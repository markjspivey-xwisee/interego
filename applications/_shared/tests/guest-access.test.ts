/**
 * The shared guest-access helper: the attribute graph it builds from identity's facts, its standard
 * policy set, its default-deny decision, and two things it must stay equal to:
 *
 *   - `@interego/abac`'s `evaluate`, on the same policies and the same graphs (the helper is a
 *     dependency-free port, so the css-gate can load it without the package);
 *   - `deploy/css-gate/guest-access.mjs`, byte for byte (the gate's image copies that file).
 *
 * Fixtures are invented: example origins and a thumbprint of repeated characters.
 */
import { readFileSync } from 'node:fs';
import { describe, it, expect } from 'vitest';
import type { AccessControlPolicyData, IRI } from '@interego/core';
import { evaluate, filterAttributeGraph, type PolicyContext, type PolicyPredicateShape, type PredicateConstraint } from '@interego/abac';
import { GUEST, GUEST_ACTIONS, GuestAccessError, decide, evaluateGuestPolicies, guestAttributeGraph, guestPolicies,
  type GuestFacts } from '../guest-access/index.js';

const PLAY = 'https://play.example';
const LEARN = 'https://learn.example';
const NOW = 1_800_000_000;
const facts = (over: Partial<Record<keyof GuestFacts, unknown>> = {}): GuestFacts => ({
  subject: `did:web:identity.example:users:u-try-guest-${'a'.repeat(32)}`, provisional: true, claimed: false,
  createdAt: NOW - 600, expiresAt: NOW + 3000, admittedBy: [PLAY], proofKeyThumbprint: 'T'.repeat(43), ...over,
} as GuestFacts);
const graphOf = (over: Partial<Record<keyof GuestFacts, unknown>> = {}, now = NOW) => guestAttributeGraph(facts(over), now * 1000);

/** `@interego/abac`'s verdict for the same question. */
function abac(policies: readonly AccessControlPolicyData[], predicates: ReadonlyMap<string, PolicyPredicateShape>,
  graph: PolicyContext['subjectAttributes'], action: string) {
  return evaluate(policies, predicates as ReadonlyMap<IRI, PolicyPredicateShape>, {
    subject: graph.subject, subjectAttributes: graph, resource: 'urn:resource' as IRI, action: action as IRI,
    now: new Date(NOW * 1000).toISOString(),
  });
}

describe('the guest attribute graph', () => {
  it('states identity\'s facts and derives the two clock attributes', () => {
    const graph = graphOf({ admittedBy: [PLAY, LEARN], hostedTermsVersion: '2026-01' });
    expect(graph.subject).toBe(facts().subject);
    expect(graph.facets).toEqual([]);
    expect(Object.fromEntries(graph.attributes)).toEqual({
      [GUEST.provisional]: [true], [GUEST.claimed]: [false], [GUEST.createdAt]: [NOW - 600], [GUEST.expiresAt]: [NOW + 3000],
      [GUEST.ageSeconds]: [600], [GUEST.secondsRemaining]: [3000], [GUEST.admittedBy]: [PLAY, LEARN],
      [GUEST.proofKeyThumbprint]: ['T'.repeat(43)], [GUEST.hostedTermsVersion]: ['2026-01'],
    });
    expect(graphOf().attributes.has(GUEST.hostedTermsVersion)).toBe(false);
  });

  it('refuses anything malformed outright, and never builds a graph from part of an answer', () => {
    const bad: Array<Partial<Record<keyof GuestFacts, unknown>>> = [
      { subject: 'u-try-guest-x' }, { subject: 'did:web:identity.example:users:' }, { provisional: false }, { provisional: 'true' },
      { claimed: 'false' }, { claimed: undefined }, { createdAt: 0 }, { createdAt: '1' }, { expiresAt: NOW - 600 }, { expiresAt: 1.5 },
      { expiresAt: Number.NaN }, { admittedBy: PLAY }, { admittedBy: [PLAY, PLAY] }, { admittedBy: ['play.example'] },
      { admittedBy: [`${PLAY}/`] }, { admittedBy: [`${PLAY}/path`] }, { admittedBy: [7] }, { admittedBy: new Array(65).fill(0).map((_, i) => `https://a${i}.example`) },
      { proofKeyThumbprint: 'short' }, { proofKeyThumbprint: undefined }, { hostedTermsVersion: '' }, { hostedTermsVersion: 3 },
    ];
    for (const over of bad) expect(() => graphOf(over), JSON.stringify(over)).toThrow(GuestAccessError);
    for (const whole of [null, undefined, 'facts', [], 7]) expect(() => guestAttributeGraph(whole, NOW * 1000)).toThrow(GuestAccessError);
    expect(() => guestAttributeGraph(facts(), Number.NaN)).toThrow(GuestAccessError);
  });
});

describe('the standard policy set, decided default-deny', () => {
  const set = guestPolicies({ application: PLAY, provisionalMay: [GUEST_ACTIONS.writeCheckpoint, GUEST_ACTIONS.useApplication],
    claimedMay: ['urn:example:keep'] });

  it('permits a live provisional guest this application admitted, and nothing it does not name', () => {
    expect(decide(GUEST_ACTIONS.writeCheckpoint, set, graphOf())).toMatchObject({ allowed: true, verdict: 'Allowed' });
    expect(decide(GUEST_ACTIONS.useApplication, set, graphOf())).toMatchObject({ allowed: true });
    expect(decide('urn:example:other', set, graphOf())).toMatchObject({ allowed: false, verdict: 'Indeterminate' });
    // What only a claimed owner may do.
    expect(decide('urn:example:keep', set, graphOf())).toMatchObject({ allowed: false, verdict: 'Indeterminate' });
    expect(decide('urn:example:keep', set, graphOf({ claimed: true }))).toMatchObject({ allowed: true });
  });

  it('refuses a guest another application admitted', () => {
    expect(decide(GUEST_ACTIONS.writeCheckpoint, set, graphOf({ admittedBy: [LEARN] }))).toMatchObject({ allowed: false, verdict: 'Indeterminate' });
    expect(decide(GUEST_ACTIONS.writeCheckpoint, set, graphOf({ admittedBy: [] }))).toMatchObject({ allowed: false });
    expect(decide(GUEST_ACTIONS.writeCheckpoint, set, graphOf({ admittedBy: [LEARN, PLAY] }))).toMatchObject({ allowed: true });
    // An origin that only starts with the application's is another origin.
    expect(decide(GUEST_ACTIONS.writeCheckpoint, set, graphOf({ admittedBy: [`${PLAY}.evil.example`] }))).toMatchObject({ allowed: false });
  });

  it('denies a guest at and after its deadline with an explicit Deny, which a Permit added beside it cannot override', () => {
    for (const now of [NOW + 3000, NOW + 3001, NOW + 999_999]) {
      expect(decide(GUEST_ACTIONS.writeCheckpoint, set, graphOf({}, now)), String(now)).toMatchObject({ allowed: false, verdict: 'Denied' });
    }
    expect(decide(GUEST_ACTIONS.writeCheckpoint, set, graphOf({}, NOW + 2999))).toMatchObject({ allowed: true });
    const always: PolicyPredicateShape = { iri: 'urn:shape:any-guest' as IRI, constraints: [{ path: GUEST.provisional, minCount: 1 }] };
    const widened = { policies: [...set.policies, { id: 'urn:policy:anyone' as IRI, policyPredicateShape: always.iri,
      governedAction: GUEST_ACTIONS.writeCheckpoint as IRI, deonticMode: 'Permit' as const }],
      predicates: new Map([...set.predicates, [always.iri, always]]) };
    expect(decide(GUEST_ACTIONS.writeCheckpoint, widened, graphOf({ admittedBy: [] }))).toMatchObject({ allowed: true });
    expect(decide(GUEST_ACTIONS.writeCheckpoint, widened, graphOf({}, NOW + 3000))).toMatchObject({ allowed: false, verdict: 'Denied' });
  });

  it('requires the hosted terms version where the application names one', () => {
    const terms = guestPolicies({ application: PLAY, provisionalMay: [GUEST_ACTIONS.useApplication], hostedTermsVersion: '2026-01' });
    expect(decide(GUEST_ACTIONS.useApplication, terms, graphOf())).toMatchObject({ allowed: false });
    expect(decide(GUEST_ACTIONS.useApplication, terms, graphOf({ hostedTermsVersion: '2025-09' }))).toMatchObject({ allowed: false });
    expect(decide(GUEST_ACTIONS.useApplication, terms, graphOf({ hostedTermsVersion: '2026-01' }))).toMatchObject({ allowed: true });
  });

  it('never grants on a missing graph, a missing attribute, an empty policy set or a malformed call', () => {
    const action = GUEST_ACTIONS.writeCheckpoint;
    expect(decide(action, set, null)).toMatchObject({ allowed: false });
    expect(decide(action, set, undefined)).toMatchObject({ allowed: false });
    expect(decide(action, { policies: [], predicates: new Map() }, graphOf())).toMatchObject({ allowed: false, verdict: 'Indeterminate' });
    expect(decide(action, null as never, graphOf())).toMatchObject({ allowed: false });
    expect(decide(undefined as never, set, graphOf())).toMatchObject({ allowed: false });
    // Each attribute a Permit rests on, removed in turn: a constraint over no values must not hold.
    for (const path of [GUEST.provisional, GUEST.admittedBy, GUEST.secondsRemaining]) {
      const graph = graphOf();
      const without = { ...graph, attributes: new Map([...graph.attributes].filter(([key]) => key !== path)) };
      expect(decide(action, set, without), path).toMatchObject({ allowed: false });
      expect(abac(set.policies, set.predicates, without, action).verdict, path).not.toBe('Allowed');
    }
    // A predicate that throws (an invalid pattern) is a refusal, not an error and not a grant.
    const broken: PolicyPredicateShape = { iri: 'urn:shape:broken' as IRI, constraints: [{ path: GUEST.admittedBy, pattern: '(' }] };
    expect(decide(action, { policies: [{ id: 'urn:policy:broken' as IRI, policyPredicateShape: broken.iri, governedAction: action as IRI,
      deonticMode: 'Permit' }], predicates: new Map([[broken.iri, broken]]) }, graphOf())).toMatchObject({ allowed: false });
  });

  it('refuses malformed policy options', () => {
    for (const options of [undefined, {}, { application: 'play.example' }, { application: `${PLAY}/` },
      { application: PLAY, provisionalMay: 'x' }, { application: PLAY, provisionalMay: [''] }, { application: PLAY, hostedTermsVersion: '' }]) {
      expect(() => guestPolicies(options as never), JSON.stringify(options)).toThrow(GuestAccessError);
    }
  });
});

describe('parity with @interego/abac', () => {
  it('@interego/abac reads direct attribute statements, and a filtered graph carries none', () => {
    const graph = graphOf();
    const set = guestPolicies({ application: PLAY, provisionalMay: [GUEST_ACTIONS.writeCheckpoint] });
    expect(abac(set.policies, set.predicates, graph, GUEST_ACTIONS.writeCheckpoint).verdict).toBe('Allowed');
    const filtered = filterAttributeGraph(graph, () => true);
    expect(filtered.attributes).toBeUndefined();
    expect(abac(set.policies, set.predicates, filtered, GUEST_ACTIONS.writeCheckpoint).verdict).toBe('Indeterminate');
  });

  it('the standard policies give the same verdict and the same matched policies on every guest state', () => {
    const sets = [
      guestPolicies({ application: PLAY, provisionalMay: [GUEST_ACTIONS.writeCheckpoint] }),
      guestPolicies({ application: LEARN, provisionalMay: [GUEST_ACTIONS.useApplication], claimedMay: [GUEST_ACTIONS.writeCheckpoint, 'urn:example:keep'],
        hostedTermsVersion: '2026-01' }),
    ];
    const actions = [GUEST_ACTIONS.writeCheckpoint, GUEST_ACTIONS.useApplication, 'urn:example:keep', 'urn:example:other'];
    let compared = 0;
    for (const set of sets) for (const action of actions) for (const claimed of [false, true])
      for (const admittedBy of [[], [PLAY], [LEARN], [PLAY, LEARN]]) for (const hostedTermsVersion of [undefined, '2026-01', '2025-09'])
        for (const now of [NOW, NOW + 2999, NOW + 3000, NOW + 9000]) {
          const graph = graphOf({ claimed, admittedBy, hostedTermsVersion }, now);
          const expected = abac(set.policies, set.predicates, graph, action);
          const mine = evaluateGuestPolicies(set.policies, set.predicates, graph, action);
          expect(mine.verdict, `${action} ${claimed} ${admittedBy} ${hostedTermsVersion} ${now}`).toBe(expected.verdict);
          expect(mine.matchedPolicies).toEqual(expected.matchedPolicies);
          expect(decide(action, set, graph).allowed).toBe(expected.verdict === 'Allowed');
          compared++;
        }
    expect(compared).toBe(2 * 4 * 2 * 4 * 3 * 4);
  });

  it('agrees on generated policies and graphs, every constraint kind and deontic mode included', () => {
    // A small deterministic generator (no Math.random: the sweep is the same on every run).
    let seed = 0x2f6e2b1;
    const next = (n: number) => { seed = (Math.imul(seed, 1103515245) + 12345) >>> 0; return seed % n; };
    const pick = <T,>(items: readonly T[]): T => items[next(items.length)]!;
    const paths = ['guest:a', 'guest:b', 'guest:c', 'guest:missing'];
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
      const mine = evaluateGuestPolicies(policies, predicates, graph, action);
      expect(mine.verdict, `round ${round}`).toBe(expected.verdict);
      expect(mine.matchedPolicies, `round ${round}`).toEqual(expected.matchedPolicies);
      expect(decide(action, { policies, predicates }, graph).allowed).toBe(expected.verdict === 'Allowed');
      outcomes.set(expected.verdict, (outcomes.get(expected.verdict) ?? 0) + 1);
    }
    // The sweep is only evidence if it reached all three verdicts in number.
    for (const verdict of ['Allowed', 'Denied', 'Indeterminate']) expect(outcomes.get(verdict) ?? 0, verdict).toBeGreaterThan(300);
  });
});

describe('the css-gate\'s copy', () => {
  it('is byte-identical to the shared helper', () => {
    const shared = readFileSync(new URL('../guest-access/guest-access.mjs', import.meta.url));
    const gate = readFileSync(new URL('../../../deploy/css-gate/guest-access.mjs', import.meta.url));
    expect(gate.equals(shared)).toBe(true);
    // No import of any kind: the gate's image holds this file and undici, nothing else of the repository.
    expect(shared.toString('utf8')).not.toMatch(/^\s*import\s|\bimport\(|\brequire\(|process\.env/m);
  });
});
