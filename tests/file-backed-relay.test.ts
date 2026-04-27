/**
 * FileBackedRelay tests — events survive across "restarts"
 * (constructor cycles), JSONL format is portable, malformed lines
 * are tolerated, dedup + replaceability still apply.
 */

import { describe, it, expect, afterEach } from 'vitest';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { existsSync, unlinkSync, readFileSync, writeFileSync } from 'node:fs';
import {
  FileBackedRelay,
  P2pClient,
  importWallet,
  KIND_DESCRIPTOR,
} from '../src/index.js';

const ALICE_KEY = '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80';

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
