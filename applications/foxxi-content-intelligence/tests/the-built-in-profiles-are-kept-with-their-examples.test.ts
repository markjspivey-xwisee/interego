/**
 * A built-in profile is never published from a draft, so nothing made it show the lint an example
 * for each template. The deployment keeps examples with each one all the same, holds them to the
 * lint a published profile has to pass, and serves them where a published version's are served.
 *
 * Foxxi's profile declares only Foxxi's own terms. The ADL and cmi5 terms its statements use are
 * named as external, by IRI and type, and are not concepts of the profile.
 *
 * Foxxi's projector writes the four `iep:` keys the xapi-x profile declares, beside its own, and
 * what it writes follows both profiles.
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
import { projectMeshEntry, type MeshDiscoverEntry } from '../src/mesh-event-projector.js';
import { buildXapixProfileDoc, XAPIX_PROFILE_VERSION_ID } from '../src/xapix/profile.js';
import { IEP_DECORATIONS, XAPIX_PROFILE_ID } from '../src/xapix/namespace.js';

type Obj = Record<string, unknown>;
const BASE = 'https://bridge.example/xapi/profiles';
const FOXXI_VERSION = `${FOXXI_PROFILE_ID}/v/1`;
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
    expect(kept.map(k => k.profile)).toEqual(builtInProfiles().map(p => (p as { id: string }).id));
    for (const k of kept) {
      const doc = builtInProfiles().find(p => (p as { id: string }).id === k.profile);
      expect(authoring.lintDocument(doc, k.examples, k.external), k.profile).toEqual([]);
    }
  });

  it('are an example for every template and every primary pattern of Foxxi\'s profile', () => {
    const { examples } = builtInKept().find(k => k.profile === FOXXI_PROFILE_ID)!;
    expect(examples.statements.length).toBe(foxxi.templates.length);
    expect(examples.sequences.map(s => s.pattern).sort()).toEqual(foxxi.patterns.filter(p => p.primary === true).map(p => p.id as string).sort());
  });

  it('are the same each time they are built', () => {
    expect(builtInKept()).toEqual(builtInKept());
  });

  it('are served where a published version\'s are, by profile or by version, and say the profile is built in', async () => {
    for (const [profile, version] of [[FOXXI_PROFILE_ID, FOXXI_VERSION], [XAPIX_PROFILE_ID, XAPIX_PROFILE_VERSION_ID]] as const) {
      const kept = builtInKept().find(k => k.profile === profile)!;
      for (const iri of [profile, version]) {
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
    // Thirteen verbs and four activity types the profile used to declare, and the two it never did.
    expect(FOXXI_EXTERNAL_TERMS.filter(t => t.type === 'Verb').length).toBe(13);
    expect(FOXXI_EXTERNAL_TERMS.filter(t => t.type === 'ActivityType').length).toBe(6);
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
  const xapix = (buildXapixProfileDoc() as { templates: Json[] }).templates;
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
    // Its own key is still written, and names the same descriptor.
    expect(((statement.context as Json).extensions as Json)[`${FOXXI_NS}substrateDescriptorIri`]).toBe(decorations(statement)[IEP_DECORATIONS.sourceDescriptor]);
    expect(validates(statement, xapix)).toMatchObject({ outcome: 'success', findings: [] });
    const judged = await followsFoxxi(statement);
    expect(judged.comments).toEqual([]);
    expect(judged.templates.length).toBeGreaterThan(0);
  });

  it('states no outcome the envelope did not carry, and keeps the one it did', () => {
    expect(Object.keys(project().result as Json)).toEqual(['extensions']);
    expect(project({ success: false, scoreScaled: 0.2 }).result).toMatchObject({ success: false, score: { scaled: 0.2 } });
  });

  it('a retraction is a voiding statement and states no modal status', () => {
    const voiding = project({ modalStatus: 'Retracted' });
    expect((voiding.verb as Json).id).toBe('http://adlnet.gov/expapi/verbs/voided');
    expect(voiding.result).toBeUndefined();
  });

  it('a projection stored before the keys were written still follows Foxxi\'s profile', async () => {
    const { result: _dropped, ...before } = project({ verb: `${FOXXI_NS}performed` }) as Json & { result?: Json };
    expect((await followsFoxxi(before)).comments).toEqual([]);
  });

  it('a projection whose modal status its verb cannot say does not follow Foxxi\'s profile', async () => {
    const statement = project({ modalStatus: 'Hypothetical' });
    const wrong = { ...statement, result: { extensions: { ...decorations(statement), [IEP_DECORATIONS.modalStatus]: 'Asserted' } } };
    const judged = await followsFoxxi(wrong);
    expect(judged.comments.join('\n')).toContain(IEP_DECORATIONS.modalStatus);
  });
});
