# version-service

[![Powered by Sebastian Software](https://img.shields.io/badge/Powered%20by-Sebastian%20Software-00718d?style=flat-square)](https://oss.sebastian-software.com)
[![CI](https://github.com/sebastian-software/version-service/actions/workflows/ci.yml/badge.svg)](https://github.com/sebastian-software/version-service/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)

Shared update-check endpoint for Sebastian Software CLIs — privacy-bounded version checks with aggregate usage counts, running on [Bunny Edge Scripting](https://bunny.net/edge-scripting-overview).

## How it works

A CLI checks at most once per 24 hours whether a newer release exists. The request doubles as an anonymous usage signal: the service counts it in aggregate and answers with the latest released version. There is deliberately **no stable identifier** — daily request counts approximate daily active installations, and that is the entire metric. This repository is public so that claim stays auditable.

### Wire contract (v2)

`POST /check`

```json
{
  "project": "palamedes",
  "version": "1.17.3",
  "os": "linux",
  "arch": "x86_64",
  "ci": false,
  "installedSince": "2026-08"
}
```

Response:

```json
{ "latestVersion": "1.18.0" }
```

- `project` is validated against a server-side allowlist that also maps each project to its version source (npm, crates.io, GitHub Releases).
- `installedSince` is a coarse year-month install cohort. Finer granularity is deliberately rejected: combined with the other dimensions it would create singleton cells whose daily requests become linkable — a de-facto identifier.
- Everything is validated strictly: exact key set, strict semver, token patterns, a 1 KiB body limit.

### Privacy model

- No installation ID, no fingerprinting, no PII.
- Client IP addresses and user agents are never stored: events reach the analytics sink with neutralized values.
- Protocol metadata (path, `Content-Type`, `Content-Length`) is read for request validation only.
- Clients honor `DO_NOT_TRACK=1` plus a per-tool opt-out (for example `PALAMEDES_UPDATE_CHECK=0`), fail silently, and never change command output or exit status.

## Architecture

- **Runtime**: a single standalone Bunny Edge Scripting script (Deno/V8).
- **Sink**: our self-hosted Rybbit instance via its server-side events API; the API key lives in a Bunny secret, never in this repository.
- **Version source**: the registry each project publishes to, fetched and cached inside the script — publishing a release is the synchronization.

## Status

The agreed design and its open points are pinned in
[palamedes#1036](https://github.com/sebastian-software/palamedes/issues/1036).
The service is **not yet implemented or deployed**. The Rust reference client
lives in [palamedes#973](https://github.com/sebastian-software/palamedes/pull/973);
a shared Node client (`@sebastian-software/update-check`) is planned as a
package in this repository.

## Development

Source code lives in `packages/<name>`.

```bash
pnpm install
pnpm agent:check   # lint + format + typecheck + build + test
```

| Script        | What it does                                        |
| ------------- | --------------------------------------------------- |
| `pnpm lint`   | OxLint first (fast), then ESLint (deep, type-aware) |
| `pnpm format` | Format everything with oxfmt                        |
| `pnpm build`  | Build all workspace packages                        |
| `pnpm test`   | Test all workspace packages                         |

## License

[MIT](LICENSE)

---

<!-- sebastian-software-branding:start -->
<p align="center">
  <a href="https://oss.sebastian-software.com">
    <img src="https://sebastian-brand.vercel.app/sebastian-software/logo-software.svg" alt="Sebastian Software" width="240" />
  </a>
</p>

<p align="center">
  <strong>Built by Sebastian Software</strong> — consulting for TypeScript, React &amp; Rust.<br />
  <a href="https://sebastian-software.de">Work with us</a> · <a href="https://oss.sebastian-software.com">More open source</a>
</p>

<p align="center">Copyright &copy; 2026 Sebastian Software GmbH</p>
<!-- sebastian-software-branding:end -->
