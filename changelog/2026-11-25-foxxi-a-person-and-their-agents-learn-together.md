## 2026-11-25 — Foxxi: a person and their agents learn together

`learner_kind: "agent"` gave a delegate its own cmi5 record earlier today. This
finishes what was listed as designed for later.

- **`POST /agent/learning/beside`** (`foxxi.learning_beside_signed`), read-only.
  For a person and the agents learning beside them: the courses assigned to the
  person in the tenant directory (an agent is assigned what its person is,
  `assignedThrough`), where each of them stands on those and on any course one
  of them launched, the launch to make, the peers who offered to be found, and
  the team of agents with the consult to make
  (`foxxi.assess_agent_disposition`). A directory that cannot be read is said so
  (`assignmentsRead: false`), not passed off as nothing assigned.
- **`visible_to_peers` on the signed cmi5 launch.** A learner offers to be found
  by other learners of the same course on this bridge, or withdraws. Each
  learner's registrations are kept under their own pod's lens, so this is the
  one read that crosses that partition, and only for learners who offered. Peers are listed only to a learner
  who offered too; a person's visibility is never their agent's choice or the
  reverse. A peer comes with the Interego inbox as the way to reach them.
- **`learner_kind` on the credential and LTI routes.** `earned`, `claim`,
  LTI `launch` and `gradebook` read a delegate as itself when it says so. A
  credential claimed by an agent is issued to the agent, and its criterion says
  it was taken by an AI agent learning beside the person named.

Still not built: projecting an agent's cmi5 registration into a trajectory the
disposition read can use, and assigning a course to an agent with no person.
