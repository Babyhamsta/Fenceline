# Fenceline content classifier

A tiny on-device classifier that inspects a page's rendered text after it loads
and blocks it if it confidently matches a filtered category the blocklists
missed. Defense in depth — the lists stay primary, this is the async backstop.

See `docs/design/specs/2026-06-11-content-classifier-design.md` for the full
design.

## Open-source scope

We publish the **scraper, training/eval scripts, and the model weights**. We do
**not** publish the scraped dataset itself (it is third-party site content).
Reproduce it by running the scraper against the public blocklist domains.

## Reproduce (POC)

Run everything from the **repo root** in an activated venv (the Python scripts
are package modules — run them with `-m`, not as bare files):

    # Activate the venv first:
    #   Windows (Git Bash):  source .venv/Scripts/activate
    #   macOS / Linux:       source .venv/bin/activate

    node compiler/compile.mjs --dump-domains   # writes dist/domains.tsv
    python -m playwright install chromium
    python -m pytest classifier/tests          # unit tests
    python -m classifier.scrape                # render sampled domains
    python -m classifier.build_dataset         # filter, dedup, split
    python -m classifier.train                 # fit the model
    python -m classifier.export_model          # emit dist/model.bin + model-meta.json
    python -m classifier.evaluate              # the go/no-go table
    node classifier/infer.mjs --selftest       # JS inference parity
