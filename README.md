<img src="assets/icon.png" width="96" align="right" alt="">

# Xray Studio

**English** · [Русский](README.ru.md)

A desktop tool for testing Xray-core configurations. It shows **why** a load balancer
picked a particular outbound, and it can make specific outbounds unreachable in a way
that is indistinguishable from a real network failure.

Built against **Xray-core v26.7.28**.

![The decision funnel](docs/img/funnel.png)

<sup>Every stage of a real `leastLoad` decision: the candidates, the arithmetic, the one
that was cut and why — and the dice roll at the end, stated as a dice roll.</sup>

None of that is available from Xray itself. Its API reports which outbound a balancer
would pick and nothing about how it got there — no strategy, no candidates, no scores,
no rejection reasons. Probe results, individual RTT samples and per-connection rule
matches are not exposed at all, and when a strategy returns nothing the dispatcher
silently falls through to the first outbound in your file and discards the error. This
tool runs a patched core that emits the missing part.

## No accounts, no telemetry, free

**The application collects nothing and reports nothing.** No analytics, no crash
reporting, no update check, no usage counter — none of that code is in it. That is
checkable rather than promised: the window runs under a `connect-src 'self'` policy, so
it cannot reach the network at all, and the process behind it talks to `127.0.0.1` and
nothing else.

**Your configs never leave your machine.** They are read from disk and nothing is
uploaded, registered or sent anywhere to be processed. The only traffic the tool causes
is the traffic your own config describes — it runs Xray against the servers you listed,
which is the entire point of it.

**Two exceptions, both yours to trigger.** Geodata: a config with `geoip:` or `geosite:`
rules needs `geoip.dat` / `geosite.dat`, which are not in the download. The first time
you start such a config, the active geodata profile fetches the files it is missing —
by default from
[Loyalsoldier/v2ray-rules-dat](https://github.com/Loyalsoldier/v2ray-rules-dat) on
GitHub, about 27 MB — and never again unless you press Update. You can add your own
profiles from URLs or from a `happ://routing/add/…` link, keep as many as you like, and
the one you pick is remembered. Nothing is fetched for a config that does not reference
geodata.

**The other exception is the AI assistant, and it is switched off until you switch it on.** It sends what you ask it,
with an API key you supply, to the provider you chose. It does nothing until you enter a
key, it lists exactly what it will include, and it can replace UUIDs, passwords and
Reality keys with markers of the same length before anything is sent. Never open it and
nothing ever leaves.

**Free, with nothing to buy.** No paid tier, no licence key, no account. The source is
[MPL-2.0](LICENSE) — read it, build it, change it. (Using the AI assistant costs
whatever your provider charges for their API. That is between you and them; this project
takes nothing.)

## Install

Download from [Releases](../../releases). One file per system:

| system | file | how |
|---|---|---|
| **macOS** 14+ | `macos-universal.dmg` | open, drag to Applications. Intel and Apple Silicon in one build |
| **Windows** 10+ | `win-x64.zip` | **portable** — unpack anywhere, run `Xray Studio.exe`. This is the one to take |
| **Windows** 11 ARM | `win-arm64.zip` | optional. Only worth it for native speed on a Snapdragon machine — the x64 build runs there too, under emulation |
| **Arch Linux** x86_64 | `linux-x86_64.pkg.tar.zst` | `sudo pacman -U <file>` |
| **Arch Linux** ARM | `linux-aarch64.pkg.tar.zst` | `sudo pacman -U <file>` |
| **Any other Linux** x86_64 | `linux-x86_64.AppImage` | `chmod +x` and run. No install, no dependency resolution |
| **Any other Linux** ARM | `linux-aarch64.AppImage` | same |

If you take the wrong Windows file, Windows says *"This app can't run on your PC"* — that
message always means an architecture mismatch, never a broken download. `win-x64.zip` is
the safe choice: it runs on ordinary PCs natively and on Windows 11 ARM under emulation.
Take `win-arm64.zip` only if you know the machine is ARM and want native speed;
`$env:PROCESSOR_ARCHITECTURE` in PowerShell prints `AMD64` or `ARM64` if you are unsure.

**Windows has no installer.** Nothing is written outside the folder: no registry keys, no
uninstall entry, no `%APPDATA%`. Settings — the API key, the window profile, pasted
configs — live in `XrayStudio-data` beside the executable, so deleting the folder removes
every trace and copying it to a USB stick carries your setup with it. If you put the
folder somewhere unwritable, such as Program Files, the app falls back to `%APPDATA%`
rather than refusing to start.

One thing does not travel between machines: the API key is encrypted with Windows DPAPI,
which is tied to the account that saved it. The folder opens fine elsewhere, but that key
has to be entered again.

Windows and Linux both need two files, for the same reason: there is no
universal binary format on Linux — no fat binary, no equivalent — so a package is built
for one architecture or the other. The names are exactly what `uname -m` prints, so run
that if you are unsure.

The AppImage is the one to reach for when a dependency is missing or the wrong version:
it never resolves packages, so it cannot fail the way an install can. It is not fully
self-contained though — Electron and its private libraries travel with it, but `gtk3`,
`nss` and `glibc` still come from the host. Only Flatpak or a container would remove
that last dependency, and neither is built here.

If it refuses to start with a FUSE error, run it as
`./XrayStudio-*.AppImage --appimage-extract-and-run`.

The Arch package installs to `/opt` with a desktop entry and icons. Its dependencies are
derived from the shipped binary's own `DT_NEEDED` entries rather than copied from an
Electron boilerplate list — `gtk3`, `nss`, `alsa-lib`, `libcups`, `mesa`, `systemd-libs`,
`dbus`, `at-spi2-core`, `xdg-utils` — so `pacman` pulls exactly what is missing and
nothing that was retired from the repositories years ago.

Also in the release:

| file | what |
|---|---|
| `src.tar.gz` | the sources this release was built from, straight out of `git archive` at the tag |
| `*.blockmap` | not for downloading — a map of content-defined chunks and their hashes, which a future auto-updater uses to fetch only the parts of an installer that changed instead of all 200 MB |

None of the builds are signed. macOS needs the quarantine flag cleared once, and Windows
will warn about an unknown publisher:

```bash
xattr -dr com.apple.quarantine "/Applications/Xray Studio.app"
```

To build it from source instead, see [DEVELOPMENT.md](DEVELOPMENT.md).

## First run

**Open config…**, pick an Xray config, press **Start**. That is the whole setup — the
tool runs its own copy of Xray against your file and leaves the file alone.

Two configs ship with it, and both are worth opening once:

- [`examples/demo-leastload.json`](examples/demo-leastload.json) — four outbounds, a
  `leastLoad` balancer and a live observatory. Every screenshot below was taken against
  it. Send traffic through its SOCKS inbound on `127.0.0.1:62692`, then open **Faults**
  and blackhole one of the `proxy-*` tags: the observatory notices, the balancer moves,
  and the funnel names the reason.
- [`examples/broken-showcase.json`](examples/broken-showcase.json) — a config Xray
  accepts and then does not act on, so **Validate** has something to show.

If you keep configs elsewhere, **Paste JSON…** takes them as text; the pasted copy goes
to the application's own scratch directory and never beside your files.

## What the tabs do

Every screenshot is the real application, captured from inside its own window while
running the demo config against the live network. The numbers in them are measurements
taken as the picture was taken.

The left rail is always present. It lists the outbounds grouped by tag prefix, each with
a sparkline of its last sixty measurements and its most recent RTT, and below them the
balancers with their current pick. Selecting a host there carries into the Graph and the
Editor — the diagram is already on that node and the text is already scrolled to it.

### Observe — what the observatory sees

![The Observe tab](docs/img/observe.png)

The RTT chart plots every successful probe. Failures cannot appear on it — a failed
probe has no round-trip time to plot — so they get their own lane underneath, one mark
per probe with a running success/failure count per host. That separation is deliberate:
the alternative is the observatory's dead marker, `99999999`, drawn as a spike that
rescales the whole axis and hides the differences you were looking at.

The **Probe results** table highlights the columns the *active* strategy actually sorts
by, so the table explains the ranking rather than being a wall of numbers. `leastLoad`
lights up deviation, average, failures and samples; `leastPing` lights up delay alone.

The warning at the bottom of the shot is one the official documentation does not make:
this config uses the plain `observatory`, which produces no HealthPing statistics, so
`leastLoad` has no deviation to rank on and quietly degenerates into `leastPing` with a
cost multiplier.

### The decision funnel — why *this* outbound

![The decision funnel](docs/img/funnel.png)

This is the reason the project exists. A balancer evaluates once per dispatched
connection, and every stage of that evaluation is shown: what went in, what survived,
and **why each loser was dropped**, with the numbers that justify it.

Read the shot from the top. Three candidates come out of the `proxy-` selector. The
filters stage keeps all three because `maxRTT` and `tolerance` are unset. The score
stage shows the arithmetic per survivor — `deviation × √cost = score` — and notes that
there is no HealthPing data behind those deviations. `baseline / expected` cuts the list
to two and names the one it dropped: *`proxy-c` — beyond the expected count*, with
`rank=2 score_ns=138000000` beside it. Two survivors then go into a uniform draw, and
the card says so in as many words: **the winner was chance, not ranking (p = 50%)**.

That last card matters more than it looks. `leastLoad` and `random` both finish with a
dice roll, so with more than one survivor there is no "the balancer chose X because X
was best" — there is a distribution, and a tool that presented one sample as a ranking
would be lying about it.

The trace runs through the *real* balancer code rather than a reimplementation of it
beside the original. There is exactly one implementation of each algorithm, so the
explanation cannot drift from the behaviour it explains — which is the only reason to
believe any of the above.

### Faults — making an outbound unreachable

![The Faults tab](docs/img/faults.png)

A fault rule matches on the **outbound tag**, which is the whole point. Two outbounds
can share a server IP and port, and a packet filter physically cannot tell them apart —
`pf` and `iptables` see identical 5-tuples. A tag can.

In the shot a blackhole has just been armed on `proxy-a`: the topbar has turned red with
a panic button that disarms everything at once, and the rail shows the host red with a
fault badge. Seconds later — visible in the Validate screenshot further down, taken from
the same session — the observatory has caught up and marks it `dead`.

**Is it working?** is the panel worth knowing about. It reports dials the fault engine
has actually intercepted — direct evidence, independent of what the health check thinks
— and here it says the engine has blocked a dial while the observatory *still shows the
host alive*. That is not a bug and the panel explains why: this config probes every 2s,
and a host stays alive while any sample in the window succeeded, so the status lags the
reality by a full round. Without this panel that gap reads as "the fault did nothing".

The failure modes are: blackhole (drop), connection refused, host and network
unreachable, DNS failure, TLS hang, TLS garbage, added latency, bandwidth throttling,
reset after N bytes, UDP packet loss, and a flaky duty cycle over any of the others.
Synthesised errors are asserted byte-identical to real kernel errors — the test compares
against a genuine `ECONNREFUSED` from `127.0.0.1:1` — and live connections are torn down
too, because a firewall does not wait politely for existing flows to finish.

The claim being made is "as if genuinely unreachable", and it is only mostly true. The
five gaps are listed in the panel itself rather than buried in documentation:

1. `sockopt.dialerProxy` hops get a pipe from Xray's internal redirect and never reach
   the dialer, so a fault on them does nothing. Fault the outbound named in
   `dialerProxy` instead — that one performs a real dial.
2. WireGuard's inner netstack dials bypass the dialer; only the outer UDP to the peer is
   covered.
3. `burstObservatory`'s `connectivity` check uses a plain HTTP client outside Xray, and
   when it decides the network is down it makes the observatory *discard* failures
   instead of recording them — which can hide an injected fault. Leave it unset while
   testing.
4. No TCP segment loss: userspace can stall and jitter a stream but cannot drop a
   segment beneath the kernel. No ICMP, no PMTUD blackholes.
5. DNS failure is partial — resolution may already have happened before the dialer is
   reached, depending on `domainStrategy`.

### Graph — the config as a diagram, and an editor

![The Graph tab](docs/img/graph.png)

Inbounds, routing rules, balancers and outbounds in columns, with the observatory as a
service node on dashed edges. The live layer runs on top: the current pick is a thick
green edge, hosts under a fault get red hatching, probes pulse.

Clicking a node opens it in the inspector on the right, and every change is written back
as a **minimal text patch** — never a re-serialisation of the file. Protocol settings,
TLS, Reality, `mux`, your comments and your formatting survive untouched. The diagram
only models tags, balancers and rules; rebuilding the JSON from it would silently delete
everything it does not model, so it never does that.

Renames follow their references — `fallbackTag`, a rule's `outboundTag`, a rule's
`balancerTag` — but deliberately do **not** rewrite balancer selectors. A selector is a
prefix pattern, not a reference; rewriting it would be a guess. The editor reports that
the outbound has left the balancer instead.

Nothing reaches disk until **Save to file**, and the draft is validated through the
sidecar's real loader first.

### Editor — the config as text, annotated

![The Editor tab](docs/img/editor.png)

The whole file in one piece, with a hint for whatever the pointer is over. It resolves
the exact key under the cursor rather than guessing from the word, so hovering `address`
inside a vless outbound documents *vless's* address and not some other protocol's.

Hovering is a glance and stays one — the hint is clamped, because 31 of the 360
documented parameters are longer than a screen (`dns.servers` alone runs to twenty-odd
paragraphs). Clicking the token pins it: the hint
keeps its place, takes the pointer, scrolls, and offers **full text ↗** into the
Reference tab for the entries where scrolling a popup is still the wrong way to read
something.

Comments and trailing commas are accepted, here and everywhere else in the tool.

**AI Assistant** sits along the bottom of this tab, collapsed until you open it. It is
worth knowing about because of what it already has rather than what it is: the config in
front of you *and* the live state — which outbounds the observatory calls alive, their
deviation, why the balancer rejected each candidate, the faults you have armed. So
"why is nothing being selected?" or "this outbound is never picked — why?" are
answerable without pasting anything anywhere.

It stays inert until you enter an API key of your own, for Claude or ChatGPT. Before
sending, it lists what it will include, and it can replace UUIDs, passwords and Reality
keys with markers of the same length — the model still sees that the field is there and
well-formed. The key is encrypted with your OS keychain and kept in the main process;
the window never sees it.

### What-if — asking without touching anything

![The What-if tab](docs/img/whatif.png)

"What would this balancer do if `maxRTT` were 200ms, or if this outbound died?" The
observation is frozen so the sliders act on a stable baseline, and the answer comes from
the sidecar running the **real strategy code** against it — not from a model of that
code reimplemented in the interface.

The result is reported over 1,000 trials, because for `random` and `leastLoad` a single
answer would be a misrepresentation: they end in a uniform draw, so what exists is a
distribution. The badge beside it says which case you are in — the shot reads
`deterministic` because `expected` is at 1, leaving exactly one survivor for the draw to
pick from. Move that slider and the badge changes with the answer.

Below the sliders the frozen observation is editable per host: override a delay, or
`kill` a host outright, and the simulated decision underneath re-runs with every stage
of the funnel intact.

### Validate — configs that load and then do nothing

![The Validate tab](docs/img/validate.png)

Xray already rejects malformed configs; that is the easy half. What it will not tell you
about is the config it *accepts* and then never acts on. Those are reported here as
**silently broken**:

- a balancer selector matching no outbound — never checked at load time, because
  balancers are built before outbounds exist;
- `leastPing` or `leastLoad` with no observatory, which fails with the opaque
  *"not all dependencies are resolved."* and never names the balancer responsible;
- a `fallbackTag` pointing nowhere, so traffic quietly leaves through the *first*
  outbound in the file;
- `tolerance` without `burstObservatory` — parses, clamps, is never consulted;
- a key nothing reads. Go's JSON decoder ignores unknown fields silently, so
  `"balancer"` instead of `"balancers"` behaves exactly as if the block were absent: no
  error, no log line.

The shot is [`examples/broken-showcase.json`](examples/broken-showcase.json), which
triggers the lot: six silently broken findings and two warnings, each with a stable
code, the exact path in the file, and an explanation of what happens instead. `balancer`
where `balancers` was meant. `IPIfNoMatch` for `IPIfNonMatch`, which is not an error —
it falls back to `AsIs`. A selector matching none of the tags that exist, listed beside
it. A `fallbackTag` naming nothing, so the dispatcher quietly uses the first outbound in
the file.

The list of keys it recognises is read out of the core it is linked against, not typed
in by hand, so it cannot fall behind the parser as Xray changes.

### Self-check — auditing the tool's own claims

![The Self-check tab](docs/img/selfcheck.png)

Everything this application tells you about Xray is an assertion about someone else's
code. These checks ask the core the same questions independently and compare the
answers, continuously, so a wrong claim shows up as a failing row instead of quietly
misleading you.

They are careful to ask in a way that changes nothing: the obvious query would advance
round-robin's rotation and re-roll the random draw, corrupting the very behaviour being
measured.

### Reference — the parameter index

![The Reference tab](docs/img/reference.png)

360 configuration parameters, searchable by name, path or text, extracted from the
official XTLS/Xray-docs-next documentation. The same text is what the `?` hints and the
editor's hover popups show, and every entry links back to the page it came from.

It is taken from one fixed version of those docs, for the same reason the core is fixed
to one version: documentation that moved underneath you would silently change what this
tool tells you about your config. The bundle exists in English and Russian —
upstream publishes both — and the switch is in the topbar, marked `docs` because it
changes the documentation only. The fallback is per *parameter* rather than per bundle,
so a key the translation has not reached yet still shows its English description instead
of an empty tooltip.

### Protocols — what goes inside `settings`

![The Protocols tab](docs/img/protocols.png)

**Validate** knows every key in a config except the ones inside `settings`. That block
is decoded later, by a lookup keyed on the protocol name, so nothing about its shape is
knowable from the rest of the file.

This tab recovers that boundary from the core's own sources, which are the only place
recording that `"vless"` means one settings shape and `"trojan"` another. Descriptions
come from the official documentation where it has them and from the field's own source
comment otherwise, always labelled so the two are never confused.

### Log — the core's own logger, teed

![The Log tab](docs/img/log.png)

Structured records straight from Xray's log handler, filterable by severity, package and
connection id — teed rather than replaced, so whatever `log.access` and `log.error` your
config sets up keeps working.

Two entries are worth pointing at. *"no rule matched → default outbound"* is
reconstructed from a routing event that Xray does not otherwise surface: nothing
matched, so traffic silently took the first outbound in the file. And a second-pass
match tells you `IPIfNonMatch` resolved the domain and re-ran the rules against the
addresses.

The log paths themselves are shown at the top of the tab. The application substitutes
its own, always, on every platform — a config written on one machine names log
directories that do not exist on another, and Xray refuses to start rather than
continuing without a log file.

## Reporting something

Open an [issue](../../issues). Config text helps enormously — but scrub it first: an
Xray config carries UUIDs, passwords and Reality keys, and none of them are needed to
reproduce a bug about a balancer.

## Building it yourself

See [DEVELOPMENT.md](DEVELOPMENT.md): the pinned core, the patch series, the sidecar,
the packaging.

## Licence

Xray-core is **MPL-2.0**, and the patches applied to it stay MPL-2.0. The parameter
documentation is adapted from XTLS/Xray-docs-next and is **CC BY-SA 4.0** — it lives in
`data/docs-en/` and `data/docs-ru/` with its own `LICENSE` and `ATTRIBUTION.md`, and
every tooltip links to the page it came from.

This project's own code and its own explanatory text are under [`LICENSE`](LICENSE).
Third-party terms are set out in [`THIRD-PARTY.md`](THIRD-PARTY.md), along with how a
release satisfies MPL's source requirement: the patched core is reproducible from
`xray/PIN` and `xray/patches/`, not merely available.
