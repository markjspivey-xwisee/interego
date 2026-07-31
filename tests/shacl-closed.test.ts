/**
 * sh:closed — refusing a predicate nobody anticipated.
 *
 * ★ WHY THIS WAS MISSING AND WHY IT MATTERS. The engine implemented minCount, maxCount,
 * datatype, nodeKind, pattern, class, in, hasValue, and/or/not/xone, qualifiedValueShape
 * and sparql — every one of which answers "is what IS here acceptable?". None of them can
 * answer "is anything here that should NOT be?".
 *
 * That distinction is not academic. A published shape is this system's mechanism for
 * enforcing a data contract on the write path (`publish_context`'s `conforms_to_shapes`
 * gate), and the contract people actually want to write is "this graph may carry ONLY
 * these fields" — for instance, an ACP work-trace that must never carry a developer's
 * file paths or tool payloads. Without sh:closed, the strongest available approximation is
 * an enumerated denylist, which refuses the predicates you thought of and admits the ones
 * you did not. For a privacy guarantee that is the wrong way round.
 *
 * ★ FAIL-OPEN IS DELIBERATE, AND ONLY HERE. A shape is closed only when sh:closed is
 * literally "true". Anything else leaves it open, because silently closing a shape its
 * author did not close would reject valid data across the whole federation.
 */
import { describe, it, expect } from 'vitest';
import { validateAgainstShape } from '@interego/core';

const PREFIXES = `
@prefix sh:   <http://www.w3.org/ns/shacl#> .
@prefix ex:   <https://example.org/> .
@prefix xsd:  <http://www.w3.org/2001/XMLSchema#> .
@prefix rdf:  <http://www.w3.org/1999/02/22-rdf-syntax-ns#> .
`;

/** A closed shape permitting exactly ex:allowed, plus rdf:type. */
const CLOSED_SHAPE = `${PREFIXES}
ex:TurnShape a sh:NodeShape ;
  sh:targetClass ex:Turn ;
  sh:closed true ;
  sh:ignoredProperties ( rdf:type ) ;
  sh:property [ sh:path ex:allowed ; sh:minCount 1 ] .
`;

/** Same shape, not closed. */
const OPEN_SHAPE = `${PREFIXES}
ex:TurnShape a sh:NodeShape ;
  sh:targetClass ex:Turn ;
  sh:property [ sh:path ex:allowed ; sh:minCount 1 ] .
`;

const data = (extra: string): string => `${PREFIXES}
ex:t1 a ex:Turn ;
  ex:allowed "fine" ${extra} .
`;

const run = (shape: string, dataTtl: string) => validateAgainstShape(dataTtl, shape);

describe('sh:closed refuses undeclared predicates', () => {
  it('accepts a node carrying only declared predicates', async () => {
    const r = run(CLOSED_SHAPE, data(''));
    expect(r.conforms, JSON.stringify(r.results)).toBe(true);
  });

  it('REFUSES a predicate the shape never declared', async () => {
    // The case the whole feature exists for: a field nobody anticipated.
    const r = run(CLOSED_SHAPE, data('; ex:secretFilePath "/home/me/.ssh/id_rsa"'));
    expect(r.conforms).toBe(false);
    expect(r.results.some(v => v.path === 'https://example.org/secretFilePath')).toBe(true);
    expect(r.results.some(v => /ClosedConstraintComponent/.test(v.constraintComponent))).toBe(true);
  });

  it('names the offending predicate, so the violation is actionable', async () => {
    const r = run(CLOSED_SHAPE, data('; ex:payload "secret"'));
    const v = r.results.find(x => x.path === 'https://example.org/payload');
    expect(v?.message).toMatch(/does not permit predicate/);
  });

  it('permits predicates listed in sh:ignoredProperties', async () => {
    // rdf:type is present in the data and only passes because it is listed.
    const r = run(CLOSED_SHAPE, data(''));
    expect(r.conforms).toBe(true);
  });

  it('rdf:type is NOT implicitly ignored, and the message says so', async () => {
    // SHACL requires rdf:type to be listed explicitly. Authors reliably forget, and a
    // bare "does not permit rdf:type" leaves them guessing.
    const shapeWithoutIgnored = `${PREFIXES}
ex:TurnShape a sh:NodeShape ;
  sh:targetClass ex:Turn ;
  sh:closed true ;
  sh:property [ sh:path ex:allowed ; sh:minCount 1 ] .
`;
    const r = run(shapeWithoutIgnored, data(''));
    expect(r.conforms).toBe(false);
    const v = r.results.find(x => x.path === 'http://www.w3.org/1999/02/22-rdf-syntax-ns#type');
    expect(v?.message).toMatch(/sh:ignoredProperties/);
  });
});

describe('a shape is open unless it says otherwise', () => {
  it('an undeclared predicate is fine on an OPEN shape', async () => {
    const r = run(OPEN_SHAPE, data('; ex:anything "allowed"'));
    expect(r.conforms, JSON.stringify(r.results)).toBe(true);
  });

  it('sh:closed false leaves the shape open', async () => {
    const explicitlyOpen = CLOSED_SHAPE.replace('sh:closed true', 'sh:closed false');
    const r = run(explicitlyOpen, data('; ex:anything "allowed"'));
    expect(r.conforms).toBe(true);
  });

  it('a malformed sh:closed value does NOT close the shape', async () => {
    // Fail-open: silently closing a shape its author did not close would reject valid
    // data across the federation. This is the one place fail-open is right.
    const weird = CLOSED_SHAPE.replace('sh:closed true', 'sh:closed "yes"');
    const r = run(weird, data('; ex:anything "allowed"'));
    expect(r.conforms).toBe(true);
  });
});

describe('closed-world composes with the ordinary constraints', () => {
  it('a missing required property still fails on a closed shape', async () => {
    const missing = `${PREFIXES}
ex:t1 a ex:Turn .
`;
    const r = run(CLOSED_SHAPE, missing);
    expect(r.conforms).toBe(false);
    expect(r.results.some(v => /MinCount/i.test(v.constraintComponent))).toBe(true);
  });

  it('reports BOTH a missing required field and an undeclared extra one', async () => {
    const both = `${PREFIXES}
ex:t1 a ex:Turn ;
  ex:unexpected "x" .
`;
    const r = run(CLOSED_SHAPE, both);
    expect(r.conforms).toBe(false);
    expect(r.results.some(v => /MinCount/i.test(v.constraintComponent))).toBe(true);
    expect(r.results.some(v => /Closed/i.test(v.constraintComponent))).toBe(true);
  });
});
