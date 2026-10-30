import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { IDENTITY_HOST_NAME, NativeIdentityHost } from '../src/native-identity-host.js';

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

describe('owner-only browser companion registration', () => {
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
