import { useEffect, useState } from 'react'
import { effectiveConfigPath, useApp, type Tab } from './store/app'
import { PasteConfig } from './components/PasteConfig'
import { Sidebar } from './panels/Sidebar'
import { Observe } from './panels/Observe'
import { Faults } from './panels/Faults'
import { WhatIf } from './panels/WhatIf'
import { SelfCheck } from './panels/SelfCheck'
import { Validate } from './panels/Validate'
import { Reference } from './panels/Reference'
import { Protocols } from './panels/Protocols'
import { LogPanel } from './panels/LogPanel'
import { Build } from './panels/Build'
import { Editor } from './panels/Editor'
import { DocLangSwitch } from './components/DocLangSwitch'
import { GeodataDialog } from './components/GeodataDialog'
import { PanelBoundary } from './components/PanelBoundary'

const TABS: { id: Tab; label: string }[] = [
  { id: 'observe', label: 'Observe' },
  { id: 'build', label: 'Graph' },
  { id: 'editor', label: 'Editor' },
  { id: 'faults', label: 'Faults' },
  { id: 'whatif', label: 'What-if' },
  { id: 'validate', label: 'Validate' },
  { id: 'selfcheck', label: 'Self-check' },
  { id: 'reference', label: 'Reference' },
  { id: 'protocols', label: 'Protocols' },
  { id: 'log', label: 'Log' },
]

export function App(): React.JSX.Element {
  const {
    snap,
    tab,
    setTab,
    setSnapshot,
    appendCoreLog,
    configPath,
    openConfig,
    start,
    stop,
    busy,
    error,
    setError,
    configDirty,
    setConfigDirty,
    setConfigPath,
    clearAllFaults,
    openPastedConfig,
  } = useApp()
  const [pasting, setPasting] = useState(false)
  const [geodataOpen, setGeodataOpen] = useState(false)
  const [geoName, setGeoName] = useState<string | null>(null)
  const [geoProgress, setGeoProgress] = useState('')

  // The active profile's name for the topbar, refreshed whenever the dialog closes —
  // that is the only place it changes.
  useEffect(() => {
    if (geodataOpen) return
    void window.xraystudio.geodata.list().then((st) => {
      setGeoName(st.profiles.find((p) => p.id === st.active)?.name ?? null)
    })
  }, [geodataOpen])
  useEffect(() => window.xraystudio.geodata.onProgress(setGeoProgress), [])

  // The topbar reserves room for the macOS traffic lights, which do not exist elsewhere.
  useEffect(() => {
    document.documentElement.dataset['platform'] = window.xraystudio.platform
  }, [])

  useEffect(() => {
    const offSnap = window.xraystudio.onSnapshot(setSnapshot)
    const offLog = window.xraystudio.onCoreLog(appendCoreLog)
    const offCfg = window.xraystudio.onConfigChanged(() => setConfigDirty(true))
    const offOpen = window.xraystudio.onConfigOpened((p) => setConfigPath(p))
    const offMenu = window.xraystudio.onMenuOpenConfig(() => void openConfig())
    return () => {
      offSnap()
      offLog()
      offCfg()
      offOpen()
      offMenu()
    }
  }, [setSnapshot, appendCoreLog, setConfigDirty, setConfigPath, openConfig])

  const shownPath = effectiveConfigPath({ configPath, snap })
  const state = snap.state?.state ?? (snap.sidecarUp ? 'stopped' : 'stopped')
  const running = state === 'running'
  const activeFaults = snap.faults.filter((f) => f.enabled).length

  return (
    <div className="app">
      <header className="topbar">
        <div className="tb-left">
          <button onClick={() => void openConfig()}>Open config…</button>
          <button onClick={() => setPasting(true)} title="Paste config JSON instead of opening a file">
            Paste JSON…
          </button>
          <span className="path mono" title={shownPath ?? ''}>
            {shownPath ? shownPath.split('/').slice(-2).join('/') : 'no config'}
          </span>
          {configDirty && (
            <button className="warn-btn" onClick={() => void start()} title="the file changed on disk">
              Reload
            </button>
          )}
        </div>

        <div className="tb-mid">
          <button className="primary" disabled={!shownPath || busy || running} onClick={() => void start()}>
            Start
          </button>
          <button disabled={!running || busy} onClick={() => void stop()}>
            Stop
          </button>
          <span className={`pill ${state}`}>{state}</span>
          {snap.state?.err && <span className="bad err" title={snap.state.err}>{snap.state.err.slice(0, 80)}</span>}
        </div>

        <div className="tb-right">
          <span className="dim mono" title="events per second from the sidecar">
            {snap.eventsPerSec}/s
          </span>
          <span
            className={snap.bus.dropped > 0 ? 'bad mono' : 'dim mono'}
            title="Events dropped by the bounded event queue. Anything above zero means the UI is not seeing everything."
          >
            drop {snap.bus.dropped}
          </span>
          {snap.xrayVersion && <span className="chip tiny">xray {snap.xrayVersion}</span>}
          <button
            className="ghost geo-btn"
            onClick={() => setGeodataOpen(true)}
            title="geoip.dat / geosite.dat profile used by the next Start"
          >
            geodata
            {geoName && <span className="dim"> · {geoName.split(' /')[0]}</span>}
          </button>
          {geoProgress && <span className="tiny warn mono">{geoProgress}</span>}
          <button
            className={activeFaults > 0 ? 'danger' : ''}
            disabled={activeFaults === 0}
            onClick={() => void clearAllFaults()}
            title="Disable every fault at once"
          >
            Chaos off{activeFaults > 0 ? ` (${activeFaults})` : ''}
          </button>
          <DocLangSwitch />
        </div>
      </header>

      {geodataOpen && <GeodataDialog onClose={() => setGeodataOpen(false)} />}

      {pasting && (
        <PasteConfig
          onCancel={() => setPasting(false)}
          onAccept={(text) => {
            setPasting(false)
            void openPastedConfig(text)
          }}
        />
      )}

      {error && (
        <div className="banner bad">
          {error}
          <button className="link" onClick={() => setError(null)}>
            dismiss
          </button>
        </div>
      )}
      {!snap.sidecarUp && snap.sidecarError && (
        <div className="banner bad">{snap.sidecarError}</div>
      )}

      <div className="body">
        <Sidebar />
        <main className="main">
          <nav className="tabs">
            {TABS.map((t) => (
              <button key={t.id} className={tab === t.id ? 'tab sel' : 'tab'} onClick={() => setTab(t.id)}>
                {t.label}
                {t.id === 'faults' && activeFaults > 0 && <span className="chip tiny bad">{activeFaults}</span>}
              </button>
            ))}
          </nav>
          {/* The graph is a canvas: it fills the window and navigates internally, so the
              tab body must not also scroll. Every other tab is a document and keeps the
              default scrolling behaviour. */}
          {/* Per tab, not once around the whole body: the boundary resets when its
              children change, and one wrapper for every tab would clear the error on
              the next tab switch and lose it. */}
          <div className={tab === 'build' ? 'tab-body tab-body-fill' : 'tab-body'}>
            <PanelBoundary what={tab}>
            {tab === 'observe' && <Observe />}
            {tab === 'build' && <Build />}
            {tab === 'editor' && <Editor />}
            {tab === 'whatif' && <WhatIf />}
            {tab === 'validate' && <Validate />}
            {tab === 'selfcheck' && <SelfCheck />}
            {tab === 'reference' && <Reference />}
            {tab === 'protocols' && <Protocols />}
            {tab === 'faults' && <Faults />}
            {tab === 'log' && <LogPanel />}
            </PanelBoundary>
          </div>
        </main>
      </div>
    </div>
  )
}
