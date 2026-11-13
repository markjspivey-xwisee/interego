/**
 * An xAPI Profile as RDF.
 *
 * A profile is a JSON-LD document read through one fixed context (https://w3id.org/xapi/profiles/context),
 * so its triples are decided by that context alone and no remote context is ever fetched. This
 * module is that context applied by hand: which properties name IRIs, which are language maps,
 * which carry a datatype, and that `sequence` is an ordered list.
 *
 * It also materializes the inference a Profile Server has to answer queries with (Part Three, 1.0):
 * every SKOS relationship, and `profile:concepts`, `profile:templates` and `profile:patterns` as
 * subproperties of the inverse of `skos:inScheme`.
 *
 * Terms are written the way @interego/pgsl's triple store holds them: an IRI bare, a blank node
 * `_:x`, a literal `"text"`, `"text"@en` or `"5"^^<datatype IRI, bare>`.
 */
import type { Triple } from '@interego/pgsl';
import { sha256 } from '@interego/core';

export type Json = null | boolean | number | string | Json[] | { [key: string]: Json };
type Obj = { [key: string]: Json };

const NS = {
  rdf: 'http://www.w3.org/1999/02/22-rdf-syntax-ns#',
  rdfs: 'http://www.w3.org/2000/01/rdf-schema#',
  xsd: 'http://www.w3.org/2001/XMLSchema#',
  prov: 'http://www.w3.org/ns/prov#',
  skos: 'http://www.w3.org/2004/02/skos/core#',
  xapi: 'https://w3id.org/xapi/ontology#',
  profile: 'https://w3id.org/xapi/profiles/ontology#',
  dcterms: 'http://purl.org/dc/terms/',
  schemaorg: 'http://schema.org/',
} as const;
export const PROFILE_NS = NS;
export const RDF_TYPE = `${NS.rdf}type`;
const RDF_JSON = `${NS.rdf}JSON`;

/** The classes the context names. A `type` outside this table is kept if it is already an IRI. */
const CLASSES: Record<string, string> = {
  Profile: `${NS.profile}Profile`, StatementTemplate: `${NS.profile}StatementTemplate`, Pattern: `${NS.profile}Pattern`,
  Organization: `${NS.schemaorg}Organization`, Person: `${NS.schemaorg}Person`,
  ...Object.fromEntries(['Verb', 'ActivityType', 'AttachmentUsageType', 'ContextExtension', 'ResultExtension', 'ActivityExtension',
    'StateResource', 'AgentProfileResource', 'ActivityProfileResource', 'Activity'].map(c => [c, `${NS.xapi}${c}`])),
};

type Kind = 'iri' | 'language' | 'boolean' | 'dateTime' | 'list' | 'node' | 'value' | 'text';
const term = (iri: string, kind: Kind): { iri: string; kind: Kind } => ({ iri, kind });
const skosIri = (name: string) => term(`${NS.skos}${name}`, 'iri');
const profIri = (name: string) => term(`${NS.profile}${name}`, 'iri');

/** The context's term definitions. A key that is not here is not in the context, and JSON-LD drops it. */
const TERMS: Record<string, { iri: string; kind: Kind }> = {
  conformsTo: term(`${NS.dcterms}conformsTo`, 'iri'),
  prefLabel: term(`${NS.skos}prefLabel`, 'language'),
  definition: term(`${NS.skos}definition`, 'language'),
  // Written as a language map in every published profile, though the context gives it no container.
  scopeNote: term(`${NS.skos}scopeNote`, 'language'),
  seeAlso: term(`${NS.rdfs}seeAlso`, 'iri'),
  versions: term(`${NS.profile}versions`, 'node'),
  author: term(`${NS.schemaorg}author`, 'node'),
  concepts: term(`${NS.profile}concepts`, 'node'),
  templates: term(`${NS.profile}templates`, 'node'),
  patterns: term(`${NS.profile}patterns`, 'node'),
  wasRevisionOf: term(`${NS.prov}wasRevisionOf`, 'iri'),
  generatedAtTime: term(`${NS.prov}generatedAtTime`, 'dateTime'),
  name: term(`${NS.schemaorg}name`, 'text'),
  url: term(`${NS.schemaorg}url`, 'text'),
  inScheme: skosIri('inScheme'),
  deprecated: term(`${NS.profile}deprecated`, 'boolean'),
  ...Object.fromEntries(['broader', 'narrower', 'broadMatch', 'narrowMatch', 'exactMatch', 'relatedMatch', 'related'].map(n => [n, skosIri(n)])),
  ...Object.fromEntries(['recommendedActivityTypes', 'recommendedVerbs', 'context', 'schema', 'verb', 'objectActivityType',
    'contextGroupingActivityType', 'contextParentActivityType', 'contextOtherActivityType', 'contextCategoryActivityType',
    'attachmentUsageType', 'objectStatementRefTemplate', 'contextStatementRefTemplate', 'alternates', 'optional', 'oneOrMore',
    'zeroOrMore'].map(n => [n, profIri(n)])),
  inlineSchema: term(`${NS.profile}inlineSchema`, 'text'),
  contentType: term(`${NS.profile}contentType`, 'text'),
  // An Activity definition is read through the xAPI activity context, not this one. Its exact JSON
  // is kept as one rdf:JSON literal rather than guessed at.
  activityDefinition: term(`${NS.profile}activityDefinition`, 'value'),
  rules: term(`${NS.profile}rules`, 'node'),
  location: term(`${NS.profile}location`, 'text'),
  selector: term(`${NS.profile}selector`, 'text'),
  presence: term(`${NS.profile}presence`, 'text'),
  any: term(`${NS.profile}any`, 'value'),
  all: term(`${NS.profile}all`, 'value'),
  none: term(`${NS.profile}none`, 'value'),
  primary: term(`${NS.profile}primary`, 'boolean'),
  sequence: term(`${NS.profile}sequence`, 'list'),
};

const isObj = (v: Json | undefined): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v);
const many = (v: Json | undefined): Json[] => v === undefined || v === null ? [] : Array.isArray(v) ? v : [v];
const isIri = (v: Json | undefined): v is string => typeof v === 'string' && /^[a-z][a-z0-9+.-]*:[^\s<>"{}|\\^`]+$/i.test(v);

export const literal = (text: string, more: { language?: string; datatype?: string } = {}): string =>
  more.language ? `"${text}"@${more.language}` : more.datatype ? `"${text}"^^${more.datatype}` : `"${text}"`;

/** A JSON value as one literal: a string plain, a number or boolean typed, anything else as rdf:JSON. */
function valueLiteral(v: Json): string {
  if (typeof v === 'string') return literal(v);
  if (typeof v === 'boolean') return literal(String(v), { datatype: `${NS.xsd}boolean` });
  if (typeof v === 'number') return literal(String(v), { datatype: `${NS.xsd}${Number.isInteger(v) ? 'integer' : 'double'}` });
  return literal(canonicalJson(v), { datatype: RDF_JSON });
}
function canonicalJson(v: Json): string {
  if (Array.isArray(v)) return `[${v.map(canonicalJson).join(',')}]`;
  if (isObj(v)) return `{${Object.keys(v).sort().map(k => `${JSON.stringify(k)}:${canonicalJson(v[k]!)}`).join(',')}}`;
  return JSON.stringify(v);
}

/**
 * The triples a profile document states. Blank nodes are named from `scope`, so two versions held
 * in one store never share one.
 */
export function profileTriples(doc: Json, scope: string): Triple[] {
  if (!isObj(doc) || !isIri(doc.id)) throw new Error('A profile needs an "id" that is an IRI.');
  const out: Triple[] = [], seen = new Set<string>();
  const tag = sha256(scope).slice(0, 12);
  let blanks = 0;
  const blank = () => `_:p${tag}n${blanks++}`;
  const add = (subject: string, predicate: string, object: string) => {
    const key = `${subject}\u0000${predicate}\u0000${object}`;
    if (!seen.has(key)) { seen.add(key); out.push({ subject, predicate, object }); }
  };

  const node = (o: Obj): string => {
    const subject = isIri(o.id) ? o.id : blank();
    for (const t of many(o.type)) {
      if (typeof t !== 'string') continue;
      const cls = CLASSES[t] ?? (isIri(t) ? t : undefined);
      if (cls) add(subject, RDF_TYPE, cls);
    }
    for (const [key, raw] of Object.entries(o)) {
      const def = TERMS[key];
      if (!def || raw === null) continue;
      switch (def.kind) {
        case 'iri': for (const v of many(raw)) if (isIri(v)) add(subject, def.iri, v); break;
        case 'language':
          if (isObj(raw)) { for (const [language, text] of Object.entries(raw)) for (const t of many(text)) if (typeof t === 'string') add(subject, def.iri, literal(t, { language })); }
          else for (const t of many(raw)) if (typeof t === 'string') add(subject, def.iri, literal(t));
          break;
        case 'boolean': for (const v of many(raw)) if (typeof v === 'boolean') add(subject, def.iri, literal(String(v), { datatype: `${NS.xsd}boolean` })); break;
        case 'dateTime': for (const v of many(raw)) if (typeof v === 'string') add(subject, def.iri, literal(v, { datatype: `${NS.xsd}dateTime` })); break;
        case 'text': for (const v of many(raw)) if (!isObj(v) && !Array.isArray(v)) add(subject, def.iri, valueLiteral(v)); break;
        case 'value': for (const v of key === 'activityDefinition' ? [raw] : many(raw)) add(subject, def.iri, valueLiteral(v)); break;
        case 'node': for (const v of many(raw)) { if (isObj(v)) add(subject, def.iri, node(v)); else if (isIri(v)) add(subject, def.iri, v); } break;
        case 'list': {
          const members = many(raw).filter(isIri);
          let head = `${NS.rdf}nil`;
          for (let i = members.length - 1; i >= 0; i--) {
            const cell = blank();
            add(cell, `${NS.rdf}first`, members[i]!);
            add(cell, `${NS.rdf}rest`, head);
            head = cell;
          }
          add(subject, def.iri, head);
          break;
        }
      }
    }
    return subject;
  };
  node(doc);
  return out;
}

// ── Inference ─────────────────────────────────────────────────────────────────────────────────

const sk = (n: string) => `${NS.skos}${n}`;
/** SKOS, as its reference states it: S7–S45, the property hierarchy and characteristics. */
const SUB_PROPERTY: Array<[string, string]> = [
  [sk('broader'), sk('broaderTransitive')], [sk('narrower'), sk('narrowerTransitive')],
  [sk('broaderTransitive'), sk('semanticRelation')], [sk('narrowerTransitive'), sk('semanticRelation')], [sk('related'), sk('semanticRelation')],
  [sk('broadMatch'), sk('broader')], [sk('narrowMatch'), sk('narrower')], [sk('relatedMatch'), sk('related')],
  [sk('broadMatch'), sk('mappingRelation')], [sk('narrowMatch'), sk('mappingRelation')], [sk('relatedMatch'), sk('mappingRelation')],
  [sk('exactMatch'), sk('closeMatch')], [sk('closeMatch'), sk('mappingRelation')], [sk('mappingRelation'), sk('semanticRelation')],
  [sk('topConceptOf'), sk('inScheme')],
  [sk('prefLabel'), `${NS.rdfs}label`], [sk('altLabel'), `${NS.rdfs}label`], [sk('hiddenLabel'), `${NS.rdfs}label`],
  ...['changeNote', 'definition', 'editorialNote', 'example', 'historyNote', 'scopeNote'].map((n): [string, string] => [sk(n), sk('note')]),
];
const INVERSE: Array<[string, string]> = [
  [sk('broader'), sk('narrower')], [sk('broadMatch'), sk('narrowMatch')], [sk('broaderTransitive'), sk('narrowerTransitive')],
  [sk('topConceptOf'), sk('hasTopConcept')],
  // The specification's own rule: these three are subproperties of the inverse of skos:inScheme.
  ...['concepts', 'templates', 'patterns'].map((n): [string, string] => [`${NS.profile}${n}`, `\u0000inverse-inScheme`]),
];
const SYMMETRIC = [sk('related'), sk('relatedMatch'), sk('exactMatch'), sk('closeMatch')];
const TRANSITIVE = [sk('broaderTransitive'), sk('narrowerTransitive'), sk('exactMatch')];

/**
 * Every triple the stated ones entail under the rules above, the stated ones not included.
 * Run to a fixed point: a broadMatch gives a broader, which gives a narrower back and a
 * broaderTransitive on, and so on.
 */
export function inferred(stated: readonly Triple[]): Triple[] {
  const key = (s: string, p: string, o: string) => `${s}\u0000${p}\u0000${o}`;
  const have = new Set(stated.map(t => key(t.subject, t.predicate, t.object)));
  const all: Triple[] = [...stated], fresh: Triple[] = [];
  const resource = (o: string) => !o.startsWith('"');
  const add = (subject: string, predicate: string, object: string) => {
    const k = key(subject, predicate, object);
    if (have.has(k)) return;
    have.add(k);
    const t = { subject, predicate, object };
    all.push(t); fresh.push(t);
  };
  const sub = new Map<string, string[]>(), inv = new Map<string, string[]>();
  for (const [a, b] of SUB_PROPERTY) sub.set(a, [...(sub.get(a) ?? []), b]);
  for (const [a, b] of INVERSE) {
    if (b === '\u0000inverse-inScheme') continue;
    inv.set(a, [...(inv.get(a) ?? []), b]); inv.set(b, [...(inv.get(b) ?? []), a]);
  }
  const inSchemeInverse = new Set(['concepts', 'templates', 'patterns'].map(n => `${NS.profile}${n}`));
  const symmetric = new Set(SYMMETRIC), transitive = new Set(TRANSITIVE);

  for (let i = 0; i < all.length; i++) {
    const { subject: s, predicate: p, object: o } = all[i]!;
    for (const q of sub.get(p) ?? []) add(s, q, o);
    if (!resource(o)) continue;
    for (const q of inv.get(p) ?? []) add(o, q, s);
    if (inSchemeInverse.has(p)) add(o, sk('inScheme'), s);
    if (symmetric.has(p)) add(o, p, s);
    if (transitive.has(p)) {
      // Join with what is already known in both directions; later triples join back as they arrive.
      for (let j = 0; j < all.length; j++) {
        const t = all[j]!;
        if (t.predicate !== p) continue;
        if (t.subject === o && t.object !== s) add(s, p, t.object);
        if (t.object === s && t.subject !== o) add(t.subject, p, o);
      }
    }
  }
  return fresh;
}

// ── Versions ──────────────────────────────────────────────────────────────────────────────────

export interface ProfileVersion { readonly id: string; readonly generatedAtTime?: string; readonly wasRevisionOf: readonly string[] }

/** The versions a document lists, and the one the document itself is: the head of the revision chain. */
export function versionsOf(doc: Json): { versions: ProfileVersion[]; current: ProfileVersion } {
  if (!isObj(doc) || !isIri(doc.id)) throw new Error('A profile needs an "id" that is an IRI.');
  const versions = many(doc.versions).filter(isObj).filter(v => isIri(v.id)).map((v): ProfileVersion => ({
    id: v.id as string,
    ...(typeof v.generatedAtTime === 'string' ? { generatedAtTime: v.generatedAtTime } : {}),
    wasRevisionOf: many(v.wasRevisionOf).filter(isIri),
  }));
  if (versions.length === 0) throw new Error('A profile needs at least one entry in "versions", each with an "id".');
  const revised = new Set(versions.flatMap(v => v.wasRevisionOf));
  const heads = versions.filter(v => !revised.has(v.id));
  const pool = heads.length > 0 ? heads : versions;
  const current = [...pool].sort((a, b) => (Date.parse(b.generatedAtTime ?? '') || 0) - (Date.parse(a.generatedAtTime ?? '') || 0))[0]!;
  return { versions, current };
}

// ── Terms on the way out ──────────────────────────────────────────────────────────────────────

export interface RdfTerm { type: 'uri' | 'bnode' | 'literal'; value: string; 'xml:lang'?: string; datatype?: string }

/** A stored term as the SPARQL 1.1 JSON results format writes it. */
export function toRdfTerm(stored: string): RdfTerm {
  if (stored.startsWith('_:')) return { type: 'bnode', value: stored.slice(2) };
  if (!stored.startsWith('"')) return { type: 'uri', value: stored };
  const close = stored.lastIndexOf('"');
  const value = stored.slice(1, close), tail = stored.slice(close + 1);
  if (tail.startsWith('@')) return { type: 'literal', value, 'xml:lang': tail.slice(1) };
  if (tail.startsWith('^^')) return { type: 'literal', value, datatype: tail.slice(2).replace(/^<|>$/g, '') };
  return { type: 'literal', value };
}
