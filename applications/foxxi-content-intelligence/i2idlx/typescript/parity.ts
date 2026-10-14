/** Independent RDF isomorphism checks, including blank nodes and literal datatypes. */
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { readFile } from 'node:fs/promises';
import { Parser, Store, Writer } from './rdf.js';

const require = createRequire(import.meta.url);
const jsonld = require('jsonld') as {
  toRDF(input: unknown, options: Record<string, unknown>): Promise<string>;
  canonize(input: string, options: Record<string, unknown>): Promise<string>;
};

export async function canonicalRdf(content: string, format: 'turtle' | 'jsonld' = 'turtle', base?: string): Promise<string> {
  let quads: string;
  if (format === 'jsonld') {
    quads = await jsonld.toRDF(JSON.parse(content), { format: 'application/n-quads', ...(base ? { base } : {}) });
  } else {
    const parsed = new Parser({ ...(base ? { baseIRI: base } : {}) }).parse(content);
    const writer = new Writer({ format: 'N-Quads' });
    writer.addQuads(new Store(parsed).getQuads(null, null, null, null));
    quads = await new Promise<string>((resolve, reject) => writer.end((error, result) => error ? reject(error) : resolve(result)));
  }
  return jsonld.canonize(quads, { algorithm: 'URDNA2015', inputFormat: 'application/n-quads', format: 'application/n-quads' });
}

export async function rdfFingerprint(content: string, format: 'turtle' | 'jsonld' = 'turtle', base?: string): Promise<string> {
  return createHash('sha256').update(await canonicalRdf(content, format, base)).digest('hex');
}

export async function compareRdfFiles(expected: string, actual: string, base?: string): Promise<{ isomorphic: boolean; expectedHash: string; actualHash: string }> {
  const [a, b] = await Promise.all([readFile(expected, 'utf8'), readFile(actual, 'utf8')]);
  const [expectedHash, actualHash] = await Promise.all([rdfFingerprint(a, 'turtle', base), rdfFingerprint(b, 'turtle', base)]);
  return { isomorphic: expectedHash === actualHash, expectedHash, actualHash };
}
