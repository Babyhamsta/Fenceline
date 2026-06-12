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


def build_record(raw: Dict, url: str, label: str) -> Dict:
    text = " ".join(_norm_text(_strip_data_uris(raw.get("text", ""))).split()[:TEXT_TOKEN_CAP])
    s = raw.get("structural") or {}
    return {
        "etld1": etld1(url),
        "url": url,
        "label": label,
        "text": text,
        "title": _strip_data_uris((raw.get("title") or "")).strip(),
        "meta": _strip_data_uris((raw.get("meta") or "")).strip(),
        "structural": {
            "script_hosts": list(s.get("script_hosts") or []),
            "iframe_count": int(s.get("iframe_count") or 0),
            "has_age_gate": bool(s.get("has_age_gate") or False),
        },
    }
