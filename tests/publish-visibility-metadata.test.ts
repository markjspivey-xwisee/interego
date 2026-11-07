import { describe, expect, it } from 'vitest';
import {
  ContextDescriptor,
  generateKeyPair,
  openEncryptedEnvelope,
  parseHypermediaMarkdown,
  renderHypermediaMarkdown,
  type EncryptedEnvelope,
  type IRI,
} from '@interego/core';
import { parseDistributionFromDescriptorTurtle, publish } from '@interego/solid';
import { inlineRenderedForDescriptor } from '../deploy/mcp-relay/note-view.js';

const POD = 'https://pod.example/owner/';
const BODY = 'A synthetic audience-label proof.';
const GRAPH = `@prefix schema: <https://schema.org/> .
<urn:graph:audience-proof> a schema:NoteDigitalDocument ; schema:text "${BODY}" .`;

function recorder() {
  const writes: Array<{ url: string; body: string }> = [];
  const fetch = async (url: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const address = String(url);
    if ((init?.method ?? 'GET') === 'GET') return new Response('', { status: 404 });
    writes.push({ url: address, body: String(init?.body ?? '') });
    return new Response('', { status: 201 });
  };
  return { fetch, writes };
}

function descriptor(suffix: string) {
  return ContextDescriptor.create(`urn:iep:audience-proof:${suffix}` as IRI)
    .describes('urn:graph:audience-proof' as IRI)
    .temporal({ validFrom: '2026-11-03T00:00:00Z' })
    .selfAsserted('did:web:author.example' as IRI)
    .build();
}

describe('published audience metadata survives a real SDK write and HMD read', () => {
  it.each(['public', 'private', 'shared'] as const)('%s retains its exact class without changing encryption recipients', async visibility => {
    const { fetch, writes } = recorder();
    const author = generateKeyPair(), peer = generateKeyPair(), outsider = generateKeyPair();
    const recipients = visibility === 'shared' ? [author.publicKey, peer.publicKey] : [author.publicKey];
    const result = await publish(descriptor(visibility), GRAPH, POD, {
      fetch, visibility, relayBaseUrl: 'https://relay.example',
      ...(visibility === 'public' ? {} : { encrypt: { recipients, senderKeyPair: author } }),
    });
    const storedDescriptor = writes.find(write => write.url === result.descriptorUrl)?.body;
    expect(storedDescriptor, 'the SDK wrote its descriptor').toBeDefined();
    const distribution = parseDistributionFromDescriptorTurtle(storedDescriptor!);
    expect(distribution?.visibility).toBe(visibility);
    expect(distribution?.encrypted).toBe(visibility !== 'public');
    const storedPayload = writes.find(write => write.url === distribution?.accessURL)?.body;
    expect(storedPayload).toBeDefined();

    let plaintext: string;
    if (visibility === 'public') {
      expect(storedPayload).toContain(BODY);
      expect(storedPayload).not.toContain('wrappedKeys');
      plaintext = storedPayload!;
    } else {
      const envelope = JSON.parse(storedPayload!) as EncryptedEnvelope;
      expect(envelope.wrappedKeys.map(key => key.recipientPublicKey)).toEqual(recipients);
      plaintext = openEncryptedEnvelope(envelope, author)!;
      expect(plaintext).toContain(BODY);
      expect(openEncryptedEnvelope(envelope, peer) !== null).toBe(visibility === 'shared');
      expect(openEncryptedEnvelope(envelope, outsider)).toBeNull();
      for (const write of writes) expect(write.body).not.toContain(BODY);
    }
    const view = inlineRenderedForDescriptor({
      descriptorUrl: result.descriptorUrl, descriptorTurtle: storedDescriptor!, plaintextTurtle: plaintext,
      publicBase: 'https://relay.example', port: 8787,
    });
    expect(view, 'the stored note can be projected after an authorized plaintext read').not.toBeNull();
    expect(parseHypermediaMarkdown(view!.rendered).state).toBe(visibility);
    expect(view!.rendered).toContain(BODY);
    if (visibility === 'shared') expect(view!.rendered).not.toContain('Private note');
  });

  it('shared remains shared with one envelope key, so the audience is not a key-count heuristic', async () => {
    const { fetch, writes } = recorder();
    const author = generateKeyPair();
    const result = await publish(descriptor('shared-single-key'), GRAPH, POD, {
      fetch, visibility: 'shared', encrypt: { recipients: [author.publicKey], senderKeyPair: author },
    });
    const turtle = writes.find(write => write.url === result.descriptorUrl)!.body;
    const distribution = parseDistributionFromDescriptorTurtle(turtle)!;
    const envelope = JSON.parse(writes.find(write => write.url === distribution.accessURL)!.body) as EncryptedEnvelope;
    expect(envelope.wrappedKeys).toHaveLength(1);
    expect(distribution.visibility).toBe('shared');
  });

  it('an SDK caller that omits visibility does not gain an invented audience declaration', async () => {
    const { fetch, writes } = recorder();
    const result = await publish(descriptor('unspecified'), GRAPH, POD, { fetch });
    const turtle = writes.find(write => write.url === result.descriptorUrl)!.body;
    expect(parseDistributionFromDescriptorTurtle(turtle)?.visibility).toBeUndefined();
    const view = inlineRenderedForDescriptor({
      descriptorUrl: result.descriptorUrl, descriptorTurtle: turtle, plaintextTurtle: GRAPH,
      publicBase: 'https://relay.example', port: 8787,
    });
    expect(parseHypermediaMarkdown(view!.rendered).state).toBe('unknown');
  });
});

describe('generic HMD lifecycle states remain independent of note audience labels', () => {
  it.each(['ready', 'completed', 'blocked', 'needs-decision'])('preserves %s', state => {
    const markdown = renderHypermediaMarkdown({
      id: 'https://review.example/result', type: 'hmd:Document',
      descriptorUrl: 'https://review.example/descriptor.ttl', state, controls: [], body: 'Review lifecycle.',
    });
    expect(parseHypermediaMarkdown(markdown).state).toBe(state);
  });
});
