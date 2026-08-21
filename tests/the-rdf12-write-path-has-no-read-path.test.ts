/**
 * RDF 1.2 annotations: we can write them, we cannot read them back.
 *
 * ★ THE ASYMMETRY. serializer.ts emits RDF 1.2 annotation syntax — `s p o {| … |}` — via
 * toTripleAnnotationTurtle. turtle-parser.ts lists that syntax under "NOT supported
 * (intentional)". Both statements are true at once, which means our own output is not our
 * own input.
 *
 * This is recorded as a test rather than only a comment because the sibling claim on that
 * same header ("Lists ( ... )" NOT supported) had already gone stale — collections were
 * implemented and the note was never updated. A prose note about a gap decays silently; an
 * executable one fails the day somebody closes the gap and tells them to update it.
 *
 * ★ WHY IT IS NOT AN EMERGENCY, stated so nobody upgrades or downgrades it by guessing:
 *   - the read side THROWS rather than silently dropping the annotation, so nothing
 *     validates as `conforms` while quietly ignoring annotated content;
 *   - no production code calls toTripleAnnotationTurtle today — only tests.
 *
 * ★ WHAT IT COSTS. docs/ns/iep-shapes-1.2.ttl is our SHACL 1.2 shape set, and all three of
 * its shapes are built on sh:reifierShape, which constrains exactly these annotations. With
 * no read path there is nothing for those shapes to validate, so they are published,
 * dereferenceable, named for real invariants — and enforce nothing. The engine reports that
 * rather than hiding it, which the last test here pins.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { toTripleAnnotationTurtle, parseTrig, validateAgainstShape } from '@interego/core';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..');

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

  it('produces output our own parser REJECTS — and rejects it loudly', () => {
    const ttl = toTripleAnnotationTurtle(annotation, { prefixes: true });
    expect(() => parseTrig(ttl)).toThrow(/unexpected character/i);
  });

  it('…while the same triple without facets round-trips fine, so it is the annotation', () => {
    const plain = toTripleAnnotationTurtle({ ...(annotation as object), facets: [] } as never,
      { prefixes: true });
    expect(plain).not.toContain('{|');
    expect(parseTrig(plain).subjects.length).toBe(1);
  });
});

describe('and so the published SHACL 1.2 shapes enforce nothing', () => {
  const shapes = readFileSync(join(REPO, 'docs/ns/iep-shapes-1.2.ttl'), 'utf8');

  it('every shape in the 1.2 file is built on sh:reifierShape', () => {
    // Count the PREDICATE, not the word: the file's own comments name sh:reifierShape three
    // more times, and matching those made this read 6-of-3 on its first run.
    const shapeCount = [...shapes.matchAll(/^\S+\s+a\s+sh:NodeShape\s*;/gm)].length;
    const reifierCount = [...shapes.matchAll(/sh:reifierShape\s*\[/g)].length;
    expect(shapeCount).toBeGreaterThan(0);
    expect(reifierCount).toBe(shapeCount);
  });

  // ★ The data has to actually TRIGGER the shape. `fullyChecked` is lowered only when an
  // unimplemented construct sits on a shape that selected a focus node in THIS graph — a
  // graph that merely cites a big shapes file must not be reported as under-checked. So
  // validating an unrelated `ex:s ex:p ex:o` against this file correctly reports
  // fullyChecked:true, and an earlier draft of this test asserted false against exactly
  // that irrelevant graph. iep:SemioticAnnotationShape-1.2 is sh:targetSubjectsOf
  // iep:modalStatus, so state one and the shape fires.
  const triggering = `@prefix iep: <https://markjspivey-xwisee.github.io/interego/ns/iep#> .
@prefix ex: <https://example.org/> .
ex:d iep:modalStatus iep:Asserted .
`;

  it('a graph that TRIGGERS them is reported as not fully checked', () => {
    const report = validateAgainstShape(triggering, shapes, {});
    expect(report.results.some(r => /reifierShape/i.test(r.message ?? ''))).toBe(true);
    expect(report.fullyChecked).toBe(false);
  });

  it('so `conforms` alone is not the safe predicate here — `conforms && fullyChecked` is', () => {
    const report = validateAgainstShape(triggering, shapes, {});
    expect(report.conforms).toBe(true);
    expect(report.conforms && report.fullyChecked).toBe(false);
  });
});
