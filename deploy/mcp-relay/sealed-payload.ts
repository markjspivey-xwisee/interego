/**
 * A PAYLOAD THE PUBLISHER ALREADY SEALED, WHICH THIS RELAY MUST STORE AND MUST NOT BE ABLE TO READ.
 *
 * ── ★★ WHAT THIS IS FOR ─────────────────────────────────────────────────────
 *
 * `publish_context` has always taken PLAINTEXT `graph_content` and done the encrypting itself. Two
 * consequences follow mechanically, and neither is a bug in the sense of a mistake — they are what
 * that design means:
 *
 *   · the relay sees every private word at write time, and
 *   · `authorEncryptionKey` is `relayAgentKey.publicKey`, so the relay is a RECIPIENT of every
 *     envelope it writes. Measured on the live fleet: two runs with four unrelated wallets put the
 *     same third key in both envelopes.
 *
 * So "end-to-end encrypted" was not true of this system, and no amount of member-key registration
 * could make it true while the sealing happened here. `sealed_payload` is the other arrangement:
 * the client builds the envelope, and the relay stores the bytes without being able to open them.
 *
 * ── ★ IT IS A PURE MODULE ON PURPOSE ────────────────────────────────────────
 *
 * `server.ts` opens a listener when it is imported, so nothing in it can be unit-tested. Every
 * decision here — what counts as an envelope, what is refused, and above all the refusal when the
 * relay finds its OWN key among the recipients — is exercised directly by `tests/`. The handler
 * keeps only the wiring.
 */

/** The envelope shape `createEncryptedEnvelope` produces. Validated structurally, never opened. */
/**
 * ★ THE FIELD IS `wrappedKey`, NOT `wrapped`. Named to match `@interego/core`'s `WrappedKey`
 * exactly — an invented name here validates nothing and rejects every honest envelope, which is
 * what the first version did: the live probe's perfectly good envelope came back 422
 * `sealed_payload_malformed`. The check is deliberately strict, so getting the shape wrong is
 * loud rather than permissive.
 */
interface WrappedKey { recipientPublicKey?: unknown; wrappedKey?: unknown; nonce?: unknown; senderPublicKey?: unknown }
interface Envelope {
  version?: unknown;
  algorithm?: unknown;
  content?: { ciphertext?: unknown; nonce?: unknown } | unknown;
  wrappedKeys?: unknown;
}

/** What the relay needs to know about a payload it cannot read. */
export interface SealedPayload {
  /** The envelope, verbatim. Written to the pod exactly as received. */
  readonly body: string;
  /** How many recipients the publisher sealed to. Reported back; never recomputed. */
  readonly recipientCount: number;
  /**
   * The plaintext's digest, as the publisher computed it.
   *
   * ★ ASSERTED, NOT VERIFIED, AND THAT CHANGES WHAT A SIGNATURE MEANS. The relay signs authorship
   * over this value without being able to check it, so the proof stops saying "I hashed these
   * bytes" and starts saying "the agent I authenticated asserted this digest". The meaning is
   * recovered on the READING side: a recipient recomputes the digest over the opened payload, and
   * a publisher who lied produces `mismatched` for every entitled reader. Which is why an absent
   * digest is a refusal rather than an `unbound` proof — see `parseSealedPayload`.
   */
  readonly contentDigest: string;
  /**
   * The descriptor-layer statements the relay would normally LIFT out of the plaintext.
   *
   * ★★ WITHOUT THIS THE ENTRY CHAIN SILENTLY FORKS. `normalizePublishInputs` reads
   * `iep:supersedes` from inside the payload and promotes it to the descriptor; feed it ciphertext
   * and it finds nothing, so every entry becomes its own head and `orderChain` reports N forked
   * heads. The publisher runs that same function over its own plaintext and sends the result here.
   */
  readonly mirror: string;
}

export type SealedParse =
  | { readonly kind: 'absent' }
  | { readonly kind: 'sealed'; readonly sealed: SealedPayload }
  | { readonly kind: 'refused'; readonly code: number; readonly body: Record<string, unknown> };

const refuse = (code: number, error: string, message: string, extra: Record<string, unknown> = {}): SealedParse =>
  ({ kind: 'refused', code, body: { error, code, message, ...extra } });

const str = (v: unknown): string => (typeof v === 'string' ? v : '');

/**
 * Decide whether this publish is publisher-sealed, and refuse the ways it can be malformed.
 *
 * `relayPublicKey` is passed in rather than imported so this module holds no runtime state and the
 * refusal below can be exercised without a relay.
 */
export function parseSealedPayload(
  args: Record<string, unknown>,
  relayPublicKey: string,
): SealedParse {
  const flag = args['sealed_payload'];
  if (flag === undefined || flag === null || flag === false) return { kind: 'absent' };

  const graphContent = str(args['graph_content']);
  if (!graphContent) {
    return refuse(422, 'sealed_payload_empty',
      'sealed_payload was set but graph_content is empty, so there is no envelope to store.');
  }

  let envelope: Envelope;
  try { envelope = JSON.parse(graphContent) as Envelope; }
  catch {
    return refuse(422, 'sealed_payload_unparseable',
      'sealed_payload was set but graph_content is not JSON, so it is not an envelope this relay can '
      + 'store as one. Send the output of createEncryptedEnvelope.');
  }

  const keys = Array.isArray(envelope.wrappedKeys) ? envelope.wrappedKeys as WrappedKey[] : null;
  const content = envelope.content as { ciphertext?: unknown; nonce?: unknown } | undefined;
  if (envelope.algorithm !== 'X25519-XSalsa20-Poly1305'
    || !content || typeof content !== 'object'
    || !str(content.ciphertext) || !str(content.nonce)
    || !keys || keys.length === 0) {
    return refuse(422, 'sealed_payload_malformed',
      'sealed_payload was set but graph_content is not a well-formed X25519-XSalsa20-Poly1305 envelope '
      + 'with a ciphertext, a nonce and at least one wrapped key. Nothing was written.');
  }
  for (const k of keys) {
    if (!str(k?.recipientPublicKey) || !str(k?.wrappedKey) || !str(k?.nonce) || !str(k?.senderPublicKey)) {
      return refuse(422, 'sealed_payload_malformed',
        'one of the wrappedKeys entries is missing its recipientPublicKey, wrappedKey, nonce or '
        + 'senderPublicKey, so this envelope would be unopenable by somebody it names. Nothing was written.');
    }
  }

  /**
   * ── ★★ THE REFUSAL THIS WHOLE FILE EXISTS FOR ───────────────────────────────
   *
   * A publisher can put any key it likes in `wrappedKeys`, including this relay's — which is
   * published, discoverable, and exactly what the OLD path put there on every write. A client that
   * copied the recipient list from an existing envelope, or read a member's key out of a registry
   * where `encryptionKeyToRecord` had substituted the relay's default, would seal to the relay and
   * call it end-to-end.
   *
   * The relay is the one party that can notice, so it does, and it refuses rather than warns: the
   * whole value of the sealed path is the sentence "the relay is not a recipient", and a path that
   * sometimes quietly is cannot support that sentence.
   */
  const relayNamed = relayPublicKey
    && keys.some((k) => str(k.recipientPublicKey) === relayPublicKey);
  if (relayNamed) {
    return refuse(409, 'relay_is_a_recipient',
      'this envelope names the relay\'s own encryption key as a recipient, which would make the content '
      + 'readable by the relay — the one thing a publisher-sealed payload exists to prevent. It is '
      + 'usually a member key read from a registry where none was ever registered: the registry '
      + 'substitutes this relay\'s key as a placeholder, and sealing to it seals to us. Nothing was '
      + 'written.',
      { relayAgentPublicKey: relayPublicKey });
  }

  const visibility = str(args['visibility']);
  if (visibility === 'public') {
    return refuse(422, 'sealed_public_contradiction',
      'visibility "public" and sealed_payload contradict each other: a public graph is served in the '
      + 'clear and this one is an envelope nobody but its recipients can open. Choose one.');
  }

  /**
   * ★ AN UNVERIFIABLE SIGNATURE MUST NOT BE MINTED AS AN UNBOUND ONE. `contentBinding: 'unbound'`
   * already means something to readers — a legacy proof written before content binding existed.
   * Signing a sealed payload with no digest would mint new proofs wearing that label, and a reader
   * would read "old" where the truth is "the publisher declined to say what it sealed".
   */
  const contentDigest = str(args['content_digest']);
  if (args['sign_authorship'] === true && !contentDigest) {
    return refuse(422, 'content_digest_required',
      'sign_authorship was requested for a sealed payload but no content_digest was supplied. The relay '
      + 'cannot compute one — it cannot read the payload — and signing without it would mint a proof '
      + 'that reads as legacy-unbound to every reader. Send the digest of the plaintext you sealed.');
  }

  return {
    kind: 'sealed',
    sealed: {
      body: graphContent,
      recipientCount: keys.length,
      contentDigest,
      // Absent is legitimate: a payload that asserts no cross-descriptor relationships has no
      // mirror, and an empty string is what `normalizePublishInputs` is happy to receive.
      mirror: str(args['cleartext_mirror']),
    },
  };
}
