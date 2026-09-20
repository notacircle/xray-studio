package sidecar_test

// End-to-end proof of the core premise.
//
// Two outbounds dial the SAME address. A fault is applied to one of them by TAG, and
// the balancer must fail over. This is the scenario a packet filter physically
// cannot express — pf/iptables see identical 5-tuples for both outbounds — and it is
// why the fault is injected at Xray's dialer rather than at the network layer.
//
// It also proves the two halves that make the fault faithful:
//   - the observatory's probes see the failure (they share the dial path), so the
//     balancer reacts on its own rather than because we told it to
//   - the decision trace names the reason, so the UI can say WHY it failed over

import (
	"encoding/json"
	"fmt"
	"net"
	"net/http"
	"sync"
	"testing"
	"time"

	"xraystudio/sidecar/fault"
	"xraystudio/sidecar/instance"
	"xraystudio/sidecar/trace"

	_ "xraystudio/sidecar/internal/xraydeps"
)

func TestFailoverOnInjectedFault(t *testing.T) {
	probeURL, stopProbe := start204Server(t)
	defer stopProbe()

	socksPort := freePort(t)

	// The plain observatory rather than burstObservatory: burst clamps its interval
	// to a 10s minimum and its round period is interval*samplingCount, which would
	// make this test take minutes. The plain observer honours probeInterval directly.
	// leastLoad works with either, degrading to "leastPing with a cost multiplier"
	// when HealthPing is absent — which this test also exercises.
	cfg := fmt.Sprintf(`{
	  "log": { "loglevel": "warning" },
	  "inbounds": [
	    { "tag": "in", "listen": "127.0.0.1", "port": %d, "protocol": "socks",
	      "settings": { "auth": "noauth", "udp": false } }
	  ],
	  "outbounds": [
	    { "tag": "out-a", "protocol": "freedom" },
	    { "tag": "out-b", "protocol": "freedom" }
	  ],
	  "observatory": {
	    "subjectSelector": ["out-"],
	    "probeURL": %q,
	    "probeInterval": "1s",
	    "enableConcurrency": true
	  },
	  "routing": {
	    "balancers": [
	      { "tag": "bal", "selector": ["out-"], "strategy": { "type": "leastLoad" } }
	    ],
	    "rules": [
	      { "inboundTag": ["in"], "balancerTag": "bal" }
	    ]
	  }
	}`, socksPort, probeURL)

	bus := trace.NewBus(4096)
	defer bus.Close()
	events, cancel := bus.Subscribe(4096)
	defer cancel()

	collected := collect(events)

	mgr := instance.New(bus, t.TempDir())
	defer mgr.Close()

	if err := mgr.Start([]byte(cfg), "e2e", ""); err != nil {
		t.Fatalf("start: %v", err)
	}

	// --- 1. both outbounds come up healthy -------------------------------------
	waitFor(t, 15*time.Second, "both outbounds alive", func() bool {
		alive := map[string]bool{}
		for _, r := range mgr.Observation() {
			alive[r.Tag] = r.Alive
		}
		return alive["out-a"] && alive["out-b"]
	})
	t.Log("both outbounds alive")

	// --- 2. blackhole ONE of them, by tag ---------------------------------------
	// Both dial the identical probe URL, so nothing about the packets distinguishes
	// them. Only the outbound tag does.
	rs, err := fault.Compile([]*fault.Rule{{
		ID: "kill-a", Enabled: true, Kind: fault.KindBlackhole, TagGlob: "out-a",
	}})
	if err != nil {
		t.Fatalf("compile rule: %v", err)
	}
	mgr.Faults().Swap(rs)
	t.Log("blackhole applied to out-a")

	// --- 3. the observatory notices, unprompted ---------------------------------
	waitFor(t, 40*time.Second, "out-a marked dead, out-b still alive", func() bool {
		var aDead, bAlive bool
		for _, r := range mgr.Observation() {
			if r.Tag == "out-a" && !r.Alive {
				aDead = true
			}
			if r.Tag == "out-b" && r.Alive {
				bAlive = true
			}
		}
		return aDead && bAlive
	})
	t.Log("observatory marked out-a dead purely from its own probe failures")

	// --- 4. the balancer fails over, and says why -------------------------------
	// Drive traffic so the balancer actually runs; it evaluates per connection.
	deadline := time.Now().Add(20 * time.Second)
	var lastEval *trace.BalancerEval
	for time.Now().Before(deadline) {
		_ = socksProbe(fmt.Sprintf("127.0.0.1:%d", socksPort))
		if ev := collected.lastEval(); ev != nil && ev.Selected == "out-b" {
			lastEval = ev
			break
		}
		time.Sleep(200 * time.Millisecond)
	}
	if lastEval == nil {
		t.Fatalf("balancer never selected out-b; last eval: %+v", collected.lastEval())
	}
	t.Logf("balancer selected %q via %q", lastEval.Selected, lastEval.Source)

	// The trace must name the reason, not merely report the outcome.
	reason := ""
	for _, st := range lastEval.Stages {
		for _, rej := range st.Rejected {
			if rej.Tag == "out-a" {
				reason = rej.Reason
			}
		}
	}
	if reason != "not_alive" {
		t.Errorf("out-a rejection reason = %q, want %q\nstages: %+v", reason, "not_alive", lastEval.Stages)
	}

	// --- 5. probe failures were observed, with the fault attributed --------------
	if n := collected.countProbeFailures("out-a"); n == 0 {
		t.Error("no probe failures recorded for out-a — the probes did not see the fault")
	}
	if n := collected.countFaultedDials("out-a", "blackhole"); n == 0 {
		t.Error("no dial events attributed to the blackhole rule")
	}
	// out-b must be untouched: the fault is scoped to a tag, not to an address.
	if n := collected.countFaultedDials("out-b", "blackhole"); n != 0 {
		t.Errorf("out-b saw %d faulted dials; the fault leaked across outbounds sharing an address", n)
	}
	t.Logf("probe failures on out-a: %d, faulted dials: %d, leaked to out-b: %d",
		collected.countProbeFailures("out-a"),
		collected.countFaultedDials("out-a", "blackhole"),
		collected.countFaultedDials("out-b", "blackhole"))

	// --- 6. clearing the fault brings it back -----------------------------------
	empty, _ := fault.Compile(nil)
	mgr.Faults().Swap(empty)
	waitFor(t, 30*time.Second, "out-a recovers", func() bool {
		for _, r := range mgr.Observation() {
			if r.Tag == "out-a" {
				return r.Alive
			}
		}
		return false
	})
	t.Log("out-a recovered after the fault was cleared")
}

// --- helpers -----------------------------------------------------------------

func start204Server(t *testing.T) (url string, stop func()) {
	t.Helper()
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatalf("probe listener: %v", err)
	}
	srv := &http.Server{Handler: http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusNoContent)
	})}
	go func() { _ = srv.Serve(ln) }()
	return fmt.Sprintf("http://%s/generate_204", ln.Addr().String()),
		func() { _ = srv.Close() }
}

func freePort(t *testing.T) int {
	t.Helper()
	l, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatalf("reserve port: %v", err)
	}
	defer l.Close()
	return l.Addr().(*net.TCPAddr).Port
}

func waitFor(t *testing.T, limit time.Duration, what string, cond func() bool) {
	t.Helper()
	deadline := time.Now().Add(limit)
	for time.Now().Before(deadline) {
		if cond() {
			return
		}
		time.Sleep(250 * time.Millisecond)
	}
	t.Fatalf("timed out after %s waiting for: %s", limit, what)
}

// socksProbe makes one SOCKS5 CONNECT so the balancer is exercised. Success is
// irrelevant; the point is that a routing decision happens.
func socksProbe(proxy string) error {
	c, err := net.DialTimeout("tcp", proxy, time.Second)
	if err != nil {
		return err
	}
	defer c.Close()
	_ = c.SetDeadline(time.Now().Add(2 * time.Second))
	if _, err := c.Write([]byte{0x05, 0x01, 0x00}); err != nil {
		return err
	}
	if _, err := c.Read(make([]byte, 2)); err != nil {
		return err
	}
	req := []byte{0x05, 0x01, 0x00, 0x03, byte(len("example.com"))}
	req = append(req, "example.com"...)
	req = append(req, 0x00, 0x50)
	if _, err := c.Write(req); err != nil {
		return err
	}
	_, err = c.Read(make([]byte, 16))
	return err
}

// collector tails the event stream into memory for assertions.
type collector struct {
	mu     sync.Mutex
	last   *trace.BalancerEval
	probes map[string]int
	dials  map[string]int
}

func collect(events <-chan []byte) *collector {
	c := &collector{probes: map[string]int{}, dials: map[string]int{}}
	go func() {
		for buf := range events {
			var head struct {
				Type string `json:"type"`
			}
			if json.Unmarshal(buf, &head) != nil {
				continue
			}
			c.mu.Lock()
			switch head.Type {
			case trace.TypeBalancerEval:
				var ev trace.BalancerEval
				if json.Unmarshal(buf, &ev) == nil {
					c.last = &ev
				}
			case trace.TypeProbeEnd:
				var ev trace.Probe
				if json.Unmarshal(buf, &ev) == nil && ev.Class != "ok" {
					c.probes[ev.Tag]++
				}
			case trace.TypeDial:
				var ev trace.Dial
				if json.Unmarshal(buf, &ev) == nil && ev.FaultKind != "" {
					c.dials[ev.Tag+"/"+ev.FaultKind]++
				}
			}
			c.mu.Unlock()
		}
	}()
	return c
}

func (c *collector) lastEval() *trace.BalancerEval {
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.last
}

func (c *collector) countProbeFailures(tag string) int {
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.probes[tag]
}

func (c *collector) countFaultedDials(tag, kind string) int {
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.dials[tag+"/"+kind]
}
