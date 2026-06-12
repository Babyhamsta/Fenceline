from classifier.domains import sample_domains


def test_filters_to_requested_labels_and_caps(tmp_path):
    tsv = tmp_path / "domains.tsv"
    rows = [
        "a.com\tgames",
        "b.com\tgames",
        "c.com\tgambling",
        "d.com\tadult",
        "e.com\tclean",
        "f.com\tclean",
    ]
    tsv.write_text("\n".join(rows) + "\n", encoding="utf-8")
    out = sample_domains(tsv, ["games", "gambling"], "clean", per_class=1, seed=0)
    labels = sorted({lab for _d, lab in out})
    assert labels == ["clean", "gambling", "games"]  # adult excluded
    # capped at per_class each
    assert sum(1 for _d, lab in out if lab == "games") == 1
