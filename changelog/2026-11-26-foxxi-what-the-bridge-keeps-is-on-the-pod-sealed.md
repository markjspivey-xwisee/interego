## 2026-11-26 — Foxxi: what the bridge keeps is on the pod, sealed

Memory is a cache of what is kept, not where a record is kept.

- **Three memory-only stores are kept** (`src/sealed-store.ts`). A recorded
  agent trajectory, a team's performance probes and an evaluation (its cohort,
  decisions and run bindings) are each written to the tenant pod, sealed, before
  the call is answered, and read from there when the process does not hold them.
  A write the pod does not take is a 503 refusal and the cache drops its copy.
  A record that is there and cannot be read is a refusal too, never treated as
  absent. Answers say `durable`.
- **Two registries were public and are now sealed.** A person's assignments to
  their own agents (#1005) and who brought which package (#1006) were plain JSON
  on the pod, readable by anyone with the address. Both are now encrypted
  envelopes; the clear copies are read once and deleted after the first sealed
  write.
- **The package listing says how many packages the operator's take-down list
  names** (`takenDownByOperator`), so the setting can be added to without
  reading it.
- Not the native commit path: one writer, last write wins. Seven of the ten
  gaps in `docs/operations/primary-state-rollout-hold.md` remain.
