"""64-bit simhash over word tokens + Hamming-distance near-duplicate collapse.
Template/affiliate farms render near-identical pages across thousands of
domains; without this the model trains on the same page thousands of times."""
import re
from typing import Dict, List

from classifier.fnv import fnv1a32

_WORD_RE = re.compile(r"[a-z0-9]+")
_BITS = 64


def simhash(text: str) -> int:
    v = [0] * _BITS
    for tok in _WORD_RE.findall(text.lower()):
        # widen the 32-bit FNV to 64 by hashing the token and its reverse
        h = (fnv1a32(tok) << 32) | fnv1a32(tok[::-1])
        for b in range(_BITS):
            v[b] += 1 if (h >> b) & 1 else -1
    out = 0
    for b in range(_BITS):
        if v[b] > 0:
            out |= 1 << b
    return out


def hamming(a: int, b: int) -> int:
    return bin(a ^ b).count("1")


def dedup(records: List[Dict], max_distance: int = 4) -> List[Dict]:
    kept: List[Dict] = []
    seen: List[int] = []
    for rec in records:
        h = simhash(rec.get("text", ""))
        if any(hamming(h, s) <= max_distance for s in seen):
            continue
        seen.append(h)
        kept.append(rec)
    return kept
