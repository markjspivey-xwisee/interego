/**
 * RDF 1.2 annotations: we write them, and now we can read them back.
 *
 * ★ WHAT THIS FILE USED TO SAY. Under its old name — the-rdf12-write-path-has-no-read-path
 * — it recorded a gap: serializer.ts emitted RDF 1.2 annotation syntax (`s p o {| … |}`)
 * while turtle-parser.ts listed that syntax under "NOT supported (intentional)", so our own
 * output was not our own input and feeding it back threw `unexpected character '|'`. The
 * gap was recorded as an executable test rather than a comment precisely so that closing it
 * would fail loudly and force this rewrite. It did.
 *
 * The parser now implements RDF 1.2 [13]/[28]/[32]/[35]/[36] and desugars per §7.3, so the
 * assertions below are inverted from the ones this file shipped with. What did NOT change:
 * the file, its history, and the reason both halves matter.
 *
 * ★ THE ONE FORM STILL REFUSED, deliberately. `<< … >>` ([29] reifiedTriple) is rejected BY
 * NAME rather than approximated, because it differs from `{| … |}` in the way that matters
 * most: annotation syntax ASSERTS the triple it names and reifiedTriple does not. Accepting
 * it as if it did would add assertions the author explicitly declined to make. A parse error
 * that says so is the honest outcome until it is implemented.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import {
  toTripleAnnotationTurtle, parseTrig, validateAgainstShape, escapeTurtleLiteral,
} from '@interego/core';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..');
const RDF_REIFIES = 'http://www.w3.org/1999/02/22-rdf-syntax-ns#reifies';

const annotation = {
  triple: {
    subject: 'https://example.org/s' as never,
    predicate: 'https://example.org/p' as never,
    object: 'https://example.org/o' as never,
  },
  facets: [{ type: 'Temporal', validFrom: '2026-01-01T00:00:00Z' }],
} as never;

describe('the RDF 1.2 write path', () => {
  it('emits annotation syntax when the triple carries facets', () => {
    const ttl = toTripleAnnotationTurtle(annotation, { prefixes: false });
    expect(ttl).toContain('{|');
    expect(ttl).toContain('|}');
  });

  it('produces output our own parser ACCEPTS — the asymmetry is closed', () => {
    const ttl = toTripleAnnotationTurtle(annotation, { prefixes: true });
    expect(() => parseTrig(ttl)).not.toThrow();
  });

  it('and the annotation survives the round trip as a reifier, not as decoration', () => {
    // Reading it back without a throw would be satisfied by a parser that silently dropped
    // the block. The reifier triple is what proves the annotation actually arrived.
    const doc = parseTrig(toTripleAnnotationTurtle(annotation, { prefixes: true }));
    const reifiers = doc.subjects.filter(s => s.properties.has(RDF_REIFIES as never));
    expect(reifiers.length).toBe(1);
    const [tt] = reifiers[0]!.properties.get(RDF_REIFIES as never)!;
    expect(tt!.kind).toBe('triple');
  });

  it('…and the same triple without facets still round-trips, so it is the annotation', () => {
    const plain = toTripleAnnotationTurtle({ ...(annotation as object), facets: [] } as never,
      { prefixes: true });
    expect(plain).not.toContain('{|');
    expect(parseTrig(plain).subjects.length).toBe(1);
  });
});

describe('★ the ESCAPES the serializer writes are escapes the parser can read', () => {
  // ★ THIS FILE'S ORIGINAL SUBJECT, FOUND AGAIN IN A DIFFERENT PLACE. It was written because
  // serializer.ts emitted RDF 1.2 annotation syntax that turtle-parser.ts could not read.
  // That asymmetry was closed — and an older, quieter one had been sitting underneath it the
  // whole time, in the most ordinary thing either side does.
  //
  // escapeTurtleLiteral has always emitted the full Turtle escape set: BS-f for a form feed,
  // BS-b for a backspace, BS-u000B and BS-u0001 for the control characters that have no
  // short form. The parser implemented four escapes and passed the rest through as their
  // LETTER — so a form feed came back as the letter f, and BS-u0001 came back as the five
  // characters u0001.
  //
  // Unlike the annotation gap, this one did not throw. Our own output was accepted by our
  // own parser and quietly meant something else, which is worse: in the signing path the
  // canonical bytes stop being the author's bytes while every check stays green.
  const AWKWARD: ReadonlyArray<readonly [string, string]> = [
    ['line feed', String.fromCharCode(10)],
    ['carriage return', String.fromCharCode(13)],
    ['tab', String.fromCharCode(9)],
    ['form feed', String.fromCharCode(12)],
    ['backspace', String.fromCharCode(8)],
    ['line tabulation', String.fromCharCode(11)],
    ['a control character with no short escape', String.fromCharCode(1)],
    ['a backslash', String.fromCharCode(92)],
    ['a double quote', '"'],
    ['a supplementary-plane character', String.fromCodePoint(0x1F600)],
    ['non-ASCII text', 'café — naïve'],
  ];

  it.each(AWKWARD)('round-trips %s', (_label, ch) => {
    const value = `before${ch}after`;
    const ttl = `@prefix ex: <https://example.org/> .
ex:s ex:p "${escapeTurtleLiteral(value)}" .`;
    const doc = parseTrig(ttl);
    const [term] = [...doc.subjects[0]!.properties.values()][0]!;
    expect(term!.kind).toBe('literal');
    expect((term as { value: string }).value).toBe(value);
  });

  it('and the escaping is REAL — the Turtle is not just the raw character', () => {
    // Guards the guard. If escapeTurtleLiteral regressed to returning the string unchanged,
    // every case above would still round-trip through a lenient parser while producing
    // Turtle no other parser would accept. A raw line feed inside a short string is a
    // syntax error, so its presence in the output is the thing to refuse.
    const out = escapeTurtleLiteral(`a${String.fromCharCode(10)}b`);
    expect(out).not.toContain(String.fromCharCode(10));
    expect(out).toContain(`${String.fromCharCode(92)}n`);
  });
});

describe('reifiedTriple is IMPLEMENTED, and still does not assert', () => {
  // ★ These two used to assert that `<< >>` was REFUSED BY NAME, and that was the right
  // behaviour for exactly as long as it lasted: refusing is honest where approximating is
  // not, because this form does not assert the triple it names and treating it like
  // `{| |}` would invent assertions the author explicitly declined to make. It is
  // implemented now, so what these assert is the property that motivated the refusal.
  const ttl = '@prefix ex: <https://example.org/> .\nex:bob ex:said << ex:alice ex:age 23 >> .\n';
  const REIFIES = 'http://www.w3.org/1999/02/22-rdf-syntax-ns#reifies';

  it('parses', () => {
    expect(() => parseTrig(ttl)).not.toThrow();
  });

  it('does NOT assert the triple it names', () => {
    const asserted = parseTrig(ttl).subjects.some(s =>
      s.subject === 'https://example.org/alice'
      && [...s.properties.keys()].some(k => k === 'https://example.org/age'));
    expect(asserted).toBe(false);
  });

  it('and yields the reifier, linked by rdf:reifies', () => {
    expect(parseTrig(ttl).subjects.some(s => s.properties.has(REIFIES as never))).toBe(true);
  });
});

describe('the published SHACL 1.2 shapes', () => {
  const shapes = readFileSync(join(REPO, 'docs/ns/iep-shapes-1.2.ttl'), 'utf8');

  it('every shape in the 1.2 file is built on sh:reifierShape', () => {
    // Count the PREDICATE, not the word: the file's own comments name sh:reifierShape three
    // more times, and matching those made this read 6-of-3 on its first run.
    const shapeCount = [...shapes.matchAll(/^\S+\s+a\s+sh:NodeShape\s*;/gm)].length;
    const reifierCount = [...shapes.matchAll(/sh:reifierShape\s*\[/g)].length;
    expect(shapeCount).toBeGreaterThan(0);
    expect(reifierCount).toBe(shapeCount);
  });

  const P = `@prefix iep: <https://markjspivey-xwisee.github.io/interego/ns/iep#> .
@prefix ex: <https://example.org/> .
`;

  it('ENFORCE now — both halves landed, and this test used to assert the opposite', () => {
    // ★ Two separate things had to be true, and for one commit only the first was: the
    // parser had to read `{| … |}`, AND the engine had to implement sh:reifierShape. This
    // assertion is the second half, and it was `fullyChecked === false` until it was.
    const report = validateAgainstShape(P + 'ex:d iep:modalStatus iep:Asserted .', shapes, {});
    expect(report.results.some(r => /reifierShape/i.test(r.message ?? ''))).toBe(false);
    expect(report.fullyChecked).toBe(true);
  });

  it('and enforcement means REFUSING something, not merely reporting checked', () => {
    // Guards the guard. `fullyChecked: true` is also what a shape that constrains nothing
    // reports, so the flag alone cannot distinguish "enforced" from "vacuous". An actual
    // rejection can: epistemicConfidence is constrained to [0, 1] by the published shape.
    const bad = P + 'ex:d iep:modalStatus iep:Asserted {| iep:epistemicConfidence 1.7 |} .';
    expect(validateAgainstShape(bad, shapes, {}).conforms).toBe(false);

    const good = P + 'ex:d iep:modalStatus iep:Asserted {| iep:epistemicConfidence 0.9 |} .';
    expect(validateAgainstShape(good, shapes, {}).conforms).toBe(true);
  });

  it('are WELL-FORMED — sh:reifierShape sits on a property shape with an IRI sh:path', () => {
    // The reason they enforced nothing was not only the missing engine: all three hung
    // sh:reifierShape off a node shape with no sh:path anywhere in the file, and SHACL 1.2
    // §7.8.5 evaluates over (focus node, $path, value node). Pinned here because SHACL has
    // no well-formedness rule that would catch a regression.
    const reifierCount = [...shapes.matchAll(/sh:reifierShape\s*\[/g)].length;
    const pathBeforeReifier = [...shapes.matchAll(/sh:path\s+\S+\s*;\s*\n\s*sh:reifierShape/g)].length;
    expect(pathBeforeReifier).toBe(reifierCount);
  });
});
