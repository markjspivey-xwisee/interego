# Interego Affordant Memory Exchange Profile 0.1

- **Status:** Draft profile — additive to Interego Protocol 1.0
- **Profile IRI:** `https://markjspivey-xwisee.github.io/interego/profiles/affordant-memory/0.1`
- **Representation:** `application/affordance+yaml; profile="https://markjspivey-xwisee.github.io/interego/profiles/affordant-memory/0.1"`

The media type is an unregistered proposal. A conforming implementation must
also offer a registered fallback representation such as JSON-LD or Turtle when
interoperating beyond an explicitly negotiated AMEP deployment.

## Purpose

AMEP turns Affordant YAML-LD Markdown into one substrate for:

- human-to-agent and agent-to-agent acts;
- typed, content-addressed memory;
- signed requests and immutable receipts;
- conflict-preserving branching and explicit composition;
- state-dependent hypermedia controls; and
- deterministic recovery by a previously uninvolved client.

Humans and agents receive different presentations only when a client chooses
to render them differently. Protocol semantics stay identical: the same action
IRI, input shape, authorization policy, precondition, and effect apply to both.

AMEP is a Layer-2 profile. It composes the stable `iep:`, `ie:`, `ieh:`, and
`pgsl:` vocabularies plus PROV, Hydra, SHACL, and Dublin Core. It does not
change Interego L1 or add terms to a core namespace.

## Representation model

An exchange is YAML-LD: YAML parsed into the JSON data model and processed as
JSON-LD with [`context.jsonld`](context.jsonld). Markdown is carried as the
`body` scalar inside `amep:SemanticMaterial`; it is not interleaved with YAML
syntax.

Every representation contains:

1. one `actor`, typed as `prov:Person` or `prov:SoftwareAgent`;
2. one signed `act`;
3. zero or one projected `memory` record;
4. zero or more immutable `receipts`;
5. the current `head` known to the representation; and
6. zero or more state- and authority-dependent `affordances`.

The actor on the exchange and the actor on the act must be the same IRI. A
server may omit controls the actor cannot invoke, but it must not change a
control's semantics for a human versus a software agent.

## Acts and state transitions

| Act | Required lineage input | Result before a later Accept |
|---|---|---|
| `amep:Ask` | none for a new inquiry | an inquiry head |
| `amep:Assert` | `expectedHead` | Candidate memory |
| `amep:Challenge` | `expectedHead`, `challengedAct` | a Candidate sibling branch |
| `amep:Accept` | `expectedHead`, `acceptedAct` | Committed memory |
| `amep:Fork` | `expectedHead`, `parentHead`, `branch` | a named Candidate branch |
| `amep:Compose` | `expectedHead`, at least two sorted unique `operands` | a composed Candidate head |

`expectedHead` is a compare-and-swap precondition, not a suggestion. A server
must reject a stale act instead of overwriting a concurrent head. Both valid
concurrent branches remain dereferenceable. Composition is an explicit act
over a lexicographically sorted set of unique operand IRIs, which makes the
same composition replay to the same semantic input order.

## Memory model

`memoryKind` is one of Observation, Claim, Commitment, Procedure, or
ContextualUse. `governanceStatus` follows this lifecycle:

```text
Candidate ──Accept──▶ Committed ──new lineage──▶ Superseded
    │                      ├────────────────────▶ Retracted
    │                      ├────────────────────▶ Expired
    │                      └────────────────────▶ Redacted
    └──────────── challenge/fork preserves sibling candidates
```

Transport acknowledgement is deliberately separate from governance. An
Applied receipt for Assert, Challenge, Fork, or Compose does **not** make the
memory Committed. Only an Applied Accept projects the accepted memory as
Committed.

Four independent status dimensions must not be collapsed:

- `integrityStatus`: whether a proof was cryptographically verified;
- `conformanceStatus`: whether the representation passed profile validation;
- `epistemicStatus`: Asserted, Hypothetical, Counterfactual, and related L1
  semiotic status; and
- `governanceStatus`: Candidate, Committed, Superseded, Retracted, Expired, or
  Redacted.

## Four identities, not one identifier

AMEP keeps these values distinct:

| Identity | Meaning |
|---|---|
| logical IRI (`@id`) | stable address of the act, memory, or exchange |
| `semanticCid` | SHA-256 of the RDFC-1.0 canonicalized semantic projection |
| `representationTag` | strong HTTP ETag for the complete actor-scoped representation |
| `envelopeCid` | optional content identifier for encrypted wire bytes |

The semantic projection is exactly the object under `memory.semantic` after
local context substitution and JSON-LD expansion. Governance status, receipts,
proof-verification outcomes, representation tags, and envelope identifiers are
outside that projection. Candidate→Committed therefore does not change the
semantic CID.

The profile runner computes:

```text
semanticCid = "urn:cid:rdfc-1.0:sha256:" +
              hex(SHA-256(RDFC-1.0(JSON-LD-to-RDF(memory.semantic))))
```

`representationTag` is the quoted SHA-256 of recursively key-sorted JSON after
removing `representationTag` itself. This makes YAML whitespace and key order
irrelevant while ensuring actor-scoped controls and receipts participate in
the validator.

## Meaning through reuse

A ContextualUse record creates new semantic material that references an
existing memory and repeats its `semanticCid` as `reusedSemanticCid`. The new
interpretation gets its own semantic CID. The reused holon's CID must remain
byte-for-byte identical; recontextualization creates lineage, not mutation.

## Affordances

Every control is both `iep:Affordance` and `hydra:Operation` and carries:

- stable `action` IRI;
- dereferenceable `target` IRI;
- HTTP `method`;
- SHACL `inputShape`; and
- one or more human-readable `effect` descriptions.

Clients discover controls from the current representation. They must not
invent action URLs or assume a control remains available after a transition.

## Receipts and replay

A receipt binds an act IRI to Applied, Rejected, or Duplicate, carries a SHACL
validation report, and identifies the resulting head when applied. Replaying
the same act IRI with identical signed content returns the same receipt. Reuse
of the act IRI with different content is a conflict.

A fresh client can recover by dereferencing the current head, walking receipts
and provenance links, validating every transition, and recomputing semantic
CIDs. No private SDK state is part of the protocol.

## Artifacts

- [`profile.ttl`](profile.ttl) — profile vocabulary and alignments
- [`context.jsonld`](context.jsonld) — YAML-LD/JSON-LD context
- [`shapes.ttl`](shapes.ttl) — SHACL Core and SHACL-SPARQL constraints
- [`http-binding.md`](http-binding.md) — HTTP status, concurrency, and error contract
- [`conformance/`](conformance/) — positive and negative fixtures
- [`examples/release-42.aym.yaml`](examples/release-42.aym.yaml) — complete negotiated exchange

From the repository root:

```bash
npm run test:amep
```

The runner uses a real YAML parser, JSON-LD expansion, RDF conversion, and
RDFC-1.0 canonicalization. Its structural validator is a deterministic mirror
of this profile's shapes and emits SHACL ValidationReport-shaped JSON-LD; it is
not a general-purpose SHACL engine.
