# Foxxi Content Intelligence — vertical

Enterprise-grade content-intelligence layer for organizational learning &
development (L&D). Ingests SCORM 1.2 / SCORM 2004 / cmi5 / xAPI packages
authored in Articulate Storyline (or any compatible tool), parses them
deterministically into RDF, enriches them with extracted concept maps +
pedagogical relations, and publishes the result as federated pod
artifacts that compose cleanly with the rest of the Interego substrate.

**Origin.** Foxxi was built independently as a three-stratum
vocabulary + parser + dashboard system (see [`imported/`](imported/)
for the original scripts, dashboards, sample payloads, and the
Foxximediums TTLs). This vertical wraps it as a first-class Interego
vertical that composes with the existing substrate — the user's
parser scripts stay authoritative; this vertical provides the
substrate-side glue.

**Dual audience.** Same discipline as
[`learner-performer-companion/`](../learner-performer-companion/) +
[`organizational-working-memory/`](../organizational-working-memory/):

| Audience | What they do | Affordances |
|---|---|---|
| **L&D administrator** (e.g., Jordan Doe at Acme Training Co) | Ingest content packages, manage the catalog, assign audiences via policies, query coverage across the catalog, audit-log everything | `foxxi.ingest_content_package`, `foxxi.publish_authoring_policy`, `foxxi.connect_lms`, `foxxi.assign_audience`, `foxxi.coverage_query`, `foxxi.publish_compliance_evidence`, `foxxi.publish_concept_map` |
| **Learner / performer** | Discover assigned courses, consume lessons, explore the published concept map | `foxxi.discover_assigned_courses`, `foxxi.consume_lesson`, `foxxi.explore_concept_map` |

## Three-stratum vocabulary

Preserves the Foxxi three-stratum decomposition. Each course produces
descriptors across all three:

| Stratum | Prefix | What it captures | Substrate composition |
|---|---|---|---|
| **Structural** | `fxs:` | Package as authored (manifest, items, resources, slides, scenes, audio files) | `cg:ContextDescriptor` + `cg:SemioticFacet` + `dcat:Distribution` |
| **Knowledge** | `fxk:` | Extracted concepts, claims, prerequisite edges, Peircean Sign/Object/Interpretant decomposition | PGSL atoms + pullbacks; SAT semiotic facet |
| **Activity** | `fxa:` | Consumption traces, extraction events, competency signals | xAPI projection via [`lrs-adapter/`](../lrs-adapter/); HELA presheaf |

The **live, canonical vocabulary** is [`src/foxxi-vocab.ts`](src/foxxi-vocab.ts) —
one namespace base (`<bridge>/ns/foxxi#`), served as dereferenceable
linked data by the bridge at `/ns/foxxi`. It is vertical-scoped (Layer
non-normative per [`spec/LAYERS.md`](../../spec/LAYERS.md)) — it composes
with L1/L2/L3 ontologies but does not extend them. The original
three-stratum ontology TTLs (the pre-Interego `vocab.foxximediums.com`
namespace) are retained under [`imported/`](imported/) as the historical
record — superseded by `foxxi-vocab.ts`, not loaded at runtime.

## Composition with existing substrate primitives

| Foxxi need | Existing substrate primitive | Why it fits |
|---|---|---|
| SCORM/cmi5 unwrap | [`applications/_shared/scorm/`](../_shared/scorm/) | Already handles unzip + manifest parse + launchable lesson extraction |
| xAPI projection of consumption events | [`applications/lrs-adapter/`](../lrs-adapter/) | Already handles the lossy projection LPC uses |
| Coverage query without per-learner reveal | [`applications/_shared/aggregate-privacy/`](../_shared/aggregate-privacy/) v3 zk-distribution | Histogram of concept coverage across courses; v3.2 ε-budget keeps cumulative leakage bounded |
| Per-action audit + compliance citation | [`integrations/compliance-overlay/`](../../integrations/compliance-overlay/) | Every L&D admin action becomes a SOC 2 / EU AI Act / NIST RMF cited descriptor |
| Federated multi-course catalog | [`hyprcat:`](../../docs/ns/hyprcat.ttl) data-product catalog | Federation IRI base in `federation_payload.json` matches the HyprCat federation discipline |
| LMS connectors (Cornerstone OnDemand, Workday Learning, etc.) | [`src/connectors/`](../../src/connectors/) extensibility surface | Foxxi reuses the connector registry pattern |

## Imported assets (`imported/`)

The original Foxxi system files, preserved as-is. Authoritative for
the parser/dashboard/admin behaviour; this vertical's TypeScript
glue references them but does NOT re-implement them.

| File | What it is |
|---|---|
| `foxxi_storyline_parser_v0{1,2,3}.py` | Python parser, Articulate Storyline → RDF, three-stratum emission |
| `foxxi-content-graph{,-v0.2}.ttl`, `rcd.ttl`, `wallet.ttl` | Original three-stratum ontology (fxs/fxk/fxa, the `vocab.foxximediums.com` namespace) — **superseded by [`src/foxxi-vocab.ts`](src/foxxi-vocab.ts)**; kept as the historical record |
| `lesson{2,3}_v0{2,3}.ttl` | Parsed lesson graphs (sample data) |
| `build_dashboard_data{,_v03}.py` | Dashboard JSON builder |
| `dashboard_data{,_v03}.json` + `lesson{2,3}_dashboard_data_v03.json` | Per-course dashboard payloads |
| `admin_gen_*.py` | Admin payload generators (catalog/users/groups/policies/events/audit/coverage/connections) |
| `admin_payload.json` | Generated tenant admin payload (sample: Acme Training Co, 183 employees, full L&D state) |
| `federation_payload.json` | Federated multi-course payload (primary + federated peers) |
| `transcripts.json` | Whisper-transcribed audio narration |
| `foxxi_admin_v01.jsx` + `foxxi_dashboard{,_v03}.jsx` | React admin + dashboard UIs |

## Layering discipline

Per [`applications/README.md`](../README.md):

- This vertical sits OUTSIDE the L1/L2/L3 protocol surface
- The `fxs:` / `fxk:` / `fxa:` prefixes are vertical-scoped — not core
- Verticals MUST NOT propose changes to core ontologies; this one
  composes them via PGSL atoms + descriptors with appropriate facets
- Path A (generic): a protocol-aware agent discovers + invokes Foxxi
  affordances via the standard `discover_context` flow + HTTP POST
  to `hydra:target`
- Path B (ergonomic): the optional MCP bridge at [`bridge/`](bridge/)
  exposes Foxxi affordances as named MCP tools

## Status

| Piece | Status |
|---|---|
| Vocabulary (vertical-scoped TTLs) | imported as-is |
| Affordance declarations (typed) | shipped — see [`affordances.ts`](affordances.ts) |
| Bridge handler skeleton | shipped — see [`src/`](src/) |
| MCP bridge | shipped — see [`bridge/server.ts`](bridge/server.ts) |
| Compose with aggregate-privacy for coverage queries | shipped |
| Compose with compliance-overlay for audit | shipped |
| Compose with LRS-adapter for activity projection | shipped (via existing lrs-adapter path) |
| Real learner Q&A — lexical (grounded against transcripts via LPC's groundedAnswer) | shipped — [`src/course-qa.ts`](src/course-qa.ts) — keyword overlap + tamper-detected atom citations |
| **Agentic RAG** — federated concept-graph retrieval + prereq-edge expansion + LLM synthesis + Interego descriptor trace | shipped — [`src/agentic-rag.ts`](src/agentic-rag.ts) — ports the prior React app's `buildGraphContext` to TS, exposes `foxxi.ask_course_question_agentic` affordance, emits a 4-step modal-statused trace (question Asserted → retrieval Hypothetical → llm Hypothetical → cited-answer Asserted via `cg:supersedes`); LLM is pluggable via `FOXXI_LLM_API_KEY` env var, retrieval works without it |
| Real enrollment discovery (walks admin payload + audience-group membership) | shipped — [`src/enrollment.ts`](src/enrollment.ts) |
| **Closing the loop** — a composed course → a generated cmi5 package + SCORM `.zip` → registered on the LMS → completed in a real browser → xAPI in the live LRS | shipped — [`src/content-package.ts`](src/content-package.ts) + [`src/content-delivery.ts`](src/content-delivery.ts); process recorded in [`CLOSING-THE-LOOP.md`](CLOSING-THE-LOOP.md), verified 14/14 in production |
| **Context Companion** — one conversational front door over a user's networked context: `POST /content/ask` classifies intent and answers from the substrate's own surfaces — assignments, the live LRS, and (for content) the vertical's existing **agentic RAG** — with sourced answers and an honest no-match, the same for humans and agents. `scope: interego` (default) federates discovery across the tenant pod + `FOXXI_FEDERATION_PODS`; `scope: vertical` narrows to the Foxxi slice. Progress / assignment questions are gated behind a wallet-signed session token | shipped — [`src/context-chat.ts`](src/context-chat.ts); process recorded in [`ASKING-YOUR-CONTEXT.md`](ASKING-YOUR-CONTEXT.md) |
| **Channel transport** — `POST /content/deliver` actually sends: a real per-channel webhook (Slack / email / SMS HTTP API, `FOXXI_TRANSPORT_<CHANNEL>`), or the Interego-native publish — a `document` delivery becomes a discoverable `foxxi:DeliveredContent` Context Descriptor on the pod | shipped — [`src/content-transport.ts`](src/content-transport.ts) |
| **Content forms** — content is text in whatever form the situation calls for: plain, markdown, static HTML hypertext, or dynamic interactive hypermedia (a self-contained HTML artifact — collapsible sections + an inline self-check). `chooseForm()` picks per channel / kind / audience; no media generated | shipped — [`src/content-forms.ts`](src/content-forms.ts) |
| **Browser dashboard** | shipped — [`dashboard-app/`](dashboard-app/) (Vite + React, auto-probes the bridge, falls back to sample mode) |
| Live deployment | not yet — adopters run the bridge + dashboard locally; production deploy is a Docker/Container Apps step |
