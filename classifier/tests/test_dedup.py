from classifier.dedup import simhash, hamming, dedup


def test_identical_text_same_hash():
    assert simhash("free online games play now") == simhash("free online games play now")


def test_near_duplicate_low_distance():
    a = simhash("play free online games puzzles racing arcade fun")
    b = simhash("play free online games puzzles racing arcade fun today")
    assert hamming(a, b) <= 6


def test_dedup_collapses_template_farm():
    base = "play free online games puzzles racing arcade multiplayer fun"
    recs = [{"text": base + f" mirror {i}", "etld1": f"site{i}.com"} for i in range(5)]
    recs.append({"text": "online casino real money blackjack roulette slots bet",
                 "etld1": "casino.com"})
    kept = dedup(recs, max_distance=4)
    # the 5 near-identical game mirrors collapse to 1; casino stays
    assert len(kept) == 2
