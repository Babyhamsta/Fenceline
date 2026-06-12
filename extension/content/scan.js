// Tier 3 content scan. Runs after a top-frame page settles, extracts the same
// rendered fields the model was trained on (title + meta description/og + body
// text, capped, data: URIs stripped), and hands them to the service worker to
// score. The worker owns the model and decides whether to block — this script
// never sees the weights and does nothing with the response (a block is a tab
// redirect the worker performs). Kept deliberately tiny: it must not jank the
// page it runs on.

(() => {
  if (window.top !== window) return; // top frame only
  const proto = location.protocol;
  if (proto !== "http:" && proto !== "https:") return;

  const TEXT_TOKEN_CAP = 400; // mirrors classifier/extract.py
  const DATA_URI = /data:[^\s'"<>]+/gi;

  function clean(s) {
    return (s || "").replace(DATA_URI, " ").replace(/\s+/g, " ").trim();
  }

  function extract() {
    const title = clean(document.title);
    const descEl = document.querySelector('meta[name="description"]');
    const desc = (descEl && descEl.getAttribute("content")) || "";
    // og:* minus the URL/media ones (those are links, not useful text)
    const og = [...document.querySelectorAll('meta[property^="og:"]')]
      .filter((m) => !/^og:(image|video|audio|url)/i.test(m.getAttribute("property") || ""))
      .map((m) => m.getAttribute("content") || "")
      .join(" ");
    const meta = clean(desc + " " + og);
    const body = document.body ? document.body.innerText : "";
    const text = clean(body).split(" ").slice(0, TEXT_TOKEN_CAP).join(" ");
    return { url: location.href, title, meta, text };
  }

  function run() {
    const rec = extract();
    // Thin/blank pages carry no signal — don't bother the worker.
    if (rec.text.split(" ").length < 20) return;
    rec.type = "scanPage";
    try {
      chrome.runtime.sendMessage(rec, () => void chrome.runtime.lastError);
    } catch {
      // Extension context can be gone mid-navigation; ignore.
    }
  }

  // document_idle already means the DOM is ready; a short extra wait lets
  // client-rendered (SPA) pages hydrate before we read their text.
  setTimeout(run, 1200);
})();
