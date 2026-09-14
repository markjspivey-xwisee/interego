import { parseTrig } from '../../packages/core/dist/rdf/turtle-parser.js';
import { unpackMcp } from './runner.mjs';
import { PR } from './graph.mjs';

/** An invocation request is linked data too; application values are not code. */
export function readRunRequest(result, { descriptorUrl, trustedSigner }) {
  const data = unpackMcp(result), auth = data.authorship;
  if (data.url !== descriptorUrl || !trustedSigner || auth?.signedBy !== trustedSigner || auth?.authorshipVerified !== true
      || auth.contentBinding !== 'bound' || auth.descriptorBinding?.bound !== true) throw new Error('Run-request authority failed');
  const subjects = parseTrig(data.graph?.content ?? data.content ?? '').subjects;
  const nodes = new Map(subjects.map(s => [typeof s.subject === 'string' ? s.subject : `_:${s.subject.bnode}`, s.properties]));
  const one = (subject, predicate) => {
    const values = nodes.get(subject)?.get(predicate);
    if (values?.length !== 1) throw new Error('Missing or ambiguous invocation binding');
    return values[0];
  };
  const resource = (subject, predicate) => {
    const value = one(subject, predicate);
    if (value.kind !== 'iri') throw new Error('Invocation links must be IRIs');
    return value.iri;
  };
  const text = (subject, predicate) => {
    const value = one(subject, predicate);
    if (value.kind !== 'literal') throw new Error('Expected an invocation literal');
    return value.value;
  };
  const roots = subjects.filter(s => s.properties.get('http://www.w3.org/1999/02/22-rdf-syntax-ns#type')?.some(t => t.iri === PR + 'RunRequest'));
  if (roots.length !== 1 || typeof roots[0].subject !== 'string') throw new Error('Expected one named run request');
  const root = roots[0].subject, inputNode = resource(root, PR + 'input');
  const entries = (nodes.get(inputNode)?.get(PR + 'field') ?? []).map(field => {
    if (field.kind !== 'iri') throw new Error('Input fields must have IRIs');
    const key = text(field.iri, PR + 'key'), value = one(field.iri, PR + 'value');
    if (!['iri', 'literal'].includes(value.kind)) throw new Error('Only scalar request inputs are supported');
    return [key, value.iri ?? value.value];
  });
  if (!entries.length || new Set(entries.map(([key]) => key)).size !== entries.length) throw new Error('Missing or duplicate input fields');
  return { id: root, procedureDescriptor: resource(root, PR + 'procedure'), procedureGraph: resource(root, PR + 'procedureGraph'),
    procedurePod: resource(root, PR + 'procedurePod'), procedureCid: text(root, PR + 'procedureCid'), input: Object.fromEntries(entries) };
}
