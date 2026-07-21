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
  FOXXI_TENANT_POD_URL=https://gate.interego.xwisee.com/foxxi/ \
  FOXXI_AUTHORITATIVE_SOURCE=did:web:acme-training.example \
  FOXXI_AUDIENCE=both \
  FOXXI_DASHBOARD_ORIGIN=http://localhost:5173 \
  FOXXI_POD_WRITE_SECRET=<bearer matching the gate's WRITE_SECRET> \
  FOXXI_BRIDGE_PRIVATE_KEY=0x<32-byte hex> \
  npx tsx server.ts

# 2. Start the dashboard:
cd ../dashboard-app
npm install
npm run dev
# → http://localhost:5173/
```

(Step 1 is optional — the dashboard falls back to sample mode if you
skip it. The header pill makes it explicit.)

### Bridge env vars

| Var | What it does |
|---|---|
| `PORT` | Port the bridge HTTP server binds to (the dashboard probes `${VITE_FOXXI_BRIDGE_URL}/affordances` here). |
| `FOXXI_TENANT_POD_URL` | Pod base the bridge reads and writes against. See "Gate vs direct CSS" below — the URL changes depending on which CSS you point at. |
| `FOXXI_AUTHORITATIVE_SOURCE` | `did:web:` (or other) identifier the bridge stamps on tenant-authored descriptors so federated readers can resolve attribution. |
| `FOXXI_AUDIENCE` | Which audience slice the bridge serves (`learner`, `admin`, or `both`). |
| `FOXXI_DASHBOARD_ORIGIN` | Origin the bridge allows through CORS for the dashboard's `fetch` calls. |
| `FOXXI_POD_WRITE_SECRET` | Bearer token the bridge sends on every pod write. The css-gate (`deploy/css-gate/`) gates all `POST`/`PUT`/`PATCH`/`DELETE` behind `Authorization: Bearer <WRITE_SECRET>` — without this, every bridge write 401s. Reads stay anonymous. Must match the gate's `WRITE_SECRET`. |
| `FOXXI_BRIDGE_PRIVATE_KEY` | 0x-prefixed 32-byte hex. The bridge derives a stable `did:key:0x<addr>#bridge` from it and signs bridge-originated descriptors (snapshots, calibration-flip records) so the pod-browser shows `CryptographicallyVerified`. If unset, the bridge generates an ephemeral key at startup and descriptors lose their verified-identity badge across restarts. Generate one with: |

```bash
node -e "const{Wallet}=require('ethers');const w=Wallet.createRandom();console.log(w.privateKey)"
```

### Gate vs direct CSS

`FOXXI_TENANT_POD_URL` must match the substrate you're pointing the bridge at:

- **Local CSS (dev)** — no gate is running, point directly at the CSS instance,
  e.g. `http://localhost:3000/foxxi/`. `FOXXI_POD_WRITE_SECRET` can be omitted
  (the local CSS accepts anonymous writes).
- **Deployed CSS** — writes are gated by `css-gate`. The URL must be the
  **gate's** URL (e.g.
  `https://gate.interego.xwisee.com/foxxi/`),
  not the raw CSS URL, and `FOXXI_POD_WRITE_SECRET` must be set to the bearer
  the gate expects. Reads still pass through the gate anonymously.

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
