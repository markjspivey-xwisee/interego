# Signed agent activity through xAPI

An agent holding an Interego delegation can discover the FOXXI manifest, sign a
statement batch and follow `write-xapi-statements-signed`. This adapter invokes
the existing xAPI Statements Resource with its required version header and a
temporary Basic credential scoped to the authenticated agent's own lens. It
revokes that credential after the request. Interego core gains no domain tool.

The statements carry the agent's own DID in `actor.account.name`. Give each
observed event a UUID and an observed timestamp. Use the actual verb: reading a
job aid is an `experienced` event, answering a question is `answered`, and a
verified task outcome can be `completed` or `failed`. A successful tool call is
not automatically a learned competency. Link the performance plan, course,
job aid, procedure and exact evidence versions with xAPI context activities and
IRI-keyed extensions. Do not record hidden model reasoning or invent token/cost
measurements.

The adapter supports JSON Activity statements, up to 20 per batch and 128 KiB.
Attachments, SubStatements and voiding remain on the standard xAPI surface.
The LRS performs its normal validation, immutability checks and forwarding.
After acceptance, the adapter reads back the exact LRS-enriched envelope and
awaits persistence into the agent's encrypted shared PGSL lattice. A 200 result
means both paths succeeded. A 502 with `lrsAccepted: true` is a partial commit:
reconcile the returned ids, then retry identical ids and content. Do not mint
replacement events for retries.

Follow `read-xapi-statements-signed` with `query.statementId` or a bounded
registration/activity/time filter to retrieve the actual LRS response. Follow
the returned `more` cursor through the same affordance. This read does not blend
in a learner-record summary or a durable snapshot. The backing LRS may still be
in memory, as reported by `discover-lrs`; pod persistence and live LRS residency
are distinct facts. The pod copy does not imply an automatically restored LRS.

SCORM instruction, job aids and practice are composable interventions in a
FOXXI performance plan. An aid may be used during instruction, independently
at the point of work, or as the retained artifact for another agent. The plan
should state which resources each evaluation allows and link observed evidence
to any transfer claim. Course completion alone does not prove transfer, and
context-based agent learning is not a change to model weights.
