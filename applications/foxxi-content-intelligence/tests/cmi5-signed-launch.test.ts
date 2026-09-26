/**
 * cmi5 for a signed learner: which AU a learner launches (the one they name or the first they
 * have not satisfied, with sequential progression held), LMS.LaunchData staged where a conformant
 * AU reads it, a launch's own statements recognized only in that launch's tenant, and the LMS's
 * `satisfied` carrying no grading tag, since a cmi5 AU reports its own result.
 */
import { describe, expect, it } from 'vitest';
import { buildCmi5Launch, chooseAu, observeCmi5Statement, signedLaunchLearner, stageLaunchData } from '../src/cmi5-lms.js';
import { readStateDocument } from '../src/xapi-lrs.js';
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

  it('stages LMS.LaunchData under the address a conformant AU reads it from', () => {
    stageLaunchData(tenant, launch, second);
    const q = new URL(launch.launchUrl).searchParams;
    // The AU re-serializes the actor it parsed from its launch URL; the key must survive that.
    const agent = JSON.stringify(JSON.parse(q.get('actor') ?? '{}'));
    expect(readStateDocument(tenant, { activityId: q.get('activityId') ?? '', agent, stateId: 'LMS.LaunchData', registration: q.get('registration') ?? '' })).toEqual(launch.launchData);
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

describe('the bridge wires the learner\'s own launch', () => {
  it('derives the learner from the signature, launches into their lens, stages launch data, and keeps statements only for the launch\'s own actor', async () => {
    const { readFileSync } = await import('node:fs');
    const src = readFileSync(new URL('../bridge/server.ts', import.meta.url), 'utf8');
    const route = src.slice(src.indexOf("app.post('/agent/cmi5/launch'"), src.indexOf("app.post('/agent/scorm/author'"));
    expect(route).toMatch(/verifyDelegatedCaller\(req\.body\)/);
    expect(route).toMatch(/const learner = await signedLearner\(auth\)/);
    expect(route).toMatch(/const tenant = lensTenantFor\(actorForPod\(learner\.podUrl, MESH_ACTOR_LABELS\)\)/);
    expect(route).toMatch(/stageLaunchData\(tenant, launch, au\.id\)/);
    expect(src).toMatch(/\(actor\?\.objectType \?\? 'Agent'\) !== 'Agent' \|\| actor\?\.account\?\.name !== learner\.did \|\| actor\?\.account\?\.homePage !== learner\.homePage/);
    expect(src).toMatch(/bearerRegistrationResolver: cmi5BearerRegistration/);
    expect(src).toMatch(/signedLaunchLearner\(reg, tenant\)/);
  });
});
