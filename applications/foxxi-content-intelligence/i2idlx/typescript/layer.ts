/** Native semantic generation over the pinned I2IDL and Foxxi snapshots. */
import { turtleIriRef } from '@interego/core';
import { createHash } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { isAbsolute, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import * as semantic from './semantic.js';
import type { Category } from './semantic.js';
import { parseTurtle, union } from './rdf.js';

export const I2IDL = 'https://id.i2idl.org/concepts/';
export const BFO_BEARER_OF = 'obo:BFO_0000196';
export const BFO_ROLE = 'obo:BFO_0000023';
export const TBOX_FILES = [
  'xapi-ontology.ttl', 'xapi-profile-ontology.ttl', 'iep.ttl',
  'interego-interego.ttl', 'interego-hypragent.ttl', 'interego-hyprcat.ttl', 'interego-harness.ttl',
] as const;
export type MappingRow = readonly [concept: string, predicate: string, target: string, ...details: unknown[]];
export interface Concept {
  readonly iri: string;
  readonly type: string;
}
export type Assignment = readonly [category: string, why: string, basis: 'definition' | 'type'];
export type ClassBridge = readonly [target: string, predicate: string, concept: string, row: MappingRow];
export interface FoxxiNamespaces {
  readonly version: string;
  readonly base: string;
  readonly archive: string;
  readonly modules: readonly string[];
  readonly sha256: Readonly<Record<string, string>>;
  readonly files: Readonly<Record<string, string>>;
  readonly iris: Readonly<Record<string, string>>;
  readonly ns: Readonly<Record<string, string>>;
}
interface FoxxiConfig {
  version: string;
  base: string;
  archive: string;
  modules: string[];
  sha256: Record<string, string>;
}

/** Resolve the immutable release archive, including a caller-provided mirror. */
export function foxxi_ns(root: string): FoxxiNamespaces {
  const cfg = (JSON.parse(readFileSync(join(root, 'config.json'), 'utf8')) as { foxxiNs: FoxxiConfig }).foxxiNs;
  const configured = process.env.FOXXI_NS_ARCHIVE || cfg.archive;
  const archive = isAbsolute(configured) ? configured : resolve(root, configured);
  return {
    version: cfg.version, base: cfg.base, archive, modules: [...cfg.modules], sha256: { ...cfg.sha256 },
    files: Object.fromEntries(cfg.modules.map(m => [m, join(archive, m, cfg.version + '.ttl')])),
    iris: Object.fromEntries(cfg.modules.map(m => [m, cfg.base + '/' + m + '/' + cfg.version])),
    ns: Object.fromEntries(cfg.modules.map(m => [m, cfg.base + '/' + m + '#'])),
  };
}
function iriRef(value: unknown): string {
  const ref = turtleIriRef(value);
  if (ref === null) throw new Error('invalid Turtle IRI: ' + String(value));
  return ref;
}
export function load_semantic(_root?: string): typeof semantic { return semantic; }
export function lit(s: string): string {
  return '"' + s.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n') + '"';
}

export class Layer {
  readonly sem = semantic;
  readonly cat: Readonly<Record<string, Category>>;
  readonly prefixes: Readonly<Record<string, string>>;

  constructor(
    readonly root: string,
    readonly ns: string,
    readonly iri: Readonly<Record<string, string>>,
    readonly concepts: Readonly<Record<string, Concept>>,
    readonly mappings: readonly MappingRow[],
    readonly release: string,
    readonly commit: string,
  ) {
    this.cat = semantic.CAT_BY_ID;
    this.prefixes = { ...semantic.PREFIXES, i2x: ns, i2idl: I2IDL };
  }

  expand(curie: string): string {
    if (curie.startsWith('http')) return curie;
    const colon = curie.indexOf(':');
    const prefix = curie.slice(0, colon);
    if (colon < 0 || !(prefix in this.prefixes)) throw new Error('no prefix for ' + curie);
    return this.prefixes[prefix]! + curie.slice(colon + 1);
  }

  /** Preserve Turtle-safe CURIEs and emit explicit IRIs for every other local name. */
  qn(term: string): string {
    if (term.startsWith('http')) return iriRef(term);
    const colon = term.indexOf(':'), pfx = term.slice(0, colon), local = term.slice(colon + 1);
    if (colon < 0 || !(pfx in this.prefixes)) throw new Error('no prefix for ' + term);
    if ((local.length > 0 && /^[\p{L}\p{N}_-]+$/u.test(local) && !/^\p{N}/u.test(local)) || pfx === 'obo') return term;
    return iriRef(this.expand(term));
  }

  ancestors(cid: string): string[] {
    const initial = this.cat[cid];
    if (!initial) throw new Error('unknown category ' + cid);
    const out: string[] = [], visited = new Set([cid]);
    let cur = initial.broader;
    while (cur) {
      if (visited.has(cur)) throw new Error('cyclic category ancestry at ' + cur);
      visited.add(cur);
      const category = this.cat[cur];
      if (!category) throw new Error('unknown parent category ' + cur);
      out.push(cur);
      cur = category.broader;
    }
    return out;
  }

  referent_classes(cid: string, inherited = true): string[] {
    const category = this.cat[cid];
    if (!category) throw new Error('unknown category ' + cid);
    const out = [...(category.referent || [])];
    if (inherited) for (const a of this.ancestors(cid)) {
      for (const c of this.cat[a]!.referent || []) if (!out.includes(c)) out.push(c);
    }
    return out;
  }

  concept_classes(cid: string): string[] {
    const category = this.cat[cid];
    if (!category) throw new Error('unknown category ' + cid);
    const out = [...(category.concept || [])];
    for (const a of this.ancestors(cid)) {
      for (const c of this.cat[a]!.concept || []) if (!out.includes(c)) out.push(c);
    }
    return out;
  }

  assignments(): Record<string, Assignment> {
    const out: Record<string, Assignment> = {};
    for (const cid of Object.keys(this.concepts).sort()) {
      const c = this.concepts[cid]!, override = this.sem.CONCEPT_CATEGORY[cid];
      if (override) out[cid] = [override[0], override[1], 'definition'];
      else if (c.type in this.sem.TYPE_DEFAULT) {
        out[cid] = [this.sem.TYPE_DEFAULT[c.type]!, this.sem.TYPE_DEFAULT_WHY[c.type]!, 'type'];
      } else throw new Error(cid + ': no referent category (type ' + c.type + ')');
    }
    return out;
  }

  class_bridges(classTargets: ReadonlySet<string>): ClassBridge[] {
    const out: ClassBridge[] = [];
    for (const row of this.mappings) {
      const [cid, pred, target] = row;
      if (!classTargets.has(target) || pred === 'closeMatch' || pred === 'relatedMatch') continue;
      out.push([target, pred, cid, row]);
    }
    return out;
  }

  referentClasses(cid: string, inherited = true): string[] { return this.referent_classes(cid, inherited); }
  conceptClasses(cid: string): string[] { return this.concept_classes(cid); }
  classBridges(classTargets: ReadonlySet<string>): ClassBridge[] { return this.class_bridges(classTargets); }

  ontology_section(): string {
    const lines: string[] = [];
    const tops = this.sem.CATEGORIES.filter(c => !c.broader).map(c => c.id);
    lines.push('i2x:ReferentCategories skos:hasTopConcept ' + tops.map(t => 'i2x:category-' + t).join(' , ') + ' .');
    for (const c of this.sem.CATEGORIES) {
      const place = c.broader ? 'skos:broader i2x:category-' + c.broader : 'skos:topConceptOf i2x:ReferentCategories';
      const parent = c.broader ? 'i2x:' + this.cat[c.broader]!.cls : 'i2x:Referent';
      lines.push(
        'i2x:category-' + c.id + ' a skos:Concept ; skos:inScheme i2x:ReferentCategories ; ' + place + ' ;\n' +
        '    skos:notation ' + lit(c.id) + ' ; skos:prefLabel ' + lit(c.label) + '@en ;\n' +
        '    skos:definition ' + lit(c.definition) + '@en ;\n' +
        '    i2x:referentClass i2x:' + c.cls + ' ; i2x:classificationMode ' + lit(c.mode || 'classify') + ' .');
      lines.push(
        'i2x:' + c.cls + ' a owl:Class ; rdfs:subClassOf ' + parent + ' ;\n' +
        '    rdfs:label ' + lit(c.label + ' (referent)') + '@en ;\n' +
        '    rdfs:comment ' + lit('Anything an I2IDL concept in the referent category “' + c.label + '” classifies.') + '@en .');
      lines.push(
        '[ a owl:Restriction ; owl:onProperty i2x:isClassifiedBy ;\n' +
        '  owl:someValuesFrom [ a owl:Restriction ; owl:onProperty i2x:referentCategory ; owl:hasValue i2x:category-' + c.id + ' ] ]\n' +
        '    rdfs:subClassOf i2x:' + c.cls + ' .');
    }
    return lines.join('\n');
  }

  alignments_ttl(now: string, classTargets: ReadonlySet<string>, mappingIri: string): string {
    const S = this.sem;
    const out = [this._prefixes(), '',
      '# ══════════════════════════════════════════════════════════════════════════════',
      "#  I2IDL-X alignments — the semantic layer's TBox bridges. Each referent category,",
      '#  each kind of I2IDL record, and the Interego and Foxxi vocabularies are aligned to',
      '#  BFO 2020 (with IAO and CCO), gist, DOLCE-UltraLite, gUFO, PROV-O, schema.org and',
      '#  peer learning vocabularies. Proposals: published Hypothetical; a reasoner using',
      '#  them reaches Hypothetical conclusions. Rationale is on each subject.',
      '# ══════════════════════════════════════════════════════════════════════════════', '',
      iriRef(this.iri.alignments) + ' a owl:Ontology ;',
      '    dct:title ' + lit('I2IDL-X alignments to upper ontologies and peer vocabularies') + '@en ;',
      '    dct:description ' + lit('Bridge axioms that let any data classified by I2IDL concepts be typed in BFO 2020 (IAO, CCO), gist, DOLCE-UltraLite, gUFO, PROV-O and schema.org, and line I2IDL, I2IDL-X, Interego and Foxxi up with CTDL, CTDL-ASN, ESCO, ELM, LRMI, ASN, Open Badges, CASE and xAPI.') + '@en ;',
      '    dct:conformsTo ' + iriRef(this.iri.shapes) + ' ;',
      '    owl:imports ' + iriRef(this.iri.ontology) + ' ;',
      '    prov:wasDerivedFrom ' + iriRef(this.iri.ontology) + ' , ' + iriRef(mappingIri) + ' ;',
      '    prov:generatedAtTime "' + now + '"^^xsd:dateTime ;',
      '    rdfs:seeAlso ' + iriRef(this.iri.referents) + ' ;',
      '    rdfs:comment ' + lit('Upper ontologies and peer vocabularies are referenced, not copied: each term was checked against a pinned snapshot of its publisher’s file. Reasoning over these axioms (OWL 2 RL or a DL reasoner) types I2IDL’s records and any data that uses i2x:isClassifiedBy.') + '@en .', ''];
    out.push('# ── Referent categories → upper ontologies and peers ─────────────────────────────');
    for (const c of S.CATEGORIES) {
      const own = c.referent || [], parts: string[] = [];
      if (own.length) parts.push('rdfs:subClassOf ' + own.map(t => this.qn(t)).join(' , '));
      if (c.bearsRole) parts.push('rdfs:subClassOf [ a owl:Restriction ; owl:onProperty ' + BFO_BEARER_OF + ' ; owl:someValuesFrom ' + BFO_ROLE + ' ]');
      if (parts.length) out.push('i2x:' + c.cls + ' ' + parts.join(' ;\n    ') + ' .');
      const notes = ['i2x:alignmentRationale ' + lit(c.why) + '@en'];
      if (c.expressible?.length) notes.push('i2x:expressibleAs ' + c.expressible.map(t => this.qn(t)).join(' , '));
      out.push('i2x:category-' + c.id + ' ' + notes.join(' ;\n    ') + ' .');
      const classes = this.concept_classes(c.id);
      if (classes.length) out.push('[ a owl:Restriction ; owl:onProperty i2x:referentCategory ; owl:hasValue i2x:category-' + c.id + ' ]\n' +
        '    rdfs:subClassOf ' + classes.map(t => this.qn(t)).join(' , ') + ' .');
    }
    out.push('', "# ── What I2IDL's records are ──────────────────────────────────────────────────────");
    for (const [subj, targets, why] of S.RECORDS) out.push(this.qn(subj) + ' rdfs:subClassOf ' + targets.map(t => this.qn(t)).join(' , ') + ' ;\n' +
      '    i2x:alignmentRationale ' + lit(why) + '@en .');
    out.push('', '# ── Classification and aboutness relations ─────────────────────────────────────────');
    for (const [subj, pred, obj, why] of S.PROPERTIES) out.push(this.qn(subj) + ' ' + pred + ' ' + this.qn(obj) + ' .  # ' + why);
    out.push('', '# ── Interego ───────────────────────────────────────────────────────────────────────');
    for (const [subj, targets, why] of S.INTEREGO) out.push(this.qn(subj) + ' rdfs:subClassOf ' + targets.map(t => this.qn(t)).join(' , ') + ' ;\n' +
      '    i2x:alignmentRationale ' + lit(why) + '@en .');
    out.push('', '# ── Foxxi (IEEE LER and ADL TLA vocabularies on the Foxxi bridge) ───────────────────');
    for (const [subj, targets, why, peers] of S.FOXXI) {
      let body = this.qn(subj) + ' rdfs:subClassOf ' + targets.map(t => this.qn(t)).join(' , ');
      if (peers.length) body += ' ;\n    skos:closeMatch ' + peers.map(p => this.qn(p)).join(' , ');
      out.push(body + ' ;\n    i2x:alignmentRationale ' + lit(why) + '@en .');
    }
    out.push('', '# ── Crosswalk proposals made executable ───────────────────────────────────────────');
    out.push('#  A proposal that maps an I2IDL concept to a *class* becomes an OWL bridge through');
    out.push('#  i2x:isClassifiedBy: exactMatch ≡, broadMatch (class is broader) ⊒, narrowMatch');
    out.push('#  (class is narrower) ⊑. closeMatch and relatedMatch stay SKOS: they license no typing.');
    for (const [target, pred, cid] of this.class_bridges(classTargets)) {
      const restr = '[ a owl:Restriction ; owl:onProperty i2x:isClassifiedBy ; owl:hasValue i2idl:' + cid + ' ]';
      if (pred === 'exactMatch') out.push(this.qn(target) + ' owl:equivalentClass ' + restr + ' .');
      else if (pred === 'narrowMatch') out.push(this.qn(target) + ' rdfs:subClassOf ' + restr + ' .');
      else if (pred === 'broadMatch') out.push(restr + ' rdfs:subClassOf ' + this.qn(target) + ' .');
    }
    return out.join('\n') + '\n';
  }

  referents_ttl(now: string): string {
    const S = this.sem, assign = this.assignments(), counts: Record<string, number> = {};
    for (const [cat] of Object.values(assign)) counts[cat] = (counts[cat] || 0) + 1;
    const countText = Object.entries(counts).sort((a, b) => b[1] - a[1]).map(([k, v]) => this.cat[k]!.label + ' ' + v).join(', ');
    const out = [this._prefixes(), '',
      '# ══════════════════════════════════════════════════════════════════════════════',
      '#  I2IDL-X referents — what each I2IDL ' + this.release + ' concept classifies. One',
      '#  referent category per concept (see i2x:ReferentCategories); the reason is either',
      "#  I2IDL's own type collection or the concept's definition. Proposals: published",
      '#  Hypothetical, reviewable one by one.',
      '# ══════════════════════════════════════════════════════════════════════════════', '',
      iriRef(this.iri.referents) + ' a owl:Ontology ;',
      '    dct:title ' + lit('What I2IDL concepts classify (derived and proposed)') + '@en ;',
      '    dct:description ' + lit('The referent category of every concept in I2IDL ' + this.release + ', so data classified by an I2IDL concept can be typed in upper ontologies and peer vocabularies through i2idlx-alignments.') + '@en ;',
      '    dct:conformsTo ' + iriRef(this.iri.shapes) + ' ;',
      '    owl:imports ' + iriRef(this.iri.alignments) + ' ;',
      '    i2x:builtAgainstRelease ' + lit(this.release) + ' ;',
      '    prov:wasDerivedFrom ' + iriRef('https://github.com/blakeplock/i2idl-linked-data/blob/' + this.commit + '/public/glossary.jsonld') + ' ;',
      '    prov:generatedAtTime "' + now + '"^^xsd:dateTime ;',
      '    rdfs:comment ' + lit('Category counts: ' + countText + '.') + '@en .', ''];
    out.push('# ── I2IDL classifying the services that publish it ─────────────────────────────────');
    for (const [iri, types, classifiedBy, why] of S.INDIVIDUALS) {
      const parts: string[] = [];
      if (types.length) parts.push('a ' + types.map(t => this.qn(t)).join(' , '));
      parts.push('i2x:isClassifiedBy ' + classifiedBy.map(c => 'i2idl:' + c).join(' , '));
      parts.push('rdfs:comment ' + lit(why) + '@en');
      out.push(iriRef(iri) + ' ' + parts.join(' ;\n    ') + ' .');
    }
    out.push('', '# ── Referent category of every concept ─────────────────────────────────────────────');
    for (const [cid, [cat, why, basis]] of Object.entries(assign)) out.push('i2idl:' + cid + ' i2x:referentCategory i2x:category-' + cat +
      ' ; i2x:categoryRationale ' + lit(why) + '@en ; i2x:assignmentBasis ' + lit(basis) + ' .');
    return out.join('\n') + '\n';
  }

  _prefixes(): string {
    const keep = ['i2x', 'i2idl', 'obo', 'cco', 'gist', 'dul', 'gufo', 'prov', 'schema', 'org', 'dct', 'dcat', 'lrmi', 'asn',
      'esco', 'elm', 'ceterms', 'ceasn', 'ob3', 'case', 'cred', 'xapi', 'xprof', 'ler', 'tla',
      'foxxi-xapi', 'foxxi-scorm-cam', 'foxxi-scorm-rte', 'foxxi-cmi5', 'iep', 'ie', 'ieh',
      'hyprcat', 'hypragent', 'skos', 'gs'];
    const rows = keep.map(p => '@prefix ' + (p + ':').padEnd(11) + iriRef(this.prefixes[p]) + ' .');
    rows.push('@prefix owl:       <http://www.w3.org/2002/07/owl#> .',
      '@prefix rdfs:      <http://www.w3.org/2000/01/rdf-schema#> .',
      '@prefix xsd:       <http://www.w3.org/2001/XMLSchema#> .');
    return rows.join('\n');
  }
}

/** Load only local snapshots. The immutable Foxxi archive is verified before parsing. */
export function tbox(root: string): ReturnType<typeof parseTurtle> {
  const upper = join(root, 'evidence', 'upper');
  const files = readdirSync(upper).filter(f => f.endsWith('.ttl')).sort().map(f => join(upper, f));
  files.push(...TBOX_FILES.map(f => join(root, 'evidence', f)));
  const foxxi = foxxi_ns(root);
  for (const module of foxxi.modules) {
    const path = foxxi.files[module]!, raw = readFileSync(path);
    const actual = createHash('sha256').update(raw).digest('hex');
    if (actual !== foxxi.sha256[module]) throw new Error(path + ' has SHA-256 ' + actual + ', not the pinned ' + foxxi.sha256[module]);
    files.push(path);
  }
  return union(...files.map(path => parseTurtle(readFileSync(path, 'utf8'), pathToFileURL(resolve(path)).href)));
}

export function snapshot_terms(root: string): Set<string> {
  const terms = new Set<string>();
  for (const q of tbox(root).getQuads(null, null, null, null)) if (q.subject.termType === 'NamedNode') terms.add(q.subject.value);
  const peers = JSON.parse(readFileSync(join(root, 'evidence', 'peer-terms.json'), 'utf8')) as { terms: Record<string, unknown> | string[] };
  for (const iri of Array.isArray(peers.terms) ? peers.terms : Object.keys(peers.terms)) terms.add(iri);
  return terms;
}

export const foxxiNs = foxxi_ns;
export const snapshotTerms = snapshot_terms;
