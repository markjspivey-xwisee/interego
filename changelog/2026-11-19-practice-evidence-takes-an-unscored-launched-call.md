## 2026-11-19 — Practice Evidence: a launched conversation the unit did not score is taken, and judged afterwards

`pev.import_launched_attempt` took a conversation from an LMS launch only when the
assignable unit had scored every criterion itself. That fits a unit that plays a
script and knows what each scripted reply is worth. It does not fit a unit that
only carries a live conversation, where the learner says anything and a model
answers: such a unit has nothing to score with.

A registration with exchanges, an end and no `scored` statement at all is now
taken, as an attempt that is `ended` and has no judgment. No judgment is made up
for it. It is judged the way a conversation held on the bridge is
(`pev.judge_attempt`, or a registered judge's packet), and reviewed by a person
after that; the statements for the unit are built from that review as before.

Not changed: a registration with some scores and not others is refused, an
unscored one is held to every other check (one session, ended, at least one
exchange, the launch mode, the actor), and a scored one is taken exactly as
before.
