import { spawn, type ChildProcessByStdio } from 'node:child_process'
import type { Readable } from 'node:stream'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { EventEmitter } from 'node:events'
import type { Envelope, FaultRule, SimRequest, SimResponse, SelfCheckReport } from '@shared/events'

interface ReadyLine {
  event: 'ready'
  pid: number
  port: number
  token: string
  xray: string
  patches: number
}

/**
 * Owns the Go sidecar child process.
 *
 * Reload means RESPAWN, never in-place: core.New() overwrites package-level state in
 * transport/internet, and the burst observatory's probe timers outlive an in-process
 * reload and later fire against a config that is gone. Killing the process is the
 * only airtight reset.
 */
export class Sidecar extends EventEmitter {
  // stdin is 'ignore': the sidecar takes no input, and closing it removes a way
  // for a wedged child to block on a write.
  private proc: ChildProcessByStdio<null, Readable, Readable> | null = null
  private ready: ReadyLine | null = null
  private stdoutBuf = ''
  private abort: AbortController | null = null
  private stopping = false

  constructor(
    private readonly binaryPath: string,
    /** Where the sidecar puts a log file whose configured directory does not exist. */
    private readonly logDir: string,
  ) {
    super()
  }

  get info(): ReadyLine | null {
    return this.ready
  }

  get running(): boolean {
    return this.proc !== null && this.ready !== null
  }

  /** Starts the sidecar and resolves once it reports its port and token. */
  async start(): Promise<ReadyLine> {
    if (this.proc) return this.ready!
    if (!existsSync(this.binaryPath)) {
      throw new Error(
        `sidecar binary missing at ${this.binaryPath}\nBuild it with: npm run build:sidecar`,
      )
    }

    this.stopping = false
    const proc = spawn(this.binaryPath, [], {
      stdio: ['ignore', 'pipe', 'pipe'],
      // Redirected logs land in the app's own data directory, which on the portable
      // Windows build sits next to the executable — so a redirect never writes outside
      // the folder that was unpacked.
      env: { ...process.env, XRAYSTUDIO_LOG_DIR: this.logDir },
    })
    this.proc = proc

    const ready = await new Promise<ReadyLine>((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error('sidecar did not report ready within 10s')),
        10_000,
      )

      proc.stdout.setEncoding('utf8')
      proc.stdout.on('data', (chunk: string) => {
        // Line 1 is the ready JSON; everything after it is the core's own log
        // output, which we forward verbatim.
        this.stdoutBuf += chunk
        let idx: number
        while ((idx = this.stdoutBuf.indexOf('\n')) >= 0) {
          const line = this.stdoutBuf.slice(0, idx)
          this.stdoutBuf = this.stdoutBuf.slice(idx + 1)
          if (!this.ready) {
            try {
              const parsed = JSON.parse(line) as ReadyLine
              if (parsed.event === 'ready') {
                this.ready = parsed
                clearTimeout(timer)
                resolve(parsed)
                continue
              }
            } catch {
              /* not the ready line; fall through and treat as core output */
            }
          }
          if (line.trim()) this.emit('coreLog', line)
        }
      })

      proc.stderr.setEncoding('utf8')
      proc.stderr.on('data', (chunk: string) => {
        for (const line of chunk.split('\n')) {
          if (line.trim()) this.emit('stderr', line)
        }
      })

      proc.on('error', (err) => {
        clearTimeout(timer)
        reject(err)
      })

      proc.on('exit', (code, signal) => {
        clearTimeout(timer)
        this.proc = null
        this.ready = null
        this.abort?.abort()
        if (!this.stopping) {
          this.emit('exit', { code, signal })
          reject(new Error(`sidecar exited early (code=${code} signal=${signal})`))
        }
      })
    })

    void this.consumeEvents()
    return ready
  }

  /** Terminates the sidecar: SIGTERM, then SIGKILL after a grace period. */
  async stop(): Promise<void> {
    const proc = this.proc
    if (!proc) return
    this.stopping = true
    this.abort?.abort()

    await new Promise<void>((resolve) => {
      const kill = setTimeout(() => {
        // The instance may be mid-shutdown with probes in flight; do not wait forever.
        proc.kill('SIGKILL')
      }, 3000)
      proc.once('exit', () => {
        clearTimeout(kill)
        resolve()
      })
      proc.kill('SIGTERM')
    })

    this.proc = null
    this.ready = null
  }

  /** Consumes the SSE event stream, reconnecting while the process lives. */
  private async consumeEvents(): Promise<void> {
    while (this.proc && this.ready) {
      const { port, token } = this.ready
      this.abort = new AbortController()
      try {
        const res = await fetch(`http://127.0.0.1:${port}/v1/events`, {
          headers: { Authorization: `Bearer ${token}` },
          signal: this.abort.signal,
        })
        if (!res.ok || !res.body) throw new Error(`event stream: HTTP ${res.status}`)

        const reader = res.body.getReader()
        const decoder = new TextDecoder()
        let buf = ''
        for (;;) {
          const { done, value } = await reader.read()
          if (done) break
          buf += decoder.decode(value, { stream: true })
          // SSE frames are separated by a blank line; each payload is one-line JSON.
          let sep: number
          while ((sep = buf.indexOf('\n\n')) >= 0) {
            const frame = buf.slice(0, sep)
            buf = buf.slice(sep + 2)
            for (const line of frame.split('\n')) {
              if (!line.startsWith('data: ')) continue
              try {
                this.emit('event', JSON.parse(line.slice(6)) as Envelope)
              } catch {
                /* malformed frame: skip rather than tear the stream down */
              }
            }
          }
        }
      } catch (err) {
        if (this.stopping || (err as Error).name === 'AbortError') return
        this.emit('streamError', (err as Error).message)
      }
      if (this.stopping) return
      await new Promise((r) => setTimeout(r, 500))
    }
  }

  // --- control plane calls ---------------------------------------------------

  private async call<T>(method: string, path: string, body?: unknown): Promise<T> {
    if (!this.ready) throw new Error('sidecar not running')
    const res = await fetch(`http://127.0.0.1:${this.ready.port}${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${this.ready.token}`,
        ...(body ? { 'Content-Type': 'application/json' } : {}),
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
    })
    const text = await res.text()

    // A non-JSON body means we are talking to something other than the endpoint we
    // expected — most often a stale sidecar binary that predates a new route, whose
    // "404 page not found" JSON.parse reports as a baffling syntax error at position 4.
    // Say what actually happened instead.
    let parsed: { error?: string } & Record<string, unknown>
    try {
      parsed = text ? JSON.parse(text) : {}
    } catch {
      const body = text.trim().slice(0, 120)
      throw new Error(
        `${method} ${path}: HTTP ${res.status}, non-JSON response ${JSON.stringify(body)}` +
          (res.status === 404 ? ' — the sidecar binary is likely stale; rebuild it' : ''),
      )
    }
    if (!res.ok) {
      throw new Error(parsed.error ?? `HTTP ${res.status}`)
    }
    return parsed as T
  }

  startConfig(path: string, assetDir: string) {
    return this.call<{ state: unknown }>('POST', '/v1/start', { path, assetDir })
  }

  stopConfig() {
    return this.call<{ state: unknown }>('POST', '/v1/stop')
  }

  /** Validates config TEXT that is not on disk yet. */
  validateText(raw: string, assetDir: string) {
    return this.call<{ ok: boolean; diagnostics: unknown[] }>('POST', '/v1/config', { raw, assetDir })
  }

  validate(path: string, assetDir: string) {
    return this.call<{ ok: boolean; diagnostics: unknown[] }>('POST', '/v1/config', { path, assetDir })
  }

  setFaults(rules: FaultRule[]) {
    return this.call<{ applied: number; poisoned: Record<string, number> }>(
      'PUT',
      '/v1/faults',
      { rules },
    )
  }

  getFaults() {
    return this.call<{ rules: FaultRule[] }>('GET', '/v1/faults')
  }

  /**
   * Run a what-if simulation. The sidecar executes the REAL strategy code against the
   * supplied observation, so the answer cannot drift from live behaviour.
   */
  simulate(req: SimRequest) {
    return this.call<SimResponse>('POST', '/v1/simulate', req)
  }

  /** Cross-check the dashboard's claims against the core's own answers. */
  selfCheck(balancers: Record<string, { strategy: string; candidates: string[] }>) {
    return this.call<SelfCheckReport>('POST', '/v1/selfcheck', { balancers })
  }
}

/**
 * Locates the sidecar binary in both dev and packaged layouts, on every platform.
 *
 * A dev build keeps binaries per target under .build/bin/<platform>-<arch>/, because a
 * release builds all of them and a single flat name could only ever hold one. The
 * unsuffixed path is checked too so an ad-hoc `go build -o .build/bin/...` still works.
 */
export function sidecarPath(appRoot: string): string {
  const exe = process.platform === 'win32' ? 'xray-studio-sidecar.exe' : 'xray-studio-sidecar'
  const os = process.platform === 'win32' ? 'win' : process.platform === 'darwin' ? 'mac' : 'linux'
  // Electron reports arm64/x64; Go's naming is handled by the build script, not here.
  const dir = `${os}-${process.arch}`

  const candidates = [
    join(appRoot, '..', '.build', 'bin', dir, exe),
    join(appRoot, '..', '.build', 'bin', exe),
    join(appRoot, '.build', 'bin', dir, exe),
    join(appRoot, '.build', 'bin', exe),
    join(process.resourcesPath ?? '', exe),
  ]
  return candidates.find((p) => existsSync(p)) ?? candidates[0]!
}
