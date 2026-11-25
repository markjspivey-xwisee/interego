## 2026-11-25 — Foxxi: an agent's course record as a trajectory, and an agent with no person

The two things left as designed for later when agents were made learners.

- **A course record read as a trajectory** (`src/course-trajectory.ts`).
  `POST /agent/learning/beside` now returns `team.courseExperience`: for each
  agent, its own statements on its cmi5 registrations projected into trajectory
  steps (a task per registration, a step per statement the agent made, a redo
  of a failed step marked as superseding it) and read for what was taken,
  answered, retried, passed and failed. `trajectory: true` returns the steps,
  in the shape the performance layer's trajectory builder takes; Foxxi imports
  nothing from that layer to make them. They are rebuilt from the statements on
  each read and stored nowhere, so this adds nothing a restart could lose. A
  registration's statements are read through every page the store returns, and
  one too long to read whole is reported as partly read.
- **What it does not claim.** A course record holds no intentions and no
  rejected alternatives, so the disposition read run over one alone would call
  any agent execution-biased and exploitative. The read reports only what the
  record supports and names deliberation and exploration as not readable.
- **An agent with no person.** A wallet signing for itself may say
  `learner_kind: "agent"`, which was refused with 400. It learns as an agent
  beside nobody: no `context.team`, its record on its own pod, the tenant
  directory's assignments to its own id read as its own. The launch record now
  says its learner's kind, since no person says it. A delegate still cannot
  drop its person: it is beside whoever its delegation names, or refused.
- **The consult note is corrected.** `foxxi.assess_agent_disposition` is a
  tenant-directory tool; the pair read said to call it without saying a
  self-sovereign delegate is refused there.
- **`docs/operations/primary-state-rollout-hold.md`** gains a dated status note
  on the three foxxi-bridge restarts of this date.

Not built: feeding the course steps into the disposition read beside recorded
work, and a person assigning a course to their own agent without the directory.
