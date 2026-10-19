/** Deterministic, read-only checks. The connected client retains all AI reasoning. */
import type { Express, Response } from 'express';
import { readFile, stat } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { loadPublicTaskData } from './i2idlx-client-tasks.js';
import { parseTurtle, union, construct, serializeTurtle, nn, RDF, GS, type Store } from '../i2idlx/typescript/rdf.js';
import { shaclValidate } from '../i2idlx/typescript/validation.js';

type Row = Record<string, unknown>;
export interface SemanticTaskConfig { baseUrl: string; appDataFile?: string; distDirectory?: string; fetch?: typeof fetch }
const object = (v: unknown): v is Row => !!v && typeof v === 'object' && !Array.isArray(v);
const rows = (v: unknown): Row[] => Array.isArray(v) ? v.filter(object) : [];
const text = (v: unknown) => typeof v === 'string' ? v : '';
const CONCEPT = 'https://id.i2idl.org/concepts/';
const RDFS = 'http://www.w3.org/2000/01/rdf-schema#', OWL = 'http://www.w3.org/2002/07/owl#';
const SCHEME = 'https://id.i2idl.org/scheme';
const MAX_TRIPLES = 512, MAX_INPUT = 64000, MAX_OUTPUT = 256000;
class CheckError extends Error { constructor(message: string, readonly status = 400) { super(message); } }
function argsOf(value: unknown, allowed: string[]): Row {
  if (!object(value) || Buffer.byteLength(JSON.stringify(value), 'utf8') > 128000) throw new CheckError('Bounded object arguments required.');
  let args = value;
  if (value._signed_payload !== undefined) {
    if (typeof value._signed_payload !== 'string') throw new CheckError('Signed arguments must be JSON text.');
    try { const parsed: unknown = JSON.parse(value._signed_payload); if (!object(parsed)) throw Error(); args = parsed; }
    catch { throw new CheckError('Signed arguments must be a JSON object.'); }
  }
  // The bridge's HTTP middleware adds these two fields to parsed bodies.
  // They are transport context, never check arguments or an identity claim.
  args = { ...args };
  delete args.__client_ip;
  delete args.__caller_token;
  // These public reads neither verify nor claim the identity in an optional envelope.
  const permitted = new Set([...allowed, 'agent_id', 'pod_url', 'timestamp']);
  if (Object.keys(args).some(k => !permitted.has(k))) throw new CheckError('Unsupported input; use only the advertised check arguments.');
  return args;
}
function graphInput(args: Row, ns: string): Store {
  const content = text(args.graph_content);
  if (!content.trim() || Buffer.byteLength(content, 'utf8') > MAX_INPUT) throw new CheckError('graph_content must be inline Turtle within 64000 UTF-8 bytes.');
  let graph: Store;
  try { graph = parseTurtle(content); } catch { throw new CheckError('graph_content is not valid Turtle.'); }
  if (graph.size > MAX_TRIPLES) throw new CheckError('graph_content exceeds 512 triples.', 413);
  // Public controls accept instance drafts, never caller-supplied schema. Such
  // axioms can alter the trusted interpretation and amplify synchronous closure.
  for (const q of graph) {
    if (q.subject.value.startsWith(CONCEPT) || q.subject.value.startsWith(ns) ||
        ['referentCategory', 'referentClass', 'classificationMode'].some(p => q.predicate.value === ns + p) ||
        (q.predicate.value.startsWith(RDFS) && !['label', 'comment', 'seeAlso', 'isDefinedBy'].includes(q.predicate.value.slice(RDFS.length))) ||
        q.predicate.value.startsWith(OWL) ||
        (q.predicate.value === RDF + 'type' && (q.object.value.startsWith(OWL) || [RDFS + 'Class', RDFS + 'Datatype', RDF + 'Property'].includes(q.object.value)))) {
      throw new CheckError('graph_content accepts instance statements only; caller schema and inference-changing axioms are unsupported.');
    }
  }
  return graph;
}
function provenance(data: Row) {
  const meta = object(data.meta) ? data.meta : {};
  return { mode: 'pinned', release: text(meta.release), commit: text(meta.commit), upstream_freshness: 'not_checked' };
}
function iriBase(data: Row): string {
  const meta = object(data.meta) ? data.meta : {}, iris = object(meta.iri) ? meta.iri : {};
  const base = text(iris.ontology);
  if (!/^https?:\/\/[^\s<>"{}]+$/.test(base)) throw new CheckError('Pinned semantic namespace unavailable.', 503);
  return base + '#';
}
function membership(data: Row, graph: Store, ns: string) {
  const known = new Set(rows(data.concepts).map(c => CONCEPT + text(c.id)));
  return graph.getQuads(null, nn(ns + 'isClassifiedBy'), null, null).map(q => ({
    subject: q.subject.value, concept: q.object.value,
    exists_in_snapshot: q.object.termType === 'NamedNode' && known.has(q.object.value),
  }));
}
function clashes(data: Row, graph: Store, ns: string) {
  const byConcept = new Map(rows(data.concepts).map(c => [CONCEPT + text(c.id), text(c.rc)]));
  const semantic = object(data.semantic) ? data.semantic : {}, matrix = object(semantic.disjoint) ? semantic.disjoint : {};
  const subjects = new Map<string, Set<string>>();
  for (const q of graph.getQuads(null, nn(ns + 'isClassifiedBy'), null, null)) {
    const category = byConcept.get(q.object.value); if (!category) continue;
    if (!subjects.has(q.subject.value)) subjects.set(q.subject.value, new Set());
    subjects.get(q.subject.value)!.add(category);
  }
  return [...subjects].flatMap(([subject, values]) => {
    const cats = [...values], result: Row[] = [];
    for (let i = 0; i < cats.length; i++) for (let j = i + 1; j < cats.length; j++) {
      const evidence = matrix[cats[i] + '|' + cats[j]] ?? matrix[cats[j] + '|' + cats[i]];
      if (evidence) result.push({ subject, categories: [cats[i], cats[j]], evidence });
    }
    return result;
  });
}
export type SemanticOperation = 'classify' | 'validate' | 'peer-term' | 'source-version';
export interface SemanticTaskResponse { status: number; body: Record<string, unknown>; retryAfter?: string }
export type SemanticTaskExecutor = (operation: SemanticOperation, body: unknown) => Promise<SemanticTaskResponse>;
// REST and MCP share the same process-wide concurrency bound.
let semanticCheckActive = false;
export function createSemanticTaskExecutor(config: SemanticTaskConfig): SemanticTaskExecutor {
  const directory = config.distDirectory ?? fileURLToPath(new URL('../i2idlx/dist-ts/', import.meta.url));
  const files = { ontology: 'i2idlx.ttl', alignments: 'i2idlx-alignments.ttl', referents: 'i2idlx-referents.ttl', shapes: 'i2idlx-shapes.ttl' } as const;
  async function graphs() {
    const entries = await Promise.all(Object.entries(files).map(async ([key, name]) => {
      const path = resolve(directory, name), info = await stat(path);
      if (!info.isFile() || info.size > 4000000) throw new CheckError('Pinned semantic build exceeds capacity.', 503);
      const content = await readFile(path, 'utf8');
      if (Buffer.byteLength(content, 'utf8') > 4000000) throw new CheckError('Pinned semantic build exceeds capacity.', 503);
      return [key, { graph: parseTurtle(content), sha256: createHash('sha256').update(content).digest('hex') }] as const;
    }));
    return Object.fromEntries(entries) as Record<keyof typeof files, { graph: Store; sha256: string }>;
  }
  type Execute = (args: Row, data: Row) => Promise<{ result: Row; evidence: Row; status?: string }>;
  const operations = new Map<SemanticOperation, { allowed: string[]; execute: Execute }>();
  const route = (slug: SemanticOperation, allowed: string[], execute: Execute) => { operations.set(slug, { allowed, execute }); };
  route('classify', ['graph_content'], async (args, data) => {
    const ns = iriBase(data), input = graphInput(args, ns), refs = membership(data, input, ns);
    if (refs.some(r => !r.exists_in_snapshot)) throw new CheckError('A classified concept is not present in the pinned glossary.');
    const query = text(rows(data.queries).find(q => q.id === 'q-classify')?.sparql);
    if (!query || query.length > 12000 || !/^\s*(?:PREFIX\s+[^\n]+\s*)*CONSTRUCT\b/i.test(query) || /\b(?:SERVICE|FROM|LOAD|INSERT|DELETE)\b/i.test(query)) throw new CheckError('Fixed classifier query unavailable.', 503);
    const built = await graphs(), datasetResult = await construct(query, union(built.ontology.graph, built.alignments.graph, built.referents.graph, input));
    if (datasetResult.size > 10000) throw new CheckError('Classifier result exceeds capacity.', 413);
    const draftSubjects = new Set([...input].map(q => q.subject.termType + ':' + q.subject.value)), inferred = union();
    inferred.addQuads([...datasetResult].filter(q => draftSubjects.has(q.subject.termType + ':' + q.subject.value)));
    const allRefs = membership(data, union(input, inferred), ns);
    if (allRefs.some(r => !r.exists_in_snapshot)) throw new CheckError('An inferred classified concept is not present in the pinned glossary.');
    const typed = inferred.getQuads(null, nn(RDF + 'type'), null, null).map(q => ({ subject: q.subject.value, type: q.object.value }));
    return { result: { modal_status: 'Hypothetical', graph_content: await serializeTurtle(inferred), types: typed,
      clashes: clashes(data, union(input, inferred), ns), full_owl_consistency: 'not_run' },
      evidence: { engine: 'existing I2IDL-X Comunica q-classify', query: 'q-classify', input_triples: input.size,
        input_sha256: createHash('sha256').update(text(args.graph_content)).digest('hex'),
        output_triples: inferred.size, dataset_output_triples: datasetResult.size, output_scope: 'submitted draft subjects',
        concept_existence: allRefs, graph_sha256: Object.fromEntries(Object.entries(built).map(([k, v]) => [k, v.sha256])) } };
  });
  route('validate', ['graph_content'], async (args, data) => {
    const ns = iriBase(data), input = graphInput(args, ns), built = await graphs();
    const report = await shaclValidate(input, built.shapes.graph, { ontology: built.ontology.graph, inference: 'rdfs' });
    const refs = membership(data, report.dataGraph, ns), unknown = refs.filter(r => !r.exists_in_snapshot);
    const draftNodes = new Set([...input].map(q => q.subject.termType + ':' + q.subject.value));
    const draftTargets = report.targets.filter(t => draftNodes.has(t.focusNode.termType + ':' + t.focusNode.value));
    const targeted = [...new Set(draftTargets.map(t => t.focusNode.value))];
    return { result: { conforms: report.conforms && unknown.length === 0, shacl_conforms: report.conforms,
      validation_applicable: targeted.length > 0,
      applicability_note: 'Conformance with no targeted nodes is vacuous; it cannot pass a required publication validation check.',
      unknown_concepts: unknown, violations: report.results.map(r => ({ focus: r.focusNode.value, path: r.path?.value, component: r.component, message: r.message })),
      publication_authorized: false, publication_performed: false, full_owl_consistency: 'not_run' },
      evidence: { engine: 'existing I2IDL-X native SHACL Core', inference: 'rdfs', input_triples: input.size,
        input_sha256: createHash('sha256').update(text(args.graph_content)).digest('hex'),
        targeted_nodes: targeted, targeted_node_count: targeted.length, evaluated_shape_node_pairs: draftTargets.length,
        applied_targets: draftTargets.map(t => ({ focus: t.focusNode.value, shape: t.sourceShape.value })),
        total_evaluated_shape_node_pairs: report.targets.length,
        constraints: 'unsupported features fail closed; SHACL-SPARQL/JS not supported', shape_sha256: built.shapes.sha256,
        ontology_sha256: built.ontology.sha256, concept_existence: refs } };
  });
  route('peer-term', ['iri'], async (args, data) => {
    const iri = text(args.iri);
    if (Buffer.byteLength(iri, 'utf8') > 2048 || !/^https?:\/\/[^\s<>"{}\\]+$/.test(iri)) throw new CheckError('iri must be one bounded absolute HTTP(S) term IRI.');
    const semantic = object(data.semantic) ? data.semantic : {}, prefixes = object(semantic.prefixes) ? semantic.prefixes : {};
    const labels = object(semantic.labels) ? semantic.labels : {};
    let found: Row | undefined;
    for (const [curie, label] of Object.entries(labels)) {
      const colon = curie.indexOf(':'), prefix = curie.slice(0, colon), expansion = text(prefixes[prefix]) + curie.slice(colon + 1);
      if (colon > 0 && text(prefixes[prefix]) && expansion === iri) { found = { iri, label: text(label), source: 'pinned publisher-label index' }; break; }
    }
    const mapping = rows(data.mappings).find(m => m.o === iri);
    if (mapping) found = { ...(found ?? {}), iri, label: text(mapping.ol) || text(found?.label), definition: text(mapping.od), vocabulary: text(mapping.v), mapping: text(mapping.id), source: found ? 'pinned publisher-label index and mapping target' : 'pinned mapping target' };
    return { result: { iri, confirmed_in_snapshot: !!found, term: found ?? null, meaning_of_miss: 'unconfirmed in pinned evidence; not proof of nonexistence' },
      evidence: { network_fetch_performed: false, snapshots: rows(semantic.snapshots) } };
  });
  route('source-version', [], async (_args, data) => {
    const response = await (config.fetch ?? fetch)('https://id.i2idl.org/scheme.ttl', { redirect: 'error', signal: AbortSignal.timeout(5000), headers: { Accept: 'text/turtle' } });
    if (!response.ok || !response.body) throw new CheckError('Canonical scheme is unavailable.', 503);
    const reader = response.body.getReader(); let content = '', bytes = 0; const decoder = new TextDecoder();
    try { for (;;) { const part = await reader.read(); if (part.done) break; bytes += part.value.byteLength;
      if (bytes > 64000) throw new CheckError('Canonical scheme exceeds capacity.', 503); content += decoder.decode(part.value, { stream: true }); }
      content += decoder.decode(); } finally { await reader.cancel().catch(() => {}); }
    const scheme = parseTurtle(content), versions = scheme.getQuads(nn(SCHEME), nn(GS + 'publicationVersion'), null, null);
    if (versions.length !== 1 || versions[0]!.object.termType !== 'Literal') throw new CheckError('Canonical release could not be established.', 503);
    const pinned = provenance(data), current = versions[0]!.object.value;
    return { result: { pinned_release: pinned.release, upstream_release: current, matches: pinned.release === current,
      reconciliation: pinned.release === current ? 'same_release' : 'review_required', automatically_upgraded: false },
      evidence: { checked_at: new Date().toISOString(), source_url: 'https://id.i2idl.org/scheme.ttl', http_status: response.status,
        sha256: createHash('sha256').update(content).digest('hex') } };
  });
  return async (slug, body) => {
    if (semanticCheckActive) return { status: 429, retryAfter: '1', body: { error: 'A semantic check is already running; retry after it completes.' } };
    semanticCheckActive = true;
    try {
      const operation = operations.get(slug);
      if (!operation) throw new CheckError('Unsupported semantic check.');
      const args = argsOf(body, operation.allowed), data = await loadPublicTaskData(config), output = await operation.execute(args, data);
      const response = { task: slug, execution: 'deterministic-read-only', status: output.status ?? 'performed', sampling_performed: false,
        writes_performed: false, source: { ...provenance(data), upstream_freshness: slug === 'source-version' ? 'checked' : 'not_checked' }, evidence: output.evidence, result: output.result };
      if (Buffer.byteLength(JSON.stringify(response), 'utf8') > MAX_OUTPUT) throw new CheckError('Check output exceeds capacity; narrow the draft.', 413);
      return { status: 200, body: response };
    } catch (error) {
      return { status: error instanceof CheckError ? error.status : 503, body: {
        task: slug, status: 'unavailable', sampling_performed: false, writes_performed: false,
        error: error instanceof CheckError ? error.message : 'Pinned semantic check unavailable; no successful result was fabricated.',
      } };
    } finally { semanticCheckActive = false; }
  };
}
export function attachSemanticTaskRoutes(app: Express, config: SemanticTaskConfig): void {
  const execute = createSemanticTaskExecutor(config);
  for (const operation of ['classify', 'validate', 'peer-term', 'source-version'] as const) app.post('/i2idlx/api/' + operation, async (req, res: Response) => {
    const output = await execute(operation, req.body);
    if (output.retryAfter) res.set('Retry-After', output.retryAfter);
    res.status(output.status).set('Cache-Control', 'no-store').json(output.body);
  });
}
