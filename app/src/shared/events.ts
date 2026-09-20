/**
 * Mirror of sidecar/trace/events.go. Keep the two in step — that file is the
 * authority for the wire format.
 */

export const EventType = {
  Ready: 'ready',
  State: 'state',
  ConfigDiag: 'config_diag',
  ProbeStart: 'probe_start',
  ProbeEnd: 'probe_end',
  Observation: 'observation',
  BalancerEval: 'balancer_eval',
  RuleMatch: 'rule_match',
  Dial: 'dial',
  ConnClose: 'conn_close',
  Log: 'log',
  Fault: 'fault',
  ConnPoisoned: 'conn_poisoned',
  LogPaths: 'log_paths',
  BusStats: 'bus_stats',
} as const

export interface Envelope {
  seq: number
  type: string
  /** Nanoseconds since sidecar start. Plot against this, not wall_ms — it is
   *  immune to clock adjustments. */
  mono_ns: number
  wall_ms: number
  /** Bumped on every instance restart, so old history stays distinguishable. */
  epoch: number
  conn_id?: number
}

export interface StateEvent extends Envelope {
  state: 'stopped' | 'starting' | 'running' | 'stopping' | 'error' | 'validating'
  config_path?: string
  err?: string
  uptime_ms: number
  /** What the running config contains — decides which panels can show anything. */
  shape?: ConfigShape
}

export interface ConfigShape {
  outbound_tags: string[]
  balancer_tags?: string[]
  has_observatory: boolean
  has_balancer: boolean
}

export interface Diagnostic {
  /** `dysfunction` is the interesting one: the config loads and then never works. */
  severity: 'error' | 'dysfunction' | 'warning' | 'info'
  code: string
  path?: string
  message: string
  detail?: string
  line?: number
  column?: number
}

export interface ProbeEvent extends Envelope {
  kind: 'burst' | 'observer'
  tag: string
  dest?: string
  round?: number
  rtt_ns?: number
  err?: string
  /** `net_down` means the burst observatory DISCARDED this result, so the failure
   *  never reaches the sampling window. Worth surfacing loudly. */
  class?: 'ok' | 'fail' | 'net_down'
}

export interface ObsRow {
  tag: string
  alive: boolean
  delay_ms: number
  /** False => plain observatory, so leastLoad degrades to leastPing x cost. */
  has_hp: boolean
  all?: number
  fail?: number
  avg_ns?: number
  dev_ns?: number
  max_ns?: number
  min_ns?: number
  last_err?: string
}

export interface ObservationEvent extends Envelope {
  rows: ObsRow[]
}

export interface Rejection {
  tag: string
  reason: RejectionReason
  values?: Record<string, number>
}

export interface Stage {
  id: StageId
  kind: 'filter' | 'rank' | 'truncate' | 'choose' | 'note'
  in: string[]
  out: string[]
  rejected?: Rejection[]
  /** Nanoseconds. Present on ranking stages. */
  scores?: Record<string, number>
  params?: Record<string, number>
  note?: StageNote
}

export interface BalancerEvalEvent extends Envelope {
  balancer_tag: string
  strategy: string
  selectors: string[]
  candidates: string[]
  observation?: ObsRow[]
  stages: Stage[]
  selected: string
  source: 'strategy' | 'override' | 'fallback_empty' | 'fallback_select_error' | 'error'
  fallback_tag?: string
  err?: string
  duration_ns: number
}

export interface RuleMatchEvent extends Envelope {
  pass: number
  /** -1 means nothing matched and traffic took the default outbound. */
  rule_idx: number
  rule_tag?: string
  out_tag?: string
  balancer?: string
}

export interface DialEvent extends Envelope {
  tag: string
  protocol?: string
  dest: string
  network: string
  origin: 'probe' | 'traffic'
  fault_id?: string
  fault_kind?: string
  err?: string
  setup_ns: number
}

export interface LogEvent extends Envelope {
  severity: string
  caller?: string
  message: string
}

export interface FaultEvent extends Envelope {
  action: 'applied' | 'cleared' | 'replaced'
  id: string
  kind?: string
  match?: string
}

export interface BusStatsEvent extends Envelope {
  emitted: number
  dropped: number
  queue_depth: number
  queue_cap: number
  subscribers: number
}

// --- stable machine codes, mirroring xraytrace/reasons.go --------------------
// Never localise these; they key the UI copy below.

export type RejectionReason =
  | 'not_in_observation'
  | 'not_alive'
  | 'maxrtt_exceeded'
  | 'tolerance_exceeded'
  | 'not_in_candidates'
  | 'outranked'
  | 'above_baseline'
  | 'beyond_expected'
  | 'not_chosen_by_dice'
  | 'not_current_index'

export type StageId =
  | 'select'
  | 'observation'
  | 'alive_filter'
  | 'node_filter'
  | 'score'
  | 'sort'
  | 'baseline'
  | 'expected'
  | 'min_scan'
  | 'rr_index'
  | 'dice'

export type StageNote =
  | 'observatory_ignored_no_fallback'
  | 'observatory_nil'
  | 'observation_error'
  | 'no_health_ping'
  | 'unfound_assumed_alive'
  | 'baseline_applied'
  | 'baseline_none_qualified'
  | 'baselines_unsorted'
  | 'expected_floor_applied'
  | 'tie'
  | 'rr_index_jumped'
  | 'empty'
  | 'override_pinned'
  | 'no_baselines'
  | 'expected_exceeds_available'

// --- fault rules -------------------------------------------------------------

export type FaultKind =
  | 'blackhole'
  | 'refuse'
  | 'host_unreachable'
  | 'net_unreachable'
  | 'dns_fail'
  | 'tls_hang'
  | 'tls_garbage'
  | 'latency'
  | 'throttle'
  | 'reset_after'
  | 'udp_loss'
  | 'quota_freeze'

export interface FaultRule {
  id: string
  enabled: boolean
  kind: FaultKind
  /** Matches the OUTBOUND TAG, not an address — two outbounds can share a server
   *  IP:port, and a packet filter cannot separate them.
   *
   *  Comma-separated for a group: `"LTE-1, LTE-4, REGULAR-*"`. A group is ONE rule so
   *  that arming and disarming it is a single atomic swap in the sidecar; several
   *  rules toggled one by one would pass through states that look like a genuine
   *  partial outage. */
  tagGlob: string
  destRegexp?: string
  network?: string
  origin?: 'probe' | 'traffic'
  delayMs?: number
  jitterMs?: number
  rateBps?: number
  burstBytes?: number
  afterBytes?: number
  lossPercent?: number
  upBytes?: number
  downBytes?: number
  freezeMs?: number
  probability?: number
  upMs?: number
  downMs?: number
}

/** Splits a rule's tag field into its members. */
export const globMembers = (glob: string): string[] =>
  glob.split(',').map((s) => s.trim()).filter(Boolean)

/**
 * Mirrors globToRegexp in sidecar/fault/rules.go.
 *
 * Lives in shared because three places need the same answer: the sidecar decides
 * whether a dial fails, the main process paints the badge, and the renderer previews
 * which outbounds a rule will hit. A preview that disagrees with the engine would
 * make the tool lie about the one thing it exists to show.
 */
export function tagsMatching(glob: string, tags: string[]): string[] {
  const alts: string[] = []
  for (const raw of glob.split(',')) {
    const part = raw.trim()
    if (!part) continue
    if (part === '*') return [...tags]
    alts.push(part.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.'))
  }
  if (alts.length === 0) return [...tags]
  const re = new RegExp(`^(?:${alts.join('|')})$`)
  return tags.filter((t) => re.test(t))
}

// --- the snapshot the renderer actually receives ------------------------------

export interface OutboundView {
  tag: string
  alive: boolean | null
  delayMs: number
  hasHealthPing: boolean
  all: number
  fail: number
  avgNs: number
  devNs: number
  minNs: number
  maxNs: number
  lastErr: string
  /** Recent RTTs in ms; -1 marks a failure so the sparkline can show a gap. */
  spark: number[]
  inFlight: number
  faultKind: string | null
  lastSeenMonoNs: number
  /** Dials the fault engine intercepted. Immediate proof a fault is firing — the
   *  alive/dead dot comes from the observatory and can lag by minutes. */
  faultHits: number
  lastFaultMonoNs: number
}

export interface BalancerView {
  tag: string
  strategy: string
  selectors: string[]
  candidates: string[]
  selected: string
  source: string
  fallbackTag: string
  err: string
  lastEvalMonoNs: number
  /** Tag -> share of the last N decisions, for spotting flapping. */
  pickShare: Record<string, number>
  evalCount: number
}

export interface LogPathsEvent extends Envelope {
  access: string
  error: string
}

export interface Snapshot {
  state: StateEvent | null
  epoch: number
  outbounds: OutboundView[]
  balancers: BalancerView[]
  bus: { emitted: number; dropped: number; queueDepth: number; queueCap: number }
  eventsPerSec: number
  /** Most recent decision per balancer tag, for the funnel. */
  lastEvals: Record<string, BalancerEvalEvent>
  recentLogs: LogEvent[]
  recentRules: RuleMatchEvent[]
  recentDials: DialEvent[]
  faults: FaultRule[]
  /** Where this instance's logs are written. The app assigns these, not the config. */
  logPaths: { access: string; error: string } | null
  /** True when the sidecar process is up, regardless of instance state. */
  sidecarUp: boolean
  sidecarError: string | null
  configPath: string | null
  xrayVersion: string | null
}

export const emptySnapshot = (): Snapshot => ({
  state: null,
  epoch: 0,
  outbounds: [],
  balancers: [],
  bus: { emitted: 0, dropped: 0, queueDepth: 0, queueCap: 0 },
  eventsPerSec: 0,
  lastEvals: {},
  recentLogs: [],
  recentRules: [],
  recentDials: [],
  faults: [],
  logPaths: null,
  sidecarUp: false,
  sidecarError: null,
  configPath: null,
  xrayVersion: null,
})

/** Series for the RTT chart, kept out of the 30Hz snapshot because it is large. */
export interface RttSeries {
  tags: string[]
  /** Seconds since sidecar start. */
  t: number[]
  /** Per tag, aligned with t. null = no sample at that instant. */
  values: (number | null)[][]
  /** Failures, plotted as rug marks rather than as huge RTT spikes. */
  failures: { tag: string; t: number }[]
  /** Vertical annotations: fault applied/cleared, epoch boundaries. */
  markers: { t: number; label: string; kind: 'fault' | 'epoch' | 'pick' }[]
}


/* ── what-if simulation ─────────────────────────────────────────────────────────
 *
 * Mirrors sidecar/sim. The sidecar runs the REAL strategy code against the supplied
 * observation, so a simulated answer cannot drift from live behaviour — which is why
 * the renderer sends a request rather than reimplementing the algorithms locally.
 */

export interface SimOverride {
  tag: string
  dead?: boolean
  delayMs?: number
  devNs?: number
  failPct?: number
  remove?: boolean
}

export interface SimCostRule {
  regexp?: boolean
  match: string
  value?: number
}

export interface SimRequest {
  balancerTag: string
  strategy: string
  fallbackTag?: string
  candidates: string[]
  observation: ObsRow[]
  overrides?: SimOverride[]
  expected?: number
  maxRttMs?: number
  tolerance?: number
  baselineMs?: number[]
  costs?: SimCostRule[]
  trials?: number
}

export interface SimOutcome {
  tag: string
  count: number
  share: number
}

export interface SimResponse {
  trace: BalancerEvalEvent
  distribution: SimOutcome[]
  trials: number
  /** True only when every trial produced the same tag. */
  deterministic: boolean
}


/* ── self-check ────────────────────────────────────────────────────────────────
 *
 * The dashboard asserts things about Xray's behaviour. These verify those claims
 * against the core's own answers, continuously, so a wrong claim becomes visible
 * instead of quietly misleading.
 */

export type CheckStatus = 'ok' | 'warn' | 'fail' | 'skipped'

export interface SelfCheckItem {
  id: string
  subject: string
  status: CheckStatus
  summary: string
  detail?: string
  expected?: string
  actual?: string
}

export interface SelfCheckReport {
  checks: SelfCheckItem[]
  ok: number
  warn: number
  fail: number
}


/* ── parameter documentation ───────────────────────────────────────────────────
 *
 * Extracted from XTLS/Xray-docs-next (CC BY-SA 4.0) by tools/docsgen, keyed by config
 * path. See data/docs-en/ATTRIBUTION.md.
 */

export interface ParamDoc {
  path: string
  name: string
  type: string
  summary: string
  detail?: string
  source: string
}

export interface DocBundle {
  docsCommit: string
  license: string
  attribution: string
  params: Record<string, ParamDoc>
}


/* ── generated protocol schema ─────────────────────────────────────────────────
 *
 * Emitted by tools/schemagen from the pinned Xray source. This covers the one part of
 * the config runtime reflection cannot see: `settings` is a json.RawMessage decoded by
 * a string-keyed registry, so the protocol-specific keys exist only in the source.
 */

export interface SchemaField {
  name: string
  type: string
  doc?: string
  ref?: string
  list?: boolean
}

export interface SchemaStruct {
  name: string
  doc?: string
  fields: SchemaField[]
}

export interface SchemaRegistry {
  key: string
  section: string
  types: Record<string, string>
}

export interface ProtocolSchema {
  source: string
  registries: Record<string, SchemaRegistry>
  types: Record<string, SchemaStruct>
}

/* ── geodata profiles ─────────────────────────────────────────────────────── */

export type GeoFile = 'geoip' | 'geosite'

export interface GeoProfile {
  id: string
  name: string
  /** Where it came from. The default cannot be edited; the others can be removed. */
  source: 'default' | 'url' | 'happ'
  geoipUrl?: string
  geositeUrl?: string
  addedAt: number
  /** What has actually been fetched. Either may be absent — a profile need not carry both. */
  files: Partial<Record<GeoFile, { bytes: number; at: number }>>
}

export interface GeoState {
  active: string
  profiles: GeoProfile[]
}
