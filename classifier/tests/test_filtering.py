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


def test_rejects_cloudflare_interstitial():
    # real Cloudflare challenge body — must not become training content
    assert not is_usable(_rec(
        "Performing security verification This website uses a security service "
        "to protect against malicious bots This page is displayed while the "
        "website verifies you are not a bot Ray ID: 8a1f waiting " * 2))


def test_rejects_just_a_moment_via_title():
    # challenge name lives in the title; thin body alone wouldn't catch it
    assert not is_usable(_rec(
        "Verifying you are not a bot before you continue please wait while we "
        "check your connection this is automatic and should only take a moment",
        title="Just a moment..."))


def test_rejects_removed_blogspot_template():
    # the dead-blogspot page that dominates the adult blocklist tail
    assert not is_usable(_rec(
        "Sign in Blog has been removed Sorry, the blog at example.blogspot.com "
        "has been removed This address is not available for new blogs and is no "
        "longer accessible to readers anywhere in the world"))


def test_rejects_error_and_server_default_pages():
    assert not is_usable(_rec(
        "404 Not Found The page you were looking for does not exist maybe we "
        "got lost trying to find it please check the address and try again now"))
    assert not is_usable(_rec(
        "Welcome to nginx If you see this page the nginx web server is "
        "successfully installed and working further configuration is required"))
