/**
 * Two exported query generators returned ZERO ROWS for every input, and nothing said so.
 *
 * ★ HOW ONE CHARACTER CLASS DISABLED FOUR FEATURES. The FILTER body was extracted with
 * `/FILTER\s*\(([^)]+)\)/` — and `[^)]+` cannot contain a closing parenthesis, so any filter
 * holding a FUNCTION CALL was truncated at that function's own `)`:
 *
 *     BOUND(?x)                        ->  BOUND(?x
 *     STRSTARTS(STR(?t), STR(iep:))    ->  STRSTARTS(STR(?t
 *
 * `parseFilter` implements STRSTARTS, BOUND, !BOUND and REGEX correctly, and every one of its
 * patterns requires the closing paren the outer regex had already eaten — so all four were
 * unreachable. The module's own doc comment listed them as supported.
 *
 * ★ AND THE FALLTHROUGH DID NOT REPORT, IT DELETED. An expression the parser did not
 * understand returned `{ variable: '?_', operator: '=', value: '' }` — a comparison on a
 * variable nothing ever binds — which drops EVERY ROW. No error, no warning, an empty array.
 * At a call site "no results" is indistinguishable from "no data".
 *
 * ★ WHAT IT COST, MEASURED ON SHIPPED CODE. Both of these are exported from @interego/core:
 *
 *     queryContextManifest      filters on STRSTARTS(STR(?facetType), STR(iep:))
 *                               -> 0 rows, always, for any store
 *     queryGraphsByTrustLevel   maps trust IRIs to scores with VALUES, then filters on the
 *                               score. VALUES was parsed by nothing, so ?score was never
 *                               bound and the filter compared an unbound variable
 *                               -> 0 rows for every input, including its own minimum level
 *
 * ★ WHY THIS FILE ASSERTS ROW CONTENT AND NOT ROW COUNTS. The existing SPARQL tests pass and
 * always did: they assert `bindings.length` and read values out of bindings that these
 * queries never produced, because they use the query shapes that happen to work. A count is
 * the one thing a silently-empty result set still satisfies when the expectation is also
 * zero — so every assertion below names the values it expects.
 */
import { describe, it, expect } from 'vitest';
import {
  createTripleStore, addTriple, executeSparqlString, type TripleStore,
} from '@interego/pgsl';
import { queryContextManifest, queryGraphsByTrustLevel } from '@interego/core';

const IEP = 'https://markjspivey-xwisee.github.io/interego/ns/iep#';
const TYPE = 'http://www.w3.org/1999/02/22-rdf-syntax-ns#type';
const EX = 'http://e/';

function store(triples: readonly (readonly [string, string, string])[]): TripleStore {
  const s = createTripleStore();
  for (const [subject, predicate, object] of triples) addTriple(s, { subject, predicate, object });
  return s;
}

const values = (s: TripleStore, q: string, v: string): string[] =>
  executeSparqlString(s, q).bindings.map(b => String(b.get(v)));

describe('a FILTER holding a function call', () => {
  const P = `PREFIX ex: <${EX}>\n`;
  const s = store([
    [`${EX}a`, `${EX}lvl`, `${EX}High`],
    [`${EX}b`, `${EX}lvl`, `${EX}Low`],
  ]);
  const ask = (filter: string): string[] =>
    values(s, `${P}SELECT ?s WHERE { ?s ex:lvl ?l . ${filter} }`, '?s').sort();

  it('has a control that returns BOTH rows, so a zero is meaningful', () => {
    // Without this, every assertion below is satisfied by a store that matched nothing.
    expect(ask('')).toEqual([`${EX}a`, `${EX}b`]);
  });

  it.each([
    ['STRSTARTS, bare variable', 'FILTER (STRSTARTS(?l, "http://e/H"))', [`${EX}a`]],
    ['STRSTARTS, STR()-wrapped', 'FILTER (STRSTARTS(STR(?l), "http://e/H"))', [`${EX}a`]],
    ['STRSTARTS against STR(prefix:)', 'FILTER (STRSTARTS(STR(?l), STR(ex:)))', [`${EX}a`, `${EX}b`]],
    ['REGEX', 'FILTER (regex(?l, "High"))', [`${EX}a`]],
    ['BOUND on a bound variable', 'FILTER (BOUND(?l))', [`${EX}a`, `${EX}b`]],
    ['plain comparison (always worked)', 'FILTER (?l = ex:High)', [`${EX}a`]],
  ])('%s', (_label, filter, expected) => {
    expect(ask(filter)).toEqual(expected);
  });

  it('REFUSES an expression it cannot evaluate, rather than dropping every row', () => {
    // ★ The half that matters most. A parser that answers "no rows" to a question it did not
    // understand is worse than one that errors: the caller gets a plausible answer.
    expect(() => executeSparqlString(s, `${P}SELECT ?s WHERE { ?s ex:lvl ?l . FILTER (WEIRDFN(?l, 3)) }`))
      .toThrow(/not supported by this engine/);
  });
});

describe('VALUES', () => {
  const P = `PREFIX ex: <${EX}>\n`;
  const s = store([
    [`${EX}a`, `${EX}lvl`, `${EX}High`],
    [`${EX}b`, `${EX}lvl`, `${EX}Low`],
  ]);

  it('RESTRICTS a variable the pattern already bound', () => {
    expect(values(s, `${P}SELECT ?s WHERE { ?s ex:lvl ?l VALUES ?l { ex:High } }`, '?s'))
      .toEqual([`${EX}a`]);
  });

  it('BINDS the extra columns of a tuple row', () => {
    // The form queryGraphsByTrustLevel depends on: a lookup table from IRI to score.
    expect(values(s, `${P}SELECT ?s ?score WHERE { ?s ex:lvl ?l VALUES (?l ?score) { (ex:High 3) } }`, '?score'))
      .toEqual(['3']);
  });
});

describe('the two exported generators, against data that has answers', () => {
  it('queryContextManifest finds the descriptor — it returned nothing for any store', () => {
    const s = store([
      ['urn:d1', TYPE, `${IEP}ContextDescriptor`],
      ['urn:d1', `${IEP}describes`, 'urn:g1'],
      ['urn:d1', `${IEP}hasFacet`, 'urn:f1'],
      ['urn:f1', TYPE, `${IEP}TemporalFacet`],
    ]);
    // Takes no argument: it is a manifest of every descriptor in the store.
    const rows = executeSparqlString(s, queryContextManifest()).bindings;
    expect(rows.length).toBe(1);
    expect(String(rows[0]!.get('?graph'))).toBe('urn:g1');
    expect(String(rows[0]!.get('?facetType'))).toBe(`${IEP}TemporalFacet`);
  });

  it('queryGraphsByTrustLevel filters AND orders by the score VALUES binds', () => {
    const s = createTripleStore();
    for (const [d, g, f, lvl] of [
      ['urn:d1', 'urn:g1', 'urn:t1', 'SelfAsserted'],
      ['urn:d2', 'urn:g2', 'urn:t2', 'CryptographicallyVerified'],
    ] as const) {
      const rows: readonly (readonly [string, string, string])[] = [
        [d, TYPE, `${IEP}ContextDescriptor`], [d, `${IEP}describes`, g], [d, `${IEP}hasFacet`, f],
        [f, TYPE, `${IEP}TrustFacet`], [f, `${IEP}trustLevel`, `${IEP}${lvl}`],
      ];
      for (const [subject, predicate, object] of rows) addTriple(s, { subject, predicate, object });
    }
    // Both graphs at or above the lowest level, highest score first.
    expect(values(s, queryGraphsByTrustLevel('SelfAsserted'), '?graph')).toEqual(['urn:g2', 'urn:g1']);
    // Only the verified one at the top level — the filter it always failed to apply.
    expect(values(s, queryGraphsByTrustLevel('CryptographicallyVerified'), '?graph')).toEqual(['urn:g2']);
  });
});
