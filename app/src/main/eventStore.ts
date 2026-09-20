import type {
  BalancerEvalEvent,
  BalancerView,
  BusStatsEvent,
  DialEvent,
  Envelope,
  FaultRule,
  LogEvent,
  ObservationEvent,
  OutboundView,
  ProbeEvent,
  RuleMatchEvent,
  RttSeries,
  Snapshot,
  StateEvent,
} from '@shared/events'
import { EventType, emptySnapshot, tagsMatching } from '@shared/events'

const SPARK_LEN = 60
const RECENT_LOGS = 400
const RECENT_RULES = 200
const RECENT_DIALS = 200
const PICK_WINDOW = 50
const RTT_POINTS = 3600

/** Marks a failed probe in a sparkline. Never plotted as a value. */
const FAILURE = -1

interface OutboundState extends OutboundView {}

/**
 * Aggregates the raw event stream into a snapshot the renderer can render.
 *
 * The renderer NEVER sees raw events. With 20 outbounds at samplingCount 10 the probe
 * storm alone exceeds 1000 events/s; per-event IPC plus a React render per event
 * would be unusable. Instead everything lands in ring buffers here and is pushed as a
 * coalesced snapshot at 30Hz.
 */
export class EventStore {
  private outbounds = new Map<string, OutboundState>()
  private balancers = new Map<string, BalancerView>()
  private lastEvals: Record<string, BalancerEvalEvent> = {}
  private logs: LogEvent[] = []
  private rules: RuleMatchEvent[] = []
  private dials: DialEvent[] = []
  private picks = new Map<string, string[]>()
  private state: StateEvent | null = null
  private bus = { emitted: 0, dropped: 0, queueDepth: 0, queueCap: 0 }
  /** Our own instance-lifetime counter, shown in the UI. Only ever goes up. */
  private epoch = 0
  /**
   * The epoch reported by the CURRENT sidecar process, tracked separately.
   *
   * The sidecar's counter is per-process and starts over at 1, and reload is a
   * respawn — so comparing incoming events against our own counter would stop
   * detecting new lifetimes after the first restart, leaving stale outbound and
   * balancer rows on screen as if they were live.
   */
  private sidecarEpoch = 0
  private faults: FaultRule[] = []
  private logPaths: { access: string; error: string } | null = null
  private sidecarUp = false
  private sidecarError: string | null = null
  private configPath: string | null = null
  private xrayVersion: string | null = null

  // RTT history, kept out of the 30Hz snapshot because it is large and changes
  // slowly relative to the UI frame rate.
  private rttT: number[] = []
  private rttByTag = new Map<string, (number | null)[]>()
  private failures: { tag: string; t: number }[] = []
  private markers: RttSeries['markers'] = []

  private eventTimes: number[] = []
  private dirty = true

  /**
   * A fresh sidecar process is about to start.
   *
   * Nothing is cleared here. The new process numbers its epochs from 1 again, so
   * forgetting the previous process's number is enough — the first event to arrive
   * then reads as a new lifetime and clears the per-instance state itself, with a
   * marker stamped from the sidecar's own monotonic clock, which is the only clock
   * the RTT chart is plotted against.
   */
  beginSidecar(): void {
    this.sidecarEpoch = 0
    this.dirty = true
  }

  setSidecar(up: boolean, version: string | null, err: string | null = null): void {
    this.sidecarUp = up
    this.xrayVersion = version
    this.sidecarError = err
    this.dirty = true
  }

  setFaults(rules: FaultRule[]): void {
    this.faults = rules
    this.dirty = true
    // Reflect the fault on the outbound rows immediately, rather than waiting for
    // the next dial to reveal it — the user just clicked a button and expects to see
    // it take effect.
    for (const ob of this.outbounds.values()) {
      ob.faultKind = this.faultKindFor(ob.tag)
      ob.faultHits = 0
      ob.lastFaultMonoNs = 0
    }
  }

  /** The rules the UI believes are in force. Re-armed against every fresh sidecar. */
  currentFaults(): FaultRule[] {
    return this.faults
  }

  /** Which enabled rule, if any, covers this tag. First match wins, as in the sidecar. */
  private faultKindFor(tag: string): string | null {
    for (const rule of this.faults) {
      if (rule.enabled && tagsMatching(rule.tagGlob, [tag]).length > 0) return rule.kind
    }
    return null
  }

  ingest(ev: Envelope): void {
    this.eventTimes.push(Date.now())
    this.dirty = true

    if (ev.epoch > this.sidecarEpoch) {
      /* A new instance lifetime: everything measured about the previous one goes.
      
         The chart used to survive this, so a restart could be read across. In practice
         it made a Stop/Start look broken rather than useful: the outbound rows, the
         sparklines and the probe table were all cleared here, and the chart alone kept
         its history — so half the screen reset and half did not, with old measurements
         sitting under a fresh, empty table.
      
         There is a correctness reason too. Reload also comes through here, and a
         reloaded config can rename, add or remove outbounds; the surviving columns were
         then keyed to tags the new instance may never mention again, drawn as live
         series that can never gain another point. */
      this.sidecarEpoch = ev.epoch
      this.epoch++
      this.outbounds.clear()
      this.balancers.clear()
      this.lastEvals = {}
      this.rttT = []
      this.rttByTag.clear()
      this.failures = []
      // Markers annotate positions on the chart. With the chart gone they would all
      // point into empty space, and an epoch marker at the origin says nothing that
      // the empty chart does not.
      this.markers = []
    }

    switch (ev.type) {
      case EventType.State: {
        this.state = ev as StateEvent
        this.configPath = (ev as StateEvent).config_path ?? this.configPath
        // List every outbound the config declares from the moment it starts. Rows used
        // to appear only once telemetry mentioned a tag — a probe or a dial — so a
        // config with no observatory and no traffic yet showed an empty rail, and an
        // empty rail reads as a broken app. Seeded rows carry alive=null, which the UI
        // already renders as "never probed", which is exactly the truth.
        for (const tag of (ev as StateEvent).shape?.outbound_tags ?? []) this.outbound(tag)
        break
      }
      case EventType.ProbeStart: {
        this.outbound((ev as ProbeEvent).tag).inFlight++
        break
      }
      case EventType.ProbeEnd: {
        const p = ev as ProbeEvent
        const ob = this.outbound(p.tag)
        ob.inFlight = Math.max(0, ob.inFlight - 1)
        ob.lastSeenMonoNs = p.mono_ns
        const tSec = p.mono_ns / 1e9
        if (p.class === 'ok' && p.rtt_ns) {
          const ms = p.rtt_ns / 1e6
          push(ob.spark, ms, SPARK_LEN)
          this.appendRtt(p.tag, tSec, ms)
        } else {
          push(ob.spark, FAILURE, SPARK_LEN)
          this.appendRtt(p.tag, tSec, null)
          this.failures.push({ tag: p.tag, t: tSec })
          if (this.failures.length > RTT_POINTS) this.failures.shift()
          if (p.err) ob.lastErr = p.err
        }
        break
      }
      case EventType.Observation: {
        for (const row of (ev as ObservationEvent).rows) {
          const ob = this.outbound(row.tag)
          ob.alive = row.alive
          ob.delayMs = row.delay_ms
          ob.hasHealthPing = row.has_hp
          ob.all = row.all ?? 0
          ob.fail = row.fail ?? 0
          ob.avgNs = row.avg_ns ?? 0
          ob.devNs = row.dev_ns ?? 0
          ob.minNs = row.min_ns ?? 0
          ob.maxNs = row.max_ns ?? 0
          if (row.last_err) ob.lastErr = row.last_err
        }
        break
      }
      case EventType.BalancerEval: {
        const b = ev as BalancerEvalEvent
        this.lastEvals[b.balancer_tag] = b
        const view = this.balancer(b.balancer_tag)
        view.strategy = b.strategy
        view.selectors = b.selectors ?? []
        view.candidates = b.candidates ?? []
        view.selected = b.selected
        view.source = b.source
        view.fallbackTag = b.fallback_tag ?? ''
        view.err = b.err ?? ''
        view.lastEvalMonoNs = b.mono_ns
        view.evalCount++

        const hist = this.picks.get(b.balancer_tag) ?? []
        hist.push(b.selected || '(none)')
        if (hist.length > PICK_WINDOW) hist.shift()
        this.picks.set(b.balancer_tag, hist)
        view.pickShare = share(hist)
        break
      }
      case EventType.RuleMatch: {
        push(this.rules, ev as RuleMatchEvent, RECENT_RULES)
        break
      }
      case EventType.Dial: {
        const d = ev as DialEvent
        push(this.dials, d, RECENT_DIALS)
        const ob = this.outbound(d.tag) // ensure the row exists even before any observation
        // Count dials the fault engine actually intercepted.
        //
        // This is the only immediate evidence a fault is working. The alive/dead dot
        // comes from the observatory, which can lag by MINUTES — burstObservatory's
        // defaults (interval 1m, sampling 10) give a 10-minute round, and `alive` only
        // flips once the whole window has failed. Without this counter the engine looks
        // broken when it is in fact faulting every dial.
        if (d.fault_kind) {
          ob.faultHits++
          ob.lastFaultMonoNs = d.mono_ns
        }
        break
      }
      case EventType.Log: {
        push(this.logs, ev as LogEvent, RECENT_LOGS)
        break
      }
      case EventType.Fault: {
        this.markers.push({
          t: ev.mono_ns / 1e9,
          label: `${(ev as never as { action: string }).action} ${(ev as never as { id: string }).id}`,
          kind: 'fault',
        })
        break
      }
      case EventType.LogPaths: {
        const r = ev as never as { access: string; error: string }
        this.logPaths = { access: r.access, error: r.error }
        break
      }
      case EventType.BusStats: {
        const b = ev as BusStatsEvent
        this.bus = {
          emitted: b.emitted,
          dropped: b.dropped,
          queueDepth: b.queue_depth,
          queueCap: b.queue_cap,
        }
        break
      }
      default:
        break
    }
  }

  /** Appends one RTT sample, keeping every series aligned to a shared time axis. */
  private appendRtt(tag: string, t: number, value: number | null): void {
    if (!this.rttByTag.has(tag)) {
      this.rttByTag.set(tag, new Array(this.rttT.length).fill(null))
    }
    this.rttT.push(t)
    for (const [k, arr] of this.rttByTag) {
      arr.push(k === tag ? value : null)
      if (arr.length > RTT_POINTS) arr.shift()
    }
    if (this.rttT.length > RTT_POINTS) this.rttT.shift()
  }

  private outbound(tag: string): OutboundState {
    let ob = this.outbounds.get(tag)
    if (!ob) {
      ob = {
        tag,
        alive: null,
        delayMs: 0,
        hasHealthPing: false,
        all: 0,
        fail: 0,
        avgNs: 0,
        devNs: 0,
        minNs: 0,
        maxNs: 0,
        lastErr: '',
        spark: [],
        inFlight: 0,
        // Seed from the rules in force rather than null. Rows are recreated from
        // scratch after a restart, and a row that appeared while a fault was already
        // armed would otherwise show no badge until the rules were edited again.
        faultKind: this.faultKindFor(tag),
        faultHits: 0,
        lastFaultMonoNs: 0,
        lastSeenMonoNs: 0,
      }
      this.outbounds.set(tag, ob)
    }
    return ob
  }

  private balancer(tag: string): BalancerView {
    let b = this.balancers.get(tag)
    if (!b) {
      b = {
        tag,
        strategy: '',
        selectors: [],
        candidates: [],
        selected: '',
        source: '',
        fallbackTag: '',
        err: '',
        lastEvalMonoNs: 0,
        pickShare: {},
        evalCount: 0,
      }
      this.balancers.set(tag, b)
    }
    return b
  }

  snapshot(): Snapshot {
    const now = Date.now()
    this.eventTimes = this.eventTimes.filter((t) => now - t < 1000)

    return {
      ...emptySnapshot(),
      state: this.state,
      epoch: this.epoch,
      outbounds: [...this.outbounds.values()].sort((a, b) => a.tag.localeCompare(b.tag)),
      balancers: [...this.balancers.values()].sort((a, b) => a.tag.localeCompare(b.tag)),
      bus: this.bus,
      eventsPerSec: this.eventTimes.length,
      lastEvals: this.lastEvals,
      recentLogs: this.logs.slice(-150),
      recentRules: this.rules.slice(-60),
      recentDials: this.dials.slice(-60),
      faults: this.faults,
      logPaths: this.logPaths,
      sidecarUp: this.sidecarUp,
      sidecarError: this.sidecarError,
      configPath: this.configPath,
      xrayVersion: this.xrayVersion,
    }
  }

  rttSeries(): RttSeries {
    const tags = [...this.rttByTag.keys()].sort()
    return {
      tags,
      t: this.rttT,
      values: tags.map((tag) => this.rttByTag.get(tag) ?? []),
      failures: this.failures,
      markers: this.markers.slice(-100),
    }
  }

  takeDirty(): boolean {
    const d = this.dirty
    this.dirty = false
    return d
  }
}

function push<T>(arr: T[], v: T, max: number): void {
  arr.push(v)
  if (arr.length > max) arr.shift()
}

function share(hist: string[]): Record<string, number> {
  const counts: Record<string, number> = {}
  for (const h of hist) counts[h] = (counts[h] ?? 0) + 1
  const out: Record<string, number> = {}
  for (const [k, v] of Object.entries(counts)) out[k] = v / hist.length
  return out
}

