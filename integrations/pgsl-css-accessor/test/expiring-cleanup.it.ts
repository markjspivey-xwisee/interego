/**
 * Expired-entry sweep over the REAL pgsl-server.json wiring.
 *
 * Live, the hourly WrappedExpiringStorage sweep failed four times an hour (cookies,
 * forgot-password, IdP adapter, ownership tokens) with
 *   "Failed to remove expired entries - Cannot read properties of undefined (reading 'startsWith')"
 * so nothing expired was ever deleted. The internal value storage walks every document
 * under /.internal/, and reader counts GreedyReadWriteLocker left in /.internal/locks/
 * while LockStorage was still pod-backed are bare numbers with no `key`, which reached
 * ContainerPathStorage as an undefined key.
 *
 * This boots CSS from config/pgsl-server.json, plants such a counter through the exact
 * chain LockStorage used to have, and runs each named sweep on the instances CSS built.
 * Plain tsx script (no vitest in this isolated dir), like the other harnesses here.
 */
import assert from 'node:assert/strict';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import type { Readable } from 'node:stream';
import {
  AppRunner, ContainerPathStorage, HashEncodingStorage, isContainerIdentifier, type KeyValueStorage,
  type ResourceIdentifier, type ResourceStore,
} from '@solid/community-server';
import { PipedJsonResourceStorage } from '../src/PipedJsonResourceStorage.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const pkgRoot = path.join(here, '..');
const configPath = path.join(pkgRoot, 'config', process.env.PGSL_CSS_CONFIG ?? 'pgsl-server.json');
const port = 3457;
const baseUrl = `http://localhost:${port}/`;

type Manager = { instantiate(id: string, settings?: Record<string, unknown>): Promise<unknown> };
type Sweeping = KeyValueStorage<string, unknown> & {
  set(key: string, value: unknown, expires?: number): Promise<unknown>;
  removeExpiredEntries(): Promise<void>;
};

async function main(): Promise<void> {
  const runner = new AppRunner();
  let manager: Manager | undefined;
  let settings: Record<string, unknown> = {};
  const createManager = Reflect.get(runner, 'createComponentsManager') as (...args: unknown[]) => Promise<Manager>;
  Object.defineProperty(runner, 'createComponentsManager', { value: async (...args: unknown[]) => {
    manager = await createManager.apply(runner, args);
    // Keep the CLI variables (baseUrl, ...) the app was built with, for the ids looked up below.
    const instantiate = manager.instantiate.bind(manager);
    manager.instantiate = async (id, given = {}) => { settings = given; return instantiate(id, given); };
    return manager;
  } });
  const app = await runner.create({
    loaderProperties: { mainModulePath: pkgRoot, typeChecking: false },
    config: configPath,
    shorthand: { port, baseUrl, loggingLevel: 'error', rootFilePath: path.join(os.tmpdir(), `pgsl-expiry-${Date.now()}`) },
  });
  await app.start();
  try {
    assert.ok(manager, 'the components manager was captured');
    // Built during create() and cached by id, so these are the instances the running server uses.
    const get = async <T>(id: string): Promise<T> => (await manager!.instantiate(`urn:solid-server:default:${id}`, settings)) as T;
    const backend = await get<KeyValueStorage<string, unknown>>('BackendKeyValueStorage');
    const internal = await get<KeyValueStorage<string, unknown>>('KeyValueStorage');
    const cookies = await get<Sweeping>('CookieStorage');
    const sweeps = [cookies, await get<Sweeping>('ForgotPasswordStorage'), await get<Sweeping>('ExpiringTokenStorage')];

    // A reader count left behind by the former LockStorage (stock storages.json chain).
    const formerLockStorage = new HashEncodingStorage(new ContainerPathStorage(backend, '/locks/'));
    await formerLockStorage.set(`${baseUrl}some-resource.count`, 1);

    await cookies.set('expired', { accountId: 'a' }, 100);
    await cookies.set('live', { accountId: 'b' }, 60 * 60 * 1000);
    await new Promise((resolve) => setTimeout(resolve, 250));

    // CSS 7.3 lists /.internal/ with `for await` over the locking store's stream. Unpatched, that
    // listing waits for the resource lock to expire (90 s in pgsl-server.json) and then crashes the
    // process, so the sweep never returns at all; PipedJsonResourceStorage reads it through a pipe.
    // Each sweep here takes milliseconds, and races a 10 s budget so a waiting one fails by name.
    for (const storage of sweeps) {
      let timer: NodeJS.Timeout | undefined;
      const budget = new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error('a sweep took 10 s: it waited for the lock')), 10_000);
      });
      try { await Promise.race([storage.removeExpiredEntries(), budget]); }
      finally { clearTimeout(timer); }
    }

    // Read underneath the expiring wrapper: its own get() deletes on read and would hide the sweep.
    assert.equal(await internal.get('accounts/cookies/expired'), undefined, 'the sweep deleted the expired cookie');
    assert.ok(await internal.get('accounts/cookies/live'), 'the sweep kept the unexpired cookie');
    assert.equal(await formerLockStorage.get(`${baseUrl}some-resource.count`), 1, 'the keyless counter is skipped, not touched');

    // A container's listing holds that container's read lock until it has been read to the end,
    // and only reading it renews the lock. A walk that visited each member while its parent's
    // listing was still open held the parent's lock, unrenewed, for as long as the member's own
    // sub-tree took; on PostgreSQL a long sub-tree outlasted the lock, which destroyed the listing
    // and failed the sweep. So no member may be fetched while a listing is still unread.
    const store = await get<ResourceStore>('ResourceStore');
    const listings: Readable[] = [];
    const fetchedWhileListing: string[] = [];
    const watched = new Proxy(store, {
      get(target, property, receiver): unknown {
        if (property !== 'getRepresentation') return Reflect.get(target, property, receiver);
        return async (identifier: ResourceIdentifier, ...rest: unknown[]) => {
          if (listings.some((listing) => !listing.readableEnded)) fetchedWhileListing.push(identifier.path);
          const representation = await Reflect.apply(target.getRepresentation, target, [identifier, ...rest]);
          if (isContainerIdentifier(identifier)) listings.push(representation.data);
          return representation;
        };
      },
    });
    // More members than the listing's pipe buffers hold, each a container of its own.
    const walk = new PipedJsonResourceStorage<number>(watched, baseUrl, '/.internal/walk-order/');
    const expected = Array.from({ length: 24 }, (_, i) => `c${String(i).padStart(2, '0')}/entry`);
    for (const [i, key] of expected.entries()) await walk.set(key, i);
    const walked: string[] = [];
    for await (const [key] of walk.entries()) walked.push(key);
    assert.deepEqual(walked.sort(), expected, 'the walk found every entry');
    assert.deepEqual(fetchedWhileListing, [], 'no member was fetched while a container listing was still unread');
    console.log('CSS-over-PGSL expired-entry sweep: ALL PASS');
  } finally {
    await app.stop();
  }
}

main().catch((e) => {
  console.error('CSS-over-PGSL expired-entry sweep FAILED:', e);
  process.exit(1);
});
