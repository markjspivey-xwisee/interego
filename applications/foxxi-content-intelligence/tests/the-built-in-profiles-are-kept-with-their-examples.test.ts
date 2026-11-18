/**
 * A built-in profile is never published from a draft, so nothing made it show the lint an example
 * for each template. The deployment keeps examples with each one all the same, holds them to the
 * lint a published profile has to pass, and serves them where a published version's are served.
 *
 * Foxxi's profile declares only Foxxi's own terms. The ADL and cmi5 terms its statements use are
 * named as external, by IRI and type, and are not concepts of the profile.
 *
 * Foxxi's projector writes the `iep:` keys the xapi-x profile declares, beside its own, with the
 * projection category and what the statement supersedes, and what it writes follows Foxxi's
 * profile and the current version of the xapi-x profile.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import express from 'express';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { ProfileServer } from '../src/xapi-profile-server/service.js';
import { ProfileAuthoring } from '../src/xapi-profile-server/authoring.js';
import { mountProfileHosting } from '../src/xapi-profile-server/authoring-http.js';
import { builtInProfiles, builtInKept } from '../src/xapi-profile-server/built-in.js';
import { validates, type Json } from '../src/xapi-profile-server/processor.js';
import { buildFoxxiProfileDoc, FOXXI_EXTERNAL_TERMS, FOXXI_NS, FOXXI_PROFILE_ID, FOXXI_PROFILE_PARTS, verbIsDeclared } from '../src/xapi-profile.js';
import { PROFILE_GENERATED_AT } from '../src/xapi-lrs.js';
import { projectMeshEntry, deterministicUuid, type MeshDiscoverEntry } from '../src/mesh-event-projector.js';
import { buildXapixProfileDoc, XAPIX_PROFILE_V1_ID, XAPIX_PROFILE_VERSION_ID, XAPIX_PROJECTION_TEMPLATE_ID } from '../src/xapix/profile.js';
import { IEP_DECORATIONS, XAPIX_PROFILE_ID, xapix as term } from '../src/xapix/namespace.js';
import { lintXapixStatements } from '../src/xapix/lint.js';

type Obj = Record<string, unknown>;
const BASE = 'https://bridge.example/xapi/profiles';
const FOXXI_VERSION = `${FOXXI_PROFILE_ID}/v/2`, FOXXI_V1 = `${FOXXI_PROFILE_ID}/v/1`;
const foxxi = buildFoxxiProfileDoc({ generatedAt: PROFILE_GENERATED_AT }) as Obj & { concepts: Obj[]; templates: Obj[]; patterns: Obj[] };

let server: ProfileServer, http: Server, origin: string;
const examplesOf = (iri: string) => fetch(`${origin}/xapi/profiles/examples?iri=${encodeURIComponent(iri)}`);

beforeAll(async () => {
  server = new ProfileServer({ builtIn: builtInProfiles, builtInKept });
  const app = express();
  mountProfileHosting(app, server, { base: BASE });
  http = app.listen(0, '127.0.0.1');
  await new Promise<void>(resolve => http.once('listening', () => resolve()));
  origin = `http://127.0.0.1:${(http.address() as AddressInfo).port}`;
});
afterAll(async () => { await new Promise(resolve => http.close(resolve)); });

describe('the examples kept with a built-in profile', () => {
  it('pass the lint a published profile has to pass, for each built-in profile', () => {
    const authoring = new ProfileAuthoring(server, { hostedUnder: `${BASE}/p/` });
    const kept = builtInKept();
    // One for each version held: Foxxi's profile and the xapi-x profile, each in its two versions.
    const versionOf = (doc: unknown) => (doc as { versions: Array<{ id: string }> }).versions[0]!.id;
    expect(kept.map(k => server.dataset.get(k.profile)!.version)).toEqual(builtInProfiles().map(versionOf));
    for (const k of kept) {
      const version = server.dataset.get(k.profile)!.version;
      const doc = builtInProfiles().find(p => versionOf(p) === version);
      expect(authoring.lintDocument(doc, k.examples, k.external), k.profile).toEqual([]);
    }
  });

  it('are an example for every template and every primary pattern of Foxxi\'s profile', () => {
    // For the current version: every template and primary pattern it does not keep only as deprecated.
    const { examples } = builtInKept().find(k => k.profile === FOXXI_VERSION)!;
    const judging = <X extends Obj>(parts: X[]) => parts.filter(p => p.deprecated !== true);
    expect(examples.statements.length).toBe(judging(foxxi.templates).length);
    expect(examples.sequences.map(s => s.pattern).sort()).toEqual(judging(foxxi.patterns).filter(p => p.primary === true).map(p => p.id as string).sort());
    // And version 1 is kept with its own, the same number: version 2 replaced five templates and two primary patterns, one for one.
    const v1 = builtInKept().find(k => k.profile === FOXXI_V1)!.examples;
    expect([v1.statements.length, v1.sequences.length]).toEqual([examples.statements.length, examples.sequences.length]);
  });

  it('are the same each time they are built', () => {
    expect(builtInKept()).toEqual(builtInKept());
  });

  it('are served where a published version\'s are, by profile or by version, and say the profile is built in', async () => {
    // A profile's IRI answers for its current version; each version answers for itself.
    for (const [profile, version, asked] of [
      [FOXXI_PROFILE_ID, FOXXI_VERSION, [FOXXI_PROFILE_ID, FOXXI_VERSION]],
      [FOXXI_PROFILE_ID, FOXXI_V1, [FOXXI_V1]],
      [XAPIX_PROFILE_ID, XAPIX_PROFILE_VERSION_ID, [XAPIX_PROFILE_ID, XAPIX_PROFILE_VERSION_ID]],
      [XAPIX_PROFILE_ID, XAPIX_PROFILE_V1_ID, [XAPIX_PROFILE_V1_ID]],
    ] as const) {
      const kept = builtInKept().find(k => server.dataset.get(k.profile)!.version === version)!;
      for (const iri of asked) {
        const res = await examplesOf(iri);
        expect(res.status, iri).toBe(200);
        const body = await res.json() as Obj;
        expect(body).toEqual({ profile, version, builtIn: true, examples: kept.examples, external: kept.external });
        // Nobody published it, so no time of publication is claimed.
        expect(body.publishedAt).toBeUndefined();
      }
    }
    expect((await examplesOf('https://example.org/no-such-profile')).status).toBe(404);
  });

  it('are not kept for a profile that is not built in', () => {
    expect(() => new ProfileServer({ builtIn: builtInProfiles, builtInKept: () => [{ profile: 'https://example.org/someone-elses', examples: { statements: [], sequences: [] }, external: [] }] }))
      .toThrow(/not one of this deployment's built-in profiles/);
  });
});

describe('Foxxi\'s profile declares only Foxxi\'s own terms', () => {
  const own = (iri: string) => iri.startsWith(FOXXI_NS) || iri.startsWith(`${FOXXI_PROFILE_ID}/`);

  it('has no concept whose IRI is another publisher\'s', () => {
    expect(foxxi.concepts.map(c => c.id as string).filter(id => !own(id))).toEqual([]);
    expect(foxxi.concepts.length).toBeGreaterThan(50);
  });

  it('names every other publisher\'s term its templates select on as external, and nothing of its own', () => {
    const named = new Set<string>();
    for (const t of foxxi.templates)
      for (const key of ['verb', 'objectActivityType', 'contextGroupingActivityType', 'contextParentActivityType', 'contextOtherActivityType', 'contextCategoryActivityType', 'attachmentUsageType'])
        for (const iri of [t[key]].flat()) if (typeof iri === 'string' && !own(iri)) named.add(iri);
    const external = FOXXI_EXTERNAL_TERMS.map(t => t.id);
    expect([...named].filter(iri => !external.includes(iri))).toEqual([]);
    expect(external.filter(own)).toEqual([]);
    expect(new Set(external).size).toBe(external.length);
    // Thirteen verbs and four activity types the profile used to declare, the two it never did, and the xapi-x projection marker.
    expect(FOXXI_EXTERNAL_TERMS.filter(t => t.type === 'Verb').length).toBe(13);
    expect(FOXXI_EXTERNAL_TERMS.filter(t => t.type === 'ActivityType').length).toBe(7);
  });

  it('still knows every verb its statements use, its own or not', () => {
    for (const v of FOXXI_PROFILE_PARTS.verbs) expect(verbIsDeclared(v.id), v.id).toBe(true);
    expect(verbIsDeclared('https://example.org/verbs/made-up-verb')).toBe(false);
  });

  it('does not redeclare the keys the xapi-x profile declares', () => {
    const keys = Object.values(IEP_DECORATIONS) as string[];
    expect(foxxi.concepts.filter(c => keys.includes(c.id as string))).toEqual([]);
    for (const key of keys) expect(server.knownTerm(key, FOXXI_PROFILE_ID), key).toBe('ResultExtension');
  });
});

describe('Foxxi\'s projector writes the keys the xapi-x profile declares', () => {
  const entry = (more: Partial<MeshDiscoverEntry> = {}): MeshDiscoverEntry => ({
    descriptorUrl: 'https://pod.example/fictional-agent/context-graphs/1790000000000.ttl', describes: ['urn:graph:made-up-1790000000000'],
    conformsTo: ['https://example.org/types/RefundDecision'], ...more });
  const project = (more: Partial<MeshDiscoverEntry> = {}) => projectMeshEntry(entry(more), 'https://pod.example/fictional-agent/')!.statement as Json;
  const decorations = (statement: Json) => ((statement.result as Json | undefined)?.extensions ?? {}) as Json;
  // The current version of the xapi-x profile, without the deprecated template every statement
  // matches: what is left selects on the projection category, which the projector writes.
  const xapixDoc = buildXapixProfileDoc() as Json & { templates: Json[] };
  const xapix = xapixDoc.templates.filter(t => t.deprecated !== true);
  const context = (statement: Json) => statement.context as Json;
  const D0 = 'https://pod.example/fictional-agent/context-graphs/1789999990000.ttl', DM1 = 'https://pod.example/fictional-agent/context-graphs/1789999980000.ttl';
  const followsFoxxi = (statement: Json) => server.validateTemplates(statement, FOXXI_PROFILE_ID);

  it.each([
    [undefined, 'Asserted', false],
    ['Asserted', 'Asserted', false],
    ['Hypothetical', 'Hypothetical', true],
    ['Counterfactual', 'Counterfactual', true],
    ['Quoted', 'Quoted', true],
  ] as const)('a %s descriptor is projected with modal status %s, lossy %s', async (modalStatus, stated, lossy) => {
    const statement = project(modalStatus ? { modalStatus } : {});
    expect(decorations(statement)).toEqual({
      [IEP_DECORATIONS.sourceDescriptor]: 'https://pod.example/fictional-agent/context-graphs/1790000000000.ttl',
      [IEP_DECORATIONS.modalStatus]: stated,
      [IEP_DECORATIONS.projectionLossy]: lossy,
    });
    // Foxxi's own keys for the same things are no longer written on a projection (decision 6).
    for (const key of ['substrateDescriptorIri', 'supersededDescriptor', 'endorsed'])
      expect(((statement.context as Json).extensions as Json)[`${FOXXI_NS}${key}`], key).toBeUndefined();
    expect(validates(statement, xapix)).toMatchObject({ outcome: 'success', findings: [], templates: [XAPIX_PROJECTION_TEMPLATE_ID] });
    const judged = await followsFoxxi(statement);
    expect(judged.comments).toEqual([]);
    expect(judged.templates.length).toBeGreaterThan(0);
  });

  it('carries the projection category, so the xapi-x template selects it; without it no xapi-x template does', () => {
    const statement = project();
    const categories = (context(statement).contextActivities as Json).category as Json[];
    expect(categories.map(c => (c.definition as Json).type)).toContain(term('Projection'));
    const without = { ...statement, context: { ...context(statement), contextActivities: { category: categories.filter(c => (c.definition as Json).type !== term('Projection')) } } };
    expect(validates(without, xapix).templates).toEqual([]);
  });

  it('names the statements it supersedes, most recent first, and refers a plain LRS to the first', async () => {
    const statement = project({ supersedes: [D0, DM1] });
    expect((context(statement).extensions as Json)[term('supersedesStatement')]).toEqual([deterministicUuid(D0), deterministicUuid(DM1)]);
    expect(context(statement).statement).toEqual({ objectType: 'StatementRef', id: deterministicUuid(D0) });
    // The id it names is the id the superseded descriptor's own projection has.
    expect(project({ descriptorUrl: D0 }).id).toBe(deterministicUuid(D0));
    // Foxxi's own key for it is gone; the superseded descriptor is still named, as an activity. It voids nothing.
    expect((context(statement).extensions as Json)[`${FOXXI_NS}supersededDescriptor`]).toBeUndefined();
    expect(((context(statement).contextActivities as Json).other as Json[]).map(a => a.id)).toEqual([D0]);
    expect((await followsFoxxi(project({ verb: `${FOXXI_NS}performed`, supersedes: [D0, DM1] }))).templates.sort()).toEqual([`${FOXXI_PROFILE_ID}/templates/performed-projection`, `${FOXXI_PROFILE_ID}/templates/superseding-projection`].sort());
    expect((statement.verb as Json).id).not.toBe('http://adlnet.gov/expapi/verbs/voided');
    expect((await followsFoxxi(statement)).comments).toEqual([]);
    expect(validates(statement, xapix)).toMatchObject({ outcome: 'success', findings: [] });
    // The envelope promises no order, so the projector makes one: newest first by the time each
    // descriptor's IRI carries, whatever order the envelope listed them in.
    const oldestFirst = project({ supersedes: [DM1, D0] });
    expect((context(oldestFirst).extensions as Json)[term('supersedesStatement')]).toEqual([deterministicUuid(D0), deterministicUuid(DM1)]);
    expect(context(oldestFirst).statement).toEqual({ objectType: 'StatementRef', id: deterministicUuid(D0) });
    // A descriptor whose IRI carries no time comes after those that do; with no time on any, the envelope's order is kept.
    const untimed = 'https://pod.example/fictional-agent/context-graphs/made-up-note.ttl', untimed2 = 'https://pod.example/fictional-agent/context-graphs/another-made-up-note.ttl';
    expect((context(project({ supersedes: [untimed, DM1, D0] })).extensions as Json)[term('supersedesStatement')]).toEqual([D0, DM1, untimed].map(deterministicUuid));
    expect((context(project({ supersedes: [untimed, untimed2] })).extensions as Json)[term('supersedesStatement')]).toEqual([untimed, untimed2].map(deterministicUuid));
    // One that supersedes nothing says nothing about it.
    expect(context(project()).statement).toBeUndefined();
    expect((context(project()).extensions as Json)[term('supersedesStatement')]).toBeUndefined();
  });

  it.each(['Hypothetical', 'Counterfactual'] as const)('leaves the outcome the envelope carried off a %s projection', async (modalStatus) => {
    const statement = project({ modalStatus, success: true, scoreScaled: 0.9 });
    expect(Object.keys(statement.result as Json)).toEqual(['extensions']);
    expect((await followsFoxxi(statement)).comments).toEqual([]);
    expect(projectMeshEntry(entry({ modalStatus, success: true }), 'https://pod.example/fictional-agent/')!.step.result).toBeUndefined();
  });

  it('passes the xapi-x statement rules for every modal status', () => {
    const profiles = [xapixDoc, foxxi as Json];
    const options = { outcomeVerbs: ['http://adlnet.gov/expapi/verbs/completed', 'http://adlnet.gov/expapi/verbs/failed'] };
    const clean = [project(), project({ success: false, scoreScaled: 0.2 }), project({ modalStatus: 'Hypothetical', success: true }),
      project({ modalStatus: 'Counterfactual', scoreScaled: 0.9 }), project({ supersedes: [D0, DM1] }),
      project({ modalStatus: 'Quoted' }), project({ modalStatus: 'Quoted', success: false, scoreScaled: 0.1 })];
    expect(lintXapixStatements(clean, profiles, options)).toEqual([]);
    // The rule is live: the statement a Quoted descriptor used to get is found.
    const before = { ...project({ modalStatus: 'Quoted' }), verb: { id: 'http://adlnet.gov/expapi/verbs/completed' } };
    expect([...new Set(lintXapixStatements([before], profiles, options).map(f => f.code))]).toEqual(['xapix-outcome-not-asserted']);
  });

  it('a Quoted descriptor is projected as quoted: no outcome verb, no outcome, and its modal status says it is not endorsed', async () => {
    for (const more of [{}, { success: true }, { success: false, scoreScaled: 0.1 }] as Array<Partial<MeshDiscoverEntry>>) {
      const statement = project({ modalStatus: 'Quoted', ...more });
      expect((statement.verb as Json).id).toBe(`${FOXXI_NS}verbs/quoted`);
      expect(Object.keys(statement.result as Json)).toEqual(['extensions']);
      expect(decorations(statement)[IEP_DECORATIONS.modalStatus]).toBe('Quoted');
      // Not a performance record: no performance category beside the two projection markers.
      expect(((context(statement).contextActivities as Json).category as Json[]).length).toBe(2);
      const judged = await followsFoxxi(statement);
      expect(judged.comments).toEqual([]);
      expect(judged.templates).toEqual([`${FOXXI_PROFILE_ID}/templates/quoted-projection`]);
      // Its trajectory step is a Quoted step, not an asserted one, and carries no outcome.
      const projected = projectMeshEntry(entry({ modalStatus: 'Quoted', ...more }), 'https://pod.example/fictional-agent/')!;
      expect(projected.step.result).toBeUndefined();
      expect(projected.step).toMatchObject({ modalStatus: 'Quoted', verb: 'quoted' });
      expect(projected.mode).toBe('quoted');
    }
    // The template refuses an outcome beside the verb.
    const withOutcome = { ...project({ modalStatus: 'Quoted' }) } as Json;
    withOutcome.result = { ...(withOutcome.result as Json), success: true };
    expect((await followsFoxxi(withOutcome)).comments.join('\n')).toContain('result.success');
  });

  it.each(['Hypothetical', 'Counterfactual', 'Quoted'] as const)('a source verb that says an outcome is not kept on a %s descriptor', (modalStatus) => {
    const structural = { Hypothetical: 'verbs/intended', Counterfactual: 'verbs/considered', Quoted: 'verbs/quoted' }[modalStatus];
    for (const verb of ['http://adlnet.gov/expapi/verbs/completed', 'http://adlnet.gov/expapi/verbs/failed', 'asked'])
      expect((project({ verb, modalStatus }).verb as Json).id, verb).toBe(`${FOXXI_NS}${structural}`);
  });

  it.each([
    // A verb the source supplies is kept when it can say the descriptor's modal status...
    [`${FOXXI_NS}performed`, 'Asserted', `${FOXXI_NS}performed`],
    [`${FOXXI_NS}performed`, 'Quoted', `${FOXXI_NS}performed`],
    ['intended', 'Hypothetical', `${FOXXI_NS}verbs/intended`],
    ['considered', 'Counterfactual', `${FOXXI_NS}verbs/considered`],
    ['quoted', 'Quoted', `${FOXXI_NS}verbs/quoted`],
    // ...and gives way to the structural verb for that status when it cannot.
    ['intended', undefined, 'http://adlnet.gov/expapi/verbs/completed'],
    ['considered', 'Asserted', 'http://adlnet.gov/expapi/verbs/completed'],
    [`${FOXXI_NS}performed`, 'Hypothetical', `${FOXXI_NS}verbs/intended`],
    [`${FOXXI_NS}performed`, 'Counterfactual', `${FOXXI_NS}verbs/considered`],
    ['intended', 'Counterfactual', `${FOXXI_NS}verbs/considered`],
    ['quoted', 'Asserted', 'http://adlnet.gov/expapi/verbs/completed'],
    ['intended', 'Quoted', `${FOXXI_NS}verbs/quoted`],
  ] as const)('a source that says %s of a %s descriptor is projected as %s, and the statement follows both profiles', async (verb, modalStatus, projectedAs) => {
    const statement = project({ verb, ...(modalStatus ? { modalStatus } : {}) });
    expect((statement.verb as Json).id).toBe(projectedAs);
    expect(decorations(statement)[IEP_DECORATIONS.modalStatus]).toBe(modalStatus ?? 'Asserted');
    expect(validates(statement, xapix).outcome).toBe('success');
    const judged = await followsFoxxi(statement);
    expect(judged.comments).toEqual([]);
    expect(judged.templates.length).toBeGreaterThan(0);
  });

  it('states no outcome the envelope did not carry, and keeps the one it did', () => {
    expect(Object.keys(project().result as Json)).toEqual(['extensions']);
    expect(project({ success: false, scoreScaled: 0.2 }).result).toMatchObject({ success: false, score: { scaled: 0.2 } });
  });

  it('a retraction is a voiding statement: it states no modal status, is not a projection, and supersedes nothing', () => {
    const voiding = project({ modalStatus: 'Retracted', supersedes: [D0] });
    expect((voiding.verb as Json).id).toBe('http://adlnet.gov/expapi/verbs/voided');
    expect(voiding.result).toBeUndefined();
    expect(voiding.object).toEqual({ objectType: 'StatementRef', id: deterministicUuid(D0) });
    expect(((context(voiding).contextActivities as Json).category as Json[]).map(c => (c.definition as Json).type)).not.toContain(term('Projection'));
    expect((context(voiding).extensions as Json)[term('supersedesStatement')]).toBeUndefined();
    expect(context(voiding).statement).toBeUndefined();
  });

  it('a projection stored under version 1 still follows version 1, which is still held', async () => {
    // As the projector wrote it before the iep# keys: Foxxi's own key in context, nothing in result.
    const now = project({ verb: `${FOXXI_NS}performed` }) as Json & { result?: Json };
    const { result: _dropped, ...rest } = now;
    const before = { ...rest, context: { ...context(now), extensions: { ...(context(now).extensions as Json), [`${FOXXI_NS}substrateDescriptorIri`]: 'https://pod.example/fictional-agent/context-graphs/1790000000000.ttl' } } };
    const v1 = await server.validateTemplates(before, FOXXI_V1);
    expect(v1.comments).toEqual([]);
    expect(v1.templates).toEqual([`${FOXXI_PROFILE_ID}/templates/performed-descriptor`]);
    // Version 2 asks for the iep# keys, so it does not pass that statement.
    expect((await followsFoxxi(before)).comments.join('\n')).toContain(IEP_DECORATIONS.sourceDescriptor);
    // And what the projector writes now is not what version 1 asked for.
    expect((await server.validateTemplates(now, FOXXI_V1)).comments.join('\n')).toContain('substrateDescriptorIri');
  });

  it('a retraction still names its descriptor in Foxxi\'s own key: a voiding statement is not a projection', () => {
    const voiding = project({ modalStatus: 'Retracted', supersedes: [D0] });
    expect(context(voiding).extensions).toMatchObject({ [`${FOXXI_NS}substrateDescriptorIri`]: 'https://pod.example/fictional-agent/context-graphs/1790000000000.ttl', [`${FOXXI_NS}supersededDescriptor`]: D0 });
  });

  it('a projection whose modal status its verb cannot say does not follow Foxxi\'s profile', async () => {
    const statement = project({ modalStatus: 'Hypothetical' });
    const wrong = { ...statement, result: { extensions: { ...decorations(statement), [IEP_DECORATIONS.modalStatus]: 'Asserted' } } };
    const judged = await followsFoxxi(wrong);
    expect(judged.comments.join('\n')).toContain(IEP_DECORATIONS.modalStatus);
  });
});
