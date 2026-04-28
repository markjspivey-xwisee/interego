# LRS Adapter — xAPI ↔ Interego boundary translator

> **Vertical application of Interego — NOT part of the protocol, NOT a reference implementation of the protocol.** A *boundary* translator: shaped to live at the edge between xAPI / LRS infrastructure and Interego pods. The Interego protocol does not depend on xAPI; this adapter is for organizations that need to interop with traditional LRS systems (Watershed, Veracity, SCORM Cloud, Yet Analytics, etc.).
>
> Status: Working Draft. Layer: application-over-L3. No L1/L2/L3 ontologies are extended.

## What this is

An adapter — not a vertical with its own framework. It does one thing: translate between **xAPI Statements** (the rigid actor / verb / object / result / context / timestamp shape used by every LRS) and **Interego Context Descriptors** (RDF 1.2 with seven facets and modal status).

Two directions:

- **Statement → Descriptor** — ingest xAPI Statements from an LRS (or a TLA-compliant Learning Activity Provider Index) into the user's pod as `cg:ContextDescriptor` instances with `cg:ProvenanceFacet` capturing the LRS source.
- **Descriptor → Statement** — project Interego descriptors out to a target LRS as xAPI Statements, for organizations whose compliance / reporting / dashboards are LRS-anchored.

## Why this is an adapter, not a vertical

xAPI's Statement format is **immutable point-in-time records** with a fixed shape. It does not express:

- `cg:modalStatus` (Hypothetical / Asserted / Counterfactual) — every Statement is implicitly a hard claim
- `cg:supersedes` chains — there's a `voided` extension but no native revision lineage
- Multiple coherent narratives over the same event — Statements are atomic
- Compositional semantics (`cg:union` / `cg:intersection`) — Statements don't compose

Forcing all Interego descriptors through xAPI shape would lose what makes Interego useful for complexity-informed practice (see [`../agent-development-practice/`](../agent-development-practice/)). Forcing all xAPI Statements into Interego shape would over-claim modal status on records that were never qualified that way.

The correct relationship is **lossy translation at the boundary**. Statements ingested as descriptors carry `cg:modalStatus cg:Asserted` because that's how the LRS recorded them, with a `provenance:wasGeneratedBy` link to the LRS-issued statement ID. Descriptors projected as Statements drop the modal facet and leave a note in `result.extensions` that the source descriptor carries richer semantics.

## Two-way translation summary

### xAPI Statement → cg:ContextDescriptor

| xAPI field | Interego mapping |
|---|---|
| `id` | `<urn:cg:lrs-statement:{statement-id}>` (stable IRI) |
| `actor` (Agent / Group) | `cg:AgentFacet { assertingAgent }` resolved via WebFinger / DID where possible |
| `verb` | `cg:SemioticFacet { content: verb.display }` + a `tcr:xapiVerb` literal preserving the IRI |
| `object` (Activity / Agent / SubStatement) | descriptor's `cg:ProvenanceFacet { wasGeneratedBy: object.id }` |
| `result` (success / completion / score / response) | `cg:SemioticFacet { content }` carrying the qualitative narrative; numerics in `tcr:xapiResult` extension |
| `context` (registration / parent / instructor) | distributed across `cg:AgentFacet` and `cg:ProvenanceFacet` per W3C PROV norms |
| `timestamp` | `cg:TemporalFacet { validFrom }` |
| `stored` | descriptor's `cg:provenance.recordedAt` |
| `authority` | `cg:TrustFacet { issuer: authority.account.homePage }` |
| `version` | preserved as `tcr:xapiVersion` on the descriptor |
| `attachments` | `cg:Distribution` blocks on the descriptor |

Modal status defaults to `cg:Asserted` (Statements are committed claims by definition).

### cg:ContextDescriptor → xAPI Statement

Only descriptors with `cg:modalStatus cg:Asserted` are projected; Hypothetical / Counterfactual descriptors are skipped (or surfaced through `tcr:xapiSkipReason` if you need an audit trail of what was withheld). Multi-narrative descriptors (those carrying multiple `adp:coherentNarrative` entries from agent-development-practice) emit a single Statement using the first narrative and add the remaining narratives to `result.extensions["urn:cg:coherent-narratives"]` as a JSON array, with a flag indicating the projection is lossy.

`cg:supersedes` chains map to xAPI `voided` Statements where appropriate, but the lineage is preserved as `result.extensions["urn:cg:supersedes-chain"]` for tools that understand it.

## Vertical-scoped vocabulary

Minimal — the adapter only adds translation-tracking terms in [`ontology/lrs.ttl`](ontology/lrs.ttl):

| Term | Purpose |
|---|---|
| `lrs:LRSEndpoint` | A target LRS. Records URL, version, auth method. |
| `lrs:StatementProjection` | Records that a descriptor was projected to a particular LRS as a Statement. |
| `lrs:StatementIngestion` | Records that a descriptor was ingested from a particular LRS Statement. |
| `lrs:projectionLossy` | Boolean — whether information was lost in translation. Defaults true. |
| `lrs:lossNote` | Free-text describing what was dropped. |

## Runnable proof-of-concept

[`examples/translate.mjs`](examples/translate.mjs) demonstrates round-trip translation:

1. A real xAPI Statement (TLA-flavored, with completion + score) is ingested into a `cg:ContextDescriptor`.
2. A multi-modal Interego descriptor (with `cg:modalStatus Hypothetical` and `cg:supersedes` chain) is projected out to a Statement, demonstrating what's preserved and what's lost.
3. The lossy-translation note is surfaced explicitly in the projected Statement's `result.extensions`.

```bash
node applications/lrs-adapter/examples/translate.mjs
```

## Tested against

Integration tests in [`tests/integration.test.ts`](tests/integration.test.ts) verify the boundary translator's invariants against REAL code paths (run via `npx vitest run applications/lrs-adapter`):

| What's verified (real code paths) | What's still simulated (deferred) |
|---|---|
| Ingest direction: synthetic xAPI Statement → conforming `cg:ContextDescriptor` with `cg:Asserted` modal + LRS Trust attribution | No actual GET against a real LRS endpoint (Tier 3 — Lrsql or Trax in Docker) |
| Project Asserted: lossy=false, full Statement emitted | No actual POST to a real LRS endpoint |
| Project Hypothetical: SKIPPED with explicit skip-reason audit row | No xAPI 2.0 conformance suite run end-to-end |
| Project Counterfactual: ALWAYS skipped regardless of caller opt-in | No round-trip integrity check across a real LRS roundtrip |
| Project multi-narrative: lossy=true with explicit `lossNote` rows for each dropped concern | |
| Project Hypothetical with `allowHypothetical` opt-in: lossy=true with audit | |

The translation logic itself is verified; the network layer is a separate test concern.

## What this is NOT

- **Not the protocol.** No L1/L2/L3 ontologies are extended.
- **Not a learning record store.** It translates *between* an LRS and Interego; it does not replace either. Run a real LRS (Watershed / Veracity / SCORM Cloud / Yet Analytics) if you need the LRS feature set.
- **Not a complete xAPI implementation.** Conformant Statement ingest only; xAPI 2.0 features like signed Statements, attachment handling, and Statement Forwarding are deferred.
- **Not an opinion about whether to use xAPI.** Some organizations need it for compliance / dashboards / vendor interop; some don't. This adapter exists for organizations in the first group.

## See also

- [`../learner-performer-companion/`](../learner-performer-companion/) — the human-protagonist vertical that consumes this adapter to bring the user's xAPI history into their pod
- [`../agent-development-practice/`](../agent-development-practice/) — the agent-as-subject vertical that explains *why* xAPI is kept at the boundary, not in the core
- ADL Total Learning Architecture — https://adlnet.gov/projects/tla/ (the reference architecture that frames xAPI's role in modern L&D)
- xAPI 2.0 spec — https://github.com/adlnet/xAPI-Spec
