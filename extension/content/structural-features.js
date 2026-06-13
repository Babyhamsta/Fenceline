// Shared structural-feature extractor — the "what the page IS and DOES" sensor
// that the lexical model can't fake. A page *about* X never instantiates X's
// functional element (a proxy's URL box, a game's canvas, a video player), so
// these scalars separate "IS X" from "is ABOUT X" where bag-of-words cannot.
//
// ONE source of truth, run in two places:
//   - live, on-device: extension/content/scan.js calls fencelineExtractStructural()
//   - offline, at scrape time: classifier/render.py injects THIS file's source
//     into its Playwright page.evaluate, then calls the same function.
// Because every numeric/boolean feature is computed HERE in JS, the training
// corpus and the device compute byte-identical vectors by construction — there
// is no Python-side feature math to drift out of sync. render.py/scan.js store
// or forward the returned dict verbatim.
//
// Pure DOM reads, no imports, no allocation beyond small temporaries; intended
// to run in a couple ms. Self-contained so it can be string-injected into a
// bare page context (no module system available there).

function fencelineExtractStructural() {
  // ---- helpers (kept inside the function so the whole thing injects cleanly) --
  // Registrable-domain heuristic: last two labels. Imperfect for multi-part
  // suffixes (co.uk) but identical on both sides, which is what parity needs —
  // it's a feature input, not a security boundary.
  const regDomain = (host) => {
    const parts = (host || "").toLowerCase().split(".").filter(Boolean);
    return parts.length <= 2 ? parts.join(".") : parts.slice(-2).join(".");
  };
  const area = (el) => {
    try {
      const r = el.getBoundingClientRect();
      return Math.max(0, r.width) * Math.max(0, r.height);
    } catch {
      return 0;
    }
  };

  const vw = Math.max(1, window.innerWidth || 0);
  const vh = Math.max(1, window.innerHeight || 0);
  const viewportArea = vw * vh;

  let locHost = "";
  try {
    locHost = location.hostname || "";
  } catch {
    locHost = "";
  }
  const locReg = regDomain(locHost);

  // ---- prose vs. chrome structure ------------------------------------------
  const bodyText = document.body ? document.body.innerText || "" : "";
  const bodyChars = Math.max(1, bodyText.length);

  const anchors = [...document.querySelectorAll("a[href]")];
  let anchorTextChars = 0;
  let internalLinks = 0;
  let totalResolvable = 0;
  const externalRegs = new Set();
  for (const a of anchors) {
    anchorTextChars += (a.innerText || "").length;
    let host = "";
    try {
      host = new URL(a.href, location.href).hostname;
    } catch {
      continue; // unparseable / javascript: / mailto: — not a navigable link
    }
    if (!host) continue;
    totalResolvable++;
    const reg = regDomain(host);
    if (reg && reg === locReg) internalLinks++;
    else if (reg) externalRegs.add(reg);
  }
  // Kohlschütter (WSDM 2010) boilerplate threshold is 0.33: articles sit below,
  // link hubs / SERPs / portals sit well above.
  const linkDensity = anchorTextChars / bodyChars;
  const internalLinkRatio = totalResolvable ? internalLinks / totalResolvable : 0;

  let paragraphCount = 0;
  for (const p of document.querySelectorAll("p")) {
    if ((p.innerText || "").trim().length > 40) paragraphCount++;
  }

  const domNodeCount = document.getElementsByTagName("*").length;
  const textToTagRatio = bodyText.length / Math.max(1, domNodeCount);

  // ---- functional-element presence (the is-vs-about core) ------------------
  const inputs = [...document.querySelectorAll("input")];
  // has_url_like_input: a box meant to take a destination URL (proxy address
  // bar). EXCLUDE search boxes — a site search shares the shape but not the
  // function, and conflating them turns a Google-Sites page into a false block.
  let hasUrlLikeInput = false;
  for (const el of inputs) {
    const type = (el.getAttribute("type") || "text").toLowerCase();
    if (type === "search" || type === "hidden" || type === "password") continue;
    const role = (el.getAttribute("role") || "").toLowerCase();
    if (role === "search") continue;
    const idattrs = [
      el.getAttribute("name") || "",
      el.getAttribute("id") || "",
      el.getAttribute("placeholder") || "",
      el.getAttribute("aria-label") || ""
    ]
      .join(" ")
      .toLowerCase();
    // search synonyms anywhere in the identifying attrs -> treat as a search box
    if (/\bq\b|query|search|find/.test(idattrs)) continue;
    const looksUrl = /\b(url|http|https|site|address|proxy|website|link)\b/.test(idattrs);
    let valueIsUrl = false;
    try {
      const v = (el.value || "").trim();
      if (v) {
        valueIsUrl = /^https?:\/\//i.test(v) || /^[\w-]+(\.[\w-]+)+/.test(v);
      }
    } catch {
      valueIsUrl = false;
    }
    if (looksUrl || valueIsUrl) {
      hasUrlLikeInput = true;
      break;
    }
  }

  // url_embeds_url: the Layer-4 proxy tell — the target URL carried in our own
  // path, percent- or base64-encoded. Mirrors extension/lib/detect/proxy-url.js
  // (kept inline so this file injects standalone). A page about proxies never
  // has its own URL shaped this way.
  const urlEmbedsUrl = (() => {
    let rawPath = "";
    try {
      rawPath = new URL(location.href).pathname;
    } catch {
      return false;
    }
    const low = rawPath.toLowerCase();
    if (low.includes("https%3a%2f%2f") || low.includes("http%3a%2f%2f")) return true;
    for (const seg of rawPath.split("/")) {
      let s = seg;
      try {
        s = decodeURIComponent(seg);
      } catch {
        /* keep raw */
      }
      if (s.length < 24 || !/^[A-Za-z0-9+/=_-]+$/.test(s)) continue;
      try {
        const decoded = atob(s.replace(/-/g, "+").replace(/_/g, "/"));
        if (/^https?:\/\//i.test(decoded)) {
          new URL(decoded);
          return true;
        }
      } catch {
        /* not base64 / not a url */
      }
    }
    return false;
  })();

  // canvas: a game's surface. cherrion-style proxies also render full-canvas, so
  // dominant-canvas is required in the prose-rescue guard, not just a game tell.
  let maxCanvasArea = 0;
  for (const c of document.querySelectorAll("canvas")) {
    const a = area(c);
    if (a > maxCanvasArea) maxCanvasArea = a;
  }
  const canvasAreaFraction = Math.min(4, maxCanvasArea / viewportArea);
  const hasDominantCanvas = canvasAreaFraction > 0.5;

  const hasVideoPlayer = document.querySelector("video") !== null;

  // iframes: large cross-origin frame = embedded game / casino / media surface.
  const iframes = [...document.querySelectorAll("iframe")];
  let maxIframeArea = 0;
  let iframeCrossOrigin = false;
  let largeXOriginIframe = false;
  for (const f of iframes) {
    const a = area(f);
    if (a > maxIframeArea) maxIframeArea = a;
    let host = "";
    try {
      host = new URL(f.src, location.href).hostname;
    } catch {
      continue;
    }
    if (host && regDomain(host) !== locReg) {
      iframeCrossOrigin = true;
      if (a / viewportArea > 0.25) largeXOriginIframe = true;
    }
  }
  const largestIframeAreaFraction = Math.min(4, maxIframeArea / viewportArea);

  const hasAgeGate = /age.?(verification|gate)|must be (18|21|over)|adults only/i.test(bodyText);

  // ---- script provenance ----------------------------------------------------
  const scriptHosts = [
    ...new Set(
      [...document.scripts]
        .map((s) => {
          try {
            return new URL(s.src).hostname;
          } catch {
            return "";
          }
        })
        .filter(Boolean)
    )
  ];
  // Shannon entropy over the script-host distribution: a single first-party host
  // is low entropy; a page stitched from many third parties (ad/affiliate hubs)
  // is high. Counts repeats by walking scripts again for weights.
  const scriptHostEntropy = (() => {
    const counts = new Map();
    let n = 0;
    for (const s of document.scripts) {
      let h = "";
      try {
        h = new URL(s.src).hostname;
      } catch {
        continue;
      }
      if (!h) continue;
      counts.set(h, (counts.get(h) || 0) + 1);
      n++;
    }
    if (n === 0) return 0;
    let e = 0;
    for (const c of counts.values()) {
      const p = c / n;
      e -= p * Math.log2(p);
    }
    return e;
  })();

  return {
    // prose vs. chrome
    link_density: linkDensity,
    internal_link_ratio: internalLinkRatio,
    paragraph_count: paragraphCount,
    text_to_tag_ratio: textToTagRatio,
    dom_node_count: domNodeCount,
    outbound_domain_diversity: externalRegs.size,
    link_count: totalResolvable,
    // functional elements
    input_count: inputs.length,
    button_count: document.querySelectorAll("button").length,
    select_count: document.querySelectorAll("select").length,
    has_url_like_input: hasUrlLikeInput,
    url_embeds_url: urlEmbedsUrl,
    has_dominant_canvas: hasDominantCanvas,
    canvas_area_fraction: canvasAreaFraction,
    has_video_player: hasVideoPlayer,
    iframe_count: iframes.length,
    largest_iframe_area_fraction: largestIframeAreaFraction,
    iframe_cross_origin: iframeCrossOrigin,
    has_large_xorigin_iframe: largeXOriginIframe,
    has_age_gate: hasAgeGate,
    // provenance
    script_hosts: scriptHosts,
    script_host_entropy: scriptHostEntropy
  };
}

// Allow Node-based unit tests to import the function; harmless in a browser /
// content-script / injected page context where `module` is undefined.
if (typeof module !== "undefined" && module.exports) {
  module.exports = { fencelineExtractStructural };
}
