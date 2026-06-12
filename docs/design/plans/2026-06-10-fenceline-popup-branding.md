# Fenceline Popup + Branding Refresh Implementation Plan

**Goal:** Add a uBlock-style toolbar popup showing quick stats + sync status, and refresh the extension's pages to lead with the Fenceline brand assets (icon + wordmark) consistently.

**Architecture:** Purely additive/visual. A new browser-action popup reuses the existing `status` message and `stats` storage (no service-worker changes). A shared `brand.css` holds tokens + a `.brandbar` header used by the popup, report, and block pages. The icon SVG is rasterized to PNGs with Pillow.

**Tech Stack:** MV3 Chrome extension (vanilla JS modules, no framework), plain CSS, Python 3 + Pillow 12 (icon rasterization), Node self-tests (`node test/*.mjs`).

---

## File Structure

New:
- `extension/lib/brand.css` — shared tokens (`:root`) + `.brandbar`, `.dot`, `.slats`.
- `tools/render-icons.py` — Pillow script: icon SVG geometry → `icon16/32/48/128.png`.
- `extension/popup/format.js` — pure helpers `relTime`, `todayCount` (DOM-free, testable).
- `extension/popup/popup.html` / `popup.css` / `popup.js` — the popup.
- `test/popup.mjs` — Node self-test for `format.js`.

Modified:
- `extension/manifest.json` — add `action`.
- `extension/icons/icon16.png` / `icon32.png` / `icon48.png` / `icon128.png` — regenerated.
- `extension/report/report.html` / `report.css` — brandbar header; tokens move to `brand.css`.
- `extension/block/block.html` / `block.css` — branded header; link `brand.css`.

Unchanged: `sw.js`, `sync.js`, `log.js`, `hash.js`, `tail.js`, compiler, list artifacts, permissions.

> Work happens on branch `feature/popup-branding` (already created). Commit after each task. Do not push.

---

## Task 1: Shared brand stylesheet

**Files:**
- Create: `extension/lib/brand.css`

- [ ] **Step 1: Create `extension/lib/brand.css`**

```css
/* Fenceline shared brand layer: design tokens + header system.
   Linked by the popup, report, and block pages so branding stays
   consistent across every surface. Local packaged asset — no network. */
:root {
  --paper: #f6f3ec;
  --ink: #20303a;
  --muted: #62707a;
  --signal: #b6452c;
  --line: #d8d2c4;
  --card: #fffdf8;
  --ok: #3f7a52;
}

.brandbar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
}
.brandbar .logo { height: 22px; width: auto; display: block; }

.dot {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  font-size: 11px;
  letter-spacing: 0.08em;
  text-transform: uppercase;
  color: var(--muted);
}
.dot::before {
  content: "";
  width: 8px;
  height: 8px;
  border-radius: 50%;
  background: var(--muted);
}
.dot.ok::before { background: var(--ok); }

.slats {
  height: 10px;
  background: repeating-linear-gradient(90deg, var(--ink) 0 12px, transparent 12px 19px);
}
```

- [ ] **Step 2: Commit**

```bash
git add extension/lib/brand.css
git commit -m "feat: add shared brand.css tokens and header system"
```

---

## Task 2: Rasterize icon SVG to PNGs

**Files:**
- Create: `tools/render-icons.py`
- Modify (regenerated): `extension/icons/icon16.png`, `icon32.png`, `icon48.png`, `icon128.png`

- [ ] **Step 1: Create `tools/render-icons.py`**

```python
#!/usr/bin/env python
"""Rasterize the Fenceline icon to PNG sizes for the extension manifest.

Pure Pillow; mirrors the geometry of extension/icons/fenceline-icon.svg
exactly (viewBox 0..230) and supersamples for crisp anti-aliased edges.
No SVG parser required.

Run: python tools/render-icons.py
"""
from pathlib import Path

from PIL import Image, ImageDraw

ICON_DIR = Path(__file__).resolve().parent.parent / "extension" / "icons"
VB = 230          # SVG viewBox is 0..230
SS = 16           # supersample factor
SIZES = (16, 32, 48, 128)

INK = (32, 48, 58, 255)       # #20303A
RUST = (182, 69, 44, 255)     # #B6452C
PAPER = (246, 243, 236, 255)  # #F6F3EC


def draw_icon(px: int) -> Image.Image:
    """Render the icon into a px-by-px transparent RGBA image."""
    img = Image.new("RGBA", (px, px), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)
    s = px / VB  # viewBox units -> pixels

    def S(v: float) -> float:
        return v * s

    r = S(22)
    # Picket 1 (x0..50): left corners rounded. corners = (TL, TR, BR, BL).
    d.rounded_rectangle([S(0), S(0), S(50), S(230)], radius=r,
                        corners=(True, False, False, True), fill=INK)
    # Pickets 2 and 3: square.
    d.rectangle([S(62), S(0), S(110), S(230)], fill=INK)
    d.rectangle([S(120), S(0), S(168), S(230)], fill=INK)
    # Picket 4 (x180..230): right corners rounded.
    d.rounded_rectangle([S(180), S(0), S(230), S(230)], radius=r,
                        corners=(False, True, True, False), fill=INK)
    # Rust horizontal band (y96..134).
    d.rectangle([S(0), S(96), S(230), S(134)], fill=RUST)
    # Blocked badge: paper ring, rust disc, paper dash.
    d.ellipse([S(115 - 66), S(115 - 66), S(115 + 66), S(115 + 66)], fill=PAPER)
    d.ellipse([S(115 - 52), S(115 - 52), S(115 + 52), S(115 + 52)], fill=RUST)
    d.rounded_rectangle([S(87), S(108.5), S(87 + 56), S(108.5 + 13)],
                        radius=S(6.5), fill=PAPER)
    return img


def main() -> None:
    for size in SIZES:
        big = draw_icon(size * SS)
        out = big.resize((size, size), Image.LANCZOS)
        path = ICON_DIR / f"icon{size}.png"
        out.save(path)
        with Image.open(path) as chk:
            assert chk.size == (size, size), f"{path} wrong size {chk.size}"
        print(f"wrote {path} ({size}x{size})")


if __name__ == "__main__":
    main()
```

- [ ] **Step 2: Run the script**

Run: `python tools/render-icons.py`
Expected output (4 lines):
```
wrote .../extension/icons/icon16.png (16x16)
wrote .../extension/icons/icon32.png (32x32)
wrote .../extension/icons/icon48.png (48x48)
wrote .../extension/icons/icon128.png (128x128)
```

- [ ] **Step 3: Eyeball the 128px output**

Open `extension/icons/icon128.png`. Confirm: four ink pickets (outer two rounded on their outer edges), a rust band across the middle, and a centered circular badge with a paper dash. It should match `fenceline-icon.svg`.

- [ ] **Step 4: Commit**

```bash
git add tools/render-icons.py extension/icons/icon16.png extension/icons/icon32.png extension/icons/icon48.png extension/icons/icon128.png
git commit -m "feat: rasterize Fenceline icon to png sizes via Pillow"
```

---

## Task 3: Pure popup helpers (TDD)

**Files:**
- Create: `extension/popup/format.js`
- Test: `test/popup.mjs`

- [ ] **Step 1: Write the failing test — `test/popup.mjs`**

```javascript
#!/usr/bin/env node
// Self-test for the popup's pure helpers. Run: node test/popup.mjs
import { relTime, todayCount } from "../extension/popup/format.js";

let failures = 0;
function assert(cond, msg) {
  if (cond) console.log(`  ok    ${msg}`);
  else {
    console.error(`  FAIL  ${msg}`);
    failures++;
  }
}

const NOW = 1_700_000_000_000;

console.log("relTime:");
assert(relTime(0, NOW) === "never", "0 -> never");
assert(relTime(null, NOW) === "never", "null -> never");
assert(relTime(NOW - 5_000, NOW) === "just now", "5s -> just now");
assert(relTime(NOW - 5 * 60_000, NOW) === "5m ago", "5m -> 5m ago");
assert(relTime(NOW - 2 * 3_600_000, NOW) === "2h ago", "2h -> 2h ago");
assert(relTime(NOW - 3 * 86_400_000, NOW) === "3d ago", "3d -> 3d ago");
assert(relTime(NOW + 10_000, NOW) === "just now", "future clamps to just now");

console.log("\ntodayCount:");
assert(todayCount({}, "2026-06-10") === 0, "empty stats -> 0");
assert(todayCount({ byDay: {} }, "2026-06-10") === 0, "no day entry -> 0");
assert(
  todayCount({ byDay: { "2026-06-10": { adult: 3, social: 2 } } }, "2026-06-10") === 5,
  "sums today's categories"
);
assert(
  todayCount({ byDay: { "2026-06-09": { adult: 9 } } }, "2026-06-10") === 0,
  "other day ignored"
);

console.log(failures ? `\n${failures} FAILURE(S)` : "\nAll checks passed.");
process.exit(failures ? 1 : 0);
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node test/popup.mjs`
Expected: FAIL — `Cannot find module .../extension/popup/format.js`.

- [ ] **Step 3: Write `extension/popup/format.js`**

```javascript
// Pure, DOM-free helpers for the popup so the logic is unit-testable
// in Node (see test/popup.mjs).

export function relTime(ts, nowMs) {
  if (!ts) return "never";
  const sec = Math.max(0, Math.floor((nowMs - ts) / 1000));
  if (sec < 60) return "just now";
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min}m ago`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr}h ago`;
  const day = Math.floor(hr / 24);
  return `${day}d ago`;
}

export function todayCount(stats, todayIso) {
  const day = (stats && stats.byDay && stats.byDay[todayIso]) || {};
  return Object.values(day).reduce((a, b) => a + b, 0);
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node test/popup.mjs`
Expected: PASS — ends with `All checks passed.`

- [ ] **Step 5: Confirm the existing self-test still passes**

Run: `node test/selftest.mjs`
Expected: ends with `All checks passed.`

- [ ] **Step 6: Commit**

```bash
git add extension/popup/format.js test/popup.mjs
git commit -m "feat: add tested relTime/todayCount popup helpers"
```

---

## Task 4: The popup (markup, styling, wiring) + manifest action

**Files:**
- Create: `extension/popup/popup.html`, `extension/popup/popup.css`, `extension/popup/popup.js`
- Modify: `extension/manifest.json`

- [ ] **Step 1: Create `extension/popup/popup.html`**

```html
<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>Fenceline</title>
<link rel="stylesheet" href="../lib/brand.css">
<link rel="stylesheet" href="popup.css">
</head>
<body>
  <header class="brandbar">
    <img class="logo" src="../icons/fenceline-logo.svg" alt="Fenceline">
    <span class="dot" id="engine">offline</span>
  </header>

  <section class="numbers">
    <div class="num">
      <span class="n" id="today">0</span>
      <span class="lbl">Blocked today</span>
    </div>
    <div class="num">
      <span class="n" id="total">0</span>
      <span class="lbl">All-time</span>
    </div>
  </section>

  <section>
    <h2>Top categories</h2>
    <div id="cat-bars" class="bars"></div>
  </section>

  <section class="sync">
    <div><span class="k">List</span><span class="v" id="version">—</span></div>
    <div><span class="k">Domains</span><span class="v" id="domains">—</span></div>
    <div><span class="k">Last sync</span><span class="v" id="lastsync" title="">never</span></div>
    <div><span class="k">Last check</span><span class="v" id="lastcheck" title="">never</span></div>
  </section>

  <footer>
    <button id="report" type="button">Open full report</button>
  </footer>

  <script type="module" src="popup.js"></script>
</body>
</html>
```

- [ ] **Step 2: Create `extension/popup/popup.css`**

```css
* { box-sizing: border-box; }

body {
  width: 320px;
  margin: 0;
  padding: 14px 16px 16px;
  background: var(--paper);
  color: var(--ink);
  font: 13px/1.45 system-ui, -apple-system, "Segoe UI", Roboto, sans-serif;
}

.brandbar { margin-bottom: 14px; }

.numbers { display: grid; grid-template-columns: 1fr 1fr; gap: 10px; }
.num {
  background: var(--card);
  border: 1px solid var(--line);
  border-radius: 8px;
  padding: 12px 14px;
  display: flex;
  flex-direction: column;
  gap: 2px;
}
.num .n { font-size: 26px; font-weight: 700; font-variant-numeric: tabular-nums; line-height: 1; }
.num:first-child .n { color: var(--signal); }
.num .lbl { font-size: 11px; letter-spacing: 0.06em; text-transform: uppercase; color: var(--muted); }

h2 { font-size: 11px; letter-spacing: 0.1em; text-transform: uppercase; color: var(--muted); margin: 16px 0 8px; }

.bars { display: grid; gap: 6px; }
.bar-row { display: grid; grid-template-columns: 78px 1fr 34px; align-items: center; gap: 8px; }
.bar-label { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-weight: 600; }
.bar-track { background: var(--card); border: 1px solid var(--line); border-radius: 3px; height: 14px; overflow: hidden; }
.bar-fill { background: var(--ink); height: 100%; min-width: 2px; }
.bar-row:first-child .bar-fill { background: var(--signal); }
.bar-count { text-align: right; font-variant-numeric: tabular-nums; color: var(--muted); }
.empty { color: var(--muted); font-size: 12px; }

.sync {
  margin-top: 16px;
  border-top: 1px solid var(--line);
  padding-top: 12px;
  display: grid;
  gap: 6px;
}
.sync div { display: flex; justify-content: space-between; gap: 12px; }
.sync .k { color: var(--muted); }
.sync .v { font-weight: 600; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }

footer { margin-top: 14px; }
button {
  width: 100%;
  font: inherit;
  font-weight: 600;
  background: var(--ink);
  color: var(--card);
  border: 0;
  border-radius: 6px;
  padding: 9px;
  cursor: pointer;
}
button:hover { background: #31454f; }
button:focus-visible { outline: 3px solid var(--signal); outline-offset: 2px; }
```

- [ ] **Step 3: Create `extension/popup/popup.js`**

```javascript
import { relTime, todayCount } from "./format.js";

function send(msg) {
  return new Promise((resolve) => chrome.runtime.sendMessage(msg, resolve));
}

function esc(s) {
  const d = document.createElement("span");
  d.textContent = s;
  return d.innerHTML;
}

async function render() {
  const status = (await send({ type: "status" })) || {};
  const { stats = {} } = await chrome.storage.local.get(["stats"]);
  const now = Date.now();

  // Engine status dot
  const engine = document.getElementById("engine");
  engine.className = status.ready ? "dot ok" : "dot";
  engine.textContent = status.ready ? "active" : "not loaded";

  // Big numbers
  const today = todayCount(stats, new Date().toISOString().slice(0, 10));
  document.getElementById("today").textContent = today.toLocaleString();
  document.getElementById("total").textContent = (stats.total || 0).toLocaleString();

  // Top 3 categories
  const cats = Object.entries(stats.byCategory || {})
    .sort((a, b) => b[1] - a[1])
    .slice(0, 3);
  const wrap = document.getElementById("cat-bars");
  if (!cats.length) {
    wrap.innerHTML = '<p class="empty">No blocks yet.</p>';
  } else {
    const max = cats[0][1];
    wrap.innerHTML = cats
      .map(
        ([name, n]) => `
      <div class="bar-row">
        <span class="bar-label">${esc(name)}</span>
        <span class="bar-track"><span class="bar-fill" style="width:${(n / max) * 100}%"></span></span>
        <span class="bar-count">${n.toLocaleString()}</span>
      </div>`
      )
      .join("");
  }

  // Sync block
  document.getElementById("version").textContent = status.listVersion
    ? String(status.listVersion).slice(0, 12)
    : "—";
  document.getElementById("domains").textContent = status.listTotal
    ? status.listTotal.toLocaleString()
    : "no list yet";

  const ls = document.getElementById("lastsync");
  ls.textContent = relTime(status.lastFullSync, now);
  ls.title = status.lastFullSync ? new Date(status.lastFullSync).toLocaleString() : "";

  const lc = document.getElementById("lastcheck");
  lc.textContent = relTime(status.lastCheck, now);
  lc.title = status.lastCheck ? new Date(status.lastCheck).toLocaleString() : "";
}

document.getElementById("report").addEventListener("click", () => {
  chrome.runtime.openOptionsPage();
});

render();
```

- [ ] **Step 4: Add the `action` to `extension/manifest.json`**

Insert this block immediately after the `"description": ...` line (before `"background"`):

```json
  "action": {
    "default_popup": "popup/popup.html",
    "default_title": "Fenceline",
    "default_icon": {
      "16": "icons/icon16.png",
      "48": "icons/icon48.png",
      "128": "icons/icon128.png"
    }
  },
```

- [ ] **Step 5: Validate the manifest JSON parses**

Run: `node -e "JSON.parse(require('fs').readFileSync('extension/manifest.json','utf8')); console.log('manifest ok')"`
Expected: `manifest ok`

- [ ] **Step 6: Load-unpacked smoke check**

In Chrome: `chrome://extensions` → Developer mode → Load unpacked → select `extension/`. Click the Fenceline toolbar icon. Confirm the popup opens, shows the wordmark, two numbers, a categories area ("No blocks yet." if none), the sync rows, and that "Open full report" opens the report page.

- [ ] **Step 7: Commit**

```bash
git add extension/popup/popup.html extension/popup/popup.css extension/popup/popup.js extension/manifest.json
git commit -m "feat: add toolbar popup with quick stats and sync status"
```

---

## Task 5: Report page branding refresh

**Files:**
- Modify: `extension/report/report.html`, `extension/report/report.css`

- [ ] **Step 1: Link `brand.css` and swap the header in `report.html`**

Replace line 7:
```html
<link rel="stylesheet" href="report.css">
```
with:
```html
<link rel="stylesheet" href="../lib/brand.css">
<link rel="stylesheet" href="report.css">
```

Replace the `<header>...</header>` block (lines 10–21) with:
```html
  <header>
    <div class="brandbar topbar">
      <img class="logo" src="../icons/fenceline-logo.svg" alt="Fenceline">
      <div class="head-actions">
        <button id="export-csv" type="button">Export CSV</button>
        <button id="export-json" type="button" class="ghost">Export JSON</button>
        <button id="clear" type="button" class="danger" hidden>Clear logs</button>
      </div>
    </div>
    <div class="slats" aria-hidden="true"></div>
    <p class="sub">On-device filtering report. Only blocked attempts are recorded — no browsing history.</p>
  </header>
```

- [ ] **Step 2: Remove the duplicated `:root` and slats from `report.css`, add header styles**

In `report.css`, delete the `:root { ... }` block (lines 1–8) — tokens now come from `brand.css`.

Delete the `.slats { ... }` rule (the old lines 21–25) — it now lives in `brand.css`. Add a wrapper margin instead. Replace the deleted `.slats` rule with:
```css
.brandbar.topbar { padding-top: 24px; }
.brandbar.topbar .logo { height: 26px; }
.slats { margin: 18px -24px 28px; }
```

- [ ] **Step 3: Confirm report still renders**

Reload the unpacked extension, open the report page (popup → "Open full report", or the extension's Details → Extension options). Confirm the Fenceline wordmark shows in the header, the slats sit below it, export/clear buttons still work, and all stats panels render as before.

- [ ] **Step 4: Commit**

```bash
git add extension/report/report.html extension/report/report.css
git commit -m "refactor: brand the report header, move tokens to brand.css"
```

---

## Task 6: Block page branding refresh

**Files:**
- Modify: `extension/block/block.html`, `extension/block/block.css`

- [ ] **Step 1: Link `brand.css` and add a branded header in `block.html`**

Replace line 15:
```html
<link rel="stylesheet" href="block.css">
```
with:
```html
<link rel="stylesheet" href="../lib/brand.css">
<link rel="stylesheet" href="block.css">
```

Replace the opening of `<main class="card">` through the slats div (lines 18–19):
```html
  <main class="card">
    <div class="slats" aria-hidden="true"></div>
```
with:
```html
  <main class="card">
    <div class="block-head">
      <img class="logo" src="../icons/fenceline-logo.svg" alt="Fenceline">
    </div>
    <div class="slats" aria-hidden="true"></div>
```

- [ ] **Step 2: Remove duplicated `:root`/`.slats` from `block.css`, add header styles**

In `block.css`, delete the `:root { ... }` block (lines 4–10) — tokens come from `brand.css`.

Delete the `.slats { ... }` rule (old lines 33–42). Replace it with the block-specific header + slats spacing:
```css
.block-head { padding: 26px 0 18px; }
.block-head .logo { height: 22px; width: auto; display: block; }
.slats { height: 14px; margin: 0 -40px 32px; }
```

In the `@media (max-width: 480px)` block, the existing `.slats { margin: 0 -22px 24px; }` override stays as-is.

- [ ] **Step 3: Verify the block page renders offline**

Open `extension/block/block.html?d=example.com&c=adult` via the loaded extension (e.g. paste `chrome-extension://<id>/block/block.html?d=example.com&c=adult`). Confirm the Fenceline wordmark appears above the slats, the "Blocked" tag and message render, and "Go back" works. Throttle/disable network in DevTools and reload — it must still render fully (all assets are packaged).

- [ ] **Step 4: Commit**

```bash
git add extension/block/block.html extension/block/block.css
git commit -m "feat: add Fenceline branding to the block page header"
```

---

## Task 7: Final verification

- [ ] **Step 1: Run all self-tests**

Run: `node test/selftest.mjs && node test/popup.mjs`
Expected: both end with `All checks passed.`

- [ ] **Step 2: Full load-unpacked pass**

Reload the unpacked extension. Verify end to end:
- Toolbar icon shows the Fenceline picture (not a default puzzle piece).
- Popup: wordmark, engine dot state, today/all-time numbers, top categories, sync rows with relative times (hover shows absolute), "Open full report" works.
- Report page: branded header, all panels intact, export/clear/force-sync work.
- Block page: branded header, renders with network disabled.

- [ ] **Step 3: Confirm no service-worker/data files changed**

Run: `git diff --name-only main... | sort`
Expected: only files under `extension/lib/brand.css`, `extension/popup/`, `extension/icons/icon*.png`, `extension/report/`, `extension/block/`, `extension/manifest.json`, `tools/render-icons.py`, `test/popup.mjs`, and `docs/`. No `sw.js`, `sync.js`, `log.js`, compiler, or list artifacts.

- [ ] **Step 4: Final commit (if any stragglers)**

```bash
git add -A
git commit -m "chore: finalize popup + branding refresh" --allow-empty
```

---

## Notes for the implementer

- **No service-worker changes.** The popup only reads via the existing `{type:"status"}` message (`sw.js:163`) and `chrome.storage.local.get(["stats"])`. If you find yourself editing `sw.js`, stop — re-read the design.
- **Block page is load-bearing offline.** Every asset it references must be packaged in the extension (it renders when the network is the problem). Inline/relative local files only — never a CDN, web font, or remote URL.
- **Do not push.** Stay on `feature/popup-branding`; the user integrates manually.
- **Token source of truth is `brand.css`.** Don't re-add `:root` blocks to page CSS.
