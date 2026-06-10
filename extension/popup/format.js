// Pure, DOM-free helpers for the popup so the logic is unit-testable
// in Node (see test/popup.mjs).

export function relTime(ts, nowMs) {
  if (!ts) return "never";
  const sec = Math.max(0, Math.floor((nowMs - ts) / 1000));
  if (sec < 60) return "just now";
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min}m ago`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr}h ago`;
  const day = Math.floor(hr / 24);
  return `${day}d ago`;
}

export function todayCount(stats, todayIso) {
  const day = (stats && stats.byDay && stats.byDay[todayIso]) || {};
  return Object.values(day).reduce((a, b) => a + b, 0);
}
