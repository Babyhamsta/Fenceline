"""Held-out effectiveness gate as a test: score the shipped hybrid over the real
labeled test set and fail if clean-FP rises above the committed ceiling or any
category's detection recall drops below its committed floor (both directions).

The corpus (classifier/data/) is gitignored and not redistributed, so this SKIPS
when test.jsonl is absent -- it gates locally and on private runners that have the
data; the committed baseline (classifier/metrics_baseline.json) travels with the
repo so the thresholds are reviewable even where the data isn't.
"""

from pathlib import Path

import pytest

from classifier.metrics_gate import (
    BASELINE,
    TEST_SET,
    assert_against_baseline,
    load_rows,
    measure,
)

if not Path(TEST_SET).exists():
    pytest.skip(
        "held-out test set absent (corpus gitignored) -- metrics gate runs locally/private CI",
        allow_module_level=True,
    )


def test_baseline_exists():
    assert BASELINE.exists(), "metrics_baseline.json missing -- run metrics_gate --update-baseline"


def test_shipped_hybrid_meets_baseline():
    rows = load_rows(Path(TEST_SET))
    m = measure(rows)
    fails = assert_against_baseline(m)
    assert fails == 0, f"{fails} held-out metric(s) regressed past the committed baseline"
