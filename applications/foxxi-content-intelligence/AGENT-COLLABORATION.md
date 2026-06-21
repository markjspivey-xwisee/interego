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

**Foxxi does not invent agent teaching.** `agent-collective` (`ac:`)
already establishes it: a teacher agent bundles a tool with its practice
context into an **`ac:TeachingPackage`**, whose trust accrues through
`amta:Attestation`s until `iep:modalStatus` flips to Asserted;
`agent-development-practice` (`adp:`) supplies the practice the package
carries. The unit one agent teaches another **is an `ac:TeachingPackage`**.

`src/agent-teaching.ts` composes that foundation and adds exactly one
thing — the **performance / L&D lens**, which the foundation does not
carry. Given a reference to an `ac:TeachingPackage`:

1. **`frameTeachingIntervention`** — reads the learner agent's
   acquisition of the package in performance terms: a Knowable
   knowledge/skill cause met with **instruction**, the **A2A**
   directionality. (A team's *emergent* behaviour is a different,
   Emergent-regime matter — §4; this frame fits only a codifiable
   capability.) Foxxi does not author or deliver the package — that is
   `ac:bundleTeachingPackage` and the substrate's context-merge.
2. **`verifyCapabilityTransfer`** — the genuine addition. The learner
   agent's trajectories *before* and *after* acquisition are read; the
   transfer holds **iff the taught behaviour now genuinely appears in
   the learner's real work** and the old behaviour has receded. The
   claim carries a `iep:modalStatus` — `Asserted` only when the learner's
   own trajectories carry enough evidence to read.
3. **`transferAttestation`** — a verified transfer is emitted as an
   `amta:Attestation` (axis: correctness). This is a new *kind* of
   evidence — observed behaviour in the learner's trajectories, not an
   execution count — that flows into the **same** attestation discipline
   `ac:` already uses to promote a package's `iep:modalStatus`. Foxxi
   runs no parallel modal flip.
4. **`teachingToOutcome`** — a verified transfer distils into a
   calibration `OutcomeRecord`: an agent lacking a documented capability
   *is* a Knowable knowledge/skill cause, an `ac:TeachingPackage`
   acquired A2A *is* instruction — so agent-teaching outcomes calibrate
   the system's recommendations alongside human course completions. The
   reflexive loop ([`PERFORMANCE-ARCHITECTURE.md`](PERFORMANCE-ARCHITECTURE.md)
   §9) spans humans and agents. **Admissibility is gated on the teacher
   signature.** A teaching outcome only enters the cross-vertical
   calibration cell because `POST /agent/teach` verified an ECDSA
   signature by `teacher.id` over `{ teachingPackage, targetBehaviour }`
   and the federation-outcome-loader re-verified `foxxi:agentSignature`
   against `prov:wasGeneratedBy` on the read side. Without that gate
   any caller could `POST` a fabricated transfer for an agent they do
   not control and poison the profile — so the signature is the
   admissibility predicate, not a wrapper around it. Unsigned or
   misattributed teaching descriptors are silently dropped both at
   write time and on the federated read.

Live surface: `POST /agent/teach` — the performance lens over a teaching
package reference. The request body is
`{ author, signature, signedPayload }`, where `author.id` is the
teacher's `did:key:0x<addr>#agent`, `signedPayload` is the canonical
JSON of `{ teachingPackage, targetBehaviour }`, and `signature` is the
teacher wallet's ECDSA signature over `'sha256:' + sha256_hex(signedPayload)`.
The route rejects with `401 signature required` if any of the three
fields are absent, and `401 signature does not verify` if the recovered
address does not match the 0x-suffix in `author.id`. Verified by
`tools/agent-teaching-example.mjs` (14/14).

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
`iep:Affordance`. So "an agent builds a tool for another agent" composes
cleanly: the tool-building agent authors a skill → a `iep:Affordance`
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

| Agent-collaboration concept | What it composes — and whose layer it is |
|---|---|
| the unit one agent teaches another | `ac:TeachingPackage` — **agent-collective**, not Foxxi |
| a tool an agent builds | a `iep:Affordance` — core `src/skills/` (SKILL.md ↔ affordance) |
| the practice a package carries | `adp:` narrative fragments / synthesis / constraints — **agent-development-practice** |
| a package's trust + modal flip | `amta:Attestation` accumulating until `iep:modalStatus` flips — substrate + `ac:` |
| what a learner agent holds | a capability passport — core `src/passport/` |
| publishing a capability for others | the public agent registry — core `src/registry/` |
| **framing acquisition as a performance intervention** | **Foxxi** — the A2A directionality, a Knowable instruction intervention |
| **verifying transfer from the learner's work** | **Foxxi** — reads the learner's own `AgentTrajectory` record, emits an `amta:Attestation` |
| **calibrating teaching outcomes** | **Foxxi** — the reflexive calibration loop, `performance-calibration.ts` |
| a team sharing context | `composeTrajectories` + `assessDisposition` — the Emergent-regime path |

The first six rows are foundation Foxxi *composes*; the three bold rows
are the dimension Foxxi *adds*. Nothing in the first six is re-built at
the Foxxi layer.

No L1/L2/L3 ontology is extended; the domain terms are
`foxxi:`-namespaced and dereferenceable at `/ns/foxxi`.

## 6. Built now, and designed for later

**Built and verified.** The performance lens over an `ac:TeachingPackage`
— `agent-teaching.ts`, the `POST /agent/teach` route,
`tools/agent-teaching-example.mjs` (14/14): given a teaching-package
reference, Foxxi frames the learner agent's acquisition as an A2A
instruction intervention, verifies the transfer from the learner's
trajectories, emits an `amta:Attestation`, and feeds the reflexive
calibration loop. Foxxi adds the measurement; `agent-collective` and
`agent-development-practice` remain the teaching foundation.

**Designed, for later.** The threads this document lays out but does not
yet fully wire:

- **End-to-end with `agent-collective`** — composing `ac:bundleTeachingPackage`
  directly so a package is authored, taught, *and* performance-verified
  in one federated flow, and discovering teaching packages across
  `FOXXI_FEDERATION_PODS`.
- **Capability passports** — writing a verified-transfer `amta:Attestation`
  onto the learner agent's passport (core `src/passport/`) and reading a
  passport to know what a team already holds before teaching.
- **Tool authoring in the flow** — an agent composing a SKILL.md → a
  `iep:Affordance` (core `src/skills/`), bundled into a teaching package.
- **Live teaching calibration** — accumulating `/agent/teach` outcomes
  into the live calibration profile, and segmenting calibration by
  directionality so A2A transfer rates are distinguishable from H2H.
- **A microsite demo** — the A2A teaching loop on the `/demos` page,
  alongside the human closed loop.

The shape is set: agents teach each other and build capabilities and
tools for each other, and Foxxi makes every step of it measurable,
modal-statused, and federated — the same discipline it brings to human
performance.
