import { afterEach, describe, expect, it, vi } from 'vitest';
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { StableBridgeStore, parseTunnelToken, validateStableOrigin } from '../src/stable-bridge.js';
import type { AgentProtector } from '../src/agent-types.js';
import type { StableBridgeInput } from '../src/bridge-types.js';

const TOKEN = 'eyJ' + 'a'.repeat(80);
const directories: string[] = [];
const input: StableBridgeInput = { provider: 'cloudflare', origin: 'https://pod.example.com', token: TOKEN,
  policy: { client: 'chatgpt-web', name: 'ChatGPT web', permissions: ['notes:read'], expiresInDays: 30 } };
function protector(): AgentProtector {
  const key = randomBytes(32);
  return {
    protect(text) {
      const nonce = randomBytes(12); const cipher = createCipheriv('aes-256-gcm', key, nonce);
      return Buffer.concat([nonce, cipher.update(text, 'utf8'), cipher.final(), cipher.getAuthTag()]).toString('base64');
    },
    unprotect(text) {
      const bytes = Buffer.from(text, 'base64'); const cipher = createDecipheriv('aes-256-gcm', key, bytes.subarray(0, 12));
      cipher.setAuthTag(bytes.subarray(-16)); return Buffer.concat([cipher.update(bytes.subarray(12, -16)), cipher.final()]).toString('utf8');
    },
  };
}
async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), 'interego-stable-settings-')); directories.push(directory);
  const protection = protector(); const choosePort = vi.fn(async () => 45321);
  const store = new StableBridgeStore({ dataDir: directory, protector: protection, choosePort });
  return { store, directory, protection, choosePort, path: join(directory, 'stable-bridge.json') };
}
afterEach(async () => {
  vi.restoreAllMocks();
  for (const directory of directories.splice(0)) {
    if (dirname(resolve(directory)) === resolve(tmpdir()) && basename(directory).startsWith('interego-stable-settings-')) await rm(directory, { recursive: true, force: true });
  }
});

describe('saved bridge provider settings', () => {
  it('starts without an address or credential and preserves the protected setup across a new store instance', async () => {
    const f = await fixture(); expect(await f.store.get()).toBeNull(); expect(await f.store.view()).toBeNull();
    const view = await f.store.save(input);
    expect(view).toMatchObject({ provider: 'cloudflare', origin: input.origin, port: 45321, hasCredential: true, policy: input.policy });
    expect(view).not.toHaveProperty('token'); expect(JSON.stringify(view)).not.toContain(TOKEN);
    const bytes = await readFile(f.path, 'utf8'); expect(bytes).not.toContain(TOKEN); expect(bytes).not.toContain(input.origin);
    const reopened = new StableBridgeStore({ dataDir: f.directory, protector: f.protection, choosePort: async () => { throw new Error('must retain its port'); } });
    expect(await reopened.get()).toMatchObject({ token: TOKEN, port: 45321, policy: input.policy });
    expect(await reopened.view()).toEqual(view); expect(f.choosePort).toHaveBeenCalledOnce();
  });

  it('preserves a blank masked token and port only for the same provider and origin', async () => {
    const f = await fixture(); await f.store.save(input);
    await f.store.save({ ...input, token: '', origin: 'https://POD.example.com/', policy: { ...input.policy, name: 'Renamed app' } });
    expect(await f.store.get()).toMatchObject({ token: TOKEN, port: 45321, policy: { name: 'Renamed app' } });
    expect(f.choosePort).toHaveBeenCalledOnce();
    await expect(f.store.save({ ...input, origin: 'https://another.example.com', token: '' })).rejects.toThrow('token');
    expect((await f.store.view())?.origin).toBe(input.origin);
    f.choosePort.mockResolvedValue(45322);
    await f.store.save({ ...input, origin: 'https://another.example.com', token: 'b'.repeat(64) });
    expect(await f.store.get()).toMatchObject({ origin: 'https://another.example.com', token: 'b'.repeat(64), port: 45322 });
  });

  it('keeps externally managed credentials outside Interego and writes an encrypted empty tombstone on Forget', async () => {
    const f = await fixture();
    const external: StableBridgeInput = { provider: 'external', origin: input.origin, policy: input.policy };
    expect(await f.store.save(external)).toMatchObject({ hasCredential: false, provider: 'external', port: 45321 });
    expect(await f.store.get()).not.toHaveProperty('token');
    await expect(f.store.save({ ...external, token: TOKEN })).rejects.toThrow('own credentials');
    await f.store.clear(); expect(await f.store.view()).toBeNull();
    const wrapper = JSON.parse(await readFile(f.path, 'utf8')) as { version: number; ciphertext: string };
    expect(wrapper.version).toBe(1); expect(f.protection.unprotect(wrapper.ciphertext)).toBe('null');
  });

  it('accepts only a public HTTPS origin without a general proxy path or private address', () => {
    expect(validateStableOrigin(' https://Pod.Example.com:443/ ')).toBe('https://pod.example.com');
    expect(() => validateStableOrigin('https://temporary.trycloudflare.com')).toThrow('temporary');
    for (const value of ['http://pod.example.com', 'https://127.0.0.1', 'https://[::1]', 'https://2130706433',
      'https://localhost', 'https://pod.localhost', 'https://pod.internal', 'https://pod.home.arpa', 'https://pod.local',
      'https://pod.example.com:444', 'https://user:secret@pod.example.com', 'https://pod.example.com/mcp',
      'https://pod.example.com?key=x', 'https://pod.example.com/#fragment', 'https://pod..example.com']) {
      expect(() => validateStableOrigin(value)).toThrow('public HTTPS');
    }
  });

  it('parses a copied install command only as data and rejects shell syntax without exposing its contents', () => {
    expect(parseTunnelToken(TOKEN)).toBe(TOKEN);
    expect(parseTunnelToken(`cloudflared.exe service install ${TOKEN}`)).toBe(TOKEN);
    expect(parseTunnelToken(`cloudflared.exe service install ${TOKEN}\r\n`)).toBe(TOKEN);
    expect(parseTunnelToken(`cloudflared tunnel run --token '${TOKEN}'`)).toBe(TOKEN);
    for (const value of [`cloudflared.exe service install ${TOKEN}; malicious`, `$(echo ${TOKEN})`, `cloudflared.exe service install ${TOKEN}\nother`, 'short']) {
      let message = ''; try { parseTunnelToken(value); } catch (error) { message = String(error); }
      expect(message).toContain('Paste the tunnel token'); expect(message).not.toContain(TOKEN);
    }
  });

  it('fails closed on corrupt, oversized or differently protected settings and can explicitly forget them', async () => {
    const f = await fixture(); await f.store.save(input);
    const foreign = new StableBridgeStore({ dataDir: f.directory, protector: protector() });
    await expect(foreign.get()).rejects.toThrow('could not be opened');
    await writeFile(f.path, '{not a valid protected record');
    await expect(f.store.get()).rejects.toThrow('could not be opened');
    await f.store.clear(); expect(await f.store.get()).toBeNull();
    await writeFile(f.path, Buffer.alloc(128 * 1024 + 1)); await expect(f.store.get()).rejects.toThrow('could not be opened');
  });

  it('keeps the prior committed setup when protecting or choosing a new setup fails', async () => {
    const f = await fixture(); await f.store.save(input); const committed = await readFile(f.path);
    vi.spyOn(f.protection, 'protect').mockImplementationOnce(() => { throw new Error(`sensitive ${TOKEN}`); });
    await expect(f.store.save({ ...input, token: 'b'.repeat(64) })).rejects.toThrow('could not be saved');
    expect(await readFile(f.path)).toEqual(committed); expect((await f.store.get())?.token).toBe(TOKEN);
    f.choosePort.mockResolvedValue(80);
    await expect(f.store.save({ ...input, origin: 'https://another.example.com' })).rejects.toThrow('could not be saved');
    expect(await readFile(f.path)).toEqual(committed); expect((await readdir(f.directory)).filter(name => name.endsWith('.tmp'))).toEqual([]);
  });

  it('validates permissions independently of the consumer form and serializes simultaneous saves', async () => {
    const f = await fixture();
    await expect(f.store.save({ ...input, policy: { ...input.policy, permissions: [] } })).rejects.toThrow('permissions');
    await expect(f.store.save({ ...input, policy: { ...input.policy, permissions: ['notes:read', 'notes:read'] } })).rejects.toThrow('permissions');
    await Promise.all([f.store.save(input), f.store.save({ ...input, token: '', policy: { ...input.policy, name: 'Second request' } })]);
    expect(f.choosePort).toHaveBeenCalledOnce(); expect((await f.store.get())?.policy.name).toBe('Second request');
  });
});
