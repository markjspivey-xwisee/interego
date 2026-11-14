/**
 * cmi5 for a signed learner: which AU a learner launches (the one they name or the first they
 * have not satisfied, with sequential progression held), LMS.LaunchData staged where a conformant
 * AU reads it, a launch's own statements recognized only in that launch's tenant, and the LMS's
 * `satisfied` carrying no grading tag, since a cmi5 AU reports its own result.
 */
import { describe, expect, it } from 'vitest';
import { buildCmi5Launch, chooseAu, findResumableLaunch, launchParametersFrom, observeCmi5Statement, recordLaunchedStatement, signedLaunchLearner, stageLaunchData } from '../src/cmi5-lms.js';
import { parseCmi5Course } from '../src/cmi5-course.js';
import { getStatementStore, readStateDocument } from '../src/xapi-lrs.js';
import { GRADED_TAG_EXT } from '../src/graded-evidence.js';
import type { Cmi5Course } from '../src/cmi5-course.js';
import type { TenantId } from '../src/tenant-context.js';

const course: Cmi5Course = {
  id: 'https://bridge.example/course/c1', title: 'Course one',
  structure: [
    { kind: 'au', id: 'https://bridge.example/au/1', title: 'First', url: 'https://bridge.example/content/au/p/0', moveOn: 'Completed' },
    { kind: 'au', id: 'https://bridge.example/au/2', title: 'Second', url: 'https://bridge.example/content/au/p/1', moveOn: 'Passed', masteryScore: 0.6 },
  ],
};
const [first, second] = ['https://bridge.example/au/1', 'https://bridge.example/au/2'];

describe('which AU a learner launches', () => {
  it('is the first they have not satisfied, and the first again for review once all are', () => {
    expect(chooseAu(course, new Set())).toMatchObject({ ok: true, au: { id: first } });
    expect(chooseAu(course, new Set([first]))).toMatchObject({ ok: true, au: { id: second } });
    expect(chooseAu(course, new Set([first, second]))).toMatchObject({ ok: true, au: { id: first } });
  });
  it('holds sequential progression for a named AU, naming what comes first', () => {
    expect(chooseAu(course, new Set(), second)).toEqual({ ok: false, status: 409, error: expect.stringContaining(first), missingPrerequisites: [first] });
    expect(chooseAu(course, new Set([first]), second)).toMatchObject({ ok: true, au: { id: second } });
  });
  it('is refused for an AU or a course that is not there', () => {
    expect(chooseAu(course, new Set(), 'https://bridge.example/au/9')).toMatchObject({ ok: false, status: 404 });
    expect(chooseAu({ ...course, structure: [] }, new Set())).toMatchObject({ ok: false, status: 404 });
  });
});

describe('a signed learner\'s launch', () => {
  const tenant = 'lens:learner-a' as TenantId;
  const launch = buildCmi5Launch({
    au: { id: second, url: 'https://bridge.example/content/au/p/1', moveOn: 'Passed', masteryScore: 0.6, title: 'Second' },
    learner: { id: 'did:ethr:0x1111111111aa00000000000000000000000beef1' },
    lrsEndpoint: 'https://bridge.example/xapi', fetchBaseUrl: 'https://bridge.example/cmi5/fetch',
    authoritativeSource: 'did:web:bridge.example', tenant, courseId: course.id, learnerPod: 'https://pod.example/eth-1111111111aa/',
  });

  it('stages LMS.LaunchData under the address a conformant AU reads it from', async () => {
    await stageLaunchData(tenant, launch, second);
    const q = new URL(launch.launchUrl).searchParams;
    // The AU re-serializes the actor it parsed from its launch URL; the key must survive that.
    const agent = JSON.stringify(JSON.parse(q.get('actor') ?? '{}'));
    expect(await readStateDocument(tenant, { activityId: q.get('activityId') ?? '', agent, stateId: 'LMS.LaunchData', registration: q.get('registration') ?? '' })).toEqual(launch.launchData);
    expect(launch.launchData).toMatchObject({ moveOn: 'Passed', masteryScore: 0.6, contextTemplate: { registration: launch.registration } });
  });

  it('is recognized as the learner\'s own only in its own tenant', () => {
    expect(signedLaunchLearner(launch.registration, tenant)).toEqual({ did: 'did:ethr:0x1111111111aa00000000000000000000000beef1', podUrl: 'https://pod.example/eth-1111111111aa/', homePage: 'did:web:bridge.example' });
    // A statement that names this registration from another auth-token arrives in another tenant.
    expect(signedLaunchLearner(launch.registration, 'lens:someone-else' as TenantId)).toBeUndefined();
    const operatorLaunch = buildCmi5Launch({ au: { id: first, url: 'https://bridge.example/content/au/p/0' }, learner: { id: 'did:ethr:0x2' }, lrsEndpoint: 'x', fetchBaseUrl: 'y', authoritativeSource: 'z', tenant });
    expect(signedLaunchLearner(operatorLaunch.registration, tenant)).toBeUndefined();
  });

  it('meets moveOn from the AU\'s own report, and the LMS\'s satisfied carries no grading tag', async () => {
    const emitted: Record<string, unknown>[] = [];
    const passed = { actor: launch.actor, verb: { id: 'http://adlnet.gov/expapi/verbs/passed' }, object: { id: second }, result: { success: true, score: { scaled: 0.8 } }, context: { registration: launch.registration } };
    const deps = { statementsForRegistration: async () => [passed], emit: (s: Record<string, unknown>) => { emitted.push(s); } };
    expect(await observeCmi5Statement(passed, 'lens:someone-else' as TenantId, deps)).toBeNull();
    const r = await observeCmi5Statement(passed, tenant, deps);
    expect(r).toMatchObject({ satisfied: true, emittedSatisfied: true });
    const satisfied = emitted.find((s) => (s.verb as { id?: string }).id === 'https://w3id.org/xapi/adl/verbs/satisfied');
    expect(satisfied).toBeDefined();
    expect(JSON.stringify(satisfied)).not.toContain(GRADED_TAG_EXT);
  });
});

const LAUNCHED = 'http://adlnet.gov/expapi/verbs/launched';
const SESSION_EXT = 'https://w3id.org/xapi/cmi5/context/extensions/sessionid';

describe('the LMS launched statement', () => {
  const tenant = 'lens:learner-launched' as TenantId;
  const learner = 'did:ethr:0x1111111111aa00000000000000000000000beef2';
  const req = {
    au: { id: second, url: 'https://bridge.example/content/au/p/1?already=1', moveOn: 'Passed' as const, masteryScore: 0.6, title: 'Second' },
    learner: { id: learner },
    lrsEndpoint: 'https://bridge.example/xapi', fetchBaseUrl: 'https://bridge.example/cmi5/fetch',
    authoritativeSource: 'did:web:bridge.example', tenant, courseId: course.id, learnerPod: 'https://pod.example/eth-1111111111aa/',
  };
  const scope = { tenant, learnerId: learner, courseId: course.id, auId: second };

  it('is stored once for a session, skipped when that session resumes, and stored again for a new session of the same registration', async () => {
    const first = buildCmi5Launch(req);
    const extensions = (first.launched?.context as { extensions: Record<string, unknown> }).extensions;
    expect(first.launched).toMatchObject({
      verb: { id: LAUNCHED },
      actor: first.actor,
      object: { id: second, objectType: 'Activity' },
      context: {
        registration: first.registration,
        contextActivities: { category: [{ id: 'https://w3id.org/xapi/cmi5/context/categories/cmi5', objectType: 'Activity' }] },
      },
    });
    expect(extensions).toMatchObject({
      [SESSION_EXT]: expect.any(String),
      'https://w3id.org/xapi/cmi5/context/extensions/launchmode': 'Normal',
      'https://w3id.org/xapi/cmi5/context/extensions/launchurl': req.au.url,
      'https://w3id.org/xapi/cmi5/context/extensions/moveon': 'Passed',
      'https://w3id.org/xapi/cmi5/context/extensions/masteryscore': 0.6,
    });
    expect(String(extensions['https://w3id.org/xapi/cmi5/context/extensions/launchurl'])).not.toContain('endpoint=');
    expect(first.launchUrl).toContain('endpoint=');
    await recordLaunchedStatement(tenant, first.launched!);

    const resumed = buildCmi5Launch({ ...req, resume: findResumableLaunch(scope) });
    expect(resumed.registration).toBe(first.registration);
    expect(resumed.launched).toBeUndefined();

    await observeCmi5Statement({ verb: { id: 'http://adlnet.gov/expapi/verbs/terminated' }, context: { registration: first.registration } }, tenant, { statementsForRegistration: async () => [], emit: () => undefined });
    const restarted = buildCmi5Launch({ ...req, resume: findResumableLaunch(scope) });
    expect(restarted.registration).toBe(first.registration);
    expect(restarted.launched).toBeDefined();
    const nextSession = (restarted.launched?.context as { extensions: Record<string, unknown> }).extensions[SESSION_EXT];
    expect(nextSession).not.toBe(extensions[SESSION_EXT]);
    await recordLaunchedStatement(tenant, restarted.launched!);

    const held = await getStatementStore(tenant).query({ registration: first.registration, limit: 20 });
    const launched = held.statements.filter(s => (s.statement.verb as { id?: string }).id === LAUNCHED);
    expect(launched).toHaveLength(2);
    expect(launched.map(s => (s.statement.context as { extensions: Record<string, unknown> }).extensions[SESSION_EXT]).sort())
      .toEqual([extensions[SESSION_EXT], nextSession].sort());
  });
});

describe('launchParameters', () => {
  const xml = `<?xml version="1.0"?><courseStructure>
    <course id="urn:course:params"><title><langstring lang="en-US">Params</langstring></title></course>
    <au id="https://au.example/with" moveOn="Completed"><title><langstring>With</langstring></title><url>https://content.example/with</url><launchParameters>  mode=practice  </launchParameters></au>
    <au id="https://au.example/without" moveOn="Completed"><title><langstring>Without</langstring></title><url>https://content.example/without</url></au>
  </courseStructure>`;

  it('reads the course structure\'s string and lets a launch request replace it', () => {
    const parsed = parseCmi5Course(xml);
    expect(parsed.structure.map(n => n.kind === 'au' ? n.launchParameters : undefined)).toEqual(['mode=practice', undefined]);
    expect(launchParametersFrom('mode=practice', undefined)).toEqual({ ok: true, value: 'mode=practice' });
    expect(launchParametersFrom('mode=practice', 'mode=exam')).toEqual({ ok: true, value: 'mode=exam' });
    expect(launchParametersFrom('mode=practice', null)).toEqual({ ok: true });
    expect(launchParametersFrom('mode=practice', 7)).toEqual({ ok: false, error: expect.stringContaining('string') });
    expect(() => parseCmi5Course(xml.replace('mode=practice', 'x'.repeat(8193)))).toThrow(/launchParameters/);
  });

  it('stages the value in LMS.LaunchData, and omits it when the activity has none', async () => {
    const lens = 'lens:launch-parameters' as TenantId;
    const withIt = buildCmi5Launch({
      au: { id: 'https://au.example/with', url: 'https://content.example/with', launchParameters: 'mode=practice' },
      learner: { id: 'did:ethr:0x1111111111111111111111111111111111111111' },
      lrsEndpoint: 'https://bridge.example/xapi', fetchBaseUrl: 'https://bridge.example/cmi5/fetch',
      authoritativeSource: 'did:web:bridge.example', tenant: lens, courseId: course.id,
    });
    expect(withIt.launchData.launchParameters).toBe('mode=practice');
    await stageLaunchData(lens, withIt, 'https://au.example/with');
    const q = new URL(withIt.launchUrl).searchParams;
    expect(await readStateDocument(lens, { activityId: 'https://au.example/with', agent: JSON.stringify(JSON.parse(q.get('actor') ?? '{}')), stateId: 'LMS.LaunchData', registration: withIt.registration })).toMatchObject({ launchParameters: 'mode=practice' });
    const without = buildCmi5Launch({
      au: { id: 'https://au.example/without', url: 'https://content.example/without' },
      learner: { id: 'did:ethr:0x1111111111111111111111111111111111111111' },
      lrsEndpoint: 'https://bridge.example/xapi', fetchBaseUrl: 'https://bridge.example/cmi5/fetch',
      authoritativeSource: 'did:web:bridge.example', tenant: lens,
    });
    expect(without.launchData).not.toHaveProperty('launchParameters');
  });
});

describe('the bridge wires the learner\'s own launch', () => {
  it('derives the learner from the signature, launches into their lens, stages launch data, and keeps statements only for the launch\'s own actor', async () => {
    const { readFileSync } = await import('node:fs');
    const src = readFileSync(new URL('../bridge/server.ts', import.meta.url), 'utf8');
    const route = src.slice(src.indexOf("app.post('/agent/cmi5/launch'"), src.indexOf("app.post('/agent/scorm/author'"));
    expect(route).toMatch(/verifyDelegatedCaller\(req\.body\)/);
    expect(route).toMatch(/const learner = await signedLearner\(auth\)/);
    expect(route).toMatch(/const tenant = lensTenantFor\(actorForPod\(learner\.podUrl, MESH_ACTOR_LABELS\)\)/);
    expect(route).toMatch(/stageLaunchData\(tenant, launch, au\.id\)/);
    expect(route).toMatch(/recordLaunchedStatement\(tenant, launch\.launched\)/);
    expect(route).toMatch(/launchParametersFrom\(au\.launchParameters, auth\.payload\.launch_parameters\)/);
    const lms = readFileSync(new URL('../src/cmi5-lms.ts', import.meta.url), 'utf8');
    expect(lms).toMatch(/await recordLaunchedStatement\(tenant, launch\.launched\)/);
    const link = readFileSync(new URL('../src/cmi5-personal-link.ts', import.meta.url), 'utf8');
    expect(link).toMatch(/if \(launch\.launched\) await recordLaunchedStatement\(tenant, launch\.launched\)/);
    expect(src).toMatch(/\(actor\?\.objectType \?\? 'Agent'\) !== 'Agent' \|\| actor\?\.account\?\.name !== learner\.did \|\| actor\?\.account\?\.homePage !== learner\.homePage/);
    expect(src).toMatch(/bearerRegistrationResolver: cmi5BearerRegistration/);
    expect(src).toMatch(/signedLaunchLearner\(reg, tenant\)/);
  });
});
