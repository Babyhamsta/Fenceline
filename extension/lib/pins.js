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
  "gitcdn.xyz"
]);

export function isNoPinHost(host, noPinHosts = NO_PIN_HOSTS) {
  const h = host.toLowerCase();
  for (const d of noPinHosts) if (h === d || h.endsWith("." + d)) return true;
  return false;
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

// storage: a chrome.storage area ({ get(keys), set(obj) }). noPinHosts lets the
// caller inject a live set (baseline + district extras) once P2.2 lands; it
// defaults to the bundled NO_PIN_HOSTS.
export function createPinStore(storage, noPinHosts = NO_PIN_HOSTS) {
  let pinned = null; // Map<registrableDomain, {category, confidence}>

  async function load() {
    if (pinned) return pinned;
    const { modelPinned = {} } = await storage.get(["modelPinned"]);
    pinned = new Map(Object.entries(modelPinned));
    return pinned;
  }

  async function pin(domain, category, confidence) {
    if (isNoPinHost(domain, noPinHosts)) return; // block the page, but don't over-block the host
    const p = await load();
    if (p.has(domain)) return;
    p.set(domain, { category, confidence });
    capPins(p, PIN_CAP);
    await storage.set({ modelPinned: Object.fromEntries(p) });
  }

  function hit(hostname) {
    return pinned ? pinnedHit(hostname, pinned) : null;
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
