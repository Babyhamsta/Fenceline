"""Exercise version identity through both artifact exporters without private data."""

import json
import pickle
from pathlib import Path

import numpy as np
import pytest
from sklearn.ensemble import HistGradientBoostingClassifier
from threadpoolctl import threadpool_limits

from classifier import export_fusion, export_model
from classifier.vectorize import DIMS


@pytest.fixture(params=["text", "fusion"])
def exporter(request, tmp_path: Path, monkeypatch):
    root = tmp_path / "classifier"
    root.mkdir()
    src = root / "dist_v3"
    src.mkdir()
    cfg = {
        "paths": {"model": "model.npz", "dist": "dist"},
        "clean_label": "clean",
        "block_threshold": 0.8,
    }
    classes = np.array(["adult", "clean", "games"])
    coef = np.zeros((3, DIMS), dtype=np.float32)
    intercept = np.zeros(3, dtype=np.float32)
    module = export_model if request.param == "text" else export_fusion
    monkeypatch.setattr(module, "ROOT", root)
    if request.param == "fusion":
        monkeypatch.setattr(module, "SRC", src)
        monkeypatch.setattr(module, "DIST", root / "dist")
        monkeypatch.setattr(module, "load", lambda name: [{"text": "example page"}])
        x = np.zeros((9, len(module.ENG) + 3))
        with threadpool_limits(limits=1):
            clf = HistGradientBoostingClassifier(max_iter=1, early_stopping=False).fit(
                x, np.tile(classes, 3)
            )
        with (src / "fusion_gbdt.pkl").open("wb") as handle:
            pickle.dump(clf, handle)

    def run(change: str = "") -> dict:
        current_cfg = dict(cfg)
        current_coef = coef.copy()
        current_intercept = intercept.copy()
        if change == "intercept":
            current_intercept[0] = 2.0
        elif change == "threshold":
            current_cfg["block_threshold"] = 0.95
        elif change == "clean_label":
            current_cfg["clean_label"] = "games"
        elif change == "weights":
            current_coef[0, 0] = 1.0
        elif change == "fusion":
            with (src / "fusion_gbdt.pkl").open("rb") as handle:
                changed_clf = pickle.load(handle)
            changed_clf._baseline_prediction[0, 0] += 0.5
            with (src / "fusion_gbdt.pkl").open("wb") as handle:
                pickle.dump(changed_clf, handle)
        (root / "poc.json").write_text(json.dumps(current_cfg), encoding="utf-8")
        model_path = root / "model.npz" if request.param == "text" else src / "text_model.npz"
        np.savez(model_path, coef=current_coef, intercept=current_intercept, classes=classes)
        with threadpool_limits(limits=1):
            module.main()
        return json.loads((root / "dist" / "model-meta.json").read_text(encoding="utf-8"))

    return request.param, run


def test_identical_export_has_stable_version(exporter) -> None:
    _, run = exporter
    assert run()["version"] == run()["version"]


@pytest.mark.parametrize("change", ["intercept", "threshold", "clean_label", "weights"])
def test_inference_change_updates_exported_version(exporter, change: str) -> None:
    _, run = exporter
    assert run()["version"] != run(change)["version"]


@pytest.mark.parametrize("exporter", ["fusion"], indirect=True)
def test_fusion_payload_updates_exported_version(exporter) -> None:
    _, run = exporter
    assert run()["version"] != run("fusion")["version"]
