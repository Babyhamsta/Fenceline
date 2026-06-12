from classifier.fnv import fnv1a32


def test_known_vectors():
    # FNV-1a 32-bit reference values.
    assert fnv1a32("") == 0x811C9DC5
    assert fnv1a32("a") == 0xE40C292C
    assert fnv1a32("foobar") == 0xBF9CF968


def test_is_uint32():
    h = fnv1a32("anything")
    assert 0 <= h <= 0xFFFFFFFF
