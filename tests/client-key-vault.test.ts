import { describe, expect, it, vi } from 'vitest';
import { webcrypto, createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { ClientKeyVault, type ClientKeyRecord, type ClientKeyStorage } from '../packages/core/src/crypto/client-vault.js';
import { generateKeyPair, openEncryptedEnvelope } from '../packages/core/src/crypto/encryption.js';
import { canonicalGraphDigest, canonicalGraphTriples } from '../packages/core/src/rdf/graph-digest.js';
import { readEncryptedGraph, readEncryptedGraphViaDiscovery } from '../deploy/mcp-relay/client/tool-client.js';

function localStorage(): ClientKeyStorage & { records: Map<string, ClientKeyRecord> } {
  const records = new Map<string, ClientKeyRecord>();
  return {
    records,
    async load(scope) { return records.get(scope) ?? null; },
    async create(scope, record) { if (!records.has(scope)) records.set(scope, structuredClone(record)); return records.get(scope)!; },
  };
}

describe('client-held encryption', () => {
  const scope = 'https://relay.example|did:example:alice';
  const passphrase = 'synthetic recovery passphrase';

  it('keeps the same key after reload and stores only an encrypted NaCl secret plus a non-extractable wrapping key', async () => {
    const store = localStorage();
    const first = new ClientKeyVault(scope, store, webcrypto);
    const publicKey = await first.create();
    const envelope = await first.seal('private browser content');
    const record = store.records.get(scope)!;
    expect(Object.keys(record).sort()).toEqual(['ciphertext', 'iv', 'publicKey', 'version', 'wrappingKey']);
    expect(record.wrappingKey.extractable).toBe(false);
    await expect(webcrypto.subtle.exportKey('raw', record.wrappingKey)).rejects.toThrow();
    const reloaded = new ClientKeyVault(scope, store, webcrypto);
    expect(await reloaded.create()).toBe(publicKey);
    expect(await reloaded.open(envelope)).toBe('private browser content');
    expect(openEncryptedEnvelope(envelope, generateKeyPair())).toBeNull();
  });

  it('seals separately for two real client keys; an unrelated relay key cannot open the result', async () => {
    const sender = new ClientKeyVault(scope, localStorage(), webcrypto);
    const recipient = new ClientKeyVault('https://relay.example|did:example:bob', localStorage(), webcrypto);
    await sender.create();
    const recipientKey = await recipient.create();
    const envelope = await sender.seal('shared client-only content', [recipientKey, recipientKey]);
    expect(envelope.wrappedKeys).toHaveLength(2);
    expect(await recipient.open(envelope)).toBe('shared client-only content');
    expect(await sender.open(envelope)).toBe('shared client-only content');
    expect(openEncryptedEnvelope(envelope, generateKeyPair())).toBeNull();
    const tampered = { ...envelope, content: { ...envelope.content, ciphertext: envelope.content.ciphertext.slice(0, -4) + 'AAAA' } };
    await expect(recipient.open(tampered)).rejects.toThrow();
  });

  it('refuses absent keys, unrelated recipients and failed persistence without a server fallback or silent key replacement', async () => {
    const empty = new ClientKeyVault(scope, localStorage(), webcrypto);
    await expect(empty.seal('nothing sent')).rejects.toThrow('no key');
    const store = localStorage();
    const broken = new ClientKeyVault(scope, { load: store.load, create: async () => { throw new Error('storage failed'); } }, webcrypto);
    await expect(broken.create()).rejects.toThrow('storage failed');
    expect(await broken.publicKey()).toBeNull();
    const a = new ClientKeyVault(scope, localStorage(), webcrypto), b = new ClientKeyVault(scope, localStorage(), webcrypto);
    await a.create(); await b.create();
    await expect(b.open(await a.seal('one recipient'))).rejects.toThrow('not a recipient');
    await expect(a.seal('bad recipient', ['not-a-key'])).rejects.toThrow('public key');
  });

  it('uses the atomically persisted key when two tabs enable encryption concurrently', async () => {
    const store = localStorage();
    const a = new ClientKeyVault(scope, store, webcrypto), b = new ClientKeyVault(scope, store, webcrypto);
    const [ak, bk] = await Promise.all([a.create(), b.create()]);
    expect(ak).toBe(bk);
    expect(await b.open(await a.seal('concurrent tabs'))).toBe('concurrent tabs');
  });

  it('restores encrypted recovery on a fresh client and rejects the wrong passphrase, identity, tampering and replacement of another key', async () => {
    const first = new ClientKeyVault(scope, localStorage(), webcrypto);
    const publicKey = await first.create();
    const envelope = await first.seal('survives loss of browser storage');
    const backup = await first.backup(passphrase);
    expect(JSON.stringify(backup)).not.toContain('secretKey');
    const recovered = new ClientKeyVault(scope, localStorage(), webcrypto);
    await expect(recovered.restore(backup, 'the wrong long passphrase')).rejects.toThrow();
    expect(await recovered.publicKey()).toBeNull();
    expect(await recovered.restore(backup, passphrase)).toBe(publicKey);
    expect(await recovered.open(envelope)).toBe('survives loss of browser storage');
    await expect(new ClientKeyVault('another identity', localStorage(), webcrypto).restore(backup, passphrase)).rejects.toThrow('current identity');
    const other = new ClientKeyVault(scope, localStorage(), webcrypto);
    const preserved = await other.create();
    await expect(other.restore(backup, passphrase)).rejects.toThrow('different key');
    expect(await other.publicKey()).toBe(preserved);
    await expect(recovered.restore({ ...backup, publicKey: generateKeyPair().publicKey }, passphrase)).rejects.toThrow();
    await expect(first.backup('short')).rejects.toThrow('12 characters');
  });

  it('binds encrypted local records to their identity and public key', async () => {
    const store = localStorage(), a = new ClientKeyVault(scope, store, webcrypto);
    await a.create(); const envelope = await a.seal('bound to local scope');
    store.records.set('other', store.records.get(scope)!);
    await expect(new ClientKeyVault('other', store, webcrypto).open(envelope)).rejects.toThrow();
  });

  it('keeps the existing canonical graph digest when using browser-compatible SHA-256', () => {
    const turtle = '<urn:test> <urn:label> "Unicode 🦊 and newline\\ntext" .';
    expect(canonicalGraphDigest(turtle)).toBe('graph-nquads-sha256:' + createHash('sha256').update(canonicalGraphTriples(turtle), 'utf8').digest('hex'));
  });

  it('ships exactly the shared client implementation in the browser bundle', () => {
    expect(execFileSync(process.execPath, ['tools/build-client-encryption.mjs', '--check'], { encoding: 'utf8' })).toContain('matches its source');
    expect(execFileSync(process.execPath, ['../../tools/build-client-encryption.mjs', '--check'], {
      cwd: 'deploy/mcp-relay', encoding: 'utf8',
    })).toContain('matches its source');
  });

  it('reads ciphertext using the read-side tool without asking a read-only connection to call act', async () => {
    const result = { encrypted: true, envelope: 'original ciphertext' };
    const call = vi.fn(async (name: string) => {
      if (name !== 'get_encrypted_graph') throw new Error('mcp:read cannot call act');
      return { structuredContent: result };
    });
    expect(await readEncryptedGraph(call, 'https://relay.example', 'https://pod.example/note.ttl', () => {})).toEqual(result);
    expect(call.mock.calls).toEqual([['get_encrypted_graph', { url: 'https://pod.example/note.ttl' }]]);
  });

  it('does not retry a denied encrypted read through the broader act tool', async () => {
    const call = vi.fn(async () => ({ isError: true, content: [{ type: 'text', text: '403 insufficient_scope' }] }));
    await expect(readEncryptedGraph(call, 'https://relay.example', 'https://pod.example/note.ttl', () => {})).rejects.toThrow('insufficient_scope');
    expect(call).toHaveBeenCalledTimes(1);
  });

  it('uses a discovered reader only when the host explicitly reports a stale tool list', async () => {
    const target = 'https://relay.example/tool/get_encrypted_graph';
    const call = vi.fn()
      .mockResolvedValueOnce({ isError: true, content: [{ type: 'text', text: 'Unknown tool: get_encrypted_graph' }] })
      .mockResolvedValueOnce({ 'hydra:member': [{ name: 'get_encrypted_graph', affordances: [{ method: 'POST', action: 'urn:iep:action:invoke:get_encrypted_graph', target }] }] })
      .mockResolvedValueOnce({ encrypted: true, envelope: 'ciphertext' });
    expect(await readEncryptedGraph(call, 'https://relay.example', 'https://pod.example/note.ttl', () => {})).toEqual({ encrypted: true, envelope: 'ciphertext' });
    expect(call.mock.calls.map(args => args[0])).toEqual(['get_encrypted_graph', 'act', 'act']);
    expect(call.mock.lastCall?.[1]).toMatchObject({ target, method: 'POST', payload: { url: 'https://pod.example/note.ttl' } });
  });

  it.each(['MCP Resource not found', '401 Unauthorized', '403 insufficient_scope', 'descriptor not found'])(
    'does not interpret %s as permission to switch the read route', async message => {
      const call = vi.fn().mockRejectedValue(new Error(message));
      await expect(readEncryptedGraph(call, 'https://relay.example', 'https://pod.example/note.ttl', () => {})).rejects.toThrow(message);
      expect(call).toHaveBeenCalledTimes(1);
    },
  );

  it('uses the explicit compatibility read with exact stored ciphertext and a real client-held key', async () => {
    const vault = new ClientKeyVault(scope, localStorage(), webcrypto);
    await vault.create();
    const envelope = JSON.stringify(await vault.seal('existing private note'));
    const target = 'https://relay.example/tool/get_encrypted_graph';
    const call = vi.fn()
      .mockResolvedValueOnce({ structuredContent: { status: 200, body: JSON.stringify({ 'hydra:member': [
        { name: 'get_encrypted_graph', affordances: [{ method: 'POST', action: 'urn:iep:action:invoke:get_encrypted_graph', target }] },
      ] }) } })
      .mockResolvedValueOnce({ structuredContent: { status: 200, body: JSON.stringify({ encrypted: true, envelope }) } });
    const result = await readEncryptedGraphViaDiscovery(call, 'https://relay.example', 'https://pod.example/note.ttl', () => {});
    expect(result.envelope).toBe(envelope);
    expect(await vault.open(JSON.parse(result.envelope))).toBe('existing private note');
    expect(call.mock.calls).toEqual([
      ['act', { target: 'https://relay.example/tools', action: 'read', method: 'GET' }],
      ['act', { target, action: 'urn:iep:action:invoke:get_encrypted_graph', method: 'POST', payload: { url: 'https://pod.example/note.ttl' } }],
    ]);
    expect(JSON.stringify(call.mock.calls)).not.toContain('existing private note');
  });

  it('refuses a foreign advertised reader and stops if the connected identity changes during discovery', async () => {
    const surface = (target: string) => ({ 'hydra:member': [{ name: 'get_encrypted_graph', affordances: [
      { method: 'POST', action: 'urn:iep:action:invoke:get_encrypted_graph', target },
    ] }] });
    const foreign = vi.fn().mockResolvedValue(surface('https://foreign.example/tool/get_encrypted_graph'));
    await expect(readEncryptedGraphViaDiscovery(foreign, 'https://relay.example', 'https://pod.example/note.ttl', () => {})).rejects.toThrow('usable encrypted reader');
    expect(foreign).toHaveBeenCalledTimes(1);
    const changed = vi.fn().mockResolvedValue(surface('https://relay.example/tool/get_encrypted_graph'));
    let checks = 0;
    await expect(readEncryptedGraphViaDiscovery(changed, 'https://relay.example', 'https://pod.example/note.ttl', () => {
      if (++checks > 1) throw new Error('identity changed');
    })).rejects.toThrow('identity changed');
    expect(changed).toHaveBeenCalledTimes(1);
  });

  it('propagates a denied explicit compatibility read without trying another transport', async () => {
    const call = vi.fn().mockResolvedValue({ structuredContent: { status: 403, error: 'insufficient_scope' } });
    await expect(readEncryptedGraphViaDiscovery(call, 'https://relay.example', 'https://pod.example/note.ttl', () => {})).rejects.toThrow('insufficient_scope');
    expect(call).toHaveBeenCalledTimes(1);
  });
});
