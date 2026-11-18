## 2026-11-17 — CI: the mutation gate runs on five runners instead of one

Mutation Gate was one job that applied every mutant in turn: 30.0 minutes on
average over 20 runs (2026-11-16 and 17), on every pull request. Its own
header still called it six minutes; the table has grown to 55 mutants since,
at about half a minute each, because every vitest run pays the typecheck
setup. It is the longest check on a pull request, so it is what the gated
auto-merge waits for.

The harness takes `--shard=<index>/<count>` and applies every count-th mutant
of the table, and `mutation-gate.yml` runs it as a matrix of five. Mutants
are independent (each starts from the pristine tree), so nothing about any
one changes: the same defect, the same gate, the same three-state verdict.
Nothing is filtered. Every mutant still runs on every pull request, which is
the property the workflow's header argues for; a cut by position narrows
nothing.

`tests/mutation-gate-shards.test.ts` reads the workflow's shard list and the
table and fails if the shards are not 1/n to n/n once each, if together they
are not the table, or if one is empty. A shard the harness cannot parse, or
one that holds no mutant, exits 1 instead of running everything or nothing.

**Checked.** The new test passes. The real harness, run locally, refused
`--shard=x` and `--shard=9/5`, caught `decline-plain` under `--shard=1/5`,
and refused to select a shard-2 mutant through shard 1. A whole shard was not
run locally; this pull request's own run is the first.

**Measured on this pull request.** A shard takes about 10.6 minutes from start
to finish, against 26 for the single job on the same days. That is slower than
the six minutes first expected: install, build and the typecheck setup are paid
on every runner. Five runners spend about ten more runner-minutes on setup than
one did. Once this lands, the `merge-wait` environment's 20-minute timer is
longer than the slowest check and should come down to about ten, or it delays
merges.
