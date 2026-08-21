/**
 * All seven SHACL node kinds, because three of them accepted everything.
 *
 * ★ THE DEFECT. `matchesNodeKind` handled four of the seven and ended in `default: return
 * true`. So `sh:nodeKind sh:IRIOrLiteral` — a SHACL **1.0** kind, nothing exotic — passed a
 * blank node, and `sh:BlankNodeOrLiteral` passed an IRI. Both were published, dereferenceable
 * constraints that asserted nothing, and no test noticed because every test that used
 * sh:nodeKind happened to use one of the four that worked.
 *
 * Found while adding the SHACL 1.2 kind sh:TripleTerm, which would have been the fifth
 * silently-permissive value. That is the useful shape of this bug: a `default` that accepts
 * is invisible until someone counts the cases against the spec.
 *
 * ★ WHY THE `default` IS STILL PERMISSIVE. An sh:nodeKind value outside the seven is an
 * ill-formed SHAPE, not invalid data. Rejecting on it would let one typo in a shape refuse a
 * publisher's entire graph. What changed is that it is no longer SILENT: the sweep reports
 * the unrecognised value and lowers `fullyChecked`, so "this check did not run" is a fact the
 * caller can read rather than a difference nobody can see.
 */
import { describe, it, expect } from 'vitest';
import { validateAgainstShape } from '@interego/core';

const P = `@prefix sh: <http://www.w3.org/ns/shacl#> .
@prefix rdf: <http://www.w3.org/1999/02/22-rdf-syntax-ns#> .
@prefix ex: <https://example.org/> .
`;

const shapeFor = (kind: string) => P + `ex:S a sh:NodeShape ; sh:targetSubjectsOf ex:p ;
  sh:property [ sh:path ex:p ; sh:nodeKind sh:${kind} ] .`;

const VALUES = {
  bnode: 'ex:s ex:p [ ex:q 1 ] .',
  iri: 'ex:s ex:p ex:o .',
  literal: 'ex:s ex:p "x" .',
} as const;

const accepts = (kind: string, value: keyof typeof VALUES): boolean =>
  validateAgainstShape(P + VALUES[value], shapeFor(kind), {}).conforms;

describe('every one of SHACL §7.1.3\'s seven node kinds', () => {
  // The full truth table, stated once. A kind missing from the switch shows up here as a
  // row of all-true, which is what the three broken ones looked like.
  const TABLE: ReadonlyArray<readonly [string, boolean, boolean, boolean]> = [
    // kind,                  bnode, iri,   literal
    ['IRI', false, true, false],
    ['Literal', false, false, true],
    ['BlankNode', true, false, false],
    ['BlankNodeOrIRI', true, true, false],
    ['BlankNodeOrLiteral', true, false, true],
    ['IRIOrLiteral', false, true, true],
    ['TripleTerm', false, false, false],
  ];

  it.each(TABLE)('sh:%s accepts exactly what it names', (kind, bnode, iri, literal) => {
    expect(accepts(kind, 'bnode'), `sh:${kind} on a blank node`).toBe(bnode);
    expect(accepts(kind, 'iri'), `sh:${kind} on an IRI`).toBe(iri);
    expect(accepts(kind, 'literal'), `sh:${kind} on a literal`).toBe(literal);
  });
});

describe('sh:TripleTerm, the SHACL 1.2 addition', () => {
  const shape = P + `ex:S a sh:NodeShape ; sh:targetSubjectsOf rdf:reifies ;
  sh:property [ sh:path rdf:reifies ; sh:nodeKind sh:TripleTerm ] .`;

  it('ACCEPTS an actual triple term', () => {
    // Guards the guard: the table above shows sh:TripleTerm rejecting bnode/IRI/literal,
    // which a kind that rejects EVERYTHING would also satisfy.
    expect(validateAgainstShape(P + 'ex:r rdf:reifies <<( ex:s ex:p ex:o )>> .', shape, {}).conforms)
      .toBe(true);
  });

  it('and rejects an ordinary IRI in the same slot', () => {
    expect(validateAgainstShape(P + 'ex:r rdf:reifies ex:notATripleTerm .', shape, {}).conforms)
      .toBe(false);
  });
});

describe('a node kind outside the seven', () => {
  const bogus = P + `ex:S a sh:NodeShape ; sh:targetSubjectsOf ex:p ;
  sh:property [ sh:path ex:p ; sh:nodeKind sh:NotAKind ] .`;
  const report = validateAgainstShape(P + VALUES.iri, bogus, {});

  it('does not reject the data — an ill-formed shape is not invalid data', () => {
    expect(report.conforms).toBe(true);
  });

  it('but is REPORTED, so the permissiveness is visible', () => {
    expect(report.results.some(r => /nodeKind/i.test(r.message ?? ''))).toBe(true);
  });

  it('and lowers fullyChecked, so `conforms && fullyChecked` still fails closed', () => {
    expect(report.fullyChecked).toBe(false);
    expect(report.conforms && report.fullyChecked).toBe(false);
  });
});
