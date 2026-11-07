/** Optional L3 profile; no term or interpreter is installed in core. */
import { createHash } from 'node:crypto';
import { parseTrig } from '../../packages/core/dist/rdf/turtle-parser.js';
import { escapeTurtleLiteral } from '../../packages/core/dist/rdf/escape.js';
import { unpackMcp } from '../procedure-runner/runner.mjs';

export const PC = 'urn:interego:procedure-composition:';
export const HC = 'https://markjspivey-xwisee.github.io/interego/ns/hyprcat#';
export const PR = 'https://markjspivey-xwisee.github.io/interego/ns/procedure#';
export const RDF = 'http://www.w3.org/1999/02/22-rdf-syntax-ns#';
export const DCT = 'http://purl.org/dc/terms/';
export const DCAT = 'http://www.w3.org/ns/dcat#';
export const HYDRA = 'http://www.w3.org/ns/hydra/core#';
export const literal = value => `"${escapeTurtleLiteral(String(value))}"`;
export function iri(value) {
  if (typeof value !== 'string' || value.length > 2048 || !/^[a-z][a-z0-9+.-]*:/iu.test(value)
      || /[\s<>"{}|^`\\\u0000-\u001f]/u.test(value)) throw new Error('Expected an absolute IRI');
  return `<${value}>`;
}
export function httpUrl(value) {
  iri(value);
  const u = new URL(value);
  if (!['http:', 'https:'].includes(u.protocol) || u.username || u.password || u.hash) throw new Error('Expected an HTTP resource URL');
  return value;
}
export function canonical(value) {
  if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']';
  if (value && typeof value === 'object') return '{' + Object.keys(value).sort().map(k => JSON.stringify(k) + ':' + canonical(value[k])).join(',') + '}';
  return JSON.stringify(value);
}
export const digest = value => createHash('sha256').update(canonical(value)).digest('hex');
export function verifiedDocument(raw, descriptorUrl, trustedSigner) {
  const data = unpackMcp(raw), a = data.authorship;
  if (data.url !== descriptorUrl || !trustedSigner || a?.signedBy !== trustedSigner
      || a.authorshipVerified !== true || a.contentBinding !== 'bound' || a.descriptorBinding?.bound !== true) {
    throw new Error('Catalogue authority or publication binding failed');
  }
  const text = data.graph?.content ?? data.content;
  if (typeof text !== 'string' || Buffer.byteLength(text) > 512 * 1024) throw new Error('Missing or oversized signed graph');
  return text;
}
export function graphIndex(turtle) {
  const nodes = new Map();
  for (const row of parseTrig(turtle).subjects) {
    const id = typeof row.subject === 'string' ? row.subject : '_:' + row.subject.bnode;
    if (!nodes.has(id)) nodes.set(id, new Map());
    for (const [p, values] of row.properties) {
      const list = nodes.get(id).get(p) ?? [];
      for (const value of values) if (!list.some(v => canonical(v) === canonical(value))) list.push(value);
      nodes.get(id).set(p, list);
    }
  }
  const many = (id, p) => nodes.get(id)?.get(p) ?? [];
  const one = (id, p, kind) => {
    const values = many(id, p);
    if (values.length !== 1 || values[0].kind !== kind) throw new Error(`Missing or ambiguous ${p}`);
    return values[0];
  };
  const link = (id, p) => one(id, p, 'iri').iri;
  const text = (id, p) => one(id, p, 'literal').value;
  const links = (id, p) => many(id, p).map(t => { if (t.kind !== 'iri') throw new Error('Expected named resource links'); return t.iri; });
  const typed = (id, type) => many(id, RDF + 'type').some(t => t.kind === 'iri' && t.iri === type);
  return { nodes, many, link, text, links, typed };
}

/** Same DCAT/HyprCat structure as FOXXI course products, with a local procedure profile. */
export function parseProcedureCatalog(turtle, policy) {
  const g = graphIndex(turtle), id = policy.graphIri;
  if (!g.typed(id, HC + 'FederatedCatalog') || !g.typed(id, PC + 'Catalog')
      || g.link(id, HC + 'issuedBy') !== policy.issuer || g.link(id, HC + 'world') !== HC + 'AgentWorld') {
    throw new Error('Catalogue identity, issuer, world or installed profile does not match policy');
  }
  const members = g.links(id, DCAT + 'dataset');
  if (members.length > 32) throw new Error('Catalogue product budget exceeded');
  const products = members.map(productId => {
    if (!g.typed(productId, HC + 'FederatedDataProduct') || !g.typed(productId, PC + 'ProcedureProduct')
        || g.link(productId, HC + 'issuedBy') !== policy.issuer
        || g.link(productId, HC + 'world') !== HC + 'AgentWorld'
        || g.link(productId, DCT + 'conformsTo') !== PR + 'ReadProcedureProfile') throw new Error('Invalid procedure product authority or profile');
    const port = g.link(productId, HC + 'outputPort');
    if (!g.typed(port, HC + 'FederatedDistribution') || !g.typed(port, HC + 'PortAffordance')
        || !g.typed(port, HYDRA + 'Operation') || g.text(port, HYDRA + 'method') !== 'GET'
        || g.text(port, DCAT + 'mediaType') !== 'text/turtle') throw new Error('Only a Turtle request read port is supported');
    const requestUrl = httpUrl(g.link(port, DCAT + 'accessURL'));
    if (g.link(port, HYDRA + 'target') !== requestUrl) throw new Error('Request port target differs from its access URL');
    // parseTrig keeps a relative IRI such as <?d> as the bare string '?d', which
    // DifferentialKernel would read as a variable matching any task term.
    const [domain, goal, procedureId] = ['domain', 'goal', 'procedure'].map(p => g.link(productId, PC + p));
    for (const value of [domain, goal, procedureId]) iri(value);
    return { id: productId, title: g.text(productId, DCT + 'title'), domain, goal, procedureId, requestUrl };
  });
  const peers = g.links(id, HC + 'federatedWith');
  if (peers.length > 8) throw new Error('Catalogue peer budget exceeded');
  return { id, products, peers };
}

export function renderCatalog({ graphIri, issuer, products, peers = [] }) {
  if (products.length > 32 || peers.length > 8) throw new Error('Catalogue budget exceeded');
  const t = [`${iri(graphIri)} a ${iri(HC + 'FederatedCatalog')}, ${iri(PC + 'Catalog')} ;`,
    `  ${iri(HC + 'issuedBy')} ${iri(issuer)} ; ${iri(HC + 'world')} ${iri(HC + 'AgentWorld')} .`];
  for (const peer of peers) t.push(`${iri(graphIri)} ${iri(HC + 'federatedWith')} ${iri(peer)} .`);
  for (const p of products) {
    const port = p.id + '#request-port'; httpUrl(p.requestUrl);
    t.push(`${iri(graphIri)} ${iri(DCAT + 'dataset')} ${iri(p.id)} .`,
      `${iri(p.id)} a ${iri(HC + 'FederatedDataProduct')}, ${iri(PC + 'ProcedureProduct')} ;`,
      `  ${iri(DCT + 'title')} ${literal(p.title)} ; ${iri(HC + 'issuedBy')} ${iri(issuer)} ;`,
      `  ${iri(HC + 'world')} ${iri(HC + 'AgentWorld')} ; ${iri(DCT + 'conformsTo')} ${iri(PR + 'ReadProcedureProfile')} ;`,
      `  ${iri(PC + 'domain')} ${iri(p.domain)} ; ${iri(PC + 'goal')} ${iri(p.goal)} ;`,
      `  ${iri(PC + 'procedure')} ${iri(p.procedureId)} ; ${iri(HC + 'outputPort')} ${iri(port)} .`,
      `${iri(port)} a ${iri(HC + 'PortAffordance')}, ${iri(HC + 'FederatedDistribution')}, ${iri(HYDRA + 'Operation')} ;`,
      `  ${iri(HYDRA + 'method')} "GET" ; ${iri(HYDRA + 'target')} ${iri(p.requestUrl)} ;`,
      `  ${iri(DCAT + 'accessURL')} ${iri(p.requestUrl)} ; ${iri(DCAT + 'mediaType')} "text/turtle" .`);
  }
  return t.join('\n') + '\n';
}

/** Publication arguments are data prepared for the existing authenticated publisher. */
export function renderRunRequest({ id, procedureDescriptor, procedureGraph, procedurePod, procedureCid, input }) {
  httpUrl(procedureDescriptor); httpUrl(procedurePod);
  const fields = Object.entries(input);
  if (!fields.length || fields.length > 32 || fields.some(([k, v]) => !/^[a-zA-Z][a-zA-Z0-9]*$/u.test(k) || typeof v !== 'string')) throw new Error('Expected bounded scalar request inputs');
  const t = [`${iri(id)} a ${iri(PR + 'RunRequest')} ; ${iri(PR + 'procedure')} ${iri(procedureDescriptor)} ;`,
    `  ${iri(PR + 'procedureGraph')} ${iri(procedureGraph)} ; ${iri(PR + 'procedurePod')} ${iri(procedurePod)} ;`,
    `  ${iri(PR + 'procedureCid')} ${literal(procedureCid)} ; ${iri(PR + 'input')} ${iri(id + '#input')} .`];
  for (const [key, value] of fields) t.push(`${iri(id + '#input')} ${iri(PR + 'field')} ${iri(id + '#' + key)} .`,
    `${iri(id + '#' + key)} ${iri(PR + 'key')} ${literal(key)} ; ${iri(PR + 'value')} ${literal(value)} .`);
  return t.join('\n') + '\n';
}
