import { createHash } from 'node:crypto';
import { parseHypermediaMarkdown } from '../../packages/core/dist/kernel/hypermedia-markdown.js';

/** Preinstalled media-type interpreters, independent of the workflow domain. */
export function projectRepresentation(format, data) {
  if (format === 'json') {
    if (data.status !== 'ok' || !/^application\/(?:[a-z0-9.+-]+\+)?json(?:;|$)/iu.test(data.contentType ?? '')) throw new Error('Expected a successful JSON representation');
    return JSON.parse(data.representation);
  }
  if (format === 'hmd') {
    if (data.status !== 'ok' || !/^text\/markdown(?:;|$)/iu.test(data.contentType ?? '')) throw new Error('Expected a successful HyperMarkdown representation');
    return parseHypermediaMarkdown(data.representation);
  }
  if (format === 'signed-json') {
    if (data.authorship?.authorshipVerified !== true || data.authorship?.contentBinding !== 'bound'
        || data.authorship?.descriptorBinding?.bound !== true) throw new Error('Unverified signed document');
    // Compatibility with the existing application-runtime signed JSON format.
    // Historical publications can contain nested named-graph wrappers. Match its
    // narrow literal fields, verify their byte digest, and never use this format
    // to store or execute a procedure. New procedures are native RDF graphs.
    const graph = data.graph?.content ?? data.content ?? '';
    if (!/@prefix\s+ia:\s*<urn:interego:application:>\s*\./u.test(graph)) throw new Error('Missing application namespace');
    const one = key => {
      const terms = [...graph.matchAll(new RegExp('(?:^|\\n)\\s*(?:ia:' + key + '|<urn:interego:application:' + key + '>)\\s+"([^"\\r\\n]+)"', 'gu'))];
      if (terms.length !== 1) throw new Error('Ambiguous signed document field');
      return terms[0][1];
    };
    if (one('format') !== 'canonical-json/v1') throw new Error('Unsupported signed document format');
    const text = Buffer.from(one('jsonBase64'), 'base64').toString('utf8');
    if (createHash('sha256').update(text).digest('hex') !== one('sha256')) throw new Error('Signed JSON digest mismatch');
    return { document: JSON.parse(text), documentDigest: one('sha256'), signedBy: data.authorship.signedBy, descriptorUrl: data.url };
  }
  throw new Error('No installed interpreter for the declared representation');
}
