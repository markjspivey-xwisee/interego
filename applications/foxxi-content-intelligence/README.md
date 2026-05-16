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
| **L&D administrator** (e.g., Jordan Doe at ACME Utility) | Ingest content packages, manage the catalog, assign audiences via policies, query coverage across the catalog, audit-log everything | `foxxi.ingest_content_package`, `foxxi.publish_authoring_policy`, `foxxi.connect_lms`, `foxxi.assign_audience`, `foxxi.coverage_query`, `foxxi.publish_compliance_evidence`, `foxxi.publish_concept_map` |
| **Learner / performer** | Discover assigned courses, consume lessons, explore the published concept map | `foxxi.discover_assigned_courses`, `foxxi.consume_lesson`, `foxxi.explore_concept_map` |

## Three-stratum vocabulary

Preserves the Foxxi three-stratum decomposition. Each course produces
descriptors across all three:

| Stratum | Prefix | What it captures | Substrate composition |
|---|---|---|---|
| **Structural** | `fxs:` | Package as authored (manifest, items, resources, slides, scenes, audio files) | `cg:ContextDescriptor` + `cg:SemioticFacet` + `dcat:Distribution` |
| **Knowledge** | `fxk:` | Extracted concepts, claims, prerequisite edges, Peircean Sign/Object/Interpretant decomposition | PGSL atoms + pullbacks; SAT semiotic facet |
| **Activity** | `fxa:` | Consumption traces, extraction events, competency signals | xAPI projection via [`lrs-adapter/`](../lrs-adapter/); HELA presheaf |

Ontology files live in [`ns/`](ns/) and are vertical-scoped (Layer
non-normative per [`spec/LAYERS.md`](../../spec/LAYERS.md)) — they
compose with L1/L2/L3 ontologies but do not extend them.

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
| `foxxi-content-graph{,-v0.2}.ttl` | Vocabulary declarations (fxs/fxk/fxa) |
| `lesson{2,3}_v0{2,3}.ttl` | Parsed lesson graphs (sample data) |
| `build_dashboard_data{,_v03}.py` | Dashboard JSON builder |
| `dashboard_data{,_v03}.json` + `lesson{2,3}_dashboard_data_v03.json` | Per-course dashboard payloads |
| `admin_gen_*.py` | Admin payload generators (catalog/users/groups/policies/events/audit/coverage/connections) |
| `admin_payload.json` | Generated tenant admin payload (sample: ACME Utility, 183 employees, full L&D state) |
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
| Live deployment | not yet — adopters can run via the bridge |
