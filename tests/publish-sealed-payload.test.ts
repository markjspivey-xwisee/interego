/**
 * STORING BYTES THE PUBLISHER SEALED, WITHOUT BEING ABLE TO READ THEM.
 *
 * ── ★★ WHY `encrypt` COULD NOT SIMPLY BE REUSED ─────────────────────────────
 *
 * `PublishOptions.encrypt` means "this process holds the plaintext and will seal it". Everything
 * reachable from it happens HERE — the recipient list, the sender keypair, the `wrapAsTriG` call —
 * so whoever runs this code has read the content. When that is the relay, the payload is not
 * end-to-end encrypted however carefully the recipients are chosen, and the relay's own key lands
 * in the envelope besides. Measured live: two runs with four unrelated wallets produced envelopes
 * sharing one third key.
 *
 * `sealedPayload` is the other arrangement, and these tests pin the three things that make it one:
 * the bytes are stored VERBATIM, no second wrapping happens, and the descriptor stops advertising
 * a projection nobody could perform.
 */

import { describe, it, expect, vi } from 'vitest';
import { ContextDescriptor, deriveEncryptionKeyPair, type IRI } from '@interego/core';
import { publish } from '@interego/solid';

const POD = 'https://pod.example/u-a/';
const ENVELOPE = JSON.stringify({
  version: 1,
  algorithm: 'X25519-XSalsa20-Poly1305',
  content: { ciphertext: 'THE-OPAQUE-CIPHERTEXT', nonce: 'n' },
  wrappedKeys: [
    { recipientPublicKey: 'MEMBER-A', wrapped: 'w1', nonce: 'n1' },
    { recipientPublicKey: 'MEMBER-B', wrapped: 'w2', nonce: 'n2' },
  ],
});

/** Records every write so the test can read exactly what would have hit the pod. */
function recordingFetch(): { fetch: typeof globalThis.fetch; writes: { url: string; method: string; body: string; type: string }[] } {
  const writes: { url: string; method: string; body: string; type: string }[] = [];
  const fetch = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    const urlStr = typeof url === 'string' ? url : url.toString();
    const method = init?.method ?? 'GET';
    if (method !== 'GET') {
      const h = new Headers(init?.headers ?? {});
      writes.push({ url: urlStr, method, body: String(init?.body ?? ''), type: h.get('content-type') ?? '' });
    }
    // A cold pod: no manifest yet. Same shape as `publish-gates.test.ts` — anything else sends
    // `publish` into its transient-retry budget and the test times out rather than failing.
    if (method === 'GET' && urlStr.includes('.well-known/context-graphs')) {
      return {
        ok: false, status: 404, statusText: 'Not Found',
        text: async () => '', json: async () => ({}), headers: new Headers(),
      } as unknown as Response;
    }
    if (method === 'GET') {
      return {
        ok: false, status: 404, statusText: 'Not Found',
        text: async () => '', json: async () => ({}), headers: new Headers(),
      } as unknown as Response;
    }
    return {
      ok: true, status: 201, statusText: 'Created',
      text: async () => '', json: async () => ({}), headers: new Headers(),
    } as unknown as Response;
  });
  return { fetch: fetch as unknown as typeof globalThis.fetch, writes };
}

/** A real X25519 pair — nacl refuses invented base64, and the encrypt arm actually runs. */
const REAL_PAIR = deriveEncryptionKeyPair('0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d');

// The real builder, same idiom as `publish-gates.test.ts` — a hand-rolled descriptor literal is a
// fixture that stops matching the type the moment the builder changes.
const descriptor = (): ReturnType<ReturnType<typeof ContextDescriptor.create>['build']> =>
  ContextDescriptor.create('urn:iep:sealed:1' as IRI)
    .describes('urn:graph:sealed:1' as IRI)
    .temporal({ validFrom: '2026-08-15T00:00:00Z' })
    .selfAsserted('did:web:alice.example' as IRI)
    .build();

describe('★★ a sealed payload is stored exactly as handed in', () => {
  it('PUTs the envelope byte-for-byte, with no re-wrapping', async () => {
    const { fetch, writes } = recordingFetch();
    await publish(descriptor(), 'IGNORED PLAINTEXT', POD, {
      fetch,
      sealedPayload: { body: ENVELOPE, recipientCount: 2 },
      visibility: 'shared',
    });

    const payloadPut = writes.find((w) => w.url.endsWith('.envelope.jose.json'));
    expect(payloadPut, 'a sealed publish must write an envelope, not a .trig').toBeDefined();
    // ★ IDENTITY, not "contains". `wrapAsTriG` around ciphertext would still contain it, and
    // nothing downstream could invert that.
    expect(payloadPut?.body).toBe(ENVELOPE);
    expect(JSON.parse(payloadPut?.body ?? '{}').wrappedKeys).toHaveLength(2);
  });

  it('★★ the plaintext argument is NOT written anywhere, even though it was passed', async () => {
    /**
     * `publish`'s `graphContent` parameter is positional and required; a sealed caller has nothing
     * meaningful to put there. This pins that whatever it does contain cannot reach the pod — the
     * one mistake that would quietly undo the entire feature while every other assertion passed.
     */
    const { fetch, writes } = recordingFetch();
    const secret = 'MARKER-' + 'the-actual-words-nobody-should-see';
    await publish(descriptor(), secret, POD, {
      fetch, sealedPayload: { body: ENVELOPE, recipientCount: 2 }, visibility: 'shared',
    });
    for (const w of writes) {
      expect(w.body, w.method + ' ' + w.url + ' carried the plaintext').not.toContain(secret);
    }
  });

  it('★ refuses when the caller also asks this process to encrypt', async () => {
    // Two sealers is not a merge — it is a caller who has not decided. Guessing would either wrap
    // an envelope in an envelope or silently substitute relay-sealing for the caller's own.
    const { fetch } = recordingFetch();
    await expect(publish(descriptor(), '', POD, {
      fetch,
      sealedPayload: { body: ENVELOPE, recipientCount: 2 },
      encrypt: { recipients: [REAL_PAIR.publicKey], senderKeyPair: REAL_PAIR },
    })).rejects.toThrow(/who is doing the sealing/);
  });
});

describe('★★ the descriptor stops promising what nobody can do', () => {
  it('does not advertise iep:renderView for a publisher-sealed payload', async () => {
    /**
     * `/render` is the relay unwrapping an envelope with its OWN key — it works today only because
     * the relay puts that key in everything it seals. A publisher-sealed envelope does not name
     * the relay, so `/render` answers 403 `NotARecipient`. Advertising the affordance anyway would
     * hand a client following its nose a 403 it would read as a problem with its own bearer.
     */
    const { fetch, writes } = recordingFetch();
    await publish(descriptor(), '', POD, {
      fetch, sealedPayload: { body: ENVELOPE, recipientCount: 2 },
      visibility: 'shared', relayBaseUrl: 'https://relay.example',
    });
    const desc = writes.find((w) => w.url.endsWith('.ttl'));
    expect(desc, 'no descriptor was written').toBeDefined();
    expect(desc?.body).not.toContain('iep:renderView');
    expect(desc?.body).toContain('iep:sealedByPublisher true');
  });

  it('★ and still advertises it for a relay-sealed payload, so the guard is not blanket', async () => {
    // Non-vacuity in the other direction: if `renderView` had simply been deleted, the assertion
    // above would pass for the wrong reason and thin clients would lose a capability that still
    // works for relay-sealed content.
    const { fetch, writes } = recordingFetch();
    await publish(descriptor(), '<urn:g> <p> "o" .', POD, {
      fetch,
      encrypt: { recipients: [REAL_PAIR.publicKey], senderKeyPair: REAL_PAIR },
      visibility: 'shared', relayBaseUrl: 'https://relay.example',
    });
    const desc = writes.find((w) => w.url.endsWith('.ttl'));
    expect(desc?.body).toContain('iep:renderView');
    expect(desc?.body).not.toContain('iep:sealedByPublisher');
  });
});
