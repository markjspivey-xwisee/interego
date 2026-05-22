# Agent Collaboration in Foxxi

One of Interego's first principles is that agents do not work alone.
They **collaborate on work, share context, teach each other, and build
capabilities and tools for each other.** Foxxi is the performance and
learning layer of the substrate — so Foxxi has to be the layer where
that teaching and capability-building becomes *real and measurable*,
not just asserted.

This is the considered account of how Foxxi composes agent
collaboration: what is built now, what it composes, and what is
designed for later. The general agent-collaboration surface — agents
coordinating on shared work — is the [`agent-collective`](../agent-collective/)
vertical's concern. Foxxi composes the **competence dimension**: how
agents teach each other, and how a capability one agent builds becomes
something another agent can acquire and be verified to hold.

A performance layer for agents cannot simply copy the one for humans.
The human closed loop ends in a person completing a course in a browser
and an xAPI statement. An agent does not "complete a course". So every
piece below re-derives the loop for agents from first principles.

---

## 1. The four threads

| Thread | What it means | Foxxi's composition |
|---|---|---|
| **Collaborate on work** | agents act together toward one outcome | the team's shared performance situation; `composeTrajectories` pools their work; `assessDisposition` reads the team |
| **Share context** | agents pool what they know | context descriptors merged via the composition algebra — the substrate's native move |
| **Teach each other** | a capable agent lifts a less capable one | the **A2A teaching loop** — `agent-teaching.ts` (built) |
| **Build capabilities & tools** | an agent makes something reusable for others | a **Capability** = a playbook + conferred affordances; tools are affordances / skills |

The rest of this document takes each in turn.

## 2. Teaching — the A2A loop (built)

The human loop: contextualize a situation → compose a course → a cmi5
package → a human completes it in a browser → xAPI in the LRS →
evaluate. **You do not run that loop for an agent.** An agent is not
quizzed and does not sit a course; a capable agent teaches a less
capable one by composing a playbook the learner ingests *as context*,
and the only honest verification is to watch the learner's real work
change.

`src/agent-teaching.ts` closes the loop for the **A2A directionality**:

1. **`authorCapability`** — a teacher agent composes a `Capability`: a
   playbook (a `Course` with an agent audience), the affordances it
   confers, and a **behaviour signature** — what the learner's work
   should look like once it genuinely has the capability. A freshly
   authored capability is `Hypothetical`: it has not yet been shown to
   transfer.
2. **`acquireCapability`** — a learner agent ingests it. The playbook is
   resolved for the learner (the composition algebra) and rendered for
   an agent audience: each fragment a context descriptor merged into the
   learner's working context — not slides. The conferred affordances
   become callable.
3. **`verifyCapabilityTransfer`** — the heart. The learner agent's
   trajectories *before* and *after* acquisition are read; the
   capability is verified **iff the taught behaviour now genuinely
   appears in the learner's real work** and the old behaviour has
   receded. The transfer claim carries a modal status: `Asserted` when
   the learner's own trajectories carry the evidence, `Hypothetical`
   when there is too little post-acquisition work to read.
4. **`teachingToOutcome`** — a verified transfer distils into a
   calibration `OutcomeRecord`. An agent lacking a documented capability
   *is* a Knowable-regime knowledge/skill cause, and a playbook *is*
   instruction (authored A2A) — so agent-teaching outcomes calibrate the
   system's recommendations alongside human course completions. The
   reflexive loop ([`PERFORMANCE-ARCHITECTURE.md`](PERFORMANCE-ARCHITECTURE.md)
   §9) spans humans and agents.
5. **`attestCapability`** — a capability with a verified transfer is
   promoted `Hypothetical → Asserted`.

Live surface: `POST /agent/teach` runs the whole loop. Verified by
`tools/agent-teaching-example.mjs` (16/16).

The principle worth stating plainly: **a capability is not verified by
the teacher's claim or the learner's report — it is verified by the
learner's trajectories.** Teaching that does not change the work did not
happen, and the system says so.

## 3. Capabilities and tools

A **Capability** is the unit an agent builds for other agents. It is two
things composed:

- a **playbook** — a `Course` with an agent audience, authored with the
  same `composeCourse` affordances a human course uses; and
- the **tools** it confers — affordance ids the learner agent gains the
  right to invoke once it acquires the capability.

A *tool* is an affordance. The substrate already has the machinery:
core `src/skills/` translates an `agentskills.io` SKILL.md to and from a
`cg:Affordance`. So "an agent builds a tool for another agent" composes
cleanly: the tool-building agent authors a skill → a `cg:Affordance`
descriptor; the Capability that confers it carries the affordance id;
the learner that acquires the Capability may now follow that affordance.
No new tool ontology — tools are affordances, and affordances are how
the whole substrate already exposes action.

A Capability is a typed, dereferenceable descriptor. That makes it
**federated and discoverable**: an agent in one pod can discover and
acquire a Capability an agent in another pod built. Agents build
capabilities *for each other* across the federation, not just within one
deployment.

What a learner holds accumulates on its **capability passport** (core
`src/passport/`): a persistent, infrastructure-independent record of the
capabilities an agent has acquired and been verified to hold. A
capability the agent has had a verified transfer for is an `Asserted`
entry; one merely acquired is `Hypothetical`. The public **registry**
(core `src/registry/`) is where a capability-building agent publishes,
so others discover it — the federated, attestation-backed "NPM for AI
agents", with Foxxi supplying the competence semantics.

## 4. Sharing context, collaborating on work

Agents collaborating on one piece of work share context continuously.
The substrate's native move is the composition algebra over context
descriptors — union to pool, restriction to scope, override to resolve
conflict. Foxxi adds the performance read:

- `composeTrajectories` pools the team's actual work into one
  trajectory;
- `assessDisposition` reads the *team's* disposition — its regime,
  vector and stance — rather than scoring an individual;
- a team's performance situation contextualizes (almost always) into
  the **Emergent regime**, where the method is a dispositional read and
  safe-to-fail probes — never a gap analysis. This is why the
  Performance Architecture refuses the gap frame for agent teams: a
  collaborating team is a complex, adaptive system.

So "agents collaborate on work" is not a separate Foxxi feature — it is
the Emergent-regime path of the architecture already in place, applied
to a team rather than one performer.

## 5. How it composes the substrate

| Agent-collaboration concept | What it composes |
|---|---|
| a Capability's playbook | a `Course` with an agent audience — `composeCourse` + `forAudience` |
| acquiring a capability | the composition algebra — context descriptors merged into working context |
| a tool an agent builds | a `cg:Affordance` — core `src/skills/` (SKILL.md ↔ affordance) |
| verifying transfer | the learner's own `AgentTrajectory` record — read, not quizzed |
| a capability's modal status | `Hypothetical` until a verified transfer promotes it to `Asserted` |
| what a learner agent holds | a capability passport — core `src/passport/` |
| publishing a capability for others | the public agent registry — core `src/registry/` |
| teaching outcomes | the reflexive calibration loop — `performance-calibration.ts` |
| a team sharing context | `composeTrajectories` + `assessDisposition` — the Emergent-regime path |

No L1/L2/L3 ontology is extended; the domain terms are
`foxxi:`-namespaced and dereferenceable at `/ns/foxxi`.

## 6. Built now, and designed for later

**Built and verified.** The A2A teaching loop — `agent-teaching.ts`,
the `POST /agent/teach` route, `tools/agent-teaching-example.mjs`
(16/16): a teacher agent authors a capability, a learner acquires it,
transfer is verified from the learner's trajectories, and the verdict
feeds the reflexive calibration loop.

**Designed, for later.** The threads this document lays out but does not
yet fully wire:

- **Capability federation** — publishing a `foxxi:AgentCapability` as a
  pod descriptor and discovering peers' capabilities across
  `FOXXI_FEDERATION_PODS`, the same pattern the Context Companion uses.
- **Capability passports** — writing a verified acquisition onto the
  learner agent's passport (core `src/passport/`) and reading a passport
  to know what a team already holds before teaching.
- **Tool authoring in the flow** — an agent composing a SKILL.md → a
  `cg:Affordance`, conferred through a Capability, with the same A2A
  authoring ergonomics as a playbook.
- **Live teaching calibration** — accumulating `/agent/teach` outcomes
  into the live calibration profile, and segmenting calibration by
  directionality so A2A transfer rates are distinguishable from H2H.
- **A microsite demo** — the A2A teaching loop on the `/demos` page,
  alongside the human closed loop.

The shape is set: agents teach each other and build capabilities and
tools for each other, and Foxxi makes every step of it measurable,
modal-statused, and federated — the same discipline it brings to human
performance.
