"""Render synthetic HTML templates through the SAME pipeline as live sites and
show, per template, (a) the model's block verdict and (b) whether the device
would PIN the host. Pinning = the page IS an instance (carries the category's
functional element); see extension/lib/pins.js:pinWorthy, mirrored here by
classifier.fp_audit.has_functional_element.

This makes the is-vs-about gap concrete and demonstrates the pin-gate fix: a
template that merely DISCUSSES proxies/games (a forum thread, a blog) blocks this
visit but is NOT pin-worthy -> the host is never blanketed; a real proxy/game
template carries the functional element -> pin-worthy.

By DEFAULT the harness scores the SHIPPED model -- the exact artifacts the
extension loads (extension/model/*, read by classifier.fusion_ref) and the exact
deploy rule the device runs (classifier.fp_audit.hybrid_decide, a byte-mirror of
extension/lib/model.js:decide). So a template verdict here predicts on-device
behaviour. `--dist DIR` swaps in a dist_v3-format model (text_model.npz +
fusion_gbdt.pkl) for BEFORE/AFTER experiments only -- that path does NOT
necessarily match what ships.

Two corpora:
  classifier/templates/*.html              settled cases with known-correct
                                           verdicts in _expected.json -> asserted
  classifier/templates/exploratory/*.html  uncertain / policy-contested probes
                                           -> printed, never asserted (calibration)

Drop a new <name>.html into classifier/templates/ (and add its expected verdict
to _expected.json) to add an asserted probe; drop it into templates/exploratory/
to add a print-only probe.

Run:
  python -m classifier.template_test                 # print settled set (shipped)
  python -m classifier.template_test --all           # + exploratory
  python -m classifier.template_test --assert         # gate on _expected.json
  python -m classifier.template_test --dist dist_v3   # score an experiment model
"""

import argparse
import json
import sys
from pathlib import Path
from typing import Callable, Dict, Optional, Tuple

from classifier import fusion_ref
from classifier.decision import has_functional_element, hybrid_decide
from classifier.extract import build_record
from classifier.render import render

CLEAN = fusion_ref.META.get("clean_label", "clean")
THR_FUSION = float(fusion_ref.META.get("thr_fusion") or 0.97)
THR_TEXT = float(fusion_ref.META.get("thr_text") or 0.89)

ROOT = Path(__file__).resolve().parent
TPL = ROOT / "templates"
EXPLORATORY = TPL / "exploratory"
EXPECTED = TPL / "_expected.json"

# A scorer maps (url, rec) -> (category, confidence, reason). category == CLEAN
# means "allowed". The default scores the shipped artifacts; --dist scores a
# dist_v3-format experiment model instead.
Scorer = Callable[[str, Dict], Tuple[str, float, str]]


def shipped_scorer() -> Scorer:
    """Score the exact model + deploy rule the extension ships."""

    def score(url: str, rec: Dict) -> Tuple[str, float, str]:
        structural = rec.get("structural") or {}
        ts = fusion_ref.text_scores(rec)
        fs = fusion_ref.fusion_scores(ts, structural)
        return hybrid_decide(
            url, ts, fs, structural, clean=CLEAN, thr_fusion=THR_FUSION, thr_text=THR_TEXT
        )

    return score


def dist_scorer(dist: str) -> Scorer:
    """Score a dist_v3-format model dir (experiment / before-after). Imported
    lazily so the default path needs only the shipped artifacts."""
    from classifier.fp_score import Model

    model = Model(dist)

    def score(url: str, rec: Dict) -> Tuple[str, float, str]:
        return model.decide(url, rec)

    return score


def verdict(score: Scorer, uri: str, rec: Dict) -> Tuple[str, float, str, bool, bool]:
    """Return (category, confidence, reason, blocked, pins)."""
    s = rec.get("structural") or {}
    cat, conf, why = score(uri, rec)
    blocked = cat != CLEAN
    pins = blocked and has_functional_element(cat, s)
    return cat, conf, why, blocked, pins


def tells(s: Dict) -> str:
    return (
        f"paras={s.get('paragraph_count')} ld={s.get('link_density')} "
        f"url_in={int(bool(s.get('has_url_like_input')))} embed={int(bool(s.get('url_embeds_url')))} "
        f"canvas={int(bool(s.get('has_dominant_canvas')))} video={int(bool(s.get('has_video_player')))} "
        f"age={int(bool(s.get('has_age_gate')))} seal={int(bool(s.get('has_gambling_license_seal')))} "
        f"pay={int(bool(s.get('has_payment_field')))} xframe={int(bool(s.get('has_large_xorigin_iframe')))} "
        f"intlink={s.get('internal_link_ratio')}"
    )


def score_template(score: Scorer, p: Path) -> Optional[Dict]:
    """Render + score one template. None on render failure."""
    raw = render(p.as_uri())
    if raw is None:
        return None
    rec = build_record(raw, p.as_uri(), "clean")
    cat, conf, why, blocked, pins = verdict(score, p.as_uri(), rec)
    return {
        "name": p.name,
        "block": cat if blocked else "clean",
        "category": cat,
        "confidence": conf,
        "reason": why,
        "blocked": blocked,
        "pin": pins,
        "structural": rec.get("structural") or {},
    }


def print_row(r: Optional[Dict], name: str) -> None:
    if r is None:
        print(f"{name:30}RENDER FAIL")
        return
    v = (
        f"{r['category']}@{r['confidence']:.2f} ({r['reason']})"
        if r["blocked"]
        else "clean (allowed)"
    )
    pins = "PIN host" if r["pin"] else ("block page only" if r["blocked"] else "-")
    print(f"{r['name']:30}{v:30}{pins:16}{tells(r['structural'])}")


def run(score: Scorer, include_exploratory: bool) -> Dict[str, Dict]:
    """Score every template; print the table; return {name: result}."""
    print(f"{'template':30}{'block verdict':30}{'pins host?':16}structural tells")
    print("-" * 140)
    results: Dict[str, Dict] = {}
    for p in sorted(TPL.glob("*.html")):
        r = score_template(score, p)
        print_row(r, p.name)
        if r is not None:
            results[p.name] = r
    if include_exploratory and EXPLORATORY.is_dir():
        print("\n--- exploratory (printed, never asserted) ---")
        for p in sorted(EXPLORATORY.glob("*.html")):
            print_row(score_template(score, p), p.name)
    return results


def assert_expected(results: Dict[str, Dict]) -> int:
    """Compare settled results to _expected.json. Return count of mismatches."""
    expected = json.loads(EXPECTED.read_text(encoding="utf-8")) if EXPECTED.exists() else {}
    fails = 0
    missing = sorted(set(results) - set(expected))
    for name in missing:
        print(f"  MISSING EXPECTED  {name}: settled template has no _expected.json entry")
        fails += 1
    print("\n=== assertions ===")
    for name in sorted(results):
        if name not in expected:
            continue
        r = results[name]
        exp = expected[name]
        got = {"block": r["block"], "pin": r["pin"]}
        want = {"block": exp["block"], "pin": bool(exp.get("pin", False))}
        if got == want:
            print(f"  ok    {name:30} block={got['block']:14} pin={got['pin']}")
        else:
            print(
                f"  FAIL  {name:30} got block={got['block']!r} pin={got['pin']} "
                f"!= want block={want['block']!r} pin={want['pin']}  "
                f"[{r['reason']} {tells(r['structural'])}]"
            )
            fails += 1
    return fails


def main() -> None:
    ap = argparse.ArgumentParser(description="Score synthetic HTML templates + pin decision.")
    ap.add_argument(
        "--dist", default="", help="dist_v3-format model dir for experiments (default: shipped)"
    )
    ap.add_argument("--all", action="store_true", help="also render templates/exploratory/")
    ap.add_argument(
        "--assert",
        dest="do_assert",
        action="store_true",
        help="gate settled verdicts against _expected.json (nonzero exit on mismatch)",
    )
    args = ap.parse_args()

    score = dist_scorer(args.dist) if args.dist else shipped_scorer()
    label = args.dist or "shipped (extension/model)"
    print(f"model={label}  (block verdict = hybrid decide; pin = has_functional_element)\n")

    results = run(score, include_exploratory=args.all or args.do_assert)
    if args.do_assert:
        fails = assert_expected(results)
        print(f"\n{'all template assertions passed.' if not fails else f'{fails} FAILURE(S).'}")
        sys.exit(1 if fails else 0)


if __name__ == "__main__":
    main()
