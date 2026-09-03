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
 * ★ WHY THE FIX IS A NEW FIELD AND NOT A PROMOTION TO Violation. Measured at the time:
 * promoting these notes to Violation refused four of the five fixtures in
 * `spec/conformance/fixtures/revocation/`, three of which say in their own headers that they
 * MUST be accepted. A Violation is a statement about the DATA; the data broke nothing.
 * `report.fullyChecked` says the true thing instead, and `conforms && fullyChecked` is the
 * fail-closed predicate for a write gate to apply.
 *
 * ★ THE EXAMPLE IN THIS FILE USED TO BE sh:sparql, AND IT HAD TO CHANGE — which is the best
 * possible reason for a test to need editing. That was the canonical unevaluated construct
 * here because this substrate shipped no SPARQL evaluator; it ships one now, sh:sparql is
 * enforced, and a test using it to demonstrate "a construct I do not implement" would have
 * been demonstrating the opposite.
 *
 * ★ AND IT HAS HAD TO CHANGE AGAIN, FOR THE SAME REASON. `sh:sparqlExpr` replaced sh:sparql
 * here and lasted until `sh:function` was implemented — a function body is written as
 * `sh:bodyExpression [ sh:sparqlExpr "CONCAT($arg0, ' ')" ]`, so the engine evaluates that
 * too now. Twice in a row the stand-in graduated, which is the shape of a healthy ledger and
 * of a fragile test: one that pins a MECHANISM to whichever construct happened to be
 * unimplemented the day it was written needs editing every time a gap closes.
 *
 * `sh:js` takes its place, and should be the last edit this file needs. SHACL-JS is a
 * SEPARATE specification for JavaScript-backed constraints, deliberately out of scope rather
 * than pending, so it is not on a path to being implemented here. The BEHAVIOUR under test —
 * an unevaluated constraint reported as unevaluated, capped at its shape's severity, never
 * silently passing — is unchanged across all three, and that is the point: it is a property
 * of the mechanism, not of any one construct.
 */
import { describe, it, expect } from 'vitest';
/**
 * ★★ FROM SOURCE, NOT FROM `@interego/core`, AND THE MUTATION HARNESS IS WHY.
 *
 * Every package here exports `./dist` only, so a gate importing `@interego/core` is reading the
 * LAST BUILD. This file's subject is `packages/core/src/validation/shacl-engine.ts`, and measured:
 * a mutant that reverted the nested-conformance rule to "count only Violations" was applied to
 * that source and this gate stayed GREEN — it was validating a dist that still had the fix. A gate
 * that cannot see a change to the file it is about is decoration, whatever it asserts.
 *
 * The W3C oracle suite (`tests/the-w3c-suite-is-the-oracle.test.ts`) deliberately keeps reading
 * the built artifact: between them the shipped bytes and the source are both covered, which is
 * the split that was missing rather than a preference for either.
 */
import { validateAgainstShape } from '../packages/core/src/validation/shacl-engine.js';

const PREFIXES = `
@prefix sh:  <http://www.w3.org/ns/shacl#> .
@prefix ex:  <https://example.org/> .
@prefix rdf: <http://www.w3.org/1999/02/22-rdf-syntax-ns#> .
`;

/** A shape carrying sh:js — a SHACL-JS constraint this engine does not evaluate. */
const SPARQL_SHAPE = `${PREFIXES}
ex:PersonShape a sh:NodeShape ;
  sh:targetClass ex:Person ;
  sh:js ex:jsConstraint .
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
    const note = report.results.find(r => /sh:js/.test(r.message));
    expect(note?.message).toContain('fullyChecked is false');
  });

  it('fullyChecked stays TRUE when no focus node reached the shape', () => {
    // The distinction the data-blind scan could not make. A gate that refused on the mere
    // presence of sh:sparql anywhere in a big shapes file would refuse everything citing it.
    const report = validateAgainstShape(OTHER_DATA, SPARQL_SHAPE);
    expect(report.fullyChecked).toBe(true);
    expect(report.conforms).toBe(true);
    expect(report.results.find(r => /sh:js/.test(r.message))?.message)
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
  sh:js ex:jsConstraint .
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
    expect(report.results.find(r => /sh:js/.test(r.message))?.severity).toBe('Violation');
    expect(report.conforms).toBe(false);
  });

  it("never exceeds the owning shape's declared sh:severity", () => {
    const warnShape = `${PREFIXES}
ex:PersonShape a sh:NodeShape ;
  sh:targetClass ex:Person ;
  sh:severity sh:Warning ;
  sh:js ex:jsConstraint .
`;
    const report = validateAgainstShape(PERSON_DATA, warnShape, { unsupportedConstructs: 'violation' });
    // A shape its author downgraded to Warning must not be promoted to a hard refusal by
    // this engine's own incompleteness — that would enforce more than the shape asks for.
    expect(report.results.find(r => /sh:js/.test(r.message))?.severity).toBe('Warning');
    expect(report.conforms).toBe(true);
    // The gap is still reported through the field that does not depend on the option.
    expect(report.fullyChecked).toBe(false);
  });

  it('does not promote a construct nothing reached', () => {
    const report = validateAgainstShape(OTHER_DATA, SPARQL_SHAPE, { unsupportedConstructs: 'violation' });
    expect(report.results.find(r => /sh:js/.test(r.message))?.severity).toBe('Info');
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
                sh:js ex:jsConstraint ] .
`;
    const report = validateAgainstShape(PERSON_DATA, nested, { unsupportedConstructs: 'violation' });
    // The root declares no severity (default Violation). The property shape its author
    // explicitly downgraded to Info must NOT be promoted past it.
    expect(report.results.find(r => /sh:js/.test(r.message))?.severity).toBe('Info');
    expect(report.conforms).toBe(true);
    expect(report.fullyChecked).toBe(false);
  });

  it('a parent cannot make a nested shape STRICTER than the nested shape declares', () => {
    const nested = `${PREFIXES}
ex:PersonShape a sh:NodeShape ;
  sh:targetClass ex:Person ;
  sh:severity sh:Violation ;
  sh:property [ sh:path ex:name ; sh:severity sh:Warning ;
                sh:js ex:jsConstraint ] .
`;
    const report = validateAgainstShape(PERSON_DATA, nested, { unsupportedConstructs: 'violation' });
    expect(report.results.find(r => /sh:js/.test(r.message))?.severity).toBe('Warning');
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
//
// ★ THE SCOPE IS NAMED PRECISELY. This said "every constraint component" while exercising the
// eight that had been broken. It now covers the fourteen VALUE constraints - cardinality,
// datatype/class/nodeKind, pattern/in/hasValue, string-length and value-range - which is the
// family severity is expressed on. The five structural components the engine also maps
// (sh:property, sh:node, node-by-expression, sh:expression, reifier-shape) compose OTHER
// shapes rather than testing a value, and carry severity through the shape they delegate to;
// they are out of scope here and the title no longer implies otherwise.
describe('sh:severity is honoured by every VALUE-CONSTRAINT component, not half of them', () => {
  const dataWrongType = `${PREFIXES}
ex:alice a ex:Person ; ex:age "not-a-number" .
`;
  const shapeWith = (component: string): string => `${PREFIXES}
@prefix xsd: <http://www.w3.org/2001/XMLSchema#> .
ex:PersonShape a sh:NodeShape ;
  sh:targetClass ex:Person ;
  sh:property [ sh:path ex:age ; sh:severity sh:Info ; ${component} ] .
`;

  // ★★ THE EIGHT BELOW WERE THE BROKEN ONES, AND THE DESCRIBE SAYS "EVERY COMPONENT".
  //
  // Those eight hardcoded `severity: 'Violation'`, so they are the ones the fix was for - but a
  // list of the components that were once broken is not "every component", and the name claimed
  // the stronger thing. The engine's own COMPONENT map names more; the value-range and
  // string-length families are added here, each with a shape that genuinely FIRES against the
  // fixture (the leg below asserts that, so a component that silently stops firing fails rather
  // than passing on an empty result set).
  it.each([
    ['sh:datatype', 'sh:datatype xsd:integer'],
    ['sh:minCount', 'sh:minCount 5'],
    ['sh:maxCount', 'sh:maxCount 0'],
    ['sh:nodeKind', 'sh:nodeKind sh:IRI'],
    ['sh:class', 'sh:class ex:Widget'],
    ['sh:pattern', 'sh:pattern "^[0-9]+$"'],
    ['sh:in', 'sh:in ( "a" "b" )'],
    ['sh:hasValue', 'sh:hasValue "zzz"'],
    ['sh:minLength', 'sh:minLength 50'],
    ['sh:maxLength', 'sh:maxLength 3'],
    ['sh:minInclusive', 'sh:minInclusive 5'],
    ['sh:maxInclusive', 'sh:maxInclusive 1'],
    ['sh:minExclusive', 'sh:minExclusive 5'],
    ['sh:maxExclusive', 'sh:maxExclusive 1'],
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

// ── the FIVE STRUCTURAL components, which the section above declared out of scope ──
//
// ★★ THAT SCOPE NOTE WAS A CLAIM, AND ONE HALF OF IT WAS FALSE.
//
// The note above reads: "The five structural components the engine also maps (sh:property,
// sh:node, node-by-expression, sh:expression, reifier-shape) compose OTHER shapes rather than
// testing a value, and carry severity through the shape they delegate to; they are out of scope
// here and the title no longer implies otherwise."
//
// Naming a bound is better than implying none, and it is still not a check. Measured, the claim
// held for severity declared on the OUTER shape and failed for the delegation itself:
// `conformsToShapeInner` decided whether a nested shape conformed with
// `.some(r => r.severity === 'Violation')` at four sites — logical constraints, sh:sparql,
// constraint components and property shapes — so an inner failure at sh:Info or sh:Warning was
// treated as CONFORMANCE and the outer sh:node did not fire at all.
//
// ★★★ THAT IS THE SAME §3.6 MISREADING THIS FILE EXISTS TO RECORD, LEFT IN THE NESTED PATH.
// §3.6: conforms is true "if the validation did not produce any validation results" — ANY result,
// at ANY severity. The top-level driver was corrected; the nested evaluator was not, and the same
// function was already inconsistent with itself, checking `target.nodeLevelShape` with
// `.length > 0` three lines above the four that asked about Violations.
//
// It matters beyond a missed result, because nesting INVERTS. Under sh:not, an inner Info failure
// read as "conforms" makes the negation fire — a softened rule became a hard rejection, which is
// precisely the inversion the comment on `nodeSatisfiesShape` warns about for deactivation.
//
// Every W3C SHACL Core, node-expression, SPARQL and 1.2 reifier fixture in this repo still passes
// with the four sites reading `.length > 0`, which is the second oracle for the change: no
// approved test distinguishes the readings, and the spec text decides.
describe('sh:severity survives DELEGATION, not just direct value constraints', () => {
  const outer = (inner: string, sev = ''): string => `${PREFIXES}
ex:PersonShape a sh:NodeShape ; sh:targetClass ex:Person ;
  sh:property [ sh:path ex:friend ; ${sev} sh:node ex:FriendShape ] .
ex:FriendShape a sh:NodeShape ; sh:property [ sh:path ex:name ; ${inner} ] .
`;
  const data = `${PREFIXES}
ex:alice a ex:Person ; ex:friend ex:bob .
ex:bob a ex:Thing .
`;

  it('sh:node carries the severity declared on the shape that delegates', () => {
    const report = validateAgainstShape(data, outer('sh:minCount 1', 'sh:severity sh:Info ;'));
    const fired = report.results.filter(r => /NodeConstraintComponent/.test(r.constraintComponent));
    expect(fired.length, 'the sh:node constraint did not fire at all').toBeGreaterThan(0);
    expect(fired.every(r => r.severity === 'Info')).toBe(true);
  });

  it('★ an INNER failure at sh:Info means the inner shape does not conform, so sh:node fires', () => {
    // The defect: this reported conforms=true with no results, because the nested evaluator
    // counted only Violations. The outer result takes the OUTER shape's severity — Violation by
    // default — which is what makes swallowing it a silent pass rather than a quieter one.
    const report = validateAgainstShape(data, outer('sh:severity sh:Info ; sh:minCount 1'));
    expect(report.conforms, 'an inner result at Info severity was treated as conformance').toBe(false);
    expect(report.results.some(r => /NodeConstraintComponent/.test(r.constraintComponent)),
      'sh:node did not fire for a value whose inner shape produced a result').toBe(true);
  });

  it('★ and nesting INVERTS, so sh:not must not fire when the inner shape produced a result', () => {
    // Under the old rule the inner Info was "conformance", so sh:not reported a violation: a
    // shape the author softened to advice became a hard rejection one level up.
    const shapes = `${PREFIXES}
ex:PersonShape a sh:NodeShape ; sh:targetClass ex:Person ;
  sh:property [ sh:path ex:friend ; sh:not ex:FriendShape ] .
ex:FriendShape a sh:NodeShape ; sh:property [ sh:path ex:name ; sh:severity sh:Info ; sh:minCount 1 ] .
`;
    const report = validateAgainstShape(data, shapes);
    expect(report.results.filter(r => /NotConstraintComponent/.test(r.constraintComponent)),
      'sh:not fired against a value whose inner shape did NOT conform').toEqual([]);
  });

  it('sh:expression carries the delegating shape severity', () => {
    const shapes = `${PREFIXES}
ex:PersonShape a sh:NodeShape ; sh:targetClass ex:Person ;
  sh:property [ sh:path ex:age ; sh:severity sh:Info ;
    sh:expression [ sh:not [ sh:exists [ sh:path ex:age ] ] ] ] .
`;
    // Its own fixture, not PERSON_DATA: with no ex:age the property shape has no value nodes,
    // nothing is evaluated, and the leg would assert about an empty result set.
    const withAge = `${PREFIXES}ex:alice a ex:Person ; ex:age "not-a-number" .
`;
    const fired = validateAgainstShape(withAge, shapes).results
      .filter(r => /ExpressionConstraintComponent/.test(r.constraintComponent));
    expect(fired.length, 'sh:expression did not fire').toBeGreaterThan(0);
    expect(fired.every(r => r.severity === 'Info')).toBe(true);
  });

  it('a severity on the NODE shape reaches the results its property shapes produce', () => {
    const shapes = `${PREFIXES}
@prefix xsd: <http://www.w3.org/2001/XMLSchema#> .
ex:PersonShape a sh:NodeShape ; sh:targetClass ex:Person ; sh:severity sh:Info ;
  sh:property [ sh:path ex:age ; sh:datatype xsd:integer ] .
`;
    const data2 = `${PREFIXES}ex:alice a ex:Person ; ex:age "not-a-number" .\n`;
    const fired = validateAgainstShape(data2, shapes).results
      .filter(r => r.constraintComponent.startsWith('http://www.w3.org/ns/shacl#'));
    expect(fired.length, 'the datatype constraint did not fire').toBeGreaterThan(0);
    expect(fired.every(r => r.severity === 'Info')).toBe(true);
  });
});
