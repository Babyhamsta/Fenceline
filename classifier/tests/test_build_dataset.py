import json
from pathlib import Path

from classifier.build_dataset import prepare


def test_prepare_filters_dedups_and_splits(tmp_path):
    recs = []
    # 12 distinct usable games pages
    for i in range(12):
        recs.append({"etld1": f"g{i}.com", "url": f"https://g{i}.com", "label": "games",
                     "text": f"play free online games arcade racing puzzle number {i} " * 3,
                     "title": "g", "meta": "", "structural": {}})
    # a thin page (filtered out) and a near-dup of g0 (deduped)
    recs.append({"etld1": "thin.com", "url": "https://thin.com", "label": "games",
                 "text": "hi", "title": "", "meta": "", "structural": {}})
    recs.append({"etld1": "dup.com", "url": "https://dup.com", "label": "games",
                 "text": "play free online games arcade racing puzzle number 0 " * 3,
                 "title": "g", "meta": "", "structural": {}})
    raw = tmp_path / "raw.jsonl"
    raw.write_text("\n".join(json.dumps(r) for r in recs) + "\n", encoding="utf-8")

    train, val, test = prepare(raw, ratios=(0.7, 0.15, 0.15), seed=0)
    kept = train + val + test
    assert all(len(r["text"].split()) >= 20 for r in kept)   # thin removed
    assert len(kept) == 12                                    # dup removed
    etlds = [{r["etld1"] for r in s} for s in (train, val, test)]
    assert etlds[0].isdisjoint(etlds[2])                      # no leak
