import { app, net } from 'electron'
import { createHash } from 'node:crypto'
import { createWriteStream } from 'node:fs'
import { mkdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import type { GeoProfile, GeoState, GeoFile } from '@shared/events'

/**
 * geoip.dat / geosite.dat, as PROFILES the user picks between.
 *
 * Xray finds those files next to its own binary by default, which in a packaged app is
 * a read-only bundle with no .dat files in it — so every config with a `geoip:` rule
 * failed to start with a path nobody could do anything about. The app now owns the
 * location the way it owns log paths: a profile is a directory, the active one is
 * handed to the sidecar on every start, and the choice is remembered.
 *
 * A profile is a pair of URLs, not a pair of files. Files are what a profile has
 * fetched so far, and either may be absent: a routing setup that only uses geosite:
 * has no reason to carry 16 MB of geoip. The validator reports precisely which file a
 * config needs and lacks.
 *
 * Nothing is downloaded on its own. The bundled default is a pair of URLs the user has
 * not fetched yet; the fetch happens when they start a config that needs it, or press
 * Update — both of which are theirs. That keeps the README's claim exact: the app does
 * not reach the network except for what the user's own actions ask of it.
 */

const DEFAULT_ID = 'loyalsoldier'
const RELEASES = 'https://github.com/Loyalsoldier/v2ray-rules-dat/releases/latest/download/'

const defaultProfile = (): GeoProfile => ({
  id: DEFAULT_ID,
  name: 'Loyalsoldier / v2ray-rules-dat',
  source: 'default',
  geoipUrl: RELEASES + 'geoip.dat',
  geositeUrl: RELEASES + 'geosite.dat',
  addedAt: Date.now(),
  files: {},
})

const root = (): string => join(app.getPath('userData'), 'geodata')
const stateFile = (): string => join(root(), 'profiles.json')
const dirOf = (id: string): string => join(root(), id)

let cache: GeoState | null = null

async function load(): Promise<GeoState> {
  if (cache) return cache
  try {
    const parsed = JSON.parse(await readFile(stateFile(), 'utf8')) as GeoState
    cache = parsed
  } catch {
    cache = { active: DEFAULT_ID, profiles: [defaultProfile()] }
    await save()
  }
  // The default is always present. A user can remove it from the list, but a state
  // with no profiles at all has nowhere to point the sidecar.
  if (cache.profiles.length === 0) {
    cache.profiles.push(defaultProfile())
    cache.active = DEFAULT_ID
    await save()
  }
  return cache
}

async function save(): Promise<void> {
  await mkdir(root(), { recursive: true })
  await writeFile(stateFile(), JSON.stringify(cache, null, 2))
}

export async function list(): Promise<GeoState> {
  const st = await load()
  // Re-stat rather than trusting the record: a file the user deleted by hand should
  // read as absent, not as whatever the record last said.
  for (const p of st.profiles) {
    for (const f of ['geoip', 'geosite'] as const) {
      try {
        const s = await stat(join(dirOf(p.id), `${f}.dat`))
        p.files[f] = { bytes: s.size, at: p.files[f]?.at ?? s.mtimeMs }
      } catch {
        delete p.files[f]
      }
    }
  }
  return st
}

/** The directory the sidecar is pointed at. Always exists, even if empty. */
export async function activeDir(): Promise<string> {
  const st = await load()
  const dir = dirOf(st.active)
  await mkdir(dir, { recursive: true })
  return dir
}

export async function active(): Promise<GeoProfile> {
  const st = await list()
  return st.profiles.find((p) => p.id === st.active) ?? st.profiles[0]!
}

export async function select(id: string): Promise<GeoState> {
  const st = await load()
  if (!st.profiles.some((p) => p.id === id)) throw new Error(`no such geodata profile: ${id}`)
  st.active = id
  await save()
  return list()
}

export async function add(input: {
  name: string
  geoipUrl?: string
  geositeUrl?: string
  source: 'url' | 'happ'
}): Promise<GeoState> {
  const geoipUrl = (input.geoipUrl ?? '').trim() || undefined
  const geositeUrl = (input.geositeUrl ?? '').trim() || undefined
  if (!geoipUrl && !geositeUrl) throw new Error('A profile needs at least one URL — geoip, geosite, or both.')
  for (const u of [geoipUrl, geositeUrl]) {
    if (u && !/^https?:\/\//i.test(u)) throw new Error(`Not an http(s) URL: ${u}`)
  }
  const st = await load()
  const id = `p${Date.now().toString(36)}`
  const profile: GeoProfile = {
    id,
    name: input.name.trim() || `Profile ${st.profiles.length + 1}`,
    source: input.source,
    addedAt: Date.now(),
    files: {},
    ...(geoipUrl ? { geoipUrl } : {}),
    ...(geositeUrl ? { geositeUrl } : {}),
  }
  st.profiles.push(profile)
  await save()
  return list()
}

export async function remove(id: string): Promise<GeoState> {
  const st = await load()
  st.profiles = st.profiles.filter((p) => p.id !== id)
  await rm(dirOf(id), { recursive: true, force: true })
  if (st.active === id) st.active = st.profiles[0]?.id ?? DEFAULT_ID
  await save()
  return list()
}

/**
 * happ://routing/add/<base64 JSON>
 *
 * Happ's routing profiles carry `Geoipurl` and `Geositeurl` alongside a lot of fields
 * this app has no use for. Only those two and the name are read. Both may be empty —
 * many shared profiles leave them so — and that is reported as such rather than
 * silently producing a profile that can never fetch anything.
 */
export function parseHappRouting(link: string): { name: string; geoipUrl?: string; geositeUrl?: string } {
  const m = /^happ:\/\/routing\/add\/([A-Za-z0-9+/=_-]+)\s*$/i.exec(link.trim())
  if (!m) throw new Error('Not a happ://routing/add/… link.')
  // URL-safe base64 appears in the wild too.
  const b64 = m[1]!.replace(/-/g, '+').replace(/_/g, '/')
  let json: Record<string, unknown>
  try {
    json = JSON.parse(Buffer.from(b64, 'base64').toString('utf8')) as Record<string, unknown>
  } catch {
    throw new Error('The link does not decode to a routing profile.')
  }
  const str = (k: string): string | undefined => {
    const v = json[k]
    return typeof v === 'string' && v.trim() ? v.trim() : undefined
  }
  const geoipUrl = str('Geoipurl') ?? str('GeoipUrl') ?? str('geoipUrl')
  const geositeUrl = str('Geositeurl') ?? str('GeositeUrl') ?? str('geositeUrl')
  if (!geoipUrl && !geositeUrl) {
    throw new Error('This routing profile carries no geoip or geosite URL — there is nothing to fetch.')
  }
  return {
    name: str('Name') ?? 'happ routing',
    ...(geoipUrl ? { geoipUrl } : {}),
    ...(geositeUrl ? { geositeUrl } : {}),
  }
}

export type Progress = (msg: string) => void

/**
 * Fetches whichever of the profile's files have a URL. Both are attempted even if one
 * fails, so a bad geosite URL does not cost the user their geoip.
 *
 * A GitHub release publishes `<asset>.sha256sum` beside each asset; when one is there
 * the download is verified against it. When it is not, it is not — a verification the
 * source does not offer is not something to invent.
 */
export async function download(id: string, progress: Progress = () => {}): Promise<GeoState> {
  const st = await load()
  const p = st.profiles.find((x) => x.id === id)
  if (!p) throw new Error(`no such geodata profile: ${id}`)
  const dir = dirOf(id)
  await mkdir(dir, { recursive: true })

  const errors: string[] = []
  for (const [file, url] of [
    ['geoip', p.geoipUrl],
    ['geosite', p.geositeUrl],
  ] as const) {
    if (!url) continue
    try {
      progress(`downloading ${file}.dat…`)
      const got = await fetchTo(url, join(dir, `${file}.dat`))
      p.files[file] = { bytes: got, at: Date.now() }
      progress(`${file}.dat: ${(got / 1048576).toFixed(1)} MB`)
    } catch (e) {
      errors.push(`${file}.dat: ${(e as Error).message}`)
    }
  }
  await save()
  if (errors.length) throw new Error(errors.join('\n'))
  return list()
}

async function fetchTo(url: string, dest: string): Promise<number> {
  const res = await net.fetch(url, { redirect: 'follow' })
  if (!res.ok || !res.body) throw new Error(`HTTP ${res.status} from ${url}`)

  const tmp = `${dest}.part`
  const hash = createHash('sha256')
  let bytes = 0
  await pipeline(
    Readable.fromWeb(res.body as never),
    async function* (src) {
      for await (const chunk of src as AsyncIterable<Buffer>) {
        bytes += chunk.length
        hash.update(chunk)
        yield chunk
      }
    },
    createWriteStream(tmp),
  )
  if (bytes === 0) {
    await rm(tmp, { force: true })
    throw new Error('the server returned an empty file')
  }

  // Optional checksum, GitHub-release style.
  try {
    const sumRes = await net.fetch(`${url}.sha256sum`, { redirect: 'follow' })
    if (sumRes.ok) {
      const want = (await sumRes.text()).trim().split(/\s+/)[0]?.toLowerCase()
      const have = hash.digest('hex')
      if (want && want.length === 64 && want !== have) {
        await rm(tmp, { force: true })
        throw new Error(`checksum mismatch — expected ${want.slice(0, 12)}…, got ${have.slice(0, 12)}…`)
      }
    }
  } catch (e) {
    if ((e as Error).message.startsWith('checksum mismatch')) throw e
    /* no checksum published; nothing to verify against */
  }

  await rename(tmp, dest)
  return bytes
}

/** Whether the active profile could fetch `file` on demand. */
export async function canFetch(file: GeoFile): Promise<boolean> {
  const p = await active()
  return file === 'geoip' ? !!p.geoipUrl : !!p.geositeUrl
}
