# Semantic-alignment + trust-substrate demos

This directory contains the runnable demos for the shared-semantics ×
decentralized-trust stack built on top of Interego descriptors. Every
script here targets a live pod (set in the script's constants) and
reads/writes real descriptors — nothing is mocked.

## Layered trust architecture

```
L0  object claims  ──────────────────────────  alpha/beta/gamma + scenarios
L1  audits ─────────────────────────────────  semantic-alignment-auditor-v*.mjs
L2  meta-audits (recursive) ────────────────  auditor v4
L3  cross-auditor consensus ────────────────  auditor-alt + auditor-consensus
L4  reputation (ERC-8004 T0) ───────────────  reputation-aggregator
L5  cryptographic attestation (T1) ─────────  erc8004-t1-sign-and-verify
L6  continuous monitoring ──────────────────  monitoring-heartbeat
┴─  cross-pod boundary ─────────────────────  cross-pod-demo + cross-pod-audit
```

## Script index

### Setup / one-shot publishers (run once)

- **`publish-shape-and-claims.mjs`** — PUTs a SHACL shape at a
  resolvable pod URL plus three descriptors with distinct issuers.
  This is what bootstraps cross-issuer signal.
- **`publish-audit-schema.mjs`** — PUTs the `audit-result-v1` shape.
  Required before `semantic-alignment-auditor-v3.mjs` can emit
  conforming audit results.
- **`publish-erc8004-schema.mjs`** — PUTs the `erc8004-attestation-v1`
  shape (T0 ladder rung). Required before the aggregator's output
  validates.

### Auditors (run anytime; each layer audits the previous)

- **`semantic-alignment-auditor.mjs`** (v1) — four structural signals
  (independence, vocabulary, modal, derivation). Honest about what it
  can and cannot measure.
- **`semantic-alignment-auditor-v2.mjs`** — v1 + mini-SHACL fetch
  and enforce + per-issuer track record.
- **`semantic-alignment-auditor-v3.mjs`** — v2 + publishes audit
  results back to the pod as descriptors. Self-validates.
- **`semantic-alignment-auditor-v4.mjs`** — v3 + recursive meta-audit
  (audits other audits) with phantom-evidence + conflict-of-interest
  + independent recomputation checks. Trust-fixpoint emerges.

### Consensus + reputation

- **`auditor-alt.mjs`** — independent auditor with stricter weighting
  (COI = fail, not flag). Publishes conforming audit-result-v1
  descriptors. Used alongside v4 to produce genuine cross-auditor
  divergence.
- **`auditor-consensus.mjs`** — pairs audits that share ≥1 citation
  target, computes per-pair agreement gap, publishes a consensus
  descriptor. Surfaces inter-auditor disagreement as first-class data.
- **`reputation-aggregator.mjs`** — walks the whole manifest, groups
  by Trust.issuer, computes avgConf + violationRate + selfReversals +
  participation, publishes one ERC-8004 T0 attestation per issuer.
  Parallelized fetch pool (16) + batched manifest PUT — runs in ~30s
  against a 100-entry manifest.

### Adversarial + verification

- **`adversarial-audits.mjs`** — publishes three malformed audits
  (phantom-evidence, self-COI, shape-violator). Run `auditor-v4`
  afterward to verify it flags all three.
- **`erc8004-t1-sign-and-verify.mjs`** — signs a T0 attestation with
  ECDSA (secp256k1, ERC-8004-compatible). Tamper-checks the
  signature; verifies signer recovery.

### Cross-pod federation

- **`cross-pod-demo.mjs`** — publishes on POD-B citing POD-A
  evidence. Proves cross-pod URLs resolve.
- **`cross-pod-audit.mjs`** — runs the actual audit pipeline across
  the boundary. Proves trust machinery is pod-agnostic (not just
  URLs).

### Composition + emergence

- **`emergent-semiotics-compose.mjs`** — three descriptors of the
  same `urn:graph` with different modal statuses and conformsTo
  lenses; computes the lattice union; shows modal polyphony as a
  structural property.

### Monitoring

- **`monitoring-heartbeat.mjs`** — runs the full pipeline
  (aggregator → alt-auditor → consensus) and publishes a heartbeat
  descriptor. Intended for cron / scheduled remote trigger.
  Full pipeline ~67s after the 2026-04-21 parallelization fix.

## Scheduling patterns

Three ways to run `monitoring-heartbeat.mjs` on a schedule:

```bash
# 1. One-off manual
node examples/monitoring-heartbeat.mjs

# 2. Session-scoped (Claude Code REPL, dies with session)
# In an interactive Claude session, ask it to CronCreate the tick:
#   "*/30 * * * *" → every 30 min while REPL idle
# 3. Durable (production)
# Use the `schedule` skill to create a remote agent trigger,
# OR deploy as a GitHub Actions cron,
# OR deploy as an Azure Container Apps scheduled job targeting
# the script entry point.
```

## Honest limits

- **SHACL enforcement** is mini-SHACL (sh:in, sh:hasValue,
  sh:minInclusive, sh:maxInclusive, sh:minCount). A real deployment
  would use rdf-validate-shacl or similar.
- **PGSL structural overlap** is syntagmatic + pragmatic, not
  semantic. Embeddings would need to layer on for semantic detection.
- **Cross-pod** currently uses 2 pods on the same CSS. Genuine
  federation needs pods on independent CSS instances + independent
  DNS zones.
- **Single-runtime author** (one Claude session) produced the test
  data at demo time; genuine concurrent multi-agent runs are
  possible via `Agent` tool (subagent) + main agent in parallel
  (demonstrated 2026-04-21).
- **Reputation aggregator's violationRate** measures shape-conformance
  only. Phantom-evidence catching is v4's job; a v2 aggregator
  should combine both.

## Session-built artifacts (2026-04-21)

18 substantive commits: `242f054` → `e5553d9`. See the git log for
the specific progression from bug-fix re-verification to full
trust-fixpoint + ERC-8004 T1 + cross-pod end-to-end.
