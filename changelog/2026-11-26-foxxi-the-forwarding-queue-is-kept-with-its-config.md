## 2026-11-26 — Foxxi: what a forwarding target did not take is kept, and an unreadable config is not overwritten

- **The queue of statements a downstream LRS refused is kept.** It was a list
  in the bridge process, so a restart dropped every statement waiting to be
  sent again. It now goes into the owner's forwarding config (sealed, on the
  owner's pod) whenever it changes, with retries, and a process that does not
  hold a target's queue restores it from there. A process that already holds
  one keeps its own.
- **A kept config that cannot be read is no longer read as "none".**
  `readForwardingConfig` tells held, absent and unreadable apart. On
  unreadable, `/agent/forwarding/targets` and `/agent/forwarding/credentials`
  answer 503 and change nothing; before, the next change wrote this process's
  copy over the kept one.
- **Both routes say whether the pod took the change** (`durable`, and a note
  when it did not). A failed write used to be logged and answered `ok`.
- Limits: one writer, last write wins. The queue is written after a failed
  delivery, debounced, not before the statement's own answer, so a process
  that dies in that gap loses that entry.
