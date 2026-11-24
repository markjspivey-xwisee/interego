## 2026-11-24 — Role-play player: a rubric whose levels do not run lowest first is refused

The player finds the level a score reaches, and the level a pass rule asks
for, by a level's place in the list. With a criterion's levels written highest
first, the weakest answers were given the top level and passed a rule that
required it. Run on a one-criterion rubric with levels good, ok, poor: a score
of 0 read as `good` and passed.

Practice Evidence already refuses such a rubric ("level values must strictly
increase from lowest to highest", `applications/practice-evidence/src/practice.ts`).
The player now refuses it when the scenario loads, in the same words, and
shows that as the reason the practice could not start.

The published scenario is unaffected: its levels run 0 to 3. Found while
reviewing #995, whose scoring is a copy of the player's.

Tests: `applications/practice-evidence/tests/roleplay-player-scenario.test.ts`,
which runs the page's own check and level arithmetic cut from the page.
