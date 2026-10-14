/**
 * Restore upper-ontology modules from their recorded publisher bytes.
 * Pinned hashes and seed counts are invariants; this command never rewrites the
 * manifest or the manually checked peer index to bless newer upstream data.
 * rdf-parse v4 API: https://github.com/rubensworks/rdf-parse.js/tree/v4.0.0
 */
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, resolve, relative, isAbsolute } from 'node:path';
import { Readable } from 'node:stream';
import { fileURLToPath } from 'node:url';
import { PREFIXES } from './semantic.js';
import { Store, RDF, RDFS, OWL, parseTurtle, serializeTurtle, type Term, type Quad } from './rdf.js';

const require = createRequire(import.meta.url);
interface ParserApi {
  parse(input: Readable, options: { contentType: string; baseIRI: string }): Readable;
}
const { rdfParser } = require('rdf-parse') as { rdfParser: ParserApi };
interface Source {
  key: string; prefixes: string[]; format: string; url: string; version: string; license: string;
  whole?: boolean; exclude?: string[]; englishOnly?: boolean; accept?: string;
}
interface ContextSource { prefix: string; url: string; title: string }
interface SourceData { SOURCES: Source[]; INTEREGO: Record<string, string>; CONTEXTS: ContextSource[] }
interface Pin {
  key: string; url: string; sha256: string; file?: string; triples?: number; kept?: number;
  seeds?: number; missing?: string[]; terms?: number; mode: string;
}
interface PeerTerm { label: string; source: string; method: string; definition?: string | null }
interface PeerIndex { checked: string; terms: Record<string, PeerTerm> }
const sources = JSON.parse(readFileSync(new URL('./refresh-upper-data.json', import.meta.url), 'utf8')) as SourceData;

function hash(raw: Uint8Array): string { return createHash('sha256').update(raw).digest('hex'); }
function checkedPath(root: string, file: string): string {
  const path = resolve(root, file), rel = relative(resolve(root), path);
  if (isAbsolute(rel) || rel === '..' || rel.startsWith('..' + '/') || rel.startsWith('..' + '\\')) throw new Error('snapshot path escapes root: ' + file);
  return path;
}
export function referenced_terms(): Set<string> {
  const data: unknown = JSON.parse(readFileSync(new URL('./semantic-data.json', import.meta.url), 'utf8'));
  const out = new Set<string>(), prefixes = new Set(Object.keys(PREFIXES));
  function walk(value: unknown): void {
    if (typeof value === 'string') {
      const m = /^([^:]+):[A-Za-z0-9_.-]+$/.exec(value);
      if (m && prefixes.has(m[1]!)) out.add(value);
    } else if (Array.isArray(value)) for (const item of value) walk(item);
    else if (value && typeof value === 'object') for (const item of Object.values(value)) walk(item);
  }
  walk(data);
  return out;
}
function expand(curie: string): string {
  const colon = curie.indexOf(':'), prefix = curie.slice(0, colon), ns = PREFIXES[prefix];
  if (!ns) throw new Error('unknown semantic prefix ' + curie);
  return ns + curie.slice(colon + 1);
}
/** A local cache is trusted only after the same raw-byte hash as a fresh fetch. */
async function fetchPinned(pin: Pin, cache: string, accept?: string): Promise<Buffer> {
  if (!/^[a-f0-9]{64}$/.test(pin.sha256)) throw new Error('missing SHA-256 pin for ' + pin.key);
  const cached = join(cache, pin.key + '.source');
  let raw: Buffer;
  if (existsSync(cached)) raw = readFileSync(cached);
  else {
    let last: unknown;
    let downloaded: Buffer | undefined;
    for (let attempt = 0; attempt < 4; attempt++) {
      try {
        const response = await fetch(pin.url, {
          headers: { 'User-Agent': 'i2idlx-refresh-upper-typescript/0.5', ...(accept ? { Accept: accept } : {}) },
          signal: AbortSignal.timeout(30000),
        });
        if (!response.ok) throw new Error(pin.url + ' returned HTTP ' + response.status);
        downloaded = Buffer.from(await response.arrayBuffer());
        break;
      } catch (error) {
        last = error;
        if (attempt < 3) await new Promise(r => setTimeout(r, 2000 * (attempt + 1)));
      }
    }
    if (!downloaded) throw last;
    raw = downloaded;
  }
  const actual = hash(raw);
  if (actual !== pin.sha256) throw new Error(pin.key + ': publisher bytes have SHA-256 ' + actual + ', expected ' + pin.sha256 + '; refusing to refresh the pin');
  return raw;
}
export async function parseSnapshot(raw: Buffer, format: string, base: string): Promise<Store> {
  if (format === 'turtle') return parseTurtle(raw.toString('utf8'), base);
  if (format !== 'xml') throw new Error('unsupported snapshot format ' + format);
  const store = new Store(), stream = rdfParser.parse(Readable.from([raw]), { contentType: 'application/rdf+xml', baseIRI: base });
  return new Promise<Store>((resolvePromise, reject) => {
    stream.on('data', (quad: Quad) => { store.addQuad(quad); });
    stream.once('error', reject);
    stream.once('end', () => resolvePromise(store));
  });
}
function termKey(term: Term): string { return term.termType + ':' + term.value; }
function objects(graph: Store, subject: Term, predicate: string): Term[] {
  return graph.getQuads(subject, predicate, null, null).map(q => q.object);
}
function list(graph: Store, head: Term): Term[] {
  const out: Term[] = [], seen = new Set<string>();
  let current = head;
  while (current.value !== RDF + 'nil') {
    const key = termKey(current);
    if (seen.has(key)) throw new Error('cyclic RDF collection at ' + current.value);
    seen.add(key);
    const first = objects(graph, current, RDF + 'first')[0], rest = objects(graph, current, RDF + 'rest')[0];
    if (!first || !rest) throw new Error('incomplete RDF collection at ' + current.value);
    out.push(first);
    current = rest;
  }
  return out;
}
function namedUp(graph: Store, node: Term, out: Map<string, Term>, visited = new Set<string>()): void {
  if (node.termType === 'NamedNode') { out.set(node.value, node); return; }
  if (node.termType !== 'BlankNode' || visited.has(termKey(node))) return;
  visited.add(termKey(node));
  const intersection = objects(graph, node, OWL + 'intersectionOf')[0];
  if (intersection) for (const member of list(graph, intersection)) namedUp(graph, member, out, visited);
}
function copyNode(graph: Store, keep: Store, node: Term, visited = new Set<string>()): void {
  const key = termKey(node);
  if (visited.has(key)) return;
  visited.add(key);
  for (const q of graph.getQuads(node, null, null, null)) {
    if (q.predicate.value === OWL + 'imports') continue;
    keep.addQuad(q);
    if (q.object.termType === 'BlankNode') copyNode(graph, keep, q.object, visited);
  }
}
const STRUCT_UP = [RDFS + 'subClassOf', OWL + 'equivalentClass', RDFS + 'subPropertyOf', OWL + 'equivalentProperty',
  OWL + 'inverseOf', RDFS + 'domain', RDFS + 'range'];
export function upwardModule(graph: Store, seeds: ReadonlySet<string>, exclude: readonly string[] = []): Store {
  const keep = new Store(), seen = new Set<string>(), queue: Term[] = [];
  for (const seed of seeds) {
    const term = graph.getQuads(seed, null, null, null)[0]?.subject;
    if (term) queue.push(term);
  }
  while (queue.length) {
    const subject = queue.pop()!;
    if (seen.has(subject.value)) continue;
    seen.add(subject.value);
    if (exclude.some(prefix => subject.value.startsWith(prefix))) continue;
    copyNode(graph, keep, subject);
    const next = new Map<string, Term>();
    for (const predicate of STRUCT_UP) for (const object of objects(graph, subject, predicate)) namedUp(graph, object, next);
    queue.push(...[...next.values()].filter(term => !seen.has(term.value)));
  }
  for (const q of graph.getQuads(null, OWL + 'disjointWith', null, null)) if (seen.has(q.subject.value) && seen.has(q.object.value)) keep.addQuad(q);
  for (const q of graph.getQuads(null, RDF + 'type', OWL + 'AllDisjointClasses', null)) {
    const head = objects(graph, q.subject, OWL + 'members')[0];
    if (head && list(graph, head).filter(member => seen.has(member.value)).length >= 2) copyNode(graph, keep, q.subject);
  }
  for (const q of graph.getQuads(null, RDF + 'type', OWL + 'Ontology', null)) copyNode(graph, keep, q.subject);
  return keep;
}
function contextTerms(raw: Buffer, context: ContextSource): Record<string, PeerTerm> {
  const data = (JSON.parse(raw.toString('utf8')) as { '@context': Record<string, unknown> })['@context'];
  const out: Record<string, PeerTerm> = {}, namespace = PREFIXES[context.prefix]!;
  function walk(map: Record<string, unknown>): void {
    for (const [label, value] of Object.entries(map)) {
      const object = value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
      let iri: unknown = typeof value === 'string' ? value : object?.['@id'];
      if (typeof iri === 'string') {
        const colon = iri.indexOf(':'), prefix = iri.slice(0, colon);
        if (iri.startsWith(context.prefix + ':')) iri = namespace + iri.slice(colon + 1);
        else if (colon >= 0 && typeof map[prefix] === 'string') iri = String(map[prefix]) + iri.slice(colon + 1);
        if (String(iri).startsWith(namespace) && !out[String(iri)]) out[String(iri)] = { label, source: context.url, method: 'JSON-LD context' };
      }
      const nested = object?.['@context'];
      if (nested && typeof nested === 'object' && !Array.isArray(nested)) walk(nested as Record<string, unknown>);
    }
  }
  walk(data);
  return out;
}

export async function refreshUpper(root: string): Promise<void> {
  root = resolve(root);
  const manifest = JSON.parse(readFileSync(join(root, 'evidence', 'upper', 'manifest.json'), 'utf8')) as { sources: Pin[] };
  const pins = new Map(manifest.sources.map(pin => [pin.key, pin]));
  const cache = join(root, '.cache', 'upper'), terms = referenced_terms();
  const planned = new Map<string, Buffer>(), raws = new Map<string, Buffer>();
  function pinFor(key: string, url: string): Pin {
    const pin = pins.get(key);
    if (!pin || pin.url !== url) throw new Error(key + ': source differs from the pinned manifest');
    return pin;
  }
  for (const source of sources.SOURCES) {
    const pin = pinFor(source.key, source.url), raw = await fetchPinned(pin, cache, source.accept);
    const graph = await parseSnapshot(raw, source.format, source.url);
    const seeds = new Set([...terms].filter(term => source.prefixes.some(prefix => term.startsWith(prefix))).map(expand));
    const missing = [...seeds].filter(seed => graph.getQuads(seed, null, null, null).length === 0).sort();
    if (graph.size !== pin.triples || seeds.size !== pin.seeds || JSON.stringify(missing) !== JSON.stringify(pin.missing)) {
      throw new Error(source.key + ': snapshot triples, semantic seeds or missing terms differ from the pin; review a new evidence version explicitly');
    }
    let keep = source.whole ? new Store(graph.getQuads(null, null, null, null).filter(q => q.predicate.value !== OWL + 'imports')) :
      upwardModule(graph, seeds, source.exclude || []);
    if (source.englishOnly) keep = new Store(keep.getQuads(null, null, null, null).filter(q =>
      q.object.termType !== 'Literal' || !q.object.language || q.object.language.startsWith('en')));
    if (keep.size !== pin.kept) throw new Error(source.key + ': extracted module has ' + keep.size + ' triples, expected ' + pin.kept);
    if (!pin.file) throw new Error(source.key + ': snapshot has no pinned output path');
    const header = '# Snapshot of ' + source.url + '\n# ' + source.version + ' — ' + source.license + '\n';
    planned.set(checkedPath(root, pin.file), Buffer.from(header + await serializeTurtle(keep, { ...PREFIXES })));
    raws.set(join(cache, source.key + '.source'), raw);
    process.stdout.write(source.key + ': ' + graph.size + ' → ' + keep.size + ' triples; ' + seeds.size + ' pinned seeds\n');
  }
  for (const [name, url] of Object.entries(sources.INTEREGO)) {
    const pin = pinFor('interego-' + name, url), raw = await fetchPinned(pin, cache);
    parseTurtle(raw.toString('utf8'), url);
    if (!pin.file) throw new Error(pin.key + ': snapshot has no pinned output path');
    planned.set(checkedPath(root, pin.file), raw);
    raws.set(join(cache, pin.key + '.source'), raw);
  }
  const peers = JSON.parse(readFileSync(join(root, 'evidence', 'peer-terms.json'), 'utf8')) as PeerIndex;
  for (const context of sources.CONTEXTS) {
    const pin = pinFor(context.prefix, context.url), raw = await fetchPinned(pin, cache);
    const found = contextTerms(raw, context);
    if (Object.keys(found).length !== pin.terms) throw new Error(context.prefix + ': context term count differs from pin');
    for (const [iri, term] of Object.entries(found)) {
      const old = peers.terms[iri];
      if (!old || old.label !== term.label || old.source !== term.source || old.method !== term.method) throw new Error(context.prefix + ': context term differs from checked peer index: ' + iri);
    }
    raws.set(join(cache, pin.key + '.source'), raw);
  }
  // Validate every source first; only then materialize the restored artifacts.
  for (const [path, raw] of [...raws, ...planned]) { mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, raw); }
  process.stdout.write('Restored pinned upper-ontology evidence; manifest and checked peer index retained.\n');
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const root = process.argv[2] || resolve(dirname(fileURLToPath(import.meta.url)), '..');
  await refreshUpper(root);
}
