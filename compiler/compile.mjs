#!/usr/bin/env node
// Fenceline list compiler.
//
// Reads compiler/sources.json + lists/allow.txt + lists/block.txt,
// downloads and normalizes every upstream list, and emits to dist/:
//
//   meta.json        version, category names, chunk index, artifact hashes
//   dnr/NNN.json     declarativeNetRequest rule chunks (Tier 1 fast path)
//   tail.bin         sorted uint64 FNV-1a hashes of ALL blocked domains
//   cats.bin         parallel uint8 category index per domain
//
// Tier-1 selection: if data/tranco.csv exists (top-1M ranking), the most
// popular blocked domains go into DNR rules; otherwise selection follows
// category order in sources.json.
//
// No npm dependencies. Node 18+.

import { createHash } from "node:crypto";
import { gunzipSync } from "node:zlib";
import { domainToASCII } from "node:url";
import { mkdirSync, readFileSync, writeFileSync, existsSync, rmSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { fnv1a64 } from "../extension/lib/hash.js";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const DIST = join(ROOT, "dist");
const SRC = JSON.parse(readFileSync(join(ROOT, "compiler", "sources.json"), "utf8"));

const DOMAIN_RE = /^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z][a-z0-9-]{0,61}[a-z0-9]$/;
const IP_RE = /^\d{1,3}(\.\d{1,3}){3}$/;

// The block-the-page-never-pin-the-origin baseline, shipped in meta.json.
// One host per line; blank lines and # comments ignored.
function readNoPinHosts() {
  const path = join(ROOT, "compiler", "no-pin-hosts.txt");
  if (!existsSync(path)) return [];
  const out = [];
  for (const line of readFileSync(path, "utf8").split("\n")) {
    const h = line.replace(/#.*$/, "").trim().toLowerCase();
    if (h) out.push(h);
  }
  return out;
}

function normalizeDomain(raw) {
  let d = raw.trim().toLowerCase();
  if (!d || d.startsWith("#") || d.startsWith("!")) return null;
  // hosts-format prefixes
  d = d.replace(/^(0\.0\.0\.0|127\.0\.0\.1|::1?|255\.255\.255\.255)\s+/, "");
  d = d.split(/[\s#]/)[0];
  d = d.replace(/^\*\./, "").replace(/\.$/, "").replace(/^www\./, "");
  if (!d || d === "localhost" || d === "broadcasthost" || IP_RE.test(d)) return null;
  if (!/^[\x00-\x7f]+$/.test(d)) {
    try {
      d = domainToASCII(d);
    } catch {
      return null;
    }
  }
  if (!DOMAIN_RE.test(d)) return null;
  return d;
}

function parsePlain(text, out) {
  for (const line of text.split("\n")) {
    const d = normalizeDomain(line);
    if (d) out.push(d);
  }
}

// Minimal tar reader: UT1 archives contain <category>/domains (and urls,
// which we skip — this is a domain filter).
function parseUt1TarGz(buf, out) {
  const tar = gunzipSync(buf);
  let off = 0;
  while (off + 512 <= tar.length) {
    const name = tar.subarray(off, off + 100).toString("utf8").replace(/\0.*$/, "");
    if (!name) break;
    const size = parseInt(tar.subarray(off + 124, off + 136).toString("utf8").replace(/\0.*$/, "").trim() || "0", 8);
    const typeflag = tar[off + 156];
    off += 512;
    if (name.endsWith("/domains") && (typeflag === 48 /* '0' */ || typeflag === 0)) {
      parsePlain(tar.subarray(off, off + size).toString("utf8"), out);
    }
    off += Math.ceil(size / 512) * 512;
  }
}

async function fetchSource(src) {
  if (src.file) {
    const buf = readFileSync(join(ROOT, src.file));
    return { buf, src };
  }
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const r = await fetch(src.url, { redirect: "follow" });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      return { buf: Buffer.from(await r.arrayBuffer()), src };
    } catch (e) {
      console.warn(`  retry ${attempt}/3 ${src.url}: ${e.message}`);
      if (attempt === 3) {
        console.error(`  SKIPPING unreachable source: ${src.url}`);
        return { buf: null, src };
      }
      await new Promise((res) => setTimeout(res, 2000 * attempt));
    }
  }
}

function readLocalList(path) {
  const full = join(ROOT, path);
  if (!existsSync(full)) return [];
  const out = [];
  parsePlain(readFileSync(full, "utf8"), out);
  return out;
}

function loadTrancoRanks() {
  const p = join(ROOT, "data", "tranco.csv");
  if (!existsSync(p)) return null;
  const ranks = new Map();
  const text = readFileSync(p, "utf8");
  let n = 0;
  for (const line of text.split("\n")) {
    const comma = line.indexOf(",");
    if (comma === -1) continue;
    const d = line.slice(comma + 1).trim().toLowerCase();
    if (d) ranks.set(d, ++n);
  }
  console.log(`Tranco ranking loaded: ${ranks.size.toLocaleString()} domains`);
  return ranks;
}

function sha256(buf) {
  return createHash("sha256").update(buf).digest("hex");
}

// Emit dist/domains.tsv ("<domain>\t<label>") for the content classifier.
// Reuses the same fetch/normalize path as the build so labels are consistent.
// "clean" = Tranco-ranked domains that are NOT in any blocked category.
async function dumpDomains() {
  const domainCat = new Map();
  for (let ci = 0; ci < SRC.categories.length; ci++) {
    const cat = SRC.categories[ci];
    for (const src of cat.sources) {
      const { buf } = await fetchSource(src);
      if (!buf) continue;
      const found = [];
      if (src.format === "ut1") parseUt1TarGz(buf, found);
      else parsePlain(buf.toString("utf8"), found);
      for (const d of found) if (!domainCat.has(d)) domainCat.set(d, cat.name);
    }
  }
  const lines = [];
  for (const [d, label] of domainCat) lines.push(`${d}\t${label}`);
  const ranks = loadTrancoRanks();
  if (ranks) {
    let cleanCount = 0;
    for (const d of ranks.keys()) {
      if (cleanCount >= 50000) break;
      // Normalize the Tranco domain the same way blocked domains were, so a
      // blocked www./IDN/trailing-dot form isn't mislabeled "clean".
      const nd = normalizeDomain(d);
      if (nd && !domainCat.has(nd)) {
        lines.push(`${nd}\tclean`);
        cleanCount++;
      }
    }
  }
  mkdirSync(DIST, { recursive: true });
  writeFileSync(join(DIST, "domains.tsv"), lines.join("\n") + "\n");
  console.log(`Wrote dist/domains.tsv: ${lines.length.toLocaleString()} rows`);
}

async function main() {
  if (process.argv.includes("--dump-domains")) {
    await dumpDomains();
    return;
  }

  console.log("Fenceline compiler\n");

  // 1) Collect: domain -> category index (first category wins).
  const catNames = SRC.categories.map((c) => c.name);
  catNames.push("custom"); // local lists/block.txt
  const domainCat = new Map();

  for (let ci = 0; ci < SRC.categories.length; ci++) {
    const cat = SRC.categories[ci];
    console.log(`[${cat.name}]`);
    for (const src of cat.sources) {
      const { buf } = await fetchSource(src);
      if (!buf) continue;
      const found = [];
      if (src.format === "ut1") parseUt1TarGz(buf, found);
      else parsePlain(buf.toString("utf8"), found);
      let added = 0;
      for (const d of found) {
        if (!domainCat.has(d)) {
          domainCat.set(d, ci);
          added++;
        }
      }
      console.log(`  ${src.url || src.file}: ${found.length.toLocaleString()} parsed, ${added.toLocaleString()} new`);
    }
  }

  // 2) Local overrides.
  const customIdx = catNames.length - 1;
  for (const d of readLocalList("lists/block.txt")) {
    if (!domainCat.has(d)) domainCat.set(d, customIdx);
  }
  const allow = new Set(readLocalList("lists/allow.txt"));
  for (const d of allow) domainCat.delete(d);
  // Also drop blocked subdomains of allowed domains.
  if (allow.size) {
    for (const d of [...domainCat.keys()]) {
      const parts = d.split(".");
      for (let i = 1; i <= parts.length - 2; i++) {
        if (allow.has(parts.slice(i).join("."))) {
          domainCat.delete(d);
          break;
        }
      }
    }
  }

  const total = domainCat.size;
  if (total === 0) throw new Error("No domains collected — refusing to publish an empty list.");
  console.log(`\nTotal unique domains: ${total.toLocaleString()}`);

  // 3) Drop redundant subdomains whose parent is also blocked in the SAME
  //    category (parent match covers them in both tiers).
  let pruned = 0;
  for (const [d, c] of [...domainCat.entries()]) {
    const parts = d.split(".");
    for (let i = 1; i <= parts.length - 2; i++) {
      const parent = parts.slice(i).join(".");
      const pc = domainCat.get(parent);
      if (pc !== undefined && pc === c) {
        domainCat.delete(d);
        pruned++;
        break;
      }
    }
  }
  console.log(`Pruned ${pruned.toLocaleString()} redundant subdomains -> ${domainCat.size.toLocaleString()} remain`);

  // 4) Tier 1 selection.
  const tier = SRC.dnrTier;
  const capacity = Math.min(tier.maxDomains, tier.maxRules * tier.domainsPerRule);
  const ranks = loadTrancoRanks();
  let dnrDomains;
  if (ranks) {
    dnrDomains = [...domainCat.keys()]
      .filter((d) => ranks.has(d))
      .sort((a, b) => ranks.get(a) - ranks.get(b));
    console.log(`Tranco-ranked blocked domains: ${dnrDomains.length.toLocaleString()}`);
    if (dnrDomains.length < capacity) {
      // Fill remaining capacity by category priority.
      const inDnr = new Set(dnrDomains);
      for (const [d] of domainCat) {
        if (dnrDomains.length >= capacity) break;
        if (!inDnr.has(d)) dnrDomains.push(d);
      }
    } else {
      dnrDomains = dnrDomains.slice(0, capacity);
    }
  } else {
    console.log("No data/tranco.csv — Tier 1 fills by category priority.");
    dnrDomains = [...domainCat.keys()].slice(0, capacity);
  }
  console.log(`Tier 1 (DNR): ${dnrDomains.length.toLocaleString()} domains (capacity ${capacity.toLocaleString()})`);

  // 5) Emit DNR chunks. Domains are packed into rules by BOTH a count cap
  //    and a serialized-size budget, so unusually long domain names can
  //    never push a rule past Chrome's per-rule compiled-size limit.
  rmSync(DIST, { recursive: true, force: true });
  mkdirSync(join(DIST, "dnr"), { recursive: true });

  const RULE_BYTE_BUDGET = 1800; // headroom under the ~2 KB documented limit

  const chunks = [];
  let chunkIdx = 0;
  let di = 0;
  while (di < dnrDomains.length && chunkIdx * tier.rulesPerChunk < tier.maxRules) {
    const ruleIdStart = chunkIdx * tier.rulesPerChunk + 1;
    let ruleId = ruleIdStart;
    const rules = [];
    let chunkDomainCount = 0;
    while (rules.length < tier.rulesPerChunk && di < dnrDomains.length) {
      const reqDomains = [];
      let bytes = 140; // fixed JSON overhead of a rule
      while (
        di < dnrDomains.length &&
        reqDomains.length < tier.domainsPerRule &&
        bytes + dnrDomains[di].length + 3 <= RULE_BYTE_BUDGET
      ) {
        bytes += dnrDomains[di].length + 3; // quotes + comma
        reqDomains.push(dnrDomains[di]);
        di++;
      }
      rules.push({
        id: ruleId++,
        priority: 1,
        action: { type: "block" },
        condition: {
          requestDomains: reqDomains,
          resourceTypes: ["main_frame", "sub_frame"]
        }
      });
      chunkDomainCount += reqDomains.length;
    }
    const file = `${String(chunkIdx).padStart(3, "0")}.json`;
    const body = JSON.stringify(rules);
    writeFileSync(join(DIST, "dnr", file), body);
    chunks.push({
      file,
      sha256: sha256(body),
      ruleIdStart,
      ruleCount: rules.length,
      maxRules: tier.rulesPerChunk,
      domains: chunkDomainCount
    });
    chunkIdx++;
  }
  const totalRules = chunks.reduce((a, c) => a + c.ruleCount, 0);

  // 6) Emit tail (ALL domains, sorted by hash) + parallel categories.
  const entries = [...domainCat.entries()].map(([d, c]) => ({ h: fnv1a64(d), c }));
  entries.sort((a, b) => (a.h < b.h ? -1 : a.h > b.h ? 1 : 0));
  // Hash-collision check (FNV-1a 64 over millions: astronomically unlikely,
  // but a collision would mis-categorize, so verify).
  for (let i = 1; i < entries.length; i++) {
    if (entries[i].h === entries[i - 1].h) {
      console.warn(`WARNING: hash collision at index ${i} — one domain will shadow another.`);
    }
  }
  const tailBuf = Buffer.alloc(entries.length * 8);
  const catsBuf = Buffer.alloc(entries.length);
  entries.forEach((e, i) => {
    tailBuf.writeBigUInt64LE(e.h, i * 8);
    catsBuf[i] = e.c;
  });
  writeFileSync(join(DIST, "tail.bin"), tailBuf);
  writeFileSync(join(DIST, "cats.bin"), catsBuf);

  // 7) meta.json — version derives from content, so unchanged lists don't
  //    trigger fleet re-downloads.
  const dnrPlaced = chunks.reduce((a, c) => a + c.domains, 0);
  const version = sha256(Buffer.concat([tailBuf, catsBuf])).slice(0, 16);
  const meta = {
    version,
    generated: new Date().toISOString(),
    categories: catNames,
    counts: { total: domainCat.size, dnrTier: dnrPlaced, rules: totalRules },
    chunks,
    tail: { file: "tail.bin", sha256: sha256(tailBuf), count: entries.length },
    cats: { file: "cats.bin", sha256: sha256(catsBuf) },
    // Block-the-page-never-pin-the-origin hosts (compiler/no-pin-hosts.txt),
    // synced so the fleet picks up additions in days, not a release cycle. The
    // extension keeps a bundled copy of this same baseline as a pre-sync fallback.
    noPinHosts: readNoPinHosts()
  };

  // Optional Tier-3 content model. If the classifier has exported one, publish
  // it next to the lists and reference it (with its OWN version) so the
  // extension pulls the ~1.3 MB weights only when the model itself changes —
  // independent of the list version.
  const modelSrc = join(ROOT, "classifier", "dist");
  if (existsSync(join(modelSrc, "model.bin")) && existsSync(join(modelSrc, "model-meta.json"))) {
    const modelBin = readFileSync(join(modelSrc, "model.bin"));
    const modelMetaRaw = readFileSync(join(modelSrc, "model-meta.json"));
    writeFileSync(join(DIST, "model.bin"), modelBin);
    writeFileSync(join(DIST, "model-meta.json"), modelMetaRaw);
    meta.model = {
      file: "model.bin",
      metaFile: "model-meta.json",
      version: JSON.parse(modelMetaRaw.toString("utf8")).version,
      sha256: sha256(modelBin)
    };
    console.log(`  model.bin ${(modelBin.length / 1048576).toFixed(2)} MB (v${meta.model.version})`);
  }

  writeFileSync(join(DIST, "meta.json"), JSON.stringify(meta, null, 2));
  // Keep GitHub Pages from running Jekyll on the dist branch.
  writeFileSync(join(DIST, ".nojekyll"), "");

  console.log(`\nWrote dist/: version ${version}`);
  console.log(`  tail.bin  ${(tailBuf.length / 1048576).toFixed(1)} MB (${entries.length.toLocaleString()} domains)`);
  console.log(`  dnr/      ${chunks.length} chunk(s), ${totalRules.toLocaleString()} rules, ${dnrPlaced.toLocaleString()} domains in Tier 1`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
