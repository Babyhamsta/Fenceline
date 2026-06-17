from classifier.dedup import dedup, hamming, simhash


def test_identical_text_same_hash():
    assert simhash("free online games play now") == simhash("free online games play now")


def test_near_duplicate_low_distance():
    a = simhash("play free online games puzzles racing arcade fun")
    b = simhash("play free online games puzzles racing arcade fun today")
    assert hamming(a, b) <= 6


def test_dedup_collapses_template_farm():
    base = "play free online games puzzles racing arcade multiplayer fun"
    recs = [{"text": base + f" mirror {i}", "etld1": f"site{i}.com"} for i in range(5)]
    recs.append(
        {"text": "online casino real money blackjack roulette slots bet", "etld1": "casino.com"}
    )
    kept = dedup(recs, max_distance=4)
    # the 5 near-identical game mirrors collapse to 1; casino stays
    assert len(kept) == 2


def test_thin_body_pages_kept_via_title_meta():
    # interior canvas game pages: empty bodies, distinct titles/meta. Body-only
    # simhashing would collapse all of them to simhash("") and keep just one;
    # hashing the full doc keeps each distinct page.
    games = [
        ("Slope Unblocked Free Online", "endless downhill ball racer dodge obstacles"),
        ("Subway Surfers Play Now", "dash through the subway escape the grumpy inspector"),
        ("Geometry Dash Full Version", "rhythm based platformer jump and fly through danger"),
        ("Among Us Online Multiplayer", "find the impostor on the spaceship complete tasks"),
        ("Tetris Classic Puzzle", "stack falling blocks clear lines beat your high score"),
    ]
    recs = [
        {"text": "", "title": t, "meta": m, "etld1": f"game{i}.com"}
        for i, (t, m) in enumerate(games)
    ]
    kept = dedup(recs, max_distance=4)
    assert len(kept) == 5  # body-only dedup would have left exactly 1
