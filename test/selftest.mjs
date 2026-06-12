#!/usr/bin/env node
// End-to-end self-test:
//   1. Build a small fixture list with the real compiler.
//   2. Load the emitted tail.bin/cats.bin exactly like the extension does.
//   3. Assert hits, subdomain hits, allowlist removals, category lookups,
//      and DNR chunk shape / rule-id ranges.
//
// Run: node test/selftest.mjs

import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync, mkdirSync, rmSync, cpSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { fnv1a64, domainCandidates, lookupHash } from "../extension/lib/hash.js";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const TMP = join(ROOT, "test", ".tmp");

let failures = 0;
function assert(cond, msg) {
  if (cond) console.log(`  ok    ${msg}`);
  else {
    console.error(`  FAIL  ${msg}`);
    failures++;
  }
}

// ---- 1) Fixture workspace ------------------------------------------------
rmSync(TMP, { recursive: true, force: true });
mkdirSync(join(TMP, "compiler"), { recursive: true });
mkdirSync(join(TMP, "lists"), { recursive: true });
mkdirSync(join(TMP, "extension", "lib"), { recursive: true });
cpSync(join(ROOT, "compiler", "compile.mjs"), join(TMP, "compiler", "compile.mjs"));
cpSync(join(ROOT, "extension", "lib", "hash.js"), join(TMP, "extension", "lib", "hash.js"));

writeFileSync(
  join(TMP, "fixture-adult.txt"),
  ["badsite.example", "www.alsobad.example", "sub.deep.bad.example", "# comment", "0.0.0.0 hostsstyle.example", "REMOVED.allowed.example"].join("\n")
);
writeFileSync(join(TMP, "fixture-gambling.txt"), ["bets.example", "badsite.example"].join("\n")); // dupe -> adult wins
writeFileSync(join(TMP, "lists", "allow.txt"), "allowed.example\n");
writeFileSync(join(TMP, "lists", "block.txt"), "districtblocked.example\n");

writeFileSync(
  join(TMP, "compiler", "sources.json"),
  JSON.stringify({
    dnrTier: { maxRules: 100, domainsPerRule: 3, rulesPerChunk: 2, maxDomains: 1000 },
    categories: [
      { name: "adult", sources: [{ file: "fixture-adult.txt", format: "domains" }] },
      { name: "gambling", sources: [{ file: "fixture-gambling.txt", format: "domains" }] }
    ]
  })
);

console.log("Running compiler on fixtures…");
execFileSync("node", [join(TMP, "compiler", "compile.mjs")], { cwd: TMP, stdio: "inherit" });

// ---- 2) Load artifacts the way the extension does -------------------------
const meta = JSON.parse(readFileSync(join(TMP, "dist", "meta.json"), "utf8"));
const tailBuf = readFileSync(join(TMP, "dist", "tail.bin"));
const catsBuf = readFileSync(join(TMP, "dist", "cats.bin"));
const hashes = new BigUint64Array(tailBuf.buffer, tailBuf.byteOffset, tailBuf.length / 8);
const cats = new Uint8Array(catsBuf.buffer, catsBuf.byteOffset, catsBuf.length);

function check(hostname) {
  for (const cand of domainCandidates(hostname)) {
    const idx = lookupHash(hashes, fnv1a64(cand));
    if (idx !== -1) return { domain: cand, category: meta.categories[cats[idx]] };
  }
  return null;
}

console.log("\nEngine checks:");
assert(meta.tail.count === hashes.length, `meta count matches tail length (${hashes.length})`);
assert(tailBuf.length === meta.tail.count * 8 && catsBuf.length === meta.tail.count, "artifact sizes consistent");

let sorted = true;
for (let i = 1; i < hashes.length; i++) if (hashes[i] <= hashes[i - 1]) sorted = false;
assert(sorted, "tail.bin strictly sorted");

assert(check("badsite.example")?.category === "adult", "exact match -> adult (dupe precedence over gambling)");
assert(check("anything.badsite.example") !== null, "subdomain of blocked domain matches");
assert(check("alsobad.example") !== null, "www. stripped at compile time, bare domain blocked");
assert(check("hostsstyle.example") !== null, "hosts-format '0.0.0.0 domain' parsed");
assert(check("bets.example")?.category === "gambling", "second category assigned correctly");
assert(check("districtblocked.example")?.category === "custom", "lists/block.txt -> custom category");
assert(check("removed.allowed.example") === null, "subdomain of allowlisted domain removed");
assert(check("allowed.example") === null, "allowlisted domain removed");
assert(check("totally-fine.example") === null, "unrelated domain not blocked");
assert(check("example.com") === null, "popular clean domain not blocked");

console.log("\nDNR chunk checks:");
let expectedStart = 1;
let totalRuleDomains = 0;
for (const chunk of meta.chunks) {
  const rules = JSON.parse(readFileSync(join(TMP, "dist", "dnr", chunk.file), "utf8"));
  assert(chunk.ruleIdStart === expectedStart, `${chunk.file} ruleIdStart ${chunk.ruleIdStart} == expected ${expectedStart}`);
  assert(rules.length === chunk.ruleCount && rules.length <= chunk.maxRules, `${chunk.file} ruleCount within reserved range`);
  for (const r of rules) {
    const size = JSON.stringify(r).length;
    assert(
      r.action.type === "block" && Array.isArray(r.condition.requestDomains) && r.condition.requestDomains.length <= 3 && size <= 1900,
      `rule ${r.id} shape valid (${r.condition.requestDomains.length} domains, ${size} B)`
    );
    totalRuleDomains += r.condition.requestDomains.length;
  }
  expectedStart += chunk.maxRules;
}
assert(totalRuleDomains === meta.counts.dnrTier, `DNR tier domain count consistent (${totalRuleDomains})`);

console.log(failures ? `\n${failures} FAILURE(S)` : "\nAll checks passed.");
process.exit(failures ? 1 : 0);
