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
| **Structural** | `fxs:` | Package as authored (manifest, items, resources, slides, scenes, audio files) | `iep:ContextDescriptor` + `iep:SemioticFacet` + `dcat:Distribution` |
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

## Performance architecture (regime-first)

Foxxi's governing primitive is the **work regime**, not content. The unit of work
is a *performance situation*; the first move is to read its regime — the
relationship between cause and effect — and route to that regime's method.
`WorkRegime` is a closed four-valued union:

| Regime | Method | When |
|---|---|---|
| **Evident** | `apply-practice` | an established practice exists — look it up, don't teach it |
| **Knowable** | `gap-analysis` | cause is analysable — read the gap and close it (*the one regime where the gap frame is correct*) |
| **Emergent** | `dispositional-read` | no fixable gap — read the disposition, steer by safe-to-fail probes + a coaching loop |
| **Turbulent** | `stabilise-first` | act to stabilise, then re-classify |

A situation must be **classified before it is planned.** With no signal,
`diagnose()` returns a first-class `classify-first` / `unclassified` diagnosis and
**refuses to gap-plan** — it never silently defaults to Knowable. Every diagnosis
carries `regimeSource` (`derived` from agent-trajectory signal · `asserted` by the
caller · `default-gap-intent` · `unclassified`); only a *derived* regime carries
calibration authority, so a caller cannot assert or gap-frame its way past the
invariant, nor ride a borrowed track record.

| Concern | Code |
|---|---|
| classify → recommend (owned by AGP) | [`agentic-performance-practice/src/performance-architecture.ts`](../agentic-performance-practice/src/performance-architecture.ts) |
| reflexive calibration loop (owned by AGP) | [`agentic-performance-practice/src/performance-calibration.ts`](../agentic-performance-practice/src/performance-calibration.ts) |
| legacy `GET /performance` / `POST /performance/plan` compatibility surface | [`src/performance-routes.ts`](src/performance-routes.ts) |
| durable multi-recipient records + cross-seat holon resolution | [`src/durable-records.ts`](src/durable-records.ts), [`src/foundation-holon-altitude.ts`](src/foundation-holon-altitude.ts), [`src/foundation-persist.ts`](src/foundation-persist.ts) |

The architecture was built and then **used on the team that built it** — the first
performance situation it managed was the team's own coordination work, classified
**Emergent** and steered by probe + coaching, not gap-planned. Full breakdown with
diagrams: [`ENGAGEMENT-REPORT.md`](../../ENGAGEMENT-REPORT.md); the running record:
[`REFLEXIVE-DOGFOOD.md`](../../REFLEXIVE-DOGFOOD.md).

## Imported assets (`imported/`)

The original Foxxi system files, preserved as-is. Authoritative for
the parser/dashboard/admin behaviour; this vertical's TypeScript
glue references them but does NOT re-implement them.

| File | What it is |
|---|---|
| `foxxi_storyline_parser_v0{1,2,3}.py` | Python parser, Articulate Storyline → RDF, three-stratum emission |
| `foxxi-content-graph{,-v0.2}.ttl`, `rcd.ttl`, `wallet.ttl` | Original three-stratum ontology (fxs/fxk/fxa) — IRIs REBASED off the dead `vocab.foxximediums.com` domain onto `<bridge>/ns/legacy/*`; **superseded by [`src/foxxi-vocab.ts`](src/foxxi-vocab.ts) + the dereferenceable `/ns/<spec>` ontologies**; kept only as the historical record (not loaded at runtime) |
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
| **Agentic RAG** — federated concept-graph retrieval + prereq-edge expansion + LLM synthesis + Interego descriptor trace | shipped — [`src/agentic-rag.ts`](src/agentic-rag.ts) — ports the prior React app's `buildGraphContext` to TS, exposes `foxxi.ask_course_question_agentic` affordance, emits a 4-step modal-statused trace (question Asserted → retrieval Hypothetical → llm Hypothetical → cited-answer Asserted via `iep:supersedes`); LLM is pluggable via `FOXXI_LLM_API_KEY` env var, retrieval works without it |
| Real enrollment discovery (walks admin payload + audience-group membership) | shipped — [`src/enrollment.ts`](src/enrollment.ts) |
| **Closing the loop** — a composed course → a generated cmi5 package + SCORM `.zip` → registered on the LMS → completed in a real browser → xAPI in the live LRS | shipped — [`src/content-package.ts`](src/content-package.ts) + [`src/content-delivery.ts`](src/content-delivery.ts); process recorded in [`CLOSING-THE-LOOP.md`](CLOSING-THE-LOOP.md), verified 14/14 in production |
| **Context Companion** — one conversational front door over a user's networked context: `POST /content/ask` classifies intent and answers from the substrate's own surfaces — assignments, the live LRS, and (for content) the vertical's existing **agentic RAG** — with sourced answers and an honest no-match, the same for humans and agents. `scope: interego` (default) federates discovery across the tenant pod + `FOXXI_FEDERATION_PODS`; `scope: vertical` narrows to the Foxxi slice. Progress / assignment questions are gated behind a wallet-signed session token | shipped — [`src/context-chat.ts`](src/context-chat.ts); process recorded in [`ASKING-YOUR-CONTEXT.md`](ASKING-YOUR-CONTEXT.md) |
| **Channel transport** — `POST /content/deliver` actually sends: a real per-channel webhook (Slack / email / SMS HTTP API, `FOXXI_TRANSPORT_<CHANNEL>`), or the Interego-native publish — a `document` delivery becomes a discoverable `foxxi:DeliveredContent` Context Descriptor on the pod | shipped — [`src/content-transport.ts`](src/content-transport.ts) |
| **Content forms** — content is text in whatever form the situation calls for: plain, markdown, static HTML hypertext, or dynamic interactive hypermedia (a self-contained HTML artifact — collapsible sections + an inline self-check). `chooseForm()` picks per channel / kind / audience; no media generated | shipped — [`src/content-forms.ts`](src/content-forms.ts) |
| **Browser dashboard** | shipped — [`dashboard-app/`](dashboard-app/) (Vite + React, auto-probes the bridge, falls back to sample mode) |
| Live deployment | shipped — bridge + css-gate run as Azure Container Apps; see [`deploy/foxxi-bridge/`](../../deploy/foxxi-bridge/) and [`deploy/css-gate/`](../../deploy/css-gate/). Bridge: `https://foxxi-bridge.interego.xwisee.com`. Tenant pod path: `/foxxi/`. |

## Run the bridge locally

```bash
cd applications/foxxi-content-intelligence/bridge
PORT=6080 \
  FOXXI_TENANT_POD_URL=https://gate.interego.xwisee.com/foxxi/ \
  FOXXI_AUTHORITATIVE_SOURCE=did:web:acme-training.example \
  FOXXI_AUDIENCE=both \
  FOXXI_DASHBOARD_ORIGIN=http://localhost:5173 \
  FOXXI_POD_WRITE_SECRET=<bearer matching the gate's WRITE_SECRET> \
  FOXXI_BRIDGE_PRIVATE_KEY=0x<32-byte hex> \
  npx tsx server.ts
```

### Bridge env vars

| Var | What it does |
|---|---|
| `PORT` | Port the bridge HTTP server binds to. |
| `FOXXI_TENANT_POD_URL` | Pod base the bridge reads and writes against. Must end in the tenant slug — the deployed tenant pod is `/foxxi/`. Against a local CSS use `http://localhost:3000/foxxi/`; against the deployed substrate use the **css-gate** URL (`https://gate.interego.xwisee.com/foxxi/`), not the raw CSS URL. |
| `FOXXI_AUTHORITATIVE_SOURCE` | `did:web:` (or other) identifier the bridge stamps on tenant-authored descriptors so federated readers can resolve attribution. |
| `FOXXI_AUDIENCE` | Which audience slice the bridge serves (`learner`, `admin`, or `both`). |
| `FOXXI_DASHBOARD_ORIGIN` | Origin the bridge allows through CORS for the dashboard's `fetch` calls. |
| `FOXXI_POD_WRITE_SECRET` | Bearer token the bridge sends on every pod write. The css-gate ([`deploy/css-gate/`](../../deploy/css-gate/)) gates all `POST`/`PUT`/`PATCH`/`DELETE` behind `Authorization: Bearer <WRITE_SECRET>` — without this the bridge can read but every write 401s. Reads stay anonymous. Must match the gate's `WRITE_SECRET`. Omit when pointing at a local CSS that accepts anonymous writes. |
| `FOXXI_BRIDGE_PRIVATE_KEY` | 0x-prefixed 32-byte hex. The bridge derives a stable `did:key:0x<addr>#bridge` from it and signs bridge-originated descriptors (snapshots, calibration-flip records) so federated readers admit them as `CryptographicallyVerified`. If unset, the bridge generates an ephemeral key at startup — the signing identity rotates on every restart and older descriptors fail signature recovery. Generate one with `node -e "const{Wallet}=require('ethers');console.log(Wallet.createRandom().privateKey)"`. |
| `FOXXI_LLM_API_KEY` | Optional. Lets the bridge call an LLM for `foxxi.ask_course_question_agentic`. Retrieval works without it. |
| `FOXXI_FEDERATION_PODS` | Optional. Comma-separated peer pod URLs the bridge composes federated calibration evidence from. |
| `FOXXI_TRANSPORT_<CHANNEL>` | Optional. Per-channel webhook URL (e.g. `FOXXI_TRANSPORT_SLACK`) that `POST /content/deliver` calls. |

### Substrate write path

Storage stays zero-trust: anyone can read pod contents and the local CSS still accepts anonymous writes. On the deployed substrate, the css-gate fronts CSS — `GET`/`HEAD`/`OPTIONS` pass through anonymously, mutating verbs require the bearer. Trust lives at the verifier and reader layer: the bridge verifies wallet signatures on every `/performance/outcome` and `/agent/teach` write, and the reader-side federated-outcome loader silently drops any peer descriptor whose `foxxi:agentSignature` does not recover to its `prov:wasGeneratedBy` DID.

### Demo invocations

```bash
# Scripted, deterministic — five wallets, signed per-agent contributions
npx tsx applications/foxxi-content-intelligence/tools/emergent-collective-demo.mjs

# Autonomous — five real Claude subagents via the Claude Agent SDK
# (requires ANTHROPIC_API_KEY or an active Claude Code OAuth login)
npx tsx applications/foxxi-content-intelligence/tools/emergent-collective-agents.mjs

# Live — same scripted contributions, browser dashboard on http://127.0.0.1:8765
npx tsx applications/foxxi-content-intelligence/tools/emergent-collective-live.mjs

# Closed-loop course → cmi5 package → LMS → real-browser completion → xAPI in the live LRS
npx tsx applications/foxxi-content-intelligence/tools/closed-loop-example.mjs

# Seed a second pod with signed peer outcomes for federation testing
npx tsx applications/foxxi-content-intelligence/tools/seed-federation-peer.mjs
```

See [`EMERGENT-COLLECTIVE.md`](EMERGENT-COLLECTIVE.md) for what the three editions share and where they differ, and [`CLOSING-THE-LOOP.md`](CLOSING-THE-LOOP.md) for the end-to-end content path.

## Content judgments, and what they earn

A learning engineer or admin can ask a System One model about a unit of content: `foxxi.judge_content_claim` returns a Hypothetical `foxxi:ContentJudgment` (how well a claim is supported by its context and evidence, or which work regime a piece of work is in), published to the tenant pod with the controls a person needs next; `foxxi.confirm_content_judgment` records what the person holds to be true as an Asserted `foxxi:ContentJudgmentOutcome` superseding the judgment; `foxxi.content_judgment_calibration` reads the outcomes back and reports, per question kind, how often the model had it and the mean multiclass Brier, Asserted from five samples.

From there the judgments earn a reputation the way the harness's do. `foxxi.attest_content_judgments` turns the calibration into a Self attestation by the judging agent about itself (accuracy from the evidence-level hit rate, competence from the work-regime hit rate, honesty from the Brier; Asserted cells only, refused when none has reached its floor), published as a `foxxi:ContentJudgmentAttestation` that supersedes the earlier ones. `foxxi.content_judgment_reputation` aggregates every attestation about the agent on the pod with `@interego/registry`: a self-attestation at a quarter, a peer's word at a half, half-life thirty days. A learning engineer who publishes their own attestation as a Peer moves the snapshot the moment it lands. The mapping to the registry lives in the shared judgment kit, so the harness and Foxxi are weighed the same way.

Confirmations are the scarce input, so `foxxi.confirm_next` says where to spend them: the pending Hypothetical judgments ranked by what a person's answer would teach — the model's own uncertainty, how far the question kind's calibration cell is from earning anything, and how little evidence the claim carried — with the weights stated in the answer and each entry carrying the confirm call to make. No new model call: the factors are the judgments' own and the calibration's, so the queue is deterministic and every factor is shown beside the priority it produced.

The loop is self-sovereign. Every one of its affordances takes `tenant_pod_url`: without it the configured tenant is meant and a learning engineer or admin is required; with it naming your own pod (enrolled with `foxxi.register_self_sovereign_learner`, which constrains your WebID to that pod), you are its owner and the whole loop runs there — judgments, outcomes, calibration, attestation and reputation on your pod, about the same judging agent. An outcome records who confirmed it (`confirmed_by_kind`: a person by default, or an agent, whose reading is a second model's opinion), the calibration counts the two apart, and the attestation carries `confirmers`, so whoever weighs the reputation sees what grounds it. `tools/content-judgment-loop.ts` runs the loop end to end as the wallet it reads, from a claims file that carries the confirmer's answers.

Judges are a network. Every judgment names its judge — the bridge's own model, or an agent that recorded its own judgment with `foxxi.record_content_judgment` (its answer, its distribution, the model it declares). `foxxi.cross_confirm` scores every two judges' newest judgments of one claim by each other's answer, once each way, as agent confirmations naming the peer judgment they came from; a person's confirmation is still what retires a judgment from the queue, and `foxxi.confirm_next` puts the claims judges disagree on first. Attestations are per judge, Self for the bridge's own and Peer for the others, the reputation lists every judge, and `foxxi.best_judge` ranks them for a kind of question by the registry's rating on that kind's axis: the judge to believe, measured rather than configured.

Autonomy is granted by calibration, as a constitutional policy. A `foxxi:AutonomyPolicy` on the pod says, per kind of question, the registry rating on its axis a judge must reach, over how many outcomes the latest attestation about it must rest, and how many of those a person must have confirmed; the default is the harness's bar (0.9 over 20 outcomes, 5 by a person). A judgment publishes Asserted without a person only when its judge clears that rule, and cites the decision either way. `foxxi.set_autonomy_policy` amends the policy through `@interego/constitutional`: proposed, voted, ratified under the tier's rules (a self-sovereign pod is tier 4, one vote, in force at once; the configured tenant amends at tier 3 and waits for a quorum), each policy superseding the last. `foxxi.autonomy_status` is the table: every judge, every kind, may it assert alone, and why.

Content grades and revises itself. `foxxi.weakest_claims` ranks every evidence-level claim judged on the pod, weakest first — graded by a person's confirmation if one exists, else an agent's, else the judges' answers, the lowest of them when they disagree — with the judgments and confirmations behind each grade and a revise control. `foxxi.revise_claim` records a `foxxi:ContentRevision` (the claim as it stood and its grade, the words now and the evidence cited from outside the passage, who revised it) and has the judge grade the revised claim at once under the autonomy policy, so the record says the grade before and after. The original judgment stands; the revision names it. The runner's `--revise <file>` walks a list of revisions and prints each grade's move.

## Courses as federated data products

The tenant's catalog is also a HyprCat catalog on its pod. `foxxi.publish_course_catalog_product` (admin) renders it as Turtle — a `hyprcat:FederatedCatalog` in the service world, issued by the tenant, listing each course as a `hyprcat:FederatedDataProduct` with its title, category, audience keywords, standard, landing page and an output port that is a followable distribution (a GET of the course's own IRI), and naming peer catalogs with `hyprcat:federatedWith` — and publishes it as a public Asserted descriptor that conforms to `hyprcat:FederatedCatalog`, under one IRI per tenant pod so a republish supersedes. Because the type is on the descriptor, any manifest walk finds the catalog without knowing Foxxi.

`foxxi.discover_course_catalogs` is that walk: over the pods the caller names, or the tenant pod and the deployment's federation peers, it finds catalogs by descriptor type, reads them back, checks each catalog's issuer against the identity the manifest attributes the descriptor to, and reports every pod walked, an unreachable one included. No registry and no marketplace: the pods are the ones you already know or federate with. The vertical uses the Layer 2 pattern as written and adds no term to it; the render, the parse and the discovery are `src/course-catalog-product.ts`, with tests.
## Credentials earned from evidence

A learner's pod wallet holds Open Badges 3.0 credentials the tenant issued, and since 2026-09-24 a credential is earned, not typed in. `foxxi.claim_credential` issues a completion credential for a catalog course only from the learner's own record: a passed, completed, mastered, satisfied or waived xAPI statement about the course (any of the course's IRIs, or a statement whose parent or grouping is one), with success not false and any score at or above the course's threshold, and graded by the bridge itself: the SCORM engine's completions carry a grading tag keyed by a secret only the bridge holds, so a statement the learner recorded is in the record but does not earn a credential. The credential names that evidence, is signed by the tenant's issuer key, is valid for a year, and is written to the learner's wallet; a `credentialed` statement joins their record. Held and in force, the credential comes back unissued. Not earned, a 409 refusal says what statement would earn it. A learner claims for themselves; an admin may claim for a learner.

`foxxi.earned_credentials` is where every assigned course stands: credentialed (a verified, unexpired credential in the wallet), claimable (mastery in the record, no credential in force; the standing carries the claim call), in progress (statements about the course, none demonstrating mastery), or not started; a lapsed credential is named. The record is the learner's shared lattice, lens and durable records, read from their own pod.

`foxxi.verify_credential` is what a relying party should check before believing a credential, open to anyone: the Data Integrity proof verifies and its key is the stated issuer; `validUntil` has not passed and `validFrom` has; the issuer is one this tenant stands behind (its own issuer key); the credential names its subject. Every check is answered, and each failed one in words. The logic is `src/earned-credentials.ts`, with tests; the bridge reads the pod, signs, and writes the wallet.
