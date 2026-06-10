// Logging: BLOCKED navigations only. No browsing history is recorded.
// Stored per-device in chrome.storage.local:
//   stats.total                lifetime block count
//   stats.byCategory[cat]      lifetime count per category
//   stats.byDomain[domain]     lifetime count per domain (capped)
//   stats.byDay[YYYY-MM-DD]    { category: count } per day
//   events                     ring buffer of recent blocks [{t, d, c}]
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

async function load() {
  if (pending) return pending;
  const st = await chrome.storage.local.get(["stats", "events"]);
  pending = {
    stats: st.stats || { total: 0, byCategory: {}, byDomain: {}, byDay: {} },
    events: st.events || []
  };
  return pending;
}

function scheduleFlush() {
  if (flushTimer) return;
  flushTimer = setTimeout(async () => {
    flushTimer = null;
    if (!pending) return;
    await chrome.storage.local.set(pending);
  }, 250); // short: MV3 SWs can be suspended; keep the loss window tiny
}

export async function recordBlock(domain, category) {
  const data = await load();
  const s = data.stats;

  s.total++;
  s.byCategory[category] = (s.byCategory[category] || 0) + 1;

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

  data.events.push({ t: Date.now(), d: domain, c: category });
  if (data.events.length > EVENT_CAP) data.events.splice(0, data.events.length - EVENT_CAP);

  scheduleFlush();
}

export async function flushNow() {
  if (flushTimer) {
    clearTimeout(flushTimer);
    flushTimer = null;
  }
  if (pending) await chrome.storage.local.set(pending);
}

// Called after logs are cleared so cached stats don't get re-written.
export function resetCache() {
  if (flushTimer) {
    clearTimeout(flushTimer);
    flushTimer = null;
  }
  pending = null;
}
