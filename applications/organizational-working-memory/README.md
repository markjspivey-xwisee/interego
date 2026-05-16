# Organizational Working Memory — federated org memory (dual-audience)

> **Vertical application of Interego — NOT part of the protocol, NOT a reference implementation of the protocol.** One specific use case among many possible. Vocabulary (`owm:` namespace) is vertical-scoped and non-normative.
>
> Status: Working Draft. Layer: application-over-L3. No L1/L2/L3 ontologies are extended.

## What this is

A vertical for **two first-class audiences** — the **knowledge worker / individual contributor** who is doing the work, and the **org-level operator** (PM lead, ops, exec, board-facing compliance) who needs aggregate visibility into how the org is operating. Both get distinct, principled affordances over the same underlying descriptors on the org pod. This is the dual-audience design discipline ([`../../docs/DUAL-AUDIENCE.md`](../../docs/DUAL-AUDIENCE.md)) applied to organizational memory.

The org pod is the shared substrate. Individual contributors don't lose their slice; org-level operators don't get a god-view of every individual. Both views derive from the same descriptors via ABAC + per-graph `share_with` + aggregate-privacy queries.

## The two audiences and what each gets

| | Knowledge worker / individual contributor | Org-level operator |
|---|---|---|
| **Primary affordances** | `owm.upsert_person` / `upsert_project` / `record_decision` / `queue_followup` / `record_note` — authoring their own slice. `owm.navigate_source` for the uniform `ls / cat / grep / recent` source-adapter surface over web / drive / slack / github / etc. | Aggregate dashboards over decision lineage, project health, follow-up flow. Decision-revision frequency (where `cg:supersedes` chains show repeated rethinking). Cross-team visibility into commitments. |
| **What they see by default** | Their own descriptors + anything explicitly `share_with` them. Project they own → full read; project they're tagged in → scoped read; project they're not in → not visible. | Aggregate counts + thresholds + lineage walks over ALL descriptors on the org pod, subject to ABAC policy. Individual records visible only when the contributor has explicitly shared or when audit policy demands. |
| **Write surface** | Authored content lands as typed descriptors on the org pod with the contributor as `cg:assertingAgent` in the AgentFacet. `cg:supersedes` carries revision; `passport:LifeEvent` carries the contributor's identity continuity across org tenure. | Org-policy descriptors (decision-promotion thresholds, retention windows, framework-compliance attestations) signed by an org-authority key. The operator does not author content ON BEHALF of contributors. |
| **Modal honesty** | Tentative notes published as Hypothetical; committed decisions as Asserted; reversed decisions superseded with the new decision linked back. The substrate carries the change. | Aggregate analytics published as Hypothetical with the model + confidence inline. The operator can SUMMARIZE; the operator cannot silently UPGRADE individuals' Hypothetical notes into Asserted org facts. |
| **Compliance posture** | Personal audit: "what did I commit to and when?" — answerable from their own descriptors. | Board / regulator-facing audit: "what decisions were made, by whom, citing what evidence?" via `src/compliance/` + framework mappings (`soc2:`, `eu-ai-act:`, `nist-rmf:`). |

The principle: same underlying descriptors on the org pod, different affordance surfaces. ABAC + per-graph `share_with` is the boundary tech.

## Architecture — two surfaces, one source of truth

The bridge ([`bridge/`](bridge/)) exposes two MCP tool surfaces backed by [`affordances.ts`](affordances.ts):

### Entity surface

`owm.upsert_person`, `owm.upsert_project`, `owm.record_decision`, `owm.queue_followup`, `owm.record_note` — author typed descriptors. Schema is open-world: an organization can introduce its own facets without a migration step (RDF + SHACL handle this natively). Each writes to the org pod with the calling agent as `cg:assertingAgent`. `cg:supersedes` chains carry decision revision; PGSL atoms content-address captured notes so two observers minting the same insight collide on IRI.

### Navigation surface

`owm.navigate_source`, `owm.update_source` — the main agent sees ONE pair of tools regardless of how many external sources are wired (web, drive, slack, github, …). Each source runs as an isolated sub-process inside the bridge: it owns the source's quirks (auth, pagination, ACL inheritance, content-type handling) so the main agent's context is never polluted by source-specific tool noise.

Verbs are uniform across sources:

- `ls` — enumerate children at a path / scope
- `cat` — fetch the content at a path
- `grep` — keyword scan within a scope
- `recent` — items modified within a window

Whatever the source returns becomes addressable as a typed descriptor at write time (`record_note` / `record_decision` / etc.) — the substrate is the persistence layer, the source is the observation surface.

## Org-operator affordance surface (implemented)

The bridge ships BOTH the contributor entity + navigation surface AND the org-operator surface — concatenating `owmAffordances` + `owmOperatorAffordances` from [`affordances.ts`](affordances.ts) and dispatching operator handlers from [`src/operator-publisher.ts`](src/operator-publisher.ts). Set `OWM_DEFAULT_AUTHORITY_DID` (or pass `authority_did` per call) so the org-authority signing key is distinct from a contributor's DID. The four operator affordances:

- **`owm.aggregate_decisions_query`** — counts / thresholds / lineage-summary over decision descriptors. v1 privacy boundary = the substrate's existing ABAC + per-graph `share_with` (response includes `privacyMode: 'abac'`); v2 will add ZK aggregate-privacy. Returns "47 decisions in Q2; mean revision count 1.3; 8 decisions superseded ≥3 times" — not the decisions themselves.
- **`owm.project_health_summary`** — per-project rollup of follow-up flow, decision recency, contributor breadth. Aggregate-shaped; individual descriptors only via explicit `share_with`.
- **`owm.publish_org_policy`** — sign and publish org-level policy descriptors (retention windows, decision-promotion thresholds, framework-compliance attestations). Authored by org-authority keys; visible to all contributors.
- **`owm.publish_compliance_evidence`** — wrap org-level operational events (deploy, access change, key rotation, incident, quarterly review) as `compliance: true` descriptors citing the relevant control IRIs (`soc2:CC6.1`, etc.). Composes [`src/ops/`](../../src/ops/) and [`integrations/compliance-overlay/`](../../integrations/compliance-overlay/).

These four operator affordances ship in `owmOperatorAffordances` and are concatenated into the bridge's tool surface alongside `owmAffordances`. Tools list reports them as one set; the affordance manifest (`GET /affordances`) declares all of them.

## Demo

Demo 15 in [`demos/scenarios/`](../../demos/scenarios/) walks the closed loop: a Curator agent distills an external page into typed entities; a separate Surfacer agent — different process, no shared memory — recovers the state from the org pod alone. The substrate IS the org's working memory; the agents are interchangeable.

## What this is NOT

- **Not the protocol.** No L1/L2/L3 ontologies are extended.
- **Not a SaaS multi-tenancy story.** The org pod is sovereign; "tenant" doesn't appear in the L1 spec.
- **Not a panopticon.** The org-operator surface is bounded by ABAC + aggregate-privacy. An operator who wants individual-level visibility needs the contributor's explicit `share_with` — there is no admin-bypass.
- **Not a Notion / Linear / Asana replacement.** Those are full products with UI, automation, integrations. OWM is the substrate that makes "what's the org's memory of X?" answerable across any of them — typically composed alongside them, not in place of.
- **Not finished — but ships both audiences.** The contributor entity + navigation surface AND the org-operator surface (aggregate queries, policy publish, compliance evidence) both ship from this bridge today. The v1 privacy boundary on aggregate queries is the substrate's existing ABAC + per-graph `share_with`; full ZK aggregate-privacy proofs (per `spec/AGGREGATE-PRIVACY.md`) are a v2.

## See also

- [`../../docs/DUAL-AUDIENCE.md`](../../docs/DUAL-AUDIENCE.md) — the design discipline this vertical applies.
- [`../learner-performer-companion/`](../learner-performer-companion/) — the other pilot dual-audience vertical (learning).
- [`affordances.ts`](affordances.ts) — single source of truth for the tool surfaces.
- [`bridge/`](bridge/) — opinionated MCP bridge that derives tool schemas from the affordances.
- [`src/`](src/) — pod-publisher implementation.
- [`source-adapters/`](source-adapters/) — per-source sub-process implementations.
