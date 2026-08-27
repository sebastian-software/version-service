<!--
  README skeleton — after creating a repository from this template:
  1. Replace the title, description and badge URLs (search for "repo-template").
  2. Keep the branding footer at the bottom intact (it is managed org-wide).
-->

# repo-template

[![Powered by Sebastian Software](https://img.shields.io/badge/Powered%20by-Sebastian%20Software-00718d?style=flat-square)](https://oss.sebastian-software.com)
[![CI](https://github.com/sebastian-software/repo-template/actions/workflows/ci.yml/badge.svg)](https://github.com/sebastian-software/repo-template/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)

One-line description of the project.

## Installation

```bash
npm install <package-name>
```

## Usage

```typescript
// Minimal usage example
```

## Development

Source code lives in `packages/<name>`, documentation (built with
[ardo](https://github.com/sebastian-software/ardo)) in `docs/`.

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
