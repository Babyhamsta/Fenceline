"""Drop pages that would poison training: dead/thin shells and parked domains.
Also doubles as a blocklist liveness audit downstream."""
from typing import Dict

MIN_TOKENS = 20
_PARK_MARKERS = (
    "domain is for sale", "buy this domain", "this domain is parked",
    "domain parking", "is for sale", "purchase this domain",
    "godaddy", "sedo", "hugedomains",
)


def is_usable(record: Dict) -> bool:
    text = (record.get("text") or "").lower()
    if len(text.split()) < MIN_TOKENS:
        return False
    if any(m in text for m in _PARK_MARKERS):
        return False
    return True
