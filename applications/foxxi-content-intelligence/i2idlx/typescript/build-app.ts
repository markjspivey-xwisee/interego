/**
 * Native Interpretant build. Reads committed upstream JSON-LD and the published RDF
 * decorations, never the clone working tree. No network and no Python at runtime.
 * The Python builder remains an independent parity oracle until the migration gate passes.
 */
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { resolve, join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { loadConfig } from './config.js';
import * as hist from './history.js';
import * as SEMM from './semantic.js';
import { safeIri } from './rdf.js';
import { cw } from './generate.js';

// JSON input is verified at the projection boundary; its values may be heterogeneous.
type Value = ReturnType<typeof JSON.parse>;
type Row = Record<string, Value>;
type Term = { value: string; termType: string; language?: string; datatype?: { value: string } };
const requireApp = createRequire(new URL('../app/package.json', import.meta.url));
const { Parser, Store, DataFactory } = requireApp('n3');
const nn = (s: string): Term => DataFactory.namedNode(s);
const node = (s: string | Term | null): Term | null => typeof s === 'string' ? nn(s) : s;
const str = (v: Term | null | undefined): string => v == null ? 'None' : v.datatype?.value === 'http://www.w3.org/2001/XMLSchema#dateTime' ? v.value.replace(/Z$/, '+00:00') : v.value;
const clean = (v: unknown): string | null => v == null ? null : String(v).trim().replace(/\s+/gu, ' ');
const aslist = <T>(v: T | T[] | null | undefined): T[] => v == null ? [] : Array.isArray(v) ? v : [v];
const ids = (v: Value): string[] => aslist(v).map((x: Value) => typeof x === 'object' ? x['@id'] : x);
const local = (iri: string, root: string): string => {
  if (!iri.startsWith(root)) throw new Error('IRI outside expected namespace: ' + iri + ' / ' + root);
  return iri.slice(root.length);
};
const sort = <T>(v: T[]): T[] => v.sort();
const uniq = <T>(v: T[]): T[] => [...new Set(v)];
const get = (r: Row, key: string): Value => r[key] ?? null;
const countBy = (rows: Row[], key: string): Row => {
  const out: Row = {};
  for (const r of rows) out[r[key]] = (out[r[key]] || 0) + 1;
  return out;
};
const mapEntries = (m: Value): [string, Value][] => m instanceof Map ? [...m.entries()] : Object.entries(m);
const mapKeys = (m: Value): string[] => m instanceof Map ? [...m.keys()] : Object.keys(m);
const pythonQuote = (v: string): string => encodeURIComponent(v).replace(/[!'()*]/g, c => '%' + c.charCodeAt(0).toString(16).toUpperCase());
const expand = (curie: string, pfx: Row): string => { const at = curie.indexOf(':'); return pfx[curie.slice(0, at)] + curie.slice(at + 1); };
const scalar = (t: Term): unknown => {
  if (t.termType !== 'Literal') return t.value;
  const d = t.datatype?.value || '';
  if (d.endsWith('#boolean')) return t.value === 'true' || t.value === '1';
  if (/#(?:integer|int|decimal|double|float|nonNegativeInteger|positiveInteger|long)$/u.test(d)) return Number(t.value);
  return t.value;
};
class Graph {
  readonly store: Value;
  readonly source: string;
  constructor(source: string, format = 'text/turtle') { this.source = source; this.store = new Store(new Parser({ format }).parse(source)); }
  get size(): number { return this.store.size; }
  objects(s: string | Term | null, p: string | Term): Term[] { return uniq<Term>(this.store.getQuads(node(s), node(p), null, null).map((q: Value) => q.object)); }
  subjects(p: string | Term, o: string | Term | null): Term[] {
    const terms: Term[] = this.store.getQuads(null, node(p), node(o), null).map((q: Value) => q.subject);
    const seen = new Set<string>(); return terms.filter(t => !seen.has(t.termType + ':' + t.value) && !!seen.add(t.termType + ':' + t.value));
  }
  pairs(p: string | Term): [Term, Term][] { return this.store.getQuads(null, node(p), null, null).map((q: Value) => [q.subject, q.object]); }
  predicateObjects(s: string | Term): [Term, Term][] { return this.store.getQuads(node(s), null, null, null).map((q: Value) => [q.predicate, q.object]); }
  value(s: string | Term, p: string | Term): Term | null { return this.objects(s, p)[0] || null; }
  text(s: string | Term, ...ps: string[]): string | null {
    for (const p of ps) {
      const vals = this.objects(s, p);
      if (vals.length) return clean((vals.find(v => v.termType === 'Literal' && (!v.language || v.language === 'en')) || vals[0])!.value);
    }
    return null;
  }
  bool(s: string | Term, p: string): boolean { const t = this.value(s, p); return !!t && t.termType === 'Literal' && (t.value === 'true' || t.value === '1'); }
}
const RDF = 'http://www.w3.org/1999/02/22-rdf-syntax-ns#';
const RDFS = 'http://www.w3.org/2000/01/rdf-schema#';
const OWL = 'http://www.w3.org/2002/07/owl#';
const SKOS = 'http://www.w3.org/2004/02/skos/core#';
const IEP = 'https://markjspivey-xwisee.github.io/interego/ns/iep#';
const IE = 'https://markjspivey-xwisee.github.io/interego/ns/interego#';
const HYDRA = 'http://www.w3.org/ns/hydra/core#';
const DCAT = 'http://www.w3.org/ns/dcat#';
const PROV = 'http://www.w3.org/ns/prov#';
const DCT = 'http://purl.org/dc/terms/';
const SH = 'http://www.w3.org/ns/shacl#';
const ACTION_ROOT = 'https://relay.interego.xwisee.com/ns/iep/action/';
const I2IDL = 'https://id.i2idl.org/';
const CONCEPTS = I2IDL + 'concepts/';
const ENDPOINT = 'https://id.i2idl.org/sparql';
const KIND_ORDER = ['NotionConcept', 'EnactableConcept', 'SystemConcept', 'StandardConcept', 'DomainConcept', 'FrameworkConcept', 'ActorConcept', 'NormativeConcept'];
const ROLE_ORDER = ['operationalizes', 'realizes', 'implements', 'measures', 'records', 'credentials', 'enforces', 'explains'];
const QORDER = ['What', 'Why', 'WhatKind', 'Where', 'Whose', 'How', 'HowMuch', 'Whether'];
const VOCABS: [string, string][] = [
  ['http://vocabularies.unesco.org/thesaurus/', 'UNESCO Thesaurus'],
  ['https://foxxi-bridge.interego.xwisee.com/ns/xapi#', 'xAPI (Foxxi)'],
  ['https://foxxi-bridge.interego.xwisee.com/ns/scorm-cam#', 'SCORM CAM (Foxxi)'],
  ['https://foxxi-bridge.interego.xwisee.com/ns/scorm-rte#', 'SCORM RTE (Foxxi)'],
  ['https://foxxi-bridge.interego.xwisee.com/ns/cmi5#', 'cmi5 (Foxxi)'],
  ['https://w3id.org/xapi/profiles/ontology#', 'xAPI Profiles'],
  ['https://w3id.org/xapi/ontology#', 'xAPI (ADL)'],
  ['https://foxxi-bridge.interego.xwisee.com/ns/ieee-ler#', 'IEEE LER'],
  ['https://foxxi-bridge.interego.xwisee.com/ns/adl-tla#', 'ADL TLA'],
  ['https://schema.org/', 'schema.org'],
  ['https://www.w3.org/2018/credentials#', 'W3C VC'],
  ['https://markjspivey-xwisee.github.io/interego/ns/', 'Interego'],
];
function rightsClass(r: string): string {
  const u = r.toUpperCase();
  if (u.split('-').includes('NC') || u.includes('-NC')) return 'nc';
  if (u.includes('PERMISSION') || u.includes('TERMS APPLY')) return 'permission';
  if (u.replace(/-/g, ' ').split(/\s+/u).includes('SA')) return 'sharealike';
  return 'open';
}
function surfaceForms(c: Row): [string, boolean][] {
  const strong = (s: string): boolean => s.trim().split(/\s+/u).length > 1 || /[A-Z].*[A-Z]|[0-9]/u.test(s);
  const out: [string, boolean][] = [[c.l, strong(c.l)]];
  const m = /^(.*?)\s*\(([^)]+)\)$/u.exec(c.l);
  if (m) { out.push([m[1]!, m[1]!.trim().split(/\s+/u).length > 1]); out.push([m[2]!, /[A-Z].*[A-Z]|[0-9]/u.test(m[2]!)]); }
  for (const a of c.a) {
    const acronym = /^[A-Za-z0-9-]*[A-Z][A-Za-z0-9-]*[A-Z0-9][A-Za-z0-9-]*$/u.test(a) && a.length >= 2;
    out.push([a, a.trim().split(/\s+/u).length > 1 || acronym]);
  }
  const seen = new Set<string>();
  return out.filter(([form]) => form.length >= 2 && !seen.has(form.toLowerCase()) && !!seen.add(form.toLowerCase()));
}
function mentions(concepts: Row[], cidx: Row): { suggestions: Row[]; forms: Value[]; links: number } {
  const claims: Record<string, [string, boolean, boolean][]> = {};
  for (const c of concepts) {
    const labels = new Set(surfaceForms({ l: c.l, a: [] }).map(([f]) => f.toLowerCase()));
    for (const [form, strong] of surfaceForms(c)) (claims[form.toLowerCase()] ||= []).push([c.id, strong, labels.has(form.toLowerCase())]);
  }
  const forms: { pattern: RegExp; form: string; target: string; strong: boolean; sensitive: boolean }[] = [];
  for (const c of concepts) for (const [form, strong] of surfaceForms(c)) {
    const owners = claims[form.toLowerCase()]!;
    if (owners.length > 1) {
      const labels = owners.filter(o => o[2]).sort((a, b) => concepts[cidx[a[0]]]!.l.length - concepts[cidx[b[0]]]!.l.length || (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
      if (!labels.length || labels[0]![0] !== c.id) continue;
    }
    const sensitive = /[A-Z].*[A-Z]/u.test(form) && form.length <= 6;
    const escaped = form.replace(/[.*+?^$()\[\]{}|\\]/g, '\\$&');
    forms.push({ pattern: new RegExp('(?<![\\p{L}\\p{N}_-])' + escaped + '(?![\\p{L}\\p{N}_-])', sensitive ? 'gu' : 'giu'), form, target: c.id, strong, sensitive });
  }
  forms.sort((a, b) => b.form.length - a.form.length);
  const suggestions: Row[] = [], seenPairs = new Set<string>();
  for (const c of concepts) {
    const linked = new Set<string>([...c.b, ...c.n, ...c.r]);
    for (const field of ['d', 'x']) {
      const body: string = c[field] || '', taken = Array(body.length).fill(false), spans: [number, number, number][] = [];
      for (const f of forms) {
        if (f.target === c.id || (!f.strong && !linked.has(f.target))) continue;
        f.pattern.lastIndex = 0;
        for (const m of body.matchAll(f.pattern)) {
          const a = m.index!, b = a + m[0]!.length;
          if (taken.slice(a, b).some(Boolean)) continue;
          taken.fill(true, a, b);
          // Match Python's character offsets, including when a definition contains supplementary characters.
          spans.push([Array.from(body.slice(0, a)).length, Array.from(body.slice(0, b)).length, cidx[f.target]]);
          break;
        }
      }
      spans.sort((a, b) => a[0] - b[0] || a[1] - b[1] || a[2] - b[2]);
      const seen = new Set<number>(), out = spans.filter(sp => !seen.has(sp[2]) && !!seen.add(sp[2]));
      if (out.length) c['m' + field] = out;
      for (const [a, b, t] of out) {
        const tid = concepts[t]!.id, pair = JSON.stringify([c.id, tid]);
        if (!linked.has(tid) && !seenPairs.has(pair)) { seenPairs.add(pair); suggestions.push({ a: c.id, b: tid, in: field, at: [a, b] }); }
      }
    }
  }
  return { suggestions, forms: forms.map(f => [f.form, cidx[f.target], f.strong ? 1 : 0, f.sensitive ? 1 : 0]),
    links: concepts.reduce((n, c) => n + (c.md?.length || 0) + (c.mx?.length || 0), 0) };
}
export interface BuildAppOptions { distDir?: string; outputDir?: string; siteDir?: string; dataOnly?: boolean; now?: string; }
export async function buildApp(root = resolve(dirname(fileURLToPath(import.meta.url)), '..'), options: BuildAppOptions = {}): Promise<Row> {
  root = resolve(root);
  const cfg = loadConfig(root) as Row;
  const DIST = options.distDir ? resolve(options.distDir) : join(root, 'dist-ts');
  const EV = join(root, 'evidence'), APP = join(root, 'app');
  const OUTPUT = options.outputDir ? resolve(options.outputDir) : join(APP, 'build-ts');
  const SITE = options.siteDir ? resolve(options.siteDir) : join(root, 'site-ts');
  const BASE = cfg.relayNsRoot + '/' + cfg.owner, SLUG = cfg.slugs as Row;
  const IRI: Row = Object.fromEntries(Object.entries(SLUG).map(([k, v]) => [k, BASE + '/' + v]));
  const NS = IRI.ontology + '#', CAT = IRI.catalog + '#', EN = IRI.enactments + '#', MP = IRI.mappings + '#';
  const failures: string[] = [];
  const check = (ok: unknown, what: string): void => { process.stdout.write((ok ? 'PASS ' : 'FAIL ') + what + '\n'); if (!ok) failures.push(what); };
  const json = (p: string): Row => JSON.parse(readFileSync(p, 'utf8'));
  const ttl = (k: string): Graph => new Graph(readFileSync(join(DIST, SLUG[k] + '.ttl'), 'utf8'));
  const git = (...args: string[]): string => execFileSync('git', ['-C', cfg.i2idl.localClone, ...args], { encoding: 'utf8', maxBuffer: 128 * 1024 * 1024 });
  const [commitSha, commitDate] = git('log', '-1', '--format=%H|%cI', '--', cfg.i2idl.graphPath).trim().split('|') as [string, string];
  const gl = JSON.parse(git('show', commitSha + ':' + cfg.i2idl.graphPath));
  const nodes: Row[] = gl['@graph'], byId: Row = Object.fromEntries(nodes.map(n => [n['@id'], n]));
  const onto = ttl('ontology'), cat = ttl('catalog'), enact = ttl('enactments'), maps = ttl('mappings'), rels = ttl('releases'), deco = ttl('decorations'), chg = ttl('changes');
  const unesco = json(join(EV, 'unesco-thesaurus.json')), published = json(join(DIST, 'published.json'));
  const fx = new Graph(readFileSync(join(EV, 'foxxi-manifest.ttl'), 'utf8'));
  const relayOps: Row[] = json(join(EV, 'relay-operations.json'))['hydra:member'];
  const relayInputs = json(join(EV, 'relay-inputs.json')), extTerms = json(join(EV, 'external-terms.json'));
  for (const [iri, term] of Object.entries(unesco.terms) as [string, Row][]) extTerms[iri] = {
    label: term.label, definition: term.scopeNote || term.definition, alt: term.alt, page: term.page, noteKind: term.scopeNote ? 'scope note' : null,
  };
  const scheme = byId[I2IDL + 'scheme'], release = scheme['gs:publicationVersion'];
  check(release === cfg.i2idl.release, 'glossary release ' + release + ' is the pinned release');
  const kindOfType: Row = {}, kinds: Row[] = KIND_ORDER.map(cls => {
    const s = NS + cls, types = sort(onto.objects(s, NS + 'kindForTypeCollection').map(o => local(str(o), I2IDL + 'collections/type/')));
    const kid = cls.replace('Concept', '').toLowerCase();
    for (const t of types) kindOfType[t] = kid;
    return { id: kid, cls: s, label: cls.replace('Concept', ''), def: onto.text(s, RDFS + 'comment'), types };
  });
  check(kinds.length === 8 && kinds.every(k => k.def), '8 agentic kinds, each with its ontology definition');
  const roles = onto.subjects(SKOS + 'inScheme', NS + 'EnactmentRoles').map(s => {
    const prop = onto.value(s, NS + 'asProperty')!;
    return { id: local(str(s), NS + 'role-'), label: onto.text(s, SKOS + 'prefLabel'), prop: local(str(prop), NS), by: onto.text(prop, RDFS + 'label') || '', def: onto.text(s, SKOS + 'definition') };
  }).sort((a, b) => ROLE_ORDER.indexOf(a.id) - ROLE_ORDER.indexOf(b.id));
  check(roles.length === 8 && roles.every(r => r.by), '8 enactment roles with their materialized properties');
  const schemeRows = (name: string, prefix: string): Row[] => onto.subjects(SKOS + 'inScheme', NS + name).map(s => ({
    id: local(str(s), NS + prefix), label: onto.text(s, SKOS + 'prefLabel'), def: onto.text(s, SKOS + 'definition'),
  }));
  const statuses = schemeRows('ReviewStatuses', 'status-'), methods = schemeRows('MappingMethods', 'method-');
  const interrogatives = onto.pairs(NS + 'answersInterrogative').map(([p, q]) => ({
    q: local(str(q), IE), prop: str(p), label: onto.text(p, RDFS + 'label') || (str(p) === SKOS + 'definition' ? 'definition' : str(p)),
  })).sort((a, b) => QORDER.indexOf(a.q) - QORDER.indexOf(b.q));
  check(JSON.stringify(interrogatives.map(r => r.q)) === JSON.stringify(QORDER), 'the eight Interego interrogatives the ontology answers');
  const collections: { field: Row[]; type: Row[]; curated: Row[] } & Record<string, Row[]> = { field: [], type: [], curated: [] }, members: Record<string, string[]> = {};
  for (const n of nodes) {
    if (!ids(n['@type']).includes('skos:Collection')) continue;
    const facet = n['gs:facet'], cid = local(n['@id'], I2IDL + 'collections/' + facet + '/');
    const mem = sort(ids(n['skos:member']).map(m => local(m, CONCEPTS)));
    members[n['@id']] = mem;
    const rec: Row = { id: cid, label: n['skos:prefLabel'], n: mem.length };
    if (n['dcterms:description']) rec.desc = clean(n['dcterms:description']);
    if (facet === 'type') rec.kind = kindOfType[cid];
    collections[facet]!.push(rec);
  }
  for (const rows of Object.values(collections)) rows.sort((a, b) => b.n - a.n || (a.label < b.label ? -1 : a.label > b.label ? 1 : 0));
  check(collections.field.length === 12 && collections.type.length === 16 && collections.curated.length === 3, '31 collections: 12 field, 16 type, 3 curated');
  check(JSON.stringify(sort(Object.keys(kindOfType))) === JSON.stringify(sort(collections.type.map(c => c.id))), 'every type collection has exactly one agentic kind');
  const sources: Row[] = [], srcIndex: Row = {}, shortLabel: Row = {};
  for (const n of nodes) for (const ev of aslist<Row>(n['gs:evidence'])) shortLabel[ev['dcterms:source']['@id']] ??= ev['gs:sourceLabel'];
  for (const n of nodes.filter(n => n['@type'] === 'dcterms:BibliographicResource').sort((a, b) => a['@id'] < b['@id'] ? -1 : 1)) {
    const rights = n['dcterms:rights'] || '', rec: Row = {
      id: local(n['@id'], I2IDL + 'sources/'), iri: n['@id'], title: n['dcterms:title'], label: shortLabel[n['@id']] || n['dcterms:title'],
      url: get(n, 'schema:url'), rights, rightsUrl: get(n, 'gs:rightsUrl'), rc: rightsClass(rights),
    };
    for (const [k, jk] of [['creator', 'dcterms:creator'], ['publisher', 'dcterms:publisher'], ['date', 'dcterms:date'], ['doi', 'dcterms:identifier'], ['page', 'gs:publicationPage'], ['cite', 'gs:preferredCitation'], ['adapt', 'gs:adaptationNotice'], ['disclaimer', 'gs:adaptationDisclaimer'], ['thirdParty', 'gs:thirdPartyMaterialNotice']] as const) {
      if (n[jk]) rec[k] = typeof n[jk] === 'string' ? clean(n[jk]) : n[jk];
    }
    srcIndex[n['@id']] = sources.length; sources.push(rec);
  }
  check(sources.length === 14, '14 evidence sources with rights');
  const conceptNodes = nodes.filter(n => ids(n['@type']).includes('skos:Concept')).sort((a, b) => a['skos:prefLabel'].toLowerCase() < b['skos:prefLabel'].toLowerCase() ? -1 : a['skos:prefLabel'].toLowerCase() > b['skos:prefLabel'].toLowerCase() ? 1 : 0);
  const fieldOf: Row = {}, curatedOf: Row = {};
  for (const [iri, mem] of Object.entries(members)) {
    const facet = iri.split('/collections/')[1]!.split('/')[0]!, cid = iri.split('/').pop()!;
    for (const m of mem) if (facet === 'field' || facet === 'curated') ((facet === 'field' ? fieldOf : curatedOf)[m] ||= []).push(cid);
  }
  const kindClass = Object.fromEntries(kinds.map(k => [k.cls, k.id]));
  const concepts: Row[] = []; let nEv = 0;
  for (const n of conceptNodes) {
    const cid = n['dcterms:identifier'], iri = n['@id'], d = byId[n['gs:activeDefinition']['@id']];
    if (iri !== CONCEPTS + cid) failures.push('concept IRI ' + iri + ' is not built from its identifier');
    const ev: Row[] = aslist<Row>(d['gs:evidence']).map(e => {
      const rec: Row = { s: srcIndex[e['dcterms:source']['@id']], r: e['gs:evidenceRelation'] === 'direct' ? 'd' : 's', c: clean(e['gs:citationDetail']), u: get(e, 'schema:url') };
      for (const [key, source] of [['p', 'gs:pdfPage'], ['pp', 'gs:pdfPrintedPage']] as const) if (e[source] != null) rec[key] = e[source];
      if (e['gs:host']) rec.h = e['gs:host'];
      if (e['gs:adaptationNotice']) rec.an = clean(e['gs:adaptationNotice']);
      if (e['gs:adaptationDisclaimer']) rec.ad = clean(e['gs:adaptationDisclaimer']);
      return rec;
    });
    nEv += ev.length;
    const pf = local(n['gs:fieldCollection']['@id'], I2IDL + 'collections/field/'), t = local(n['gs:typeCollection']['@id'], I2IDL + 'collections/type/');
    const fields = uniq<string>(fieldOf[cid] || []).sort((a, b) => Number(a !== pf) - Number(b !== pf) || (a < b ? -1 : a > b ? 1 : 0));
    const dk = deco.objects(iri, RDF + 'type').filter(t => str(t) in kindClass).map(t => kindClass[str(t)]), k = kindOfType[t];
    if (JSON.stringify(dk) !== JSON.stringify([k])) failures.push('kind of ' + cid + ': decorations differ from type mapping');
    const pv = ev.some(e => e.r === 'd') ? 'g' : 's', dp = deco.objects(d['@id'], RDF + 'type').map(str);
    if (!dp.includes(NS + (pv === 'g' ? 'SourceGroundedDefinition' : 'SynthesizedDefinition'))) failures.push('provenance of ' + cid + ': decorations differ from evidence');
    if (clean(n['skos:definition']) !== clean(d['rdf:value'])) failures.push('definition text of ' + cid + ' differs from its active definition');
    concepts.push({
      id: cid, l: n['skos:prefLabel'], a: aslist(n['skos:altLabel']), d: clean(n['skos:definition']), x: clean(n['gs:editorialExplanation']),
      st: get(n, 'gs:editorialStatus'), t, f: fields, pf, cu: sort(curatedOf[cid] || []), k, pv,
      b: sort(ids(n['skos:broader']).map(x => local(x, CONCEPTS))), n: sort(ids(n['skos:narrower']).map(x => local(x, CONCEPTS))), r: sort(ids(n['skos:related']).map(x => local(x, CONCEPTS))),
      di: d['@id'], ds: get(d, 'gs:editorialStatus'), dq: get(d, 'gs:definitionSequence'), dc: d['dcterms:creator'] ? ids(d['dcterms:creator'])[0] : null, dl: get(d, 'dcterms:language'), ev,
      xm: ['exactMatch', 'closeMatch', 'relatedMatch', 'broadMatch', 'narrowMatch'].flatMap(p => ids(n['skos:' + p]).map(t => [p, t])),
    });
  }
  const cidx: Row = Object.fromEntries(concepts.map((c, i) => [c.id, i]));
  check(concepts.length === 397, concepts.length + ' concepts extracted');
  check(nEv === 541, nEv + ' evidence records extracted');
  check(concepts.every(c => c.f.includes(c.pf)), "every concept's primary field is among its field memberships");
  check(!failures.some(f => /^(kind of|provenance of|definition text|concept IRI)/u.test(f)), 'kinds and definition provenance agree with the materialized decorations');
  for (const c of concepts) {
    for (const rel of ['b', 'n', 'r']) for (const x of c[rel]) if (!(x in cidx)) failures.push(c.id + ' ' + rel + ' → unknown ' + x);
    const s = CONCEPTS + c.id, spec = sort(cat.objects(s, NS + 'specification').map(str)), exm = sort(cat.objects(s, NS + 'exemplifiedBy').map(str));
    if (spec.length) c.spec = spec; if (exm.length) c.exm = exm;
  }
  check(concepts.filter(c => c.spec).length === 9 && concepts.filter(c => c.exm).length === 10, '9 specification links and 10 exemplars from the catalog');
  const neighQ = str(cat.value(CAT + 'q-concept-neighborhood', NS + 'sparql'));
  let bad = 0;
  for (const c of concepts) {
    const query = neighQ.replace(/\$concept\b/g, safeIri(CONCEPTS + c.id)), want: Row = {
      card: 'https://www.i2idl.org/glossary#' + c.id, definition: c.di + '.ttl', neighborhood: ENDPOINT + '?query=' + pythonQuote(query),
      resolve: CONCEPTS + c.id + '.ttl', 'resolve-json': CONCEPTS + c.id + '.jsonld',
    }, got: Row = {};
    for (const a of deco.objects(CONCEPTS + c.id, IEP + 'affordance')) got[str(a).split('--')[1]!] = str(deco.value(a, HYDRA + 'target'));
    if (Object.keys(got).length !== Object.keys(want).length || Object.entries(want).some(([k, v]) => got[k] !== v)) bad++;
  }
  check(bad === 0, "the client's control recipe reproduces all " + (concepts.length * 5) + ' decorated targets exactly');
  const actions: Row = {};
  const inputSort = (a: Row, b: Row): number => Number(!a.req) - Number(!b.req) || (a.n < b.n ? -1 : a.n > b.n ? 1 : 0);
  for (const s of fx.subjects(RDF + 'type', IEP + 'Affordance').sort((a, b) => a.value < b.value ? -1 : 1)) {
    const a = str(fx.value(s, IEP + 'action')), ex = fx.value(s, HYDRA + 'expects'), inputs: Row[] = [];
    if (ex) for (const sp of fx.objects(ex, HYDRA + 'supportedProperty')) {
      const prop = fx.value(sp, HYDRA + 'property'), d = fx.value(sp, SH + 'datatype');
      inputs.push({ n: prop ? fx.text(prop, RDFS + 'label') || '?' : '?', req: fx.bool(sp, HYDRA + 'required'), c: fx.text(sp, RDFS + 'comment'), t: d ? str(d).split('#').pop() : null });
    }
    inputs.sort(inputSort);
    const hint = (p: string): boolean | null => fx.value(s, p) == null ? null : fx.bool(s, p);
    const parts = local(a, ACTION_ROOT).split('/'), sys = parts.shift();
    actions[a] = { sys, n: parts.join('/'), t: fx.text(s, HYDRA + 'title'), lb: fx.text(s, RDFS + 'label'), d: fx.text(s, RDFS + 'comment'), m: str(fx.value(s, HYDRA + 'method')),
      u: str(fx.value(s, HYDRA + 'target')), mt: fx.text(s, DCAT + 'mediaType'), ro: hint(IEP + 'readOnlyHint'), de: hint(IEP + 'destructiveHint'), ix: hint(IEP + 'idempotentHint'), xr: hint(IEP + 'externallyRouted'),
      co: sort(fx.objects(s, IEP + 'appliesToCollection').map(str)), in: inputs };
  }
  const nFx = Object.keys(actions).length;
  for (const op of relayOps) {
    const a = op.action, name = local(a, ACTION_ROOT + 'relay/'), schema = relayInputs[name] || {}, req = new Set(schema.required || []);
    const inputs = Object.entries(schema.properties || {}).map(([k, v]: [string, Value]) => ({ n: k, req: req.has(k), c: v.description ? clean(v.description)!.slice(0, 280) : null, t: typeof v.type === 'string' ? v.type : null })).sort(inputSort);
    actions[a] = { sys: 'relay', n: name, t: clean(op.title), lb: clean(op.title), d: clean(op.description), m: get(op, 'method'), u: get(op, 'target'), mt: 'application/json',
      ro: null, de: null, ix: null, xr: null, co: [], in: inputs, cls: get(op, 'classification'), auth: (op['hydra:expectsHeader'] || []).some((h: Row) => h['hydra:headerName'] === 'Authorization' && h['hydra:required']) };
  }
  const bridgeSnapshot: Row[] = JSON.parse(readFileSync(join(EV, 'foxxi-affordances.json'), 'utf8'));
  const expectedBridgeActions = new Set(bridgeSnapshot.filter(r => r.action).map(r => r.action)), expectedRelayActions = new Set(relayOps.map(r => r.action));
  check(nFx === expectedBridgeActions.size && [...expectedBridgeActions].every(a => actions[a] && actions[a].sys !== 'relay') && expectedRelayActions.size === Object.keys(actions).length - nFx && [...expectedRelayActions].every(a => actions[a]?.sys === 'relay'), nFx + ' bridge affordances and ' + (Object.keys(actions).length - nFx) + ' relay operations match the actual snapshots');
  const enactments: Row[] = enact.subjects(RDF + 'type', NS + 'Enactment').map(s => {
    return { id: local(str(s), EN), c: local(str(enact.value(s, NS + 'enactedConcept')), CONCEPTS), a: str(enact.value(s, NS + 'viaAction')),
      r: local(str(enact.value(s, NS + 'enactmentRole')), NS + 'role-'), cf: Number(str(enact.value(s, NS + 'confidence'))), w: enact.text(s, NS + 'rationale'),
      s: local(str(enact.value(s, NS + 'reviewStatus')), NS + 'status-'), m: local(str(enact.value(s, NS + 'mappingMethod')), NS + 'method-') };
  });
  check(enactments.length === 89 && enactments.every(e => e.a in actions && e.c in cidx), '89 enactments, every action in the live catalogs and every concept in the release');
  const direct = new Set(enactments.map(e => JSON.stringify([e.c, e.a])));
  const ancestorsOf = (cid: string, seen = new Set<string>()): string[] => {
    const out: string[] = []; for (const b of concepts[cidx[cid]]!.b) if (!seen.has(b)) { seen.add(b); out.push(b, ...ancestorsOf(b, seen)); } return out;
  };
  const inherited = deco.pairs(NS + 'inheritedEnactedBy').map(([s, o]) => { const c = local(str(s), CONCEPTS), a = str(o); return { c, a, via: ancestorsOf(c).find(anc => direct.has(JSON.stringify([anc, a]))) || null }; })
    .sort((a, b) => a.c < b.c ? -1 : a.c > b.c ? 1 : a.a < b.a ? -1 : a.a > b.a ? 1 : 0);
  check(inherited.length === 7 && inherited.every(r => r.via), '7 inherited enactments, each traced to the broader concept that enacts it');
  // The descriptive notes were Turtle comments in the Python projection. Preserve
  // their declarative source wording and prove every row is present in the RDF graph.
  const roleCaps: Row[] = [];
  for (const [c, key, confidence, why] of cw.ROLE_CAPABILITIES) roleCaps.push({ c, a: ACTION_ROOT + key, note: confidence.toFixed(2) + ' — ' + why });
  const foxxiByKey: Row = Object.fromEntries(bridgeSnapshot.filter(r => r.action).map(r => [r.action.split('/ns/iep/action/').pop(), r]));
  for (const [tag, [c]] of Object.entries(cw.ROLE_TAGS)) {
    for (const key of Object.keys(foxxiByKey).filter(k => foxxiByKey[k].title.startsWith(tag)).sort()) {
      roleCaps.push({ c, a: ACTION_ROOT + key, note: 'derived: ' + tag + ' in manifest title' });
    }
  }
  check(roleCaps.every(r => enact.objects(CONCEPTS + r.c, NS + 'roleCapability').some(o => str(o) === r.a)), 'every role capability note describes a triple in the generated graph');
  check(roleCaps.length === 26 && roleCaps.every(r => r.a in actions), '26 role capabilities, all live actions');
  const mappings: Row[] = [], adoptedOf = new Map<string, string>(); let nSuperseded = 0;
  for (const s of maps.subjects(RDF + 'type', NS + 'MappingProposal')) {
    const id = local(str(s), MP), status = str(maps.value(s, NS + 'reviewStatus'));
    if (status === NS + 'status-superseded') { nSuperseded++; continue; }
    const c = local(str(maps.value(s, NS + 'proposedSubject')), CONCEPTS), obj = str(maps.value(s, NS + 'proposedObject'));
    if (status === NS + 'status-adopted') { adoptedOf.set(JSON.stringify([c, obj]), id); continue; }
    const term = extTerms[obj] || {}, vocab = VOCABS.find(([ns]) => obj.startsWith(ns));
    if (!vocab) throw new Error('Unknown mapping target vocabulary: ' + obj);
    const rec: Row = { id, c, p: str(maps.value(s, NS + 'proposedPredicate')).split('#').pop(), o: obj, v: vocab[1], ol: get(term, 'label'), od: term.definition ? term.definition.replace(/\[\[([^\]]+)\]\]/g, '$1') : term.definition ?? null,
      cf: Number(str(maps.value(s, NS + 'confidence'))), w: maps.text(s, NS + 'rationale'), s: local(status, NS + 'status-'), m: local(str(maps.value(s, NS + 'mappingMethod')), NS + 'method-') };
    const cited = maps.value(s, NS + 'citedIn');
    if (cited) { rec.ci = str(cited); rec.pg = str(maps.value(s, RDFS + 'seeAlso')); rec.oa = term.alt || []; if (term.noteKind) rec.on = term.noteKind; }
    const ip = sort(maps.objects(s, NS + 'i2idlPredicate').map(o => str(o).split('#').pop()!)); if (ip.length) rec.ip = ip;
    const old = maps.value(s, DCT + 'replaces'); if (old) rec.rp = { id: str(old).split('#').pop(), o: str(maps.value(old, NS + 'proposedObject')) };
    mappings.push(rec);
  }
  const openOf = new Map(mappings.map(m => [JSON.stringify([m.c, m.o]), [m.id, m.p]]));
  for (const c of concepts) { c.xm = c.xm.map(([p, t]: [string, string]) => [p, t, extTerms[t]?.label ?? null, adoptedOf.get(JSON.stringify([c.id, t])) ?? null, openOf.get(JSON.stringify([c.id, t])) ?? null]); if (!c.xm.length) delete c.xm; }
  const nOwn = concepts.reduce((n, c) => n + (c.xm?.length || 0), 0), nUnesco = mappings.filter(m => m.v === 'UNESCO Thesaurus').length;
  check(nOwn > 0 && concepts.every(c => (c.xm || []).every((x: Value[]) => x[3] || x[4] == null || x[4][1] !== x[0])) && adoptedOf.size === concepts.reduce((n, c) => n + (c.xm || []).filter((x: Value[]) => x[3]).length, 0), nOwn + " of I2IDL's own crosswalks on the concepts that carry them; " + adoptedOf.size + ' adopt a proposal');
  check(mappings.length + adoptedOf.size === 73 && mappings.every(m => m.c in cidx), mappings.length + ' open mapping proposals on concepts in the release');
  check(nSuperseded === 15 && mappings.filter(m => m.rp).length === 15 && mappings.filter(m => m.rp).every(m => m.rp.o.startsWith('https://w3id.org/xapi/ontology#') && m.v === 'xAPI (Foxxi)'), "15 proposals to Foxxi's xAPI ontology name the ADL proposals they replace");
  check(nUnesco + [...adoptedOf.keys()].filter(k => JSON.parse(k)[1].startsWith('http://vocabularies.unesco.org/')).length === 13 && mappings.filter(m => m.v === 'UNESCO Thesaurus').every(m => m.ci && m.m === 'evidence-cited'), nUnesco + ' open UNESCO Thesaurus proposals, each evidence-cited');
  check(mappings.filter(m => m.ci).every(m => unesco.terms[m.o].citedBy.some((c: Row) => c.concept === m.c && c.definition === m.ci)), "every evidence-cited proposal's definition cites its target in the UNESCO snapshot");
  const nOther = mappings.filter(m => m.v !== 'UNESCO Thesaurus').length;
  check(mappings.filter(m => m.od && m.v !== 'UNESCO Thesaurus').length >= nOther - 2 && mappings.filter(m => m.v.includes('(Foxxi)')).every(m => m.od), "other targets carry their own vocabulary's definition (every Foxxi target does)");
  const releases: Row[] = rels.subjects(RDF + 'type', NS + 'GlossaryRelease').map(s => ({ v: str(rels.value(s, NS + 'releaseVersion')), commit: str(rels.value(s, NS + 'releaseCommit')),
    at: str(rels.value(s, PROV + 'generatedAtTime')), n: Number(str(rels.value(s, NS + 'conceptCount'))), rel: Number(str(rels.value(s, NS + 'relatedPairCount'))), br: Number(str(rels.value(s, NS + 'broaderPairCount'))),
    add: sort(rels.objects(s, NS + 'addedConcept').map(o => local(str(o), CONCEPTS))), rem: sort(rels.objects(s, NS + 'removedConcept').map(o => local(str(o), CONCEPTS))), rev: sort(rels.objects(s, NS + 'revisedDefinitionOf').map(o => local(str(o), CONCEPTS))),
    diff: rels.value(s, RDFS + 'seeAlso') ? str(rels.value(s, RDFS + 'seeAlso')) : null, note: rels.text(s, RDFS + 'comment') })).sort((a, b) => {
      const av = a.v.replace(/^v/, '').split('.').map(Number), bv = b.v.replace(/^v/, '').split('.').map(Number);
      for (let i = 0; i < Math.max(av.length, bv.length); i++) if ((av[i] || 0) !== (bv[i] || 0)) return (av[i] || 0) - (bv[i] || 0);
      return 0;
    });
  check(releases.length === 23 && releases.at(-1)?.v === release && releases.at(-1)?.n === 397, '23 releases ending at the pinned release with 397 concepts');
  const hrels = hist.releases(cfg.i2idl.localClone, cfg.i2idl.graphPath) as Value[];
  check(JSON.stringify(hrels.map(h => h.version)) === JSON.stringify(releases.map(r => r.v)), 'change history covers exactly the releases in the release feed');
  const nFacts = hrels.reduce((n, h) => n + h.events.length, 0), graphFacts = chg.subjects(RDF + 'type', NS + 'ChangeEvent').reduce((n, s) => n + chg.objects(s, NS + 'changeCount').reduce((a, o) => a + Number(str(o)), 0), 0);
  check(nFacts === graphFacts, nFacts + ' fact-level changes equal the published change graph total');
  const recon = hist.reconcile(hrels) as Value;
  check(mapEntries(recon).every(([, v]) => v[0] === v[1]), 'history reconciles baseline + additions − removals for every count');
  const changeKinds = hist.KINDS.map(([id, label, def]) => ({ id, label, def }));
  for (let i = 0; i < releases.length; i++) {
    const tally = countBy(hrels[i].events, 'kind');
    releases[i]!.ch = Object.fromEntries(hist.KIND_CODES.filter((k: string) => tally[k]).map((k: string) => [k, tally[k]])); releases[i]!.nch = hrels[i].events.length;
  }
  const baseline = new Set(mapKeys(hrels[0].snap.concepts).map(c => local(c, CONCEPTS)));
  for (const c of concepts) c.h0 = baseline.has(c.id) ? 1 : 0;
  for (let ri = 1; ri < hrels.length; ri++) {
    const per: Row = {};
    for (const e of hrels[ri].events) for (const iri of hist.touched(e)) {
      const cid = local(iri, CONCEPTS); if (!(cid in cidx)) continue;
      const rec: Row = per[cid] ||= {}, k: string = e.kind;
      const append = (key: string, v: Value): void => { (rec[key] ||= []).push(v); };
      if (k === 'concept-added') rec.add = 1;
      else if (k === 'concept-removed') rec.rem = 1;
      else if (k.startsWith('relationship-')) {
        const other = local(iri === e.a ? e.b : e.a, CONCEPTS), key = (e.property === 'skos:related' ? 'r' : iri === e.a ? 'b' : 'n') + (k.endsWith('added') ? '+' : '-');
        if (other in cidx) append(key, cidx[other]);
      } else if (k.startsWith('membership-')) append('m' + (k.endsWith('added') ? '+' : '-'), e.collection.split('/collections/')[1]);
      else if (k === 'evidence-added' || k === 'evidence-removed') { const key = 'e' + (k.endsWith('added') ? '+' : '-'); rec[key] = (rec[key] || 0) + 1; }
      else if (k === 'evidence-classified') { rec.ec ||= {}; rec.ec[e.new] = (rec.ec[e.new] || 0) + 1; }
      else if (k === 'evidence-reclassified') append('er', [e.prior ?? null, e.new, srcIndex[e.source] ?? null]);
      else if (k.startsWith('alt-label')) append('al' + (k.endsWith('added') ? '+' : '-'), e.new || e.prior);
      else if ('target' in e) append('x', [k, e.target, e.prior ?? null, e.new ?? null]);
      else (rec.s ||= {})[k] = [e.prior ?? null, e.new ?? null];
    }
    for (const [cid, rec] of Object.entries(per)) (concepts[cidx[cid]]!.h ||= []).push([ri, rec]);
  }
  const nHist = concepts.reduce((n, c) => n + (c.h?.length || 0), 0);
  check(nHist > 0 && concepts.every(c => c.h0 || (c.h || []).some(([, r]: Value[]) => 'add' in r)), 'every concept is in the baseline or has an added event; ' + nHist + ' history rows');
  const allEvents = hrels.flatMap(h => h.events), changesMeta = { baseline: hrels[0].version, baselineDate: hrels[0].date, facts: nFacts,
    events: chg.subjects(RDF + 'type', NS + 'ChangeEvent').length, releaseChanges: chg.subjects(RDF + 'type', NS + 'ReleaseChange').length,
    withChanges: hrels.slice(1).filter(h => h.events.length).length, byKind: countBy(allEvents, 'kind'), reconcile: Object.fromEntries(mapEntries(recon).map(([k, v]) => [k, v[1]])), baselineCounts: hist.totals(hrels[0].snap) };
  const doc = (heading: string, paths: string[]): [string, string] => {
    for (const path of paths) { try { const body = git('show', commitSha + ':' + path); if (body.split(/\r?\n/u).includes(heading)) return [path, body]; } catch { /* An older release may have the heading in README. */ } }
    throw new Error('No ' + heading + ' at the pinned commit ' + commitSha);
  };
  const [roadmapPath, roadmap] = doc('## Next development priorities', ['docs/ROADMAP.md', 'README.md']);
  const [principlePath, principleDoc] = doc('## Development principle', ['docs/ARCHITECTURE.md', 'README.md']);
  const phases = [...roadmap.matchAll(/^### Phase (\d+): (.+?)\n+\*\*(.+?)\*\*/gm)].map(m => ({ n: Number(m[1]!), title: m[2]!.trim(), status: m[3]!.trim().replace(/\.$/, '') }));
  const prioBlock = roadmap.split('## Next development priorities')[1]!.split('\n## ')[0]!;
  const priorities = [...prioBlock.matchAll(/^### (\d+)\. (.+)$/gm)].map(m => ({ n: Number(m[1]!), title: m[2]!.trim(), anchor: (m[1]! + '. ' + m[2]!).toLowerCase().replace(/[^a-z0-9 -]/g, '').replace(/ /g, '-') }));
  const principle = clean(principleDoc.split('## Development principle')[1]!.split('\n## ')[0])!.replace(/`([^`]+)`/g, '$1');
  const routes = [...prioBlock.matchAll(/^(\/api\/[^\s]+)$/gm)].map(m => m[1]!), provLines = [...prioBlock.matchAll(/^Definition provenance: (.+)$/gm)].map(m => m[1]!);
  check(phases.length === 7 && priorities.length === 4 && routes.length === 3 && provLines.length === 2 && principle, "I2IDL's own roadmap and development principle are read from the pinned commit");
  check(JSON.stringify(provLines) === JSON.stringify(['Direct source definition', 'I2IDL synthesis supported by source evidence']), "the provenance wording is I2IDL's own");
  const blob = cfg.i2idl.repo + '/blob/' + commitSha + '/', upstream = { phases, priorities, principle, routes, provenance: provLines, roadmap: blob + roadmapPath, roadmapName: roadmapPath !== 'README.md' ? 'roadmap' : 'README',
    principleSource: blob + principlePath, principleName: principlePath !== 'README.md' ? 'architecture notes' : 'README' };
  const unescoGroups: Row[] = [];
  for (const c of concepts) {
    const mts = c.ev.filter((e: Row) => e.u && /vocabularies\.unesco\.org\/unesco\/en\/page\/mt[\d.]+$/u.test(e.u));
    const concs = c.ev.filter((e: Row) => e.u && /vocabularies\.unesco\.org\/unesco\/en\/page\/concept\d+$/u.test(e.u));
    for (const e of mts) unescoGroups.push({ c: c.id, page: e.u, cite: e.c, only: !concs.length });
  }
  check(unescoGroups.filter(g => g.only).length === 3, unescoGroups.length + ' UNESCO microthesaurus citations; 3 concepts cite only a group');
  const unescoMeta = { scheme: unesco.scheme, fetchedAt: unesco.fetchedAt, groups: unescoGroups };
  const order = cat.objects(IRI.catalog, IEP + 'affordance').map(n => local(str(n), CAT));
  const shapeProps = (shape: Term): Row[] => cat.objects(shape, SH + 'property').map(p => ({
    n: cat.text(p, SH + 'name') || str(cat.value(p, SH + 'path')).split('#').pop(), req: Number(str(cat.value(p, SH + 'minCount') || { value: '0', termType: 'Literal' })) >= 1,
    c: cat.text(p, SH + 'description'), def: cat.text(p, SH + 'defaultValue'), pat: cat.text(p, SH + 'pattern'), max: Number(str(cat.value(p, SH + 'maxLength') || { value: '0', termType: 'Literal' })) || null,
  })).sort(inputSort);
  const ports = order.map(name => {
    const s = CAT + name, tmpl = cat.value(s, NS + 'targetTemplate'), exp = cat.value(s, HYDRA + 'expects'), rec: Row = {
      id: name, label: cat.text(s, RDFS + 'label'), title: cat.text(s, HYDRA + 'title'), desc: cat.text(s, HYDRA + 'description'), action: str(cat.value(s, IEP + 'action')),
      m: str(cat.value(s, HYDRA + 'method')), mt: cat.text(s, DCAT + 'mediaType'), ro: cat.bool(s, IEP + 'readOnlyHint'), de: cat.bool(s, IEP + 'destructiveHint'), routed: cat.bool(s, IEP + 'externallyRouted'),
    };
    const target = cat.value(s, HYDRA + 'target'); if (target) rec.u = str(target);
    if (tmpl) { rec.tpl = str(cat.value(tmpl, HYDRA + 'template')); rec.vars = cat.objects(tmpl, HYDRA + 'mapping').map(mp => ({ v: str(cat.value(mp, HYDRA + 'variable')), p: str(cat.value(mp, HYDRA + 'property')) })); }
    if (exp) rec.expects = { id: str(exp).split('#').pop(), label: cat.text(exp, RDFS + 'label'), note: cat.text(exp, RDFS + 'comment'), props: shapeProps(exp) };
    const via = cat.value(s, NS + 'delegatesTo'), cap = cat.value(s, NS + 'requiresCapability');
    if (via) rec.via = str(via); if (cap) rec.cap = str(cap).split('#').pop();
    return rec;
  });
  check(ports.length === 23 && ['port-change-history', 'port-vocabulary', 'port-alignments', 'port-referents', 'port-publish-classified'].every(id => ports.some(p => p.id === id)), '23 catalog controls in catalog order, including change history and semantic layer');
  const samples: Row = { 'concept-neighborhood': { concept: 'learning-record-store-lrs' }, 'concept-search': { text: 'record store' }, 'definition-evidence': { concept: 'data-privacy' },
    'collection-members': { collection: 'curated/competency-and-assessment' }, 'field-intersection': { fieldA: 'field/learning-engineering', fieldB: 'field/learning-sciences' },
    'concepts-by-type': { type: 'type/standard' }, 'multi-field-concepts': {}, 'provenance-profile': {}, 'release-check': { version: release }, classify: {}, 'concept-referents': { concept: 'formative-assessment' } };
  const queries = cat.subjects(RDF + 'type', NS + 'StoredQuery').map(s => {
    const id = local(str(s), CAT), sparql = str(cat.value(s, NS + 'sparql')), name = id.slice(2);
    const params = uniq(cat.objects(s, NS + 'parameter').map(str)).sort((a, b) => sparql.indexOf('$' + a) - sparql.indexOf('$' + b));
    const over = sort(cat.objects(s, NS + 'runsOver').map(o => str(o).split('#').pop()!)), q: Row = {
      id, name, label: cat.text(s, RDFS + 'label'), desc: cat.text(s, DCT + 'description'), form: str(cat.value(s, NS + 'queryForm')), sparql, params, sample: samples[name],
    }; if (over.length) q.over = over; return q;
  });
  check(queries.length === 11 && queries.filter(q => q.over).length === 2, '11 stored queries, 2 client-side over semantic-layer ports');
  const lim = cat.subjects(RDF + 'type', NS + 'ServiceLimits')[0]!, limitsMany: Row = {};
  for (const [p, o] of cat.predicateObjects(lim)) {
    if (str(p) === RDF + 'type') continue;
    let key = str(p).split('#').pop()!.split('/').pop()!, value = scalar(o);
    if (o.datatype?.value.endsWith('#dayTimeDuration') || o.datatype?.value.endsWith('#duration')) {
      const m = /^P(?:(\d+(?:\.\d+)?)D)?(?:T(?:(\d+(?:\.\d+)?)H)?(?:(\d+(?:\.\d+)?)M)?(?:(\d+(?:\.\d+)?)S)?)?$/u.exec(o.value);
      if (!m) throw new Error('Unsupported duration in limits: ' + o.value);
      key += 'Seconds'; value = Number(m[1]! || 0) * 86400 + Number(m[2]! || 0) * 3600 + Number(m[3]! || 0) * 60 + Number(m[4]! || 0);
    }
    (limitsMany[key] ||= []).push(value);
  }
  const limits = Object.fromEntries(Object.entries(limitsMany).map(([k, vs]: [string, Value]) => [k, vs.length === 1 ? vs[0] : sort(vs)]));
  const titles: Row = { ontology: 'Ontology', shapes: 'Shapes', rules: 'Rules', catalog: 'Agent catalog', enactments: 'Enactments', mappings: 'Mapping proposals', releases: 'Release feed', changes: 'Change history', alignments: 'Alignments', referents: 'Referents' };
  const pubBySlug: Row = Object.fromEntries(published.graphs.map((r: Row) => [r.graph, r])), unpublished = Object.keys(titles).filter(k => !(SLUG[k] in pubBySlug));
  check(!unpublished.length || process.env.I2IDLX_ALLOW_UNPUBLISHED === '1', 'every graph the app links is published' + (unpublished.length ? ' (not yet: ' + unpublished.join(', ') + ')' : ''));
  const graphs = ['catalog', 'ontology', 'shapes', 'rules', 'enactments', 'mappings', 'releases', 'changes', 'alignments', 'referents'].map(key => {
    const r = pubBySlug[SLUG[key]] || { modalStatus: null, descriptor: null, contentHash: null };
    return { key, slug: SLUG[key], iri: IRI[key], title: titles[key], status: r.modalStatus, descriptor: r.descriptor, hash: r.contentHash, validFrom: get(r, 'validFrom'), triples: ttl(key).size };
  });
  const annotation = mentions(concepts, cidx); check(annotation.links > 0, 'definitions and explanations are hypertext');
  let otext = readFileSync(join(root, 'src', 'origins.json'), 'utf8');
  for (const [k, v] of Object.entries({ '{nTypes}': collections.type.length, '{nFields}': collections.field.length, '{nCurated}': collections.curated.length, '{nSources}': sources.length })) otext = otext.replaceAll(k, String(v));
  const originSrc = JSON.parse(otext), whereTokens: Row = { '{release}': release, '{commit7}': commitSha.slice(0, 7), '{base}': BASE.replace(/^https:\/\//, ''), '{foxxi}': cfg.foxxiManifest.replace(/^https:\/\//, '') };
  const origins = originSrc.origins.map((o: Row) => {
    let where = o.where; for (const [k, v] of Object.entries(whereTokens)) where = where.replaceAll(k, v);
    if (where.includes('{')) throw new Error('Unfilled origin wording token: ' + where);
    return { id: o.id, label: o.label, group: o.group, what: o.what, trust: o.trust, where };
  });
  const publishedOrigins: Row = {};
  for (const n of onto.subjects(SKOS + 'inScheme', NS + 'Origins')) publishedOrigins[str(onto.value(n, SKOS + 'notation'))] = [str(onto.value(n, SKOS + 'prefLabel')), str(onto.value(n, SKOS + 'definition')), str(onto.value(n, SKOS + 'scopeNote'))];
  check(origins.every((o: Row, i: number) => publishedOrigins[o.id]?.[0] === o.label && publishedOrigins[o.id]?.[1] === (originSrc.origins[i].definition || o.what) && publishedOrigins[o.id]?.[2] === (originSrc.origins[i].scope || o.trust)), 'origin labels and wording match the published ontology');
  const al = ttl('alignments'), refs = ttl('referents'), semj = json(join(DIST, 'semantic-layer.json')), PFX: Row = { ...SEMM.PREFIXES, i2x: NS, i2idl: CONCEPTS };
  const curie = (iri: string): string => {
    const best = Object.entries(PFX).filter(([, base]) => iri.startsWith(base)).sort((a, b) => b[1].length - a[1].length)[0];
    return best ? best[0] + ':' + iri.slice(best[1].length) : iri;
  };
  const restriction = (g: Graph, n: Term, prop: string): Term | null => str(g.value(n, OWL + 'onProperty')) === prop ? g.value(n, OWL + 'hasValue') : null;
  const catNodes: Record<string, Term> = {};
  for (const n of onto.subjects(SKOS + 'inScheme', NS + 'ReferentCategories')) catNodes[str(onto.value(n, SKOS + 'notation'))] = n;
  check(JSON.stringify(sort(Object.keys(catNodes))) === JSON.stringify(sort(SEMM.CATEGORIES.map((c: Value) => c.id))), Object.keys(catNodes).length + ' referent categories in the published ontology');
  const conceptLevel: Row = {};
  for (const [r, o] of al.pairs(RDFS + 'subClassOf')) {
    const v = restriction(al, r, NS + 'referentCategory');
    if (v && o.termType === 'NamedNode') (conceptLevel[str(onto.value(v, SKOS + 'notation'))] ||= []).push(curie(str(o)));
  }
  const semCats = SEMM.CATEGORIES.map((c: Value) => {
    const n = catNodes[c.id]!, cls = onto.value(n, NS + 'referentClass')!, own = sort(al.objects(cls, RDFS + 'subClassOf').filter(o => o.termType === 'NamedNode').map(o => curie(str(o))));
    if (JSON.stringify(own) !== JSON.stringify(sort([...(c.referent || [])]))) failures.push('category ' + c.id + ': published alignments differ from semantic source');
    return { id: c.id, label: onto.text(n, SKOS + 'prefLabel'), def: onto.text(n, SKOS + 'definition'), cls: curie(str(cls)), parent: c.broader ?? null, group: c.group,
      mode: str(onto.value(n, NS + 'classificationMode')), abstract: !!c.abstract, own, cc: sort(conceptLevel[c.id] || []), ex: sort(al.objects(n, NS + 'expressibleAs').map(o => curie(str(o)))), why: al.text(n, NS + 'alignmentRationale'), role: !!c.bearsRole } as Row;
  });
  check(semCats.every(sc => sc.why && sc.label && sc.def), 'every category has a label, definition and alignment rationale');
  for (const sc of semCats) {
    const start = nn(expand(sc.cls, PFX)), visited = new Set<string>(), named = new Set<string>(), walk = (s: Term): void => {
      const key = s.termType + ':' + s.value; if (visited.has(key)) return; visited.add(key);
      if (s.termType === 'NamedNode') named.add(str(s));
      for (const g of [onto, al]) for (const o of g.objects(s, RDFS + 'subClassOf')) walk(o);
    }; walk(start); sc.all = sort([...named].map(curie));
  }
  const catOfNode = Object.fromEntries(Object.entries(catNodes).map(([k, n]) => [str(n), k])); let assigned = 0;
  for (const c of concepts) {
    const s = CONCEPTS + c.id, cn = refs.value(s, NS + 'referentCategory');
    if (!cn) { failures.push(c.id + ': no referent category'); continue; }
    c.rc = catOfNode[str(cn)]; c.rb = str(refs.value(s, NS + 'assignmentBasis')) === 'type' ? 't' : 'd'; c.rw = refs.text(s, NS + 'categoryRationale'); assigned++;
  }
  check(assigned === concepts.length, 'all ' + assigned + ' concepts carry their referent category, basis and reason');
  const bridges: Row[] = [], propOf = new Map<string, string>();
  for (const p of maps.subjects(RDF + 'type', NS + 'MappingProposal')) propOf.set(JSON.stringify([str(maps.value(p, NS + 'proposedSubject')), str(maps.value(p, NS + 'proposedObject'))]), str(p).split('#').pop()!);
  for (const [t, r] of al.pairs(OWL + 'equivalentClass')) { const v = restriction(al, r, NS + 'isClassifiedBy'); if (v) bridges.push({ t: curie(str(t)), c: local(str(v), CONCEPTS), k: 'exact' }); }
  for (const [a, b] of al.pairs(RDFS + 'subClassOf')) {
    const va = restriction(al, a, NS + 'isClassifiedBy'), vb = restriction(al, b, NS + 'isClassifiedBy');
    if (vb && a.termType === 'NamedNode') bridges.push({ t: curie(str(a)), c: local(str(vb), CONCEPTS), k: 'narrow' });
    else if (va && b.termType === 'NamedNode') bridges.push({ t: curie(str(b)), c: local(str(va), CONCEPTS), k: 'broad' });
  }
  for (const b of bridges) b.m = propOf.get(JSON.stringify([CONCEPTS + b.c, expand(b.t, PFX)])) ?? null;
  bridges.sort((a, b) => a.c < b.c ? -1 : a.c > b.c ? 1 : a.t < b.t ? -1 : a.t > b.t ? 1 : 0);
  check(bridges.length === semj.bridges && bridges.every(b => b.m), bridges.length + ' crosswalk bridges traced to mapping proposals');
  const own = refs.subjects(NS + 'isClassifiedBy', null).sort((a, b) => a.value < b.value ? -1 : 1).map(s => ({
    iri: str(s), types: sort(refs.objects(s, RDF + 'type').map(o => curie(str(o)))), by: sort(refs.objects(s, NS + 'isClassifiedBy').map(o => local(str(o), CONCEPTS))), why: refs.text(s, RDFS + 'comment'),
  }));
  const aligned = (rows: readonly Value[], withPeers = false): Row[] => rows.map(row => {
    const [s, targets, why] = row, have = sort(al.objects(expand(s, PFX), RDFS + 'subClassOf').filter(o => o.termType === 'NamedNode').map(o => curie(str(o))));
    if (JSON.stringify(sort([...targets])) !== JSON.stringify(have)) failures.push(s + ': published alignment differs from semantic source');
    const rec: Row = { s, t: [...targets], why }; if (withPeers && row[3]?.length) rec.peers = [...row[3]]; return rec;
  });
  const semRecords = aligned(SEMM.RECORDS), semInterego = aligned(SEMM.INTEREGO), semFoxxi = aligned(SEMM.FOXXI, true);
  check(!failures.some(f => f.includes('published alignment') || f.startsWith('category ')), 'records, Interego and Foxxi alignments match the published graph');
  const pick = (r: Row, keys: string[]): Row => Object.fromEntries(keys.map(k => [k, r[k]]));
  const snap = json(join(EV, 'upper', 'manifest.json'));
  const semantic = {
    columns: SEMM.COLUMNS.map(([id, label]) => ({ id, label })), vocabs: SEMM.VOCABS.map((v: Value) => ({ p: v.prefix, col: v.column, kind: v.kind, title: v.title, short: v.short, home: v.home, ns: SEMM.PREFIXES[v.prefix] })),
    categories: semCats, prefixes: PFX, bridges, own, records: semRecords, interego: semInterego, foxxi: semFoxxi,
    props: SEMM.PROPERTIES.map(([s, p, o, why]) => ({ s, p, o, why })), labels: semj.labels, disjoint: semj.disjoint,
    snapshots: snap.sources.map((s: Row) => Object.fromEntries(['key', 'version', 'license', 'url', 'sha256', 'mode', 'kept', 'triples'].map(k => [k, s[k] ?? null]))),
    example: readFileSync(join(root, 'examples', 'industry-context.ttl'), 'utf8'), clash: readFileSync(join(root, 'examples', 'industry-context-clash.ttl'), 'utf8'),
    reasoning: { owlrl: { ...pick(semj.owlrl, ['input', 'closed', 'seconds']), errors: semj.owlrl.errors.length }, records: semj.records, conceptLevel: semj.conceptLevel, hermit: semj.hermit,
      rules: semj.rules, classify: pick(semj.classify, ['typings', 'sampleTypings', 'sound', 'complete']), classifyByResource: semj.classify.byResource, disjointCheck: semj.disjointCheck,
      clash: semj.clash.rejectedBy, expected: semj.expected, terms: semj.terms, byVocabulary: semj.byVocabulary, byBasis: semj.byBasis },
  };
  check(semantic.reasoning.classify.sound && semantic.reasoning.classify.complete && semantic.reasoning.rules.agree && semantic.reasoning.disjointCheck.agree, 'reasoning record reports query, rules and disjointness agreement with OWL 2 RL');
  const built = options.now || process.env.I2IDLX_NOW || new Date().toISOString().replace(/\.\d{3}Z$/, '+00:00');
  // Rights text is committed too: a modified local licence must never be attributed to the pinned commit.
  const dataLicense = git('show', commitSha + ':DATA-LICENSE.md'), holder = /^©[^\n]+$/mu.exec(dataLicense)?.[0].trim();
  if (!holder) throw new Error('No copyright holder in committed DATA-LICENSE.md');
  const meta = {
    app: 'Interpretant', version: cfg.version, built, release, commit: commitSha, commitDate, repo: cfg.i2idl.repo,
    scheme: { iri: I2IDL + 'scheme', title: scheme['dcterms:title'], rights: clean(scheme['dcterms:rights']), publisher: ids(scheme['dcterms:publisher'])[0], profile: get(scheme, 'gs:semanticProfileVersion'), status: get(scheme, 'gs:editorialStatus') },
    license: { holder, name: 'CC BY 4.0', url: 'https://creativecommons.org/licenses/by/4.0/', file: cfg.i2idl.repo + '/blob/' + commitSha + '/DATA-LICENSE.md' },
    endpoint: ENDPOINT, human: 'https://www.i2idl.org/glossary', jsonld: I2IDL + 'glossary.jsonld', ns: NS, base: BASE, iri: IRI, shapes: IRI.shapes, actionRoot: ACTION_ROOT, foxxiManifest: cfg.foxxiManifest, relayOps: 'https://relay.interego.xwisee.com/.well-known/operations', graphs, limits,
    counts: { concepts: concepts.length, evidence: nEv, sources: sources.length, related: Math.floor(concepts.reduce((n, c) => n + c.r.length, 0) / 2), broader: concepts.reduce((n, c) => n + c.b.length, 0), altLabels: concepts.reduce((n, c) => n + c.a.length, 0),
      enactments: enactments.length, mappings: mappings.length, roleCaps: roleCaps.length, inherited: inherited.length, actions: Object.keys(actions).length, releases: releases.length, grounded: concepts.filter(c => c.pv === 'g').length,
      links: annotation.links, suggestions: annotation.suggestions.length, unesco: nUnesco, ownCrosswalks: nOwn, ownUnesco: concepts.reduce((n, c) => n + (c.xm || []).filter((x: Value[]) => x[1].startsWith('http://vocabularies.unesco.org/')).length, 0), adopted: adoptedOf.size },
    neighborhoodQuery: neighQ, changes: changesMeta, upstream, unesco: unescoMeta, origins,
  };
  const runFile = join(root, 'examples', 'orchestra', 'kestrel-point-run.json'), orchestra = existsSync(runFile) ? json(runFile) : null;
  if (orchestra) check(orchestra.v === 1 && orchestra.events.every((e: Row) => ['step', 'say', 'call', 'result', 'decision'].includes(e.k)), 'recorded run has known event kinds');
  const data: Row = { meta, kinds, roles, statuses, methods, interrogatives, collections, sources, concepts, actions, enactments, inherited, roleCaps, mappings, releases, ports, queries, suggestions: annotation.suggestions, changeKinds, forms: annotation.forms, semantic, orchestra };
  mkdirSync(OUTPUT, { recursive: true }); const out = join(OUTPUT, 'data.json'); writeFileSync(out, JSON.stringify(data));
  if (failures.length) throw new Error('App data validation failed:\n' + failures.slice(0, 40).join('\n'));
  if (options.dataOnly) return data;
  execFileSync(process.env.NODE || process.execPath, [join(APP, 'tools', 'layout.mjs'), out, join(OUTPUT, 'layout.json')], { cwd: APP, stdio: 'inherit' });
  const layout = json(join(OUTPUT, 'layout.json'));
  check(JSON.stringify(sort(Object.keys(layout.xy))) === JSON.stringify(sort(concepts.map(c => c.id))), 'every concept has a place on the map');
  data.layout = layout; writeFileSync(out, JSON.stringify(data));
  const bundle = join(OUTPUT, 'app.js'), esbuild = requireApp('esbuild');
  await esbuild.build({ entryPoints: [join(APP, 'src', 'main.jsx')], bundle: true, format: 'iife', jsxFactory: 'React.createElement', jsxFragment: 'React.Fragment', target: 'es2020', minify: true, legalComments: 'none', logLevel: 'warning', outfile: bundle });
  const inlineJson = (obj: unknown): string => JSON.stringify(obj).replace(/<\//g, '<\\/').replace(/<!--/g, '<\\!--');
  const inlineJs = (s: string): string => s.replace(/<\/script/g, '<\\/script');
  const cdn = ['https://cdnjs.cloudflare.com/ajax/libs/react/18.3.1/umd/react.production.min.js', 'https://cdnjs.cloudflare.com/ajax/libs/react-dom/18.3.1/umd/react-dom.production.min.js', 'https://cdnjs.cloudflare.com/ajax/libs/d3/7.9.0/d3.min.js'];
  const fonts = 'https://fonts.googleapis.com/css2?family=Newsreader:ital,opsz,wght@0,6..72,400;0,6..72,500;0,6..72,600;1,6..72,400&family=Red+Hat+Display:wght@500;700;800&family=Red+Hat+Mono:wght@400;500&family=Red+Hat+Text:wght@400;500;600;700&display=swap';
  const page = '<!doctype html>\n<html lang="en">\n<head>\n<meta charset="utf-8">\n<meta name="viewport" content="width=device-width,initial-scale=1">\n<title>Interpretant Glossary Workbench</title>\n<meta name="description" content="A workbench for the I2IDL Digital Learning Glossary (' + release + '), decorated with the Interego and Foxxi layer I2IDL-X.">\n' +
    '<link rel="preconnect" href="https://fonts.googleapis.com">\n<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>\n<link rel="stylesheet" href="' + fonts + '">\n<style>\n' + readFileSync(join(APP, 'src', 'styles.css'), 'utf8') +
    '\n</style>\n</head>\n<body>\n<div id="root"><noscript><p style="padding:24px;font-family:system-ui">Interpretant needs JavaScript. The glossary itself is at <a href="https://www.i2idl.org/glossary">i2idl.org/glossary</a>.</p></noscript></div>\n' +
    '<script type="application/json" id="i2-data">' + inlineJson(data) + '</script>\n<script>window.__APP_URL__ = ' + inlineJson(cfg.appArtifactUrl || '') + ';</script>\n' +
    cdn.map(u => '<script src="' + u + '" crossorigin="anonymous"></script>\n').join('') + '<script>\n' + inlineJs(readFileSync(bundle, 'utf8')) + '\n</script>\n</body>\n</html>\n';
  mkdirSync(SITE, { recursive: true }); writeFileSync(join(SITE, 'app.html'), page);
  check(Buffer.byteLength(page) < 16000000, 'workbench HTML is below the 16 MB artifact limit');
  if (failures.length) throw new Error(failures.join('\n'));
  process.stdout.write('wrote ' + join(SITE, 'app.html') + '\n'); return data;
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const args = process.argv.slice(2), root = args[0]?.startsWith('-') ? undefined : args[0];
  const opt = (name: string): string | undefined => { const at = args.indexOf(name); return at < 0 ? undefined : args[at + 1]; };
  await buildApp(root, { distDir: opt('--dist'), outputDir: opt('--out'), siteDir: opt('--site'), dataOnly: args.includes('--data-only') });
}
