/**
 * The Profile Server as a client of the specification meets it (xAPI Profiles, Part Three):
 * /sparql, /validate_templates and /validate_patterns with POST variables, 204 on success and 400
 * with comments on failure; profiles added by an agent, held under that agent, and read back after
 * a restart from the records that were kept.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import express from 'express';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { ProfileServer, ProfileServerError, mountProfileServerReads, whyNotAddable, type ProfileRecord } from '../src/xapi-profile-server/service.js';
import { xapiProfileServerAffordances } from '../src/xapi-profile-server/affordances.js';
import type { Json } from '../src/xapi-profile-server/rdf.js';

const P = 'https://example.org/profiles/tidepool';
const OWN = 'https://example.org/profiles/own';
const profile = (version: 1 | 2, id = P): Json => ({
  id, type: 'Profile', prefLabel: { en: 'Tidepool survey' }, definition: { en: 'A made-up profile about counting crabs.' },
  versions: version === 1 ? [{ id: `${id}/v1`, generatedAtTime: '2026-01-01T00:00:00Z' }]
    : [{ id: `${id}/v2`, generatedAtTime: '2026-05-01T00:00:00Z', wasRevisionOf: [`${id}/v1`] }, { id: `${id}/v1`, generatedAtTime: '2026-01-01T00:00:00Z' }],
  concepts: [{ id: `${id}/verbs/counted`, type: 'Verb', inScheme: `${id}/v${version}`, prefLabel: { en: 'counted' }, definition: { en: 'Counted.' } },
    { id: `${id}/verbs/arrived`, type: 'Verb', inScheme: `${id}/v${version}`, prefLabel: { en: 'arrived' }, definition: { en: 'Arrived.' } }],
  templates: [
    { id: `${id}/templates/arrival`, type: 'StatementTemplate', inScheme: `${id}/v${version}`, prefLabel: { en: 'arrival' }, definition: { en: 'Arriving.' }, verb: `${id}/verbs/arrived` },
    { id: `${id}/templates/count`, type: 'StatementTemplate', inScheme: `${id}/v${version}`, prefLabel: { en: 'count' }, definition: { en: 'One count.' }, verb: `${id}/verbs/counted`,
      rules: [{ location: '$.result.score.raw', presence: 'included' }, ...(version === 2 ? [{ location: '$.result.extensions', presence: 'excluded' } as Json] : [])] },
  ],
  patterns: [{ id: `${id}/patterns/survey`, type: 'Pattern', primary: true, inScheme: `${id}/v${version}`, prefLabel: { en: 'survey' }, definition: { en: 'Arrive, then count.' },
    sequence: [`${id}/templates/arrival`, `${id}/patterns/counts`] },
  { id: `${id}/patterns/counts`, type: 'Pattern', inScheme: `${id}/v${version}`, oneOrMore: `${id}/templates/count` }],
});
const statement = (verb: string, t: string, more: Json = {}): Json => ({ actor: { mbox: 'mailto:fictional-surveyor@example.org' }, verb: { id: `${P}/verbs/${verb}` }, object: { id: `${P}/pools/north` }, timestamp: t, ...(more as object) });
const counted = (t: string, raw?: number) => statement('counted', t, raw === undefined ? {} : { result: { score: { raw } } });

const kept: ProfileRecord[] = [];
const make = () => new ProfileServer({
  builtIn: () => [profile(1, OWN)],
  persist: async record => { kept.push(JSON.parse(JSON.stringify(record)) as ProfileRecord); return { persisted: true, holonUri: 'urn:test:holon' }; },
  hydrate: async () => kept,
  isOperator: did => did === 'did:example:operator',
});

let server: ProfileServer, http: Server, base: string;
const post = (path: string, body: unknown, type = 'application/json') => fetch(`${base}${path}`, { method: 'POST', headers: { 'Content-Type': type }, body: typeof body === 'string' ? body : JSON.stringify(body) });
const form = (fields: Record<string, string>) => new URLSearchParams(fields).toString();

beforeAll(async () => {
  server = make();
  const app = express();
  app.use(express.json({ limit: '2mb' }));
  mountProfileServerReads(app, server, {
    base: 'https://bridge.example/xapi/profiles',
    urlencoded: express.urlencoded({ extended: false, limit: '2mb' }),
    text: express.text({ type: ['application/sparql-query'], limit: '64kb' }),
    addTarget: 'https://bridge.example/agent/xapi-profiles/add', removeTarget: 'https://bridge.example/agent/xapi-profiles/remove',
  });
  http = app.listen(0, '127.0.0.1');
  await new Promise<void>(resolve => http.once('listening', () => resolve()));
  base = `http://127.0.0.1:${(http.address() as AddressInfo).port}/xapi/profiles`;
  await server.add(profile(1), 'did:example:alice');
  await server.add(profile(2), 'did:example:alice');
});
afterAll(async () => { await new Promise(resolve => http.close(resolve)); });

describe('adding and holding profiles', () => {
  it('holds a profile under the agent that first added it', async () => {
    await expect(server.add(profile(2), 'did:example:mallory')).rejects.toMatchObject({ status: 409 });
    await expect(server.add(profile(1, OWN), 'did:example:alice')).rejects.toMatchObject({ status: 409 });
    await expect(server.remove(P, 'did:example:mallory')).rejects.toMatchObject({ status: 403 });
    await expect(server.remove(OWN, 'did:example:operator')).rejects.toMatchObject({ status: 409 });
    await expect(server.remove('https://example.org/none', 'did:example:alice')).rejects.toBeInstanceOf(ProfileServerError);
  });
  it('does not let a version held under one profile be replaced through another', async () => {
    const thief = (version: string): Json => ({ ...(profile(1, 'https://example.org/profiles/thief') as object), versions: [{ id: version, generatedAtTime: '2027-01-01T00:00:00Z' }] });
    await expect(server.add(thief(`${P}/v2`), 'did:example:mallory')).rejects.toMatchObject({ status: 409 });
    await expect(server.add(thief(`${OWN}/v1`), 'did:example:mallory')).rejects.toMatchObject({ status: 409 });
    expect(server.dataset.get(`${P}/v2`)!.id).toBe(P);
    expect(server.dataset.get(`${OWN}/v1`)!.id).toBe(OWN);
  });
  it('says why a document is not a profile', () => {
    expect(whyNotAddable([])).toMatch(/JSON object/);
    expect(whyNotAddable({ id: 'urn:x', type: 'Profile', versions: [{ id: 'https://e.org/v1' }] })).toMatch(/http\(s\) IRI/);
    expect(whyNotAddable({ id: P, versions: [{ id: `${P}/v1` }] })).toMatch(/"type": "Profile"/);
    expect(whyNotAddable({ id: P, type: 'Profile' })).toMatch(/versions/);
    expect(whyNotAddable({ id: P, type: 'Profile', versions: [{ id: P }] })).toMatch(/different/);
    expect(whyNotAddable({ id: P, type: 'Profile', versions: [{ id: `${P}/v1` }], templates: [{ verb: 'x' }] })).toMatch(/templates/);
    expect(whyNotAddable({ id: P, type: 'Profile', versions: [{ id: `${P}/v1` }], concepts: [{ id: `${P}/c`, pad: 'x'.repeat(600_000) }] })).toMatch(/bytes/);
    expect(whyNotAddable(profile(2))).toBeUndefined();
  });
  it('reads everything back after a restart, removals included', async () => {
    const other = 'https://example.org/profiles/gone';
    await server.add(profile(1, other), 'did:example:bob');
    await server.remove(other, 'did:example:operator');
    const again = make();
    await again.ready();
    expect(again.dataset.get(P)?.version).toBe(`${P}/v2`);
    expect(again.dataset.get(`${P}/v1`)?.version).toBe(`${P}/v1`);
    expect(again.dataset.get(other)).toBeUndefined();
    expect(again.owner(P)).toBe('did:example:alice');
    // The lock survives the restart too.
    await expect(again.add(profile(2), 'did:example:mallory')).rejects.toMatchObject({ status: 409 });
  });
});

describe('over HTTP', () => {
  it('lists what is held and where each part answers', async () => {
    const index = await (await fetch(base)).json() as { sparql: string; profiles: Array<{ id: string; version: string; current: boolean; builtIn: boolean; addedBy?: string; document: string }> };
    expect(index.sparql).toBe('https://bridge.example/xapi/profiles/sparql');
    expect(index.profiles.filter(p => p.id === P).map(p => [p.version, p.current])).toEqual([[`${P}/v1`, false], [`${P}/v2`, true]]);
    expect(index.profiles.find(p => p.id === OWN)).toMatchObject({ builtIn: true });
    expect(index.profiles.find(p => p.id === P)!.addedBy).toBe('did:example:alice');
  });

  it('gives back the exact document, by profile or by version', async () => {
    const byVersion = await fetch(`${base}/profile?iri=${encodeURIComponent(`${P}/v1`)}`);
    expect(byVersion.headers.get('content-type')).toMatch(/application\/ld\+json/);
    expect(await byVersion.json()).toEqual(profile(1));
    expect(await (await fetch(`${base}/profile?iri=${encodeURIComponent(P)}`)).json()).toEqual(profile(2));
    expect((await fetch(`${base}/profile?iri=${encodeURIComponent('https://example.org/none')}`)).status).toBe(404);
  });

  it('answers /sparql by GET, by form, by a query body and by JSON', async () => {
    const q = `PREFIX profile: <https://w3id.org/xapi/profiles/ontology#> PREFIX skos: <http://www.w3.org/2004/02/skos/core#> select ?t where { ?t a profile:StatementTemplate . ?t skos:inScheme <${P}> }`;
    const expectTemplates = async (r: Response) => {
      expect(r.status).toBe(200);
      expect(r.headers.get('content-type')).toMatch(/application\/sparql-results\+json/);
      const body = await r.json() as { head: { vars: string[] }; results: { bindings: Array<{ t: { type: string; value: string } }> } };
      expect(body.head.vars).toEqual(['t']);
      expect(body.results.bindings.map(b => b.t.value).sort()).toEqual([`${P}/templates/arrival`, `${P}/templates/count`]);
      expect(body.results.bindings[0]!.t.type).toBe('uri');
    };
    await expectTemplates(await fetch(`${base}/sparql?query=${encodeURIComponent(q)}`));
    await expectTemplates(await post('/sparql', form({ query: q }), 'application/x-www-form-urlencoded'));
    await expectTemplates(await post('/sparql', q, 'application/sparql-query'));
    await expectTemplates(await post('/sparql', { query: q }));
    // The protocol's default-graph-uri picks a version.
    const rules = `PREFIX profile: <https://w3id.org/xapi/profiles/ontology#> SELECT ?l WHERE { <${P}/templates/count> profile:rules ?r . ?r profile:location ?l }`;
    const count = async (extra: string) => ((await (await fetch(`${base}/sparql?query=${encodeURIComponent(rules)}${extra}`)).json()) as { results: { bindings: unknown[] } }).results.bindings.length;
    expect(await count('')).toBe(2);
    expect(await count(`&default-graph-uri=${encodeURIComponent(`${P}/v1`)}`)).toBe(1);
    const refused = await fetch(`${base}/sparql?query=${encodeURIComponent('CONSTRUCT { ?s ?p ?o } WHERE { ?s ?p ?o }')}`);
    expect(refused.status).toBe(400);
    expect((await refused.json() as { error: string }).error).toMatch(/CONSTRUCT/);
    expect((await fetch(`${base}/sparql`)).status).toBe(400);
  });

  it('answers /validate_templates with 204, or 400 and why', async () => {
    const good = counted('2026-03-01T10:00:00Z', 4);
    const asForm = await post('/validate_templates', form({ statement: JSON.stringify(good), profile: P }), 'application/x-www-form-urlencoded');
    expect(asForm.status).toBe(204);
    expect(await asForm.text()).toBe('');
    expect((await post('/validate_templates', { statement: good, profile: P })).status).toBe(204);

    const bad = await post('/validate_templates', form({ statement: JSON.stringify(counted('2026-03-01T10:00:00Z')), profile: P }), 'application/x-www-form-urlencoded');
    expect(bad.status).toBe(400);
    const why = await bad.json() as { comments: string[] };
    expect(why.comments[0]).toContain(`${P}/templates/count`);
    expect(why.comments[0]).toContain('$.result.score.raw');

    // The version named decides the rules: v2 forbids result extensions, v1 does not.
    const extended = { ...(good as object), result: { score: { raw: 4 }, extensions: { 'https://example.org/x': 1 } } };
    expect((await post('/validate_templates', { statement: extended, profile: `${P}/v1` })).status).toBe(204);
    expect((await post('/validate_templates', { statement: extended, profile: P })).status).toBe(400);

    const stranger = await post('/validate_templates', { statement: statement('swam', '2026-03-01T10:00:00Z'), profile: P });
    expect(stranger.status).toBe(400);
    expect((await stranger.json() as { comments: string[] }).comments[0]).toMatch(/matches no statement template/);
    const unknown = await post('/validate_templates', { statement: good, profile: 'https://example.org/none' });
    expect(unknown.status).toBe(400);
    expect((await unknown.json() as { comments: string[] }).comments[0]).toMatch(/No profile with id/);
    expect((await post('/validate_templates', form({ statement: '{not json', profile: P }), 'application/x-www-form-urlencoded')).status).toBe(400);
    expect((await post('/validate_templates', { statement: [good], profile: P })).status).toBe(400);
  });

  it('answers /validate_patterns with 204, or 400 and which part', async () => {
    const run = [counted('2026-03-01T10:02:00Z', 2), statement('arrived', '2026-03-01T10:00:00Z'), counted('2026-03-01T10:01:00Z', 7)];
    expect((await post('/validate_patterns', form({ statements: JSON.stringify(run), profile: P }), 'application/x-www-form-urlencoded')).status).toBe(204);
    expect((await post('/validate_patterns', { statements: run, profile: P })).status).toBe(204);
    const noArrival = await post('/validate_patterns', { statements: run.filter((_, i) => i !== 1), profile: P });
    expect(noArrival.status).toBe(400);
    expect((await noArrival.json() as { comments: string[] }).comments.length).toBeGreaterThan(0);
    const unfinished = await post('/validate_patterns', { statements: [run[1]], profile: P });
    expect((await unfinished.json() as { comments: string[] }).comments[0]).toMatch(/end before the pattern does/);
    expect((await post('/validate_patterns', { statements: run[0], profile: P })).status).toBe(400);
    expect((await post('/validate_patterns', { statements: Array.from({ length: 501 }, () => run[0]), profile: P })).status).toBe(413);
  });
});

describe('the affordances', () => {
  it('name the paths the routes are at', () => {
    const targets = xapiProfileServerAffordances.map(a => a.targetTemplate);
    expect(targets).toEqual(['{base}/agent/xapi-profiles/add', '{base}/agent/xapi-profiles/remove', '{base}/xapi/profiles/sparql',
      '{base}/xapi/profiles/validate_templates', '{base}/xapi/profiles/validate_patterns']);
    expect(new Set(xapiProfileServerAffordances.map(a => a.toolName)).size).toBe(5);
  });
});
