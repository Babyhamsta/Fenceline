// Sync: pulls list artifacts from GitHub Pages.
//
//   meta.json     — tiny, checked every checkIntervalHours (ETag/304 cheap)
//   dnr/NNN.json  — chunks of ready-to-load declarativeNetRequest rules
//                   (the "fast tier": popular blocked domains, blocked in
//                   the network stack — zero flash, works while the SW
//                   sleeps). Only changed chunks are re-fetched/re-applied.
//   tail.bin      — sorted u64 hashes of ALL blocked domains (superset of
//                   the DNR tier; also used for category lookup on blocks)
//   cats.bin      — parallel category byte per domain
//
// Rule ID layout (dynamic rules):
//   1 .. 899_999      block rules from chunks (chunk i owns a fixed range)
//   900_001 .. +N     allow rules from managed policy (priority 100)
//   950_001 .. +N     extra block rules from managed policy

import { getConfig } from "./config.js";
import { storeArtifacts, getStoredVersion } from "./tail.js";
import { storeModel, getStoredModelVersion } from "./model.js";

const ALLOW_ID_BASE = 900001;
const EXTRA_BLOCK_ID_BASE = 950001;
const MAX_POLICY_RULES = 5000;

async function fetchJSON(url) {
  const r = await fetch(url, { cache: "no-cache" });
  if (!r.ok) throw new Error(`${url} -> ${r.status}`);
  return r.json();
}

async function fetchBuf(url) {
  const r = await fetch(url, { cache: "no-cache" });
  if (!r.ok) throw new Error(`${url} -> ${r.status}`);
  return r.arrayBuffer();
}

// Hex SHA-256 of a buffer, matched against the compiler's published hashes
// (which are over the RAW file bytes). meta.json ships these for every artifact;
// verifying them rejects a truncated/corrupted CDN response of the right length
// and a stale mixed-version cache (e.g. tail from v2 + cats from v1, fetched as
// two requests) — both of which a byte-length check alone lets through.
async function digestHex(buf) {
  const d = await crypto.subtle.digest("SHA-256", buf);
  return [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

function resourceTypes(cfg) {
  return cfg.blockSubframes ? ["main_frame", "sub_frame"] : ["main_frame"];
}

// Apply managed-policy allow/deny domains as dynamic rules.
export async function applyPolicyRules() {
  const cfg = await getConfig();
  const existing = await chrome.declarativeNetRequest.getDynamicRules();
  const oldIds = existing.filter((r) => r.id >= ALLOW_ID_BASE).map((r) => r.id);

  const addRules = [];
  cfg.allowDomains.slice(0, MAX_POLICY_RULES).forEach((d, i) => {
    addRules.push({
      id: ALLOW_ID_BASE + i,
      priority: 100,
      action: { type: "allow" },
      condition: { requestDomains: [d], resourceTypes: ["main_frame", "sub_frame"] }
    });
  });
  cfg.extraBlockDomains.slice(0, MAX_POLICY_RULES).forEach((d, i) => {
    addRules.push({
      id: EXTRA_BLOCK_ID_BASE + i,
      priority: 2,
      action: { type: "block" },
      condition: { requestDomains: [d], resourceTypes: resourceTypes(cfg) }
    });
  });

  if (oldIds.length || addRules.length) {
    await chrome.declarativeNetRequest.updateDynamicRules({
      removeRuleIds: oldIds,
      addRules
    });
  }
}

// Phase 1 of the differential DNR update: fetch every CHANGED chunk's raw bytes,
// verify its sha256, and only THEN parse — hashing a re-serialized object would
// not match the published file, so we must digest the bytes off the wire. No
// chrome.declarativeNetRequest write happens here, so a mismatch (thrown with
// .hashMismatch) aborts the whole sync with the current rules untouched.
// meta.chunks[i] = {file, sha256, ruleIdStart, ruleCount, maxRules}
async function prepareDnrChunks(meta, cfg, storedChunkHashes) {
  const changed = [];
  for (const chunk of meta.chunks) {
    const prev = storedChunkHashes[chunk.file];
    if (prev && prev.sha256 === chunk.sha256) continue; // unchanged

    const buf = await fetchBuf(`${cfg.listBaseUrl}/dnr/${chunk.file}`);
    if (chunk.sha256 && (await digestHex(buf)) !== chunk.sha256) {
      const err = new Error(`DNR chunk ${chunk.file} hash mismatch`);
      err.hashMismatch = true;
      throw err;
    }
    let rules;
    try {
      rules = JSON.parse(new TextDecoder("utf-8").decode(buf));
    } catch (e) {
      const err = new Error(`DNR chunk ${chunk.file} parse failed`);
      err.hashMismatch = true; // verified bytes that won't parse: refuse to apply
      throw err;
    }
    changed.push({ chunk, rules });
  }

  // Rules from chunks that no longer exist in meta.
  const liveFiles = new Set(meta.chunks.map((c) => c.file));
  const staleIds = [];
  for (const [file, info] of Object.entries(storedChunkHashes)) {
    if (!liveFiles.has(file) && info && info.ruleIdStart !== undefined) {
      for (let id = info.ruleIdStart; id < info.ruleIdStart + info.maxRules; id++)
        staleIds.push(id);
    }
  }

  // Chunk state (hash + id range) to persist after a successful apply.
  const state = {};
  for (const chunk of meta.chunks) {
    state[chunk.file] = {
      sha256: chunk.sha256,
      ruleIdStart: chunk.ruleIdStart,
      maxRules: chunk.maxRules
    };
  }
  return { changed, staleIds, state };
}

// Phase 2: apply the verified chunks. Runs only after tail/cats AND every
// changed chunk have passed verification, so corrupt input never lands rules.
async function applyDnrChunks(cfg, prepared) {
  const rt = resourceTypes(cfg); // honor the subframe setting at apply time
  for (const { chunk, rules } of prepared.changed) {
    const removeRuleIds = [];
    for (let id = chunk.ruleIdStart; id < chunk.ruleIdStart + chunk.maxRules; id++) {
      removeRuleIds.push(id);
    }
    for (const r of rules) r.condition.resourceTypes = rt;
    await chrome.declarativeNetRequest.updateDynamicRules({ removeRuleIds, addRules: rules });
  }
  if (prepared.staleIds.length) {
    await chrome.declarativeNetRequest.updateDynamicRules({ removeRuleIds: prepared.staleIds });
  }
  await chrome.storage.local.set({ chunkState: prepared.state });
}

// Pull the content-classifier model when its version changes. Independent of
// the list-version check and the bandwidth throttle below: the model is small
// (~1.3 MB) and we want it current even when the (much larger) list isn't due.
async function syncModel(cfg, meta) {
  if (!meta.model || !meta.model.version) return null;
  if ((await getStoredModelVersion()) === meta.model.version) return null;
  const [coefBuf, modelMeta] = await Promise.all([
    fetchBuf(`${cfg.listBaseUrl}/${meta.model.file}`),
    fetchJSON(`${cfg.listBaseUrl}/${meta.model.metaFile}`)
  ]);
  const expected = modelMeta.classes.length * modelMeta.dims * 4;
  if (coefBuf.byteLength !== expected) throw new Error("model size mismatch — refusing to apply");
  if (meta.model.sha256 && (await digestHex(coefBuf)) !== meta.model.sha256) {
    throw new Error("model hash mismatch — refusing to apply"); // caught upstream; keeps current model
  }
  await storeModel(coefBuf, modelMeta);
  console.log(`[fenceline] synced content model v${modelMeta.version}`);
  return modelMeta.version;
}

export async function checkAndSync(force = false) {
  const cfg = await getConfig();
  const st = await chrome.storage.local.get(["lastFullSync", "chunkState", "lastCheck"]);

  let meta;
  try {
    meta = await fetchJSON(`${cfg.listBaseUrl}/meta.json`);
  } catch (e) {
    console.warn("[fenceline] meta check failed (offline?)", e.message);
    return { synced: false, reason: "meta-unreachable" };
  }
  await chrome.storage.local.set({ lastCheck: Date.now() });

  // No-pin baseline rides meta.json (tiny, fetched every check) so the fleet
  // picks up additions without a full artifact re-download or release cycle.
  if (Array.isArray(meta.noPinHosts)) {
    await chrome.storage.local.set({ noPinHosts: meta.noPinHosts });
  }

  // Model first (cheap, version-gated) so it tracks even an up-to-date list.
  try {
    const mv = await syncModel(cfg, meta);
    if (mv) await chrome.storage.local.set({ modelVersion: mv });
  } catch (e) {
    console.warn("[fenceline] model sync failed", e.message);
  }

  const currentVersion = await getStoredVersion();
  // Never re-download an identical version, even on a forced check. "Force"
  // only bypasses the time throttle below (to pull a genuinely NEW version
  // early) — it must not let a spammed button re-fetch tens of MB of
  // unchanged artifacts and burn fleet bandwidth.
  if (currentVersion === meta.version) {
    return { synced: false, reason: "up-to-date", version: meta.version };
  }

  // Throttle full artifact downloads to protect fleet bandwidth —
  // unless we have no list at all, or an admin forced it.
  const days = (Date.now() - (st.lastFullSync || 0)) / 86400000;
  if (!force && currentVersion && days < cfg.minDaysBetweenFullSync) {
    return { synced: false, reason: "throttled", nextInDays: cfg.minDaysBetweenFullSync - days };
  }

  // 1) Fetch tail artifacts and verify size + hash BEFORE storing anything.
  const [tailBuf, catsBuf] = await Promise.all([
    fetchBuf(`${cfg.listBaseUrl}/${meta.tail.file}`),
    fetchBuf(`${cfg.listBaseUrl}/${meta.cats.file}`)
  ]);
  if (tailBuf.byteLength !== meta.tail.count * 8 || catsBuf.byteLength !== meta.tail.count) {
    console.warn("[fenceline] artifact size mismatch — keeping current list");
    return { synced: false, reason: "size-mismatch" };
  }
  if (meta.tail.sha256 && (await digestHex(tailBuf)) !== meta.tail.sha256) {
    console.warn("[fenceline] tail.bin hash mismatch — keeping current list");
    return { synced: false, reason: "hash-mismatch" };
  }
  if (meta.cats.sha256 && (await digestHex(catsBuf)) !== meta.cats.sha256) {
    console.warn("[fenceline] cats.bin hash mismatch — keeping current list");
    return { synced: false, reason: "hash-mismatch" };
  }

  // 2) Fetch + verify every changed DNR chunk into memory (no rules applied yet).
  const storedChunkHashes = {};
  for (const [f, info] of Object.entries(st.chunkState || {})) storedChunkHashes[f] = info;
  let prepared;
  try {
    prepared = await prepareDnrChunks(meta, cfg, storedChunkHashes);
  } catch (e) {
    if (e && e.hashMismatch) {
      console.warn("[fenceline] keeping current list —", e.message);
      return { synced: false, reason: "hash-mismatch" };
    }
    throw e; // network/other error — bubble to caller as before
  }

  // 3) Everything verified — apply atomically: tail/cats, then chunks, then policy.
  await storeArtifacts(tailBuf, catsBuf, meta.categories, meta.version);
  await applyDnrChunks(cfg, prepared);
  await applyPolicyRules();

  await chrome.storage.local.set({
    lastFullSync: Date.now(),
    listVersion: meta.version,
    listGenerated: meta.generated,
    listTotal: meta.tail.count
  });

  console.log(`[fenceline] synced list v${meta.version} (${meta.tail.count} domains)`);
  return { synced: true, version: meta.version, total: meta.tail.count };
}
