# Foxxi dashboard — Interego-grounded

Refactored Foxxi admin + learner dashboard. Replaces the standalone
[`imported/foxxi_admin_v01.jsx`](../imported/foxxi_admin_v01.jsx) and
[`imported/foxxi_dashboard_v03.jsx`](../imported/foxxi_dashboard_v03.jsx)
single-file React apps with a Vite app whose data layer flows through
the Foxxi vertical bridge.

The originals had a giant inlined `RAW_DATA` blob at the top of each
file and a mocked "any well-formed WebID accepts" login. This app
runs the same UX intent (learner sees enrolled courses + asks
questions about a course; admin sees catalog + policies + coverage +
audit) but every data fetch goes through Interego:

| UX action | Old (imported JSX) | New (this app) |
|---|---|---|
| Learner sees their assignments | Looked up against inlined sample data | `foxxi.discover_assigned_courses` against the Foxxi bridge (Path B) — same call shape the substrate's bridge handlers accept |
| Learner asks a question | Local string-match on inlined transcripts | `foxxi.ask_course_question` against the bridge → composes the substrate's `groundedAnswer` (honest no-match, content-hash verified, IRI citations) |
| Admin views catalog | Read from inlined RAW_DATA | Sourced from the substrate's published `fxs:Package` descriptors (sample mode bundles them for offline dev) |
| Admin runs coverage query | Local counting | `foxxi.coverage_query` against the bridge — composes the aggregate-privacy ladder (abac / merkle-attested-opt-in / zk-distribution) |
| Admin views audit log | Read from inlined RAW_DATA | Sample-bundled today; production composes [`integrations/compliance-overlay/`](../../../integrations/compliance-overlay/) |
| Login | Any-string mock | Pick a real identity from the Acme Training Co sample roster; `webId` becomes the `learner_did` on every affordance call |

## Two transports — automatic

The dashboard's [`src/interego/client.ts`](src/interego/client.ts)
probes the Foxxi bridge at startup:

- **bridge mode**: if `${VITE_FOXXI_BRIDGE_URL}/affordances` responds
  (default `http://localhost:6080`), every affordance call is a
  JSON-RPC `tools/call` against `/mcp`. The bridge runs the real
  substrate handlers — composed with aggregate-privacy, compliance-
  overlay, LPC's grounded-answer.
- **sample mode**: if the bridge isn't reachable, the client switches
  to in-process synthesis using the bundled Acme Training Co sample data
  from [`../imported/`](../imported/). Same UI, no bridge required.
  Useful for clicking around without standing up the bridge.

The transport status is shown as a pill in the top-right header
(`● live bridge` vs `● offline sample`).

## Run

```bash
# 1. Start the Foxxi bridge (in another terminal):
cd ../bridge
PORT=6080 \
  FOXXI_TENANT_POD_URL=https://interego-css.livelysky-8b81abb0.eastus.azurecontainerapps.io/foxxi/ \
  FOXXI_AUTHORITATIVE_SOURCE=did:web:acme-training.example \
  FOXXI_AUDIENCE=both \
  FOXXI_DASHBOARD_ORIGIN=http://localhost:5173 \
  npx tsx server.ts

# 2. Start the dashboard:
cd ../dashboard-app
npm install
npm run dev
# → http://localhost:5173/
```

(Step 1 is optional — the dashboard falls back to sample mode if you
skip it. The header pill makes it explicit.)

## Three LLM architectures (pick via Settings ⚙)

The dashboard's chat panel routes through the substrate three ways
depending on who owns the LLM call:

| Mode | Who pays for inference | Where the key lives | Tool called |
|---|---|---|---|
| `bridge-env` | The tenant operating the bridge | `FOXXI_LLM_API_KEY` env on the bridge | `foxxi.ask_course_question_agentic` (no per-request key) |
| `byok` | The end user (their Anthropic subscription) | Paste into Settings → browser `localStorage` → sent as `llm_api_key` per request; bridge uses transiently, never persists/logs | `foxxi.ask_course_question_agentic` (with `llm_api_key`) |
| `mcp-client` | The end user's existing agent subscription (Claude.ai connector / Claude Desktop / Claude Code / Cursor) | NO API key anywhere | `foxxi.retrieve_course_context` (substrate returns retrieval scaffold + verbatim cited transcripts; you copy them into YOUR agent session and have it synthesise) |

Each mode records its key source on the LLM-completion descriptor
(`body.keySource: 'bridge-env' | 'per-request-byok' | 'mcp-client'`)
so the audit trail is honest about who paid for the inference.

In `mcp-client` mode the chat panel shows a "Copy structured prompt"
button that gives you a ready-to-paste prompt with the cited
transcripts pre-attached — drop it into Claude.ai / Claude Desktop /
Claude Code / etc. and the agent synthesises against the retrieval
the substrate just produced for you. Your existing subscription
pays. No second auth setup, no bridge-side key.

## Identity flow

The dashboard's login screen lets you pick:
- **Admin** — Jordan Doe (L&D Administrator at Acme Training Co)
- **Learner** — pick from the sample roster. Joshua Liu (`u-joshua`,
  engineering audience) is the recommended starting point:
  he has Golf Explained assigned, the full parsed course
  is bundled, and the Q&A flow has real transcripts to ground in.

The selected identity's `webId` is sent as `learner_did` on every
affordance call. The substrate uses it to (a) resolve audience-tag
membership for enrollment discovery, (b) record on the audit-log
descriptor for the Q&A turn.

In production this is replaced with the substrate's real auth flow
(DID-resolution, SIWE / WebAuthn). The dashboard's
[`src/auth/session.ts`](src/auth/session.ts) is the single seam to
swap.

## What this proves

- The Foxxi vertical's affordances are sufficient to drive a real
  end-user dashboard, not just a contract-test surface.
- The substrate-side bridge handlers can be invoked from the browser
  (CORS-enabled at the vertical layer per
  [`docs/DEPLOYMENT-SPLIT.md`](../../../docs/DEPLOYMENT-SPLIT.md)
  guidance — the substrate stays CORS-agnostic; verticals own their
  CORS policy).
- The `groundedAnswer` substrate primitive (from LPC, composed by
  the Foxxi `course-qa.ts` adapter) gives the learner a real answer
  to "what is handicap?" with verbatim transcript citations
  — and an honest null for "what is photosynthesis?".
- The aggregate-privacy ladder is reachable from the admin UI: a
  click on "Run query" with the merkle-attested-opt-in mode returns
  a real Merkle root the auditor can re-verify.
- The architectural discipline holds: the generic `mcp-server/` and
  `deploy/mcp-relay/` know nothing about Foxxi; the Foxxi bridge
  runs on its own port; the dashboard composes the same affordance
  contract a generic agent would discover via Path A.

## Substrate composition map

```
dashboard-app (this directory)
  └─ src/interego/client.ts ─────────────►  applications/foxxi-content-intelligence/bridge/server.ts
                                                  │
                                                  ├─ foxxi.discover_assigned_courses
                                                  │   └► src/enrollment.ts
                                                  │
                                                  ├─ foxxi.ask_course_question
                                                  │   └► src/course-qa.ts
                                                  │      └► applications/learner-performer-companion/src/grounded-answer.ts
                                                  │
                                                  ├─ foxxi.coverage_query
                                                  │   └► src/publisher.ts:coverageQuery
                                                  │      └► applications/_shared/aggregate-privacy/  (v2 + v3 + v3-distribution)
                                                  │
                                                  └─ (other handlers wire to compliance-overlay,
                                                      lrs-adapter, src/connectors/, etc.)
```
