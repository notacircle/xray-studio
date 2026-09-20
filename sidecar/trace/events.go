// Package trace defines the event wire schema and the bounded bus that carries it.
//
// This file is the single source of truth for what the UI receives. Its TypeScript
// mirror is app/src/shared/events.ts; keep the two in step.
package trace

// Event type discriminators.
const (
	TypeReady        = "ready"
	TypeState        = "state"
	TypeConfigDiag   = "config_diag"
	TypeProbeStart   = "probe_start"
	TypeProbeEnd     = "probe_end"
	TypeObservation  = "observation"
	TypeBalancerEval = "balancer_eval"
	TypeRuleMatch    = "rule_match"
	TypeDial         = "dial"
	TypeConnClose    = "conn_close"
	TypeLog          = "log"
	TypeFault        = "fault"
	TypeConnPoisoned = "conn_poisoned"
	TypeLogPaths     = "log_paths"
	TypeBusStats     = "bus_stats"
)

// Envelope is the header every event carries.
//
// Seq is a gap-free counter assigned at emit time. The UI uses it to detect loss:
// a jump means the bus dropped events, and an observability tool that hides that is
// worse than useless.
//
// MonoNs is nanoseconds since sidecar start and is the axis to plot on — it is
// immune to wall-clock adjustments. WallMs exists only for display.
//
// Epoch increments on every instance restart, so history from a previous config can
// be kept on screen without being mistaken for the current one.
type Envelope struct {
	Seq    uint64 `json:"seq"`
	Type   string `json:"type"`
	MonoNs int64  `json:"mono_ns"`
	WallMs int64  `json:"wall_ms"`
	Epoch  uint32 `json:"epoch"`
	ConnID uint32 `json:"conn_id,omitempty"`
}

// State reports the instance lifecycle.
type State struct {
	Envelope
	// stopped | validating | starting | running | stopping | error
	State      string `json:"state"`
	ConfigPath string `json:"config_path,omitempty"`
	Err        string `json:"err,omitempty"`
	UptimeMs   int64  `json:"uptime_ms"`
	// Shape describes what the running config contains, so the UI can say what it
	// will and will not be able to show for it — see ConfigShape.
	Shape *ConfigShape `json:"shape,omitempty"`
}

// ConfigShape is the part of a config that decides which panels have anything to say.
//
// Most of this tool is about balancers and the observatory that feeds them. A config
// with neither is perfectly valid and runs fine, and every probe-driven panel then sits
// empty — which reads as "nothing works" unless something says why. This is read from
// the raw JSON at start, once, so the rail can list the outbounds before any of them has
// been dialled and the Observe tab can explain an empty chart instead of showing one.
type ConfigShape struct {
	OutboundTags   []string `json:"outbound_tags"`
	BalancerTags   []string `json:"balancer_tags,omitempty"`
	HasObservatory bool     `json:"has_observatory"`
	HasBalancer    bool     `json:"has_balancer"`
}

// Diagnostic is one validation finding about the config.
//
// Severity "error" means the config will not load. "dysfunction" is the interesting
// one: the config loads fine and then never works — a balancer selector matching no
// outbound, leastLoad with no observatory, a fallbackTag naming an outbound that does
// not exist. Those have no representation anywhere in Xray's own output.
type Diagnostic struct {
	Severity string `json:"severity"` // error | dysfunction | warning | info
	Code     string `json:"code"`     // stable machine code
	Path     string `json:"path,omitempty"`
	Message  string `json:"message"`
	Detail   string `json:"detail,omitempty"`
	Line     int    `json:"line,omitempty"`
	Column   int    `json:"column,omitempty"`
}

// ConfigDiag carries the result of validating a config.
type ConfigDiag struct {
	Envelope
	OK          bool         `json:"ok"`
	Diagnostics []Diagnostic `json:"diagnostics"`
}

// Probe mirrors xraytrace.ProbeEvent onto the wire.
//
// Class "net_down" is worth special handling in the UI: the burst observatory
// discards that result, so the failure never reaches the sampling window. Without
// this event an injected fault can appear to have done nothing at all.
type Probe struct {
	Envelope
	Kind  string `json:"kind"` // burst | observer
	Tag   string `json:"tag"`
	Dest  string `json:"dest,omitempty"`
	Round uint64 `json:"round,omitempty"`
	RTTNs int64  `json:"rtt_ns,omitempty"`
	Err   string `json:"err,omitempty"`
	Class string `json:"class,omitempty"` // ok | fail | net_down
}

// ObsRow is one outbound's observatory record.
type ObsRow struct {
	Tag     string `json:"tag"`
	Alive   bool   `json:"alive"`
	DelayMs int64  `json:"delay_ms"`
	HasHP   bool   `json:"has_hp"`
	All     int64  `json:"all,omitempty"`
	Fail    int64  `json:"fail,omitempty"`
	AvgNs   int64  `json:"avg_ns,omitempty"`
	DevNs   int64  `json:"dev_ns,omitempty"`
	MaxNs   int64  `json:"max_ns,omitempty"`
	MinNs   int64  `json:"min_ns,omitempty"`
	LastErr string `json:"last_err,omitempty"`
}

// Observation is a periodic snapshot, emitted on a timer independent of traffic so
// the probe table stays live even when nothing is being dispatched.
type Observation struct {
	Envelope
	Rows []ObsRow `json:"rows"`
}

// Rejection, Stage and BalancerEval mirror the xraytrace types. They are re-declared
// rather than aliased so the wire format is owned here and cannot be changed by an
// edit to the patch series without this file noticing.
type Rejection struct {
	Tag    string           `json:"tag"`
	Reason string           `json:"reason"`
	Values map[string]int64 `json:"values,omitempty"`
}

type Stage struct {
	ID       string           `json:"id"`
	Kind     string           `json:"kind"`
	In       []string         `json:"in"`
	Out      []string         `json:"out"`
	Rejected []Rejection      `json:"rejected,omitempty"`
	Scores   map[string]int64 `json:"scores,omitempty"`
	Params   map[string]int64 `json:"params,omitempty"`
	Note     string           `json:"note,omitempty"`
}

// BalancerEval is the "why was this picked" payload.
type BalancerEval struct {
	Envelope
	BalancerTag string   `json:"balancer_tag"`
	Strategy    string   `json:"strategy"`
	Selectors   []string `json:"selectors"`
	Candidates  []string `json:"candidates"`
	Observation []ObsRow `json:"observation,omitempty"`
	Stages      []Stage  `json:"stages"`
	Selected    string   `json:"selected"`
	Source      string   `json:"source"`
	FallbackTag string   `json:"fallback_tag,omitempty"`
	Err         string   `json:"err,omitempty"`
	DurationNs  int64    `json:"duration_ns"`
}

// RuleMatch reports which routing rule claimed a connection.
// RuleIdx == -1 means none did, and traffic silently took the default outbound.
type RuleMatch struct {
	Envelope
	Pass     int    `json:"pass"`
	RuleIdx  int    `json:"rule_idx"`
	RuleTag  string `json:"rule_tag,omitempty"`
	OutTag   string `json:"out_tag,omitempty"`
	Balancer string `json:"balancer,omitempty"`
}

// Dial reports one outbound connection attempt as seen by the fault dialer.
//
// Origin distinguishes observatory probes from user traffic. They travel the exact
// same path — which is what makes the fault injection faithful — so nothing else can
// tell them apart.
type Dial struct {
	Envelope
	Tag       string `json:"tag"`
	Protocol  string `json:"protocol,omitempty"`
	Dest      string `json:"dest"`
	Network   string `json:"network"`
	Origin    string `json:"origin"` // probe | traffic
	FaultID   string `json:"fault_id,omitempty"`
	FaultKind string `json:"fault_kind,omitempty"`
	Err       string `json:"err,omitempty"`
	SetupNs   int64  `json:"setup_ns"`
}

// ConnClose reports a tracked connection ending, with byte counts.
type ConnClose struct {
	Envelope
	Tag     string `json:"tag"`
	Read    int64  `json:"read"`
	Written int64  `json:"written"`
	Err     string `json:"err,omitempty"`
	AgeMs   int64  `json:"age_ms"`
}

// Log is a structured record from the core's log handler.
type Log struct {
	Envelope
	Severity string `json:"severity"`
	Caller   string `json:"caller,omitempty"`
	Message  string `json:"message"`
}

// Fault reports a fault rule being applied, cleared or triggered.
type Fault struct {
	Envelope
	Action string `json:"action"` // applied | cleared | replaced
	ID     string `json:"id"`
	Kind   string `json:"kind,omitempty"`
	Match  string `json:"match,omitempty"`
}

// ConnPoisoned reports live connections torn down because their outbound went into a
// hard-down fault. Without this, "unreachable" would only affect NEW connections,
// which is not how a firewall behaves.
type ConnPoisoned struct {
	Envelope
	Tag   string `json:"tag"`
	Count int    `json:"count"`
	Kind  string `json:"kind"`
}

// LogPaths reports where this instance's logs are being written.
//
// The app assigns these rather than taking them from the config; the Log tab shows them
// so that "where are the logs?" has an answer in the place people look.
type LogPaths struct {
	Envelope
	Access string `json:"access"`
	Error  string `json:"error"`
}

// BusStats reports the health of the event pipeline itself.
type BusStats struct {
	Envelope
	Emitted     uint64 `json:"emitted"`
	Dropped     uint64 `json:"dropped"`
	QueueDepth  int    `json:"queue_depth"`
	QueueCap    int    `json:"queue_cap"`
	Subscribers int    `json:"subscribers"`
}
