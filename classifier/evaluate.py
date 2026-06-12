"""Score the held-out test set and print the go/no-go table.

The deployment never blocks on a bare argmax — it blocks only when a blocked
category clears a high-confidence threshold, otherwise it leaves the page alone.
So we report metrics at that operating point (``block_threshold`` in poc.json),
plus a threshold sweep showing the clean false-positive vs recall trade-off, and
the raw-argmax numbers for reference. Also prints model size and Python
inference latency (a proxy; on-device JS latency is measured separately)."""
import json
import time
from pathlib import Path

import numpy as np

from classifier.extract import doc
from classifier.metrics import fp_rate_on_clean, per_class
from classifier.vectorize import DIMS, vectorize

ROOT = Path(__file__).resolve().parent


def _scores(rec, intercept, coef):
    logits = intercept.copy()
    for idx, v in vectorize(doc(rec)).items():
        logits += v * coef[:, idx]
    e = np.exp(logits - logits.max())
    return e / e.sum()


def _predict(prob, classes, clean_label, threshold):
    """Block with the top blocked category only if it clears the threshold,
    otherwise fall back to clean — the high-confidence-only deploy rule."""
    blocked = [(c, prob[i]) for i, c in enumerate(classes) if c != clean_label]
    top_c, top_p = max(blocked, key=lambda cp: cp[1])
    return top_c if top_p >= threshold else clean_label


def main() -> None:
    cfg = json.loads((ROOT / "poc.json").read_text(encoding="utf-8"))
    clean_label = cfg["clean_label"]
    threshold = cfg.get("block_threshold", 0.9)
    meta = json.loads((ROOT / cfg["paths"]["dist"] / "model-meta.json").read_text("utf-8"))
    classes = meta["classes"]
    coef = np.frombuffer((ROOT / cfg["paths"]["dist"] / "model.bin").read_bytes(),
                         dtype=np.float32).reshape(len(classes), DIMS)
    intercept = np.array(meta["intercept"], dtype=np.float32)

    test = [json.loads(l) for l in
            (ROOT / cfg["paths"]["test"]).read_text("utf-8").split("\n") if l.strip()]
    y_true, probs, t0 = [], [], time.perf_counter()
    for rec in test:
        probs.append(_scores(rec, intercept, coef))
        y_true.append(rec["label"])
    dt = (time.perf_counter() - t0) / max(1, len(test)) * 1000

    # operating point
    y_pred = [_predict(p, classes, clean_label, threshold) for p in probs]
    pc = per_class(y_true, y_pred, classes)
    print(f"\n=== operating point: block_threshold={threshold} "
          f"(block only above this confidence) ===")
    print(f"{'category':<14}{'precision':>10}{'recall':>9}{'support':>9}")
    for lab in classes:
        print(f"{lab:<14}{pc[lab]['precision']:>10.3f}{pc[lab]['recall']:>9.3f}"
              f"{pc[lab]['support']:>9}")
    print(f"\nclean FP-rate:        {fp_rate_on_clean(y_true, y_pred, clean_label):.3f}")

    # threshold sweep: clean FP vs overall block-recall
    print(f"\n{'threshold':>10}{'clean-FP':>10}{'blocked-recall':>16}")
    blocked_total = sum(1 for y in y_true if y != clean_label)
    clean_total = sum(1 for y in y_true if y == clean_label)
    for t in (0.50, 0.70, 0.80, 0.90, 0.95, 0.99):
        preds = [_predict(p, classes, clean_label, t) for p in probs]
        fp = sum(1 for yt, yp in zip(y_true, preds)
                 if yt == clean_label and yp != clean_label) / max(1, clean_total)
        rec = sum(1 for yt, yp in zip(y_true, preds)
                  if yt != clean_label and yp != clean_label) / max(1, blocked_total)
        print(f"{t:>10.2f}{fp:>10.3f}{rec:>16.3f}")

    size_mb = (ROOT / cfg["paths"]["dist"] / "model.bin").stat().st_size / 1e6
    print(f"\nmodel size:           {size_mb:.2f} MB")
    print(f"py inference latency:  {dt:.2f} ms/doc (proxy)")
    print(f"test docs:            {len(test)}")


if __name__ == "__main__":
    main()
