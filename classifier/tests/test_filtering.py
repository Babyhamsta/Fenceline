from classifier.filtering import is_usable


def _rec(text, title="t"):
    return {"text": text, "title": title, "meta": "", "label": "games",
            "etld1": "x.com", "url": "https://x.com", "structural": {}}


def test_rejects_thin_text():
    assert not is_usable(_rec("too short"))


def test_rejects_parked_fingerprint():
    assert not is_usable(_rec("this domain is for sale buy this domain now "
                              "parked free " * 5))


def test_accepts_real_page():
    assert is_usable(_rec("play hundreds of free online games puzzles racing "
                          "shooting arcade multiplayer fun for everyone " * 4))
