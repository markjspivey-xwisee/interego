# LRS Adapter — xAPI ↔ Interego boundary translator

> **Vertical application of Interego — NOT part of the protocol, NOT a reference implementation of the protocol.** A *boundary* translator: shaped to live at the edge between xAPI / LRS infrastructure and Interego pods. The Interego protocol does not depend on xAPI; this adapter is for organizations that need to interop with traditional LRS systems (Watershed, Veracity, SCORM Cloud, Yet Analytics, etc.).
>
> Status: Working Draft. Layer: application-over-L3. No L1/L2/L3 ontologies are extended.

## What this is

An adapter — not a vertical with its own framework. It does one thing: translate between **xAPI Statements** (the rigid actor / verb / object / result / context / timestamp shape used by every LRS) and **Interego Context Descriptors** (RDF 1.2 with seven facets and modal status).

Two directions, **each serving a different audience** of the dual-audience learning vertical (see [`../../docs/DUAL-AUDIENCE.md`](../../docs/DUAL-AUDIENCE.md)):

- **Statement → Descriptor** (the **learner / performer** read path) — a learner's agent connects to any institutional LRS the learner has read access to, pulls the learner's own xAPI Statements (or a TLA-compliant Learning Activity Provider Index entry), and writes them into the learner's pod as `iep:ContextDescriptor` instances with `iep:ProvenanceFacet` capturing the LRS source. The learner's wallet ([`../learner-performer-companion/`](../learner-performer-companion/)) now has a permanent, portable, queryable copy. The institution still has its LRS; the learner gains independent reach to their own history.
- **Descriptor → Statement** (the **enterprise edtech professional** projection path) — institution-side: with the learner's per-graph consent, project Interego descriptors out to a target LRS as xAPI Statements, for organizations whose compliance / reporting / dashboards are LRS-anchored. The institution does not get to mint Statements about a learner without the learner's consent descriptor on the source graph; this is enforced at the projection boundary.

Both directions are **lossy at the boundary** — the next section explains why.

## Why this is an adapter, not a vertical

xAPI's Statement format is **immutable point-in-time records** with a fixed shape. It does not express:

- `iep:modalStatus` (Hypothetical / Asserted / Counterfactual) — every Statement is implicitly a hard claim
- `iep:supersedes` chains — there's a `voided` extension but no native revision lineage
- Multiple coherent narratives over the same event — Statements are atomic
- Compositional semantics (`iep:union` / `iep:intersection`) — Statements don't compose

Forcing all Interego descriptors through xAPI shape would lose what makes Interego useful for complexity-informed practice (see [`../agent-development-practice/`](../agent-development-practice/)). Forcing all xAPI Statements into Interego shape would over-claim modal status on records that were never qualified that way.

The correct relationship is **lossy translation at the boundary**. Statements ingested as descriptors carry `iep:modalStatus iep:Asserted` because that's how the LRS recorded them, with a `provenance:wasGeneratedBy` link to the LRS-issued statement ID. Descriptors projected as Statements drop the modal facet and leave a note in `result.extensions` that the source descriptor carries richer semantics.

## Two-way translation summary

### xAPI Statement → iep:ContextDescriptor

| xAPI field | Interego mapping |
|---|---|
| `id` | `<urn:iep:lrs-statement:{statement-id}>` (stable IRI) |
| `actor` (Agent / Group) | `iep:AgentFacet { assertingAgent }` resolved via WebFinger / DID where possible |
| `verb` | `iep:SemioticFacet { content: verb.display }` + a `tcr:xapiVerb` literal preserving the IRI |
| `object` (Activity / Agent / SubStatement) | descriptor's `iep:ProvenanceFacet { wasGeneratedBy: object.id }` |
| `result` (success / completion / score / response) | `iep:SemioticFacet { content }` carrying the qualitative narrative; numerics in `tcr:xapiResult` extension |
| `context` (registration / parent / instructor) | distributed across `iep:AgentFacet` and `iep:ProvenanceFacet` per W3C PROV norms |
| `timestamp` | `iep:TemporalFacet { validFrom }` |
| `stored` | descriptor's `iep:provenance.recordedAt` |
| `authority` | `iep:TrustFacet { issuer: authority.account.homePage }` |
| `version` | preserved as `tcr:xapiVersion` on the descriptor |
| `attachments` | `iep:Distribution` blocks on the descriptor |

Modal status defaults to `iep:Asserted` (Statements are committed claims by definition).

### iep:ContextDescriptor → xAPI Statement

Only descriptors with `iep:modalStatus iep:Asserted` are projected; Hypothetical / Counterfactual descriptors are skipped (or surfaced through `tcr:xapiSkipReason` if you need an audit trail of what was withheld). Multi-narrative descriptors (those carrying multiple `adp:coherentNarrative` entries from agent-development-practice) emit a single Statement using the first narrative and add the remaining narratives to `result.extensions["https://markjspivey-xwisee.github.io/interego/ns/iep#coherentNarratives"]` as a JSON array, with a flag indicating the projection is lossy.

`iep:supersedes` chains map to xAPI `voided` Statements where appropriate, but the lineage is preserved as `result.extensions["urn:iep:supersedes-chain"]` for tools that understand it.

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

1. A real xAPI Statement (TLA-flavored, with completion + score) is ingested into a `iep:ContextDescriptor`.
2. A multi-modal Interego descriptor (with `iep:modalStatus Hypothetical` and `iep:supersedes` chain) is projected out to a Statement, demonstrating what's preserved and what's lost.
3. The lossy-translation note is surfaced explicitly in the projected Statement's `result.extensions`.

```bash
node applications/lrs-adapter/examples/translate.mjs
```

## Tested against

Integration tests in [`tests/integration.test.ts`](tests/integration.test.ts) verify the boundary translator's invariants against REAL code paths (run via `npx vitest run applications/lrs-adapter`):

| What every automated run verifies (real code paths) | What NO automated run verifies |
|---|---|
| Ingest direction: synthetic xAPI Statement → conforming `iep:ContextDescriptor` with `iep:Asserted` modal + LRS Trust attribution | Tier 3c (6 bodies) against SCORM Cloud. It is a third-party commercial LRS; no workflow can stand one up. The step exists in `lrs-adapter-conformance.yml` and goes live the moment `SCORM_CLOUD_KEY` / `_SECRET` / `_ENDPOINT` exist as repo secrets — and is fail-closed once they do, so a secret that stops working reds the job rather than emptying it. |
| Project Asserted: lossy=false, full Statement emitted | Tier 8 (8 bodies) — the LRS → real pod → audit chain. It needs an LRS *and* a pod write credential, and no workflow supplies the latter (`INTEREGO_POD_WRITE_SECRET`). Those bodies still take the skip path on every run. |
| Project Hypothetical: SKIPPED with explicit skip-reason audit row | Compatibility with any LRS other than the pinned `yetanalytics/lrsql:v0.9.5` (and SCORM Cloud when configured). |
| Project Counterfactual: ALWAYS skipped regardless of caller opt-in | |
| Project multi-narrative: lossy=true with explicit `lossNote` rows for each dropped concern | |
| Project Hypothetical with `allowHypothetical` opt-in: lossy=true with audit | |

**The wire-level bodies now execute in CI.** [`.github/workflows/lrs-adapter-conformance.yml`](../../.github/workflows/lrs-adapter-conformance.yml) stands a pinned `yetanalytics/lrsql:v0.9.5` service container up and runs Tier 3 + Tier 3b — 12 bodies — with `LRSQL_IT=1`. That variable is a *declaration*, not a detection: with it set, an unreachable LRS is a FAILURE and never a skip. That distinction is the point of the workflow more than the container is. Until it existed, no workflow under `.github/workflows/` provisioned an LRS at all, every one of the 18 Tier 3 / 3b / 3c bodies reported `skipped` on every run, and the two tests that "passed" asserted `typeof reachable === 'boolean'` — true of `false`. `skipped` counts as a finished module in `tools/vitest-run-integrity.mjs`, so no gate in this repo would ever have noticed.

Read the tier sections below with that split in mind: Tier 3 and Tier 3b are gated, Tier 3c and Tier 8 are not. Any result those two record — including the SCORM Cloud version-negotiation findings — is a manual observation from a hand-run, not something that would catch a regression today.

**Tier 2** — [`_shared/tests/tier2-azure-css.test.ts`](../_shared/tests/tier2-azure-css.test.ts) PUTs a real ingested LRS-Statement descriptor to the deployed css-gate pod (`INTEREGO_POD_BASE`, default `https://gate.interego.xwisee.com`) and confirms the descriptor IRI + `Asserted` modal + LRS authority all survive the HTTP roundtrip. The Azure host this used to name was destroyed in the Railway move. It requires `INTEREGO_POD_WRITE_SECRET` — the gate refuses anonymous writes — and without it the suite skips on a *declared* reason. With the credential set, a pod that is unreachable or absent now FAILS rather than skipping (see `_shared/tests/real-pod-gate.ts`), so this is evidence when it runs and says so plainly when it does not.

**Tier 3** — [`tests/tier3-real-lrs.test.ts`](tests/tier3-real-lrs.test.ts) runs against a real Yet Analytics Lrsql LRS in Docker (`docker run yetanalytics/lrsql`). Verifies:
- POST projected Asserted Statements → 200 OK + UUID returned
- GET roundtrip preserves actor / verb / object / score
- Multi-narrative lossy projection: `result.extensions["https://markjspivey-xwisee.github.io/interego/ns/iep#coherentNarratives"]` + `https://markjspivey-xwisee.github.io/interego/ns/iep#projectionLossy: true` + `https://markjspivey-xwisee.github.io/interego/ns/iep#modalStatus: Hypothetical` all survive LRS persistence and round-trip back intact
- LRS rejects malformed Statements (missing required `actor` field) with 400-class error — confirms the LRS is doing real xAPI 2.0 §4.1 validation
- Non-existent statement IDs return 404 per xAPI 2.0 §4.2.1

Skips automatically if Lrsql isn't running locally on `:8080`; declaring `SKIP_LRSQL_TESTS` forces the skip. In CI, `lrs-adapter-conformance.yml` provisions the container and sets `LRSQL_IT` (to the literal `1`), under which an unreachable LRS FAILS the job instead of skipping — a `SKIP_LRSQL_TESTS` exported into that job cannot make it green. Locally, run the `docker run` above (pin the same `v0.9.5` tag, or the recipe stops reproducing CI) and export `LRSQL_IT=1` to get the same fail-closed behaviour.

Both names are read through [`applications/_shared/tests/env-flag.ts`](../_shared/tests/env-flag.ts), so "declared" is a contract rather than a single spelling: `1`/`true`/`yes`/`on` declare, `0`/`false`/`no`/`off` and an empty value decline, and any other value throws naming those spellings instead of being read as "no". That file exists because the previous `=== '1'` comparison meant `SKIP_POD_TESTS=true` did not skip and did not complain — it dialled the live pod.

**Tier 3b** — [`tests/tier3b-xapi-conformance.test.ts`](tests/tier3b-xapi-conformance.test.ts) deepens xAPI 2.0 conformance against the real Lrsql:
- **cmi5 profile** — `launched` + `completed` Statements with cmi5 `contextActivities.category` (`https://w3id.org/xapi/cmi5/context/categories/cmi5` + `moveon`) + `sessionid` extension, accepted as a 2-Statement batch
- **Sub-Statement** — Statement whose object is itself a `SubStatement` is accepted; LRS preserves nested object on roundtrip
- **Voiding** (xAPI's mechanism for projected `iep:supersedes`) — POST original; POST `voided` Statement with `StatementRef` object; ordinary GET on the original returns 404 per xAPI 2.0 §4.2.1; `voidedStatementId=` parameter retrieves it; the void Statement itself is retrievable normally
- **Batch POST** — 5 Statements in single request return 5 IDs in order
- **Filtering** — GET `?verb=...&agent=...` returns only matching Statements
- **Alternate request method** (POST with `?method=GET`, xAPI 2.0 §6.2) — handled gracefully whether LRS supports (200) or refuses cleanly (4xx); 5xx server-error would be the failure mode
- **Version negotiation** — LRS reports both 2.0.0 and 1.0.3 in `/about`

**Tier 3c** — [`tests/tier3c-scorm-cloud.test.ts`](tests/tier3c-scorm-cloud.test.ts) closes the proprietary-LRS gap by testing against **SCORM Cloud** (Rustici Software's commercial LRS, used widely in enterprise L&D). Gated by env vars (`SCORM_CLOUD_KEY`, `SCORM_CLOUD_SECRET`, `SCORM_CLOUD_ENDPOINT`); skips automatically when unset. Verifies:
- `/about` reports xAPI 1.0.3 specifically — **NOT 2.0.0**. (Observed on a manual run against a SCORM Cloud sandbox tenant when this test was written; no automated run re-checks it, so treat it as a dated observation rather than a current fact about the vendor.)
- xAPI 2.0 client gets explicit 400 rejection (not silent acceptance), so an adapter that targets 2.0.0 against a 1.0.3-only LRS fails loudly
- POST + GET roundtrip preserves Statement ID + verb + result.score
- Lossy-projection extensions (`https://markjspivey-xwisee.github.io/interego/ns/iep#projectionLossy`, `https://markjspivey-xwisee.github.io/interego/ns/iep#coherentNarratives`, `https://markjspivey-xwisee.github.io/interego/ns/iep#modalStatus`) survive SCORM Cloud roundtrip
- Voiding semantics work the same (xAPI 1.0.3 §4.1.6.7): plain GET → 404; `voidedStatementId=` → retrievable. Cross-LRS-conformant with Lrsql.
- Cross-LRS confirmation: same Statement shape works against both Lrsql AND SCORM Cloud → adapter is genuinely interoperable across open-source + proprietary LRS implementations

**Implication for the lrs-adapter**: must do version negotiation against the LRS's `/about` endpoint, target 2.0.0 against modern LRSes (Lrsql) and fall back to 1.0.3 against legacy proprietary LRSes (SCORM Cloud). The xAPI 1.0.3-conformant subset of Statements is the safest projection target for cross-LRS deployment.

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
