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

function resourceTypes(cfg) {
  return cfg.blockSubframes ? ["main_frame", "sub_frame"] : ["main_frame"];
}

// Apply managed-policy allow/deny domains as dynamic rules.
export async function applyPolicyRules() {
  const cfg = await getConfig();
  const existing = await chrome.declarativeNetRequest.getDynamicRules();
  const oldIds = existing
    .filter((r) => r.id >= ALLOW_ID_BASE)
    .map((r) => r.id);

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

// Differentially apply DNR chunks. meta.chunks[i] = {file, sha256, ruleIdStart, ruleCount}
async function applyDnrChunks(cfg, meta, storedChunkHashes) {
  const newHashes = {};
  for (const chunk of meta.chunks) {
    newHashes[chunk.file] = chunk.sha256;
    const prev = storedChunkHashes[chunk.file];
    if (prev && prev.sha256 === chunk.sha256) continue; // unchanged

    const rules = await fetchJSON(`${cfg.listBaseUrl}/dnr/${chunk.file}`);
    const removeRuleIds = [];
    for (let id = chunk.ruleIdStart; id < chunk.ruleIdStart + chunk.maxRules; id++) {
      removeRuleIds.push(id);
    }
    // Honor the subframe setting at apply time.
    const rt = resourceTypes(cfg);
    for (const r of rules) r.condition.resourceTypes = rt;

    await chrome.declarativeNetRequest.updateDynamicRules({ removeRuleIds, addRules: rules });
  }

  // Remove rules from chunks that no longer exist.
  const liveFiles = new Set(meta.chunks.map((c) => c.file));
  const staleIds = [];
  for (const [file, info] of Object.entries(storedChunkHashes)) {
    if (!liveFiles.has(file) && info && info.ruleIdStart !== undefined) {
      for (let id = info.ruleIdStart; id < info.ruleIdStart + info.maxRules; id++) staleIds.push(id);
    }
  }
  if (staleIds.length) {
    await chrome.declarativeNetRequest.updateDynamicRules({ removeRuleIds: staleIds });
  }

  // Persist chunk state (hash + id range) for the next diff.
  const state = {};
  for (const chunk of meta.chunks) {
    state[chunk.file] = {
      sha256: chunk.sha256,
      ruleIdStart: chunk.ruleIdStart,
      maxRules: chunk.maxRules
    };
  }
  await chrome.storage.local.set({ chunkState: state });
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

  // 1) Tail artifacts.
  const [tailBuf, catsBuf] = await Promise.all([
    fetchBuf(`${cfg.listBaseUrl}/${meta.tail.file}`),
    fetchBuf(`${cfg.listBaseUrl}/${meta.cats.file}`)
  ]);
  if (tailBuf.byteLength !== meta.tail.count * 8 || catsBuf.byteLength !== meta.tail.count) {
    throw new Error("artifact size mismatch — refusing to apply");
  }
  await storeArtifacts(tailBuf, catsBuf, meta.categories, meta.version);

  // 2) DNR chunks (differential).
  const storedChunkHashes = {};
  for (const [f, info] of Object.entries(st.chunkState || {})) storedChunkHashes[f] = info;
  await applyDnrChunks(cfg, meta, storedChunkHashes);

  // 3) Policy overrides on top.
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
