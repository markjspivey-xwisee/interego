## 2026-11-27 — Foxxi: trajectories, probes, evaluations and SCORM attempts commit natively

- **Where a tenant's record store is native, these four kinds of record are
  native too.** They are encrypted native artifacts under the tenant, published
  by the same conditional head commit a statement is
  (`NativeInteregoLrsStore.putResource`, which xAPI documents already use). No
  new storage mechanism: `src/kept-records.ts` routes them there.
- **Why.** The sealed pod records of 2026-11-26 were a plain PUT per record:
  one writer, last write wins, no revision check, no receipt. That is not the
  commit `docs/operations/native-learning-storage.md` requires, and it was not
  safe for two bridge processes.
- **Records already kept sealed are brought across** the first time each is
  read: committed natively, then the sealed copy removed. A native write or
  removal also removes the sealed copy, so one cannot be read back later as
  the record.
- A tenant whose store is not native keeps the sealed pod record, as before.
- Limits: a record is one native artifact, so it is bounded by the native
  artifact size (8 MiB); a SCORM attempt carries its whole course. The three
  sealed registries (own-agent assignments, package bringers, personal launch
  links) and the per-owner forwarding config are not moved by this change.
