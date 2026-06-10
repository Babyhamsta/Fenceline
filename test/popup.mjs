#!/usr/bin/env node
// Self-test for the popup's pure helpers. Run: node test/popup.mjs
import { relTime, todayCount } from "../extension/popup/format.js";

let failures = 0;
function assert(cond, msg) {
  if (cond) console.log(`  ok    ${msg}`);
  else {
    console.error(`  FAIL  ${msg}`);
    failures++;
  }
}

const NOW = 1_700_000_000_000;

console.log("relTime:");
assert(relTime(0, NOW) === "never", "0 -> never");
assert(relTime(null, NOW) === "never", "null -> never");
assert(relTime(NOW - 5_000, NOW) === "just now", "5s -> just now");
assert(relTime(NOW - 5 * 60_000, NOW) === "5m ago", "5m -> 5m ago");
assert(relTime(NOW - 2 * 3_600_000, NOW) === "2h ago", "2h -> 2h ago");
assert(relTime(NOW - 3 * 86_400_000, NOW) === "3d ago", "3d -> 3d ago");
assert(relTime(NOW + 10_000, NOW) === "just now", "future clamps to just now");

console.log("\ntodayCount:");
assert(todayCount({}, "2026-06-10") === 0, "empty stats -> 0");
assert(todayCount({ byDay: {} }, "2026-06-10") === 0, "no day entry -> 0");
assert(
  todayCount({ byDay: { "2026-06-10": { adult: 3, social: 2 } } }, "2026-06-10") === 5,
  "sums today's categories"
);
assert(
  todayCount({ byDay: { "2026-06-09": { adult: 9 } } }, "2026-06-10") === 0,
  "other day ignored"
);

console.log(failures ? `\n${failures} FAILURE(S)` : "\nAll checks passed.");
process.exit(failures ? 1 : 0);
