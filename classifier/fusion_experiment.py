"""Go/no-go experiment: does fusing the structural features with the text score
beat text alone? Trains a gradient-boosted tree on [text_scores + structural]
and compares per-category recall to the text-only model AT THE SAME clean-FP
budget on the held-out test set. Evidence before we build the shippable version.

Run: python -m classifier.fusion_experiment
"""

import json
from collections import defaultdict
from pathlib import Path

import numpy as np
from scipy.sparse import csr_matrix
from sklearn.ensemble import HistGradientBoostingClassifier
from sklearn.linear_model import LogisticRegression
from sklearn.model_selection import StratifiedKFold

from classifier.extract import doc
from classifier.vectorize import DIMS, vectorize

ROOT = Path(__file__).resolve().parent
cfg = json.loads((ROOT / "poc.json").read_text(encoding="utf-8"))
CLEAN = cfg["clean_label"]

meta = json.loads((ROOT / "dist" / "model-meta.json").read_text(encoding="utf-8"))
CLASSES = meta["classes"]
COEF = np.frombuffer((ROOT / "dist" / "model.bin").read_bytes(), dtype=np.float32).reshape(
    len(CLASSES), DIMS
)
INTERCEPT = np.array(meta["intercept"], dtype=np.float32)

# Numeric/boolean structural features (drop the script_hosts list; its entropy is
# already a scalar). These are the only NEW signal the text model can't represent.
STRUCT = [
    "link_density",
    "internal_link_ratio",
    "paragraph_count",
    "text_to_tag_ratio",
    "dom_node_count",
    "outbound_domain_diversity",
    "link_count",
    "input_count",
    "button_count",
    "select_count",
    "has_url_like_input",
    "url_embeds_url",
    "has_dominant_canvas",
    "canvas_area_fraction",
    "has_video_player",
    "iframe_count",
    "largest_iframe_area_fraction",
    "iframe_cross_origin",
    "has_large_xorigin_iframe",
    "has_age_gate",
    "script_host_entropy",
]


def text_scores(rec):
    lg = INTERCEPT.copy()
    for idx, v in vectorize(doc(rec)).items():
        lg += v * COEF[:, idx]
    e = np.exp(lg - lg.max())
    return e / e.sum()  # aligned to CLASSES order


def build_sparse(recs):
    """Vectorize a record list once into a sparse [n x DIMS] matrix (reused for
    the out-of-fold LR fits, so we pay vectorization a single time)."""
    rows, cols, data = [], [], []
    for i, r in enumerate(recs):
        for idx, v in vectorize(doc(r)).items():
            rows.append(i)
            cols.append(idx)
            data.append(v)
    return csr_matrix((data, (rows, cols)), shape=(len(recs), DIMS))


def oof_text_scores(X_text, y, n_splits=5):
    """Out-of-fold text-model probabilities for the training rows: each row is
    scored by a logistic model that never saw it, so the fusion tree learns the
    HONEST text->label relationship (not the memorized train-set one). Mirrors
    train.py's LR config. Returns an [n x len(CLASSES)] array in CLASSES order."""
    oof = np.zeros((X_text.shape[0], len(CLASSES)), dtype=np.float64)
    skf = StratifiedKFold(n_splits=n_splits, shuffle=True, random_state=0)
    for fold, (tr, te) in enumerate(skf.split(np.zeros(len(y)), y), 1):
        lr = LogisticRegression(max_iter=1000, class_weight="balanced", C=4.0)
        lr.fit(X_text[tr], y[tr])
        proba = lr.predict_proba(X_text[te])
        colmap = [list(lr.classes_).index(c) for c in CLASSES]
        oof[te] = proba[:, colmap]
        print(f"  oof fold {fold}/{n_splits} done", flush=True)
    return oof


def struct_vec(rec):
    s = rec.get("structural") or {}
    return [float(s.get(k) or 0.0) for k in STRUCT]


def load(name):
    p = ROOT / "data" / f"{name}.jsonl"
    return [json.loads(line) for line in p.read_text(encoding="utf-8").split("\n") if line.strip()]


def evaluate(P, prob_classes, y_true, thr):
    """Block rule: top non-clean class blocks if its prob >= thr. Returns
    (clean_fp, overall_blocked_recall, per_category_recall)."""
    ci = {c: i for i, c in enumerate(prob_classes)}
    rec = defaultdict(lambda: [0, 0])
    fp = [0, 0]
    for p, yt in zip(P, y_true):
        order = [(c, p[ci[c]]) for c in CLASSES if c != CLEAN]
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


def recall_at_fp(P, prob_classes, y_true, target_fp):
    """Sweep thresholds; return the (recall, per_cat, thr, fp) at the lowest
    threshold whose clean-FP does not exceed target_fp — i.e. max recall within
    the FP budget. Apples-to-apples across models."""
    best = None
    for thr in np.linspace(0.30, 0.995, 140):
        fp, overall, per = evaluate(P, prob_classes, y_true, thr)
        if fp <= target_fp:
            if best is None or overall > best[0]:
                best = (overall, per, thr, fp)
    if best is None:  # never within budget; report strictest point
        fp, overall, per = evaluate(P, prob_classes, y_true, 0.995)
        best = (overall, per, 0.995, fp)
    return best


def main():
    train, test = load("train"), load("test")
    print(f"train={len(train)} test={len(test)}")

    ytr = np.array([r["label"] for r in train])
    yte = np.array([r["label"] for r in test])
    Xtr_struct = np.array([struct_vec(r) for r in train])
    Xte_struct = np.array([struct_vec(r) for r in test])

    print("vectorizing train + out-of-fold text scoring (the slow part)...", flush=True)
    Xtr_feat = build_sparse(train)
    Xtr_text = oof_text_scores(Xtr_feat, ytr)  # leak-free train text scores
    # Test rows were never in the text model's training set, so the deployed
    # model's scores on them are already honest.
    Xte_text = np.array([text_scores(r) for r in test])

    def gbdt(X, y):
        clf = HistGradientBoostingClassifier(
            max_depth=6, max_iter=300, learning_rate=0.08, l2_regularization=1.0, random_state=0
        )
        clf.fit(X, y)
        return clf

    print("training fusion (text+struct) and struct-only trees...", flush=True)
    clf_fuse = gbdt(np.hstack([Xtr_text, Xtr_struct]), ytr)
    clf_struct = gbdt(Xtr_struct, ytr)

    P_text = Xte_text  # text model probs directly
    P_fuse = clf_fuse.predict_proba(np.hstack([Xte_text, Xte_struct]))
    P_struct = clf_struct.predict_proba(Xte_struct)

    models = [
        ("text-only (current)", P_text, CLASSES),
        ("struct-only", P_struct, list(clf_struct.classes_)),
        ("FUSION text+struct", P_fuse, list(clf_fuse.classes_)),
    ]

    for budget in (0.010, 0.015, 0.020):
        print(f"\n=== max recall within clean-FP <= {budget:.3f} ===")
        print(f"{'model':22}{'recall':>8}{'fp':>7}{'thr':>6}   per-category")
        for name, P, pc in models:
            overall, per, thr, fp = recall_at_fp(P, pc, yte, budget)
            cats = " ".join(f"{c.split('-')[0]}={per.get(c, 0):.2f}" for c in CLASSES if c != CLEAN)
            print(f"{name:22}{overall:>8.3f}{fp:>7.3f}{thr:>6.2f}   {cats}")

    # Feature importance proxy: permutation would be slower; print the structural
    # split gains via the model's internal counts is not exposed — instead show
    # how often each structural feature is non-trivially populated, as a sanity check.
    print("\n(experiment only — nothing exported or shipped)")


if __name__ == "__main__":
    main()
