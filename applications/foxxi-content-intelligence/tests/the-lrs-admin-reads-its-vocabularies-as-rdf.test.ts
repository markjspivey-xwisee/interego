/**
 * The LRS admin's conformance view reads the Foxxi vocabulary and the IEEE LER and ADL TLA
 * ontologies as RDF — by what they say, not by how one serializer lays them out.
 *
 * ★ WHY. `GET /xapi/admin/conformance` dereferences <bridge>/ns/foxxi for the Foxxi verb set, and
 * /ns/ieee-ler and /ns/adl-tla for the semantic layer. It read `doc.terms` out of the JSON-LD — a
 * key the documents stopped having when they became JSON-LD @graphs (so that expansion yields real
 * triples) — after which every read found zero verbs and zero terms while still reporting
 * `dereferenced: true`. It now asks for Turtle and reads the triples. Here the bridge's own routes
 * are stood in for by the documents themselves, and the view must find every declared verb and
 * every term each ontology defines.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import express from 'express';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { attachXapiAdminRoutes } from '../src/xapi-admin.js';
import { deriveUserWallet, mintSessionToken } from '../src/auth.js';
import { renderVocabTurtle, declaredVerbIris } from '../src/foxxi-vocab.js';
import { renderSemOntologyTurtle, LER_DOC, TLA_DOC } from '../src/ler-tla-vocab.js';
import { turtleQuads, RDFS } from './support/ns-graph.js';

const SEED = 'the-lrs-admin-reads-its-vocabularies-as-rdf';
const SELF = 'https://bridge.test';
const ADMIN = { userId: 'u-admin', webId: 'https://pod.test/u-admin/profile/card#me' };
const DOCS: Record<string, () => string> = {
  [`${SELF}/ns/foxxi`]: renderVocabTurtle,
  [`${SELF}/ns/ieee-ler`]: () => renderSemOntologyTurtle('ler'),
  [`${SELF}/ns/adl-tla`]: () => renderSemOntologyTurtle('tla'),
};

let server: Server;
let base = '';
const realFetch = globalThis.fetch;
const accepts: string[] = [];

beforeAll(async () => {
  // The bridge's /ns routes, stood in for: Turtle for the three documents, anything else goes out.
  vi.stubGlobal('fetch', async (input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    const doc = DOCS[url];
    if (!doc) return realFetch(input, init);
    accepts.push(new Headers(init?.headers).get('accept') ?? '');
    return new Response(doc(), { status: 200, headers: { 'Content-Type': 'text/turtle' } });
  });
  const app = express();
  attachXapiAdminRoutes(app, {
    adminWebId: ADMIN.webId, learningEngineerWebIds: new Set(), selfBaseUrl: SELF, basicAuthPairs: '', forwardingTargets: '',
    loadUsers: () => [{ user_id: ADMIN.userId, web_id: ADMIN.webId, wallet_address: deriveUserWallet(ADMIN.userId, SEED).address }],
  });
  server = app.listen(0, '127.0.0.1');
  await new Promise<void>((r) => server.once('listening', () => r()));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(() => {
  vi.unstubAllGlobals();
  server?.close();
});

describe('GET /xapi/admin/conformance', () => {
  it('finds every verb the Foxxi vocabulary declares, and every term the LER and TLA ontologies define', async () => {
    const token = await mintSessionToken({ ...ADMIN, seed: SEED });
    const r = await realFetch(`${base}/xapi/admin/conformance`, { headers: { Authorization: `Bearer ${token}` } });
    expect(r.status).toBe(200);
    const body = await r.json() as {
      vocabularyDereferenced: boolean; declaredVerbs: number;
      semanticLayer: { dereferenced: boolean; composedTermCount: number; ontologies: Array<{ id: string; url: string; termCount: number }> };
    };
    expect(accepts.every(a => a === 'text/turtle')).toBe(true);
    expect(body.vocabularyDereferenced).toBe(true);
    // The ADL core verbs plus the vocabulary's own: none of the vocabulary's is missed.
    const verbs = declaredVerbIris();
    expect(verbs.length).toBeGreaterThan(5);
    expect(body.declaredVerbs).toBeGreaterThanOrEqual(verbs.length);
    expect(body.declaredVerbs).toBe(new Set([...verbs, ...['launched', 'initialized', 'experienced', 'completed', 'passed', 'failed', 'satisfied', 'terminated', 'abandoned', 'waived', 'voided'].map(v => `http://adlnet.gov/expapi/verbs/${v}`)]).size);

    expect(body.semanticLayer.dereferenced).toBe(true);
    for (const [doc, fam] of [[LER_DOC, 'ler'], [TLA_DOC, 'tla']] as const) {
      const own = new Set(turtleQuads(renderSemOntologyTurtle(fam)).filter(t => t.predicate.value === `${RDFS}isDefinedBy` && t.object.value === doc).map(t => t.subject.value));
      const seen = body.semanticLayer.ontologies.find(o => o.id === doc);
      expect(seen, doc).toBeDefined();
      expect(seen!.termCount, doc).toBe(own.size);
      expect(own.size, doc).toBeGreaterThan(20);
    }
    expect(body.semanticLayer.composedTermCount).toBeGreaterThan(0);
  });
});
