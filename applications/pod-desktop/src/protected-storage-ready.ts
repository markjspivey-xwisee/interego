/** Electron's Windows profile key is cached before its delayed Local State write. */
import { lstat, open } from 'node:fs/promises';
import { isAbsolute, join } from 'node:path';
import { setTimeout as pause } from 'node:timers/promises';

export const PROTECTED_STORAGE_UNAVAILABLE = 'Your computer’s protected storage is still starting. Restart Interego and try again. Your saved pod has not been changed.';
export interface ProtectedStorageReadinessOptions {
  readonly signal?: AbortSignal;
  readonly timeoutMs?: number;
  /** Explicit only for an isolated test or a platform-specific launcher. */
  readonly platform?: NodeJS.Platform;
}
const MAX_STATE_BYTES = 4 * 1024 * 1024;
// A Windows DPAPI blob begins with version 1 and the DPAPI provider GUID.
const DPAPI_PREFIX = Buffer.from('445041504901000000d08c9ddf0115d1118c7a00c04fc297eb', 'hex');

async function profileKeyIsDurable(path: string): Promise<boolean> {
  try {
    const before = await lstat(path);
    if (!before.isFile() || before.isSymbolicLink() || before.size > MAX_STATE_BYTES) return false;
    const file = await open(path, 'r');
    try {
      const after = await file.stat();
      if (!after.isFile() || after.dev !== before.dev || after.ino !== before.ino || after.size > MAX_STATE_BYTES) return false;
      const bytes = Buffer.alloc(after.size + 1); let size = 0;
      while (size < bytes.length) {
        const read = await file.read(bytes, size, bytes.length - size, null);
        if (!read.bytesRead) break;
        size += read.bytesRead;
      }
      if (size === bytes.length || size > MAX_STATE_BYTES) return false;
      const state: unknown = JSON.parse(bytes.subarray(0, size).toString('utf8'));
      if (!state || typeof state !== 'object' || Array.isArray(state)) return false;
      const crypt: unknown = (state as Record<string, unknown>)['os_crypt'];
      if (!crypt || typeof crypt !== 'object' || Array.isArray(crypt)) return false;
      const encoded = (crypt as Record<string, unknown>)['encrypted_key'];
      if (typeof encoded !== 'string' || encoded.length > 16 * 1024) return false;
      const protectedKey = Buffer.from(encoded, 'base64');
      return protectedKey.length > DPAPI_PREFIX.length && protectedKey.toString('base64') === encoded
        && protectedKey.subarray(0, DPAPI_PREFIX.length).equals(DPAPI_PREFIX);
    } finally { await file.close(); }
  } catch { return false; }
}

/**
 * Call after app.whenReady() and a harmless safeStorage.encryptString() probe,
 * before issuing any reusable safeStorage-protected companion ticket. Pass
 * app.getPath('sessionData'): Electron stores Local State there, not in our vault.
 * Observes the actual disk state rather than assuming a fixed startup delay.
 */
export async function waitForProtectedStorage(sessionData: string, options: ProtectedStorageReadinessOptions = {}): Promise<void> {
  options.signal?.throwIfAborted();
  if ((options.platform ?? process.platform) !== 'win32') return;
  const timeoutMs = options.timeoutMs ?? 25_000;
  if (!isAbsolute(sessionData) || !Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 30_000) throw new Error(PROTECTED_STORAGE_UNAVAILABLE);
  const deadline = performance.now() + timeoutMs;
  const path = join(sessionData, 'Local State');
  for (;;) {
    options.signal?.throwIfAborted();
    if (await profileKeyIsDurable(path)) { options.signal?.throwIfAborted(); return; }
    const remaining = deadline - performance.now();
    if (remaining <= 0) throw new Error(PROTECTED_STORAGE_UNAVAILABLE);
    await pause(Math.min(200, remaining), undefined, { signal: options.signal });
  }
}
