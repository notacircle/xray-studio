import { useApp } from '../store/app'
import { fmtMs, fmtMsFromMs, isDeadSentinel } from '../lib/copy'
import { DecisionFunnel } from './DecisionFunnel'
import { RttTimeline } from './RttTimeline'
import type { BalancerView } from '@shared/events'

/**
 * Highlights the columns the ACTIVE strategy actually sorts by, so the table itself
 * explains the ranking rather than being a wall of numbers.
 */
function sortKeysFor(strategy: string): Set<string> {
  switch (strategy) {
    case 'leastload':
      return new Set(['dev', 'avg', 'fail', 'all'])
    case 'leastping':
      return new Set(['delay'])
    default:
      return new Set(['alive'])
  }
}

export function Observe(): React.JSX.Element {
  const { snap, selectedBalancer, selectBalancer } = useApp()
  const active = snap.balancers.find((b) => b.tag === selectedBalancer) ?? snap.balancers[0]
  const keys = sortKeysFor(active?.strategy ?? '')
  const evalEvent = selectedBalancer ? (snap.lastEvals[selectedBalancer] ?? null) : null

  const shape = snap.state?.shape
  const running = snap.state?.state === 'running'

  return (
    <div className="observe">
      {/* A config with no observatory and no balancer is valid, runs fine, and gives
          every probe-driven panel nothing to show. Left unexplained, that reads as the
          application not working — which is precisely how it was reported. So say what
          the config lacks, what still works, and where to add the missing part. */}
      {running && shape && (!shape.has_observatory || !shape.has_balancer) && (
        <section className="panel note info shape-note">
          <strong>
            {!shape.has_observatory && !shape.has_balancer
              ? 'This config has no observatory and no balancer.'
              : !shape.has_observatory
                ? 'This config has a balancer but no observatory.'
                : 'This config has an observatory but no balancer.'}
          </strong>{' '}
          {!shape.has_observatory && (
            <>
              Nothing probes the outbounds, so the RTT chart, the probe lane and this table stay empty
              and every outbound reads as <em>never probed</em>.{' '}
            </>
          )}
          {!shape.has_balancer && (
            <>
              No balancer runs, so there are no decisions to trace here or in What-if.{' '}
            </>
          )}
          It is running, and the rest works on real traffic: send connections through an inbound
          and they show up in <strong>Faults</strong> evidence and the <strong>Log</strong>;{' '}
          <strong>Graph</strong>, <strong>Editor</strong> and <strong>Validate</strong> read the config
          itself. To see the balancer side, add an{' '}
          <code className="inline-code">observatory</code> and a{' '}
          <code className="inline-code">routing.balancers</code> entry — the Graph tab can add both.
        </section>
      )}
      <RttTimeline />

      <section className="panel">
        <h3>Probe results</h3>
        {snap.outbounds.length === 0 ? (
          <p className="dim">
            Nothing probed yet. An observatory or burstObservatory block is what produces
            these rows — without one, leastPing and leastLoad have nothing to rank.
          </p>
        ) : (
          <table className="grid">
            <thead>
              <tr>
                <th>outbound</th>
                <th className={keys.has('alive') ? 'key' : ''}>alive</th>
                <th className={keys.has('delay') ? 'key' : ''}>delay</th>
                <th className={keys.has('avg') ? 'key' : ''}>avg</th>
                <th className={keys.has('dev') ? 'key' : ''}>deviation</th>
                <th>min / max</th>
                <th className={keys.has('fail') ? 'key' : ''}>fail</th>
                <th className={keys.has('all') ? 'key' : ''}>samples</th>
                <th>last error</th>
              </tr>
            </thead>
            <tbody>
              {snap.outbounds.map((ob) => (
                <tr key={ob.tag} className={ob.alive === false ? 'dead' : ''}>
                  <td className="mono">
                    {ob.tag}
                    {ob.faultKind && <span className="chip tiny bad">{ob.faultKind}</span>}
                  </td>
                  <td>
                    {ob.alive === null ? (
                      <span className="dim" title="never probed — invisible to leastPing/leastLoad">
                        untested
                      </span>
                    ) : ob.alive ? (
                      <span className="ok">yes</span>
                    ) : (
                      <span className="bad">no</span>
                    )}
                  </td>
                  <td
                    className={isDeadSentinel(ob.delayMs) ? 'mono bad' : 'mono'}
                    title={
                      isDeadSentinel(ob.delayMs)
                        ? 'Not a measurement: the observatory stores 99999999 as its dead marker.'
                        : ob.delayMs === 0
                          ? 'Delay truncates to whole milliseconds, so sub-1ms reads as 0'
                          : ''
                    }
                  >
                    {fmtMsFromMs(ob.delayMs)}
                  </td>
                  <td className="mono dim">{ob.hasHealthPing ? fmtMs(ob.avgNs) : '—'}</td>
                  <td className="mono dim">{ob.hasHealthPing ? fmtMs(ob.devNs) : '—'}</td>
                  <td className="mono dim">
                    {ob.hasHealthPing ? `${fmtMs(ob.minNs)} / ${fmtMs(ob.maxNs)}` : '—'}
                  </td>
                  <td className="mono">{ob.hasHealthPing ? ob.fail : '—'}</td>
                  <td className="mono">{ob.hasHealthPing ? ob.all : '—'}</td>
                  <td className="dim err" title={ob.lastErr}>
                    {ob.lastErr.slice(0, 60)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
        {snap.outbounds.some((o) => o.alive !== null && !o.hasHealthPing) && (
          <p className="note warn">
            Some rows have no HealthPing data — that is the plain observatory rather than
            burstObservatory. leastLoad then ranks on raw delay instead of deviation,
            which makes it behave like leastPing with a cost multiplier.
          </p>
        )}
      </section>

      <section className="panel">
        <h3>Balancers</h3>
        <div className="bal-cards">
          {snap.balancers.map((b) => (
            <BalancerCard key={b.tag} b={b} onClick={() => selectBalancer(b.tag)} active={b.tag === selectedBalancer} />
          ))}
          {snap.balancers.length === 0 && (
            <p className="dim">
              No balancer has run yet. They evaluate once per dispatched connection, so
              send traffic through an inbound that routes to a balancerTag.
            </p>
          )}
        </div>
      </section>

      <section className="panel">
        <h3>Why this outbound?</h3>
        <DecisionFunnel evalEvent={evalEvent} />
      </section>
    </div>
  )
}

function BalancerCard({
  b,
  onClick,
  active,
}: {
  b: BalancerView
  onClick: () => void
  active: boolean
}): React.JSX.Element {
  const shares = Object.entries(b.pickShare).sort((a, b2) => b2[1] - a[1])
  const noCandidates = b.candidates.length === 0

  return (
    <div className={`card ${active ? 'sel' : ''}`} onClick={onClick}>
      <div className="card-head">
        <strong>{b.tag}</strong>
        <span className="chip">{b.strategy}</span>
      </div>
      <div className="card-pick">{b.selected || '(none)'}</div>
      <div className="card-meta">
        <span className={noCandidates ? 'bad' : 'dim'}>
          {b.candidates.length} candidate{b.candidates.length === 1 ? '' : 's'}
        </span>
        {b.fallbackTag && <span className="dim">fallback {b.fallbackTag}</span>}
        <span className="dim">{b.evalCount} evals</span>
      </div>
      {noCandidates && (
        <div className="note bad">
          Selector {b.selectors.join(', ') || '(empty)'} matches no outbound. Xray does
          not check this at load time — balancers are built before outbounds exist.
        </div>
      )}
      {shares.length > 1 && (
        <div className="share" title="distribution over the last 50 decisions">
          {shares.map(([tag, frac]) => (
            <div key={tag} className="share-seg" style={{ width: `${frac * 100}%` }} title={`${tag} ${(frac * 100).toFixed(0)}%`}>
              <span>{tag}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
