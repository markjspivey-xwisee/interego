## 2026-11-18 — Automatic branch updates use the tested head

The automatic merge driver includes the tested commit as `expected_head_sha`
when it asks GitHub to update a pull-request branch. A push that arrives after
the checks were read makes the update fail. GitHub's diagnostic remains in the
job's inherited stderr; the printed note identifies the failed command.
The driver leaves the update refused for the next run to reassess.

Mocked driver tests cover a successful update, update failures, an unarmed run,
and the existing merge guard and label rollback. The failure branch returns
after its exit call, so a returning test mock cannot log a successful merge.
GitHub's actual stale-head rejection is specified by its REST contract.
