"""Effectiveness METER + regression GATE for the shipped hybrid model.

Unlike the template corpus (a handful of synthetic tripwire pages) and unlike
evaluate.py (which scores the TEXT model alone, argmax+threshold, no fusion), this
scores the EXACT shipped decision -- fusion_ref text+fusion scores through
fp_audit.hybrid_decide, the byte-mirror of extension/lib/model.js:decide -- over
the held-out, eTLD-disjoint test set (classifier/data/test.jsonl, ~5900 real
labeled pages with real scrape-time structural features). It produces NUMBERS:

  - clean false-positive rate     (clean pages the model blocks -- the real harm)
  - per-category DETECTION recall (true blocked page blocked as ANYTHING -- what a
                                   CIPA filter cares about: was it stopped)
  - per-category EXACT recall     (blocked as the CORRECT category -- cosmetic)
  - per-category precision        (of pages blocked as c, how many truly are c)
  - wrong-category confusion count

`--assert` gates those numbers against classifier/data/metrics_baseline.json
(committed): FAIL if clean-FP rises above the ceiling OR any category's detection
recall drops below its floor. Hard, both directions. `--update-baseline`
regenerates the baseline from the current run (ceiling = observed FP + margin,
floor = observed recall - margin). `--sweep` prints the clean-FP vs recall
trade-off across candidate fusion thresholds so the operating point is visible.

The corpus is gitignored (not redistributed), so this is a LOCAL / private-CI
gate; the committed baseline travels, the data does not. The pytest wrapper
(classifier/tests/test_metrics_gate.py) skips when test.jsonl is absent.

Run:
  python -m classifier.metrics_gate                     # print the meter table
  python -m classifier.metrics_gate --assert            # gate vs baseline
  python -m classifier.metrics_gate --update-baseline   # rebaseline from now
  python -m classifier.metrics_gate --sweep             # threshold trade-off
"""

import argparse
import json
import sys
import time
from pathlib import Path
from typing import Dict, List, Optional, Tuple

from classifier import fusion_ref
from classifier.fp_audit import CLEAN, hybrid_decide

ROOT = Path(__file__).resolve().parent
TEST_SET = ROOT / "data" / "test.jsonl"
# Baseline lives at the classifier ROOT (tracked), NOT under data/ (gitignored
# corpus) — it is numbers, not pages, and must travel with the repo so the gate
# thresholds are reviewable everywhere even though the held-out data is not.
BASELINE = ROOT / "metrics_baseline.json"
BLOCK_CATS = ("adult", "proxy-bypass", "gambling", "games")

# Gate margins (percentage points). Absorb scoring noise / minor drift so the gate
# fires on real regressions, not float jitter. clean-FP may rise at most this much
# above the recorded value; recall may fall at most this much below it.
FP_MARGIN_PP = 1.0
RECALL_MARGIN_PP = 3.0


def load_rows(path: Path) -> List[Dict]:
    return [
        json.loads(line) for line in path.read_text(encoding="utf-8").splitlines() if line.strip()
    ]


def _decide(rec: Dict, thr_fusion: Optional[float] = None, thr_text: Optional[float] = None):
    """Shipped hybrid decision for one record. thr_* override the bundled operating
    point (used by --sweep); None = the shipped thresholds inside hybrid_decide."""
    s = rec.get("structural") or {}
    ts = fusion_ref.text_scores(rec)
    fs = fusion_ref.fusion_scores(ts, s)
    if thr_fusion is None and thr_text is None:
        cat, _, _ = hybrid_decide(rec.get("url", ""), ts, fs, s)
        return cat
    # Threshold override path: replicate hybrid_decide with custom thresholds.
    from classifier.decision import is_search_engine_url, prose_rescue

    if is_search_engine_url(rec.get("url", "")):
        return CLEAN
    fc, fp = _top(fs)
    if fp >= thr_fusion:
        return fc
    tc, tp = _top(ts)
    if tp >= thr_text and not prose_rescue(tc, s):
        return tc
    return CLEAN


def _top(scores: Dict[str, float]) -> Tuple[str, float]:
    best_c, best_p = CLEAN, -1.0
    for c, p in scores.items():
        if c != CLEAN and p > best_p:
            best_c, best_p = c, p
    return best_c, best_p


def measure(rows: List[Dict], thr_fusion=None, thr_text=None) -> Dict:
    """Score every row; return the metric bundle."""
    clean_total = clean_fp = 0
    detected = {c: 0 for c in BLOCK_CATS}  # blocked as anything
    exact = {c: 0 for c in BLOCK_CATS}  # blocked as the correct category
    total = {c: 0 for c in BLOCK_CATS}
    predicted = {c: 0 for c in BLOCK_CATS}  # times the model output category c
    pred_correct = {c: 0 for c in BLOCK_CATS}
    wrong_cat = 0
    for r in rows:
        cat = _decide(r, thr_fusion, thr_text)
        blocked = cat != CLEAN
        if blocked and cat in predicted:
            predicted[cat] += 1
        lab = r.get("label")
        if lab == CLEAN:
            clean_total += 1
            if blocked:
                clean_fp += 1
        elif lab in total:
            total[lab] += 1
            if blocked:
                detected[lab] += 1
                if cat == lab:
                    exact[lab] += 1
                    pred_correct[lab] += 1
                else:
                    wrong_cat += 1
    return {
        "n": len(rows),
        "clean_total": clean_total,
        "clean_fp": clean_fp,
        "clean_fp_rate": clean_fp / max(1, clean_total),
        "total": total,
        "detected": detected,
        "exact": exact,
        "predicted": predicted,
        "pred_correct": pred_correct,
        "detection_recall": {c: detected[c] / max(1, total[c]) for c in BLOCK_CATS},
        "exact_recall": {c: exact[c] / max(1, total[c]) for c in BLOCK_CATS},
        "precision": {c: pred_correct[c] / max(1, predicted[c]) for c in BLOCK_CATS},
        "wrong_cat": wrong_cat,
    }


def print_table(m: Dict) -> None:
    print(f"scored {m['n']} held-out rows (model={fusion_ref.META.get('version')})\n")
    print(
        f"CLEAN false-positive rate : {m['clean_fp']}/{m['clean_total']} = {100 * m['clean_fp_rate']:.2f}%"
    )
    print(f"wrong-category blocks     : {m['wrong_cat']}\n")
    print(f"{'category':14}{'detect recall':16}{'exact recall':16}{'precision':12}")
    print("-" * 58)
    for c in BLOCK_CATS:
        dr = m["detection_recall"][c]
        det_col = f"{100 * dr:.1f}% ({m['detected'][c]}/{m['total'][c]})"
        er_col = f"{100 * m['exact_recall'][c]:.1f}%"
        pr_col = f"{100 * m['precision'][c]:.1f}%"
        print(f"{c:14}{det_col:16}{er_col:16}{pr_col:12}")


def build_baseline(m: Dict) -> Dict:
    return {
        "model_version": fusion_ref.META.get("version"),
        "generated_from": "classifier/data/test.jsonl",
        "n": m["n"],
        "fp_margin_pp": FP_MARGIN_PP,
        "recall_margin_pp": RECALL_MARGIN_PP,
        "observed": {
            "clean_fp_rate": round(m["clean_fp_rate"], 4),
            "detection_recall": {c: round(m["detection_recall"][c], 4) for c in BLOCK_CATS},
        },
        "clean_fp_ceiling": round(m["clean_fp_rate"] + FP_MARGIN_PP / 100.0, 4),
        "recall_floor": {
            c: round(max(0.0, m["detection_recall"][c] - RECALL_MARGIN_PP / 100.0), 4)
            for c in BLOCK_CATS
        },
    }


def assert_against_baseline(m: Dict) -> int:
    """Hard gate, both directions. Returns failure count."""
    if not BASELINE.exists():
        print(f"  NO BASELINE at {BASELINE} -- run --update-baseline first")
        return 1
    base = json.loads(BASELINE.read_text(encoding="utf-8"))
    fails = 0
    ceil = base["clean_fp_ceiling"]
    print("\n=== gate vs baseline ===")
    if m["clean_fp_rate"] <= ceil:
        print(f"  ok    clean-FP {100 * m['clean_fp_rate']:.2f}% <= ceiling {100 * ceil:.2f}%")
    else:
        print(
            f"  FAIL  clean-FP {100 * m['clean_fp_rate']:.2f}% > ceiling {100 * ceil:.2f}% (REGRESSION)"
        )
        fails += 1
    for c in BLOCK_CATS:
        floor = base["recall_floor"][c]
        got = m["detection_recall"][c]
        if got >= floor:
            print(f"  ok    {c:14} recall {100 * got:.1f}% >= floor {100 * floor:.1f}%")
        else:
            print(f"  FAIL  {c:14} recall {100 * got:.1f}% < floor {100 * floor:.1f}% (REGRESSION)")
            fails += 1
    if base.get("model_version") != fusion_ref.META.get("version"):
        print(
            f"  note  baseline model {base.get('model_version')} != current "
            f"{fusion_ref.META.get('version')} -- rebaseline if this is an intended bump"
        )
    return fails


def sweep(rows: List[Dict]) -> None:
    """Clean-FP vs mean detection-recall across candidate fusion thresholds, with
    the text backstop held at the shipped value. Shows the operating-point curve."""
    thr_text = float(fusion_ref.META.get("thr_text") or 0.89)
    shipped_f = float(fusion_ref.META.get("thr_fusion") or 0.97)
    print(f"\nthreshold sweep (thr_text held at {thr_text}; shipped thr_fusion={shipped_f})")
    print(f"{'thr_fusion':12}{'clean-FP':12}{'mean detect recall':20}")
    print("-" * 44)
    for thr_f in (0.90, 0.93, 0.95, 0.97, 0.98, 0.99):
        m = measure(rows, thr_fusion=thr_f, thr_text=thr_text)
        mean_recall = sum(m["detection_recall"].values()) / len(BLOCK_CATS)
        mark = "  <- shipped" if abs(thr_f - shipped_f) < 1e-9 else ""
        fp_col = f"{100 * m['clean_fp_rate']:.2f}%"
        rec_col = f"{100 * mean_recall:.1f}%"
        print(f"{thr_f:<12}{fp_col:12}{rec_col:20}{mark}")


def main() -> None:
    ap = argparse.ArgumentParser(description="Held-out effectiveness meter + regression gate.")
    ap.add_argument("--test-set", default=str(TEST_SET), help="held-out jsonl (label+structural)")
    ap.add_argument("--assert", dest="do_assert", action="store_true", help="gate vs baseline")
    ap.add_argument("--update-baseline", action="store_true", help="rewrite baseline from this run")
    ap.add_argument("--sweep", action="store_true", help="print threshold trade-off curve")
    args = ap.parse_args()

    path = Path(args.test_set)
    if not path.exists():
        print(f"test set not found: {path} (corpus is gitignored -- run where it exists)")
        sys.exit(0 if not args.do_assert else 2)

    t0 = time.perf_counter()
    rows = load_rows(path)
    m = measure(rows)
    print_table(m)
    print(f"\nscored in {time.perf_counter() - t0:.1f}s")

    if args.sweep:
        sweep(rows)

    if args.update_baseline:
        BASELINE.write_text(json.dumps(build_baseline(m), indent=2) + "\n", encoding="utf-8")
        print(f"\nbaseline written -> {BASELINE}")

    if args.do_assert:
        fails = assert_against_baseline(m)
        print(f"\n{'metrics gate passed.' if not fails else f'{fails} REGRESSION(S).'}")
        sys.exit(1 if fails else 0)


if __name__ == "__main__":
    main()
