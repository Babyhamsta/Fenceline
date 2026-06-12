"""Eval metrics. fp_rate_on_clean is the number that governs shippability:
how often a legitimate (clean) page gets flagged as a blocked category."""

from typing import Dict, List


def per_class(y_true: List[str], y_pred: List[str], labels: List[str]) -> Dict:
    out: Dict[str, Dict[str, float]] = {}
    for lab in labels:
        tp = sum(1 for t, p in zip(y_true, y_pred) if p == lab and t == lab)
        fp = sum(1 for t, p in zip(y_true, y_pred) if p == lab and t != lab)
        fn = sum(1 for t, p in zip(y_true, y_pred) if p != lab and t == lab)
        prec = tp / (tp + fp) if (tp + fp) else 0.0
        rec = tp / (tp + fn) if (tp + fn) else 0.0
        out[lab] = {"precision": prec, "recall": rec, "support": tp + fn}
    return out


def fp_rate_on_clean(y_true: List[str], y_pred: List[str], clean_label: str) -> float:
    clean = [(t, p) for t, p in zip(y_true, y_pred) if t == clean_label]
    if not clean:
        return 0.0
    flagged = sum(1 for _t, p in clean if p != clean_label)
    return flagged / len(clean)
