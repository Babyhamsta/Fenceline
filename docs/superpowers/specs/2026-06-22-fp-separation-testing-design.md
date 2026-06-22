# FP-Separation Testing — Design

> Status: IMPLEMENTED (2026-06-22) on branch `test/fp-separation-hardening`. All
> three workstreams shipped + wired into CI; 5 documented findings quarantined in
> `classifier/templates/exploratory/`. Goal: in-depth testing of the
> classifier, pin gate, behavioral detectors, and JS↔Python parity so that
> false positives and near-misses ("a page ABOUT X" vs "a page that IS X") are
> caught automatically and can't regress silently.

## Problem

The shipped filter must separate four things for each blocked category
(proxy-bypass, games, adult, gambling):

1. **IS-X** — the page instantiates the category's functional element (a proxy's
   URL box / embedded-URL path, a game's dominant canvas, an adult video player /
   age gate, a casino's bet iframe / license seal / payment field). → block, and
   the host is **pin-worthy**.
2. **ABOUT-X** — an article / forum / Q&A / news page saturated with the
   category's vocabulary but carrying no functional element. → clean (or blocked
   this visit but **never pinned**).
3. **Near-miss-clean** — structurally adjacent to a real instance but legitimate
   (a games portal that is a pure link-hub with no canvas, a Wikipedia *category
   list* at 0.75 link-density, a math-practice interactive-but-clean app, an
   archival/reader service embedding a target URL plainly).
4. **Near-miss-block** — reads clean-ish by structure but policy says block (a VPN
   listicle / "best proxy 2026" promo / affiliate review).

Today's coverage does not exercise (3) and (4), tests only proxy+games for (1)/(2),
and the template harness asserts nothing.

### Load-bearing finding (verified 2026-06-22)

`classifier/template_test.py --dist dist_v3` scores against `classifier/dist_v3`
(a `.pkl` GBDT). **The device does not run that model.** It runs the exported
artifacts in `extension/model/` (`model.bin` + `model-meta.json` + `fusion.json`,
version `75f0aa25501ab3f8`), read by `classifier/fusion_ref.py`. On the existing
5 templates the two models pick the same top category but disagree on
probability — e.g. `forum_games_question` is **games@0.96** under `dist_v3` vs
**games@0.75** shipped. The block verdict happens to agree on these easy cases;
a near-miss sitting between those numbers would pass the harness and fail
on-device. Any template-level assertion is therefore only trustworthy if it
scores the **shipped** model.

## Goals

- A template corpus that probes every category × {is, about, near-miss-clean,
  near-miss-block}, scored through the **shipped** model + the device decision
  rule, with per-template expected verdicts asserted in CI.
- Pin-gate (`pinWorthy`) and behavioral-detector (`proxy-url`, `glyph-cipher`,
  `svg-app`, `search-engine`, `prose-rescue`) coverage extended to the same
  near-miss boundaries, with a JS↔Python agreement check on the pin gate.
- Parity hardened so the chain **sklearn == Python == JS == device** is proven on
  the hard structural vectors, including the **decision rule itself**, plus a
  guard that prevents the harness from silently scoring a non-shipped model.

## Non-goals

- No model retraining or threshold changes. This is a *measurement* effort; it
  reports separation, it does not move it. (If a near-miss is mis-scored, that is
  a finding for a later training pass, recorded in the exploratory lane — not
  fixed here.)
- No full end-to-end extension load in a real browser. The render→extract→score→
  decide path is tested at the function/pipeline level, not through the block UI.
- `dist_v3` is not promoted or modified; it remains an opt-in `--dist` for
  before/after experiments.

## Architecture — three workstreams

### Workstream 1 — Asserting + exploratory template corpus (Python, real render)

**Retarget scoring to the shipped model.** `template_test.py` scores via the
shipped artifacts (`fusion_ref.text_scores` + `fusion_ref.fusion_scores`) and a
decision function that mirrors `extension/lib/model.js:decide` +
`classifier/decision.py` (`is_search_engine_url` → fusion ≥ `thr_fusion` →
text ≥ `thr_text` AND NOT `prose_rescue`). The single hybrid-decide implementation
already exists as `fp_audit.hybrid_decide`; the harness reuses it rather than
re-deriving the rule. `--dist DIR` stays as an **optional** override that swaps in
`fp_score.Model(DIR)` for before/after experiments; default = shipped.

**Pin decision** stays `fp_audit.has_functional_element` (mirror of
`pins.js:pinWorthy`), as today.

**Corpus layout.**
- `classifier/templates/*.html` — the **settled** set (known-correct expected
  verdicts). Asserted.
- `classifier/templates/exploratory/*.html` — **uncertain / policy-contested**
  probes (e.g. games portal link-hub, where the rework plan keeps the portal
  signal a *feature* not a hard block, while policy leans block). Printed with
  full structural tells, **not** asserted — calibration surface, not a gate.
- `classifier/templates/_expected.json` — `{ "<name>.html": {"block":
  "<category>"|"clean", "pin": <bool>} }` for the settled set only. A settled
  template with no entry is an error (forces an explicit decision per template).

**Harness modes** (`template_test.py`):
- default: print the verdict table for the settled set (current behavior, shipped
  model).
- `--all`: also render and print `exploratory/`.
- `--assert`: compare settled verdicts to `_expected.json`; nonzero exit + a diff
  table on any mismatch. Exploratory templates are never asserted.
- `--dist DIR`: score `DIR` instead of shipped (experiments).

**CI wrapper.** `classifier/tests/test_templates.py` (pytest) invokes the
`--assert` path. It **skips cleanly** (`pytest.skip`) when Playwright or a browser
binary is unavailable, so the suite is green on runners without a browser while
still gating locally and on browser-equipped CI.

**Template matrix** (settled unless marked *exploratory*). Each row is one
`.html`; expected `block`/`pin` in brackets.

| category | IS-X (block, pin) | ABOUT-X (clean) | near-miss-clean (clean) | near-miss-block (block) |
|---|---|---|---|---|
| proxy | `real_proxy` (url box) ✓; `proxy_canvas` (full-canvas, cherrion-style); `proxy_embed_url` (target in path) | `blog_what_is_proxy` ✓; `forum_proxy_question` ✓ | `archive_reader` (embeds target URL plainly, legit) | `vpn_listicle` (best-proxy/affiliate promo) *may start exploratory* |
| games | `real_game` (canvas) ✓; `game_iframe` (large x-origin frame) | `forum_games_question` ✓; `game_review_article` | `math_practice_app` (interactive, thin text, no canvas); `games_portal_linkhub` *exploratory* | — |
| adult | `adult_player` (video + age gate) | `sex_ed_article` | — | — |
| gambling | `casino_seal` (license seal + payment); `casino_iframe` (large x-origin bet frame) | `gambling_news` | `gambling_odds_explainer` (prose, no element) | `casino_promo` (bonus-code affiliate) *may start exploratory* |

Templates marked ✓ already exist. New templates render to realistic DOM so the
shared structural extractor (`render.py`, mirroring `scan.js`) produces the
discriminating scalars (`link_density`, `paragraph_count`, `has_url_like_input`,
`url_embeds_url`, `has_dominant_canvas`, `has_video_player`, `has_age_gate`,
`has_gambling_license_seal`, `has_payment_field`, `has_large_xorigin_iframe`,
`internal_link_ratio`). Where a real instance is hard to reproduce offline
(cross-origin iframes, video that actually plays), the template includes the
minimal markup the extractor keys on, and the expected verdict is set from an
observed shipped-model run, not assumed.

**Calibration protocol.** New templates are first run un-asserted (printed). A
verdict goes into `_expected.json` (settled) only after it is confirmed correct
against policy; anything the shipped model gets *wrong* stays in `exploratory/`
with a one-line note, becoming a documented finding for a future training pass
rather than a forced/incorrect assertion. This keeps the gate honest: it asserts
what the model *should* and *does* do, and quarantines what it shouldn't.

### Workstream 2 — Pin-gate + detector depth (JS, `test/detect.mjs`)

- **pinWorthy near-misses** mirroring the new templates' structural vectors
  (proxy canvas, embed-url, games iframe vs portal-without-canvas, casino
  payment/iframe, adult age-gate-only). Each asserts pin vs no-pin.
- **JS↔Python pin agreement.** A small shared table of `(category, structural)`
  vectors lives in one JSON fixture; `test/detect.mjs` asserts `pinWorthy` and a
  Python check (`pytest` calling `fp_audit.has_functional_element`) agree on every
  row. Prevents the device pin decision drifting from the offline training router.
- **proxy-url** — more legit-embed FPs (additional archival/reader/CDN hosts that
  carry a plain target URL) and more real-proxy encodings (Scramjet/UV/Bare
  variants), past the current handful.
- **glyph-cipher / svg-app / search-engine** — boundary cases at the documented
  thresholds (distinct-glyph ratio floor, foreignObject-without-script,
  path-scoped engine exemption edges) beyond the current set.

### Workstream 3 — Parity hardening (sklearn == Python == JS == device)

- **Expand existing parity records.** Add the hard structural vectors from the new
  templates to `test_fusion_parity.mjs`'s `RECORDS`, and add a few high-vocabulary
  strings to `test_parity.mjs`, so the tree-walk and vectorizer parity are proven
  on the cases that actually decide near-misses — not just the current 4 + 1.
- **Decision-rule parity (new).** A test that feeds a fixed set of
  `(url, textScores, fusionScores, structural)` tuples — spanning serp-exempt,
  fusion-block, text-backstop-block, prose-rescued-clean, and clean — through both
  `classifier/decision.py` + `fp_audit.hybrid_decide` (Python) and
  `extension/lib/model.js:decide` (JS, with the SERP exemption applied as `sw.js`
  does), asserting identical `(category, reason)`. The tuples are model-independent
  (scores are inputs), so this isolates the deploy rule from the model weights.
- **Shipped-vs-harness sync guard (new).** A test asserting the template harness's
  scoring path equals the shipped `extension/model` decision on the template
  vectors — i.e. that `fusion_ref` (shipped) and whatever the harness scores agree.
  This is the regression test for the finding above: if someone repoints the
  harness at `dist_v3`, or the export drifts from the bundled `fusion.json`, the
  guard fails loudly instead of the corpus silently testing the wrong model.

## CI / runner wiring

- `package.json` `test` already runs `test/detect.mjs`; the expanded pin/detector
  cases ride along, no new wiring.
- `test/detect.mjs` gains the JS half of the pin-agreement table (reads the shared
  JSON fixture).
- Parity tests (`test_parity.mjs`, `test_fusion_parity.mjs`, new decision-rule +
  sync-guard tests) run via Node and spawn Python (`FENCELINE_PYTHON` / venv
  resolution, as the existing ones do). They are added to the suite runner.
- `pytest` gains `classifier/tests/test_templates.py` (skips w/o browser) and the
  Python half of the pin-agreement check (`classifier/tests/test_pin_agreement.py`).

## Risks / must-handle

- **Offline ≠ live extraction.** A template's offline structural vector must match
  what `scan.js` computes live, or the verdict is wrong-by-construction. Mitigated
  by the shared extractor already used in both paths; templates are authored to
  the extractor's documented keys, and any field the offline path can't produce
  (true cross-origin behavior) is noted and the verdict set from an observed run.
- **Browserless CI.** The template pytest must skip, not fail, when Playwright has
  no browser — otherwise the gate is red on stock runners. Explicit skip guard.
- **Over-asserting contested cases.** The games-portal hard-block vs Wikipedia-list
  collision is unresolved by current signals (rework plan keeps it a feature). It
  goes in `exploratory/`, never the settled gate, until a real portal/list corpus
  settles it.
- **Promo/near-miss-block depends on policy, not structure.** `vpn_listicle` /
  `casino_promo` may be CLEAN-by-structure to the model today (the promo signal is
  an `fp_audit` routing heuristic, not part of `decide`). If the shipped model
  doesn't block them, they stay exploratory and are recorded as a known gap, not
  forced green.

## Key files

- Harness: `classifier/template_test.py`, `classifier/templates/`,
  `classifier/templates/_expected.json`, `classifier/tests/test_templates.py`
- Scoring refs: `classifier/fusion_ref.py`, `classifier/fp_audit.py` (hybrid_decide,
  has_functional_element), `classifier/decision.py`, `classifier/fp_score.py`
- Device: `extension/lib/model.js`, `extension/lib/fusion.js`,
  `extension/lib/pins.js`, `extension/lib/detect/*`, `extension/model/*`
- JS tests: `test/detect.mjs`, `classifier/tests/test_parity.mjs`,
  `classifier/tests/test_fusion_parity.mjs`, + new decision-rule & sync-guard tests
- Python tests: `classifier/tests/test_pin_agreement.py`,
  `classifier/tests/test_templates.py`
- Shared fixture: pin-agreement `(category, structural)` table (JSON)
