# Linked procedure execution demo

An agent can select a published Interego procedure once, let ordinary code follow its directed affordances, and return for a decision when a declared expectation fails. This optional client integration demonstrates that boundary on a live performance and learning evidence workflow.

The procedure is [native RDF](../../examples/procedures/performance-learning-review.ttl): named steps, directed `pr:next` edges, linked conditions and input bindings, Hydra GET operations, and explicit failure outcomes. It reuses the core Turtle and HyperMarkdown parsers. The small `pr:` [vocabulary](../../docs/ns/procedure.ttl) is an optional L3 example profile, grounded in PROV plans and activities. Application semantics stay in the example. No core MCP tool or service endpoint is added.

## What the example does

1. Discover the application's current catalog head and require verified authority, bound content, complete replay, and verified artifacts.
2. Select the catalog's currently advertised **Refresh and verify** GET control. Follow its exact action IRI and descriptor authority through the existing generic `act` capability.
3. Compare the refreshed release state with the caller's expectation. A mismatch returns an observation and `needs-decision`; a new invocation repeats discovery and all checks.
4. Follow accepted AGP readiness and FOXXI result links. Check their document digests and candidate/suite/grade bindings, then follow the linked portable performance record.
5. Read the course's HyperMarkdown, select its typed JSON catalog link, and bind the live course identifier and assessment count to the accepted FOXXI evidence. Return its advertised SCORM manifest and package links.
6. Recheck state and catalog heads before reporting completion. Return the historical xAPI reference explicitly as a signed snapshot, not a fresh LRS statement query.

This reviews existing performance evidence. It does not launch a course, execute a SCORM package, run a new assessment, or establish general competence.

The [HyperMarkdown view](../../examples/procedures/performance-learning-review.hmd.md) uses the canonical renderer, declared term mappings, IRI-valued entry and step membership, typed links, and a directed-step table. It is a navigation projection: full conditions and binding resources remain in the linked RDF authority. The core HMD reader deliberately supports scalar fields and lists, so this view does not hide executable structure inside an opaque JSON field. `render.mjs` accepts controls already discovered from the authority and retains their source; it invents no server-side Run action.

## Measured live execution: 2026-09-14

| Execution | Routine steps completed | Routine Interego calls | Routine time | Bootstrap calls / time | Total time | Decision handoffs |
| --- | ---: | ---: | ---: | --- | ---: | ---: |
| Initial completion | 28 | 10 | 36.223 s | 3 / 6.833 s | 43.057 s | 0 |
| Deliberately stale caller expectation | 7 | 3 | 22.047 s | 3 / 7.019 s | 29.067 s | 1 |
| Fresh run after the decision | 28 | 10 | 34.548 s | 3 / 8.638 s | 43.187 s | 0 |

The signed request and procedure were loaded and their current-head pin checked during each bootstrap. Routine timing includes the local JSON-lines host round trips and journal writes. Both completed runs observed release v5, 8/8 verified artifacts, and 6/6 replay links. Assessment totals came from existing accepted evidence. These are demonstrations on one existing application, not independent benchmark trials.

The executor contains no model callback and recorded zero model invocations **inside the executor**. The stale-input case produced one observed return to the surrounding model, which accepted the verified current state for a current-status request and restarted the full procedure. This is not a provider inference count. Provider tokens, inference requests, and monetary cost were unavailable and remain `null`.

One earlier bridge-development attempt dispatched a descriptor read but lost its stdin channel before receiving the response. Its intent and failure record are retained separately; it is excluded from completed-run timings. The three instrumented runs dispatched 32 Interego calls including bootstrap, all with recorded outcomes. No claim is made that every development attempt succeeded.

After the initial completion, the host discovered FOXXI's signed performance-recording affordance through its advertised manifest authority, signed the request, and invoked that control. The service acknowledged an xAPI performance event for the evidence-review execution, with success and duration `PT36.223S`, and returned a persisted lattice descriptor that was independently readable. The recording happened **outside** the read-only procedure and the timings above. The readable projection had no authorship proof; neither it nor the acknowledgement is described as an independently authenticated raw LRS query. This new execution event is distinct from the historical assessment statement reviewed by the procedure. FOXXI normalized the submitted task identifier in its receipt.

Public aggregate data are in [results.json](../../examples/procedures/results.json). Operational descriptors, statement identifiers, raw assessment evidence, journals, and publication receipts remain in the private evidence bundle. This demo is separate from the completed controller-comparison cohorts and changes none of their results.

## Prose reference and comparison boundary

[The prose reference](../../examples/procedures/prose-reference.md) gives an agent the same task as ordinary instructions. It is an **unmeasured reference**, not an executed competing system. It contains no RDF execution graph. A prose-driven agent may still use discovered Interego affordances, scripts, or caching; no restriction is imposed to manufacture an advantage.

This demonstration establishes that linked routine execution and an explicit decision boundary work. It does not establish lower dollar cost, a causal latency improvement, or superiority over another framework. Those require a separately specified comparison with equivalent access, task conditions, declared script policy, and provider usage metering.

## Run with an existing authenticated MCP host

From a normal repository checkout:

```sh
npm ci
npm run build:core
node --test integrations/procedure-runner/*.test.mjs
node integrations/procedure-runner/stdio.mjs REQUEST_DESCRIPTOR TRUSTED_SIGNER PRIVATE_OUTPUT_DIRECTORY
```

Publish the RDF example through the existing `publish_context` capability, resolve its committed current head, and publish a signed [run request](../../examples/procedures/request.example.ttl) containing those observed publication values and your application inputs. The sample uses `.invalid` placeholders; never treat those as an authority. The request's signer and the procedure's signer must match the host's explicit trusted signer. Every invocation refuses a pin that is no longer the current unambiguous procedure head.

The CLI emits one JSON line per requested MCP operation:

```json
{"kind":"call","id":1,"tool":"get_descriptor","args":{"url":"https://example.invalid/request.ttl"}}
```

The authenticated host mechanically forwards that call to its existing Interego connection and sends one response line:

```json
{"id":1,"result":{"structuredContent":{},"isError":false}}
```

The empty result above illustrates the envelope only; it intentionally cannot pass authority verification. Return the actual MCP response unchanged, or `{"id":1,"transportError":"..."}`. Keep stdin open for the session. An interactive terminal uses raw input to avoid echoing private response bytes. An optional final CLI argument explicitly overrides the expected state CID for a new invocation; the override is journaled. There is no resume cursor.

The CLI writes an exclusive private `events.jsonl` with fsynced, hash-chained intents and outcomes, followed by `result.json`. A hash chain detects accidental alteration against the retained tail; it is not a signature. Store the journal privately: it includes the underlying evidence. The host must preserve transport authorization and avoid retrying an unknown outcome.

The runner allows only `get_descriptor`, `get_current_head`, and `dereference` reads, plus `act` on a uniquely selected, executable, input-free GET control. It uses a bounded data expression language, no dynamic code loading, and a call budget. Signature and content verification come from the authenticated Interego host; the client also checks expected signer and publication bindings. Historical application documents use a narrowly checked legacy JSON-literal decoder with a SHA-256 byte check. New procedures and invocation requests use native RDF.
