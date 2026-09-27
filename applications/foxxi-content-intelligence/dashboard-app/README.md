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
| Learner finds and plays a composition | — | **Learn** (`/learn`, `/learn/<hash>`): a pasted link, IRI or hash, the ones opened lately, and the learner's own record (`foxxi.content_mine`); played step by step with `foxxi.content_launch` and `foxxi.content_next`, resolved from their own record and signed as them — the same affordances an agent plays through with no page |
| Author writes and composes content | — | **Author** (`/author`, `/author/<hash>`): fragments written with the engine's own kinds and a Markdown preview by its own renderer, questions of every kind, composed into positions of alternatives from a shelf or by IRI; each composition's page resolves it for its author as a person or as an agent (`foxxi.content_resolve`: no play started, nothing recorded), links its cmi5 course structure and SCORM 2004 package, and shows what it has learned (its efficacy, as the engine says it) — `foxxi.content_fragment`, `foxxi.content_compose`, `foxxi.content_mine`, the same affordances an agent authors through |
| Performer records work and keeps what it implies | — | **Work** (`/work`): a unit of production work recorded with how it went, step by step (`foxxi.record_performance_signed`), checked first by the bridge's own limits and duration rule, and recorded as an agent's (which can make the performer's record public) only once they confirm it; a failure answered with the offer the work implies (its regime, the plan, the forms of content that would help), kept or withdrawn with `foxxi.content_admit` and listed with `foxxi.content_admissions` |

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

A roster identity's session token is signed by its demo wallet, derived from
a public seed. A bridge may keep those wallets out of its directory, as the
deployed one does, since anyone could sign as them; it then refuses the token
("not in tenant directory"). The dashboard asks once, of the session's own
profile, whether the bridge takes the token
([`src/auth/token-standing.ts`](src/auth/token-standing.ts)). A roster session
it refuses is treated like a wallet or a pasted key: it lands on Learn, and
the pages read with the token say why.

Two sign-ins act as a real self-sovereign identity rather than a roster
stand-in:
- **A wallet extension** (any EIP-1193 browser wallet). Its key never leaves
  the wallet. The wallet signs the session's token at sign-in, and each signed
  request after that, every time on its owner's approval: the bridge takes only
  the actor's own signature (or its delegation anchor's), so there is no session
  key in between. The pages say so before a prompt, and nothing that prompts runs
  without a click. The session holds no key, so it survives a reload.
- **A pasted key** (or recovery phrase), held in the tab's memory only and never
  written to storage, so it does not survive a reload.

Every session signs its `/agent/*` requests through one signer
([`src/auth/signer.ts`](src/auth/signer.ts)): its wallet extension, its pasted
key, or its roster identity's demo wallet.

In production the roster is replaced with the substrate's real auth flow
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
