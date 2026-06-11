"""Retrain on increasing slices and print macro-precision so we can see where it
plateaus — the 'how much data is enough' signal."""
import json
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent
REPO = ROOT.parent


def _run(module: str) -> None:
    subprocess.run([sys.executable, "-m", f"classifier.{module}"], cwd=REPO, check=True)


def main() -> None:
    cfg = json.loads((ROOT / "poc.json").read_text(encoding="utf-8"))
    train_path = ROOT / cfg["paths"]["train"]
    full = train_path.read_text("utf-8").splitlines()
    backup = full[:]
    try:
        for n in (1000, 3000, 10000):
            train_path.write_text("\n".join(full[:n]) + "\n", encoding="utf-8")
            _run("train")
            _run("export_model")
            print(f"\n=== n={n} ===")
            _run("evaluate")
    finally:
        train_path.write_text("\n".join(backup) + "\n", encoding="utf-8")


if __name__ == "__main__":
    main()
