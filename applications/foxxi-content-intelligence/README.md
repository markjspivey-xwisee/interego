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

## Hosted SCORM packages

An uploaded SCORM package (`foxxi.upload_scorm_package`) is played from the bridge itself, with no second origin ([`src/scorm-hosting.ts`](src/scorm-hosting.ts)):
- it is kept on the tenant pod under its sha-256, and read back only while its bytes still hash to it;
- each of its files is served from `/scorm/packages/<sha-256>/files/<path>` with `Content-Security-Policy: sandbox` and no `allow-same-origin`, so every document runs in an opaque origin of its own and cannot reach anything of the bridge's;
- each HTML document gets the SCORM runtime put into it (the player's own `scorm-rte.js`), after a bootstrap that stands in for web storage and takes the cmi5 launch's auth-token. The content's commits become that AU's cmi5 statements, sent with a credential bound to one registration;
- the package is a cmi5 course of its SCOs, launched with the signed `POST /agent/cmi5/launch` (`course_id` is `<bridge>/scorm/packages/<sha-256>`), and its statements land in the learner's record as experience.

Single-document SCOs, which current authoring tools export, run. Content whose frames script each other does not, because each document is its own origin.

The bridge lists what it hosts at `GET /scorm/packages`, linked from its entry point as `scorm-packages`. In the dashboard, an admin hosts a package from the LMS content panel ("Host a package"; the bridge refuses anyone else). A learner finds it on the Learn page, launches it signed as themselves, and plays it in a tab of its own.

The listing opens no package. What each package is (its title and SCOs) is kept beside it on the pod as `<sha-256>.json`, and the listing reads that. A package kept with none, for example one uploaded before descriptions were kept, is counted as `unlisted`. The bridge then reads it once, in the background and one package at a time, keeps its description, and lists it from then on. However many requests ask for the same package at once, it is read from the pod once. A SCO whose path would leave the package is never made an AU.

An authoring tool's own export that is no SCORM package (an `.h5p` file, an Adapt course exported as source, or a Rise 360, Storyline, iSpring or Captivate course published for xAPI or the web) is taken by the same upload. It is read in its tool's model ([`src/tool-exports.ts`](src/tool-exports.ts)), and the answer says what it is (`exported`). It is kept the same way, described beside it as an export (`exportOf`). It launches nothing as it is (`playable: false`), so no course is made of it:
- the listing gives it apart from what plays (`exports`), with the fold that takes it;
- its record at `/scorm/packages/<sha-256>` says how to fold it;
- its files are served in the same sandbox, for the pages folded from it.

In the dashboard, "Host a package" takes an `.h5p` file too, and the Author page folds an export as it folds a package.

## Folding a SCORM package into composable content

A hosted package can also be taken apart, into the same fragments and compositions an author writes here ([`src/package-import.ts`](src/package-import.ts)). Anyone may fold one, since a hosted package is served to anyone. Send `package_sha256` to `foxxi.content_fold_course` (`POST /agent/content/fold-course`), or use the Author page's "Fold a package" tab. What it makes is kept on the signer's pod, with the package it was derived from.
- **Pages.** The manifest gives the order: each organization item's resource, its launch page and then its files, each under the `xml:base` its resource inherits. Every HTML page outside the folders packages keep their shared chrome in becomes a concept fragment in Markdown: headings, paragraphs, lists, tables, quotes, code, emphasis, links and images. Text that looks like Markdown is escaped, so it shows as the page showed it. A page's first top-level heading is its title, and its images are the package's own files as this bridge hosts them.
- **Topics.** The pages in one folder are a topic, titled by the organization item whose launch page is there, else by the folder's name. A topic of more than one part becomes a composition, pages then check, and the package a composition of its topics.
- **Questions.** Questions are read only as the package declares them, in any of these forms:
  - calls to a `Question` constructor the package declares in its own scripts, read by its own parameter names and type constants. A call in a comment or inside a string is not one;
  - QTI items, 2.x, 3.0 or 1.2 ([`src/question-banks.ts`](src/question-banks.ts)), read by the correct response each declares: choice (one right option or several), inline choice, text entry (fill-in or numeric, with the other answers its mapping scores), order (sequencing) and match (matching);
  - a bank written as data, in a JSON file or as an array of question objects in a script, read by its field names: choice (options as text, or as objects flagging which are right), true-false, numeric and fill-in.

  They become a check for the topic of the page that loads their script, or of the file's folder, graded on this bridge. A bank kept with the shared chrome is a topic of its own. A right option is named by its place, so an option whose text is one letter is not read as a letter. The package serves the same answers to every browser it runs in, so such a check is only as closed-book as the package was.
- **A package an authoring tool made** is read in that tool's own model ([`src/tool-exports.ts`](src/tool-exports.ts)), since its runtime draws each page from data kept beside it, not from pages of its own:
  - Adapt (`course/<language>/*.json`, as a build keeps it or as an export keeps it under `src/`): each page a topic and each article a page of its blocks and components (text, graphics, accordions, narratives, hot graphics). Its question components are read as the tool marks them right: multiple choice (one right or several), text input (a blank at a time, with the other answers it accepts), matching, and a slider's one right value on its scale. What its author made unavailable is left out, as the course leaves it out;
  - H5P (`h5p.json` and `content/content.json`, in an `.h5p` file or in a package that plays H5P content): an interactive book's chapters as topics and a presentation's slides as pages. Text, tables, images, accordions and dialog cards are read as pages. Multiple choice, true/false, fill in the blanks (a blank at a time), drag the words, single-choice sets, summaries and flashcards are read as questions.
  - Rise 360 ([`src/rise-course.ts`](src/rise-course.ts); the course is base64 JSON in the page its runtime draws everything into, written three ways over its versions): each lesson a topic whose blocks are its pages, split where the course asks the learner to continue (and where a page would grow past what a fragment holds), and each quiz lesson a topic of its questions. Text, lists, quotes, tables, images, galleries, accordions, tabs, processes, timelines, labeled graphics, flashcards, sorting piles and buttons are read as pages, each block showing what its variant shows: a field another variant left behind is not the course's text. Questions are right as Rise grades them: a knowledge check by the answers it flags, a quiz by what its `correct` and `corrects` name (the flags beside a quiz's answers are often leftovers the runtime ignores). A quiz's fill-in accepts every answer it lists, and a bank a quiz draws from is asked whole.
  - Storyline 360 and 3 ([`src/storyline-course.ts`](src/storyline-course.ts); the course is JSON in the data files its player loads, `html5/data/js/`, read without running them): each scene a topic, titled as the player's menu titles it (a scene too long for one composition, topics of fifty slides), and each content slide a page of its layers' text in the order a screen reader reads it, its pictures and its notes. Questions are right as Storyline grades them: the choices, pairs, order or values their definition marks correct. A question built from a form keeps the choices the form names; a free-form one's are the slide's own objects, as the slide shows them. A fill-in accepts every answer it lists, a sort into groups is a match of each item to its group, and a bank a scene draws from is asked whole. A variable's value is a running course's, so it reads as "…", and a quiz's results slide is left out. A button that takes the learner on (to another slide, a submit, out of its layer) is the player's way on, not the course's text; any other button's text is read, as a tab's or a choice's is.
  - iSpring Suite, Presenter, Converter, Free and QuizMaker, 8 to 11 ([`src/ispring-course.ts`](src/ispring-course.ts); the course is base64 in the player's page, a presentation's `presInfo` zlib-deflated, read without running anything): a presentation's slides as pages, a topic for each slide at the top of its outline (one topic, in parts of fifty, when it has no outline), each with its text shape by shape, its pictures (not its background, nor text drawn as a picture) and its notes; an interaction (tabs, an accordion, a glossary, steps) as a page; and a quiz, in a slide's place or on its own, as questions iSpring grades: the choices it marks correct, every answer a typed answer accepts (its letter case where it says so), a sentence of blanks or of lists a blank at a time, a word bank's words, the pairs it matches, the order it keeps, and the values it compares equal. A group a quiz draws from at random is asked whole. QuizMaker 8's quizzes are read too.
  - Captivate 8 to 13, Classic and the new player ([`src/captivate-course.ts`](src/captivate-course.ts); the course is one JavaScript object literal beside the player, `assets/js/CPM.js` for Classic and `assets/js/project.js` for the new player, read as a literal and never run): the course's slides as pages, in the order each slide shows its items (a fixed Classic project's text as it keeps it for a screen reader, a responsive one's HTML, the new player's rich text with its lists), with their pictures (the package's own files) and their narration's captions. Question slides are questions right as Captivate grades them: the answers it marks correct, a blank or a short answer accepting each answer it lists (its letter case where it says so), a blank that is a list, the pairs it matches and the order it keeps; answers it shuffles are turned. The question's text is read from the slide, not from a copy Captivate does not keep in step with it. Objects scored as questions (a click, a drag), hotspots, surveys, video, web objects and pictures Classic packs into its data files are listed with why.

  Options the tool shows shuffled are turned by a count their question decides, so the right one is not always first and the same package folds the same way. Media, an essay, a question or option that is a picture, and a blank that takes misspellings are left out with why. A package neither tool made is read as above. A package that holds several courses (a zip of modules, or a SCORM package whose activities include a course a tool published) has each read in its tool's model, titled as its own, and its other activities read as above.
- **A typed answer is graded as its source grades it.** Letter case counts where the source counts it: QTI 2.x and 3.0 unless the mapping's entries that score an answer say not, QTI 1.2 where a condition says so, H5P blanks unless their author said not, Adapt blanks unless their author allows any case, Rise 360 fill-ins where they say so, Storyline fill-ins as their answers say, iSpring and Captivate typed answers where they say so. The question then says so (`caseSensitive`), and the engine keeps letter case for it alone. Every other typed answer is read without it, as before. The whole reply is compared, as the tool compares it (`compare`): every character (`exact`), or, for an Adapt blank whose author allows punctuation, the letters and digits of every script (`letters`). So "C" is not "C++", "Grüße" is not "Größe", and "not legs" is not "legs". A typed answer authored here is read as it always has been: its letters and digits, and any word of four letters or more. A question here grades all its answers one way, so a QTI item whose accepted answers differ in whether case counts is left out, with why.
- **What a question's form does not say is not guessed.** An item with no correct response, an interaction not graded here (an extended answer, a hotspot), a question that shows an image (in its stem or its prompt), a choice with no list of options, an answer given as a bare number or index when nothing says whether options count from 0 or 1: each is left out and listed with why.
- **What is not read** is listed with why: shared templates, a page with no text of its own, a question whose answer does not fit it, a page longer than a fragment holds.

The same package folds to the same IRIs on this bridge. The sample in `imported/golf-explained.zip` folds into four topics: 14 pages, and 15 questions in 4 checks.

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
| `FOXXI_DASHBOARD_ORIGIN` | Origins (comma-separated) the bridge allows through CORS for the dashboard's `fetch` calls. Their hosts are also the pages a session-key grant may be asked from. |
| `FOXXI_SESSION_KEYS` | Optional. `off` takes no session keys. Otherwise a wallet may grant a key a tab makes the right to sign this bridge's requests as it (`src/session-key.ts`): the grant is an EIP-4361 message naming a dashboard host, this bridge, the key and an expiry; it travels with each request as `_session`, and is checked in full each time. The policy is published at `GET /.well-known/foxxi-session-key`. |
| `FOXXI_SESSION_KEY_MAX_TTL_S` | Optional. The longest a session-key grant may run, in seconds: twelve hours unless set, a week at most. |
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

The loop is self-sovereign. Every one of its affordances takes `tenant_pod_url`: without it the configured tenant is meant and a learning engineer or admin is required; with it naming your own pod (enrolled with `foxxi.register_self_sovereign_learner`, which takes only the pod your wallet is named for, signed by that wallet for itself, and constrains your WebID to that pod; a pod whose name says no wallet, another wallet's pod and a relay- or delegate-signed request are refused, and a membership row for another wallet on a wallet's pod authorizes nothing), you are its owner and the whole loop runs there — judgments, outcomes, calibration, attestation and reputation on your pod, about the same judging agent. An outcome records who confirmed it (`confirmed_by_kind`: a person by default, or an agent, whose reading is a second model's opinion), the calibration counts the two apart, and the attestation carries `confirmers`, so whoever weighs the reputation sees what grounds it. `tools/content-judgment-loop.ts` runs the loop end to end as the wallet it reads, from a claims file that carries the confirmer's answers.

Judges are a network. Every judgment names its judge — the bridge's own model, or an agent that recorded its own judgment with `foxxi.record_content_judgment` (its answer, its distribution, the model it declares). `foxxi.cross_confirm` scores every two judges' newest judgments of one claim by each other's answer, once each way, as agent confirmations naming the peer judgment they came from; a person's confirmation is still what retires a judgment from the queue, and `foxxi.confirm_next` puts the claims judges disagree on first. Attestations are per judge, Self for the bridge's own and Peer for the others, the reputation lists every judge, and `foxxi.best_judge` ranks them for a kind of question by the registry's rating on that kind's axis: the judge to believe, measured rather than configured.

Autonomy is granted by calibration, as a constitutional policy. A `foxxi:AutonomyPolicy` on the pod says, per kind of question, the registry rating on its axis a judge must reach, over how many outcomes the latest attestation about it must rest, and how many of those a person must have confirmed; the default is the harness's bar (0.9 over 20 outcomes, 5 by a person). A judgment publishes Asserted without a person only when its judge clears that rule, and cites the decision either way. `foxxi.set_autonomy_policy` amends the policy through `@interego/constitutional`: proposed, voted, ratified under the tier's rules (a self-sovereign pod is tier 4, one vote, in force at once; the configured tenant amends at tier 3 and waits for a quorum), each policy superseding the last. `foxxi.autonomy_status` is the table: every judge, every kind, may it assert alone, and why.

Content grades and revises itself. `foxxi.weakest_claims` ranks every evidence-level claim judged on the pod, weakest first — graded by a person's confirmation if one exists, else an agent's, else the judges' answers, the lowest of them when they disagree — with the judgments and confirmations behind each grade and a revise control. `foxxi.revise_claim` records a `foxxi:ContentRevision` (the claim as it stood and its grade, the words now and the evidence cited from outside the passage, who revised it) and has the judge grade the revised claim at once under the autonomy policy, so the record says the grade before and after. The original judgment stands; the revision names it. The runner's `--revise <file>` walks a list of revisions and prints each grade's move.

## I2IDL-X: a shared vocabulary for learning data, and a semantic layer over it

[`i2idlx/`](i2idlx/) makes the [I2IDL Digital Learning Glossary](https://www.i2idl.org/glossary) (397 editorially reviewed concepts, published by I2IDL as linked data) something agents can act on and something any organization's learning data can be typed by. It decorates I2IDL's IRIs and never restates or edits the glossary; everything it proposes is published Hypothetical.

- **Ten graphs on Interego**, each a signed, public context graph that dereferences at its own IRI (Turtle, JSON-LD, HyperMarkdown): the `i2x:` ontology, shapes, SHACL rules, a HyprCat agent catalog, enactments, mapping proposals, a release feed, a change history, alignments and referents.
- **An agent entry point.** The catalog's 23 controls cover I2IDL's live SPARQL service, the I2IDL-X graphs, governed writes to the caller's own pod (crosswalk proposals, ratification votes, course-concept alignments, classified data) and two Foxxi capabilities (`write-xapi-statements-signed` for concept-tagged usage, the coverage query).
- **A semantic layer.** Every concept has one of 35 referent categories, aligned to BFO 2020 (with IAO and CCO), gist, DOLCE-UltraLite, gUFO, PROV-O, schema.org and the peer learning vocabularies (CTDL, CTDL-ASN, ESCO, ELM, LRMI, ASN, Open Badges, CASE, xAPI, and this vertical's IEEE LER and ADL TLA). Data linked to an I2IDL concept with `i2x:isClassifiedBy` is typed in all of them by one stored SPARQL query, by SHACL-AF rules, or by an OWL 2 RL or DL reasoner, and contradictions are rejected.
- **How it meets Foxxi.** 89 enactments link I2IDL concepts to live Foxxi and relay actions; usage tagging reuses Foxxi's `foxxi#conceptIds` xAPI extension with I2IDL IRIs; `i2x:CourseConceptAlignment` lines course concept-map nodes up with I2IDL so coverage can be read against one shared reference space; the alignments place this vertical's LER and TLA classes in the same upper ontologies.
- **Agents at work, in view.** The workbench (Interpretant) has an Orchestrate view: on one side a team of eight agents onboards a fictional clinical academy's learning records into the semantic layer — classifying them, checking for contradictions, proposing and ratifying a crosswalk, curating a pack — and on the other the workbench itself follows each call. They act only through the workbench's tools and the catalog's controls, in a sandbox; the governed writes they stage are the exact `publish_context` calls the ports declare, behind a human approval gate. A recorded run replays with every call re-executed and checked; a live run uses the viewer's own Claude account.

Its README covers the design, the reasoning results, the workbench (Interpretant) and how to rebuild and verify against the live services. It is non-normative and adds no term to any Interego namespace.

## Courses as federated data products

The tenant's catalog is also a HyprCat catalog on its pod, and so is any self-sovereign pod's: the configured tenant's admin publishes the tenant's, and a pod's owner publishes that pod's, to that pod and issued by it, with the SCORM courses the owner authored on this bridge. `foxxi.publish_course_catalog_product` renders it as Turtle — a `hyprcat:FederatedCatalog` in the service world, issued by the tenant, listing each course as a `hyprcat:FederatedDataProduct` with its title, category, audience keywords, standard, landing page and an output port that is a followable distribution (a GET of the course's own IRI), and naming peer catalogs with `hyprcat:federatedWith` — and publishes it as a public Asserted descriptor that conforms to `hyprcat:FederatedCatalog`, under one IRI per pod, replaced in place on each republish; an owner's lists every course they authored, read from their own pod as well as the bridge's memory, so a restart does not empty it. Because the type is on the descriptor, any manifest walk finds the catalog without knowing Foxxi.

`foxxi.discover_course_catalogs` is that walk: over the pods the caller names, or the tenant pod and the deployment's federation peers, it finds catalogs by descriptor type, reads them back, checks each catalog's issuer against the identity the manifest attributes the descriptor to, and reports every pod walked, an unreachable one included. No registry and no marketplace: the pods are the ones you already know or federate with. The vertical uses the Layer 2 pattern as written and adds no term to it; the render, the parse and the discovery are `src/course-catalog-product.ts`, with tests.
## Credentials earned from evidence

A learner's pod wallet holds Open Badges 3.0 credentials the tenant issued, and since 2026-09-24 a credential is earned, not typed in. `foxxi.claim_credential` issues a completion credential for a catalog course only from the learner's own record: a passed, mastered, satisfied or waived xAPI statement about the course (not `completed`, which the engine also records beside `failed`) (any of the course's IRIs, or a statement whose parent or grouping is one), with success not false and any score at or above the course's threshold, and graded by the bridge itself: the SCORM engine's completions carry a grading tag keyed by a secret only the bridge holds, so a statement the learner recorded is in the record but does not earn a credential. The credential names that evidence, is signed by the tenant's issuer key, is valid for a year, and is written to the learner's wallet; a `credentialed` statement joins their record. Held and in force, the credential comes back unissued. Not earned, a 409 refusal says what statement would earn it. A learner claims for themselves; an admin may claim for a learner.

The same claim is signed like the SCORM engine's own routes, for the courses the engine grades: `foxxi.claim_credential_signed` and `foxxi.earned_credentials_signed` (`POST /agent/credentials/claim` and `/earned`) take a wallet's signature or a delegated agent's, which is how a relay connection such as a Claude connector reaches Foxxi. They read the signer's own pod, derived from the signature and never named by the caller, and a delegated claim is issued to the person the delegation names. The criteria say when the learner is the course's author, comparing the pods the two names derive as well as the names, since a wallet authors as its did:ethr and its owner learns under a WebID.

`foxxi.earned_credentials` is where every assigned course stands: credentialed (a verified, unexpired credential in the wallet), claimable (mastery in the record, no credential in force; the standing carries the claim call), in progress (statements about the course, none demonstrating mastery), or not started; a lapsed credential is named. The record is the learner's shared lattice, lens and durable records, read from their own pod.

`foxxi.verify_credential` is what a relying party should check before believing a credential, open to anyone: the Data Integrity proof verifies and its key is the stated issuer; `validUntil` has not passed and `validFrom` has; the issuer is one this tenant stands behind (its own issuer key); the credential names its subject. Every check is answered, and each failed one in words. Give it `credential_url`, the credential's link in its holder's wallet on this deployment's pod store, and the bridge reads the bytes the issuer signed. A pasted copy is only as good as whoever copied it: a fresh agent handed a credential to verify moved one field while retyping it, and the proof failed. The logic is `src/earned-credentials.ts`, with tests; the bridge reads the pod, signs, and writes the wallet.
