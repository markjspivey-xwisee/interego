# Foxxi Performance & Knowledge Architecture

A content-management, training-generation, performance-support and
knowledge-management system for humans **and** agents — in which a
diagnosis decides whether content is even the answer, content is an
emergent composition rather than an authored artifact, knowledge is
mapped honestly into what can and cannot become content, and the same
authoring tools serve a human instructional designer and an agent
author identically.

This is the "how could all of that look" account. The running code is
`src/performance-architecture.ts`, `src/emergent-content.ts` and
`src/knowledge-architecture.ts`; the proofs are
`tools/performance-architecture-example.mjs` (27/27) and
`tools/knowledge-architecture-example.mjs` (14/14); the live surface is
`GET /performance` and `GET /knowledge`.

This synthesis — its model, vocabulary and composition — is the
project's own. It is informed by established work in performance
improvement, instructional design, knowledge management, complexity-
aware management and causal reasoning, but it does not adopt or depend
on any one external framework. See `SOURCES-AND-ATTRIBUTION.md`.

---

## 1. The first principle — performance is the unit, not content

A traditional LMS / LXP / CMS starts with content: here is a course;
assign it, deliver it, track it. Foxxi starts one step earlier, with a
**PerformanceSituation** — a typed context descriptor of a performer
(human or agent), the work they are doing, what is observed, how often
the task occurs, and how critical it is. Note what it does *not* carry:
an idealised future state. A situation is not a gap. It carries a
**modal status**: a reported situation is `Hypothetical` until measured;
an assessment promotes it to `Asserted`.

Content is never assumed. It is one possible *intervention*, selected —
or ruled out — by the regime-appropriate method.

> The question — *"does an agent decide instruction needs to be
> developed, or assessments, or contextual in-the-flow performance
> support?"* — is exactly the contextualize → intervention-selection
> decision. The system's answer is an **InterventionPlan**, and it is
> genuinely varied: across the seven demo scenarios, half the situations
> route to *non-content* interventions.

## 2. The first move — contextualize: the regime chooses the method

The system does **not** begin by idealising a future state and naming a
gap to it. Idealising an exemplary state, identifying the gap to
observed performance, and closing that gap is the method of **one**
causality regime — the Knowable regime — not a universal frame. Where
work is a complex, adaptive system — a team of agents adapting to
open-ended work — there is no exemplary state to close toward; there are
only dispositions, propensities and a direction of drift.

So the universal first step is to **contextualize**: read the **work
regime** — how knowable the relationship between act and outcome is —
and only then route to that regime's method:

| Work regime | Method | What it produces |
|---|---|---|
| **Evident** — act→outcome is self-evident | apply the established practice | recognise the situation, apply the known response |
| **Knowable** — act→outcome is discoverable by expertise | gap analysis (cause-factor + the discriminating question) | an exemplary state, a root cause, a selected intervention |
| **Emergent** — act→outcome coheres only in retrospect | a dispositional read (composes `agent-disposition.ts`) | a disposition, a vector, safe-to-fail probes |
| **Turbulent** — no stable act→outcome yet | stabilise first, then re-contextualize | a decisive act, not a plan |

Only the Knowable row names a gap. `agent-disposition.ts` already
refuses the gap frame for complex agent teams — the Performance
Architecture **routes to it** rather than contradicting it.

## 3. Contextualizing — and, for Knowable work, the cause analysis

`diagnose()` is the contextualizing function: it reads the regime first,
then applies that regime's method.

For **Knowable** work — and only there — it builds a **six-factor cause
analysis** — three environmental factors (Information, Instrumentation,
Incentives) and three individual factors (Knowledge & Skill, Capacity,
Motives) — and applies the **discriminating question**: could the
performer perform correctly under ideal conditions (full motivation, no
obstacles)? If yes, it is *not* a skill deficiency, and instruction is
the wrong intervention. The environmental factors are examined first
because, in practice, they account for the majority of performance gaps
and are cheaper to fix than re-skilling people. The exemplary state is
established here, as an input to this analysis — nowhere else.

For **Evident** work, the response is self-evident; `diagnose()` returns
the established practice with no cause analysis. For **Emergent** work,
it composes `agent-disposition.assessDisposition()` and returns a
disposition + vector + stance, with an explicit caveat that there is no
exemplary state and no gap. For **Turbulent** work, it calls for
stabilising first.

## 4. The intervention paradigm

The output of diagnosis is an **InterventionPlan** — the full *paradigm*
of interventions, each marked selected or ruled-out with its reasoning:

- **instruction** — curriculum / course / module / lesson; for a genuine
  skill gap in a *frequent* task that must be held in memory.
- **performance-support** — a job aid; the *same* skill gap in a *rare*
  task, delivered in the flow of work (no need to memorise).
- **reference** — searchable knowledge; looked up, not "trained".
- **practice** — deliberate practice; the skill exists but fluency
  has decayed.
- **assessment** — verifies a `Hypothetical` gap before money is spent.
- **coaching** — a feedback loop; motivation, transfer, the Emergent
  regime.
- **probe** — a safe-to-fail constraint probe; the Emergent regime.
- **environmental-fix** — tools, information, incentives; *not a content
  deliverable at all*.
- **no-intervention** — the gap is acceptable variance or self-resolving.

Selecting one is a **paradigmatic operation**: the intervention space is
a paradigm set, the diagnosis supplies the constraints, the selected
intervention is the surviving cell. Instruction is one cell of nine.

## 5. Content as emergent composition

When content *is* warranted, it is not authored as a monolith. It is an
emergent composition:

```
curriculum = a syntagm of courses     (toward a set of competencies)
course     = a syntagm of modules
module     = a syntagm of lessons
lesson     = a syntagm of grounding fragments   (PGSL-atom content)
```

Every level is a **syntagm** — an ordered chain. Every *position* holds
a **paradigm** — the interchangeable alternatives for that competency-
point (a concept told as text, as a worked example, as a simulation).

**Personalisation is the substrate's composition algebra, made
concrete.** `personalize(course, performer)` produces a `ResolvedCourse`
by two operations: **restriction** drops positions whose competency-point
the performer has mastered; **override** collapses each remaining
paradigm to the cell that suits the performer's disposition. The `Course`
is never mutated — a novice and a partially-skilled performer receive
different resolved courses from the *identical* fragments. The course is
a recipe, not a record. That is the emergentism: there is no "course
table"; a course is a composition over content-addressed fragments.

### Fragments and compositions as data

[`src/content-fragments.ts`](src/content-fragments.ts) and
[`src/compositions.ts`](src/compositions.ts) make the recipe data that can
be stored, fetched and checked. They work the same for a person and for an
agent, as learner and as author.

- **A fragment's IRI is the hash of its content**
  (`/ns/foxxi/fragment/<sha256>`), taken with competencies by id rather
  than by this deployment's URLs.
  - It names the same content on every bridge.
  - A copy fetched from any pod is checked by hashing it again
    (`fragmentIsIntact`).
  - What a learner is shown under an IRI they already hold cannot change.
  - Its body is Markdown, which an agent reads as it is and a person reads
    rendered.
  - Its questions are the xAPI interaction types, stored with verifiers
    and never with answers. The hash takes each question as its public
    view plus a commitment (the hash of the stored question), so the
    public form (`publicFragment`) can be served to anyone, without a salt
    or verifier, and still be checked against the IRI
    (`publicFragmentIsIntact`). A fragment with a graded question also
    carries a random blinding value, stored and never served, that goes
    into every salt and commitment. Without it, a learner could rebuild
    the stored question for each answer they might try and see whose
    commitment matches. So the same quiz authored twice is two fragments,
    and a stored form sent back keeps its IRI.
  - Its kind says what form it takes: concept, worked example, job aid,
    reference, assessment item, practice task, context, and the forms of
    emergent work, `probe` and `reflection`. Those two take no graded
    question, because such work has no right answer yet.
- **A composition is one type at every size.** Each position names a
  competency and the alternatives that can fill it: fragments or other
  compositions, by reference. Its IRI hashes its content too, and a
  revision names what it `supersedes`. The fragments it shares with the old
  version are the same fragments, so the evidence gathered on them still
  counts.
- **`resolveComposition` is personalisation applied to evidence:**
  - *Restriction* skips a position only when the learner has
    *demonstrated* it: an Asserted competency on their record at the
    position's rank. A training-only inference is Hypothetical and skips
    nothing.
  - *Admission* keeps only the forms said to suit the competency.
  - *Choice* takes the alternative pitched nearest the learner's level.
    Among fragments pitched equally near, it takes what has worked there
    for learners at that level (below), and otherwise the author's order.
    A nested composition is chosen only if it
    resolves; one that leaves positions unmet falls back to the next
    alternative, and the reason says why the branch fell short. Nested
    resolutions are remembered per composition, so the work stays
    proportional to the number of compositions, not paths. One resolution
    holds at most 2,000 positions. A composition can reach the same
    module from many positions, so what it resolves to can grow faster than
    what it lists.
  - Whatever a pod or cache serves for an alternative is used only if it
    hashes to the IRI that was asked for. Changed content is refused and
    traced, and the refusal is listed in the resolution's `refused`,
    including when it was found inside a branch that was fallen back from.
    A cycle would need a composition to contain its own hash, which
    content addressing rules out.
  - Every position's outcome is traced in words.
- **Which forms suit a competency is this practice's call, made from
  published data.** Each intervention method in `agp-methods.ttl` names the
  forms that deliver it (`agp:contentFormToken`).
  `admissionFromPlan` (agentic-performance-practice) reads a plan through
  that data, so:

  | Regime | The plan selects | The resolution gives |
  |---|---|---|
  | Emergent | probe and coaching | probes and reflection, never a lesson |
  | Turbulent | an environmental fix | no content, and it says content is not the answer |
  | Evident | reference | the procedure to look up |
  | Knowable, not yet measured | assessment | a check before any teaching |

  The dependency runs from the practice to Foxxi, never back.
- **The learner keeps an admission; the bridge only reads it**
  ([`src/admission-records.ts`](src/admission-records.ts)).
  - A plan made with `contextualize_and_plan` offers the admission it
    implies at the situation's competency (`admissionOffer`). Nothing is
    written onto anyone's record from it.
  - **Work that fails is answered unasked**
    (`offerFromWork`, agentic-performance-practice `src/work-offers.ts`).
    A performer who records their own work
    (`foxxi.record_performance_signed`) can send how it went with it, as a
    trajectory. The trajectory is kept in the work's own statement, on
    their pod (`PERF_EXT.workTrajectory`). When a unit fails:
    - The work recorded at its competency is read back, the latest units
      first, by the rule the learner record counts it (`workAt`).
    - Its regime is read from the trajectories kept with that work, and
      from those the performer recorded apart from it: through
      `foxxi.record_agent_trajectory`, or as steps published to their own
      pod, as the mesh sweep keeps them. One of those counts where a task
      step names that competency by the record's own rule (a domain type
      of what it acted on, or the task it names with an outcome), and only
      that task and the steps below it are read (`trajectoryAt`).
    - The failure is answered with the plan for that regime and the
      admission the plan implies, to keep or not.
    - A failure only its performer reported is a claim to measure first.
    - Work with neither kind of trajectory leaves the regime unread, so
      nothing is offered, and the answer says what would let one be read.
    - Nothing is offered twice, or for a plan with nothing to keep.
  - The learner, person or agent, keeps it with `foxxi.content_admit` on
    their own pod, in a list of its own sealed by the bridge to itself and
    to them ([`src/admission-store.ts`](src/admission-store.ts)). Nothing
    counts until the pod holds it: the list is written on the condition of
    what was read, and a write that fails leaves no trace.
  - For each competency the latest record stands, and a withdrawal is a
    record too. A withdrawal at a position's competency stands over what
    the composition's competency admits.
  - Whenever a request names no admission of its own, resolution reads
    what the learner kept, and says which records limited a position
    (`admittedBy`). A list that cannot be read is not read as empty:
    resolution answers 503 rather than admit every form.

**On the bridge**, for a person or an agent alike, as signed affordances:
- `foxxi.content_fragment` authors a fragment.
- `foxxi.content_compose` authors a composition. Every alternative must be
  content the bridge can reach.
- `foxxi.content_resolve` resolves a composition for the caller from
  their own record, with an admission if they send one.
- `foxxi.content_fold_course` folds a course the caller authored into
  fragments and compositions (below).
- `foxxi.content_mine` lists the compositions the caller authored and the
  ones they played ([`src/content-listing.ts`](src/content-listing.ts)).
  Nothing new is kept to answer it:
  - plays are read from their own record, with whether they finished and
    the latest finished score;
  - authoring is read from the index of where content lives, which names
    each item's author, and one made as a whole is marked a root while its
    authoring record is at hand.
- `foxxi.content_admissions` reads back what the caller keeps with
  `foxxi.content_admit`. A list that cannot be read now answers 503, never
  an empty one.

Each item is written to its author's pod's shared lattice first. Only
once that write lands is it recorded as an `authored` statement, cached,
and its pod remembered. The pod is remembered as written, not derived
again from the DID, and each item keeps up to five authors' pods.

**Folding an authored course** ([`src/course-fold.ts`](src/course-fold.ts)).
A course authored with `foxxi.scorm_author` becomes composable content, so
it resolves per learner, plays step by step and learns which explanation
works.

- **A section's teaching and its check become two fragments.** The
  teaching is a concept fragment. The questions are a check: an assessment
  item, or a reflection when none is graded. Kept apart, another
  explanation can be offered at the teaching's position, and the same check
  judges which one works.
- **The course's shape is kept.** A section with both parts becomes a
  composition of its own, teaching then check. The course becomes a
  composition of its sections in order.
- **The questions grade the same.** They keep the stored form they were
  authored in. Each check's blinding value is derived from the bridge's own
  key, which every pod write needs. So the same course folds to the same
  IRIs on that bridge whenever it can keep anything, and a bridge with no
  key folds nothing.
- **Nothing is invented.** Titles, bodies and questions are the author's.
  The competency is the one named for the course or a section; with none
  named, the course's own IRI names what it teaches. The course's mastery
  score is not carried, because a play grades each step.
- **One write for the lot.** Only the course's author folds it. What it
  makes is kept on their pod as one bundle (`foxxi:ContentBundle`), so a
  course of a hundred sections is one write, not three hundred: each write
  puts the whole lattice. Each item keeps its own IRI, and the store finds
  it inside the bundle and checks it like anything else read back.
- **An emergent course folds too** ([`src/emergent-fold.ts`](src/emergent-fold.ts)).
  The older model's course was already syntagms and paradigms, but it lived
  in memory, under ids nothing could check. Sent to the same route, each of
  its levels becomes a composition and each grounding fragment a fragment,
  in the author's order.
  - A competency's id is the free text its author wrote, exactly.
  - A "question ::: answer — why" check is graded on the bridge: the answer
    as written, and without a leading article.
  - Its audience and moveOn are not carried. The fold answers which IRIs
    each older id became: one each, unless the older model gave several
    things one id, as it does two lessons titled alike.

Anything read back is checked against its hash
([`src/content-store.ts`](src/content-store.ts)), so a wrong or hostile
source can make an item unavailable but never different. A fragment's IRI
dereferences to its public form, and a composition's to itself.

**Playing** ([`src/composition-play.ts`](src/composition-play.ts)):
`foxxi.content_launch` resolves a composition for the caller and starts a
play. `foxxi.content_next` answers the step they are on and moves on.

- **The bridge grades each answer** against the stored verifiers, never
  the learner's word, and marks what it graded.
- **Each step is recorded in the learner's own lens**, as xAPI about the
  fragment itself:
  - an `answered` statement per question, the question as an interaction
    activity that never carries its correct responses;
  - an `experienced` statement for the fragment, carrying the competency,
    the position, the alternatives it was chosen from and why.
  So the record can say which explanation, example or probe a learner met
  at which point, and how they did after it.
- **A missed check brings another way in.** Each position that taught the
  check's competency since the last check there, and offers more than the
  learner met, gives them another of its alternatives. It is chosen as
  resolution chose (`anotherAlternative`: admitted, meant for them, what its
  IRI says, nearest the level they met it at) and is never one they have
  already met, though it may be one the play would show them later. Each
  step the miss was credited to stands for its own position, so a fragment
  taught at two positions gives each its way in. Another check from the
  missed check's position follows, when it
  offers one. The steps go in right after the missed check, before the play
  decides it is done.
  - Each position does this once per play, and at most 12 in all.
  - A position with nothing else to offer adds nothing: the same
    explanation twice is not another way in.
  - The new way in is judged by the check that follows it, as any teaching
    is, and its statements say why it came. The step says so too: its
    view carries `wayIn: 'teaching'` or `wayIn: 'check'`.
  - A play an LMS launches works the same way, without admissions, as it
    resolves.
- **The last step completes the composition.**
- **Every statement follows the Foxxi xAPI profile's
  `composition-attempt` pattern.** Its templates are `question-answered`,
  `fragment-experienced` and `composition-completed`, with the `answered`
  verb and the interaction, fragment and composition activity types. Its
  language maps are keyed by the fragment's language.
- **A step counts only once its record is kept** (`takeStep`). Every
  statement is written to the learner's lens and composed into their lattice
  on their own pod, and each write is waited for. If one fails, the step
  stays answered but pending: nothing is credited, a finished play is not
  let go, and the next call keeps the same statements, with the answers
  already given. So a retry never grades new answers or writes a second
  copy. Only kept statements are forwarded, one after another for each
  learner, in the pattern's order.
- **The content routes share a per-IP budget of their own.** Content is
  authored a fragment at a time and played a step at a time, so one course
  is dozens of requests.

**Projected as a cmi5 course** ([`src/composition-cmi5.ts`](src/composition-cmi5.ts),
[`src/composition-au-page.ts`](src/composition-au-page.ts)). Any LMS that
speaks cmi5 can take a composition as it takes any other course.

- **One AU, resolved per learner.** `GET <composition IRI>/cmi5.xml` is a
  course with one AU, the composition itself, whose page is the bridge's
  player. A cmi5 course lists its AUs when it is published, and a
  composition decides its steps for each learner when it is played. So the
  LMS sees one course and an attempt, and the learner gets what resolution
  chose for them.
- **The page does what cmi5 asks of an AU and no more.** It takes the
  LMS's auth-token from the fetch URL and sends it under Basic, reads
  `LMS.LaunchData`, shows each step, and sends every statement the bridge
  hands it to the LMS's LRS, sending again what the LMS refused before
  anything more is taken. Grading stays on the bridge: the page never holds
  an answer. It is served with a policy that lets its one script run and no
  other, and offers the LMS's return address only when it is a web address.
  A Browse or Review launch is not judged: only `terminated` closes it.
- **Every statement is the LMS's.**
  - Each carries the LMS's actor, registration and context template.
  - Order: `initialized` first, then the play's statements at the fragment
    grain as cmi5 allowed statements, then `completed`, then `passed` or
    `failed` when there is a mastery score to judge by, and `terminated`
    last.
  - Only the defined statements carry the cmi5 category.
  - None claims an xAPI version, since an LMS's LRS may speak 1.0.3.
- **A learner the bridge cannot verify is not counted.** The LMS names its
  learner as an xAPI actor, which the bridge cannot check. So a projected
  attempt resolves with no record, counts nothing toward what has worked,
  and is kept nowhere on the bridge beyond the play itself.

**Projected as a SCORM package** ([`src/composition-scorm.ts`](src/composition-scorm.ts)),
for an LMS that speaks SCORM 2004 rather than cmi5.

- `GET <composition IRI>/scorm.zip` holds one SCO, a wrapper. The wrapper
  frames the same player, launched with `transport=scorm`, and records
  what the player posts it through the LMS's SCORM API.
- The package holds no content and no answers. Grading stays on the bridge,
  unlike the packages the older course model makes, which grade in the SCO
  from hashes shipped in the zip.
- The wrapper records a message only from the bridge's origin, fixed when
  the package is built. It tells the player its own origin, so the player
  posts only to it.
- What SCORM records:
  - each answered question as an interaction (its id, type, response and
    result, never its correct responses);
  - once the play ends, the score over every graded question;
  - success against the LMS's passing score, or every graded question right
    when none is set;
  - completion.
- The learner is named by an LMS id the bridge cannot verify, so, as under
  cmi5, the attempt resolves with no record and counts nothing.

**Alternatives that learn** ([`src/fragment-efficacy.ts`](src/fragment-efficacy.ts)).
Nobody declares which explanation of a competency works; the plays show it.

- **A cell is a fragment at a competency, for learners at one level.** It
  counts the learners who met the fragment there and how many then
  succeeded.
- **A teaching fragment is credited with the check that follows it.** An
  explanation has no answer of its own, so it takes the outcome of the next
  graded step at the same competency in the same play.
- **Each learner counts once per cell.** The count is kept under an HMAC
  of the learner and the cell, with a key only the bridge holds, derived
  from the key that seals the tally so that both last as long. The token
  names nobody and differs from cell to cell, so replaying a composition
  cannot push a fragment up or down, and one learner's outcomes cannot be
  linked across fragments. A cell stops growing at 1,000 learners.
- **A cell's success rate is read at its Wilson lower bound.** At 12
  outcomes the cell turns from Hypothetical to Asserted: the same flip the
  practice's calibration makes for an intervention.
- **Choice prefers what has worked, and still tries what has no record
  yet.** An alternative with no outcome yet for learners at that level gets
  its turn first. After that, the upper confidence bound decides, so a new
  explanation can earn its place. `chosenBecause` says which rule chose,
  and the counts once they may be shown.
- **Nothing about a person is published.** A cell's counts are shown only
  once it holds 5 outcomes: by `GET <fragment IRI>/efficacy`, and in the
  reason a resolution gives, which the learner sees and the step's record
  keeps. Pod resources are world-readable, so the tally is kept on the
  tenant pod sealed to the bridge's own key, and taken back only if that
  key sealed it. A bridge with no key keeps it in the process only.
- **A composition shows its author what it has learned**
  (`GET <composition IRI>/efficacy`, `src/composition-efficacy.ts`). At
  each position it sets the alternatives side by side: each one's cells at
  the position's competency, by the same rule as a fragment's. At each
  level it says which alternative the composition leans to, and why.
  - The alternatives are ranked as resolution ranks them: those that are
    what their IRIs say and are meant for the learner, pitched nearest
    their level, then in the author's order, with a composition counting
    as pitched at every level.
  - Where a composition comes first, learners go into it when it resolves.
    Otherwise the alternatives after it are tried in rank order up to the
    first fragment (`otherwise`): a composition is taken when it resolves,
    and that fragment always. Outcomes decide nothing at such a level, and
    the leaning says so (`into`).
  - Otherwise the leaning is `chooseByEfficacy` among the fragments
    pitched alike. Where an alternative is meant for one kind of learner,
    people and agents get a leaning each.
  - No leaning assumes an admission; one a learner keeps, or a plan
    implies, can narrow what they are shown.
  - It is withheld where any fragment weighed has outcomes too few to
    show, since which of two leads can say what one learner did.
  - A nested composition is named as one, to be read at its own IRI.
  - A tally not read yet answers 503 rather than show no outcomes.
  So an author, a person or an agent, can see which explanation is
  working, and which to revise or add.
- **The tally is written by a state writer** (`src/state-writer.ts`), like
  the index of where content lives: one write at a time, and a failed write
  tried again on its own after a pause that grows while the pod keeps
  failing.
- **A pod that cannot be read now keeps its tally.** Outcomes are counted
  only once the stored tally has been read, so it is never replaced by one
  process's view.

A SCORM package hosted on the bridge folds into this model
(`foxxi.content_fold_course` with `package_sha256`, `src/package-import.ts`):
its pages become concept fragments, a folder of pages a topic composition,
and the questions it keeps a check graded here. Questions are read in any
form the package declares them in (`src/question-banks.ts`): calls to a
Question constructor it declares, QTI items (2.x, 3.0 and 1.2), or a bank
written as data, in a JSON file or in a script. A package Adapt, H5P,
Rise 360, Storyline, iSpring or Captivate made is read in that tool's own
model (`src/tool-exports.ts`, `src/rise-course.ts`,
`src/storyline-course.ts`, `src/ispring-course.ts`,
`src/captivate-course.ts`): Adapt's pages, articles and components, H5P's
chapters, slides and pieces, Rise 360's lessons and blocks, Storyline's
scenes and slides, iSpring's slides and quizzes, or Captivate's slides, and
their questions as the tool grades them. A package that holds several courses
has each read in its own tool's model, and a SCORM package's other activities
read as any package's. A tool's own export that is no
SCORM package (an .h5p file, an Adapt course exported as source, a Rise 360,
Storyline, iSpring or Captivate course published for xAPI or the web) is
uploaded and kept the same way, described as an export: it
launches nothing as it is, so it is listed apart from what plays, and
folded like any hosted package.

## 6. Authoring is composition — the same tools for humans and agents

Authoring is not a separate WYSIWYG application. Authoring **is** the act
of composing fragments into syntagms — `authorFragment`, `authorLesson`,
`composeCourse`, `composeCurriculum` — exposed as affordances
(`POST /content/compose-course`, …), so a human instructional designer
reaches them through the dashboard and an agent reaches them as a tool
call. The *same* affordances.

That symmetry makes humans and agents both first-class instructional
designers, and it makes the four directionalities real — they emerge
from the Agent facet (author kind × audience kind):

| Direction | Meaning |
|---|---|
| **H2H** | a human authors for a human audience — classic instructional design. |
| **H2A** | a human authors doctrine/policy an agent ingests *as context*. |
| **A2H** | an agent authors a job aid / micro-lesson for a human, in the flow of work. |
| **A2A** | one agent composes a playbook another agent consumes — agentic content generation. |

An "agent playbook" is not a new type — it is a `Course` with an agent
audience; `forAudience()` renders the same fragments as context
descriptors the consuming agent merges into its working context.

## 7. Knowledge management — what can honestly become content

Underneath an instruction intervention sits a harder question: of the
knowledge a competent performer draws on, how much can honestly become
content at all? `knowledge-architecture.ts` answers it.

A competency is decomposed into **knowledge components** by how
codifiable each is:

| Component | Where the knowledge lives | Codifiable? | Transfer route |
|---|---|---|---|
| **recorded** | in a document, tool, system | fully | reference |
| **trained** | as a trainable skill | partially | instruction + practice |
| **judged** | as rules of thumb, pattern-cued judgment | partially | narrative, worked examples |
| **lived** | as accumulated experience | no | apprenticeship, connection |
| **innate** | as innate aptitude | no | selection — not transferable |

Three principles govern the whole layer:

1. Knowledge is **volunteered** — given by a willing contributor, never
   extracted; every asset records who volunteered it.
2. Knowledge is **triggered** — it surfaces when a real decision needs
   it; just-in-time beats just-in-case.
3. Knowledge is **lossy under codification** — what is written is less
   than what is said is less than what is known; every codified artefact
   records its uncodified residue.

And the knowledge **strategy** is regime-routed: codify in Evident /
Knowable regimes (knowledge as a stock); connect-and-flow in the
Emergent regime (knowledge as a flow — connection, narrative,
just-in-time emergence). `knowledgeAwareScaffold()` composes this with
the InterventionPlan: if the diagnosis warranted instruction but the
decomposition finds the competency is mostly *lived* and *judged*, the
scaffold **warns** that a course will under-deliver and routes the
residue to apprenticeship and coaching — honest content, honest about
its limits.

## 8. Evaluation — the Knowable regime's closing move

Closing a gap is, again, a Knowable-regime act: it presumes an exemplary
state was established and an intervention applied. The evaluation is a
four-level **modal-status progression**:

- **response** — a recorded reaction (Hypothetical evidence of value).
- **capability** — an assessment result (an `Asserted` competency, or not).
- **transfer** — evidence the behaviour transferred to *real work* — an
  xAPI statement from the LRS, or a trajectory step in the work context.
- **outcome** — the situation's observed-state, re-measured against the
  exemplary one. If the gap closed, the new performance state
  **supersedes** the old (`iep:supersedes`).

The **PerformancePortfolio** rolls many contextualized situations into
the performance-management view. Its headline number is
content-vs-non-content: a system that is genuinely performance-driven
routes a large share of situations to non-content interventions.

## 9. The reflexive loop — calibrating the system's own judgment

The architecture refuses to assume content is the answer. The reflexive
loop refuses to assume the **contextualization itself** was right. A
Knowable-regime situation labelled a Knowledge & Skill cause and routed
to instruction might close the gap — or might not, because the cause was
an incentive all along.

So every evaluation verdict is also evidence about the *diagnosis*.
`recordOutcome()` distils a completed evaluation into an **OutcomeRecord**
— regime, cause, intervention, verdict, and (when it missed and was
re-contextualized) the cause it turned out to be.
`buildCalibrationProfile()` rolls many records into a **CalibrationProfile**:
for each (regime × cause × intervention) cell, how often that
recommendation has actually closed the gap.

`calibrate()` then annotates every fresh plan with its own track record —
*"instruction for a Knowledge & Skill cause has closed 44% of 241
comparable situations; in 39% of the misses the cause was re-diagnosed
as Incentives."* The system holds its own advice to the evidentiary
standard it holds content to.

### A live upward↔downward causal loop

The reflexive loop is a concrete instance of **upward and downward
causation**, and it is live, not static:

- **Upward** — the parts cause the whole. A completed loop records its
  outcome (`POST /performance/outcome`); `/agent/teach` records its A2A
  transfer outcomes; the `CalibrationProfile` is **recomposed on every
  read** from the seeded historical baseline plus those live outcomes.
  Individual outcomes (parts) constitute the profile (whole).
- **Downward** — the whole presses back on the parts. `calibrate()` does
  not merely annotate: when the accumulated profile shows a *sibling*
  intervention out-performing the one the plan selected for the same
  cause, it surfaces it — *"for the same cause, a job aid has closed 75%
  where instruction closed 44% — the evidence favours it."* The profile
  (whole) reshapes the next recommendation (part). It stays advisory:
  the diagnosis is case-specific, the profile aggregate; the
  contextualized decision still rules.

The self-calibrating behaviour is **emergent** — it belongs to neither
an outcome nor the profile alone, but to the loop that runs between
them. And it is **cross-vertical**: the outcomes that feed it come from
Foxxi's own closed loop, from `/agent/teach` (which composes
agent-collective's `ac:TeachingPackage`), and from federated peer pods.

It composes the substrate throughout:

- **Modal status** — a cell is `Hypothetical` until it has the samples
  to `Assert` a rate; the system never over-claims from thin evidence.
- **`iep:supersedes`** — a new profile supersedes the prior one.
- **Federation** — profiles union across organizations
  (`composeCalibrationProfiles()`): one org's hard-won evidence
  calibrates another's, and a cell `Hypothetical` for each org alone can
  become `Asserted` once their evidence is pooled.
- **Aggregate privacy** — a calibration cell is an aggregate count,
  never a record; `federationView()` withholds cells below a
  k-anonymity threshold before anything crosses an org boundary.

### Signature-gated trust at the reader

The federated profile is only as trustworthy as the outcomes that feed
it. The `federation-outcome-loader` filters peer descriptors by
signature verification: every peer outcome's `foxxi:agentSignature` is
checked against the `prov:wasGeneratedBy` DID, and only descriptors
that recover the claimed signer — `iep:CryptographicallyVerified` —
contribute to the rolled-up profile. Unsigned or mis-signed peer
descriptors are silently dropped. Without that gate the calibration
cell would be poisonable: any pod could publish junk outcomes
attributed to anyone and skew a sibling-intervention comparison.

This is the Option D substrate position. Storage stays allow-all
(zero-trust); the storage layer does not know or care who wrote a
descriptor. Trust lives at the verifier and reader layer — the
signature check on write, the signature filter on read. Verticals can
layer extra gates on top of storage if they want (the `css-gate` in
front of the Foxxi tenant pod is one example, requiring a bearer on
writes), but those are optional L3 patterns; the calibration loop's
trustworthiness does not depend on them.

This is calibration as a Knowable-regime act — it is the one regime that
names a cause, so it is the one regime whose cause analysis can be right
or wrong, measured, and improved.

## 10. How it composes the substrate

| System concept | Interego primitive it composes |
|---|---|
| PerformanceSituation | a typed Context Descriptor with a modal status + Provenance + Trust facet |
| contextualization | a composition over the performer's disposition / record / work environment |
| intervention selection | a paradigmatic operation — constraints applied to a paradigm set |
| grounding fragment | a PGSL atom — content-addressed |
| course / module / lesson | a syntagm; positions are paradigm sets |
| personalisation | the composition algebra — restriction + override |
| directionality | the Agent facet — author kind × audience kind |
| knowledge as flow | the affordance / federation graph |
| evaluation closing a gap | `iep:supersedes` — a new asserted state supersedes the old |
| calibration | modal status + federated union + aggregate-privacy k-anonymity |

Nothing here is a monolith. The "performance, content and knowledge
system" is an **emergent property** of composing these primitives. No
L1/L2/L3 ontology was extended; the domain terms are `foxxi:`-namespaced
and dereferenceable at `/ns/foxxi`.

## 11. Surface

| Endpoint | Purpose | Request shape |
|---|---|---|
| `GET /performance` | self-describing index of the system + its affordances | — |
| `POST /performance/plan` | contextualize a situation → the InterventionPlan, a content scaffold, and the plan's calibration track record | `{ situation }` |
| `POST /performance/portfolio` | contextualize a set of situations → the performance-management read | `{ situations }` |
| `POST /performance/calibration` | the reflexive loop — the recorded track record of the system's own recommendations, recomposed live, federated | — |
| `POST /performance/outcome` | the reflexive loop's upward arm — a completed loop records its outcome into the live calibration profile. **Signature-gated.** | `{ author, signature, signedPayload }` |
| `POST /agent/teach` | record an A2A teaching event (composes `ac:TeachingPackage`); transfer outcomes from this endpoint also flow into the calibration profile. **Signature-gated.** | `{ author, signature, signedPayload }` |
| `POST /content/compose-course` | author an emergent course (the authoring tool) | `{ course }` |
| `POST /content/personalize` | resolve a course for one performer (restriction + override) | `{ course, performer }` |
| `GET /knowledge` | self-describing index of the knowledge architecture | — |
| `POST /knowledge/map` | decompose a competency → what to codify, what to enable as flow | `{ competency }` |

### Signature gate on outcome + teach

`POST /performance/outcome` and `POST /agent/teach` require a signed
body — the gate is what lets unsigned peer descriptors be filtered out
of the federated calibration profile (see §9). The request shape is:

```
{
  author:        { id: 'did:key:0x<addr>#agent', kind: 'agent' | 'human' },
  signature:     '<ECDSA hex>',
  signedPayload: '<JSON.stringify(<canonical body>)>'
}
```

The canonical body is the outcome record for `/performance/outcome`, or
`{ teachingPackage, targetBehaviour }` for `/agent/teach`. The
signature is produced by signing a sha256 commitment over the
payload:

```
signedPayload = JSON.stringify(<canonical body>)
signature     = wallet.signMessage('sha256:' + sha256_hex(signedPayload))
```

Rejection responses:

- **`401 signature required`** — `author`, `signature`, or
  `signedPayload` is missing.
- **`401 signature does not verify`** — the address recovered from the
  signature does not match the `0x`-suffix in `author.id`.

On success the server publishes the outcome (or teaching record) into
the tenant pod with `iep:CryptographicallyVerified` trust. Publish is
bounded (~4s) — if it does not land in time, the response returns with
`published=[]` and the publish completes in the background.

Reference clients that produce the right shape live in
`tools/emergent-collective-*.mjs`, `tools/closed-loop-example.mjs`, and
`tools/seed-federation-peer.mjs`.

Verified by `tools/performance-architecture-example.mjs` (seven
scenarios, 27/27) and `tools/knowledge-architecture-example.mjs` (six
scenarios, 14/14).
