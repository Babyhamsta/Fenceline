# Exploratory templates — open findings (NOT asserted)

These probes render through the shipped model but are **not** in `_expected.json`,
because the shipped model's verdict on them is wrong, contested, or a fail-safe
gap. They are calibration surface and documented findings for a future training /
rule pass — never a regression gate. Re-observe with:

    python -m classifier.template_test --all

## Findings (observed 2026-06-22, model 75f0aa25501ab3f8)

### game_review_article.html — FALSE POSITIVE (games article blocked)
A critical essay *about* games (prose, no canvas) is blocked `games@~0.97` via the
**text-backstop**. `prose_rescue` deliberately excludes `games` (only proxy/adult/
gambling are rescuable — see `classifier/decision.py:_RESCUABLE` and the
`detect.mjs` assertion "games category → never rescued"), so a games *article* has
no escape hatch. Correctly **not pinned** (no functional element) → the host is not
blanketed, but the visit is wrongly blocked. This is an intentional design tradeoff
(games-is-thin-text-plus-canvas, an article is neither), now demonstrated. Fixing
would mean making games prose-rescuable, which risks re-opening games FNs; out of
scope for the testing pass.

### proxy_canvas.html — PIN GAP (full-canvas proxy blocks but never pins)
A cherrion-style full-canvas proxy is blocked correctly (`proxy-bypass`, via text /
proxy vocab) but `has_functional_element("proxy-bypass", …)` has no `canvas` signal,
so the host is **never pinned**. Defensible as a fail-safe (a dominant canvas alone
is ambiguous — a game has one too), but memory holds that cherrion *is* a proxy and
arguably pin-worthy. Open: does proxy pin-worthiness need a thin-page + dominant
canvas clause? If added, regression-test it does not pin games.

### game_iframe.html — FALSE NEGATIVE (embedded game evades)
A real game embedded in a large cross-origin `<iframe>` (no own canvas, thin text)
is **not blocked**. Neither fusion nor the text-backstop fires. The structural tells
are there (`has_large_xorigin_iframe`), but no rule keys games off them. Open: should
a large cross-origin iframe + games text be a games signal?

### games_portal_linkhub.html — CONTESTED POLICY (portal cleaned)
A link-hub portal (24 game links, link_density ~0.69, no canvas) is **cleaned**. The
rework plan keeps the portal/internal-link signal a *feature*, not a hard block,
because it collides with Wikipedia category lists; policy (labeling memo) leans
block. Unresolved until a real portal/list corpus settles it — stays exploratory.

### vpn_listicle.html — FALSE NEGATIVE per policy (promo/affiliate cleaned)
A "best VPN/proxy 2026" affiliate listicle is **cleaned** by `decide()`. The promo /
affiliate detection (`fp_audit.is_promo`) is an offline training-router heuristic,
**not** part of the on-device deploy rule, so the device does not block it. Open:
should promo/affiliate detection move into `decide()`, or stay a labeling-only signal?
