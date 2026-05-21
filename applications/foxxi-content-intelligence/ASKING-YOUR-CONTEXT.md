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
- `src/content-delivery.ts` — the published-course registry now retains
  the source emergent `Course` (so the companion can retrieve over it)
  and exposes the job-aid registry.
- Wired into the bridge: `attachContextChatRoutes` with `emitStatement`
  bound to the LRS, a `resolveAssignments` resolver that reads the
  tenant directory for policy-driven assignments, the same
  `FOXXI_LLM_API_KEY` + per-IP rate limiter the agentic-ask MCP handler
  uses, and a `discoverInteregoContext` resolver that composes
  `@interego/core`'s `discover()` over the pod manifest — the substrate
  pass-through for `scope: "interego"`.

Verified before deploy by `tools/context-chat-smoke.ts` (41/41): intent
classification, the grounded + sourced answers, the agentic-RAG trace,
the honest no-match, the `scope` toggle (interego pass-through vs
vertical narrowing), and the `POST /content/ask` route over a throwaway
app.

## 4. Verification — in production

`tools/ask-your-context-example.mjs` runs the whole thing against the
live bridge, LMS and LRS, with a **real headless browser** completing a
**real generated course** so the chat has genuine progress to read —
28/28:

1. **Publish** — a course + a job aid into the networked context.
2. **Ask "what does the refund authority threshold mean?"** — answered
   by the vertical's agentic RAG: an LLM-synthesised answer
   (`claude-opus-4-7`, the bridge key) grounded in the cited course
   content, carrying the modal-statused Interego trace, with the cited
   source holding the verbatim fragment.
3. **Ask "how do I handle a refund over $500?"** — the agentic RAG
   answers, sourced from the job aid.
4. **Ask "do I have any courses assigned to me?"** — the assignment
   surface answers.
5. **Complete** — a real Chromium browser launches and completes the
   course's AUs on the LMS; the xAPI lands in the live LRS.
6. **Ask "what's my progress?"** — now grounded in the learner's live
   LRS activity.
7. **Ask as an agent** — the identical question returns the identical
   grounded retrieval (same cited sources); only the asker kind differs.
8. **Ask the same question at each scope** — `scope: "vertical"` finds
   nothing about "golf" (it's not in the Foxxi vertical); `scope:
   "interego"` passes through to the substrate, discovers the
   `course:golf-explained` Context Descriptor on the pod, and surfaces
   it. The pass-through reaches what the vertical alone never saw.
9. **Ask an off-topic question** — an honest no-match: it refuses to
   guess.
10. **Verify** — every ask is in the live LRS as an xAPI `interacted`
    statement carrying the question it answered.

So any human or agent user genuinely just chats — "what does this
mean?", "do I have courses assigned?", "what's my progress?" — and the
networked context answers, routed to the right surface, sourced from its
own content, grounded in live LRS data, and never guessing. In the
production run the progress answer read back, verbatim from the live
LRS, "You've completed 1 course … your learning record holds 15
statements (initialized, completed, passed, terminated, interacted,
satisfied)" — the chat reflecting real, recorded activity.

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
on the pod's published manifest — it *surfaces* them (you see, cite, and
can follow each one). Deep Q&A *inside* a discovered descriptor's graph
is the next hop: follow the link, fetch the graph. The pass-through is
honest about that — it answers at the descriptor level ("your wider
context holds X, at this IRI") and hands you the link. Today it
discovers over the configured tenant pod; discovering across a user's
own pod + federated pods is the same `discover()` call pointed at more
pods — a bounded extension.

`POST /content/ask` is open in this deployment so the demo is
self-contained, and the LLM-synthesis path on the bridge key reuses the
same per-IP rate limiter the agentic-ask MCP handler already has. In
production, progress and assignment questions about a specific learner
should be gated behind the same wallet-signed session token
`foxxi.discover_assigned_courses` already uses; content questions over
published content need no gate. Wiring that gate is a bounded, separate
step.
