# Pattern: Out-of-Band Auth Exchange

**Layer:** L2 — Architecture (informative pattern).
**Reference runtime:** `applications/foxxi-content-intelligence/src/hypermedia-resources.ts`
(`/api/foxxi/v1/launch-codes` mint + exchange endpoints).
**Status:** Informative. Verticals MAY adopt for cross-origin launch flows.

## Problem

A common hypermedia flow hands control to a second origin: a dashboard
opens a course player, a report viewer, an editor — in a new tab or
window the dashboard does not control. That second origin needs the
caller's credential to act on their behalf.

The path of least resistance is to put the bearer token in the launch
URL (`?bearer=eyJ…`). This leaks a long-lived secret into:

- **Browser history** — persists for the token's whole lifetime.
- **`Referer` headers** — sent to every resource the player loads.
- **Server / proxy / CDN access logs** — often retained for months.
- **Shoulder-surfing + screen-shares** — the URL bar is visible.

A session bearer with an 8-hour TTL sitting in `history.db` is a
standing liability disproportionate to the convenience.

## Pattern

Borrow the shape of OAuth's authorization-code grant / PKCE: **never
put the long-lived credential in the URL — put a short-lived,
single-use code there instead.**

```
 dashboard                    bridge                      player
 (origin A)                                              (origin B)
    │                            │                           │
    │ 1. POST /launch-codes      │                           │
    │    Authorization: Bearer ──▶ mint { code, expiresIn }   │
    │ ◀── { code } ──────────────│                           │
    │                            │                           │
    │ 2. open  …?code=<code>……───┼──────────────────────────▶│
    │                            │                           │
    │                            │ 3. POST /launch-codes/<code>
    │                            │ ◀─────────────────────────│
    │                            │ exchange → { bearer } ────▶│
    │                            │   (code deleted — single-use)
```

1. **Mint.** The dashboard POSTs to the bridge's mint endpoint with its
   own bearer in the `Authorization` header. The bridge stores the
   bearer against a fresh random code and returns the code.
2. **Hand off.** The code travels in the launch URL — not the bearer.
3. **Exchange.** The second origin POSTs the code back; the bridge
   returns the bearer **and deletes the code**. The code is consumed on
   first read whether or not it had expired, so a replayed code is
   always spent.

### Code properties

| Property | Value | Rationale |
|---|---|---|
| Lifetime | ~120 s | Long enough to open a tab; short enough that a leaked URL is stale before anyone reads the log. |
| Uses | Exactly one | Deleted on exchange. Replay yields 404. |
| Entropy | ≥ 192 bits random | Not guessable; not derived from the bearer. |
| Store cap | Bounded + swept | The in-memory map is capped and TTL-swept so it cannot grow without bound. |

The code still appears in the URL — but it is single-use and expires in
two minutes. By the time a code reaches a log file or history entry it
is almost certainly already spent or expired. The 8-hour bearer never
touches a URL at all.

## Hypermedia integration

The pattern composes with templated links (Hydra `IriTemplate`). A
`launch` link declares its `code` variable as **`fromExchange`** rather
than **`fromSession`**:

```jsonc
"launch": {
  "href": "https://player…/?bridge=…&course_id=…&code={code}&learner_did={learner_did}",
  "templated": true,
  "mapping": [
    { "variable": "code", "required": true,
      "fromExchange": { "mintUrl": "https://bridge…/api/foxxi/v1/launch-codes", "method": "POST" } },
    { "variable": "learner_did", "required": true, "fromSession": "actorDid" }
  ]
}
```

A client expanding the template sees `fromExchange`, performs the mint
round-trip, and substitutes the returned code. Non-secret variables
(`learner_did`, `learner_name`) stay `fromSession` — they are not
sensitive and need no indirection.

Because the mint round-trip is asynchronous, a client opening a popup
must open the window **synchronously inside the click gesture** (to
survive popup blockers) and navigate it once the URL resolves.

## Layering

L2 pattern, **no new `iep:` term**. The mint/exchange endpoints are
ordinary HTTP resources; the code store is bridge-local state. The
`fromExchange` marker lives in the affordance/link-serialization shape
(vertical infrastructure), not in the L1 ontology. A vertical that does
not open cross-origin surfaces never needs it.

## Relationship to other mechanisms

- **Not a replacement for token verification.** The bridge still
  verifies the bearer on every protected call. The exchange only moves
  *where* the bearer travels; it does not grant authority.
- **Not ABAC.** Resource-scoped affordances (see
  `resource-scoped-affordances.md`) decide *what is advertised*; ABAC
  decides *who may invoke*; this pattern decides *how the credential
  reaches a second origin safely*. The three are orthogonal.
