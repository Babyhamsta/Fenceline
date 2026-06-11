# Fenceline content classifier

A tiny on-device classifier that inspects a page's rendered text after it loads
and blocks it if it confidently matches a filtered category the blocklists
missed. Defense in depth — the lists stay primary, this is the async backstop.

See `docs/superpowers/specs/2026-06-11-content-classifier-design.md` for the full
design.

## Open-source scope

We publish the **scraper, training/eval scripts, and the model weights**. We do
**not** publish the scraped dataset itself (it is third-party site content).
Reproduce it by running the scraper against the public blocklist domains:

    node ../compiler/compile.mjs --dump-domains   # writes dist/domains.tsv
    python -m playwright install chromium
    python scrape.py && python build_dataset.py && python train.py

## Reproduce (POC)

    source .venv/Scripts/activate
    pip install -r requirements.txt
    pytest                       # unit tests
    python scrape.py             # render the sampled domains
    python build_dataset.py      # filter, dedup, split
    python train.py              # fit the model
    python export_model.py       # emit dist/model.bin + model-meta.json
    python evaluate.py           # the go/no-go table
    node infer.mjs --selftest    # JS inference parity
