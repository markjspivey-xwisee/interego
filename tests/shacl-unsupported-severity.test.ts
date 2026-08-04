/**
 * "This validator skipped a constraint" must be graded against the DATA, not the shape file.
 *
 * ★ THE DEFECT. The engine's unsupported-construct scan walked `shapeDoc.subjects` and
 * consulted the data graph nowhere, then hard-coded `severity: 'Info'`. Info is excluded
 * from `conforms`, so `conforms: true` was returned for graphs where a declared constraint
 * had not been evaluated at all — and there was no field a caller could read to find that
 * out. Validating the EMPTY STRING against a shapes file produced byte-identical notes to
 * validating a real graph, so even a caller willing to inspect the notes could not tell
 * "your data hit a rule I cannot check" from "this file mentions a construct I do not
 * implement."
 *
 * ★ WHY THE FIX IS A NEW FIELD AND NOT A PROMOTION TO Violation. Measured: promoting these
 * notes to Violation refuses four of the five fixtures in
 * `spec/conformance/fixtures/revocation/`, three of which say in their own headers that
 * they MUST be accepted. `docs/ns/iep-shapes.ttl` attaches `sh:sparql` to shapes targeting
 * `iep:SemioticFacet` and `iep:RevocationCondition` — classes essentially every descriptor
 * carries — and this substrate ships no SPARQL evaluator. A Violation is a statement about
 * the DATA; the data broke nothing. `report.fullyChecked` says the true thing instead, and
 * `conforms && fullyChecked` is the fail-closed predicate for a write gate to apply.
 */
import { describe, it, expect } from 'vitest';
import { validateAgainstShape } from '@interego/core';

const PREFIXES = `
@prefix sh:  <http://www.w3.org/ns/shacl#> .
@prefix ex:  <https://example.org/> .
@prefix rdf: <http://www.w3.org/1999/02/22-rdf-syntax-ns#> .
`;

/** A shape carrying sh:sparql — a construct this engine does not evaluate. */
const SPARQL_SHAPE = `${PREFIXES}
ex:PersonShape a sh:NodeShape ;
  sh:targetClass ex:Person ;
  sh:sparql [ sh:message "custom rule" ; sh:select "SELECT $this WHERE { }" ] .
`;

const PERSON_DATA = `${PREFIXES}
ex:alice a ex:Person ; ex:name "Alice" .
`;

/** Same shape, but the data graph contains no ex:Person at all. */
const OTHER_DATA = `${PREFIXES}
ex:widget a ex:Widget ; ex:name "Widget" .
`;

describe('an unevaluated constraint is reported as unevaluated, not as conformance', () => {
  it('fullyChecked is false when a focus node DID reach the skipped construct', () => {
    const report = validateAgainstShape(PERSON_DATA, SPARQL_SHAPE);
    // ★ The load-bearing assertion. `conforms` was — and remains — true, because the data
    // broke no rule. Before the fix there was nothing else in the report to read.
    expect(report.conforms).toBe(true);
    expect(report.fullyChecked).toBe(false);
    const note = report.results.find(r => /sh:sparql/.test(r.message));
    expect(note?.message).toContain('fullyChecked is false');
  });

  it('fullyChecked stays TRUE when no focus node reached the shape', () => {
    // The distinction the data-blind scan could not make. A gate that refused on the mere
    // presence of sh:sparql anywhere in a big shapes file would refuse everything citing it.
    const report = validateAgainstShape(OTHER_DATA, SPARQL_SHAPE);
    expect(report.fullyChecked).toBe(true);
    expect(report.conforms).toBe(true);
    expect(report.results.find(r => /sh:sparql/.test(r.message))?.message)
      .toContain('nothing was actually skipped');
  });

  it('an EMPTY data graph is fully checked', () => {
    // The relay probes `validateAgainstShape('', body)` to decide whether a fetched body is
    // a shapes graph at all. Every such probe would report a gap if presence alone counted.
    expect(validateAgainstShape('', SPARQL_SHAPE).fullyChecked).toBe(true);
  });

  it('a shape with no unimplemented construct is fully checked', () => {
    const plain = `${PREFIXES}
ex:PersonShape a sh:NodeShape ;
  sh:targetClass ex:Person ;
  sh:property [ sh:path ex:name ; sh:minCount 1 ] .
`;
    const report = validateAgainstShape(PERSON_DATA, plain);
    expect(report.fullyChecked).toBe(true);
    expect(report.conforms).toBe(true);
  });

  it('an unparseable shape graph is neither conforming nor fully checked', () => {
    const report = validateAgainstShape(PERSON_DATA, '@prefix sh: <http');
    expect(report.conforms).toBe(false);
    expect(report.fullyChecked).toBe(false);
  });

  it('a deactivated shape selected nothing, so it leaves fullyChecked alone', () => {
    const off = `${PREFIXES}
ex:PersonShape a sh:NodeShape ;
  sh:targetClass ex:Person ;
  sh:deactivated true ;
  sh:sparql [ sh:message "custom rule" ; sh:select "SELECT $this WHERE { }" ] .
`;
    expect(validateAgainstShape(PERSON_DATA, off).fullyChecked).toBe(true);
  });

  it('a blank-node sh:path drops the whole property shape, and says so', () => {
    // The most dangerous of the three, because the omission is invisible in the shape.
    const pathShape = `${PREFIXES}
ex:PersonShape a sh:NodeShape ;
  sh:targetClass ex:Person ;
  sh:property [ sh:path [ sh:inversePath ex:knows ] ; sh:minCount 1 ] .
`;
    expect(validateAgainstShape(PERSON_DATA, pathShape).fullyChecked).toBe(false);
    expect(validateAgainstShape(OTHER_DATA, pathShape).fullyChecked).toBe(true);
  });
});

describe('unsupportedConstructs:"violation" is available, but opt-in', () => {
  it('promotes a live skipped construct to Violation', () => {
    const report = validateAgainstShape(PERSON_DATA, SPARQL_SHAPE, { unsupportedConstructs: 'violation' });
    expect(report.results.find(r => /sh:sparql/.test(r.message))?.severity).toBe('Violation');
    expect(report.conforms).toBe(false);
  });

  it("never exceeds the owning shape's declared sh:severity", () => {
    const warnShape = `${PREFIXES}
ex:PersonShape a sh:NodeShape ;
  sh:targetClass ex:Person ;
  sh:severity sh:Warning ;
  sh:sparql [ sh:message "custom rule" ; sh:select "SELECT $this WHERE { }" ] .
`;
    const report = validateAgainstShape(PERSON_DATA, warnShape, { unsupportedConstructs: 'violation' });
    // A shape its author downgraded to Warning must not be promoted to a hard refusal by
    // this engine's own incompleteness — that would enforce more than the shape asks for.
    expect(report.results.find(r => /sh:sparql/.test(r.message))?.severity).toBe('Warning');
    expect(report.conforms).toBe(true);
    // The gap is still reported through the field that does not depend on the option.
    expect(report.fullyChecked).toBe(false);
  });

  it('does not promote a construct nothing reached', () => {
    const report = validateAgainstShape(OTHER_DATA, SPARQL_SHAPE, { unsupportedConstructs: 'violation' });
    expect(report.results.find(r => /sh:sparql/.test(r.message))?.severity).toBe('Info');
    expect(report.conforms).toBe(true);
  });
});
