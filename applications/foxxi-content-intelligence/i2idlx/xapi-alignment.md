# Version-qualified xAPI integration

A recorded account of an experience and the experience itself have different identities. The current Foxxi `xapi:Statement` class describes an informational record. HD-XAPI's historical `https://w3id.org/xapi/ontology#Statement` describes a PROV activity. Neither a matching local name nor a SKOS peer link licenses class equivalence.

| Producer / consumer | Executed path | Source boundary |
| --- | --- | --- |
| Learning Fabric | Tenant LRS row → read-only REST/MCP projection → current Statement → I2IDL-X classifier | Exact retained original and stored JSON are separate source entities. The existing v0.0.63 default and accepted assertion bindings stay pinned; a separately named v0.0.93 + authored 0.1.1 companion provides current terminology. No historical producer model is invented. |
| HD-XAPI playground | Actual JSON editor → explicit three-format record export → classifier | The historical activity keeps its IRI and type. The distinct record is about that activity and derives from a source JSON entity. No remote context loading, upload or achievement inference occurs. |
| Legacy semantic-layer reference | ETL / HTTP ingestion → shared actual in-memory store → original JSON, legacy RDF and separate record RDF → classifier | Immutable UUID retries are idempotent; changed payload conflicts. The implementation is an in-memory reference, with no deployed durable LRS claim. |
| Interego TLA demos | Actual producer functions → current record / nested Result and Score | Synthetic fixtures remain explicit. Source JSON preserves legacy fields, including the old non-UUID registration without asserting it as a current UUID. The demos are not run against production for verification. |
| HELA | Its merged source-qualified Statement producer → classifier | Repository source alignment is verified separately from any active deployment. |

Positive checks use the actual emitted graph, not a manually substituted class assertion. The classifier must assign canonical `xapi-statement` and `learning-record` only to the distinct informational record. Negative checks include an unadapted legacy activity, an Account, a foreign same-name Statement and aboutness alone. Original JSON and activity nodes must not acquire record classification. Protocol versions, ontology releases and glossary releases are reported independently; these bridges do not constitute full xAPI or SHACL conformance.

The public classifier computes the monotone fixed point of the pinned `q-classify`, with a 32-pass and 10,000-derived-triple bound. A nonconvergent query fails closed. This remains the existing query's limited rule closure, not full OWL consistency checking. The original submitted-subject boundary and unknown-concept refusal remain in force.

The active AI-drafted `m-ai-competency-framework-for-teachers-ai-cft-1` mapping currently entails LER CompetencyFramework for a referent classified as AI-CFT. The separately authored LER bridge then entails the generic authored Competency framework classification. Closure now exposes that existing two-step consequence in one request. Its proposal status and confidence remain unchanged; this is not canonical adoption or a newly ratified narrower relation.

CaSS peer annotations remain annotations: no actual CaSS producer has been identified for a qualified adapter. A generic Proficiency level concept remains a separate editorial gap. Existing old local checkouts are not updated or rewritten by this integration.
