import { randomBytes } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { PROTECTED_STORAGE_UNAVAILABLE, waitForProtectedStorage } from '../src/protected-storage-ready.js';

const directories: string[] = [];
const key = () => Buffer.concat([Buffer.from('445041504901000000d08c9ddf0115d1118c7a00c04fc297eb', 'hex'), randomBytes(64)]).toString('base64');
async function profile() { const directory = await mkdtemp(join(tmpdir(), 'interego-protected-storage-')); directories.push(directory); return directory; }
afterEach(async () => { await Promise.all(directories.splice(0).map(directory => rm(directory, { recursive: true, force: true }))); });

describe('Windows protected storage persistence readiness', () => {
  it('waits until the actual wrapped key appears, even after empty, truncated or invalid state', async () => {
    const directory = await profile(); const path = join(directory, 'Local State'); let ready = false;
    const waiting = waitForProtectedStorage(directory, { platform: 'win32', timeoutMs: 3000 }).then(() => { ready = true; });
    try {
      for (const value of ['{}', '{"os_crypt":', JSON.stringify({ os_crypt: { encrypted_key: 'not-a-canonical-protected-key' } })]) {
        await writeFile(path, value); await new Promise(resolve => setTimeout(resolve, 20)); expect(ready).toBe(false);
      }
      await writeFile(path, JSON.stringify({ os_crypt: { encrypted_key: key() } }));
      await waiting; expect(ready).toBe(true);
    } finally { await waiting; }
  });

  it('returns promptly for an existing canonical DPAPI-wrapped key', async () => {
    const directory = await profile(); await writeFile(join(directory, 'Local State'), JSON.stringify({ os_crypt: { encrypted_key: key() } }));
    await waitForProtectedStorage(directory, { platform: 'win32', timeoutMs: 1 });
  });

  it.each([
    '{}', '{"os_crypt":null}', JSON.stringify({ os_crypt: { encrypted_key: Buffer.from('DPAPI').toString('base64') } }),
    JSON.stringify({ os_crypt: { encrypted_key: `${key()}\n` } }), JSON.stringify({ os_crypt: { encrypted_key: randomBytes(100).toString('base64') } }),
  ])('bounds failure and returns only a safe error for malformed state %j', async state => {
    const directory = await profile(); await writeFile(join(directory, 'Local State'), state);
    await expect(waitForProtectedStorage(directory, { platform: 'win32', timeoutMs: 20 })).rejects.toThrow(PROTECTED_STORAGE_UNAVAILABLE);
  });

  it('supports cancellation while waiting and before filesystem work', async () => {
    const directory = await profile(); const controller = new AbortController();
    const waiting = waitForProtectedStorage(directory, { platform: 'win32', signal: controller.signal }); controller.abort();
    await expect(waiting).rejects.toMatchObject({ name: 'AbortError' });
    await expect(waitForProtectedStorage(directory, { platform: 'win32', signal: controller.signal })).rejects.toMatchObject({ name: 'AbortError' });
  });

  it('is a no-op on other platforms and rejects an unbounded deadline on Windows', async () => {
    await waitForProtectedStorage('not a profile', { platform: 'linux' });
    const directory = await profile();
    await expect(waitForProtectedStorage(directory, { platform: 'win32', timeoutMs: 30_001 })).rejects.toThrow(PROTECTED_STORAGE_UNAVAILABLE);
  });
});
