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

/** The same projection, with the rule switched off. Must infer NOTHING, not everything. */
const PROJECT_DEACTIVATED_RULE = `${PREFIXES}
ex:Projection a sh:NodeShape ;
  sh:targetClass ex:Record ;
  sh:rule [ a sh:TripleRule ; sh:deactivated true ;
            sh:subject sh:this ; sh:predicate ex:status ; sh:object [ sh:path ex:status ] ] .
`;

/** Same again, switched off at the node shape rather than the rule. Same meaning. */
const PROJECT_DEACTIVATED_SHAPE = `${PREFIXES}
ex:Projection a sh:NodeShape ;
  sh:targetClass ex:Record ;
  sh:deactivated true ;
  sh:rule [ a sh:TripleRule ;
            sh:subject sh:this ; sh:predicate ex:status ; sh:object [ sh:path ex:status ] ] .
`;

/** A shape declaring no rule at all — the ONE case that legitimately means "merge". */
const PLAIN_MERGE = `${PREFIXES}
ex:Plain a sh:NodeShape ; sh:targetClass ex:Record ; sh:property [ sh:path ex:status ] .
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
    // ★ The number the kernel actually reads. 0 here — and ONLY here — licenses the merge.
    expect(run.declaredRules).toBe(0);
    expect(run.turtle).toBe('');
  });

  it('honours sh:deactivated on the rule WITHOUT looking like a shape that declares none', () => {
    const run = runShaclRules(RECORD_DATA, PROJECT_DEACTIVATED_RULE);
    expect(run.ruleCount).toBe(0);
    expect(run.tripleCount).toBe(0);
    // ★ THE ASSERTION THE OLD TEST WAS MISSING, and its absence is why the leak shipped.
    // The old test asserted `ruleCount === 0` and stopped — pinning the exact return value
    // that made `applyReducerStep` union the raw link body. The shape DECLARES a rule; it
    // is switched off. Those are different facts and the caller needs both.
    expect(run.declaredRules).toBe(1);
  });

  it('honours sh:deactivated on the NODE SHAPE the same way', () => {
    const run = runShaclRules(RECORD_DATA, PROJECT_DEACTIVATED_SHAPE);
    expect(run.ruleCount).toBe(0);
    expect(run.declaredRules).toBe(1);
    expect(run.turtle).toBe('');
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
    // ★ THE FIXTURE HERE USED TO BE `ex:P sh:targetClass ex:Record ; sh:rule [ … ]`, AND IT
    // WAS WRONG ABOUT WHAT A SHAPE IS. §2.1.1 gives four sufficient conditions and rdf:type
    // is only one of them: a node that is the subject of a TARGET triple is a shape, full
    // stop. The engine required the type, so it did not compile that node, so this threw —
    // and the test recorded the bug as the contract.
    //
    // The guard itself is real, so it is kept and re-pointed at a node that genuinely is
    // not a shape by any of the four conditions: no rdf:type, no target, no constraint
    // parameter. sh:rule alone does not make one — a rule needs a shape to say WHICH nodes
    // it applies to, and without that there is nothing to run it against.
    const notAShape = `${PREFIXES}
ex:P sh:rule [ a sh:TripleRule ; sh:subject sh:this ; sh:predicate ex:status ; sh:object [ sh:path ex:status ] ] .
`;
    expect(() => runShaclRules(RECORD_DATA, notAShape)).toThrow(/not a compiled sh:NodeShape/);
  });

  it('…and a shape declared by its TARGET alone, with no rdf:type, does compile', () => {
    // The other half of the correction above: what §2.1.1 says IS a shape must be treated
    // as one. Without this, the fix could have been "make the error message match" rather
    // than "recognise the shape", and nothing would have caught the difference.
    const typeless = `${PREFIXES}
ex:P sh:targetClass ex:Record ;
  sh:rule [ a sh:TripleRule ; sh:subject sh:this ; sh:predicate ex:status ; sh:object [ sh:path ex:status ] ] .
`;
    expect(() => runShaclRules(RECORD_DATA, typeless)).not.toThrow();
  });

  // ★ THE OFF SWITCH IS NOT A SKIP-THE-CHECKS SWITCH.
  //
  // `sh:deactivated` used to `continue` above the well-formedness check (though below the
  // type check), so the ill-formed fixture two tests up — the one this suite pins as
  // REFUSED — became silently acceptable the moment its author added one keyword. Combined
  // with the ruleCount conflation it then folded the ENTIRE link body. Whether a rule is
  // well-formed is a property of the shape as written, not of whether it is switched on.
  it('still refuses an ill-formed rule that is ALSO marked sh:deactivated', () => {
    const badAndOff = `${PREFIXES}
ex:P a sh:NodeShape ; sh:targetClass ex:Record ;
  sh:rule [ a sh:TripleRule ; sh:deactivated true ; sh:subject sh:this ; sh:predicate ex:status ] .
`;
    expect(() => runShaclRules(RECORD_DATA, badAndOff)).toThrow(/sh:subject, sh:predicate and sh:object/);
  });

  it('still refuses an ill-formed rule under a DEACTIVATED node shape', () => {
    const badUnderOffShape = `${PREFIXES}
ex:P a sh:NodeShape ; sh:targetClass ex:Record ; sh:deactivated true ;
  sh:rule [ a sh:TripleRule ; sh:subject sh:this ; sh:predicate ex:status ] .
`;
    expect(() => runShaclRules(RECORD_DATA, badUnderOffShape)).toThrow(/sh:subject, sh:predicate and sh:object/);
  });

  it('still refuses an unknown sh: property on a deactivated rule node', () => {
    const condAndOff = `${PREFIXES}
ex:P a sh:NodeShape ; sh:targetClass ex:Record ;
  sh:rule [ a sh:TripleRule ; sh:deactivated true ; sh:condition ex:SomeShape ;
            sh:subject sh:this ; sh:predicate ex:status ; sh:object [ sh:path ex:status ] ] .
`;
    expect(() => runShaclRules(RECORD_DATA, condAndOff)).toThrow(/unsupported/);
  });
});

// ── Term resolution: what a rule constructs must be what the rule says ──
//
// ★ THESE FORMS DID NOT THROW AND DID NOT CONSTRUCT FEWER TRIPLES. They FABRICATED a
// wrong one: `asIri` returned undefined for a complex path, `objPath` stayed undefined,
// and the code fell through to emitting the term itself — putting `_:_anon1`, a blank-node
// label from the SHAPE document, into the constructed data graph and into the hashed
// headStateCid the substrate presents as independently verifiable. A triple naming a node
// that exists in neither graph is worse than a missing triple.
describe('runShaclRules — refuses fabricating a term it cannot resolve', () => {
  const PROJECT_WITH = (sPart: string, oPart: string): string => `${PREFIXES}
ex:P a sh:NodeShape ; sh:targetClass ex:Record ;
  sh:rule [ a sh:TripleRule ; sh:subject ${sPart} ; sh:predicate ex:status ; sh:object ${oPart} ] .
`;

  it('throws on a complex sh:path (sh:inversePath) under sh:object', () => {
    expect(() => runShaclRules(RECORD_DATA, PROJECT_WITH('sh:this', '[ sh:path [ sh:inversePath ex:status ] ]')))
      .toThrow(/complex sh:path expression/);
  });

  it('throws on a sequence-path collection under sh:object', () => {
    expect(() => runShaclRules(RECORD_DATA, PROJECT_WITH('sh:this', '[ sh:path ( ex:status ex:ssn ) ]')))
      .toThrow(/complex sh:path expression/);
  });

  it('throws on a blank node with no sh:path at all under sh:object', () => {
    expect(() => runShaclRules(RECORD_DATA, PROJECT_WITH('sh:this', '[ ex:unrelated "x" ]')))
      .toThrow(/blank node without sh:path/);
  });

  it('throws on a blank node with no sh:path under sh:subject', () => {
    expect(() => runShaclRules(RECORD_DATA, PROJECT_WITH('[ ex:unrelated "x" ]', '"closed"')))
      .toThrow(/blank node without sh:path/);
  });

  // ★ SHACL-AF: AN IRI IS ALWAYS A CONSTANT. The value-path lookup used to accept
  // `oTerm.kind === 'iri'` too and resolve it against every subject in the shape document,
  // so ONE unrelated triple elsewhere in the same file — `ex:Redacted sh:path ex:ssn .` —
  // silently converted `sh:object ex:Redacted` from "emit the constant ex:Redacted" into
  // "emit the values of ex:ssn at the focus node". The rule a reviewer reads was not the
  // rule that ran, and the divergence leaked in exactly the direction the fix prevents.
  it('does not let a stray sh:path elsewhere in the shape hijack an IRI constant', () => {
    const hijack = `${PREFIXES}
ex:Redacted sh:path ex:ssn .
ex:P a sh:NodeShape ; sh:targetClass ex:Record ;
  sh:rule [ a sh:TripleRule ; sh:subject sh:this ; sh:predicate ex:status ; sh:object ex:Redacted ] .
`;
    const run = runShaclRules(RECORD_DATA, hijack);
    expect(run.turtle).toContain('<https://example.org/Redacted>');
    expect(run.turtle).not.toContain('111-22-3333');
    // Identical to the same shape without the stray triple — that IS the property.
    const clean = `${PREFIXES}
ex:P a sh:NodeShape ; sh:targetClass ex:Record ;
  sh:rule [ a sh:TripleRule ; sh:subject sh:this ; sh:predicate ex:status ; sh:object ex:Redacted ] .
`;
    expect(run.turtle).toBe(runShaclRules(RECORD_DATA, clean).turtle);
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

  // ★ THE LEAK ONE KEYWORD AWAY, AT THE LAYER WHERE IT ACTUALLY BIT.
  //
  // `runShaclRules` was tested in isolation, where `ruleCount === 0` is not yet
  // load-bearing, so the deactivation case looked correct there and was a disclosure here.
  // These assert the FOLD, which is the thing with the security property.
  it('a DEACTIVATED projection contributes nothing — it does not fall back to the union', async () => {
    const result = await reduce(HEAD, {
      fetch: fetcherFor({ [HEAD]: RECORD_DATA }),
      reducerSpec: { kind: 'shacl-transform', shape: PROJECT_DEACTIVATED_RULE },
    });
    // SHACL-AF: a deactivated rule infers NOTHING. Switching a redaction rule off must
    // narrow the fold, never widen it back to the raw link body.
    expect(result.head).not.toContain('111-22-3333');
    expect(result.head).toBe('');
  });

  it('a DEACTIVATED node shape contributes nothing either', async () => {
    const result = await reduce(HEAD, {
      fetch: fetcherFor({ [HEAD]: RECORD_DATA }),
      reducerSpec: { kind: 'shacl-transform', shape: PROJECT_DEACTIVATED_SHAPE },
    });
    expect(result.head).not.toContain('111-22-3333');
    expect(result.head).toBe('');
  });

  it('deactivated-projection, plain-merge and honest-projection are three distinct headStateCids', async () => {
    const f = fetcherFor({ [HEAD]: RECORD_DATA });
    const spec = (shape: string) => ({ fetch: f, reducerSpec: { kind: 'shacl-transform' as const, shape } });
    const off = await reduce(HEAD, spec(PROJECT_DEACTIVATED_RULE));
    const offShape = await reduce(HEAD, spec(PROJECT_DEACTIVATED_SHAPE));
    const merged = await reduce(HEAD, spec(PLAIN_MERGE));
    const projected = await reduce(HEAD, spec(PROJECT_STATUS));
    // All three used to be ONE CID — the exact "two different shapes, one headStateCid"
    // failure the projecting-vs-merge test above was written to close, reopened by
    // `sh:deactivated`. A CID that cannot tell a redaction from a disclosure is not a proof.
    expect(new Set([
      off.replayProof.headStateCid,
      merged.replayProof.headStateCid,
      projected.replayProof.headStateCid,
    ]).size).toBe(3);
    // Off-at-the-rule and off-at-the-shape mean the same thing, so they agree.
    expect(offShape.replayProof.headStateCid).toBe(off.replayProof.headStateCid);
  });

  it('an ill-formed shape marked sh:deactivated still REFUSES rather than folding the body', async () => {
    const badAndOff = `${PREFIXES}
ex:P a sh:NodeShape ; sh:targetClass ex:Record ;
  sh:rule [ a sh:TripleRule ; sh:deactivated true ; sh:subject sh:this ; sh:predicate ex:status ] .
`;
    await expect(reduce(HEAD, {
      fetch: fetcherFor({ [HEAD]: RECORD_DATA }),
      reducerSpec: { kind: 'shacl-transform', shape: badAndOff },
    })).rejects.toThrow(/could not be executed/);
  });
});
