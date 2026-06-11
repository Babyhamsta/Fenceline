"""FNV-1a 32-bit hash — same family as extension/lib/hash.js, used by the
hashing vectorizer so Python and JS produce identical feature indices."""

_OFFSET = 0x811C9DC5
_PRIME = 0x01000193
_MASK = 0xFFFFFFFF


def fnv1a32(s: str) -> int:
    h = _OFFSET
    for byte in s.encode("utf-8"):
        h ^= byte
        h = (h * _PRIME) & _MASK
    return h
