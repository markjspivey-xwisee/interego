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

  it('a complex sh:path COMPILES now, so it no longer drops the property shape', () => {
    // ★ Inverted from "drops the whole property shape, and says so". Complex paths are
    // implemented; what remains reportable is a path the engine cannot compile at all.
    const pathShape = `${PREFIXES}
ex:PersonShape a sh:NodeShape ;
  sh:targetClass ex:Person ;
  sh:property [ sh:path [ sh:inversePath ex:knows ] ; sh:minCount 1 ] .
`;
    expect(validateAgainstShape(PERSON_DATA, pathShape).fullyChecked).toBe(true);
    // And it enforces: nobody knows ex:alice, so the inverse path yields no value node.
    expect(validateAgainstShape(PERSON_DATA, pathShape).conforms).toBe(false);
  });

  it('but a path it CANNOT compile is still reported', () => {
    // An empty alternative list is syntactically a path and semantically nothing.
    const broken = `${PREFIXES}
ex:PersonShape a sh:NodeShape ;
  sh:targetClass ex:Person ;
  sh:property [ sh:path [ sh:alternativePath ( ) ] ; sh:minCount 1 ] .
`;
    expect(validateAgainstShape(PERSON_DATA, broken).fullyChecked).toBe(false);
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

  // ★ THE CAP HELD FOR ROOT SHAPES ONLY, AND THE TEST ABOVE COULD NOT SEE IT.
  //
  // `ownerSeverity` stamped every reachable subject with the ROOT's severity, so the
  // severity applied was never the shape actually carrying the construct. The test above
  // passes because it puts `sh:severity` on the ROOT — the one position where root and
  // carrier coincide — so it measured a proxy for the property it names and left the guard
  // unmutated in the nested case.
  it("caps at the CARRYING property shape's sh:severity, not just the root's", () => {
    const nested = `${PREFIXES}
ex:PersonShape a sh:NodeShape ;
  sh:targetClass ex:Person ;
  sh:property [ sh:path ex:name ; sh:severity sh:Info ;
                sh:sparql [ sh:message "advisory only" ; sh:select "SELECT $this WHERE { }" ] ] .
`;
    const report = validateAgainstShape(PERSON_DATA, nested, { unsupportedConstructs: 'violation' });
    // The root declares no severity (default Violation). The property shape its author
    // explicitly downgraded to Info must NOT be promoted past it.
    expect(report.results.find(r => /sh:sparql/.test(r.message))?.severity).toBe('Info');
    expect(report.conforms).toBe(true);
    expect(report.fullyChecked).toBe(false);
  });

  it('a parent cannot make a nested shape STRICTER than the nested shape declares', () => {
    const nested = `${PREFIXES}
ex:PersonShape a sh:NodeShape ;
  sh:targetClass ex:Person ;
  sh:severity sh:Violation ;
  sh:property [ sh:path ex:name ; sh:severity sh:Warning ;
                sh:sparql [ sh:message "advisory" ; sh:select "SELECT $this WHERE { }" ] ] .
`;
    const report = validateAgainstShape(PERSON_DATA, nested, { unsupportedConstructs: 'violation' });
    expect(report.results.find(r => /sh:sparql/.test(r.message))?.severity).toBe('Warning');
    expect(report.conforms).toBe(true);
  });
});

// ── sh:severity, for constraints the engine DOES implement ──
//
// ★ HALF THE ENGINE IGNORED IT. minCount, maxCount, nodeKind, datatype, class, pattern, in
// and hasValue hardcoded `severity: 'Violation'`; the twelve newer components routed through
// the shape's declared severity. So whether `sh:severity sh:Info` was honoured depended on
// which constraint the author happened to write under it. That split is also what made the
// unsupported-construct cap above unbelievable — it promised to respect a severity the
// engine itself only half respected.
describe('sh:severity is honoured by every constraint component, not half of them', () => {
  const dataWrongType = `${PREFIXES}
ex:alice a ex:Person ; ex:age "not-a-number" .
`;
  const shapeWith = (component: string): string => `${PREFIXES}
@prefix xsd: <http://www.w3.org/2001/XMLSchema#> .
ex:PersonShape a sh:NodeShape ;
  sh:targetClass ex:Person ;
  sh:property [ sh:path ex:age ; sh:severity sh:Info ; ${component} ] .
`;

  it.each([
    ['sh:datatype', 'sh:datatype xsd:integer'],
    ['sh:minCount', 'sh:minCount 5'],
    ['sh:maxCount', 'sh:maxCount 0'],
    ['sh:nodeKind', 'sh:nodeKind sh:IRI'],
    ['sh:class', 'sh:class ex:Widget'],
    ['sh:pattern', 'sh:pattern "^[0-9]+$"'],
    ['sh:in', 'sh:in ( "a" "b" )'],
    ['sh:hasValue', 'sh:hasValue "zzz"'],
  ])('%s under sh:severity sh:Info reports Info — and still does not conform', (_name, component) => {
    const report = validateAgainstShape(dataWrongType, shapeWith(component));
    const fired = report.results.filter(r => r.constraintComponent.startsWith('http://www.w3.org/ns/shacl#'));
    // The constraint must actually FIRE — otherwise this asserts nothing about severity.
    expect(fired.length).toBeGreaterThan(0);
    expect(fired.every(r => r.severity === 'Info')).toBe(true);
    // ★ THIS LINE USED TO ASSERT `true`, AND THAT WAS THIS REPO'S BUG, NOT THE SPEC'S.
    //
    // §3.6 defines sh:conforms as "true if the validation did not produce any validation
    // results, and false otherwise" — ANY result, at ANY severity. Severity says how loudly
    // a result speaks, not whether it counts. We were reading it as "no Violations", so a
    // shape declaring sh:Info or sh:Warning reported conforms:true on data that broke it.
    //
    // Two independent oracles say otherwise, and neither is our own reading of the prose:
    //   - pySHACL 0.30.1, same graph, same shapes file: conforms=False where we said true.
    //   - W3C SHACL 1.2 Core, tests/core/misc/severity-001.ttl, mf:status sht:approved: one
    //     sh:Warning result, expected `sh:conforms false`.
    //
    // A caller that wants "no Violations" filters results by severity, which is a thing it
    // can do; a caller that trusts `conforms` cannot un-break what it already let through.
    expect(report.conforms).toBe(false);
  });

  it('still reports Violation when the shape declares no severity', () => {
    const plain = `${PREFIXES}
@prefix xsd: <http://www.w3.org/2001/XMLSchema#> .
ex:PersonShape a sh:NodeShape ;
  sh:targetClass ex:Person ;
  sh:property [ sh:path ex:age ; sh:datatype xsd:integer ] .
`;
    const report = validateAgainstShape(dataWrongType, plain);
    expect(report.conforms).toBe(false);
  });
});

// ── The SHACL Core constructs the scan could not see ──
//
// ★ `fullyChecked` WAS LOWERED BY THREE HARD-CODED PROBES and nothing else — the three
// someone had noticed. `sh:not` / `sh:or` / `sh:and` / `sh:xone` are SHACL **Core** and are
// not implemented by this engine at all, so they were parsed, dropped, and reported by
// nothing: a graph that VIOLATES a sh:not prohibition came back `conforms: true,
// fullyChecked: true`, and the advertised fail-closed predicate `conforms && fullyChecked`
// accepted it. The scan is now an allowlist, so a construct nobody has thought of yet is
// reported by default rather than by having been remembered.
describe('the unsupported-construct scan is an allowlist, so it fails closed', () => {
  const violatesTheShape = `${PREFIXES}
ex:alice a ex:Person ; ex:ssn "111-22-3333" .
`;
  const logical = (clause: string): string => `${PREFIXES}
ex:PersonShape a sh:NodeShape ;
  sh:targetClass ex:Person ;
  ${clause} .
`;

  it.each([
    ['sh:not', 'sh:not [ sh:property [ sh:path ex:ssn ; sh:minCount 1 ] ]'],
    ['sh:or', 'sh:or ( [ sh:property [ sh:path ex:aaa ; sh:minCount 1 ] ] [ sh:property [ sh:path ex:bbb ; sh:minCount 1 ] ] )'],
    ['sh:and', 'sh:and ( [ sh:property [ sh:path ex:aaa ; sh:minCount 1 ] ] )'],
    ['sh:xone', 'sh:xone ( [ sh:property [ sh:path ex:aaa ; sh:minCount 1 ] ] [ sh:property [ sh:path ex:bbb ; sh:minCount 1 ] ] )'],
  ])('%s is ENFORCED, and therefore no longer reported as unsupported', (name, clause) => {
    // ★ THIS BLOCK USED TO ASSERT THE OPPOSITE — that each of these cleared `fullyChecked`
    // because the engine could not run it. All four are implemented now, so the assertion
    // inverts: a construct that IS enforced must stop appearing in the unsupported sweep, or
    // the report tells a caller a check was skipped when it ran.
    const report = validateAgainstShape(violatesTheShape, logical(clause));
    expect(report.fullyChecked, `${name} is implemented; it must not clear fullyChecked`).toBe(true);
    expect(report.results.some(r => r.message.includes('not implemented')), `${name}`).toBe(false);
  });

  it('and sh:not actually refuses the graph it prohibits', () => {
    // Reporting is not enforcing, and the previous version of this file could not tell the
    // difference: it checked only that the construct was MENTIONED.
    const report = validateAgainstShape(violatesTheShape,
      logical('sh:not [ sh:property [ sh:path ex:ssn ; sh:minCount 1 ] ]'));
    expect(report.conforms).toBe(false);
  });

  it('a shape that selected no focus node still leaves fullyChecked alone', () => {
    const report = validateAgainstShape(OTHER_DATA, logical('sh:not [ sh:property [ sh:path ex:ssn ; sh:minCount 1 ] ]'));
    expect(report.fullyChecked).toBe(true);
  });

  // ★ THE PROPERTY THAT MAKES THIS AN ALLOWLIST RATHER THAN A LONGER DENYLIST: a SHACL term
  // invented after this file was written is caught without anyone editing this file.
  it('reports a sh: construct that did not exist when this engine was written', () => {
    const future = `${PREFIXES}
ex:PersonShape a sh:NodeShape ;
  sh:targetClass ex:Person ;
  sh:someConstraintInventedLater "x" .
`;
    const report = validateAgainstShape(PERSON_DATA, future);
    expect(report.fullyChecked).toBe(false);
    expect(report.results.some(r => r.message.includes('sh:someConstraintInventedLater'))).toBe(true);
  });

  it('does not report the non-validating annotations, which skip no check', () => {
    const annotated = `${PREFIXES}
ex:PersonShape a sh:NodeShape ;
  sh:targetClass ex:Person ;
  sh:property [ sh:path ex:name ; sh:name "Name" ; sh:description "the name" ;
                sh:order 1 ; sh:group ex:G ; sh:minCount 1 ] .
`;
    expect(validateAgainstShape(PERSON_DATA, annotated).fullyChecked).toBe(true);
  });
});
