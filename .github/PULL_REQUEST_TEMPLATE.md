<!-- Conventional Commit title, e.g. feat(extension): … / fix(classifier): … -->

## What & why

<!-- What this changes and the reason. Link any issue. -->

## Checklist

- [ ] `node test/selftest.mjs`, `node test/popup.mjs`, `node test/detect.mjs` pass
- [ ] `npm run lint` and `npm run format:check` pass
- [ ] `python -m pytest classifier/tests` and `node classifier/tests/test_parity.mjs` pass (if Python touched)
- [ ] **No name/framework/domain-string matching added for evasion detection** (behaviour-based only)
- [ ] Frozen-contract files (`fnv.py`, `extract.py`, `vectorize.py`, `hash.js`, `infer.mjs`) untouched — or a full pipeline rebuild is described below
- [ ] Pin / no-pin semantics preserved (shared hosts block-the-page, never pin)
- [ ] Docs updated if behaviour/config changed

## Artifact-contract impact

<!-- If you touched the hashing/vectorizer or compiler output format, state the
rebuild/republish plan. Otherwise: "none". -->
