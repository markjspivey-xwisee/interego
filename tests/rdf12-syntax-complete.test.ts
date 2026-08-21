/**
 * RDF 1.2 reification syntax, complete, against the spec's own worked examples.
 *
 * Every assertion here traces to a numbered example or a normative sentence in the RDF 1.2
 * Turtle Working Draft of 12 August 2026. The example numbers are cited so a future reader
 * can check the transcription rather than trust it — and so a spec change is findable.
 *
 * ★ THE ONE DISTINCTION EVERYTHING ELSE HANGS ON. Annotation syntax `{| … |}` ASSERTS the
 * triple it names; reified-triple syntax `<< … >>` does NOT. §2.11 on Example 25: "this
 * graph does not assert that employee38 has a jobTitle of 'Assistant Designer'". Conflating
 * them does not merely lose information — it INVENTS assertions the author explicitly
 * declined to make, which is why `<< >>` was refused outright rather than approximated for
 * the commit between the two halves of this work.
 */
import { describe, it, expect } from 'vitest';
import { parseTrig } from '@interego/core';

const P = `@prefix : <https://example.org/> .
@prefix rdf: <http://www.w3.org/1999/02/22-rdf-syntax-ns#> .
@prefix xsd: <http://www.w3.org/2001/XMLSchema#> .
`;
const REIFIES = 'http://www.w3.org/1999/02/22-rdf-syntax-ns#reifies';

/** Every (subject, predicate, object-shape) triple the parser produced. */
function triples(ttl: string): { s: string; p: string; o: string }[] {
  const out: { s: string; p: string; o: string }[] = [];
  for (const subj of parseTrig(P + ttl).subjects) {
    const s = typeof subj.subject === 'string' ? subj.subject : `_:${subj.subject.bnode}`;
    for (const [p, terms] of subj.properties) {
      for (const t of terms) {
        const o = t.kind === 'iri' ? t.iri
          : t.kind === 'bnode' ? `_:${t.id}`
            : t.kind === 'triple' ? '<<TRIPLE-TERM>>'
              : t.value;
        out.push({ s, p: p as string, o });
      }
    }
  }
  return out;
}
const asserts = (ttl: string, s: string, p: string, o: string): boolean =>
  triples(ttl).some(t => t.s === s && t.p === p && t.o === o);

describe('annotation syntax {| … |} — RDF 1.2 Turtle [35][36]', () => {
  it('Example 29 -> 30: exactly three triples, and the base triple IS asserted', () => {
    const ttl = ':alice :name "Alice" {| :statedBy :bob |} .';
    expect(triples(ttl)).toHaveLength(3);
    expect(asserts(ttl, 'https://example.org/alice', 'https://example.org/name', 'Alice')).toBe(true);
  });

  it('the connector is rdf:reifies, pointing at a triple term', () => {
    const ts = triples(':alice :name "Alice" {| :statedBy :bob |} .');
    const reifies = ts.filter(t => t.p === REIFIES);
    expect(reifies).toHaveLength(1);
    expect(reifies[0]!.o).toBe('<<TRIPLE-TERM>>');
  });

  it('Example 28: `~ :t` names the reifier, giving four triples', () => {
    const ttl = ':alice :name "Alice" ~ :t {| :statedBy :bob ; :recorded "2021-07-07"^^xsd:date |} .';
    expect(triples(ttl)).toHaveLength(4);
    expect(asserts(ttl, 'https://example.org/t', REIFIES, '<<TRIPLE-TERM>>')).toBe(true);
  });

  it('[35] is a Kleene star: two blocks mean two DISTINCT reifiers', () => {
    // Merging them would fuse two separate claims about one statement into one claim.
    const ts = triples(':s :p :o {| :a "1" |} {| :b "2" |} .');
    const reifiers = new Set(ts.filter(t => t.p === REIFIES).map(t => t.s));
    expect(reifiers.size).toBe(2);
  });

  it('an annotation follows EVERY object in a comma list, per [13] objectList', () => {
    const ts = triples(':s :p :o1 {| :a "1" |}, :o2 {| :b "2" |} .');
    expect(new Set(ts.filter(t => t.p === REIFIES).map(t => t.s)).size).toBe(2);
  });

  it('a bare `~` still yields the rdf:reifies triple with a fresh blank node', () => {
    const ts = triples(':s :p :o ~ .');
    expect(ts.filter(t => t.p === REIFIES)).toHaveLength(1);
    expect(ts).toHaveLength(2);
  });
});

describe('reified triples << … >> — RDF 1.2 Turtle [29]', () => {
  it('does NOT assert the base triple — the whole difference from {| |}', () => {
    const ttl = ':bob :said << :alice :age 23 >> .';
    expect(asserts(ttl, 'https://example.org/alice', 'https://example.org/age', '23')).toBe(false);
  });

  it('evaluates to the reifier, so the outer triple points at it', () => {
    const ts = triples(':bob :said << :alice :age 23 >> .');
    const said = ts.find(t => t.p === 'https://example.org/said');
    expect(said?.o.startsWith('_:')).toBe(true);
    expect(ts.some(t => t.s === said!.o && t.p === REIFIES)).toBe(true);
  });

  it('`~:r` names that reifier', () => {
    const ttl = ':bob :said << :alice :age 23 ~:r >> .';
    expect(asserts(ttl, 'https://example.org/bob', 'https://example.org/said', 'https://example.org/r'))
      .toBe(true);
    expect(asserts(ttl, 'https://example.org/r', REIFIES, '<<TRIPLE-TERM>>')).toBe(true);
  });

  it('and STILL does not assert, even when the reifier is named', () => {
    expect(asserts(':bob :said << :alice :age 23 ~:r >> .',
      'https://example.org/alice', 'https://example.org/age', '23')).toBe(false);
  });
});

describe('triple terms <<( … )>> — RDF 1.2 Turtle [32]', () => {
  it('are a term, and assert nothing on their own', () => {
    const ts = triples(':r rdf:reifies <<( :s :p :o )>> .');
    expect(ts).toHaveLength(1);
    expect(ts[0]!.o).toBe('<<TRIPLE-TERM>>');
  });

  it('refuse a literal subject, per [33] ttSubject', () => {
    expect(() => parseTrig(`${P}:r rdf:reifies <<( "lit" :p :o )>> .`)).toThrow(/triple term subject/i);
  });
});

describe('@version "1.2"', () => {
  it('is accepted', () => {
    expect(() => parseTrig(`@version "1.2" .\n${P}:s :p :o .`)).not.toThrow();
  });

  it('is NOT required for 1.2 syntax — §7.1 makes it a hint, not a mode switch', () => {
    // Refusing 1.2 syntax in a document that omits the directive would reject conformant
    // input; a document is 1.2 because of the syntax it uses, not because it says so.
    expect(() => parseTrig(`${P}:s :p :o {| :c 1 |} .`)).not.toThrow();
  });
});

describe('none of this changed ordinary Turtle', () => {
  it.each([
    ['a plain triple', ':s :p :o .'],
    ['a collection', ':s :list ( :a :b ) .'],
    ['a blank-node property list', ':s :p [ :q "x" ] .'],
    ['a typed literal', ':s :p "5"^^xsd:integer .'],
    ['a language-tagged literal', ':s :p "x"@en .'],
  ])('%s still parses', (_label, ttl) => {
    expect(() => parseTrig(P + ttl)).not.toThrow();
  });
});
