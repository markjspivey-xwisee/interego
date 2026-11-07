import { afterEach, describe, expect, it } from 'vitest';
import { createCipheriv, createDecipheriv, randomBytes, randomUUID } from 'node:crypto';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { BridgeStateStore, validateBridgeState, type BridgeSavedState } from '../src/bridge-state.js';
import type { AgentProtector } from '../src/agent-types.js';

const directories: string[] = [];
function protector(): AgentProtector {
  const key = randomBytes(32);
  return {
    protect(value) { const nonce = randomBytes(12); const cipher = createCipheriv('aes-256-gcm', key, nonce);
      return Buffer.concat([nonce, cipher.update(value), cipher.final(), cipher.getAuthTag()]).toString('base64'); },
    unprotect(value) { const bytes = Buffer.from(value, 'base64'); const cipher = createDecipheriv('aes-256-gcm', key, bytes.subarray(0, 12));
      cipher.setAuthTag(bytes.subarray(-16)); return Buffer.concat([cipher.update(bytes.subarray(12, -16)), cipher.final()]).toString(); },
  };
}
function state(): BridgeSavedState {
  const clientId = randomBytes(32).toString('base64url'); const connectionId = randomUUID(); const familyId = randomUUID();
  return { version: 1, origin: 'https://private-pod.example', port: 48177, podBinding: 'owner-pod-fingerprint',
    configuration: { name: 'My private web connection', client: 'chatgpt-web', permissions: ['notes:read'], expiresInDays: 30 },
    clients: [{ id: clientId, name: 'Private app label', redirects: ['https://chatgpt.com/connector/callback'], expires: Date.now() + 86_400_000 }],
    families: [{ id: familyId, clientId, connectionId, scopes: ['notes:read'], expires: Date.now() + 86_400_000, refreshHash: randomBytes(32).toString('base64url') }],
    access: [[randomBytes(32).toString('base64url'), { familyId, expires: Date.now() + 60_000 }]],
    retired: [[randomBytes(32).toString('base64url'), { familyId, expires: Date.now() + 60_000 }]], connections: [connectionId] };
}
async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), 'interego-bridge-state-')); directories.push(directory);
  const protection = protector(); const options = { dataDir: directory, protector: protection, getPodBinding: async () => 'owner-pod-fingerprint' };
  return { directory, path: join(directory, 'oauth-state.json'), protection, options, store: new BridgeStateStore(options) };
}
afterEach(async () => {
  for (const directory of directories.splice(0)) if (dirname(resolve(directory)) === resolve(tmpdir()) && basename(directory).startsWith('interego-bridge-state-')) await rm(directory, { recursive: true, force: true });
});

describe('protected stable bridge authority', () => {
  it('atomically saves encrypted metadata and reloads it through a fresh store', async () => {
    const f = await fixture(); const saved = state(); expect(await f.store.load()).toBeNull();
    await f.store.save(saved);
    const file = await readFile(f.path, 'utf8');
    expect(file).not.toContain(saved.origin); expect(file).not.toContain(saved.configuration.name);
    expect(file).not.toContain(saved.families[0]!.refreshHash); expect(file).not.toContain(saved.connections[0]!);
    const reopened = new BridgeStateStore(f.options); expect(await reopened.load()).toEqual(saved);
    expect(await readdir(f.directory)).toEqual(['oauth-state.json']);
    await reopened.save(null); expect(await new BridgeStateStore(f.options).load()).toBeNull();
  });

  it('rejects damaged or unknown authority rather than treating it as an empty pairing store', async () => {
    const f = await fixture();
    await writeFile(f.path, '{broken'); await expect(f.store.load()).rejects.toThrow('could not be opened');
    await writeFile(f.path, JSON.stringify({ version: 1, ciphertext: f.protection.protect(JSON.stringify({ ...state(), pending: [{ code: 'never-resume-consent' }] })) }));
    await expect(f.store.load()).rejects.toThrow('could not be opened');
    await f.store.save(null); expect(await f.store.load()).toBeNull();
  });

  it('rejects scope escalation, foreign references, duplicate hashes and unsafe stable origins', () => {
    const saved = state();
    expect(() => validateBridgeState({ ...saved, origin: 'http://localhost:1234' })).toThrow();
    expect(() => validateBridgeState({ ...saved, configuration: { ...saved.configuration, expiresInDays: '30' } })).toThrow();
    expect(() => validateBridgeState({ ...saved, families: [{ ...saved.families[0], scopes: ['notes:create'] }] })).toThrow();
    expect(() => validateBridgeState({ ...saved, families: [{ ...saved.families[0], connectionId: randomUUID() }] })).toThrow();
    expect(() => validateBridgeState({ ...saved, access: [...saved.access, ...saved.access] })).toThrow();
    expect(() => validateBridgeState({ ...saved, access: [[saved.access[0]![0], { familyId: randomUUID(), expires: Date.now() }]] })).toThrow();
  });

  it('does not replace the previous authority when protected storage fails', async () => {
    const f = await fixture(); const saved = state(); await f.store.save(saved);
    const broken = new BridgeStateStore({ ...f.options, protector: { ...f.protection, protect() { throw new Error('not available'); } } });
    await expect(broken.save(null)).rejects.toThrow('not available');
    expect(await f.store.load()).toEqual(saved);
  });
});
