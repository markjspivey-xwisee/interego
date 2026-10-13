/**
 * ns/sssom.ts — a Foxxi ontology's mappings to other vocabularies, as an SSSOM mapping set.
 *
 * ★ WHY. Each ontology records its alignments as SKOS mapping triples (a skos:exactMatch to ADL's
 * xAPI ontology, a skos:closeMatch to CaSS, …) — the right form for a reasoner, an annotation and
 * never an equivalence axiom. A mapping reviewer reads them differently: as a table, one mapping a
 * row, saying what kind of entity sits on each side and on what justification the mapping was
 * made. SSSOM (the Simple Standard for Sharing Ontological Mappings, version 1.0) is that table, and
 * the form mapping registries and tools (sssom-py, SSSOM-Java, OxO) read.
 *
 * ★ GENERATED FROM THE GRAPH, SO THE TWO CANNOT DISAGREE. Every SKOS mapping triple whose subject
 * the document mints is one row, and nothing else is: no row is written by hand. A note on a
 * mapping (an owl:Axiom annotation on the mapping triple) becomes that row's comment.
 *
 * ★ A GAP IS LISTED AS A GAP. A document aligned term by term to one counterpart ontology (Foxxi's
 * xAPI ontology to ADL's) accounts for every term: each term with no mapping into the counterpart
 * is a row mapped to sssom:NoTermFound, with the counterpart as its object_source — so a missing
 * mapping reads as a term the counterpart lacks, not as one nobody looked for.
 *
 * ★ ONLY WHAT IS ON RECORD. A target's label and entity type are given when they come from its
 * publisher's own record: Foxxi's documents for Foxxi terms, and the transcribed records of the
 * ontologies Foxxi is checked against. Otherwise the cells are empty rather than guessed.
 *
 * Conforms to SSSOM 1.0 (sssom-schema 1.0.0): SSSOM/TSV with the metadata block embedded as
 * commented YAML; every entity reference a CURIE whose prefix the curie_map declares (the built-in
 * prefixes owl, rdf, rdfs, skos, semapv and sssom are not redeclared).
 */
import { type Graph, type Prefixes, iri, RDF, RDFS, OWL, SKOS } from './rdf.js';
import { type DocMeta, CREATOR, LICENSE, noticeOf, versionIri } from './catalog.js';

/** The SSSOM version these sets conform to. */
export const SSSOM_VERSION = '1.0';
/** The media type of SSSOM/TSV. */
export const SSSOM_MEDIA_TYPE = 'text/tab-separated-values';
/** Where a document's mapping set is published. */
export const mappingSetIri = (docIri: string): string => `${docIri}/mappings`;

/** The entity types SSSOM 1.0 names (its entity_type_enum) that Foxxi's mappings use. */
export type SssomEntityType =
  | 'owl class' | 'owl object property' | 'owl data property' | 'owl annotation property'
  | 'owl named individual' | 'skos concept' | 'rdfs datatype';

/** What is on record about a mapping target. */
export interface MappingTargetInfo { readonly label?: string; readonly type?: SssomEntityType }

/** One row of a mapping set, by SSSOM slot name. */
export interface SssomRow {
  readonly subject_id: string;
  readonly subject_label?: string;
  readonly predicate_id: string;
  readonly object_id: string;
  readonly object_label?: string;
  readonly mapping_justification: string;
  readonly subject_type?: SssomEntityType;
  readonly object_type?: SssomEntityType;
  readonly object_source?: string;
  readonly comment?: string;
}

/** The columns written, in the order the SSSOM schema lists the slots. */
export const SSSOM_COLUMNS = [
  'subject_id', 'subject_label', 'predicate_id', 'object_id', 'object_label', 'mapping_justification',
  'subject_type', 'object_type', 'object_source', 'comment',
] as const satisfies ReadonlyArray<keyof SssomRow>;

export interface MappingSetSource {
  /** The document the mappings are from. */
  readonly meta: DocMeta;
  /** Its graph. */
  readonly graph: Graph;
  /** Prefixes for every namespace a subject, object or source may be in. */
  readonly prefixes: Prefixes;
  /** What is on record about a target outside this document. */
  readonly lookup?: (iri: string) => MappingTargetInfo | undefined;
  /** The ontology this document is aligned to term by term (see the header). */
  readonly counterpart?: { readonly iri: string; readonly namespace: string };
}

const MAPPING_RELATIONS = ['exactMatch', 'closeMatch', 'broadMatch', 'narrowMatch', 'relatedMatch'] as const;
const BUILT_IN_PREFIXES: Prefixes = Object.freeze({
  owl: OWL, rdf: RDF, rdfs: RDFS, skos: SKOS, semapv: 'https://w3id.org/semapv/vocab/', sssom: 'https://w3id.org/sssom/',
});
/** Every mapping here was made by a person comparing the two terms' definitions. */
const MANUAL_CURATION = 'semapv:ManualMappingCuration';
const NO_TERM_FOUND = 'sssom:NoTermFound';

/** The SSSOM entity type of a term, from its declaration in `g`. */
export function entityTypeIn(g: Graph, term: string): SssomEntityType | undefined {
  const types = new Set(g.objects(iri(term), RDF + 'type').map(t => t.value));
  if (types.has(OWL + 'Class')) return 'owl class';
  if (types.has(OWL + 'ObjectProperty')) return 'owl object property';
  if (types.has(OWL + 'DatatypeProperty')) return 'owl data property';
  if (types.has(OWL + 'AnnotationProperty')) return 'owl annotation property';
  if (types.has(RDFS + 'Datatype')) return 'rdfs datatype';
  if (types.has(SKOS + 'Concept')) return 'skos concept';
  if (types.has(OWL + 'NamedIndividual')) return 'owl named individual';
  return undefined;
}

/** A term's label in `g`: its skos:prefLabel (the word a code list uses), else its rdfs:label. */
export function labelIn(g: Graph, term: string): string | undefined {
  for (const p of [SKOS + 'prefLabel', RDFS + 'label']) {
    const ls = g.objects(iri(term), p).filter(o => o.termType === 'Literal');
    const en = ls.find(l => l.termType === 'Literal' && (l.language === 'en' || !l.language));
    if (en) return en.value;
  }
  return undefined;
}

/** `prefix:local` for an IRI, by the longest namespace that holds it. Throws when none does: a
 *  mapping set whose identifiers its own curie_map cannot expand is not a mapping set. */
export function sssomCurie(value: string, prefixes: Prefixes): string {
  let best: [string, string] | null = null;
  for (const [p, ns] of Object.entries({ ...BUILT_IN_PREFIXES, ...prefixes })) {
    if (value.startsWith(ns) && value.length > ns.length && (!best || ns.length > best[1].length)) best = [p, ns];
  }
  const local = best ? value.slice(best[1].length) : '';
  if (!best || !/^[^\s|]+$/.test(local)) throw new Error(`no prefix declared for ${value}: add its namespace to the mapping-set prefixes`);
  const curie = `${best[0]}:${local}`;
  // The CURIE syntax the SSSOM toolkit reads (a prefix of [A-Za-z0-9_.], a local part that begins
  // with a letter, digit or underscore); anything else it takes for an unprefixed string.
  if (!/^[A-Za-z0-9_.]+:[A-Za-z0-9_]/.test(curie)) throw new Error(`${curie} is not a CURIE the SSSOM toolkit can read`);
  return curie;
}

/** The rows of the mapping set of `src`, in canonical order (subject, predicate, object). */
export function mappingRows(src: MappingSetSource): SssomRow[] {
  const g = src.graph;
  const ns = src.meta.ns;
  if (!ns) throw new Error(`${src.meta.iri} mints no terms, so it has no mappings of its own`);
  const curie = (v: string): string => sssomCurie(v, src.prefixes);
  // The notes on mappings: owl:Axiom annotations naming the mapping triple.
  const notes = new Map<string, string>();
  for (const ax of g.subjectsOfType(OWL + 'Axiom')) {
    const one = (p: string): string | undefined => g.objects(ax, p)[0]?.value;
    const [s, p, o] = [one(OWL + 'annotatedSource'), one(OWL + 'annotatedProperty'), one(OWL + 'annotatedTarget')];
    const c = g.objects(ax, RDFS + 'comment')[0];
    if (s && p && o && c) notes.set(`${s} ${p} ${o}`, c.value);
  }
  const rows: SssomRow[] = [];
  const mapped = new Set<string>();
  for (const t of g.triples) {
    const rel = MAPPING_RELATIONS.find(r => t.p.value === SKOS + r);
    if (!rel || t.s.termType !== 'NamedNode' || !t.s.value.startsWith(ns) || t.o.termType !== 'NamedNode') continue;
    const s = t.s.value, o = t.o.value;
    const target = src.lookup?.(o);
    const inCounterpart = src.counterpart && o.startsWith(src.counterpart.namespace);
    if (inCounterpart) mapped.add(s);
    rows.push(clean({
      subject_id: curie(s), subject_label: labelIn(g, s), predicate_id: `skos:${rel}`,
      object_id: curie(o), object_label: target?.label, mapping_justification: MANUAL_CURATION,
      subject_type: entityTypeIn(g, s), object_type: target?.type,
      object_source: inCounterpart ? curie(src.counterpart!.iri) : undefined,
      comment: notes.get(`${s} ${t.p.value} ${o}`),
    }));
  }
  if (src.counterpart) {
    // Every term the document declares — classes, properties, datatypes, code-list concepts — that
    // has no mapping into the counterpart. A concept scheme is a list, not a term to map.
    const declared = new Set<string>();
    for (const t of g.triples) {
      if (t.p.value === RDF + 'type' && t.s.termType === 'NamedNode' && t.s.value.startsWith(ns) && entityTypeIn(g, t.s.value)) declared.add(t.s.value);
    }
    for (const s of declared) {
      if (mapped.has(s)) continue;
      rows.push(clean({
        subject_id: curie(s), subject_label: labelIn(g, s), predicate_id: 'skos:exactMatch',
        object_id: NO_TERM_FOUND, mapping_justification: MANUAL_CURATION,
        subject_type: entityTypeIn(g, s), object_source: curie(src.counterpart.iri),
      }));
    }
  }
  const key = (r: SssomRow): string => `${r.subject_id}\u0000${r.predicate_id}\u0000${r.object_id}`;
  return rows.sort((a, b) => (key(a) < key(b) ? -1 : key(a) > key(b) ? 1 : 0));
}

/** Drop the slots with no value, so a row says only what is on record. */
function clean(r: Record<keyof SssomRow, string | undefined> | Partial<Record<keyof SssomRow, string | undefined>>): SssomRow {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(r)) if (v !== undefined && v !== '') out[k] = v;
  return out as unknown as SssomRow;
}

/** A YAML double-quoted scalar. */
const yamlString = (s: string): string => `"${s.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n')}"`;

/** A TSV cell: SSSOM/TSV has no quoting, so a value may not contain a tab or a line break. */
function cell(v: string | undefined, where: string): string {
  if (v === undefined) return '';
  if (/[\t\r\n]/.test(v)) throw new Error(`${where}: a tab or line break cannot be written in SSSOM/TSV`);
  return v;
}

/** The prefixes a set of rows (and its metadata) uses, sorted, built-ins left out. */
function usedPrefixes(rows: readonly SssomRow[], extra: readonly string[], prefixes: Prefixes): Record<string, string> {
  const used = new Set<string>();
  const note = (c: string | undefined): void => { if (c) used.add(c.slice(0, c.indexOf(':'))); };
  for (const r of rows) { note(r.subject_id); note(r.predicate_id); note(r.object_id); note(r.object_source); note(r.mapping_justification); }
  for (const e of extra) note(e);
  const out: Record<string, string> = {};
  for (const p of [...used].sort()) {
    if (p in BUILT_IN_PREFIXES) continue;
    const ns = prefixes[p];
    if (!ns) throw new Error(`prefix ${p} is used but not declared`);
    out[p] = ns;
  }
  return out;
}

/** The mapping set of `src`, as SSSOM/TSV with its metadata embedded. */
export function renderSssomTsv(src: MappingSetSource): string {
  const meta = src.meta;
  const rows = mappingRows(src);
  const subjectSource = sssomCurie(meta.iri, src.prefixes);
  const curieMap = usedPrefixes(rows, [subjectSource], src.prefixes);
  const gaps = rows.filter(r => r.object_id === NO_TERM_FOUND).length;
  const description = `Mappings from the terms of ${meta.title} (${meta.iri}) to other vocabularies: one row for each SKOS mapping the ontology makes, generated from it.`
    + (src.counterpart ? ` The ontology is aligned term by term to ${src.counterpart.iri}; each of its ${gaps} terms with no counterpart there is listed as mapped to sssom:NoTermFound.` : '');
  const md: string[] = ['curie_map:'];
  for (const [p, ns] of Object.entries(curieMap)) md.push(`  ${p}: ${yamlString(ns)}`);
  md.push(
    `mapping_set_id: ${yamlString(mappingSetIri(meta.iri))}`,
    `mapping_set_version: ${yamlString(meta.version)}`,
    `mapping_set_title: ${yamlString(`${meta.title} — mappings`)}`,
    `mapping_set_description: ${yamlString(description)}`,
    'creator_label:',
    `  - ${yamlString(CREATOR)}`,
    `license: ${yamlString(LICENSE)}`,
    `subject_source: ${yamlString(subjectSource)}`,
    `subject_source_version: ${yamlString(versionIri(meta))}`,
    `mapping_provider: ${yamlString(meta.iri)}`,
    `publication_date: ${meta.issued}`,
    `comment: ${yamlString(noticeOf(meta))}`,
  );
  const lines = md.map(l => `#${l}`);
  lines.push(SSSOM_COLUMNS.join('\t'));
  for (const r of rows) lines.push(SSSOM_COLUMNS.map(c => cell(r[c], `${r.subject_id} ${c}`)).join('\t'));
  return `${lines.join('\n')}\n`;
}

/** Whether a graph makes any mapping from the terms in namespace `ns`. */
export function hasMappings(g: Graph, ns: string): boolean {
  return g.triples.some(t => t.s.termType === 'NamedNode' && t.s.value.startsWith(ns)
    && MAPPING_RELATIONS.some(r => t.p.value === SKOS + r));
}
