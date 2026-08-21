/**
 * The W3C RDF 1.2 Turtle test suite runs in CI, and it is at 106 of 106.
 *
 * ★ WHY THE PARSER NEEDED ITS OWN ORACLE. A parser decides what every test in this repo is
 * ALLOWED TO SAY. If it silently mis-reads a construct, every assertion written on top of it
 * agrees — not because the behaviour is right but because both sides share the same wrong
 * reading. Nothing inside our own tests can see that, which is exactly the position the
 * SHACL engine was in before its suite was vendored.
 *
 * It was measured only by accident: chasing a SHACL result led to `sh:singleLine` not
 * catching a form feed, which turned out to be the parser, which turned out to be this:
 *
 *   ★ `\\uXXXX` WAS NOT DECODED AT ALL. `"\\u0041"` parsed to the five characters `u0041`
 *     rather than to `A`. `\\f` became the letter f, `\\b` became the letter b.
 *
 * That is not a missing feature. It is text CHANGED rather than rejected, in a repo whose
 * whole premise is that a published graph can be re-verified byte for byte by a stranger —
 * and UCHAR is precisely how a conservatively-written Turtle document carries any non-ASCII
 * character. Then the suite found the rest:
 *
 *   - RELATIVE IRIs WERE NEVER RESOLVED. `@base` was consumed and dropped, on the stated
 *     reasoning that "this parser does not resolve relative IRIs, so the base has nothing to
 *     act on". But `<s>` did not stay unresolved — it became the absolute IRI `s`. Every
 *     relative reference in every based document named a different resource than written,
 *     and two documents with different bases collided on the same key.
 *   - `1e0` was typed xsd:decimal. Turtle gives an exponent xsd:double, and a different
 *     datatype is a different RDF term — so `sh:datatype xsd:double` refused every double
 *     this parser produced.
 *   - A reified triple could not be a SUBJECT, which is the natural way to say something
 *     about a statement and the reason the syntax exists.
 *   - `VERSION "1.2"`, the SPARQL-style spelling, was `unknown bareword`.
 *   - A lone surrogate escape was accepted, producing a string that is not valid UTF-8.
 *   - `@en--LTR` and `@en--unk` were accepted as base directions.
 *   - A collection or a blank-node property list was accepted INSIDE a reified triple,
 *     asserting extra triples from within a construct whose purpose is to mention a
 *     statement without asserting it.
 *
 * Every one of those is silent. None produces an error, a warning, or a wrong-looking value
 * at the call site — they produce a different graph.
 */
import { describe, it, expect } from 'vitest';
import { execFileSync } from 'node:child_process';
import { readdirSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { parseTrig } from '@interego/core';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..');
const RUNNER = join(REPO, 'tools', 'rdf12-w3c', 'run.mjs');
const SUITE = join(REPO, 'tests', 'fixtures', 'rdf12-w3c');

interface Report {
  total: number;
  pass: number;
  fail: number;
  missing: number;
  skipped: number;
  positive: number;
  negative: number;
  evaluated: number;
  failing: string[];
}

const report: Report = JSON.parse(
  execFileSync(process.execPath, [RUNNER, '--json'], { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 }));

function countFiles(dir: string): number {
  let n = 0;
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) n += countFiles(p);
    else n += 1;
  }
  return n;
}

describe('W3C RDF 1.2 Turtle conformance', () => {
  it('the vendored suite is there, and all three kinds of entry are in it', () => {
    // ★ Guards the guard, three ways. A count alone would be satisfied by 106 positive
    // tests; the NEGATIVE ones are what stop a permissive parser passing by accepting
    // everything, and the EVAL ones are what stop it passing by rejecting nothing while
    // producing the wrong triples. Losing any one category silently would leave a green
    // gate over a different, weaker question.
    expect(countFiles(SUITE)).toBeGreaterThanOrEqual(140);
    expect(report.positive, 'no positive-syntax entries ran').toBeGreaterThanOrEqual(40);
    expect(report.negative, 'no negative-syntax entries ran').toBeGreaterThanOrEqual(30);
    expect(report.evaluated, 'no eval entries ran').toBeGreaterThanOrEqual(30);
    expect(report.missing, 'a fixture the manifest names is not vendored').toBe(0);
    expect(report.skipped, 'an entry type this runner does not handle').toBe(0);
  });

  it('passes every entry', () => {
    // ★ No floor and no known-divergence list, deliberately. The SHACL suite has both
    // because two of its entries are genuinely disputed or out of scope; this one is at
    // 106 of 106, and the honest gate for that is "all of them". The moment a real
    // divergence appears it should be argued for in a comment, not absorbed into a number.
    expect(report.failing, 'RDF 1.2 Turtle entries failing:\n  ' + report.failing.join('\n  '))
      .toEqual([]);
    expect(report.pass).toBe(report.total);
  });
});

describe('the three silent corruptions, pinned directly', () => {
  // The suite above covers these, and it covers them among 106 other things. These assert
  // them by name, so a regression says WHAT broke rather than "entry 47 now fails".
  const P = '@prefix ex: <https://example.org/> .\n';
  const BS = String.fromCharCode(92);

  it('decodes numeric escapes rather than passing the letters through', () => {
    const doc = parseTrig(`${P}ex:s ex:p "${BS}u0041${BS}U0001F600${BS}f${BS}b" .`);
    const [t] = [...doc.subjects[0]!.properties.values()][0]!;
    expect(t!.kind).toBe('literal');
    const v = (t as { value: string }).value;
    expect(v.startsWith('A'), `got ${JSON.stringify(v)}`).toBe(true);
    expect(v).toContain(String.fromCodePoint(0x1F600));
    expect(v).toContain(String.fromCharCode(0x0C));
    expect(v).toContain(String.fromCharCode(0x08));
  });

  it('refuses a surrogate escape instead of producing an unpaired one', () => {
    expect(() => parseTrig(`${P}ex:s ex:p "${BS}uD83C" .`)).toThrow(/surrogate/i);
  });

  it('resolves a relative IRI against @base, and does not normalise it', () => {
    // ★ The second half is as load-bearing as the first. `new URL(ref, base)` would resolve
    // correctly AND lower-case the host and drop the default port — changing the IRI string
    // while leaving the resource the same. Fine for fetching, fatal for a canonical digest.
    const doc = parseTrig('@base <http://EXAMPLE.org:80/a/b> .\n<c> <http://x/p> <../d> .');
    const s = doc.subjects.find(x => typeof x.subject === 'string');
    expect(s?.subject).toBe('http://EXAMPLE.org:80/a/c');
    const [t] = [...s!.properties.values()][0]!;
    expect((t as { iri: string }).iri).toBe('http://EXAMPLE.org:80/d');
  });

  it('types an exponent as xsd:double, not xsd:decimal', () => {
    const doc = parseTrig(`${P}ex:s ex:p 1e0 , 1.0 , 1 .`);
    const dts = [...doc.subjects[0]!.properties.values()][0]!
      .map(t => (t as { datatype?: string }).datatype?.replace(/^.*#/, ''));
    expect(dts).toEqual(['double', 'decimal', 'integer']);
  });
});
