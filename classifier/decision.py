"""Deploy-rule post-processing that the device applies on top of the raw model
scores, mirrored here so offline evaluation reflects what actually ships.

Two rules, byte-for-byte equivalents of the JS:
  - ``prose_rescue``  <-> extension/lib/detect/prose-rescue.js
  - ``is_search_engine_serp`` <-> extension/lib/detect/search-engine.js

Keep the literals (0.33 density, 3 paragraphs, the engine/path table) identical
on both sides; a divergence means the metrics no longer predict field behaviour.
"""

from typing import Dict, Optional
from urllib.parse import urlsplit

# --- prose-rescue ----------------------------------------------------------
_RESCUABLE = {"proxy-bypass", "adult", "gambling"}


def prose_rescue(category: str, s: Optional[Dict]) -> bool:
    """True if a block on ``category`` should be overturned to clean because the
    page is clearly an article about the topic, lacking its functional element.
    Missing structural fields read as 0/False -> the prose tests fail -> no
    rescue (fail safe: keep blocking rather than over-rescue)."""
    if category not in _RESCUABLE or not s:
        return False
    if not (float(s.get("link_density") or 0.0) < 0.33):
        return False
    if not (int(s.get("paragraph_count") or 0) >= 3):
        return False
    if s.get("has_dominant_canvas"):
        return False
    if category == "proxy-bypass" and (s.get("url_embeds_url") or s.get("has_url_like_input")):
        return False
    if category == "adult" and s.get("has_video_player"):
        return False
    if category == "gambling" and s.get("has_large_xorigin_iframe"):
        return False
    return True


# --- search-engine Layer-3 exemption --------------------------------------
# Exact host -> allowed SERP/home path prefixes. Exact-match (no suffix) so
# translate./cache. subdomains are never exempt; path-scoped so a path-mounted
# proxy on a search host isn't covered. The content model is skipped ONLY here.
_ENGINES = (
    (("google.com", "www.google.com"), ("/", "/search")),
    (("bing.com", "www.bing.com"), ("/", "/search")),
    (("duckduckgo.com",), ("/", "/html", "/lite")),
    (("search.brave.com",), ("/", "/search")),
    (("startpage.com", "www.startpage.com"), ("/", "/sp/search", "/do/search", "/do/dsearch")),
    (("ecosia.org", "www.ecosia.org"), ("/", "/search")),
    (("search.yahoo.com",), ("/", "/search")),
    (("yandex.com", "www.yandex.com"), ("/", "/search")),
)


def is_search_engine_serp(hostname: str, pathname: str) -> bool:
    h = (hostname or "").lower()
    p = (pathname or "/").lower()
    for hosts, serp in _ENGINES:
        if h not in hosts:
            continue
        return any(p == s if s == "/" else (p == s or p.startswith(s + "/")) for s in serp)
    return False


def is_search_engine_url(url: str) -> bool:
    """Convenience for record-level evaluation: split a stored URL into host+path
    and apply the exemption (top-frame semantics)."""
    parts = urlsplit(url or "")
    return is_search_engine_serp(parts.hostname or "", parts.path or "/")
