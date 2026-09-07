import { describe, expect, it } from 'vitest';
import { act, followAffordance, type IRI } from '@interego/core';

const bytes = new Uint8Array([80, 75, 3, 4, 0, 255, 128, 192, 254, 1]);
const descriptor = '@prefix iep: <https://markjspivey-xwisee.github.io/interego/ns/iep#> . @prefix hydra: <http://www.w3.org/ns/hydra/core#> . <urn:download> a iep:Affordance; iep:action <urn:download>; hydra:target <https://example.test/file>; hydra:method "GET" .';
const fetcher: typeof fetch = async url => String(url).endsWith('/descriptor') ? new Response(descriptor) : new Response(bytes, { headers: { 'content-type': 'application/zip' } });
describe('binary artifact bytes survive both affordance invocation paths', () => {
  it.each(['resolved', 'descriptor', 'follower'] as const)('%s returns reversible base64 with an explicit encoding', async path => {
    const result = path === 'follower' ? await followAffordance('https://example.test/descriptor', 'urn:download', {}, { fetch: fetcher })
      : await act(path === 'resolved' ? { target: 'https://example.test/file' as IRI, action: 'urn:download' as IRI, method: 'GET' }
        : { descriptorUrl: 'https://example.test/descriptor' as IRI, actionIri: 'urn:download' as IRI }, {}, { fetch: fetcher });
    expect(result.bodyEncoding).toBe('base64');
    expect(Buffer.from(result.body, 'base64')).toEqual(Buffer.from(bytes));
    expect(result.contentType).toBe('application/zip');
  });
  it.each(['application/json', 'application/ld+json', 'application/xml', 'image/svg+xml', 'text/markdown', 'application/trig'])('preserves %s as text', async type => {
    const result = await act({ target: 'https://example.test/file' as IRI, action: 'urn:read' as IRI, method: 'GET' }, {}, { fetch: async () => new Response('héllo', { headers: { 'content-type': type } }) });
    expect(result.body).toBe('héllo'); expect(result.bodyEncoding).toBeUndefined();
  });
});
