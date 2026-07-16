/**
 * spec-ontology.ts — standards ontologies that EMERGE from the substrate.
 *
 * A spec ontology (xAPI 2.0, SCORM CAM/SN/RTE, cmi5) is authored ONCE as a
 * structured OntologyModel (the single source, derived from the normative
 * spec/XSDs). It is then:
 *
 *   1. COMPOSED into the shared PGSL lattice (composeSpecOntology →
 *      composeIntoSharedLattice): every class/property/vocab IRI becomes a
 *      reusable lattice atom, and the whole model is the holon's content atom.
 *      The ontology is now a first-class Interego holon (iep:ContextDescriptor,
 *      provenance, affordances) — emergent of PGSL, not a hosted file.
 *
 *   2. PROJECTED on dereference: OWL Turtle, SHACL, and JSON-LD are renders of
 *      that same holon's content (readArtifact → render*). RDF is one projection
 *      of many — exactly how a course KG or a performance holon projects.
 *
 *   3. The SINGLE SOURCE for conformance: validateAgainstShape applies the SAME
 *      constraints the SHACL projection publishes, and every result cites the
 *      dereferenceable sh:NodeShape IRI. So when the LRS/LMS validates a
 *      statement/manifest, it is validating against this ontology — not a
 *      detached code rule.
 *
 * Because instances (statements, manifests) are composed into the SAME lattice,
 * their verb/type IRIs reuse the spec atoms — conformance is coherence over the
 * shared graph.
 */
import { composeIntoSharedLattice, readArtifact } from './foundation-shared-lattice.js';

/** The dereferenceable namespace root the bridge serves (conneg + HATEOAS). Kept
 *  identical to foxxi-vocab's host so every Foxxi ns IRI resolves the same way. */
export const NS_ROOT = 'https://interego-foxxi-bridge.livelysky-8b81abb0.eastus.azurecontainerapps.io/ns/';

export interface OntClass { name: string; label: string; comment: string; subClassOf?: string[] }
export interface OntProperty {
  name: string; label: string; comment: string;
  kind: 'object' | 'datatype';
  domain?: string; range?: string;
  functional?: boolean; inverseFunctional?: boolean;
}
export interface OntVocabMember { name: string; label: string; comment?: string }
export interface OntVocab { name: string; label?: string; comment?: string; members: OntVocabMember[] }
export interface ShapeConstraint {
  path: string; comment?: string;
  datatype?: string;      // e.g. xsd:dateTime
  class?: string;         // sh:class IRI (curie or #name within this module)
  nodeKind?: 'IRI' | 'Literal' | 'IRIOrLiteral' | 'BlankNodeOrIRI';
  minCount?: number; maxCount?: number;
  pattern?: string;       // regex (string form)
  in?: string[];          // sh:in enumeration (literal values)
  minInclusive?: number; maxInclusive?: number;
}
export interface OntShape {
  name: string; targetClass: string; label?: string; comment?: string;
  closed?: boolean; ignoredProperties?: string[];
  constraints: ShapeConstraint[];
  /** Exactly one of these paths must be present (rendered as sh:xone, enforced by the
   *  validator) — e.g. an xAPI Agent's single Inverse Functional Identifier. */
  exactlyOneOf?: { paths: string[]; comment?: string };
}
export interface OntologyModel {
  module: string;         // 'xapi' | 'scorm-cam' | …  (→ <NS_ROOT><module>)
  title: string; description: string; version: string;
  spec: string;           // official normative spec URL
  derivedFrom?: string;   // e.g. the in-repo XSD path the model transcribes
  prefixes?: Record<string, string>;
  imports?: string[];
  classes: OntClass[];
  properties: OntProperty[];
  vocabularies?: OntVocab[];
  shapes: OntShape[];
}

// ── IRI helpers ───────────────────────────────────────────────────────────────
export const ontologyIri = (m: OntologyModel): string => `${NS_ROOT}${m.module}`;
export const ns = (m: OntologyModel): string => `${ontologyIri(m)}#`;
export const shapesIri = (m: OntologyModel): string => `${ontologyIri(m)}/shapes`;
const esc = (s: string): string => String(s).replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n');

/** Expand a class/range token: a curie (`prov:Agent`) stays; a bare `Name` becomes a module term. */
function expand(m: OntologyModel, token: string): string {
  if (!token) return token;
  if (/^https?:\/\//.test(token)) return `<${token}>`;
  if (/^[a-z][\w-]*:/i.test(token)) return token; // already a curie
  return `${m.module}:${token}`;
}

const STD_PREFIXES: Record<string, string> = {
  rdf: 'http://www.w3.org/1999/02/22-rdf-syntax-ns#',
  rdfs: 'http://www.w3.org/2000/01/rdf-schema#',
  owl: 'http://www.w3.org/2002/07/owl#',
  xsd: 'http://www.w3.org/2001/XMLSchema#',
  sh: 'http://www.w3.org/ns/shacl#',
  skos: 'http://www.w3.org/2004/02/skos/core#',
  dct: 'http://purl.org/dc/terms/',
  prov: 'http://www.w3.org/ns/prov#',
};

function prefixBlock(m: OntologyModel, extra: Record<string, string> = {}): string {
  const all = { ...STD_PREFIXES, ...(m.prefixes ?? {}), [m.module]: ns(m), ...extra };
  return Object.entries(all).map(([p, iri]) => `@prefix ${p}: <${iri}> .`).join('\n');
}

/** A triple, as three ABSOLUTE identifiers (or a literal in object position).
 *  Never a CURIE: `rdfs:label` is a Turtle serialization artifact, the identity is
 *  the URL it abbreviates. Feeding abbreviations to the lattice would atomize the
 *  serialization instead of the thing. */
export type Triple = readonly [string, string, string];

const A = STD_PREFIXES.rdf + 'type';
const RDFS = STD_PREFIXES.rdfs, OWL = STD_PREFIXES.owl, SKOS = STD_PREFIXES.skos, DCT = STD_PREFIXES.dct;

/** Expand a model token to an ABSOLUTE url (the module's own ns, a std prefix, or
 *  an already-absolute url) — the inverse of the CURIE the Turtle projection prints. */
function expandAbs(m: OntologyModel, token: string): string {
  if (!token) return token;
  if (/^https?:\/\//.test(token)) return token;
  const curie = /^([a-z][\w-]*):(.+)$/i.exec(token);
  if (curie) {
    const base = ({ ...STD_PREFIXES, ...(m.prefixes ?? {}), [m.module]: ns(m) })[curie[1]!];
    return base ? base + curie[2] : token;
  }
  return `${ns(m)}${token}`;
}

/**
 * The ontology as TRIPLES — the same graph renderOwl prints, but as data.
 *
 * This is what the lattice should be fed. Ingesting the ontology as a flat list
 * of its subject urls gives every atom exactly one occurrence (measured: 1.05x
 * reuse across all six specs), so PGSL builds ~n^2/2 prefix fragments over a
 * sequence with no shared structure — the overlap is destroyed BEFORE the lattice
 * sees it. At triple granularity the same six specs reuse at 5.30x, because a
 * spec is overwhelmingly repetition: rdfs:isDefinedBy 520x, rdfs:comment 511x,
 * rdf:type 509x, rdfs:label 362x. Those become ONE atom each, shared by every
 * triple and every ontology that mentions them.
 *
 * Composed HOLONICALLY by the caller: each triple is a holon of its three atoms,
 * and the ontology is a holon of its triples. Granularity stays open — an atom
 * here can later be decomposed further (url segments, characters) beneath these
 * triples without disturbing anything reading at the triple level.
 */
export function ontologyTriples(m: OntologyModel): Triple[] {
  const out: Triple[] = [];
  const O = ontologyIri(m);
  out.push([O, A, OWL + 'Ontology'], [O, DCT + 'title', m.title], [O, DCT + 'description', m.description],
    [O, OWL + 'versionInfo', m.version], [O, RDFS + 'seeAlso', m.spec]);
  if (m.derivedFrom) out.push([O, RDFS + 'comment', `Transcribed from the normative schema: ${m.derivedFrom}`]);
  for (const i of m.imports ?? []) out.push([O, OWL + 'imports', /^https?:\/\//.test(i) ? i : `${NS_ROOT}${i}`]);
  out.push([O, RDFS + 'isDefinedBy', O]);

  for (const c of m.classes) {
    const s = `${ns(m)}${c.name}`;
    out.push([s, A, OWL + 'Class'], [s, RDFS + 'label', c.label], [s, RDFS + 'comment', c.comment]);
    for (const sup of c.subClassOf ?? []) out.push([s, RDFS + 'subClassOf', expandAbs(m, sup)]);
    out.push([s, RDFS + 'isDefinedBy', O]);
  }
  for (const p of m.properties) {
    const s = `${ns(m)}${p.name}`;
    out.push([s, A, OWL + (p.kind === 'object' ? 'ObjectProperty' : 'DatatypeProperty')]);
    if (p.functional) out.push([s, A, OWL + 'FunctionalProperty']);
    if (p.inverseFunctional) out.push([s, A, OWL + 'InverseFunctionalProperty']);
    out.push([s, RDFS + 'label', p.label], [s, RDFS + 'comment', p.comment]);
    if (p.domain) out.push([s, RDFS + 'domain', expandAbs(m, p.domain)]);
    if (p.range) out.push([s, RDFS + 'range', expandAbs(m, p.range)]);
    out.push([s, RDFS + 'isDefinedBy', O]);
  }
  for (const v of m.vocabularies ?? []) {
    const vs = `${ns(m)}${v.name}`;
    out.push([vs, A, SKOS + 'ConceptScheme'], [vs, RDFS + 'label', v.label ?? v.name]);
    if (v.comment) out.push([vs, RDFS + 'comment', v.comment]);
    out.push([vs, RDFS + 'isDefinedBy', O]);
    for (const mem of v.members) {
      const ms = `${ns(m)}${mem.name}`;
      out.push([ms, A, SKOS + 'Concept'], [ms, SKOS + 'inScheme', vs], [ms, SKOS + 'prefLabel', mem.label]);
      if (mem.comment) out.push([ms, SKOS + 'definition', mem.comment]);
      out.push([ms, RDFS + 'isDefinedBy', O]);
    }
  }
  return out;
}

// ── OWL projection ──────────────────────────────────────────────────────────
export function renderOwl(m: OntologyModel): string {
  const lines: string[] = [prefixBlock(m), ''];
  lines.push(`<${ontologyIri(m)}> a owl:Ontology ;`);
  lines.push(`    dct:title "${esc(m.title)}" ;`);
  lines.push(`    dct:description "${esc(m.description)}" ;`);
  lines.push(`    owl:versionInfo "${esc(m.version)}" ;`);
  lines.push(`    rdfs:seeAlso <${m.spec}> ;`);
  if (m.derivedFrom) lines.push(`    rdfs:comment "Transcribed from the normative schema: ${esc(m.derivedFrom)}" ;`);
  // Expand a bare module token (e.g. 'xapi') to its dereferenceable ontology IRI;
  // keep an already-absolute IRI as-is. (A bare <xapi> would not resolve.)
  if (m.imports?.length) for (const i of m.imports) lines.push(`    owl:imports <${/^https?:\/\//.test(i) ? i : `${NS_ROOT}${i}`}> ;`);
  lines.push(`    rdfs:isDefinedBy <${ontologyIri(m)}> .`, '');

  for (const c of m.classes) {
    const parts = [`${m.module}:${c.name} a owl:Class ;`,
      `    rdfs:label "${esc(c.label)}" ;`,
      `    rdfs:comment "${esc(c.comment)}" ;`];
    for (const s of c.subClassOf ?? []) parts.push(`    rdfs:subClassOf ${expand(m, s)} ;`);
    parts.push(`    rdfs:isDefinedBy <${ontologyIri(m)}> .`);
    lines.push(parts.join('\n'), '');
  }
  for (const p of m.properties) {
    const pt = p.kind === 'object' ? 'owl:ObjectProperty' : 'owl:DatatypeProperty';
    const parts = [`${m.module}:${p.name} a ${pt}${p.functional ? ', owl:FunctionalProperty' : ''}${p.inverseFunctional ? ', owl:InverseFunctionalProperty' : ''} ;`,
      `    rdfs:label "${esc(p.label)}" ;`,
      `    rdfs:comment "${esc(p.comment)}" ;`];
    if (p.domain) parts.push(`    rdfs:domain ${expand(m, p.domain)} ;`);
    if (p.range) parts.push(`    rdfs:range ${expand(m, p.range)} ;`);
    parts.push(`    rdfs:isDefinedBy <${ontologyIri(m)}> .`);
    lines.push(parts.join('\n'), '');
  }
  for (const v of m.vocabularies ?? []) {
    lines.push(`${m.module}:${v.name} a skos:ConceptScheme ;\n    rdfs:label "${esc(v.label ?? v.name)}" ;${v.comment ? `\n    rdfs:comment "${esc(v.comment)}" ;` : ''}\n    rdfs:isDefinedBy <${ontologyIri(m)}> .`, '');
    for (const mem of v.members) {
      lines.push(`${m.module}:${mem.name} a skos:Concept ;\n    skos:inScheme ${m.module}:${v.name} ;\n    skos:prefLabel "${esc(mem.label)}" ;${mem.comment ? `\n    skos:definition "${esc(mem.comment)}" ;` : ''}\n    rdfs:isDefinedBy <${ontologyIri(m)}> .`, '');
    }
  }
  return lines.join('\n') + '\n';
}

// ── SHACL projection ──────────────────────────────────────────────────────────
export function renderShacl(m: OntologyModel): string {
  const lines: string[] = [prefixBlock(m, { shapes: `${shapesIri(m)}#` }), ''];
  lines.push(`<${shapesIri(m)}> a owl:Ontology ;\n    dct:title "${esc(m.title)} — SHACL shapes" ;\n    rdfs:comment "Conformance shapes for ${esc(m.module)}; the LMS/LRS validates instances against these (single source: the composed ontology model). Each result cites its sh:NodeShape IRI." ;\n    rdfs:isDefinedBy <${ontologyIri(m)}> .`, '');
  for (const s of m.shapes) {
    const parts = [`shapes:${s.name} a sh:NodeShape ;`,
      `    sh:targetClass ${expand(m, s.targetClass)} ;`];
    if (s.label) parts.push(`    rdfs:label "${esc(s.label)}" ;`);
    if (s.comment) parts.push(`    rdfs:comment "${esc(s.comment)}" ;`);
    if (s.closed) parts.push(`    sh:closed true ;`);
    for (const c of s.constraints) {
      const inner: string[] = [`sh:path ${expand(m, c.path)}`];
      if (c.datatype) inner.push(`sh:datatype ${c.datatype}`);
      if (c.class) inner.push(`sh:class ${expand(m, c.class)}`);
      if (c.nodeKind) inner.push(`sh:nodeKind sh:${c.nodeKind}`);
      if (c.minCount != null) inner.push(`sh:minCount ${c.minCount}`);
      if (c.maxCount != null) inner.push(`sh:maxCount ${c.maxCount}`);
      if (c.pattern) inner.push(`sh:pattern "${esc(c.pattern)}"`);
      if (c.in) inner.push(`sh:in ( ${c.in.map(x => `"${esc(x)}"`).join(' ')} )`);
      if (c.minInclusive != null) inner.push(`sh:minInclusive ${c.minInclusive}`);
      if (c.maxInclusive != null) inner.push(`sh:maxInclusive ${c.maxInclusive}`);
      if (c.comment) inner.push(`rdfs:comment "${esc(c.comment)}"`);
      parts.push(`    sh:property [ ${inner.join(' ; ')} ] ;`);
    }
    if (s.exactlyOneOf) {
      const branches = s.exactlyOneOf.paths.map(p => `[ sh:path ${expand(m, p)} ; sh:minCount 1 ]`).join(' ');
      parts.push(`    sh:xone ( ${branches} ) ;${s.exactlyOneOf.comment ? ` # ${s.exactlyOneOf.comment}` : ''}`);
    }
    parts.push(`    rdfs:isDefinedBy <${ontologyIri(m)}> .`);
    lines.push(parts.join('\n'), '');
  }
  return lines.join('\n') + '\n';
}

// ── JSON-LD projection (HATEOAS) ───────────────────────────────────────────────
export function renderJsonLd(m: OntologyModel): Record<string, unknown> {
  return {
    '@context': { ...STD_PREFIXES, ...(m.prefixes ?? {}), [m.module]: ns(m) },
    '@id': ontologyIri(m),
    '@type': 'owl:Ontology',
    'dct:title': m.title, 'dct:description': m.description, 'owl:versionInfo': m.version,
    'rdfs:seeAlso': { '@id': m.spec },
    classes: m.classes.map(c => ({ '@id': `${m.module}:${c.name}`, '@type': 'owl:Class', 'rdfs:label': c.label, 'rdfs:comment': c.comment, 'rdfs:subClassOf': (c.subClassOf ?? []).map(s => ({ '@id': expand(m, s).replace(/^<|>$/g, '') })) })),
    properties: m.properties.map(p => ({ '@id': `${m.module}:${p.name}`, '@type': p.kind === 'object' ? 'owl:ObjectProperty' : 'owl:DatatypeProperty', 'rdfs:label': p.label, 'rdfs:comment': p.comment, ...(p.domain ? { 'rdfs:domain': p.domain } : {}), ...(p.range ? { 'rdfs:range': p.range } : {}) })),
    _links: {
      self: { href: ontologyIri(m) },
      owl: { href: ontologyIri(m), type: 'text/turtle' },
      shapes: { href: shapesIri(m), type: 'text/turtle' },
      spec: { href: m.spec },
      validate: { href: `${ontologyIri(m)}/validate`, method: 'POST', title: 'Validate an instance against these shapes' },
    },
  };
}

// ── Model-driven validation (the SAME constraints the SHACL publishes) ──────────
export interface ValidationResult {
  conforms: boolean;
  results: Array<{ path: string; message: string; value?: unknown; sourceShape: string; severity: 'Violation' }>;
  shapesIri: string;
}
const IRI_RE = /^[A-Za-z][A-Za-z0-9+.-]*:[^\s]+$/;
const XSD_NUM = new Set(['xsd:decimal', 'xsd:double', 'xsd:float', 'xsd:integer', 'xsd:nonNegativeInteger', 'xsd:int']);
const XSD_STR = new Set(['xsd:string', 'xsd:anyURI', 'xsd:language', 'xsd:token', 'xsd:normalizedString']);
const DATETIME_RE = /^\d{4}-\d{2}-\d{2}[Tt ]\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:\d{2})?$/;
const DURATION_RE = /^P(?:\d+(?:\.\d+)?Y)?(?:\d+(?:\.\d+)?M)?(?:\d+(?:\.\d+)?W)?(?:\d+(?:\.\d+)?D)?(?:T(?:\d+(?:\.\d+)?H)?(?:\d+(?:\.\d+)?M)?(?:\d+(?:\.\d+)?S)?)?$/;

function pick(instance: Record<string, unknown>, path: string): unknown {
  // path is a module curie like xapi:actor → property key 'actor'; support bare too.
  const key = path.includes(':') ? path.split(':')[1] : path;
  return instance[key];
}

/** Validate a JS instance against ONE shape's constraints (citing the shape IRI). */
export function validateAgainstShape(m: OntologyModel, shapeName: string, instance: Record<string, unknown>): ValidationResult {
  const shape = m.shapes.find(s => s.name === shapeName);
  const sourceShape = `${shapesIri(m)}#${shapeName}`;
  const results: ValidationResult['results'] = [];
  if (!shape) return { conforms: true, results, shapesIri: shapesIri(m) };
  for (const c of shape.constraints) {
    const v = pick(instance, c.path);
    const present = v !== undefined && v !== null;
    const arr = Array.isArray(v) ? v : present ? [v] : [];
    if (c.minCount != null && arr.length < c.minCount) results.push({ path: c.path, message: `expected at least ${c.minCount} value(s)`, sourceShape, severity: 'Violation' });
    if (c.maxCount != null && arr.length > c.maxCount) results.push({ path: c.path, message: `expected at most ${c.maxCount} value(s)`, value: v, sourceShape, severity: 'Violation' });
    for (const item of arr) {
      const viol = (message: string): void => { results.push({ path: c.path, message, value: item, sourceShape, severity: 'Violation' }); };
      if (c.datatype && XSD_STR.has(c.datatype) && typeof item !== 'string') viol(`expected a string (${c.datatype})`);
      if (c.datatype === 'xsd:boolean' && typeof item !== 'boolean') viol('expected a boolean');
      if (c.datatype && XSD_NUM.has(c.datatype) && typeof item !== 'number') viol(`expected a number (${c.datatype})`);
      if (c.datatype === 'xsd:dateTime' && !(typeof item === 'string' && DATETIME_RE.test(item))) viol('expected an RFC 3339 dateTime');
      if (c.datatype === 'xsd:duration' && !(typeof item === 'string' && DURATION_RE.test(item))) viol('expected an ISO 8601 duration');
      if (c.datatype === 'rdf:langString' && !(typeof item === 'string' || (typeof item === 'object' && item !== null))) viol('expected a language-tagged string or language map');
      if (c.nodeKind === 'IRI' && !(typeof item === 'string' && IRI_RE.test(item))) viol('expected an IRI');
      if (c.nodeKind === 'Literal' && (item === null || typeof item === 'object')) viol('expected a literal, not an IRI/blank node');
      if (c.pattern && typeof item === 'string' && !new RegExp(c.pattern).test(item)) viol(`does not match pattern ${c.pattern}`);
      if (c.in && !c.in.includes(String(item))) viol(`not in the allowed vocabulary {${c.in.join(', ')}}`);
      if (c.minInclusive != null && typeof item === 'number' && item < c.minInclusive) viol(`must be ≥ ${c.minInclusive}`);
      if (c.maxInclusive != null && typeof item === 'number' && item > c.maxInclusive) viol(`must be ≤ ${c.maxInclusive}`);
    }
  }
  if (shape.exactlyOneOf) {
    const present = shape.exactlyOneOf.paths.filter(p => { const x = pick(instance, p); return x !== undefined && x !== null; });
    if (present.length !== 1) results.push({ path: shape.exactlyOneOf.paths.join(' | '), message: `exactly one of {${shape.exactlyOneOf.paths.join(', ')}} is required — found ${present.length}`, sourceShape, severity: 'Violation' });
  }
  return { conforms: results.length === 0, results, shapesIri: shapesIri(m) };
}

// ── Composition into the PGSL lattice (the ontology becomes a holon) ────────────
export interface ComposedOntology { module: string; label: string; holonUri?: string; descriptorUrl?: string }

/** Compose a spec ontology MODEL into the shared lattice: its term IRIs become
 *  reusable atoms, the model is the holon's content atom. Best-effort (needs a pod);
 *  returns the holon refs when persisted. */
export async function composeSpecOntology(model: OntologyModel, opts: { podUrl: string; agentDid: string }): Promise<ComposedOntology> {
  const label = `ns-${model.module}`;
  // The ontology is a graph, so compose it AS a graph — mirroring RDF's own
  // hierarchy: graph -> subject -> triple -> (subject, predicate, object).
  //
  // The previous flat list of subject urls gave every atom exactly one occurrence
  // (1.05x reuse over all six specs), so PGSL built ~n^2/2 fragments over a
  // sequence with nothing in common. Grouping by subject restores the real overlap
  // (82% of triple slots hit an existing atom) AND keeps every ingest narrow:
  // ~6 triples per subject, 3 terms per triple. Composing the ontology out of all
  // ~450 triples in ONE ingest is not "more holonic" — it is quadratic, and OOMs.
  const bySubject = new Map<string, Triple[]>();
  for (const t of ontologyTriples(model)) {
    const cur = bySubject.get(t[0]);
    if (cur) cur.push(t); else bySubject.set(t[0], [t]);
  }
  const groups = [...bySubject.values()].map(ts => ts.map(t => [t[0], t[1], t[2]] as const));
  // Keep the ontology url itself on the flat spine: it is the term other artifacts
  // (and other ontologies' owl:imports) join on.
  const terms = [ontologyIri(model)];
  if (!opts.podUrl) return { module: model.module, label };
  const sl = await composeIntoSharedLattice({
    podUrl: opts.podUrl, agentDid: opts.agentDid, label,
    terms, termGroups: groups, content: { ontology: model }, contentType: 'spec:Ontology', projections: ['rdf'],
    // The ontology IS this code's OntologyModel — recomposed identically every
    // boot and served from the resident lattice (specModelFromHolon, with the
    // model itself as fallback). Nothing dereferences its pod copy, and every
    // ontology label composes to the SAME tenant pod, so persisting made them
    // accumulate each other's nodes until the PUT 500'd at 43 MB.
    ephemeral: true,
    // Public: this ontology is already served in full at /ns/<module>. Marking it
    // lets its nodes be dereferenced by hash without a label — see resolvePublicNode.
    // Nothing here is private; every atom is a term of a published vocabulary.
    publicLattice: true,
  });
  return { module: model.module, label, holonUri: sl?.holonUri, descriptorUrl: sl?.descriptorUrl };
}

/** A single class/property term as a JSON-LD resource with HATEOAS links. */
export function renderTermJsonLd(m: OntologyModel, name: string): Record<string, unknown> {
  const cls = m.classes.find(c => c.name === name);
  const prop = m.properties.find(p => p.name === name);
  const t = cls ?? prop;
  const type = cls ? 'owl:Class' : prop ? (prop.kind === 'object' ? 'owl:ObjectProperty' : 'owl:DatatypeProperty') : 'rdfs:Resource';
  return {
    '@context': { ...STD_PREFIXES, [m.module]: ns(m) },
    '@id': `${ns(m)}${name}`, '@type': type,
    'rdfs:label': t?.label ?? name,
    'rdfs:comment': t?.comment ?? `A term in ${m.title}.`,
    'rdfs:isDefinedBy': { '@id': ontologyIri(m) },
    _links: { ontology: { href: ontologyIri(m) }, shapes: { href: shapesIri(m) }, spec: { href: m.spec } },
  };
}

/** A minimal human-readable HTML view (content negotiation: Accept: text/html). */
export function renderHtml(m: OntologyModel): string {
  const li = (s: string): string => `<li><code>${s}</code></li>`;
  return `<!doctype html><meta charset="utf-8"><title>${m.title}</title>`
    + `<body style="font-family:system-ui;max-width:50rem;margin:2rem auto;line-height:1.5">`
    + `<h1>${m.title}</h1><p>${m.description}</p>`
    + `<p><b>IRI:</b> <code>${ontologyIri(m)}</code> · <b>version:</b> ${m.version} · <b>spec:</b> <a href="${m.spec}">${m.spec}</a></p>`
    + `<p>Projections: <a href="${ontologyIri(m)}" type="text/turtle">OWL (Turtle)</a> · <a href="${shapesIri(m)}">SHACL shapes</a> · <a href="${ontologyIri(m)}/validate">POST /validate</a></p>`
    + `<p>This ontology is composed into the PGSL lattice; the OWL/SHACL/JSON-LD here are projections of that holon. The Foxxi LRS/LMS validate instances against these shapes.</p>`
    + `<h2>Classes (${m.classes.length})</h2><ul>${m.classes.map(c => li(`${m.module}:${c.name}`)).join('')}</ul>`
    + `<h2>Properties (${m.properties.length})</h2><ul>${m.properties.map(p => li(`${m.module}:${p.name}`)).join('')}</ul>`
    + `<h2>Shapes (${m.shapes.length})</h2><ul>${m.shapes.map(s => li(`${m.module}-shapes:${s.name}`)).join('')}</ul>`
    + `</body>`;
}

/** Read the model back from the composed holon (PGSL is canonical), if resident. */
export function modelFromHolon(label: string, holonUri: string): OntologyModel | null {
  const art = readArtifact(label, holonUri);
  if (!art || art.contentType !== 'spec:Ontology') return null;
  return (art.content as { ontology: OntologyModel }).ontology;
}
