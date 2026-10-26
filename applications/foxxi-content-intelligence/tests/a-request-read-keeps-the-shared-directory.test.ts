/**
 * A tool call's read of the tenant pod may share the directory it loaded, but it must not replace
 * the bridge's shared directory with anything else.
 *
 * ★ WHY. Every foxxi.* tool call reads the admin payload before any auth (autoFetchAdmin), and that
 * read used to write its `users` into the process-wide directory snapshot every operator gate reads.
 * Two things reached the snapshot that should not have:
 *
 *   - A directory the read could not load. fetchAdminPayload composes `users: []` for a closed
 *     tenant whose TenantDirectory section is unreadable (502, timeout, no key), and that empty
 *     default replaced the last good copy, so every signed-in operator got 401 for at least a minute.
 *   - A pod the caller named. The write was gated on samePod, which folds case and collapses
 *     slashes, so a caller's `tenant_pod_url` that differs from the configured pod only in case was
 *     read (from a path the pod server treats as different) and its result written to the snapshot.
 *
 * The read now passes a hook that fetchAdminPayload calls only with a directory section that loaded,
 * and the bridge builds that hook only for a read of exactly the configured pod URL.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';

const pod = vi.hoisted(() => ({
  entries: new Map<string, Array<{ descriptorUrl: string; conformsTo: string[] }>>(),
  descriptors: new Map<string, string>(),
  graphs: new Map<string, string>(),
}));

vi.mock('@interego/solid', async (original) => ({
  ...(await original<typeof import('@interego/solid')>()),
  discover: async (podUrl: string) => pod.entries.get(podUrl) ?? [],
  fetchGraphContent: async (url: string) => ({ content: pod.graphs.get(url) ?? null, encrypted: false, mediaType: 'application/trig' }),
}));
vi.mock('../src/ssrf-guard.js', () => ({
  assertSafeFetchTarget: async () => undefined,
  guardedFetchFn: (f: unknown) => f,
  // A descriptor the pod does not hold answers 502: the section is listed but cannot be read.
  safeFetch: async (url: string) => (pod.descriptors.has(url)
    ? new Response(pod.descriptors.get(url), { status: 200 })
    : new Response('', { status: 502, statusText: 'Bad Gateway' })),
  safePublicUrlOrUndefined: (u: string) => u,
  isPrivateHostname: () => false,
}));

const { fetchAdminPayload, invalidateTenantCache } = await import('../src/tenant-fetcher.js');
const { createDirectoryDemand, directoryObserverFor } = await import('../src/directory-demand.js');
const { TENANT_TYPES } = await import('../src/tenant-publisher.js');

const TENANT = 'https://gate.example/u-eth-abc/';
const OPERATOR = { user_id: 'operator', web_id: 'https://operator.example/profile#me', wallet_address: '0x1111111111111111111111111111111111111111' };
const INTRUDER = { user_id: 'intruder', web_id: 'https://intruder.example/me', wallet_address: '0x2222222222222222222222222222222222222222' };

/** List a TenantDirectory section on `podUrl`; `readable: false` lists it but answers 502 when read. */
function publishDirectory(podUrl: string, users: unknown[], readable = true): void {
  const descriptorUrl = `${podUrl}tenant/directory.ttl`;
  const graphUrl = `${podUrl}tenant/directory-graph.trig`;
  pod.entries.set(podUrl, [{ descriptorUrl, conformsTo: [TENANT_TYPES.TenantDirectory] }]);
  if (readable) pod.descriptors.set(descriptorUrl, `<> hydra:target <${graphUrl}> .`);
  pod.graphs.set(graphUrl, `<${graphUrl}#s> <${graphUrl}#bundleJson> "${Buffer.from(JSON.stringify({ users, groups: [] })).toString('base64')}" .`);
}

/** A directory that already holds the operator, and never reloads by itself during a test. */
function warmDirectory() {
  const directory = createDirectoryDemand(async () => { throw new Error('no reload expected'); });
  directory.observe([OPERATOR]);
  return directory;
}

/** What autoFetchAdmin does for a read of `podUrl` while the bridge is configured for TENANT. */
function readAsTheBridge(podUrl: string, directory: ReturnType<typeof warmDirectory>) {
  const onDirectoryLoaded = directoryObserverFor(podUrl, TENANT, directory);
  return fetchAdminPayload({ podUrl, authoritativeSource: 'did:web:gate.example' as never, forceClosed: true,
    ...(onDirectoryLoaded ? { onDirectoryLoaded } : {}) }) as Promise<{ users: unknown[] }>;
}

beforeEach(() => {
  pod.entries.clear(); pod.descriptors.clear(); pod.graphs.clear();
  invalidateTenantCache();
});

describe('a read of the configured pod shares only a directory it loaded', () => {
  it('a directory that loaded replaces the shared copy', async () => {
    const directory = warmDirectory();
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
      publishDirectory(variant, [INTRUDER]);
      await readAsTheBridge(variant, planted);
      expect(planted.read()).toEqual([OPERATOR]);
    });
  }

  it('no hook at all when the bridge has no configured pod', () => {
    expect(directoryObserverFor('', '', { observe: () => undefined })).toBeUndefined();
  });

  it('the bridge writes the shared directory only through this hook', () => {
    const server = readFileSync(new URL('../bridge/server.ts', import.meta.url), 'utf8');
    expect(server).not.toMatch(/directoryUsersCache\.observe\(/);
    expect(server).toContain('directoryObserverFor(podUrl, tenantPodUrl, directoryUsersCache)');
  });
});
