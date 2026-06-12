from classifier.decontaminate import contamination_category, partition_clean


def _rec(text, label="clean", title="", age_gate=False):
    return {"text": text, "title": title, "meta": "", "label": label,
            "etld1": "x.com", "url": "https://x.com",
            "structural": {"has_age_gate": age_gate}}


def test_flags_casino_with_two_signals():
    assert contamination_category(_rec(
        "Best online casino welcome bonus play slots and roulette now")) == "gambling"


def test_single_mention_is_not_flagged():
    # a news article mentioning a casino once must stay clean
    assert contamination_category(_rec(
        "The city council approved a new hotel near the old casino downtown "
        "after a long debate about traffic and parking for residents")) is None


def test_age_gate_alone_does_not_flag():
    # age-gates appear on alcohol/finance/vaping sites too — not enough alone
    assert contamination_category(_rec(
        "Verify your age to continue you must be 18 or over to use this service",
        age_gate=True)) is None


def test_explicit_adult_vocabulary_flags():
    assert contamination_category(_rec(
        "Free porn videos xxx hardcore nude camgirl live sex cams updated daily")
        ) == "adult"


def test_word_boundaries_avoid_false_hits():
    # alphabet/essex/slothful must not trigger bet/sex/slot
    assert contamination_category(_rec(
        "Learn the alphabet in Essex with our slothful study method today "
        "for children and parents who want a calm relaxed pace of learning")) is None


def test_web_proxy_flagged():
    assert contamination_category(_rec(
        "Free web proxy unblock any site just enter a url and browse "
        "anonymously through our online proxy")) == "proxy-bypass"


def test_partition_only_touches_clean_rows():
    recs = [_rec("online casino slots jackpot", label="clean"),
            _rec("totally normal homepage about widgets and gears", label="clean"),
            _rec("online casino slots jackpot", label="gambling")]
    kept, quar = partition_clean(recs, "clean")
    assert len(quar) == 1 and quar[0]["contamination"] == "gambling"
    assert len(kept) == 2  # the genuine clean + the (untouched) gambling row
    assert any(r["label"] == "gambling" for r in kept)
