from classifier.decision import (
    is_search_engine_serp,
    is_search_engine_url,
    prose_rescue,
)


# --- prose-rescue: mirrors test/detect.mjs detect/prose-rescue ---------------
def test_prose_rescue_wikipedia_article_rescued():
    assert prose_rescue(
        "proxy-bypass",
        {"link_density": 0.2, "paragraph_count": 60, "has_url_like_input": False},
    )


def test_prose_rescue_croxy_has_url_input_not_rescued():
    # load-bearing: croxyproxy passes both prose tests but has a url-like input
    assert not prose_rescue(
        "proxy-bypass",
        {"link_density": 0.19, "paragraph_count": 6, "has_url_like_input": True},
    )


def test_prose_rescue_full_canvas_proxy_not_rescued():
    assert not prose_rescue(
        "proxy-bypass",
        {"link_density": 0.0, "paragraph_count": 2, "has_dominant_canvas": True},
    )


def test_prose_rescue_dense_list_not_rescued():
    assert not prose_rescue("proxy-bypass", {"link_density": 0.75, "paragraph_count": 2})


def test_prose_rescue_adult_player_gate():
    base = {"link_density": 0.1, "paragraph_count": 10}
    assert prose_rescue("adult", {**base, "has_video_player": False})
    assert not prose_rescue("adult", {**base, "has_video_player": True})


def test_prose_rescue_gambling_iframe_gate():
    base = {"link_density": 0.2, "paragraph_count": 8}
    assert prose_rescue("gambling", {**base, "has_large_xorigin_iframe": False})
    assert not prose_rescue("gambling", {**base, "has_large_xorigin_iframe": True})


def test_prose_rescue_games_never_rescued():
    assert not prose_rescue("games", {"link_density": 0.1, "paragraph_count": 20})


def test_prose_rescue_missing_structural_fail_safe():
    assert not prose_rescue("proxy-bypass", None)
    assert not prose_rescue("proxy-bypass", {})
    # density present but paragraphs missing -> fails the paragraph test
    assert not prose_rescue("proxy-bypass", {"link_density": 0.1})


# --- search-engine exemption: mirrors test/detect.mjs detect/search-engine ---
def test_search_engine_serp_exact_host_and_path():
    assert is_search_engine_serp("www.google.com", "/search")
    assert is_search_engine_serp("google.com", "/")
    assert is_search_engine_serp("duckduckgo.com", "/html")
    assert is_search_engine_serp("search.brave.com", "/search")


def test_search_engine_translate_and_cache_not_exempt():
    # translate.google.com is a proxy vector — exact-host match excludes it
    assert not is_search_engine_serp("translate.google.com", "/")
    assert not is_search_engine_serp("webcache.googleusercontent.com", "/")


def test_search_engine_path_scoped():
    assert not is_search_engine_serp("www.google.com", "/maps")
    assert not is_search_engine_serp("evil.example", "/search")


def test_is_search_engine_url_splits_host_and_path():
    assert is_search_engine_url("https://www.google.com/search?q=unblocked+games")
    assert not is_search_engine_url("https://translate.google.com/?u=https://x")
    assert not is_search_engine_url("https://poki.com/")
