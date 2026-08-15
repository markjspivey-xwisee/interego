/**
 * WHAT THE RELAY ACCEPTS WHEN IT IS TOLD THE PAYLOAD IS ALREADY SEALED.
 *
 * ── ★★ THE ONE REFUSAL THAT CARRIES THE WHOLE CLAIM ─────────────────────────
 *
 * A publisher-sealed payload exists so the relay can say "I am not a recipient of this". A
 * publisher can put any key it likes in `wrappedKeys` — including the relay's, which is published,
 * discoverable, and precisely what the OLD publish path put there on every single write. The most
 * likely route is not malice: `encryptionKeyToRecord` substitutes the relay's key as a placeholder
 * for an agent that registered none, so a client that reads a member's key out of the registry and
 * seals to it seals to the relay while believing it did the opposite.
 *
 * The relay is the only party in a position to notice. So it refuses — not warns — because a path
 * that is sometimes quietly escrowed cannot support the sentence it exists to support.
 *
 * ★ AND THESE RUN AT ALL ONLY BECAUSE THE PARSER IS A SEPARATE MODULE. `server.ts` opens a
 * listener when it is imported, so nothing reachable from it can be unit-tested; every decision
 * worth testing was therefore in a file no test could load.
 */

import { describe, it, expect } from 'vitest';
import { parseSealedPayload } from '../deploy/mcp-relay/sealed-payload.js';

const RELAY_KEY = 'RXRg5b/FlX8yix14MJDW/cyIqWzmwKfEU01T7KEKUSk=';
const MEMBER_A = 'AAAAb0N/9B5HAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=';
const MEMBER_B = 'BBBBQuKvuL56tBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB=';

const wrapped = (to: string): Record<string, string> => ({ recipientPublicKey: to, wrapped: 'w', nonce: 'n' });
const envelope = (recipients: readonly string[]): string => JSON.stringify({
  version: 1,
  algorithm: 'X25519-XSalsa20-Poly1305',
  content: { ciphertext: 'opaque', nonce: 'n' },
  wrappedKeys: recipients.map(wrapped),
});

const sealedArgs = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
  sealed_payload: true,
  graph_content: envelope([MEMBER_A, MEMBER_B]),
  content_digest: 'bafydigest',
  cleartext_mirror: '<urn:g> <http://…/iep#supersedes> <urn:prior> .',
  ...over,
});

describe('a publish with no sealed_payload is untouched', () => {
  it('★ absent means absent — every existing caller must take a byte-identical path', () => {
    expect(parseSealedPayload({ graph_content: '<a> <b> "c" .' }, RELAY_KEY).kind).toBe('absent');
    expect(parseSealedPayload({}, RELAY_KEY).kind).toBe('absent');
    // `false` is a caller explicitly saying no, which is the same answer.
    expect(parseSealedPayload({ sealed_payload: false, graph_content: 'x' }, RELAY_KEY).kind).toBe('absent');
  });
});

describe('★★ the relay refuses to be a recipient of a payload it is told is end-to-end', () => {
  it('refuses when its own key is among the recipients', () => {
    const out = parseSealedPayload(sealedArgs({ graph_content: envelope([MEMBER_A, RELAY_KEY]) }), RELAY_KEY);
    expect(out.kind).toBe('refused');
    if (out.kind !== 'refused') return;
    expect(out.code).toBe(409);
    expect(out.body['error']).toBe('relay_is_a_recipient');
    // Names the key, so a client can tell which of its recipients was the problem.
    expect(out.body['relayAgentPublicKey']).toBe(RELAY_KEY);
    // And explains the likely cause rather than just the rule — this is the registry placeholder.
    expect(String(out.body['message'])).toContain('registry');
  });

  it('refuses even when the relay is the ONLY recipient', () => {
    const out = parseSealedPayload(sealedArgs({ graph_content: envelope([RELAY_KEY]) }), RELAY_KEY);
    expect(out.kind).toBe('refused');
    if (out.kind === 'refused') expect(out.body['error']).toBe('relay_is_a_recipient');
  });

  it('★ accepts an envelope sealed to members only', () => {
    const out = parseSealedPayload(sealedArgs(), RELAY_KEY);
    expect(out.kind).toBe('sealed');
    if (out.kind !== 'sealed') return;
    expect(out.sealed.recipientCount).toBe(2);
    expect(out.sealed.contentDigest).toBe('bafydigest');
    expect(out.sealed.mirror).toContain('supersedes');
  });

  it('★★ and the check is not vacuous when the relay key is unknown to it', () => {
    /**
     * If `relayPublicKey` ever arrives empty — a config miss, a rename — then "the relay is not a
     * recipient" would pass for every envelope including one sealed entirely to the relay. The
     * guard is written so an empty key cannot match, and this pins that an envelope naming the
     * real key is still caught when the key IS known, so the two cases stay distinguishable.
     */
    const blind = parseSealedPayload(sealedArgs({ graph_content: envelope([RELAY_KEY]) }), '');
    expect(blind.kind, 'an empty relay key must not silently match everything').toBe('sealed');
    const seeing = parseSealedPayload(sealedArgs({ graph_content: envelope([RELAY_KEY]) }), RELAY_KEY);
    expect(seeing.kind).toBe('refused');
  });
});

describe('what is not an envelope', () => {
  it('refuses a plaintext graph sent under the sealed flag', () => {
    const out = parseSealedPayload(sealedArgs({ graph_content: '<urn:g> <p> "the actual words" .' }), RELAY_KEY);
    expect(out.kind).toBe('refused');
    if (out.kind === 'refused') expect(out.body['error']).toBe('sealed_payload_unparseable');
  });

  it('refuses JSON that is not an X25519 envelope', () => {
    const out = parseSealedPayload(sealedArgs({ graph_content: '{"hello":"world"}' }), RELAY_KEY);
    expect(out.kind).toBe('refused');
    if (out.kind === 'refused') expect(out.body['error']).toBe('sealed_payload_malformed');
  });

  it('★ refuses an envelope with no recipients at all — that is not sealed, it is lost', () => {
    const out = parseSealedPayload(sealedArgs({ graph_content: envelope([]) }), RELAY_KEY);
    expect(out.kind).toBe('refused');
    if (out.kind === 'refused') expect(out.body['error']).toBe('sealed_payload_malformed');
  });

  it('★ refuses a wrappedKeys entry missing its wrapped key, which nobody could open', () => {
    const broken = JSON.stringify({
      version: 1, algorithm: 'X25519-XSalsa20-Poly1305',
      content: { ciphertext: 'c', nonce: 'n' },
      wrappedKeys: [{ recipientPublicKey: MEMBER_A }],
    });
    const out = parseSealedPayload(sealedArgs({ graph_content: broken }), RELAY_KEY);
    expect(out.kind).toBe('refused');
    if (out.kind === 'refused') expect(String(out.body['message'])).toContain('unopenable');
  });

  it('refuses an empty graph_content', () => {
    const out = parseSealedPayload({ sealed_payload: true, graph_content: '' }, RELAY_KEY);
    expect(out.kind).toBe('refused');
    if (out.kind === 'refused') expect(out.body['error']).toBe('sealed_payload_empty');
  });
});

describe('the two contradictions it will not resolve for you', () => {
  it('★ "public" and sealed are not compatible', () => {
    const out = parseSealedPayload(sealedArgs({ visibility: 'public' }), RELAY_KEY);
    expect(out.kind).toBe('refused');
    if (out.kind === 'refused') expect(out.body['error']).toBe('sealed_public_contradiction');
  });

  it('★★ signing without a digest is refused rather than minted as "unbound"', () => {
    /**
     * `contentBinding: 'unbound'` already means "a legacy proof written before content binding
     * existed". Signing a sealed payload with no digest would mint NEW proofs wearing that label,
     * and every reader would read "old" where the truth is "the publisher declined to say what it
     * sealed" — a wrong answer to a question about provenance, which is the one class of wrongness
     * this system exists to avoid.
     */
    const out = parseSealedPayload(sealedArgs({ sign_authorship: true, content_digest: undefined }), RELAY_KEY);
    expect(out.kind).toBe('refused');
    if (out.kind !== 'refused') return;
    expect(out.body['error']).toBe('content_digest_required');
    expect(String(out.body['message'])).toContain('legacy-unbound');
  });

  it('★ but an unsigned sealed publish needs no digest', () => {
    const out = parseSealedPayload(sealedArgs({ sign_authorship: false, content_digest: undefined }), RELAY_KEY);
    expect(out.kind).toBe('sealed');
    if (out.kind === 'sealed') expect(out.sealed.contentDigest).toBe('');
  });

  it('★ and a payload asserting no relationships needs no mirror', () => {
    // An empty mirror is legitimate — `normalizePublishInputs` accepts empty content. Refusing it
    // would make the first entry of every chain impossible.
    const out = parseSealedPayload(sealedArgs({ cleartext_mirror: undefined }), RELAY_KEY);
    expect(out.kind).toBe('sealed');
    if (out.kind === 'sealed') expect(out.sealed.mirror).toBe('');
  });
});
