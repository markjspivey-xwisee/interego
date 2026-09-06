import { describe, expect, it } from 'vitest';
import { webcrypto, createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { ClientKeyVault, type ClientKeyRecord, type ClientKeyStorage } from '../packages/core/src/crypto/client-vault.js';
import { generateKeyPair, openEncryptedEnvelope } from '../packages/core/src/crypto/encryption.js';
import { canonicalGraphDigest, canonicalGraphTriples } from '../packages/core/src/rdf/graph-digest.js';

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
  });
});
