import json

from classifier.build_dataset import prepare


def _doc(i: int) -> str:
    # >= 20 tokens, dominated by tokens unique to index i, so genuinely distinct
    # pages stay far apart under simhash (min pairwise distance ~18) and survive
    # dedup at the production max_distance. An identical _doc(i) is a true
    # near-duplicate (distance 0) and collapses.
    unique = " ".join(f"u{i}w{j}" for j in range(22))
    return f"games portal online play category {i} {unique}"


def test_prepare_filters_dedups_and_splits(tmp_path):
    recs = [{"etld1": f"g{i}.com", "url": f"https://g{i}.com", "label": "games",
             "text": _doc(i), "title": "g", "meta": "", "structural": {}}
            for i in range(12)]
    # a thin page (filtered out) and a true near-dup of g0 (collapses into it)
    recs.append({"etld1": "thin.com", "url": "https://thin.com", "label": "games",
                 "text": "hi there", "title": "", "meta": "", "structural": {}})
    recs.append({"etld1": "dup.com", "url": "https://dup.com", "label": "games",
                 "text": _doc(0), "title": "g", "meta": "", "structural": {}})
    raw = tmp_path / "raw.jsonl"
    raw.write_text("\n".join(json.dumps(r) for r in recs) + "\n", encoding="utf-8")

    train, val, test = prepare(raw, ratios=(0.7, 0.15, 0.15), seed=0)
    kept = train + val + test
    assert all(len(r["text"].split()) >= 20 for r in kept)   # thin removed
    assert len(kept) == 12                                    # dup collapsed
    etlds = [{r["etld1"] for r in s} for s in (train, val, test)]
    assert etlds[0].isdisjoint(etlds[2])                      # no leak


def test_prepare_survives_unicode_line_separators_in_text(tmp_path):
    # page text with U+2028 must not tear the JSON record (str.splitlines bug)
    body = "games portal online play arcade racing puzzle   multiplayer fun "
    recs = [{"etld1": f"g{i}.com", "url": f"https://g{i}.com", "label": "games",
             "text": body + " ".join(f"u{i}w{j}" for j in range(22)),
             "title": "g", "meta": "", "structural": {}} for i in range(4)]
    raw = tmp_path / "raw.jsonl"
    raw.write_text("\n".join(json.dumps(r) for r in recs) + "\n", encoding="utf-8")
    train, val, test = prepare(raw, ratios=(0.7, 0.15, 0.15), seed=0)
    assert len(train + val + test) == 4  # all parsed, none torn/dropped
