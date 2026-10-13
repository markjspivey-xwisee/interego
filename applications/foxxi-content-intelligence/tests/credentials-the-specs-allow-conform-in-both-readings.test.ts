/**
 * An Open Badges 3.0 or CLR 2.0 credential gets the same verdict from the Foxxi validator, reading
 * its JSON, as from a SHACL processor, reading its RDF — and that verdict is the specification's.
 *
 * ★ WHY. A review found the published OB 3.0 and CLR 2.0 shapes rejected credentials the specs allow
 * and passed ones they forbid. They required credentialSubject.id, where OB 3.0 allows an identifier
 * instead, and a typed proof, which a credential secured by an enveloping proof (VC-JOSE-COSE, VC-JWT)
 * does not carry; they checked neither the subject's type, nor the credential's id, nor the second
 * @context, nor a CLR's issuer, validFrom or name; and one check was vacuous — an Achievement's
 * rdf:type, on a shape that only nodes typed Achievement reach. The shapes now say what 1EdTech's
 * data model tables say (OB 3.0 and CLR 2.0, Appendix B), one shape per class, and the validator
 * follows a document into its nested nodes as a SHACL processor does.
 *
 * And Foxxi's own credentials did not meet them. Its badges carried their evidence on the subject,
 * where OB 3.0's context gives `evidence` no meaning, so a verifier reading one as JSON-LD dropped the
 * evidence — and in safe mode refused the badge; their achievements could lack the description OB 3.0
 * requires; and its CLRs had no name, lacked the OB 3.0 context CLR 2.0 requires third, and carried
 * Foxxi's own fields under terms no context defined. They are fixtures here too, rebuilt from the code.
 *
 * ★ HOW. Each fixture in tests/support/credentials is a credential and its RDF reading: the N-Quads a
 * verifier gets through the W3C VC 2.0 contexts and 1EdTech's OB 3.0.3 and CLR 2.0.1 contexts in
 * JSON-LD safe mode, or what safe mode said when it refused the document. They are made by
 * tools/read-credential-fixtures.ts, because 1EdTech's contexts are 1EdTech's to distribute and are
 * not copied here. The SHACL processor is the substrate's (@interego/core), on the reading's default
 * graph — an embedded proof is a graph of its own. A requirement on the JSON document itself — the
 * order of its @context — has no RDF reading, and on it the two readings differ, as the shapes say.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { Parser, Writer, type Quad } from 'n3';
import { validateAgainstShape as shacl } from '@interego/core';
import { renderShacl, shapesIri, type OntologyModel } from '../src/spec-ontology.js';
import { OB3_MODEL, CLR_MODEL } from '../src/spec/ler.model.js';
import { validateInstanceWith } from '../src/spec/index.js';
import { turtleQuads } from './support/ns-graph.js';
import { foxxiCourseCompletion, foxxiClr } from './support/credentials/foxxi-fixtures.js';

const DIR = new URL('./support/credentials/', import.meta.url);
const SH = 'http://www.w3.org/ns/shacl#';

interface Expect {
  model: OntologyModel;
  /** The specification's verdict. */
  conforms: boolean;
  /** The shapes the violations are reported by, in both readings. */
  faults?: string[];
  /** A requirement on the JSON document only: the RDF reading cannot see it. */
  jsonOnly?: string;
  /** Safe mode refuses to read the document: no RDF reading, and this is why. */
  refused?: string;
}
const ob3 = (conforms: boolean, rest: Partial<Expect> = {}): Expect => ({ model: OB3_MODEL, conforms, ...rest });
const clr = (conforms: boolean, rest: Partial<Expect> = {}): Expect => ({ model: CLR_MODEL, conforms, ...rest });
const FIXTURES: Record<string, Expect> = {
  'ob3-embedded-proof': ob3(true),
  'ob3-enveloped': ob3(true),
  'ob3-identifier-only': ob3(true),
  'foxxi-course-completion': ob3(true),
  'ob3-no-id': ob3(false, { faults: ['OpenBadgeCredentialShape'] }),
  'ob3-no-issuer': ob3(false, { faults: ['OpenBadgeCredentialShape'] }),
  'ob3-local-time': ob3(false, { faults: ['OpenBadgeCredentialShape'] }),
  'ob3-anonymous-subject': ob3(false, { faults: ['AchievementSubjectShape'] }),
  'ob3-undescribed-achievement': ob3(false, { faults: ['AchievementShape'] }),
  'ob3-no-criteria': ob3(false, { faults: ['AchievementShape'] }),
  'ob3-unhashed-identity': ob3(false, { faults: ['IdentityObjectShape'] }),
  'ob3-untyped-subject': ob3(false, { refused: 'invalid property' }),
  'ob3-untyped-achievement': ob3(false, { refused: 'invalid property' }),
  'ob3-contexts-swapped': ob3(false, { jsonOnly: '@context' }),
  'clr-valid': clr(true),
  'clr-identifier-only': clr(true),
  'foxxi-clr': clr(true),
  'clr-unnamed': clr(false, { faults: ['ClrCredentialShape'] }),
  'clr-no-validfrom': clr(false, { faults: ['ClrCredentialShape'] }),
  'clr-no-credentials': clr(false, { faults: ['ClrSubjectShape'] }),
  'clr-without-ob-context': clr(false, { refused: 'relative @type reference' }),
};

const json = (name: string): Record<string, unknown> => JSON.parse(readFileSync(new URL(`${name}.json`, DIR), 'utf8'));
const has = (name: string, ext: string): boolean => existsSync(new URL(`${name}${ext}`, DIR));
/** The reading's default graph, as N-Triples. */
function defaultGraph(name: string): string {
  const quads = new Parser({ format: 'application/n-quads' }).parse(readFileSync(new URL(`${name}.nq`, DIR), 'utf8'));
  const w = new Writer({ format: 'N-Triples' });
  w.addQuads(quads.filter((q: Quad) => q.graph.termType === 'DefaultGraph'));
  let out = '';
  w.end((err, s) => { if (err) throw err; out = s; });
  return out;
}

/** The node shape a result is about: the shape it cites, or the node shape holding the property shape it cites. */
function ownerOf(model: OntologyModel): (source: string | undefined) => string {
  const q = turtleQuads(renderShacl(model));
  return source => {
    if (!source) return '?';
    const owner = q.find(t => t.predicate.value === `${SH}property` && t.object.value === source)?.subject.value ?? source;
    return owner.slice(owner.indexOf('#') + 1);
  };
}
const violations = (r: { results: ReadonlyArray<{ severity: string; sourceShape?: string }> }): string[] =>
  [...new Set(r.results.filter(x => x.severity === 'Violation').map(x => x.sourceShape ?? '?'))].sort();

describe('the credential fixtures', () => {
  it('are all listed here, and each has its RDF reading or the reason it has none', () => {
    const names = readdirSync(DIR).filter(f => f.endsWith('.json') && !f.endsWith('.refused.json')).map(f => f.slice(0, -5)).sort();
    expect(names).toEqual(Object.keys(FIXTURES).sort());
    for (const [name, e] of Object.entries(FIXTURES)) {
      expect(has(name, '.nq'), name).toBe(!e.refused);
      expect(has(name, '.refused.json'), name).toBe(!!e.refused);
    }
  });

  it('include Foxxi\'s own credentials, exactly as its code builds them now', async () => {
    expect(await foxxiCourseCompletion()).toEqual(json('foxxi-course-completion'));
    expect(await foxxiClr()).toEqual(json('foxxi-clr'));
  });
});

for (const [name, e] of Object.entries(FIXTURES)) {
  describe(`${name} (${e.model.module})`, () => {
    const doc = json(name);
    const fromJson = validateInstanceWith(e.model, doc);

    it(`the Foxxi validator ${e.conforms ? 'accepts' : 'rejects'} it`, () => {
      expect(fromJson.conforms, JSON.stringify(fromJson.results, null, 1)).toBe(e.conforms);
      if (e.jsonOnly) expect([...new Set(fromJson.results.map(r => r.path))]).toEqual([e.jsonOnly]);
      if (e.faults) expect([...new Set(violations(fromJson).map(ownerOf(e.model)))].sort()).toEqual(e.faults);
    });

    if (e.refused) {
      it('has no RDF reading: a verifier in JSON-LD safe mode refuses it', () => {
        const why = JSON.parse(readFileSync(new URL(`${name}.refused.json`, DIR), 'utf8')) as { code: string };
        expect(why.code).toBe(e.refused);
      });
      return;
    }

    it(e.jsonOnly
      ? `its RDF reading conforms: ${e.jsonOnly} is a requirement on the JSON document, which the reading cannot see`
      : `a SHACL processor ${e.conforms ? 'accepts' : 'rejects'} its RDF reading, for the same shape`, () => {
      const shapes = renderShacl(e.model);
      const report = shacl(defaultGraph(name), shapes);
      expect(report.fullyChecked).toBe(true);
      expect(report.conforms, JSON.stringify(report.results, null, 1)).toBe(e.jsonOnly ? true : e.conforms);
      if (e.faults) {
        expect([...new Set(violations(report).map(ownerOf(e.model)))].sort()).toEqual(e.faults);
        // …and down to the constraint: both readings cite the same published shapes.
        expect(violations(report)).toEqual(violations(fromJson));
      }
      // The shapes the report cites are the published ones.
      for (const r of report.results) expect(r.sourceShape?.startsWith(`${shapesIri(e.model)}#`), r.sourceShape).toBe(true);
    });

    if (e.model === CLR_MODEL && e.conforms) {
      it('and the Open Badges 3.0 shapes accept the credentials it bundles, in the same reading', () => {
        const report = shacl(defaultGraph(name), renderShacl(OB3_MODEL));
        expect(report.conforms, JSON.stringify(report.results, null, 1)).toBe(true);
        expect(defaultGraph(name)).toContain('https://purl.imsglobal.org/spec/vc/ob/vocab.html#OpenBadgeCredential');
      });
    }
  });
}
