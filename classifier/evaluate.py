"""Score the held-out test set with the trained model and print the go/no-go
table: per-class precision/recall, the clean false-positive rate, model size,
and Python inference latency (a proxy; on-device JS latency is measured later)."""
import json
import time
from pathlib import Path

import numpy as np

from classifier.extract import doc
from classifier.metrics import fp_rate_on_clean, per_class
from classifier.vectorize import DIMS, vectorize

ROOT = Path(__file__).resolve().parent


def main() -> None:
    cfg = json.loads((ROOT / "poc.json").read_text(encoding="utf-8"))
    meta = json.loads((ROOT / cfg["paths"]["dist"] / "model-meta.json").read_text("utf-8"))
    classes = meta["classes"]
    coef = np.frombuffer((ROOT / cfg["paths"]["dist"] / "model.bin").read_bytes(),
                         dtype=np.float32).reshape(len(classes), DIMS)
    intercept = np.array(meta["intercept"], dtype=np.float32)

    test = [json.loads(l) for l in
            (ROOT / cfg["paths"]["test"]).read_text("utf-8").splitlines() if l.strip()]
    y_true, y_pred, t0 = [], [], time.perf_counter()
    for rec in test:
        vec = vectorize(doc(rec))
        logits = intercept.copy()
        for idx, v in vec.items():
            logits += v * coef[:, idx]
        y_pred.append(classes[int(np.argmax(logits))])
        y_true.append(rec["label"])
    dt = (time.perf_counter() - t0) / max(1, len(test)) * 1000

    pc = per_class(y_true, y_pred, classes)
    print(f"\n{'category':<14}{'precision':>10}{'recall':>9}{'support':>9}")
    for lab in classes:
        print(f"{lab:<14}{pc[lab]['precision']:>10.3f}{pc[lab]['recall']:>9.3f}"
              f"{pc[lab]['support']:>9}")
    size_mb = (ROOT / cfg["paths"]["dist"] / "model.bin").stat().st_size / 1e6
    print(f"\nclean FP-rate:        {fp_rate_on_clean(y_true, y_pred, cfg['clean_label']):.3f}")
    print(f"model size:           {size_mb:.2f} MB")
    print(f"py inference latency:  {dt:.2f} ms/doc (proxy)")
    print(f"test docs:            {len(test)}")


if __name__ == "__main__":
    main()
