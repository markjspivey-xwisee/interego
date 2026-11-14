/**
 * @interego/abac, portable: the policy decision for any deployable, with no imports.
 *
 * THE SINGLE SOURCE. `@interego/abac/portable` resolves to this file. A deployable whose image
 * cannot carry the package (the css-gate: plain ESM, one dependency) keeps a byte-identical copy
 * (`deploy/css-gate/abac-portable.mjs`), and `tests/abac-portable.test.ts` holds every copy to
 * these bytes and holds `evaluatePolicies` to the package's `evaluate` on the same policies and
 * graphs. Change this file, then copy it.
 *
 * What it gives:
 *   - `subjectAttributeGraph(facts, nowMs)`: ONE subject model for every principal. A registered
 *     owner, a delegated agent, a service account and a provisional guest are all a subject with
 *     attributes; "provisional", "claimed", "linkedTo", "admittedBy" and "role" are attribute
 *     VALUES, not kinds of account. The facts must be an authority's own answer about the subject
 *     (an identity service's introspection, a tenant directory's row), never the subject's request.
 *   - `evaluatePolicies(policies, predicates, graph, action)`: the package's `evaluate` (L1 deontic
 *     combination: Deny overrides Permit, a Duty permits, nothing applying is Indeterminate) over
 *     graphs made of direct attribute statements.
 *   - `decide(action, policySet, graph)`: DEFAULT-DENY. Only an applicable Permit with no
 *     applicable Deny allows. Indeterminate, a missing graph and anything that throws refuse.
 *   - `decideInShadow(...)`: adopt a policy beside an existing fixed rule. In shadow mode the
 *     existing rule decides and a disagreement is logged; in enforce mode the policy decides.
 *   - `provisionalSubjectPolicies(...)`: a standard policy set for provisional subjects.
 *   - `canonicalSubject(facts)`: whom to attribute a decision or a usage record to when the
 *     authority states the subject is linked to a main account.
 *
 * Policies are `iep:AccessControlPolicy` records ({ id, policyPredicateShape, governedAction,
 * deonticMode }); predicates are the mini-SHACL shapes of `abac:` ({ iri, constraints: [{ path,
 * minCount, hasValue, inValues, minInclusive, maxInclusive, pattern }] }). Attribute paths are
 * declared in docs/ns/passport.ttl (an identity's standing) and docs/ns/abac.ttl (what the
 * evaluator derives, and the coarse action).
 */

/** Attribute paths of a subject's graph. */
export const SUBJECT = Object.freeze({
  provisional: 'passport:provisional',
  claimed: 'passport:claimed',
  establishedAt: 'passport:establishedAt',
  standingUntil: 'passport:standingUntil',
  admittedBy: 'passport:admittedBy',
  linkedTo: 'passport:linkedTo',
  role: 'passport:role',
  onBehalfOf: 'iep:onBehalfOf',
  acceptedTermsVersion: 'passport:acceptedTermsVersion',
  proofKeyThumbprint: 'passport:proofKeyThumbprint',
  ageSeconds: 'abac:ageSeconds',
  secondsRemaining: 'abac:secondsRemaining',
});

/** Action IRIs the standard policies govern. Any IRI may be a governed action; these two are common. */
export const ACTIONS = Object.freeze({
  /** Use a service as this subject at all: the coarsest action a decision point guards. */
  useService: 'abac:useService',
  /** Publish (write) to a resource the subject may write. */
  publish: 'iep:canPublish',
});

export class AbacPortableError extends Error {
  constructor(code) { super(code); this.name = 'AbacPortableError'; this.code = code; }
}

const ORIGIN = /^https?:\/\/[A-Za-z0-9.-]+(?::[0-9]{1,5})?$/;
const isOrigin = value => typeof value === 'string' && value.length <= 256 && ORIGIN.test(value);
const isSeconds = value => Number.isSafeInteger(value) && value > 0;
const isIri = value => typeof value === 'string' && value.length > 0 && value.length <= 2048 && !/\s/.test(value);
const isName = value => typeof value === 'string' && /^[A-Za-z0-9._:-]{1,64}$/.test(value);
const distinct = (list, ok, max) => Array.isArray(list) && list.length <= max && list.every(ok) && new Set(list).size === list.length;

/**
 * The attribute graph of a subject, from the facts an authority states about it and this
 * verifier's clock.
 *
 * facts: { subject, provisional, claimed?, establishedAt?, standingUntil?, admittedBy?, linkedTo?,
 *          roles?, onBehalfOf?, acceptedTermsVersion?, proofKeyThumbprint? }
 *   - `subject`: the subject's IRI (a DID).            - `provisional`: boolean, always stated.
 *   - `establishedAt`, `standingUntil`: Unix seconds.  - `admittedBy`: service origins.
 *   - `linkedTo`: the IRI of the subject this one is linked to (its main account).
 *   - `roles`: short names a directory states.         - `onBehalfOf`: a delegated agent's owner.
 *
 * Throws AbacPortableError('invalid_subject_facts') for anything malformed: a graph is never
 * built from part of an answer, and an unknown member is refused instead of ignored.
 * `abac:secondsRemaining` and `abac:ageSeconds` are derived here, so a policy bounds them with a
 * plain number.
 */
export function subjectAttributeGraph(facts, nowMs = Date.now()) {
  const f = facts;
  const known = ['subject', 'provisional', 'claimed', 'establishedAt', 'standingUntil', 'admittedBy', 'linkedTo', 'roles', 'onBehalfOf',
    'acceptedTermsVersion', 'proofKeyThumbprint'];
  if (!f || typeof f !== 'object' || Array.isArray(f) || Object.keys(f).some(key => !known.includes(key))
    || !isIri(f.subject) || typeof f.provisional !== 'boolean'
    || (f.claimed !== undefined && typeof f.claimed !== 'boolean')
    || (f.establishedAt !== undefined && !isSeconds(f.establishedAt))
    || (f.standingUntil !== undefined && !isSeconds(f.standingUntil))
    || (f.establishedAt !== undefined && f.standingUntil !== undefined && f.standingUntil <= f.establishedAt)
    || (f.admittedBy !== undefined && !distinct(f.admittedBy, isOrigin, 64))
    || (f.linkedTo !== undefined && (!isIri(f.linkedTo) || f.linkedTo === f.subject))
    || (f.roles !== undefined && !distinct(f.roles, isName, 32))
    || (f.onBehalfOf !== undefined && !isIri(f.onBehalfOf))
    || (f.acceptedTermsVersion !== undefined && !isName(f.acceptedTermsVersion))
    || (f.proofKeyThumbprint !== undefined && (typeof f.proofKeyThumbprint !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(f.proofKeyThumbprint)))
    || !Number.isFinite(nowMs)) throw new AbacPortableError('invalid_subject_facts');
  const now = Math.floor(nowMs / 1000);
  const attributes = new Map([[SUBJECT.provisional, [f.provisional]]]);
  const state = (path, values) => { if (values !== undefined) attributes.set(path, values); };
  state(SUBJECT.claimed, f.claimed === undefined ? undefined : [f.claimed]);
  state(SUBJECT.establishedAt, f.establishedAt === undefined ? undefined : [f.establishedAt]);
  state(SUBJECT.ageSeconds, f.establishedAt === undefined ? undefined : [Math.max(0, now - f.establishedAt)]);
  state(SUBJECT.standingUntil, f.standingUntil === undefined ? undefined : [f.standingUntil]);
  state(SUBJECT.secondsRemaining, f.standingUntil === undefined ? undefined : [f.standingUntil - now]);
  state(SUBJECT.admittedBy, f.admittedBy === undefined ? undefined : [...f.admittedBy]);
  state(SUBJECT.linkedTo, f.linkedTo === undefined ? undefined : [f.linkedTo]);
  state(SUBJECT.role, f.roles === undefined ? undefined : [...f.roles]);
  state(SUBJECT.onBehalfOf, f.onBehalfOf === undefined ? undefined : [f.onBehalfOf]);
  state(SUBJECT.acceptedTermsVersion, f.acceptedTermsVersion === undefined ? undefined : [f.acceptedTermsVersion]);
  state(SUBJECT.proofKeyThumbprint, f.proofKeyThumbprint === undefined ? undefined : [f.proofKeyThumbprint]);
  // The shape of an `@interego/abac` AttributeGraph: no facets, direct statements only.
  return { subject: f.subject, facets: [], sources: new Map(), attributes };
}

/**
 * The subject a decision or a usage record should be attributed to: the main account an authority
 * states the subject is linked to (`linkedTo`), else the subject itself. `also` is the subject
 * that acted, where that is not the canonical one, so a record can keep both.
 *
 * `facts` are validated as `subjectAttributeGraph` validates them (and throw the same way): a link
 * is believed only as part of a whole, well-formed answer from the authority. A link is followed
 * once. The authority states the main account, never a chain, and nothing here asks anyone else.
 */
export function canonicalSubject(facts, nowMs = Date.now()) {
  const graph = subjectAttributeGraph(facts, nowMs);
  const linked = graph.attributes.get(SUBJECT.linkedTo)?.[0];
  return typeof linked === 'string' ? { subject: linked, also: [graph.subject], linked: true } : { subject: graph.subject, also: [], linked: false };
}

/** One constraint of a predicate shape against the graph: the package's checkConstraint. */
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
 * The package's `evaluate` over a graph of direct attribute statements: a policy applies when it
 * governs `action` and every constraint of its predicate holds; Deny overrides Permit; a Duty
 * permits; nothing applying is Indeterminate. `predicates` is a Map from shape IRI to shape, and a
 * policy whose shape is not in it is skipped, as there.
 */
export function evaluatePolicies(policies, predicates, graph, action) {
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
 * Decide `action` for the subject whose graph is `graph` under `policySet` ({ policies, predicates }).
 * Default-deny: `allowed` is true only for the verdict Allowed. Indeterminate (no policy applies,
 * or the graph is missing) is a refusal here, never a grant, and so is anything that throws.
 */
export function decide(action, policySet, graph) {
  try {
    if (typeof action !== 'string' || !graph || !(graph.attributes instanceof Map)
      || !policySet || !Array.isArray(policySet.policies) || !(policySet.predicates instanceof Map)) {
      return { allowed: false, verdict: 'Indeterminate', reason: 'default-deny: nothing to evaluate', matchedPolicies: [] };
    }
    const result = evaluatePolicies(policySet.policies, policySet.predicates, graph, action);
    if (result.verdict === 'Allowed') return { allowed: true, verdict: 'Allowed', reason: `permitted by ${result.matchedPolicies.join(', ')}`, matchedPolicies: result.matchedPolicies };
    if (result.verdict === 'Denied') return { allowed: false, verdict: 'Denied', reason: `denied by ${result.matchedPolicies.join(', ')}`, matchedPolicies: result.matchedPolicies };
    return { allowed: false, verdict: 'Indeterminate', reason: 'default-deny: no policy permits this action', matchedPolicies: [] };
  } catch {
    return { allowed: false, verdict: 'Indeterminate', reason: 'default-deny: the decision could not be made', matchedPolicies: [] };
  }
}

/**
 * Adopt a policy at a decision point that already has a fixed rule.
 *
 *   mode 'shadow' (the default, and what any value but 'enforce' means): the EXISTING rule's
 *   answer is returned. The policy is evaluated beside it, and when the two differ `log` is called
 *   once with a small structured record: the point, the action, the subject, both answers and the
 *   policies that matched. Nothing of the request, no credential and no attribute value is in it.
 *   mode 'enforce': the policy's answer is returned (default-deny), and a difference is still logged.
 *
 * A `log` that throws, or a policy that cannot be evaluated, never changes the answer.
 */
export function decideInShadow(input) {
  const { point, mode, existing, action, policySet, graph, log } = input ?? {};
  const enforce = mode === 'enforce';
  const policy = decide(action, policySet, graph);
  if (policy.allowed !== (existing === true) && typeof log === 'function') {
    try {
      log({ event: 'abac_shadow_disagreement', point: String(point ?? '').slice(0, 128), mode: enforce ? 'enforce' : 'shadow',
        action: String(action ?? '').slice(0, 256), subject: String(graph?.subject ?? '').slice(0, 256),
        existing: existing === true, policy: policy.verdict, matchedPolicies: policy.matchedPolicies.slice(0, 8) });
    } catch { /* a logger's failure is not a decision */ }
  }
  return enforce ? policy.allowed : existing === true;
}

/**
 * A standard policy set for provisional subjects at one service, as data:
 *   - a provisional subject this service admitted, whose standing has not ended, may do each
 *     action in `provisionalMay`;
 *   - one that has also been claimed (it holds an enrolled credential) may do each in `claimedMay`;
 *   - a subject whose standing has ended is denied every action named (an explicit Deny, which
 *     overrides any Permit a service adds beside these).
 * `acceptedTermsVersion`, where given, is required of both.
 *
 * Every constraint a Permit rests on carries minCount 1: a constraint over no values holds
 * vacuously in SHACL, and a missing attribute must never satisfy a Permit.
 */
export function provisionalSubjectPolicies(options) {
  const { service, provisionalMay = [], claimedMay = [], acceptedTermsVersion } = options ?? {};
  if (!isOrigin(service) || !Array.isArray(provisionalMay) || !Array.isArray(claimedMay)
    || ![...provisionalMay, ...claimedMay].every(a => typeof a === 'string' && a.length > 0 && a.length <= 256)
    || (acceptedTermsVersion !== undefined && !isName(acceptedTermsVersion))) {
    throw new AbacPortableError('invalid_policy_options');
  }
  const base = `urn:interego:abac:provisional-subject:${service}`;
  const live = [
    { path: SUBJECT.admittedBy, minCount: 1, hasValue: service },
    { path: SUBJECT.secondsRemaining, minCount: 1, minInclusive: 1 },
    ...(acceptedTermsVersion !== undefined ? [{ path: SUBJECT.acceptedTermsVersion, minCount: 1, hasValue: acceptedTermsVersion }] : []),
  ];
  const shapes = [
    { iri: `${base}#provisional`, constraints: [{ path: SUBJECT.provisional, minCount: 1, hasValue: 'true' }, ...live] },
    { iri: `${base}#claimed`, constraints: [{ path: SUBJECT.claimed, minCount: 1, hasValue: 'true' }, ...live] },
    { iri: `${base}#standing-ended`, constraints: [{ path: SUBJECT.secondsRemaining, minCount: 1, maxInclusive: 0 }] },
  ];
  const policies = [];
  const policy = (name, shape, action, deonticMode) => policies.push({
    id: `${base}#${name}:${action}`, policyPredicateShape: shape.iri, governedAction: action, deonticMode });
  for (const action of new Set(provisionalMay)) policy('permit-provisional', shapes[0], action, 'Permit');
  for (const action of new Set(claimedMay)) policy('permit-claimed', shapes[1], action, 'Permit');
  for (const action of new Set([...provisionalMay, ...claimedMay])) policy('deny-standing-ended', shapes[2], action, 'Deny');
  return { policies, predicates: new Map(shapes.map(shape => [shape.iri, shape])) };
}
