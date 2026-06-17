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

// ---- curated resource-fingerprint lists (the doc's "thing that clusters the
// categories"). Inlined as substrings so the whole extractor still injects as a
// single self-contained function — host matching is a cheap `.includes` against
// the registrable host, not an exact-set lookup, so `ads.example-adnet.com`
// matches the `example-adnet` marker. Starter sets; expand from field hits.
// These are FEATURE INPUTS, not a block boundary — false matches only add noise
// a tree can down-weight, they never block on their own.
const FP_ADULT_ADNET = [
  "exoclick", "juicyads", "trafficjunky", "eroadvertising", "adxxx",
  "trafficstars", "popads", "adsterra", "plugrush", "hilltopads",
  "clickadu", "tsyndicate", "adnium", "ero-advertising"
];
const FP_GAMBLING_AFFILIATE = [
  "income-access", "incomeaccess", "raventrack", "netrefer", "myaffiliates",
  "cellxpert", "smartico", "betradar", "sportradar", "everymatrix",
  "softswiss", "pragmaticplay", "evolution", "1xbet", "betano"
];
const FP_CRYPTO_WIDGET = [
  "coinbase-commerce", "coingate", "nowpayments", "cryptomus", "coinpayments",
  "binance", "metamask", "walletconnect", "web3modal", "moonpay", "wert.io"
];
// CGI-proxy software tells (Glype/CGIProxy/PHProxy). Matched against page text +
// inline markup, lowercased. base64-destination handling stays in url_embeds_url.
const FP_PROXY_MARKER = [
  "powered by glype", "glype", "cgiproxy", "phproxy", "powered by php-proxy",
  "miniproxy", "php-proxy", "x-proxy", "/browse.php?u=", "/nph-proxy"
];

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
  const shannon = (str) => {
    const s = str || "";
    if (!s.length) return 0;
    const counts = new Map();
    for (const ch of s) counts.set(ch, (counts.get(ch) || 0) + 1);
    let e = 0;
    for (const c of counts.values()) {
      const p = c / s.length;
      e -= p * Math.log2(p);
    }
    return e;
  };
  const countMarkers = (hay, markers) => {
    let n = 0;
    for (const m of markers) if (hay.includes(m)) n++;
    return n;
  };

  const vw = Math.max(1, window.innerWidth || 0);
  const vh = Math.max(1, window.innerHeight || 0);
  const viewportArea = vw * vh;

  let locHost = "";
  let locHref = "";
  let locPath = "";
  let locSearch = "";
  try {
    locHost = location.hostname || "";
    locHref = location.href || "";
    locPath = location.pathname || "";
    locSearch = location.search || "";
  } catch {
    locHost = "";
  }
  const locReg = regDomain(locHost);

  // ---- URL/host lexical (always available — the fallback for thin pages) ------
  // Computed from `location` so the scrape (page rendered AT the stored url) and
  // the device (live url) derive identical values. Pure string math, no DOM.
  const hostLabels = locHost.split(".").filter(Boolean);
  const urlDigits = (locHref.match(/[0-9]/g) || []).length;
  const urlLength = locHref.length;
  const urlFeatures = {
    url_length: urlLength,
    path_depth: locPath.split("/").filter(Boolean).length,
    query_param_count: locSearch ? locSearch.replace(/^\?/, "").split("&").filter(Boolean).length : 0,
    url_digit_ratio: urlLength ? urlDigits / urlLength : 0,
    url_hyphen_count: (locHref.match(/-/g) || []).length,
    url_pct_encoded_count: (locHref.match(/%[0-9a-fA-F]{2}/g) || []).length,
    host_entropy: shannon(locHost),
    path_entropy: shannon(locPath),
    subdomain_depth: Math.max(0, hostLabels.length - 2),
    is_ip_literal_host: /^\d{1,3}(\.\d{1,3}){3}$/.test(locHost) ? 1 : 0,
    // Cheap/abused TLDs carry signal (doc). Boolean flag keeps the vector numeric
    // and fixed-length; a full categorical can be added offline if it pays.
    is_cheap_tld: /\.(xyz|top|click|club|online|site|live|fun|gq|cf|ml|tk|ga|buzz|rest|cyou)$/i.test(locHost) ? 1 : 0,
    // per-category keyword hits in the full URL (lowercased) — strongest cheap
    // signal on thin/blocked pages where the DOM collapses to nothing.
    kw_url_proxy: countMarkers(locHref.toLowerCase(), ["proxy", "unblock", "unblocked", "bypass", "vpn", "hidester", "croxy"]),
    kw_url_gambling: countMarkers(locHref.toLowerCase(), ["casino", "bet", "slot", "poker", "gambl", "wager", "roulette", "blackjack"]),
    kw_url_adult: countMarkers(locHref.toLowerCase(), ["porn", "xxx", "sex", "adult", "nude", "cam", "escort", "hentai"]),
    kw_url_games: countMarkers(locHref.toLowerCase(), ["game", "play", "unblocked", "io", "arcade", "html5"])
  };

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
  let iframeCrossOriginCount = 0;
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
      iframeCrossOriginCount++;
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

  // ---- DOM tag histogram + script ratios -----------------------------------
  // Native getElementsByTagName is a live count, no walk — cheap even on huge
  // pages. The histogram lets the tree branch on composition (media-heavy adult,
  // canvas games, iframe-stitched casinos) rather than raw node count alone.
  const tagCount = (t) => document.getElementsByTagName(t).length;
  const imgCount = tagCount("img");
  const scripts = [...document.scripts];
  let scriptsWithSrc = 0;
  let thirdPartyScripts = 0;
  let popupIndicatorCount = 0;
  for (const s of scripts) {
    if (s.src) {
      scriptsWithSrc++;
      let host = "";
      try {
        host = new URL(s.src, location.href).hostname;
      } catch {
        host = "";
      }
      if (host && regDomain(host) !== locReg) thirdPartyScripts++;
    } else {
      // Inline script text is readable; popunder/popup tells live here. Bounded
      // by only scanning inline bodies (already in memory, no fetch).
      const body = s.textContent || "";
      if (/window\.open\s*\(|popunder|pop_under|\.popups?\b/i.test(body)) popupIndicatorCount++;
    }
  }
  const totalScripts = scripts.length;
  const thirdPartyScriptRatio = scriptsWithSrc ? thirdPartyScripts / scriptsWithSrc : 0;
  const inlineScriptRatio = totalScripts ? (totalScripts - scriptsWithSrc) / totalScripts : 0;
  // onclick="window.open" popunder pattern (bounded sample of elements w/ onclick)
  for (const el of [...document.querySelectorAll("[onclick]")].slice(0, 200)) {
    if (/window\.open|popunder/i.test(el.getAttribute("onclick") || "")) popupIndicatorCount++;
  }

  // max DOM depth via a bounded iterative DFS — a pathological page can't blow
  // the time budget (node cap), and depth separates deep app shells from flat
  // doorway/link-hub pages.
  const maxDomDepth = (() => {
    let maxDepth = 0;
    let budget = 15000;
    const stack = document.body ? [[document.body, 1]] : [];
    while (stack.length && budget-- > 0) {
      const [node, depth] = stack.pop();
      if (depth > maxDepth) maxDepth = depth;
      const kids = node.children;
      for (let i = 0; i < kids.length; i++) stack.push([kids[i], depth + 1]);
    }
    return maxDepth;
  })();

  // ---- payment / credential fields -----------------------------------------
  let passwordFieldCount = 0;
  let hasPaymentField = false;
  for (const el of inputs) {
    const type = (el.getAttribute("type") || "text").toLowerCase();
    if (type === "password") passwordFieldCount++;
    const ac = (el.getAttribute("autocomplete") || "").toLowerCase();
    const idattrs = (
      (el.getAttribute("name") || "") +
      " " +
      (el.getAttribute("id") || "") +
      " " +
      (el.getAttribute("placeholder") || "")
    ).toLowerCase();
    if (
      /\bcc-(number|csc|exp)\b|\bcardnumber\b/.test(ac) ||
      /card.?number|\bcvv\b|\bcvc\b|\bccnum|card.?holder|expir/.test(idattrs)
    ) {
      hasPaymentField = true;
    }
  }

  // ---- image-to-text ratio (media-heavy categories spike) -------------------
  const imageToTextRatio = imgCount / Math.max(1, bodyText.length);

  // ---- resource fingerprints (cross-origin script + iframe hosts vs lists) --
  const fpHosts = [];
  for (const s of scripts) {
    if (s.src) {
      try {
        fpHosts.push(new URL(s.src, location.href).hostname.toLowerCase());
      } catch {
        /* skip */
      }
    }
  }
  for (const f of iframes) {
    try {
      fpHosts.push(new URL(f.src, location.href).hostname.toLowerCase());
    } catch {
      /* skip */
    }
  }
  const hostsBlob = fpHosts.join(" ");
  const fpAdultAdnet = countMarkers(hostsBlob, FP_ADULT_ADNET);
  const fpGamblingAffiliate = countMarkers(hostsBlob, FP_GAMBLING_AFFILIATE);
  const fpCryptoWidget = countMarkers(hostsBlob, FP_CRYPTO_WIDGET);
  // proxy-software markers + gambling license seals: text-level tells. bodyText
  // already in hand; lowercase once.
  const lowText = bodyText.toLowerCase();
  const fpProxyMarker = countMarkers(lowText, FP_PROXY_MARKER);
  const hasGamblingLicenseSeal =
    /(curacao|curaçao|gaming\s+license|gambling\s+commission|licensed\s+(?:and\s+regulated|by)|mga\/|malta\s+gaming|begambleaware|gamcare)/i.test(
      bodyText
    );

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
    iframe_cross_origin_count: iframeCrossOriginCount,
    largest_iframe_area_fraction: largestIframeAreaFraction,
    iframe_cross_origin: iframeCrossOrigin,
    has_large_xorigin_iframe: largeXOriginIframe,
    has_age_gate: hasAgeGate,
    // provenance
    script_hosts: scriptHosts,
    script_host_entropy: scriptHostEntropy,
    // ---- url/host lexical (spread last; never collides with the above keys) --
    ...urlFeatures,
    // ---- tag histogram -------------------------------------------------------
    tag_div: tagCount("div"),
    tag_iframe: iframes.length,
    tag_script: totalScripts,
    tag_video: tagCount("video"),
    tag_canvas: tagCount("canvas"),
    tag_embed: tagCount("embed"),
    tag_object: tagCount("object"),
    tag_form: tagCount("form"),
    tag_input: inputs.length,
    tag_a: anchors.length,
    tag_img: imgCount,
    max_dom_depth: maxDomDepth,
    // ---- script composition --------------------------------------------------
    third_party_script_ratio: thirdPartyScriptRatio,
    inline_script_ratio: inlineScriptRatio,
    popup_indicator_count: popupIndicatorCount,
    // ---- payment / credential ------------------------------------------------
    form_count: tagCount("form"),
    password_field_count: passwordFieldCount,
    has_payment_field: hasPaymentField,
    image_to_text_ratio: imageToTextRatio,
    // ---- resource fingerprints ----------------------------------------------
    fp_adult_adnet_count: fpAdultAdnet,
    fp_gambling_affiliate_count: fpGamblingAffiliate,
    fp_crypto_widget_count: fpCryptoWidget,
    fp_proxy_marker_count: fpProxyMarker,
    has_gambling_license_seal: hasGamblingLicenseSeal
  };
}

// Allow Node-based unit tests to import the function; harmless in a browser /
// content-script / injected page context where `module` is undefined.
if (typeof module !== "undefined" && module.exports) {
  module.exports = { fencelineExtractStructural };
}
