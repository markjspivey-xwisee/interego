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
import {
  AppRunner, ContainerPathStorage, HashEncodingStorage, type KeyValueStorage,
} from '@solid/community-server';

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

    for (const storage of sweeps) await storage.removeExpiredEntries();

    // Read underneath the expiring wrapper: its own get() deletes on read and would hide the sweep.
    assert.equal(await internal.get('accounts/cookies/expired'), undefined, 'the sweep deleted the expired cookie');
    assert.ok(await internal.get('accounts/cookies/live'), 'the sweep kept the unexpired cookie');
    assert.equal(await formerLockStorage.get(`${baseUrl}some-resource.count`), 1, 'the keyless counter is skipped, not touched');
    console.log('CSS-over-PGSL expired-entry sweep: ALL PASS');
  } finally {
    await app.stop();
  }
}

main().catch((e) => {
  console.error('CSS-over-PGSL expired-entry sweep FAILED:', e);
  process.exit(1);
});
