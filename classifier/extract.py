"""Normalize a raw Playwright render into the canonical training record.
Pure function so it is unit-testable and identical offline vs (later) on-device."""

import re
from typing import Dict

from classifier.etld import etld1

TEXT_TOKEN_CAP = 400  # lead tokens kept; short input keeps the model tiny/fast

# Strip inlined base64 media (e.g. an og:image data: URI) before storing — a
# load-bearing guardrail: we never persist media, only text features.
_DATA_URI_RE = re.compile(r"data:[^\s'\"<>]+", re.IGNORECASE)


def _strip_data_uris(s: str) -> str:
    return _DATA_URI_RE.sub(" ", s)


def _norm_text(text: str) -> str:
    return " ".join(text.split())[: TEXT_TOKEN_CAP * 16]  # char guard


def doc(rec: Dict) -> str:
    """The model's input string: title + meta + text (title/meta are
    high-signal). One source of truth for training and evaluation."""
    return f"{rec.get('title', '')} {rec.get('meta', '')} {rec.get('text', '')}"


# The structural scalars the shared JS extractor emits (see
# extension/content/structural-features.js). All feature math happens in JS so
# train/infer vectors match by construction; here we only coerce types and
# default safely, never recompute. Grouped by type for the coercion below.
_STRUCT_FLOATS = (
    "link_density",
    "internal_link_ratio",
    "text_to_tag_ratio",
    "canvas_area_fraction",
    "largest_iframe_area_fraction",
    "script_host_entropy",
    # url/host lexical
    "url_digit_ratio",
    "host_entropy",
    "path_entropy",
    # script composition + media density
    "third_party_script_ratio",
    "inline_script_ratio",
    "image_to_text_ratio",
)
_STRUCT_INTS = (
    "paragraph_count",
    "dom_node_count",
    "outbound_domain_diversity",
    "link_count",
    "input_count",
    "button_count",
    "select_count",
    "iframe_count",
    "iframe_cross_origin_count",
    # url/host lexical (counts + 0/1 flags emitted numerically by the JS)
    "url_length",
    "path_depth",
    "query_param_count",
    "url_hyphen_count",
    "url_pct_encoded_count",
    "subdomain_depth",
    "is_ip_literal_host",
    "is_cheap_tld",
    "kw_url_proxy",
    "kw_url_gambling",
    "kw_url_adult",
    "kw_url_games",
    # tag histogram
    "tag_div",
    "tag_iframe",
    "tag_script",
    "tag_video",
    "tag_canvas",
    "tag_embed",
    "tag_object",
    "tag_form",
    "tag_input",
    "tag_a",
    "tag_img",
    "max_dom_depth",
    # script composition + payment/credential + fingerprints
    "popup_indicator_count",
    "form_count",
    "password_field_count",
    "fp_adult_adnet_count",
    "fp_gambling_affiliate_count",
    "fp_crypto_widget_count",
    "fp_proxy_marker_count",
)
_STRUCT_BOOLS = (
    "has_url_like_input",
    "url_embeds_url",
    "has_dominant_canvas",
    "has_video_player",
    "iframe_cross_origin",
    "has_large_xorigin_iframe",
    "has_age_gate",
    "has_payment_field",
    "has_gambling_license_seal",
)


def _norm_structural(s: Dict) -> Dict:
    """Coerce the raw structural dict to a typed, defaulted record. Tolerates
    old corpora (only script_hosts/iframe_count/has_age_gate) and any missing or
    malformed field without raising — a wedged page that returned junk still
    yields a clean zero-vector rather than poisoning the row."""
    s = s or {}

    def _f(k):
        try:
            return float(s.get(k) or 0.0)
        except (TypeError, ValueError):
            return 0.0

    def _i(k):
        try:
            return int(s.get(k) or 0)
        except (TypeError, ValueError):
            return 0

    out = {k: _f(k) for k in _STRUCT_FLOATS}
    out.update({k: _i(k) for k in _STRUCT_INTS})
    out.update({k: bool(s.get(k) or False) for k in _STRUCT_BOOLS})
    out["script_hosts"] = list(s.get("script_hosts") or [])
    return out


def build_record(raw: Dict, url: str, label: str) -> Dict:
    text = " ".join(_norm_text(_strip_data_uris(raw.get("text", ""))).split()[:TEXT_TOKEN_CAP])
    return {
        "etld1": etld1(url),
        "url": url,
        "label": label,
        "text": text,
        "title": _strip_data_uris((raw.get("title") or "")).strip(),
        "meta": _strip_data_uris((raw.get("meta") or "")).strip(),
        "structural": _norm_structural(raw.get("structural") or {}),
    }
