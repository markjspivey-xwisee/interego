/**
 * THE KEY A HOST HOLDS, AND THE RELAY DOES NOT.
 *
 * ★ IT LIVES IN THE SHARED CLIENT BECAUSE EVERY HOST NEEDS THE SAME ANSWER. It began in the
 * desktop app, and the Discord conduit needs it too — it holds a wallet of its own and cannot read
 * a private workspace without one. Two copies of "may this identity read these bytes" is two
 * places for that question to be answered differently, which is the one kind of drift this package
 * cannot tolerate: the disagreement would show up as a workspace that is readable in one client
 * and reported corrupt in another.
 *
 * The SECRET still belongs to the host. Nothing here stores a key, and `WorkspaceClient` takes the
 * opener as a function rather than key material precisely so that this package can be bundled into
 * a browser artifact without ever being handed one.
 *
 * ── ★★ WHAT MAKES THE ENCRYPTION END-TO-END RATHER THAN AT-REST ─────────────
 *
 * Until this file existed, every agent on the fleet advertised the SAME encryption public key —
 * the relay's single process-wide keypair, stamped over anything an agent tried to register. So
 * "encrypted to its members" sealed content to one key the relay holds, and the relay could read
 * all of it. No member held a key at all, which is the part that decides whether the word applies.
 *
 * The relay now keeps a key an agent supplies (`register_agent`'s `encryption_public_key`) and
 * hands back sealed envelopes to anyone (`get_encrypted_graph`) without opening them. This is the
 * other half: the client that holds the secret and does the opening.
 *
 * ── ★ DERIVED FROM THE WALLET, NOT GENERATED ────────────────────────────────
 *
 * `deriveEncryptionKeyPair` is deterministic from the account's secp256k1 private key, with its
 * own domain separator. Three consequences, all of which matter more than the convenience:
 *
 *   · NOTHING NEW CAN BE LOST. A generated key would be a second secret, and losing it would make
 *     every message ever encrypted to it unreadable, permanently, with the pod intact and useless.
 *     This one is recoverable from the same seed phrase the account already depends on.
 *   · IT IS THE SAME KEY ON EVERY MACHINE this person signs in on, so a second device joins a
 *     private workspace by signing in rather than by a key-transfer ceremony nobody would do.
 *   · AND IT IS SCOPED, so a delegate derives a different key from the same wallet than its
 *     principal does — an agent's reach does not silently become its human's.
 *
 * ★ THE SECRET NEVER LEAVES THIS PROCESS. It is derived in the main process from a key held in the
 * OS secret store, used to open bytes, and never sent to the relay, written to a descriptor, or
 * exposed on the renderer bridge. Only the PUBLIC half is ever published.
 */

import { deriveEncryptionKeyPair, openEncryptedEnvelope, type EncryptedEnvelope, type EncryptionKeyPair } from '@interego/core';

/**
 * This account's encryption keypair.
 *
 * `principal` scopes the derivation — pass the delegate's DID when deriving for a delegate, so it
 * does not share a key with the human it acts for.
 */
export function encryptionKeyFor(privateKeyHex: string, principal?: string): EncryptionKeyPair {
  return deriveEncryptionKeyPair(privateKeyHex, principal);
}

/** What came back from `get_encrypted_graph`, and what this reader could make of it. */
export type Opened =
  | { readonly kind: 'plaintext'; readonly content: string }
  | { readonly kind: 'opened'; readonly content: string }
  | { readonly kind: 'not-for-you'; readonly why: string }
  | { readonly kind: 'unreadable'; readonly why: string };

/**
 * Open what `get_encrypted_graph` returned.
 *
 * ★ "NOT FOR YOU" AND "BROKEN" ARE DIFFERENT ANSWERS AND ARE REPORTED AS SUCH. An envelope that
 * does not name this key is a permission, not a fault — the same distinction the workspace client
 * had to learn when it was calling withheld records malformed. A reader that collapsed them would
 * tell somebody their workspace was corrupt because they had not been invited to it.
 */
export function openGraph(payload: unknown, key: EncryptionKeyPair): Opened {
  const p = (payload ?? {}) as { encrypted?: boolean; content?: string; envelope?: string; error?: string; message?: string };
  if (p.error) return { kind: 'unreadable', why: String(p.message ?? p.error) };
  if (p.encrypted === false && typeof p.content === 'string') return { kind: 'plaintext', content: p.content };
  if (typeof p.envelope !== 'string') {
    return { kind: 'unreadable', why: 'the relay returned neither plaintext nor an envelope, so there is nothing to open' };
  }

  let envelope: EncryptedEnvelope;
  try { envelope = JSON.parse(p.envelope) as EncryptedEnvelope; }
  catch (e) { return { kind: 'unreadable', why: 'the envelope did not parse as JSON (' + ((e as Error).message) + ')' }; }

  // Asked before unwrapping so the answer distinguishes the two cases above rather than reporting
  // every miss as a decryption failure.
  const named = Array.isArray(envelope.wrappedKeys)
    && envelope.wrappedKeys.some((w) => w.recipientPublicKey === key.publicKey);
  if (!named) {
    return {
      kind: 'not-for-you',
      why: 'this content is encrypted to ' + (envelope.wrappedKeys?.length ?? 0) + ' recipient(s) and this '
        + 'identity is not among them. Nothing is wrong with it — it is not yours to read.',
    };
  }
  const plain = openEncryptedEnvelope(envelope, key);
  if (plain === null) {
    // Named but unopenable: the key material is wrong or the ciphertext is damaged. Distinct from
    // both cases above, and worth saying so rather than implying a permission problem.
    return { kind: 'unreadable', why: 'this identity is named as a recipient but the envelope would not open, so the key material or the ciphertext is damaged' };
  }
  return { kind: 'opened', content: plain };
}

/**
 * The opener to hand {@link WorkspaceClient.setGraphOpener}, from a private key.
 *
 * ★★ THE COLLAPSE FROM FOUR ANSWERS TO TWO HAPPENS EXACTLY ONCE, HERE. `openGraph` distinguishes
 * "not addressed to me" from "damaged" because a reader must be able to say which; the client's
 * opener contract is narrower — a string or `null`, where `null` means NOT MINE. Each host writing
 * that reduction itself is how one of them eventually maps `unreadable` to a placeholder string
 * and lands "could not decrypt" in a workspace document as though somebody had published it.
 *
 * A damaged envelope therefore reads as withheld. That is the conservative direction: it says
 * less than is known rather than more, and the record stays exactly as unread as it truly is.
 */
export function openerFor(privateKeyHex: string, principal?: string): (sealed: unknown) => string | null {
  const key = encryptionKeyFor(privateKeyHex, principal);
  return (sealed) => {
    const opened = openGraph(sealed, key);
    return opened.kind === 'opened' || opened.kind === 'plaintext' ? opened.content : null;
  };
}
