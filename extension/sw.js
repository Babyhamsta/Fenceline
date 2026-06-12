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
import { ensureModelLoaded, isModelReady, modelVersion, decide } from "./lib/model.js";

const SYNC_ALARM = "fenceline-sync";

// ---- block page helpers ----------------------------------------------

// Dedupe: a Tier-1 block can fire both onErrorOccurred and (rarely) race
// with a tail hit; don't double-log the same tab+domain within 3 s.
const recentBlocks = new Map(); // tabId -> { domain, t }

// The last real http/https host each tab navigated to. In-page "browser"
// proxies render proxied content into an about:blank top document (no
// hostname), so a content block from there is attributed to the host that
// served the proxy (e.g. cherrion.top) — which is then pinned.
const lastRealHost = new Map(); // tabId -> hostname
chrome.tabs.onRemoved.addListener((tabId) => {
  lastRealHost.delete(tabId);
  recentBlocks.delete(tabId);
});

function shouldLog(tabId, domain) {
  const prev = recentBlocks.get(tabId);
  const now = Date.now();
  recentBlocks.set(tabId, { domain, t: now });
  if (recentBlocks.size > 200) {
    for (const [k, v] of recentBlocks) if (now - v.t > 10000) recentBlocks.delete(k);
  }
  return !(prev && prev.domain === domain && now - prev.t < 3000);
}

// source: "list" (DNR/tail), "model" (content classifier), "district-policy".
// confidence (0..1) is set only for model blocks — surfaced on the block page.
async function blockTab(tabId, domain, category, source = "list", confidence = null) {
  if (shouldLog(tabId, domain)) recordBlock(domain, category, source);
  let url =
    chrome.runtime.getURL("block/block.html") +
    `?d=${encodeURIComponent(domain)}&c=${encodeURIComponent(category)}` +
    `&s=${encodeURIComponent(source)}`;
  if (confidence != null) url += `&conf=${Math.round(confidence * 100)}`;
  try {
    await chrome.tabs.update(tabId, { url });
  } catch (e) {
    // Tab may already be gone.
  }
}

// Domains the model has blocked before are pinned locally so a re-visit is
// blocked at navigation time (no second-load flash, no re-scan).
let pinned = null; // Map<registrableDomain, {category, confidence}>
const PIN_CAP = 2000;

// Hosts that serve many independent sites under one hostname (path-multitenant).
// We still block the specific page, but never pin the bare host — pinning
// sites.google.com would block ALL Google Sites fleet-wide. These get re-scanned
// on each visit instead.
const NO_PIN_HOSTS = new Set([
  "sites.google.com",
  "script.google.com",
  "storage.googleapis.com",
  "docs.google.com",
  "drive.google.com"
]);

async function loadPins() {
  if (pinned) return pinned;
  const { modelPinned = {} } = await chrome.storage.local.get(["modelPinned"]);
  pinned = new Map(Object.entries(modelPinned));
  return pinned;
}

async function pinDomain(domain, category, confidence) {
  if (NO_PIN_HOSTS.has(domain)) return; // block the page, but don't over-block the host
  const p = await loadPins();
  if (p.has(domain)) return;
  p.set(domain, { category, confidence });
  const obj = Object.fromEntries(p);
  const keys = Object.keys(obj);
  while (keys.length > PIN_CAP) delete obj[keys.shift()];
  await chrome.storage.local.set({ modelPinned: obj });
}

function pinnedHit(hostname, p) {
  const parts = hostname.toLowerCase().split(".");
  for (let i = 0; i < parts.length - 1; i++) {
    const cand = parts.slice(i).join(".");
    if (p.has(cand)) return cand;
  }
  return null;
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

// Tier 4: web-proxy ENGINE signature — detected by BEHAVIOUR, not a list of
// framework names (which would both miss new proxies and false-trip legit sites
// like an epoxy or UV-service company). Every web proxy loads its target by
// embedding the target URL in the PATH, e.g.
//   cherrion.top/scramjet/https%3A%2F%2Fgamesito.com/...   (percent-encoded)
//   someproxy.net/service/aHR0cHM6Ly9nYW1lc2l0by5jb20...   (base64, Ultraviolet)
// Legit sites only ever pass a target URL as a ?query param, never as a path
// segment — so a URL-in-the-path is a near-zero-FP, framework-agnostic tell.
function _decodesToUrl(seg) {
  if (seg.length < 24 || !/^[A-Za-z0-9+/=_-]+$/.test(seg)) return false;
  try {
    return /^https?:\/\//i.test(atob(seg.replace(/-/g, "+").replace(/_/g, "/")));
  } catch {
    return false;
  }
}
function looksLikeProxyUrl(url) {
  try {
    const rawPath = new URL(url).pathname;
    const path = rawPath.toLowerCase();
    if (path.includes("https%3a%2f%2f") || path.includes("http%3a%2f%2f")) return true; // percent-encoded
    if (path.includes("/https:/") || path.includes("/http:/")) return true;             // plain
    for (const seg of rawPath.split("/")) if (_decodesToUrl(seg)) return true;           // base64
    return false;
  } catch {
    return false;
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
  // Tier 4 runs on EVERY frame: a proxy-engine URL anywhere in the tab means
  // the host serving it is a web proxy — block & pin it on first use.
  if (looksLikeProxyUrl(details.url)) {
    const phost = hostnameOf(details.url) || lastRealHost.get(details.tabId);
    if (phost) {
      const cfg = await getConfig();
      if (!isAllowed(phost, cfg)) {
        await pinDomain(phost, "proxy-bypass", 1);
        blockTab(details.tabId, phost, "proxy-bypass", "proxy");
        return;
      }
    }
  }

  if (details.frameId !== 0) return;
  const hostname = hostnameOf(details.url);
  if (!hostname) return;
  lastRealHost.set(details.tabId, hostname); // remember for about:blank attribution

  const cfg = await getConfig();
  if (isAllowed(hostname, cfg)) return;

  const extra = extraBlocked(hostname, cfg);
  if (extra) {
    blockTab(details.tabId, extra, "district-policy");
    return;
  }

  // Re-visit to a domain the model blocked earlier — block before it loads.
  const pins = await loadPins();
  const ph = pinnedHit(hostname, pins);
  if (ph) {
    const info = pins.get(ph);
    blockTab(details.tabId, ph, info.category, "model", info.confidence);
    return;
  }

  await ensureLoaded();
  const hit = check(hostname);
  if (hit) blockTab(details.tabId, hit.domain, hit.category, "list");
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
  if (hit) blockTab(details.tabId, hit.domain, hit.category, "list");
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
    await ensureModelLoaded();
  } catch (e) {
    console.error("[fenceline] initial sync failed", e);
  }
});

chrome.runtime.onStartup.addListener(async () => {
  await scheduleSync();
  ensureLoaded();
  ensureModelLoaded();
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
      await ensureModelLoaded();
      sendResponse({
        ready: isReady(),
        tailSize: listSize(),
        modelReady: isModelReady(),
        modelVersion: modelVersion(),
        modelEnabled: cfg.contentModelEnabled,
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
      // Rate-limit manual checks so the button can't be spammed into hammering
      // the list host. Enforced in the service worker (not just the UI) so a
      // page reload can't bypass it.
      const FORCE_COOLDOWN_MS = 60000;
      const { lastForcedCheck = 0 } = await chrome.storage.local.get(["lastForcedCheck"]);
      const since = Date.now() - lastForcedCheck;
      if (since < FORCE_COOLDOWN_MS) {
        sendResponse({
          synced: false,
          reason: "cooldown",
          retryInSec: Math.ceil((FORCE_COOLDOWN_MS - since) / 1000)
        });
      } else {
        await chrome.storage.local.set({ lastForcedCheck: Date.now() });
        try {
          sendResponse(await checkAndSync(true));
        } catch (e) {
          sendResponse({ synced: false, error: String(e) });
        }
      }
    } else if (msg.type === "scanPage") {
      // Tier 3: a content script sent this page's rendered text. Score it and
      // block if a blocked category clears the confidence threshold.
      const cfg = await getConfig();
      // about:blank (in-page proxy) has no hostname — attribute to the real
      // host the tab came from.
      let hostname = hostnameOf(msg.url);
      if (!hostname && sender.tab) hostname = lastRealHost.get(sender.tab.id) || null;
      if (!cfg.contentModelEnabled || !hostname || isAllowed(hostname, cfg)) {
        sendResponse({ blocked: false });
        return;
      }
      await ensureModelLoaded();
      if (!isModelReady()) {
        sendResponse({ blocked: false });
        return;
      }
      const doc = `${msg.title || ""} ${msg.meta || ""} ${msg.text || ""}`;
      const verdict = decide(doc, cfg.contentModelThreshold);
      if (verdict && sender.tab) {
        await pinDomain(hostname, verdict.category, verdict.confidence);
        blockTab(sender.tab.id, hostname, verdict.category, "model", verdict.confidence);
        sendResponse({ blocked: true });
      } else {
        sendResponse({ blocked: false });
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
