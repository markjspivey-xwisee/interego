## 2026-11-26 — Foxxi: a SCORM attempt in progress survives a restart

- **An attempt an agent is playing is kept.** `POST /agent/scorm/launch` writes
  the attempt to the pod, sealed, before it hands out the session id, and
  `/agent/scorm/submit` writes where it stands after each step before
  answering. A process that does not hold the attempt reads it back. It is
  removed once its outcome is in the learner's record. An attempt the pod does
  not take is not started. A step it does not take is not undone (it was
  graded and may be recorded): the answer says the pod does not hold it.
- **The sequencing engine's sessions are kept.** Their snapshot was collected
  with `JSON.stringify` of a cyclic structure, so collecting threw and nothing
  was ever published, and its restore discarded each entry. `sessionToJson` and
  `sessionFromJson` write a session without its parent links and rebuild them.
  A test restarts a session before every step of a course and checks it answers
  and ends exactly as one that was never interrupted.
- Three of the ten gaps in `docs/operations/primary-state-rollout-hold.md`
  remain: attachments, the forwarding config and the forwarding queue.
