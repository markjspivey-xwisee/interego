import { renderHypermediaMarkdown } from '../../packages/core/dist/kernel/hypermedia-markdown.js';
import { compileProcedureGraph, PR } from './graph.mjs';

/** A navigable HMD projection. The linked RDF remains the executable authority. */
export function renderProcedure(turtle, { descriptorUrl, controls = [] }) {
  const { procedure, graph } = compileProcedureGraph(turtle);
  const resource = new Map(procedure.steps.map((step, i) => [step.id, graph.stepIris[i]]));
  const cell = text => String(text).replaceAll('|', '\\|').replaceAll('\n', ' ');
  const sources = value => {
    if (value === null || typeof value !== 'object') return [];
    if (typeof value.$ref === 'string') return [value.$ref];
    return Object.values(value).flatMap(sources);
  };
  const rows = procedure.steps.map((step, i) => {
    const next = procedure.steps[i + 1];
    const bindings = [...new Set(sources(step))].map(cell).join('; ') || '—';
    const operation = ['read', 'follow'].includes(step.op) ? `${step.op} · Hydra GET` : step.op;
    return `| [${step.id}](${resource.get(step.id)}) | ${operation} | ${next ? `[${next.id}](${resource.get(next.id)})` : 'terminal'} | ${bindings} |`;
  });
  return renderHypermediaMarkdown({
    id: graph.root, type: 'pr:Procedure', descriptorUrl, title: graph.title,
    extraContext: {
      pr: PR,
      entry: { '@id': PR + 'entry', '@type': '@id' },
      steps: { '@id': PR + 'step', '@type': '@id' },
      input: { '@id': PR + 'input', '@type': '@id' },
      procedureProfile: { '@id': 'http://purl.org/dc/terms/conformsTo', '@type': '@id' }
    },
    fields: { entry: graph.stepIris[0], steps: graph.stepIris, input: graph.inputNode,
      procedureProfile: PR + 'ReadProcedureProfile' },
    controls,
    links: [
      { label: 'Authoritative procedure graph', href: descriptorUrl, rel: 'describedby', type: 'text/turtle' },
      { label: 'Entry step', href: graph.stepIris[0], rel: PR + 'entry', type: 'text/turtle' },
      ...procedure.steps.map(step => ({ label: step.id, href: resource.get(step.id), rel: PR + 'step', type: 'text/turtle' }))
    ],
    body: `# ${graph.title}\n\n`
      + 'This view exposes the entry and step IRIs as linked data. The authoritative RDF carries each directed next edge, condition, input binding, Hydra operation, and decision boundary. The table follows those edges; file order is immaterial.\n\n'
      + 'The installed client interpreter loads the signed graph through its run request. This view advertises only controls supplied by the authority; it does not invent a server-side execution action.\n\n'
      + '| Step | Operation | Next | Bound data |\n| --- | --- | --- | --- |\n' + rows.join('\n') + '\n'
  });
}
