// Tier 4c: app smuggled as an SVG document --------------------------------
// A static SVG image is harmless; an SVG carrying a <foreignObject> is HTML
// smuggled inside an image — the "app-as-image" trick (DaydreamX et al.) used to
// host a web proxy under an innocent .svg extension on a public code CDN
// (jsDelivr / githack / statically). These two predicates are the body-level
// half of that detection (the Content-Type gate lives in sw.js): we block only
// when a top-level SVG both carries a <foreignObject> AND runs executable code,
// so legit top-level SVGs (logos, badges, Mermaid/draw.io diagram exports) are
// never touched.

// Namespace-aware (<svg:foreignObject> is legal in XML-served SVG). A static
// diagram export (Mermaid, draw.io, svg-term) also wraps HTML labels in
// <foreignObject>, so presence alone is necessary but not sufficient — pair it
// with svgHasExecutableContent below.
export function svgHasForeignObject(body) {
  return /<([a-z0-9]+:)?foreignObject[\s/>]/i.test(body);
}

// Executable JavaScript or an embedded browsing context inside the SVG — the
// markers of a smuggled app. Inert data scripts (MathJax type="math/…",
// application/json, text/x-…) and label-only foreignObject are ignored.
export function svgHasExecutableContent(body) {
  if (/<([a-z0-9]+:)?(iframe|embed|object)[\s/>]/i.test(body)) return true;
  const re = /<([a-z0-9]+:)?script\b([^>]*)>/gi;
  let m;
  while ((m = re.exec(body))) {
    const tm = (m[2] || "").match(/\btype\s*=\s*["']?\s*([^"'\s>]+)/i);
    if (!tm) return true; // no type attribute → executable JS by default
    const t = tm[1].toLowerCase();
    if (
      t === "module" ||
      t === "text/javascript" ||
      t === "application/javascript" ||
      /(^|\/)(java|ecma)script$/.test(t)
    ) {
      return true;
    }
  }
  return false;
}
