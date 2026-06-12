"""Fit a multinomial LogisticRegression over the frozen FNV hashing vectorizer.
Concatenates title+meta+text (title/meta are high-signal) before vectorizing.
Saves coef/intercept/classes to model.npz."""
import json
from pathlib import Path
from typing import List, Tuple

import numpy as np
from scipy.sparse import csr_matrix
from sklearn.linear_model import LogisticRegression

from classifier.extract import doc
from classifier.vectorize import DIMS, vectorize

ROOT = Path(__file__).resolve().parent


def _matrix(records: List[dict]) -> Tuple[csr_matrix, List[str]]:
    rows, cols, data, labels = [], [], [], []
    for i, rec in enumerate(records):
        for idx, val in vectorize(doc(rec)).items():
            rows.append(i); cols.append(idx); data.append(val)
        labels.append(rec["label"])
    X = csr_matrix((data, (rows, cols)), shape=(len(records), DIMS))
    return X, labels


def main() -> None:
    cfg = json.loads((ROOT / "poc.json").read_text(encoding="utf-8"))
    train = [json.loads(l) for l in
             (ROOT / cfg["paths"]["train"]).read_text(encoding="utf-8").split("\n")
             if l.strip()]
    X, y = _matrix(train)
    clf = LogisticRegression(max_iter=1000, class_weight="balanced", C=4.0)
    clf.fit(X, y)
    np.savez(ROOT / cfg["paths"]["model"], coef=clf.coef_.astype(np.float32),
             intercept=clf.intercept_.astype(np.float32),
             classes=np.array(clf.classes_))
    print(f"trained on {len(train)} docs, classes={list(clf.classes_)}")


if __name__ == "__main__":
    main()
