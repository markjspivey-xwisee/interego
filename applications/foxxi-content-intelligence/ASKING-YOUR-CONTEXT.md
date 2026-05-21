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
any user (human or agent) and answers it. Four design decisions:

**Intent classification.** A deterministic, keyword-routed classifier
maps the question to one of six intents — `assignments`, `progress`,
`concept`, `procedure`, `catalog`, `general` — so the right surface
answers it. "Do I have any courses assigned to me?" routes to the
assignment surface; "what does this mean?" routes to the content.

**Networked-context assembly.** For each ask, the asker's networked
context is assembled from the substrate's *own* surfaces: the
published-course registry (its emergent `Course`s, retained so their
fragments carry full provenance), the job-aid registry, the live LRS
(the learner's xAPI activity), and — when the tenant directory is
seeded — their policy-driven assignments. Nothing new is stored; the
context is read off what the substrate already holds.

**Sourced answers, never confabulated.** Content answers are grounded by
term overlap against the actual fragment bodies. Every answer quotes the
**verbatim** fragment and carries a `GroundedSource` — the descriptor
IRI plus the `course › module › lesson` provenance trail. A question
nothing in the networked context covers gets an honest no-match
(`grounded: false`, no sources) — the same discipline `course-qa.ts`
borrows from LPC's grounded-answer. It says "I won't guess."

**Human / agent symmetry.** The asker's *kind* is recorded, never
branched on. A human and an agent asking the same question get the
identical grounded answer. That is the same symmetry `emergent-content.ts`
relies on: humans and agents are the same kind of user of the same
substrate.

The ask itself is instrumented into the LRS as an xAPI `interacted`
statement — so the conversation joins the networked context's own trace
graph.

## 3. Development

Built and deployed:

- `src/context-chat.ts` — the intent classifier, the term-overlap
  grounded retrieval, the per-intent answer composers, the
  networked-context assembler, and `attachContextChatRoutes` —
  `POST /content/ask`.
- `src/content-delivery.ts` — the published-course registry now retains
  the source emergent `Course` (so the companion can ground in its
  fragments with provenance) and exposes the job-aid registry.
- Wired into the bridge: `attachContextChatRoutes` with `emitStatement`
  bound to the LRS, and a `resolveAssignments` resolver that reads the
  tenant directory for policy-driven assignments when the pod is seeded.

Verified before deploy by `tools/context-chat-smoke.ts` (35/35): intent
classification, the grounded + sourced answers, the honest no-match, and
the `POST /content/ask` route over a throwaway app — a course + job aid
published, then asked about, every content answer checked to cite a real
source.

## 4. Verification — in production

`tools/ask-your-context-example.mjs` runs the whole thing against the
live bridge, LMS and LRS, with a **real headless browser** completing a
**real generated course** so the chat has genuine progress to read —
22/22:

1. **Publish** — a course + a job aid into the networked context.
2. **Ask "what does the refund authority threshold mean?"** — a
   concept-routed answer, grounded, quoting the verbatim fragment with
   its `course › module › lesson` provenance.
3. **Ask "how do I handle a refund over $500?"** — a procedure-routed
   answer, sourced from the job aid.
4. **Ask "do I have any courses assigned to me?"** — the assignment
   surface answers.
5. **Complete** — a real Chromium browser launches and completes the
   course's AUs on the LMS; the xAPI lands in the live LRS.
6. **Ask "what's my progress?"** — now grounded in the learner's live
   LRS activity.
7. **Ask as an agent** — the identical question returns the identical
   grounded answer; only the recorded asker kind differs.
8. **Ask an off-topic question** — an honest no-match: it refuses to
   guess.
9. **Verify** — every ask is in the live LRS as an xAPI `interacted`
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

Retrieval is deterministic term overlap, not an LLM. That is a
deliberate choice: the answer *is* the sourced content, so it is
verifiable and auditable, and the companion works with no API key. The
LLM-backed path still exists — `agentic-rag.ts` / `foxxi.ask_course_question_agentic`
synthesises multi-turn answers over course payloads — and the two
compose: this front door routes and grounds; the agentic path
synthesises when a synthesised answer is wanted.

`POST /content/ask` is open in this deployment so the demo is
self-contained. In production, progress and assignment questions about a
specific learner should be gated behind the same wallet-signed session
token `foxxi.discover_assigned_courses` already uses; concept, procedure
and catalog questions over published content need no gate. Wiring that
gate is a bounded, separate step.
