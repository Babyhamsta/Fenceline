# Security Policy

Fenceline is a content filter deployed to managed devices, often minors'. We take
reports seriously and especially welcome **filter-bypass reports** — for this
project, a working evasion *is* a vulnerability.

## Supported versions

Only the latest released version is supported. Fixes ship there; please reproduce
on the current version before reporting.

## Reporting a vulnerability

**Report privately. Do not open a public issue for a working bypass or any
weaponizable finding.**

Use GitHub's **private vulnerability reporting**:
**[Report a vulnerability](https://github.com/Babyhamsta/Fenceline/security/advisories/new)**
(or the repo's **Security** tab → **Report a vulnerability**). Include:

- what you did (steps to reproduce), the URL/technique, and the version,
- what you expected vs. what happened (e.g. a blocked category loaded),
- managed-policy config if relevant.

We aim to acknowledge within a few days and to keep you updated as we work a fix.
Coordinated disclosure is appreciated; we'll credit you if you'd like.

## In scope

- **Bypass techniques** — any way to reach a filtered category without a block
  (new proxy transports, obfuscation that defeats the content model or the
  behaviour detectors, navigation tricks that dodge the tiers).
- **Log tampering / evasion of logging** — making a blocked attempt go unlogged.
- **Policy escape** — defeating the managed-policy controls a district relies on
  (e.g. neutralizing the extension from the page, disabling enforcement).

## Out of scope

- The **documented limits** in the README's "Known limits and caveats" section
  (e.g. another extension wrapping the unload guard, off-Chrome browsers, network
  layers Fenceline explicitly doesn't cover). These are known trade-offs, not
  vulnerabilities — though a concrete, practical exploitation of one is still
  worth reporting.
- Findings that require admin/OU-level access the threat model already assumes
  is trusted.

## A note on the detection philosophy

All evasion detection is **behaviour-based** (URL-in-path, x-bare wire protocol,
foreignObject+script SVGs, glyph-alphabet statistics). If you find a behavioural
invariant we're missing, that's exactly the kind of report we want.
