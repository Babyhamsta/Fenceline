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

(() => {
  if (window.top !== window) return; // top frame only
  const proto = location.protocol;
  if (proto !== "http:" && proto !== "https:" && proto !== "about:") return;

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
    const text = clean(body).split(" ").slice(0, TEXT_TOKEN_CAP).join(" ");
    return { type: "scanPage", url: location.href, title, meta, text };
  }

  async function doScan() {
    if (scans >= MAX_SCANS) return stop();
    const rec = extract();
    if (rec.text.split(" ").length < 20) return; // thin/blank — no signal
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
