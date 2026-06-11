# Fenceline — On-Device Content Classifier

**Date:** 2026-06-11
**Status:** Design (pending review)

## Goal

Add a second line of defense to Fenceline: a tiny, on-device machine-learning
classifier that inspects a page's *rendered content* after it loads and blocks
it if it confidently matches a filtered category — even when the domain is on no
blocklist. The blocklists catch *known* bad domains exactly and instantly; the
classifier generalizes to the **long tail of novel and ephemeral sites** the
lists never keep up with (new proxy mirrors, "unblocked games" sites spun up
daily, brand-new adult/gambling domains).

This is **defense in depth, not a replacement.** The list stays the primary,
exact, explainable path. The model is an async backstop on pages the list let
through.

The model and the training pipeline are open-sourced so other districts can use,
audit, and improve them.

## Non-goals

- Replacing the blocklists. The list is faster, exact, and explainable; it stays
  first.
- A real-time blocking gate. The classifier runs **after** the page loads
  (async), never on the navigation critical path.
- Classifying `malware-phishing`. Malicious pages camouflage as legitimate ones
  (a phishing page's text is byte-identical to the real login page), so a
  *content* model is structurally the wrong tool and would cause false
  positives. Malware stays on the reputation/list path (HaGeZi TIF et al.),
  which is already strong at it.
- Vision/screenshot models. Training on rendered imagery re-introduces the media
  (incl. CSAM) handling risk that text-only scraping avoids, costs far more
  on-device, and adds a screenshot-every-page privacy posture. Out of scope. If
  an image safety-net is ever wanted for text-less adult pages, it would be a
  pre-trained, off-the-shelf NSFW classifier — never one trained here.

## Categories

The classifier targets the project's content categories **except
malware-phishing**, plus a `clean` (allowed) class:

`adult`, `gambling`, `drugs`, `hate-violence`, `proxy-bypass`, `social`,
`games`, and `clean`.

(The category set tracks `compiler/sources.json`; `social` comes from the
pending blocklist-expansion work. The classifier reads its label set from the
compiler categories so the two stay in sync.)

## Runtime architecture (the paired design)

```
navigation ──► [Tier 1 DNR] ──► [Tier 2 tail engine]  ── allowed ──► page loads
                  (exact, ~6 µs, both already on-device)                  │
                                                                          ▼
                                                          content script, after hydrate+idle
                                                          extract: rendered innerText + title
                                                          + meta/OG + a few structural flags
                                                                          │
                                                                          ▼
                                                          tiny classifier (in extension)
                                                          → per-category confidence
                                                                          │
                                                   max(conf) ≥ threshold?  │
                                                          │ yes            │ no
                                                          ▼                ▼
                                              redirect to block page    do nothing
                                              + pin domain to local list
                                              (next visit blocks instantly,
                                               with a human-readable reason)
```

Key properties:
- **Runs only on pages the list allowed** — bounds compute to not-already-blocked
  navigations.
- **Async, after `DOMContentLoaded` + a short settle** (`requestIdleCallback` or
  a brief delay), so JS-rendered SPAs have hydrated and `innerText` reflects what
  the student actually sees. Never blocks page load.
- **A positive verdict pins the domain to the device's local block list** with
  the predicted category + confidence as the reason. The pin makes the *next*
  visit an instant, explainable Tier-2 block and gives an auditable trail
  ("blocked by classifier: gambling, 0.97") instead of an opaque model decision.
- **Threshold is tunable** via managed policy (district chooses how aggressive).
  Default favors precision (overprotective is acceptable per requirements, but
  the false-positive rate on legitimate sites is the metric that governs the
  default).

### Input the classifier sees (NOT raw HTML/JS/CSS)

A content script extracts a small, high-signal record — never raw page source:

- `text`: `document.body.innerText`, normalized/truncated (lead N tokens).
- `title`: `<title>`.
- `meta`: `<meta name="description">` + OpenGraph (`og:title`, `og:description`,
  `og:type`, `og:site_name`).
- `structural`: a handful of cheap fingerprints that matter for evasion
  categories — `script_hosts` (distinct script-src hostnames), `iframe_count`,
  known-proxy-framework signatures (e.g. service-worker proxy patterns),
  age-gate / payment-iframe presence.

Feeding code is explicitly avoided: JS/CSS are noise for "what category is this",
and they are why naive approaches blow up context. Short curated input keeps
inference cheap and keeps the model small enough to ship.

## Offline pipeline (`classifier/`)

A new top-level folder, structured and commented to match the rest of the repo
(focused files, no unnecessary dependencies in the parts that can avoid them,
the project's terse technical comment style).

```
classifier/
  README.md          what it is, how to reproduce, how to retrain
  scrape/            headless render + feature extraction (Python + Playwright)
  data/              liveness/park filter, content-dedup, split, balance
  train/             the model bake-off + shared eval harness
  eval/              metrics, learning curves, the comparison table
  corpus/            REPRODUCIBLE inputs: domain+label lists, NOT raw content
  dist/              the chosen shipped model + model-meta.json (versioned)
```

Language split: **Python** for offline scrape/train/eval (Playwright,
scikit-learn, optionally transformers) — consistent with the repo's
"right tool, few deps" stance and the user's Python env. **JavaScript** for the
on-device runtime inference (it must run in the extension).

### 1. Scrape (`classifier/scrape/`)

- Input: the compiled domain set (labelled by category from the compiler) + a
  `clean` set mined from Tranco top sites **minus** the blocklist, plus known
  school/edu and obvious mainstream domains (google, amazon, etc.).
- Render each domain with **headless Chromium (Playwright)** the *same way the
  extension reads it* (rendered `innerText` + meta + structural flags), so there
  is no train/serve skew.
- Safety guardrails (load-bearing):
  - **Block sub-resource fetches** (no images/video/media); we only need DOM text.
  - **Strip `data:` URIs** before storing (avoid inlined media).
  - Store **extracted features only** — never raw pages, never screenshots,
    never media.
  - Per-page timeout; isolated, disposable browser contexts; egress controls.
  - `malware-phishing` is **not scraped** (dropped from scope).
- Target volume: ~**30k raw scraped per category** to net ~10k usable after
  filtering/dedup; **oversample `clean` (~2–3×)** because "everything else" is
  far more diverse than any one blocked topic and that diversity is what prevents
  false positives.

### 2. Clean + dedup + balance (`classifier/data/`)

- **Liveness/park filter:** drop dead, parked, error, and login-wall pages
  (too-little-text and parked-page fingerprints). This pass doubles as a
  **blocklist liveness audit** — dead domains it finds can be pruned from the
  actual lists later.
- **Content dedup:** collapse near-duplicates (simhash/minhash). Adult/games/
  gambling are dominated by template/affiliate farms — thousands of domains
  rendering near-identical pages; without dedup the model trains on the same page
  thousands of times and biases toward big classes.
- **Balance:** roughly equal positive classes; oversample `clean`. Thin
  categories (social/proxy after dedup may yield only a few thousand unique
  pages) are *not* padded with near-duplicate subdomains — use class weights
  instead.
- **Split by registrable domain (eTLD+1)**, once, into train/val/test. Splitting
  by URL would leak subdomains of a training site into test and inflate accuracy.

### 3. Model bake-off (`classifier/train/` + `classifier/eval/`)

The dataset is stored **model-agnostic** so multiple models train and evaluate on
the *same* splits. Canonical record:

```json
{ "etld1": "...", "url": "...", "label": "games",
  "text": "<rendered innerText>", "title": "...", "meta": "<desc+og>",
  "structural": { "script_hosts": ["..."], "iframe_count": 3, "has_age_gate": false } }
```

Each candidate brings its own vectorizer over the shared records. Candidates, in
the order we'd actually try them (cheapest first):

1. **Hashing n-grams → linear** (logistic regression / linear SVM). <1 MB,
   microseconds, trivially portable to JS (just hashing — no tokenizer artifact).
   Topical categories are highly separable by vocabulary; this may simply win.
2. **Static embeddings → linear head** (Model2Vec / "potion", multilingual
   variant — UT1 data is French/EU-heavy). No attention → no context-length
   cliff; a few MB; sub-ms; WASM-only.
3. **Tiny distilled transformer** (MiniLM-L6 / TinyBERT, int8 via
   transformers.js / onnxruntime-web). Tens of ms async; the accuracy ceiling
   that's still device-shippable.
4. *(optional)* **fastText** as a fourth cheap baseline.

ModernBERT (or a strong multilingual encoder) is **offline-only**, held in
reserve as a *teacher* to clean noisy labels and to distill into whichever
student ships — never put on the device.

**A shared eval harness scores every candidate on the same held-out test set and
emits one comparison table** across four axes:

| Axis | Why it gates |
|---|---|
| per-class precision / recall | does it actually detect each category |
| **FP-rate on `clean` at the operating threshold** | the number that decides shippability (over-blocking legit sites) |
| model size (MB) | bandwidth + device storage |
| **p50/p95 inference latency on a bottom-tier Chromebook profile** | the overhead budget |
| requires WebGPU? | if yes, disqualified for the low-end fleet |

**Decision rule:** ship the **lightest model that clears the accuracy + FP bar**
— not the most accurate one. Each candidate must have a **JavaScript inference
path** (linear/static export to JSON/binary + plain-JS inference; transformer via
ONNX/transformers.js); a model that can't run in the extension is disqualified
regardless of score.

**Sizing is confirmed by a learning curve**, not assumed: train each class at
1k/3k/10k and add data only while precision/recall is still climbing.

## Shipping & versioning (deploy like the lists, only-on-changed)

The chosen model is published as a static artifact and synced to the extension
exactly like the blocklists:

- The model + a `model-meta.json` (version hash derived from content, format,
  size, category order, threshold defaults) are published to GitHub Pages
  alongside `lists/` (e.g. `model/`).
- The extension's existing periodic version check (`sync.js`) is extended to also
  check the model version. The model artifact is **fetched only when the version
  changes** (ETag-friendly, same throttle philosophy as
  `minDaysBetweenFullSync`). Unchanged = a cheap `model-meta.json` check, no
  download.
- Model artifacts are larger than list deltas, so only-on-changed matters more
  for the GitHub Pages 100 GB/month soft cap. Version derives from content so an
  unchanged retrain doesn't trigger a fleet re-download.
- A managed-policy switch enables/disables the classifier and sets the threshold,
  so districts opt in and tune aggressiveness without forking.

## Open-sourcing — model yes, raw dataset NO (legal sharp edge)

Requirement: open-source the model and dataset. One real constraint:

- **The trained model weights** can be released (project artifact; standard
  practice, doesn't redistribute third-party content). License alongside the
  code (MIT for code).
- **The raw scraped dataset CANNOT be redistributed.** A corpus of scraped page
  text from millions of third-party sites is a redistribution of *their*
  copyrighted content (and, for adult, content we should not host at all). That
  is a copyright/liability problem regardless of the blocklists' CC-BY-SA terms.
- **What we open-source instead** (the standard "release URLs, not content"
  approach used by large web datasets):
  - `classifier/corpus/`: the **domain + label lists** and the **scraper**, so
    anyone can reproduce the dataset themselves.
  - Optionally, **non-reversible derived features** (e.g. hashed n-gram vectors
    or pooled embeddings) that do not reconstitute the original page content.
  - The full training/eval code and the eval harness.

This delivers "open and reproducible" without hosting other people's content.
Call it out explicitly in `classifier/README.md`.

## Privacy / FERPA

- Inference is **fully on-device**; page content is read in memory and **never
  logged or transmitted**. Only the existing block record (domain, category,
  confidence, timestamp) is stored, consistent with the current posture
  ("blocked attempts only, nothing leaves the device").
- The extension still makes exactly one kind of network request beyond list
  sync: fetching its own model artifact (static, like the lists).

## Testing & verification

- **Offline:** the eval harness *is* the test — per-class precision/recall, the
  `clean` FP-rate, size, and latency table, plus learning curves, on a held-out
  eTLD+1 split. A small fixture-based self-test (in the repo's `assert(cond,msg)`
  style) covers the deterministic pieces: feature extraction, dedup, the split
  being leak-free (no eTLD+1 in both train and test), and the JS-inference parity
  (JS path produces the same scores as the Python path for sample inputs).
- **On-device:** load-unpacked manual check that the content script extracts the
  expected record, the classifier runs async without janking the page, a known
  unlisted test site of each category gets pinned+blocked, and a basket of known
  legitimate/edu sites does **not** (the FP check that matters).

## Phased rollout

1. **POC** (this first): `games`, `gambling`, `proxy-bypass` + `clean`,
   ~5k/class (scrape ~10–15k raw each). Build scrape → filter/dedup → split,
   train candidate #1 (hashing + linear), run the eval harness, read the
   precision / FP / latency table. **Go/no-go decision from real numbers**
   before committing to the full crawl.
2. **Full dataset + bake-off:** all seven content categories + `clean` at target
   volume; run all candidates; pick the winner by the decision rule.
3. **On-device integration:** content-script extractor + JS inference + the
   async-after-hydrate hook + domain pinning + the block-page reason.
4. **Shipping:** model artifact + `model-meta.json` + extend `sync.js` for
   only-on-changed model sync + the managed-policy enable/threshold switch.
5. **Open-source release:** corpus (domains+labels+scraper), training/eval code,
   model weights, README with the data-licensing explanation.

## Risks / open questions

- **Does a tiny model beat the lists on the long tail at acceptable on-device
  cost?** Unknown until the POC table exists — this is the whole point of doing
  the POC first.
- **FP-rate on legitimate sites** is the make-or-break metric; the `clean`-class
  diversity and threshold default are the levers.
- **Multilingual skew:** UT1 is French/EU-heavy while fleet traffic is largely
  English. Decide per-bake-off whether to filter to English or keep multilingual
  (favors the multilingual static-embedding candidate).
- **SPA settle timing:** classifying too early yields an empty shell. The
  `DOMContentLoaded` + idle/settle delay needs tuning on real pages.
- **Latency budget on bottom-tier hardware** must be measured, not assumed; it
  may eliminate the transformer candidate outright.
