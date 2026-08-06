/**
 * Where the wallet key lives, and what that actually buys.
 *
 * ★ NEVER A FILE IN THE REPO AND NEVER A PLAINTEXT CONFIG. The key is encrypted by the
 * OPERATING SYSTEM before it touches disk — Electron's `safeStorage`, which on Windows is
 * DPAPI scoped to the logged-in user account, on macOS the login Keychain, and on Linux the
 * Secret Service (kwallet/gnome-keyring) when one is running.
 *
 * ★ AND HERE IS WHAT IT DOES NOT BUY, because overstating it would be exactly the kind of
 * confident falsehood this vertical exists not to make. DPAPI binds the ciphertext to the
 * Windows USER, not to this application: any process running as the same user can call
 * `CryptUnprotectData` on it. That is the same protection Chrome gives cookies and VS Code
 * gives tokens; it defeats an attacker who copies the file off the machine, and it does not
 * defeat malware already running as you. `isEncryptionAvailable()` is checked and a false is
 * REFUSED rather than silently downgraded to plaintext — a "secret store" that quietly writes
 * a cleartext key is worse than no secret store, because the user believes the first
 * sentence of this comment.
 */

import { safeStorage, app } from 'electron';
import { mkdirSync, readFileSync, writeFileSync, existsSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';

/** One named secret per file, under the app's own userData directory. */
function secretPath(name: string): string {
  const dir = join(app.getPath('userData'), 'secrets');
  mkdirSync(dir, { recursive: true });
  return join(dir, name + '.bin');
}

export class OsSecretStoreUnavailable extends Error {
  constructor() {
    super('The OS secret store is not available on this machine, so there is nowhere to put a '
      + 'private key that is not a plaintext file. Sign in with the browser instead — that path '
      + 'holds no key at all.');
    this.name = 'OsSecretStoreUnavailable';
  }
}

export const secretStoreAvailable = (): boolean => safeStorage.isEncryptionAvailable();

export function putSecret(name: string, value: string): void {
  if (!safeStorage.isEncryptionAvailable()) throw new OsSecretStoreUnavailable();
  writeFileSync(secretPath(name), safeStorage.encryptString(value), { mode: 0o600 });
}

export function getSecret(name: string): string | null {
  const p = secretPath(name);
  if (!existsSync(p)) return null;
  if (!safeStorage.isEncryptionAvailable()) throw new OsSecretStoreUnavailable();
  try {
    return safeStorage.decryptString(readFileSync(p));
  } catch (e) {
    // A ciphertext that will not decrypt is NOT an absent secret. Returning null here would
    // have the caller offer to mint a fresh identity — silently abandoning the pod the user's
    // words are already on — so it is reported instead.
    throw new Error('A stored secret exists at ' + p + ' and this machine could not decrypt it ('
      + ((e as Error)?.message ?? String(e)) + '). It was encrypted by a different OS user '
      + 'account, or the OS key store was reset. It is NOT being treated as absent, because '
      + 'that would mint a new identity and leave your pod behind.');
  }
}

export function forgetSecret(name: string): void {
  const p = secretPath(name);
  if (existsSync(p)) unlinkSync(p);
}

/** Where a token may be cached. Tokens are short-lived; the key is the thing worth protecting. */
export const WALLET_KEY = 'wallet-privkey';
export const CACHED_BEARER = 'relay-bearer';
