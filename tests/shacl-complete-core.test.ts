/**
 * Every SHACL constraint component and path form this engine claims, enforced.
 *
 * ★ WHY A TRUTH TABLE AND NOT A TEST PER FEATURE. The engine reported 9 of 29 constructs
 * ENFORCED when this was written, and the other 20 were invisible for two different reasons
 * that a per-feature test suite would never have surfaced together:
 *
 *   INERT-BUT-REPORTED — sh:not, sh:or, sh:and, sh:xone and all four complex path forms
 *     were parsed, dropped, and mentioned only in an UnsupportedConstraint note. A graph
 *     violating an sh:not prohibition came back `conforms: true`. Reporting is not enforcing.
 *   INERT-AND-SILENT — sh:class, sh:datatype and sh:nodeKind read their value with `asIri`,
 *     which yields undefined for the SHACL 1.2 list form. `sh:datatype ( xsd:integer
 *     xsd:string )` therefore compiled to NO constraint at all and accepted every term, with
 *     nothing to report because a list is a perfectly legal value.
 *
 * The shape of both failures is the same and it is not "a feature is missing": it is that a
 * constraint can be absent and indistinguishable from a satisfied one. So each row below
 * asserts BOTH directions — the bad graph is refused AND the good graph is accepted. A row
 * that only checked refusal would pass for a constraint that rejects everything; a row that
 * only checked acceptance is what an inert constraint looks like.
 */
import { describe, it, expect } from 'vitest';
import { validateAgainstShape } from '@interego/core';

const P = `@prefix sh: <http://www.w3.org/ns/shacl#> .
@prefix rdf: <http://www.w3.org/1999/02/22-rdf-syntax-ns#> .
@prefix rdfs: <http://www.w3.org/2000/01/rdf-schema#> .
@prefix xsd: <http://www.w3.org/2001/XMLSchema#> .
@prefix ex: <https://example.org/> .
`;

/** shape body placed inside `ex:S`, a graph that must PASS, a graph that must FAIL. */
type Row = readonly [name: string, body: string, good: string, bad: string];

const shapeFor = (body: string): string =>
  `${P}ex:S a sh:NodeShape ; sh:targetSubjectsOf ex:p ; sh:targetNode ex:s ;\n  ${body} .`;

const CORE_10: readonly Row[] = [
  ['sh:not', 'sh:not [ sh:property [ sh:path ex:bad ; sh:minCount 1 ] ]',
    'ex:s ex:p "x" .', 'ex:s ex:bad "x" .'],
  ['sh:and', 'sh:and ( [ sh:property [ sh:path ex:a ; sh:minCount 1 ] ] [ sh:property [ sh:path ex:b ; sh:minCount 1 ] ] )',
    'ex:s ex:a "x" ; ex:b "y" .', 'ex:s ex:a "x" .'],
  ['sh:or', 'sh:or ( [ sh:property [ sh:path ex:a ; sh:minCount 1 ] ] [ sh:property [ sh:path ex:b ; sh:minCount 1 ] ] )',
    'ex:s ex:a "x" .', 'ex:s ex:c "x" .'],
  ['sh:xone', 'sh:xone ( [ sh:property [ sh:path ex:a ; sh:minCount 1 ] ] [ sh:property [ sh:path ex:b ; sh:minCount 1 ] ] )',
    'ex:s ex:a "x" .', 'ex:s ex:a "x" ; ex:b "y" .'],
];

const PATHS: readonly Row[] = [
  ['sequence path', 'sh:property [ sh:path ( ex:a ex:b ) ; sh:minCount 1 ]',
    'ex:s ex:a [ ex:b "x" ] .', 'ex:s ex:a [ ex:zz "x" ] .'],
  ['inverse path', 'sh:property [ sh:path [ sh:inversePath ex:parent ] ; sh:minCount 1 ]',
    'ex:s a ex:T . ex:child ex:parent ex:s .', 'ex:s a ex:T . ex:other ex:zz ex:s .'],
  ['alternative path', 'sh:property [ sh:path [ sh:alternativePath ( ex:a ex:b ) ] ; sh:minCount 1 ]',
    'ex:s ex:b "x" .', 'ex:s ex:c "x" .'],
  ['zeroOrMore path', 'sh:property [ sh:path [ sh:zeroOrMorePath ex:next ] ; sh:minCount 2 ]',
    'ex:s ex:next ex:t . ex:t ex:next ex:u .', 'ex:s ex:zz ex:t .'],
  ['oneOrMore path', 'sh:property [ sh:path [ sh:oneOrMorePath ex:next ] ; sh:minCount 1 ]',
    'ex:s ex:next ex:t .', 'ex:s ex:zz ex:t .'],
];

const SHACL_12: readonly Row[] = [
  ['sh:singleLine', 'sh:property [ sh:path ex:p ; sh:singleLine true ]',
    'ex:s ex:p "one line" .', 'ex:s ex:p """two\nlines""" .'],
  ['sh:someValue', 'sh:property [ sh:path ex:p ; sh:someValue [ sh:datatype xsd:integer ] ]',
    'ex:s ex:p "x" , 1 .', 'ex:s ex:p "x" , "y" .'],
  ['sh:memberShape', 'sh:property [ sh:path ex:list ; sh:memberShape [ sh:datatype xsd:integer ] ]',
    'ex:s ex:p 1 ; ex:list ( 1 2 ) .', 'ex:s ex:p 1 ; ex:list ( 1 "x" ) .'],
  ['sh:minListLength', 'sh:property [ sh:path ex:list ; sh:minListLength 2 ]',
    'ex:s ex:p 1 ; ex:list ( 1 2 ) .', 'ex:s ex:p 1 ; ex:list ( 1 ) .'],
  ['sh:maxListLength', 'sh:property [ sh:path ex:list ; sh:maxListLength 2 ]',
    'ex:s ex:p 1 ; ex:list ( 1 2 ) .', 'ex:s ex:p 1 ; ex:list ( 1 2 3 ) .'],
  ['sh:uniqueMembers', 'sh:property [ sh:path ex:list ; sh:uniqueMembers true ]',
    'ex:s ex:p 1 ; ex:list ( 1 2 ) .', 'ex:s ex:p 1 ; ex:list ( 1 1 ) .'],
  ['sh:subsetOf', 'sh:property [ sh:path ex:p ; sh:subsetOf ex:q ]',
    'ex:s ex:p ex:a ; ex:q ex:a , ex:b .', 'ex:s ex:p ex:z ; ex:q ex:a .'],
  ['sh:rootClass', 'sh:property [ sh:path ex:p ; sh:rootClass ex:Base ]',
    'ex:Sub rdfs:subClassOf ex:Base . ex:s ex:p ex:Sub .', 'ex:Unrel a rdfs:Class . ex:s ex:p ex:Unrel .'],
];

const UNIONS: readonly Row[] = [
  ['sh:class as a list', 'sh:property [ sh:path ex:p ; sh:class ( ex:A ex:B ) ]',
    'ex:o a ex:B . ex:s ex:p ex:o .', 'ex:o a ex:C . ex:s ex:p ex:o .'],
  ['sh:datatype as a list', 'sh:property [ sh:path ex:p ; sh:datatype ( xsd:integer xsd:string ) ]',
    'ex:s ex:p 1 .', 'ex:s ex:p true .'],
  ['sh:nodeKind as a list', 'sh:property [ sh:path ex:p ; sh:nodeKind ( sh:IRI sh:Literal ) ]',
    'ex:s ex:p ex:o .', 'ex:s ex:p [ ex:q 1 ] .'],
];

function check(row: Row): void {
  const [name, body, good, bad] = row;
  const shape = shapeFor(body);
  expect(validateAgainstShape(P + good, shape, {}).conforms,
    `${name}: the CONFORMING graph was refused — an over-strict constraint is as broken as an absent one`)
    .toBe(true);
  expect(validateAgainstShape(P + bad, shape, {}).conforms,
    `${name}: the VIOLATING graph was accepted — the constraint is inert`)
    .toBe(false);
}

describe('SHACL 1.0 logical constraints — parsed and dropped until now', () => {
  it.each(CORE_10.map(r => [r[0], r] as const))('%s enforces in both directions', (_n, row) => check(row));
});

describe('SHACL property paths — a non-IRI sh:path used to drop the whole property shape', () => {
  it.each(PATHS.map(r => [r[0], r] as const))('%s enforces in both directions', (_n, row) => check(row));

  it('zeroOrMore includes the focus node itself, oneOrMore does not', () => {
    // §4.5 vs §4.6, and the difference is observable: with no ex:next edge at all, the
    // reflexive form still yields one value node (the focus) and the transitive form yields
    // none. Getting this backwards would make sh:minCount 1 trivially true everywhere.
    const data = P + 'ex:s a ex:T .';
    const zeroOrMore = shapeFor('sh:property [ sh:path [ sh:zeroOrMorePath ex:next ] ; sh:minCount 1 ]');
    const oneOrMore = shapeFor('sh:property [ sh:path [ sh:oneOrMorePath ex:next ] ; sh:minCount 1 ]');
    expect(validateAgainstShape(data, zeroOrMore, {}).conforms).toBe(true);
    expect(validateAgainstShape(data, oneOrMore, {}).conforms).toBe(false);
  });

  it('a cyclic graph terminates instead of hanging', () => {
    const cyclic = P + 'ex:s ex:next ex:t . ex:t ex:next ex:s .';
    const shape = shapeFor('sh:property [ sh:path [ sh:zeroOrMorePath ex:next ] ; sh:maxCount 99 ]');
    expect(validateAgainstShape(cyclic, shape, {}).conforms).toBe(true);
  });
});

describe('SHACL 1.2 constraint components', () => {
  it.each(SHACL_12.map(r => [r[0], r] as const))('%s enforces in both directions', (_n, row) => check(row));

  it('a value node that is not a SHACL list violates the list constraints', () => {
    // §7.5: "Each value node v must be a SHACL list - if v is not a SHACL list there is a
    // validation result." Skipping a non-list would make the constraint opt-out by malformation.
    const shape = shapeFor('sh:property [ sh:path ex:list ; sh:minListLength 1 ]');
    expect(validateAgainstShape(P + 'ex:s ex:p 1 ; ex:list "not a list" .', shape, {}).conforms)
      .toBe(false);
  });
});

describe('SHACL 1.2 list-valued class / datatype / nodeKind — a union of choices', () => {
  it.each(UNIONS.map(r => [r[0], r] as const))('%s enforces in both directions', (_n, row) => check(row));

  it('the single-IRI form still means exactly what it did', () => {
    // The generalisation must not change the degenerate case; a list of one and a bare IRI
    // are the same constraint.
    const asIri = shapeFor('sh:property [ sh:path ex:p ; sh:datatype xsd:integer ]');
    const asList = shapeFor('sh:property [ sh:path ex:p ; sh:datatype ( xsd:integer ) ]');
    for (const data of ['ex:s ex:p 1 .', 'ex:s ex:p "x" .']) {
      expect(validateAgainstShape(P + data, asIri, {}).conforms)
        .toBe(validateAgainstShape(P + data, asList, {}).conforms);
    }
  });
});

describe('SHACL 1.2 targets', () => {
  const check12 = (shape: string, good: string, bad: string): void => {
    expect(validateAgainstShape(P + good, P + shape, {}).conforms).toBe(true);
    expect(validateAgainstShape(P + bad, P + shape, {}).conforms).toBe(false);
  };

  it('sh:targetWhere selects by CONFORMANCE rather than by lookup', () => {
    check12(`ex:S a sh:NodeShape ;
      sh:targetWhere [ sh:property [ sh:path ex:kind ; sh:hasValue "audited" ] ] ;
      sh:property [ sh:path ex:owner ; sh:minCount 1 ] .`,
    'ex:a ex:kind "audited" ; ex:owner ex:o .', 'ex:a ex:kind "audited" .');
  });

  it('sh:shape lets the DATA nominate which shape applies to it', () => {
    check12('ex:S a sh:NodeShape ; sh:property [ sh:path ex:owner ; sh:minCount 1 ] .',
      'ex:a sh:shape ex:S ; ex:owner ex:o .', 'ex:a sh:shape ex:S .');
  });

  it('a shape that is also an rdfs:Class targets its own instances implicitly', () => {
    check12('ex:S a sh:NodeShape , rdfs:Class ; sh:property [ sh:path ex:owner ; sh:minCount 1 ] .',
      'ex:a a ex:S ; ex:owner ex:o .', 'ex:a a ex:S .');
  });

  it('sh:ShapeClass does the same without claiming rdfs:Class', () => {
    check12('ex:S a sh:NodeShape , sh:ShapeClass ; sh:property [ sh:path ex:owner ; sh:minCount 1 ] .',
      'ex:a a ex:S ; ex:owner ex:o .', 'ex:a a ex:S .');
  });

  it('sh:targetNode names a node whether or not the data mentions it', () => {
    // ★ This searched data.subjects, so `sh:targetNode ex:s` + `sh:minCount 1` CONFORMED on
    // a graph where ex:s appeared only as an object, or not at all. §2.1.3.2 is
    // unconditional; an unmentioned node is a focus node with no properties.
    const shape = `${P}ex:S a sh:NodeShape ; sh:targetNode ex:s ;
      sh:property [ sh:path ex:required ; sh:minCount 1 ] .`;
    for (const data of ['ex:s a ex:T .', 'ex:other ex:zz ex:s .', 'ex:other ex:zz "x" .']) {
      expect(validateAgainstShape(P + data, shape, {}).conforms, `data: ${data}`).toBe(false);
    }
  });
});

describe('SHACL 1.2 severities', () => {
  const withSeverity = (sev: string): ReturnType<typeof validateAgainstShape> =>
    validateAgainstShape(P + 'ex:s ex:p "x" .',
      `${P}ex:S a sh:NodeShape ; sh:targetSubjectsOf ex:p ;
        sh:property [ sh:path ex:p ; sh:datatype xsd:integer ; sh:severity sh:${sev} ] .`, {});

  it.each([['Trace', true], ['Debug', true], ['Info', true], ['Warning', true], ['Violation', false]] as const)(
    'sh:%s produces a result; conforms stays %s', (sev, stillConforms) => {
      const r = withSeverity(sev);
      expect(r.results.length, `sh:${sev} produced no result at all`).toBeGreaterThan(0);
      expect(r.results[0]!.severity).toBe(sev);
      expect(r.conforms).toBe(stillConforms);
    });
});

describe('sh:closed sh:ByTypes', () => {
  it('closes against the properties of the node\'s OWN types, not of the carrying shape', () => {
    const shape = `${P}ex:T a sh:NodeShape ; sh:targetClass ex:Thing ;
      sh:property [ sh:path ex:allowed ] .
ex:C a sh:NodeShape ; sh:targetClass ex:Thing ; sh:closed sh:ByTypes ;
      sh:ignoredProperties ( rdf:type ) .`;
    expect(validateAgainstShape(P + 'ex:s a ex:Thing ; ex:allowed "x" .', shape, {}).conforms).toBe(true);
    expect(validateAgainstShape(P + 'ex:s a ex:Thing ; ex:allowed "x" ; ex:sneaky "y" .', shape, {}).conforms)
      .toBe(false);
  });
});

describe('SHACL 1.2 property-pair parameters take paths', () => {
  it('sh:equals accepts an inverse path, not only a predicate IRI', () => {
    const shape = shapeFor('sh:property [ sh:path ex:p ; sh:equals [ sh:inversePath ex:backref ] ]');
    expect(validateAgainstShape(P + 'ex:s ex:p ex:v . ex:v ex:backref ex:s .', shape, {}).conforms)
      .toBe(true);
    expect(validateAgainstShape(P + 'ex:s ex:p ex:v . ex:other ex:backref ex:s .', shape, {}).conforms)
      .toBe(false);
  });
});
