## 2026-11-26 — Foxxi: what the bridge keeps is on the pod, sealed

Memory is a cache of what is kept, not where a record is kept.

- **Three memory-only stores are kept** (`src/sealed-store.ts`). A recorded
  agent trajectory, a team's performance probes and an evaluation (its cohort,
  decisions and run bindings) are each written to the tenant pod, sealed, before
  the call is answered, and read from there when the process does not hold them.
  A write the pod does not take is a 503 refusal and the cache drops its copy.
  A record that is there and cannot be read is a refusal too, never treated as
  absent. Answers say `durable`.
- **Three registries were public and are now sealed.** A person's assignments
  to their own agents (#1005), who brought which package (#1006) and the
  personal launch links (each link's learner, pod and course) were plain JSON on
  the pod, readable by anyone with the address. All are now encrypted envelopes.
  At start the bridge moves each clear copy to its sealed resource and removes
  it, retrying until it is gone, whether or not anyone changes a record.
- **The cmi5 rollup's dedup state is in the cmi5 snapshot.** After a restart a
  learner's next satisfied AU repeated the block's and the course's `satisfied`
  under a newly minted registration.
- **The course ownership index is written safely.** It read "not ok" as "none
  yet" and overwrote, and never looked at whether its PUT succeeded. Authoring
  now awaits the write and reports `authorIndexKept`.
- **The package listing says how many packages the operator's take-down list
  names** (`takenDownByOperator`), so the setting can be added to without
  reading it.
- Not the native commit path: one writer, last write wins. Five of the ten
  gaps in `docs/operations/primary-state-rollout-hold.md` remain.
