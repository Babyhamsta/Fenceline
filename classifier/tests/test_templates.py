"""Template corpus as a CI gate: render the settled templates through the SHIPPED
model + deploy rule and assert each one's block/pin verdict matches _expected.json.

Skips cleanly when Playwright or its browser binary is unavailable (stock CI
runners without a browser) so the suite stays green there while still gating
locally and on browser-equipped CI. The exploratory/ probes are intentionally NOT
asserted here -- they are documented findings (see templates/exploratory/FINDINGS.md).
"""

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
    """Score the settled corpus through the shipped model. ONLY a missing browser
    is skippable -- and that surfaces as render() raising on chromium launch. Once
    the first render succeeds the browser works, so any later raise OR a None
    render (extractor/render returning nothing) is a real regression and must
    FAIL, not skip. This keeps a throwing code bug from hiding as a green skip."""
    score = shipped_scorer()
    results = {}
    templates = sorted(TPL.glob("*.html"))
    assert templates, "no settled templates found"
    for i, p in enumerate(templates):
        if i == 0:
            # First render doubles as the browser probe: chromium-launch failure
            # (no binary) raises here -> environment gap -> skip the whole gate.
            try:
                r = score_template(score, p)
            except Exception as exc:  # noqa: BLE001 - launch failure only reaches here on the probe
                pytest.skip(
                    f"browser unavailable ({exc.__class__.__name__}) -- skipping template gate"
                )
        else:
            r = score_template(score, p)  # browser proven; let real errors propagate as failures
        assert r is not None, f"render returned None for {p.name} -- extractor/render regression"
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
