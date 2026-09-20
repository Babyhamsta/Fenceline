// Pin store: domains the model/proxy tiers have blocked before are pinned
// locally so a re-visit is blocked at navigation time (no second-load flash, no
// re-scan). The store wraps a chrome.storage area, injected so the logic is
// testable in plain Node with a fake.

export const PIN_CAP = 2000;

// Hosts that render MANY independent sites' content under one origin
// (path-multitenant). We still block the specific harmful page (content scan
// re-runs every visit), but never PIN the bare host — pinning would over-block
// the whole service: pinning sites.google.com kills all Google Sites; pinning
// web.archive.org kills the Wayback Machine for legit research. A blocked game
// reached *via* archive.org/translate is still blocked on that visit; the
// origin stays usable. Suffix-matched, so subdomains are covered.
export const NO_PIN_HOSTS = new Set([
  // Google path-multitenant hosts.
  "sites.google.com",
  "script.google.com",
  "storage.googleapis.com",
  "docs.google.com",
  "drive.google.com",
  "translate.google.com",
  "webcache.googleusercontent.com",
  "groups.google.com",
  // Archival / cache / reader services — they serve other sites' content.
  "archive.org",
  "archive.ph",
  "archive.today",
  "archive.is",
  "archive.li",
  "archive.vn",
  "archive.fo",
  "cachedview.nl",
  "r.jina.ai",
  "12ft.io",
  // Public code CDNs — anyone can host a file/app here.
  "jsdelivr.net",
  "githack.com",
  "statically.io",
  "raw.githubusercontent.com",
  "gitcdn.link",
  "gitcdn.xyz",
  // App / deploy / sandbox hosts: each tenant renders its OWN site (often with a
  // real functional element — a hosted proxy's URL box, a hosted game's canvas),
  // so the structural pin-gate alone wouldn't save the shared origin. Pinning the
  // apex would blanket thousands of unrelated tenants.
  "github.io",
  "gitlab.io",
  "pages.dev",
  "workers.dev",
  "vercel.app",
  "netlify.app",
  "web.app",
  "firebaseapp.com",
  "herokuapp.com",
  "glitch.me",
  "repl.co",
  "replit.app",
  "replit.dev",
  "codepen.io",
  "codesandbox.io",
  "stackblitz.com",
  "jsfiddle.net",
  "surge.sh",
  "onrender.com",
  "pythonanywhere.com",
  "itch.io",
  "neocities.org",
  // Code / repo hosts — one repo is not the whole forge.
  "github.com",
  "gitlab.com",
  "bitbucket.org",
  "sourceforge.net",
  "codeberg.org",
  "huggingface.co",
  // User-content forums / Q&A / blogs — one thread/post/answer is not the site.
  // (The structural pin-gate already spares most of these, since a discussion
  // page has no functional element; listed too as defence-in-depth.)
  "quora.com",
  "reddit.com",
  "news.ycombinator.com",
  "stackoverflow.com",
  "stackexchange.com",
  "superuser.com",
  "serverfault.com",
  "askubuntu.com",
  "medium.com",
  "substack.com",
  "wordpress.com",
  "blogspot.com",
  "tumblr.com",
  "dev.to",
  "pastebin.com"
]);

export function isNoPinHost(host, noPinHosts = NO_PIN_HOSTS) {
  const h = host.toLowerCase();
  for (const d of noPinHosts) if (h === d || h.endsWith("." + d)) return true;
  return false;
}

// Should a content-model block PIN its host (escalate to a whole-origin block on
// every later visit), or just block this one page? Pin only when the page
// structurally IS an instance of the category — it carries the category's
// FUNCTIONAL ELEMENT (a proxy's URL box / embedded-URL path, a casino's bet
// iframe / license seal / payment field, an adult video player / age gate, a
// game's dominant canvas). A page that merely DISCUSSES the topic — a forum
// thread, a blog, a news article, a Q&A "how do I bypass the school proxy" — has
// the vocabulary but not the element. Blocking that page this visit is fine;
// pinning its host is NOT, or one false positive blankets an entire site
// (Quora, Reddit, Medium, a teacher's Google Site). This is the site-agnostic
// guard: it works on any host without an enumerated list.
//
// Mirrors classifier/fp_audit.py:has_functional_element so the device's pin
// decision matches the offline routing that curates the training data. A missing
// structural field reads falsy -> not pin-worthy (fail safe: under-pin, never
// blanket on a partial signal).
export function pinWorthy(category, s) {
  s = s || {};
  const paras = Number(s.paragraph_count) || 0;
  switch (category) {
    case "proxy-bypass":
      // url_embeds_url / a proxy marker is proxy-specific. A bare URL-like input
      // also fires on any site's SEARCH box, so only count it on a thin page — a
      // real proxy is a tool (few paragraphs), a discussion of one is not.
      return !!(
        s.url_embeds_url ||
        Number(s.fp_proxy_marker_count) > 0 ||
        (s.has_url_like_input && paras < 5)
      );
    case "adult":
      return !!(s.has_video_player || s.has_age_gate);
    case "gambling":
      return !!(s.has_large_xorigin_iframe || s.has_gambling_license_seal || s.has_payment_field);
    case "games":
      return !!s.has_dominant_canvas;
    default:
      return false;
  }
}

// Effective no-pin set = synced baseline (or the bundled NO_PIN_HOSTS fallback
// when nothing has synced yet) ∪ district extras (extraNoPinHosts policy key).
// Block-the-page-never-pin semantics only — this never allows a host.
export function buildNoPinHosts(syncedBaseline, extras = []) {
  const base =
    Array.isArray(syncedBaseline) && syncedBaseline.length ? syncedBaseline : NO_PIN_HOSTS;
  const out = new Set();
  for (const h of base) out.add(String(h).toLowerCase());
  for (const h of extras) {
    const v = String(h).toLowerCase().trim();
    if (v) out.add(v);
  }
  return out;
}

export function pinnedHit(hostname, p) {
  const parts = hostname.toLowerCase().split(".");
  for (let i = 0; i < parts.length - 1; i++) {
    const cand = parts.slice(i).join(".");
    if (p.has(cand)) return cand;
  }
  return null;
}

// FIFO eviction in insertion order — keeps the in-memory Map at or below the
// cap so it can't grow unbounded across writes.
export function capPins(p, cap = PIN_CAP) {
  while (p.size > cap) p.delete(p.keys().next().value);
}

// storage: a chrome.storage area ({ get(keys), set(obj) }). getNoPinHosts is a
// sync getter returning the live effective set (synced baseline + district
// extras), re-evaluated on each pin so a freshly-synced list or policy change
// takes effect without rebuilding the store; it defaults to the bundled set.
export function createPinStore(storage, getNoPinHosts = () => NO_PIN_HOSTS) {
  let pinned = null; // Map<registrableDomain, {category, confidence}>
  let loading = null;
  let writes = Promise.resolve();

  async function load() {
    if (pinned) return pinned;
    if (!loading) {
      loading = storage
        .get(["modelPinned"])
        .then(({ modelPinned = {} }) => {
          pinned = new Map(Object.entries(modelPinned));
          return pinned;
        })
        .finally(() => {
          loading = null;
        });
    }
    return loading;
  }

  async function pin(domain, category, confidence) {
    if (isNoPinHost(domain, getNoPinHosts())) return; // block the page, but don't over-block the host
    const p = await load();
    if (isNoPinHost(domain, getNoPinHosts())) return;
    if (p.has(domain)) return;
    p.set(domain, { category, confidence });
    capPins(p, PIN_CAP);
    const snapshot = Object.fromEntries(p);
    const write = writes.then(() => storage.set({ modelPinned: snapshot }));
    writes = write.catch(() => {});
    await write;
  }

  function hit(hostname) {
    if (!pinned || isNoPinHost(hostname, getNoPinHosts())) return null;
    const domain = pinnedHit(hostname, pinned);
    return domain && !isNoPinHost(domain, getNoPinHosts()) ? domain : null;
  }

  return {
    load,
    pin,
    hit,
    get(domain) {
      return pinned ? pinned.get(domain) : undefined;
    }
  };
}
