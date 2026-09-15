# Performance consulting and intervention methods

AGP owns the performance consulting and management model and the FOXXI-specific performance HTTP adapter in `compatibility/foxxi-performance-routes.ts`. Only FOXXI mounts that adapter; it is not part of AGP's anonymous bridge. FOXXI keeps a compatibility export, its signed-request checks and its existing URLs for content, assessments and standards delivery. Both authorities declare their own method action names with the same input and output contracts. The same methods apply to humans, agents and mixed teams; they do not add domain-specific tools to the neutral Interego core.

The consulting cycle is **agree purpose → contextualize → select → design → pilot/implement → evaluate → manage**, with explicit links back to contextualization and revision. Read the work regime before selecting an intervention: Evident applies established practice; Knowable may use gap analysis; Emergent uses dispositional reads and bounded probes; Turbulent stabilizes first. Unclassified work remains unclassified until evidence supports a regime. A method profile does not override these decisions.

`ontology/agp-methods.ttl` is the canonical profile data. It defines a consulting process and nine intervention methods: instructional design, in-flow performance support, reference, practice, assessment, coaching, bounded probes, environmental changes and monitoring without intervention. Each profile names applicability, an entry step, subsequent and revision steps, required work products, quality criteria, source guidance and a version. Intervention plans link to those profiles using the mapping in the graph. A missing mapping is an error, not a reason to use an embedded fallback table.

Instructional design requires task and audience analysis; objectives aligned with practice and assessment; worked examples and supported-to-independent performance; explicit scoring and input rules; usability and accessibility checks; delivery and recording checks; a pilot and revision log; and transfer support. Every intervention also requires a context record, outcome ownership, selection rationale, evaluation plan and maintenance plan. A job aid can stand alone or be composed with training.

Both the AGP and FOXXI authorities advertise these native affordances:

| Operation | Resource | Result |
| --- | --- | --- |
| Read methods | `GET /performance/methods` | JSON-LD catalogue; optional `method=instruction` or another profile token |
| Read a representation | Add `format=markdown` or `format=turtle` | HMD with native controls, or the complete connected Turtle graph including dependencies |
| Review evidence coverage | `POST /performance/methods/review` | Missing criteria, required work products, coverage and per-criterion results |

The review accepts `{ "method": "instruction", "evidence": [] }`. Each supplied evidence item must have the exact `criterion` IRI from the profile, an absolute `artifact` IRI and a non-empty `note`. Unknown criteria, unsafe URI schemes and caller approval flags are rejected. A complete set of pointers returns **documented-unverified**, never approved or passed. The operation does not fetch artifacts, write records, authenticate an author or verify methodological suitability, substantive quality or performance effects. The status of each criterion belongs to a review instance, not to the reusable criterion definition.

Use the resulting missing-work list to finish the design and inspection work. Record technical test results, substantive reviews and observed performance separately with their actual provenance. A recorded score is not automatically valid evidence for an intended decision; a high post-test score alone does not demonstrate learning gain, transfer or causal improvement. Live performance management continues through the existing outcome, evaluation, portfolio and calibration operations.

These are project-authored practice profiles informed by the source guidance linked in the graph, including [OPM needs assessment and evaluation](https://www.opm.gov/policy-data-oversight/training-and-development/planning-evaluating/), [CDC quality training guidance](https://www.cdc.gov/training-development/php/qts/index.html), [W3C form validation guidance](https://www.w3.org/WAI/tutorials/forms/validation/), and the project's existing performance architecture. They do not assert certification, adoption of a proprietary framework, or a universally best intervention.

The bridge serves the canonical ontology plus method graph. Public ontology and SHACL copies are regenerated with `node --import tsx tools/render-agp-ontology.mjs`; the regression suite checks that they match the runtime sources.
