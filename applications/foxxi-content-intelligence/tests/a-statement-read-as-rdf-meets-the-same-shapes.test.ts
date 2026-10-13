/**
 * An xAPI statement, read into RDF through the context the xAPI ontology publishes (/ns/xapi/context),
 * gets the same verdict from a SHACL processor running the published shapes as the statement gets from
 * the Foxxi validator reading its JSON.
 *
 * ★ WHY. A review showed the shapes checked nothing: no context read a statement into the ontology's
 * terms, `objectType` was a literal property, a statement and most of its parts are never typed in
 * xAPI, and the shapes were written for typed nodes only — so an invalid statement, read as RDF,
 * conformed. Meanwhile the documents said the LRS validated every statement against the shapes. Now
 * the context reads a statement into the ontology (objectType as rdf:type; each `id` as what it is),
 * the shapes select what that reading produces — by class where xAPI types a node, by the property
 * that reaches it where it does not — and this test holds the two readings to one verdict.
 *
 * ★ WHAT EACH READING IS. The JSON verdict is validateXapiStatement — the shapes run on the JSON, and
 * the LRS's own statement validator. The RDF verdict is the substrate's SHACL processor
 * (@interego/core) on the statement's reading in JSON-LD safe mode. A statement safe mode refuses has
 * no reading — an unknown property, a verb whose id is not an IRI — and both readings reject it.
 * Some rules have no RDF statement at all (no property beyond those xAPI defines; a Group as a
 * statement's authority is an OAuth pair): those the LRS validator checks alone, and they are listed
 * here as what they are.
 */
import { describe, it, expect } from 'vitest';
import jsonld from 'jsonld';
import { validateAgainstShape as shacl } from '@interego/core';
import { renderShacl, ns, shapesIri } from '../src/spec-ontology.js';
import { XAPI_MODEL } from '../src/spec/xapi.model.js';
import { validateXapiStatement } from '../src/spec/index.js';
import { XAPI_CONTEXT_URL, xapiJsonLdContext } from '../src/spec/xapi-context.js';
import { utcTimestamp } from '../src/xapi-validate.js';
import { turtleQuads, RDF_TYPE } from './support/ns-graph.js';
import { base, RICH, STATEMENT_CASES as CASES } from './support/xapi-statement-cases.js';

const X = ns(XAPI_MODEL);
const SHAPES = renderShacl(XAPI_MODEL);
type Json = Record<string, unknown>;

const documentLoader = async (url: string) => {
  if (url !== XAPI_CONTEXT_URL) throw new Error(`the test fetches nothing: ${url}`);
  return { contextUrl: undefined, documentUrl: url, document: xapiJsonLdContext() };
};
/** The statement's RDF reading as N-Quads, or why safe mode refused it. */
async function reading(stmt: Json): Promise<{ nq: string } | { refused: string }> {
  try {
    const nq = await jsonld.toRDF({ '@context': XAPI_CONTEXT_URL, ...stmt } as jsonld.JsonLdDocument,
      { format: 'application/n-quads', documentLoader, safe: true } as unknown as jsonld.Options.ToRdf) as unknown as string;
    return { nq };
  } catch (e) {
    const code = (e as { details?: { event?: { code?: string } } }).details?.event?.code;
    if (!code) throw e;
    return { refused: code };
  }
}

describe('the context a statement is read through', () => {
  it('is published beside the ontology, and every term it reads a statement into is the ontology\'s', async () => {
    // ★ REVISED: the context of the ontology's own version, which never changes (ns/releases.ts),
    // where this read the unversioned /context — which answers with whichever version is current.
    expect(XAPI_CONTEXT_URL).toBe(`${X.slice(0, -1)}/context/${XAPI_MODEL.version}`);
    const ontology = turtleQuads((await import('../src/spec-ontology.js')).renderOwl(XAPI_MODEL));
    const declared = new Set(ontology.filter(t => t.predicate.value === RDF_TYPE).map(t => t.subject.value));
    const r = await reading(RICH);
    expect('nq' in r).toBe(true);
    const used = new Set<string>();
    for (const line of (r as { nq: string }).nq.trim().split('\n')) {
      const [, p, o] = /^\S+ <([^>]+)> (<([^>]+)>)?/.exec(line)! as unknown as [string, string, string, string];
      if (p.startsWith(X)) used.add(p);
      const typed = /^\S+ <http:\/\/www\.w3\.org\/1999\/02\/22-rdf-syntax-ns#type> <([^>]+)>/.exec(line)?.[1];
      if (typed?.startsWith(X)) used.add(typed);
      void o;
    }
    expect(used.size).toBeGreaterThan(40);
    expect([...used].filter(t => !declared.has(t))).toEqual([]);
  });
});

for (const [name, c] of Object.entries(CASES)) {
  describe(name, () => {
    const fromJson = validateXapiStatement(c.stmt);
    it(`the Foxxi validator ${c.conforms && !c.refused ? 'accepts' : c.refused && c.conforms ? 'accepts' : 'rejects'} it`, () => {
      expect(fromJson.conforms, JSON.stringify(fromJson.results, null, 1)).toBe(c.conforms);
    });
    it(c.refused ? `has no RDF reading: safe mode refuses it (${c.refused})`
      : c.jsonOnly ? `its RDF reading conforms: ${c.jsonOnly} has no RDF statement`
        : `a SHACL processor ${c.conforms ? 'accepts' : 'rejects'} its RDF reading`, async () => {
      const r = await reading(c.stmt);
      if (c.refused) { expect(r).toEqual({ refused: c.refused }); return; }
      expect('nq' in r, JSON.stringify(r)).toBe(true);
      const report = shacl((r as { nq: string }).nq, SHAPES);
      expect(report.fullyChecked).toBe(true);
      expect(report.conforms, JSON.stringify(report.results, null, 1)).toBe(c.jsonOnly ? true : c.conforms);
      for (const x of report.results) expect(x.sourceShape?.startsWith(`${shapesIri(XAPI_MODEL)}#`), x.sourceShape).toBe(true);
      if (c.fault) {
        const { json, rdf } = typeof c.fault === 'string' ? { json: c.fault, rdf: c.fault } : c.fault;
        const shapes = turtleQuads(SHAPES);
        const owner = (src: string): string => (shapes.find(t => t.predicate.value === 'http://www.w3.org/ns/shacl#property' && t.object.value === src)?.subject.value ?? src).split('#')[1]!;
        expect(report.results.map(x => owner(x.sourceShape!))).toContain(rdf);
        expect(fromJson.results.map(x => owner(x.sourceShape))).toContain(json);
      }
    });
  });
}

describe('the LRS stores a statement\'s time as the shapes require', () => {
  it('converts a timestamp to UTC rather than rejecting it (xAPI 2.0, LRS part: Timestamps)', () => {
    expect(utcTimestamp('2026-10-01T08:00:00.000-04:00')).toBe('2026-10-01T12:00:00.000Z');
    expect(utcTimestamp('2008-09-15 15:53:00.601+00:00')).toBe('2008-09-15T15:53:00.601Z');
    expect(utcTimestamp('2023-05-04T12:00-05:00')).toBe('2023-05-04T17:00:00.000Z');
    expect(utcTimestamp('2026-10-01T12:00:00Z')).toBe('2026-10-01T12:00:00Z');
  });
  it('and the converted statement reads as one the shapes accept', async () => {
    const stmt = base({ timestamp: utcTimestamp('2023-05-04T12:00-05:00') });
    const r = await reading(stmt) as { nq: string };
    expect(shacl(r.nq, SHAPES).conforms).toBe(true);
    expect(validateXapiStatement(stmt).conforms).toBe(true);
  });
});
