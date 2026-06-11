from classifier.metrics import per_class, fp_rate_on_clean


def test_per_class_precision_recall():
    y_true = ["games", "games", "clean", "gambling"]
    y_pred = ["games", "clean", "clean", "gambling"]
    pc = per_class(y_true, y_pred, ["games", "gambling", "clean"])
    assert pc["games"]["precision"] == 1.0          # 1 predicted games, correct
    assert pc["games"]["recall"] == 0.5             # 2 true games, 1 found
    assert pc["gambling"]["recall"] == 1.0


def test_fp_rate_on_clean():
    # 4 clean items; 1 wrongly flagged as a blocked category
    y_true = ["clean", "clean", "clean", "clean"]
    y_pred = ["clean", "games", "clean", "clean"]
    assert fp_rate_on_clean(y_true, y_pred, "clean") == 0.25
