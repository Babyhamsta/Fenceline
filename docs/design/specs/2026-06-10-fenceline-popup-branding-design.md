# Fenceline — Toolbar Popup + Branding Refresh

**Date:** 2026-06-10
**Status:** Approved design (pending spec review)

## Goal

Add a uBlock-Origin-style toolbar popup to the Fenceline extension showing quick
stats and sync status, and refresh the existing pages so the product reads as
professional, modern, and well-established. Lead with the new Fenceline brand
assets (icon + wordmark) consistently across every surface.

This is purely additive/visual. No changes to filtering logic, the data model,
permissions, or the service worker.

## Scope

In scope:
- New browser-action popup (`extension/popup/`).
- Shared brand stylesheet (`extension/lib/brand.css`).
- Branding refresh of the report page and the block page.
- Rasterize `fenceline-icon.svg` to PNG icon sizes for the manifest.

Out of scope (YAGNI):
- Per-tab / current-site block counts.
- Sync-now or pause/disable controls in the popup.
- Auto-refresh of the popup while open.
- Any change to `sw.js`, `sync.js`, `log.js`, `hash.js`, `tail.js`, the
  compiler, or list artifacts.

## Brand assets

The user supplied two SVGs in `extension/icons/`:

- `fenceline-icon.svg` — viewBox `0 0 230 230`. Four ink pickets (outer two with
  22px rounded outer corners, app-icon style), a rust horizontal band at
  `y=96 h=38`, and a centered circular "blocked" badge (paper ring r=66, rust
  disc r=52, paper dash `87,108.5 w56 h13 rx6.5`).
- `fenceline-logo.svg` — viewBox `0 0 1105 230`. The same icon plus the
  `FENCELINE` wordmark (ink `#20303A`) as vector paths.

Brand palette (already used implicitly in the report page):

| Token       | Hex       | Role                          |
|-------------|-----------|-------------------------------|
| `--paper`   | `#f6f3ec` | background                     |
| `--ink`     | `#20303a` | text, pickets, primary fill   |
| `--muted`   | `#62707a` | secondary text                |
| `--signal`  | `#b6452c` | rust accent, primary number   |
| `--line`    | `#d8d2c4` | borders                       |
| `--card`    | `#fffdf8` | card surface                  |

## Icon rasterization

No SVG rasterizer (ImageMagick/Inkscape/rsvg/cairosvg) is installed, but Pillow
is present and the icon is pure geometry with known coordinates. A build script
draws the icon shapes with Pillow at 4× then downsamples with LANCZOS for crisp
anti-aliased edges, emitting transparent PNGs.

- Script: `tools/render-icons.py` (pure Pillow, no new dependencies).
- Inputs: the icon geometry (mirrors `fenceline-icon.svg` exactly).
- Outputs: `extension/icons/icon16.png`, `icon32.png`, `icon48.png`,
  `icon128.png` (overwrites the existing placeholder PNGs).
- Rounded outer corners on the leftmost/rightmost pickets are preserved so the
  small sizes still read as a finished app icon.

The wordmark logo is **not** rasterized — it is embedded as inline/`<img>` SVG in
page headers, which stays crisp at any size and needs no build step.

## Architecture

### Shared brand layer — `extension/lib/brand.css`

Single source of truth for the visual system, linked by the popup, report, and
block pages:

- `:root` design tokens (the table above).
- `.brandbar` — horizontal header: the logo wordmark (SVG) on the left, optional
  status dot on the right. One header system everywhere prevents drift.
- `.dot` status indicator: `.dot.ok` (green) / `.dot.off` (grey).
- The existing `.slats` fence motif, promoted here as a reusable accent.

Pages keep their own page-specific CSS for layout, but all reference the same
tokens and brandbar.

### Popup — `extension/popup/popup.{html,css,js}`

Registered via a new `manifest.json` `action`:

```json
"action": {
  "default_popup": "popup/popup.html",
  "default_title": "Fenceline",
  "default_icon": {
    "16": "icons/icon16.png",
    "48": "icons/icon48.png",
    "128": "icons/icon128.png"
  }
}
```

Width ~320px. Layout top → bottom:

1. **Brandbar** — Fenceline logo wordmark + engine status dot
   (`active` green / `not loaded` grey).
2. **Two big numbers** — Blocked today | Blocked all-time.
3. **Top categories** — top 3 as mini bars, reusing the report `.bar-row`
   pattern; first bar uses the rust `--signal` fill.
4. **Sync block** — list version (first 12 chars), domain count, last sync
   (relative "2h ago", absolute timestamp on `title` hover), last check.
5. **Footer** — "Open full report" button → `chrome.runtime.openOptionsPage()`.

Empty/edge states: no list → "no list yet" + grey dot; zero blocks →
"No blocks yet"; long school name → truncate with ellipsis.

### Data flow (no backend changes)

The popup reuses the existing message + storage surface:

- `chrome.runtime.sendMessage({ type: "status" })` → `ready`, `tailSize`,
  `listVersion`, `listTotal`, `listGenerated`, `lastFullSync`, `lastCheck`,
  `config.schoolName` (handler already exists in `sw.js:163`).
- `chrome.storage.local.get(["stats"])` → `total` (lifetime), `byCategory`,
  `byDay`. Today's count = sum of values in `byDay[<today ISO date>]`.

The popup renders once on open (popups are short-lived; no live updates).

### Pure, testable helpers — `extension/popup/format.js`

DOM-free module so logic is unit-testable in the existing Node style:

- `relTime(ts, nowMs)` → "just now" / "5m ago" / "2h ago" / "3d ago" / "never".
- `todayCount(stats, todayIso)` → number; sums `byDay[todayIso]`, 0 when absent.

`popup.js` imports these and handles only DOM wiring.

### Report page refresh — `extension/report/`

- Replace the plain `<h1>Fenceline</h1>` text header with the `.brandbar` +
  logo wordmark.
- Move `:root` tokens out to `brand.css`; `report.css` keeps only layout.
- Tighten spacing/card treatment so it reads as a product dashboard, not a debug
  page. Keep the slats motif as a secondary accent.
- No change to `report.js` data logic.

### Block page refresh — `extension/block/`

- Add the Fenceline icon/logo to the header so a blocked student sees clear,
  legitimate district branding above the existing message.
- Link `brand.css` for tokens.
- Constraint preserved: **no external resources** — the page must render when the
  network is the problem. Logo embedded inline; no fonts/CDN.
- Keep the tone calm and the page fast; light touch only.

## Testing

- `test/popup.mjs` — new self-test in the existing `assert(cond, msg)` style
  (run with `node test/popup.mjs`). Covers `relTime` boundaries (never, <1m,
  minutes, hours, days) and `todayCount` (present day, absent day, empty stats).
- `tools/render-icons.py` asserts it wrote all four PNG sizes at the expected
  pixel dimensions.
- Rendering verified manually via load-unpacked: open the popup, confirm the
  today/lifetime numbers match the report page; confirm the report and block
  headers show the wordmark; confirm icons render in the toolbar.

## Files

New:
- `extension/popup/popup.html`
- `extension/popup/popup.css`
- `extension/popup/popup.js`
- `extension/popup/format.js`
- `extension/lib/brand.css`
- `tools/render-icons.py`
- `test/popup.mjs`

Changed:
- `extension/manifest.json` — add `action`.
- `extension/icons/icon16.png`, `icon32.png`, `icon48.png`, `icon128.png` —
  regenerated from the icon SVG (icon32 is new).
- `extension/report/report.html`, `report.css` — brandbar header, tokens moved
  to `brand.css`.
- `extension/block/block.html`, `block.css` — branded header, link `brand.css`.

Unchanged: `sw.js`, `sync.js`, `log.js`, `hash.js`, `tail.js`, compiler,
list artifacts, permissions, data model.

## Risks / notes

- Pillow-drawn icon must visually match the SVG; the script mirrors exact
  coordinates and supersamples. Verified by eye against the SVG at 128px.
- The block page's no-external-resources rule is load-bearing (it renders during
  network failures) — the logo must be inline SVG, never a network/font fetch.
- Brand assets contain no PII; safe to commit. (Unlike the earlier example
  policy file — real district config stays in the Admin console, never in repo.)
