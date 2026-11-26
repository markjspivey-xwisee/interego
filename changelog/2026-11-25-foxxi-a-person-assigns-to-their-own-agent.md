## 2026-11-25 — Foxxi: a person assigns a course to their own agent, and a pair's disposition

The last two items left open when agents were made learners.

- **`POST /agent/learning/assign`** (`foxxi.assign_to_own_agent_signed`). A
  person assigns a course on this bridge to an agent that holds their
  delegation, or takes it back (`withdraw: true`). The agent's own delegation
  has to name the signer and be in force; anyone else's agent is refused. The
  assignment is written to the pod before the answer is given, and `durable`
  says whether it was. It shows on the pair read on that agent's entry as
  `assignedByPerson`, to the person and to the agent reading as itself. It
  enrols nobody in a tenant directory and gives the agent no access it lacked.
- **`team.disposition` on the pair read.** When any of the pair's agents has
  recorded work of its own, its dispositional read is given there, so a pair in
  no tenant directory can have it. Course steps are left out of it on purpose:
  they are all `Asserted` and would lower the deliberation and exploration
  ratios by what a course record cannot hold. They stay in `courseExperience`.
- **Checked live with test wallets** before this change: a lone agent's launch,
  peer discovery between two learners and its withdrawal, and a credential
  claimed by an agent.

Not built: recorded trajectories are still held in memory only, and an
assignment is not sent to the agent's inbox.
