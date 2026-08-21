/**
 * Published shapes enforce what their published prose says.
 *
 * ★ THE PATTERN THIS FILE EXISTS FOR. An ontology comment that says MUST is a claim about the
 * data, made at a dereferenceable IRI, that anyone may rely on. When no SHACL constraint
 * expresses it, the claim is still published and still relied upon — it is simply false. That
 * is strictly worse than not having written it down, because a reader who checks the
 * vocabulary comes away believing the invariant holds.
 *
 * Each block below was found by auditing the ontologies against their own prose, verified by
 * hand, and is pinned here in both directions: the valid shape of the data is accepted AND
 * each way of breaking it is refused. A test that only checked refusal would pass for a shape
 * that rejects everything.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { validateAgainstShape } from '@interego/core';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..');
const IEP_SHAPES = readFileSync(join(REPO, 'docs/ns/iep-shapes.ttl'), 'utf8');
const VAULT_LD = readFileSync(join(REPO, 'docs/ns/vault-ld.ttl'), 'utf8');

const P = `@prefix iep: <https://markjspivey-xwisee.github.io/interego/ns/iep#> .
@prefix hmd: <https://relay.interego.xwisee.com/ns/maintainer/hmd#> .
@prefix xsd: <http://www.w3.org/2001/XMLSchema#> .
@prefix ex: <https://example.org/> .
`;

const violationsMatching = (data: string, shapes: string, re: RegExp): number =>
  validateAgainstShape(P + data, shapes, {}).results
    .filter(r => r.severity === 'Violation' && re.test(r.message ?? '')).length;

describe('iep:AccessControlPolicy — its comment specifies (a)(b)(c) and nothing checked them', () => {
  const MUST = /iep:AccessControlPolicy MUST/;
  const policy = (body: string): string => `ex:pol a iep:AccessControlPolicy ; ${body} .`;
  const complete = 'iep:policyPredicate ex:shape ; iep:governedAction ex:act ; iep:deonticMode iep:Permit';

  it('accepts a complete policy', () => {
    expect(violationsMatching(policy(complete), IEP_SHAPES, MUST)).toBe(0);
  });

  it.each([
    ['no policyPredicate — applies to everyone or no one, unknowably',
      'iep:governedAction ex:act ; iep:deonticMode iep:Permit'],
    ['no governedAction — governs nothing, so decides nothing',
      'iep:policyPredicate ex:shape ; iep:deonticMode iep:Permit'],
    ['no deonticMode — Deny overrides Permit, so composition is undefined',
      'iep:policyPredicate ex:shape ; iep:governedAction ex:act'],
    ['two deonticModes — the same problem, twice over',
      'iep:policyPredicate ex:shape ; iep:governedAction ex:act ; iep:deonticMode iep:Permit , iep:Deny'],
    ['a deonticMode outside Permit/Deny/Duty',
      'iep:policyPredicate ex:shape ; iep:governedAction ex:act ; iep:deonticMode ex:MaybePermit'],
  ])('refuses: %s', (_label, body) => {
    expect(violationsMatching(policy(body), IEP_SHAPES, MUST)).toBeGreaterThan(0);
  });
});

describe('iep:SignedAuthorship — the signed block was OPEN', () => {
  // ★ The verifier rebuilds the canonical payload from a FIXED field set
  // (buildAuthorshipProofBlock in packages/solid/src/client.ts). Any other predicate inside
  // the block is content the signature does not cover, sitting exactly where a reader
  // expects signed content. Nothing in iep-shapes.ttl used sh:closed at all, so a forger
  // could append arbitrary unsigned triples to a verifying proof unchallenged.
  const proof = (extra: string): string => `ex:p a iep:SignedAuthorship ;
  iep:scheme "eip191" ; iep:issuer ex:i ; iep:verificationMethod ex:vm ;
  iep:signerAddress "0xabc" ; iep:created "2026-01-01T00:00:00Z"^^xsd:dateTime ;
  iep:ownerWebId ex:w ; iep:descriptorId ex:d ; iep:proofValue "sig" ${extra} .`;

  it('accepts the exact field set the serializer writes', () => {
    expect(validateAgainstShape(P + proof(''), IEP_SHAPES, {}).conforms).toBe(true);
  });

  it('accepts the optional contentHash', () => {
    expect(validateAgainstShape(P + proof('; iep:contentHash "sha256:ab"'), IEP_SHAPES, {}).conforms)
      .toBe(true);
  });

  it('REFUSES an unsigned extra triple inside the signed block', () => {
    const r = validateAgainstShape(P + proof('; ex:smuggled "unsigned content"'), IEP_SHAPES, {});
    expect(r.conforms).toBe(false);
    expect(r.results.some(x => /no predicate beyond/.test(x.message ?? '')),
      'the refusal must explain WHY, not just say "closed shape"').toBe(true);
  });
});

describe('vault-ld rung-<=3 — four predicates that ENTAIL a control were unscreened', () => {
  // hmd.ttl gives six predicates rdfs:domain hmd:Control, so bearing any of them entails the
  // subject IS a control — rung-4 execution authority. The shape screened target and rel and
  // missed method, expects, returns and condition. The hydra: half of the same list was
  // complete, which is what made the hmd: half look finished.
  it.each(['method', 'target', 'expects', 'returns', 'condition', 'rel'])(
    'hmd:%s is refused in a rung-<=3 vault', pred => {
      expect(validateAgainstShape(P + `ex:note hmd:${pred} "x" .`, VAULT_LD, {}).conforms).toBe(false);
    });

  it('and a plain note still passes — it constrains, it does not reject everything', () => {
    expect(validateAgainstShape(P + 'ex:note ex:body "just prose" .', VAULT_LD, {}).conforms).toBe(true);
  });
});

describe('iep:SemioticFacet — modal status and ground truth must agree', () => {
  // Was sh:sparql-only, against an engine with no SPARQL, so it checked nothing.
  const facet = (body: string): string => `ex:f a iep:SemioticFacet ; ${body} .`;
  const violations = (body: string): number =>
    validateAgainstShape(P + facet(body), IEP_SHAPES, {}).results
      .filter(r => r.severity === 'Violation').length;

  it.each([
    ['Asserted with groundTruth true', 'iep:modalStatus iep:Asserted ; iep:groundTruth true', 0],
    ['Counterfactual with groundTruth false', 'iep:modalStatus iep:Counterfactual ; iep:groundTruth false', 0],
    ['Hypothetical with no groundTruth', 'iep:modalStatus iep:Hypothetical', 0],
  ])('accepts %s', (_l, body, want) => expect(violations(body)).toBe(want));

  it.each([
    ['Asserted with groundTruth FALSE', 'iep:modalStatus iep:Asserted ; iep:groundTruth false'],
    ['Asserted with groundTruth MISSING', 'iep:modalStatus iep:Asserted'],
    ['Counterfactual with groundTruth TRUE', 'iep:modalStatus iep:Counterfactual ; iep:groundTruth true'],
    ['Hypothetical WITH a groundTruth', 'iep:modalStatus iep:Hypothetical ; iep:groundTruth true'],
  ])('refuses %s', (_l, body) => expect(violations(body)).toBeGreaterThan(0));
});
