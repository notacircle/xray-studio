import { app, BrowserWindow, Menu, dialog, ipcMain, shell } from 'electron'
import { dirname, join } from 'node:path'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { watch, type FSWatcher } from 'node:fs'
import type { Envelope, FaultRule, SimRequest } from '@shared/events'
import { accessSync, appendFileSync, constants, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { EventStore } from './eventStore'
import { Sidecar, sidecarPath } from './sidecar'
import * as ai from './ai'
import * as geodata from './geodata'

// Electron's main-process stdout is not reliably captured when the app is launched
// detached, which makes "the window never appeared" impossible to diagnose. Write a
// trace to a file instead when XRAYSTUDIO_TRACE is set.
const TRACE = process.env['XRAYSTUDIO_TRACE']
function trace(msg: string): void {
  if (!TRACE) return
  try {
    appendFileSync(TRACE, `${new Date().toISOString()} ${msg}\n`)
  } catch {
    /* diagnostics must never break the app */
  }
}

const isDev = !app.isPackaged

// Everything Electron derives from the app name — the About panel, the Hide/Quit menu
// items, crash report metadata — follows this. It does NOT fix the bold application
// menu title when running from source: macOS reads that from the running bundle's
// CFBundleName, which in a dev run belongs to Electron itself and is fixed at launch,
// long before any of this executes. Packaged builds get it from productName and read
// correctly.
app.setName('Xray Studio')

app.setAboutPanelOptions({
  applicationName: 'Xray Studio',
  applicationVersion: app.getVersion(),
  credits: 'Tests Xray-core configurations: balancer decision tracing and fault injection.',
})

const store = new EventStore()
let sidecar: Sidecar | null = null
let win: BrowserWindow | null = null
let configWatcher: FSWatcher | null = null
let currentConfig: string | null = null

/** Snapshot cadence. The renderer never sees raw events — see EventStore. */
const SNAPSHOT_HZ = 30

function createWindow(): BrowserWindow {
  const w = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 1100,
    minHeight: 700,
    show: false,
    backgroundColor: '#0e1116',
    // macOS only. On Windows this maps to a frameless window: no title bar and no menu
    // bar, which is both unlike every other app on that platform and how the Paste
    // dialog ended up with no working Ctrl+V — the accelerators live on the menu.
    ...(process.platform === 'darwin' ? { titleBarStyle: 'hiddenInset' as const } : {}),
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      // The renderer displays tags, domains and error text originating from the
      // config under test and from remote servers. Keep it sandboxed.
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  })

  trace(`createWindow: isPackaged=${app.isPackaged} devURL=${process.env['ELECTRON_RENDERER_URL'] ?? '(none)'}`)

  // XRAYSTUDIO_SHOT=<path>[,<delayMs>] captures the window to a PNG from inside the app.
  // Useful for verifying the UI without granting Screen Recording to whatever shell
  // happens to be driving the session.
  const shot = process.env['XRAYSTUDIO_SHOT']
  if (shot) {
    const [file, delay] = shot.split(',')
    setTimeout(
      () => {
        // XRAYSTUDIO_SHOT_JS runs in the renderer first, so a capture can target a
        // specific tab or scroll position.
        const pre = process.env['XRAYSTUDIO_SHOT_JS']
        const ready = pre ? w.webContents.executeJavaScript(pre) : Promise.resolve()
        void ready
          .catch((e: Error) => trace(`shot-js failed: ${e.message}`))
          .then(() => new Promise((r) => setTimeout(r, 500)))
          .then(() => w.webContents.capturePage())
          .then((img) => writeFileSync(file!, img.toPNG()))
          .then(() => trace(`captured ${file}`))
          .catch((e: Error) => trace(`capture failed: ${e.message}`))
      },
      Number(delay ?? 5000),
    )
  }

  /* XRAYSTUDIO_SHOTS=<json> captures a whole sequence from one launch and then quits.
   *
   * The single-shot form above needs one process per image, and the documentation set
   * is a dozen of them: a dozen cold starts, a dozen reconnections to real servers, and
   * a dozen windows taking focus. Worse, each run starts with an empty observatory, so
   * every chart would be captured in the same blank first seconds.
   *
   * The file is [{ file, js?, delay? }, …]. `js` runs in the renderer, `delay` waits
   * after it before capturing — a panel that mounts a chart needs a frame or two to
   * have anything in it. */
  const shots = process.env['XRAYSTUDIO_SHOTS']
  if (shots) {
    void (async () => {
      // Read before the warmup, and traced: an unreadable list is a typo in the caller,
      // and finding out fifteen seconds later through an unhandled rejection — which is
      // to say, through nothing at all — is how this went wrong the first time.
      let steps: { file: string; js?: string; delay?: number }[]
      try {
        steps = JSON.parse(readFileSync(shots, 'utf8'))
        trace(`shots: ${steps.length} step(s) from ${shots}`)
      } catch (e) {
        trace(`shots: cannot read ${shots}: ${(e as Error).message}`)
        return
      }
      // One settling wait before the first frame, so the probes have results to draw.
      await new Promise((r) => setTimeout(r, Number(process.env['XRAYSTUDIO_SHOTS_WARMUP'] ?? 9000)))
      for (const step of steps) {
        try {
          if (step.js) {
            // The result goes to the trace. A capture that lands on the wrong panel is
            // otherwise indistinguishable from one whose script threw, and both look
            // like a correct screenshot of something else.
            const r: unknown = await w.webContents.executeJavaScript(step.js)
            if (r !== undefined) trace(`shot-js returned: ${JSON.stringify(r)}`)
          }
          await new Promise((r) => setTimeout(r, step.delay ?? 900))
          writeFileSync(step.file, (await w.webContents.capturePage()).toPNG())
          trace(`captured ${step.file}`)
        } catch (e) {
          trace(`capture failed for ${step.file}: ${(e as Error).message}`)
        }
      }
      app.quit()
    })()
  }
  w.once('ready-to-show', () => {
    trace('ready-to-show fired -> show()')
    w.show()
    trace(`isVisible=${w.isVisible()} bounds=${JSON.stringify(w.getBounds())}`)
  })

  // Diagnostics: a renderer that fails to load leaves ready-to-show unfired, and the
  // app then sits there with no window and no error — which is indistinguishable from
  // a hang. Report it, and show the window anyway so the failure is visible.
  w.webContents.on('did-finish-load', () => trace('did-finish-load'))
  w.webContents.on('did-fail-load', (_e, code, desc, url) => {
    trace(`load FAILED ${code} ${desc} ${url}`)
    w.show()
  })
  w.webContents.on('render-process-gone', (_e, details) => trace(`renderer gone: ${details.reason}`))
  // Electron 43 replaced the positional arguments with a single event object.
  w.webContents.on('console-message', (e) =>
    trace(`renderer console[${e.level}] ${e.sourceId}:${e.lineNumber} ${e.message}`),
  )
  setTimeout(() => {
    if (w.isDestroyed()) {
      trace('window destroyed before it could be shown')
      return
    }
    trace(`3s check: isVisible=${w.isVisible()} bounds=${JSON.stringify(w.getBounds())}`)
    if (!w.isVisible()) {
      trace('ready-to-show never fired; showing anyway')
      w.show()
      w.focus()
      trace(`after forced show: isVisible=${w.isVisible()}`)
    }
  }, 3000)
  w.webContents.setWindowOpenHandler(({ url }) => {
    void shell.openExternal(url)
    return { action: 'deny' }
  })

  const devURL = process.env['ELECTRON_RENDERER_URL']
  if (isDev && devURL) void w.loadURL(devURL)
  else void w.loadFile(join(__dirname, '../renderer/index.html'))

  return w
}

/**
 * The asset directory for a start, fetching the active profile's files first when the
 * config needs one it does not have yet.
 *
 * Deciding by asking the validator, not by guessing: it reports exactly which of the
 * two files a config references and lacks, so a geosite-only config never triggers a
 * 16 MB geoip download it would not use. The fetch is the user's action — they pressed
 * Start on a config that asks for it — and it is the only way a download ever begins.
 */
async function geodataForStart(sc: Sidecar, path: string): Promise<string> {
  const dir = await geodata.activeDir()
  const { diagnostics } = await sc.validate(path, dir)
  // A clean config comes back with diagnostics: null — Go's nil slice — and this used
  // to call .filter on it, which aborted the start of every VALID config. Caught by
  // the demo config, which is the one thing that should never fail to start.
  const missing = ((diagnostics ?? []) as { code?: string; message?: string }[])
    .filter((d) => d.code === 'geodata_missing')
    .map((d) => (/geosite\.dat/.test(d.message ?? '') ? 'geosite' : 'geoip') as 'geoip' | 'geosite')
  if (missing.length === 0) return dir

  const profile = await geodata.active()
  const fetchable = missing.filter((f) => (f === 'geoip' ? profile.geoipUrl : profile.geositeUrl))
  if (fetchable.length === 0) return dir // nothing to fetch from; the validator's error stands

  win?.webContents.send('geodata:progress', `fetching ${fetchable.join(' and ')} for "${profile.name}"…`)
  try {
    await geodata.download(profile.id, (msg) => win?.webContents.send('geodata:progress', msg))
    win?.webContents.send('geodata:progress', '')
  } catch (e) {
    win?.webContents.send('geodata:progress', '')
    trace(`geodata fetch failed: ${(e as Error).message}`)
    // Fall through: the start will fail with the validator's own message, which now
    // also says the fetch was attempted.
  }
  return dir
}

async function ensureSidecar(): Promise<Sidecar> {
  if (sidecar?.running) return sidecar

  const bin = sidecarPath(app.getAppPath())
  const sc = new Sidecar(bin, join(app.getPath('userData'), 'logs'))
  store.beginSidecar()

  sc.on('event', (ev: Envelope) => store.ingest(ev))
  sc.on('coreLog', (line: string) => win?.webContents.send('core:log', line))
  sc.on('stderr', (line: string) => win?.webContents.send('core:log', line))
  sc.on('exit', ({ code, signal }: { code: number | null; signal: string | null }) => {
    store.setSidecar(false, null, `sidecar exited (code=${code} signal=${signal})`)
  })
  sc.on('streamError', (msg: string) => store.setSidecar(true, sc.info?.xray ?? null, msg))

  const ready = await sc.start()
  trace(`sidecar ready pid=${ready.pid} port=${ready.port} token=${ready.token} xray=${ready.xray}`)
  store.setSidecar(true, ready.xray)
  sidecar = sc

  // Re-arm the faults on the fresh process.
  //
  // The rule set lives in the sidecar's fault.Store, which is per-PROCESS, and reload
  // is a respawn (see Sidecar's class comment). So a restart silently disarms every
  // fault while the UI goes on listing them as enabled — the tool then reports the
  // opposite of the truth. Doing it here rather than in the reload path also covers a
  // crash-respawn, and it lands BEFORE startConfig, so the very first probe of the new
  // instance already sees the fault.
  const rules = store.currentFaults()
  if (rules.length > 0) {
    try {
      const res = await sc.setFaults(rules)
      trace(`re-armed ${rules.length} fault rule(s) on the new sidecar: applied=${res.applied}`)
    } catch (err) {
      // Surface it: a fault the user believes is active but is not would make every
      // subsequent observation misleading.
      store.setSidecar(true, ready.xray, `faults were not re-armed after restart: ${(err as Error).message}`)
      trace(`re-arming faults FAILED: ${(err as Error).message}`)
    }
  }
  return sc
}

/**
 * Watches the config on disk. The user edits in their own editor, so the app has to
 * notice — that is the whole reload workflow for M1.
 */
function watchConfig(path: string): void {
  configWatcher?.close()
  let debounce: NodeJS.Timeout | null = null
  try {
    configWatcher = watch(path, () => {
      if (debounce) clearTimeout(debounce)
      // Editors write in bursts (truncate, then write); coalesce them.
      debounce = setTimeout(() => win?.webContents.send('config:changed', path), 250)
    })
  } catch {
    // A missing directory or an editor that replaces the inode makes this fail;
    // it is a convenience, not a requirement.
    configWatcher = null
  }
}

function registerIpc(): void {
  ipcMain.handle('app:versions', () => ({
    app: app.getVersion(),
    electron: process.versions.electron,
    chrome: process.versions.chrome,
    node: process.versions.node,
  }))

  ipcMain.handle('config:pick', async () => {
    const res = await dialog.showOpenDialog({
      title: 'Open Xray config',
      filters: [{ name: 'Xray config', extensions: ['json', 'jsonc'] }],
      properties: ['openFile'],
    })
    if (res.canceled || !res.filePaths[0]) return null
    return res.filePaths[0]
  })

  ipcMain.handle('config:read', async (_e, path: string) => readFile(path, 'utf8'))

  /**
   * Materialises pasted JSON as a real file and returns its path.
   *
   * Everything downstream — starting an instance, the disk watcher, the graph editor's
   * read/save cycle — is addressed by path, because that is what the core's own loader
   * takes. Threading an in-memory alternative through all of it would mean two code
   * paths for every operation and a second class of config that silently lacks half
   * the features. Writing the paste to disk instead costs one file and keeps the rest
   * of the app unaware that pasting exists.
   *
   * It lands in userData, never next to the user's own configs: this is our scratch
   * space, and a tool that scatters files into someone's config directory is a tool
   * they stop trusting.
   */
  ipcMain.handle('config:fromText', async (_e, text: string, name?: string) => {
    const dir = join(app.getPath('userData'), 'pasted')
    await mkdir(dir, { recursive: true })
    const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)
    const safe = (name ?? '').replace(/[^\w.-]/g, '').slice(0, 40)
    const file = join(dir, `${safe || 'pasted'}-${stamp}.json`)
    await writeFile(file, text, 'utf8')
    trace(`pasted config -> ${file}`)
    return file
  })

  ipcMain.handle('instance:start', async (_e, path: string) => {
    let sc = await ensureSidecar()
    const assets = await geodataForStart(sc, path)
    // Reload = a fresh process. Stopping the instance in place would leave the burst
    // observatory's probe timers running against a config that no longer exists.
    if (currentConfig) {
      await sc.stop()
      sidecar = null
      sc = await ensureSidecar()
    }
    currentConfig = path
    watchConfig(path)
    return sc.startConfig(path, assets)
  })

  ipcMain.handle('instance:stop', async () => {
    if (!sidecar) return null
    const r = await sidecar.stopConfig()
    return r
  })

  // Writing the user's real config. Deliberately explicit: only ever called from the
  // Save button, never on edit, so the file on disk is always something they chose.
  ipcMain.handle('config:write', async (_e, path: string, text: string) => {
    await writeFile(path, text, 'utf8')
    return true
  })

  // Validate text that has not been saved yet, so the Build tab can check a draft.
  ipcMain.handle('instance:validateText', async (_e, text: string) => {
    const sc = await ensureSidecar()
    return sc.validateText(text, await geodata.activeDir())
  })

  ipcMain.handle('instance:validate', async (_e, path: string) => {
    const sc = await ensureSidecar()
    return sc.validate(path, await geodata.activeDir())
  })

  /* ── geodata profiles ──────────────────────────────────────────────────── */
  ipcMain.handle('geodata:list', () => geodata.list())
  ipcMain.handle('geodata:select', (_e, id: string) => geodata.select(id))
  ipcMain.handle('geodata:remove', (_e, id: string) => geodata.remove(id))
  ipcMain.handle(
    'geodata:add',
    (_e, input: { name: string; geoipUrl?: string; geositeUrl?: string }) =>
      geodata.add({ ...input, source: 'url' }),
  )
  ipcMain.handle('geodata:addHapp', (_e, link: string) =>
    geodata.add({ ...geodata.parseHappRouting(link), source: 'happ' }),
  )
  ipcMain.handle('geodata:download', (_e, id: string) =>
    geodata.download(id, (msg) => win?.webContents.send('geodata:progress', msg)),
  )

  ipcMain.handle('faults:set', async (_e, rules: FaultRule[]) => {
    const sc = await ensureSidecar()
    const res = await sc.setFaults(rules)
    store.setFaults(rules)
    return res
  })

  ipcMain.handle('rtt:series', () => store.rttSeries())

  /* ── assistant ─────────────────────────────────────────────────────────────
     The renderer never sees the API key, and could not reach the provider anyway:
     its CSP is connect-src 'self'. It sends a request and receives text deltas. */
  ipcMain.handle('ai:hasKey', (_e, p: ai.Provider) => ai.hasKey(p))
  ipcMain.handle('ai:setKey', (_e, p: ai.Provider, key: string) => ai.setKey(p, key))
  ipcMain.handle('ai:clearKeys', () => ai.clearKeys())
  ipcMain.handle('ai:getProxy', () => ai.getProxy())
  ipcMain.handle('ai:setProxy', (_e, url: string) => ai.setProxy(url))

  let inflight: AbortController | null = null
  ipcMain.handle('ai:cancel', () => {
    inflight?.abort()
    inflight = null
  })

  ipcMain.handle('ai:send', async (_e, req: ai.ChatRequest & { id: string }) => {
    // One conversation at a time: a second reply streaming into the same panel would
    // interleave two answers into nonsense.
    inflight?.abort()
    const ctl = new AbortController()
    inflight = ctl
    const send = (kind: string, payload: unknown): void => {
      if (!win || win.isDestroyed()) return
      win.webContents.send('ai:event', { id: req.id, kind, payload })
    }
    await ai.chat(
      req,
      {
        delta: (text) => send('delta', text),
        done: (info) => send('done', info),
        error: (message) => send('error', message),
      },
      ctl.signal,
    )
    if (inflight === ctl) inflight = null
  })

  // What-if analysis. The sidecar runs the REAL strategy code against the supplied
  // observation, so the answer cannot drift from live behaviour.
  // Parameter documentation is a static data file; load it once, lazily, so a missing
  // or unreadable bundle degrades to "no tooltips" rather than breaking startup.
  const docsCache = new Map<string, unknown>()
  ipcMain.handle('docs:bundle', async (_e, lang = 'en') => {
    // Only a locale name, never a path: this string reaches a filesystem lookup.
    const loc = /^[a-z]{2}$/.test(String(lang)) ? String(lang) : 'en'
    if (docsCache.has(loc)) return docsCache.get(loc)
    for (const p of [
      join(app.getAppPath(), '..', 'data', `docs-${loc}`, 'params.json'),
      join(app.getAppPath(), 'data', `docs-${loc}`, 'params.json'),
      join(process.resourcesPath ?? '', `docs-${loc}`, 'params.json'),
    ]) {
      try {
        const bundle = JSON.parse(await readFile(p, 'utf8'))
        docsCache.set(loc, bundle)
        trace(`docs[${loc}] loaded from ${p}`)
        return bundle
      } catch {
        /* try the next location */
      }
    }
    trace(`docs bundle for ${loc} not found`)
    docsCache.set(loc, null)
    return null
  })

  let schemaCache: unknown = null
  ipcMain.handle('schema:bundle', async () => {
    if (schemaCache) return schemaCache
    for (const p of [
      join(app.getAppPath(), '..', 'data', 'schema', 'protocols.json'),
      join(app.getAppPath(), 'data', 'schema', 'protocols.json'),
      join(process.resourcesPath ?? '', 'schema', 'protocols.json'),
    ]) {
      try {
        schemaCache = JSON.parse(await readFile(p, 'utf8'))
        return schemaCache
      } catch {
        /* try the next location */
      }
    }
    trace('protocol schema not found')
    return null
  })

  ipcMain.handle('selfcheck:run', async () => {
    if (!sidecar) throw new Error('sidecar not running')
    const snap = store.snapshot()
    const balancers: Record<string, { strategy: string; candidates: string[] }> = {}
    for (const b of snap.balancers) {
      balancers[b.tag] = { strategy: b.strategy, candidates: b.candidates }
    }
    return sidecar.selfCheck(balancers)
  })

  ipcMain.handle('sim:run', async (_e, req: SimRequest) => {
    if (!sidecar) throw new Error('sidecar not running')
    return sidecar.simulate(req)
  })
}

function startSnapshotLoop(): void {
  setInterval(() => {
    if (!win || win.isDestroyed()) return
    // Only push when something actually changed, so an idle app costs nothing.
    if (!store.takeDirty()) return
    win.webContents.send('snapshot', store.snapshot())
  }, 1000 / SNAPSHOT_HZ)
}

/**
 * Keep Chromium's profile out of ~/Library/Application Support when running from
 * source.
 *
 * macOS attributes a child process's file access to the app that LAUNCHED it, so a
 * dev run started from a terminal, an IDE or an agent is not the app itself as far as
 * TCC is concerned. Chromium's default profile directory then reads as another app's
 * data, and every launch raises "would like to access data from other apps" — several
 * times a session, on top of the window, which makes the tool unusable for the very
 * thing it exists for.
 *
 * Putting the profile inside the repo's own .build/ sidesteps the check entirely:
 * nothing there belongs to another app. It also means a dev profile never pollutes a
 * packaged install's, and `rm -rf .build` is a clean slate. Must run before ready —
 * Chromium reads the path during initialisation.
 */
if (isDev) {
  const profile = join(app.getAppPath(), '..', '.build', 'electron-userdata')
  try {
    mkdirSync(profile, { recursive: true })
    app.setPath('userData', profile)
    trace(`userData -> ${profile}`)
  } catch (err) {
    // Not fatal: the default location still works, it just prompts.
    trace(`could not relocate userData: ${(err as Error).message}`)
  }
} else if (process.platform === 'win32') {
  /**
   * Windows ships as a portable folder, so keep everything the app writes inside it.
   *
   * "No installer" is only half of portable. If the API key, the Chromium profile and
   * the pasted configs still went to %APPDATA%, deleting the folder would leave those
   * behind and copying it to a USB stick would carry none of them. Both are exactly what
   * someone reaching for a portable build is trying to avoid.
   *
   * PORTABLE_EXECUTABLE_DIR is set by electron-builder's portable target; for the zip it
   * is the directory the executable sits in. If that turns out to be unwritable — the
   * folder was dropped in Program Files, or opened straight from a read-only mount — the
   * default location is used instead, because failing to start would be a worse answer
   * than writing where Windows expects.
   */
  const base = process.env['PORTABLE_EXECUTABLE_DIR'] ?? dirname(app.getPath('exe'))
  const profile = join(base, 'XrayStudio-data')
  try {
    mkdirSync(profile, { recursive: true })
    accessSync(profile, constants.W_OK)
    app.setPath('userData', profile)
    trace(`portable userData -> ${profile}`)
  } catch (err) {
    trace(`portable userData unavailable (${(err as Error).message}); using the default`)
  }
}

trace('main module loaded')

/**
 * The application menu.
 *
 * Set explicitly rather than left to Electron's default, because the default is where
 * Cut/Copy/Paste and their accelerators come from — and on Windows the frameless window
 * this app used to request left no menu bar to carry them, so Ctrl+V did nothing in the
 * Paste dialog. Roles are used throughout: Electron wires them to the native clipboard
 * and localises the labels, which hand-rolled handlers would not.
 */
function buildMenu(): void {
  const isMac = process.platform === 'darwin'
  Menu.setApplicationMenu(
    Menu.buildFromTemplate([
      ...(isMac
        ? ([{ role: 'appMenu' }] as Electron.MenuItemConstructorOptions[])
        : []),
      {
        label: 'File',
        submenu: [
          {
            label: 'Open config…',
            accelerator: 'CmdOrCtrl+O',
            click: () => win?.webContents.send('menu:open-config'),
          },
          { type: 'separator' },
          isMac ? { role: 'close' } : { role: 'quit' },
        ],
      },
      { role: 'editMenu' },
      {
        label: 'View',
        submenu: [
          { role: 'reload' },
          { role: 'toggleDevTools' },
          { type: 'separator' },
          { role: 'resetZoom' },
          { role: 'zoomIn' },
          { role: 'zoomOut' },
          { type: 'separator' },
          { role: 'togglefullscreen' },
        ],
      },
      { role: 'windowMenu' },
    ]),
  )
}

void app.whenReady().then(async () => {
  trace('app ready')
  buildMenu()
  registerIpc()
  win = createWindow()
  startSnapshotLoop()

  // Dev convenience: XRAYSTUDIO_CONFIG=<path> opens and starts a config on launch, so the
  // edit/run loop does not require clicking through the picker every time.
  const auto = process.env['XRAYSTUDIO_CONFIG']
  if (auto) {
    try {
      const sc = await ensureSidecar()
      const assets = await geodataForStart(sc, auto)
      currentConfig = auto
      watchConfig(auto)
      await sc.startConfig(auto, assets)
      win.webContents.send('config:opened', auto)
    } catch (err) {
      store.setSidecar(false, null, (err as Error).message)
    }
  }

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) win = createWindow()
  })
})

// The sidecar is a child process holding the config's inbound ports. Reap it on
// every exit path, not just the tidy one.
async function shutdown(): Promise<void> {
  configWatcher?.close()
  await sidecar?.stop()
  sidecar = null
}

app.on('before-quit', (e) => {
  if (!sidecar) return
  e.preventDefault()
  void shutdown().then(() => app.quit())
})

app.on('window-all-closed', () => {
  void shutdown().then(() => {
    if (process.platform !== 'darwin') app.quit()
  })
})

process.on('exit', () => {
  sidecar?.stop().catch(() => {})
})
