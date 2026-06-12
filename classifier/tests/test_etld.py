from classifier.etld import etld1


def test_basic():
    assert etld1("https://www.poki.com/en/g") == "poki.com"
    assert etld1("http://sub.deep.example.co.uk/x") == "example.co.uk"
    assert etld1("crazygames.com") == "crazygames.com"


def test_invalid_returns_empty():
    assert etld1("not a url at all") == ""
