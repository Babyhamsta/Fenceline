"""Python half of the pin-gate agreement: classifier.fp_audit.has_functional_element
must match the device pin gate (extension/lib/pins.js:pinWorthy) on every row of
the shared fixture. The JS half asserts the same table in test/detect.mjs. One
fixture, two languages -> the host the device pins can't drift from what the
offline corpus router treats as a real instance.
"""

import json
from pathlib import Path

import pytest

from classifier.fp_audit import has_functional_element

FIXTURE = Path(__file__).resolve().parents[2] / "test" / "fixtures" / "pin_agreement.json"
ROWS = json.loads(FIXTURE.read_text(encoding="utf-8"))["rows"]


@pytest.mark.parametrize("row", ROWS, ids=[r["name"] for r in ROWS])
def test_pin_gate_matches_fixture(row):
    got = bool(has_functional_element(row["category"], row["structural"]))
    assert got == row["pin"], (
        f"has_functional_element({row['category']!r}, {row['structural']}) = {got}, "
        f"fixture expects {row['pin']}"
    )
