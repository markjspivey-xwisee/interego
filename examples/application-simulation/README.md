# Application simulation — L3 reference example

`simulateApplication` previews the existing Application Lab `signed-domain/v1`
contract dialect. Tic-Tac-Toe and Release Control use the same resolver, guard
evaluator, effect evaluator, receipt preparation, and replay verifier. Their
domain rules are data in `rule-packs.ts`; the simulator has no application-name
dispatch, game callbacks, approval policy, or infrastructure adapter.

```bash
node --import tsx examples/application-simulation/run.ts
npx vitest run tests/application-simulation.test.ts tests/application-effects-purity.test.ts
node --import tsx deploy/mcp-relay/_application-lab-test.ts
```

The demo prints both frontiers and their source bindings. All fixture writes
remain zero. The adapter creates canonical JSON envelopes and real SHA-256
document digests locally. Descriptor CIDs and signature-verifier results are
explicit test doubles. These fixtures establish interpreter behavior, not live
signature verification or a production deployment.

## Audit and boundary

This is an implementation audit of the Application Lab path, with a source check
of `packages/core/src/affordance`, `packages/core/src/kernel`, and the PGSL runtime
evaluator for Tic-Tac-Toe/Release Control dispatch. It is not a proof of neutrality
for every package in the monorepo.

| Concern | Finding and implementation |
| --- | --- |
| Matching | Application Lab already interprets declarative guards and payload declarations. Candidate enumeration was missing; preview now enumerates declared choices and implicit Boolean domains. |
| State transition | Preview calls `prepareApplicationAction`, the same function execution uses. No second guard/effect interpreter is introduced. |
| Purity | Resolved effect values could alias caller data; later effects could mutate that input. Every inserted value now becomes an owned JSON value. Prepared receipt payloads are also detached. |
| Object paths | Traversal could reach inherited objects. Reads now follow own properties, and effect paths reject empty and prototype-related segments. Missing effect references fail JSON validation. |
| Unknown predicates | `none` could interpret an unsupported nested predicate as zero matches. Predicate support now propagates through collection guards and updates, including empty collections. |
| Domain semantics | Board geometry, turns, winning lines, approval uniqueness, and the two-approval threshold belong solely to the fixture contracts. No L1 ontology or kernel API changes are needed. |
| Authority | Resolution supplies catalog, contract, state, and complete replay bindings. Preview requires a matching head and preserves those bindings in its result. |
| Rewrite Mesh | This example covers one-step JSON contract simulation. It does not implement RDF graph-rewrite matching, a general mesh search, or synthesis of new rules. No such implementation was found in this source tree. |

The Tic-Tac-Toe fixture models alternating marks and explicit win/draw declarations;
it does not assign player identities. The Release Control fixture models approval
and deployment *state*. It performs no Railway, GitHub, shell, or other infrastructure
operation. Neither fixture replaces the live application's existing contract.

## Preview contract

Resolve an application with `resolveApplicationLab`, then pass that resolved value
to `simulateApplication` with an explicit actor, timestamp, and expected state CID.
The simulator accepts no read or write capability and does not obtain the time.
Returned JSON is detached from the caller's inputs.

An alternative is `simulated`, `refused` with the executor's reason, or
`needs-input`. Finite declared options are deduplicated and enumerated in stable
order; optional omission and null are included because the executor accepts them.
Boolean inputs without options are finite. An explicitly empty required option
set has no candidates and remains visible in the action coverage list.

Strings, numbers, and other open inputs require caller-supplied samples for concrete
previews. The open-space marker remains even when a sample succeeds: samples cannot
establish completeness. Verified evidence must be obtained before preview through
the existing evidence resolver; passing evidence-shaped JSON does not grant trust.

The default budget is 256 alternatives. Overflow rejects the entire call. Ordering
uses code-point comparison and canonical JSON, so action/option discovery order
does not rank candidates. Changed contract bytes still change the contract digest
and receipts, even if their candidate semantics happen to agree.

Each successful alternative includes a provisional successor, its document digest,
receipt digest, JSON Pointer changes, and a change count. Object changes recurse;
an array change counts as one replacement. These counts describe state differences,
not utility, confidence, or a recommendation. Preview never selects an action.

Selection does not authorize a write. The caller must re-resolve current authority,
contract, evidence, and head, then execute through the existing authenticated path.
The live `preview_application_action` tool wraps this same pure simulator. It
requires the observed state CID and active contract digest, resolves signed
authority and evidence afresh, and binds actor and time on the server. It checks
authority again before returning. The Application Lab's **Preview changes** button
calls that tool each time and displays the proposed changes separately from
authoritative state. It discards responses after edits, rediscovery, or application
switching. Execution remains a separate confirmed action with independent checks.

The preview tool receives only read adapters, skips session pod initialization
and directory registration, and is classified for OAuth read scope. Its narrow
same-origin session bridge also makes it callable through the existing generic
`act` tool when a client's named tool catalog is stale. That returns live JSON;
mounting the native Lab still requires the host to expose `open_application_lab`.
No production code imports these example rule packs or fixture verifier doubles.

## Acceptance coverage

Tests freeze inputs and reject network/implicit-clock calls during preview. They
compare every successful initial candidate with the executor's prepared successor,
then explicitly record selected transitions in the in-memory fixture adapter and
verify complete replay. They also cover denied alternatives, input-space gaps,
candidate-budget overflow, stale heads, a state fork, missing history, and tampered
document digest, authorship, and CID bindings. The evaluator regressions reproduce
input aliasing and prototype traversal before the fix.
