/**
 * A shape IRI is defined once, by one file, whatever endpoint serves it.
 *
 * ★★ WHAT THIS WAS WRITTEN AFTER. `iep:ContextDescriptorShape`, `iep:TemporalFacetShape`,
 * `iep:TrustFacetShape` and `iep:SemioticFacetShape` were each defined TWICE under the same IRI —
 * once in `packages/core/src/validation/shacl-shapes.ts`, served live by the relay at
 * `/.well-known/shacl-shapes`, and again in `packages/core/src/rdf/system-ontology.ts`, served
 * live by pgsl-browser at `/ontology/shacl`.
 *
 * Measured before the fix: 4 of 4 shared shapes disagreed, and always in the same direction —
 *
 *   iep:describes           the second copy added sh:maxCount 1
 *   iep:validFrom           the second copy added sh:minCount 1  (made it REQUIRED)
 *   iep:trustLevel          the second copy added sh:minCount 1  (made it REQUIRED)
 *   iep:modalStatus         the second copy added sh:minCount 1  (made it REQUIRED)
 *   iep:epistemicConfidence xsd:decimal there, xsd:double here
 *
 * Two published shapes graphs disagreeing about one IRI is not a difference of opinion. A client
 * that merges them gets whichever it parsed last, and a descriptor valid against one endpoint is
 * invalid against the other — with nothing anywhere saying which is authoritative.
 *
 * The disagreement is only the symptom. The defect is that one IRI had two definitions, and this
 * test pins the cure: `systemShaclShapes()` composes the normative graph rather than restating any
 * of it, so a future edit can make a shape stricter but cannot make it stricter in one place only.
 */

import { describe, it, expect } from 'vitest';
import { Parser } from 'n3';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { getShaclShapesTurtle, systemShaclShapes } from '@interego/core';

const RDF_TYPE = 'http://www.w3.org/1999/02/22-rdf-syntax-ns#type';
const SH_NODESHAPE = 'http://www.w3.org/ns/shacl#NodeShape';

const src = (rel: string): string =>
  readFileSync(fileURLToPath(new URL(`../packages/core/src/${rel}`, import.meta.url)), 'utf8');

/** Shape IRIs textually DEFINED in a Turtle-in-TS source (`iep:XShape a sh:NodeShape ;`). */
function definedIn(text: string): Set<string> {
  return new Set([...text.matchAll(/(iep:[A-Za-z0-9_]+Shape)\s+a\s+sh:NodeShape\s*;/g)].map(m => m[1] ?? ''));
}

/** Subjects typed sh:NodeShape in a parsed document. */
function nodeShapes(turtle: string): string[] {
  return new Parser().parse(turtle)
    .filter(q => q.predicate.value === RDF_TYPE && q.object.value === SH_NODESHAPE)
    .map(q => q.subject.value);
}

describe('no shape IRI is defined by two sources', () => {
  it('the two Turtle-in-TS sources define disjoint sets of shapes', () => {
    const normative = definedIn(src('validation/shacl-shapes.ts'));
    const projection = definedIn(src('rdf/system-ontology.ts'));

    // Guard the guard: a parse that finds nothing would make the overlap trivially empty.
    expect(normative.size, 'parsed no shapes from shacl-shapes.ts').toBeGreaterThan(10);
    expect(projection.size, 'parsed no shapes from system-ontology.ts').toBeGreaterThan(0);

    const overlap = [...projection].filter(s => normative.has(s));
    expect(
      overlap,
      `these shape IRIs are defined in BOTH packages/core/src/validation/shacl-shapes.ts and `
        + `packages/core/src/rdf/system-ontology.ts, and are served live from two different `
        + `endpoints. Define each once and compose: ${overlap.join(', ')}`,
    ).toEqual([]);
  });

  it('the system projection composes the normative graph rather than restating it', () => {
    const composed = nodeShapes(systemShaclShapes());
    const normative = nodeShapes(getShaclShapesTurtle());
    expect(normative.length).toBeGreaterThan(10);
    // Every normative shape reaches the projection's consumers.
    for (const s of normative) expect(composed, `${s} missing from systemShaclShapes()`).toContain(s);
  });

  it('defines every shape exactly once in the composed document', () => {
    const all = nodeShapes(systemShaclShapes());
    const seen = new Map<string, number>();
    for (const s of all) seen.set(s, (seen.get(s) ?? 0) + 1);
    const dupes = [...seen.entries()].filter(([, n]) => n > 1).map(([s]) => s);
    expect(dupes, `defined more than once: ${dupes.join(', ')}`).toEqual([]);
  });

  it('keeps the shapes only the projection defines', () => {
    // Deleting the duplicates must not have taken these with them.
    const composed = nodeShapes(systemShaclShapes()).join(' ');
    for (const s of ['CoherenceCertificateShape', 'ParadigmConstraintShape', 'PersistenceRecordShape']) {
      expect(composed, `${s} was dropped`).toContain(s);
    }
  });
});
