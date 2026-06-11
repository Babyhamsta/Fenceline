from classifier.splitting import split_by_etld1


def test_no_etld1_leak_across_splits():
    recs = [{"etld1": f"site{i}.com", "label": "games"} for i in range(100)]
    # add subdomains that share an eTLD+1 with an existing record
    recs += [{"etld1": "site1.com", "label": "games"} for _ in range(5)]
    train, val, test = split_by_etld1(recs, (0.7, 0.15, 0.15), seed=1)
    sets = [{r["etld1"] for r in s} for s in (train, val, test)]
    assert sets[0].isdisjoint(sets[1])
    assert sets[0].isdisjoint(sets[2])
    assert sets[1].isdisjoint(sets[2])
    assert len(train) + len(val) + len(test) == len(recs)


def test_deterministic_with_seed():
    recs = [{"etld1": f"s{i}.com", "label": "x"} for i in range(50)]
    a = split_by_etld1(recs, (0.7, 0.15, 0.15), seed=7)
    b = split_by_etld1(recs, (0.7, 0.15, 0.15), seed=7)
    assert [r["etld1"] for r in a[0]] == [r["etld1"] for r in b[0]]
