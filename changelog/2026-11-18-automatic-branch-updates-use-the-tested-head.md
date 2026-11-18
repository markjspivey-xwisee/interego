## 2026-11-18 — Automatic branch updates use the tested head

The automatic merge driver includes the tested commit as `expected_head_sha`
when it asks GitHub to update a pull-request branch. A push that arrives after
the checks were read makes the update fail with the original diagnostic.
The driver leaves the update refused for the next run to reassess.

Mocked driver tests cover a successful update, a stale head, unrelated validation
errors, an unarmed run, and the existing merge guard and label rollback.
