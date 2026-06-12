# Contributing to Fenceline

Thanks for helping. Fenceline filters content on managed devices, so correctness
and a low false-positive rate matter more than features. Please read this before
opening a PR.

## Before you open a PR

Run the full suite from the repo root and make sure it's green:

```sh
# JS engine + detectors
node test/selftest.mjs        # compiler + tail engine, end-to-end on fixtures
node test/popup.mjs           # popup stats aggregation
node test/detect.mjs          # behaviour-based evasion detectors + pin store

# JS lint/format
npm ci
npm run lint
npm run format:check

# Python classifier
source .venv/Scripts/activate     # Windows (Git Bash); macOS/Linux: .venv/bin/activate
pip install -r classifier/requirements.txt
python -m pytest classifier/tests
node classifier/tests/test_parity.mjs   # Python <-> JS scorer parity
ruff check classifier
ruff format --check classifier
```

CI runs all of this on every PR; a red check blocks merge.

## Hard review criteria

These are not negotiable — PRs that violate them get sent back:

### 1. Detection stays behaviour-based, never name-based

All evasion detection keys off **behaviour**, not framework/domain/product names:
URL-in-path, the x-bare wire protocol, foreignObject+executable SVGs, glyph-
alphabet statistics. A list of proxy names both misses new proxies and
false-trips legit sites (an "epoxy" company, a UV-coating service). **PRs that add
proxy-name / framework-name / domain-string matching for detection are rejected.**
See [docs/design/](docs/design/) and the comments in `extension/lib/detect/`.

### 2. Frozen contracts: the hashing + vectorizer

`classifier/fnv.py`, `classifier/extract.py`, `classifier/vectorize.py` and their
JS mirrors (`extension/lib/hash.js`, `classifier/infer.mjs`) define the **frozen
hashing/feature contract**. Every published artifact and the trained model are
encoded against it. **Changing the FNV hash or the extract/vectorize logic
invalidates every published list artifact and the model** — it is a fleet-wide
breaking change, not a refactor. Don't touch them unless you are deliberately
re-cutting the whole pipeline, and say so loudly in the PR.

### 3. Pin vs. no-pin distinction

Shared/multitenant hosts (archive.org, translate, public CDNs) are
**block-the-page, never-pin-the-origin**. Keep the pin / no-pin distinction and
the `pin=false` stateless-signal paths intact. Fail open on ambiguity — a false
positive is worse than a miss for everything except the list tiers.

## Adding a blocklist source

Edit `compiler/sources.json` (category + source URL + format). **Review the
source's license first** — its terms flow through to redistribution; note the
license in the PR. Prefer domain/hosts formats the compiler already parses.

## Commit messages

Conventional Commits, imperative mood, subject ≤ 72 chars. Match the existing
log:

```
feat(extension): block apps smuggled as top-level SVG documents
fix(extension): enforce pin cap by evicting from the Map
docs: fix build cadence in DEPLOYMENT.md
```

Scopes in use: `extension`, `classifier`, `compiler`, `ci`, `docs`, `build`.

## Reporting a bypass

A working evasion is a security issue — report it privately, not in a PR or public
issue. See [SECURITY.md](SECURITY.md).
