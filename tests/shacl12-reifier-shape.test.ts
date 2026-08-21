/**
 * SHACL 1.2 §7.8.5 — sh:reifierShape / sh:reificationRequired, measured against W3C's own
 * approved test cases.
 *
 * ★ WHY THESE FIXTURES AND NOT A SECOND ENGINE. Nothing available here can cross-check this
 * constraint. pySHACL implements neither term (grep of the installed 0.30.1: zero hits), and
 * its maintainer records that RDF 1.2 support is blocked on rdflib — which, measured
 * locally at 7.2.1, parses none of RDF 1.2's new syntax: not `{| |}`, not `<<( )>>`, not
 * `~`, not even `@version "1.2"`. Apache Jena's SHACL 1.2 issue is open with nothing landed;
 * open-source TopBraid does not support 1.2 either, per its own maintainer. The one
 * independent implementation is rudof (Rust, on Oxigraph), which self-describes its support
 * as a "first version" and which I have not run.
 *
 * So the usual move — agree with a reference implementation, as tools/shacl-agreement/ does
 * for SHACL Core — is unavailable, and this file says so rather than quietly doing without.
 * What replaces it is better than a second engine anyway: W3C publishes ITS OWN test cases
 * for this constraint, both `mf:status sht:approved`, and an approved test is the artifact an
 * implementation is actually measured against.
 *
 * ★ THE EXPECTATIONS ARE READ FROM THE FIXTURE, NOT TRANSCRIBED. Each file states its own
 * `mf:result` — conforms, focus node, path, component, source shape, value — and this test
 * parses that block and compares. Retyping them here would create a second source of truth
 * that goes stale the first time W3C edits a fixture, and would also let a typo in my
 * transcription pass as agreement.
 *
 * ★ TWO SPEC DEFECTS THESE TESTS RESOLVE, recorded because the prose alone would have sent
 * an implementer the other way:
 *
 *   1. §7.8.5 says the validation result carries the TRIPLE TERM as sh:value. Both approved
 *      fixtures expect the VALUE NODE. The prose also rebinds its own variable mid-sentence
 *      ("Let t be the triple term (focus node, $path, value node). … For each reifier t …"),
 *      so it cannot be read consistently. The tests win.
 *   2. Appendix C of the published WD appears to declare sh:ReificationRequiredConstraint-
 *      Component. It is a ReSpec generation artifact — absent from the editor's draft source
 *      and from both fixtures, and §7.8.5 states the component IRI is
 *      sh:ReifierShapeConstraintComponent. Fixture 002, the reificationRequired case, emits
 *      sh:ReifierShapeConstraintComponent, so that is what this engine emits.
 *
 * Fixtures vendored as DATA under tests/fixtures/shacl12-w3c/, checked in rather than
 * fetched: a test that reaches the network to learn what it expects is not a test.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { validateAgainstShape, parseTrig } from '@interego/core';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..');
const FIXTURES = join(REPO, 'tests/fixtures/shacl12-w3c');
const SH = 'http://www.w3.org/ns/shacl#';

interface Expected {
  conforms: boolean;
  focusNode?: string;
  resultPath?: string;
  component?: string;
  sourceShape?: string;
  value?: string;
}

/** Read what the fixture itself says the report must be. */
function expectationOf(ttl: string): Expected {
  const doc = parseTrig(ttl);
  const one = (subjIndex: number, pred: string): string | undefined => {
    const t = doc.subjects[subjIndex]?.properties.get(`${SH}${pred}` as never)?.[0];
    if (!t) return undefined;
    return t.kind === 'iri' ? t.iri : t.kind === 'literal' ? t.value : undefined;
  };
  const reportIdx = doc.subjects.findIndex(s => s.properties.has(`${SH}conforms` as never));
  const resultIdx = doc.subjects.findIndex(s => s.properties.has(`${SH}sourceConstraintComponent` as never));
  expect(reportIdx, 'fixture states no sh:conforms').toBeGreaterThanOrEqual(0);
  return {
    conforms: one(reportIdx, 'conforms') === 'true',
    focusNode: one(resultIdx, 'focusNode'),
    resultPath: one(resultIdx, 'resultPath'),
    component: one(resultIdx, 'sourceConstraintComponent'),
    sourceShape: one(resultIdx, 'sourceShape'),
    value: one(resultIdx, 'value'),
  };
}

describe.each(['reifierShape-001', 'reifierShape-002'])('W3C approved fixture %s', name => {
  const ttl = readFileSync(join(FIXTURES, `${name}.ttl`), 'utf8');
  // Both fixtures put data and shapes in the same graph (sht:dataGraph <> ; sht:shapesGraph <>).
  const report = validateAgainstShape(ttl, ttl, {});
  const want = expectationOf(ttl);
  const violations = report.results.filter(r => r.severity === 'Violation');

  it('is an APPROVED test, so its expectation is authoritative', () => {
    expect(ttl).toContain('mf:status sht:approved');
  });

  it('agrees on conformance', () => {
    expect(report.conforms).toBe(want.conforms);
  });

  it('produces exactly the one expected violation', () => {
    expect(violations.length).toBe(1);
  });

  it('reports it against the right focus node and path', () => {
    expect(violations[0]!.focusNode).toBe(want.focusNode);
    expect(violations[0]!.path).toBe(want.resultPath);
  });

  it('names sh:ReifierShapeConstraintComponent — one component for BOTH parameters', () => {
    expect(want.component).toBe(`${SH}ReifierShapeConstraintComponent`);
    expect(violations[0]!.constraintComponent).toBe(want.component);
  });

  it('attributes it to the PROPERTY shape, not the node shape', () => {
    // The fixture expects ex:TestShape-propertyA. This engine reported the enclosing node
    // shape on every property-constraint result until these fixtures said otherwise.
    expect(violations[0]!.sourceShape).toBe(want.sourceShape);
  });

  it('carries the VALUE NODE as sh:value, per the fixture over the prose', () => {
    expect(violations[0]!.value).toBe(want.value);
  });

  it('and reports the check as actually run, not skipped', () => {
    // Without this, an engine that silently ignored sh:reifierShape would satisfy the
    // conformance assertion above on fixture 001 by coincidence of a different failure.
    expect(report.fullyChecked).toBe(true);
  });
});

describe('the inline reifier shape, which the W3C fixtures do not cover', () => {
  // Our own docs/ns/iep-shapes-1.2.ttl writes `sh:reifierShape [ a sh:NodeShape ; … ]`
  // rather than referencing a named shape. Both fixtures use a named ex:ReifyShape, so
  // nothing above would catch an inline shape failing to compile — which is exactly how
  // sh:qualifiedValueShape once silently enforced nothing here.
  const P = `@prefix sh: <http://www.w3.org/ns/shacl#> .
@prefix xsd: <http://www.w3.org/2001/XMLSchema#> .
@prefix ex: <https://example.org/> .
`;
  const SHAPE = P + `
ex:S a sh:NodeShape ;
  sh:targetSubjectsOf ex:hasItem ;
  sh:property [
    sh:path ex:hasItem ;
    sh:reifierShape [
      a sh:NodeShape ;
      sh:property [ sh:path ex:position ; sh:datatype xsd:integer ; sh:minCount 1 ]
    ] ;
    sh:reificationRequired true
  ] .`;
  const check = (data: string) => validateAgainstShape(P + data, SHAPE, {});

  it('accepts a correctly annotated statement', () => {
    const r = check('ex:p ex:hasItem ex:c {| ex:position 1 |} .');
    expect(r.conforms).toBe(true);
    expect(r.fullyChecked).toBe(true);
  });

  it('rejects an annotation whose value has the wrong datatype', () => {
    expect(check('ex:p ex:hasItem ex:c {| ex:position "one" |} .').conforms).toBe(false);
  });

  it('rejects an annotation missing the required property', () => {
    expect(check('ex:p ex:hasItem ex:c {| ex:other 1 |} .').conforms).toBe(false);
  });

  it('rejects a bare statement when sh:reificationRequired is true', () => {
    expect(check('ex:p ex:hasItem ex:c .').conforms).toBe(false);
  });
});

describe('an ill-formed reifier constraint is REPORTED, not silently dropped', () => {
  // ★ SHACL 1.2 has no well-formedness rule for this. Appendix A carries six explicit
  // "Node shapes cannot have any value for sh:X" rules and sh:reifierShape is not one of
  // them, so a validator is free to compile these into nothing and say `conforms`. That is
  // precisely how docs/ns/iep-shapes-1.2.ttl shipped: three shapes, no sh:path between
  // them, enforcing nothing under dereferenceable names.
  const P = `@prefix sh: <http://www.w3.org/ns/shacl#> .
@prefix ex: <https://example.org/> .
`;
  const data = P + 'ex:p ex:hasItem ex:c .';

  it('flags sh:reifierShape on a node shape with no sh:path', () => {
    const shape = P + `ex:S a sh:NodeShape ; sh:targetSubjectsOf ex:hasItem ;
  sh:reifierShape [ a sh:NodeShape ; sh:property [ sh:path ex:position ; sh:minCount 1 ] ] .`;
    const r = validateAgainstShape(data, shape, {});
    expect(r.results.some(x => /no sh:path/i.test(x.message ?? ''))).toBe(true);
    expect(r.fullyChecked).toBe(false);
  });

  it('flags sh:reifierShape on a complex (non-IRI) sh:path', () => {
    // Appendix A: "If a value for sh:reifierShape is given, sh:path values are constrained
    // to IRIs." A sequence/alternative path is a blank node.
    const shape = P + `ex:S a sh:NodeShape ; sh:targetSubjectsOf ex:hasItem ;
  sh:property [ sh:path [ sh:inversePath ex:hasItem ] ;
                sh:reifierShape [ a sh:NodeShape ] ] .`;
    const r = validateAgainstShape(data, shape, {});
    expect(r.results.some(x => /sh:reifierShape/i.test(x.message ?? ''))).toBe(true);
  });
});
