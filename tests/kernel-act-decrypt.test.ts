/**
 * Kernel `act` × `iep:canDecrypt` integration test.
 *
 * Verifies the server-side decrypt path for authorized recipients:
 *
 *   1. The `iep:canDecrypt` affordance (hydra:method=GET, hydra:target=<envelope>)
 *      is recognised by `act()` as having decrypt semantics.
 *   2. When `act` is given `recipientKeyPair` AND the keypair is in the
 *      envelope's recipient set, the body of the act() result is the
 *      plaintext Turtle (NOT the raw `application/jose+json` envelope).
 *   3. When the keypair is NOT a recipient, the body is the raw envelope —
 *      so the existing "encrypted-no-key" UX is preserved.
 *   4. The descriptor-resolved invocation form
 *      `act({ descriptorUrl, actionIri: iep:canDecrypt })` also unwraps —
 *      this is the path MCP `invoke_affordance` / Path A traffic takes.
 *
 * The kernel `act()` previously did a raw HTTP GET and returned the
 * ciphertext body verbatim — `iep:canDecrypt` was advertised on the
 * affordance graph but had no operational meaning. These tests pin the
 * fixed semantics.
 */

import { describe, it, expect } from 'vitest';
import {
  act,
  createEncryptedEnvelope,
  generateKeyPair,
} from '@interego/core';
import type { FetchFn } from '@interego/core';

const CG_CAN_DECRYPT_FULL =
  'https://markjspivey-xwisee.github.io/interego/ns/iep#canDecrypt';

// Build a minimal fetch mock that serves (a) a descriptor with a
// `iep:canDecrypt` affordance pointing at (b) an envelope URL whose body
// is the JOSE+JSON envelope produced by `createEncryptedEnvelope`.
function buildMockFetch(opts: {
  descriptorUrl: string;
  envelopeUrl: string;
  envelopeBody: string;
}): FetchFn {
  const descriptorTurtle = [
    '@prefix iep: <https://markjspivey-xwisee.github.io/interego/ns/iep#> .',
    '@prefix ieh: <https://markjspivey-xwisee.github.io/interego/ns/cgh#> .',
    '@prefix hydra: <http://www.w3.org/ns/hydra/core#> .',
    '@prefix dcat: <http://www.w3.org/ns/dcat#> .',
    `<${opts.descriptorUrl}> iep:affordance [`,
    '  a iep:Affordance, ieh:Affordance, hydra:Operation, dcat:Distribution ;',
    '  iep:action iep:canDecrypt ;',
    '  hydra:method "GET" ;',
    `  hydra:target <${opts.envelopeUrl}> ;`,
    `  dcat:accessURL <${opts.envelopeUrl}> ;`,
    '  dcat:mediaType "application/jose+json" ;',
    '  iep:encrypted true',
    '] .',
  ].join('\n');

  return (async (url: string, _init?: unknown) => {
    if (url === opts.descriptorUrl) {
      return {
        ok: true,
        status: 200,
        statusText: 'OK',
        headers: {
          get: (h: string) =>
            h.toLowerCase() === 'content-type' ? 'text/turtle' : null,
        },
        text: async () => descriptorTurtle,
      } as unknown as Response;
    }
    if (url === opts.envelopeUrl) {
      return {
        ok: true,
        status: 200,
        statusText: 'OK',
        headers: {
          get: (h: string) =>
            h.toLowerCase() === 'content-type' ? 'application/jose+json' : null,
        },
        text: async () => opts.envelopeBody,
      } as unknown as Response;
    }
    throw new Error(`unexpected fetch url: ${url}`);
  }) as unknown as FetchFn;
}

describe('kernel.act + iep:canDecrypt server-side decrypt', () => {
  const descriptorUrl = 'https://pod.test/alice/ctx/secret.ttl';
  const envelopeUrl = 'https://pod.test/alice/ctx/secret-graph.envelope.jose.json';
  const plaintext = '<a> <b> <c> .';

  it('pre-resolved affordance: recipient keypair → plaintext body', async () => {
    const author = generateKeyPair();
    const envelope = createEncryptedEnvelope(plaintext, [author.publicKey], author);
    const envelopeBody = JSON.stringify(envelope);
    const fetch = buildMockFetch({ descriptorUrl, envelopeUrl, envelopeBody });

    const result = await act(
      {
        action: CG_CAN_DECRYPT_FULL,
        target: envelopeUrl,
        method: 'GET',
        mediaType: 'application/jose+json',
      },
      undefined,
      { fetch, recipientKeyPair: author },
    );

    expect(result.status).toBe(200);
    expect(result.body).toBe(plaintext);
    // Not the raw envelope.
    expect(result.body.startsWith('{')).toBe(false);
  });

  it('pre-resolved affordance: non-recipient → raw envelope JSON', async () => {
    const author = generateKeyPair();
    const stranger = generateKeyPair();
    const envelope = createEncryptedEnvelope(plaintext, [author.publicKey], author);
    const envelopeBody = JSON.stringify(envelope);
    const fetch = buildMockFetch({ descriptorUrl, envelopeUrl, envelopeBody });

    const result = await act(
      {
        action: CG_CAN_DECRYPT_FULL,
        target: envelopeUrl,
        method: 'GET',
        mediaType: 'application/jose+json',
      },
      undefined,
      { fetch, recipientKeyPair: stranger },
    );

    // Body is the raw envelope JSON (decrypt yielded null → fall through).
    expect(result.body).toBe(envelopeBody);
  });

  it('pre-resolved affordance: no recipientKeyPair → raw envelope JSON (no decrypt attempted)', async () => {
    const author = generateKeyPair();
    const envelope = createEncryptedEnvelope(plaintext, [author.publicKey], author);
    const envelopeBody = JSON.stringify(envelope);
    const fetch = buildMockFetch({ descriptorUrl, envelopeUrl, envelopeBody });

    const result = await act(
      {
        action: CG_CAN_DECRYPT_FULL,
        target: envelopeUrl,
        method: 'GET',
        mediaType: 'application/jose+json',
      },
      undefined,
      { fetch },
    );

    expect(result.body).toBe(envelopeBody);
  });

  it('descriptor-resolved form: act({descriptorUrl, actionIri: iep:canDecrypt}) returns plaintext', async () => {
    const author = generateKeyPair();
    const envelope = createEncryptedEnvelope(plaintext, [author.publicKey], author);
    const envelopeBody = JSON.stringify(envelope);
    const fetch = buildMockFetch({ descriptorUrl, envelopeUrl, envelopeBody });

    const result = await act(
      { descriptorUrl, actionIri: CG_CAN_DECRYPT_FULL },
      undefined,
      { fetch, recipientKeyPair: author },
    );

    expect(result.status).toBe(200);
    expect(result.body).toBe(plaintext);
    expect(result.affordance.action).toBe(CG_CAN_DECRYPT_FULL);
    expect(result.affordance.target).toBe(envelopeUrl);
    expect(result.affordance.method).toBe('GET');
  });

  it('★★ mayDecrypt is asked about the URL FETCHED, not the descriptor authorised', async () => {
    /**
     * The hole this closes: a host may hold a key on behalf of callers and authorise its use
     * against a DESCRIPTOR the caller legitimately controls. The descriptor's `hydra:target`
     * is chosen by its author and can name a resource anywhere, and the kernel follows it
     * holding that key. "Authorise on a descriptor I control, decrypt what it points at."
     *
     * So the callback is handed `envelopeUrl` — what was actually fetched — and refusing it
     * leaves the envelope sealed. Refusing is not a new failure mode: the caller sees exactly
     * what a non-recipient sees, the raw envelope JSON.
     */
    const author = generateKeyPair();
    const envelope = createEncryptedEnvelope(plaintext, [author.publicKey], author);
    const envelopeBody = JSON.stringify(envelope);
    const fetch = buildMockFetch({ descriptorUrl, envelopeUrl, envelopeBody });

    const asked: string[] = [];
    const result = await act(
      { descriptorUrl, actionIri: CG_CAN_DECRYPT_FULL },
      undefined,
      {
        fetch,
        recipientKeyPair: author,
        mayDecrypt: (url: string) => { asked.push(url); return false; },
      },
    );

    // The key was held and the recipient WAS entitled to the content — the only reason this
    // stays sealed is that the fetched URL was refused. That is the whole assertion.
    expect(asked).toEqual([envelopeUrl]);
    expect(result.body).not.toBe(plaintext);
    expect(JSON.parse(result.body)).toMatchObject({ wrappedKeys: expect.any(Array) });
  });

  it('mayDecrypt returning true leaves the entitled path working', async () => {
    const author = generateKeyPair();
    const envelope = createEncryptedEnvelope(plaintext, [author.publicKey], author);
    const fetch = buildMockFetch({ descriptorUrl, envelopeUrl, envelopeBody: JSON.stringify(envelope) });
    const result = await act(
      { descriptorUrl, actionIri: CG_CAN_DECRYPT_FULL },
      undefined,
      { fetch, recipientKeyPair: author, mayDecrypt: () => true },
    );
    expect(result.body).toBe(plaintext);
  });

  it('descriptor-resolved form: non-recipient → raw envelope JSON', async () => {
    const author = generateKeyPair();
    const stranger = generateKeyPair();
    const envelope = createEncryptedEnvelope(plaintext, [author.publicKey], author);
    const envelopeBody = JSON.stringify(envelope);
    const fetch = buildMockFetch({ descriptorUrl, envelopeUrl, envelopeBody });

    const result = await act(
      { descriptorUrl, actionIri: CG_CAN_DECRYPT_FULL },
      undefined,
      { fetch, recipientKeyPair: stranger },
    );

    expect(result.body).toBe(envelopeBody);
  });
});
