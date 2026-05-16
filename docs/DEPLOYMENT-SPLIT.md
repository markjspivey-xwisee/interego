# Splitting a vertical bridge into audience-specific deployments

Closes the "per-vertical operator-side bridges as standalone
deployments" item from the [`STATUS.md`](../STATUS.md) "Honest
remaining work" list. Both first-party verticals (LPC + OWM) ship
their bridge as a single process exposing every audience's affordances
by default. For institutional / enterprise deployments where the
operator-only surface needs to live behind stricter network policy
than the protagonist-facing surface, the bridges support splitting
via a single environment variable. This page documents the pattern.

## What the verticals already separate

Each vertical's affordances are declared in two arrays:

| Vertical | Protagonist array | Institutional array |
|---|---|---|
| LPC | [`lpcAffordances`](../applications/learner-performer-companion/affordances.ts) | [`lpcEnterpriseAffordances`](../applications/learner-performer-companion/affordances.ts) |
| OWM | [`owmAffordances`](../applications/organizational-working-memory/affordances.ts) | [`owmOperatorAffordances`](../applications/organizational-working-memory/affordances.ts) |

The two arrays are declared separately (so the dual-audience
discipline in [`DUAL-AUDIENCE.md`](DUAL-AUDIENCE.md) is enforced at
the source level), then concatenated at bridge startup. The split
deployment turns this concatenation into a runtime choice.

## Splitting via environment variable

Both bridge entry points respect an `<VERTICAL>_AUDIENCE` env var:

| Vertical | Env var | Values |
|---|---|---|
| LPC | `LPC_AUDIENCE` | `learner` \| `institutional` \| `both` (default) |
| OWM | `OWM_AUDIENCE` | `contributor` \| `operator` \| `both` (default) |

Example: a separate operator-only OWM deployment behind a stricter
firewall:

```bash
# Operator deployment (internal network only)
OWM_AUDIENCE=operator \
PORT=6060 \
OWM_DEFAULT_POD_URL=https://operator-pod.acme.example/ \
npx tsx applications/organizational-working-memory/bridge/server.ts

# Contributor deployment (employee-facing network)
OWM_AUDIENCE=contributor \
PORT=6061 \
OWM_DEFAULT_POD_URL=https://contributor-pod.acme.example/ \
npx tsx applications/organizational-working-memory/bridge/server.ts
```

The two processes share the same source tree + the same affordance
declarations; they differ only in which subset of affordances the
runtime exposes. Discovery (`GET /affordances`) reflects the active
subset; the MCP `tools/list` is derived from the affordance
manifest, so a client connected to the operator-only deployment sees
only the operator-side tools.

## Why this is a configuration change, not a code change

Three structural properties make the split a configuration change:

1. **Affordance arrays are already separate.** The dual-audience
   discipline requires every audience get its own array in
   `affordances.ts`. The merge at startup is the only place they
   were entangled.
2. **Handlers are name-keyed.** The `handlers` object indexes by
   action name; an audience's handlers stay declared in the same
   file but the bridge only routes to handlers whose names appear
   in the active affordance set.
3. **The protocol contract is per-affordance, not per-deployment.**
   A client discovers a `cg:Affordance` and follows
   `hydra:target`; nothing in the contract requires every
   affordance be hosted on the same origin. Splitting hosts is
   transparent to clients.

## When to split

Split when:
- the operator-side affordances need network isolation (different
  VPC, different ingress controller, internal-only)
- different audit / logging policies apply to the two audiences
- different rate-limiting / authentication regimes apply
- the operator-side affordances write to a separate pod scope that
  the protagonist-side runtime should never reach

Don't split when:
- you just want a logical separation (the unified deployment +
  client-side audience filtering is simpler)
- the deployment is small enough that one process suffices

## Pod scope hygiene

Splitting the bridge doesn't automatically split the pod scope. If
the operator-only deployment writes to a different pod URL, configure
`<VERTICAL>_DEFAULT_POD_URL` accordingly. The ABAC layer's
`PolicyContext` resolution treats the pod URL as the authority
boundary; pod-side ABAC + the bridge-side audience split together
give defence in depth.

## Beyond the first-party verticals

Any vertical that follows the dual-audience discipline gets the same
split for free — declare two affordance arrays, switch on an env
var at startup. The pattern is documented here as the reference
recipe; new verticals should follow it from day one rather than
retrofit it later.
