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
    intercept = data["intercept"].astype(np.float32)
    classes = [str(c) for c in data["classes"]]
    # sklearn emits ONE coef row for a 2-class fit (predicts classes_[1]). The
    # shipped artifact and the JS scorer always assume n_classes rows + softmax,
    # so expand the binary case to the equivalent 2-row form: class 0 = zeros,
    # class 1 = the learned row (softmax of [0, w·x+b] == sigmoid(w·x+b)).
    if coef.shape[0] == 1 and len(classes) == 2:
        coef = np.vstack([np.zeros_like(coef[0]), coef[0]])
        intercept = np.array([0.0, float(intercept[0])], dtype=np.float32)
    assert coef.shape[0] == len(classes), "coef rows must equal class count"
    dist = ROOT / cfg["paths"]["dist"]
    dist.mkdir(parents=True, exist_ok=True)
    blob = coef.tobytes()
    (dist / "model.bin").write_bytes(blob)
    version = hashlib.sha256(blob).hexdigest()[:16]
    meta = {
        "version": version,
        "vectorizer": "fnv-hash-v1",
        "dims": DIMS,
        "classes": classes,
        "intercept": [float(x) for x in intercept],
        # Deploy params travel with the model so the extension blocks exactly as
        # evaluated: only when the top blocked class clears block_threshold.
        "clean_label": cfg["clean_label"],
        "block_threshold": cfg.get("block_threshold", 0.9),
    }
    (dist / "model-meta.json").write_text(json.dumps(meta, indent=2), encoding="utf-8")
    print(f"exported model.bin ({len(blob)} bytes), version {version}")


if __name__ == "__main__":
    main()
