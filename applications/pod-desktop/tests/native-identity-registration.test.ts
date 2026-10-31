import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { IDENTITY_HOST_NAME, NativeIdentityHost } from '../src/native-identity-host.js';
import { BrowserExtensionStore } from '../src/browser-extensions.js';
import { IdentityBrowserPolicy } from '../src/identity-browser-policy.js';

const directories: string[] = [];
afterEach(async () => {
  for (const path of directories.splice(0)) if (dirname(resolve(path)) === resolve(tmpdir()) && basename(path).startsWith('interego-native-registration-')) await rm(path, { recursive: true, force: true });
});
async function fixture(foreign = false) {
  const root = await mkdtemp(join(tmpdir(), 'interego-native-registration-')); directories.push(root);
  const executable = join(root, 'Interego-Identity.exe'); await writeFile(executable, 'fixture');
  const calls: { file: string; args: readonly string[]; input?: string }[] = [];
  const registry = new Map<string, string>(); let refusal = false; let protectedReply = { code: 0, stdout: Buffer.alloc(100, 7).toString('base64') };
  const host = new NativeIdentityHost({ dataDir: root, executable, command: async (file, args, input) => {
    calls.push({ file, args, input });
    if (file === executable) return protectedReply;
    const key = args[1]!;
    if (args[0] === 'query') {
      const value = foreign ? 'C:\\OtherApp\\foreign.json' : registry.get(key);
      return value ? { code: 0, stdout: `\n    (Default)    REG_SZ    ${value}\r\n` } : { code: 1, stdout: '' };
    }
    if (args[0] === 'add') {
      if (refusal) return { code: 1, stdout: '' };
      registry.set(key, args[args.indexOf('/d') + 1]!); return { code: 0, stdout: '' };
    }
    if (args[0] === 'delete') { registry.delete(key); return { code: 0, stdout: '' }; }
    throw new Error('Unexpected registry operation.');
  } });
  return { host, root, executable, calls, registry, refuse: (value = true) => { refusal = value; }, protectedReply: (value: typeof protectedReply) => { protectedReply = value; } };
}

// Isolated policy bytes and injected registry commands; no Windows profile or registry is opened.
const protector = {
  protect: (value: string) => 'fixture:' + Buffer.from(value).toString('base64'),
  unprotect: (value: string) => {
    if (!value.startsWith('fixture:')) throw new Error('Fixture protected storage refused');
    return Buffer.from(value.slice('fixture:'.length), 'base64').toString();
  },
};
async function retainedPolicy(f: Awaited<ReturnType<typeof fixture>>, ids: readonly string[] | null) {
  const directory = join(f.root, 'allowed-extensions'); const store = new BrowserExtensionStore(directory, protector);
  if (ids !== null) await store.save(ids);
  let admitted = false;
  const saveAllowed = vi.fn((value: readonly string[]) => store.save(value));
  const policy = new IdentityBrowserPolicy({ loadAllowed: () => store.list(), saveAllowed,
    configureHost: value => f.host.configure(value), closing: () => false,
    revoke: () => { admitted = false; }, allowAdmission: () => { admitted = true; } });
  return { policy, store, saveAllowed, admitted: () => admitted, path: join(directory, 'browser-extensions.bin') };
}

describe('owner-only browser companion registration', () => {
  it('repairs a legacy uninstall deletion on restart using the identical protected owner policy', async () => {
    const f = await fixture(); const ids = ['a'.repeat(32), 'p'.repeat(32)]; const saved = await retainedPolicy(f, ids);
    await f.host.configure(ids); const manifest = await readFile(f.host.manifestPath, 'utf8');
    const policyBytes = await readFile(saved.path);
    const sentinel = join(f.root, 'retained-identity.sentinel'); await writeFile(sentinel, 'untouched fixture identity data');
    // Older uninstallers remove both registration values even during an in-place update.
    f.registry.clear(); f.calls.length = 0;
    await expect(saved.policy.reconcile()).resolves.toEqual(ids);
    expect([...f.registry.values()]).toEqual([f.host.manifestPath, f.host.manifestPath]);
    expect(await readFile(f.host.manifestPath, 'utf8')).toBe(manifest);
    expect(await readFile(saved.path)).toEqual(policyBytes); expect(saved.saveAllowed).not.toHaveBeenCalled();
    expect(await saved.store.list()).toEqual(ids); expect(saved.admitted()).toBe(true);
    expect(await readFile(sentinel, 'utf8')).toBe('untouched fixture identity data');
    const registered = [...f.registry.entries()];
    await expect(saved.policy.reconcile()).resolves.toEqual(ids);
    expect([...f.registry.entries()]).toEqual(registered); expect(await readFile(f.host.manifestPath, 'utf8')).toBe(manifest);
    expect(await readFile(saved.path)).toEqual(policyBytes); expect(saved.saveAllowed).not.toHaveBeenCalled();
  });

  it.each([{ name: 'missing', ids: null }, { name: 'disabled', ids: [] }])('does not touch registration for a $name saved policy', async ({ ids }) => {
    const f = await fixture(); const saved = await retainedPolicy(f, ids);
    f.registry.set('HKCU\\Software\\Google\\Chrome\\NativeMessagingHosts\\com.interego.identity', f.host.manifestPath);
    f.registry.set('HKCU\\Software\\Microsoft\\Edge\\NativeMessagingHosts\\com.interego.identity', 'C:\\OtherApp\\foreign.json');
    const before = [...f.registry.entries()];
    await expect(saved.policy.reconcile()).resolves.toEqual([]);
    expect(f.calls).toEqual([]); expect([...f.registry.entries()]).toEqual(before);
    expect(saved.admitted()).toBe(false); expect(saved.saveAllowed).not.toHaveBeenCalled();
    await expect(readFile(f.host.manifestPath)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it.each(['damaged', protector.protect(JSON.stringify(['*']))])('refuses unreadable or malformed retained policy without registry or policy writes (%#)', async bytes => {
    const f = await fixture(); const saved = await retainedPolicy(f, ['a'.repeat(32)]); await writeFile(saved.path, bytes);
    await expect(saved.policy.reconcile()).rejects.toThrow('could not be opened');
    expect(f.calls).toEqual([]); expect(f.registry.size).toBe(0); expect(await readFile(saved.path, 'utf8')).toBe(bytes);
    expect(saved.admitted()).toBe(false); expect(saved.saveAllowed).not.toHaveBeenCalled();
  });

  it('retained consent cannot replace another installation or lose its saved policy after a failed repair', async () => {
    const f = await fixture(true); const saved = await retainedPolicy(f, ['a'.repeat(32)]); const bytes = await readFile(saved.path);
    await expect(saved.policy.reconcile()).rejects.toThrow('Another Interego');
    expect(f.calls.every(call => call.args[0] === 'query')).toBe(true);
    await expect(readFile(f.host.manifestPath)).rejects.toMatchObject({ code: 'ENOENT' });
    expect(await readFile(saved.path)).toEqual(bytes); expect(saved.saveAllowed).not.toHaveBeenCalled(); expect(saved.admitted()).toBe(false);
  });

  it('does no registration until requested, then allows only exact owner-selected IDs', async () => {
    const f = await fixture(); expect(f.calls).toEqual([]);
    const ids = ['a'.repeat(32), 'p'.repeat(32)]; expect(await f.host.configure([...ids].reverse())).toEqual(ids);
    const manifest = JSON.parse(await readFile(f.host.manifestPath, 'utf8'));
    expect(manifest).toEqual({ name: IDENTITY_HOST_NAME, description: 'Interego local identity consent', path: f.executable,
      type: 'stdio', allowed_origins: ids.map(id => `chrome-extension://${id}/`) });
    expect([...f.registry.keys()]).toHaveLength(2);
    expect([...f.registry.keys()].every(key => key.startsWith('HKCU\\') && key.endsWith(IDENTITY_HOST_NAME))).toBe(true);
  });

  it('refuses to replace another installation’s registration or write its own manifest', async () => {
    const f = await fixture(true); await expect(f.host.configure(['a'.repeat(32)])).rejects.toThrow('Another Interego');
    await expect(f.host.configure([])).rejects.toThrow('Another Interego');
    expect(f.calls.every(call => call.args[0] === 'query')).toBe(true);
    await expect(readFile(f.host.manifestPath)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('removes only owned default values when disconnected and supports re-registration', async () => {
    const f = await fixture(); await f.host.configure(['a'.repeat(32)]);
    const key = [...f.registry.keys()][0]!; f.registry.set(key, f.host.manifestPath.toUpperCase()); await f.host.configure([]);
    expect(f.registry.size).toBe(0);
    expect(f.calls.filter(call => call.args[0] === 'delete').every(call => call.args.includes('/ve'))).toBe(true);
    await expect(readFile(f.host.manifestPath)).rejects.toMatchObject({ code: 'ENOENT' });
    await f.host.configure(['b'.repeat(32)]); expect(f.registry.size).toBe(2);
  });

  it('rejects wildcards, duplicate IDs and excess IDs before changing Windows settings', async () => {
    const f = await fixture();
    for (const ids of [['*'], ['a'.repeat(32), 'a'.repeat(32)], ['a', 'b', 'c', 'd', 'e'].map(value => value.repeat(32)), ['chrome-extension://' + 'a'.repeat(32)], ['z'.repeat(32)]]) {
      expect(() => f.host.configure(ids)).toThrow();
    }
    expect(f.calls).toEqual([]);
    f.refuse(); await expect(f.host.configure(['a'.repeat(32)])).rejects.toThrow('could not finish');
    f.refuse(false); expect(await f.host.configure(['b'.repeat(32)])).toEqual(['b'.repeat(32)]); expect(f.registry.size).toBe(2);
  });

  it('passes transport secrets only on the private protection pipe', async () => {
    const f = await fixture(); const secret = 'temporary transport credential';
    expect(await f.host.protectTicket(secret)).toMatch(/^[A-Za-z0-9+/]+=*$/);
    expect(f.calls).toEqual([{ file: f.executable, args: ['--protect-ticket'], input: secret }]);
    await expect(f.host.protectTicket('x'.repeat(4097))).rejects.toThrow('could not be created'); expect(f.calls).toHaveLength(1);
    for (const value of [{ code: 1, stdout: Buffer.alloc(100).toString('base64') }, { code: 0, stdout: 'plaintext private ticket' }, { code: 0, stdout: 'A'.repeat(65) }]) {
      f.protectedReply(value); await expect(f.host.protectTicket(secret)).rejects.toThrow('could not protect');
    }
  });
});
