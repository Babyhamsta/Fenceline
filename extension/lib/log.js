// Logging: BLOCKED navigations only. No browsing history is recorded.
// Stored per-device in chrome.storage.local:
//   stats.total                lifetime block count
//   stats.byCategory[cat]      lifetime count per category
//   stats.bySource[source]     lifetime count per block source (list/model/…)
//   stats.byDomain[domain]     lifetime count per domain (capped)
//   stats.byDay[YYYY-MM-DD]    { category: count } per day
//   events                     ring buffer of recent blocks [{t, d, c, s}]
//
// Students can't tamper with this on a managed device: extension storage
// is only writable by the extension, DevTools on force-installed
// extensions is policy-disabled, and the report page's Clear button is
// gated behind the managed allowClearLogs policy.

const DOMAIN_CAP = 5000; // max distinct domains tracked; overflow -> "(other)"
const EVENT_CAP = 2000; // recent events kept
const DAY_CAP = 400; // days of byDay history kept

let pending = null;
let flushTimer = null;
let loading = null;
let generation = 0;
let writes = Promise.resolve();
let clearing = null;

async function load() {
  if (clearing) await clearing;
  if (pending) return pending;
  if (!loading) {
    const current = generation;
    loading = chrome.storage.local
      .get(["stats", "events"])
      .then((st) => {
        if (current !== generation) return null;
        const stats = st.stats || { total: 0, byCategory: {}, byDomain: {}, byDay: {} };
        if (!stats.bySource) stats.bySource = {}; // back-fill for pre-Tier-3 stores
        pending = { stats, events: st.events || [] };
        return pending;
      })
      .finally(() => {
        if (current === generation) loading = null;
      });
  }
  return loading;
}

function scheduleFlush() {
  if (flushTimer) return;
  flushTimer = setTimeout(() => {
    flushTimer = null;
    flushNow().catch((e) => console.warn("[fenceline] log flush failed", e));
  }, 250); // short: MV3 SWs can be suspended; keep the loss window tiny
}

export async function recordBlock(domain, category, source = "list") {
  const data = await load();
  if (!data || data !== pending) return;
  const s = data.stats;

  s.total++;
  s.byCategory[category] = (s.byCategory[category] || 0) + 1;
  s.bySource[source] = (s.bySource[source] || 0) + 1;

  if (s.byDomain[domain] !== undefined || Object.keys(s.byDomain).length < DOMAIN_CAP) {
    s.byDomain[domain] = (s.byDomain[domain] || 0) + 1;
  } else {
    s.byDomain["(other)"] = (s.byDomain["(other)"] || 0) + 1;
  }

  const day = new Date().toISOString().slice(0, 10);
  if (!s.byDay[day]) {
    s.byDay[day] = {};
    const days = Object.keys(s.byDay).sort();
    while (days.length > DAY_CAP) delete s.byDay[days.shift()];
  }
  s.byDay[day][category] = (s.byDay[day][category] || 0) + 1;

  data.events.push({ t: Date.now(), d: domain, c: category, s: source });
  if (data.events.length > EVENT_CAP) data.events.splice(0, data.events.length - EVENT_CAP);

  scheduleFlush();
}

export async function flushNow() {
  if (flushTimer) {
    clearTimeout(flushTimer);
    flushTimer = null;
  }
  if (pending) {
    const current = generation;
    const snapshot = structuredClone(pending);
    const write = writes.then(() => {
      if (current === generation) return chrome.storage.local.set(snapshot);
    });
    writes = write.catch(() => {});
    await write;
  }
}

// Called after logs are cleared so cached stats don't get re-written.
export function resetCache() {
  if (flushTimer) {
    clearTimeout(flushTimer);
    flushTimer = null;
  }
  pending = null;
  loading = null;
  generation++;
}

export function clearLogs() {
  resetCache();
  const removal = writes.then(() => chrome.storage.local.remove(["stats", "events"]));
  writes = removal.catch(() => {});
  clearing = removal;
  return removal.finally(() => {
    if (clearing === removal) clearing = null;
  });
}
