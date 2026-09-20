// Package control exposes the sidecar over loopback HTTP + WebSocket.
//
// Why HTTP+WS rather than NDJSON over stdio: a pipe applies backpressure to the
// WRITER. During a burst round (len(tags) x samplingCount concurrent probes) a slow
// reader would stall the Xray data path through our hooks — the observer would then
// be perturbing the thing it observes. A WebSocket with a bounded server-side ring
// drops instead, and reports the drops.
//
// stdout stays reserved for the core's own log output, so it can be shown verbatim.
package control

import (
	"crypto/rand"
	"crypto/subtle"
	"encoding/hex"
	"encoding/json"
	"errors"
	"net"
	"net/http"
	"os"
	"sync"
	"time"

	"xraystudio/sidecar/fault"
	"xraystudio/sidecar/instance"
	"xraystudio/sidecar/sim"
	"xraystudio/sidecar/trace"
)

// Server is the loopback control plane.
type Server struct {
	mgr    *instance.Manager
	bus    *trace.Bus
	token  string
	ln     net.Listener
	srv    *http.Server
	closed sync.Once
}

// New binds 127.0.0.1 on an ephemeral port and mints a bearer token.
//
// Loopback-only plus a per-process token, because anything on this socket can start
// an arbitrary Xray config and rewrite fault rules. It is not a public API.
func New(mgr *instance.Manager, bus *trace.Bus) (*Server, error) {
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		return nil, err
	}
	var tok [16]byte
	if _, err := rand.Read(tok[:]); err != nil {
		_ = ln.Close()
		return nil, err
	}
	s := &Server{mgr: mgr, bus: bus, token: hex.EncodeToString(tok[:]), ln: ln}
	s.srv = &http.Server{Handler: s.routes(), ReadHeaderTimeout: 5 * time.Second}
	return s, nil
}

// Port returns the bound port.
func (s *Server) Port() int { return s.ln.Addr().(*net.TCPAddr).Port }

// Token returns the bearer token.
func (s *Server) Token() string { return s.token }

// Serve blocks until the server stops.
func (s *Server) Serve() error {
	err := s.srv.Serve(s.ln)
	if errors.Is(err, http.ErrServerClosed) {
		return nil
	}
	return err
}

// Close shuts the server down.
func (s *Server) Close() {
	s.closed.Do(func() { _ = s.srv.Close() })
}

func (s *Server) routes() http.Handler {
	mux := http.NewServeMux()
	mux.HandleFunc("GET /v1/status", s.auth(s.handleStatus))
	mux.HandleFunc("POST /v1/config", s.auth(s.handleValidate))
	mux.HandleFunc("POST /v1/start", s.auth(s.handleStart))
	mux.HandleFunc("POST /v1/stop", s.auth(s.handleStop))
	mux.HandleFunc("GET /v1/faults", s.auth(s.handleGetFaults))
	mux.HandleFunc("PUT /v1/faults", s.auth(s.handlePutFaults))
	mux.HandleFunc("GET /v1/observation", s.auth(s.handleObservation))
	mux.HandleFunc("POST /v1/simulate", s.auth(s.handleSimulate))
	mux.HandleFunc("POST /v1/selfcheck", s.auth(s.handleSelfCheck))
	mux.HandleFunc("GET /v1/oracle/principle/{tag}", s.auth(s.handlePrinciple))
	mux.HandleFunc("GET /v1/events", s.auth(s.handleEvents))
	return mux
}

// auth enforces the bearer token in constant time.
func (s *Server) auth(next http.HandlerFunc) http.HandlerFunc {
	want := "Bearer " + s.token
	return func(w http.ResponseWriter, r *http.Request) {
		got := r.Header.Get("Authorization")
		if got == "" {
			got = "Bearer " + r.URL.Query().Get("token") // WebSocket clients cannot set headers
		}
		if subtle.ConstantTimeCompare([]byte(got), []byte(want)) != 1 {
			http.Error(w, "unauthorized", http.StatusUnauthorized)
			return
		}
		next(w, r)
	}
}

func writeJSON(w http.ResponseWriter, code int, v any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(code)
	_ = json.NewEncoder(w).Encode(v)
}

// statusView is a plain snapshot. The event types embed trace.Envelope, whose
// seq/type/mono_ns fields are meaningless outside the stream — serialising them here
// would put a permanently-zero "seq" in every status response.
type statusView struct {
	PID   int `json:"pid"`
	State struct {
		State      string `json:"state"`
		ConfigPath string `json:"config_path,omitempty"`
		Err        string `json:"err,omitempty"`
		UptimeMs   int64  `json:"uptime_ms"`
		Epoch      uint32 `json:"epoch"`
	} `json:"state"`
	Bus struct {
		Emitted     uint64 `json:"emitted"`
		Dropped     uint64 `json:"dropped"`
		QueueDepth  int    `json:"queue_depth"`
		QueueCap    int    `json:"queue_cap"`
		Subscribers int    `json:"subscribers"`
	} `json:"bus"`
}

func (s *Server) handleStatus(w http.ResponseWriter, r *http.Request) {
	st, bs := s.mgr.State(), s.bus.Stats()

	var v statusView
	v.PID = os.Getpid()
	v.State.State, v.State.ConfigPath = st.State, st.ConfigPath
	v.State.Err, v.State.UptimeMs = st.Err, st.UptimeMs
	v.State.Epoch = s.bus.Epoch()
	v.Bus.Emitted, v.Bus.Dropped = bs.Emitted, bs.Dropped
	v.Bus.QueueDepth, v.Bus.QueueCap, v.Bus.Subscribers = bs.QueueDepth, bs.QueueCap, bs.Subscribers

	writeJSON(w, http.StatusOK, v)
}

type configRequest struct {
	Path string `json:"path,omitempty"`
	Raw  string `json:"raw,omitempty"`
	// AssetDir is where geoip.dat and geosite.dat are read from for this instance.
	// The app owns geodata the way it owns log paths: a profile is chosen in the UI,
	// and the core is pointed at that profile's directory rather than at wherever the
	// sidecar binary happens to live — which in a packaged app is a read-only bundle
	// with no .dat files in it at all.
	AssetDir string `json:"assetDir,omitempty"`
}

// load resolves a request to raw config bytes, from an inline body or a file path.
func (c configRequest) load() ([]byte, string, error) {
	if c.Raw != "" {
		return []byte(c.Raw), c.Path, nil
	}
	if c.Path == "" {
		return nil, "", errors.New("either raw or path is required")
	}
	b, err := os.ReadFile(c.Path)
	return b, c.Path, err
}

func (s *Server) handleValidate(w http.ResponseWriter, r *http.Request) {
	var req configRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": err.Error()})
		return
	}
	raw, _, err := req.load()
	if err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": err.Error()})
		return
	}
	diags, ok := s.mgr.Validate(raw, req.AssetDir)
	writeJSON(w, http.StatusOK, map[string]any{"ok": ok, "diagnostics": diags})
}

func (s *Server) handleStart(w http.ResponseWriter, r *http.Request) {
	var req configRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": err.Error()})
		return
	}
	raw, path, err := req.load()
	if err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": err.Error()})
		return
	}
	if err := s.mgr.Start(raw, path, req.AssetDir); err != nil {
		writeJSON(w, http.StatusUnprocessableEntity, map[string]any{
			"error": err.Error(),
			"state": s.mgr.State(),
		})
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"state": s.mgr.State()})
}

func (s *Server) handleStop(w http.ResponseWriter, r *http.Request) {
	if err := s.mgr.Stop(); err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": err.Error()})
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"state": s.mgr.State()})
}

func (s *Server) handleObservation(w http.ResponseWriter, r *http.Request) {
	writeJSON(w, http.StatusOK, map[string]any{"rows": s.mgr.Observation()})
}

func (s *Server) handleGetFaults(w http.ResponseWriter, r *http.Request) {
	writeJSON(w, http.StatusOK, map[string]any{"rules": s.mgr.Faults().Load().Rules()})
}

func (s *Server) handlePutFaults(w http.ResponseWriter, r *http.Request) {
	var req struct {
		Rules []*fault.Rule `json:"rules"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": err.Error()})
		return
	}
	rs, err := fault.Compile(req.Rules)
	if err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": err.Error()})
		return
	}

	prev := s.mgr.Faults().Swap(rs)
	s.reportFaultChange(prev, rs)

	// Poison live connections for every tag that just went hard-down. Without this,
	// "unreachable" would apply only to NEW connections while established flows kept
	// working — which no firewall does, and which would let a long-lived connection
	// mask the very outage under test.
	poisoned := map[string]int{}
	for _, rule := range rs.Rules() {
		if !rule.Kind.HardDown() {
			continue
		}
		for _, tag := range s.tagsMatching(rule) {
			if n := s.mgr.Registry().Poison(tag, fault.PoisonError(rule.Kind, tag)); n > 0 {
				poisoned[tag] += n
				ev := trace.ConnPoisoned{Tag: tag, Count: n, Kind: string(rule.Kind)}
				s.bus.Publish(trace.TypeConnPoisoned, &ev.Envelope, &ev)
			}
		}
	}
	writeJSON(w, http.StatusOK, map[string]any{"applied": len(rs.Rules()), "poisoned": poisoned})
}

// tagsMatching finds live outbound tags a rule applies to. Only tags with tracked
// connections matter here, since poisoning is about existing flows.
func (s *Server) tagsMatching(rule *fault.Rule) []string {
	var out []string
	for _, tag := range s.mgr.Registry().Tags() {
		if rule.MatchesTag(tag) {
			out = append(out, tag)
		}
	}
	return out
}

func (s *Server) reportFaultChange(prev, next *fault.RuleSet) {
	seen := map[string]*fault.Rule{}
	for _, r := range next.Rules() {
		seen[r.ID] = r
		ev := trace.Fault{Action: "applied", ID: r.ID, Kind: string(r.Kind), Match: r.TagGlob}
		s.bus.Publish(trace.TypeFault, &ev.Envelope, &ev)
	}
	for _, r := range prev.Rules() {
		if _, still := seen[r.ID]; !still {
			ev := trace.Fault{Action: "cleared", ID: r.ID, Kind: string(r.Kind), Match: r.TagGlob}
			s.bus.Publish(trace.TypeFault, &ev.Envelope, &ev)
		}
	}
}

// ReadyLine is the first stdout line, telling the parent process how to reach us.
func (s *Server) ReadyLine(xrayVersion string, patches int) string {
	b, _ := json.Marshal(map[string]any{
		"event":   "ready",
		"pid":     os.Getpid(),
		"port":    s.Port(),
		"token":   s.token,
		"xray":    xrayVersion,
		"patches": patches,
	})
	return string(b)
}

// mustJSON marshals or returns an empty object; used only for frames we construct
// ourselves, which cannot fail to marshal.
func mustJSON(v any) []byte {
	b, err := json.Marshal(v)
	if err != nil {
		return []byte("{}")
	}
	return b
}

// handleSimulate answers "what would this balancer do if …" by running the real
// strategy code against a supplied observation. See package sim.
func (s *Server) handleSimulate(w http.ResponseWriter, r *http.Request) {
	var req sim.Request
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": err.Error()})
		return
	}
	res, err := sim.Run(req)
	if err != nil {
		writeJSON(w, http.StatusUnprocessableEntity, map[string]string{"error": err.Error()})
		return
	}
	writeJSON(w, http.StatusOK, res)
}

// handleSelfCheck cross-checks the dashboard's claims against the core's own answers.
func (s *Server) handleSelfCheck(w http.ResponseWriter, r *http.Request) {
	var req struct {
		Balancers map[string]struct {
			Strategy   string   `json:"strategy"`
			Candidates []string `json:"candidates"`
		} `json:"balancers"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": err.Error()})
		return
	}
	facts := make(map[string]instance.BalancerFacts, len(req.Balancers))
	for tag, b := range req.Balancers {
		facts[tag] = instance.BalancerFacts{Strategy: b.Strategy, Candidates: b.Candidates}
	}
	writeJSON(w, http.StatusOK, s.mgr.RunSelfCheck(facts))
}

// handlePrinciple exposes the core's own principle target for a balancer.
func (s *Server) handlePrinciple(w http.ResponseWriter, r *http.Request) {
	tags, err := s.mgr.PrincipleTarget(r.PathValue("tag"))
	if err != nil {
		writeJSON(w, http.StatusUnprocessableEntity, map[string]string{"error": err.Error()})
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"tags": tags})
}

// Connections reports how many event-stream clients are attached. Used by the
// orphan guard: if the UI crashed, nothing is listening and the sidecar should exit
// rather than keep the config's inbound ports bound.
func (s *Server) Connections() int { return s.bus.Stats().Subscribers }
