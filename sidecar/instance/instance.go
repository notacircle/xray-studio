// Package instance owns the lifetime of the single Xray core instance, wires the
// telemetry hooks to the event bus, and installs the fault dialer.
//
// One instance per OS process, always. core.New() unconditionally overwrites the
// package-level dnsClient and outbound manager in transport/internet, so two
// instances in one process silently cross-talk; and the burst observatory's probe
// timers outlive an in-process reload and later fire against a dead config. The
// Electron side therefore respawns the whole process to reload.
package instance

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"os"
	"strings"
	"sync"
	"time"

	xlog "github.com/xtls/xray-core/common/log"
	"github.com/xtls/xray-core/core"
	"github.com/xtls/xray-core/features/extension"
	"github.com/xtls/xray-core/infra/conf/serial"
	"github.com/xtls/xray-core/xraytrace"

	"xraystudio/sidecar/fault"
	"xraystudio/sidecar/trace"
	"xraystudio/sidecar/validate"

	applog "github.com/xtls/xray-core/app/log"
	"github.com/xtls/xray-core/app/observatory"
)

// State values.
const (
	StateStopped  = "stopped"
	StateStarting = "starting"
	StateRunning  = "running"
	StateStopping = "stopping"
	StateError    = "error"
)

// Manager owns the instance and everything attached to it.
type Manager struct {
	shape  *trace.ConfigShape
	faults *fault.Store
	reg    *fault.Registry
	dialer *fault.Dialer
	events *trace.Bus

	// Where a log file goes when the one the config names is unusable. Empty disables
	// the redirect entirely.
	logDir   string
	logPaths LogPaths

	mu         sync.Mutex
	inst       *core.Instance
	state      string
	configPath string
	configRaw  []byte
	lastErr    string
	startedAt  time.Time

	obsTickerStop chan struct{}
}

// New creates the manager and installs the fault dialer immediately.
//
// Installing before any core.New is deliberate: it means there is never a window in
// which traffic could escape un-instrumented.
func New(events *trace.Bus, logDir string) *Manager {
	m := &Manager{
		faults: &fault.Store{},
		events: events,
		state:  StateStopped,
		logDir: logDir,
	}
	m.reg = fault.NewRegistry(func(tag string, read, written int64, age time.Duration, err error) {
		ev := trace.ConnClose{Tag: tag, Read: read, Written: written, AgeMs: age.Milliseconds()}
		if err != nil {
			ev.Err = err.Error()
		}
		events.Publish(trace.TypeConnClose, &ev.Envelope, &ev)
	})
	m.dialer = fault.NewDialer(nil, m.faults, m.reg, m.onDial)
	m.dialer.Install()
	m.installHooks()
	return m
}

// LogPaths reports where this instance's logs are being written.
func (m *Manager) LogPaths() LogPaths {
	m.mu.Lock()
	defer m.mu.Unlock()
	return m.logPaths
}

// Faults exposes the rule store so the control plane can swap rules atomically.
func (m *Manager) Faults() *fault.Store { return m.faults }

// Registry exposes the connection registry, for poisoning live connections.
func (m *Manager) Registry() *fault.Registry { return m.reg }

func (m *Manager) onDial(r fault.DialReport) {
	ev := trace.Dial{
		Tag: r.Tag, Protocol: r.Protocol, Dest: r.Dest, Network: r.Network,
		Origin: r.Origin, FaultID: r.FaultID, FaultKind: r.FaultKind, SetupNs: r.SetupNs,
	}
	ev.ConnID = r.ConnID
	if r.Err != nil {
		ev.Err = r.Err.Error()
	}
	m.events.Publish(trace.TypeDial, &ev.Envelope, &ev)
}

// installHooks connects the patched core's telemetry to the bus.
//
// Set once, before any core.New, and never mutated afterwards — the hook variables
// are read without synchronisation on hot paths.
func (m *Manager) installHooks() {
	xraytrace.OnProbe = func(e xraytrace.ProbeEvent) {
		ev := trace.Probe{
			Kind: e.Kind, Tag: e.Tag, Dest: e.Dest, Round: e.Round,
			RTTNs: e.RTTNs, Err: e.Err, Class: e.Class,
		}
		typ := trace.TypeProbeEnd
		if e.Phase == "start" {
			typ = trace.TypeProbeStart
		}
		m.events.Publish(typ, &ev.Envelope, &ev)
	}

	xraytrace.OnBalancerEval = func(t *xraytrace.Trace) {
		if t == nil {
			return
		}
		ev := trace.BalancerEval{
			BalancerTag: t.BalancerTag, Strategy: t.Strategy,
			Selectors: t.Selectors, Candidates: t.Candidates,
			Selected: t.Selected, Source: t.Source, FallbackTag: t.FallbackTag,
			Err: t.Err, DurationNs: t.DurationNs,
			Observation: convertObs(t.Observation),
			Stages:      convertStages(t.Stages),
		}
		ev.ConnID = t.ConnID
		m.events.Publish(trace.TypeBalancerEval, &ev.Envelope, &ev)
	}

	xraytrace.OnRuleMatch = func(e xraytrace.RuleMatch) {
		ev := trace.RuleMatch{
			Pass: e.Pass, RuleIdx: e.RuleIdx, RuleTag: e.RuleTag,
			OutTag: e.OutTag, Balancer: e.Balancer,
		}
		ev.ConnID = e.ConnID
		m.events.Publish(trace.TypeRuleMatch, &ev.Envelope, &ev)
	}

}

// teeLogs installs a log handler that forwards to the core's own handler as well as
// to our bus. Called after core.New, because app/log registers itself from in there
// and we must chain onto whatever it installed rather than displace it.
func (m *Manager) teeLogs(inst *core.Instance) {
	var primary xlog.Handler
	if h, ok := inst.GetFeature((*applog.Instance)(nil)).(xlog.Handler); ok {
		primary = h
	}
	xlog.RegisterHandler(&tee{primary: primary, bus: m.events})
}

func convertObs(in []xraytrace.ObsRow) []trace.ObsRow {
	if len(in) == 0 {
		return nil
	}
	out := make([]trace.ObsRow, len(in))
	for i, r := range in {
		out[i] = trace.ObsRow{
			Tag: r.Tag, Alive: r.Alive, DelayMs: r.DelayMs, HasHP: r.HasHP,
			All: r.All, Fail: r.Fail, AvgNs: r.AvgNs, DevNs: r.DevNs,
			MaxNs: r.MaxNs, MinNs: r.MinNs, LastErr: r.LastErr,
		}
	}
	return out
}

func convertStages(in []xraytrace.Stage) []trace.Stage {
	if len(in) == 0 {
		return nil
	}
	out := make([]trace.Stage, len(in))
	for i, s := range in {
		st := trace.Stage{
			ID: s.ID, Kind: s.Kind, In: s.In, Out: s.Out,
			Scores: s.Scores, Params: s.Params, Note: s.Note,
		}
		if len(s.Rejected) > 0 {
			st.Rejected = make([]trace.Rejection, len(s.Rejected))
			for j, r := range s.Rejected {
				st.Rejected[j] = trace.Rejection{Tag: r.Tag, Reason: r.Reason, Values: r.Values}
			}
		}
		out[i] = st
	}
	return out
}

// Validate parses a config without starting it.
//
// serial.LoadJSONConfig is used rather than core.LoadConfig because it reports
// line/character positions for syntax errors, which the editor can point at.
func (m *Manager) Validate(raw []byte, assetDir string) (diags []trace.Diagnostic, ok bool) {
	SetAssetDir(assetDir)
	// Before the loader: a missing .dat file makes LoadJSONConfig fail with a path deep
	// inside the bundle, and that error would otherwise be all the user sees. This one
	// names the rule and says where the fix is.
	if geo := validate.Geodata(raw); len(geo) > 0 {
		return geo, false
	}
	if _, err := serial.LoadJSONConfig(bytes.NewReader(raw)); err != nil {
		return []trace.Diagnostic{{
			Severity: "error",
			Code:     "config_parse_failed",
			Message:  err.Error(),
		}}, false
	}
	// Parsing cleanly is necessary but nowhere near sufficient: the interesting
	// failures are configs Xray accepts and then does not act on.
	//
	// Non-nil from the start, so a clean config serialises as [] rather than null.
	// Every consumer of this list is written as though it were a list.
	diags = []trace.Diagnostic{}
	diags = append(diags, validate.UnknownKeys(raw)...)
	diags = append(diags, validate.Semantic(raw)...)

	ok = true
	for _, d := range diags {
		if d.Severity == "error" {
			ok = false
		}
	}
	return diags, ok
}

// Start loads the config and starts the instance.
// SetAssetDir points the core at a directory of geoip.dat / geosite.dat.
//
// Xray resolves those through the XRAY_LOCATION_ASSET environment variable, read on
// every open — it is not cached — so it can be switched between instance lifetimes
// without restarting this process. Set on Start rather than at spawn because the
// active profile is a UI choice that changes at runtime.
func SetAssetDir(dir string) {
	if dir == "" {
		_ = os.Unsetenv("XRAY_LOCATION_ASSET")
		return
	}
	_ = os.Setenv("XRAY_LOCATION_ASSET", dir)
}

func (m *Manager) Start(raw []byte, path, assetDir string) error {
	m.mu.Lock()
	defer m.mu.Unlock()

	if m.inst != nil {
		return errors.New("already running; stop first (reload = a fresh process)")
	}

	m.events.NextEpoch()
	SetAssetDir(assetDir)
	// Before the loader, for the same reason Validate does it: the loader's own error
	// for a missing .dat file names a path inside the bundle and nothing else. This
	// one names the rule and where the fix is, and it is what the UI banner shows.
	if geo := validate.Geodata(raw); len(geo) > 0 {
		msg := geo[0].Message + " " + geo[0].Detail
		m.setState(StateError, msg)
		return errors.New(msg)
	}
	m.configRaw, m.configPath = raw, path
	m.shape = readShape(raw)
	m.setState(StateStarting, "")

	// The app owns the log destinations — see logpaths.go. A log path is a property of
	// the machine, not of the config, and these configs travel.
	rewritten, paths, err := applyLogPaths(raw, m.logDir)
	if err != nil {
		m.setState(StateError, err.Error())
		return err
	}
	raw, m.logPaths = rewritten, paths
	if paths.Access != "" {
		ev := trace.LogPaths{Access: paths.Access, Error: paths.Error}
		m.events.Publish(trace.TypeLogPaths, &ev.Envelope, &ev)
	}

	cfg, err2 := serial.LoadJSONConfig(bytes.NewReader(raw))
	if err = err2; err != nil {
		m.setState(StateError, err.Error())
		return err
	}

	inst, err := core.New(cfg)
	if err != nil {
		// The most common cause is a leastPing/leastLoad balancer with no
		// observatory configured. RequireFeatures parks the dependency instead of
		// failing loudly, so core.New surfaces only "not all dependencies are
		// resolved." with no hint as to which balancer caused it.
		m.setState(StateError, annotateStartError(err))
		return err
	}
	if err := inst.Start(); err != nil {
		_ = inst.Close()
		m.setState(StateError, err.Error())
		return err
	}

	m.teeLogs(inst)
	m.inst = inst
	m.startedAt = time.Now()
	m.setState(StateRunning, "")
	m.startObservationTicker()
	return nil
}

// annotateStartError turns core.New's opaque failures into something actionable.
func annotateStartError(err error) string {
	msg := err.Error()
	if strings.Contains(msg, "not all dependencies are resolved") {
		return msg + " — this almost always means a balancer uses strategy " +
			"leastPing or leastLoad but the config has no \"observatory\" or " +
			"\"burstObservatory\" block. Those strategies bind the observatory " +
			"lazily, so the failure surfaces here rather than at the balancer."
	}
	return msg
}

// Stop shuts the instance down.
func (m *Manager) Stop() error {
	m.mu.Lock()
	defer m.mu.Unlock()
	if m.inst == nil {
		return nil
	}
	m.setState(StateStopping, "")
	m.stopObservationTicker()
	err := m.inst.Close()
	m.inst = nil
	m.setState(StateStopped, "")
	return err
}

// Observation returns the current observatory snapshot, or nil when no observatory
// is configured.
func (m *Manager) Observation() []trace.ObsRow {
	m.mu.Lock()
	inst := m.inst
	m.mu.Unlock()
	if inst == nil {
		return nil
	}
	obs, ok := inst.GetFeature(extension.ObservatoryType()).(extension.Observatory)
	if !ok || obs == nil {
		return nil
	}
	msg, err := obs.GetObservation(context.Background())
	if err != nil {
		return nil
	}
	result, ok := msg.(*observatory.ObservationResult)
	if !ok {
		return nil
	}
	rows := make([]trace.ObsRow, 0, len(result.Status))
	for _, s := range result.Status {
		row := trace.ObsRow{
			Tag: s.OutboundTag, Alive: s.Alive, DelayMs: s.Delay, LastErr: s.LastErrorReason,
		}
		if hp := s.HealthPing; hp != nil {
			row.HasHP = true
			row.All, row.Fail = hp.All, hp.Fail
			row.AvgNs, row.DevNs, row.MaxNs, row.MinNs = hp.Average, hp.Deviation, hp.Max, hp.Min
		}
		rows = append(rows, row)
	}
	return rows
}

// startObservationTicker publishes a snapshot every second, independent of traffic,
// so the probe table stays live even when nothing is being dispatched.
func (m *Manager) startObservationTicker() {
	stop := make(chan struct{})
	m.obsTickerStop = stop
	go func() {
		t := time.NewTicker(time.Second)
		defer t.Stop()
		for {
			select {
			case <-stop:
				return
			case <-t.C:
				if rows := m.Observation(); rows != nil {
					ev := trace.Observation{Rows: rows}
					m.events.Publish(trace.TypeObservation, &ev.Envelope, &ev)
				}
			}
		}
	}()
}

func (m *Manager) stopObservationTicker() {
	if m.obsTickerStop != nil {
		close(m.obsTickerStop)
		m.obsTickerStop = nil
	}
}

// State reports the current lifecycle state.
func (m *Manager) State() trace.State {
	m.mu.Lock()
	defer m.mu.Unlock()
	return m.stateLocked()
}

func (m *Manager) stateLocked() trace.State {
	s := trace.State{State: m.state, ConfigPath: m.configPath, Err: m.lastErr, Shape: m.shape}
	if m.state == StateRunning {
		s.UptimeMs = time.Since(m.startedAt).Milliseconds()
	}
	return s
}

func (m *Manager) setState(state, errText string) {
	m.state, m.lastErr = state, errText
	s := m.stateLocked()
	m.events.Publish(trace.TypeState, &s.Envelope, &s)
}

// Close stops everything and restores the default dialer.
func (m *Manager) Close() {
	_ = m.Stop()
	fault.Uninstall()
}

// readShape summarises a config for the UI. Loose JSON on purpose: this runs on
// configs that may go on to fail the real loader, and it should still describe them.
func readShape(raw []byte) *trace.ConfigShape {
	var doc struct {
		Outbounds []struct {
			Tag string `json:"tag"`
		} `json:"outbounds"`
		Observatory      json.RawMessage `json:"observatory"`
		BurstObservatory json.RawMessage `json:"burstObservatory"`
		Routing          struct {
			Balancers []struct {
				Tag string `json:"tag"`
			} `json:"balancers"`
		} `json:"routing"`
	}
	if err := json.Unmarshal(raw, &doc); err != nil {
		return nil
	}
	sh := &trace.ConfigShape{OutboundTags: []string{}}
	for _, o := range doc.Outbounds {
		if o.Tag != "" {
			sh.OutboundTags = append(sh.OutboundTags, o.Tag)
		}
	}
	for _, b := range doc.Routing.Balancers {
		if b.Tag != "" {
			sh.BalancerTags = append(sh.BalancerTags, b.Tag)
		}
	}
	sh.HasBalancer = len(doc.Routing.Balancers) > 0
	sh.HasObservatory = len(doc.Observatory) > 0 || len(doc.BurstObservatory) > 0
	return sh
}
