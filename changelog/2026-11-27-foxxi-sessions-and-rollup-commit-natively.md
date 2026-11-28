## 2026-11-27 — Foxxi: a sequencing session and the cmi5 rollup's record are kept before the answer

- **SCORM sequencing sessions are one record each.** Where the bridge's record
  store is native, a session is a native commit, so the three session routes
  wait for it and answer `sessionKept`. A session this process does not hold is
  read from the store, so a session outlives the process and the 5000 held in
  memory. One that is kept and cannot be read is a 503, never "no session".
- **Kept sessions are bounded.** The route that makes one is public and
  unsigned. An index record, changed by a conditional commit, holds the ids in
  order: a session is added to it before its record is written, and past 5000
  the oldest are removed. The bound holds across restarts and across bridges.
  The session routes are also rate limited by address.
- **What the cmi5 rollup has said is one record a learner**, read before the
  rollup decides and written before it returns, merged by a conditional commit
  so two of a learner's courses rolling up at once both land. If the record is
  kept and cannot be read, the rollup says nothing that time. Forgetting a
  learner removes the record, and fails the request if it cannot.
- **Why records and not the snapshot.** Publishing the whole-surface snapshot
  takes about sixteen seconds on the deployed bridge; waiting for it was tried
  and withdrawn earlier this day. With a store the snapshot is not written for
  these two at all.
- `KeptRecords.update` changes a record by what it holds (a conditional native
  commit; one at a time where records are sealed). `sealedBefore: false` marks
  a kind with no earlier sealed copies, so a native read or write makes no
  request to the pod's sealed records.
- Without a native store or a pod, both behave as before.
