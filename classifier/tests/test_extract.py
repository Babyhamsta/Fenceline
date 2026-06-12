from classifier.extract import TEXT_TOKEN_CAP, build_record, doc


def test_assembles_and_caps():
    raw = {
        "text": "  Free   ONLINE games  " + "x " * 5000,
        "title": "Poki",
        "meta": "Play free games",
        "structural": {"script_hosts": ["g.poki.com"], "iframe_count": 2, "has_age_gate": False},
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
    assert rec["structural"] == {"script_hosts": [], "iframe_count": 0, "has_age_gate": False}


def test_strips_data_uris_from_all_text_fields():
    # inlined base64 media must never reach the stored record (guardrail)
    blob = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJ"
    raw = {
        "text": f"hello {blob} world games arcade fun play online now today",
        "title": f"Site {blob}",
        "meta": f"desc {blob} here",
    }
    rec = build_record(raw, "https://x.example", "games")
    assert "data:" not in rec["text"]
    assert "data:" not in rec["title"]
    assert "data:" not in rec["meta"]
    assert "hello" in rec["text"] and "world" in rec["text"]


def test_doc_assembles_title_meta_text():
    rec = {"title": "T", "meta": "M", "text": "B"}
    assert doc(rec) == "T M B"
    assert doc({}) == "  "  # missing fields -> empty pieces, never raises
