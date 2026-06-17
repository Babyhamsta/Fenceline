// Tier 3 content scan. Extracts the same rendered fields the model was trained
// on (title + meta + body text, capped, data: URIs stripped) and hands them to
// the service worker to score. The worker owns the model and decides whether to
// block — this script never sees the weights.
//
// Also scans about:blank: in-page "browser" proxies (Scramjet/Ultraviolet —
// cherrion.top et al.) render the real page into an about:blank top document,
// so http/https-only scanning would miss them. Their content swaps in place as
// you navigate, so we re-scan on DOM changes — but heavily throttled
// (debounce + cooldown + per-page cap + skip-if-unchanged) so a busy or
// adversarial page can't spin the model and pin the CPU.

/* global fencelineExtractStructural */
(() => {
  const proto = location.protocol;
  if (proto !== "http:" && proto !== "https:" && proto !== "about:") return;

  // Sub-frames: only scan ones SAME-ORIGIN to their parent. A web proxy serves
  // the forbidden site same-origin under its own host, so the proxied content is
  // reachable here — while every cross-origin third-party embed (ads, trackers,
  // widgets) is structurally skipped. Behaviour, not name lists. The SIZE gate
  // (proxied content fills the view; widgets don't) is applied at scan time, not
  // here, because these in-page browsers show/grow the content frame after load.
  const isSubframe = window.top !== window;
  if (isSubframe) {
    let sameOrigin = false;
    try {
      void window.parent.location.href;
      sameOrigin = true;
    } catch (e) {
      sameOrigin = false;
    }
    if (!sameOrigin) return;
  }

  const TEXT_TOKEN_CAP = 400; // mirrors classifier/extract.py
  const DATA_URI = /data:[^\s'"<>]+/gi;
  const COOLDOWN_MS = 4000; // minimum gap between scans (CPU guard)
  const SETTLE_MS = 1200; // wait for content to settle after a change
  const MAX_SCANS = 12; // hard per-page cap — anti-spam backstop

  let lastText = "";
  let lastScanAt = 0;
  let scans = 0;
  let timer = null;
  let busy = false;
  let observer = null;

  const clean = (s) => (s || "").replace(DATA_URI, " ").replace(/\s+/g, " ").trim();

  function extract() {
    const title = clean(document.title);
    const descEl = document.querySelector('meta[name="description"]');
    const desc = (descEl && descEl.getAttribute("content")) || "";
    const og = [...document.querySelectorAll('meta[property^="og:"]')]
      .filter((m) => !/^og:(image|video|audio|url)/i.test(m.getAttribute("property") || ""))
      .map((m) => m.getAttribute("content") || "")
      .join(" ");
    const meta = clean(desc + " " + og);
    const body = document.body ? document.body.innerText : "";
    // Cap by tokens AND by chars: a glyph-cipher page (DaydreamX) maps spaces
    // away, so it's one space-less mega-token — the char cap bounds it.
    const text = clean(body).split(" ").slice(0, TEXT_TOKEN_CAP).join(" ").slice(0, 4000);
    const lang = (document.documentElement.getAttribute("lang") || "").slice(0, 16);
    // Structural features (the is-vs-about sensor). Computed by the shared
    // extractor loaded just before this script (content/structural-features.js)
    // — the SAME source the training scraper injects, so device and corpus
    // vectors match by construction. Guarded: a structural failure must never
    // break the text scan.
    let structural = null;
    try {
      if (typeof fencelineExtractStructural === "function")
        structural = fencelineExtractStructural();
    } catch {
      structural = null;
    }
    return { type: "scanPage", url: location.href, title, meta, text, lang, structural };
  }

  async function doScan() {
    if (scans >= MAX_SCANS) return stop();
    // Size gate (sub-frames only) evaluated NOW, so a content frame that was
    // hidden/unsized at load but is large now still gets scanned.
    if (isSubframe && (window.innerWidth < 500 || window.innerHeight < 380)) return;
    const rec = extract();
    // Thin/blank gate, mirrored byte-for-byte in classifier/filtering.py
    // (MIN_BODY_CHARS=80, MIN_META_TOKENS=6). Keep if the body carries real text
    // OR the title+meta do: an interior game page is often one canvas element
    // (empty body) under a loud title + og:description, and that signal is real.
    // Body counts non-space CHARS, not space-tokens — a glyph-cipher page maps
    // spaces away, so token-counting would wrongly read it as empty.
    const bodyChars = rec.text.replace(/\s+/g, "").length;
    const metaTokens = (rec.title + " " + rec.meta).trim().split(/\s+/).filter(Boolean).length;
    if (bodyChars < 80 && metaTokens < 6) return;
    if (rec.text === lastText) return; // content unchanged since last scan
    lastText = rec.text;
    lastScanAt = Date.now();
    scans++;
    busy = true;
    try {
      await chrome.runtime.sendMessage(rec); // worker blocks the tab if needed
    } catch {
      // extension context gone mid-navigation — stop trying
      stop();
    } finally {
      busy = false;
    }
  }

  // Debounce content changes, but never scan more often than COOLDOWN_MS.
  function schedule() {
    if (timer) clearTimeout(timer);
    const wait = Math.max(SETTLE_MS, COOLDOWN_MS - (Date.now() - lastScanAt));
    timer = setTimeout(() => {
      timer = null;
      if (busy) schedule();
      else doScan();
    }, wait);
  }

  function stop() {
    if (timer) clearTimeout(timer);
    if (observer) observer.disconnect();
    observer = null;
  }

  function startObserving() {
    if (!document.body || observer) return;
    observer = new MutationObserver(schedule);
    observer.observe(document.body, { childList: true, subtree: true, characterData: true });
  }

  // First scan after the page settles, then throttled re-scans on content swaps.
  setTimeout(() => {
    doScan();
    startObserving();
  }, SETTLE_MS);
  if (!document.body) addEventListener("DOMContentLoaded", startObserving);
})();
