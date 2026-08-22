/**
 * Two whole constraint FAMILIES were evaluated only for shapes the driver reached directly.
 *
 * ★ FOUND BY A REVIEWER, NOT BY A FAILING TEST. The W3C SHACL-SPARQL suite was at 44 of 44 and
 * every installed mutant was dead when six agents were pointed at the change set and told to
 * REFUTE it. `sparqlConstraints` and the SPARQL-based constraint components were each consumed
 * at exactly ONE call site — the top-level validation driver — and nothing said so.
 *
 * ── WHY THE SUITE CANNOT SEE IT ──────────────────────────────────────────────
 *
 * Every `sh:sparql` entry in the suite hangs its constraint off a shape with a target. A shape
 * REACHED — through `sh:node`, `sh:not`, `sh:or`, `sh:xone`, `sh:qualifiedValueShape` — is
 * evaluated by a different function, `conformsToShapeInner`, which walked the node-level
 * constraints, the logical constraints, the property shapes and `sh:closed`, and then returned
 * true. A shape whose only constraint was an `sh:sparql` therefore constrained NOTHING, and
 * looked fully constrained doing it.
 *
 * ★ AND UNDER sh:not IT IS WORSE THAN A MISSED VIOLATION. A nested shape that can never fail
 * makes its negation always fail — so the same gap that lets bad data through in one direction
 * refuses good data in the other, and neither report mentions the constraint that was skipped.
 *
 * The fix is one line in each direction plus a run-scoped handle on the components, for the
 * same reason `RECURSION_STACK` is run-scoped: threading a parameter through eight mutually
 * recursive functions is the change where the one call site that forgets reintroduces the bug
 * silently.
 */
import { describe, it, expect } from 'vitest';
import { validateAgainstShape, inferShaclTriples } from '@interego/core';

const PREFIXES = `
@prefix sh:  <http://www.w3.org/ns/shacl#> .
@prefix ex:  <https://example.org/> .
@prefix rdf: <http://www.w3.org/1999/02/22-rdf-syntax-ns#> .
`;

/** The prefix mechanism SPARQL strings use, which is not @prefix. */
const DECLARE = `
ex: a sh:ShapesGraph ; sh:declare [ sh:prefix "ex" ; sh:namespace "https://example.org/" ] .
`;

describe('an sh:sparql constraint on a shape reached through sh:node', () => {
  const SHAPES = `${PREFIXES}${DECLARE}
ex:Outer a sh:NodeShape ; sh:targetClass ex:T ; sh:node ex:Inner .
ex:Inner a sh:NodeShape ; sh:sparql [
  sh:message "the inner constraint fired" ; sh:prefixes ex: ;
  sh:select "SELECT $this WHERE { $this ex:bad true }" ] .
`;

  it('fires — the shape is constrained wherever it is reached from', () => {
    const bad = validateAgainstShape(`${SHAPES}\nex:t1 a ex:T ; ex:bad true .`, SHAPES, {});
    expect(bad.conforms, 'the nested sh:sparql constrained nothing').toBe(false);
  });

  it('and still accepts data that satisfies it', () => {
    // The other half: a fix that makes everything fail is not a fix. Without this the change
    // could have been "always report a violation for a shape carrying sh:sparql".
    const good = validateAgainstShape(`${SHAPES}\nex:t1 a ex:T .`, SHAPES, {});
    expect(good.conforms).toBe(true);
  });

  it('and inverts correctly under sh:not, which is where the gap flips direction', () => {
    const negated = `${PREFIXES}${DECLARE}
ex:Outer a sh:NodeShape ; sh:targetClass ex:T ; sh:not ex:Inner .
ex:Inner a sh:NodeShape ; sh:sparql [
  sh:prefixes ex: ; sh:select "SELECT $this WHERE { $this ex:bad true }" ] .
`;
    // ex:t1 IS bad, so it does not conform to ex:Inner, so sh:not is satisfied. While the
    // nested constraint was inert, ex:Inner accepted everything and sh:not refused everything.
    expect(validateAgainstShape(`${negated}\nex:t1 a ex:T ; ex:bad true .`, negated, {}).conforms)
      .toBe(true);
    expect(validateAgainstShape(`${negated}\nex:t1 a ex:T .`, negated, {}).conforms)
      .toBe(false);
  });
});

describe('a SPARQL-based constraint component on a shape reached through sh:node', () => {
  const SHAPES = `${PREFIXES}${DECLARE}
ex:MaxLenComponent a sh:ConstraintComponent ;
  sh:parameter [ sh:path ex:maxLen ] ;
  sh:validator [ a sh:SPARQLAskValidator ; sh:prefixes ex: ;
    sh:ask "ASK { FILTER (STRLEN(STR($value)) <= $maxLen) }" ] .

ex:Outer a sh:NodeShape ; sh:targetClass ex:T ;
  sh:property [ sh:path ex:child ; sh:node ex:Inner ] .
ex:Inner a sh:NodeShape ; sh:property [ sh:path ex:name ; ex:maxLen 3 ] .
`;

  it('activates on the nested shape', () => {
    // ★ THE CARRIER LIST WAS BUILT FROM THE TOP-LEVEL SHAPE ONLY — its own subject and its own
    // property shapes. A component's parameters on a shape reached through sh:node activated
    // nothing at all, so a shapes graph could define a constraint kind, use it, and enforce it
    // in one place and not the other.
    const bad = validateAgainstShape(
      `${SHAPES}\nex:t1 a ex:T ; ex:child ex:c1 . ex:c1 ex:name "toolong" .`, SHAPES, {});
    expect(bad.conforms, 'the component did not activate on the nested shape').toBe(false);
  });

  it('and accepts a value the component permits', () => {
    const good = validateAgainstShape(
      `${SHAPES}\nex:t1 a ex:T ; ex:child ex:c1 . ex:c1 ex:name "ok" .`, SHAPES, {});
    expect(good.conforms).toBe(true);
  });
});

describe('a component validator that reports ?failure', () => {
  it('is a REFUSAL, not the component failing the data', () => {
    // `sparqlResults` honoured ?failure for sh:sparql and the component path did not, so a
    // validator saying "I could not judge this" was reported under the component's own IRI —
    // "the data is wrong" in place of "the check broke". The two are the same VERDICT and
    // different FACTS, which is why the refusal has its own component IRI.
    const shapes = `${PREFIXES}${DECLARE}
ex:Comp a sh:ConstraintComponent ;
  sh:parameter [ sh:path ex:param ] ;
  sh:validator [ a sh:SPARQLSelectValidator ; sh:prefixes ex: ;
    sh:select "SELECT $this ?failure WHERE { BIND (true AS ?failure) }" ] .
ex:Shape a sh:NodeShape ; sh:targetClass ex:T ; ex:param 1 .
ex:t1 a ex:T .
`;
    const rep = validateAgainstShape(shapes, shapes, {});
    expect(rep.conforms).toBe(false);
    expect(rep.results.map(r => r.constraintComponent))
      .toContain('urn:iep:shacl:SparqlRefused');
  });
});

describe('a SPARQL-based target when the shapes are a SEPARATE document', () => {
  const SHAPES = `${PREFIXES}${DECLARE}
ex:Shape a sh:NodeShape ;
  sh:targetNode [ sh:prefixes ex: ; sh:select "SELECT ?this WHERE { ?this a ex:T }" ] ;
  sh:property [ sh:path ex:name ; sh:minCount 1 ] .
`;
  const DATA = '@prefix ex: <https://example.org/> .\nex:t1 a ex:T .';

  it('selects the same focus nodes as it does from one document', () => {
    // ★ THE SELECTOR WAS LOOKED UP IN THE DATA GRAPH. With a separate shapes file it was not
    // found, control fell through, and the SELECTOR BLANK NODE ITSELF became the focus node —
    // so the shape's constraints were evaluated against the query, and sh:minCount reported a
    // violation on `_:b0`. A confident answer about a node that is not in the data at all.
    const combined = validateAgainstShape(`${SHAPES}\n${DATA}`, `${SHAPES}\n${DATA}`, {});
    const split = validateAgainstShape(DATA, SHAPES, {});
    expect(split.conforms).toBe(combined.conforms);
    expect(split.results.map(r => r.focusNode)).toEqual(combined.results.map(r => r.focusNode));
    expect(split.results[0]?.focusNode, 'the report named the selector, not the selected node')
      .toBe('https://example.org/t1');
  });

  it('and the projected variable may be called ?this', () => {
    // The value-producing path skipped a binding named `this` unconditionally — right for a
    // node expression, where $this is PRE-BOUND and is not the produced value, and wrong for a
    // target query, where nothing is pre-bound and `SELECT ?this` is an ordinary projection.
    // The W3C fixture projects `?person`, so only a query that names it `?this` showed it: the
    // target selected nobody and the shape enforced nothing.
    expect(validateAgainstShape(DATA, SHAPES, {}).results).toHaveLength(1);
  });
});

describe('the run-scoped state that makes the two fixes above possible', () => {
  // Reaching a nested shape's components needs the compiled component set eight mutually
  // recursive calls below the driver that compiled it, so it is held in a module-level
  // variable — the same shape as `RECURSION_STACK`, and with the same hazard.

  /** A shapes graph declaring a component whose validator NEVER passes. */
  const FORBIDDING = `${PREFIXES}${DECLARE}
ex:ForbidComponent a sh:ConstraintComponent ;
  sh:parameter [ sh:path ex:forbidden ] ;
  sh:validator [ a sh:SPARQLAskValidator ; sh:prefixes ex: ; sh:ask "ASK { FILTER (false) }" ] .
ex:Anything a sh:NodeShape ; sh:targetClass ex:Unrelated ; ex:forbidden 1 .
ex:u1 a ex:Unrelated .
`;

  /** A rules graph that declares NO components and whose condition carries that parameter. */
  const RULES = `${PREFIXES}${DECLARE}
ex:Cond a sh:NodeShape ; ex:forbidden 1 .
ex:Shape a sh:NodeShape ; sh:targetClass ex:T ;
  sh:rule [ a sh:TripleRule ; sh:condition ex:Cond ; sh:predicate ex:ok ; sh:object true ] .
ex:t1 a ex:T .
`;

  it('does not outlive the run that set it', () => {
    // ★ SET AT THE START AND CLEARED BY THE NEXT CALL IS NOT RUN-SCOPED. The components stayed
    // live after the driver returned, so a later `nodeConformsToShape` — which is how the
    // rules engine checks an sh:condition — judged `ex:Cond` with the PREVIOUS validation's
    // components. `ex:Cond` carries ex:forbidden, the leaked component never passes, the
    // condition fails and the rule does not fire.
    //
    // The failure is ORDER-DEPENDENT, which is worse than plainly wrong: the same inference
    // answers differently depending on what ran before it, and nothing in either result says
    // so. This test is the pair of runs, and it asserts they agree.
    const alone = inferShaclTriples(RULES, RULES).triples.length;
    validateAgainstShape(FORBIDDING, FORBIDDING, {});
    const after = inferShaclTriples(RULES, RULES).triples.length;

    expect(alone, 'the rule did not fire even on its own').toBe(1);
    expect(after, 'an unrelated validation changed what the rules engine inferred').toBe(alone);
  });

  it('and the rules engine establishes it when there is no validation to inherit', () => {
    // ★ THE OTHER HALF, AND THE ONE A FIRST ATTEMPT AT THIS TEST MISSED. Restoring the scope
    // is not enough: `nodeConformsToShape` is a public entry point in its own right — it is
    // how the rules engine checks an `sh:condition` — so when nothing else has set the scope
    // it has to compile the components from the document it was handed. Without that, a
    // condition shape carrying a component's parameter passes because the component is not in
    // scope, and the rule fires when the author said it must not.
    //
    // The first version of this test asserted only that a validation still sees its own
    // components, which is true either way. Two mutants survived it.
    const selfDeclaring = `${PREFIXES}${DECLARE}
ex:ForbidComponent a sh:ConstraintComponent ;
  sh:parameter [ sh:path ex:forbidden ] ;
  sh:validator [ a sh:SPARQLAskValidator ; sh:prefixes ex: ; sh:ask "ASK { FILTER (false) }" ] .
ex:Cond a sh:NodeShape ; ex:forbidden 1 .
ex:Shape a sh:NodeShape ; sh:targetClass ex:T ;
  sh:rule [ a sh:TripleRule ; sh:condition ex:Cond ; sh:predicate ex:ok ; sh:object true ] .
ex:t1 a ex:T .
`;
    expect(inferShaclTriples(selfDeclaring, selfDeclaring).triples,
      'the condition\'s component was not in scope, so the rule fired anyway').toHaveLength(0);
  });

  it('and a validation still sees its own components either way', () => {
    const inner = validateAgainstShape(FORBIDDING, FORBIDDING, {});
    expect(inner.conforms, 'the always-failing component did not fire').toBe(false);
  });
});
