"""Reference implementation of the SHIPPED hybrid scoring, reading the exact
artifacts the extension bundles (dist/model.bin, model-meta.json, fusion.json).
Used by tests/test_parity.mjs to prove the JS interpreter (extension/lib/fusion.js)
walks the trees identically. CLI: pass a record JSON, get {text, fusion} scores."""

import json
import sys
from pathlib import Path

import numpy as np

from classifier.extract import doc
from classifier.vectorize import DIMS, vectorize

# Read the COMMITTED, shipped artifacts (the bundled baseline) so the parity
# test validates exactly what the extension loads and runs from a fresh checkout.
MODEL = Path(__file__).resolve().parent.parent / "extension" / "model"
META = json.loads((MODEL / "model-meta.json").read_text(encoding="utf-8"))
CLASSES = META["classes"]
COEF = np.frombuffer((MODEL / "model.bin").read_bytes(), dtype=np.float32).reshape(len(CLASSES), DIMS)
INTERCEPT = np.array(META["intercept"], dtype=np.float32)
FUSION = json.loads((MODEL / "fusion.json").read_text(encoding="utf-8"))


def text_scores(rec):
    lg = INTERCEPT.copy()
    for idx, v in vectorize(doc(rec)).items():
        lg += v * COEF[:, idx]
    e = np.exp(lg - lg.max())
    p = e / e.sum()
    return {c: float(p[i]) for i, c in enumerate(CLASSES)}


def _walk(nodes, x):
    i = 0
    while True:
        feat, thr, left, right, val, is_leaf, miss_left = nodes[i]
        if is_leaf:
            return val
        xv = x[feat]
        if xv != xv:
            i = left if miss_left else right
        else:
            i = left if xv <= thr else right


def fusion_scores(text, structural):
    nt = FUSION["n_text"]
    eng = FUSION["engineered"]
    x = [0.0] * (nt + len(eng))
    for k, c in enumerate(FUSION["classes"]):
        x[k] = text.get(c, 0.0)
    s = structural or {}
    for i, k in enumerate(eng):
        try:
            x[nt + i] = float(s.get(k) or 0.0)
        except (TypeError, ValueError):
            x[nt + i] = 0.0
    raw = list(FUSION["baseline"])
    for trees in FUSION["trees"]:
        for k, nodes in enumerate(trees):
            raw[k] += _walk(nodes, x)
    m = max(raw)
    e = [np.exp(v - m) for v in raw]
    z = sum(e)
    return {c: float(e[i] / z) for i, c in enumerate(FUSION["classes"])}


if __name__ == "__main__":
    rec = json.loads(sys.argv[1])
    t = text_scores(rec)
    print(json.dumps({"text": t, "fusion": fusion_scores(t, rec.get("structural"))}))
