// Fenceline service worker.
//
// Two-tier blocking:
//   Tier 1 — declarativeNetRequest dynamic rules (popular blocked domains,
//            compiled server-side). Blocks in the network stack: zero
//            content flash, zero latency, enforced even while this worker
//            is asleep. A blocked main-frame nav surfaces as
//            net::ERR_BLOCKED_BY_CLIENT, which we catch to show the
//            custom block page and log the hit.
//   Tier 2 — tail engine (full multi-million-domain list as sorted u64
//            hashes). Checked on webNavigation.onBeforeNavigate; on a hit
//            the tab is redirected to the block page.
//
// All matching is on-device. Nothing is sent anywhere. Only BLOCKS are logged.

import { check, ensureLoaded, isReady, listSize } from "./lib/tail.js";
import { checkAndSync, applyPolicyRules } from "./lib/sync.js";
import { recordBlock, resetCache } from "./lib/log.js";
import { getConfig } from "./lib/config.js";

const SYNC_ALARM = "fenceline-sync";

// ---- block page helpers ----------------------------------------------

// Dedupe: a Tier-1 block can fire both onErrorOccurred and (rarely) race
// with a tail hit; don't double-log the same tab+domain within 3 s.
const recentBlocks = new Map(); // tabId -> { domain, t }

function shouldLog(tabId, domain) {
  const prev = recentBlocks.get(tabId);
  const now = Date.now();
  recentBlocks.set(tabId, { domain, t: now });
  if (recentBlocks.size > 200) {
    for (const [k, v] of recentBlocks) if (now - v.t > 10000) recentBlocks.delete(k);
  }
  return !(prev && prev.domain === domain && now - prev.t < 3000);
}

async function blockTab(tabId, domain, category) {
  if (shouldLog(tabId, domain)) recordBlock(domain, category);
  const url =
    chrome.runtime.getURL("block/block.html") +
    `?d=${encodeURIComponent(domain)}&c=${encodeURIComponent(category)}`;
  try {
    await chrome.tabs.update(tabId, { url });
  } catch (e) {
    // Tab may already be gone.
  }
}

function hostnameOf(url) {
  try {
    const u = new URL(url);
    if (u.protocol !== "http:" && u.protocol !== "https:") return null;
    return u.hostname;
  } catch {
    return null;
  }
}

function isAllowed(hostname, cfg) {
  const h = hostname.toLowerCase();
  return cfg.allowDomains.some((d) => h === d || h.endsWith("." + d));
}

function extraBlocked(hostname, cfg) {
  const h = hostname.toLowerCase();
  return cfg.extraBlockDomains.find((d) => h === d || h.endsWith("." + d)) || null;
}

// ---- Tier 2: tail check on navigation ---------------------------------

chrome.webNavigation.onBeforeNavigate.addListener(async (details) => {
  if (details.frameId !== 0) return;
  const hostname = hostnameOf(details.url);
  if (!hostname) return;

  const cfg = await getConfig();
  if (isAllowed(hostname, cfg)) return;

  const extra = extraBlocked(hostname, cfg);
  if (extra) {
    blockTab(details.tabId, extra, "district-policy");
    return;
  }

  await ensureLoaded();
  const hit = check(hostname);
  if (hit) blockTab(details.tabId, hit.domain, hit.category);
});

// ---- Tier 1: DNR blocked the request at the network layer -------------

chrome.webNavigation.onErrorOccurred.addListener(async (details) => {
  if (details.frameId !== 0) return;
  if (details.error !== "net::ERR_BLOCKED_BY_CLIENT") return;
  const hostname = hostnameOf(details.url);
  if (!hostname) return;

  const cfg = await getConfig();
  const extra = extraBlocked(hostname, cfg);
  if (extra) {
    blockTab(details.tabId, extra, "district-policy");
    return;
  }

  // Verify it was OUR list (another extension could also block) and
  // resolve the category from the tail (superset of the DNR tier).
  await ensureLoaded();
  const hit = check(hostname);
  if (hit) blockTab(details.tabId, hit.domain, hit.category);
});

// ---- sync scheduling ---------------------------------------------------

async function scheduleSync() {
  const cfg = await getConfig();
  await chrome.alarms.create(SYNC_ALARM, {
    periodInMinutes: Math.max(1, cfg.checkIntervalHours) * 60,
    delayInMinutes: 1
  });
}

chrome.alarms.onAlarm.addListener(async (alarm) => {
  if (alarm.name !== SYNC_ALARM) return;
  try {
    await checkAndSync(false);
  } catch (e) {
    console.error("[fenceline] sync failed", e);
  }
});

chrome.runtime.onInstalled.addListener(async () => {
  await scheduleSync();
  try {
    // First install: force a full download regardless of throttle.
    const loaded = await ensureLoaded();
    await checkAndSync(!loaded);
  } catch (e) {
    console.error("[fenceline] initial sync failed", e);
  }
});

chrome.runtime.onStartup.addListener(async () => {
  await scheduleSync();
  ensureLoaded();
});

// Admin pushed new policy (allow/deny lists, settings) — apply live.
chrome.storage.managed.onChanged.addListener(async () => {
  try {
    await applyPolicyRules();
    await scheduleSync();
  } catch (e) {
    console.error("[fenceline] policy apply failed", e);
  }
});

// ---- messages from block/report pages ----------------------------------

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  (async () => {
    if (msg.type === "status") {
      const cfg = await getConfig();
      const st = await chrome.storage.local.get([
        "listVersion",
        "listGenerated",
        "listTotal",
        "lastFullSync",
        "lastCheck"
      ]);
      await ensureLoaded();
      sendResponse({
        ready: isReady(),
        tailSize: listSize(),
        config: {
          schoolName: cfg.schoolName,
          supportContact: cfg.supportContact,
          blockMessage: cfg.blockMessage,
          allowClearLogs: cfg.allowClearLogs,
          allowExport: cfg.allowExport
        },
        ...st
      });
    } else if (msg.type === "forceSync") {
      try {
        sendResponse(await checkAndSync(true));
      } catch (e) {
        sendResponse({ synced: false, error: String(e) });
      }
    } else if (msg.type === "clearLogs") {
      const cfg = await getConfig();
      if (!cfg.allowClearLogs) {
        sendResponse({ ok: false, error: "Clearing logs is disabled by policy." });
      } else {
        await chrome.storage.local.remove(["stats", "events"]);
        resetCache();
        sendResponse({ ok: true });
      }
    }
  })();
  return true; // async sendResponse
});
