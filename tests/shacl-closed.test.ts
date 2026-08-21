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

describe('★ closed-world alone is NOT the privacy guarantee', () => {
  /**
   * The decisive property, and the reason a privacy contract needs TWO shapes.
   *
   * `sh:targetClass` is direct-type: SHACL does not entail subclasses, and this engine
   * does not either (`void options.entailment`). So one triple —
   * `ex:Rich rdfs:subClassOf ex:Turn` — makes an instance escape a closed shape entirely.
   * A one-triple bypass that returns a green 200.
   *
   * The counter is a shape with a DIFFERENT QUANTIFIER: `sh:targetSubjectsOf` selects a
   * node BECAUSE it carries the forbidden predicate, so it does not care what class the
   * carrier claims. Node-scoped positive closure answers "does this node carry anything
   * nobody anticipated?"; graph-scoped negative closure answers "does ANY node carry a
   * forbidden predicate?".
   *
   * Neither alone is the guarantee — it exists only in the conjunction. That is why the
   * ACP witness's privacy contract is specified as two shapes rather than one, and this
   * test is what makes the claim falsifiable.
   */
  const P = PREFIXES + `@prefix rdfs: <http://www.w3.org/2000/01/rdf-schema#> .\n`;
  const withSecret = (type: string) => P + `
ex:Rich rdfs:subClassOf ex:Turn .
ex:t a ${type} ; ex:allowed "fine" ; ex:secretPath "/home/me/.ssh/id_rsa" .
`;
  const CLOSED = P + `
ex:TurnShape a sh:NodeShape ; sh:targetClass ex:Turn ; sh:closed true ;
  sh:ignoredProperties ( rdf:type ) ;
  sh:property [ sh:path ex:allowed ; sh:minCount 1 ] .
`;
  const DENYLIST = P + `
ex:NoSecrets a sh:NodeShape ; sh:targetSubjectsOf ex:secretPath ;
  sh:property [ sh:path ex:secretPath ; sh:maxCount 0 ;
                sh:message "content-bearing predicate on a witnessed graph" ] .
`;

  it('the closed shape catches the secret on a DIRECT instance', () => {
    expect(validateAgainstShape(withSecret('ex:Turn'), CLOSED).conforms).toBe(false);
  });

  it('…and a SUBCLASS no longer escapes it — the one-triple bypass is closed', () => {
    // This test used to assert `true` and document the hole. It closed when the subclass
    // closure stopped being opt-in: sh:targetClass is defined over SHACL instances
    // (rdf:type + rdfs:subClassOf*), so a shape targeting ex:Turn always reached ex:Rich
    // and we were simply not implementing it. See tests/shacl-entailment.test.ts.
    //
    // Per that comment's own instruction, the denylist below is STILL required, and the
    // two tests after this one are why: it is graph-scoped rather than class-targeted, so
    // it also catches a secret on a node carrying no rdf:type for any closure to follow.
    expect(validateAgainstShape(withSecret('ex:Rich'), CLOSED).conforms).toBe(false);
  });

  it('and the denylist still earns its place: an UNTYPED node has no closure to follow', () => {
    // The justification for keeping both, made checkable. sh:targetSubjectsOf keys on the
    // predicate, so it reaches a node the class-targeted shape cannot see at all — no
    // rdf:type means no subclass path to ex:Turn, however complete the closure is.
    const untyped = P + `ex:t ex:allowed "fine" ; ex:secretPath "/home/me/.ssh/id_rsa" .\n`;
    expect(validateAgainstShape(untyped, CLOSED).conforms).toBe(true);
    expect(validateAgainstShape(untyped, DENYLIST).conforms).toBe(false);
  });

  it('the graph-scoped denylist catches what the closed shape missed', () => {
    const r = validateAgainstShape(withSecret('ex:Rich'), DENYLIST);
    expect(r.conforms).toBe(false);
    expect(r.results.some(v => /content-bearing/.test(v.message ?? ''))).toBe(true);
  });

  it('and it still catches the direct case, so the pair covers both', () => {
    expect(validateAgainstShape(withSecret('ex:Turn'), DENYLIST).conforms).toBe(false);
  });
});
