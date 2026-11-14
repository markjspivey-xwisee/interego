# @interego/abac

Attribute-Based Access Control over @interego/core descriptors. Policy evaluator + attribute resolver + decision cache + SHACL-shape policy validation.

Particular composition over the `@interego/core` substrate — see
`docs/ARCHITECTURAL-FOUNDATIONS.md §12` for the substrate-vs-vertical
split that motivates this package boundary.

Interego has access control at L1 (the AccessControl facet: a policy is a predicate shape, a governed action and a deontic mode; Deny overrides Permit) and the evaluation pattern at L2 (`abac:`, `docs/ns/abac.ttl`). This package is the reference runtime, and it is meant to be what a deployed service decides with, in place of a rule written into its code.

## Two entry points

- `@interego/abac`: `evaluate(policies, predicates, context)`, `resolveAttributes`, `filterAttributeGraph`, `createDecisionCache`. Needs `@interego/core`.
- `@interego/abac/portable` (`portable/abac-portable.mjs`): the same decision with **no imports**, for a deployable that cannot carry the package (plain ESM, a one-dependency image). It is the single source: such a deployable keeps a byte-identical copy (the css-gate's `deploy/css-gate/abac-portable.mjs`), and `tests/abac-portable.test.ts` holds each copy to these bytes and `evaluatePolicies` to `evaluate` on the same policies and graphs. A new copy is one more path in that test's list.

## One subject model

Every principal is a subject with attributes. A registered owner, a delegated agent, a service account and a provisional guest differ in the values, not in the mechanism:

```js
subjectAttributeGraph({ subject: ownerDid, provisional: false, roles: ['admin'] })
subjectAttributeGraph({ subject: agentDid, provisional: false, onBehalfOf: ownerDid })
subjectAttributeGraph({ subject: guestDid, provisional: true, claimed: false, standingUntil, admittedBy: [origin] })
```

The facts must be an authority's own answer about the subject (identity's introspection, a tenant directory's row), never something the subject sent. The paths are declared in `docs/ns/passport.ttl` (`passport:provisional`, `passport:claimed`, `passport:role`, `passport:linkedTo`, …) and `docs/ns/abac.ttl` (`abac:secondsRemaining`, `abac:ageSeconds`, `abac:useService`). Anything malformed, an unknown member included, throws: a graph is never built from part of an answer.

## Attributing usage to a main account

`canonicalSubject(facts)` answers whom a decision or a usage record belongs to: the main account when the authority states the subject is `linkedTo` one, else the subject itself, with the acting subject in `also`. A vertical keys what it keeps per person (a learner record, a consultant, a quota) on `canonicalSubject(facts).subject` and records `also` beside it, so a guest's usage becomes the main account's the moment the authority states the link, and nothing written before is rewritten. Identity states `linkedTo` for a general guest that its owner linked to a registered account, and only while that account's own record lists the guest (`deploy/identity/PROVISIONAL-PLAY.md`, "Linking a guest to an account"); the coached world admits by it.

## Adopting it at a decision point: shadow, then enforce

A service that already decides with a fixed rule keeps that rule deciding and runs the policy beside it. `decideInShadow` returns the existing rule's answer and logs one small record when the policy disagrees (the point, the action, the subject, both answers, the matching policies; no attribute value and nothing of the request). When the log has been quiet for long enough, a setting moves the point to `enforce` and the policy decides, default-deny.

```ts
import { decideInShadow, subjectAttributeGraph } from '@interego/abac/portable';

// The rule as data: an administrator of this tenant may manage it.
const policySet = {
  policies: [{ id: 'urn:example:policy:admins-manage', policyPredicateShape: 'urn:example:shape:admin',
    governedAction: 'urn:example:action:manage', deonticMode: 'Permit' }],
  predicates: new Map([['urn:example:shape:admin', { iri: 'urn:example:shape:admin',
    constraints: [{ path: 'passport:role', minCount: 1, hasValue: 'admin' }] }]]),
};

function mayManage(caller, mode /* 'shadow' unless the operator set 'enforce' */) {
  const existing = caller.roles.includes('admin');                       // the rule the service has today
  let graph = null;
  try { graph = subjectAttributeGraph({ subject: caller.did, provisional: false, roles: caller.roles }); } catch { /* refused below */ }
  return decideInShadow({ point: 'example.manage', mode, existing, action: 'urn:example:action:manage',
    policySet, graph, log: record => console.warn(JSON.stringify(record)) });
}
```

Three rules for a policy that grants:

- **Default-deny is in `decide`, not in a policy.** Under deny-overrides, a "deny everything" policy would override every Permit. `decide` allows only on the verdict `Allowed`; `Indeterminate` (nothing applied) refuses.
- **Every constraint a Permit rests on carries `minCount: 1`.** A SHACL constraint over no values holds vacuously, so without it a missing attribute satisfies the Permit.
- **Read the mode in the server's entry file** and pass it in. Shadow is the default and what any value but `enforce` means.

## Where it decides today

- `deploy/css-gate/provisional-play.mjs`: what a general guest may write (`deploy/identity/PROVISIONAL-PLAY.md`, "Policy at the css-gate"). Enforcing; it is a new surface with no earlier rule to shadow.
- `packages/pgsl-store/src/abac-pdp.ts`: the atom-granular read decision, for a mediator.

No rule that guards registered principals in a deployed service runs under `decideInShadow` yet.
