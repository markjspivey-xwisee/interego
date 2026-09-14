import { parseTrig } from '../../packages/core/dist/rdf/turtle-parser.js';
import { validateProcedure, unpackMcp } from './runner.mjs';

export const PR = 'https://markjspivey-xwisee.github.io/interego/ns/procedure#';
const RDF = 'http://www.w3.org/1999/02/22-rdf-syntax-ns#';
const HYDRA = 'http://www.w3.org/ns/hydra/core#';
const XSD = 'http://www.w3.org/2001/XMLSchema#';
const DCT = 'http://purl.org/dc/terms/';
const kindName = { Read: 'read', Check: 'check', Select: 'select', Pick: 'pick', Project: 'project', Follow: 'follow', Expect: 'expect', Output: 'output' };
const termId = term => term?.kind === 'iri' ? term.iri : term?.kind === 'bnode' ? `_:${term.id}` : null;

/** Decode semantic triples. JSON is an internal execution representation only. */
export function compileProcedureGraph(turtle) {
  const parsed = parseTrig(turtle);
  const nodes = new Map();
  for (const item of parsed.subjects) {
    const id = typeof item.subject === 'string' ? item.subject : `_:${item.subject.bnode}`;
    if (!nodes.has(id)) nodes.set(id, new Map());
    for (const [predicate, objects] of item.properties) {
      const prior = nodes.get(id).get(predicate) ?? [];
      for (const object of objects) if (!prior.some(p => JSON.stringify(p) === JSON.stringify(object))) prior.push(object);
      nodes.get(id).set(predicate, prior);
    }
  }
  const many = (id, predicate) => [...(nodes.get(id)?.get(predicate) ?? [])]
    .sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
  const one = (id, predicate, optional = false) => {
    const values = many(id, predicate);
    if (optional && values.length === 0) return undefined;
    if (values.length !== 1) throw new Error(`Expected one ${predicate} on ${id}`);
    return values[0];
  };
  const iri = (id, predicate, optional = false) => {
    const value = one(id, predicate, optional);
    if (value === undefined) return undefined;
    if (value.kind !== 'iri') throw new Error('Procedure identities and edges must be IRIs');
    return value.iri;
  };
  const literal = (id, predicate, optional = false) => {
    const value = one(id, predicate, optional);
    if (value === undefined) return undefined;
    if (value.kind !== 'literal') throw new Error('Expected a literal');
    return value.value;
  };
  const hasType = (id, type) => many(id, RDF + 'type').some(v => termId(v) === type);
  const roots = [...nodes.keys()].filter(id => hasType(id, PR + 'Procedure'));
  if (roots.length !== 1) throw new Error('Expected exactly one linked procedure');
  const root = roots[0];
  const declared = many(root, PR + 'step').map(termId);
  if (!declared.length || declared.some(id => !id || id.startsWith('_:')) || new Set(declared).size !== declared.length) throw new Error('Steps must have unique IRIs');
  const keys = new Map(declared.map(id => [id, literal(id, PR + 'key')]));
  const inputNode = iri(root, PR + 'input');
  const itemNode = iri(root, PR + 'iterationItem');
  const decode = (term, visiting = new Set()) => {
    if (term?.kind === 'literal') {
      if (term.datatype === XSD + 'boolean') {
        if (!['true', 'false', '1', '0'].includes(term.value)) throw new Error('Invalid boolean');
        return ['true', '1'].includes(term.value);
      }
      if (term.datatype === XSD + 'integer') {
        if (!/^-?\d+$/u.test(term.value) || !Number.isSafeInteger(Number(term.value))) throw new Error('Invalid integer');
        return Number(term.value);
      }
      if (term.datatype && term.datatype !== XSD + 'string') throw new Error('Unsupported literal datatype');
      return term.value;
    }
    const id = termId(term);
    if (id === RDF + 'nil') return [];
    if (!id || visiting.has(id) || visiting.size > 40) throw new Error('Invalid or cyclic expression');
    const next = new Set(visiting).add(id);
    const sub = predicate => decode(one(id, predicate), next);
    if (hasType(id, PR + 'Binding')) {
      const source = iri(id, PR + 'source'), path = literal(id, PR + 'pointer');
      if (path !== '' && !path.startsWith('/')) throw new Error('Binding requires a relative JSON Pointer');
      const prefix = source === inputNode ? '/input' : source === itemNode ? '/item' : keys.has(source) ? `/steps/${keys.get(source)}` : null;
      if (!prefix) throw new Error('Binding source is not part of this procedure');
      return { $ref: prefix + path };
    }
    if (hasType(id, PR + 'Object')) {
      const entries = many(id, PR + 'field').map(field => {
        const fieldId = termId(field);
        return [literal(fieldId, PR + 'key'), decode(one(fieldId, PR + 'value'), next)];
      });
      if (new Set(entries.map(([key]) => key)).size !== entries.length) throw new Error('Duplicate object field');
      return Object.fromEntries(entries);
    }
    if (many(id, RDF + 'first').length) {
      const rest = sub(RDF + 'rest');
      if (!Array.isArray(rest)) throw new Error('Malformed RDF collection');
      return [sub(RDF + 'first'), ...rest];
    }
    if (hasType(id, PR + 'Equal')) return { op: 'eq', left: sub(PR + 'left'), right: sub(PR + 'right') };
    if (hasType(id, PR + 'Nonempty')) return { op: 'nonempty', value: sub(PR + 'value') };
    if (hasType(id, PR + 'And')) return { op: 'and', tests: many(id, PR + 'condition').map(t => decode(t, next)) };
    if (hasType(id, PR + 'All')) return { op: 'all', values: sub(PR + 'values'), test: sub(PR + 'condition') };
    throw new Error(`Unsupported expression node ${id}`);
  };
  const steps = [], visited = new Set();
  let cursor = iri(root, PR + 'entry');
  while (cursor) {
    if (!keys.has(cursor) || visited.has(cursor) || visited.size >= 64) throw new Error('Cycle or undeclared step');
    visited.add(cursor);
    const kind = iri(cursor, PR + 'kind');
    const op = kindName[kind.slice(PR.length)];
    if (!kind.startsWith(PR) || !op) throw new Error('Unsupported step kind');
    const step = { id: keys.get(cursor), op };
    const decodeAt = property => decode(one(cursor, property));
    if (op === 'read' || op === 'follow') {
      if (!hasType(cursor, HYDRA + 'Operation') || literal(cursor, HYDRA + 'method') !== 'GET') throw new Error('Only declared Hydra GET operations are supported');
    }
    if (op === 'read') { step.tool = literal(cursor, PR + 'capability'); step.args = decodeAt(PR + 'arguments'); }
    if (['check', 'select', 'pick', 'expect'].includes(op)) step.test = decodeAt(PR + 'condition');
    if (['select', 'pick', 'project'].includes(op)) step.from = decodeAt(PR + 'from');
    if (op === 'project') step.format = literal(cursor, PR + 'format');
    if (op === 'follow') {
      const binding = iri(cursor, PR + 'control');
      if (!visited.has(binding) || steps.find(s => s.id === keys.get(binding))?.op !== 'select') throw new Error('Follow requires a preceding control-selection edge');
      step.control = keys.get(binding);
    }
    if (op === 'expect') step.observation = decodeAt(PR + 'observation');
    if (op === 'output') step.value = decodeAt(PR + 'value');
    const reason = literal(cursor, DCT + 'description', true);
    if (reason) step.reason = reason;
    if (op === 'check' && iri(cursor, PR + 'onFailure') !== PR + 'Blocked') throw new Error('Checks must fail closed');
    if (op === 'expect' && iri(cursor, PR + 'onFailure') !== PR + 'NeedsDecision') throw new Error('Expectations must return control');
    steps.push(step);
    const nextStep = iri(cursor, PR + 'next', true);
    if (op === 'output' && nextStep) throw new Error('Output is terminal');
    cursor = nextStep;
  }
  if (visited.size !== declared.length) throw new Error('Unreachable declared steps');
  const compiled = validateProcedure({ schema: 'interego.read-procedure/v1', id: root, steps });
  return { procedure: compiled, graph: { root, stepIris: [...visited], inputNode,
    title: literal(root, DCT + 'title'), representation: 'text/turtle', executionSource: 'linked-rdf-affordances' } };
}

export function verifiedProcedureGraph(result, { descriptorUrl, trustedSigner }) {
  const data = unpackMcp(result), auth = data.authorship;
  if (data.url !== descriptorUrl || !trustedSigner || auth?.signedBy !== trustedSigner
      || auth.authorshipVerified !== true || auth.contentBinding !== 'bound'
      || auth.descriptorBinding?.bound !== true) throw new Error('Procedure authority verification failed');
  const graph = data.graph?.content ?? data.content;
  if (typeof graph !== 'string') throw new Error('No verified procedure graph');
  return compileProcedureGraph(graph);
}
