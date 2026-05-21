# Closing the Loop — analysis, design, development

This document records, as part of the Foxxi vertical, the full
analysis → design → development → delivery → evaluation process by which
the Performance & Knowledge Architecture was wired into the live
LMS / CMS / LRS so that generated content is actually produced,
delivered, completed, and recorded with real data.

It is deliberately reflexive: the process documented here — analyse the
gap, design the intervention, develop it, deliver it, evaluate whether
it closed the gap — *is* the lifecycle the Performance Architecture
itself runs (`diagnose` → `recommendInterventions` → compose →
publish/deliver → `evaluateIntervention`). The system was closed using
its own model.

---

## 1. Analysis — the gap

The honest finding before this work: the substrate and the architecture
both existed and worked **in isolation**, but the loop was not closed
with real flowing data.

- The LRS was a conformant xAPI 2.0 LRS; the LMS layers (cmi5 launch,
  SCORM runtime + sequencing, LTI, OneRoster) worked; the Performance &
  Knowledge Architecture computed diagnoses, plans, courses and
  knowledge maps live.
- But `composeCourse()` produced a *typed Course object*, not a
  deployable package. Nothing generated a cmi5 or SCORM artifact.
- A composed course was never registered or launched on the LMS — the
  content layer and the LMS layer were not connected.
- Performance aids produced descriptors; nothing delivered them or
  instrumented them.
- No learner had completed generated content; there was no
  generated-content data in the LRS log or any report.

Diagnosis (in the architecture's own terms): an **Evident-regime,
knowable gap** — the desired end state was fully specified and the cause
was a missing connection between built components. The intervention was
not "more architecture"; it was **development** — build the missing
links. Content *was* warranted, because the deficiency was genuinely a
missing capability of the system, needed every time.

## 2. Design

The design reuses everything already deployed and adds only the missing
links. All generated content is text.

**Generation — `src/content-package.ts`.** An emergent `Course` is
flattened (default paradigm cell at each position) into modules →
lessons, then turned into:

- a **cmi5 package** — a `cmi5.xml` course structure plus, per lesson,
  a runnable **Assignable Unit**: a self-contained HTML page that on
  load reads the cmi5 launch parameters from its own URL, exchanges the
  one-time fetch token for an auth-token, renders the lesson's text, and
  on completion emits the cmi5 xAPI statements straight to the LRS. An
  assessment-item lesson ("question ::: answer") is scored.
- a **SCORM 2004 package** — an `imsmanifest.xml` (with sequencing) plus
  one SCO per lesson, zipped — a real, conformant `.zip` artifact.

**Delivery — `src/content-delivery.ts`.** `POST /content/publish-course`
generates the package, **registers the course structure on the cmi5
LMS** (`registerCmi5Course`) so it is launchable, trackable, and rolls
up satisfaction, and stores the runnable artifacts. `GET /content/au/…`
serves a runnable AU; `GET /content/package/…` serves the cmi5.xml and
the SCORM `.zip`. Job aids are published (`POST /content/job-aid`) and a
learner view is instrumented into the LRS.

**Channels — `src/content-channels.ts`.** Because the content is text,
it is rendered for the channels work actually uses — a document
(markdown), an email, a chat message, an SMS. `POST /content/deliver`
renders a unit for a channel and logs the delivery to the LRS.

**Reuse.** A published cmi5 course is launched through the *existing*
`GET /cmi5/launch`; launch, the fetch handshake, moveOn evaluation,
satisfaction rollup, and the LRS were already built and deployed. This
work generates the package and registers it — nothing more was needed
on the LMS side.

## 3. Development

Built and deployed:

- `src/content-package.ts` — the cmi5 + SCORM generators and the
  runnable AU / SCO templates.
- `src/content-delivery.ts` — `POST /content/publish-course`,
  `GET /content/au/:pub/:idx`, `GET /content/package/:pub/{cmi5.xml,scorm.zip}`,
  `POST /content/job-aid`, `GET /content/job-aid/:id`,
  `POST /content/deliver`.
- `src/content-channels.ts` — the four channel renderers.
- Wired into the bridge with `emitStatement` bound to the LRS's internal
  statement store; `foxxi:` vocabulary extended (`deliveryChannel`,
  `recipient`).

Verified before deploy by `tools/content-pipeline-smoke.ts` (16/16): the
generators round-trip — the generated `cmi5.xml` re-parses as a cmi5
course, and the SCORM package's `imsmanifest.xml` re-parses through
Foxxi's own SCORM engine — and every delivery route works.

## 4. Verification — the closed loop, in production

`tools/closed-loop-example.mjs` runs the whole cycle against the live
bridge, LMS and LRS, with a **real headless browser** completing a
**real generated course** — 14/14:

1. **Analyse** — a refund-dispute performance gap is diagnosed; the plan
   warrants instruction.
2. **Design** — an emergent course is composed (`/content/compose-course`).
3. **Develop** — it is published: a cmi5 package + a SCORM `.zip` are
   generated and the course is registered on the cmi5 LMS; both
   artifacts are downloadable.
4. **Deliver** — an AU is launched (`/cmi5/launch`); a Chromium browser
   opens the launch URL, the generated AU does the cmi5 handshake, the
   learner completes it, and the AU emits cmi5 xAPI to the LRS — with no
   page errors.
5. **Verify** — the cmi5 registration reports `satisfied = true` (moveOn
   fired); the **live LRS holds five statements** for that registration
   — `initialized`, `completed`, `passed`, `terminated`, and the
   LMS-emitted `satisfied`. A job aid is published and channel-delivered
   on all four channels, each instrumented into the LRS.
6. **Evaluate** — the four-level evaluation returns `closed`: the
   measured new state supersedes the prior observed state.

So a diagnosed gap genuinely produces a real, SCORM/cmi5-compliant
training course, delivered and tracked on the live LMS; a learner
genuinely completes it; the xAPI statements are genuinely in the live
LRS log; performance support genuinely reaches text channels with every
delivery instrumented; and the gap's evaluation genuinely closes. The
loop is closed.

## 5. Honest scope

The content is text — fragment bodies rendered as readable text in the
AU / SCO / channel payloads. No media is generated. Channel *transport*
(actually sending to a specific Slack workspace, mailbox, or phone
number) is an operator/integration concern: `POST /content/deliver`
produces the channel-ready payload and records the delivery; wiring a
specific live transport is a bounded, separate step. The cmi5 path is
the fully wired, browser-verified completion loop; the SCORM `.zip` is a
generated, round-trip-validated artifact.
