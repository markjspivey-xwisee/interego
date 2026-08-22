/**
 * The parts of the SPARQL evaluator the W3C suite never asks about.
 *
 * ★ THIS FILE EXISTS BECAUSE TWO MUTANTS SURVIVED 26 OF 26. After the SHACL-SPARQL suite
 * reached full marks — verdicts AND every expected result, matched one-to-one — ten bugs
 * were installed one at a time to see which the suite would catch. Eight died. Two lived:
 *
 *   1. deleting the rule that an aggregate with no GROUP BY produces ONE row even when the
 *      pattern matched nothing, so `SELECT (COUNT(?x) AS ?n)` answered "no rows" instead of
 *      "zero";
 *   2. computing MIN, MAX and AVG as `NaN` — stored, confidently, as an xsd:integer literal
 *      reading "NaN".
 *
 * Neither is obscure and neither is hypothetical: both were REAL BUGS, found while chasing a
 * spec entry, and both were fixed. The suite simply never asks. Its 26 validation entries use
 * COUNT over a non-empty match and nothing else, so a conformance score of 26 of 26 is
 * silent about five of the seven aggregates the parser accepts.
 *
 * ★ AND "THE PARSER ACCEPTS IT" IS THE PART THAT MAKES IT DANGEROUS. An unimplemented
 * function this evaluator does not know is REFUSED by name — the query fails, loudly, and
 * the caller learns the engine cannot answer. MIN was in the accepted-aggregates set and
 * absent from the computation, which is the other thing: a typed, plausible, wrong answer.
 *
 * A conformance suite measures agreement with a specification. It does not measure whether
 * the code you wrote around it is right, and a number that keeps going up can hide the
 * difference. These are the checks the suite cannot be.
 */
import { describe, it, expect } from 'vitest';
import { parseTrig, runSparql } from '@interego/core';

const PREFIXES = new Map([
  ['ex', 'http://example.com/ns#'],
  ['rdfs', 'http://www.w3.org/2000/01/rdf-schema#'],
]);

const DATA = parseTrig(`
  @prefix ex: <http://example.com/ns#> .
  @prefix rdfs: <http://www.w3.org/2000/01/rdf-schema#> .

  ex:Cougar
    rdfs:label "Cougar"@en ;
    rdfs:label "Mountain Lion"@en-US ;
    rdfs:label "Puma"@de ;
    ex:score 3 ;
    ex:score 11 ;
    ex:score 7 .

  ex:Empty a ex:Thing .
`);

const one = (query: string): Map<string, { value?: string; iri?: string }> | undefined => {
  const r = runSparql(DATA, query, PREFIXES);
  return r.bindings[0] as Map<string, { value?: string; iri?: string }> | undefined;
};

describe('an aggregate over an empty result', () => {
  it('still answers, and the answer is zero', () => {
    // ★ SPARQL §18.5: a query with aggregates and no GROUP BY has exactly one group. An
    // empty result set is not the absence of an answer — it is the input to COUNT, and the
    // answer is 0. Returning no rows here is the shape of bug that reads as "nothing to
    // report" at every call site.
    const row = one('SELECT (COUNT(?x) AS ?n) WHERE { ex:Cougar ex:nothing ?x }');
    expect(row, 'an aggregate query returned NO row at all').toBeDefined();
    expect(row?.get('n')?.value).toBe('0');
  });

  it('and AVG of nothing is 0, not an error and not NaN', () => {
    expect(one('SELECT (AVG(?x) AS ?a) WHERE { ex:Cougar ex:nothing ?x }')?.get('a')?.value)
      .toBe('0');
  });

  it('while MIN and MAX of nothing are correctly UNBOUND', () => {
    // Not zero: there is no smallest member of an empty set, and answering 0 would be a
    // value the data never contained.
    const row = one('SELECT (MIN(?x) AS ?m) WHERE { ex:Cougar ex:nothing ?x }');
    expect(row).toBeDefined();
    expect(row?.get('m')).toBeUndefined();
  });
});

describe('every aggregate the parser accepts is computed', () => {
  const q = (agg: string): string =>
    `SELECT (${agg} AS ?r) WHERE { ex:Cougar ex:score ?s }`;

  it.each([
    ['COUNT(?s)', '3'],
    ['SUM(?s)', '21'],
    ['MIN(?s)', '3'],
    ['MAX(?s)', '11'],
    // "7.0", not "7": Avg is Sum/Count via op:numeric-divide, and integer / integer is
    // xsd:decimal. This line said '7' until a reviewer read the arithmetic against the spec.
    ['AVG(?s)', '7.0'],
  ])('%s is %s', (agg, expected) => {
    // ★ MIN/MAX ORDER NUMERICALLY, NOT LEXICALLY. "11" < "3" as strings, and a comparator
    // that falls back to the term's key gets MAX(3, 11, 7) = 7 — a real number from the real
    // data, wrong by a hair, and impossible to spot in a report.
    expect(one(q(agg))?.get('r')?.value).toBe(expected);
  });

  it('SAMPLE returns one of the values', () => {
    expect(['3', '11', '7']).toContain(one(q('SAMPLE(?s)'))?.get('r')?.value);
  });

  it('GROUP_CONCAT joins them', () => {
    const v = one(q('GROUP_CONCAT(?s)'))?.get('r')?.value ?? '';
    expect(v.split(' ').sort()).toEqual(['11', '3', '7']);
  });
});

describe('a zero-length path', () => {
  it('reaches a term that appears in the graph only as a PREDICATE', () => {
    // ★ §18.4: where one end is a term and the other a variable, ZeroLengthPath binds the
    // variable to that term. Nothing requires the term to be a NODE of the graph — and
    // `?p rdfs:subPropertyOf* rdfs:label`, the idiomatic "rdfs:label or anything under it",
    // is exactly that case. Seeding the identity from the graph's subjects and objects finds
    // nothing, so the query that walks every label walks none.
    const r = runSparql(DATA, 'SELECT ?p WHERE { ?p rdfs:subPropertyOf* rdfs:label }', PREFIXES);
    expect(r.bindings.map(b => (b.get('p') as { iri?: string })?.iri))
      .toContain('http://www.w3.org/2000/01/rdf-schema#label');
  });

  it('and still relates every node of the graph to itself when both ends are variables', () => {
    const r = runSparql(DATA, 'SELECT ?a ?b WHERE { ?a ex:nothing* ?b }', PREFIXES);
    const pairs = r.bindings.map(b => [
      (b.get('a') as { iri?: string })?.iri, (b.get('b') as { iri?: string })?.iri]);
    expect(pairs).toContainEqual(['http://example.com/ns#Empty', 'http://example.com/ns#Empty']);
    expect(pairs.every(([a, b]) => a === b), 'a zero-length path related two DIFFERENT nodes')
      .toBe(true);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
//  What a six-lens ADVERSARIAL REVIEW found after the score was already full
// ═══════════════════════════════════════════════════════════════════════════
//
// ★ 44 OF 44 WITH EVERY MUTANT DEAD WAS STILL NOT ENOUGH. Six reviewers were pointed at the
// change set and told to REFUTE it; each finding was then handed to two skeptics told to kill
// it, and twenty-five survived both. Every one reproduced against the build. The evaluator's
// share is below. Each is a wrong ANSWER rather than a missing feature, and the W3C suite
// asks none of these questions.

describe('an aggregate modifier that was parsed and thrown away', () => {
  const doc = parseTrig(`
    @prefix ex: <http://example.com/ns#> .
    ex:s ex:v 1 ; ex:v 1 ; ex:v 2 .
  `);
  const one = (q: string): string | undefined =>
    (runSparql(doc, q, PREFIXES).bindings[0]?.get('r') as { value?: string } | undefined)?.value;

  it('COUNT(DISTINCT ?v) counts the DISTINCT values', () => {
    // ★ `eatWord('DISTINCT')` consumed the token and dropped the flag, so the modifier was
    // ACCEPTED and never applied — precisely what this module's header says must be refused
    // by name rather than answered wrongly. It returned 3.
    expect(one('SELECT (COUNT(DISTINCT ?v) AS ?r) WHERE { ex:s ex:v ?v }')).toBe('2');
  });

  it('and SUM(DISTINCT ?v) adds each of them once', () => {
    expect(one('SELECT (SUM(DISTINCT ?v) AS ?r) WHERE { ex:s ex:v ?v }')).toBe('3');
  });
});

describe('an aggregate over a value that is not a number', () => {
  it('is a type error — the aggregate is UNBOUND, not a sum of the numeric subset', () => {
    // §18.5.1.2: Sum over a non-numeric operand raises an error, and an aggregate that errors
    // binds nothing. Filtering the offender out answers a different question — "the sum of
    // whichever members happened to be numeric" — and the discarded value still decided the
    // result's datatype.
    const doc = parseTrig('@prefix ex: <http://example.com/ns#> . ex:s ex:v 1 ; ex:v 2 ; ex:v "x" .');
    const row = runSparql(doc, 'SELECT (SUM(?v) AS ?r) WHERE { ex:s ex:v ?v }', PREFIXES).bindings[0];
    expect(row, 'the group produced no row at all').toBeDefined();
    expect(row?.get('r')).toBeUndefined();
  });
});

describe('the order a query is evaluated in', () => {
  it('binds (expr AS ?v) BEFORE ORDER BY, so ORDER BY + LIMIT picks the right row', () => {
    // §18.2.4 fixes it: Group → Aggregation → Having → Extend → OrderBy → Project → Distinct
    // → Slice. Sorting before Extend left the sort key unbound on every row, the comparator
    // saw undefined on both sides, the sort became a no-op, and LIMIT 1 returned whichever
    // row happened to come first. A wrong answer, not an unsorted one.
    const doc = parseTrig('@prefix ex: <http://example.com/ns#> . ex:s ex:v 3 ; ex:v 1 ; ex:v 2 .');
    const r = runSparql(doc, 'SELECT (?v AS ?w) WHERE { ex:s ex:v ?v } ORDER BY ?w LIMIT 1', PREFIXES);
    expect((r.bindings[0]?.get('w') as { value?: string } | undefined)?.value).toBe('1');
  });

  it('and a FILTER applies to its whole group, wherever in it the filter is written', () => {
    // §18.2.2.8 lifts filters out of the group. Applied at its textual position, a filter
    // written first is evaluated against unbound variables and drops every row — the query
    // matches nothing, and the constraint it belongs to reports nothing.
    //
    // ★ BOTH DIRECTIONS, because one alone pins nothing: a filter that ACCEPTS returns one
    // row whether it was lifted or dropped altogether, and a filter that REJECTS returns none
    // whether it was lifted or applied too early. Only the pair distinguishes all three.
    const doc = parseTrig('@prefix ex: <http://example.com/ns#> . ex:s ex:v 5 .');
    expect(runSparql(doc, 'SELECT ?v WHERE { FILTER (?v > 1) ex:s ex:v ?v }', PREFIXES).bindings)
      .toHaveLength(1);
    expect(runSparql(doc, 'SELECT ?v WHERE { FILTER (?v > 10) ex:s ex:v ?v }', PREFIXES).bindings)
      .toHaveLength(0);
  });
});

describe('ordering is decided by the datatype, not by how the characters look', () => {
  const doc = parseTrig(`
    @prefix ex: <http://example.com/ns#> .
    ex:s ex:code "10" ; ex:code "9" .
    ex:s ex:num 10 ; ex:num 9 .
  `);
  const min = (predicate: string): string | undefined =>
    (runSparql(doc, `SELECT (MIN(?c) AS ?r) WHERE { ex:s ex:${predicate} ?c }`, PREFIXES)
      .bindings[0]?.get('r') as { value?: string } | undefined)?.value;

  it('MIN over xsd:string compares codepoints', () => {
    // ★ `Number("10") < Number("9")` is true and says nothing about two strings. Coercing
    // every literal through Number() made MIN("10","9") answer "9" — a real term from the
    // real data, wrong, and invisible in a report. Codes, versions and identifiers are
    // exactly the strings that look numeric.
    expect(min('code')).toBe('10');
  });

  it('MIN over xsd:integer compares numerically', () => {
    expect(min('num')).toBe('9');
  });
});

describe('a zero-length path', () => {
  it('yields its identity solution ONCE, not once per source that seeded it', () => {
    // The identity is seeded for every node of the graph AND appended for a bound endpoint.
    // With no dedup between the two, `ex:s ex:q* ?y` where ex:s is a graph node returns the
    // same solution twice — which doubles a COUNT and doubles a violation report.
    const doc = parseTrig('@prefix ex: <http://example.com/ns#> . ex:s ex:p ex:o .');
    expect(runSparql(doc, 'SELECT ?y WHERE { ex:s ex:q* ?y }', PREFIXES).bindings).toHaveLength(1);
  });
});

describe('an unbounded path runs to a fixpoint', () => {
  it('reaches the far end of a chain longer than any fixed bound', () => {
    // ★ THE LOOP STOPPED AT SIXTEEN HOPS AND SAID `false`. Not "I gave up" — false. A
    // reachability question answered "not reachable" because the engine stopped counting is
    // the fail-open direction this file exists to catch.
    const links = Array.from({ length: 40 }, (_, i) => `ex:n${i} ex:next ex:n${i + 1} .`).join('\n');
    const doc = parseTrig(`@prefix ex: <http://example.com/ns#> .\n${links}`);
    expect(runSparql(doc, 'ASK { ex:n0 ex:next+ ex:n40 }', PREFIXES).boolean).toBe(true);
  });

  it('and terminates on a cycle instead of walking it forever', () => {
    const doc = parseTrig(`@prefix ex: <http://example.com/ns#> .
      ex:a ex:next ex:b . ex:b ex:next ex:c . ex:c ex:next ex:a .`);
    expect(runSparql(doc, 'ASK { ex:a ex:next+ ex:a }', PREFIXES).boolean).toBe(true);
  });
});

describe('BASE', () => {
  it('resolves the relative IRIs written after it', () => {
    // ★ RECOGNISED AND DISCARDED IS WORSE THAN UNPARSED. The prologue regex matched
    // `BASE <…>` and stripped it, keeping only the PREFIX captures — so `<a>` became the IRI
    // `a`, matched nothing, and the constraint reported clean.
    // Resolved by RFC 3986 §5.3 against the base's PATH — deliberately not `new URL`, which
    // normalises the string, and a normalised IRI is a different IRI once anything has hashed
    // the original. So a `#`-terminated base does not extend its fragment: `<a>` against
    // `http://example.com/ns#` is `http://example.com/a`, which is the correct answer and not
    // the intuitive one.
    const doc = parseTrig('<http://example.com/v1/a> <http://example.com/v1/p> "v" .');
    const r = runSparql(doc, 'BASE <http://example.com/v1/> SELECT ?o WHERE { <a> <p> ?o }', new Map());
    expect(r.bindings).toHaveLength(1);
    const hashBase = runSparql(
      parseTrig('<http://example.com/a> <http://example.com/p> "v" .'),
      'BASE <http://example.com/ns#> SELECT ?o WHERE { <a> <p> ?o }', new Map());
    expect(hashBase.bindings).toHaveLength(1);
  });
});

describe('`_:b` outside a CONSTRUCT template', () => {
  it('is REFUSED, because a non-distinguished variable is not implemented', () => {
    // In a template it means "a fresh blank node per solution". In a WHERE clause SPARQL
    // makes it a variable that matches anything — and treating it there as the literal blank
    // node it looks like turns the pattern into one that matches nothing, so the constraint
    // passes silently. Refusing by name is the rule this module applies to every construct it
    // does not implement.
    const doc = parseTrig('@prefix ex: <http://example.com/ns#> . ex:s ex:p "v" .');
    expect(() => runSparql(doc, 'SELECT ?o WHERE { _:x ex:p ?o }', PREFIXES))
      .toThrow(/non-distinguished variable/);
  });
});

describe('a sub-SELECT', () => {
  const doc = parseTrig(`
    @prefix ex: <http://example.com/ns#> .
    ex:a ex:v 1 ; ex:v 2 ; ex:v 3 .
    ex:b ex:v 9 .
  `);

  it('folds its aggregate over the WHOLE multiset, not the enclosing row', () => {
    // ★ §18.2 EVALUATES A SUB-SELECT INDEPENDENTLY AND THEN JOINS. Passing the enclosing
    // solution in as a pre-binding correlated it — the inner COUNT then folded only over the
    // rows that agreed with the outer `?x`, so a query asking "how many values are there"
    // answered "how many values are there that equal this one": 1, four times over.
    //
    // SHACL's pre-binding is the one thing that DOES reach a sub-select, and it still does;
    // that is a different mechanism from a variable the enclosing pattern happened to bind.
    const r = runSparql(doc,
      'SELECT ?s ?n WHERE { ?s ex:v ?x . { SELECT (COUNT(?x) AS ?n) WHERE { ?y ex:v ?x } } }',
      PREFIXES);
    expect(r.bindings).toHaveLength(4);
    expect([...new Set(r.bindings.map(b => (b.get('n') as { value?: string })?.value))])
      .toEqual(['4']);
  });

  it('and JOINS on a shared variable rather than overwriting it', () => {
    // The merge was unconditional, so an outer row whose ?v disagreed with the sub-query's
    // silently took the sub-query's value — inventing a solution neither side had.
    const r = runSparql(doc,
      'SELECT ?s ?v WHERE { ?s ex:v ?v . { SELECT ?v WHERE { ex:b ex:v ?v } } }', PREFIXES);
    expect(r.bindings).toHaveLength(1);
    expect((r.bindings[0]?.get('s') as { iri?: string })?.iri).toBe('http://example.com/ns#b');
  });
});

// ═══════════════════════════════════════════════════════════════════════════
//  Round two: what a refute pass over THE FIXES found
// ═══════════════════════════════════════════════════════════════════════════
//
// ★ TWO OF THESE ARE REGRESSIONS THE FIRST ROUND OF FIXES INTRODUCED, which is the whole
// reason a second pass was run over the corrections rather than only over the original code.
// A fix authored and tested by the same mind encodes that mind's reading of the problem.

describe('the zero-length dedup, which half-fixed its own bug', () => {
  const doc = parseTrig(`
    @prefix ex: <http://example.com/ns#> .
    @prefix rdfs: <http://www.w3.org/2000/01/rdf-schema#> .
    ex:Cougar rdfs:label "Cougar" ; rdfs:label "Mountain Lion" ; rdfs:label "Puma" .
  `);

  it('adds the identity ONCE when both ends of the path are the same off-graph term', () => {
    // ★ THE DEDUP CHECKED `pairs` AND NOT ITSELF. Each end appended its own identity pair, so
    // a term absent from the graph — rdfs:label, which occurs only as a predicate — got it
    // twice. Exactly the duplication the dedup was added to prevent, on exactly the query
    // that motivated it: three labels counted as six.
    const r = runSparql(doc,
      'SELECT (COUNT(?o) AS ?n) WHERE { ?s ?p ?o . ?p rdfs:subPropertyOf* rdfs:label }', PREFIXES);
    expect((r.bindings[0]?.get('n') as { value?: string } | undefined)?.value).toBe('3');
  });

  it('and once when both ends are the same term written out in full', () => {
    expect(runSparql(doc, 'SELECT * WHERE { rdfs:label rdfs:subPropertyOf* rdfs:label }', PREFIXES)
      .bindings).toHaveLength(1);
  });

  it('and a zero-length walk reaches through a NESTED repeat', () => {
    // `(ex:p*)+` takes zero steps by taking one iteration of a zero-length inner path. Asking
    // only about the OUTER repeat's minimum answers a different question, and the off-graph
    // endpoint was then unreachable.
    const empty = parseTrig('@prefix ex: <http://example.com/ns#> . ex:s ex:other ex:o .');
    expect(runSparql(empty, 'SELECT ?y WHERE { ex:offGraph (ex:p*)+ ?y }', PREFIXES).bindings)
      .toHaveLength(1);
  });
});

describe('a FILTER inside a nested group', () => {
  it('does not see the variables of the group that CONTAINS it', () => {
    // ★ THE SECOND HALF OF THE FILTER FIX. §18.2.2.6 translates a group to
    // `Join(G, Filter(F, translate(inner)))` — the inner pattern is evaluated on its own and
    // only then joined. Seeding each nested group with the enclosing solutions made a filter
    // written inside the braces see variables from outside them, and lifting filters to the
    // end of their group turned that from "type error, no rows" into "compares fine, one
    // row". A false violation, produced by the fix for a different false negative.
    const doc = parseTrig(`@prefix ex: <http://example.com/ns#> .
      ex:alice ex:age 30 . ex:bob ex:age 20 .`);
    expect(runSparql(doc,
      'SELECT ?s WHERE { ?s ex:age ?age . { ex:bob ex:age ?limit . FILTER (?age > ?limit) } }',
      PREFIXES).bindings, '?age leaked into the nested group').toHaveLength(0);
  });

  it('while a UNION arm still joins what it does bind', () => {
    // The other direction: scoping the arm must not stop it contributing its own bindings.
    const doc = parseTrig(`@prefix ex: <http://example.com/ns#> .
      ex:a ex:kind "x" . ex:b ex:kind "y" .`);
    const r = runSparql(doc,
      'SELECT ?s WHERE { ?s ex:kind ?k . { ?s ex:kind "x" } UNION { ?s ex:kind "y" } }', PREFIXES);
    expect(r.bindings).toHaveLength(2);
  });
});

describe('a timestamp is a value, not a string', () => {
  it('MIN over xsd:dateTime compares INSTANTS across timezone offsets', () => {
    // ★ §15.1 orders by `<`, which §17.3 maps to op:dateTime-less-than. `2025-12-31T23:00:00-02:00`
    // IS `2026-01-01T01:00:00Z`, so it is the LATER instant while sorting first by codepoint.
    // Every literal that is not numeric fell through to the lexical comparison.
    const doc = parseTrig(`
      @prefix ex: <http://example.com/ns#> .
      @prefix xsd: <http://www.w3.org/2001/XMLSchema#> .
      ex:s ex:t "2026-01-01T00:00:00Z"^^xsd:dateTime ;
           ex:t "2025-12-31T23:00:00-02:00"^^xsd:dateTime .
    `);
    const r = runSparql(doc, 'SELECT (MIN(?t) AS ?m) WHERE { ex:s ex:t ?t }', PREFIXES);
    expect((r.bindings[0]?.get('m') as { value?: string } | undefined)?.value)
      .toBe('2026-01-01T00:00:00Z');
  });
});

describe('AVG is a division', () => {
  it('is xsd:decimal even when the mean is a whole number', () => {
    // §18.5.1.4 defines Avg as Sum/Count via op:numeric-divide, and integer ÷ integer is
    // xsd:decimal. Typing AVG(1,3) as xsd:integer made the aggregate disagree with the `/`
    // operator sitting beside it in the same evaluator.
    const doc = parseTrig('@prefix ex: <http://example.com/ns#> . ex:s ex:v 1 ; ex:v 3 .');
    const t = runSparql(doc, 'SELECT (AVG(?v) AS ?m) WHERE { ex:s ex:v ?v }', PREFIXES)
      .bindings[0]?.get('m') as { value?: string; datatype?: string } | undefined;
    expect(t?.datatype).toBe('http://www.w3.org/2001/XMLSchema#decimal');
    expect(t?.value).toBe('2.0');
  });

  it('and SUM of integers stays xsd:integer', () => {
    const doc = parseTrig('@prefix ex: <http://example.com/ns#> . ex:s ex:v 1 ; ex:v 3 .');
    const t = runSparql(doc, 'SELECT (SUM(?v) AS ?m) WHERE { ex:s ex:v ?v }', PREFIXES)
      .bindings[0]?.get('m') as { value?: string; datatype?: string } | undefined;
    expect(t?.datatype).toBe('http://www.w3.org/2001/XMLSchema#integer');
    expect(t?.value).toBe('4');
  });
});
