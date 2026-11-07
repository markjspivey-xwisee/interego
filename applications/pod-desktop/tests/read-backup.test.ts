import { afterAll, describe, expect, it } from 'vitest';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { readBackupFile } from '../src/read-backup.js';

describe('bounded notes backup input', () => {
  const directories: string[] = [];
  const fixture = async () => {
    const directory = await mkdtemp(join(tmpdir(), 'interego-backup-input-'));
    directories.push(directory);
    return directory;
  };

  afterAll(async () => {
    for (const directory of directories) {
      if (dirname(resolve(directory)) === resolve(tmpdir()) && basename(directory).startsWith('interego-backup-input-')) {
        await rm(directory, { recursive: true, force: true });
      }
    }
  });

  it('returns exact bytes for a normal file, including a file at the limit', async () => {
    const directory = await fixture();
    const path = join(directory, 'notes.interego');
    const bytes = Buffer.from([0, 255, 8, 13, 10, 32, 65, 128]);
    await writeFile(path, bytes);
    expect(Buffer.from(await readBackupFile(path, bytes.length))).toEqual(bytes);
    await writeFile(path, Buffer.alloc(160 * 1024, 173));
    expect(Buffer.from(await readBackupFile(path, 160 * 1024))).toEqual(Buffer.alloc(160 * 1024, 173));
  });

  it('rejects an oversized file before importing any backup data', async () => {
    const directory = await fixture();
    const path = join(directory, 'too-large.interego');
    await writeFile(path, Buffer.alloc(1025));
    await expect(readBackupFile(path, 1024)).rejects.toThrow(/too large/i);
  });

  it('refuses directories and reports a missing or unavailable file without exposing its path', async () => {
    const directory = await fixture();
    const folder = join(directory, 'not-a-backup');
    await mkdir(folder);
    await expect(readBackupFile(folder)).rejects.toThrow(/regular.*file/i);
    await expect(readBackupFile(join(directory, 'missing.interego'))).rejects.toThrow(/^The notes backup could not be read\./);
  });
});
