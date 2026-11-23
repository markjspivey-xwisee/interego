## 2026-11-23 — Practice Evidence: a call held as an agent test is not taken as an attempt

A scenario can now be tried out as a live call between two speech models. Such
a call is written to the learning record like any other, under the identity of
whoever launched it. Nothing stopped it being imported: it would have been
judged and reviewed as that person's own practice. Until now only a note in the
README asked for that not to be done, and a reviewer in another session
confirmed the gap in the import's source.

A unit launched as an agent test now writes `pev:agentTest: true` in the context
of every statement it sends. The role-play player does this when its launch
says `contextKind=agent-test` or `actorKind=agent`. The import refuses any
registration in which a statement of the unit carries it, and says why.

Not caught: a unit that does not write the term, a launch that does not say it
is a test, and the agent-test calls recorded before this change.
