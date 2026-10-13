/**
 * An instance of SCORM CAM, SN or RTE, cmi5, the AI e-learning profile, SOC 2, the EU AI Act or the
 * NIST AI RMF gets one verdict from the Foxxi validator, reading its JSON, and from a SHACL processor,
 * reading its RDF through the context the document publishes — and that verdict is the shapes'.
 *
 * ★ WHY. A review counted 62 node shapes across these eight shapes graphs that selected nothing in any
 * published reading: the validator checked the JSON (POST /ns/<module>/validate), but nothing read an
 * instance into RDF, and the shapes selected nodes by class while JSON leaves most nodes untyped. So a
 * SHACL processor given the shapes had nothing to check, and every instance passed it. Each document
 * now publishes the JSON-LD context its instances are read through (/ns/<module>/context, generated
 * from its model by src/ns/model-context.ts), and its shapes select what RDFS's domain and range rules
 * make an instance of their class — a node by a property it has, or by the property that reaches it —
 * as the validator selects the same nodes of the JSON by their keys.
 *
 * ★ WHAT IS HELD. For each case (tests/support/both-readings-cases.ts): the validator's verdict, and the
 * verdict of the substrate's SHACL processor (@interego/core) on the reading, are the case's — the
 * same property shapes, at the same severities. A case safe mode refuses has no reading; the validator
 * rejects it for what the shapes see. And every node shape of each graph with a target selects a node
 * of some instance's reading, so none is left that checks nothing; a node shape with no target is one
 * another shape refers to (sh:node).
 *
 * ★ WHERE THE READINGS STILL PART, and the last describe below holds each:
 *  - An instance whose root neither declares its type nor has a property that implies one is checked
 *    by the validator against the document's first shape, so that leaving the type out never passes
 *    an instance unchecked; its reading has nothing a shape selects.
 *  - A key the document does not define has no reading (safe mode refuses the instance), and the
 *    validator, which checks what the shapes ask, ignores it.
 *  - Where the context coerces a key's values to a datatype — a date, a time, a URI, the integer type
 *    the shapes ask for — the reading takes the value's lexical form and not its JSON type: a
 *    position written "1" reads as the position 1, and an href written 42 as the URI "42". The
 *    validator, reading the JSON, holds the value to the JSON type the standard's JSON uses.
 */
import { describe, it, expect } from 'vitest';
import jsonld from 'jsonld';
import { Parser } from 'n3';
import { validateAgainstShape as shacl } from '@interego/core';
import { renderShacl, shapesIri, type OntologyModel } from '../src/spec-ontology.js';
import { SPEC_MODELS, validateInstance, validateInstanceWith } from '../src/spec/index.js';
import { COMPLIANCE_MODELS } from '../src/spec/compliance.model.js';
import { modelContextUrl, modelJsonLdContext } from '../src/ns/model-context.js';
import { XAPI_CONTEXT_URL, xapiJsonLdContext } from '../src/spec/xapi-context.js';
import { READING_CASES } from './support/both-readings-cases.js';

const SH = 'http://www.w3.org/ns/shacl#';
const RDF_TYPE = 'http://www.w3.org/1999/02/22-rdf-syntax-ns#type';
const MODELS: Record<string, OntologyModel> = { ...SPEC_MODELS, ...COMPLIANCE_MODELS };
type Json = Record<string, unknown>;
/** A SCORM manifest with everything its shapes require. */
const MANIFEST_OK: Json = {
  '@type': 'Manifest', identifier: 'm', metadata: { schema: 'ADL SCORM', schemaversion: 'CAM 1.3' },
  organizations: { organization: [{ identifier: 'o', title: 'O', item: [{ identifier: 'i', title: 'I' }] }] },
};
type Results = ReadonlyArray<{ severity?: string; sourceShape?: string }>;

/** The property shapes a report names, by severity, as local names. */
const verdict = (results: Results) => {
  const of = (severity: string): string[] => [...new Set(results.filter(r => r.severity === severity).map(r => String(r.sourceShape).split('#')[1]!))].sort();
  return { violates: of('Violation'), warns: of('Warning') };
};
const jsonVerdict = (module: string, instance: Json) =>
  verdict((module in SPEC_MODELS ? validateInstance(module, instance)! : validateInstanceWith(MODELS[module]!, instance)).results);

/** The instance's RDF reading through the document's published context, in safe mode, or the reason
 *  safe mode refused it. The contexts are the ones the bridge publishes; nothing is fetched. */
async function reading(m: OntologyModel, instance: Json): Promise<{ nq: string } | { refused: string }> {
  const documentLoader = async (url: string) => {
    const document = url === modelContextUrl(m) ? modelJsonLdContext(m) : url === XAPI_CONTEXT_URL ? xapiJsonLdContext() : undefined;
    if (!document) throw new Error(`the test fetches nothing: ${url}`);
    return { contextUrl: undefined, documentUrl: url, document };
  };
  try {
    const nq = await jsonld.toRDF({ '@context': modelContextUrl(m), ...instance } as jsonld.JsonLdDocument,
      { format: 'application/n-quads', documentLoader, safe: true } as unknown as jsonld.Options.ToRdf) as unknown as string;
    return { nq };
  } catch (e) {
    const code = (e as { details?: { event?: { code?: string } } }).details?.event?.code;
    if (!code) throw e;
    return { refused: code };
  }
}

/** The node shapes of a shapes graph that select a node of the data: by class, by a property it has,
 *  or by the property that reaches it (SHACL §2.1.3). */
function selecting(shapes: string, data: string): Set<string> {
  const sg = new Parser({ format: 'text/turtle' }).parse(shapes);
  const dg = new Parser({ format: 'application/n-quads' }).parse(data);
  const targets = (s: string, p: string): string[] => sg.filter(q => q.subject.value === s && q.predicate.value === SH + p).map(q => q.object.value);
  const types = new Set(dg.filter(q => q.predicate.value === RDF_TYPE).map(q => q.object.value));
  const predicates = new Set(dg.map(q => q.predicate.value));
  return new Set(sg.filter(q => q.predicate.value === RDF_TYPE && q.object.value === `${SH}NodeShape`).map(q => q.subject.value)
    .filter(s => targets(s, 'targetClass').some(c => types.has(c))
      || [...targets(s, 'targetSubjectsOf'), ...targets(s, 'targetObjectsOf')].some(p => predicates.has(p))));
}

for (const [module, cases] of Object.entries(READING_CASES)) {
  const m = MODELS[module]!;
  const SHAPES = renderShacl(m);

  describe(`${module}: the validator and a SHACL processor give each instance the shapes' verdict`, () => {
    for (const c of cases) {
      it(c.name, async () => {
        const want = { violates: [...(c.violates ?? [])].sort(), warns: [...(c.warns ?? [])].sort() };
        expect(jsonVerdict(module, c.instance), 'the validator, reading the JSON').toEqual(want);
        const r = await reading(m, c.instance);
        if (c.refused) { expect(r).toEqual({ refused: c.refused }); return; }
        expect('nq' in r, JSON.stringify(r)).toBe(true);
        const report = shacl((r as { nq: string }).nq, SHAPES);
        expect(report.fullyChecked).toBe(true);
        for (const x of report.results) expect(x.sourceShape?.startsWith(`${shapesIri(m)}#`), x.sourceShape).toBe(true);
        expect(verdict(report.results), 'a SHACL processor, reading the RDF').toEqual(want);
      });
    }
  });

  it(`${module}: every node shape selects a node of some instance's reading, or is one another refers to`, async () => {
    const selected = new Set<string>();
    for (const c of cases) {
      const r = await reading(m, c.instance);
      if ('nq' in r) for (const s of selecting(SHAPES, r.nq)) selected.add(s);
    }
    const sg = new Parser({ format: 'text/turtle' }).parse(SHAPES);
    const all = sg.filter(q => q.predicate.value === RDF_TYPE && q.object.value === `${SH}NodeShape`).map(q => q.subject.value);
    const targeted = all.filter(s => sg.some(q => q.subject.value === s && [`${SH}targetClass`, `${SH}targetSubjectsOf`, `${SH}targetObjectsOf`].includes(q.predicate.value)));
    const referred = new Set(sg.filter(q => q.predicate.value === `${SH}node`).map(q => q.object.value));
    expect(targeted.length).toBeGreaterThan(0);
    expect(targeted.filter(s => !selected.has(s)).map(s => s.split('#')[1])).toEqual([]);
    expect(all.filter(s => !targeted.includes(s) && !referred.has(s)).map(s => s.split('#')[1])).toEqual([]);
  });
}

describe('the eight documents together', () => {
  it('have 78 node shapes, and the cases cover every document whose context is generated', () => {
    const generated = Object.values(MODELS).filter(m => m.generatedContext).map(m => m.module).sort();
    expect(Object.keys(READING_CASES).sort()).toEqual(generated);
    const count = generated.reduce((n, module) => n + new Parser({ format: 'text/turtle' }).parse(renderShacl(MODELS[module]!))
      .filter(q => q.predicate.value === RDF_TYPE && q.object.value === `${SH}NodeShape`).length, 0);
    // 62 when the review counted them; since, cmi5's entitlement key and learner shapes, the EU AI
    // Act's and the NIST AI RMF's shapes for a record that cites one of their concepts, and a code
    // shape for each kind of obligation (eight) and each function (four).
    expect(count).toBe(78);
  });
});

describe('where the two readings part, as the header says', () => {
  const verdicts = async (module: string, instance: Json) => {
    const m = MODELS[module]!;
    const r = await reading(m, instance);
    return { json: jsonVerdict(module, instance), rdf: 'nq' in r ? verdict(shacl(r.nq, renderShacl(m)).results) : r };
  };
  it('a root that says nothing of what it is: the validator checks it against the first shape; nothing selects its reading', async () => {
    // Its one key is a property of several kinds of node (rdfs:domain a union), so neither its type
    // nor RDFS makes it a manifest, an organization, an item or a resource. (In SCORM RTE every
    // property has one domain, so every key there says what its node is.)
    const cam = await verdicts('scorm-cam', { identifier: 'com.example.refunds' });
    expect(cam.json.violates).toEqual(['ManifestShape-metadata', 'ManifestShape-metadata-schema', 'ManifestShape-metadata-schemaversion', 'ManifestShape-organizations', 'ManifestShape-resources']);
    expect(cam.rdf).toEqual({ violates: [], warns: [] });
    const cmi5 = await verdicts('cmi5', { title: [{ lang: 'en', text: 'Refunds' }] });
    expect(cmi5.json.violates).toEqual(['CourseStructureShape-course', 'CourseStructureShape-structure']);
    expect(cmi5.rdf).toEqual({ violates: [], warns: [] });
  });
  it('a key the document does not define: safe mode refuses the reading; the validator ignores the key', async () => {
    const { json, rdf } = await verdicts('soc2', { type: 'DeployEvent', evidences: 'CC8.1', occurredAt: '2026-10-01T12:00:00Z', actingAgent: 'did:web:ci.example.org', signer: '0x1', mood: 'calm' });
    expect(json).toEqual({ violates: [], warns: [] });
    expect(rdf).toEqual({ refused: 'invalid property' });
  });
  it('a coerced value: the reading takes its lexical form; the validator holds it to its JSON type', async () => {
    const position = await verdicts('cmi5', { type: 'Block', id: 'https://example.org/b', title: [{ lang: 'en', text: 'B' }], description: [{ lang: 'en', text: 'B' }], position: '1' });
    expect(position.json.violates).toEqual(['BlockShape-position']);
    expect(position.rdf).toEqual({ violates: [], warns: [] });
    const href = await verdicts('scorm-cam', { ...MANIFEST_OK, resources: { resource: [{ identifier: 'r', type: 'webcontent', scormType: 'asset', href: 42 }] } });
    expect(href.json.violates).toEqual(['ResourceShape-href']);
    expect(href.rdf).toEqual({ violates: [], warns: [] });
  });
});
