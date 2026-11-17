/**
 * The local pod survives Community Solid Server's hourly expired-entry sweep.
 *
 * Every expiring storage CSS builds (cookies, forgot-password records, ownership tokens, OIDC
 * adapter entries) is a WrappedExpiringStorage that sweeps once an hour by walking the internal
 * value storage under /.internal/. CSS 7.3 lists each container on that walk by running
 * `for await` over the container's body. Read through the full ResourceStore, that body is
 * Turtle, in which it finds no member, wrapped by the locking store in an object `for await`
 * cannot read. So the first sweep waited out the 6 s resource lock and crashed the process with
 * "callback is not a function". That happened on a freshly started pod with nothing signed in,
 * because CSS writes /.internal/ itself at boot, so the desktop pod server went down about an
 * hour after every start. config/file-pod.json now points that storage at the file backend, the
 * way CSS's own BackendKeyValueStorage reads the same container. That read takes no resource
 * lock on the documents the storage owns, which holds only while the gateway keeps out CSS's
 * account and OIDC routes, the only requests that write them; the first case pins that. The
 * locker's reader counts, which every pod read wrote under /.internal/locks/ and the sweep could
 * not read, now stay in memory; the last case sweeps while a read is open.
 *
 * An hour is too long to wait, so this runs three of the four sweeps directly, on the instances
 * CSS built for a real local node. The IdP adapter's has no @id to instantiate it by; it walks
 * the same storage.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { request } from 'node:http';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { AppRunner } from '@solid/community-server';
import { resolveDeploymentConfig } from '@interego/deployment-config';
import { startLocalNode, type LocalNode } from '@interego/local-node';

const STARTUP_MS = 120_000;
/** css:config/util/resource-locker/memory.json: an unreadable listing waits this long, then crashes. */
const LOCK_EXPIRY_MS = 6_000;

type Manager = { instantiate(id: string, settings?: Record<string, unknown>): Promise<unknown> };
type Sweeping = {
  set(key: string, value: unknown, expires?: number): Promise<unknown>;
  removeExpiredEntries(): Promise<void>;
};
type Storage = { get(key: string): Promise<unknown> };

describe('the local pod survives the hourly expired-entry sweep', () => {
  let fixtureDir: string;
  let node: LocalNode | undefined;
  let manager: Manager | undefined;
  let settings: Record<string, unknown> = {};
  // startLocalNode builds CSS itself, so capture the components manager it creates.
  const runner = AppRunner.prototype as unknown as { createComponentsManager(...args: unknown[]): Promise<Manager> };
  const createManager = runner.createComponentsManager;

  /** A request whose path reaches the gateway exactly as written. */
  const raw = async (path: string, credential: string): Promise<{ status: number; body: string }> => {
    const origin = new URL(node!.baseUrl);
    return new Promise((done, fail) => {
      const pending = request({
        hostname: origin.hostname, port: origin.port, path,
        headers: { authorization: `Bearer ${credential}`, accept: 'text/turtle' },
      }, (response) => {
        let body = '';
        response.setEncoding('utf8');
        response.on('data', (chunk: string) => { body += chunk; });
        response.once('end', () => done({ status: response.statusCode ?? 0, body }));
      });
      pending.once('error', fail);
      pending.end();
    });
  };
  const get = async <T>(id: string): Promise<T> => {
    if (!manager) throw new Error('The components manager was not captured.');
    // Built during startup and cached by id, so these are the instances the running pod uses.
    return (await manager.instantiate(`urn:solid-server:default:${id}`, settings)) as T;
  };
  // A sweep that waits for the lock does not return late: it never returns, and the process
  // crashes when the lock expires. So each sweep races a budget of half the lock, and fails by name.
  const sweepAll = async (): Promise<void> => {
    for (const id of ['CookieStorage', 'ForgotPasswordStorage', 'ExpiringTokenStorage']) {
      const storage = await get<Sweeping>(id);
      let timer: NodeJS.Timeout | undefined;
      const budget = new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`${id}'s sweep took ${LOCK_EXPIRY_MS / 2} ms: it waited for the resource lock`)), LOCK_EXPIRY_MS / 2);
      });
      try { await Promise.race([storage.removeExpiredEntries(), budget]); }
      finally { clearTimeout(timer); }
    }
  };

  beforeAll(async () => {
    runner.createComponentsManager = async function (this: unknown, ...args: unknown[]) {
      manager = await createManager.apply(this, args);
      const instantiate = manager.instantiate.bind(manager);
      manager.instantiate = async (id, given = {}) => { settings = given; return instantiate(id, given); };
      return manager;
    };
    fixtureDir = await mkdtemp(join(tmpdir(), 'interego-local-node-sweep-'));
    node = await startLocalNode(resolveDeploymentConfig({
      profile: 'local', dataDir: join(fixtureDir, 'persistent'),
    }), { port: 0, startupTimeoutMs: STARTUP_MS });
  }, STARTUP_MS + 30_000);

  afterAll(async () => {
    try { await node?.stop(); }
    finally {
      runner.createComponentsManager = createManager;
      // Only remove this test's own newly created temporary directory.
      if (fixtureDir && dirname(resolve(fixtureDir)) === resolve(tmpdir())
        && basename(fixtureDir).startsWith('interego-local-node-sweep-')) {
        await rm(fixtureDir, { recursive: true, force: true });
      }
    }
  }, STARTUP_MS);

  it('never forwards the routes that write /.internal/ on request', async () => {
    // config/file-pod.json reads /.internal/ without the resource lock, which is safe only while
    // nothing but CSS's own boot and sweeps writes the documents there. CSS's account and OIDC
    // routes are the requests that write them, and the gateway answers everything outside the
    // pod's path itself.
    for (const path of ['/.account/', '/.account/login/password/', '/.oidc/reg', '/.internal/', '/.well-known/openid-configuration']) {
      const response = await node!.fetch(new URL(path, node!.baseUrl), { headers: { accept: 'text/turtle' } });
      expect(response.status, path).toBe(404);
      expect(await response.text(), path).toBe('No local pod resource at this path.');
    }
    // Sent as written, not normalised by a client first: the gateway resolves dot segments,
    // percent-encoded ones included, before it compares the path with the pod's.
    const credential = (await readFile(join(fixtureDir, 'persistent', 'service-credential'), 'utf8')).trim();
    const pod = new URL(node!.podUrl).pathname;
    for (const path of [`${pod}../.account/`, `${pod}%2e%2e/.oidc/reg`, `${pod}.%2e/.internal/`, `${pod}%2E%2E/.internal/`]) {
      const response = await raw(path, credential);
      expect(response.status, path).toBe(404);
      expect(response.body, path).toBe('No local pod resource at this path.');
    }
    // An empty segment before the dots resolves inside the pod, so CSS answers for a pod resource.
    const inside = await raw(`${pod}/../.account/`, credential);
    expect(inside.status).toBe(404);
    expect(inside.body).not.toBe('No local pod resource at this path.');
    expect(inside.body).not.toContain('"controls"');
  });

  it('sweeps a freshly started pod at once, and the pod keeps serving', async () => {
    await sweepAll();
    const response = await node!.fetch(node!.podUrl, { headers: { accept: 'text/turtle' } });
    expect(response.status).toBe(200);
    await response.text();
  });

  it('deletes the expired cookie and keeps the live one', async () => {
    const cookies = await get<Sweeping>('CookieStorage');
    await cookies.set('expired', { accountId: 'a' }, 100);
    await cookies.set('live', { accountId: 'b' }, 60 * 60 * 1000);
    await new Promise((done) => setTimeout(done, 250));
    await sweepAll();
    // Read underneath the expiring wrapper: its own get() deletes on read and would hide the sweep.
    const internal = await get<Storage>('KeyValueStorage');
    expect(await internal.get('accounts/cookies/expired')).toBeUndefined();
    expect(await internal.get('accounts/cookies/live')).toBeDefined();
  });

  it('sweeps while a pod read is still open', async () => {
    const resource = new URL('sweep-open-read.bin', node!.podUrl);
    const body = Buffer.alloc(8 * 1024 * 1024, 7);
    const put = await node!.fetch(resource, { method: 'PUT', headers: { 'content-type': 'application/octet-stream' }, body });
    expect(put.ok, `PUT answered ${put.status}`).toBe(true);
    await put.arrayBuffer();
    // The body is left unread, so CSS keeps this read's lock, and its reader count, until it is.
    const open = await node!.fetch(resource);
    expect(open.status).toBe(200);
    try {
      await sweepAll();
      expect((await open.arrayBuffer()).byteLength).toBe(body.length);
    } finally {
      await open.body?.cancel().catch(() => undefined);
    }
  });
});
