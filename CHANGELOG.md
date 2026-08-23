# Changelog

## 0.1.0-alpha.5

A crash on hover, and the reason it took a release to notice.

### Fixed

- **Hovering a `?` hint no longer takes the panel down.** The lookup that finds a
  parameter's documentation builds a fresh object every call, and the layout effect that
  positions the popup depended on it — so positioning the popup scheduled a render,
  which produced a new object, which re-ran the effect. React stopped the loop the only
  way it can, by throwing *Maximum update depth exceeded*, and the panel went with it.
  Reported on Windows, but the loop was there on every platform.
- **The crash report stays on screen.** Its boundary cleared itself whenever the
  surrounding elements changed identity, which is every render of the parent — thirty a
  second from the telemetry snapshot. The report appeared for a single frame: long
  enough to look like a flicker, not long enough to read, and nowhere near long enough
  to copy. It now clears when you switch tabs, which is what it was for.

  These two are the same story. A crash on hover reached a release because the thing
  built to report it was erasing itself faster than anyone could see it.

## 0.1.0-alpha.4

Three things the interface was reporting wrongly, all of them about state that had moved
on without the screen noticing.

### Fixed

- **Stop then Start clears the chart.** The RTT history and the probe lane used to
  survive a restart while the outbound rows, the sparklines and the probe table were
  cleared — half the screen resetting and half not, with measurements from the previous
  run sitting under a fresh, empty table. Reload takes the same path, and a reloaded
  config can rename or drop outbounds, which left columns keyed to tags the new instance
  will never mention again.
- **Start can be pressed after Stop.** It guarded on the config path recorded when you
  pick a file in the window, so a config opened any other way — through
  `XRAYSTUDIO_CONFIG`, or by a sidecar already running one — left the button disabled
  with a config visible in the header and nothing to explain the contradiction.
- **The probe lane no longer shows a failing outbound as plainly healthy.** The row
  highlight is the observatory's verdict and the marks are the individual probes; an
  outbound stays alive while any sample in `interval × sampling` succeeded, so after it
  starts failing the verdict lags by up to a whole window — a minute and a half with the
  defaults. The row was tinted green with a run of red marks beside it.

  It now has its own amber state, because that disagreement is worth seeing rather than
  smoothing away: an outbound in it is still eligible, and a balancer will keep picking
  it. The tooltip says what the state means and when it will flip.

## 0.1.0-alpha.3

A bad field in a config could take the whole window down. It cannot any more, and when
something else does, there is now a report to send.

### Fixed

- **A malformed field no longer blanks the application.** A number where a duration was
  expected — `"interval": 30` instead of `"30s"` — threw while rendering the observatory
  and React took the entire interface with it: no panel, no error, nothing to click.
  `"subjectSelector": "proxy-"` as a bare string did the same to the Graph. Nine places
  read the config with casts that assert a shape rather than check one; they check now,
  and forgivingly, since this is a tool for looking at broken configs and Validate is
  what should object.
- **A faulted outbound is no longer reported dead when it is alive.** The rail turned a
  host red the moment any fault was armed on it. That was indistinguishable from the
  truth while every fault made the outbound unreachable, and wrong the moment one did
  not: with a quota freeze the probes keep passing, and the dot was asserting "dead"
  over telemetry saying the opposite — hiding the exact disagreement that fault exists
  to show. The dot reports the observatory's opinion and nothing else; a hard-down fault
  still turns it red once that becomes true.

### Added

- **A crash dialog.** When something in the interface throws, it now names what failed
  and shows the message, the stack, the platform and the versions in one block, with a
  Copy button and a restart. It says the defect is in this tool rather than in your
  config, that nothing was written to your file, and that the Xray instance is still
  running — and the report deliberately carries no part of the config, so it is safe to
  paste as it is. Coverage includes the shell itself and the failures an error boundary
  structurally cannot see: a rejected IPC call, or a throw inside an event handler.
- **An unimplemented fault kind is refused instead of ignored.** A rule naming a kind the
  engine does not have was accepted, listed, and completely inert — everything reporting
  success while no dial was ever faulted. That is the failure this whole tool exists to
  expose, and it was the tool's own behaviour.

### For anyone building from source

- `npm run dev` rebuilds the sidecar when its sources are newer, and refuses to start if
  that build fails. It used to launch whatever Go binary was on disk, so a new interface
  could talk to an old engine with no sign that anything was wrong.

## 0.1.0-alpha.2

One new failure mode, and two things that were quietly telling you the wrong thing.

### Fault injection

- **Quota freeze — TSPU 16/20 KB.** A per-connection byte quota, the way Russian TSPU
  equipment throttles TLS leaving the country. The handshake completes and small
  exchanges succeed; once roughly 16 KB has been sent or 20 KB received on one
  connection, it stops carrying bytes — no RST, no error, silence until the caller times
  out. A new connection gets a fresh quota, which is why a page loads in fragments and a
  large download never finishes.

  It reproduces the one failure none of the existing kinds could. Blackhole, refuse and
  the unreachables fail the dial, so the probe fails too and the observatory correctly
  reports the outbound dead. `reset_after` delivers a visible `ECONNRESET`. This
  produces neither: a health check fetching a 204 moves a few hundred bytes, never
  reaches the quota, and reports the outbound perfectly alive while every real transfer
  through it dies. Reach for it when the observatory says alive and users say broken.

  Both thresholds are editable, because they are not constants — the trigger is a packet
  count, around 25 in either direction, so the payload figure depends on the MSS and
  operators report anywhere from 15 to 20 KB.

### Fixed

- **The RTT chart no longer looks broken before the first probe.** With no samples uPlot
  laid out no x axis, gave the plot area the whole canvas, and cut the bottom gridline's
  label in half, so an empty chart read as a failed one. Nothing is drawn now until
  there is something to draw, and the space is held so the panel does not jump when the
  first measurement lands.

### Interface

- **The assistant is called AI Assistant** and says what it is for while collapsed,
  instead of sitting at the bottom of the Editor as a grey row that reads like a footer.

### Project

- A [website](https://x-ray.studio), English and Russian, switched in place without
  leaving the page.
- The README says plainly what the application collects, which is nothing: no analytics,
  no crash reporting, no update check. The one exception is the AI Assistant, and it
  does nothing until you give it a key of your own.

## 0.1.0-alpha.1

First public build. Alpha: interfaces and file formats may change without notice, and
the fault engine acts on **real servers** in the config you open.

Built against Xray-core **v26.7.28**, patched with a nine-commit telemetry series
(`xray/patches/`).

### Observability

- **Decision funnel** — why a balancer picked the outbound it picked, stage by stage,
  with a stable rejection reason for every candidate that dropped out. Threaded through
  the real strategy code rather than reimplemented, and pinned by an equivalence test
  over 10,000 randomised cases.
- **Observe** — live RTT chart with a per-outbound probe lane showing every probe,
  successful and failed, on the chart's own time axis. Failures are never plotted as
  values: the observatory represents a dead probe as a sentinel (`99999999` plain,
  `MaxInt64` burst), and charting those would flatten every real measurement.
- **Log** — the core's structured log stream, filterable by severity and connection id.
- **Self-check** — continuously re-derives the dashboard's claims from the core's own
  answers, using the side-effect-free `GetPrincipleTarget` oracle.

### Fault injection

Eleven fault kinds at the dialer level — blackhole, refuse, host/net unreachable,
DNS failure, TLS hang, TLS garbage, latency, throttle, reset-after, UDP loss — applied
to real dials so probes and user traffic see the same failure. Hard-down faults also
poison established connections, because a firewall does not wait for existing flows to
finish.

The UI states the four fidelity limits rather than burying them: `dialerProxy` hops
never reach the dialer, WireGuard's gVisor stack dials internally, `burst.checkConnectivity`
uses a bare HTTP client outside Xray, and there is no TCP segment loss, ICMP or PMTUD.

### Config work

- **Validate** — catches configs Xray *accepts* and then does not act on: unknown keys
  (Go's JSON decoder ignores them silently), `leastLoad` without an observatory, a
  selector matching nothing, a `fallbackTag` pointing nowhere, `tolerance` without
  `burstObservatory`, and traps that make faults look broken. The known-key set is
  derived by reflecting over `conf.Config`, so it cannot drift from the parser.
- **Editor** — the whole config as text, with a documentation hint for whatever the
  pointer is over. The pointer position maps arithmetically to a character offset
  (the font is monospace), and `getLocation` turns that into the JSON path the docs are
  keyed by — so hints are exact rather than guessed from the nearest word, including
  inside protocol `settings`, which are keyed by protocol.
- **Graph** — the config as a diagram, editable: click a node and change it. Every edit
  is a minimal text patch, so protocol settings, TLS, Reality, `mux`, comments and
  formatting survive untouched. Individual nodes can also be edited as raw JSON.
  Nodes are banded by group — the same tag-prefix split the rail and the RTT legend use
  — on an unbounded pan-and-zoom canvas: a diagram sized to its content forces a choice
  between labels too small to read and a mostly-empty page to scroll. Any group can be
  dragged where its reader wants it; the automatic layout is a starting point, not a
  claim about what matters in a particular config. The one spacing control widens the
  gap between COLUMNS, which is the only dimension where more room buys legibility —
  every edge crosses it.
- **Assistant** — a collapsible chat under the editor (Claude or ChatGPT), given both
  the config and the live telemetry: which outbounds the observatory calls alive, their
  deviation, the balancer's decision funnel with the core's own rejection reasons, armed
  faults and validator findings. That is the difference between this and pasting a config
  into a browser tab — "why is this outbound never picked?" has an answer here.
  The API key is encrypted with the OS keychain and lives only in the main process; the
  window never receives it. Credentials in the config are masked by default before
  anything is sent. Provider calls go through a configurable proxy, because Chromium
  ignores `HTTPS_PROXY` and a direct request is refused outright in some regions.
- **Reference / Protocols** — 311 documented parameters and the generated
  `settings` schema for every protocol in the registry.
- **What-if** — runs the real strategy against a frozen observation and reports the
  outcome over 1,000 trials, because `random` and `leastLoad` end in a uniform draw.

### Known limits

- One artefact per system: a universal macOS `.dmg` (Intel and Apple Silicon), a
  Windows installer carrying both x64 and arm64, and an Arch Linux `.pkg.tar.zst` per
  architecture — Linux has no universal binary format, so that is the one place a single
  file is not possible. The fault dialer's errno layer is build-tagged per platform; the Windows variant
  synthesises WSA* errors through ConnectEx and WSARecv so an injected failure is
  indistinguishable from a real one there too.
- Unsigned and un-notarised — see the README for the one-time quarantine removal.
- One config per process. Reload is a respawn, by design.
