import json
import random

from classifier.frontier import (
    attempted_path,
    build_pools,
    domain_of_url,
    kept_by_label,
    kept_domains,
    load_attempted,
    load_ranks,
    load_seed,
    remaining,
    sample_interior_links,
)


def test_build_pools_buckets_and_is_deterministic(tmp_path):
    tsv = tmp_path / "d.tsv"
    tsv.write_text("a.com\tgames\nb.com\tgames\nc.com\tclean\nd.com\tgames\n", encoding="utf-8")
    p1 = build_pools(tsv, ["games", "clean"], seed=0)
    p2 = build_pools(tsv, ["games", "clean"], seed=0)
    assert sorted(p1["games"]) == ["a.com", "b.com", "d.com"]
    assert p1["clean"] == ["c.com"]
    assert p1 == p2  # same seed -> identical order across processes


def test_domain_of_url_mirrors_scraper_scheme():
    assert domain_of_url("https://poki.com/") == "poki.com"
    assert domain_of_url("http://x.io") == "x.io"


def test_remaining_excludes_attempted_and_kept_preserving_order():
    pool = ["a.com", "b.com", "c.com", "d.com"]
    assert remaining(pool, {"b.com"}, {"d.com"}) == ["a.com", "c.com"]


def test_kept_by_label_counts_only_usable_but_skipset_is_all(tmp_path):
    raw = tmp_path / "raw.jsonl"
    good = {"label": "games", "url": "https://g.com/", "text": " ".join(["games"] * 30)}
    thin = {"label": "games", "url": "https://t.com/", "text": "too short"}
    raw.write_text(json.dumps(good) + "\n" + json.dumps(thin) + "\n", encoding="utf-8")
    # only the usable record counts toward the target...
    assert kept_by_label(raw) == {"games": 1}
    # ...but both are in the skip-set so neither domain is re-rendered
    assert kept_domains(raw) == {"g.com", "t.com"}


def test_load_attempted_reads_log(tmp_path):
    attempted_path(tmp_path, "games").write_text("a.com\nb.com\n", encoding="utf-8")
    assert load_attempted(tmp_path, "games") == {"a.com", "b.com"}
    assert load_attempted(tmp_path, "missing") == set()


def test_build_pools_denylist_drops_matching_substrings(tmp_path):
    tsv = tmp_path / "d.tsv"
    tsv.write_text("x.blogspot.com\tadult\nporn.com\tadult\ntaboola.com\tadult\n", encoding="utf-8")
    pools = build_pools(tsv, ["adult"], seed=0, denylist=("blogspot", "taboola"))
    assert pools["adult"] == ["porn.com"]  # blogspot + ad-tech removed


def test_build_pools_popular_first_orders_by_rank(tmp_path):
    tsv = tmp_path / "d.tsv"
    # three ranked + one unranked
    tsv.write_text(
        "low.com\tadult\ntop.com\tadult\nmid.com\tadult\nobscure.com\tadult\n", encoding="utf-8"
    )
    ranks = {"top.com": 5, "mid.com": 50, "low.com": 500}
    pools = build_pools(tsv, ["adult"], seed=0, popular_first=("adult",), ranks=ranks)
    # ranked first, ascending by rank; unranked tail last
    assert pools["adult"][:3] == ["top.com", "mid.com", "low.com"]
    assert pools["adult"][3] == "obscure.com"


def test_build_pools_popular_first_only_affects_listed_labels(tmp_path):
    tsv = tmp_path / "d.tsv"
    tsv.write_text("a.com\tgames\nb.com\tgames\n", encoding="utf-8")
    ranks = {"b.com": 1, "a.com": 2}
    # games not in popular_first -> shuffled, not rank-ordered
    pools = build_pools(tsv, ["games"], seed=0, popular_first=("adult",), ranks=ranks)
    assert sorted(pools["games"]) == ["a.com", "b.com"]


def test_load_ranks_parses_csv(tmp_path):
    csv = tmp_path / "tranco.csv"
    csv.write_text("1,google.com\n2,youtube.com\n", encoding="utf-8")
    assert load_ranks(csv) == {"google.com": 1, "youtube.com": 2}


def test_force_label_moves_domain_and_prepends(tmp_path):
    tsv = tmp_path / "d.tsv"
    # proxy.example is listed as adult upstream; force it to proxy-bypass
    tsv.write_text(
        "proxy.example\tadult\nporn.com\tadult\nkproxy.com\tproxy-bypass\n", encoding="utf-8"
    )
    pools = build_pools(
        tsv,
        ["adult", "proxy-bypass"],
        seed=0,
        force_label={"proxy-bypass": ["proxy.example", "kproxy.com"]},
    )
    assert "proxy.example" not in pools["adult"]  # removed from its upstream label
    assert pools["proxy-bypass"][:2] == ["proxy.example", "kproxy.com"]  # forced, prepended first
    assert pools["adult"] == ["porn.com"]


def test_load_seed_skips_comments_and_blanks(tmp_path):
    p = tmp_path / "seed.txt"
    p.write_text("# header\n\nfoo.com\n  bar.net  \n# mid\nbaz.io\n", encoding="utf-8")
    assert load_seed(p) == ["foo.com", "bar.net", "baz.io"]
    assert load_seed(tmp_path / "missing.txt") == []


def test_sample_interior_links_same_etld1_only():
    links = [
        "https://poki.com/",  # homepage root — excluded
        "https://poki.com/en/g/slope",  # interior, same eTLD+1
        "https://poki.com/en/g/subway-surfers",  # interior, same eTLD+1
        "https://blog.poki.com/post/news",  # subdomain, same eTLD+1
        "https://google.com/ads",  # off-site — excluded
        "http://not a url",  # unparseable host -> different eTLD+1, excluded
    ]
    out = sample_interior_links(links, "poki.com", 5, random.Random(0))
    assert set(out) == {
        "https://poki.com/en/g/slope",
        "https://poki.com/en/g/subway-surfers",
        "https://blog.poki.com/post/news",
    }


def test_sample_interior_links_caps_at_k_and_is_seed_deterministic():
    links = [f"https://site.com/g/{i}" for i in range(20)]
    a = sample_interior_links(links, "site.com", 4, random.Random(0))
    b = sample_interior_links(links, "site.com", 4, random.Random(0))
    assert len(a) == 4 and a == b  # capped + deterministic given the same rng seed
    assert sample_interior_links(links, "site.com", 0, random.Random(0)) == []
