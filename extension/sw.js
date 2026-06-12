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

// MV3 suspends idle service workers (~30 s) and SW globals are then lost. If a
// scanPage hit from an about:blank in-page proxy arrives after a restart with
// an empty lastRealHost, hostnameOf("about:blank") is null and the block is
// silently skipped — leaving the in-page-proxy case (which the README
// advertises as covered) intermittently uncovered. Mirror the Map into
// chrome.storage.session: it survives SW restarts, dies with the browser
// session, and never hits disk — consistent with the privacy posture. The Map
// stays a write-through cache; hydrate lazily before any read, persist debounced
// on every update. (recentBlocks is fine to lose — at worst one duplicate log.)
let _lrhHydrated = null;
function hydrateLastRealHost() {
  if (!_lrhHydrated) {
    _lrhHydrated = chrome.storage.session
      .get("lastRealHost")
      .then(({ lastRealHost: stored }) => {
        if (stored) {
          for (const [k, v] of Object.entries(stored)) {
            const tid = Number(k);
            if (!lastRealHost.has(tid)) lastRealHost.set(tid, v); // live updates win
          }
        }
      })
      .catch(() => {});
  }
  return _lrhHydrated;
}
let _lrhTimer = null;
function persistLastRealHost() {
  if (_lrhTimer) return; // debounce: coalesce bursts of nav events into one write
  _lrhTimer = setTimeout(() => {
    _lrhTimer = null;
    chrome.storage.session.set({ lastRealHost: Object.fromEntries(lastRealHost) }).catch(() => {});
  }, 500);
}
function setLastRealHost(tabId, hostname) {
  lastRealHost.set(tabId, hostname);
  persistLastRealHost();
}

chrome.tabs.onRemoved.addListener((tabId) => {
  lastRealHost.delete(tabId);
  recentBlocks.delete(tabId);
  persistLastRealHost();
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

// A loaded page can mount a beforeunload "Leave site?" trap to veto our
// redirect (proxies do this). For post-load blocks we therefore force-replace
// the tab — chrome.tabs.remove is programmatic and bypasses the dialog — instead
// of navigating it. Pre-load blocks (list tier, pins) navigate in place to keep
// "Go back" working.
async function forceReplaceTab(tabId, url) {
  // Flip the MAIN-world guard (content/unload-guard.js) so the page's
  // beforeunload trap can't veto the navigation, then redirect in place.
  try {
    await chrome.scripting.executeScript({
      target: { tabId, allFrames: true },
      world: "MAIN",
      func: () => {
        window.__fenceline_suppress = true;
      }
    });
  } catch (e) {
    // Restricted page or no scripting access — still attempt the redirect.
  }
  try {
    await chrome.tabs.update(tabId, { url });
  } catch (e) {
    // Tab may already be gone.
  }
}

// source: "list" (DNR/tail), "model" (content classifier), "proxy",
// "district-policy". confidence (0..1) is set only for model blocks.
async function blockTab(tabId, domain, category, source = "list", confidence = null, force = false) {
  if (tabId == null || tabId < 0) return;
  if (shouldLog(tabId, domain)) recordBlock(domain, category, source);
  let url =
    chrome.runtime.getURL("block/block.html") +
    `?d=${encodeURIComponent(domain)}&c=${encodeURIComponent(category)}` +
    `&s=${encodeURIComponent(source)}`;
  if (confidence != null) url += `&conf=${Math.round(confidence * 100)}`;
  if (force) {
    await forceReplaceTab(tabId, url);
  } else {
    try {
      await chrome.tabs.update(tabId, { url });
    } catch (e) {
      // Tab may already be gone.
    }
  }
}

// Domains the model has blocked before are pinned locally so a re-visit is
// blocked at navigation time (no second-load flash, no re-scan).
let pinned = null; // Map<registrableDomain, {category, confidence}>
const PIN_CAP = 2000;

// Hosts that render MANY independent sites' content under one origin
// (path-multitenant). We still block the specific harmful page (content scan
// re-runs every visit), but never PIN the bare host — pinning would over-block
// the whole service: pinning sites.google.com kills all Google Sites; pinning
// web.archive.org kills the Wayback Machine for legit research. A blocked game
// reached *via* archive.org/translate is still blocked on that visit; the
// origin stays usable. Suffix-matched, so subdomains are covered.
const NO_PIN_HOSTS = new Set([
  // Google path-multitenant hosts.
  "sites.google.com",
  "script.google.com",
  "storage.googleapis.com",
  "docs.google.com",
  "drive.google.com",
  "translate.google.com",
  "webcache.googleusercontent.com",
  // Archival / cache / reader services — they serve other sites' content.
  "archive.org",
  "archive.ph",
  "archive.today",
  "archive.is",
  "archive.li",
  "archive.vn",
  "archive.fo",
  "cachedview.nl",
  "r.jina.ai",
  "12ft.io",
  // Public code CDNs — anyone can host a file/app here.
  "jsdelivr.net",
  "githack.com",
  "statically.io",
  "raw.githubusercontent.com",
  "gitcdn.link",
  "gitcdn.xyz"
]);

function isNoPinHost(host) {
  const h = host.toLowerCase();
  for (const d of NO_PIN_HOSTS) if (h === d || h.endsWith("." + d)) return true;
  return false;
}

async function loadPins() {
  if (pinned) return pinned;
  const { modelPinned = {} } = await chrome.storage.local.get(["modelPinned"]);
  pinned = new Map(Object.entries(modelPinned));
  return pinned;
}

async function pinDomain(domain, category, confidence) {
  if (isNoPinHost(domain)) return; // block the page, but don't over-block the host
  const p = await loadPins();
  if (p.has(domain)) return;
  p.set(domain, { category, confidence });
  // Evict from the Map itself (FIFO, insertion order) BEFORE serializing.
  // Trimming only the serialized object left the in-memory Map untrimmed, so
  // the next write re-serialized the full Map and resurrected every evicted
  // entry — the cap held for one write, then storage grew unbounded.
  while (p.size > PIN_CAP) p.delete(p.keys().next().value);
  const obj = Object.fromEntries(p);
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
  let s = seg;
  try {
    s = decodeURIComponent(seg); // tolerate %3D padding (Ultraviolet's base64 codec)
  } catch {
    // leave as-is
  }
  if (s.length < 24 || !/^[A-Za-z0-9+/=_-]+$/.test(s)) return false;
  try {
    const decoded = atob(s.replace(/-/g, "+").replace(/_/g, "/"));
    if (!/^https?:\/\//i.test(decoded)) return false;
    new URL(decoded); // must be a COMPLETE, parseable URL — kills partial/contrived false positives
    return true;
  } catch {
    return false;
  }
}
function looksLikeProxyUrl(url) {
  try {
    const rawPath = new URL(url).pathname;
    const path = rawPath.toLowerCase();
    // Percent-encoded target (Scramjet & most): /scramjet/https%3A%2F%2Ftarget…
    if (path.includes("https%3a%2f%2f") || path.includes("http%3a%2f%2f")) return true;
    // Base64-encoded target (Ultraviolet / Bare service path): /service/aHR0cHM6Ly8…
    for (const seg of rawPath.split("/")) if (_decodesToUrl(seg)) return true;
    // NOTE: a PLAIN "/https:/<target>" in the path is deliberately NOT treated as
    // a proxy tell. Legit archival/reader services embed the target URL plainly
    // (web.archive.org, archive.ph, r.jina.ai, outline.com, cloudinary
    // image/fetch) — stress-tested as 7/7 false positives. Real proxies percent-
    // or base64-encode the target (handled above); an oddball plain-path proxy
    // is still caught by the content scan and x-bare tiers.
    return false;
  } catch {
    return false;
  }
}


// ---- Tier 3b: glyph-cipher (font-substitution) obfuscation -------------
// Some proxies (e.g. DaydreamX's font obfuscator) defeat the content model by
// replacing every character in the DOM with a mapped character from a DIFFERENT
// Unicode script, then rendering it back to the original glyphs with a custom
// webfont. The page looks normal, but innerText is gibberish in the wrong
// script, so the model has nothing to score. We turn that against them by
// BEHAVIOUR, not names: a page that renders its text in a script contradicting
// its declared language — or in the Private Use Area, which is never legitimate
// body text — is running such a cipher. Robust because the cipher codepoints
// MUST be present in the DOM for the page to render, so a content script always
// sees them regardless of how the font/script files are named or obfuscated.
const LATIN_LANGS = new Set([
  "en", "es", "fr", "de", "pt", "it", "nl", "sv", "da", "no", "nb", "nn", "fi",
  "is", "pl", "cs", "sk", "sl", "hr", "ro", "hu", "tr", "et", "lv", "lt", "ga",
  "cy", "ca", "gl", "eu", "af", "sw", "id", "ms", "tl", "vi", "lb", "mt"
]);
function langIsLatinScript(lang) {
  if (!lang) return false;
  const p = String(lang).toLowerCase().split(/[-_]/)[0];
  return LATIN_LANGS.has(p); // validated against a real list, not "anything not non-Latin"
}
function classifyCp(cp) {
  if ((cp >= 0x41 && cp <= 0x5a) || (cp >= 0x61 && cp <= 0x7a)) return "ascii";
  if (cp >= 0x30 && cp <= 0x39) return "digit";
  if (cp < 0x80) return null; // ASCII punctuation / whitespace / control
  // Large-alphabet scripts: legit prose uses hundreds+ of distinct codepoints.
  if ((cp >= 0x3400 && cp <= 0x9fff) || (cp >= 0xf900 && cp <= 0xfaff) || (cp >= 0x20000 && cp <= 0x2fa1f)) return "han";
  if (cp >= 0xac00 && cp <= 0xd7a3) return "hangul";
  // Private Use Area (icon fonts and PUA ciphers).
  if ((cp >= 0xe000 && cp <= 0xf8ff) || (cp >= 0xf0000 && cp <= 0xffffd) || (cp >= 0x100000 && cp <= 0x10fffd)) return "pua";
  if (cp >= 0x2000 && cp <= 0x206f) return null; // general punctuation
  if (cp >= 0x2190 && cp <= 0x2bff) return null; // arrows / symbols / dingbats
  if (cp >= 0x1f000 && cp <= 0x1ffff) return null; // emoji
  if (cp >= 0xfe00 && cp <= 0xfe0f) return null; // variation selectors
  return "small"; // any other non-ASCII letter (Cyrillic/Greek/Latin-Ext/Arabic/…)
}
// True if `text` is glyph-substitution-cipher obfuscation. The robust invariant
// is statistical, not script-specific: a cipher draws a long body of text from a
// fixed ≤~95-char source alphabet, so its DISTINCT codepoint count saturates
// while real prose keeps introducing new characters. `distinct*2 < count` =
// heavy repetition of a tiny alphabet — which real Han/Hangul/PUA content never
// shows. Lang-agnostic, so it can't be evaded by spoofing the lang attribute.
function detectGlyphCipher(text, lang) {
  if (!text) return false;
  let ascii = 0, digit = 0, han = 0, hangul = 0, small = 0, pua = 0;
  const dHan = new Set(), dHangul = new Set(), dPua = new Set();
  for (const ch of text) {
    const cp = ch.codePointAt(0);
    switch (classifyCp(cp)) {
      case "ascii": ascii++; break;
      case "digit": digit++; break;
      case "han": han++; dHan.add(cp); break;
      case "hangul": hangul++; dHangul.add(cp); break;
      case "pua": pua++; dPua.add(cp); break;
      case "small": small++; break;
    }
  }
  const nonAscii = han + hangul + small + pua;
  const total = ascii + nonAscii;
  if (total < 80) return false; // too little text to judge

  // Layer A — large-alphabet substitution (CJK ideographs / Hangul / PUA). The
  // ratio guard separates a cipher (distinct saturates ~94) from real prose
  // (distinct grows with length) at any length, and from icon fonts (each glyph
  // used ~once → fails the ratio; too few distinct → fails the >=15 floor).
  if (han >= 180 && dHan.size <= 100 && dHan.size * 2 < han && han >= 0.6 * total) return true;
  if (hangul >= 180 && dHangul.size <= 100 && dHangul.size * 2 < hangul && hangul >= 0.6 * total) return true;
  if (pua >= 150 && dPua.size >= 15 && dPua.size <= 100 && dPua.size * 2 < pua && pua >= 0.6 * total) return true;

  // Layer B — SMALL-alphabet scripts only (Cyrillic/Greek/Latin-Ext/…), where
  // distinct-count can't separate cipher from prose. Conservative lang mismatch:
  // declares a Latin-script language but renders almost entirely in a small
  // non-Latin script with no ASCII letters or digits (real foreign pages
  // sprinkle numerals and brand names). Han/Hangul/PUA are Layer A's job, so a
  // mislabeled-lang Chinese/Korean/icon page is NOT caught here.
  if (langIsLatinScript(lang) && small >= 80 && small > 0.9 * total && ascii === 0 && digit === 0) return true;

  return false;
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
  await hydrateLastRealHost(); // SW may have just restarted; restore attribution map
  // Tier 4 runs on EVERY frame: a proxy-engine URL anywhere in the tab means
  // the host serving it is a web proxy — block & pin it on first use.
  if (looksLikeProxyUrl(details.url)) {
    const phost = hostnameOf(details.url) || lastRealHost.get(details.tabId);
    if (phost && (await blockProxyHost(phost, details.tabId, false))) return;
  }

  if (details.frameId !== 0) return;
  const hostname = hostnameOf(details.url);
  if (!hostname) return;
  setLastRealHost(details.tabId, hostname); // remember for about:blank attribution

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

// ---- Tier 4b: web-proxy WIRE PROTOCOL ----------------------------------
// The Bare protocol (used by Ultraviolet and most modern proxies) tunnels the
// real target in x-bare-* request headers. This is the transport contract — it
// survives renaming the client JS, obfuscating the code, and XOR-encoding the
// visible path, because the bare server still has to be told what to fetch.
// No legitimate site sends x-bare-* headers, so this is robust AND low-FP.
async function blockProxyHost(host, tabId, pin = true) {
  await hydrateLastRealHost(); // tabless path below scans the attribution map
  const cfg = await getConfig();
  if (isAllowed(host, cfg)) return false;
  // URL-path hits pass pin=false: that signal is stateless (re-fires on every
  // navigation), and pinning a shared image CDN that merely embeds an encoded
  // URL in its path (Cloudflare/Cloudinary/imgproxy) would block it forever.
  if (pin) await pinDomain(host, "proxy-bypass", 1);
  if (tabId >= 0) {
    blockTab(tabId, host, "proxy-bypass", "proxy", null, true);
  } else {
    // Request came from the proxy's service worker (no tab) — replace whatever
    // tab is sitting on that host.
    for (const [tid, h] of lastRealHost) if (h === host) blockTab(tid, host, "proxy-bypass", "proxy", null, true);
  }
  return true;
}

chrome.webRequest.onBeforeSendHeaders.addListener(
  (details) => {
    const headers = details.requestHeaders || [];
    if (!headers.some((h) => h.name.toLowerCase().startsWith("x-bare-"))) return;
    const host = (details.initiator && hostnameOf(details.initiator)) || hostnameOf(details.url);
    if (host) blockProxyHost(host, details.tabId);
  },
  { urls: ["*://*/*"], types: ["xmlhttprequest", "websocket", "other"] },
  ["requestHeaders"]
);

// ---- Tier 4c: app smuggled as an SVG document --------------------------
// A top-level navigation whose RESPONSE is image/svg+xml is not normal
// browsing — it's the "serve a whole app inside <svg><foreignObject>" trick
// (DaydreamX et al.) used to host a web proxy under an innocent .svg extension
// on a public code CDN (jsDelivr / githack / statically). We judge it on the
// HTTP Content-Type, which the page author cannot obfuscate without abandoning
// the technique — so this fires BEFORE the page's scripts run and is immune to
// its shuffled script names, glyph-obfuscated fonts, anti-debugger traps, and
// console hijacking (none of which have executed at header time).
//
// We block but do NOT pin: the host is shared CDN infrastructure (pinning
// cdn.jsdelivr.net would over-block a legit CDN), and this header check is
// stateless — it re-fires on every visit, so no pin is needed. A district can
// still allowlist a host that legitimately serves top-level SVGs.
chrome.webRequest.onHeadersReceived.addListener(
  (details) => {
    if (details.type !== "main_frame" || details.tabId < 0) return;
    const ct = (details.responseHeaders || []).find((h) => h.name.toLowerCase() === "content-type");
    if (!ct || !/image\/svg\+xml/i.test(ct.value || "")) return;
    maybeBlockSvgApp(details.url, details.tabId);
  },
  { urls: ["*://*/*"], types: ["main_frame"] },
  ["responseHeaders"]
);

// A static SVG image is harmless; an SVG carrying a <foreignObject> is HTML
// smuggled inside an image — the "app-as-image" trick. Fetch the (already-
// cached) body and block ONLY when foreignObject is present, so legit top-level
// SVGs (logos, badges, diagrams) are never touched. Stress-tested: 4 real SVGs
// had 0 foreignObject; DaydreamX's index.svg had 2. We block but don't pin —
// the host is shared CDN infrastructure and this check re-fires every visit.
async function maybeBlockSvgApp(url, tabId) {
  const host = hostnameOf(url);
  if (!host) return;
  const cfg = await getConfig();
  if (isAllowed(host, cfg)) return;
  let body;
  try {
    const buf = new Uint8Array(await (await fetch(url, { credentials: "omit" })).arrayBuffer());
    // .svgz / gzip body fetch() didn't transparently inflate (no Content-Encoding):
    // decompress first, else the gzip bytes hide the markup.
    if (buf[0] === 0x1f && buf[1] === 0x8b && typeof DecompressionStream !== "undefined") {
      const stream = new Blob([buf]).stream().pipeThrough(new DecompressionStream("gzip"));
      body = await new Response(stream).text();
    } else {
      body = new TextDecoder("utf-8").decode(buf);
    }
  } catch (e) {
    return; // can't read/inflate — fail open rather than risk a false positive on a real image
  }
  body = body.slice(0, 512 * 1024); // bound the scan
  // Namespace-aware (<svg:foreignObject> is legal in XML-served SVG).
  if (!/<([a-z0-9]+:)?foreignObject[\s/>]/i.test(body)) return;
  // A static diagram export (Mermaid, draw.io, svg-term) also wraps HTML labels
  // in <foreignObject> — but carries no EXECUTABLE script and no embedded frame.
  // Only block when the SVG also runs JS or hosts a browsing context: that's a
  // smuggled app, not vector art.
  if (!svgHasExecutableContent(body)) return;
  console.log("[fenceline] blocked app-as-SVG:", host);
  blockTab(tabId, host, "proxy-bypass", "proxy", null, true);
}

// Executable JavaScript or an embedded browsing context inside the SVG — the
// markers of a smuggled app. Inert data scripts (MathJax type="math/…",
// application/json, text/x-…) and label-only foreignObject are ignored.
function svgHasExecutableContent(body) {
  if (/<([a-z0-9]+:)?(iframe|embed|object)[\s/>]/i.test(body)) return true;
  const re = /<([a-z0-9]+:)?script\b([^>]*)>/gi;
  let m;
  while ((m = re.exec(body))) {
    const tm = (m[2] || "").match(/\btype\s*=\s*["']?\s*([^"'\s>]+)/i);
    if (!tm) return true; // no type attribute → executable JS by default
    const t = tm[1].toLowerCase();
    if (t === "module" || t === "text/javascript" || t === "application/javascript" || /(^|\/)(java|ecma)script$/.test(t)) {
      return true;
    }
  }
  return false;
}

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
      // A sub-frame's own URL is untrustworthy (a proxy spoofs it / about:blank
      // has none), so a sub-frame hit is attributed to the real host the tab
      // came from — i.e. the proxy serving it. Top-frame hits use the page URL.
      const isSub = sender.frameId !== 0;
      const tabId = sender.tab && sender.tab.id;
      let hostname = isSub ? null : hostnameOf(msg.url);
      if (!hostname && tabId != null) {
        await hydrateLastRealHost(); // about:blank proxy attribution after a SW restart
        hostname = lastRealHost.get(tabId) || hostnameOf(msg.url);
      }
      if (!hostname || isAllowed(hostname, cfg)) {
        sendResponse({ blocked: false });
        return;
      }
      // Glyph-cipher obfuscation is an evasion tell, not a content category, so
      // block it as proxy-bypass even when the content model is disabled.
      if (detectGlyphCipher(msg.text || "", msg.lang)) {
        if (!isSub) await pinDomain(hostname, "proxy-bypass", 1);
        blockTab(tabId, hostname, "proxy-bypass", "proxy", null, true);
        sendResponse({ blocked: true });
        return;
      }
      if (!cfg.contentModelEnabled) {
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
        // Pin only top-frame hits (the site's own content). A sub-frame hit
        // blocks this visit but isn't pinned — a proxy just re-flags next time,
        // while a legit page with one large same-origin section isn't broken
        // forever.
        if (!isSub) await pinDomain(hostname, verdict.category, verdict.confidence);
        blockTab(tabId, hostname, verdict.category, "model", verdict.confidence, true);
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
