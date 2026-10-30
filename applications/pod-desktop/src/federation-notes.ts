import { parseTrig, type IRI } from '@interego/core';
import type { FederationResource } from '@interego/pod-federation';

/** Optional note presentation; the original resource is always retained unchanged. */
export function presentSharedResource(resource: FederationResource): FederationResource & { note?: { title: string; body: string } } {
  const match = resource.iri.match(/^urn:graph:pod-note:([0-9a-f-]{36})$/i);
  if (resource.mediaType !== 'text/turtle' || !match) return resource;
  try {
    const subject = parseTrig(resource.content).subjects.find(value => value.subject === `urn:uuid:${match[1]}`);
    const terms = subject?.properties.get('http://www.w3.org/1999/02/22-rdf-syntax-ns#value' as IRI);
    if (terms?.length !== 1 || terms[0]?.kind !== 'literal') return resource;
    const value = JSON.parse(terms[0].value) as Record<string, unknown>;
    if (value['id'] !== match[1] || typeof value['title'] !== 'string' || value['title'].length > 160
      || typeof value['body'] !== 'string' || value['body'].length > 50_000) return resource;
    return { ...resource, note: { title: value['title'], body: value['body'] } };
  } catch { return resource; }
}
