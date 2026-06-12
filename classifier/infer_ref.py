"""Python reference scorer over the exported artifact — exists only so the JS
parity test has something to compare against (same math as infer.mjs)."""

import json
import math
from pathlib import Path

import numpy as np

from classifier.vectorize import vectorize

ROOT = Path(__file__).resolve().parent


def classify_ref(text: str) -> dict:
    meta = json.loads((ROOT / "dist" / "model-meta.json").read_text(encoding="utf-8"))
    classes = meta["classes"]
    dims = meta["dims"]
    intercept = meta["intercept"]
    coef = np.frombuffer((ROOT / "dist" / "model.bin").read_bytes(), dtype=np.float32).reshape(
        len(classes), dims
    )
    vec = vectorize(text)
    logits = []
    for ci in range(len(classes)):
        s = intercept[ci] + sum(v * float(coef[ci, idx]) for idx, v in vec.items())
        logits.append(s)
    m = max(logits)
    exps = [math.exp(x - m) for x in logits]
    z = sum(exps)
    scores = {classes[i]: exps[i] / z for i in range(len(classes))}
    label = max(scores, key=scores.get)
    return {"label": label, "scores": scores}
