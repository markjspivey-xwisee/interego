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

import { canonicalGraphDigest } from '@interego/core';
import { digestedGraphRegion, parseAuthorshipProofFromDescriptorTurtle } from '@interego/solid';
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

/**
 * What an opener answers. Three outcomes, and collapsing any two of them tells somebody something
 * untrue — see `openerFor` for the one that shipped collapsed and what it said.
 */
export type OpenedGraph =
  | { readonly kind: 'opened'; readonly content: string }
  /** Genuinely not a recipient. A permission, not a fault. */
  | { readonly kind: 'not-for-you' }
  /** The bytes could not be got or could not be opened. A fault, and NOT evidence about membership. */
  | { readonly kind: 'unreadable'; readonly why: string };

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
 * ★★ THE HALF OF THE PROOF ONLY A RECIPIENT CAN CHECK, CHECKED BY THE RECIPIENT.
 *
 * ── WHAT WAS WRONG ──────────────────────────────────────────────────────────
 *
 * The relay verifies an authorship proof in two independent parts: the SIGNATURE, and whether
 * that signature covers the bytes being served. The second part needs the payload — and for a
 * sealed graph the relay is not a recipient, so it cannot read one. Its own module says so:
 * "a private payload the relay is not a recipient of decrypts to null", which it reports, quite
 * correctly, as `contentBinding: 'declared'` — an honest "I did not check".
 *
 * But `verifiedSigner()` keys on `contentBinding`, by design and for a good measured reason. So
 * every descriptor in every PRIVATE workspace arrived with `signedBy: null`, and `judgeAuthorship`
 * reads a null signer on a record attributed to an agent as **disputed** — with the reason "no
 * authorship block reached this reader", which was not true. One did. It was complete, its
 * signature verified, and the only thing missing was a comparison the relay was structurally
 * unable to make.
 *
 * The visible result: in an end-to-end encrypted workspace, every entry a DELEGATE wrote rendered
 * as authorship disputed. Encrypting a channel silently disabled the thing that says who is
 * speaking in it — worst in exactly the rooms where that matters most.
 *
 * ── WHY THE READER MAY ANSWER IT ────────────────────────────────────────────
 *
 * Because the reader has what the relay lacked. It just opened the envelope with a key the relay
 * does not hold, so it is holding the plaintext the publisher digested. Running the SAME digest
 * the relay would have run, over the SAME region, is not a new trust assumption — it is the
 * deferred half of a check that was already specified.
 *
 * ★ THE REGION IS NOT THIS FUNCTION'S TO CHOOSE. `digestedGraphRegion` decides it, and every
 * party goes through it. A digest scope only one side knows is not a scope — when the relay owned
 * that decision privately, a forged acceptance in the DEFAULT graph left the digest byte-identical.
 *
 * ★ AND IT CAN ONLY EVER NARROW THE ANSWER. It runs on `'declared'` alone — never on `'bound'`,
 * `'mismatched'` or `'unbound'`, all of which are verdicts the relay reached by looking. A local
 * check may complete a check nobody ran; it may not overturn one that ran.
 *
 * ★ AND A MISMATCH IS REPORTED, NOT SWALLOWED. If the opened plaintext does not digest to what
 * the proof committed to, this says `'mismatched'` — the strongest signal in the vocabulary — and
 * `verifiedSigner` refuses it exactly as it refuses `'declared'`. Returning `'declared'` on a
 * failed comparison would be reporting "I did not check" about a check that ran and caught
 * something.
 */
export function sealedBindingCheck(
  d: Record<string, unknown>, content: string,
): { readonly authorship?: Record<string, unknown> } {
  const a = d['authorship'] as Record<string, unknown> | undefined;
  // Only the case the relay could not reach. Every other value is a verdict from a look.
  if (!a || a['contentBinding'] !== 'declared') return {};
  /**
   * ★★ AND ONLY WHEN EVERY OTHER PART OF THE PROOF ALREADY PASSED. FOUND BY A REFUTE-REVIEW OF
   * THE FIRST VERSION OF THIS FUNCTION, WHICH WAS A FORGERY HOLE.
   *
   * `'declared'` does NOT mean "the signature was fine and only the content went unchecked". The
   * relay reports it from `contentBindingWhenUnchecked(proof.contentHash)` on EVERY path that did
   * not reach the comparison — including the two refusals:
   *
   *   · the signature did not verify, and
   *   · the signature verified and the proof is about SOME OTHER RECORD — the lifted-proof class
   *     `descriptorBinding` exists to catch, where a real proof from one of a principal's honest
   *     public descriptors is pasted into a fabricated one.
   *
   * Both arrive as `authorshipVerified: false` with `contentBinding: 'declared'`. Gating on the
   * binding alone therefore upgraded a REFUSED descriptor to `'bound'` — and `verifiedSigner`
   * keys on exactly that value, so it began returning the forger's chosen issuer for records the
   * relay had already thrown out. A reader completing the one check the relay could not make must
   * not thereby overturn the checks it did make.
   *
   * ★ `descriptorBinding.bound` is required as well as `authorshipVerified`. They are separate
   * axes and the relay reports them separately on purpose: a descriptor can verify and still not
   * be the one its proof names.
   */
  if (a['authorshipVerified'] !== true) return {};
  const db = a['descriptorBinding'] as { bound?: unknown } | undefined;
  if (!db || db['bound'] !== true) return {};
  const turtle = typeof d['turtle'] === 'string' ? d['turtle'] as string : null;
  if (!turtle) return {};
  const declared = parseAuthorshipProofFromDescriptorTurtle(turtle)?.contentHash;
  if (typeof declared !== 'string' || !declared) return {};
  let observed: string | undefined;
  try {
    const region = digestedGraphRegion({ graphContent: content, descriptorTurtle: turtle });
    observed = region.ok ? canonicalGraphDigest(region.turtle) ?? undefined : undefined;
  } catch { return {}; }
  // Still could not compute one. Unchanged: 'declared' is already the right answer for that.
  if (!observed) return {};
  const bound = observed === declared;
  return {
    authorship: {
      ...a,
      contentBinding: bound ? 'bound' : 'mismatched',
      /**
       * ★ WHO ESTABLISHED IT, SAID OUT LOUD. The relay's own note stays as the relay wrote it;
       * this is a separate field, because a reader must be able to tell a verdict the relay
       * reached from one this process reached with a key the relay does not hold. Collapsing the
       * two would let a client's own arithmetic wear the relay's authority.
       */
      contentBindingCheckedLocally: true,
      contentBindingLocalNote: bound
        ? 'The relay could not compare this proof against the payload, because the payload is '
          + 'sealed and the relay is not a recipient of it. This reader opened the envelope with '
          + 'its own key and ran the same digest over the same region: it matches, so the '
          + 'signature does cover these bytes. Established here, not by the relay.'
        : 'The relay could not compare this proof against the payload. This reader opened the '
          + 'envelope with its own key and ran the same digest over the same region, and it DOES '
          + 'NOT match what the proof committed to — so whatever was signed, it was not this.',
    },
  };
}

/**
 * The opener to hand {@link WorkspaceClient.setGraphOpener}, from a private key.
 *
 * ★★ THE REDUCTION FROM FOUR ANSWERS TO THREE HAPPENS EXACTLY ONCE, HERE — and it used to be a
 * reduction to TWO, which is what made it wrong. `openGraph`'s `plaintext` and `opened` are the
 * same thing to a caller, so they merge. `not-for-you` and `unreadable` are NOT, and merging them
 * turned every transport failure into a statement about somebody's membership.
 *
 * Doing the reduction here rather than in each host is what stops one of them mapping `unreadable`
 * to a placeholder string and landing "could not decrypt" in a workspace document as though
 * somebody had published it.
 */
export function openerFor(privateKeyHex: string, principal?: string): (sealed: unknown) => OpenedGraph {
  const key = encryptionKeyFor(privateKeyHex, principal);
  return (sealed) => {
    const opened = openGraph(sealed, key);
    if (opened.kind === 'opened' || opened.kind === 'plaintext') return { kind: 'opened', content: opened.content };
    /**
     * ★★ THE THIRD ANSWER, WHICH USED TO BE COLLAPSED INTO THE SECOND. This returned `null` for
     * BOTH "not addressed to me" and "the read failed" — violating the contract written on
     * `GraphOpener` itself, which says null must mean the former and never the latter.
     *
     * The cost was a false statement about somebody's membership. A CSS 502 during a redeploy, a
     * damaged envelope, a `no_envelope_url` — any of them produced `unreadable`, became `null`,
     * became `withheld`, and `verifyGrantIri` then refused a member's own Accept with "this
     * workspace is private and this identity is not among them". That is verbatim the sentence
     * re-sealing was introduced to stop anybody seeing, said this time to somebody who IS a
     * recipient, because a transport hiccup was reported as a permission.
     */
    if (opened.kind === 'unreadable') return { kind: 'unreadable', why: opened.why };
    return { kind: 'not-for-you' };
  };
}
