# Third-party code and content

Xray Studio links a patched build of Xray-core and ships reference text extracted from
the official Xray documentation. Both carry their own licenses, and neither is covered
by this repository's `LICENSE`.

## Xray-core — MPL-2.0

- Upstream: <https://github.com/XTLS/Xray-core>
- License: Mozilla Public License 2.0
- Pinned commit: see [`xray/PIN`](xray/PIN) (tag `v26.7.28`)

The Go sidecar links Xray-core into its own process, and the distributed binary
therefore contains MPL-covered code. MPL-2.0 is a **file-level** copyleft: it requires
that the source of the covered files — including any modifications to them — is made
available to anyone who receives the binary. It does not extend to files that are not
themselves derived from the covered work.

This repository satisfies that in a way that is stronger than a source drop, because the
result is reproducible rather than merely available:

- [`xray/PIN`](xray/PIN) records the exact upstream commit.
- [`xray/patches/`](xray/patches/) contains every modification as a readable patch
  series — nine commits, roughly 380 changed lines.
- [`scripts/bootstrap-xray.sh`](scripts/bootstrap-xray.sh) reconstructs the exact tree
  the binary was built from, and [`scripts/check-pin.sh`](scripts/check-pin.sh) verifies
  it against a hash of the pin and the patches.

Anyone holding a release can therefore rebuild the identical modified Xray-core, which
is the point of the requirement.

Xray-core is **not vendored** into this repository. It is cloned at build time.

## Xray documentation text — CC BY-SA 4.0

- Upstream: <https://github.com/XTLS/Xray-docs-next>
- License: Creative Commons Attribution-ShareAlike 4.0 International

The **Reference** tab and the `?` hover hints are generated from the official docs by
[`tools/docsgen`](tools/docsgen/), pinned to a specific commit for the same reason the
core is: unpinned upstream text would silently change what the app tells you about your
config.

The extracted text lives in [`data/docs-en/`](data/docs-en/) with its own `LICENSE` and
`ATTRIBUTION.md`. CC BY-SA is share-alike: **that directory** stays under CC BY-SA 4.0
regardless of this repository's license, and reusing the text elsewhere carries the same
obligation.

Where a parameter has no official documentation, the app falls back to the field's own
source comment from `infra/conf` and **labels it as such** in the UI, so generated text
is never presented as documentation.

## Geodata — Loyalsoldier/v2ray-rules-dat

`geoip.dat` and `geosite.dat` are **not shipped** with the application. The default
geodata profile points at the release assets of
[Loyalsoldier/v2ray-rules-dat](https://github.com/Loyalsoldier/v2ray-rules-dat), which
are fetched to the user's own data directory on their first start of a config that needs
them, or when they press Update. The files never enter this repository or its release
artefacts.

That project's build tooling is GPL-3.0. The data it compiles comes from several sources
under their own terms, including MaxMind's GeoLite2 (CC BY-SA 4.0) and community domain
lists; see its README for the full list. Users who add their own profiles from a URL or
a `happ://` link are fetching whatever that URL serves, under whatever terms it carries.

## npm and Go dependencies

Ordinary transitive dependencies, under their own licenses (predominantly MIT, BSD and
Apache-2.0). See `app/package-lock.json` and `sidecar/go.sum` for the exact set.

Electron itself is MIT-licensed and bundles Chromium (BSD-style) and Node.js (MIT).
