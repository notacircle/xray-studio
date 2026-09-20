import { useEffect, useState } from 'react'
import type { GeoProfile, GeoState } from '@shared/events'

/**
 * geoip.dat / geosite.dat profiles.
 *
 * Xray looks for these beside its own binary, which in a packaged app is a read-only
 * bundle that has never contained them — so the first config with a `geoip:` rule
 * failed with a path nobody could act on. Profiles make the location a choice: pick
 * one here, and the sidecar is pointed at it on every start.
 *
 * A profile is a pair of URLs; the files are whatever has been fetched. Either may be
 * missing, and the validator says precisely which one a config needs.
 */
export function GeodataDialog({ onClose }: { onClose: () => void }): React.JSX.Element {
  const [state, setState] = useState<GeoState | null>(null)
  const [busy, setBusy] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [progress, setProgress] = useState('')
  const [mode, setMode] = useState<'urls' | 'happ'>('urls')
  const [name, setName] = useState('')
  const [geoipUrl, setGeoipUrl] = useState('')
  const [geositeUrl, setGeositeUrl] = useState('')
  const [happ, setHapp] = useState('')

  useEffect(() => {
    void window.xraystudio.geodata.list().then(setState)
    return window.xraystudio.geodata.onProgress(setProgress)
  }, [])

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  const run = async (label: string, op: () => Promise<GeoState>): Promise<void> => {
    setBusy(label)
    setError(null)
    try {
      setState(await op())
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setBusy(null)
      setProgress('')
    }
  }

  const add = (): void => {
    if (mode === 'happ') {
      void run('add', () => window.xraystudio.geodata.addHapp(happ)).then(() => setHapp(''))
    } else {
      void run('add', () => window.xraystudio.geodata.add({ name, geoipUrl, geositeUrl })).then(() => {
        setName('')
        setGeoipUrl('')
        setGeositeUrl('')
      })
    }
  }

  return (
    <div className="modal-scrim" onMouseDown={onClose}>
      <div className="modal geodata" onMouseDown={(e) => e.stopPropagation()}>
        <div className="modal-head">
          <h3>Geodata</h3>
          <button className="link" onClick={onClose}>
            close
          </button>
        </div>

        <p className="tiny dim">
          <code className="inline-code">geoip.dat</code> and{' '}
          <code className="inline-code">geosite.dat</code> for <code className="inline-code">geoip:</code> /{' '}
          <code className="inline-code">geosite:</code> rules. The selected profile is handed to Xray on the
          next Start or Reload — a running instance keeps the one it started with. Files are fetched only
          when you press Fetch, or when you start a config that needs one the profile has not fetched yet.
        </p>

        {!state ? (
          <p className="dim">Loading…</p>
        ) : (
          <div className="geo-list">
            {state.profiles.map((p) => (
              <ProfileRow
                key={p.id}
                p={p}
                active={p.id === state.active}
                busy={busy}
                onSelect={() => void run('select', () => window.xraystudio.geodata.select(p.id))}
                onFetch={() => void run(`fetch:${p.id}`, () => window.xraystudio.geodata.download(p.id))}
                onRemove={() => void run('remove', () => window.xraystudio.geodata.remove(p.id))}
              />
            ))}
          </div>
        )}

        {progress && <p className="tiny warn mono">{progress}</p>}
        {error && <p className="note bad prewrap">{error}</p>}

        <div className="geo-add">
          <div className="seg">
            <button className={mode === 'urls' ? 'on' : ''} onClick={() => setMode('urls')}>
              From URLs
            </button>
            <button className={mode === 'happ' ? 'on' : ''} onClick={() => setMode('happ')}>
              From happ:// link
            </button>
          </div>

          {mode === 'urls' ? (
            <div className="geo-form">
              <input placeholder="Name" value={name} onChange={(e) => setName(e.target.value)} />
              <input
                className="mono"
                placeholder="geoip.dat URL (optional)"
                value={geoipUrl}
                onChange={(e) => setGeoipUrl(e.target.value)}
              />
              <input
                className="mono"
                placeholder="geosite.dat URL (optional)"
                value={geositeUrl}
                onChange={(e) => setGeositeUrl(e.target.value)}
              />
            </div>
          ) : (
            <div className="geo-form">
              <textarea
                className="mono"
                rows={3}
                placeholder="happ://routing/add/…  — the Geoipurl and Geositeurl inside it are used; everything else in the link is ignored"
                value={happ}
                onChange={(e) => setHapp(e.target.value)}
              />
            </div>
          )}
          <div className="row gap">
            <span className="tiny faint">
              {mode === 'urls'
                ? 'One URL is enough — a profile need not carry both files.'
                : 'Many shared routing links leave both URLs empty; that is reported rather than saved.'}
            </span>
            <span className="spacer" />
            <button
              className="primary"
              disabled={busy !== null || (mode === 'urls' ? !geoipUrl.trim() && !geositeUrl.trim() : !happ.trim())}
              onClick={add}
            >
              Add profile
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}

function ProfileRow({
  p,
  active,
  busy,
  onSelect,
  onFetch,
  onRemove,
}: {
  p: GeoProfile
  active: boolean
  busy: string | null
  onSelect: () => void
  onFetch: () => void
  onRemove: () => void
}): React.JSX.Element {
  const canFetch = !!(p.geoipUrl || p.geositeUrl)
  const fetching = busy === `fetch:${p.id}`
  return (
    <div className={`geo-row ${active ? 'sel' : ''}`}>
      <label className="row gap geo-pick">
        <input type="radio" checked={active} onChange={onSelect} disabled={busy !== null} />
        <strong>{p.name}</strong>
        <span className="chip tiny">{p.source}</span>
      </label>
      <div className="geo-files">
        <FileLine file="geoip" p={p} />
        <FileLine file="geosite" p={p} />
      </div>
      <div className="row gap geo-actions">
        {canFetch && (
          <button className="tiny" disabled={busy !== null} onClick={onFetch}>
            {fetching ? 'Fetching…' : p.files.geoip || p.files.geosite ? 'Update' : 'Fetch'}
          </button>
        )}
        {p.source !== 'default' && (
          <button className="tiny link" disabled={busy !== null} onClick={onRemove}>
            remove
          </button>
        )}
      </div>
    </div>
  )
}

function FileLine({ file, p }: { file: 'geoip' | 'geosite'; p: GeoProfile }): React.JSX.Element {
  const f = p.files[file]
  const url = file === 'geoip' ? p.geoipUrl : p.geositeUrl
  return (
    <span className="tiny mono geo-file" title={url ?? 'no URL for this file'}>
      <span className={f ? 'ok' : url ? 'warn' : 'faint'}>{file}.dat</span>{' '}
      <span className="dim">
        {f ? `${(f.bytes / 1048576).toFixed(1)} MB · ${ago(f.at)}` : url ? 'not fetched' : 'no URL'}
      </span>
    </span>
  )
}

function ago(ms: number): string {
  const d = Math.max(0, Date.now() - ms)
  const h = Math.floor(d / 3_600_000)
  if (h < 1) return 'just now'
  if (h < 48) return `${h}h ago`
  return `${Math.floor(h / 24)}d ago`
}
