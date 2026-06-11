"""FNV-1a 32-bit hash. Byte-for-byte mirror of fnv1a32 in classifier/infer.mjs
(UTF-8 bytes, 32-bit) so the hashing vectorizer yields identical feature indices
in Python (training) and JS (on-device). Same FNV-1a idiom the project uses
elsewhere (cf. the 64-bit domain hash in extension/lib/hash.js)."""

_OFFSET = 0x811C9DC5
_PRIME = 0x01000193
_MASK = 0xFFFFFFFF


def fnv1a32(s: str) -> int:
    h = _OFFSET
    for byte in s.encode("utf-8"):
        h ^= byte
        h = (h * _PRIME) & _MASK
    return h
