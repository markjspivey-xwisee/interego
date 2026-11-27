## 2026-11-27 — Foxxi: a change is written before the call that made it is answered

Three stores were marked changed and written two seconds later by a timer that
nothing waited for. A process that stopped in that gap lost the change after
answering for it.

- **SCORM sequencing sessions.** Creating a session, a navigation request and a
  tracking commit each wait for the sessions to be written and answer
  `sessionKept`. A step the pod does not take is not undone; the answer says so.
  The session routes also wait for the sessions kept before a restart to be
  read, so a kept session is not "no session" in the first moments of a start.
- **What the cmi5 rollup has said.** The registration it speaks under is
  written before the first statement carries it, and each `satisfied` is
  written as it is said.
- **The forwarding queue.** The delivery that queued a statement, and the retry
  that emptied the queue, return once the owner's config is written. The
  debounced writer remains only as the retry after a write the pod refused.
- `keepSnapshot(surface)` is the awaited write: `kept`, `not-kept` (tried again
  on the debounce) or `unconfigured`. Writes of one surface now go one at a
  time; the timer and a waiting caller could publish at once under one version.
- Cost: each of these calls now takes as long as a pod write of the whole
  surface.
