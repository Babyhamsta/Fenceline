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
    if category == "gambling" and (
        s.get("has_large_xorigin_iframe") or s.get("has_gambling_license_seal")
    ):
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


# --- shipped hybrid deploy rule -------------------------------------------
# The decision the device runs, mirrored from extension/lib/model.js:decide (the
# SERP exemption is applied by sw.js upstream; folded in here for record-level
# evaluation). Lives here -- the tracked deploy-rule module -- so the gate/meter
# tooling depends on it WITHOUT importing the playwright/httpx-heavy fp_audit
# harness; fp_audit re-exports these for backward compatibility.


def top_blocked(scores: Dict[str, float], clean: str) -> tuple:
    """Highest-scoring non-clean category and its probability ((clean, -1.0) if
    none). Mirrors extension/lib/model.js:topBlocked (strict >, first-seen tie)."""
    best_c, best_p = clean, -1.0
    for c, p in scores.items():
        if c != clean and p > best_p:
            best_c, best_p = c, p
    return best_c, best_p


def hybrid_decide(
    url: str,
    text_scores: Dict[str, float],
    fusion_scores: Dict[str, float],
    structural: Optional[Dict],
    clean: str = "clean",
    thr_fusion: float = 0.97,
    thr_text: float = 0.89,
) -> tuple:
    """Returns (category, confidence, reason); category == ``clean`` means allow.
    Byte-mirror of model.js:decide: SERP-exempt -> fusion top >= thr_fusion ->
    text top >= thr_text AND NOT prose_rescue -> clean."""
    if is_search_engine_url(url):
        return (clean, 0.0, "serp-exempt")
    fc, fp = top_blocked(fusion_scores, clean)
    if fp >= thr_fusion:
        return (fc, fp, "fusion")
    tc, tp = top_blocked(text_scores, clean)
    if tp >= thr_text and not prose_rescue(tc, structural):
        return (tc, tp, "text-backstop")
    return (clean, max(fp, tp), "-")


def has_functional_element(cat: str, s: Dict) -> bool:
    """True if the page carries the blocked category's defining tool -- evidence
    it IS the thing, not a page about it. Mirror of extension/lib/pins.js:pinWorthy
    (the pin-gate), kept identical so the device's pin decision matches the offline
    routing. A missing structural field reads falsy -> not an instance (fail safe)."""
    if cat == "proxy-bypass":
        # url_embeds_url / a proxy marker is proxy-specific. A bare url-like input
        # also fires on any site's SEARCH box, so only count it on a thin page -- a
        # real proxy is a tool (few paragraphs), an article isn't.
        return bool(
            s.get("url_embeds_url")
            or int(s.get("fp_proxy_marker_count") or 0) > 0
            or (s.get("has_url_like_input") and int(s.get("paragraph_count") or 0) < 5)
        )
    if cat == "adult":
        return bool(s.get("has_video_player") or s.get("has_age_gate"))
    if cat == "gambling":
        return bool(
            s.get("has_large_xorigin_iframe")
            or s.get("has_gambling_license_seal")
            or s.get("has_payment_field")
        )
    if cat == "games":
        return bool(s.get("has_dominant_canvas"))
    return False
