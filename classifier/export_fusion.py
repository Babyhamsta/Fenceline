"""Export the fusion GBDT (dist_v3/fusion_gbdt.pkl) + the v3 text model to the
shippable on-device artifacts:

  dist/model.bin / model-meta.json   the v3 TEXT model (same format the extension
                                     already loads), now carrying the hybrid
                                     thresholds + the engineered-feature order.
  dist/fusion.json                   the GBDT as a portable tree array the JS
                                     interpreter (extension/lib/fusion.js) walks.

A HistGradientBoostingClassifier predicts: raw[k] = baseline[k] + sum over all
iterations of tree[iter][k].leaf(X); proba = softmax(raw). Each node splits
`X[feature_idx] <= num_threshold -> left child else right`. The fusion input X is
[text_prob for each class (class order)] ++ [engineered scalars (ENG order)].

We re-walk the exported trees in pure Python and assert the result matches
clf.predict_proba to <1e-6 on the test set BEFORE writing — so the JSON is proven
faithful, and the JS interpreter only has to mirror this same walk (parity test).

Run: python -m classifier.export_fusion
"""

import hashlib
import json
import pickle
import shutil
from pathlib import Path

import numpy as np

from classifier.extract import doc
from classifier.train_gbdt import ENG, eng_vec, load
from classifier.vectorize import DIMS, vectorize

ROOT = Path(__file__).resolve().parent
SRC = ROOT / "dist_v3"
DIST = ROOT / "dist"

# Hybrid operating points (per-model thresholds at the ~1.5% clean-FP budget from
# the train_gbdt eval). Travel with the model so the device blocks as evaluated.
THR_FUSION = 0.97
THR_TEXT = 0.89


def export_trees(clf):
    """clf._predictors[iter][k].nodes -> compact per-tree node arrays. Each node:
    [feature_idx, threshold, left, right, value, is_leaf, missing_go_to_left]."""
    iters = []
    for iteration in clf._predictors:
        trees = []
        for tree in iteration:  # one tree per class
            nodes = []
            for n in tree.nodes:
                nodes.append(
                    [
                        int(n["feature_idx"]),
                        float(n["num_threshold"]),
                        int(n["left"]),
                        int(n["right"]),
                        float(n["value"]),
                        int(n["is_leaf"]),
                        int(n["missing_go_to_left"]),
                    ]
                )
            trees.append(nodes)
        iters.append(trees)
    return iters


def walk(nodes, x):
    """Mirror of HGBC tree traversal (and of the JS interpreter)."""
    i = 0
    while True:
        feat, thr, left, right, val, is_leaf, miss_left = nodes[i]
        if is_leaf:
            return val
        xv = x[feat]
        if xv != xv:  # NaN -> follow the trained missing direction
            i = left if miss_left else right
        else:
            i = left if xv <= thr else right


def raw_scores(iters, baseline, x):
    raw = list(baseline)
    for trees in iters:
        for k, nodes in enumerate(trees):
            raw[k] += walk(nodes, x)
    return raw


def softmax(raw):
    m = max(raw)
    e = [np.exp(v - m) for v in raw]
    z = sum(e)
    return [v / z for v in e]


def main() -> None:
    clf = pickle.load((SRC / "fusion_gbdt.pkl").open("rb"))
    classes = [str(c) for c in clf.classes_]
    baseline = [float(v) for v in np.asarray(clf._baseline_prediction).ravel()]
    iters = export_trees(clf)

    # ---- parity check: re-walk vs predict_proba on the test set --------------
    test = load("test")
    Xte_eng = np.array([eng_vec(r) for r in test])
    # text scores from the deployed v3 text model (same as classify_v3 uses)
    tm = np.load(SRC / "text_model.npz", allow_pickle=True)
    coef, intercept = tm["coef"].astype(np.float32), tm["intercept"].astype(np.float32)
    tclasses = list(tm["classes"])
    colmap = [tclasses.index(c) for c in classes]

    def text_probs(rec):
        lg = intercept.copy()
        for idx, v in vectorize(doc(rec)).items():
            lg += v * coef[:, idx]
        e = np.exp(lg - lg.max())
        p = e / e.sum()
        return p[colmap]  # aligned to `classes`

    X = np.hstack([np.array([text_probs(r) for r in test]), Xte_eng])
    ref = clf.predict_proba(X)
    mine = np.array([softmax(raw_scores(iters, baseline, X[i])) for i in range(len(X))])
    diff = float(np.max(np.abs(ref - mine)))
    print(f"parity (re-walk vs predict_proba): max abs diff = {diff:.2e} over {len(X)} rows")
    assert diff < 1e-6, f"tree export not faithful (diff {diff})"

    # ---- write fusion.json ---------------------------------------------------
    DIST.mkdir(parents=True, exist_ok=True)
    fusion = {
        "classes": classes,
        "baseline": baseline,
        "n_text": len(classes),  # first N features are text probs (class order)
        "engineered": ENG,  # remaining features, in this exact order
        "thr_fusion": THR_FUSION,
        "thr_text": THR_TEXT,
        "trees": iters,
    }
    blob = json.dumps(fusion, separators=(",", ":")).encode("utf-8")
    (DIST / "fusion.json").write_bytes(blob)
    print(f"wrote fusion.json ({len(blob) / 1e6:.2f} MB), {sum(len(it) for it in iters)} trees")

    # ---- export the v3 TEXT model to model.bin / model-meta.json -------------
    cfg = json.loads((ROOT / "poc.json").read_text(encoding="utf-8"))
    # text model already aligned to `classes`? sklearn LR classes_ order:
    coef_out = np.vstack([coef[tclasses.index(c)] for c in classes]).astype(np.float32)
    intercept_out = np.array(
        [float(intercept[tclasses.index(c)]) for c in classes], dtype=np.float32
    )
    binblob = coef_out.tobytes()
    (DIST / "model.bin").write_bytes(binblob)
    version = hashlib.sha256(binblob + blob).hexdigest()[:16]
    meta = {
        "version": version,
        "vectorizer": "fnv-hash-v1",
        "dims": DIMS,
        "classes": classes,
        "intercept": [float(x) for x in intercept_out],
        "clean_label": cfg["clean_label"],
        "block_threshold": cfg.get("block_threshold", 0.9),
        # hybrid params: fusion is primary, text is the backstop, both gated by
        # the structural article-guard (proseRescue) in the deploy rule.
        "model_kind": "hybrid-text-fusion",
        "thr_fusion": THR_FUSION,
        "thr_text": THR_TEXT,
        "fusion_file": "fusion.json",
    }
    (DIST / "model-meta.json").write_text(json.dumps(meta, indent=2), encoding="utf-8")
    print(f"wrote model.bin ({len(binblob)} bytes) + model-meta.json, version {version}")

    # Update the COMMITTED bundled baseline (what a fresh install loads, and what
    # the parity test validates). compile.mjs separately reads dist/ for OTA.
    bundled = ROOT.parent / "extension" / "model"
    bundled.mkdir(parents=True, exist_ok=True)
    for name in ("model.bin", "model-meta.json", "fusion.json"):
        shutil.copyfile(DIST / name, bundled / name)
    print(f"copied baseline -> {bundled}")


if __name__ == "__main__":
    main()
