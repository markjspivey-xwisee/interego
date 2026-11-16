/**
 * The xapi-x profile is one of the deployment's built-in profiles: the profile server holds the
 * document `src/xapix/profile.ts` builds, resolves each of its IRIs, validates a statement against
 * it, and lets no agent replace it or take it down.
 *
 * The statements are built by the lrs-adapter's own builder, the one it posts to an LRS.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import express from 'express';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { buildProjectionStatement } from '../../lrs-adapter/src/projection-statement.js';
import { ProfileServer, ProfileServerError, mountProfileServerReads } from '../src/xapi-profile-server/service.js';
import { mountProfileHosting } from '../src/xapi-profile-server/authoring-http.js';
import { builtInProfiles } from '../src/xapi-profile-server/built-in.js';
import { lintProfile } from '../src/xapi-profile-server/lint.js';
import { lintXapixProfile, lintXapixStatements } from '../src/xapix/lint.js';
import { validates, type Json } from '../src/xapi-profile-server/processor.js';
import { FOXXI_PROFILE_ID } from '../src/xapi-profile.js';
import { buildXapixProfileDoc, buildXapixProfileDocV1, XAPIX_PROFILE_V1_ID, XAPIX_PROFILE_VERSION_ID, XAPIX_PROJECTION_TEMPLATE_ID, XAPIX_V1_TEMPLATE_ID } from '../src/xapix/profile.js';
import { IEP_DECORATIONS, XAPIX_PROFILE_ID, xapix } from '../src/xapix/namespace.js';

const BASE = 'https://bridge.example/xapi/profiles';
const projected = (): Json => buildProjectionStatement({
  descriptorIri: 'https://pod.example/fictional-learner/context-graphs/1790000000000.ttl',
  actor: { account: { homePage: 'https://example.org', name: 'fictional-learner' } },
  verbId: 'https://example.org/verbs/made-up-verb',
  objectId: 'https://example.org/activities/made-up-activity',
}, '6f1d2c9a-3b4e-4f5a-8b6c-7d8e9f0a1b2c', '2026-11-15T12:00:00.000Z');
const withoutSource = (): Json => {
  const statement = projected();
  const result = statement.result as Json;
  const { [IEP_DECORATIONS.sourceDescriptor]: _dropped, ...rest } = result.extensions as Json;
  return { ...statement, result: { ...result, extensions: rest } };
};

let server: ProfileServer, http: Server, origin: string;
const get = (path: string, accept?: string) => fetch(`${origin}${path}`, accept ? { headers: { Accept: accept } } : {});
const resource = (iri: string, accept?: string) => get(`/xapi/profiles/resource?iri=${encodeURIComponent(iri)}`, accept);
const validate = (statement: Json, profile: string) => fetch(`${origin}/xapi/profiles/validate_templates`,
  { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ statement, profile }) });

beforeAll(async () => {
  server = new ProfileServer({ builtIn: builtInProfiles });
  const app = express();
  app.use(express.json({ limit: '2mb' }));
  mountProfileServerReads(app, server, {
    base: BASE,
    urlencoded: express.urlencoded({ extended: false, limit: '2mb' }),
    text: express.text({ type: ['application/sparql-query'], limit: '64kb' }),
    addTarget: 'https://bridge.example/agent/xapi-profiles/add', removeTarget: 'https://bridge.example/agent/xapi-profiles/remove',
  });
  mountProfileHosting(app, server, { base: BASE });
  http = app.listen(0, '127.0.0.1');
  await new Promise<void>(resolve => http.once('listening', () => resolve()));
  origin = `http://127.0.0.1:${(http.address() as AddressInfo).port}`;
});
afterAll(async () => { await new Promise(resolve => http.close(resolve)); });

describe('the xapi-x profile on the profile server', () => {
  it('is built in beside Foxxi\'s own, as the document its source builds', () => {
    expect(builtInProfiles().map(p => (p as { id: string }).id)).toEqual([FOXXI_PROFILE_ID, XAPIX_PROFILE_ID, XAPIX_PROFILE_ID]);
    expect(builtInProfiles().slice(1)).toEqual([buildXapixProfileDocV1(), buildXapixProfileDoc()]);
    expect(server.isBuiltIn(XAPIX_PROFILE_ID)).toBe(true);
    expect(server.dataset.get(XAPIX_PROFILE_ID)?.version).toBe(XAPIX_PROFILE_VERSION_ID);
  });

  it('passes the lint a published profile has to pass, with a statement the adapter builds as its example', () => {
    const examples = { statements: [{ id: 'a-projection', follows: [XAPIX_PROJECTION_TEMPLATE_ID], statement: projected() }], sequences: [] };
    expect(lintProfile(buildXapixProfileDoc(), examples)).toEqual([]);
    // Without its example the template has none, and the lint says so: the example is doing the work.
    expect(lintProfile(buildXapixProfileDoc()).map(f => [f.code, f.at])).toEqual([['template-example', XAPIX_PROJECTION_TEMPLATE_ID]]);
    // The profile declares every xapix: key a statement may carry, and lints clean under the xapi-x rules too.
    expect(lintXapixProfile(buildXapixProfileDoc() as Json, examples)).toEqual([]);
    expect(lintXapixStatements([projected()], [buildXapixProfileDoc() as Json])).toEqual([]);
  });

  it('is listed by the server as built in, with nobody named as having added it', async () => {
    const index = await (await get('/xapi/profiles')).json() as { profiles: Array<{ id: string; version: string; builtIn: boolean; addedBy?: string }> };
    const listed = index.profiles.filter(p => p.id === XAPIX_PROFILE_ID);
    expect(listed).toMatchObject([{ id: XAPIX_PROFILE_ID, version: XAPIX_PROFILE_V1_ID, builtIn: true }, { id: XAPIX_PROFILE_ID, version: XAPIX_PROFILE_VERSION_ID, builtIn: true }]);
    expect((listed as unknown as Array<{ current: boolean }>).map(p => p.current)).toEqual([false, true]);
    expect(listed[0]!.addedBy).toBeUndefined();
  });

  it('answers for the profile, its version, its template and each key it declares', async () => {
    const profile = await resource(XAPIX_PROFILE_ID, 'application/ld+json');
    expect(profile.status).toBe(200);
    expect(profile.headers.get('content-type')).toContain('application/ld+json');
    expect(await profile.json()).toEqual(buildXapixProfileDoc());
    expect(await (await resource(XAPIX_PROFILE_VERSION_ID)).json()).toMatchObject({ id: XAPIX_PROFILE_ID });
    expect(await (await resource(XAPIX_PROJECTION_TEMPLATE_ID)).json()).toMatchObject({ id: XAPIX_PROJECTION_TEMPLATE_ID, type: 'StatementTemplate', inScheme: XAPIX_PROFILE_VERSION_ID });
    // The keys are `iep:` IRIs, not children of the profile's: they resolve to this profile's declaration all the same.
    for (const key of Object.values(IEP_DECORATIONS))
      expect(await (await resource(key)).json(), key).toMatchObject({ id: key, type: 'ResultExtension', inScheme: XAPIX_PROFILE_VERSION_ID });
    // And the xapix: terms, which are on the relay's origin and declared here.
    expect(await (await resource(xapix('Projection'))).json()).toMatchObject({ id: xapix('Projection'), type: 'ActivityType' });
    expect(await (await resource(xapix('previousDigest'))).json()).toMatchObject({ id: xapix('previousDigest'), type: 'ContextExtension' });
    const triples = await resource(XAPIX_PROFILE_ID, 'application/n-triples');
    expect(triples.status).toBe(200);
    expect(await triples.text()).toContain(`<${XAPIX_PROJECTION_TEMPLATE_ID}>`);
  });

  it('judges a statement against it: a projection the adapter builds validates, and one without its descriptor does not', async () => {
    expect((await validate(projected(), XAPIX_PROFILE_ID)).status).toBe(204);
    const refused = await validate(withoutSource(), XAPIX_PROFILE_ID);
    expect(refused.status).toBe(400);
    expect(JSON.stringify(await refused.json())).toContain(IEP_DECORATIONS.sourceDescriptor);
  });

  it('still holds version 1: its IRI resolves, and a statement written before the category existed validates against it', async () => {
    expect(server.dataset.get(XAPIX_PROFILE_V1_ID)?.doc).toEqual(buildXapixProfileDocV1());
    expect(server.dataset.get(XAPIX_PROFILE_ID)?.version).toBe(XAPIX_PROFILE_VERSION_ID);
    expect((await resource(XAPIX_PROFILE_V1_ID)).status).toBe(200);
    const { context: _none, ...before } = projected();
    expect((await validate(before, XAPIX_PROFILE_V1_ID)).status).toBe(204);
    // Against the current version it is not a projection at all, so nothing in it is judged.
    expect(validates(before, (buildXapixProfileDoc().templates as Json[]).filter(t => t.deprecated !== true)).outcome).toBe('unmatched');
    expect(validates(before, buildXapixProfileDocV1().templates as Json[])).toMatchObject({ outcome: 'success', templates: [XAPIX_V1_TEMPLATE_ID] });
  });

  it('is not replaced and not taken down, by an agent or by the operator', async () => {
    const operated = new ProfileServer({ builtIn: builtInProfiles, isOperator: did => did === 'did:example:operator' });
    const changed = { ...buildXapixProfileDoc(), prefLabel: { en: 'someone else\'s xapi-x' } } as never;
    for (const by of ['did:example:alice', 'did:example:operator']) {
      await expect(operated.add(changed, by)).rejects.toMatchObject({ status: 409 });
      await expect(operated.remove(XAPIX_PROFILE_ID, by)).rejects.toBeInstanceOf(ProfileServerError);
      await expect(operated.remove(XAPIX_PROFILE_VERSION_ID, by)).rejects.toMatchObject({ status: 409 });
    }
    expect(operated.dataset.get(XAPIX_PROFILE_ID)?.doc).toEqual(buildXapixProfileDoc());
  });
});
