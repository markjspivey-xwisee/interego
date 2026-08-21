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
import { toTripleAnnotationTurtle, parseTrig, validateAgainstShape } from '@interego/core';

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

describe('reifiedTriple is refused by name, not by accident', () => {
  it('names itself in the error instead of "unexpected character"', () => {
    // A generic tokeniser error would send the next reader hunting for a typo. This one
    // has to explain that the construct is real, understood, and declined.
    expect(() => parseTrig('@prefix ex: <https://example.org/> .\nex:s ex:p << ex:a ex:b ex:c >> .\n'))
      .toThrow(/reifiedTriple/i);
  });

  it('and explains WHY, because the reason is the whole distinction', () => {
    expect(() => parseTrig('@prefix ex: <https://example.org/> .\nex:s ex:p << ex:a ex:b ex:c >> .\n'))
      .toThrow(/does NOT assert/i);
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
