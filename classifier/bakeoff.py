"""Model bake-off: compare on-device-deployable classifiers on the same frozen
hashed features, ranked by what actually matters for deployment — clean
false-positive rate and blocked-recall at the high-confidence threshold, plus
model size (the bytes we ship) and inference latency.

Features are held constant (the frozen FNV hashing vectorizer) so any winner
ships with the existing JS vectorizer unchanged; only the classifier differs. A
few entries vary the hash dimension to show the size/accuracy curve, and one MLP
probes whether nonlinearity earns its extra bytes. Heavyweight options (static
embeddings, tiny transformers) are intentionally out of scope — they exceed the
"super lightweight, runs in a content script" budget by 1-2 orders of magnitude.
Run: python -m classifier.bakeoff"""
import json
import math
import time
from pathlib import Path

import numpy as np
from scipy.sparse import csr_matrix
from sklearn.calibration import CalibratedClassifierCV
from sklearn.linear_model import LogisticRegression, SGDClassifier
from sklearn.metrics import f1_score
from sklearn.neural_network import MLPClassifier
from sklearn.svm import LinearSVC

from classifier.extract import doc
from classifier.fnv import fnv1a32
from classifier.vectorize import tokens

ROOT = Path(__file__).resolve().parent
THRESHOLD = 0.9


def _load(name):
    cfg = json.loads((ROOT / "poc.json").read_text(encoding="utf-8"))
    rows = [json.loads(l) for l in
            (ROOT / cfg["paths"][name]).read_text("utf-8").split("\n") if l.strip()]
    return rows, cfg["clean_label"]


def _matrix(rows, dims):
    r, c, v, y = [], [], [], []
    for i, rec in enumerate(rows):
        acc = {}
        for tok in tokens(doc(rec)):
            h = fnv1a32(tok)
            idx = h & (dims - 1)
            acc[idx] = acc.get(idx, 0.0) + (-1.0 if (h >> 31) & 1 else 1.0)
        norm = math.sqrt(sum(x * x for x in acc.values())) or 1.0
        for idx, val in acc.items():
            r.append(i); c.append(idx); v.append(val / norm)
        y.append(rec["label"])
    return csr_matrix((v, (r, c)), shape=(len(rows), dims)), y


def _proba(model, X):
    if hasattr(model, "predict_proba"):
        return model.predict_proba(X)
    d = model.decision_function(X)            # LinearSVC: softmax the margins
    e = np.exp(d - d.max(axis=1, keepdims=True))
    return e / e.sum(axis=1, keepdims=True)


def _metrics(model, classes, clean, X, y):
    ci = list(classes).index(clean)
    P = _proba(model, X)
    y = np.array(y)
    # pure model quality: plain argmax, no threshold
    am = np.array([classes[i] for i in P.argmax(1)])
    acc = (am == y).mean()
    macro = f1_score(y, am, average="macro")
    # deploy operating point: block only if top blocked class clears threshold
    blocked_cols = [i for i in range(len(classes)) if i != ci]
    pred = []
    for row in P:
        bi = max(blocked_cols, key=lambda i: row[i])
        pred.append(classes[bi] if row[bi] >= THRESHOLD else clean)
    pred = np.array(pred)
    clean_mask = y == clean
    fp = ((pred != clean) & clean_mask).sum() / max(1, clean_mask.sum())
    rec = ((pred != clean) & ~clean_mask).sum() / max(1, (~clean_mask).sum())
    return acc, macro, fp, rec


def _size_mb(model, dims, n_classes):
    if isinstance(model, MLPClassifier):
        n = sum(w.size for w in model.coefs_) + sum(b.size for b in model.intercepts_)
        return n * 4 / 1e6
    return n_classes * dims * 4 / 1e6  # linear: the coef matrix we ship


def main():
    train, clean = _load("train")
    test, _ = _load("test")
    classes = sorted({r["label"] for r in train})

    # ComplementNB is omitted: it requires non-negative features, but our frozen
    # vectorizer is signed (the hash's top bit sets the sign), so it's incompatible
    # with the features we actually ship. LinearSVC is sigmoid-calibrated so its
    # confidence threshold is meaningful (raw SVM margins are not probabilities).
    candidates = [
        ("logreg C=1   d=65536", 65536, LogisticRegression(max_iter=1000, C=1.0, class_weight="balanced")),
        ("logreg C=4   d=65536", 65536, LogisticRegression(max_iter=1000, C=4.0, class_weight="balanced")),
        ("logreg C=8   d=65536", 65536, LogisticRegression(max_iter=1000, C=8.0, class_weight="balanced")),
        ("svc-calib    d=65536", 65536, CalibratedClassifierCV(LinearSVC(C=1.0, class_weight="balanced"), method="sigmoid", cv=3)),
        ("sgd-log      d=65536", 65536, SGDClassifier(loss="log_loss", class_weight="balanced", max_iter=30, random_state=0)),
        ("logreg C=4   d=16384", 16384, LogisticRegression(max_iter=1000, C=4.0, class_weight="balanced")),
        ("logreg C=4   d= 4096", 4096, LogisticRegression(max_iter=1000, C=4.0, class_weight="balanced")),
        ("mlp(128)     d= 8192", 8192, MLPClassifier(hidden_layer_sizes=(128,), max_iter=40, random_state=0)),
    ]

    # build matrices once per distinct dim
    dims_needed = sorted({d for _, d, _ in candidates})
    Xtr = {d: _matrix(train, d) for d in dims_needed}
    Xte = {d: _matrix(test, d) for d in dims_needed}

    print(f"\ntrain={len(train)} test={len(test)} classes={classes} "
          f"threshold={THRESHOLD}\n")
    hdr = (f"{'model':<22}{'argmaxAcc':>10}{'macroF1':>9}{'cleanFP@.9':>11}"
           f"{'blkRec@.9':>10}{'size MB':>9}{'train s':>9}{'ms/doc':>8}")
    print(hdr); print("-" * len(hdr))
    for name, dims, model in candidates:
        Xt, ytr = Xtr[dims]; Xv, yte = Xte[dims]
        t0 = time.perf_counter(); model.fit(Xt, ytr); train_s = time.perf_counter() - t0
        t1 = time.perf_counter(); _proba(model, Xv); ms = (time.perf_counter() - t1) / max(1, Xv.shape[0]) * 1000
        acc, macro, fp, rec = _metrics(model, np.array(classes), clean, Xv, yte)
        size = _size_mb(model, dims, len(classes))
        print(f"{name:<22}{acc:>10.3f}{macro:>9.3f}{fp:>11.3f}"
              f"{rec:>10.3f}{size:>9.2f}{train_s:>9.1f}{ms:>8.3f}")


if __name__ == "__main__":
    main()
