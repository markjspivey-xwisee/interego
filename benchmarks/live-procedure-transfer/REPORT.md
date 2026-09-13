# Live procedure reuse and action rebinding

The source capture records four fresh agents reusing a frozen procedure through generic Interego MCP calls. All four completed an assessment, attached its signed observation to an isolated application, reached a test-release state, and obtained a successful three-link history replay. Both agents whose activation binding changed recovered after their saved invocation was refused. Neither received a replacement action from the coordinator.

Both the linked-resource and conventional workflow representations succeeded. This supports procedure reuse and action rebinding under the tested conditions. **Both arms used Interego.** The experiment does not establish superiority for either representation or compare Interego with another substrate.

This publication contains a privacy-filtered, unsigned projection of the source capture. Its local audit verifies the published accounting and structural equivalence. It cannot independently verify source signatures, live freshness, raw assessment grading, or the recorded replay verification. Read [PRIVACY.md](PRIVACY.md) for the publication boundary.

## Recorded results

| Episode | Recorded grade | Recorded replay links verified | Generic calls | Recorded decision batches | Generic failures |
|---|---:|---:|---:|---:|---:|
| Acquisition | 10/10 | 3/3 | 30 | 21 | 3 discovery/dispatch probes |
| Linked, stable | 10/10 | 3/3 | 24 | 14 | 0 |
| Conventional, stable | 10/10 | 3/3 | 24 | 13 | 0 |
| Linked, changed binding | 10/10 | 3/3 | 28 | 18 | 1 refused old binding |
| Conventional, changed binding | 10/10 | 3/3 | 28 | 17 | 1 refused old binding |

Each episode used one graded attempt. The four transfer cases total **104 generic calls and 62 recorded decision batches**. Counts include three final execution-report publication/readback calls per episode. Batches are recorded groups of model-selected calls; they are not provider inference counts. Grouping choices differed, so the one-batch representation differences support no performance conclusion. Captured output byte counts measure retained serialized representations, not network traffic. No token, inference-cost, or reliable end-to-end latency measurement is available.

The source recordings also contain local trace-writing and serialization failures. These are separate from the generic call failures counted above and had no recorded accepted live-state effects. Their free-text diagnostics are excluded from the public projection.

## Method and intervention

Acquisition received one coordinator intervention: the agent had overlooked controls already present in its own descriptor result, and the coordinator pointed to that field. No private application address, replacement action, or fixture repair was supplied. After completing the assessment and application transitions, the acquisition agent authored two procedure representations. Their eight resource roles, ten semantic steps, and eleven dependencies were checked for equivalence. Two documentation defects were corrected before freezing; neither procedure changed after transfer began.

Each transfer agent started without conversation history, with the same task template and budget, and one signed entry resource. The entry linked the frozen procedure, isolated target, evaluator, course, and candidate. Agents were instructed to inspect those links and advertised resources without consulting prior traces, reference answers, or other agents' files. This was seeded traversal of a linked procedure, not unseeded capability search. The documents guided agent interpretation; they were not a deterministic DAG executor.

The assessment course and frozen policy already existed. Agents read the current questions and policy/job aid, chose answers, and submitted once to the actual grading service. The private source audit checked the retained launch, answer ordering, grade, observation, and response-digest correspondence. Its five recorded sessions were distinct and scored 10/10. The public projection preserves the scores and question counts, but removes questions, answers, responses, session identifiers, and digests. This reuse does not demonstrate held-out generalization, learning causation, a model-weight update, or complete adherence of opaque reasoning to an algorithm.

All four agents paused after evidence acceptance and saved their advertised activation invocation. Stable cases resumed without a fixture change. In changed-binding cases, the coordinator published a predeclared successor contract and catalog using current-head concurrency control. Acceptance stayed identical. Activation preserved its ownership/status guards and effects, changed its action identity, and added an advertised acknowledgement input. The coordinator verified unchanged application state and sent the same continuation message used for stable cases, with no replacement action or payload.

Both saved invocations then returned `isError: true` with `INVALID_ARGUMENT`, indicating that application authority had changed before submission. **This was an application-level refusal, not an HTTP 412 response.** Both agents followed their frozen recovery guidance, resolved the current catalog, inspected the replacement control, supplied its declared acknowledgement, and completed the transition. Their recorded final histories replayed across both contract epochs. This tests a changed action identity and one added supported input, not arbitrary new interpreter semantics.

## Scope and limits

The source capture records verification of observation signature, identity, graph/current-head binding, and declared fields before acceptance. The observation is an observer/relay attestation of the grading response, not a signature held by the grading service or independent human review. The application guard does not independently recompute grade semantics. The evaluator also used an advertised manifest action through generic `act` after root-descriptor dispatch failed during acquisition; that fallback does not re-resolve descriptor authority at invocation.

The coordinator's source records report final catalog and descriptor checks, five of five verified artifacts per transfer application, three of three replay links, no replay errors, and unchanged frozen procedure heads. The public projection contains recorded replay counts, not the underlying cryptographic proofs. Original game and production release heads were checked as unchanged in the source work. Test release was an isolated, single-owner state declaration and caused no production deployment or game reset.

No MCP tool or production runtime change was added. Experiment-specific fixture documents, authoring helpers, and audit code were created; this is not a zero-code or zero-setup claim. Preparation, binding-change coordination, and additional verification reads are outside the measured episode counts. Total implementation effort and integration cost were not controlled against another platform.

This complements the [controller/surface pilot](../controller-surface/REPORT.md). ReAct and Plan–Act approaches govern when an agent reasons, plans, and acts. Interego supplies discoverable actions, signed resource identity, guarded transitions, and verifiable history. A Plan–Act controller can consume those resources. The present experiment evaluates procedure representation and reuse; it does not test a particular external controller implementation or show that linked formatting improves a controller.

## Reproduce the public checks

From the repository root:

```bash
node benchmarks/live-procedure-transfer/audit.mjs
```

`public-evidence.json` contains allowlisted accounting records. `public-procedures.json` contains the two structural procedure projections. The audit recomputes accounting and checks their structural equivalence without network access or application execution. `export-public.mjs` provides a reproduction path for a holder of the original capture after its private audit. The original capture is not distributed here, so a public-only reader cannot independently establish that the projection faithfully represents it.
