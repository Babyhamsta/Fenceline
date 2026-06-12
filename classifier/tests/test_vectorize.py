import math

from classifier.vectorize import tokens, vectorize, DIMS


def test_tokens_word_and_char_ngrams():
    t = set(tokens("ab cd"))
    # word 1-grams
    assert "ab" in t and "cd" in t
    # word 2-gram
    assert "ab cd" in t
    # char 3-gram inside a word boundary-padded token (^ab$ style)
    assert any(tok.startswith("#") for tok in t)  # char n-grams are prefixed


def test_vector_is_l2_normalized():
    v = vectorize("hello world hello")
    norm = math.sqrt(sum(x * x for x in v.values()))
    assert abs(norm - 1.0) < 1e-9
    assert all(0 <= i < DIMS for i in v)


def test_empty_text_is_empty_vector():
    assert vectorize("") == {}
