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
import { mkdirSync, readFileSync, readdirSync, writeFileSync, existsSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';

/**
 * One named secret per file, under the app's own userData directory.
 *
 * ★ THE NAME BECOMES A PATH SEGMENT AND IS THEREFORE CHECKED. Every caller in this app passes a
 * constant or a validated hex address, so nothing today could traverse — which is exactly when a
 * check is cheap to add and expensive to add later. A `..` in a secret name would read and write
 * files outside the secrets directory.
 */
function secretPath(name: string): string {
  if (!/^[A-Za-z0-9._-]+$/.test(name) || name.indexOf('..') >= 0) {
    throw new Error('secretPath: "' + name + '" is not a usable secret name. It becomes a filename, so it is refused rather than sanitised.');
  }
  const dir = join(app.getPath('userData'), 'secrets');
  mkdirSync(dir, { recursive: true });
  return join(dir, name + '.bin');
}

/**
 * A SECRET NAMED AFTER THE ADDRESS OF THE KEY IN IT.
 *
 * ★ THE IDENTITY IS THE KEY, NOT THIS FILE. `delegates.ts` in the shared package states the rule
 * and the measurement behind it: a delegate's DID is a function of its own keypair plus one
 * constant surface name, so the same key is the same delegate in any client that holds it. The
 * same is true one level up: which pod the relay provisions is a function of the account key, so
 * the same key is the same person's account in any client that holds it. This app is a HOST for
 * both. Naming a file after the address rather than after a slot number ("delegate-1", or one
 * fixed "the wallet") makes that true in the storage layer too: two apps holding the same key
 * agree about whose it is, and reinstalling this one loses the key without changing who it was.
 *
 * ★ AND IT IS WHY NOTHING HERE CAN BE OVERWRITTEN BY IMPORTING A DIFFERENT KEY. A single slot
 * means the second key a person pastes destroys the first, and a private key is the WHOLE of an
 * identity — there is no reset, no recovery and no support desk, so a silent overwrite is the
 * permanent loss of a pod and everything written to it. Address-keying makes that impossible by
 * construction rather than by remembering to warn.
 */
const addressSlot = (prefix: 'delegate' | 'account' | 'accountpod', address: string, what: string): string => {
  if (!/^0x[0-9a-fA-F]{40}$/.test(address)) {
    throw new Error(prefix.toUpperCase() + '_KEY: "' + address + '" is not an Ethereum address, so it is not ' + what + '.');
  }
  return prefix + '-' + address.toLowerCase();
};

/** Where a DELEGATE's key lives. A person may have several, so this is a family of names. */
export const DELEGATE_KEY = (address: string): string => addressSlot('delegate', address, 'a delegate this app holds a key for');

/**
 * Where an ACCOUNT's key lives — the key that decides which pod the person's own words land on.
 *
 * The same shape as {@link DELEGATE_KEY} and deliberately a DIFFERENT prefix. They are separate
 * namespaces because they are separate kinds of identity: an account signs in under this app's
 * own OAuth client name and provisions the person's pod, a delegate signs in under
 * `DELEGATE_SURFACE` and provisions its own. The same key in both slots would be the same secp256k1
 * secret acting as two identities, which is legal and confusing; keeping the namespaces apart means
 * "forget my delegate" can never reach the key holding somebody's account.
 */
export const ACCOUNT_KEY = (address: string): string => addressSlot('account', address, 'an account this app holds a key for');

/**
 * The pod the RELAY answered, the last time this account key signed in on this machine.
 *
 * ★ REMEMBERED, NEVER DERIVED. `u-eth-<first 12 hex of the address>` is what the relay does today
 * and deriving it here would silently address a pod that does not exist the day it stops — and a
 * wrong pod name reads back as an EMPTY LOG rather than as an error, which is the confident
 * falsehood this vertical is written against (`openAgentSession` records the same rule). So this
 * is a cache of an ANSWER, written only after a real sign-in, and its absence means "not
 * established here" rather than "this key has no pod".
 */
export const ACCOUNT_POD = (address: string): string => addressSlot('accountpod', address, 'an account this app has signed in');

/**
 * Which stored account key the wallet button signs in with.
 *
 * Holds an address, not a key. It is in the encrypted store rather than a plain file only because
 * that is the one place this process already writes to; nothing about an address is secret.
 */
export const ACTIVE_ACCOUNT = 'active-account';

const slotDir = (): string => {
  const dir = join(app.getPath('userData'), 'secrets');
  mkdirSync(dir, { recursive: true });
  return dir;
};

/** Every address this machine holds a key for under one prefix. */
const listSlots = (prefix: 'delegate' | 'account'): readonly string[] =>
  readdirSync(slotDir())
    .map((f) => new RegExp('^' + prefix + '-(0x[0-9a-f]{40})\\.bin$').exec(f)?.[1] ?? null)
    .filter((a): a is string => a !== null)
    .sort();

/** Every delegate this machine holds a key for. The POD is the roster; this is the keyring. */
export const listDelegateKeys = (): readonly string[] => listSlots('delegate');

/**
 * Every account this machine holds a key for.
 *
 * Plural on purpose. One person can hold more than one account — a pod they use and a pod they are
 * testing with — and the app's job is to let them say which one is speaking, not to decide for
 * them by keeping only the most recent.
 */
export const listAccountKeys = (): readonly string[] => listSlots('account');

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

/**
 * THE ORIGINAL SINGLE ACCOUNT SLOT, KEPT BECAUSE PEOPLE HAVE KEYS IN IT.
 *
 * ★ IT IS LEGACY AND IT IS NOT DELETED. Every install before account keys became address-keyed
 * wrote here, and that file is the only copy of the identity behind somebody's pod. `main.ts`
 * COPIES it into an {@link ACCOUNT_KEY} slot on startup and then works only in the new namespace;
 * the old file is left exactly where it was. Removing it after a successful copy would be tidier
 * and would also mean that a bug in the copy — or a downgrade to an older build — costs a person
 * their pod. Tidiness is not worth that trade, and an encrypted 32-byte file costs nothing.
 */
export const WALLET_KEY = 'wallet-privkey';
export const CACHED_BEARER = 'relay-bearer';
