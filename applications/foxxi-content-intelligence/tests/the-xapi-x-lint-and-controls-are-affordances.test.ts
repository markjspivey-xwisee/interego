/**
 * The xapi-x rules and the controls document, reached over HTTP on the profile server
 * (src/xapix/http.ts), and the offers Foxxi's own profile states.
 *
 * Every name, address and identifier is made up.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import express from 'express';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { ProfileServer } from '../src/xapi-profile-server/service.js';
import { builtInProfiles, builtInKept } from '../src/xapi-profile-server/built-in.js';
import { xapiProfileServerAffordances } from '../src/xapi-profile-server/affordances.js';
import { ProfileAuthoring } from '../src/xapi-profile-server/authoring.js';
import { validates, type Json } from '../src/xapi-profile-server/processor.js';
import { mountXapixRoutes, templatesFollowed } from '../src/xapix/http.js';
import { controlsDocument, controlsUrl, offersOf } from '../src/xapix/controls.js';
import { lintXapixProfile } from '../src/xapix/lint.js';
import { IEP_DECORATIONS, XAPIX_PROFILE_ID, xapix } from '../src/xapix/namespace.js';
import { projectionCategory } from '../src/xapix/statement.js';
import { buildFoxxiProfileDoc, FOXXI_PROFILE_ID, OFFERED_AFTER_A_FAILED_ATTEMPT } from '../src/xapi-profile.js';
import { PROFILE_GENERATED_AT } from '../src/xapi-lrs.js';
import { foxxiAffordances } from '../affordances.js';

const BASE = 'https://bridge.example/xapi/profiles';
const BRIDGE = 'https://bridge.example';
const ADL = 'http://adlnet.gov/expapi';
const LESSON_FAILED = `${FOXXI_PROFILE_ID}/templates/lesson-failed`;
const COURSE_FAILED = `${FOXXI_PROFILE_ID}/templates/course-failed`;
const LESSON_PASSED = `${FOXXI_PROFILE_ID}/templates/lesson-passed`;
const DESIGN_IDEA = 'https://id.example/concept/made-up-idea';

const served = (iri: string) => foxxiAffordances.find(a => a.action === iri);
const describeAffordance = (iri: string) => { const a = served(iri); return a ? { title: a.title, method: a.method, target: a.targetTemplate.replace('{base}', BRIDGE), mediaType: a.mediaType } : undefined; };

let server: ProfileServer, http: Server, origin: string;
let glossaryUp = true;
let lookupsAsked = 0;
const post = async (path: string, body: unknown) => { const r = await fetch(`${origin}/xapi/profiles${path}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }); return { status: r.status, body: await r.json() as Json }; };
const get = async (path: string) => { const r = await fetch(`${origin}/xapi/profiles${path}`); return { status: r.status, body: await r.json() as Json }; };

beforeAll(async () => {
  server = new ProfileServer({ builtIn: builtInProfiles, builtInKept });
  const app = express();
  app.use(express.json({ limit: '2mb' }));
  mountXapixRoutes(app, server, {
    base: BASE,
    links: async () => { lookupsAsked++; return { ...(glossaryUp ? { designIdea: (iri: string) => iri === DESIGN_IDEA } : {}), affordance: (iri: string) => served(iri) !== undefined }; },
    describeAffordance,
  });
  http = app.listen(0, '127.0.0.1');
  await new Promise<void>(resolve => http.once('listening', () => resolve()));
  origin = `http://127.0.0.1:${(http.address() as AddressInfo).port}`;
});
afterAll(async () => { await new Promise(resolve => http.close(resolve)); });

const projection = (more: { modalStatus?: string; result?: Json } = {}): Json => ({
  id: '6f1d2c9a-3b4e-4f5a-8b6c-7d8e9f0a1b2c',
  actor: { account: { homePage: 'https://example.org', name: 'fictional-learner' } },
  verb: { id: 'https://example.org/verbs/made-up-verb' },
  object: { objectType: 'Activity', id: 'https://example.org/activities/made-up-activity' },
  result: { ...more.result, extensions: {
    [IEP_DECORATIONS.sourceDescriptor]: 'https://pod.example/fictional-learner/context-graphs/1790000000000.ttl',
    [IEP_DECORATIONS.modalStatus]: more.modalStatus ?? 'Asserted',
    [IEP_DECORATIONS.projectionLossy]: (more.modalStatus ?? 'Asserted') !== 'Asserted',
  } },
  context: { contextActivities: { category: [projectionCategory()] } },
  timestamp: '2026-11-17T12:00:00.000Z',
});
const failedLesson = (): Json => ({
  id: 'b2e4a1c0-1111-4222-8333-444455556666',
  actor: { account: { homePage: 'https://example.org', name: 'fictional-learner' } },
  verb: { id: `${ADL}/verbs/failed` },
  object: { objectType: 'Activity', id: 'https://example.org/lessons/made-up', definition: { type: `${ADL}/activities/lesson` } },
  result: { success: false, score: { scaled: 0.2 } },
  timestamp: '2026-11-17T12:00:00.000Z',
});

describe('POST /xapi/profiles/lint_decorations, over statements', () => {
  it('finds nothing in a well-formed projection, and says what it judged', async () => {
    const asked = lookupsAsked;
    const r = await post('/lint_decorations', { statements: [projection()] });
    expect(r.status).toBe(200);
    // Statements have no links to look up, so the lookups (a glossary read, on the bridge) are not asked for.
    expect(lookupsAsked).toBe(asked);
    expect(r.body.linksChecked).toBeUndefined();
    expect(r.body).toMatchObject({ ok: true, findings: [], clean: true, checked: { statements: 1, declaredBy: [XAPIX_PROFILE_ID] } });
  });

  it('finds an outcome on a statement that is not asserted, and a key no profile declares', async () => {
    const hypothetical = projection({ modalStatus: 'Hypothetical', result: { success: true } });
    const undeclared = { ...projection(), id: 'c3d5b2e1-aaaa-4bbb-8ccc-ddddeeeeffff', context: { extensions: { [`${xapix('controls')}-made-up`]: 'x' } } };
    const r = await post('/lint_decorations', { statements: [hypothetical, undeclared] });
    const codes = (r.body.findings as Json[]).map(f => f.code);
    expect(r.body.clean).toBe(false);
    expect(codes).toContain('xapix-outcome-not-asserted');
    expect(codes).toContain('xapix-undeclared');
    expect((r.body.findings as Json[]).every(f => typeof f.fix === 'string' && typeof f.path === 'string')).toBe(true);
  });

  it('reads the domain profiles the caller names, and takes a verb the caller calls an outcome', async () => {
    const quoted = { ...projection({ modalStatus: 'Quoted' }), verb: { id: `${ADL}/verbs/completed` } };
    const without = await post('/lint_decorations', { statements: [quoted], profiles: [FOXXI_PROFILE_ID] });
    expect(without.body.checked).toMatchObject({ declaredBy: [XAPIX_PROFILE_ID, FOXXI_PROFILE_ID] });
    const told = await post('/lint_decorations', { statements: [quoted], outcomeVerbs: [`${ADL}/verbs/completed`] });
    expect((told.body.findings as Json[]).map(f => f.code)).toEqual(['xapix-outcome-not-asserted']);
  });

  it('refuses what it cannot judge', async () => {
    expect((await post('/lint_decorations', {})).status).toBe(400);
    expect((await post('/lint_decorations', { statements: 'not statements' })).status).toBe(400);
    expect((await post('/lint_decorations', { statements: [projection()], profiles: ['https://example.org/profiles/not-held'] })).status).toBe(400);
    expect((await post('/lint_decorations', { statements: Array.from({ length: 501 }, () => projection()) })).status).toBe(413);
    expect((await post('/lint_decorations', { profile: 'https://example.org/profiles/not-held' })).status).toBe(400);
  });
});

describe('POST /xapi/profiles/lint_decorations, over a profile', () => {
  it('passes each built-in profile with the examples it is kept with, and says the lookups were made', async () => {
    for (const profile of [FOXXI_PROFILE_ID, XAPIX_PROFILE_ID]) {
      const r = await post('/lint_decorations', { profile });
      expect(r.body, profile).toMatchObject({ ok: true, findings: [], clean: true, linksChecked: { evidences: true, offers: true } });
      expect((r.body.checked as Json).examples as number).toBeGreaterThan(0);
    }
  });

  it('finds an offer that is not an affordance served here, and an evidence link that is not a design idea', async () => {
    const document = {
      id: 'https://example.org/profiles/made-up', type: 'Profile',
      concepts: [
        { id: 'https://example.org/profiles/made-up/verbs/checked', type: 'Verb', [xapix('evidences')]: [{ '@id': DESIGN_IDEA }] },
        { id: 'https://example.org/profiles/made-up/verbs/guessed', type: 'Verb', [xapix('evidences')]: [{ '@id': 'https://id.example/concept/not-in-the-release' }] },
      ],
      templates: [{ id: 'https://example.org/profiles/made-up/templates/tried', type: 'StatementTemplate', verb: 'https://example.org/profiles/made-up/verbs/checked',
        [xapix('offers')]: [{ '@id': OFFERED_AFTER_A_FAILED_ATTEMPT[0] }, { '@id': 'urn:iep:action:foxxi:made-up-and-not-served' }, 'not an object'] }],
    };
    const r = await post('/lint_decorations', { document });
    const found = (r.body.findings as Json[]).filter(f => String(f.code).startsWith('xapix-link')).map(f => [f.code, f.at]);
    expect(found).toEqual([
      ['xapix-link-target', 'https://example.org/profiles/made-up/verbs/guessed'],
      ['xapix-link-target', 'https://example.org/profiles/made-up/templates/tried'],
      ['xapix-link-shape', 'https://example.org/profiles/made-up/templates/tried'],
    ]);
  });

  it('says so when the release could not be read, and checks those targets for shape only', async () => {
    glossaryUp = false;
    try {
      const document = { id: 'https://example.org/profiles/made-up', type: 'Profile', concepts: [{ id: 'https://example.org/profiles/made-up/verbs/guessed', type: 'Verb', [xapix('evidences')]: [{ '@id': 'https://id.example/concept/not-in-the-release' }] }] };
      const r = await post('/lint_decorations', { document });
      expect(r.body.linksChecked).toEqual({ evidences: false, offers: true });
      expect((r.body.findings as Json[]).filter(f => f.code === 'xapix-link-target')).toEqual([]);
    } finally { glossaryUp = true; }
  });
});

describe('what Foxxi\'s profile offers after a failed attempt', () => {
  const foxxi = buildFoxxiProfileDoc({ generatedAt: PROFILE_GENERATED_AT }) as unknown as Json & { templates: Json[] };
  const template = (id: string) => foxxi.templates.find(t => t.id === id)!;

  it('is stated on the two failed templates, and on no other', () => {
    expect(offersOf(template(LESSON_FAILED))).toEqual([...OFFERED_AFTER_A_FAILED_ATTEMPT]);
    expect(offersOf(template(COURSE_FAILED))).toEqual([...OFFERED_AFTER_A_FAILED_ATTEMPT]);
    expect(foxxi.templates.filter(t => offersOf(t).length > 0).map(t => t.id).sort()).toEqual([COURSE_FAILED, LESSON_FAILED].sort());
  });

  it('names affordances the bridge serves to a learner', () => {
    for (const action of OFFERED_AFTER_A_FAILED_ATTEMPT) expect(served(action), action).toBeDefined();
    expect(lintXapixProfile(foxxi, builtInKept().find(k => k.profile === FOXXI_PROFILE_ID)!.examples, { affordance: iri => served(iri) !== undefined })).toEqual([]);
  });

  it('changes nothing a plain processor reads: the profile still lints, and the same statements follow the template', () => {
    const kept = builtInKept().find(k => k.profile === FOXXI_PROFILE_ID)!;
    expect(new ProfileAuthoring(server, { hostedUnder: `${BASE}/p/` }).lintDocument(foxxi, kept.examples, kept.external)).toEqual([]);
    const r = validates(failedLesson(), foxxi.templates.filter(t => t.deprecated !== true));
    expect(r.templates).toEqual([LESSON_FAILED]);
    expect(r.findings).toEqual([]);
  });
});

describe('the controls document', () => {
  it('is served for a template, with each offered affordance as the deployment serves it', async () => {
    const r = await get(`/controls?template=${encodeURIComponent(LESSON_FAILED)}`);
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ id: controlsUrl(BASE, [LESSON_FAILED]), templates: [LESSON_FAILED], conformsTo: xapix('controls') });
    const controls = r.body.controls as Json[];
    expect(controls.map(c => c.affordance)).toEqual([...OFFERED_AFTER_A_FAILED_ATTEMPT]);
    for (const c of controls) {
      expect(c.offeredBy).toBe(LESSON_FAILED);
      expect(String(c.target)).toMatch(/^https:\/\/bridge\.example\//);
      expect(c.target).toBe(served(String(c.affordance))!.targetTemplate.replace('{base}', BRIDGE));
      expect(c.method).toBe(served(String(c.affordance))!.method);
    }
    expect(r.body.unresolved).toBeUndefined();
    // Nothing a statement says is in it.
    expect(JSON.stringify(r.body)).not.toContain('fictional-learner');
  });

  it('has no controls for a template that offers nothing, and answers 404 for what is not a template', async () => {
    const none = await get(`/controls?template=${encodeURIComponent(LESSON_PASSED)}`);
    expect(none.body).toMatchObject({ templates: [LESSON_PASSED], controls: [] });
    expect((await get(`/controls?template=${encodeURIComponent(FOXXI_PROFILE_ID)}`)).status).toBe(404);
    expect((await get('/controls')).status).toBe(400);
    const mixed = await get(`/controls?template=${encodeURIComponent(LESSON_FAILED)}&template=${encodeURIComponent('https://example.org/not-held')}`);
    expect(mixed.body).toMatchObject({ templates: [LESSON_FAILED], notTemplates: ['https://example.org/not-held'] });
  });

  it('is found for a statement by the templates it follows, without the statement being kept or echoed', async () => {
    const r = await post('/controls', { statement: failedLesson() });
    expect(r.body).toMatchObject({ templates: [LESSON_FAILED], link: controlsUrl(BASE, [LESSON_FAILED]) });
    expect((r.body.controls as Json[]).length).toBe(OFFERED_AFTER_A_FAILED_ATTEMPT.length);
    expect(JSON.stringify(r.body)).not.toContain('fictional-learner');
    // A statement that follows a template with no offers has nothing to follow, and no link.
    const passed = { ...failedLesson(), verb: { id: `${ADL}/verbs/passed` }, result: { success: true, score: { scaled: 0.9 } } };
    const nothing = await post('/controls', { statement: passed });
    expect(nothing.body).toMatchObject({ templates: [], controls: [] });
    expect(nothing.body.link).toBeUndefined();
    expect((await post('/controls', { statement: 'not a statement' })).status).toBe(400);
  });

  it('finds the template a statement follows even when it breaks a rule of a template in another profile', async () => {
    // A made-up second profile whose template also matches a failed lesson, and asks for a response it does not carry.
    const strict = {
      id: 'https://example.org/profiles/strict', type: 'Profile', versions: [{ id: 'https://example.org/profiles/strict/v/1', generatedAtTime: '2026-11-17T00:00:00.000Z' }],
      templates: [{ id: 'https://example.org/profiles/strict/templates/failed-with-a-response', type: 'StatementTemplate', inScheme: 'https://example.org/profiles/strict/v/1',
        verb: `${ADL}/verbs/failed`, rules: [{ location: '$.result.response', presence: 'included' }] }],
    };
    const both = new ProfileServer({ builtIn: () => [...builtInProfiles(), strict as never], builtInKept });
    expect(validates(failedLesson(), [...(buildFoxxiProfileDoc({ generatedAt: PROFILE_GENERATED_AT }) as unknown as { templates: Json[] }).templates.filter(t => t.deprecated !== true), ...strict.templates as Json[]]).outcome).toBe('invalid');
    expect((await templatesFollowed(both, failedLesson())).map(t => t.id)).toEqual([LESSON_FAILED]);
  });

  it('names an offer the deployment does not serve as unresolved, and gives it no target', () => {
    const doc = controlsDocument({ id: 'https://bridge.example/x', templates: [{ id: 'https://example.org/t', [xapix('offers')]: [{ '@id': 'urn:made-up:not-served' }, { '@id': OFFERED_AFTER_A_FAILED_ATTEMPT[0] }] }], describe: describeAffordance });
    expect(doc.unresolved).toEqual([{ offeredBy: 'https://example.org/t', affordance: 'urn:made-up:not-served' }]);
    expect((doc.controls as Json[]).map(c => c.affordance)).toEqual([OFFERED_AFTER_A_FAILED_ATTEMPT[0]]);
  });
});

describe('the two routes are affordances', () => {
  it('each with the path it is mounted at', () => {
    const byTool = new Map(xapiProfileServerAffordances.map(a => [a.toolName, a]));
    expect(byTool.get('foxxi.xapi_profile_lint_decorations')).toMatchObject({ method: 'POST', targetTemplate: '{base}/xapi/profiles/lint_decorations' });
    expect(byTool.get('foxxi.xapi_profile_controls')).toMatchObject({ method: 'GET', targetTemplate: '{base}/xapi/profiles/controls' });
    expect(byTool.get('foxxi.xapi_profile_lint_decorations')!.annotations).toMatchObject({ readOnlyHint: true });
  });
});
