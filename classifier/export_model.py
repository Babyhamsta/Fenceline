"""Export model.npz to the shippable artifact the JS path reads:
  dist/model.bin        float32 coef, row-major [n_classes x DIMS]
  dist/model-meta.json  classes, dims, intercepts, vectorizer id, version hash"""
import hashlib
import json
from pathlib import Path

import numpy as np

from classifier.vectorize import DIMS

ROOT = Path(__file__).resolve().parent


def main() -> None:
    cfg = json.loads((ROOT / "poc.json").read_text(encoding="utf-8"))
    data = np.load(ROOT / cfg["paths"]["model"], allow_pickle=True)
    coef = data["coef"].astype(np.float32)
    dist = ROOT / cfg["paths"]["dist"]
    dist.mkdir(parents=True, exist_ok=True)
    blob = coef.tobytes()
    (dist / "model.bin").write_bytes(blob)
    version = hashlib.sha256(blob).hexdigest()[:16]
    meta = {
        "version": version,
        "vectorizer": "fnv-hash-v1",
        "dims": DIMS,
        "classes": [str(c) for c in data["classes"]],
        "intercept": [float(x) for x in data["intercept"]],
    }
    (dist / "model-meta.json").write_text(json.dumps(meta, indent=2), encoding="utf-8")
    print(f"exported model.bin ({len(blob)} bytes), version {version}")


if __name__ == "__main__":
    main()
