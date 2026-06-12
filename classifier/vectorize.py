"""Frozen v1 hashing vectorizer. MUST stay byte-identical to infer.mjs.
Config: lowercase; word 1-2 grams; char 3-4 grams within each word (prefixed
'#' and boundary-padded with '^'/'$'); FNV-1a 32-bit -> index & (DIMS-1);
sign from the top bit; L2-normalized term vector."""

import math
import re
from typing import Dict, Iterator, List

from classifier.fnv import fnv1a32

DIMS = 65536  # 2**16
_WORD_RE = re.compile(r"[a-z0-9]+")


def _char_ngrams(word: str) -> Iterator[str]:
    padded = f"^{word}$"
    for n in (3, 4):
        for i in range(len(padded) - n + 1):
            yield "#" + padded[i : i + n]


def tokens(text: str) -> List[str]:
    words = _WORD_RE.findall(text.lower())
    out: List[str] = []
    for i, w in enumerate(words):
        out.append(w)
        if i + 1 < len(words):
            out.append(w + " " + words[i + 1])
        out.extend(_char_ngrams(w))
    return out


def vectorize(text: str) -> Dict[int, float]:
    acc: Dict[int, float] = {}
    for tok in tokens(text):
        h = fnv1a32(tok)
        idx = h & (DIMS - 1)
        sign = -1.0 if (h >> 31) & 1 else 1.0
        acc[idx] = acc.get(idx, 0.0) + sign
    norm = math.sqrt(sum(x * x for x in acc.values()))
    if norm == 0.0:
        return {}
    return {i: x / norm for i, x in acc.items()}
