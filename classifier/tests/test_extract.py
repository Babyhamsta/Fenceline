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
    s = rec["structural"]
    # every structural key present and zero-defaulted, regardless of input
    assert s["script_hosts"] == []
    assert s["iframe_count"] == 0 and s["paragraph_count"] == 0
    assert s["link_density"] == 0.0 and s["script_host_entropy"] == 0.0
    assert s["has_age_gate"] is False and s["has_url_like_input"] is False


def test_structural_passthrough_and_coercion():
    # full extractor payload (strings/ints from JSON) coerces to typed scalars
    raw = {
        "text": "hello world games arcade fun play online now today friends here",
        "structural": {
            "link_density": "0.42",
            "paragraph_count": 7,
            "has_url_like_input": True,
            "url_embeds_url": False,
            "iframe_count": "3",
            "script_hosts": ["a.com", "b.com"],
            "script_host_entropy": 1.5,
        },
    }
    s = build_record(raw, "https://x.example", "proxy-bypass")["structural"]
    assert s["link_density"] == 0.42 and isinstance(s["link_density"], float)
    assert s["paragraph_count"] == 7
    assert s["iframe_count"] == 3 and isinstance(s["iframe_count"], int)
    assert s["has_url_like_input"] is True and s["url_embeds_url"] is False
    assert s["script_hosts"] == ["a.com", "b.com"]
    assert s["script_host_entropy"] == 1.5


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
