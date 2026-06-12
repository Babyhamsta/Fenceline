# Changelog

All notable changes to Fenceline are documented here. Format follows
[Keep a Changelog](https://keepachangelog.com/); versions track
`extension/manifest.json`. Reconstructed from git history (the repo had no tags
before 1.4.0).

## [1.4.0] - 2026-06-12

Hardening, test coverage, and repo professionalism. Behaviour changed (artifact
hash verification, SW state persistence, guard hardening), so a minor bump.

### Security / robustness

- Verify SHA-256 of every synced artifact (tail, cats, model, DNR chunks) against
  `meta.json` before applying — rejects truncated/corrupt CDN responses and stale
  mixed-version caches. All-or-nothing: a mismatch keeps the current list.
- Pin the `__fenceline_suppress` flag (closure-backed, `configurable:false`) so a
  page can't redefine it to re-arm its `beforeunload` trap and veto force-blocks.
- Persist `lastRealHost` in `chrome.storage.session` so about:blank in-page-proxy
  attribution survives MV3 service-worker suspension.
- Actually enforce the pin cap by evicting from the in-memory Map (it previously
  trimmed only the serialized copy, so storage grew unbounded).

### Added

- Behaviour-based evasion detectors extracted to `extension/lib/detect/` with a
  unit-test suite (`test/detect.mjs`) encoding the documented adversarial cases.
- `extraNoPinHosts` managed-policy key; the block-but-never-pin baseline now
  syncs in `meta.json` (`compiler/no-pin-hosts.txt`) instead of being hardcoded.
- CI workflow (lint + node tests + python tests + parity), ESLint/Prettier/ruff
  configs, `.editorconfig`, Dependabot, SHA-pinned actions.
- SECURITY.md, CONTRIBUTING.md, issue forms, PR template, this changelog.

### Changed

- `docs/superpowers/` → `docs/design/`.
- Doc fixes: build cadence (every 2 days), cross-platform classifier reproduce
  steps, manifest description broadened to ChromeOS/Windows/macOS/Linux.

## [1.3.6] and earlier

Initial public feature set:

- **Two-tier on-device blocking** — declarativeNetRequest fast tier (popular
  blocked domains, enforced even while the SW sleeps) plus a tail engine over the
  full multi-million-domain list (sorted u64 FNV-1a hashes + category bytes),
  synced from GitHub Pages with bandwidth throttling.
- **Tier 3 on-device content classifier** — scores rendered page text against a
  tiny FNV-hashed-n-gram linear model and blocks confident hits the lists miss;
  Python trainer with a byte-exact JS inference parity.
- **Tier 4 behaviour-based evasion detection** — web-proxy engine signatures
  (URL-in-path), the x-bare wire protocol, apps smuggled as top-level SVG
  documents, and glyph-cipher (font-substitution) obfuscation.
- **Shared-host safety** — path-multitenant hosts (Google Sites, archive.org,
  public CDNs) are blocked per-page but never pinned, so one bad page can't
  over-block a whole service.
- Toolbar popup (stats + sync status), on-device report page with export, and a
  Google Admin managed-policy control channel (list URL, allow/deny overrides,
  block-page branding, report controls).
