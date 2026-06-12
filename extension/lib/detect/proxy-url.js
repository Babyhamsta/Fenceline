// Tier 4: web-proxy ENGINE signature — detected by BEHAVIOUR, not a list of
// framework names (which would both miss new proxies and false-trip legit sites
// like an epoxy or UV-service company). Every web proxy loads its target by
// embedding the target URL in the PATH, e.g.
//   cherrion.top/scramjet/https%3A%2F%2Fgamesito.com/...   (percent-encoded)
//   someproxy.net/service/aHR0cHM6Ly9nYW1lc2l0by5jb20...   (base64, Ultraviolet)
// Legit sites only ever pass a target URL as a ?query param, never as a path
// segment — so a URL-in-the-path is a near-zero-FP, framework-agnostic tell.
export function _decodesToUrl(seg) {
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

export function looksLikeProxyUrl(url) {
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
