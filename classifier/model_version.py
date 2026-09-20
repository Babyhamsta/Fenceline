"""Content identity for all inputs that affect deployed model inference."""

import hashlib
import json


def model_version(weights: bytes, metadata: dict, fusion: bytes = b"") -> str:
    metadata = {key: value for key, value in metadata.items() if key != "version"}
    encoded = json.dumps(metadata, sort_keys=True, separators=(",", ":")).encode("utf-8")
    digest = hashlib.sha256()
    for part in (weights, encoded, fusion):
        digest.update(len(part).to_bytes(8, "big"))
        digest.update(part)
    return digest.hexdigest()[:16]
