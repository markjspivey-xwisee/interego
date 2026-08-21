/**
 * RDFS subclass entailment — closing a one-triple bypass of every class-targeted shape.
 *
 * ★ THE DEFECT. `validateAgainstShape` accepted an `entailment` option and threw it away
 * (`void options.entailment;`). The relay's publish gate has been passing
 * `{ entailment: 'rdfs' }` the entire time, believing it did something.
 *
 * Because `sh:targetClass` matched direct types only, ONE triple bypassed any
 * class-targeted shape:
 *
 *     ex:Sub rdfs:subClassOf ex:Target .
 *     ex:n a ex:Sub ; ex:anythingAtAll "…" .     # shape targeting ex:Target never fires
 *
 * For a closed privacy shape that is a total bypass with a conforming result. For
 * vault-ld's authority-class check it is precisely the smuggling attack that file
 * documents in its own comment.
 *
 * ★ AND THE FIX WAS HALF-APPLIED. The closure was implemented but left opt-in, on the
 * stated grounds that "SHACL's own default is direct-type matching and a published shape
 * must mean the same thing here as in pySHACL". That is now measured rather than argued,
 * and it was false: tools/shacl-agreement/fixtures/subclass-value-is-subclass.data.ttl
 * puts a value typed with a subclass against sh:class on the superclass, and pySHACL
 * CONFORMS where we violated. Our published shape meant two different things to us and to
 * a conformant reader — the exact failure that agreement harness exists to catch, on the
 * one case it had never been given.
 *
 * The confusion was between two separate mechanisms. Applying an RDFS entailment regime to
 * the data graph IS optional (SHACL 1.1 §1.5). But sh:class and sh:targetClass are not
 * defined via a regime at all — they are defined over "SHACL instance", which is rdf:type
 * plus rdfs:subClassOf*. That closure is part of what those two constraints MEAN.
 *
 * So leaving it opt-in did not leave us conservative, it left the bypass above ARMED for
 * every caller taking the default — including applications/foxxi-content-intelligence/
 * src/performance-evidence.ts, which validates a submitter-supplied body against a
 * submitter-named shape and returns 422 on failure. The submitter controls that data
 * graph, so the submitter could have shipped the subClassOf triple themselves.
 *
 * The closure is now unconditional: 'none' and 'rdfs' are identical and both conformant,
 * and 'rdfs-observe' remains as a deliberately non-conformant migration mode.
 */
import { describe, it, expect } from 'vitest';
import { validateAgainstShape } from '@interego/core';

const P = `@prefix sh: <http://www.w3.org/ns/shacl#> .
@prefix rdfs: <http://www.w3.org/2000/01/rdf-schema#> .
@prefix rdf: <http://www.w3.org/1999/02/22-rdf-syntax-ns#> .
@prefix ex: <https://example.org/> .
`;
const SHAPE = P + `
ex:S a sh:NodeShape ; sh:targetClass ex:Turn ; sh:closed true ;
  sh:ignoredProperties ( rdf:type ) ;
  sh:property [ sh:path ex:allowed ; sh:minCount 1 ] .
`;
const conforms = (data: string, rdfs?: boolean) =>
  validateAgainstShape(P + data, SHAPE, rdfs ? { entailment: 'rdfs' } : {}).conforms;

describe('rdfs entailment', () => {
  it('applies BY DEFAULT — sh:targetClass is defined over SHACL instances, not direct types', () => {
    expect(conforms(`ex:Sub rdfs:subClassOf ex:Turn .\nex:n a ex:Sub ; ex:allowed "x" ; ex:secret "s" .`))
      .toBe(false);
  });

  it('and asking for it explicitly changes nothing, because it was never optional', () => {
    expect(conforms(`ex:Sub rdfs:subClassOf ex:Turn .\nex:n a ex:Sub ; ex:allowed "x" ; ex:secret "s" .`, true))
      .toBe(false);
  });

  it('is transitive across multiple levels', () => {
    expect(conforms(
      `ex:Mid rdfs:subClassOf ex:Turn . ex:Deep rdfs:subClassOf ex:Mid .\nex:n a ex:Deep ; ex:allowed "x" ; ex:secret "s" .`,
      true)).toBe(false);
  });

  it('terminates on a cyclic hierarchy instead of hanging', () => {
    expect(conforms(
      `ex:A rdfs:subClassOf ex:B . ex:B rdfs:subClassOf ex:A . ex:B rdfs:subClassOf ex:Turn .\nex:n a ex:A ; ex:allowed "x" ; ex:secret "s" .`,
      true)).toBe(false);
  });

  it('still accepts a conforming subclass instance — it constrains, it does not reject', () => {
    expect(conforms(`ex:Sub rdfs:subClassOf ex:Turn .\nex:n a ex:Sub ; ex:allowed "x" .`, true))
      .toBe(true);
  });

  it('an unrelated class is unaffected', () => {
    expect(conforms(`ex:Other a rdfs:Class .\nex:n a ex:Other ; ex:whatever "x" .`, true)).toBe(true);
  });
});

describe('the closure is seeded from BOTH graphs', () => {
  /**
   * ★ Reading the data graph alone made entailment inert for every contract in this
   * repo: our published shape files carry zero `rdfs:subClassOf`, because the hierarchy
   * lives in the ontology beside the shapes. Worse, a data-only closure is trivially
   * evaded — the attacker controls the data, so they simply omit the triple.
   */
  const P = `@prefix sh: <http://www.w3.org/ns/shacl#> .
@prefix rdfs: <http://www.w3.org/2000/01/rdf-schema#> .
@prefix rdf: <http://www.w3.org/1999/02/22-rdf-syntax-ns#> .
@prefix ex: <https://example.org/> .
`;
  const SHAPE_WITH_HIERARCHY = P + `
ex:Rich rdfs:subClassOf ex:Turn .
ex:S a sh:NodeShape ; sh:targetClass ex:Turn ; sh:closed true ;
  sh:ignoredProperties ( rdf:type ) ;
  sh:property [ sh:path ex:allowed ; sh:minCount 1 ] .
`;
  const DATA_NO_HIERARCHY = P + `ex:t a ex:Rich ; ex:allowed "x" ; ex:secret "s" .`;

  it('a hierarchy declared only in the SHAPES graph is honoured', () => {
    const r = validateAgainstShape(DATA_NO_HIERARCHY, SHAPE_WITH_HIERARCHY, { entailment: 'rdfs' });
    expect(r.conforms, 'the attacker omits the triple from their data; the shape still knows')
      .toBe(false);
  });
});

describe('observe mode reports without rejecting', () => {
  /**
   * Turning entailment on is a FLEET change, not a code change: shapes begin firing on
   * nodes they never fired on before, so publishes that pass today start failing all at
   * once at deploy time. Observe mode makes that list discoverable from production
   * BEFORE it bites. There is no safe way to learn it except by running it.
   */
  const P = `@prefix sh: <http://www.w3.org/ns/shacl#> .
@prefix rdfs: <http://www.w3.org/2000/01/rdf-schema#> .
@prefix rdf: <http://www.w3.org/1999/02/22-rdf-syntax-ns#> .
@prefix ex: <https://example.org/> .
`;
  const SHAPE = P + `ex:Rich rdfs:subClassOf ex:Turn .
ex:S a sh:NodeShape ; sh:targetClass ex:Turn ; sh:closed true ;
  sh:ignoredProperties ( rdf:type ) ; sh:property [ sh:path ex:allowed ; sh:minCount 1 ] .`;
  const DATA = P + `ex:t a ex:Rich ; ex:allowed "x" ; ex:secret "s" .`;

  it('does not change conformance', () => {
    expect(validateAgainstShape(DATA, SHAPE, { entailment: 'rdfs-observe' }).conforms).toBe(true);
  });

  it('but reports what enforcing WOULD have rejected', () => {
    const r = validateAgainstShape(DATA, SHAPE, { entailment: 'rdfs-observe' });
    const notes = r.results.filter(x => (x.message ?? '').startsWith('[entailment-observe]'));
    expect(notes.length).toBeGreaterThan(0);
    expect(notes[0]!.severity).toBe('Info');
  });

  it('does NOT downgrade a violation that would fire without entailment either', () => {
    // A direct-type instance failing minCount is a real violation in every mode —
    // downgrading it would hide a genuine failure behind the rollout flag.
    const direct = P + `ex:t a ex:Turn .`;
    expect(validateAgainstShape(direct, SHAPE, { entailment: 'rdfs-observe' }).conforms).toBe(false);
  });
});

describe('sh:class moves with sh:targetClass', () => {
  /**
   * Making only TARGETING subclass-aware creates a false-reject asymmetry: the shape
   * starts firing on subclass instances (right) and then rejects them for failing an
   * sh:class check still demanding the exact parent type (wrong).
   */
  const P = `@prefix sh: <http://www.w3.org/ns/shacl#> .
@prefix rdfs: <http://www.w3.org/2000/01/rdf-schema#> .
@prefix ex: <https://example.org/> .
`;
  const SHAPE = P + `ex:SubFacet rdfs:subClassOf ex:Facet .
ex:S a sh:NodeShape ; sh:targetClass ex:Doc ;
  sh:property [ sh:path ex:facet ; sh:class ex:Facet ; sh:minCount 1 ] .`;
  const DATA = P + `ex:d a ex:Doc ; ex:facet ex:f . ex:f a ex:SubFacet .`;

  it('accepts a subclass value under entailment', () => {
    expect(validateAgainstShape(DATA, SHAPE, { entailment: 'rdfs' }).conforms).toBe(true);
  });

  it('and still rejects an unrelated class', () => {
    const bad = P + `ex:d a ex:Doc ; ex:facet ex:f . ex:f a ex:Unrelated .`;
    expect(validateAgainstShape(bad, SHAPE, { entailment: 'rdfs' }).conforms).toBe(false);
  });
});

/**
 * ★ THE EDGE BOUND WAS AN OFF SWITCH THE CALLER COULD REACH.
 *
 * buildSubclassClosure caps materialised descendant edges to avoid a caller-triggered
 * CPU/heap blowup on the publish path. That guard is necessary. Abandoning the closure
 * SILENTLY was not: the closure is seeded from caller-supplied data, so a publisher could
 * switch entailment off for their own publish by padding the graph with irrelevant
 * rdfs:subClassOf triples. Measured before the fix: ~209 KB of junk — free against a 4 MiB
 * body limit — turned a 5-violation graph into `conforms: true`.
 *
 * A guard the guarded party can disable is not a guard. The same padding also silenced the
 * observe-mode evidence, so "the entailment logs are quiet" stopped meaning anything.
 */
describe('a truncated subclass closure fails closed instead of disabling entailment', () => {
  const P = `@prefix sh: <http://www.w3.org/ns/shacl#> .
@prefix rdfs: <http://www.w3.org/2000/01/rdf-schema#> .
@prefix ex: <https://example.org/> .
`;
  const SHAPE = P + `ex:Sub rdfs:subClassOf ex:Base .
ex:S a sh:NodeShape ; sh:targetClass ex:Base ;
  sh:property [ sh:path ex:needed ; sh:minCount 1 ] .`;

  /** Enough unrelated subclass edges to blow the bound. */
  const pad = (n: number) =>
    Array.from({ length: n }, (_, i) => `ex:J${i} rdfs:subClassOf ex:Root .`).join('\n');

  const violating = P + 'ex:n a ex:Sub .';

  it('rejects the entailed violation when the closure fits', () => {
    const r = validateAgainstShape(violating, SHAPE, { entailment: 'rdfs' });
    expect(r.conforms).toBe(false);
  });

  it('STILL rejects when the graph is padded past the bound', () => {
    const r = validateAgainstShape(violating + '\n' + pad(6000), SHAPE, { entailment: 'rdfs' });
    expect(r.conforms, 'padding rdfs:subClassOf must not buy a pass').toBe(false);
  });

  it('says WHY, so the refusal is not mistaken for the original violation', () => {
    const r = validateAgainstShape(violating + '\n' + pad(6000), SHAPE, { entailment: 'rdfs' });
    const note = r.results.find(x => x.constraintComponent === 'urn:iep:shacl:EntailmentIncomplete');
    expect(note, 'must report that entailment was abandoned').toBeDefined();
    expect(note!.severity).toBe('Violation');
  });

  it('observe mode reports it as a Warning without changing conforms', () => {
    // Downgrading here is the point of observe mode; going silent is not.
    const r = validateAgainstShape(violating + '\n' + pad(6000), SHAPE, { entailment: 'rdfs-observe' });
    const note = r.results.find(x => x.constraintComponent === 'urn:iep:shacl:EntailmentIncomplete');
    expect(note?.severity).toBe('Warning');
    expect(r.conforms).toBe(true);
  });

  it('a Violation added to the notes list actually changes conforms', () => {
    // Regression guard: `conforms` was computed from a DIFFERENT list than the one
    // returned, which made the first Violation ever added to the notes dead on arrival.
    const r = validateAgainstShape(violating + '\n' + pad(6000), SHAPE, { entailment: 'rdfs' });
    const violations = r.results.filter(x => x.severity === 'Violation');
    expect(violations.length).toBeGreaterThan(0);
    expect(r.conforms).toBe(false);
  });
});
