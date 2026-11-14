/**
 * Guest access decisions: what a provisional guest may do in an application, decided from the
 * guest's attributes by policies that are data.
 *
 * Identity states facts about a guest (`guestAttributes` in its exchange and introspection
 * answers). `guestAttributeGraph` turns those facts into an attribute graph, `guestPolicies` is a
 * standard policy set for one application, and `decide` evaluates an action against them. A
 * decision is DEFAULT-DENY: only a Permit that applies, with no Deny that applies, allows.
 *
 * This file has no imports and uses nothing but the language, so the css-gate (plain ESM in its
 * own image), the relay and any bridge can load it. `deploy/css-gate/guest-access.mjs` is a
 * byte-identical copy, and `applications/_shared/tests/guest-access.test.ts` holds both to that
 * and to `@interego/abac`: `evaluateGuestPolicies` is a port of that package's `evaluate`
 * (deny-overrides, Indeterminate when nothing matches) restricted to graphs made of direct
 * attribute statements, and the test compares the two on the same policies and graphs.
 *
 * The policies are `iep:AccessControlPolicy`-shaped records ({ id, policyPredicateShape,
 * governedAction, deonticMode }) and their predicates are the mini-SHACL shapes `@interego/abac`
 * evaluates ({ iri, constraints: [{ path, minCount, hasValue, inValues, minInclusive,
 * maxInclusive, pattern }] }). The attribute and action names are this helper's own vocabulary
 * (`guest:`, ontology/guest.ttl beside this file): deployment terms, not protocol terms.
 */

/** The attribute paths of a guest's graph. */
export const GUEST = Object.freeze({
  provisional: 'guest:provisional',
  claimed: 'guest:claimed',
  createdAt: 'guest:createdAt',
  expiresAt: 'guest:expiresAt',
  ageSeconds: 'guest:ageSeconds',
  secondsRemaining: 'guest:secondsRemaining',
  admittedBy: 'guest:admittedBy',
  hostedTermsVersion: 'guest:hostedTermsVersion',
  proofKeyThumbprint: 'guest:proofKeyThumbprint',
});

/** The actions the standard policies govern. */
export const GUEST_ACTIONS = Object.freeze({
  /** Use the application as this guest (an application's own admission decision). */
  useApplication: 'guest:UseApplication',
  /** Write the application's bounded checkpoint documents in the guest's own pod (the css-gate). */
  writeCheckpoint: 'guest:WriteCheckpoint',
});

export class GuestAccessError extends Error {
  constructor(code) { super(code); this.name = 'GuestAccessError'; this.code = code; }
}

const ORIGIN = /^https?:\/\/[A-Za-z0-9.-]+(?::[0-9]{1,5})?$/;
const isOrigin = value => typeof value === 'string' && value.length <= 256 && ORIGIN.test(value);
const isSeconds = value => Number.isSafeInteger(value) && value > 0;

/**
 * The attribute graph of a guest, from the facts identity states about it and this verifier's
 * clock. `facts` must be identity's own answer (its exchange or introspection response), never a
 * value a guest or an application supplied.
 *
 * facts: { subject, provisional, claimed, createdAt, expiresAt, admittedBy, proofKeyThumbprint,
 *          hostedTermsVersion? }, times in Unix seconds, `admittedBy` the application origins that
 * have admitted or used the guest.
 *
 * Throws GuestAccessError('invalid_guest_facts') for anything malformed: a graph is never built
 * from part of an answer. `guest:secondsRemaining` and `guest:ageSeconds` are derived here, so a
 * policy can bound them with a plain number.
 */
export function guestAttributeGraph(facts, nowMs = Date.now()) {
  const f = facts;
  if (!f || typeof f !== 'object' || Array.isArray(f)
    || typeof f.subject !== 'string' || !/^did:web:[A-Za-z0-9.:%-]+:users:[A-Za-z0-9-]{1,64}$/.test(f.subject)
    || f.provisional !== true || typeof f.claimed !== 'boolean'
    || !isSeconds(f.createdAt) || !isSeconds(f.expiresAt) || f.expiresAt <= f.createdAt
    || !Array.isArray(f.admittedBy) || f.admittedBy.length > 64 || !f.admittedBy.every(isOrigin)
    || new Set(f.admittedBy).size !== f.admittedBy.length
    || typeof f.proofKeyThumbprint !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(f.proofKeyThumbprint)
    || (f.hostedTermsVersion !== undefined && (typeof f.hostedTermsVersion !== 'string'
      || !f.hostedTermsVersion || f.hostedTermsVersion.length > 64))
    || !Number.isFinite(nowMs)) throw new GuestAccessError('invalid_guest_facts');
  const now = Math.floor(nowMs / 1000);
  const attributes = new Map([
    [GUEST.provisional, [true]],
    [GUEST.claimed, [f.claimed]],
    [GUEST.createdAt, [f.createdAt]],
    [GUEST.expiresAt, [f.expiresAt]],
    [GUEST.ageSeconds, [Math.max(0, now - f.createdAt)]],
    [GUEST.secondsRemaining, [f.expiresAt - now]],
    [GUEST.admittedBy, [...f.admittedBy]],
    [GUEST.proofKeyThumbprint, [f.proofKeyThumbprint]],
    ...(f.hostedTermsVersion !== undefined ? [[GUEST.hostedTermsVersion, [f.hostedTermsVersion]]] : []),
  ]);
  // The shape of an `@interego/abac` AttributeGraph: no facets, direct statements only.
  return { subject: f.subject, facets: [], sources: new Map(), attributes };
}

/** One constraint of a predicate shape against the graph: `@interego/abac`'s checkConstraint. */
function violations(graph, c) {
  const values = (graph.attributes?.get(c.path) ?? []).filter(v => v !== undefined && v !== null);
  if (c.minCount !== undefined && values.length < c.minCount) return 1;
  let count = 0;
  if (c.hasValue !== undefined && !values.some(v => String(v) === c.hasValue)) count++;
  if (c.inValues !== undefined) for (const v of values) if (!c.inValues.includes(String(v))) count++;
  if (c.minInclusive !== undefined) {
    for (const v of values) {
      const n = typeof v === 'number' ? v : parseFloat(String(v));
      if (Number.isFinite(n) && n < c.minInclusive) count++;
    }
  }
  if (c.maxInclusive !== undefined) {
    for (const v of values) {
      const n = typeof v === 'number' ? v : parseFloat(String(v));
      if (Number.isFinite(n) && n > c.maxInclusive) count++;
    }
  }
  if (c.pattern !== undefined) {
    const re = new RegExp(c.pattern);
    for (const v of values) if (!re.test(String(v))) count++;
  }
  return count;
}

/**
 * `@interego/abac`'s `evaluate` over a graph of direct attribute statements: a policy applies when
 * it governs `action` and every constraint of its predicate holds; Deny overrides Permit; a Duty
 * allows; nothing applying is Indeterminate. `predicates` is a Map from shape IRI to shape, and a
 * policy whose shape is not in it is skipped, as there.
 */
export function evaluateGuestPolicies(policies, predicates, graph, action) {
  let permitted = false;
  let denied = false;
  const matchedPolicies = [];
  for (const policy of policies) {
    const predicate = predicates.get(policy.policyPredicateShape);
    if (!predicate) continue;
    if (action !== policy.governedAction) continue;
    if (predicate.constraints.some(c => violations(graph, c) > 0)) continue;
    if (policy.deonticMode === 'Deny') denied = true;
    else if (policy.deonticMode === 'Permit' || policy.deonticMode === 'Duty') permitted = true;
    else continue;
    matchedPolicies.push(policy.id);
  }
  if (denied) return { verdict: 'Denied', matchedPolicies };
  if (permitted) return { verdict: 'Allowed', matchedPolicies };
  return { verdict: 'Indeterminate', matchedPolicies: [] };
}

/**
 * Decide `action` for the guest whose graph is `graph` under `policySet` ({ policies, predicates }).
 * Default-deny: `allowed` is true only for the verdict Allowed. Indeterminate (no policy applies,
 * or the graph is missing) is a refusal here, never a grant, and so is anything that throws.
 */
export function decide(action, policySet, graph) {
  try {
    if (typeof action !== 'string' || !graph || !(graph.attributes instanceof Map)
      || !policySet || !Array.isArray(policySet.policies) || !(policySet.predicates instanceof Map)) {
      return { allowed: false, verdict: 'Indeterminate', reason: 'default-deny: nothing to evaluate', matchedPolicies: [] };
    }
    const result = evaluateGuestPolicies(policySet.policies, policySet.predicates, graph, action);
    if (result.verdict === 'Allowed') return { allowed: true, verdict: 'Allowed', reason: `permitted by ${result.matchedPolicies.join(', ')}`, matchedPolicies: result.matchedPolicies };
    if (result.verdict === 'Denied') return { allowed: false, verdict: 'Denied', reason: `denied by ${result.matchedPolicies.join(', ')}`, matchedPolicies: result.matchedPolicies };
    return { allowed: false, verdict: 'Indeterminate', reason: 'default-deny: no policy permits this action', matchedPolicies: [] };
  } catch {
    return { allowed: false, verdict: 'Indeterminate', reason: 'default-deny: the decision could not be made', matchedPolicies: [] };
  }
}

/**
 * The standard policy set of one application, as data:
 *   - a provisional guest this application has admitted, whose deadline has not passed, may do
 *     each action in `provisionalMay`;
 *   - one that has also enrolled a credential (a claimed owner) may do each action in `claimedMay`;
 *   - a guest whose deadline has passed is denied every action named (an explicit Deny, which
 *     overrides any Permit an application adds beside these).
 * `hostedTermsVersion`, where given, is required of both.
 *
 * Every constraint a Permit rests on carries minCount 1: a constraint over no values holds
 * vacuously in SHACL, and a missing attribute must never satisfy a Permit.
 */
export function guestPolicies(options) {
  const { application, provisionalMay = [], claimedMay = [], hostedTermsVersion } = options ?? {};
  if (!isOrigin(application) || !Array.isArray(provisionalMay) || !Array.isArray(claimedMay)
    || ![...provisionalMay, ...claimedMay].every(a => typeof a === 'string' && a.length > 0 && a.length <= 256)
    || (hostedTermsVersion !== undefined && (typeof hostedTermsVersion !== 'string' || !hostedTermsVersion))) {
    throw new GuestAccessError('invalid_guest_policy_options');
  }
  const base = `urn:interego:guest-access:${application}`;
  const live = [
    { path: GUEST.admittedBy, minCount: 1, hasValue: application },
    { path: GUEST.secondsRemaining, minCount: 1, minInclusive: 1 },
    ...(hostedTermsVersion !== undefined ? [{ path: GUEST.hostedTermsVersion, minCount: 1, hasValue: hostedTermsVersion }] : []),
  ];
  const shapes = [
    { iri: `${base}#provisional-guest`, constraints: [{ path: GUEST.provisional, minCount: 1, hasValue: 'true' }, ...live] },
    { iri: `${base}#claimed-owner`, constraints: [{ path: GUEST.claimed, minCount: 1, hasValue: 'true' }, ...live] },
    { iri: `${base}#deadline-passed`, constraints: [{ path: GUEST.secondsRemaining, minCount: 1, maxInclusive: 0 }] },
  ];
  const policies = [];
  const policy = (name, shape, action, deonticMode) => policies.push({
    id: `${base}#${name}:${action}`, policyPredicateShape: shape.iri, governedAction: action, deonticMode });
  for (const action of new Set(provisionalMay)) policy('permit-provisional-guest', shapes[0], action, 'Permit');
  for (const action of new Set(claimedMay)) policy('permit-claimed-owner', shapes[1], action, 'Permit');
  for (const action of new Set([...provisionalMay, ...claimedMay])) policy('deny-deadline-passed', shapes[2], action, 'Deny');
  return { policies, predicates: new Map(shapes.map(shape => [shape.iri, shape])) };
}
