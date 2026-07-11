# AMEP 0.1 HTTP binding

## Negotiation

Clients request the profile explicitly:

```http
Accept: application/affordance+yaml; profile="https://markjspivey-xwisee.github.io/interego/profiles/affordant-memory/0.1"
```

Responses include:

```http
Content-Type: application/affordance+yaml; profile="https://markjspivey-xwisee.github.io/interego/profiles/affordant-memory/0.1"
Link: <https://markjspivey-xwisee.github.io/interego/profiles/affordant-memory/0.1>; rel="profile"
ETag: "sha256-…"
```

`application/affordance+yaml` is an unregistered proposal. Implementations
must make an established RDF representation available through normal content
negotiation for clients that do not opt into the proposal.

## Read and act

`GET` on an exchange or head returns its actor-scoped projection and current
affordances. A client submits an advertised act to the control's `target` using
the advertised `method` and sends both concurrency preconditions:

```http
If-Match: "sha256-<representation hash>"
Content-Type: application/affordance+yaml; profile="https://markjspivey-xwisee.github.io/interego/profiles/affordant-memory/0.1"
```

The act body also carries `expectedHead`. `If-Match` protects the negotiated
wire projection; `expectedHead` protects semantic lineage. Passing one does not
waive the other.

## Success and idempotency

An applied act returns `201 Created` for a new receipt or `200 OK` for replay of
an identical act. The response includes:

```http
Location: <receipt IRI>
ETag: "sha256-<new representation hash>"
Link: <result head IRI>; rel="latest-version"
```

An act's `@id` is its idempotency key. Reusing the IRI with different canonical
act bytes returns `409 Conflict`.

## Failure contract

Errors use RFC 9457 Problem Details in `application/problem+json`. Extensions
are namespaced by this profile.

| Condition | Status | Required behavior |
|---|---:|---|
| malformed YAML or JSON-LD | 400 | identify syntax failure without processing an act |
| authentication required | 401 | advertise the applicable authentication challenge |
| actor authenticated but unauthorized | 403 | reveal no current head, memory, policy internals, or affordances |
| reused act IRI with different content | 409 | identify the idempotency conflict |
| stale `If-Match` or `expectedHead` | 412 | preserve every existing branch and provide a safe rediscovery link |
| shape/profile violation | 422 | include a SHACL ValidationReport-shaped `validationReport` |
| unsupported media type/profile | 415 | identify supported representations/profiles |

The supplied examples are conformance fixtures:

- [`examples/stale-head.problem.json`](examples/stale-head.problem.json)
- [`examples/invalid-act.problem.json`](examples/invalid-act.problem.json)
- [`examples/forbidden.problem.json`](examples/forbidden.problem.json)

The 403 fixture intentionally contains no head, target resource state, hidden
policy reason, or affordance list. Authorization failure must not become a
metadata oracle.

