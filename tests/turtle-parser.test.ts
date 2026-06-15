/**
 * TriG / Turtle subject-extraction parser tests.
 *
 * Covers: prefix expansion, full-IRI predicates (long form), datatyped
 * literals, language-tagged literals, comments inside / outside strings,
 * triple-quoted strings, escaped characters, blank nodes, graph blocks,
 * integer parsing, supersedes-chain reasoning.
 */

import { describe, it, expect } from 'vitest';
import {
  findSubjectsOfType,
  parseTrig,
  readIntegerValue,
  readIriValue,
  readStringValues,
} from '@interego/core';
import type {
  IRI,
} from '@interego/core';

const CGH = (l: string) => `https://markjspivey-xwisee.github.io/interego/ns/harness#${l}` as IRI;

describe('TriG parser — basic prefix + property extraction', () => {
  it('parses a well-formed PromotionConstraint with prefixed names', () => {
    const trig = `@prefix cgh: <https://markjspivey-xwisee.github.io/interego/ns/harness#> .
<urn:cg:c:1> a cgh:PromotionConstraint ;
  cgh:requiresAttestationAxis "safety" ;
  cgh:requiresMinimumPeerAttestations 2 ;
  cgh:ratifiedBy <urn:cg:amend:1> .`;
    const doc = parseTrig(trig);
    const constraints = findSubjectsOfType(doc, CGH('PromotionConstraint'));
    expect(constraints).toHaveLength(1);
    expect(readStringValues(constraints[0]!, CGH('requiresAttestationAxis'))).toEqual(['safety']);
    expect(readIntegerValue(constraints[0]!, CGH('requiresMinimumPeerAttestations'))).toBe(2);
    expect(readIriValue(constraints[0]!, CGH('ratifiedBy'))).toBe('urn:cg:amend:1');
  });

  it('parses long-form IRI predicates (no prefix label needed)', () => {
    const trig = `<urn:cg:c:1> <http://www.w3.org/1999/02/22-rdf-syntax-ns#type> <https://markjspivey-xwisee.github.io/interego/ns/harness#PromotionConstraint> ;
  <https://markjspivey-xwisee.github.io/interego/ns/harness#requiresAttestationAxis> "safety" .`;
    const doc = parseTrig(trig);
    const constraints = findSubjectsOfType(doc, CGH('PromotionConstraint'));
    expect(constraints).toHaveLength(1);
    expect(readStringValues(constraints[0]!, CGH('requiresAttestationAxis'))).toEqual(['safety']);
  });

  it('handles datatyped string literals ("v"^^xsd:string)', () => {
    const trig = `@prefix cgh: <https://markjspivey-xwisee.github.io/interego/ns/harness#> .
@prefix xsd: <http://www.w3.org/2001/XMLSchema#> .
<urn:cg:c:1> a cgh:PromotionConstraint ;
  cgh:requiresAttestationAxis "safety"^^xsd:string ;
  cgh:requiresMinimumPeerAttestations "3"^^xsd:integer .`;
    const doc = parseTrig(trig);
    const c = findSubjectsOfType(doc, CGH('PromotionConstraint'))[0]!;
    expect(readStringValues(c, CGH('requiresAttestationAxis'))).toEqual(['safety']);
    expect(readIntegerValue(c, CGH('requiresMinimumPeerAttestations'))).toBe(3);
  });

  it('handles comment lines that name the same predicate', () => {
    // The regex parser would have picked up the commented-out value.
    const trig = `@prefix cgh: <https://markjspivey-xwisee.github.io/interego/ns/harness#> .
# cgh:requiresAttestationAxis "fake-from-comment"
<urn:cg:c:1> a cgh:PromotionConstraint ;
  cgh:requiresAttestationAxis "real" .`;
    const doc = parseTrig(trig);
    const c = findSubjectsOfType(doc, CGH('PromotionConstraint'))[0]!;
    expect(readStringValues(c, CGH('requiresAttestationAxis'))).toEqual(['real']);
  });

  it('handles strings containing escaped quotes', () => {
    const trig = `@prefix cgh: <https://markjspivey-xwisee.github.io/interego/ns/harness#> .
<urn:cg:c:1> a cgh:PromotionConstraint ;
  cgh:requiresAttestationAxis "with \\"quote\\" inside" .`;
    const doc = parseTrig(trig);
    const c = findSubjectsOfType(doc, CGH('PromotionConstraint'))[0]!;
    expect(readStringValues(c, CGH('requiresAttestationAxis'))).toEqual(['with "quote" inside']);
  });

  it('handles language-tagged strings', () => {
    const trig = `@prefix cgh: <https://markjspivey-xwisee.github.io/interego/ns/harness#> .
<urn:cg:c:1> a cgh:PromotionConstraint ;
  cgh:requiresAttestationAxis "safety"@en .`;
    const doc = parseTrig(trig);
    const c = findSubjectsOfType(doc, CGH('PromotionConstraint'))[0]!;
    const terms = c.properties.get(CGH('requiresAttestationAxis'))!;
    expect(terms[0]!).toMatchObject({ kind: 'literal', value: 'safety', language: 'en' });
  });

  it('handles triple-quoted multi-line strings', () => {
    const trig = `@prefix cgh: <https://markjspivey-xwisee.github.io/interego/ns/harness#> .
<urn:cg:c:1> a cgh:PromotionConstraint ;
  cgh:requiresAttestationAxis """multi
line
value""" .`;
    const doc = parseTrig(trig);
    const c = findSubjectsOfType(doc, CGH('PromotionConstraint'))[0]!;
    expect(readStringValues(c, CGH('requiresAttestationAxis'))[0]).toBe('multi\nline\nvalue');
  });

  it('collects multiple values for the same predicate (object list)', () => {
    const trig = `@prefix cgh: <https://markjspivey-xwisee.github.io/interego/ns/harness#> .
<urn:cg:c:1> a cgh:PromotionConstraint ;
  cgh:requiresAttestationAxis "safety" , "provenance" , "signature" .`;
    const doc = parseTrig(trig);
    const c = findSubjectsOfType(doc, CGH('PromotionConstraint'))[0]!;
    expect(readStringValues(c, CGH('requiresAttestationAxis'))).toEqual(['safety', 'provenance', 'signature']);
  });

  it('parses graph blocks { ... }', () => {
    const trig = `@prefix cgh: <https://markjspivey-xwisee.github.io/interego/ns/harness#> .
<urn:graph:1> {
  <urn:cg:c:1> a cgh:PromotionConstraint ;
    cgh:requiresAttestationAxis "safety" .
}`;
    const doc = parseTrig(trig);
    const c = findSubjectsOfType(doc, CGH('PromotionConstraint'))[0]!;
    expect(readStringValues(c, CGH('requiresAttestationAxis'))).toEqual(['safety']);
  });

  it('parses inline blank node property lists [ ... ]', () => {
    const trig = `@prefix cgh: <https://markjspivey-xwisee.github.io/interego/ns/harness#> .
<urn:cg:c:1> a cgh:PromotionConstraint ;
  cgh:requiresAttestationAxis "safety" ;
  cgh:nested [ cgh:inner "x" ] .`;
    const doc = parseTrig(trig);
    const c = findSubjectsOfType(doc, CGH('PromotionConstraint'))[0]!;
    // The nested anonymous bnode is a separate subject; the constraint
    // still has a reference to it as a bnode-typed object.
    const nested = c.properties.get(CGH('nested'))!;
    expect(nested[0]!.kind).toBe('bnode');
  });
});

describe('TriG parser — adversarial / edge cases', () => {
  it('throws on unterminated string', () => {
    const trig = `@prefix cgh: <https://markjspivey-xwisee.github.io/interego/ns/harness#> .
<urn:cg:c:1> cgh:requiresAttestationAxis "unterminated`;
    expect(() => parseTrig(trig)).toThrow();
  });

  it('throws on unknown prefix usage', () => {
    const trig = `<urn:cg:c:1> mystery:something "x" .`;
    expect(() => parseTrig(trig)).toThrow(/unknown prefix/);
  });

  it('does not match a predicate-name fragment that appears inside a string literal', () => {
    const trig = `@prefix cgh: <https://markjspivey-xwisee.github.io/interego/ns/harness#> .
<urn:cg:c:1> a cgh:PromotionConstraint ;
  cgh:requiresAttestationAxis "this string mentions cgh:requiresAttestationAxis but is just data" .`;
    const doc = parseTrig(trig);
    const c = findSubjectsOfType(doc, CGH('PromotionConstraint'))[0]!;
    const values = readStringValues(c, CGH('requiresAttestationAxis'));
    expect(values).toHaveLength(1);
    expect(values[0]).toContain('but is just data');
  });

  it('handles comment with # after a triple terminator', () => {
    const trig = `@prefix cgh: <https://markjspivey-xwisee.github.io/interego/ns/harness#> .
<urn:cg:c:1> a cgh:PromotionConstraint ;
  cgh:requiresAttestationAxis "safety" . # trailing comment cgh:requiresAttestationAxis "fake"
<urn:cg:c:2> a cgh:PromotionConstraint ;
  cgh:requiresAttestationAxis "second" .`;
    const doc = parseTrig(trig);
    const constraints = findSubjectsOfType(doc, CGH('PromotionConstraint'));
    expect(constraints).toHaveLength(2);
    const axes = constraints.flatMap(c => readStringValues(c, CGH('requiresAttestationAxis')));
    expect(axes.sort()).toEqual(['safety', 'second']);
  });

  it('returns empty when input contains no PromotionConstraint subjects', () => {
    const trig = `@prefix foaf: <http://xmlns.com/foaf/0.1/> .
<urn:agent:1> a foaf:Agent ;
  foaf:name "alpha" .`;
    const doc = parseTrig(trig);
    expect(findSubjectsOfType(doc, CGH('PromotionConstraint'))).toEqual([]);
  });

  it('rejects pathologically nested blank-node input before stack overflow', () => {
    // Pre-stack-overflow protection: 1000 nested `[ a foaf:X ` blocks
    // would blow the JS recursion limit. The parser caps at
    // MAX_NESTING_DEPTH (256) and throws a ParseError instead.
    const open = '@prefix cgh: <https://markjspivey-xwisee.github.io/interego/ns/harness#> .\n<urn:cg:c:1> cgh:nested ' + '[ cgh:nested '.repeat(1000);
    const close = ']'.repeat(1000) + ' .';
    const trig = open + close;
    expect(() => parseTrig(trig)).toThrow(/maximum nesting depth/);
  });

  it('handles legitimately nested blank-node input up to a reasonable depth', () => {
    // 10 nested layers is well within the cap.
    const open = '@prefix cgh: <https://markjspivey-xwisee.github.io/interego/ns/harness#> .\n<urn:cg:c:1> cgh:nested ' + '[ cgh:nested '.repeat(10);
    const close = '"leaf"' + ']'.repeat(10) + ' .';
    expect(() => parseTrig(open + close)).not.toThrow();
  });
});

describe('TriG parser — RDF Collection syntax `( ... )`', () => {
  // Regression for the f-shin-collection finding: a shape with
  // `sh:in ( "X" "O" )` tripped the parser, validateAgainstShape
  // caught the throw and silently returned conforms:true, and the
  // gate vacuously accepted every value (including illegal marks
  // outside the enumeration). The parser now desugars `( ... )` into
  // the standard RDF list form (head bnode + rdf:first/rdf:rest
  // chain terminating at rdf:nil) so downstream consumers can walk it.
  const RDF_FIRST = 'http://www.w3.org/1999/02/22-rdf-syntax-ns#first' as IRI;
  const RDF_REST = 'http://www.w3.org/1999/02/22-rdf-syntax-ns#rest' as IRI;
  const RDF_NIL = 'http://www.w3.org/1999/02/22-rdf-syntax-ns#nil' as IRI;

  it('object-position collection ( "X" "O" ) parses without throwing', () => {
    const trig = `@prefix ex: <http://example/> .
<urn:s:1> ex:p ( "X" "O" ) .`;
    expect(() => parseTrig(trig)).not.toThrow();
  });

  it('object-position collection desugars to a walkable rdf:first/rdf:rest chain', () => {
    const trig = `@prefix ex: <http://example/> .
<urn:s:1> ex:p ( "X" "O" ) .`;
    const doc = parseTrig(trig);
    const subject = doc.subjects.find(s => s.subject === 'urn:s:1');
    expect(subject).toBeDefined();
    const head = subject!.properties.get('http://example/p' as IRI)?.[0];
    expect(head?.kind).toBe('bnode');
    // Walk the rdf:first/rdf:rest chain and collect the literal values.
    const values: string[] = [];
    let cursor = head;
    for (let i = 0; i < 16 && cursor && cursor.kind === 'bnode'; i++) {
      const cellId = cursor.id;
      const cell = doc.subjects.find(s =>
        typeof s.subject === 'object' && 'bnode' in s.subject && s.subject.bnode === cellId,
      );
      if (!cell) break;
      const first = cell.properties.get(RDF_FIRST)?.[0];
      if (first?.kind === 'literal') values.push(first.value);
      const rest = cell.properties.get(RDF_REST)?.[0];
      if (!rest) break;
      if (rest.kind === 'iri' && rest.iri === RDF_NIL) break;
      cursor = rest;
    }
    expect(values).toEqual(['X', 'O']);
  });

  it('empty collection () desugars to rdf:nil', () => {
    const trig = `@prefix ex: <http://example/> .
<urn:s:1> ex:p () .`;
    const doc = parseTrig(trig);
    const subject = doc.subjects.find(s => s.subject === 'urn:s:1');
    const head = subject!.properties.get('http://example/p' as IRI)?.[0];
    expect(head?.kind).toBe('iri');
    if (head?.kind === 'iri') expect(head.iri).toBe(RDF_NIL);
  });

  it('nested collection ( ( "X" ) "Y" ) parses without throwing', () => {
    const trig = `@prefix ex: <http://example/> .
<urn:s:1> ex:p ( ( "X" ) "Y" ) .`;
    expect(() => parseTrig(trig)).not.toThrow();
  });

  it('collection inside a blank-node property list parses', () => {
    const trig = `@prefix sh: <http://www.w3.org/ns/shacl#> .
@prefix ttt: <urn:ttt:> .
ttt:Shape a sh:NodeShape ;
  sh:property [
    sh:path ttt:mark ;
    sh:in ( "X" "O" )
  ] .`;
    expect(() => parseTrig(trig)).not.toThrow();
  });

  it('unterminated collection throws (does not silently accept)', () => {
    // `.` inside the collection short-circuits the inner term parse
    // before the loop's own "missing `)`" check fires. Either error
    // path is fine — what matters is that the parser does NOT silently
    // accept a malformed list.
    const trig = `@prefix ex: <http://example/> .
<urn:s:1> ex:p ( "X" "O" .`;
    expect(() => parseTrig(trig)).toThrow();
  });
});
