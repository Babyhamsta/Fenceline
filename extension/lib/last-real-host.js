// Per-tab "last real http(s) host", used to attribute about:blank in-page-proxy
// content blocks: an in-page "browser" proxy renders the proxied page into an
// about:blank top document (no hostname), so a block from there is attributed to
// the host that served the proxy (e.g. cherrion.top) — which is then pinned.
//
// MV3 suspends idle service workers (~30 s) and SW globals are lost, so the Map
// is mirrored into chrome.storage.session (survives SW restarts, dies with the
// browser session, never hits disk — consistent with the privacy posture). The
// Map is a write-through cache: hydrate lazily before any read, persist debounced
// on every change.
//
// CRUCIAL invariant: every mutating op hydrates FIRST. A bare delete-then-persist
// without hydration would, on a cold-start event (e.g. a tab close that wakes a
// suspended SW with an empty Map), write {} over the stored state and wipe all
// attribution — the exact failure this persistence exists to prevent. Keeping
// hydrate inside set/remove makes that unrepresentable at any call site.
//
// storage: a chrome.storage area ({ get(keys), set(obj) }), injected for tests.
// schedule: timer fn (defaults to setTimeout), injectable so tests drive persist.
export function createLastRealHostStore(storage, { debounceMs = 500, schedule = setTimeout } = {}) {
  const map = new Map(); // tabId -> hostname
  let hydrated = null;
  let timer = null;

  function hydrate() {
    if (!hydrated) {
      hydrated = storage
        .get("lastRealHost")
        .then(({ lastRealHost: stored }) => {
          if (stored) {
            for (const [k, v] of Object.entries(stored)) {
              const tid = Number(k);
              if (!map.has(tid)) map.set(tid, v); // a live update beats the stored value
            }
          }
        })
        .catch(() => {});
    }
    return hydrated;
  }

  function persistSoon() {
    if (timer) return; // debounce: coalesce bursts of events into one write
    timer = schedule(() => {
      timer = null;
      storage.set({ lastRealHost: Object.fromEntries(map) }).catch(() => {});
    }, debounceMs);
  }

  async function set(tabId, hostname) {
    await hydrate();
    map.set(tabId, hostname);
    persistSoon();
  }

  async function remove(tabId) {
    await hydrate(); // never persist an un-hydrated (possibly empty) Map over the store
    map.delete(tabId);
    persistSoon();
  }

  return {
    hydrate,
    set,
    remove,
    get: (tabId) => map.get(tabId),
    entries: () => map.entries()
  };
}
