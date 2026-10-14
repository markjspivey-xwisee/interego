/**
 * Native evidence refresh for I2IDL-X. All downloads are parsed as data before
 * replacement; released Foxxi modules and the reasoner are checked against the
 * SHA-256 pins in config.json. The build itself stays entirely offline.
 */
import { readFileSync, existsSync } from 'node:fs';
import { mkdir, mkdtemp, writeFile, rename, readdir, rm, rmdir } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { resolve, join, dirname, isAbsolute, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createRequire } from 'node:module';
import { execFileSync } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import { loadConfig } from './config.js';

type Value = ReturnType<typeof JSON.parse>;
type Row = Record<string, Value>;
type Term = { value: string; termType: string; language?: string; datatype?: { value: string } };
const requireRoot = createRequire(import.meta.url);
const { Parser, Store, DataFactory } = requireRoot('n3');
const jsonld = requireRoot('jsonld');
const RDF = 'http://www.w3.org/1999/02/22-rdf-syntax-ns#';
const RDFS = 'http://www.w3.org/2000/01/rdf-schema#';
const SKOS = 'http://www.w3.org/2004/02/skos/core#';
const DCT = 'http://purl.org/dc/terms/';
const IEP = 'https://markjspivey-xwisee.github.io/interego/ns/iep#';
const HYDRA = 'http://www.w3.org/ns/hydra/core#';
const UNESCO_SCHEME = 'http://vocabularies.unesco.org/thesaurus';
const UNESCO_API = 'https://vocabularies.unesco.org/rest/v1/unesco/data?format=application/ld%2Bjson&uri=';
const UA = 'i2idlx-refresh/1.0';
const bytesHash = (bytes: Uint8Array): string => createHash('sha256').update(bytes).digest('hex');
const decode = (bytes: Uint8Array): string => new TextDecoder('utf-8', { fatal: true }).decode(bytes);
const aslist = <T>(value: T | T[] | null | undefined): T[] => value == null ? [] : Array.isArray(value) ? value : [value];
const ids = (value: Value): string[] => aslist<Value>(value).map(x => typeof x === 'object' ? x['@id'] : x);
const log = (message: string): void => { process.stdout.write(message + '\n'); };
const lexical = (t: Term | null): string => t?.datatype?.value === 'http://www.w3.org/2001/XMLSchema#dateTime' ? t.value.replace(/Z$/, '+00:00') : t?.value || '';
const clean = (value: unknown): string => value == null ? '' : String(value).trim().replace(/\s+/gu, ' ');
const encodeIri = (value: string): string => encodeURIComponent(value).replace(/[!'()*]/g, c => '%' + c.charCodeAt(0).toString(16).toUpperCase());

class Graph {
  readonly store: Value;
  constructor(body: string, format = 'text/turtle', baseIRI?: string) { this.store = new Store(new Parser({ format, baseIRI }).parse(body)); }
  objects(s: string | Term | null, p: string): Term[] { return this.store.getQuads(typeof s === 'string' ? DataFactory.namedNode(s) : s, DataFactory.namedNode(p), null, null).map((q: Value) => q.object); }
  subjects(p: string, o: string | Term | null): Term[] {
    const seen = new Set<string>();
    return this.store.getQuads(null, DataFactory.namedNode(p), typeof o === 'string' ? DataFactory.namedNode(o) : o, null).map((q: Value) => q.subject)
      .filter((t: Term) => !seen.has(t.termType + ':' + t.value) && !!seen.add(t.termType + ':' + t.value));
  }
  value(s: string | Term, ...predicates: string[]): Term | null { for (const p of predicates) { const v = this.objects(s, p)[0]; if (v) return v; } return null; }
  english(s: string | Term, p: string): string[] { return this.objects(s, p).filter(t => t.termType === 'Literal' && t.language === 'en').map(t => t.value).sort(); }
}
export interface RefreshOptions {
  mode?: 'base' | 'app' | 'unesco' | 'all' | 'reasoner' | 'foxxi';
  distDir?: string; outputDir?: string; foxxiDir?: string; reasonerFile?: string;
  timeoutMs?: number; now?: string;
}
interface Retrieval { url: string; resolvedUrl: string; bytes: number; sha256: string; fetchedAt: string; }
export interface RefreshResult { mode: string; files: string[]; retrievals: Retrieval[]; }
interface Context {
  root: string; cfg: Row; evidence: string; dist: string; options: RefreshOptions;
  downloads: Retrieval[]; files: Map<string, Uint8Array>;
}
function isoNow(): string { return new Date().toISOString().replace(/\.\d{3}Z$/, '+00:00'); }
async function getBytes(ctx: Context, url: string, accept?: string, timeoutMs?: number): Promise<Uint8Array> {
  const parsed = new URL(url);
  if (parsed.protocol !== 'https:') throw new Error('Evidence download must use HTTPS: ' + url);
  const response = await fetch(url, { headers: { 'User-Agent': UA, ...(accept ? { Accept: accept } : {}) }, redirect: 'follow',
    signal: AbortSignal.timeout(timeoutMs || ctx.options.timeoutMs || 60000) });
  if (!response.ok) throw new Error('HTTP ' + response.status + ' for ' + url);
  if (new URL(response.url).protocol !== 'https:') throw new Error('Evidence redirect left HTTPS: ' + response.url);
  const declared = Number(response.headers.get('content-length') || 0);
  if (declared > 256 * 1024 * 1024) throw new Error('Evidence download exceeds 256 MiB: ' + url);
  const bytes = new Uint8Array(await response.arrayBuffer());
  if (bytes.byteLength > 256 * 1024 * 1024) throw new Error('Evidence download exceeds 256 MiB: ' + url);
  ctx.downloads.push({ url, resolvedUrl: response.url, bytes: bytes.length, sha256: bytesHash(bytes), fetchedAt: ctx.options.now || isoNow() });
  return bytes;
}
function keep(ctx: Context, name: string, value: string | Uint8Array): void {
  if (isAbsolute(name) || name.split(/[\\/]/u).includes('..')) throw new Error('Evidence name escapes the output directory: ' + name);
  ctx.files.set(name, typeof value === 'string' ? new TextEncoder().encode(value) : value);
}
function jsonText(value: unknown): string { return JSON.stringify(value, null, 1) + '\n'; }
function sortedRecord(record: Row): Row { return Object.fromEntries(Object.keys(record).sort().map(k => [k, record[k]])); }
function jsonEvidence(ctx: Context, name: string): Value {
  const bytes = ctx.files.get(name);
  return JSON.parse(bytes ? decode(bytes) : readFileSync(join(ctx.evidence, name), 'utf8'));
}
function manifestRows(graph: Graph): Row[] {
  return graph.subjects(RDF + 'type', IEP + 'Affordance').map(s => ({
    subject: s.value, action: lexical(graph.value(s, IEP + 'action')) || null, target: lexical(graph.value(s, HYDRA + 'target')) || null,
    method: lexical(graph.value(s, HYDRA + 'method')) || null, title: lexical(graph.value(s, HYDRA + 'title', RDFS + 'label')),
    desc: clean(lexical(graph.value(s, HYDRA + 'description', RDFS + 'comment'))).slice(0, 240), expects: lexical(graph.value(s, HYDRA + 'expects')) || null,
    collections: graph.objects(s, IEP + 'appliesToCollection').map(t => t.value).sort(), readOnly: graph.value(s, IEP + 'readOnlyHint') ? lexical(graph.value(s, IEP + 'readOnlyHint')) : null,
  })).sort((a, b) => (a.action || '') < (b.action || '') ? -1 : (a.action || '') > (b.action || '') ? 1 : 0);
}
async function refreshBase(ctx: Context): Promise<void> {
  const manifest = await getBytes(ctx, ctx.cfg.foxxiManifest, 'text/turtle'), graph = new Graph(decode(manifest), 'text/turtle', ctx.cfg.foxxiManifest);
  const rows = manifestRows(graph);
  if (!rows.length || rows.some(r => !r.action || !r.target || !r.method)) throw new Error('Foxxi manifest contains no usable affordances or an incomplete affordance');
  keep(ctx, 'foxxi-affordances.json', jsonText(rows)); keep(ctx, 'foxxi-manifest.ttl', manifest);
  const operations = await getBytes(ctx, 'https://relay.interego.xwisee.com/.well-known/operations', 'application/json');
  const ops = JSON.parse(decode(operations));
  if (!Array.isArray(ops['hydra:member']) || !ops['hydra:member'].length || ops['hydra:member'].some((r: Row) => !r.action)) throw new Error('Relay operations document lacks hydra:member operation records');
  keep(ctx, 'relay-operations.json', operations);
  for (const [name, url] of [
    ['xapi-ontology.ttl', 'https://w3id.org/xapi/ontology'],
    ['xapi-profile-ontology.ttl', 'https://w3id.org/xapi/profiles/ontology'],
    ['iep.ttl', 'https://markjspivey-xwisee.github.io/interego/ns/iep.ttl'],
  ] as const) {
    const bytes = await getBytes(ctx, url, 'text/turtle'); new Graph(decode(bytes), 'text/turtle', url); keep(ctx, name, bytes);
  }
  log('Fetched and parsed ' + rows.length + ' Foxxi affordances and ' + ops['hydra:member'].length + ' relay operations');
}
function foxxiArchive(ctx: Context): { cfg: Row; archive: string; files: [string, string, string][] } {
  const cfg = ctx.cfg.foxxiNs, loc = process.env.FOXXI_NS_ARCHIVE || cfg.archive;
  const archive = isAbsolute(loc) ? loc : resolve(ctx.root, loc);
  return { cfg, archive, files: cfg.modules.map((module: string) => [module, join(archive, module, cfg.version + '.ttl'), cfg.base + '/' + module + '/' + cfg.version]) };
}
function validatePinnedFoxxi(ctx: Context): [string, Graph][] {
  const { cfg, files } = foxxiArchive(ctx);
  return files.map(([module, path, iri]) => {
    const bytes = readFileSync(path);
    if (bytesHash(bytes) !== cfg.sha256[module]) throw new Error('Foxxi module does not match config.json SHA-256: ' + path);
    return [iri, new Graph(decode(bytes), 'text/turtle', iri)];
  });
}
function literal(value: Value): Value {
  if (Array.isArray(value)) { const en = value.filter(x => x && typeof x === 'object' && (x['@language'] || 'en') === 'en'); return literal(en[0] || value[0]); }
  if (value && typeof value === 'object') return value['@value'] ?? null;
  return value ?? null;
}
async function refreshApp(ctx: Context): Promise<void> {
  if (!ctx.files.has('foxxi-manifest.ttl')) {
    const bytes = await getBytes(ctx, ctx.cfg.foxxiManifest, 'text/turtle'); new Graph(decode(bytes), 'text/turtle', ctx.cfg.foxxiManifest); keep(ctx, 'foxxi-manifest.ttl', bytes);
  }
  const operations: Row[] = jsonEvidence(ctx, 'relay-operations.json')['hydra:member'], inputs: Row = {};
  if (!Array.isArray(operations)) throw new Error('No relay operation snapshot: refresh base evidence first');
  for (const op of operations) {
    const url = op.expects;
    if (!url || !url.startsWith('https://relay.interego.xwisee.com/')) continue;
    const name = op.action.split('/').pop();
    try {
      const schema = JSON.parse(decode(await getBytes(ctx, url, 'application/json')));
      if (!schema || typeof schema !== 'object' || Array.isArray(schema)) throw new Error('Input schema is not a JSON object');
      inputs[name] = schema;
    } catch (error) { log('No input schema for ' + name + ': ' + String(error)); }
  }
  keep(ctx, 'relay-inputs.json', jsonText(sortedRecord(inputs)));
  const i2x = ctx.cfg.relayNsRoot + '/' + ctx.cfg.owner + '/' + ctx.cfg.slugs.ontology + '#';
  const maps = new Graph(readFileSync(join(ctx.dist, ctx.cfg.slugs.mappings + '.ttl'), 'utf8'));
  const targets = [...new Set(maps.objects(null, i2x + 'proposedObject').map(t => t.value))].sort();
  const vocabs: [string, Graph][] = ['xapi-ontology.ttl', 'xapi-profile-ontology.ttl', 'iep.ttl'].map(name => {
    const bytes = ctx.files.get(name), text = bytes ? decode(bytes) : readFileSync(join(ctx.evidence, name), 'utf8');
    return [name, new Graph(text)];
  });
  vocabs.push(...validatePinnedFoxxi(ctx));
  const schemaUrl = 'https://schema.org/version/latest/schemaorg-current-https.jsonld';
  const schemaDoc = JSON.parse(decode(await getBytes(ctx, schemaUrl, 'application/ld+json')));
  if (!Array.isArray(schemaDoc['@graph'])) throw new Error('schema.org response lacks @graph');
  const schemaById: Row = Object.fromEntries(schemaDoc['@graph'].map((n: Row) => [n['@id'], n]));
  const vcUrl = 'https://www.w3.org/2018/credentials';
  vocabs.push(['w3.org/2018/credentials', new Graph(decode(await getBytes(ctx, vcUrl, 'text/turtle')), 'text/turtle', vcUrl)]);
  const terms: Row = {};
  for (const target of targets) {
    let rec: Row | null = null;
    if (target.startsWith('https://schema.org/')) {
      const n = schemaById['schema:' + target.split('/').pop()];
      if (n) rec = { label: literal(n['rdfs:label']), definition: literal(n['rdfs:comment']), from: 'schema.org' };
    } else {
      const own = vocabs.filter(([name]) => name.startsWith('https://') && target.startsWith(name.slice(0, name.lastIndexOf('/')) + '#'));
      for (const [name, graph] of [...own, ...vocabs.filter(v => !own.includes(v))]) {
        const label = graph.value(target, RDFS + 'label', SKOS + 'prefLabel'), comment = graph.value(target, SKOS + 'definition', RDFS + 'comment');
        if (label || comment) { rec = { label: label ? lexical(label) : null, definition: comment ? clean(lexical(comment)) : null, from: name }; break; }
      }
    }
    terms[target] = rec || { label: null, definition: null, from: null };
    if (!rec) log('No definition found for ' + target);
  }
  keep(ctx, 'external-terms.json', jsonText(sortedRecord(terms)));
  log('Fetched ' + Object.keys(inputs).length + ' input schemas; ' + Object.values(terms).filter(t => t.definition).length + ' of ' + targets.length + ' targets have definitions');
}
async function jsonldGraph(ctx: Context, url: string): Promise<Graph> {
  const bytes = await getBytes(ctx, url, 'application/ld+json', 45000), document = JSON.parse(decode(bytes));
  // JSON-LD expansion is a data parser. Remote contexts are constrained to the
  // vocabulary hosts this refresh intentionally consumes and recorded as downloads.
  const loader = async (contextUrl: string): Promise<Row> => {
    const parsed = new URL(contextUrl);
    if (!['vocabularies.unesco.org', 'www.w3.org', 'schema.org', 'w3id.org'].includes(parsed.hostname)) throw new Error('Unexpected JSON-LD context origin: ' + contextUrl);
    if (parsed.protocol === 'http:') parsed.protocol = 'https:';
    const body = await getBytes(ctx, parsed.href, 'application/ld+json');
    return { contextUrl: null, documentUrl: parsed.href, document: JSON.parse(decode(body)) };
  };
  const nquads: string = await jsonld.toRDF(document, { format: 'application/n-quads', documentLoader: loader, base: url });
  return new Graph(nquads, 'N-Quads', url);
}
async function unescoGraph(ctx: Context, iri: string): Promise<Graph> {
  let last: unknown;
  for (let attempt = 0; attempt < 8; attempt++) {
    try { return await jsonldGraph(ctx, UNESCO_API + encodeIri(iri)); }
    catch (error) { last = error; if (attempt < 7) await delay(2000 + attempt * 2000); }
  }
  throw new Error('UNESCO API unreachable for ' + iri + ': ' + String(last));
}
async function refreshUnesco(ctx: Context): Promise<void> {
  const clone = ctx.cfg.i2idl.localClone, path = ctx.cfg.i2idl.graphPath;
  const document = JSON.parse(execFileSync('git', ['-C', clone, 'show', 'HEAD:' + path], { encoding: 'utf8', maxBuffer: 128 * 1024 * 1024 }));
  const nodes: Row[] = document['@graph'], byId: Row = Object.fromEntries(nodes.map(n => [n['@id'], n]));
  const version = nodes.find(n => aslist<Value>(n['@type']).includes('skos:ConceptScheme'))?.['gs:publicationVersion'];
  if (version !== ctx.cfg.i2idl.release) throw new Error('Clone release ' + version + ' differs from pinned release ' + ctx.cfg.i2idl.release);
  const cited: Record<string, Row[]> = {}, mapped: Record<string, Row[]> = {};
  const concepts = nodes.filter(n => aslist<Value>(n['@type']).includes('skos:Concept'));
  for (const n of concepts) for (const definition of ids(n['gs:activeDefinition'])) {
    for (const evidence of aslist<Row>(byId[definition]?.['gs:evidence'])) {
      const m = /^https?:\/\/vocabularies\.unesco\.org\/unesco\/en\/page\/(concept\d+)$/u.exec(evidence['schema:url'] || '');
      if (m && String(evidence['gs:citationDetail'] || '').includes('Preferred term')) (cited[UNESCO_SCHEME + '/' + m[1]] ||= []).push({
        concept: n['@id'].split('/').pop(), definition, relation: evidence['gs:evidenceRelation'] ?? null, citation: evidence['gs:citationDetail'] ?? null, page: evidence['schema:url'] ?? null,
      });
    }
  }
  for (const n of concepts) for (const property of ['skos:exactMatch', 'skos:closeMatch', 'skos:broadMatch', 'skos:narrowMatch', 'skos:relatedMatch']) {
    for (const target of ids(n[property])) if (target.startsWith(UNESCO_SCHEME + '/concept')) (mapped[target] ||= []).push({ concept: n['@id'].split('/').pop(), property });
  }
  const sg = await unescoGraph(ctx, UNESCO_SCHEME), output: Row = {
    fetchedAt: ctx.options.now || isoNow(), i2idlRelease: version, scheme: { iri: UNESCO_SCHEME,
      title: sg.english(UNESCO_SCHEME, SKOS + 'prefLabel')[0] || 'UNESCO Thesaurus', license: lexical(sg.value(UNESCO_SCHEME, DCT + 'license')),
      rightsHolder: lexical(sg.value(UNESCO_SCHEME, DCT + 'rightsHolder')), modified: lexical(sg.value(UNESCO_SCHEME, DCT + 'modified')) }, terms: {},
  };
  const targets = [...new Set([...Object.keys(cited), ...Object.keys(mapped)])].sort((a, b) => Number(a.split('concept').pop()) - Number(b.split('concept').pop()));
  for (const iri of targets) {
    const graph = await unescoGraph(ctx, iri), label = graph.english(iri, SKOS + 'prefLabel')[0];
    if (!label) throw new Error(iri + ': no English preferred label in UNESCO response');
    const groups = graph.subjects(SKOS + 'member', iri).sort((a, b) => a.value < b.value ? -1 : a.value > b.value ? 1 : 0);
    output.terms[iri] = {
      label, alt: graph.english(iri, SKOS + 'altLabel'), scopeNote: graph.english(iri, SKOS + 'scopeNote').join(' ') || null,
      definition: graph.english(iri, SKOS + 'definition').join(' ') || null,
      broader: graph.objects(iri, SKOS + 'broader').sort((a, b) => a.value < b.value ? -1 : a.value > b.value ? 1 : 0).map(t => ({ iri: t.value, label: graph.english(t, SKOS + 'prefLabel')[0] || null })),
      narrowerCount: new Set(graph.objects(iri, SKOS + 'narrower').map(t => t.value)).size, groups: groups.map(t => ({ iri: t.value, label: graph.english(t, SKOS + 'prefLabel')[0] || null })),
      inScheme: lexical(graph.value(iri, SKOS + 'inScheme')), page: 'https://vocabularies.unesco.org/unesco/en/page/' + iri.split('/').pop(), citedBy: cited[iri] || [], mappedBy: mapped[iri] || [],
    };
    log(iri.split('/').pop() + ': ' + label + ', ' + output.terms[iri].broader.length + ' broader terms, ' + groups.length + ' groups');
  }
  keep(ctx, 'unesco-thesaurus.json', jsonText(output));
  log('UNESCO snapshot: ' + targets.length + ' actual terms; licence ' + output.scheme.license);
}
async function removeTemporary(path: string, prefix: string): Promise<void> {
  const absolute = resolve(path), permitted = resolve(prefix);
  if (!absolute.startsWith(permitted + sep) && !absolute.startsWith(permitted)) throw new Error('Temporary cleanup target escaped its prefix');
  await rm(absolute, { recursive: true, force: true });
}
async function commitFiles(ctx: Context): Promise<string[]> {
  await mkdir(ctx.evidence, { recursive: true });
  const parent = ctx.evidence, stagingPrefix = join(parent, '.refresh-'), staging = await mkdtemp(stagingPrefix), installed: string[] = [], backedUp: string[] = []; let safeToClean = true;
  try {
    for (const [name, bytes] of ctx.files) { const path = join(staging, 'incoming', name); await mkdir(dirname(path), { recursive: true }); await writeFile(path, bytes); }
    for (const [name] of ctx.files) {
      const target = join(parent, name), backup = join(staging, 'backup', name);
      if (existsSync(target)) { await mkdir(dirname(backup), { recursive: true }); await rename(target, backup); backedUp.push(name); }
      await mkdir(dirname(target), { recursive: true }); await rename(join(staging, 'incoming', name), target); installed.push(name);
    }
  } catch (error) {
    const rollbackErrors: unknown[] = [];
    for (const name of [...installed].reverse()) { try { await rm(join(parent, name), { force: true }); } catch (rollback) { rollbackErrors.push(rollback); } }
    for (const name of [...backedUp].reverse()) { try { await rename(join(staging, 'backup', name), join(parent, name)); } catch (rollback) { rollbackErrors.push(rollback); } }
    if (rollbackErrors.length) { safeToClean = false; throw new AggregateError([error, ...rollbackErrors], 'Refresh rollback failed; original backups preserved in ' + staging); }
    throw error;
  } finally { if (safeToClean) await removeTemporary(staging, stagingPrefix); }
  return installed.map(name => join(parent, name));
}
async function fetchFoxxi(ctx: Context): Promise<string[]> {
  if (!ctx.options.foxxiDir) throw new Error('Usage: refresh-evidence.ts <root> --foxxi <empty-or-new-directory>');
  const destination = resolve(ctx.options.foxxiDir);
  if (existsSync(destination) && (await readdir(destination)).length) throw new Error(destination + ' is not empty; immutable release archives are never overwritten');
  const cfg = ctx.cfg.foxxiNs, downloads = new Map<string, Uint8Array>();
  for (const module of cfg.modules as string[]) {
    const name = module + '/' + cfg.version + '.ttl', bytes = await getBytes(ctx, cfg.base + '/' + module + '/' + cfg.version, 'text/turtle');
    if (bytesHash(bytes) !== cfg.sha256[module]) throw new Error('Fetched Foxxi module is not the release pinned in config.json: ' + module);
    new Graph(decode(bytes), 'text/turtle', cfg.base + '/' + module + '/' + cfg.version); downloads.set(name, bytes);
  }
  const sums = Object.entries(cfg.sha256).map(([module, hash]) => hash + '  ' + module + '/' + cfg.version + '.ttl\n').join('');
  downloads.set('SHA256SUMS', new TextEncoder().encode(sums));
  await mkdir(dirname(destination), { recursive: true }); const prefix = join(dirname(destination), '.i2idlx-foxxi-'), staging = await mkdtemp(prefix);
  const wasEmpty = existsSync(destination);
  try {
    for (const [name, bytes] of downloads) { const file = join(staging, name); await mkdir(dirname(file), { recursive: true }); await writeFile(file, bytes); }
    if (wasEmpty) await rmdir(destination);
    await rename(staging, destination);
  } catch (error) {
    if (wasEmpty && !existsSync(destination)) await mkdir(destination, { recursive: true });
    if (existsSync(staging)) await removeTemporary(staging, prefix);
    throw error;
  }
  log('Foxxi ' + cfg.version + ' fetched and SHA-256 verified against config.json');
  return [...downloads.keys()].map(name => join(destination, name));
}
async function fetchReasoner(ctx: Context): Promise<string[]> {
  const cfg = ctx.cfg.reasoner, specified = ctx.options.reasonerFile || process.env.I2IDLX_REASONER_JAR || cfg.jar;
  const destination = isAbsolute(specified) ? specified : resolve(ctx.root, specified), bytes = await getBytes(ctx, cfg.url);
  if (bytesHash(bytes) !== cfg.sha256) throw new Error('Fetched reasoner jar is not the one pinned in config.json');
  await mkdir(dirname(destination), { recursive: true }); const prefix = join(dirname(destination), '.i2idlx-reasoner-'), staging = await mkdtemp(prefix);
  const temporary = join(staging, 'reasoner.jar'), backup = join(staging, 'previous.jar'); let saved = false, safeToClean = true;
  try {
    await writeFile(temporary, bytes, { mode: 0o644 });
    if (existsSync(destination)) { await rename(destination, backup); saved = true; }
    try { await rename(temporary, destination); } catch (error) {
      if (saved) { try { await rename(backup, destination); } catch (rollback) { safeToClean = false; throw new AggregateError([error, rollback], 'Reasoner rollback failed; original jar preserved in ' + staging); } }
      throw error;
    }
  } finally { if (safeToClean) await removeTemporary(staging, prefix); }
  log('Reasoner fetched and SHA-256 verified against config.json'); return [destination];
}
export async function refreshEvidence(root = resolve(dirname(fileURLToPath(import.meta.url)), '..'), options: RefreshOptions = {}): Promise<RefreshResult> {
  root = resolve(root); const mode = options.mode || 'base', cfg = loadConfig(root) as Row;
  const ctx: Context = { root, cfg, options, evidence: options.outputDir ? resolve(options.outputDir) : join(root, 'evidence'), dist: options.distDir ? resolve(options.distDir) : join(root, 'dist-ts'), downloads: [], files: new Map() };
  let files: string[];
  if (mode === 'foxxi') files = await fetchFoxxi(ctx);
  else if (mode === 'reasoner') files = await fetchReasoner(ctx);
  else {
    if (mode === 'base' || mode === 'all') await refreshBase(ctx);
    if (mode === 'app' || mode === 'all') await refreshApp(ctx);
    if (mode === 'unesco' || mode === 'all') await refreshUnesco(ctx);
    keep(ctx, 'refresh-receipt.json', jsonText({ refreshedAt: options.now || isoNow(), mode, downloads: ctx.downloads }));
    files = await commitFiles(ctx);
  }
  return { mode, files, retrievals: ctx.downloads };
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const args = process.argv.slice(2), root = args[0]?.startsWith('-') ? undefined : args[0];
  const opt = (name: string): string | undefined => { const at = args.indexOf(name); return at < 0 ? undefined : args[at + 1]; };
  const mode: RefreshOptions['mode'] = args.includes('--foxxi') ? 'foxxi' : args.includes('--reasoner') ? 'reasoner' : args.includes('--all') ? 'all' : args.includes('--app') ? 'app' : args.includes('--unesco') ? 'unesco' : 'base';
  log(JSON.stringify(await refreshEvidence(root, { mode, foxxiDir: opt('--foxxi'), reasonerFile: opt('--reasoner-file'), distDir: opt('--dist'), outputDir: opt('--out') })));
}
