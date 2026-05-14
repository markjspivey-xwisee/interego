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
  parseTrig,
  findSubjectsOfType,
  readStringValues,
  readIntegerValue,
  readIriValue,
} from '../src/rdf/turtle-parser.js';
import type { IRI } from '../src/index.js';

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
