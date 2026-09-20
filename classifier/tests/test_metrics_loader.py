"""JSONL loader regressions independent of the held-out corpus."""

import json
from pathlib import Path

import pytest

from classifier.metrics_gate import load_rows


@pytest.mark.parametrize("separator", ["\u2028", "\u2029", "\u0085"])
def test_unicode_line_separators_remain_inside_records(tmp_path: Path, separator: str) -> None:
    records = [{"title": f"one{separator}two", "label": "clean"}, {"label": "adult"}]
    path = tmp_path / "records.jsonl"
    path.write_text(
        "\n\n".join(json.dumps(row, ensure_ascii=False) for row in records) + "\n",
        encoding="utf-8",
    )
    assert load_rows(path) == records
