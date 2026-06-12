# Deploying Fenceline

## 1. Fork and publish lists

1. Fork this repo.
2. Edit `compiler/sources.json` if you want different upstream lists or categories
   (max 254 categories; `custom` is reserved for `lists/block.txt`).
3. Add district overrides to `lists/allow.txt` / `lists/block.txt`.
4. Repo **Settings → Pages** → Source: `Deploy from a branch` → branch `gh-pages`, folder `/ (root)`.
5. **Actions** tab → run **Build filter lists** manually once. It compiles and pushes
   artifacts to `gh-pages/lists/`. After Pages deploys, verify:
   `https://YOUR-ORG.github.io/fenceline/lists/meta.json`
6. The workflow then runs every 2 days. It only publishes when list content actually changed
   (version is a content hash), and devices only download the full artifacts when the
   version changes **and** their `minDaysBetweenFullSync` throttle allows it.

**Update cadences (how fast a change reaches a device):**

| Channel | Cadence | Use it for |
|---|---|---|
| List rebuild (Action) | every 48 h (cron), or run manually | upstream list churn |
| Device version check (`meta.json`, ~1 KB, ETag) | every `checkIntervalHours` (12 h) | noticing a new version |
| Device full artifact download | only when version changed AND ≥ `minDaysBetweenFullSync` (7 days) since last full sync; **first install bypasses the throttle** | bulk list updates |
| Managed policy `extraBlockDomains` / `allowDomains` | minutes (Google pushes policy) | **emergencies** |

The consequence to understand: an edit to `lists/block.txt` can take up to ~7 days
to reach a device that synced yesterday. That's by design (bandwidth), and it's why
urgent district blocks go through the **managed policy `extraBlockDomains`**, which
applies its own DNR rules within minutes, independent of the list pipeline. Push it
in Admin console, then add it to `lists/block.txt` for permanence.

**Bandwidth math** (GitHub Pages soft cap: 100 GB/month): at UT1-full scale the
artifacts are roughly 35–45 MB. 300 devices × weekly full sync ≈ 50 GB/month. If you
grow the fleet or shorten the sync interval, front the repo with a CDN (below) or
shorten the list.

**Hotlinking / other people pulling your lists:** GitHub Pages is public static
hosting — no auth, no referrer control, and free-tier Pages requires a public repo
anyway. You can't stop third parties from pointing their own deployments at your
URL; the only real cost they impose is your bandwidth quota (GitHub's response to
exceeding the soft cap is an email, not a cutoff). If it ever becomes a real
problem: put a domain you own in front via free Cloudflare (CNAME to
`YOUR-ORG.github.io`, cache-everything rule on `/lists/*`). Hotlinkers then hit
Cloudflare's cache instead of your Pages quota, and you get rate-limiting/WAF
controls and the ability to change the URL out from under freeloaders (your fleet
follows via the `listBaseUrl` policy; theirs breaks). Don't bother with obscure
paths — the publish workflow is in a public repo, so the path is discoverable.

## 2. Set your list URL in the extension

Either set `listBaseUrl` in the managed policy (recommended — one extension build
works for every district), or edit the default in `extension/lib/config.js`.

## 3. Publish the extension

**Recommended: Chrome Web Store, unlisted.** One-time $5 developer fee, painless
updates, no CRX signing to maintain.

1. Zip the `extension/` directory contents (manifest at zip root).
2. [Chrome Web Store developer dashboard](https://chrome.google.com/webstore/devconsole)
   → New item → upload → visibility **Unlisted** → submit for review.
3. Note the extension ID after publication.

**Alternative: self-hosted CRX.** Pack with a persistent key
(`chrome --pack-extension`), host the `.crx` and an update-manifest XML on your
Pages site, and use the `id;update_url` form when force-installing. You own
version bumps and key custody forever. Only do this if Web Store review becomes
a problem.

## 4. Force-install via Google Admin

Admin console → **Devices → Chrome → Apps & extensions → Users & browsers** →
select the **student OU** →

1. Add the extension by ID (Web Store) or ID + update URL (self-hosted).
2. Installation policy: **Force install** (users cannot remove or disable it).
3. Click the extension → **Policy for extensions** → paste the contents of
   `extension/policy/example_admin_policy.json`, edited for your district.
   This is the admin control channel: list URL, allow/deny overrides, block-page
   branding, and whether the report page's Clear/Export buttons work. Students
   cannot read or modify managed policy.

**`extraNoPinHosts`** extends the block-the-page-never-pin-the-origin baseline.
Fenceline ships a synced baseline of shared/path-multitenant hosts (Google Sites,
archive.org, public CDNs…) that are blocked per harmful page but never *pinned*,
so a single bad page can't over-block the whole service for everyone. Add your
own shared hosts here — e.g. an internal archive or CDN your district runs — when
a blocked page on them should not take the origin down. It never allowlists a
host; use `allowDomains` for that.

## 5. Hardening checklist (this is most of the actual security)

The extension only filters Chrome on the profile it's installed in. Close the
side doors in the same OU policy:

- [ ] **Incognito mode**: Disallow (extension state/logging isn't guaranteed there).
- [ ] **Guest mode**: Disable (guest sessions have no forced extensions).
- [ ] **Sign-in restriction**: only `@yourdistrict.org` accounts on devices.
- [ ] **Linux development environment (Crostini)**: Disable for students
      (a Linux browser bypasses everything).
- [ ] **Developer tools**: set *Never allow use of built-in developer tools*
      (blocks inspecting/poking the extension; also the default for
      force-installed extensions).
- [ ] **chrome://flags**: block via URLBlocklist (`chrome://flags`).
- [ ] **Task manager ending processes**: ChromeOS policy
      *Do not allow users to end processes* (prevents killing the SW —
      note Tier 1 DNR rules keep blocking even if the SW is killed).
- [ ] Consider DNS-level backstop on the school LAN (e.g., FortiGate DNS filter)
      for defense in depth on-network; Fenceline covers roaming.

## 6. Verify on a test device

1. Sign in with a student-OU test account; confirm the extension appears and
   cannot be removed.
2. `chrome://extensions` → Fenceline → it should show "Installed by your administrator".
3. Wait ~2 minutes for the first sync (or open the report page — *Details →
   Extension options* — and hit **Check for list update now**).
4. Visit a known-blocked domain: you should get the block page with the domain
   and category filled in.
5. Report page should show the block under Recent blocks and in the category bars.

## CIPA note

Fenceline is a technology protection measure for the student fleet, but CIPA/E-Rate
certification also requires: filtering on *staff* devices (with an
authorized-adult disable provision), monitoring of minors' online activities, and a
board-adopted Internet Safety Policy with a public hearing on record. Scope your
compliance story accordingly.
