/**
 * The profile server as an authoring tool and a host: a profile is drafted, linted, published as an
 * immutable version, revised, and every IRI it ever published answers, over the routes the
 * affordances point at.
 *
 * Foxxi's own profile and the coached-world profile go through the same path with no findings,
 * with examples built by the functions that emit their statements where there is one.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import express from 'express';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ProfileServer, type ProfileRecord } from '../src/xapi-profile-server/service.js';
import { ProfileAuthoring, LintRefused, type DraftView } from '../src/xapi-profile-server/authoring.js';
import { mountProfileAuthoring, mountProfileHosting } from '../src/xapi-profile-server/authoring-http.js';
import { lintProfile, type ExampleSequence, type ExampleStatement, type ExternalTerm, type LintFinding, type ProfileExamples } from '../src/xapi-profile-server/lint.js';
import { xapiProfileServerAffordances } from '../src/xapi-profile-server/affordances.js';
import type { Json as PJson } from '../src/xapi-profile-server/processor.js';
import type { Json } from '../src/xapi-profile-server/rdf.js';
import { buildFoxxiProfileDoc, FOXXI_EXTERNAL_TERMS } from '../src/xapi-profile.js';
import { foxxiProfileExamples } from '../src/built-in-profile-examples.js';
import { IEP_DECORATIONS } from '../src/xapix/namespace.js';
import { loadPackFile } from '../../coached-world/src/pack.js';
import { buildProfile as buildWorldProfile } from '../../coached-world/src/profile.js';
import { buildMissionStatements } from '../../coached-world/src/statements.js';

type Obj = { [key: string]: Json };
const json = <T>(v: unknown): T => JSON.parse(JSON.stringify(v)) as T;
const codes = (findings: LintFinding[]) => [...new Set(findings.map(f => f.code))].sort();

// ── A made-up profile, written here ──────────────────────────────────────────────────────────
const BASE = 'https://bridge.example/xapi/profiles';
const P = `${BASE}/p/tidepool`;
const lang = (en: string) => ({ en });
const verb = (name: string, definition: string): Obj => ({ id: `${P}/verbs/${name}`, type: 'Verb', prefLabel: lang(name), definition: lang(definition) });
const concepts: Obj[] = [
  verb('arrived', 'A surveyor reached a pool.'), verb('counted', 'A surveyor counted the crabs in a pool.'), verb('sketched', 'A surveyor drew a pool.'),
  { id: `${P}/activity-types/pool`, type: 'ActivityType', prefLabel: lang('pool'), definition: lang('A tide pool that is surveyed.') },
  { id: `${P}/ext/tide`, type: 'ContextExtension', prefLabel: lang('tide'), definition: lang('The height of the tide when the count was made, in metres.'), inlineSchema: '{"type":"number"}' },
];
const template = (name: string, definition: string, more: Obj = {}): Obj => ({ id: `${P}/templates/${name}`, prefLabel: lang(name), definition: lang(definition),
  objectActivityType: `${P}/activity-types/pool`, ...more });
const templates: Obj[] = [
  template('arrival', 'Reaching a pool.', { verb: `${P}/verbs/arrived` }),
  template('count', 'One count, with the tide it was made at.', { verb: `${P}/verbs/counted`,
    rules: [{ location: '$.result.score.raw', presence: 'included' }, { location: `$.context.extensions['${P}/ext/tide']`, presence: 'included' }] }),
  template('sketch', 'A drawing of a pool.', { verb: `${P}/verbs/sketched` }),
];
const patterns: Obj[] = [
  { id: `${P}/patterns/survey`, primary: true, prefLabel: lang('survey'), definition: lang('Arrive, then count one or more times.'), sequence: [`${P}/templates/arrival`, `${P}/patterns/counts`] },
  { id: `${P}/patterns/counts`, primary: false, prefLabel: lang('counts'), definition: lang('The counts of one visit.'), oneOrMore: `${P}/templates/count` },
];
const said = (name: string, more: Obj = {}): PJson => ({ actor: { mbox: 'mailto:fictional-surveyor@example.org' }, verb: { id: `${P}/verbs/${name}` },
  object: { id: `${P}/pools/north`, definition: { type: `${P}/activity-types/pool` } }, ...more });
const counted = said('counted', { result: { score: { raw: 7 } }, context: { extensions: { [`${P}/ext/tide`]: 0.4 } } });
const examples = {
  statements: [
    { id: 'an-arrival', follows: [`${P}/templates/arrival`], statement: said('arrived') },
    { id: 'a-count', follows: [`${P}/templates/count`], statement: counted },
    { id: 'a-sketch', follows: [`${P}/templates/sketch`], statement: said('sketched') },
  ],
  sequences: [{ id: 'a-visit', pattern: `${P}/patterns/survey`, statements: ['an-arrival', 'a-count', 'a-count'] }],
};
const metadata = { prefLabel: lang('Tidepool survey'), definition: lang('A made-up profile about counting crabs.'), author: { type: 'Organization', name: 'Fictional Shoreline Society' } };

// ── The server, with a fake signer: the body says who it is from ─────────────────────────────
const kept: ProfileRecord[] = [];
let clock = '2026-03-01T00:00:00.000Z';
const makeServer = () => new ProfileServer({
  builtIn: () => [],
  persist: async record => { kept.push(json<ProfileRecord>(record)); return { persisted: true, holonUri: 'urn:test:holon' }; },
  hydrate: async () => kept,
  isOperator: did => did === 'did:example:operator',
});
let server: ProfileServer, authoring: ProfileAuthoring, http: Server, origin: string;
const ALICE = 'did:example:alice';
const act = async (path: string, payload: object, as = ALICE) => {
  const r = await fetch(`${origin}/agent/xapi-profiles/${path}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ as, payload }) });
  return { status: r.status, body: await r.json() as Record<string, unknown> & { findings?: LintFinding[]; document?: Obj } };
};
const fakeSigner = async (body: unknown) => {
  const b = body as { as?: string; payload?: Record<string, unknown> };
  return typeof b?.as === 'string' ? { ok: true as const, callerDid: b.as, payload: b.payload ?? {} } : { ok: false as const, status: 401, error: 'agent signature required' };
};
const get = (path: string, accept?: string) => fetch(`${origin}${path}`, accept ? { headers: { Accept: accept } } : {});
const resource = (iri: string, accept?: string) => get(`/xapi/profiles/resource?iri=${encodeURIComponent(iri)}`, accept);

beforeAll(async () => {
  server = makeServer();
  authoring = new ProfileAuthoring(server, { now: () => new Date(clock), hostedUnder: `${BASE}/p/` });
  const app = express();
  app.use(express.json({ limit: '2mb' }));
  mountProfileAuthoring(app, authoring, {
    base: BASE,
    verify: fakeSigner,
    limit: { windowMs: 60_000, limit: 100_000 },
  });
  mountProfileHosting(app, server, { base: BASE });
  http = app.listen(0, '127.0.0.1');
  await new Promise<void>(resolve => http.once('listening', () => resolve()));
  origin = `http://127.0.0.1:${(http.address() as AddressInfo).port}`;
});
afterAll(async () => { await new Promise(resolve => http.close(resolve)); });

describe('the lint tells a writer what to change', () => {
  const V = `${P}/v/1`;
  const whole = (change: (doc: { concepts: Obj[]; templates: Obj[]; patterns: Obj[] } & Obj) => void = () => {}) => {
    const stamp = (parts: Obj[], type?: string) => parts.map(p => ({ ...(type ? { type } : {}), ...json<Obj>(p), inScheme: V }));
    const doc = { '@context': 'https://w3id.org/xapi/profiles/context', id: P, type: 'Profile', conformsTo: 'https://w3id.org/xapi/profiles#1.0', ...metadata,
      versions: [{ id: V }], concepts: stamp(concepts), templates: stamp(templates, 'StatementTemplate'), patterns: stamp(patterns, 'Pattern') };
    change(doc);
    return doc;
  };
  const lint = (change?: Parameters<typeof whole>[0], ex: ProfileExamples = examples) => lintProfile(whole(change), ex);

  it('has nothing to say about a profile that is whole', () => {
    expect(lint()).toEqual([]);
  });

  it('names the term, the place and the change for each thing missing', () => {
    const findings = lint(d => {
      delete d.concepts[0]!.prefLabel; delete d.templates[0]!.definition; d.patterns[1]!.inScheme = `${P}/v/0`;
      delete d.concepts[4]!.inlineSchema;
    });
    expect(findings.map(f => [f.code, f.at, f.path])).toEqual([
      ['label', `${P}/verbs/arrived`, 'concepts[0].prefLabel'],
      ['definition', `${P}/templates/arrival`, 'templates[0].definition'],
      ['in-scheme', `${P}/patterns/counts`, 'patterns[1].inScheme'],
      ['extension-schema', `${P}/ext/tide`, 'concepts[4]'],
    ]);
    for (const f of findings) { expect(f.message.length).toBeGreaterThan(10); expect(f.fix.length).toBeGreaterThan(10); }
    expect(codes(lint(d => { d.concepts[4]!.schema = 'https://example.org/schemas/tide'; }))).toEqual(['schema-both']);
    expect(codes(lint(d => { d.concepts[4]!.inlineSchema = 'a number'; }))).toEqual(['schema-unreadable']);
    expect(codes(lint(d => { delete d.prefLabel; delete d.author; d.conformsTo = 'something else'; }))).toEqual(['label', 'profile-author', 'profile-conforms-to']);
  });

  it('mounts no signed route without its limit: past it, a request is refused before its signature is read', async () => {
    const app = express();
    app.use(express.json());
    let verified = 0;
    mountProfileAuthoring(app, new ProfileAuthoring(makeServer(), { hostedUnder: `${BASE}/p/` }), {
      base: BASE,
      verify: async body => { verified++; return fakeSigner(body); },
      limit: { windowMs: 60_000, limit: 2 },
    });
    const limited = app.listen(0, '127.0.0.1');
    await new Promise<void>(resolve => limited.once('listening', () => resolve()));
    try {
      const post = (path: string) => fetch(`http://127.0.0.1:${(limited.address() as AddressInfo).port}/agent/xapi-profiles/${path}`,
        { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ as: ALICE, payload: {} }) });
      expect((await post('draft')).status).toBe(200);
      expect((await post('draft')).status).toBe(200);
      for (const path of ['draft', 'lint', 'publish']) {
        const refused = await post(path);
        expect([path, refused.status, await refused.json()]).toEqual([path, 429, { error: 'too_many_requests' }]);
      }
      expect(verified).toBe(2);
    } finally { await new Promise(resolve => limited.close(resolve)); }
  });

  it('finds a verb, an activity type or an extension that nothing declares, and one declared as another kind', () => {
    const undeclared = lint(d => { d.concepts = d.concepts.filter(c => c.type === 'Verb' && c.id !== `${P}/verbs/sketched`); });
    expect(undeclared.filter(f => f.code === 'undeclared-term').map(f => [f.at, f.path])).toEqual([
      [`${P}/templates/arrival`, 'templates[0].objectActivityType'],
      [`${P}/templates/count`, 'templates[1].objectActivityType'],
      [`${P}/templates/count`, 'templates[1].rules[1].location'],
      [`${P}/templates/sketch`, 'templates[2].verb'],
      [`${P}/templates/sketch`, 'templates[2].objectActivityType'],
    ]);
    expect(codes(lint(d => { d.concepts[4]!.type = 'ResultExtension'; }))).toEqual(['term-kind']);
    // The same place written with brackets is the same place: the extension is still found.
    const bracketed = (d: Parameters<NonNullable<Parameters<typeof lint>[0]>>[0]) => {
      const rule = (d.templates[1] as unknown as { rules: Array<{ location: string }> }).rules[1]!;
      const written = rule.location.replace(/\.([A-Za-z]+)\.extensions\[/, (_m, holder: string) => `["${holder}"]['extensions'][`);
      expect(written).not.toBe(rule.location);
      rule.location = written;
    };
    expect(lint(bracketed)).toEqual([]);
    expect(lint(d => { bracketed(d); d.concepts = d.concepts.filter(c => c.type !== 'ContextExtension' && c.type !== 'ResultExtension' && c.type !== 'ActivityExtension'); })
      .filter(f => f.code === 'undeclared-term').map(f => f.path)).toEqual(['templates[1].rules[1].location']);
    // A context that is not the specification's is a different document from the triples served for it.
    for (const context of [null, {}, 'https://example.org/another-context', ['https://example.org/another-context'], 'https://example.org/?https://w3id.org/xapi/profiles/context'])
      expect(codes(lint(d => { (d as unknown as Record<string, unknown>)['@context'] = context; }))).toEqual(['profile-context']);
    expect(lint(d => { (d as unknown as Record<string, unknown>)['@context'] = ['https://w3id.org/xapi/profiles/context', { ex: 'https://example.org/' }]; })).toEqual([]);
    // A term another publisher defines is known when the writer vouches for it, or another held profile declares it.
    const elsewhere = whole(d => { d.concepts = d.concepts.filter(c => c.id !== `${P}/verbs/sketched`); });
    expect(codes(lintProfile(elsewhere, examples))).toEqual(['undeclared-term']);
    expect(lintProfile(elsewhere, examples, { external: iri => iri === `${P}/verbs/sketched` ? 'Verb' : undefined })).toEqual([]);
  });

  it('finds two templates nothing tells apart, and an example that follows a template it does not claim', () => {
    const twins = lint(d => { d.templates[2]!.verb = `${P}/verbs/arrived`; });
    expect(twins.find(f => f.code === 'same-determining-properties')).toMatchObject({ at: `${P}/templates/sketch` });
    // A template that takes any pool statement: every example now follows it too, and says so.
    const overlapping = lint(d => { d.templates.push({ id: `${P}/templates/any`, type: 'StatementTemplate', inScheme: V, prefLabel: lang('any'), definition: lang('Anything about a pool.'), objectActivityType: `${P}/activity-types/pool` }); });
    expect(codes(overlapping)).toEqual(['example-follows-another', 'template-example']);
    // Claimed, the overlap is the writer's decision and is accepted.
    const claimed = { ...examples, statements: examples.statements.map(e => ({ ...e, follows: [...e.follows, `${P}/templates/any`] })) };
    expect(lint(d => { d.templates.push({ id: `${P}/templates/any`, type: 'StatementTemplate', inScheme: V, prefLabel: lang('any'), definition: lang('Anything about a pool.'), objectActivityType: `${P}/activity-types/pool` }); }, claimed)).toEqual([]);
  });

  it('needs an example for every template and every primary pattern, judged by the processor', () => {
    expect(lint(undefined, { statements: [], sequences: [] }).map(f => [f.code, f.at])).toEqual([
      ['template-example', `${P}/templates/arrival`], ['template-example', `${P}/templates/count`], ['template-example', `${P}/templates/sketch`],
      ['pattern-example', `${P}/patterns/survey`],
    ]);
    // A count with no score does not follow its template: the processor's reason is the finding.
    const unscored = { ...examples, statements: examples.statements.map(e => e.id === 'a-count' ? { ...e, statement: said('counted', { context: { extensions: { [`${P}/ext/tide`]: 0.4 } } }) } : e) };
    const bad = lint(undefined, unscored);
    expect(bad.find(f => f.code === 'example-does-not-follow')).toMatchObject({ at: 'example:a-count', message: expect.stringContaining('$.result.score.raw') });
    expect(codes(bad)).toEqual(['example-does-not-follow', 'pattern-example', 'sequence-does-not-follow', 'template-example']);
    // A run that stops before the pattern does, and one with a statement the pattern has no place for.
    const run = (statements: string[]) => lint(undefined, { ...examples, sequences: [{ id: 'run', pattern: `${P}/patterns/survey`, statements }] });
    expect(run(['an-arrival']).map(f => f.code)).toEqual(['sequence-does-not-follow', 'pattern-example']);
    expect(run(['an-arrival', 'a-count', 'a-sketch']).map(f => f.code)).toEqual(['sequence-does-not-follow', 'pattern-example']);
    expect(run(['an-arrival', 'no-such-example']).map(f => f.code)).toEqual(['example-shape', 'pattern-example']);
  });

  it('reads every rule as the specification\'s JSONPath, and every pattern as one of its five kinds', () => {
    expect(lint(d => { (d.templates[1]!.rules as Obj[])[0]!.location = 'result.score.raw'; }).map(f => [f.code, f.path])).toEqual([['rule-jsonpath', 'templates[1].rules[0].location']]);
    expect(codes(lint(d => { (d.templates[1]!.rules as Obj[])[0]!.location = '$.result[?(@.raw)]'; }))).toEqual(['rule-jsonpath']);
    expect(codes(lint(d => { (d.templates[1]!.rules as Obj[])[0] = { location: '$.result' }; }))).toEqual(['rule-shape']);
    expect(codes(lint(d => { d.patterns[1]!.zeroOrMore = `${P}/templates/count`; }))).toEqual(['pattern-shape']);
    expect(codes(lint(d => { d.patterns[1]!.oneOrMore = `${P}/templates/nothing`; }))).toEqual(['unknown-reference']);
    expect(codes(lint(d => { d.patterns[1]!.oneOrMore = `${P}/patterns/survey`; }))).toEqual(['pattern-cycle']);
    expect(codes(lint(d => { d.templates[0]!.id = d.templates[1]!.id!; }))).toContain('duplicate-id');
  });
});

describe('a profile is written as a draft', () => {
  it('opens empty, is edited in parts, and says what is still wrong each time', async () => {
    expect((await act('draft', { profile: P }, 'nobody')).status).toBe(200);
    expect((await fetch(`${origin}/agent/xapi-profiles/draft`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' })).status).toBe(401);
    await act('draft', { profile: P, discard: true }, 'nobody');

    const opened = await act('draft', { profile: P });
    expect(opened.body).toMatchObject({ ok: true, profile: P, version: `${P}/v/1`, publishable: false });
    expect(codes(opened.body.findings!)).toEqual(['definition', 'label', 'profile-author']);

    const withTerms = await act('draft', { profile: P, set: metadata, put: { concepts, templates, patterns } });
    // inScheme and the type of a template or pattern are filled in; what is left is the examples.
    expect((withTerms.body.document!.templates as Obj[]).every(t => t.inScheme === `${P}/v/1` && t.type === 'StatementTemplate')).toBe(true);
    expect(codes(withTerms.body.findings!)).toEqual(['pattern-example', 'template-example']);
    expect((await act('publish', { profile: P })).status).toBe(422);

    const done = await act('draft', { profile: P, examples });
    expect(done.body).toMatchObject({ publishable: true, findings: [], counts: { concepts: 5, templates: 3, patterns: 2, exampleStatements: 3, exampleSequences: 1 } });
    expect((await act('lint', { profile: P })).body).toMatchObject({ ok: true, publishable: true, findings: [] });
    expect((await act('draft', {})).body.drafts).toEqual([{ profile: P, version: `${P}/v/1`, updatedAt: clock }]);
  });

  it('is its writer\'s, and an edit that is refused leaves it as it was', async () => {
    expect((await act('draft', { profile: P }, 'did:example:mallory')).status).toBe(409);
    expect((await act('lint', { profile: P }, 'did:example:mallory')).status).toBe(409);
    expect((await act('draft', { profile: P, put: { verbs: [] } })).status).toBe(400);
    expect((await act('draft', { profile: P, put: { concepts: [{ prefLabel: lang('no id') }] }, set: { prefLabel: lang('changed') } })).status).toBe(400);
    expect((await act('draft', { profile: P })).body.document).toMatchObject({ prefLabel: lang('Tidepool survey') });
    // An IRI on this deployment belongs under the hosted path; one on the writer's own domain is theirs.
    expect((await act('draft', { profile: 'https://bridge.example/dashboard' })).status).toBe(400);
    expect((await act('draft', { profile: 'https://example.org/profiles/elsewhere' })).status).toBe(200);
    await act('draft', { profile: 'https://example.org/profiles/elsewhere', discard: true });
  });

  it('lints a document that is sent and not kept', async () => {
    const r = await act('lint', { document: { id: 'https://example.org/profiles/loose', type: 'Profile', versions: [{ id: 'https://example.org/profiles/loose/v1' }] } }, 'did:example:passer-by');
    expect(r.status).toBe(200);
    expect(codes(r.body.findings!)).toEqual(['definition', 'label', 'profile-author', 'profile-conforms-to', 'profile-context']);
    expect((await act('draft', {}, 'did:example:passer-by')).body.drafts).toEqual([]);
  });
});

describe('a version is published once', () => {
  it('fixes generatedAtTime at publication, and is then immutable', async () => {
    clock = '2026-03-02T09:30:00.000Z';
    const r = await act('publish', { profile: P });
    expect(r.body).toMatchObject({ ok: true, profile: P, version: `${P}/v/1`, generatedAtTime: clock, immutable: true, deprecated: [], persisted: true });
    expect(r.body.wasRevisionOf).toBeUndefined();
    const doc = await (await resource(`${P}/v/1`)).json() as Obj;
    expect(doc.versions).toEqual([{ id: `${P}/v/1`, generatedAtTime: clock }]);
    expect((await act('draft', {})).body.drafts).toEqual([]);

    // The same version again, by any road: refused. Its author cannot take it down; the operator can.
    await expect(server.add(doc, ALICE)).rejects.toMatchObject({ status: 409 });
    await expect(server.publish(doc, examples as ProfileExamples, [], ALICE, clock)).rejects.toMatchObject({ status: 409 });
    await expect(server.remove(`${P}/v/1`, ALICE)).rejects.toMatchObject({ status: 409 });
    await expect(server.remove(P, ALICE)).rejects.toMatchObject({ status: 409 });
    clock = '2026-03-03T00:00:00.000Z';
    expect(((await (await resource(P)).json()) as Obj).versions).toEqual([{ id: `${P}/v/1`, generatedAtTime: '2026-03-02T09:30:00.000Z' }]);
  });

  it('revises the version before it, and what it leaves out stays resolvable as deprecated', async () => {
    const draft = await act('draft', { profile: P });
    expect(draft.body).toMatchObject({ version: `${P}/v/2`, revises: `${P}/v/1`, publishable: true });
    // Sketching is dropped: the template, its verb, and the example of it.
    const edited = await act('draft', { profile: P, remove: [`${P}/templates/sketch`, `${P}/verbs/sketched`, 'a-sketch'],
      put: { templates: [template('count', 'One count, with the tide it was made at, and no notes.', { verb: `${P}/verbs/counted`,
        rules: [{ location: '$.result.score.raw', presence: 'included' }, { location: `$.context.extensions['${P}/ext/tide']`, presence: 'included' }, { location: '$.result.response', presence: 'excluded' }] })] } });
    expect(edited.body).toMatchObject({ publishable: true, findings: [] });
    clock = '2026-06-01T00:00:00.000Z';
    const r = await act('publish', { profile: P });
    expect(r.body).toMatchObject({ version: `${P}/v/2`, generatedAtTime: clock, wasRevisionOf: `${P}/v/1`, deprecated: [`${P}/verbs/sketched`, `${P}/templates/sketch`] });

    const current = await (await resource(P)).json() as Obj & { templates: Obj[] };
    expect(current.versions).toEqual([{ id: `${P}/v/2`, generatedAtTime: clock, wasRevisionOf: [`${P}/v/1`] }, { id: `${P}/v/1`, generatedAtTime: '2026-03-02T09:30:00.000Z' }]);
    expect(current.templates.find(t => t.id === `${P}/templates/sketch`)).toMatchObject({ deprecated: true, inScheme: `${P}/v/2` });
    // The first version is as it was published.
    const first = await (await resource(`${P}/v/1`)).json() as Obj & { templates: Obj[] };
    expect(first.versions).toEqual([{ id: `${P}/v/1`, generatedAtTime: '2026-03-02T09:30:00.000Z' }]);
    expect(first.templates.find(t => t.id === `${P}/templates/sketch`)?.deprecated).toBeUndefined();
  });

  it('refuses a draft that still uses what it removes', async () => {
    await act('draft', { profile: P });
    // Counting is taken out while the survey pattern, an example and an example run still rest on it.
    const r = await act('draft', { profile: P, remove: [`${P}/templates/count`] });
    expect(codes(r.body.findings!)).toEqual(['deprecated-reference', 'example-unknown-template', 'pattern-example', 'sequence-does-not-follow']);
    expect(r.body.findings!.find(f => f.code === 'deprecated-reference')).toMatchObject({ at: `${P}/patterns/counts`, path: 'patterns[1].oneOrMore' });
    const refused = await act('publish', { profile: P });
    expect(refused.status).toBe(422);
    expect(refused.body.findings!.length).toBeGreaterThan(0);
    await expect(authoring.publish(P, ALICE)).rejects.toBeInstanceOf(LintRefused);
    await act('draft', { profile: P, discard: true });
  });

  it('is read back after a restart, still immutable', async () => {
    expect(kept.map(r => r.kind)).toEqual(['published', 'published']);
    const again = makeServer();
    await again.ready();
    expect(again.dataset.get(P)?.version).toBe(`${P}/v/2`);
    expect(again.published(`${P}/v/1`)?.examples.statements.map(e => e.id)).toEqual(['an-arrival', 'a-count', 'a-sketch']);
    await expect(again.add(again.dataset.get(`${P}/v/1`)!.doc, ALICE)).rejects.toMatchObject({ status: 409 });
  });
});

describe('every IRI of a hosted profile dereferences', () => {
  it('serves the profile, each version and each term, at the resolver and at its own address', async () => {
    for (const iri of [P, `${P}/v/1`, `${P}/v/2`, `${P}/verbs/counted`, `${P}/ext/tide`, `${P}/templates/count`, `${P}/patterns/survey`]) {
      const byResolver = await resource(iri);
      expect(byResolver.status, iri).toBe(200);
      expect(byResolver.headers.get('content-type')).toContain('application/ld+json');
      expect(byResolver.headers.get('vary')).toBe('Accept');
      const own = await get(new URL(iri).pathname);
      expect(own.status, iri).toBe(200);
      expect(await own.json()).toEqual(await byResolver.json());
    }
    const term = await (await resource(`${P}/templates/count`)).json() as Obj;
    expect(term).toMatchObject({ '@context': 'https://w3id.org/xapi/profiles/context', id: `${P}/templates/count`, type: 'StatementTemplate', inScheme: `${P}/v/2` });
    expect(term.deprecated).toBeUndefined();
    expect((await resource(`${P}/patterns/survey`)).headers.get('link')).toContain(`rel="predecessor-version"`);
    expect((await resource(`${P}/templates/none`)).status).toBe(404);
    expect((await get('/xapi/profiles/p/nothing-here')).status).toBe(404);
    expect((await get('/xapi/profiles/resource')).status).toBe(400);
  });

  it('answers for a removed term, marked deprecated', async () => {
    for (const iri of [`${P}/templates/sketch`, `${P}/verbs/sketched`]) {
      const r = await resource(iri);
      expect(r.status).toBe(200);
      expect(await r.json()).toMatchObject({ id: iri, deprecated: true });
    }
  });

  it('negotiates the representation', async () => {
    const turtle = await resource(`${P}/templates/count`, 'text/turtle');
    expect(turtle.headers.get('content-type')).toContain('text/turtle');
    const text = await turtle.text();
    expect(text).toContain(`<${P}/templates/count> <http://www.w3.org/1999/02/22-rdf-syntax-ns#type> <https://w3id.org/xapi/profiles/ontology#StatementTemplate> .`);
    expect(text).toContain(`<http://www.w3.org/2004/02/skos/core#prefLabel> "count"@en .`);
    // Its rules are blank nodes, and they come with it; another template's triples do not.
    expect(text).toContain('$.result.score.raw');
    expect(text).not.toContain(`${P}/templates/arrival`);
    const whole = await (await resource(P, 'application/n-triples')).text();
    expect(whole.split('\n').length).toBeGreaterThan(40);
    expect((await resource(P, 'application/json')).headers.get('content-type')).toContain('application/json');
    expect((await resource(P, 'image/png')).status).toBe(406);
    const kept = await (await get(`/xapi/profiles/examples?iri=${encodeURIComponent(`${P}/v/1`)}`)).json() as { examples: ProfileExamples };
    expect(kept.examples.sequences).toEqual(examples.sequences);
  });
});

describe('statements are validated against a hosted version', () => {
  it('by the processor, with a deprecated template judging nothing', async () => {
    expect(await server.validateTemplates(counted, `${P}/v/2`)).toMatchObject({ comments: [], templates: [`${P}/templates/count`] });
    const noted = { ...counted, result: { score: { raw: 7 }, response: 'seven, I think' } };
    expect((await server.validateTemplates(noted, `${P}/v/1`)).comments).toEqual([]);
    expect((await server.validateTemplates(noted, `${P}/v/2`)).comments[0]).toContain('presence is excluded');
    // A sketch follows the first version, and matches nothing in the second, where its template is deprecated.
    expect((await server.validateTemplates(said('sketched'), `${P}/v/1`)).comments).toEqual([]);
    expect((await server.validateTemplates(said('sketched'), P)).comments[0]).toContain('matches no statement template');
    expect(await server.validatePatterns([said('arrived'), counted, counted], P)).toEqual({ comments: [], pattern: `${P}/patterns/survey` });
    expect((await server.validatePatterns([counted], `${P}/v/2`)).comments.length).toBeGreaterThan(0);
  });
});

describe('the affordances are the surface', () => {
  it('names a target for writing, linting, publishing and resolving, each of which this file called', () => {
    const byTool = new Map(xapiProfileServerAffordances.map(a => [a.toolName, a]));
    expect(byTool.get('foxxi.xapi_profile_draft')).toMatchObject({ method: 'POST', targetTemplate: '{base}/agent/xapi-profiles/draft' });
    expect(byTool.get('foxxi.xapi_profile_lint')).toMatchObject({ method: 'POST', targetTemplate: '{base}/agent/xapi-profiles/lint' });
    expect(byTool.get('foxxi.xapi_profile_publish')).toMatchObject({ method: 'POST', targetTemplate: '{base}/agent/xapi-profiles/publish' });
    expect(byTool.get('foxxi.xapi_profile_resolve')).toMatchObject({ method: 'GET', targetTemplate: '{base}/xapi/profiles/resource' });
    expect(new Set(xapiProfileServerAffordances.map(a => a.action)).size).toBe(xapiProfileServerAffordances.length);
  });
});

// ── The profiles this repository publishes, through the same path ────────────────────────────

/** Author → lint → publish → host, on a server of its own. Returns what the host then serves. */
async function roundTrip(doc: Obj, ex: ProfileExamples, external: ExternalTerm[] = []) {
  // A version is published only once it is kept, so this server has somewhere that says it kept it.
  const own = new ProfileServer({ builtIn: () => [], persist: async () => ({ persisted: true }) });
  const at = '2026-11-15T12:00:00.000Z';
  const tool = new ProfileAuthoring(own, { now: () => new Date(at) });
  const id = doc.id as string;
  const view = await tool.edit({ profile: id, document: doc, examples: ex, external }, ALICE) as DraftView;
  const published = view.publishable ? await tool.publish(id, ALICE) : undefined;
  return { view, published, own, at };
}

const example = (id: string, follows: string[], statement: unknown): ExampleStatement => ({ id, follows, statement: json<PJson>(statement) });

describe('Foxxi\'s own profile goes through author, lint, publish and host with no findings', () => {
  const doc = buildFoxxiProfileDoc({ generatedAt: '2026-07-22T00:00:00.000Z' }) as Obj & { templates: Obj[]; patterns: Obj[]; concepts: Obj[] };
  const T = (name: string) => `${doc.id as string}/templates/${name}`;
  // The examples the deployment keeps with the profile (src/built-in-profile-examples.ts).
  const { statements, sequences } = foxxiProfileExamples();

  it('has an example for each of its templates and primary patterns, and the lint finds nothing', async () => {
    expect(statements.length).toBe(doc.templates.length);
    expect(sequences.length).toBe(doc.patterns.filter(p => p.primary === true).length);
    // Its templates name verbs and activity types ADL and cmi5 define, and the four keys the xapi-x
    // profile declares. The profile declares none of them. Unvouched, on a server that holds no
    // other profile, the lint says so; they are their publishers' terms, so they are named as
    // external and not copied into this profile's concepts.
    const unvouched = await roundTrip(doc, { statements, sequences });
    expect(unvouched.view.findings.length).toBeGreaterThan(0);
    expect([...new Set(unvouched.view.findings.map(f => f.code))]).toEqual(['undeclared-term']);
    expect(unvouched.view.findings.map(f => f.at)).toEqual(expect.arrayContaining([T('experienced-performance'), T('interacted'), T('launched'), T('performed-descriptor')]));
    expect(unvouched.published).toBeUndefined();
    const external = [...FOXXI_EXTERNAL_TERMS.map(t => ({ ...t })), ...Object.values(IEP_DECORATIONS).map(id => ({ id, type: 'ResultExtension' }))];
    const { view, published, own, at } = await roundTrip(doc, { statements, sequences }, external);
    expect(view.findings).toEqual([]);
    const version = `${doc.id as string}/v/1`;
    expect(own.published(version)?.external).toEqual(external);
    expect(published).toMatchObject({ generatedAtTime: at, deprecated: [] });
    expect(published!.held.version).toBe(version);
    // What is hosted is what was written, with the time of this publication.
    expect(own.resolve(doc.id as string)!.body).toEqual({ ...doc, versions: [{ id: version, generatedAtTime: at }] });
    for (const part of [...doc.concepts, ...doc.templates, ...doc.patterns]) expect(own.resolve(part.id as string)?.body, String(part.id)).toMatchObject({ id: part.id, inScheme: version });
    expect(await own.validateTemplates(statements.find(e => e.id === 'slide-viewed')!.statement, version)).toMatchObject({ comments: [], templates: [T('slide-viewed')] });
  });

  it('says what each of its extensions carries', () => {
    const extensions = doc.concepts.filter(c => String(c.type).endsWith('Extension'));
    expect(extensions.length).toBeGreaterThan(30);
    expect(extensions.filter(c => typeof c.inlineSchema !== 'string').map(c => c.id)).toEqual([]);
  });
});

describe.each(['orchard', 'mandate'])('the coached-world %s profile goes through author, lint, publish and host with no findings', name => {
  const pack = loadPackFile(join(dirname(fileURLToPath(import.meta.url)), `../../coached-world/packs/${name}.json`));
  const doc = json<Obj & { templates: Obj[]; patterns: Obj[]; concepts: Obj[] }>(buildWorldProfile(pack));
  const mission = pack.missions[0]!;
  const cause = pack.causes.find(c => c.symptoms.length > 0)!;
  const build = (more: Partial<Parameters<typeof buildMissionStatements>[0]>) => buildMissionStatements({
    pack, homePage: 'http://127.0.0.1:9/', actorDid: 'did:web:example:agents:pip', missionId: mission.id, missionTitle: mission.title,
    missionObject: mission.object, symptoms: cause.symptoms.slice(0, 3), herring: undefined, progressed: 2, measured: undefined,
    timestamp: '2026-11-14T00:00:00.000Z', ...more,
  });

  it('with the statements the world builds as its examples', async () => {
    const opened = build({}).statements.map(s => json<PJson>(s));
    const settled = build({ symptoms: [], progressed: 2, measured: { raw: 61, success: true }, registration: build({}).registration }).statements.map(s => json<PJson>({ ...s, timestamp: '2026-11-14T00:02:00.000Z' }));
    const standing = build({ symptoms: [], progressed: 0, measured: { raw: 40, success: false } }).statements.map(s => json<PJson>(s));
    const T = (verb: string) => `${pack.profileId}/templates/${verb}`;
    const verbOf = (s: PJson) => doc.templates.find(t => t.verb === (s.verb as { id: string }).id)!.id as string;
    // One example per template, each the first statement the world builds with that verb.
    const statements = [...opened, ...settled].filter((s, i, all) => all.findIndex(o => verbOf(o) === verbOf(s)) === i).map((s, i) => example(`built-${i}`, [verbOf(s)], s));
    expect(statements.map(e => e.follows[0]).sort()).toEqual(['initialized', 'measured', 'observed', 'progressed'].map(T).sort());
    const sequences: ExampleSequence[] = [
      { id: 'a-mission', pattern: `${pack.profileId}/patterns/mission`, statements: [...opened, ...settled] },
      { id: 'a-standing-measure', pattern: `${pack.profileId}/patterns/standing-measure`, statements: standing },
    ];
    const { view, published, own, at } = await roundTrip(doc, { statements, sequences });
    expect(view.findings).toEqual([]);
    const version = `${pack.profileId}/v/1`;
    expect(published!.held.version).toBe(version);
    expect(own.resolve(pack.profileId)!.body).toEqual({ ...doc, versions: [{ id: version, generatedAtTime: at }] });
    expect(own.resolve(`${pack.profileId}/ext/cause`)!.body).toMatchObject({ type: 'ResultExtension', inScheme: version });
    expect(await own.validatePatterns([...opened, ...settled], version)).toEqual({ comments: [], pattern: `${pack.profileId}/patterns/mission` });
  });
});
