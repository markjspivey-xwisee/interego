import { describe, expect, it } from 'vitest';
import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import type { EncryptionKeyPair } from '@interego/core';
import { PodController, type PodKeyVault } from '../src/controller.js';
import { WorkspaceService, WORKSPACE_ACTIONS as A } from '../src/workspace-service.js';

async function contents(directory: string): Promise<string> {
  const bytes: string[] = [];
  for (const child of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, child.name);
    if (child.isDirectory()) bytes.push(await contents(path));
    else if (child.isFile()) bytes.push((await readFile(path)).toString('utf8'));
  }
  return bytes.join('\n');
}

describe('Workspace persistence in the real encrypted local pod', () => {
  it('keeps messages private on disk, reopens the same records and respects an owner stopping the pod', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'interego-workspace-pod-'));
    const absolute = resolve(directory);
    if (dirname(absolute) !== resolve(tmpdir()) || !basename(absolute).startsWith('interego-workspace-pod-')) throw new Error('Unexpected test directory.');
    let key: EncryptionKeyPair | null = null;
    const vault: PodKeyVault = { async load() { return key; }, async save(value) { key = value; } };
    const pod = new PodController({ dataDir: directory, vault });
    let holdNextWrite = false;
    let entered!: () => void; const storageEntered = new Promise<void>(resolve => { entered = resolve; });
    let release!: () => void; const storageRelease = new Promise<void>(resolve => { release = resolve; });
    const options = { store: { load: () => pod.readVerticalState('workspace'), save: (value: unknown, binding: string, authorize: () => Promise<void>) => {
      if (holdNextWrite) {
        holdNextWrite = false;
        // A real controller operation owns its queue while the workspace mutation waits behind it.
        void pod.writeVerticalState('queue-blocker', {}, binding, async () => { entered(); await storageRelease; });
      }
      return pod.writeVerticalState('workspace', value, binding, authorize);
    } },
      binding: () => pod.agentPodBinding() };
    try {
      await pod.setup();
      const service = new WorkspaceService(options);
      const initial = await service.status();
      await service.act({ action: A.ENABLE, target: initial.id });
      const created = await service.act({ action: A.CREATE, target: initial.id, input: { title: 'Private room 2c9f18' } });
      const posted = await service.act({ action: A.POST, target: created.id, input: { body: 'Private conversation body 7a8273ce must stay encrypted.' } });
      const bytes = await contents(join(directory, 'store'));
      expect(bytes).not.toContain('Private room 2c9f18');
      expect(bytes).not.toContain('Private conversation body 7a8273ce');
      expect(bytes).not.toContain(key!.secretKey);
      await pod.stop();
      await expect(service.status()).rejects.toThrow(/Start your pod/i);
      await expect(service.act({ action: A.READ, target: created.id })).rejects.toThrow(/Start your pod/i);
      expect((await pod.getStatus()).running).toBe(false);
      await pod.start();
      const reopened = new WorkspaceService(options);
      const representation = await reopened.act({ action: A.READ, target: created.id });
      expect(representation.workspace!.entries).toEqual(posted.workspace!.entries);
      expect(representation.workspace!.title).toBe('Private room 2c9f18');
      expect((await pod.getStatus()).federationEnabled).toBe(false);
      const binding = (await pod.agentPodBinding())!;
      await pod.writeVerticalState('size-bound', { retained: 'Keep the previous stored value' }, binding);
      const wrapperBytes = Buffer.byteLength(JSON.stringify({ format: 'interego-private-vertical-state', version: 1,
        namespace: 'size-bound', binding, value: { text: '' } }));
      const tooLargeAfterEncryption = { text: 'a'.repeat(6 * 1024 * 1024 - wrapperBytes) };
      // The plaintext meets its exact limit; base64 plus authenticated-envelope metadata exceeds the read limit.
      await expect(pod.writeVerticalState('size-bound', tooLargeAfterEncryption, binding)).rejects.toThrow(/data is full/);
      expect(await pod.readVerticalState('size-bound')).toEqual({ retained: 'Keep the previous stored value' });
      let allowed = true;
      const agent = { id: randomUUID(), kind: 'agent' as const, name: 'Revocable connection', workspaceIds: [created.id],
        permissions: ['workspaces:read', 'workspaces:chat'] as const, authorize: async () => { if (!allowed) throw new Error('The owner revoked this connection.'); } };
      await reopened.act({ action: A.INVITE, target: created.id, input: { memberId: agent.id, name: agent.name, kind: 'agent' } });
      const acceptance = (await reopened.status(agent)).affordances.find(a => a.action === A.ACCEPT)!;
      await reopened.act({ action: acceptance.action, target: acceptance.target }, agent);
      holdNextWrite = true;
      const refusedWrite = reopened.act({ action: A.POST, target: created.id, input: { body: 'Must not persist after queued revocation' } }, agent);
      await storageEntered;
      allowed = false; release();
      await expect(refusedWrite).rejects.toThrow(/could not be saved|revoked/i);
      const retained = await reopened.act({ action: A.READ, target: created.id });
      expect(retained.workspace!.entries).toHaveLength(1);
      expect(retained.workspace!.entries[0]!.body).toContain('7a8273ce');
      await expect(pod.writeVerticalState('workspace', {}, 'b'.repeat(64))).rejects.toThrow(/different pod/);
      await expect(pod.readVerticalState('../other')).rejects.toThrow(/supported local application/);
    } finally {
      await pod.stop();
      await rm(absolute, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    }
  }, 120_000);
});
