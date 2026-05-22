# Asking your networked context — analysis, design, development

This document records, as part of the Foxxi vertical, the
analysis → design → development → verification process by which the
**Context Companion** was added: one conversational front door over a
user's whole networked context, for humans and agents alike.

It is the companion to [`CLOSING-THE-LOOP.md`](CLOSING-THE-LOOP.md).
That document recorded wiring generated content into the live
LMS/CMS/LRS so it is produced, delivered and recorded. This one records
the next step: making all of that *askable* — so a user never has to
know which surface holds the answer.

---

## 1. Analysis — the gap

The honest finding before this work: every surface existed and worked,
but a user still had to know which one to call.

- `course-qa.ts` could answer a question — but only about a single
  course you hand it.
- `agentic-rag.ts` could answer with an LLM — but only over course
  payloads you hand it, and only with an API key.
- `discoverAssignedCourses()` resolved assignments — a separate call.
- The LRS held every learner's progress — another separate surface.

So the substrate knew, for any user, what courses were assigned to them,
what those courses were composed from, what job aids existed, and
everything they had done — but there was no single place a user could
*just ask*. The whole premise of Interego is that a user's context is
**networked** — one substrate, every surface joined. The missing piece
was a front door that treats it that way.

Diagnosis (in the architecture's own terms): an **Evident-regime gap** —
the desired end state was obvious and the cause was a missing
connection, not missing capability. The intervention was **development**:
build the front door.

## 2. Design

One route — `POST /content/ask` — takes a natural-language question from
any user (human or agent) and answers it. The module is **composition
glue, not new machinery** — five design decisions:

**Intent classification.** A deterministic, keyword-routed classifier
maps the question to one of six intents — `assignments`, `progress`,
`concept`, `procedure`, `catalog`, `general` — so the right surface
answers it. "Do I have any courses assigned to me?" routes to the
assignment surface; "what does this mean?" routes to the content.

**Networked-context assembly.** For each ask, the asker's networked
context is assembled from the substrate's *own* surfaces: the
published-course registry (its emergent `Course`s, retained so they can
be retrieved over), the job-aid registry, the live LRS (the learner's
xAPI activity), and — when the tenant directory is seeded — their
policy-driven assignments. Nothing new is stored; the context is read
off what the substrate already holds.

**Scope — Interego passes through to what composes it.** A Foxxi user
is an Interego user — Foxxi is one vertical composing the substrate, not
a thing apart from it. So the *default* scope is `interego`: the
assembly also discovers Context Descriptors across the wider substrate
(`@interego/core`'s `discover()` over the pod's published manifest) and
folds them in alongside the Foxxi content — the same retrieval runs over
everything. `scope: "vertical"` narrows the ask to the Foxxi slice (the
vertical's intersection with Interego). The two are the composition
algebra made literal: `interego` is the union; `vertical` is a
restriction of it. A vertical-scoped no-match tells the user to widen.
The whole, not the sum of verticals — the whole, passed through to each
part.

**Content questions delegate to the existing agentic RAG.** This module
does not reinvent retrieval. Content questions (`concept` / `procedure`
/ `general`) are answered by the vertical's `agentic-rag.ts` —
concept-graph retrieval, prereq-edge expansion, LLM synthesis, and the
modal-statused Interego trace (question Asserted → retrieval Hypothetical
→ LLM Hypothetical → cited-answer Asserted). The networked context's
published courses + job aids are adapted into the `FoxxiAgenticCourse`
shape that module already consumes — a third adapter alongside its
existing `payloadToAgenticCourse` + `courseContentToAgenticCourse`.
With an LLM key — the bridge's `FOXXI_LLM_API_KEY`, or per-request
BYOK — the answer is synthesised; without one it falls back to
`retrieveCourseContext`, the retrieval scaffold the *calling agent's own
LLM subscription* synthesises from. Either way the answer is sourced:
cited slides carry the descriptor id + the `course › lesson` provenance.
A question no concept matches gets an honest no-match *before* any LLM
call — it says "I won't guess."

**Human / agent symmetry.** The asker's *kind* is recorded, never
branched on. A human and an agent asking the same question get the
identical grounded *retrieval* — the same cited sources (only the LLM's
prose varies). That is the same symmetry `emergent-content.ts` relies
on: humans and agents are the same kind of user of the same substrate.

The ask itself is instrumented into the LRS as an xAPI `interacted`
statement — so the conversation joins the networked context's own trace
graph.

## 3. Development

Built and deployed:

- `src/context-chat.ts` — the intent classifier, the `scope` toggle, the
  networked-context assembler, the `Course` / job-aid / discovered-
  descriptor → `FoxxiAgenticCourse` adapters, the per-intent answer
  composers (content questions delegating to `askAgenticRag` /
  `retrieveCourseContext`), and `attachContextChatRoutes` —
  `POST /content/ask`.
- `src/content-delivery.ts` — the published-course registry retains the
  source emergent `Course`; the job-aid registry is exposed; and
  `POST /content/deliver` now actually transports (§6).
- `src/content-transport.ts` — the channel transports: a real webhook
  POST, and the Interego-native pod-descriptor publish (§6).
- Wired into the bridge: `attachContextChatRoutes` with `emitStatement`
  bound to the LRS, `resolveAssignments` (policy-driven assignments),
  the `FOXXI_LLM_API_KEY` + per-IP rate limiter, `discoverInteregoContext`
  (federated `discover()` over the tenant pod + `FOXXI_FEDERATION_PODS`),
  and `verifyCaller` (the session-token gate); `attachContentDeliveryRoutes`
  with the channel-transport config.

Verified before deploy by three local smokes: `context-chat-smoke.ts`
(52/52 — intent classification, grounded + sourced answers, the
agentic-RAG trace, the honest no-match, the `scope` toggle, the
deep-fetch, `mergeDiscovered` federation dedup, and the auth gate),
`content-transport-smoke.ts` (9/9 — the webhook transport against a
live HTTP sink, and the honest `none` path), and `content-pipeline-smoke.ts`
(16/16 — the generator + delivery round-trips).

## 4. Verification — in production

`tools/ask-your-context-example.mjs` runs the whole thing against the
live bridge, LMS and LRS, with a **real headless browser** completing a
**real generated course** so the chat has genuine progress to read —
24/24:

1. **Publish** — a course + a job aid into the networked context.
2. **Ask a concept question** (open) — answered by the vertical's
   agentic RAG: an LLM-synthesised answer grounded in the cited course
   content, with the cited source holding the verbatim fragment and the
   modal-statused Interego trace attached.
3. **Ask a procedure question** — the agentic RAG answers, sourced from
   the job aid.
4. **Ask "do I have any courses assigned to me?"** — *gated*: rejected
   `401` with no token; allowed with a wallet-signed token, the answer
   bound to the verified identity (§6).
5. **Complete** — a real Chromium browser launches and completes the
   course's AUs on the LMS; the xAPI lands in the live LRS.
6. **Ask "what's my progress?"** — gated; grounded in the learner's
   live LRS activity.
7. **Ask as an agent** — the identical question returns the identical
   grounded retrieval (same cited sources); only the asker kind differs.
8. **Ask at each scope, across the federation** — `vertical` reaches
   only the Foxxi slice; `interego` federates across the tenant pod and
   the federation peer pod, discovers and deep-fetches a peer-pod course
   ("Incident Response Basics") the vertical never had, and answers from
   it (§6).
9. **Deliver to the `document` channel** — the rendering is published to
   the pod as a discoverable `foxxi:DeliveredContent` Context Descriptor,
   dereferenceable back (§6).
10. **Ask an off-topic question** — an honest no-match: it refuses to
    guess.
11. **Verify** — every ask is in the live LRS as an xAPI `interacted`
    statement carrying the question it answered.

So any human or agent user genuinely just chats — "what does this
mean?", "do I have courses assigned?", "what's my progress?" — and the
networked context answers, routed to the right surface, gated where the
answer is the user's own record, federated across the substrate, sourced
from real content, and never guessing.

## 5. Honest scope

The companion is composition, not new machinery: content answering *is*
the vertical's existing agentic RAG (`agentic-rag.ts`), the same engine
behind `foxxi.ask_course_question_agentic`. It runs in two modes, both
pre-existing: with an LLM key (`FOXXI_LLM_API_KEY` or per-request BYOK)
the bridge synthesises the answer; with no key, `retrieveCourseContext`
returns the retrieval scaffold and the calling agent's own subscription
synthesises. Retrieval is deterministic either way — only the synthesis
varies — so the substrate's human/agent symmetry shows up as identical
cited sources for the same question. What this module adds is the front
door: intent routing + networked-context assembly + the adapters that
let the agentic RAG run over emergent courses and job aids, not just
parsed SCORM payloads.

The `scope: "interego"` pass-through discovers the Context Descriptors
on the pod's published manifest. A discovered **course package** is
fetched in full — composing `fetchCoursePackage` + `payloadToAgenticCourse`,
both already in the vertical — so the companion answers from its *actual
content*, not just its descriptor. Other descriptors (policies, audit
streams, tenant config) are surfaced at the metadata level: you see,
cite, and can follow each; deep Q&A inside one of those is a single
follow-the-link hop.

## 6. Closing the honest-scope gaps

The §5 above once named three things as genuine-but-deferred work.
They are now built, deployed and verified.

**The auth gate.** A progress or assignment question is about a
learner's own record — PII. `POST /content/ask` now gates those two
intents behind the same wallet-signed session token the rest of the
bridge verifies (`verifySessionToken` against the tenant directory).
The effective learner is **bound to the verified identity** — you may
ask about your own record, never someone else's; an admin may ask about
anyone. Content, procedure and catalog questions are over published
content and stay open. Verified in production: the assignment question
is rejected `401` without a token and answered with one, bound to the
caller.

**Federated discovery.** `scope: "interego"` no longer discovers only
the tenant pod. It federates across the tenant pod **and** every pod in
`FOXXI_FEDERATION_PODS`, merged + deduped by descriptor URL
(`mergeDiscovered`, first-publisher-wins), each descriptor tagged with
its origin pod. Verified in production against a real federation peer
pod carrying a course — "Incident Response Basics" — the tenant pod
does not have: the interego scope discovers it, deep-fetches it, and
answers from it; the vertical scope does not reach it.

**Channel transport.** `POST /content/deliver` no longer just produces a
payload. `content-transport.ts` adds two real transports: a **webhook**
— a real HTTP POST, a Slack incoming webhook or an email/SMS provider
API, activating on `FOXXI_TRANSPORT_<CHANNEL>`; and the Interego-native
**pod-descriptor** publish — a `document` delivery is published to the
pod as a discoverable `foxxi:DeliveredContent` Context Descriptor. The
delivery becomes substrate — itself discoverable, federatable, and
answerable by the Context Companion — not a fire-and-forget send.
Verified: the webhook against a live HTTP endpoint (smoke); the
pod-descriptor publish in production (the delivery descriptor is
dereferenceable on the pod).

## 7. What now honestly remains

Media generation stays out — a deliberate boundary the user set: the
content is text. Channel transport's external sends (Slack / email /
SMS) are real adapters that activate when their endpoint is configured;
this deployment configures none, so those channels honestly report
`mode: "none"` until an operator wires a real endpoint. Auto-resolving a
user's *own* pod into the federation set (rather than a configured peer
list) is a refinement of the same `discover()` call. None of these is a
gap in the capability — each is either a deliberate boundary or an
operator-configuration step.

What honestly remains, named rather than hidden: **multi-pod / federated
discovery** — pointing `discover()` at a user's own pod and federated
peers, not only the configured tenant pod (the same call, more pods;
best built against a real federated deployment so it can be verified);
and the **session-token gate** above for a non-demo deployment. Live
channel transport and media generation are *not* further work on this
companion — they are deliberate boundaries: an operator-integration
concern, and a text-content-by-design choice. The deep-fetch of
discovered course packages, previously noted here as a next hop, is now
done.
