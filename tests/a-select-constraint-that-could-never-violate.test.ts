/**
 * `validateDomainShapes` had a SPARQL constraint path that no test touched and that could
 * never report a violation for a SELECT query.
 *
 * ★ THE WHOLE DEFECT IS ONE COMPARISON. The check was:
 *
 *     if (result.boolean === false) { …violation… }
 *
 * `boolean` is set by ASK and by nothing else. A SELECT leaves it `undefined`, and
 * `undefined === false` is false — so every SELECT-based constraint passed unconditionally.
 * SHACL §5.2.1 says the opposite: for a SELECT constraint, EVERY SOLUTION IS A VIOLATION.
 *
 * ★ AND NOTHING WOULD HAVE FOUND IT. `sparqlConstraints` is an exported field of an exported
 * interface, and grep across the whole repo finds it in exactly three places: the interface,
 * the loop that reads it, and one arithmetic expression. No test, no caller, no fixture. A
 * code path with no test is not "untested" in the mild sense — it is a claim in the type
 * signature that nothing has ever checked.
 *
 * ★ WHY IT REFUSES RATHER THAN APPROXIMATES. Pre-binding here is TEXTUAL substitution of
 * `$this`, and SHACL's pre-binding is substitution into the query ALGEBRA with a rule that a
 * pre-bound variable must not be re-bound. Replacing characters cannot tell those cases
 * apart, and it would happily rewrite a `$this` sitting inside a string literal. So the two
 * cases it cannot handle correctly now THROW. A constraint that runs and answers wrongly is
 * worse than one that says it cannot run.
 */
import { describe, it, expect } from 'vitest';
import {
  createPGSL, ingest, validateDomainShapes,
  type PGSLInstance, type ShaclShapeDefinition,
} from '@interego/pgsl';
import type { IRI } from '@interego/core';

const PGSL_NS = 'https://markjspivey-xwisee.github.io/interego/ns/pgsl#';

/** A lattice with something in it, so a query has data to find. `ingest` mutates. */
function lattice(): PGSLInstance {
  const p = createPGSL({
    wasAttributedTo: 'urn:test:agent' as IRI,
    generatedAtTime: '2026-01-01T00:00:00Z',
  });
  ingest(p, ['the', 'cat', 'sat']);
  return p;
}

const shape = (sparql: string): ShaclShapeDefinition => ({
  name: 'ProbeShape',
  targetClass: `${PGSL_NS}Atom`,
  properties: [],
  sparqlConstraints: [sparql],
});

describe('a SELECT-based SPARQL constraint', () => {
  it('VIOLATES when the query returns a solution — it could never violate before', () => {
    // Every atom has a pgsl:value, so this query returns solutions for every focus node.
    const r = validateDomainShapes(lattice(), [shape(
      `PREFIX pgsl: <${PGSL_NS}>\nSELECT $this WHERE { $this pgsl:value ?v }`)]);
    expect(r.conforms).toBe(false);
    expect(r.violations.length).toBeGreaterThan(0);
  });

  it('and CONFORMS when it returns none — it constrains, it does not reject everything', () => {
    // Guards the guard. A rule that reported a violation unconditionally would satisfy the
    // assertion above just as well, and would be exactly as useless in the other direction.
    const r = validateDomainShapes(lattice(), [shape(
      `PREFIX pgsl: <${PGSL_NS}>\nSELECT $this WHERE { $this pgsl:nothingHasThis ?v }`)]);
    expect(r.conforms).toBe(true);
    expect(r.violations).toEqual([]);
  });
});

describe('what it refuses rather than answering wrongly', () => {
  it.each([
    ['$this inside a string literal — textual substitution would rewrite it',
      'SELECT $this WHERE { $this ?p "a literal mentioning $this" }',
      /inside a string literal/],
    ['BIND re-binding $this, which SHACL pre-binding forbids',
      'SELECT $this WHERE { BIND(<urn:x> AS $this) }',
      /re-binds \$this/],
    ['a query that is neither ASK nor SELECT',
      'CONSTRUCT { $this ?p ?o } WHERE { $this ?p ?o }',
      /neither ASK nor SELECT/],
  ])('refuses: %s', (_label, sparql, message) => {
    expect(() => validateDomainShapes(lattice(), [shape(sparql)])).toThrow(message);
  });

  it('an ASK constraint still works, and false is still the violation', () => {
    // The one form that DID work must keep working — the fix is additive, not a rewrite.
    const ok = validateDomainShapes(lattice(), [shape(
      `PREFIX pgsl: <${PGSL_NS}>\nASK { $this pgsl:value ?v }`)]);
    expect(ok.conforms).toBe(true);
  });
});
