# Foxxi Performance Architecture

A content-management, training-generation and performance-support system
for humans **and** agents — in which a diagnosis decides whether content
is even the answer, content is an emergent composition rather than an
authored artifact, and the same authoring tools serve a human
instructional designer and an agent author identically.

This document is the "how could all of that look" answer. The running
code is `src/performance-architecture.ts` + `src/emergent-content.ts`;
the end-to-end proof is `tools/performance-architecture-example.mjs`
(27/27); the live surface is `GET /performance`.

---

## 1. The first principle — performance is the unit, not content

A traditional LMS/LXP/CMS starts with content: here is a course; assign
it, deliver it, track it. Foxxi starts one step earlier, with a
**PerformanceGap** — a typed context descriptor of what a performer
(human or agent) is trying to accomplish, the desired vs. observed
performance, the work context, how often the task occurs, and how
critical it is. The gap carries a **modal status**: a reported gap is
`Hypothetical` until measured; an assessment promotes it to `Asserted`.

Content is never assumed. It is one possible *intervention*, selected —
or ruled out — by a diagnosis. This is the discipline of performance
consulting (Gilbert, Mager & Pipe, Rummler, Robinson & Robinson)
expressed in substrate primitives.

> The user's question — *"does an agent think instruction needs to be
> developed, or should there be assessments, or contextual in-the-flow
> performance support?"* — is exactly the cause-analysis →
> intervention-selection decision. The system's answer is an
> **InterventionPlan**, and it is genuinely varied: across the seven
> demo scenarios, half the gaps route to *non-content* interventions.

## 2. The novel framing — performance consulting is Cynefin-routed

Classic Human Performance Technology — Gilbert's Behavior Engineering
Model, Mager & Pipe's "could they do it if their life depended on it" —
is a **Complicated-domain** method: an expert closes a knowable gap.
It does not apply to a **Complex** adaptive system (e.g. a team of
agents adapting to novel work), where there is no fixable gap and no
ideal state — only dispositions, propensities and vectors.

So the system reads the Cynefin domain of the work **first**, then picks
the consulting method:

| Domain | Method | What it produces |
|---|---|---|
| Clear / Complicated | HPT gap analysis — Gilbert BEM + Mager-Pipe | a root cause + a selected intervention |
| Complex | a dispositional read (composes `agent-disposition.ts`) | a disposition, a vector, safe-to-fail probes |
| Chaotic | stabilise first, then re-diagnose | a decisive act, not a plan |

This is the deep unification. Both are "performance consulting"; the
domain decides which kind is honest. `agent-disposition.ts` already
refuses the gap frame for complex agent teams — the Performance
Architecture **routes to it** rather than contradicting it.

## 3. Diagnosis

For Clear/Complicated work, `diagnose()` builds **Gilbert's six-cell
Behavior Engineering Model** — three environmental cells (Information,
Instrumentation, Incentives) and three individual cells (Knowledge &
Skill, Capacity, Motives) — and applies **Mager & Pipe's discriminating
question**: would the performer do it correctly if their life depended
on it? If yes, it is *not* a skill deficiency, and instruction is the
wrong intervention. Gilbert's empirical finding — that the large
majority of performance gaps are environmental, not individual — is why
the environmental cells are examined first.

For Complex work, `diagnose()` composes `agent-disposition.assessDisposition()`
and returns a disposition + vector + stance, with an explicit caveat that
classic gap analysis does not apply.

## 4. The intervention paradigm

The output of diagnosis is an **InterventionPlan** — the full *paradigm*
of interventions, each marked selected or ruled-out with its reasoning:

- **instruction** — curriculum / course / module / lesson; for a genuine
  skill gap in a *frequent* task that must be held in memory.
- **performance-support** — a job aid / EPSS; for the *same* skill gap
  in a *rare* task, delivered in the flow of work (no need to memorise).
- **reference** — searchable knowledge; looked up, not "trained".
- **practice** — deliberate practice / simulation; the skill exists but
  fluency has decayed.
- **assessment** — verifies a `Hypothetical` gap before money is spent;
  certifies; measures intervention effect.
- **coaching** — a feedback loop; for motivation, transfer, the Complex
  domain.
- **probe** — a safe-to-fail constraint probe; the Complex domain.
- **environmental-fix** — tools, information, incentives; *not a content
  deliverable at all*.
- **no-intervention** — the gap is acceptable variance or self-resolving.

Selecting one is a **paradigmatic operation**: the intervention space is
a paradigm set, the diagnosis supplies the constraints, the selected
intervention is the surviving cell. Instruction is one cell of nine. A
healthy system frequently selects something else — and says so, with
its reasoning, so a human or an auditor can see *why* a course was, or
was not, the answer.

## 5. Content as emergent composition

When the diagnosis *does* warrant content, the content is not authored
as a monolith in a CMS. It is an emergent composition:

```
curriculum = a syntagm of courses     (toward a set of competencies)
course     = a syntagm of modules
module     = a syntagm of lessons
lesson     = a syntagm of grounding fragments   (PGSL-atom content)
```

Every level is a **syntagm** — an ordered chain. Every *position* in a
syntagm holds a **paradigm** — the interchangeable alternatives for that
competency-point (a concept told as text, as a worked example, as a
simulation; a beginner module vs. an advanced one).

**Personalisation is the substrate's composition algebra, made
concrete.** `personalize(course, performer)` produces a `ResolvedCourse`
by two operations:

- **restriction** — drop the syntagm positions whose competency-point
  the performer has already mastered;
- **override** — collapse each remaining paradigm to the cell that suits
  the performer's disposition.

The `Course` is never mutated. A novice and a partially-skilled performer
receive different resolved courses from the *identical* fragments — the
course is a recipe, not a record. That is the emergentism: there is no
"course table", no "CMS database"; a course is a composition over
content-addressed fragments, and the resolved course emerges per
performer at request time.

## 6. Authoring is composition — the same tools for humans and agents

Authoring is not a separate WYSIWYG application. Authoring **is** the act
of composing fragments into syntagms — `authorFragment`, `authorLesson`,
`authorModule`, `composeCourse`, `composeCurriculum`. These are exposed
as affordances (`POST /content/compose-course`, …), so a human
instructional designer reaches them through the dashboard and an agent
reaches them as a tool call — the *same* affordances.

That symmetry is what makes humans and agents both first-class
instructional designers, and it is what makes the four directionalities
real. They are not a bolted-on taxonomy; they emerge from the Agent
facet — author kind × audience kind:

| Direction | Meaning |
|---|---|
| **H2H** | a human authors for a human audience — classic instructional design. |
| **H2A** | a human authors doctrine/policy an agent ingests *as context* — the "course" is a set of context descriptors, not slides. |
| **A2H** | an agent authors a job aid / micro-lesson for a human, typically in the flow of their work. |
| **A2A** | one agent composes a playbook another agent consumes — agentic content generation. |

An "agent playbook" is not a new type. It is a `Course` with an agent
audience: `forAudience()` renders the same fragments as typed context
descriptors the consuming agent merges into its working context, rather
than as slides. The fragments are identical; the delivery is a
composition choice.

## 7. Contextual (in-the-flow) performance support

In-the-flow performance support is the *same grounding fragment* a
course would use, delivered by an **affordance attached to the work
context** — surfaced when the performer (human or agent) enters the
triggering task, never on a training schedule. Delivery is
`restriction(all-support-content, current-task-context)`. Nothing is
"carried in memory"; the support is composed into the work, not the
calendar. `inFlowSupport()` / `authorJobAid()` produce exactly this.

## 8. Assessment and evaluation — closing the loop

Kirkpatrick's four levels are expressed as a **modal-status
progression**:

- **L1 reaction** — a recorded response (Hypothetical evidence of value).
- **L2 learning** — an assessment result (an `Asserted` competency, or not).
- **L3 behaviour** — evidence the behaviour transferred to *real work* —
  an xAPI statement from the LRS, or a trajectory step in the work
  context. This is where the loop touches the original gap.
- **L4 results** — the gap's observed-state, re-measured. If it closed,
  the new performance state **supersedes** the old (`cg:supersedes`),
  and the gap descriptor is retired.

A `no-change` verdict at L3 is a transfer failure — and the honest next
action is to *re-diagnose*, because the original cause analysis probably
mis-identified the root cause (often: the real cause was environmental).

The **PerformancePortfolio** rolls many diagnosed gaps into the
performance-management view. Its headline number is content-vs-non-content:
a system that is genuinely performance-driven routes a large share of
gaps to non-content interventions.

## 9. How it composes the substrate (the Interego mapping)

| System concept | Interego primitive it composes |
|---|---|
| PerformanceGap | a typed Context Descriptor with a modal status + Provenance + Trust facet |
| diagnosis | a composition over the performer's disposition / record / work environment |
| intervention selection | a paradigmatic operation — constraints applied to a paradigm set |
| grounding fragment | a PGSL atom — content-addressed |
| course / module / lesson | a syntagm (`cg:SyntagmaticPattern`); positions are paradigm sets |
| personalisation | the composition algebra — restriction + override |
| directionality | the Agent facet — author kind × audience kind |
| in-flow support | an affordance attached to a work context |
| evaluation closing a gap | `cg:supersedes` — a new asserted state supersedes the old |
| Complex-domain routing | composes `agent-disposition.ts` (Cynefin / Pearl) |

Nothing here is a monolith. The "performance and content system" is an
**emergent property** of composing these primitives — exactly as
Foxxi-as-LRS is an emergent property of Interego. No L1/L2/L3 ontology
was extended; the domain terms are `foxxi:`-namespaced and dereferenceable
at `/ns/foxxi` (`foxxi:PerformanceGap`, `foxxi:Diagnosis`,
`foxxi:InterventionPlan`, `foxxi:GroundingFragment`, `foxxi:Course`, …).

## 10. Surface

| Endpoint | Purpose |
|---|---|
| `GET /performance` | self-describing HATEOAS index of the system + its affordances |
| `POST /performance/plan` | diagnose a gap → the full InterventionPlan + a content scaffold |
| `POST /content/compose-course` | author an emergent course (the authoring tool) |
| `POST /content/personalize` | resolve a course for one performer (restriction + override) |

Verified by `tools/performance-architecture-example.mjs` — seven
scenarios, 27/27 checks: an environmental gap the system refuses to build
a course for; a rare task routed to an in-flow job aid; a real frequent
skill gap composed into a course and personalised two ways; an A2A agent
playbook; an honestly-empty content scaffold; a Complex-domain gap where
instruction is ruled out for probes; and the evaluation loop closing a
gap and rolling up the portfolio.
