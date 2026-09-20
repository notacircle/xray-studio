import { contextBridge, ipcRenderer } from 'electron'
import type {
  Diagnostic,
  DocBundle,
  ProtocolSchema,
  FaultRule,
  RttSeries,
  SimRequest,
  SimResponse,
  SelfCheckReport,
  Snapshot,
  GeoState,
} from '@shared/events'

/**
 * The entire surface the renderer is allowed to touch.
 *
 * The renderer never learns the sidecar's port or bearer token, never touches the
 * filesystem, and never sees Node. Everything is a typed IPC call.
 */
const api = {
  /** The renderer lays out its title bar differently per platform; this is the only
   *  thing it needs to know about the host. */
  platform: process.platform,

  getVersions: (): Promise<{ app: string; electron: string; chrome: string; node: string }> =>
    ipcRenderer.invoke('app:versions'),

  pickConfig: (): Promise<string | null> => ipcRenderer.invoke('config:pick'),
  /** Overwrites a config file. Only called from an explicit Save. */
  writeConfig: (path: string, text: string): Promise<boolean> =>
    ipcRenderer.invoke('config:write', path, text),

  /** Validates unsaved text through the sidecar's real config loader. */
  validateText: (text: string): Promise<{ ok: boolean; diagnostics: Diagnostic[] }> =>
    ipcRenderer.invoke('instance:validateText', text),

  readConfig: (path: string): Promise<string> => ipcRenderer.invoke('config:read', path),

  /** Writes pasted JSON to a scratch file and returns its path. Everything downstream
   *  is path-addressed, so this keeps pasting on the same code path as opening. */
  configFromText: (text: string, name?: string): Promise<string> =>
    ipcRenderer.invoke('config:fromText', text, name),

  start: (path: string): Promise<unknown> => ipcRenderer.invoke('instance:start', path),
  stop: (): Promise<unknown> => ipcRenderer.invoke('instance:stop'),
  validate: (path: string): Promise<{ ok: boolean; diagnostics: Diagnostic[] }> =>
    ipcRenderer.invoke('instance:validate', path),

  setFaults: (rules: FaultRule[]): Promise<{ applied: number; poisoned: Record<string, number> }> =>
    ipcRenderer.invoke('faults:set', rules),

  /** Pulled on demand rather than pushed: the series is large and changes slowly
   *  relative to the 30Hz snapshot. */
  /** What-if analysis; runs the real strategy in the sidecar. */
  /** Cross-check the dashboard's claims against the core's own answers. */
  /** Per-parameter documentation, or null when the bundle is unavailable. */
  /** Generated protocol settings schema, or null when unavailable. */
  schema: (): Promise<ProtocolSchema | null> => ipcRenderer.invoke('schema:bundle'),

  docs: (lang: string): Promise<DocBundle | null> => ipcRenderer.invoke('docs:bundle', lang),

  selfCheck: (): Promise<SelfCheckReport> => ipcRenderer.invoke('selfcheck:run'),

  /* geoip.dat / geosite.dat profiles. See main/geodata.ts. */
  geodata: {
    list: (): Promise<GeoState> => ipcRenderer.invoke('geodata:list'),
    select: (id: string): Promise<GeoState> => ipcRenderer.invoke('geodata:select', id),
    remove: (id: string): Promise<GeoState> => ipcRenderer.invoke('geodata:remove', id),
    add: (input: { name: string; geoipUrl?: string; geositeUrl?: string }): Promise<GeoState> =>
      ipcRenderer.invoke('geodata:add', input),
    addHapp: (link: string): Promise<GeoState> => ipcRenderer.invoke('geodata:addHapp', link),
    download: (id: string): Promise<GeoState> => ipcRenderer.invoke('geodata:download', id),
    onProgress: (cb: (msg: string) => void): (() => void) => {
      const h = (_e: unknown, msg: string): void => cb(msg)
      ipcRenderer.on('geodata:progress', h)
      return () => ipcRenderer.off('geodata:progress', h)
    },
  },

  simulate: (req: SimRequest): Promise<SimResponse> => ipcRenderer.invoke('sim:run', req),

  rttSeries: (): Promise<RttSeries> => ipcRenderer.invoke('rtt:series'),

  onSnapshot: (cb: (s: Snapshot) => void): (() => void) => {
    const h = (_e: unknown, s: Snapshot): void => cb(s)
    ipcRenderer.on('snapshot', h)
    return () => ipcRenderer.off('snapshot', h)
  },

  onCoreLog: (cb: (line: string) => void): (() => void) => {
    const h = (_e: unknown, line: string): void => cb(line)
    ipcRenderer.on('core:log', h)
    return () => ipcRenderer.off('core:log', h)
  },

  onMenuOpenConfig: (cb: () => void): (() => void) => {
    const h = (): void => cb()
    ipcRenderer.on('menu:open-config', h)
    return () => ipcRenderer.off('menu:open-config', h)
  },

  onConfigOpened: (cb: (path: string) => void): (() => void) => {
    const h = (_e: unknown, path: string): void => cb(path)
    ipcRenderer.on('config:opened', h)
    return () => ipcRenderer.off('config:opened', h)
  },

  /* ── assistant ───────────────────────────────────────────────────────────── */
  aiHasKey: (provider: 'anthropic' | 'openai'): Promise<boolean> =>
    ipcRenderer.invoke('ai:hasKey', provider),
  aiSetKey: (provider: 'anthropic' | 'openai', key: string): Promise<void> =>
    ipcRenderer.invoke('ai:setKey', provider, key),
  aiClearKeys: (): Promise<void> => ipcRenderer.invoke('ai:clearKeys'),
  aiGetProxy: (): Promise<{ value: string; source: 'stored' | 'env' | 'none' }> =>
    ipcRenderer.invoke('ai:getProxy'),
  aiSetProxy: (url: string): Promise<void> => ipcRenderer.invoke('ai:setProxy', url),
  aiCancel: (): Promise<void> => ipcRenderer.invoke('ai:cancel'),
  aiSend: (req: {
    id: string
    provider: 'anthropic' | 'openai'
    model: string
    system: string
    messages: { role: 'user' | 'assistant'; content: string }[]
  }): Promise<void> => ipcRenderer.invoke('ai:send', req),

  onAiEvent: (
    cb: (e: { id: string; kind: string; payload: unknown }) => void,
  ): (() => void) => {
    const h = (_e: unknown, ev: { id: string; kind: string; payload: unknown }): void => cb(ev)
    ipcRenderer.on('ai:event', h)
    return () => ipcRenderer.off('ai:event', h)
  },

  onConfigChanged: (cb: (path: string) => void): (() => void) => {
    const h = (_e: unknown, path: string): void => cb(path)
    ipcRenderer.on('config:changed', h)
    return () => ipcRenderer.off('config:changed', h)
  },
} as const

export type XrayStudioApi = typeof api

contextBridge.exposeInMainWorld('xraystudio', api)
