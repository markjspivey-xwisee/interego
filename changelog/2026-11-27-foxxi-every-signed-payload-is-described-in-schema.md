## 2026-11-27 — Foxxi: every signed affordance says in schema what its payload holds

- **All 58 signed learner-side affordances carry a `contentSchema`.** Four did.
  The other 54 named their payload's fields only in a sentence, so a client
  that followed the descriptor still had to be told what to send.
  `src/signed-payload-content.ts` describes each, and `foxxiAffordances` is
  published with them attached.
- **Written from the routes.** Each entry names the fields its handler reads.
  That found fields the prose never named: `source` on the record review,
  `evidence_shape` on a performance record, `tenant_pod_url` on course ingest,
  `learner_kind` on the SCORM launch, and `actor_kind` on the extension check.
  It also found `learner_kind` missing from the assignment schema added on
  2026-11-26.
- **Held to the code.** A test reads each route's handler and fails when it
  takes a payload field the schema does not name.
- Limit: a property is flat. A nested value is `object` or `array` with its
  shape in the description.
