"""Train and evaluate the research-doc model: a gradient-boosted tree over the
full engineered feature vector (URL/host lexical + DOM histogram + structural +
resource fingerprints) fused with the frozen text model's per-class scores.

Compares three models at a matched clean-FP budget on the held-out v3 test set,
per category, against the text-only logistic baseline RETRAINED on v3 (so the
comparison is apples-to-apples — same train distribution for every model):

  - text-only (current architecture)
  - engineered-only GBDT (no text — what the structure alone can do)
  - FUSION GBDT  [text scores + engineered]   (the doc's Stage-2)

Leak-free: the GBDT's train-row text scores are out-of-fold (each row scored by
an LR that never saw it), so the tree learns the honest text->label relation.

Saves artifacts to dist_v3/ for the real-site + adversarial test stages.

Run: python -m classifier.train_gbdt
"""

import json
import pickle
from collections import defaultdict
from pathlib import Path

import numpy as np
from scipy.sparse import csr_matrix
from sklearn.ensemble import HistGradientBoostingClassifier
from sklearn.linear_model import LogisticRegression
from sklearn.model_selection import StratifiedKFold

from classifier.extract import _STRUCT_BOOLS, _STRUCT_FLOATS, _STRUCT_INTS, doc
from classifier.vectorize import DIMS, vectorize

ROOT = Path(__file__).resolve().parent
cfg = json.loads((ROOT / "poc.json").read_text(encoding="utf-8"))
CLEAN = cfg["clean_label"]
OUT = ROOT / "dist_v3"

# The engineered feature vector = every numeric/bool scalar the shared extractor
# emits (script_hosts is the only non-scalar; its entropy is already a scalar).
# Imported from extract.py so train/infer can never drift from the stored fields.
ENG = list(_STRUCT_FLOATS) + list(_STRUCT_INTS) + list(_STRUCT_BOOLS)


def load(name):
    p = ROOT / "data" / f"{name}.jsonl"
    return [json.loads(line) for line in p.read_text(encoding="utf-8").split("\n") if line.strip()]


def eng_vec(rec):
    s = rec.get("structural") or {}
    return [float(s.get(k) or 0.0) for k in ENG]


def build_sparse(recs):
    rows, cols, data = [], [], []
    for i, r in enumerate(recs):
        for idx, v in vectorize(doc(r)).items():
            rows.append(i)
            cols.append(idx)
            data.append(v)
    return csr_matrix((data, (rows, cols)), shape=(len(recs), DIMS))


def fit_text_lr(X, y):
    lr = LogisticRegression(max_iter=1000, class_weight="balanced", C=4.0)
    lr.fit(X, y)
    return lr


def oof_text_scores(X_text, y, classes, n_splits=5):
    oof = np.zeros((X_text.shape[0], len(classes)), dtype=np.float64)
    skf = StratifiedKFold(n_splits=n_splits, shuffle=True, random_state=0)
    for fold, (tr, te) in enumerate(skf.split(np.zeros(len(y)), y), 1):
        lr = fit_text_lr(X_text[tr], y[tr])
        colmap = [list(lr.classes_).index(c) for c in classes]
        oof[te] = lr.predict_proba(X_text[te])[:, colmap]
        print(f"  oof fold {fold}/{n_splits} done", flush=True)
    return oof


def gbdt(X, y):
    clf = HistGradientBoostingClassifier(
        max_depth=6, max_iter=400, learning_rate=0.08, l2_regularization=1.0, random_state=0
    )
    clf.fit(X, y)
    return clf


def evaluate(P, prob_classes, y_true, thr, classes):
    ci = {c: i for i, c in enumerate(prob_classes)}
    rec = defaultdict(lambda: [0, 0])
    fp = [0, 0]
    for p, yt in zip(P, y_true):
        order = [(c, p[ci[c]]) for c in classes if c != CLEAN]
        tc, tp = max(order, key=lambda x: x[1])
        pred = tc if tp >= thr else CLEAN
        if yt == CLEAN:
            fp[1] += 1
            fp[0] += int(pred != CLEAN)
        else:
            rec[yt][1] += 1
            rec[yt][0] += int(pred != CLEAN)
    overall = sum(v[0] for v in rec.values()) / max(1, sum(v[1] for v in rec.values()))
    per = {k: rec[k][0] / max(1, rec[k][1]) for k in rec}
    return fp[0] / max(1, fp[1]), overall, per


def recall_at_fp(P, prob_classes, y_true, target_fp, classes):
    best = None
    for thr in np.linspace(0.30, 0.995, 140):
        fp, overall, per = evaluate(P, prob_classes, y_true, thr, classes)
        if fp <= target_fp and (best is None or overall > best[0]):
            best = (overall, per, thr, fp)
    if best is None:
        fp, overall, per = evaluate(P, prob_classes, y_true, 0.995, classes)
        best = (overall, per, 0.995, fp)
    return best


def main():
    train, test = load("train"), load("test")
    print(f"train={len(train)} test={len(test)}  engineered_features={len(ENG)}")

    ytr = np.array([r["label"] for r in train])
    yte = np.array([r["label"] for r in test])
    classes = sorted(set(ytr))

    Xtr_eng = np.array([eng_vec(r) for r in train])
    Xte_eng = np.array([eng_vec(r) for r in test])

    print("vectorizing train + out-of-fold text scoring (slow part)...", flush=True)
    Xtr_feat = build_sparse(train)
    Xtr_text = oof_text_scores(Xtr_feat, ytr, classes)

    # Deployed text model: fit on ALL train, score test (test rows were never in
    # train, so these scores are already honest).
    text_lr = fit_text_lr(Xtr_feat, ytr)
    text_colmap = [list(text_lr.classes_).index(c) for c in classes]
    Xte_feat = build_sparse(test)
    Xte_text = text_lr.predict_proba(Xte_feat)[:, text_colmap]

    print("training engineered-only and fusion trees...", flush=True)
    clf_eng = gbdt(Xtr_eng, ytr)
    clf_fuse = gbdt(np.hstack([Xtr_text, Xtr_eng]), ytr)

    P_text = Xte_text
    P_eng = clf_eng.predict_proba(Xte_eng)
    P_fuse = clf_fuse.predict_proba(np.hstack([Xte_text, Xte_eng]))

    models = [
        ("text-only (current)", P_text, classes),
        ("engineered-only GBDT", P_eng, list(clf_eng.classes_)),
        ("FUSION text+engineered", P_fuse, list(clf_fuse.classes_)),
    ]

    for budget in (0.010, 0.015, 0.020):
        print(f"\n=== max recall within clean-FP <= {budget:.3f} ===")
        print(f"{'model':24}{'recall':>8}{'fp':>7}{'thr':>6}   per-category")
        for name, P, pc in models:
            overall, per, thr, fp = recall_at_fp(P, pc, yte, budget, classes)
            cats = " ".join(f"{c.split('-')[0]}={per.get(c, 0):.2f}" for c in classes if c != CLEAN)
            print(f"{name:24}{overall:>8.3f}{fp:>7.3f}{thr:>6.2f}   {cats}")

    # Persist artifacts for the real-site + adversarial stages.
    OUT.mkdir(exist_ok=True)
    np.savez(
        OUT / "text_model.npz",
        coef=text_lr.coef_.astype(np.float32),
        intercept=text_lr.intercept_.astype(np.float32),
        classes=np.array(text_lr.classes_),
    )
    with (OUT / "fusion_gbdt.pkl").open("wb") as fh:
        pickle.dump(clf_fuse, fh)
    with (OUT / "engineered_gbdt.pkl").open("wb") as fh:
        pickle.dump(clf_eng, fh)
    (OUT / "features.json").write_text(
        json.dumps({"engineered": ENG, "classes": classes, "clean": CLEAN}, indent=2),
        encoding="utf-8",
    )
    print(f"\nartifacts -> {OUT}")


if __name__ == "__main__":
    main()
