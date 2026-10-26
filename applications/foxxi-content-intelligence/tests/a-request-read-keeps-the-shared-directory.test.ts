/**
 * A tool call's read of the tenant pod may share the directory it loaded, but it must not replace
 * the bridge's shared directory with anything else, or with anything older than what it holds.
 *
 * ★ WHY. Every foxxi.* tool call reads the admin payload before any auth (autoFetchAdmin), and that
 * read used to write its `users` into the process-wide directory snapshot every operator gate reads.
 * Four things reached the snapshot that should not have:
 *
 *   - A directory the read could not load. fetchAdminPayload composes `users: []` for a closed
 *     tenant whose TenantDirectory section is unreadable (502, timeout, no key), and that empty
 *     default replaced the last good copy, so every signed-in operator got 401 for at least a minute.
 *   - A pod the caller named. The write was gated on samePod, which folds case and collapses
 *     slashes, so a caller's `tenant_pod_url` that differs from the configured pod only in case was
 *     read (from a path the pod server treats as different) and its result written to the snapshot.
 *   - An older read. The hook ran only after the slowest of eight sections, and the snapshot took
 *     whatever arrived last, stamped "now". A read that loaded the directory before a revocation but
 *     waited minutes on a sibling section put the revoked user back after a newer read had dropped
 *     them, and gave them a fresh five minutes.
 *   - An old cache entry presented as new. tenant-fetcher keeps a section for 60 s; a reload served
 *     from that cache was stamped with the time of the reload, so a revoked user could outlive the
 *     five-minute bound by up to a minute.
 *
 * These tests drive `readAdminPayload` and `loadConfiguredDirectory`, the functions bridge/server.ts
 * itself calls, and the last test pins server.ts to calling exactly those and nothing else.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';

const pod = vi.hoisted(() => ({
  entries: new Map<string, Array<{ descriptorUrl: string; conformsTo: string[] }>>(),
  descriptors: new Map<string, string>(),
  graphs: new Map<string, string>(),
  /** A descriptor or graph URL whose next fetch waits for this promise. */
  stalls: new Map<string, Promise<void>>(),
}));

vi.mock('@interego/solid', async (original) => ({
  ...(await original<typeof import('@interego/solid')>()),
  discover: async (podUrl: string) => pod.entries.get(podUrl) ?? [],
  // A stalled graph read answers late with what the pod held when it was asked.
  fetchGraphContent: async (url: string) => {
    const content = pod.graphs.get(url) ?? null;
    const stall = pod.stalls.get(url);
    if (stall) { pod.stalls.delete(url); await stall; }
    return { content, encrypted: false, mediaType: 'application/trig' };
  },
}));
vi.mock('../src/ssrf-guard.js', () => ({
  assertSafeFetchTarget: async () => undefined,
  guardedFetchFn: (f: unknown) => f,
  // A descriptor the pod does not hold answers 502: the section is listed but cannot be read.
  safeFetch: async (url: string) => {
    const stall = pod.stalls.get(url);
    if (stall) { pod.stalls.delete(url); await stall; }
    return pod.descriptors.has(url)
      ? new Response(pod.descriptors.get(url), { status: 200 })
      : new Response('', { status: 502, statusText: 'Bad Gateway' });
  },
  safePublicUrlOrUndefined: (u: string) => u,
  isPrivateHostname: () => false,
}));

const { fetchSection, invalidateTenantCache } = await import('../src/tenant-fetcher.js');
const { createDirectoryDemand, directoryObserverFor } = await import('../src/directory-demand.js');
const { loadConfiguredDirectory, readAdminPayload } = await import('../src/admin-payload-read.js');
const { TENANT_TYPES } = await import('../src/tenant-publisher.js');
const { deriveUserWallet, mintSessionToken } = await import('../src/auth.js');

const TENANT = 'https://gate.example/u-eth-abc/';
const SOURCE = 'did:web:gate.example' as never;
const SEED = 'shared-directory-private-test-seed';
const OPERATOR = { user_id: 'operator', web_id: 'https://operator.example/profile#me', wallet_address: deriveUserWallet('operator', SEED).address };
const INTRUDER = { user_id: 'intruder', web_id: 'https://intruder.example/me', wallet_address: '0x2222222222222222222222222222222222222222' };
const T0 = Date.parse('2026-10-26T12:00:00.000Z');

/** List a section on `podUrl`; `readable: false` lists it but answers 502 when read. */
function publishSection(podUrl: string, type: string, name: string, bundle: unknown, readable = true): string {
  const descriptorUrl = `${podUrl}tenant/${name}.ttl`;
  const graphUrl = `${podUrl}tenant/${name}-graph.trig`;
  const entries = (pod.entries.get(podUrl) ?? []).filter(e => e.descriptorUrl !== descriptorUrl);
  pod.entries.set(podUrl, [...entries, { descriptorUrl, conformsTo: [type] }]);
  if (readable) pod.descriptors.set(descriptorUrl, `<> hydra:target <${graphUrl}> .`);
  else pod.descriptors.delete(descriptorUrl);
  pod.graphs.set(graphUrl, `<${graphUrl}#s> <${graphUrl}#bundleJson> "${Buffer.from(JSON.stringify(bundle)).toString('base64')}" .`);
  return descriptorUrl;
}
const publishDirectory = (podUrl: string, users: unknown[], readable = true) =>
  publishSection(podUrl, TENANT_TYPES.TenantDirectory, 'directory', { users, groups: [] }, readable);
const directoryGraph = (podUrl: string) => `${podUrl}tenant/directory-graph.trig`;

/** Make the next fetch of `descriptorUrl` wait until the returned release is called. */
function stall(descriptorUrl: string): () => void {
  let release!: () => void;
  pod.stalls.set(descriptorUrl, new Promise<void>(resolve => { release = resolve; }));
  return release;
}
const settle = () => new Promise(resolve => setTimeout(resolve, 20));

/** A directory that never reloads by itself during a test. */
function quietDirectory() {
  return createDirectoryDemand(async () => { throw new Error('no reload expected'); });
}
function warmDirectory() {
  const directory = quietDirectory();
  directory.observe([OPERATOR]);
  return directory;
}

/** The read autoFetchAdmin performs for `podUrl` while the bridge is configured for TENANT. */
function readAsTheBridge(podUrl: string, directory: ReturnType<typeof quietDirectory>) {
  return readAdminPayload({ base: { authoritativeSource: SOURCE }, podUrl, configuredPodUrl: TENANT,
    forceClosed: true, directory }) as Promise<{ users: unknown[] }>;
}

beforeEach(() => {
  pod.entries.clear(); pod.descriptors.clear(); pod.graphs.clear(); pod.stalls.clear();
  invalidateTenantCache();
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(T0);
});
afterEach(() => { vi.useRealTimers(); });

describe('a read of the configured pod shares only a directory it loaded', () => {
  it('a directory that loaded replaces the shared copy', async () => {
    const directory = warmDirectory();
    vi.setSystemTime(T0 + 1);
    publishDirectory(TENANT, [INTRUDER]);
    const admin = await readAsTheBridge(TENANT, directory);
    expect(admin.users).toEqual([INTRUDER]);
    expect(directory.read()).toEqual([INTRUDER]);
  });

  it('★ an unreadable directory keeps the last good copy, though the composed payload is empty', async () => {
    const directory = warmDirectory();
    publishDirectory(TENANT, [INTRUDER], false);
    const admin = await readAsTheBridge(TENANT, directory);
    // The payload still fails closed for this request: a closed tenant with no readable directory has no users.
    expect(admin.users).toEqual([]);
    expect(directory.read()).toEqual([OPERATOR]);
    // A repeat call served from the payload cache does not write the empty default either.
    await readAsTheBridge(TENANT, directory);
    expect(directory.read()).toEqual([OPERATOR]);
  });

  it('a directory that was never published does not empty the shared copy', async () => {
    const directory = warmDirectory();
    const admin = await readAsTheBridge(TENANT, directory);
    expect(admin.users).toEqual([]);
    expect(directory.read()).toEqual([OPERATOR]);
  });
});

describe('★ an older read never replaces a newer one, and its age counts from when it was read', () => {
  it('a directory read before a revocation cannot come back while a sibling section of that read stalls', async () => {
    const directory = quietDirectory();
    publishDirectory(TENANT, [INTRUDER]);
    const release = stall(publishSection(TENANT, TENANT_TYPES.AuditLogStream, 'audit', []));
    const first = readAsTheBridge(TENANT, directory);
    await settle();
    // Shared as soon as the directory section settled, not after the stalled audit section.
    expect(directory.read()).toEqual([INTRUDER]);

    vi.setSystemTime(T0 + 120_000); // The admin revokes the intruder, and a fresh read sees it.
    publishDirectory(TENANT, []);
    invalidateTenantCache();
    await readAsTheBridge(TENANT, directory);
    expect(directory.read()).toEqual([]);

    vi.setSystemTime(T0 + 240_000); // The first read's audit section finally answers.
    release();
    expect((await first).users).toEqual([INTRUDER]); // That request's own payload is its own business.
    expect(directory.read()).toEqual([]);
  });

  it('a directory read that started before a newer one is ignored when it lands', async () => {
    const directory = quietDirectory();
    const release = stall(publishDirectory(TENANT, [INTRUDER]));
    const first = readAsTheBridge(TENANT, directory);
    await settle();
    expect(directory.read()).toEqual([]);

    vi.setSystemTime(T0 + 120_000);
    publishDirectory(TENANT, [OPERATOR]);
    invalidateTenantCache();
    await readAsTheBridge(TENANT, directory);
    expect(directory.read()).toEqual([OPERATOR]);

    vi.setSystemTime(T0 + 240_000);
    release();
    await first;
    expect(directory.read()).toEqual([OPERATOR]);
    // And the newer copy's own age still counts from its read at T0+120 s.
    vi.setSystemTime(T0 + 120_000 + 299_999);
    expect(directory.read()).toEqual([OPERATOR]);
    vi.setSystemTime(T0 + 120_000 + 300_000);
    expect(directory.read()).toEqual([]);
  });

  it('a reload served from the 60 s section cache is as old as the read that filled the cache', async () => {
    publishDirectory(TENANT, [OPERATOR]);
    const config = { podUrl: TENANT, authoritativeSource: SOURCE };
    // Another handler reads the directory section at T0; the result sits in tenant-fetcher's cache.
    await fetchSection(TENANT_TYPES.TenantDirectory, config);
    // The operator is revoked and the pod then becomes unreadable: every later read fails.
    pod.descriptors.clear();
    const directory = createDirectoryDemand(signal => loadConfiguredDirectory(config, signal));
    vi.setSystemTime(T0 + 59_000);
    const token = await mintSessionToken({ userId: OPERATOR.user_id, webId: OPERATOR.web_id, seed: SEED });
    expect((await directory.verifySession(token)).ok).toBe(true); // A cache hit, from the read at T0.
    vi.setSystemTime(T0 + 299_999);
    expect(directory.read()).toEqual([OPERATOR]);
    // Five minutes after the pod last showed the operator, not five minutes after the cache hit.
    vi.setSystemTime(T0 + 300_000);
    expect(directory.read()).toEqual([]);
    const late = await mintSessionToken({ userId: OPERATOR.user_id, webId: OPERATOR.web_id, seed: SEED });
    expect((await directory.verifySession(late)).ok).toBe(false);
  });
});

describe('★ an older read that lands late never displaces a newer one in the 60 s section cache', () => {
  // Without this, the late read's cache entry (stamped with its older start) is served for 60 s, and
  // the shared directory rejects every such hit as older than its copy: no refresh reaches the pod,
  // so a revocation is not seen until the copy goes stale and then every operator is refused.
  it('a refresh past ttl still reaches the pod and sees a revocation', async () => {
    publishDirectory(TENANT, [OPERATOR]);
    const config = { podUrl: TENANT, authoritativeSource: SOURCE };
    const directory = createDirectoryDemand(signal => loadConfiguredDirectory(config, signal));
    const release = stall(directoryGraph(TENANT));
    const first = readAsTheBridge(TENANT, directory); // Read A starts at T0 and stalls.
    await settle();

    vi.setSystemTime(T0 + 1_000); // An operator's request refreshes from the pod.
    const token = await mintSessionToken({ userId: OPERATOR.user_id, webId: OPERATOR.web_id, seed: SEED });
    expect((await directory.verifySession(token)).ok).toBe(true);

    vi.setSystemTime(T0 + 200_000); // The admin revokes the operator.
    publishDirectory(TENANT, []);
    vi.setSystemTime(T0 + 250_000); // Read A finally answers with what the pod held at T0.
    release();
    await first;
    expect(directory.read()).toEqual([OPERATOR]); // Older than the held copy: ignored.

    vi.setSystemTime(T0 + 251_000); // Past ttl: this refresh must read the pod, not A's late entry.
    const later = await mintSessionToken({ userId: OPERATOR.user_id, webId: OPERATOR.web_id, seed: SEED });
    expect((await directory.verifySession(later)).ok).toBe(false);
    expect(directory.read()).toEqual([]);
  });

  it('the composed admin payload is not replaced by a read that started before it', async () => {
    publishDirectory(TENANT, [INTRUDER]);
    const directory = quietDirectory();
    const release = stall(directoryGraph(TENANT));
    const first = readAsTheBridge(TENANT, directory); // Read A starts at T0 and stalls.
    await settle();

    vi.setSystemTime(T0 + 1_000); // The intruder is revoked; read B sees it.
    publishDirectory(TENANT, []);
    expect((await readAsTheBridge(TENANT, directory)).users).toEqual([]);

    vi.setSystemTime(T0 + 2_000);
    release();
    expect((await first).users).toEqual([INTRUDER]); // That request's own payload is its own business.
    // Every later caller within the payload's 60 s gets B's, not A's.
    expect((await readAsTheBridge(TENANT, directory)).users).toEqual([]);
  });
});

describe('★ a pod the caller names never writes the shared directory', () => {
  for (const variant of ['https://gate.example/U-ETH-ABC/', 'https://GATE.example/u-eth-abc/',
    'https://gate.example//u-eth-abc/', 'https://gate.example/u-eth-abc']) {
    it(`${variant} is not the configured pod for the shared directory`, async () => {
      expect(directoryObserverFor(variant, TENANT, { observe: () => { throw new Error('observed'); } })).toBeUndefined();
      // Whether that path answers with nothing or with a directory of its own, the shared copy stands.
      const empty = warmDirectory();
      expect((await readAsTheBridge(variant, empty)).users).toEqual([]);
      expect(empty.read()).toEqual([OPERATOR]);
      invalidateTenantCache();
      const planted = warmDirectory();
      vi.setSystemTime(T0 + 1);
      publishDirectory(variant, [INTRUDER]);
      expect((await readAsTheBridge(variant, planted)).users).toEqual([INTRUDER]);
      expect(planted.read()).toEqual([OPERATOR]);
    });
  }

  it('no hook at all when the bridge has no configured pod', () => {
    expect(directoryObserverFor('', '', { observe: () => undefined })).toBeUndefined();
  });

  it('the bridge reaches the shared directory only through these functions, with its own pod URL', () => {
    const server = readFileSync(new URL('../bridge/server.ts', import.meta.url), 'utf8');
    // The request-time read is exactly the tested function, called once, naming the configured pod.
    expect(server.match(/\breadAdminPayload\(/g)).toHaveLength(1);
    expect(server).toContain('readAdminPayload({ base: fetcherConfig(), podUrl, configuredPodUrl: tenantPodUrl,\n'
      + '      forceClosed, directory: directoryUsersCache })');
    expect(server).toContain('const directoryUsersCache = createDirectoryDemand(signal => loadConfiguredDirectory(fetcherConfig(), signal));');
    // No second route to the snapshot: no hook built or passed in server.ts, no raw admin read.
    for (const bypass of [/\bdirectoryObserverFor\b/, /\bonDirectoryLoaded\b/, /\bfetchAdminPayload\b/, /\bfetchSectionStamped\b/]) {
      expect(server).not.toMatch(bypass);
    }
    // Every other mention of the snapshot only reads it, verifies with it, or mounts its middleware.
    const uses = [...server.matchAll(/\bdirectoryUsersCache\b(.{0,40})/g)].map(m => m[1]);
    const allowed = [/^ = createDirectoryDemand\(/, /^ \}\) as FoxxiAdminPayload;/, /^\.read\(\)/, /^\.verifySession\(/, /^\.middleware\)/];
    expect(uses.filter(rest => !allowed.some(form => form.test(rest!)))).toEqual([]);
  });
});
