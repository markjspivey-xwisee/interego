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
  **supersedes** the old (`cg:supersedes`).

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
- **`cg:supersedes`** — a new profile supersedes the prior one.
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
that recover the claimed signer — `cg:CryptographicallyVerified` —
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
| evaluation closing a gap | `cg:supersedes` — a new asserted state supersedes the old |
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
the tenant pod with `cg:CryptographicallyVerified` trust. Publish is
bounded (~4s) — if it does not land in time, the response returns with
`published=[]` and the publish completes in the background.

Reference clients that produce the right shape live in
`tools/emergent-collective-*.mjs`, `tools/closed-loop-example.mjs`, and
`tools/seed-federation-peer.mjs`.

Verified by `tools/performance-architecture-example.mjs` (seven
scenarios, 27/27) and `tools/knowledge-architecture-example.mjs` (six
scenarios, 14/14).
