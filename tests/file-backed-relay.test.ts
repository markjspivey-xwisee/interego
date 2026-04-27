/**
 * FileBackedRelay tests — events survive across "restarts"
 * (constructor cycles), JSONL format is portable, malformed lines
 * are tolerated, dedup + replaceability still apply.
 */

import { describe, it, expect, afterEach } from 'vitest';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { existsSync, unlinkSync, readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import {
  FileBackedRelay,
  P2pClient,
  importWallet,
  KIND_DESCRIPTOR,
} from '../src/index.js';

const ALICE_KEY = '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80';

function deriveKey(seed: string): string {
  return createHash('sha256').update(seed, 'utf8').digest('base64');
}

function freshPath(): string {
  return join(tmpdir(), `interego-fbr-test-${Date.now()}-${Math.random().toString(36).slice(2)}.jsonl`);
}

const cleanups: string[] = [];
afterEach(() => {
  for (const p of cleanups.splice(0)) {
    try { if (existsSync(p)) unlinkSync(p); } catch { /* ignore */ }
  }
});

describe('FileBackedRelay — JSONL persistence', () => {
  it('events written by one relay are visible to a fresh relay on the same file', async () => {
    const path = freshPath();
    cleanups.push(path);

    // Session 1: write 3 events
    const r1 = new FileBackedRelay(path, { log: () => {} });
    const alice = new P2pClient(r1, importWallet(ALICE_KEY, 'agent', 'alice'));
    await alice.publishDescriptor({ descriptorId: 'urn:cg:fbr:1', cid: 'bafk-1', graphIri: 'urn:graph:fbr' });
    await alice.publishDescriptor({ descriptorId: 'urn:cg:fbr:2', cid: 'bafk-2', graphIri: 'urn:graph:fbr' });
    await alice.publishDescriptor({ descriptorId: 'urn:cg:fbr:3', cid: 'bafk-3', graphIri: 'urn:graph:fbr' });
    expect(r1.size()).toBe(3);
    expect(existsSync(path)).toBe(true);

    // Session 2: open a fresh relay on the same file
    const r2 = new FileBackedRelay(path, { log: () => {} });
    expect(r2.size()).toBe(3);
    const events = await r2.query({ kinds: [KIND_DESCRIPTOR] });
    expect(events).toHaveLength(3);
    const ids = events.map(e => e.tags.find(t => t[0] === 'd')?.[1]).sort();
    expect(ids).toEqual(['urn:cg:fbr:1', 'urn:cg:fbr:2', 'urn:cg:fbr:3']);
  });

  it('appending after replay continues from where session 1 left off', async () => {
    const path = freshPath();
    cleanups.push(path);

    const r1 = new FileBackedRelay(path, { log: () => {} });
    const alice = new P2pClient(r1, importWallet(ALICE_KEY, 'agent', 'alice'));
    await alice.publishDescriptor({ descriptorId: 'urn:cg:fbr-append:1', cid: 'bafk-1', graphIri: 'urn:graph:append' });

    const r2 = new FileBackedRelay(path, { log: () => {} });
    expect(r2.size()).toBe(1);
    const aliceR2 = new P2pClient(r2, importWallet(ALICE_KEY, 'agent', 'alice'));
    await aliceR2.publishDescriptor({ descriptorId: 'urn:cg:fbr-append:2', cid: 'bafk-2', graphIri: 'urn:graph:append' });
    expect(r2.size()).toBe(2);

    // Session 3 should see both events
    const r3 = new FileBackedRelay(path, { log: () => {} });
    expect(r3.size()).toBe(2);
  });

  it('NIP-33 replaceability survives the round-trip', async () => {
    const path = freshPath();
    cleanups.push(path);

    const r1 = new FileBackedRelay(path, { log: () => {} });
    const alice = new P2pClient(r1, importWallet(ALICE_KEY, 'agent', 'alice'));
    await alice.publishDescriptor({ descriptorId: 'urn:cg:replace-test', cid: 'v1', graphIri: 'urn:graph:replace' });
    await new Promise(r => setTimeout(r, 1100)); // ensure created_at advances
    await alice.publishDescriptor({ descriptorId: 'urn:cg:replace-test', cid: 'v2', graphIri: 'urn:graph:replace' });
    // In-memory size: 1 (v2 superseded v1). On-disk file: 2 lines (append-only).
    expect(r1.size()).toBe(1);

    // Fresh session replays both lines but applies the same
    // replaceability rule, so the in-memory size is still 1
    // and the survivor is v2.
    const r2 = new FileBackedRelay(path, { log: () => {} });
    expect(r2.size()).toBe(1);
    const events = await r2.query({ kinds: [KIND_DESCRIPTOR] });
    expect(events[0]!.tags.find(t => t[0] === 'cid')?.[1]).toBe('v2');
  });

  it('malformed lines in the file are skipped without breaking replay', async () => {
    const path = freshPath();
    cleanups.push(path);

    // Hand-write a file with one valid event + one malformed line
    const r1 = new FileBackedRelay(path, { log: () => {} });
    const alice = new P2pClient(r1, importWallet(ALICE_KEY, 'agent', 'alice'));
    await alice.publishDescriptor({ descriptorId: 'urn:cg:malformed-test', cid: 'bafk-mal', graphIri: 'urn:graph:malformed' });

    const original = readFileSync(path, 'utf8');
    writeFileSync(path, original + 'this is not json\n{not json either}\n');

    const r2 = new FileBackedRelay(path, { log: () => {} });
    // The single valid event still loads
    expect(r2.size()).toBe(1);
  });

  it('encrypted persistence: round-trip works with the same key', async () => {
    const path = freshPath();
    cleanups.push(path);
    const key = deriveKey('test-seed-1');

    // Session 1: write encrypted
    const r1 = new FileBackedRelay(path, { log: () => {}, encryptionKey: key });
    expect(r1.isEncrypted()).toBe(true);
    const alice = new P2pClient(r1, importWallet(ALICE_KEY, 'agent', 'alice'));
    await alice.publishDescriptor({
      descriptorId: 'urn:cg:enc-test:secret-1',
      cid: 'bafk-secret-cid',
      graphIri: 'urn:graph:enc',
      summary: 'CONFIDENTIAL: this should not appear in plaintext on disk',
    });
    expect(r1.size()).toBe(1);

    // Disk inspection: nothing sensitive should appear in plaintext
    const onDisk = readFileSync(path, 'utf8');
    expect(onDisk).not.toContain('CONFIDENTIAL');
    expect(onDisk).not.toContain('secret-1');
    expect(onDisk).not.toContain('bafk-secret-cid');
    expect(onDisk).not.toContain('urn:graph:enc');
    // Encrypted-line format: nonce_b64:ct_b64\n
    expect(onDisk).toMatch(/^[A-Za-z0-9+/=]+:[A-Za-z0-9+/=]+\n$/);

    // Session 2: same key opens it
    const r2 = new FileBackedRelay(path, { log: () => {}, encryptionKey: key });
    expect(r2.size()).toBe(1);
    const events = await r2.query({ kinds: [KIND_DESCRIPTOR] });
    expect(events).toHaveLength(1);
    const restoredCid = events[0]!.tags.find(t => t[0] === 'cid')?.[1];
    expect(restoredCid).toBe('bafk-secret-cid');
  });

  it('encrypted persistence: wrong key cannot decrypt — events skipped', async () => {
    const path = freshPath();
    cleanups.push(path);
    const correctKey = deriveKey('correct-seed');
    const wrongKey = deriveKey('wrong-seed');

    const r1 = new FileBackedRelay(path, { log: () => {}, encryptionKey: correctKey });
    const alice = new P2pClient(r1, importWallet(ALICE_KEY, 'agent', 'alice'));
    await alice.publishDescriptor({
      descriptorId: 'urn:cg:wrong-key',
      cid: 'bafk-wk',
      graphIri: 'urn:graph:wk',
    });

    // A reader with the wrong key sees nothing — lines fail Poly1305
    // auth and are skipped silently (logged via opts.log if provided)
    const r2 = new FileBackedRelay(path, { log: () => {}, encryptionKey: wrongKey });
    expect(r2.size()).toBe(0);
  });

  it('encryption survives NIP-33 replaceability', async () => {
    const path = freshPath();
    cleanups.push(path);
    const key = deriveKey('test-seed-2');

    const r1 = new FileBackedRelay(path, { log: () => {}, encryptionKey: key });
    const alice = new P2pClient(r1, importWallet(ALICE_KEY, 'agent', 'alice'));
    await alice.publishDescriptor({ descriptorId: 'urn:cg:enc-replace', cid: 'v1', graphIri: 'urn:graph:enc-replace' });
    await new Promise(r => setTimeout(r, 1100));
    await alice.publishDescriptor({ descriptorId: 'urn:cg:enc-replace', cid: 'v2', graphIri: 'urn:graph:enc-replace' });

    const r2 = new FileBackedRelay(path, { log: () => {}, encryptionKey: key });
    expect(r2.size()).toBe(1);
    const events = await r2.query({ kinds: [KIND_DESCRIPTOR] });
    expect(events[0]!.tags.find(t => t[0] === 'cid')?.[1]).toBe('v2');
  });

  it('rejects an encryption key that is not 32 bytes', () => {
    const path = freshPath();
    cleanups.push(path);
    const tooShort = Buffer.from('too short').toString('base64');
    expect(() => new FileBackedRelay(path, { log: () => {}, encryptionKey: tooShort })).toThrow(/32 bytes/);
  });

  it('publish failure (file write error) propagates as ok=false', async () => {
    // Use a path that can't be written to (parent doesn't exist
    // and we can't create it because it's nested under a path we
    // also can't make on a typical FS). Easiest: use a path with
    // a NUL char which is invalid on every OS.
    const path = '/tmp/\x00invalid';
    const r = new FileBackedRelay(path, { log: () => {} });
    const alice = new P2pClient(r, importWallet(ALICE_KEY, 'agent', 'alice'));
    // publishDescriptor throws when relay returns ok=false
    await expect(alice.publishDescriptor({
      descriptorId: 'urn:cg:write-fail',
      cid: 'bafk-x',
      graphIri: 'urn:graph:x',
    })).rejects.toThrow(/Persisted publish failed|Relay rejected/);
  });
});
