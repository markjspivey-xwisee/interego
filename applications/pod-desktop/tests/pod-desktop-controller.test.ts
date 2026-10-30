import { afterAll, describe, expect, it } from 'vitest';
import { mkdtemp, readFile, readdir, rm, stat, unlink, writeFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { Socket } from 'node:net';
import { generateKeyPair, type EncryptionKeyPair } from '@interego/core';
import { PodController, type PodKeyVault } from '../src/controller.js';

class MemoryVault implements PodKeyVault {
  key: EncryptionKeyPair | null = null;
  failNextSave = false;
  async load(): Promise<EncryptionKeyPair | null> { return this.key; }
  async save(value: EncryptionKeyPair): Promise<void> {
    if (this.failNextSave) { this.failNextSave = false; throw new Error('The OS secret store was temporarily unavailable.'); }
    this.key = value;
  }
}

async function fileContents(directory: string): Promise<string> {
  const bodies: string[] = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) bodies.push(await fileContents(path));
    else if (entry.isFile()) bodies.push((await readFile(path)).toString('utf8'));
  }
  return bodies.join('\n');
}

describe('the consumer pod controller uses the real local encrypted pod', () => {
  const directories: string[] = [];
  const controllers: PodController[] = [];
  const phrase = 'a private recovery phrase for these notes';
  const fixture = async (vault = new MemoryVault()) => {
    const directory = await mkdtemp(join(tmpdir(), 'interego-consumer-pod-'));
    directories.push(directory);
    const controller = new PodController({ dataDir: directory, vault });
    controllers.push(controller);
    return { controller, vault, directory };
  };

  afterAll(async () => {
    for (const controller of controllers) await controller.stop();
    for (const directory of directories) {
      if (dirname(resolve(directory)) === resolve(tmpdir()) && basename(directory).startsWith('interego-consumer-pod-')) {
        await rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
      }
    }
  }, 120_000);

  it('sets up, saves private notes, restarts, and restores an authenticated portable notes backup', async () => {
    const first = await fixture();
    const originalConnect = Socket.prototype.connect;
    const denied: string[] = [];
    Socket.prototype.connect = function (this: Socket, ...args: unknown[]): Socket {
      const value = Array.isArray(args[0]) ? args[0][0] : args[0];
      const options = value && typeof value === 'object' ? value as { path?: string; host?: string; hostname?: string } : undefined;
      if (typeof value !== 'string' && !options?.path) {
        const host = options?.host ?? options?.hostname ?? (typeof args[1] === 'string' ? args[1] : 'localhost');
        if (!['127.0.0.1', 'localhost', '::1', '[::1]', '::ffff:127.0.0.1'].includes(host)) {
          denied.push(host); throw new Error('The consumer controller tried a non-loopback connection.');
        }
      }
      return Reflect.apply(originalConnect, this, args) as Socket;
    } as typeof Socket.prototype.connect;
    try {
      expect((await first.controller.getStatus()).configured).toBe(false);
      expect((await first.controller.setup()).running).toBe(true);
      const saved = await first.controller.saveNote({ title: 'A very private title', body: 'A unique private body with "quotes" and\na second line.' });
      expect(await first.controller.listNotes()).toEqual([saved]);
      const stored = await fileContents(join(first.directory, 'store'));
      expect(stored).not.toContain(saved.title);
      expect(stored).not.toContain('A unique private body');
      expect(stored).not.toContain(first.vault.key!.secretKey);
      await first.controller.stop();
      expect((await first.controller.start()).noteCount).toBe(1);
      expect(await first.controller.listNotes()).toEqual([saved]);

      const backup = await first.controller.exportBackup(phrase);
      expect(Buffer.from(backup).toString('utf8')).not.toContain(saved.title);
      expect(Buffer.from(backup).toString('utf8')).not.toContain(first.vault.key!.secretKey);
      const restored = await fixture();
      await expect(restored.controller.restoreBackup(backup, 'the wrong but long enough phrase')).rejects.toThrow(/passphrase|damaged/i);
      expect((await restored.controller.getStatus()).configured).toBe(false);
      expect(restored.vault.key).toBeNull();
      await expect(stat(join(restored.directory, 'store'))).rejects.toMatchObject({ code: 'ENOENT' });
      restored.vault.failNextSave = true;
      await expect(restored.controller.restoreBackup(backup, phrase)).rejects.toThrow(/restore did not finish/i);
      expect((await restored.controller.getStatus()).restorePending).toBe(true);
      await expect(restored.controller.start()).rejects.toThrow(/same notes backup/i);
      expect((await restored.controller.restoreBackup(backup, phrase)).running).toBe(true);
      expect((await restored.controller.getStatus()).restorePending).toBeUndefined();
      expect(await restored.controller.listNotes()).toEqual([saved]);
      expect(restored.vault.key).toEqual(first.vault.key);
      await expect(restored.controller.restoreBackup(backup, phrase)).rejects.toThrow(/new pod|existing/i);
      expect(await restored.controller.listNotes()).toEqual([saved]);
      expect(denied).toEqual([]);
    } finally { Socket.prototype.connect = originalConnect; }
  }, 240_000);

  it('recovers a demonstrably dead runtime lock but refuses an alive process or malformed lock', async () => {
    const { controller, directory } = await fixture();
    await controller.setup(); await controller.stop();
    const deadPid = await new Promise<number>((done, fail) => {
      const child = spawn(process.execPath, ['-e', 'process.exit(0)'], { stdio: 'ignore', windowsHide: true });
      child.once('error', fail);
      child.once('exit', () => child.pid ? done(child.pid) : fail(new Error('No child pid.')));
    });
    const lockPath = join(directory, 'store', 'runtime.lock');
    await writeFile(lockPath, JSON.stringify({ version: 1, id: randomUUID(), pid: deadPid }));
    expect((await controller.start()).running).toBe(true);
    await controller.stop();
    const alive = JSON.stringify({ version: 1, id: randomUUID(), pid: process.pid });
    await writeFile(lockPath, alive);
    await expect(controller.start()).rejects.toThrow(/already running/i);
    expect(await readFile(lockPath, 'utf8')).toBe(alive);
    await writeFile(lockPath, '{damaged');
    await expect(controller.start()).rejects.toThrow(/lock could not be verified/i);
    expect(await readFile(lockPath, 'utf8')).toBe('{damaged');
    await unlink(lockPath);
  }, 180_000);

  it('refuses invalid input, short passphrases and mismatched content keys without replacing data', async () => {
    const { controller, vault } = await fixture();
    await expect(controller.saveNote({ title: '', body: 'text' })).rejects.toThrow(/title/i);
    await expect(controller.exportBackup('short')).rejects.toThrow(/12/i);
    await controller.setup(); await controller.stop();
    const original = vault.key!;
    vault.key = { ...original, publicKey: generateKeyPair().publicKey };
    await expect(controller.start()).rejects.toThrow(/does not match/i);
    expect(vault.key.publicKey).not.toBe(original.publicKey);
    vault.key = original;
    expect((await controller.start()).running).toBe(true);
  }, 180_000);
});
