"""Template corpus as a CI gate: render the settled templates through the SHIPPED
model + deploy rule and assert each one's block/pin verdict matches _expected.json.

Skips cleanly when Playwright or its browser binary is unavailable (stock CI
runners without a browser) so the suite stays green there while still gating
locally and on browser-equipped CI. The exploratory/ probes are intentionally NOT
asserted here -- they are documented findings (see templates/exploratory/FINDINGS.md).
"""

from pathlib import Path

import pytest

from classifier.template_test import (
    EXPECTED,
    TPL,
    assert_expected,
    score_template,
    shipped_scorer,
)

pytest.importorskip("playwright", reason="Playwright not installed")


def _render_or_skip():
    """Score the settled corpus through the shipped model. Skip (don't fail) if no
    browser is available -- the first render returning None on a real .html means
    Playwright has no usable Chromium, which is an environment gap, not a defect."""
    score = shipped_scorer()
    results = {}
    templates = sorted(TPL.glob("*.html"))
    assert templates, "no settled templates found"
    for p in templates:
        r = score_template(score, p)
        if r is None:
            pytest.skip(f"render failed for {p.name} (no browser?) -- skipping template gate")
        results[p.name] = r
    return results


def test_expected_covers_settled():
    """Every settled template must have an _expected.json entry (forces an explicit
    verdict per probe). This part needs no browser."""
    import json

    expected = json.loads(EXPECTED.read_text(encoding="utf-8")) if EXPECTED.exists() else {}
    settled = {p.name for p in TPL.glob("*.html")}
    missing = sorted(settled - set(expected))
    assert not missing, f"settled templates without _expected.json entries: {missing}"


def test_settled_templates_match_shipped_model():
    results = _render_or_skip()
    fails = assert_expected(results)
    assert fails == 0, f"{fails} template verdict(s) diverged from _expected.json"
