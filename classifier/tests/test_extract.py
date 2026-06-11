from classifier.extract import build_record, TEXT_TOKEN_CAP


def test_assembles_and_caps():
    raw = {
        "text": "  Free   ONLINE games  " + "x " * 5000,
        "title": "Poki",
        "meta": "Play free games",
        "structural": {"script_hosts": ["g.poki.com"], "iframe_count": 2,
                       "has_age_gate": False},
    }
    rec = build_record(raw, "https://www.poki.com/en", "games")
    assert rec["label"] == "games"
    assert rec["etld1"] == "poki.com"
    assert rec["title"] == "Poki"
    # text is whitespace-collapsed and token-capped
    assert "  " not in rec["text"]
    assert len(rec["text"].split()) <= TEXT_TOKEN_CAP
    assert rec["structural"]["iframe_count"] == 2


def test_missing_fields_default_safely():
    rec = build_record({"text": "hi"}, "https://x.example", "clean")
    assert rec["title"] == "" and rec["meta"] == ""
    assert rec["structural"] == {"script_hosts": [], "iframe_count": 0,
                                 "has_age_gate": False}
