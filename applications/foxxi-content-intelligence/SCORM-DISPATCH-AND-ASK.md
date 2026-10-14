# Dispatch, other LMSs' launches, and asking a course — analysis, design, development, verification

This document records, as part of the Foxxi vertical, how three things were added together:

- **Dispatch.** A course authored on the bridge plays inside another organization's LMS, through a
  stub package that holds none of the course.
- **Other LMSs' launches.** An LTI 1.3 launch from another registered LMS plays a course in the
  bridge's SCORM engine, and the grade goes back to that LMS.
- **Asking a course.** A question about a course is answered from the course and the I2IDL Digital
  Learning Glossary, decorated with I2IDL-X.

It is Layer 3, vertical: no protocol term is added, and the I2IDL and I2IDL-X vocabularies are read,
not extended.

---

## 1. Analysis

Foxxi already had each piece a learning platform needs: an xAPI 2.0 LRS, a SCORM 2004 sequencing
engine that grades from hashed answers, an LTI 1.3 Tool and Platform, a cmi5 LMS, hosting for
uploaded packages, and a composition package that frames the bridge's player from inside an LMS.
What it lacked were three crossings between them and the systems an organization already runs.

1. **A course authored here could reach another LMS only as a full copy.** The SCORM export
   (`scorm-artifacts.ts`) carries the content and its answer hashes. Once imported, it no longer
   changes when the author changes it, and nothing can withdraw it.
2. **Another LMS's launch went to the dashboard.** `startLtiPlay` played only the bridge's own
   LMS's launches, because only that LMS checked the learner's signature and so only its launches
   name a pod to record to. A course assigned in Canvas or Moodle could not be played and graded
   back there.
3. **A course could not be asked about.** The course ask surfaces (`/agent/course/ask`,
   `/content/ask`) serve the package-analysis model and the Context Companion; an agent-authored
   SCORM course had no ask at all, and nothing in the vertical read the I2IDL glossary, though
   I2IDL-X (this vertical's decoration of it) publishes signed graphs about every concept.

In the vertical's own terms each gap is Evident: the end state is clear and the cause is a missing
connection. The intervention is development.

## 2. Design

### Dispatch

The **stub** is one SCO with no content. It finds the LMS's SCORM API (`API_1484_11` for 2004,
`API` for 1.2), opens the course on the bridge in a frame, and writes what the bridge reports
through that API. The course stays on the bridge, so an author edits it once, and a dispatch the
author withdraws, lets expire or caps stops every copy of the stub.

Choices, and why:

- **The LMS keeps the learner's record.** The stub never sends the bridge the LMS's learner id. An
  LMS learner id is a name the bridge cannot verify, so, as with the composition package, nothing
  is recorded here in anyone's name. The engine plays a dispatched attempt with
  `keptBy: 'launching-lms'`, which skips `recordScormCompletion`. The author sees counts —
  launches, completions, passes — and nothing about who.
- **Each side believes only the other.** The stub records a message only from the bridge's origin,
  fixed into the package. It tells the bridge its own origin, and the bridge posts each page's
  report only to that origin, and to none when the value is not a bare `http(s)` origin.
- **SCORM's data model, per version.** 2004: `cmi.score.raw/min/max/scaled`, `success_status`,
  `completion_status`, `exit`, `session_time` as an ISO duration, and interactions of type `other`
  with `learner_response`. 1.2: `cmi.core.score.*`, `lesson_status` (passed / failed, or completed
  when nothing is graded), `cmi.core.exit`, `cmi.core.session_time` as `HHHH:MM:SS`, and
  interactions of type `performance` with `student_response` and `wrong`. An LMS that does not
  keep interactions does not stop the attempt.
- **The passing score.** The course's mastery score goes into the manifest (2004: the primary
  objective's `minNormalizedMeasure`; 1.2: `adlcp:masteryscore`). An LMS administrator may change
  it there, and the stub grades against theirs; with none, the engine's rollup decides.
- **Resume.** The stub keeps the bridge's attempt address in `suspend_data`, and sets `exit` to
  `suspend` when the learner leaves mid-way, so the next launch resumes the attempt while it lasts.
- **Each answer is reported once.** The bridge reports a step's answers with the page that follows
  it, then forgets them, so a reloaded page does not add interactions twice.
- **The registry never evicts.** A dispatch is a promise to another organization. A full registry,
  or an author holding a thousand, refuses a new dispatch rather than dropping an old one. It is
  kept on the tenant pod beside `course-authors.json`, merged (larger counts, earlier withdrawal)
  with the durable copy before each write, and re-read when a dispatch is not in the process.
- **Limits sized for learners.** One organization's learners can share an address, so launches and
  asks have their own per-address windows (120 and 60 a minute), not the agentic limit, which
  guards model calls and allows ten per five minutes.

### Other LMSs' launches

A registered platform's resource link that names a course (custom `foxxi_course_id`) plays it in
the engine. The learner is the account the platform signed for: its issuer and `sub`, as an xAPI
account. The outcome is kept in the Tool's LRS (the operator's store) under that account, and the
grade goes to the platform's gradebook over AGS. The learner has no pod here, so no lattice holds
the outcome (`keptBy: 'tool-lrs'`), and another platform's `foxxi_learner_pod` claim is not read:
only the bridge's own LMS vouches for a pod. The attempt's engine session is keyed by issuer and
`sub` together, so two platforms' learners never share one. A launch that names no course keeps the
dashboard hand-off.

### Asking a course

`askCourse` assembles an answer; it does not generate one. It finds the I2IDL terms the question
names with I2IDL-X's surface forms (labels; "Label (ACR)" split; alternate labels; shared forms to
the concept whose own label carries them; short acronyms by case; longest first, no overlap), what
I2IDL says each means, where the course covers it, and the sections whose words overlap the
question's (words a term already accounts for are not counted again). Every field carries its
origin, in I2IDL-X's what's-whose:

| Field | Origin |
|---|---|
| Label, definition, sources and their rights | I2IDL |
| "Direct source definition" / "I2IDL synthesis supported by source evidence"; the reuse class | I2IDL-X · derived |
| Referent category; enactment (the Foxxi capability that realizes, operationalizes or measures the concept) | I2IDL-X · proposed, Hypothetical |
| Section and snippet | the course's author |

**Rights decide what is quoted.** A definition that rests directly on a source that is
non-commercial or used by I2IDL with permission is not quoted: the answer names the concept, links
I2IDL's card, and says why. I2IDL's own syntheses (CC BY 4.0) and openly licensed sources are
quoted with attribution to the release.

An answer never reads an assessment. The glossary and I2IDL-X's referents and enactments are read
from their published locations (I2IDL's JSON-LD, the relay's expanded JSON-LD), cached for a day;
when I2IDL-X cannot be read the answer carries I2IDL's record alone, and when I2IDL cannot be read
it comes from the course alone and says so.

## 3. Development

| Piece | Where |
|---|---|
| Glossary reader, I2IDL-X layer reader, surface-form matcher, daily loader | `src/i2idl-glossary.ts` |
| The assembled answer | `src/course-ask.ts` |
| Dispatch registry, stub manifest (2004 and 1.2), stub SCO, zip, routes | `src/scorm-dispatch.ts` |
| Engine adapter, registry persistence, `POST /agent/scorm/ask`, external launches | `bridge/server.ts` |
| Pages take a crumb, trailing markup, and where a record is kept | `src/lti-player.ts` |
| Affordances: `foxxi.scorm_course_ask`, `foxxi.scorm_dispatch`, `foxxi.scorm_dispatch_revoke`, `foxxi.scorm_dispatches` | `affordances.ts` |
| The affordance gate reads the dispatch route module | `tools/check-foxxi-affordances.mjs` |

## 4. Verification

- `tests/i2idl-glossary.test.ts`: the release read as published, provenance wording, reuse classes,
  surface forms and the shared-form rule, the I2IDL-X layers whether types are written as `@type`
  or `rdf:type`, and the loader's day cache and failure backoff.
- `tests/course-ask.test.ts`: quoting and withholding by rights, origins per field, Hypothetical
  layers, the course-only answer, determinism, and that no assessment is read.
- `tests/scorm-dispatch.test.ts`: the registry's states, merging and bounds; both manifests (2004
  parsed by the engine's own manifest reader); the stub in both versions against a fake LMS API
  (interactions, outcome, passing score, resume, suspend, an LMS without interactions, foreign
  origins, an author's title that looks like markup); and the routes over HTTP on the same express
  major and JSON parser the bridge's app uses.
- `tests/lti-player.test.ts`: the external-launch and dispatch wiring in `bridge/server.ts`.
- **Live, locally.** The bridge was run and driven over HTTP with signed requests: a course
  authored, dispatched, both packages downloaded, launched, played, asked about, listed and
  withdrawn. In Chromium, each package was imported into a fake LMS on a second origin and played
  through the bridge's frame; the LMS's API ended with the score, success, completion, both
  interactions and the session time, in each version's data model. A second LTI Platform on its
  own origin launched a course on the bridge as its own learner; the statements in the LRS name
  that platform's issuer and `sub`, and the line item reached AGS (the local platform was `http`,
  which the Tool's guard refuses for a grade; a real LMS is `https`).

Two faults were found by running it live and fixed before the tests were written to catch them:
the play route parsed JSON a second time, which fails when the app's parser comes from a different
body-parser major (the shared vertical bridge runs Express 5, the vertical Express 4); and the
first draft rate-limited learners' launches with the agentic limit.

## 5. What is not done

- The stub needs the LMS to allow a frame to the bridge's origin (the README in each package says
  so). An LMS that forbids frames needs the course hosted inside it instead.
- A dispatched attempt is not in any xAPI record on the bridge, by design. An organization that
  wants one can forward its LMS's own records to the LRS with its credentials.
- I2IDL-X's own build stays in Python (`i2idlx/`); this reads what it publishes. Porting the build
  is separate work.
