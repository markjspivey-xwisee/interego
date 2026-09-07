import type { FetchResponse } from './types.js';

/** Text stays text; binary representations must survive an MCP/JSON round trip. */
export async function readResponseBody(response: FetchResponse): Promise<{ body: string; bodyEncoding?: 'base64' }> {
  const mediaType = (response.headers?.get('content-type') ?? '').split(';')[0]!.trim().toLowerCase();
  const textual = !mediaType || mediaType.startsWith('text/') || /(?:json|xml|javascript|turtle|trig|n-triples|n-quads|sparql-query|x-www-form-urlencoded)$/.test(mediaType);
  if (textual) return { body: await response.text() };
  if (!response.arrayBuffer) throw new Error(`Transport cannot read binary ${mediaType} without corrupting its bytes.`);
  const bytes = new Uint8Array(await response.arrayBuffer());
  let binary = '';
  for (let i = 0; i < bytes.length; i += 8192) binary += String.fromCharCode(...bytes.subarray(i, i + 8192));
  return { body: btoa(binary), bodyEncoding: 'base64' };
}
