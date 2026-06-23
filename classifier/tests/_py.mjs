// Shared helper for the JS<->Python parity tests: resolve the Python interpreter
// cross-platform so they run locally (Windows or POSIX venv) and in CI (no venv —
// deps installed into the runner's python). FENCELINE_PYTHON overrides everything.
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

export function resolvePython() {
  if (process.env.FENCELINE_PYTHON) return process.env.FENCELINE_PYTHON;
  const winVenv = join(REPO_ROOT, ".venv", "Scripts", "python.exe");
  const nixVenv = join(REPO_ROOT, ".venv", "bin", "python");
  if (existsSync(winVenv)) return winVenv;
  if (existsSync(nixVenv)) return nixVenv;
  return process.platform === "win32" ? "python" : "python3";
}

export const PY = resolvePython();
