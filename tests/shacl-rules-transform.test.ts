/**
 * SHACL-AF `sh:rule` execution, and the kernel `reduce` fold that depends on it.
 *
 * ★ THE DEFECT. `applyReducerStep`'s `shacl-transform` branch returned
 * `prior ∪ currentBody` for EVERY shape — it never looked at the shape at all. So a
 * reducer whose entire job was to NARROW the graph widened it instead:
 *
 *     shape:  "construct <s> ex:status ?v for each ex:Record"
 *     fold:   prior ∪ the whole record, ex:ssn included
 *
 * and an UNPARSEABLE shape produced the same folded head — and the same headStateCid —
 * as a valid one, so a typo'd redaction rule redacted nothing and the ReplayProof still
 * verified. A transform declared to drop a field and observed to keep it is a disclosure,
 * not a coarse approximation.
 *
 * ★ WHY runShaclRules THROWS RATHER THAN SKIPPING. A rule engine that silently ignores a
 * form it cannot execute reports "0 triples constructed" for "I refused to look", and the
 * caller cannot distinguish that from a rule that legitimately matched no rows. Every
 * inexpressible form here — sh:SPARQLRule, sh:construct, an unknown sh: property on the
 * rule node, an ill-formed TripleRule, a rule hung off a non-NodeShape — is a throw.
 */
import { describe, it, expect } from 'vitest';
import { runShaclRules, ShaclRuleError, reduce, parseTrig } from '@interego/core';
import type { IRI } from '@interego/core';

const PREFIXES = `
@prefix sh:  <http://www.w3.org/ns/shacl#> .
@prefix ex:  <https://example.org/> .
@prefix iep: <https://interego.xwisee.com/ns/iep#> .
`;

const RECORD_DATA = `${PREFIXES}
ex:r1 a ex:Record ; ex:status "open" ; ex:ssn "111-22-3333" .
`;

/** Project ONLY ex:status. ex:ssn must not survive. */
const PROJECT_STATUS = `${PREFIXES}
ex:Projection a sh:NodeShape ;
  sh:targetClass ex:Record ;
  sh:rule [ a sh:TripleRule ;
            sh:subject sh:this ;
            sh:predicate ex:status ;
            sh:object [ sh:path ex:status ] ] .
`;

describe('runShaclRules — executing sh:TripleRule', () => {
  it('constructs only what the rule declares', () => {
    const run = runShaclRules(RECORD_DATA, PROJECT_STATUS);
    expect(run.ruleCount).toBe(1);
    expect(run.tripleCount).toBe(1);
    expect(run.turtle).toContain('<https://example.org/status>');
    // ★ The disclosure the union fold used to leak.
    expect(run.turtle).not.toContain('111-22-3333');
    expect(run.turtle).not.toContain('ssn');
  });

  it('emits full IRIs, not prefixed names', () => {
    // The result is concatenated with the next chain link's own @prefix block; a prefix
    // that resolved differently in the two documents would silently retarget the triples.
    const run = runShaclRules(RECORD_DATA, PROJECT_STATUS);
    expect(run.turtle).toMatch(/^<https:\/\/example\.org\/r1> <https:\/\/example\.org\/status> "open" \.$/);
  });

  it('is order-stable and deduped', () => {
    const two = `${PREFIXES}
ex:a a ex:Record ; ex:status "open" .
ex:b a ex:Record ; ex:status "open" .
`;
    const first = runShaclRules(two, PROJECT_STATUS).turtle;
    const second = runShaclRules(two, PROJECT_STATUS).turtle;
    // Byte-identical across runs: the reduce verb hashes this into a ReplayProof
    // checkpoint, so an unstable Map iteration order would make an honest replay look
    // like tampering.
    expect(first).toBe(second);
    expect(first.split('\n')).toHaveLength(2);
  });

  it('escapes a literal that would otherwise close the string and inject triples', () => {
    const hostile = `${PREFIXES}
ex:r1 a ex:Record ; ex:status "ok\\" . <https://example.org/evil> <https://example.org/p> \\"x" .
`;
    const run = runShaclRules(hostile, PROJECT_STATUS);
    expect(run.tripleCount).toBe(1);
    // The evil IRI survives as TEXT inside the escaped literal — that is fine and is what
    // escaping means. What must not happen is it becoming a TRIPLE when the next fold step
    // parses this output, so assert on the re-parse, not on a substring.
    const reparsed = parseTrig(run.turtle);
    expect(reparsed.subjects).toHaveLength(1);
    expect(reparsed.subjects[0]!.subject).toBe('https://example.org/r1');
  });

  it('reports 0 rules for a shape that declares none, without touching the data', () => {
    const noRules = `${PREFIXES}
ex:Plain a sh:NodeShape ; sh:targetClass ex:Record ; sh:property [ sh:path ex:status ] .
`;
    const run = runShaclRules(RECORD_DATA, noRules);
    expect(run.ruleCount).toBe(0);
    expect(run.turtle).toBe('');
  });

  it('honours sh:deactivated on the rule', () => {
    const off = `${PREFIXES}
ex:Projection a sh:NodeShape ;
  sh:targetClass ex:Record ;
  sh:rule [ a sh:TripleRule ; sh:deactivated true ;
            sh:subject sh:this ; sh:predicate ex:status ; sh:object [ sh:path ex:status ] ] .
`;
    const run = runShaclRules(RECORD_DATA, off);
    expect(run.ruleCount).toBe(0);
    expect(run.tripleCount).toBe(0);
  });
});

describe('runShaclRules — refuses rather than under-reporting', () => {
  it('throws on an unparseable shape graph', () => {
    expect(() => runShaclRules(RECORD_DATA, '@prefix sh: <http')).toThrow(ShaclRuleError);
  });

  it('throws on sh:SPARQLRule', () => {
    const sparqlRule = `${PREFIXES}
ex:P a sh:NodeShape ; sh:targetClass ex:Record ;
  sh:rule [ a sh:SPARQLRule ; sh:construct "CONSTRUCT { } WHERE { }" ] .
`;
    expect(() => runShaclRules(RECORD_DATA, sparqlRule)).toThrow(/SPARQL engine/);
  });

  it('throws on an unknown sh: property of the rule node', () => {
    // sh:condition is the dangerous one: ignoring it BROADENS what the rule constructs.
    const cond = `${PREFIXES}
ex:P a sh:NodeShape ; sh:targetClass ex:Record ;
  sh:rule [ a sh:TripleRule ; sh:condition ex:SomeShape ;
            sh:subject sh:this ; sh:predicate ex:status ; sh:object [ sh:path ex:status ] ] .
`;
    expect(() => runShaclRules(RECORD_DATA, cond)).toThrow(/unsupported/);
  });

  it('throws on an ill-formed TripleRule missing sh:object', () => {
    const bad = `${PREFIXES}
ex:P a sh:NodeShape ; sh:targetClass ex:Record ;
  sh:rule [ a sh:TripleRule ; sh:subject sh:this ; sh:predicate ex:status ] .
`;
    expect(() => runShaclRules(RECORD_DATA, bad)).toThrow(/sh:subject, sh:predicate and sh:object/);
  });

  it('throws when sh:rule hangs off something that is not a compiled sh:NodeShape', () => {
    const notAShape = `${PREFIXES}
ex:P sh:targetClass ex:Record ;
  sh:rule [ a sh:TripleRule ; sh:subject sh:this ; sh:predicate ex:status ; sh:object [ sh:path ex:status ] ] .
`;
    expect(() => runShaclRules(RECORD_DATA, notAShape)).toThrow(/not a compiled sh:NodeShape/);
  });
});

// ── The kernel fold that depends on all of the above ──────────

const HEAD = 'https://example.org/chain/head' as IRI;

function fetcherFor(bodies: Record<string, string>) {
  return async (iri: IRI): Promise<string | null> => bodies[iri] ?? null;
}

describe('reduce() shacl-transform actually runs the shape', () => {
  it('drops what the projection does not construct', async () => {
    const result = await reduce(HEAD, {
      fetch: fetcherFor({ [HEAD]: RECORD_DATA }),
      reducerSpec: { kind: 'shacl-transform', shape: PROJECT_STATUS },
    });
    // ★ The repro. Before the fix the folded head was the whole record.
    expect(result.head).not.toContain('111-22-3333');
    expect(result.head).toContain('<https://example.org/status>');
  });

  it('a shape with no sh:rule still means merge', async () => {
    const merge = `${PREFIXES}
ex:Plain a sh:NodeShape ; sh:targetClass ex:Record ; sh:property [ sh:path ex:status ] .
`;
    const result = await reduce(HEAD, {
      fetch: fetcherFor({ [HEAD]: RECORD_DATA }),
      reducerSpec: { kind: 'shacl-transform', shape: merge },
    });
    expect(result.head).toContain('111-22-3333');
  });

  it('an unparseable shape REFUSES instead of yielding the union', async () => {
    // Before the fix this returned the same state — and the same headStateCid — as a
    // valid shape, so a broken redaction rule was indistinguishable from a working one.
    await expect(reduce(HEAD, {
      fetch: fetcherFor({ [HEAD]: RECORD_DATA }),
      reducerSpec: { kind: 'shacl-transform', shape: '@prefix sh: <http' },
    })).rejects.toThrow(/could not be executed/);
  });

  it('a projecting shape and a merge shape no longer share a headStateCid', async () => {
    const merge = `${PREFIXES}
ex:Plain a sh:NodeShape ; sh:targetClass ex:Record ; sh:property [ sh:path ex:status ] .
`;
    const f = fetcherFor({ [HEAD]: RECORD_DATA });
    const projected = await reduce(HEAD, { fetch: f, reducerSpec: { kind: 'shacl-transform', shape: PROJECT_STATUS } });
    const merged = await reduce(HEAD, { fetch: f, reducerSpec: { kind: 'shacl-transform', shape: merge } });
    expect(projected.replayProof.headStateCid).not.toBe(merged.replayProof.headStateCid);
  });
});
