"""Normalize a raw Playwright render into the canonical training record.
Pure function so it is unit-testable and identical offline vs (later) on-device."""
from typing import Dict

from classifier.etld import etld1

TEXT_TOKEN_CAP = 400  # lead tokens kept; short input keeps the model tiny/fast


def _norm_text(text: str) -> str:
    return " ".join(text.split())[: TEXT_TOKEN_CAP * 16]  # char guard


def build_record(raw: Dict, url: str, label: str) -> Dict:
    text = " ".join(_norm_text(raw.get("text", "")).split()[:TEXT_TOKEN_CAP])
    s = raw.get("structural") or {}
    return {
        "etld1": etld1(url),
        "url": url,
        "label": label,
        "text": text,
        "title": (raw.get("title") or "").strip(),
        "meta": (raw.get("meta") or "").strip(),
        "structural": {
            "script_hosts": list(s.get("script_hosts") or []),
            "iframe_count": int(s.get("iframe_count") or 0),
            "has_age_gate": bool(s.get("has_age_gate") or False),
        },
    }
