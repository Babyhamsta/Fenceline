# Fenceline

Free, self-managed, roaming CIPA content filtering for Google-managed
Chromebooks. No subscription, no server to run, no per-request API calls, no
backhaul. The filter lives on the device and enforces on every network —
school, home, hotspot, or offline-cached pages.

- **Blocklists** are compiled daily by a GitHub Action from free categorized
  sources (UT1, hosts-format lists, your own) and published as static files on
  GitHub Pages. "Updating the filter" = the Action committing new artifacts;
  forcing a change = editing `lists/block.txt` / `lists/allow.txt` and pushing.
- **The extension** is force-installed via Google Admin on the student OU,
  syncs the list on an ETag-friendly version check, and matches every
  navigation **on-device**. Zero added page latency (~6 µs per navigation
  check at 2M domains in benchmarks).
- **Logging** records *blocked attempts only* — domain, category, timestamp.
  No browsing history, nothing leaves the device. The report page shows
  lifetime block counts by category/domain/day and exports CSV/JSON.
- **The block page** is plain HTML/CSS/JS — restyle it freely
  (see `docs/CUSTOMIZING.md`), with district branding injectable via managed
  policy without forking.

## Architecture

```
GitHub Action (daily)                         Chromebook
┌─────────────────────────┐   GitHub Pages   ┌──────────────────────────────┐
│ compiler/compile.mjs    │   (static, CDN)  │ MV3 extension (force-install)│
│  pull UT1 / hosts lists ├──► meta.json ────► version check (12h, ~1 KB)   │
│  categorize + dedupe    │    dnr/NNN.json ─► Tier 1: DNR block rules      │
│  apply allow/block.txt  │    tail.bin ─────► Tier 2: sorted u64 hash array│
│  emit artifacts         │    cats.bin ─────►         + category bytes     │
└─────────────────────────┘                  └──────────────────────────────┘
```

**Two-tier matching, both fully on-device:**

| | Tier 1 — declarativeNetRequest | Tier 2 — tail engine |
|---|---|---|
| Coverage | ~500k most-popular blocked domains (Tranco-ranked) | **all** domains (millions) |
| Where it blocks | network stack, before the request leaves | `webNavigation.onBeforeNavigate` |
| Content flash | none — request never happens | possible sub-second flash before redirect |
| Works while service worker asleep | yes | wakes the worker first |
| Memory | Chrome's rule matcher | ~9 MB per 1M domains (8B hash + 1B category) |

Tier 1 exists because `webNavigation` **cannot cancel** a navigation — it can
only observe and redirect after the fact. By putting the domains students
actually hit into DNR rules, the common case blocks atomically with no flash;
the tail catches the long tail. The tail is a superset of Tier 1 and also
resolves the category when a DNR block (`net::ERR_BLOCKED_BY_CLIENT`) fires.

Subdomains of every listed domain are blocked automatically, in both tiers.

## Repo layout

```
extension/          the MV3 extension (load unpacked to dev-test)
  lib/hash.js       FNV-1a 64 + binary search — shared with the compiler
  block/            customizable block page
  report/           on-device report: stats, exports, force-sync
  policy/           managed-storage schema + example Google Admin policy
compiler/           list compiler + sources.json (categories, tier sizing)
lists/              allow.txt / block.txt district overrides
.github/workflows/  daily build + publish to gh-pages
test/selftest.mjs   end-to-end: compile fixtures, run the real engine logic
docs/               DEPLOYMENT.md (Admin console, hardening), CUSTOMIZING.md
```

## Quick start

```bash
node test/selftest.mjs        # sanity-check the toolchain
node compiler/compile.mjs     # full build into dist/ (downloads upstream lists)
```

Then follow `docs/DEPLOYMENT.md`: enable Pages, run the Action, publish the
extension (Web Store unlisted), force-install on the student OU with the
managed policy, and work the hardening checklist — **the checklist is most of
the real security**; the extension can't compensate for an enabled guest mode
or Linux container.

## Admin controls (managed policy, students can't touch)

`listBaseUrl`, sync intervals, `allowDomains` / `extraBlockDomains` overrides,
block-page branding, and whether the report page's Clear/Export buttons
function. See `extension/policy/example_admin_policy.json`.

## Privacy / FERPA posture

Only blocked attempts are logged, on-device, capped (5k distinct domains,
2k recent events, 400 days of daily counts). There is no telemetry, no remote
logging, and the extension makes exactly one kind of network request: fetching
its own list artifacts.

## Known limits and caveats (read before trusting your fleet to it)

- **Tier 2 flash:** a long-tail block redirects after navigation starts; on a
  slow device, blocked content can render briefly. Popular domains live in
  Tier 1 specifically to avoid this where it matters most.
- **Per-rule size limit (unverified):** Chrome documents a ~2 KB compiled-size
  limit in the context of regex rules; whether it applies to large
  `requestDomains` arrays is not clearly documented. The compiler packs rules
  to an 1,800-byte serialized budget to stay safe either way. Validate on real
  hardware before fleet rollout.
- **Dynamic-rule apply time (unverified):** applying ~8–28k dynamic rules on
  first sync hasn't been benchmarked on low-end Chromebooks. It happens in the
  background and only when chunks change (differential by chunk hash), but
  measure your first-boot experience.
- **It filters Chrome.** Guest mode, other browsers (Crostini), and other
  devices are out of scope — that's Admin-console policy (see the hardening
  checklist) and your network-edge filter.
- **CIPA scope:** student-OU filtering alone doesn't complete CIPA/E-Rate
  certification (staff filtering, monitoring, and a board-adopted Internet
  Safety Policy are also required).
- **Log loss window:** stats writes are debounced 250 ms; if Chrome kills the
  service worker in that window, the last event can be lost. Counts are
  operational telemetry, not forensic evidence.

## License

MIT. Upstream blocklists carry their own licenses — UT1 (Université Toulouse
Capitole) is CC BY-SA; review the terms of any source you add to
`compiler/sources.json`.
