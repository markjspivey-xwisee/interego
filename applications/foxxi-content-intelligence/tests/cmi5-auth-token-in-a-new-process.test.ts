/**
 * Two processes, one secret, one pod: the second takes the token the first handed out.
 *
 * `cmi5-auth-token-survives-a-restart.test.ts` shows the two halves apart: a token reads under the
 * same key with nothing stored, and the LMS resolves a token from the launch record. Neither is a
 * restart. Here the LMS module is loaded, a launch is made and its token redeemed, and the launch
 * snapshot it would have published is taken. Then every module is thrown away and loaded again, as
 * a new process would load it, with that snapshot as what the pod holds. The token is put to the
 * same four functions the LRS asks, before and after.
 *
 * The pod is stood in for at the snapshot publisher's edge: what the LMS registers to be collected
 * is what a later load is given back, through JSON, as a pod would return it.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { TenantId } from '../src/tenant-context.js';

const pod = vi.hoisted(() => ({ collect: undefined as undefined | (() => unknown), held: null as unknown }));
vi.mock('../src/pod-snapshot-publisher.js', async (original) => ({
  ...(await original<typeof import('../src/pod-snapshot-publisher.js')>()),
  registerSnapshot: (args: { surface: string; collect: () => unknown }) => { if (args.surface === 'cmi5') pod.collect = args.collect; },
  dirty: () => undefined,
  loadLatestSnapshot: async (surface: string) => (surface === 'cmi5' ? pod.held : null),
}));

const SECRET = 'the secret both processes are started with';
const tenant = 'lens:two-processes' as TenantId;
const learner = { id: 'did:ethr:0x4444444444dd00000000000000000000000beef4' };
const request = {
  au: { id: 'https://bridge.example/au/two-processes', url: 'https://bridge.example/content/au/two-processes', moveOn: 'Completed' as const, title: 'Two processes' },
  learner, lrsEndpoint: 'https://bridge.example/xapi', fetchBaseUrl: 'https://bridge.example/cmi5/fetch',
  authoritativeSource: 'did:web:bridge.example', tenant, courseId: 'https://bridge.example/course/two-processes',
};

/** A process: the LMS module loaded from nothing, started with a secret, its launches read back from the pod. */
async function startProcess(secret: string) {
  vi.resetModules();
  pod.collect = undefined;
  const lms = await import('../src/cmi5-lms.js');
  lms.configureCmi5AuthTokenSecret(secret);
  await lms.whenCmi5Ready();
  return lms;
}
/** What the process would have published: its launches, as the pod would hand them back. */
const published = (): unknown => JSON.parse(JSON.stringify(pod.collect!()));

/** The first process: a launch, its token handed to the unit, and its launches on the pod. */
async function firstProcess() {
  pod.held = null;
  const lms = await startProcess(SECRET);
  const launch = lms.buildCmi5Launch(request);
  const redeemed = lms.redeemFetchToken(launch.fetchToken);
  if (!redeemed.ok) throw new Error('fetch token did not redeem');
  const token = redeemed.body['auth-token'];
  const before = {
    tenant: lms.cmi5BearerTenant(token), registration: lms.cmi5BearerRegistration(token),
    actor: lms.cmi5BearerActor(token), session: lms.cmi5BearerSession(token),
  };
  return { launch, token, before, snapshot: published() };
}

afterEach(() => { vi.useRealTimers(); });

describe('a token handed out by one process, shown to the next', () => {
  it('is answered the same by a process with the same secret and the launches the pod holds', async () => {
    const first = await firstProcess();
    expect(first.before.registration).toBe(first.launch.registration);
    expect(first.before.session).toMatchObject({ closed: false, superseded: false });

    pod.held = first.snapshot;
    const lms = await startProcess(SECRET);
    expect({
      tenant: lms.cmi5BearerTenant(first.token), registration: lms.cmi5BearerRegistration(first.token),
      actor: lms.cmi5BearerActor(first.token), session: lms.cmi5BearerSession(first.token),
    }).toEqual(first.before);
    // The one-time fetch token is not carried over: a launch link made before the restart is made again.
    expect(lms.redeemFetchToken(first.launch.fetchToken)).toMatchObject({ ok: false, status: 404 });
  });

  it('is refused by a process started with another secret, or with none', async () => {
    const first = await firstProcess();
    pod.held = first.snapshot;
    const rotated = await startProcess('a secret rotated since');
    expect(rotated.cmi5BearerTenant(first.token)).toBeNull();
    expect(rotated.cmi5BearerActor(first.token)).toBeNull();
    const unset = await startProcess('');
    expect(unset.cmi5BearerTenant(first.token)).toBeNull();
    expect(unset.cmi5BearerSession(first.token)).toBeNull();
  });

  it('is refused by a process whose pod never received the launch', async () => {
    const first = await firstProcess();
    pod.held = null;
    const lms = await startProcess(SECRET);
    expect(lms.cmi5BearerTenant(first.token)).toBeNull();
    expect(lms.cmi5BearerRegistration(first.token)).toBeNull();
    expect(lms.cmi5BearerActor(first.token)).toBeNull();
  });

  it('is refused in the next process once it is past its time', async () => {
    const first = await firstProcess();
    pod.held = first.snapshot;
    const lms = await startProcess(SECRET);
    const { CMI5_AUTH_TOKEN_TTL_MS } = await import('../src/cmi5-auth-token.js');
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(Date.now() + CMI5_AUTH_TOKEN_TTL_MS - 60_000);
    expect(lms.cmi5BearerRegistration(first.token)).toBe(first.launch.registration);
    vi.setSystemTime(Date.now() + 120_000);
    expect(lms.cmi5BearerTenant(first.token)).toBeNull();
    expect(lms.cmi5BearerRegistration(first.token)).toBeNull();
  });

  it('is refused in the next process once the learner is forgotten there, and in the one after', async () => {
    const first = await firstProcess();
    pod.held = first.snapshot;
    const second = await startProcess(SECRET);
    second.forgetCmi5Learner(tenant, learner.id);
    expect(second.cmi5BearerTenant(first.token)).toBeNull();
    pod.held = published();
    const third = await startProcess(SECRET);
    expect(third.cmi5BearerTenant(first.token)).toBeNull();
    expect(third.cmi5BearerActor(first.token)).toBeNull();
  });

  it('is an earlier session\'s token in the next process once the registration has moved on to a later one', async () => {
    const first = await firstProcess();
    pod.held = first.snapshot;
    const lms = await startProcess(SECRET);
    // The unit ended its session without meeting moveOn; the learner opens the same registration again.
    const terminated = {
      actor: first.launch.actor, verb: { id: 'http://adlnet.gov/expapi/verbs/terminated' }, object: { id: request.au.id },
      context: { registration: first.launch.registration },
    };
    await lms.observeCmi5Statement(terminated, tenant, { statementsForRegistration: async () => [terminated], emit: () => undefined });
    const resumable = lms.findResumableLaunch({ tenant, learnerId: learner.id, courseId: request.courseId, auId: request.au.id });
    expect(resumable).toMatchObject({ registration: first.launch.registration, newSession: true });
    const again = lms.buildCmi5Launch({ ...request, resume: resumable! });
    expect(again.registration).toBe(first.launch.registration);
    const redeemed = lms.redeemFetchToken(again.fetchToken);
    if (!redeemed.ok) throw new Error('fetch token did not redeem');
    expect(lms.cmi5BearerSession(redeemed.body['auth-token'])).toMatchObject({ closed: false, superseded: false });
    expect(lms.cmi5BearerSession(first.token)).toMatchObject({ registration: first.launch.registration, closed: true, superseded: true });
  });
});
