## 2026-11-27 — Foxxi: a whole-surface snapshot write no longer holds a learner's answer

- **Regression fixed.** A change earlier this day made the SCORM sequencing
  routes and the cmi5 rollup wait for their snapshot to be written. Measured
  on the deployed bridge, that write takes about sixteen seconds (it publishes
  the whole surface and the pod's manifest), so every sequencing step took
  sixteen seconds and a cmi5 completion could take three times that.
- These two now start the write when the change is made, with no two-second
  timer, and do not wait for it. Writes of a surface still go one at a time
  and a refused one is retried. The sequencing answers no longer carry
  `sessionKept`: when the answer is sent, that is not known.
- The forwarding queue still waits for its write. That one is a single
  resource on the owner's pod, not a publish.
- These two stores are therefore not "written before the answer". A process
  that stops during the write loses the step. Closing that needs a store that
  commits one record quickly, which is the native record store.
