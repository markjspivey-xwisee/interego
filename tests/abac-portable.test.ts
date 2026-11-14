/**
 * `@interego/abac/portable` (packages/abac/portable/abac-portable.mjs): the dependency-free policy
 * decision every deployable can load. One subject model for every principal, a default-deny
 * `decide`, shadow adoption beside a fixed rule, and two things it must stay equal to:
 *
 *   - the package's `evaluate`, on the same policies and the same graphs;
 *   - every vendored copy (deploy/css-gate/abac-portable.mjs), byte for byte.
 *
 * Fixtures are invented: example origins, DIDs and a thumbprint of repeated characters.
 */
import { readFileSync } from 'node:fs';
import { describe, it, expect } from 'vitest';
import type { AccessControlPolicyData, IRI } from '@interego/core';
import { evaluate, filterAttributeGraph, type PolicyContext, type PolicyPredicateShape, type PredicateConstraint } from '@interego/abac';
import { ACTIONS, AbacPortableError, SUBJECT, decide, decideInShadow, evaluatePolicies, provisionalSubjectPolicies, subjectAttributeGraph,
  type PolicySet, type ShadowDisagreement, type SubjectFacts } from '@interego/abac/portable';

const PLAY = 'https://play.example';
const LEARN = 'https://learn.example';
const NOW = 1_800_000_000;
const GUEST_DID = `did:web:identity.example:users:u-try-guest-${'a'.repeat(32)}`;
const OWNER_DID = 'did:web:identity.example:users:u-pk-aaaaaaaaaaaa';
type Over = Partial<Record<keyof SubjectFacts, unknown>>;
const facts = (over: Over = {}): SubjectFacts => ({
  subject: GUEST_DID, provisional: true, claimed: false, establishedAt: NOW - 600, standingUntil: NOW + 3000,
  admittedBy: [PLAY], proofKeyThumbprint: 'T'.repeat(43), ...over } as SubjectFacts);
const graphOf = (over: Over = {}, now = NOW) => subjectAttributeGraph(facts(over), now * 1000);

/** The package's verdict for the same question. */
function abac(policies: readonly AccessControlPolicyData[], predicates: ReadonlyMap<string, PolicyPredicateShape>,
  graph: PolicyContext['subjectAttributes'], action: string) {
  return evaluate(policies, predicates as ReadonlyMap<IRI, PolicyPredicateShape>, {
    subject: graph.subject, subjectAttributes: graph, resource: 'urn:resource' as IRI, action: action as IRI,
    now: new Date(NOW * 1000).toISOString(),
  });
}

describe('one subject model for every principal', () => {
  it('states an authority\'s facts and derives the two clock attributes', () => {
    const graph = graphOf({ acceptedTermsVersion: '2026-11-06-r2', linkedTo: OWNER_DID });
    expect(graph.subject).toBe(GUEST_DID);
    expect(graph.facets).toEqual([]);
    expect(Object.fromEntries(graph.attributes)).toEqual({
      [SUBJECT.provisional]: [true], [SUBJECT.claimed]: [false], [SUBJECT.establishedAt]: [NOW - 600], [SUBJECT.ageSeconds]: [600],
      [SUBJECT.standingUntil]: [NOW + 3000], [SUBJECT.secondsRemaining]: [3000], [SUBJECT.admittedBy]: [PLAY], [SUBJECT.linkedTo]: [OWNER_DID],
      [SUBJECT.acceptedTermsVersion]: ['2026-11-06-r2'], [SUBJECT.proofKeyThumbprint]: ['T'.repeat(43)],
    });
  });

  it('a registered owner, a delegated agent and a service account are the same kind of thing with other values', () => {
    const owner = subjectAttributeGraph({ subject: OWNER_DID, provisional: false, roles: ['admin', 'learner'] }, NOW * 1000);
    expect(Object.fromEntries(owner.attributes)).toEqual({ [SUBJECT.provisional]: [false], [SUBJECT.role]: ['admin', 'learner'] });
    const agent = subjectAttributeGraph({ subject: 'did:web:identity.example:agents:claude-code-u-pk-aaaaaaaaaaaa', provisional: false, onBehalfOf: OWNER_DID }, NOW * 1000);
    expect(agent.attributes.get(SUBJECT.onBehalfOf)).toEqual([OWNER_DID]);
    const service = subjectAttributeGraph({ subject: 'did:web:identity.example:agents:game-service', provisional: false, roles: ['service'], establishedAt: NOW - 86_400 }, NOW * 1000);
    expect(service.attributes.get(SUBJECT.ageSeconds)).toEqual([86_400]);
    // No standing end stated: nothing is derived from one, and a policy that needs it does not apply.
    expect(owner.attributes.has(SUBJECT.secondsRemaining)).toBe(false);
    // A role-based rule is the same kind of policy as a guest rule.
    const admins: PolicySet = { policies: [{ id: 'urn:policy:admins' as IRI, policyPredicateShape: 'urn:shape:admin' as IRI, governedAction: 'urn:act:administer' as IRI, deonticMode: 'Permit' }],
      predicates: new Map([['urn:shape:admin', { iri: 'urn:shape:admin' as IRI, constraints: [{ path: SUBJECT.role, minCount: 1, hasValue: 'admin' }, { path: SUBJECT.provisional, minCount: 1, hasValue: 'false' }] }]]) };
    expect(decide('urn:act:administer', admins, owner).allowed).toBe(true);
    expect(decide('urn:act:administer', admins, service).allowed).toBe(false);
    expect(decide('urn:act:administer', admins, graphOf({ roles: ['admin'] })).allowed).toBe(false);
  });

  it('refuses anything malformed outright, an unknown member included, and never builds a graph from part of an answer', () => {
    const bad: Over[] = [
      { subject: '' }, { subject: 'a b' }, { subject: 7 }, { provisional: 'true' }, { provisional: undefined }, { claimed: 'false' },
      { establishedAt: 0 }, { establishedAt: '1' }, { standingUntil: NOW - 600 }, { standingUntil: 1.5 }, { standingUntil: Number.NaN },
      { admittedBy: PLAY }, { admittedBy: [PLAY, PLAY] }, { admittedBy: ['play.example'] }, { admittedBy: [`${PLAY}/`] }, { admittedBy: [7] },
      { admittedBy: new Array(65).fill(0).map((_, i) => `https://a${i}.example`) }, { linkedTo: GUEST_DID }, { linkedTo: 'a b' }, { roles: 'admin' },
      { roles: ['a b'] }, { roles: ['x', 'x'] }, { onBehalfOf: '' }, { proofKeyThumbprint: 'short' }, { acceptedTermsVersion: '' }, { acceptedTermsVersion: 3 },
    ];
    for (const over of bad) expect(() => graphOf(over), JSON.stringify(over)).toThrow(AbacPortableError);
    expect(() => subjectAttributeGraph({ ...facts(), surprise: true }, NOW * 1000)).toThrow(AbacPortableError);
    for (const whole of [null, undefined, 'facts', [], 7]) expect(() => subjectAttributeGraph(whole, NOW * 1000)).toThrow(AbacPortableError);
    expect(() => subjectAttributeGraph(facts(), Number.NaN)).toThrow(AbacPortableError);
  });
});

describe('the standard policies for provisional subjects, decided default-deny', () => {
  const set = provisionalSubjectPolicies({ service: PLAY, provisionalMay: [ACTIONS.publish, ACTIONS.useService], claimedMay: ['urn:example:keep'] });

  it('permits a live provisional subject this service admitted, and nothing the set does not name', () => {
    expect(decide(ACTIONS.publish, set, graphOf())).toMatchObject({ allowed: true, verdict: 'Allowed' });
    expect(decide(ACTIONS.useService, set, graphOf())).toMatchObject({ allowed: true });
    expect(decide('urn:example:other', set, graphOf())).toMatchObject({ allowed: false, verdict: 'Indeterminate' });
    expect(decide('urn:example:keep', set, graphOf())).toMatchObject({ allowed: false, verdict: 'Indeterminate' });
    expect(decide('urn:example:keep', set, graphOf({ claimed: true }))).toMatchObject({ allowed: true });
    // A registered principal is not a provisional one: this set says nothing for it, so it is refused here.
    expect(decide(ACTIONS.publish, set, graphOf({ provisional: false }))).toMatchObject({ allowed: false });
  });

  it('refuses a subject another service admitted', () => {
    expect(decide(ACTIONS.publish, set, graphOf({ admittedBy: [LEARN] }))).toMatchObject({ allowed: false, verdict: 'Indeterminate' });
    expect(decide(ACTIONS.publish, set, graphOf({ admittedBy: [] }))).toMatchObject({ allowed: false });
    expect(decide(ACTIONS.publish, set, graphOf({ admittedBy: undefined }))).toMatchObject({ allowed: false });
    expect(decide(ACTIONS.publish, set, graphOf({ admittedBy: [LEARN, PLAY] }))).toMatchObject({ allowed: true });
    expect(decide(ACTIONS.publish, set, graphOf({ admittedBy: [`${PLAY}.evil.example`] }))).toMatchObject({ allowed: false });
  });

  it('denies at and after the end of standing with an explicit Deny, which a Permit added beside it cannot override', () => {
    for (const now of [NOW + 3000, NOW + 3001, NOW + 999_999]) {
      expect(decide(ACTIONS.publish, set, graphOf({}, now)), String(now)).toMatchObject({ allowed: false, verdict: 'Denied' });
    }
    expect(decide(ACTIONS.publish, set, graphOf({}, NOW + 2999))).toMatchObject({ allowed: true });
    const always: PolicyPredicateShape = { iri: 'urn:shape:any' as IRI, constraints: [{ path: SUBJECT.provisional, minCount: 1 }] };
    const widened = { policies: [...set.policies, { id: 'urn:policy:anyone' as IRI, policyPredicateShape: always.iri,
      governedAction: ACTIONS.publish as IRI, deonticMode: 'Permit' as const }],
      predicates: new Map([...set.predicates, [always.iri, always]]) };
    expect(decide(ACTIONS.publish, widened, graphOf({ admittedBy: [] }))).toMatchObject({ allowed: true });
    expect(decide(ACTIONS.publish, widened, graphOf({}, NOW + 3000))).toMatchObject({ allowed: false, verdict: 'Denied' });
    // No end of standing stated at all: the Permit, which needs one, does not apply.
    expect(decide(ACTIONS.publish, set, graphOf({ standingUntil: undefined }))).toMatchObject({ allowed: false, verdict: 'Indeterminate' });
  });

  it('requires the accepted terms version where the service names one', () => {
    const terms = provisionalSubjectPolicies({ service: PLAY, provisionalMay: [ACTIONS.useService], acceptedTermsVersion: '2026-01-15' });
    expect(decide(ACTIONS.useService, terms, graphOf())).toMatchObject({ allowed: false });
    expect(decide(ACTIONS.useService, terms, graphOf({ acceptedTermsVersion: '2025-09-01' }))).toMatchObject({ allowed: false });
    expect(decide(ACTIONS.useService, terms, graphOf({ acceptedTermsVersion: '2026-01-15' }))).toMatchObject({ allowed: true });
  });

  it('never grants on a missing graph, a missing attribute, an empty policy set or a malformed call', () => {
    const action = ACTIONS.publish;
    expect(decide(action, set, null)).toMatchObject({ allowed: false });
    expect(decide(action, set, undefined)).toMatchObject({ allowed: false });
    expect(decide(action, { policies: [], predicates: new Map() }, graphOf())).toMatchObject({ allowed: false, verdict: 'Indeterminate' });
    expect(decide(action, null as never, graphOf())).toMatchObject({ allowed: false });
    expect(decide(undefined as never, set, graphOf())).toMatchObject({ allowed: false });
    for (const path of [SUBJECT.provisional, SUBJECT.admittedBy, SUBJECT.secondsRemaining]) {
      const graph = graphOf();
      const without = { ...graph, attributes: new Map([...graph.attributes].filter(([key]) => key !== path)) };
      expect(decide(action, set, without), path).toMatchObject({ allowed: false });
      expect(abac(set.policies, set.predicates, without, action).verdict, path).not.toBe('Allowed');
    }
    const broken: PolicyPredicateShape = { iri: 'urn:shape:broken' as IRI, constraints: [{ path: SUBJECT.admittedBy, pattern: '(' }] };
    expect(decide(action, { policies: [{ id: 'urn:policy:broken' as IRI, policyPredicateShape: broken.iri, governedAction: action as IRI,
      deonticMode: 'Permit' }], predicates: new Map([[broken.iri, broken]]) }, graphOf())).toMatchObject({ allowed: false });
    for (const options of [undefined, {}, { service: 'play.example' }, { service: `${PLAY}/` }, { service: PLAY, provisionalMay: 'x' },
      { service: PLAY, provisionalMay: [''] }, { service: PLAY, acceptedTermsVersion: '' }]) {
      expect(() => provisionalSubjectPolicies(options as never), JSON.stringify(options)).toThrow(AbacPortableError);
    }
  });
});

describe('adopting a policy beside a fixed rule: shadow, then enforce', () => {
  const set = provisionalSubjectPolicies({ service: PLAY, provisionalMay: [ACTIONS.publish] });
  const run = (existing: boolean, graph: ReturnType<typeof graphOf> | null, mode?: string) => {
    const logged: ShadowDisagreement[] = [];
    const answer = decideInShadow({ point: 'test.point', mode, existing, action: ACTIONS.publish, policySet: set, graph, log: record => logged.push(record) });
    return { answer, logged };
  };

  it('in shadow mode the existing rule decides, and only a disagreement is logged', () => {
    expect(run(true, graphOf())).toEqual({ answer: true, logged: [] });
    expect(run(false, graphOf({ admittedBy: [] }))).toEqual({ answer: false, logged: [] });
    const permissiveRule = run(true, graphOf({ admittedBy: [] }));
    expect(permissiveRule.answer).toBe(true);
    expect(permissiveRule.logged).toEqual([{ event: 'abac_shadow_disagreement', point: 'test.point', mode: 'shadow', action: ACTIONS.publish,
      subject: GUEST_DID, existing: true, policy: 'Indeterminate', matchedPolicies: [] }]);
    const strictRule = run(false, graphOf());
    expect(strictRule.answer).toBe(false);
    expect(strictRule.logged[0]).toMatchObject({ existing: false, policy: 'Allowed', mode: 'shadow' });
    // Shadow is the default, and what any value but "enforce" means.
    for (const mode of [undefined, '', 'Enforce', 'on', '1']) expect(run(true, graphOf({ admittedBy: [] }), mode).answer, String(mode)).toBe(true);
  });

  it('in enforce mode the policy decides, default-deny, and a difference is still logged', () => {
    expect(run(true, graphOf({ admittedBy: [] }), 'enforce')).toMatchObject({ answer: false, logged: [{ mode: 'enforce', existing: true }] });
    expect(run(false, graphOf(), 'enforce')).toMatchObject({ answer: true, logged: [{ mode: 'enforce', existing: false, policy: 'Allowed' }] });
    expect(run(true, null, 'enforce').answer).toBe(false);
    expect(run(true, graphOf(), 'enforce')).toEqual({ answer: true, logged: [] });
  });

  it('the record carries no attribute value and nothing of the request, is bounded, and a failing logger changes no answer', () => {
    const record = run(true, graphOf({ admittedBy: [] })).logged[0]!;
    expect(Object.keys(record).sort()).toEqual(['action', 'event', 'existing', 'matchedPolicies', 'mode', 'point', 'policy', 'subject']);
    expect(JSON.stringify(record)).not.toContain('T'.repeat(43));
    const long = decideInShadow({ point: 'p'.repeat(1000), existing: true, action: 'a'.repeat(1000), policySet: set, graph: { ...graphOf({ admittedBy: [] }), subject: 's'.repeat(5000) as IRI },
      log: r => { expect([r.point.length, r.action.length, r.subject.length]).toEqual([128, 256, 256]); } });
    expect(long).toBe(true);
    expect(decideInShadow({ point: 'x', existing: true, action: ACTIONS.publish, policySet: set, graph: null, log: () => { throw new Error('logger down'); } })).toBe(true);
    expect(decideInShadow({ point: 'x', mode: 'enforce', existing: true, action: ACTIONS.publish, policySet: set, graph: graphOf(), log: () => { throw new Error('logger down'); } })).toBe(true);
    expect(decideInShadow({ point: 'x', existing: false, action: ACTIONS.publish, policySet: set, graph: graphOf() })).toBe(false);
    expect(decideInShadow(undefined as never)).toBe(false);
  });
});

describe('parity with the package\'s evaluate', () => {
  it('the package reads direct attribute statements, and a filtered graph carries none', () => {
    const graph = graphOf();
    const set = provisionalSubjectPolicies({ service: PLAY, provisionalMay: [ACTIONS.publish] });
    expect(abac(set.policies, set.predicates, graph, ACTIONS.publish).verdict).toBe('Allowed');
    const filtered = filterAttributeGraph(graph, () => true);
    expect(filtered.attributes).toBeUndefined();
    expect(abac(set.policies, set.predicates, filtered, ACTIONS.publish).verdict).toBe('Indeterminate');
  });

  it('the standard policies give the same verdict and the same matched policies on every subject state', () => {
    const sets = [
      provisionalSubjectPolicies({ service: PLAY, provisionalMay: [ACTIONS.publish] }),
      provisionalSubjectPolicies({ service: LEARN, provisionalMay: [ACTIONS.useService], claimedMay: [ACTIONS.publish, 'urn:example:keep'], acceptedTermsVersion: '2026-01-15' }),
    ];
    const actions = [ACTIONS.publish, ACTIONS.useService, 'urn:example:keep', 'urn:example:other'];
    let compared = 0;
    for (const set of sets) for (const action of actions) for (const claimed of [false, true]) for (const provisional of [true, false])
      for (const admittedBy of [[], [PLAY], [LEARN], [PLAY, LEARN]]) for (const acceptedTermsVersion of [undefined, '2026-01-15', '2025-09-01'])
        for (const now of [NOW, NOW + 2999, NOW + 3000, NOW + 9000]) {
          const graph = graphOf({ claimed, provisional, admittedBy, acceptedTermsVersion }, now);
          const expected = abac(set.policies, set.predicates, graph, action);
          const mine = evaluatePolicies(set.policies, set.predicates, graph, action);
          expect(mine.verdict, `${action} ${claimed} ${provisional} ${admittedBy} ${acceptedTermsVersion} ${now}`).toBe(expected.verdict);
          expect(mine.matchedPolicies).toEqual(expected.matchedPolicies);
          expect(decide(action, set, graph).allowed).toBe(expected.verdict === 'Allowed');
          compared++;
        }
    expect(compared).toBe(2 * 4 * 2 * 2 * 4 * 3 * 4);
  });

  it('agrees on generated policies and graphs, every constraint kind and deontic mode included', () => {
    // A small deterministic generator (no Math.random: the sweep is the same on every run).
    let seed = 0x2f6e2b1;
    const next = (n: number) => { seed = (Math.imul(seed, 1103515245) + 12345) >>> 0; return seed % n; };
    const pick = <T,>(items: readonly T[]): T => items[next(items.length)]!;
    const paths = ['x:a', 'x:b', 'x:c', 'x:missing'];
    const pool: ReadonlyArray<string | number | boolean> = [true, false, 0, 1, -1, 5, 5.5, '5', 'true', 'x', 'abc', '', '7up', 'NaN', PLAY];
    const actions = ['urn:act:one', 'urn:act:two'];
    const outcomes = new Map<string, number>();
    for (let round = 0; round < 4000; round++) {
      const attributes = new Map<string, Array<string | number | boolean>>();
      for (const path of paths.slice(0, 3)) {
        if (next(5) === 0) continue;
        attributes.set(path, Array.from({ length: next(4) }, () => pick(pool)));
      }
      const graph = { subject: 'urn:subject' as IRI, facets: [], sources: new Map(), attributes };
      const predicates = new Map<string, PolicyPredicateShape>();
      const policies: AccessControlPolicyData[] = [];
      for (let p = 0; p < 1 + next(4); p++) {
        const constraints: PredicateConstraint[] = Array.from({ length: next(3) }, () => ({
          path: pick(paths),
          ...(next(2) ? { minCount: next(3) } : {}),
          ...(next(3) === 0 ? { hasValue: String(pick(pool)) } : {}),
          ...(next(4) === 0 ? { inValues: [String(pick(pool)), String(pick(pool))] } : {}),
          ...(next(4) === 0 ? { minInclusive: next(7) - 1 } : {}),
          ...(next(4) === 0 ? { maxInclusive: next(7) - 1 } : {}),
          ...(next(5) === 0 ? { pattern: pick(['^t', '^[0-9]+$', 'a', '^$']) } : {}),
        }));
        const shape = { iri: `urn:shape:${p}` as IRI, constraints };
        // One policy in eight names a shape that is not in the registry: both skip it.
        if (next(8) !== 0) predicates.set(shape.iri, shape);
        policies.push({ id: `urn:policy:${p}` as IRI, policyPredicateShape: shape.iri, governedAction: pick(actions) as IRI,
          deonticMode: pick(['Permit', 'Deny', 'Duty'] as const), ...(next(2) ? { duties: ['urn:duty'] } : {}) });
      }
      const action = pick(actions);
      const expected = abac(policies, predicates, graph, action);
      const mine = evaluatePolicies(policies, predicates, graph, action);
      expect(mine.verdict, `round ${round}`).toBe(expected.verdict);
      expect(mine.matchedPolicies, `round ${round}`).toEqual(expected.matchedPolicies);
      expect(decide(action, { policies, predicates }, graph).allowed).toBe(expected.verdict === 'Allowed');
      outcomes.set(expected.verdict, (outcomes.get(expected.verdict) ?? 0) + 1);
    }
    // The sweep is only evidence if it reached all three verdicts in number.
    for (const verdict of ['Allowed', 'Denied', 'Indeterminate']) expect(outcomes.get(verdict) ?? 0, verdict).toBeGreaterThan(300);
  });
});

describe('the single source and its copies', () => {
  const source = readFileSync(new URL('../packages/abac/portable/abac-portable.mjs', import.meta.url));

  it('every vendored copy is byte-identical to packages/abac/portable/abac-portable.mjs', () => {
    for (const copy of ['../deploy/css-gate/abac-portable.mjs']) {
      expect(readFileSync(new URL(copy, import.meta.url)).equals(source), copy).toBe(true);
    }
  });

  it('has no import of any kind and reads no environment', () => {
    expect(source.toString('utf8')).not.toMatch(/^\s*import\s|\bimport\(|\brequire\(|process\.env/m);
  });

  it('every attribute path and action it names is declared in the ontology of its prefix', () => {
    const ttl = (name: string) => readFileSync(new URL(`../docs/ns/${name}.ttl`, import.meta.url), 'utf8');
    const files: Record<string, string> = { passport: ttl('passport'), abac: ttl('abac'), iep: ttl('iep') };
    for (const term of [...Object.values(SUBJECT), ...Object.values(ACTIONS)]) {
      const [prefix, local] = term.split(':') as [string, string];
      expect(files[prefix], term).toMatch(new RegExp(`^${prefix}:${local} a `, 'm'));
    }
  });
});
