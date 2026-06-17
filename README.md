<div align="center">

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="extension/icons/fenceline-logo-dark.svg">
  <img alt="Fenceline" src="extension/icons/fenceline-logo.svg" width="460">
</picture>

<p><strong>Self-hosted, on-device CIPA web filtering for managed Chrome.</strong></p>
<p>No subscription &middot; no server to run &middot; no per-request API calls &middot; no backhaul.<br>
The filter lives on the device and enforces on every network — school, home, hotspot, or offline.</p>

<p>
  <a href="LICENSE"><img alt="License: MIT" src="https://img.shields.io/badge/license-MIT-B6452C?style=flat-square"></a>
  <img alt="Manifest V3" src="https://img.shields.io/badge/manifest-v3-20303A?style=flat-square">
  <img alt="Runs on managed Chrome" src="https://img.shields.io/badge/runs%20on-ChromeOS%20%C2%B7%20Win%20%C2%B7%20mac%20%C2%B7%20Linux-20303A?style=flat-square">
  <img alt="Inference 100% on-device" src="https://img.shields.io/badge/inference-100%25%20on--device-B6452C?style=flat-square">
</p>

</div>

---

Fenceline is a content filter you actually own. A GitHub Action compiles free
categorized blocklists into static files every couple of days; a Manifest V3
extension — force-installed through your admin console — syncs them and matches
every navigation **on the device**. Nothing is proxied, nothing is logged off-box, and
there is no recurring cost. It runs on managed Chromebooks (the strongest story —
Chrome *is* the device) and equally on managed Chrome for Windows, macOS, and
Linux via Chrome Browser Cloud Management or OS policy.

- **Blocklists** are compiled every two days by a GitHub Action from free
  categorized sources (UT1, HaGeZi, hosts-format lists, your own) and published
  as static files on GitHub Pages. "Updating the filter" = the Action committing
  new artifacts; forcing a change = editing `lists/block.txt` / `lists/allow.txt`
  and pushing.
- **The extension** is force-installed via managed policy on the student OU and
  matches every navigation on-device — ~6 µs per check at 2M domains in
  benchmarks. It polls a tiny version file every 12 hours (ETag/304, ~1 KB) and
  downloads the full list at most once every 7 days, so fleet bandwidth stays
  trivial.
- **Logging** records *blocked attempts only* — domain, category, timestamp,
  and which layer blocked it. No browsing history, nothing leaves the device.
  The report page shows lifetime counts by category/domain/day and exports
  CSV/JSON.
- **The block page** is plain HTML/CSS/JS — restyle it freely
  (`docs/CUSTOMIZING.md`), with district branding injectable via managed policy
  without forking.

## How it blocks — layered, all on-device

Each layer is cheaper and earlier than the one below it, so the common case never
reaches the expensive checks. Every block is attributed to the layer that caught
it, visible on the block page and in the report.

| Layer | Catches | How |
|---|---|---|
| **1 · Network rules** | the ~500k most-popular blocked domains | `declarativeNetRequest` blocks in the network stack *before the request leaves* — zero flash, enforced even while the service worker is asleep |
| **2 · Tail engine** | every other listed domain (millions) | the full list as a sorted array of u64 hashes, checked on `webNavigation.onBeforeNavigate` and redirected |
| **3 · Content model** | pages the lists miss — judged by what the page actually says | a tiny on-device text classifier (below) |
| **3b · Glyph-cipher guard** | pages that scramble their own text to blind the model | a statistical fingerprint of substitution-cipher fonts (below) |
| **4 · Proxy & evasion detection** | web-proxies / "unblockers" that tunnel past everything above | behavioural signals — not names (below) |

Tier 1 exists because `webNavigation` **cannot cancel** a navigation — it can only
observe and redirect after the fact. Putting the domains students actually hit
into network rules means the common case blocks atomically with no flash; the
tail catches the long tail and also resolves the category when a Tier-1 block
(`net::ERR_BLOCKED_BY_CLIENT`) fires. Subdomains of every listed domain are
blocked automatically in both tiers.

### The list pipeline

```mermaid
flowchart LR
    A["<b>GitHub Action</b> — every 2 days<br/><br/>compiler/compile.mjs<br/>pull UT1 · HaGeZi · …<br/>categorize · dedupe<br/>apply allow / block<br/>emit lists + model"]
    P["<b>GitHub Pages</b> — static, CDN<br/><br/>meta.json<br/>dnr/*.json<br/>tail.bin<br/>model.bin"]
    E["<b>Managed Chrome</b> — MV3, force-installed<br/><br/>Tier 1 · network rules<br/>Tier 2 · tail engine<br/>Tier 3 · content model"]
    A -->|publish| P
    P -->|"device sync<br/>12 h version check · full pull ≤ 7 days"| E
```

## The content model (Tier 3)

A **hybrid classifier** that reads a page *after* it loads and blocks it if it
confidently matches a filtered category (`adult`, `gambling`, `games`,
`proxy-bypass`) the lists missed. The lists stay primary; this is the async
backstop that generalises to sites nobody has listed yet. It pairs a fast text
model with a small tree model over the page's *structure*, because text alone
can't tell a page that **IS** a proxy from a page **ABOUT** proxies — same words,
same score. A Wikipedia "Proxy server" article and a working web proxy are
identical to a bag-of-words; what separates them is that the article never
instantiates a proxy's functional element (a URL box, an embedded-URL path).

**What it sees.** A content script (`extension/content/structural-features.js`,
the *one* extractor shared with the offline scraper so train/infer vectors are
identical by construction) derives a fixed numeric vector locally — nothing
leaves the device:

- **Text:** title, meta description, and the first few hundred words of visible
  body text (data URIs stripped, capped). Also reads in-page "browser" proxies
  that draw a real site into an `about:blank` document, which URL filtering can't
  see.
- **URL/host:** length, path depth, host/path entropy, digit ratio, cheap-TLD
  flag, embedded-URL-in-path, per-category keyword hits.
- **Structure:** tag histogram, DOM depth, link density, paragraph count,
  third-party-script ratio, iframe/canvas/video composition, payment/password
  fields, and the "is-vs-about" functional-element flags (a URL box, a dominant
  game canvas, a casino iframe, an age gate).
- **Resource fingerprints:** known adult-ad / gambling-affiliate / crypto-widget
  hosts, CGI-proxy software markers (Glype/CGIProxy/PHProxy), gambling license
  seals.

**How it scores (two stages, then a hybrid rule).**
1. **Text model** — words and char 3-/4-grams hashed with FNV-1a into 65,536
   signed buckets (the "hashing trick" — no vocabulary file, fixed memory), run
   through a 5-class multinomial logistic regression. ~1.3 MB, microseconds.
2. **Fusion model** — a gradient-boosted decision tree (`fusion.json`) over the
   5 text scores **plus** the ~60 structural/URL/fingerprint scalars. A tree
   natively models the conjunction text can't: *proxy words AND a URL box AND not
   prose ⇒ block; proxy words AND article structure ⇒ clean.*
3. **Hybrid decision** — the fusion model is the primary call (it learned
   is-vs-about, so it cleans articles the text model would block). The text model
   is a **high-recall backstop** for true positives the tree misses (a logged-out
   casino landing page, an atypical games portal) — but a structural **article
   guard** (`prose-rescue.js`: low link-density + real paragraphs + no functional
   element) suppresses the backstop on genuine articles, so the text model's
   vocabulary false-positives never leak through. Search-result pages are exempt
   upstream (a SERP is structurally a link hub and scores on whatever the student
   typed). Per-category thresholds tuned for ~1.5% clean false-positives.

**Why it's trustworthy.** The whole pipeline is parity-checked end to end:
the vectorizer and the **tree walk are byte-identical in Python (training) and
JavaScript (device)** — `export_fusion.py` asserts the exported trees reproduce
sklearn's `predict_proba` exactly, and `test_fusion_parity.mjs` asserts the JS
interpreter matches the Python reference, so the chain *sklearn ≡ Python ≡ JS*
holds and the eval numbers are exactly what runs on the Chromebook. Cost is a few
ms per page; assets (~1.3 MB text + ~3 MB tree) are pulled on version change with
a SHA-256 check, and a baseline ships inside the extension so a fresh install is
never unprotected. If the tree fails to load, `decide()` degrades to text-only.

**How it's built.** Trained on rendered text + structure from ~50k live sites
(blocklist domains for the filtered classes, Tranco for `clean`), split leak-free
by registrable domain. The decisive technique is **hard-negative mining**: pages
with a category's *vocabulary* but a clean page's *structure* — Wikipedia topic
articles, news, VPN/gambling coverage, sex-ed, interactive education — are mined
into the training set so the tree learns to lean on structure. Policy is
**block-by-category-aggressively, allowlist the exceptions**: VPN vendor/download
pages and game portals are blocked (they're bypass tools / games), with the
allowlist as the escape hatch. We publish the **scraper, training/eval/export
scripts, and the weights**; we do **not** publish the scraped pages (third-party
content). See [`classifier/README.md`](classifier/README.md) to reproduce.

## Proxy & evasion detection (Tiers 3b + 4)

Web-proxies ("unblockers") are the hard case: a student loads one site that
fetches and re-renders any other, slipping every domain list. They can rename
every file, shuffle every script name, and obfuscate every line — so Fenceline
keys on the **behaviour a proxy can't avoid**, never on names.

- **URL-in-path** — every web proxy loads its target by embedding the destination
  URL in its *own* path, percent-encoded (`/…/https%3A%2F%2F…`) or base64. Legit
  sites pass a URL as a query parameter, never as a path segment.
- **Bare wire-protocol** — most modern proxies tunnel through `x-bare-*` request
  headers; no legitimate site sends those.
- **App-as-image (SVG)** — some proxies ship their whole UI inside an
  `<svg><foreignObject>` served under an `.svg` extension on a public CDN.
  Fenceline blocks a top-level SVG that smuggles an *executable* HTML app, while
  leaving real vector art and diagram exports (which carry no script) alone.
- **Glyph-cipher fonts** — the toughest: a page renders its text through a
  substitution-cipher font, so it *looks* normal but the DOM text is gibberish the
  model can't read. Fenceline catches it by the statistical fingerprint — a long
  page drawn from a tiny fixed alphabet, which real language never is — regardless
  of the script, the declared language, or the font's name.

These detections **block the page, not the origin**. A blocked site reached *via*
a shared service (web.archive.org, Google Translate, a public CDN) is blocked on
that visit without permanently pinning the service, so legitimate use of those
hosts keeps working.

## Repo layout

```
extension/          the MV3 extension (load unpacked to dev-test)
  lib/hash.js       FNV-1a 64 + binary search — shared with the compiler
  lib/model.js      on-device classifier (mirrors classifier/infer.mjs)
  lib/detect/       behaviour-based evasion detectors (proxy-url, glyph-cipher, svg-app)
  lib/pins.js       block-but-never-pin store + no-pin host set
  content/          content scan + evasion guards
  block/            customizable block page
  report/           on-device report: stats, exports, force-sync
  policy/           managed-storage schema + example admin policy
  model/            bundled baseline model.bin + model-meta.json
compiler/           list compiler + sources.json (categories, tier sizing)
  no-pin-hosts.txt  synced block-but-never-pin baseline
classifier/         scraper, training/eval, model export (Python + JS parity)
tools/              build-time helpers (render-icons.py: SVG → manifest PNGs, needs Pillow)
lists/              allow.txt / block.txt district overrides
.github/workflows/  build + publish to gh-pages (every 2 days)
test/               selftest.mjs (engine e2e), detect.mjs (evasion detectors), popup.mjs
docs/               DEPLOYMENT.md (admin console, hardening), CUSTOMIZING.md
```

## Quick start

```bash
node test/selftest.mjs        # sanity-check the toolchain
node compiler/compile.mjs     # full build into dist/ (downloads upstream lists)
```

Then follow `docs/DEPLOYMENT.md`: enable Pages, run the Action, publish the
extension (Web Store unlisted), force-install on the student OU with the managed
policy, and work the hardening checklist — **the checklist is most of the real
security**; the extension can't compensate for an enabled guest mode or a Linux
container.

## Admin controls (managed policy, students can't touch)

`listBaseUrl`, sync intervals, `allowDomains` / `extraBlockDomains` overrides,
the content model on/off and threshold, block-page branding, and whether the
report page's Clear/Export buttons function. See
`extension/policy/example_admin_policy.json`.

## Privacy / FERPA posture

Only blocked attempts are logged, on-device, capped (5k distinct domains, 2k
recent events, 400 days of daily counts). There is no telemetry, no remote
logging, and the extension makes exactly two kinds of network request: fetching
its own list artifacts and its own model file. The content model runs entirely
on-device — page text is never sent anywhere.

## Known limits and caveats (read before trusting your fleet to it)

- **It filters Chrome, not the machine.** Guest mode, other browsers, and other
  devices are out of scope — that's admin-console policy (see the hardening
  checklist) and your network-edge filter. On a managed Chromebook this gap
  closes (Chrome is the device); on Windows/macOS, pair it with device policy
  that blocks other browsers.
- **Tier 2 flash:** a long-tail block redirects after navigation starts; on a
  slow device, blocked content can render briefly. Popular domains live in Tier 1
  specifically to avoid this where it matters most.
- **The content model is a backstop, not an oracle.** It blocks confident matches
  only (0.90 threshold) to keep false positives low, which means it will miss
  borderline pages. It catches what the lists don't; it doesn't replace them.
- **Glyph-cipher edge:** a cipher mapping into a *small* alphabet (e.g. Cyrillic)
  on a page that also spoofs its language tag is the one residual gap — defeating
  it needs font-coverage inspection, which Fenceline doesn't yet do.
- **CIPA scope:** student-OU filtering alone doesn't complete CIPA/E-Rate
  certification (staff filtering, monitoring, and a board-adopted Internet Safety
  Policy are also required).
- **Log loss window:** stats writes are debounced; if Chrome kills the service
  worker in that window, the last event can be lost. Counts are operational
  telemetry, not forensic evidence.

## Blocklist sources & credits

Fenceline compiles only free, publicly maintained domain lists, fetched fresh at
build time so coverage tracks upstream automatically. Huge thanks to the
maintainers below — please review and honor each project's license before
redistributing (UT1 and its mirrors are **CC BY-SA**, which requires attribution
and share-alike). The authoritative list lives in
[`compiler/sources.json`](compiler/sources.json).

| Project | Feeds these categories | License |
|---|---|---|
| [UT1 — Université Toulouse 1 Capitole](https://dsi.ut-capitole.fr/blacklists/) (Fabrice Prigent) | adult, gambling, drugs, hate-violence, malware-phishing, proxy-bypass, social, games | CC BY-SA |
| [HaGeZi DNS Blocklists](https://github.com/hagezi/dns-blocklists) | adult (NSFW), gambling, malware-phishing (TIF), proxy-bypass (DoH/VPN) | see repo |
| [StevenBlack/hosts](https://github.com/StevenBlack/hosts) | adult (porn extensions), gambling | MIT |
| [Sinfonietta/hostfiles](https://github.com/Sinfonietta/hostfiles) | hate-violence | MIT |
| [arkynx/blocklists](https://github.com/arkynx/blocklists) | gambling | see repo |
| [olbat/ut1-blacklists](https://github.com/olbat/ut1-blacklists) | drugs, games (daily UT1 mirror) | CC BY-SA |
| [nickoppen/pihole-blocklists](https://github.com/nickoppen/pihole-blocklists) | social (TikTok, Snapchat, Reddit, Discord, Telegram, Meta), proxy-bypass (VPN), games (Roblox, Steam, Epic, Minecraft, Nintendo) | see repo |
| [Mafraysse/AdGuard_GameList-Filter](https://github.com/Mafraysse/AdGuard_GameList-Filter) | games (browser-game portals) | see repo |
| [oisd](https://oisd.nl) ([sjhgvr/oisd](https://github.com/sjhgvr/oisd)) | adult (NSFW) | see repo |
| [4skinSkywalker/Anti-Porn-HOSTS-File](https://github.com/4skinSkywalker/Anti-Porn-HOSTS-File) | adult | see repo |
| [dibdot/DoH-IP-blocklists](https://github.com/dibdot/DoH-IP-blocklists) | proxy-bypass (DoH servers) | see repo |

UT1 and HaGeZi refresh daily; the build Action re-pulls every 2 days, so the
fleet's filter stays current with no manual list maintenance.

## License

Fenceline's own code is MIT — see [LICENSE](LICENSE). Upstream blocklists carry
their own licenses; see **Blocklist sources & credits** above and review the
terms of any source you add to `compiler/sources.json`.
