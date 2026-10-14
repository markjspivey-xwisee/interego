/**
 * Native TypeScript derivation of the public I2IDL release history.
 * Keep event insertion order and Python tuple ordering: consumers hash/group events.
 */
import { execFileSync } from 'node:child_process';

export type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };
export type JsonObject = { [key: string]: JsonValue };
export const KINDS: readonly (readonly [string, string, string])[] = [["concept-added","Concept added","A concept IRI first appears in the release."],["concept-removed","Concept removed","A concept IRI present in the previous release is absent."],["label-changed","Preferred label changed","The concept's skos:prefLabel differs from the previous release."],["alt-label-added","Alternative label added","A skos:altLabel was added to the concept."],["alt-label-removed","Alternative label removed","A skos:altLabel was removed from the concept."],["definition-revised","Definition revised","The concept's skos:definition text differs from the previous release."],["explanation-revised","Editorial explanation revised","The concept's gs:editorialExplanation differs from the previous release."],["type-changed","Type changed","The concept's gs:typeCollection differs from the previous release."],["field-changed","Primary field changed","The concept's gs:fieldCollection differs from the previous release."],["status-changed","Editorial status changed","The concept's gs:editorialStatus differs from the previous release."],["relationship-added","Relationship added","A skos:related pair or a skos:broader / skos:narrower pair is new in the release."],["relationship-removed","Relationship removed","A skos:related or skos:broader / skos:narrower pair of the previous release is absent."],["membership-added","Collection membership added","A concept became a skos:member of a collection."],["membership-removed","Collection membership removed","A concept stopped being a skos:member of a collection."],["collection-added","Collection added","A skos:Collection first appears in the release."],["collection-removed","Collection removed","A skos:Collection of the previous release is absent."],["collection-revised","Collection revised","A collection's label, facet or description differs from the previous release."],["source-added","Source added","A source (dcterms:BibliographicResource) first appears in the release."],["source-removed","Source removed","A source of the previous release is absent."],["source-revised","Source revised","A source's title, URL or rights statement differs from the previous release."],["evidence-added","Evidence added","An evidence record (source + citation) was added to a concept's active definition."],["evidence-removed","Evidence removed","An evidence record was removed from a concept's active definition."],["evidence-classified","Evidence classified","An evidence record received its first evidence relation (direct or supporting)."],["evidence-reclassified","Evidence reclassified","An evidence record's relation changed (for example supporting to direct)."],["external-mapping-added","External mapping added","I2IDL's record asserts a new crosswalk from a concept to a term of an external vocabulary (skos:exactMatch, closeMatch, broadMatch, narrowMatch or relatedMatch)."],["external-mapping-revised","External mapping revised","An asserted crosswalk changed its mapping property, or I2IDL withdrew it."],["association-added","Ontology association added","A proposed association from a concept to a term of an external ontology (gs:externalOntologyAssociations) was added."],["association-revised","Ontology association revised","A proposed association's label, note, target kind or review status changed."],["association-removed","Ontology association removed","A proposed association was removed."]];
export const KIND_CODES = KINDS.map(([code]) => code);
export const REL_PROPS = ['skos:broader', 'skos:narrower', 'skos:related'] as const;
export const MATCH_PROPS = ['skos:exactMatch', 'skos:closeMatch', 'skos:broadMatch', 'skos:narrowMatch', 'skos:relatedMatch'] as const;

export interface ConceptSnapshot {
  label: JsonValue; alt: Set<JsonValue>; definition: JsonValue; explanation: JsonValue;
  type: JsonValue; field: JsonValue; status: JsonValue;
  rel: Record<(typeof REL_PROPS)[number], Set<string>>;
  /** JSON-encoded [source, citation, duplicateOrdinal] keys. */
  ev: Map<string, JsonValue>;
  match: Map<string, Set<string>>;
  /** JSON-encoded [target, associationType] keys. */
  assoc: Map<string, JsonObject>;
}
export interface Snapshot {
  version: string;
  concepts: Record<string, ConceptSnapshot>;
  sources: Record<string, JsonObject>;
  collections: Record<string, { members: Set<string>; meta: JsonObject }>;
}
export interface HistoryEvent {
  kind: string; concept?: string; collection?: string; source?: JsonValue;
  property?: string; a?: string; b?: string; target?: JsonValue;
  prior?: JsonValue; new?: JsonValue; status?: JsonValue;
  fields?: Record<string, [JsonValue, JsonValue]>;
}
export interface Release {
  version: string; commits: number; commit: string; date: string; snap: Snapshot;
  events: HistoryEvent[]; previous: string | null;
}
export type Totals = Record<'concepts' | 'related' | 'broader' | 'memberships' | 'evidence' | 'sources' | 'collections' | 'mappings' | 'associations', number>;
type Pair = readonly [string, string];

export function aslist<T>(value: T | T[] | null | undefined): T[] {
  return value == null ? [] : Array.isArray(value) ? value : [value];
}
function object(value: JsonValue | undefined): JsonObject | null {
  return value != null && typeof value === 'object' && !Array.isArray(value) ? value : null;
}
export function ids(value: JsonValue | undefined): string[] {
  return aslist(value).map(x => (object(x)?.['@id'] ?? x) as string);
}
function get(record: JsonObject, key: string): JsonValue { return record[key] ?? null; }
function truthy(value: JsonValue | undefined): boolean {
  if (value == null || value === false || value === '' || value === 0) return false;
  if (Array.isArray(value)) return value.length !== 0;
  if (typeof value === 'object') return Object.keys(value).length !== 0;
  return true;
}
/** Python compares strings by Unicode code points, independently of locale. */
export function compareText(a: string, b: string): number {
  const aa = Array.from(a), bb = Array.from(b);
  for (let i = 0; i < Math.min(aa.length, bb.length); i++) {
    const d = aa[i]!.codePointAt(0)! - bb[i]!.codePointAt(0)!;
    if (d) return d;
  }
  return aa.length - bb.length;
}
function sorted(values: Iterable<string>): string[] { return [...values].sort(compareText); }
function difference<T>(a: ReadonlySet<T>, b: ReadonlySet<T>): Set<T> {
  return new Set([...a].filter(x => !b.has(x)));
}
function intersection<T>(a: ReadonlySet<T>, b: ReadonlySet<T>): Set<T> {
  return new Set([...a].filter(x => b.has(x)));
}
function equal(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (a == null || b == null || typeof a !== typeof b) return false;
  if (a instanceof Set && b instanceof Set) {
    return a.size === b.size && [...a].every(v => [...b].some(w => equal(v, w)));
  }
  if (Array.isArray(a) || Array.isArray(b)) {
    return Array.isArray(a) && Array.isArray(b) && a.length === b.length && a.every((v, i) => equal(v, b[i]));
  }
  if (typeof a === 'object' && typeof b === 'object') {
    const aa = a as Record<string, unknown>, bb = b as Record<string, unknown>;
    const aks = Object.keys(aa), bks = Object.keys(bb);
    return aks.length === bks.length && aks.every(k => Object.hasOwn(bb, k) && equal(aa[k], bb[k]));
  }
  return false;
}
/** Python repr for JSON-shaped values (used for deterministic history keys/events). */
export function pyRepr(value: unknown): string {
  if (value == null) return 'None';
  if (typeof value === 'boolean') return value ? 'True' : 'False';
  if (typeof value === 'number') return String(value);
  if (typeof value === 'string') {
    const quote = value.includes("'") && !value.includes('"') ? '"' : "'";
    let out = quote;
    for (const ch of value) {
      const cp = ch.codePointAt(0)!;
      if (ch === '\\' || ch === quote) out += '\\' + ch;
      else if (ch === '\t') out += '\\t';
      else if (ch === '\n') out += '\\n';
      else if (ch === '\r') out += '\\r';
      else if (cp < 32 || cp === 127 || (ch !== ' ' && /[\p{C}\p{Z}]/u.test(ch))) {
        if (cp <= 255) out += '\\x' + cp.toString(16).padStart(2, '0');
        else if (cp <= 65535) out += '\\u' + cp.toString(16).padStart(4, '0');
        else out += '\\U' + cp.toString(16).padStart(8, '0');
      } else out += ch;
    }
    return out + quote;
  }
  if (Array.isArray(value)) return '[' + value.map(pyRepr).join(', ') + ']';
  if (typeof value === 'object') {
    return '{' + Object.entries(value).map(([key, v]) => pyRepr(key) + ': ' + pyRepr(v)).join(', ') + '}';
  }
  throw new TypeError('Python representation requires a JSON-shaped value');
}
export function pyTupleRepr(tuple: readonly unknown[]): string {
  return '(' + tuple.map(pyRepr).join(', ') + (tuple.length === 1 ? ',' : '') + ')';
}
/** Event fields are Python tuples, while other JSON arrays remain Python lists. */
export function pyEventRepr(event: HistoryEvent): string {
  return '{' + Object.entries(event).map(([key, value]) => {
    const repr = key === 'fields' && value != null
      ? '{' + Object.entries(value as Record<string, [JsonValue, JsonValue]>)
          .map(([property, pair]) => pyRepr(property) + ': ' + pyTupleRepr(pair)).join(', ') + '}'
      : pyRepr(value);
    return pyRepr(key) + ': ' + repr;
  }).join(', ') + '}';
}
function encode(tuple: readonly JsonValue[]): string { return JSON.stringify(tuple); }
function decode(key: string): JsonValue[] { return JSON.parse(key) as JsonValue[]; }
function tupleCompare(a: string, b: string): number {
  const aa = decode(a), bb = decode(b);
  for (let i = 0; i < Math.min(aa.length, bb.length); i++) {
    if (aa[i] === bb[i]) continue;
    if (typeof aa[i] === 'string' && typeof bb[i] === 'string') return compareText(aa[i] as string, bb[i] as string);
    if (typeof aa[i] === 'number' && typeof bb[i] === 'number') return (aa[i] as number) - (bb[i] as number);
    throw new TypeError('Unorderable I2IDL tuple values');
  }
  return aa.length - bb.length;
}
function reprSorted(keys: Iterable<string>): string[] {
  return [...keys].sort((a, b) => compareText(pyTupleRepr(decode(a)), pyTupleRepr(decode(b))));
}
function keyset(map: Map<string, unknown>): Set<string> { return new Set(map.keys()); }

export function snapshot(doc: JsonObject): Snapshot {
  const graph = aslist(doc['@graph']).map(object).filter((n): n is JsonObject => n !== null);
  const by = new Map(graph.map(n => [n['@id'], n]));
  const s: Snapshot = { version: '?', concepts: {}, sources: {}, collections: {} };
  for (const n of graph) {
    const types = aslist(n['@type']);
    if (types.includes('skos:ConceptScheme')) s.version = (n['gs:publicationVersion'] ?? '?') as string;
    else if (types.includes('dcterms:BibliographicResource')) {
      s.sources[n['@id'] as string] = Object.fromEntries(Object.entries(n).filter(([k]) => k !== '@id'));
    } else if (types.includes('skos:Collection')) {
      s.collections[n['@id'] as string] = {
        members: new Set(ids(n['skos:member'])),
        meta: Object.fromEntries(Object.entries(n).filter(([k]) => k !== '@id' && k !== 'skos:member')),
      };
    }
  }
  for (const n of graph) {
    if (!aslist(n['@type']).includes('skos:Concept')) continue;
    const ad = ids(n['gs:activeDefinition']), dn = ad.length ? by.get(ad[0]!) : undefined;
    const ev = new Map<string, JsonValue>();
    for (const evidenceRecord of aslist(dn?.['gs:evidence'])) {
      const e = object(evidenceRecord);
      if (e === null) throw new TypeError('I2IDL evidence records must be objects');
      const src = ids(e['dcterms:source']);
      const base: JsonValue[] = [src[0] ?? null, truthy(e['gs:citationDetail']) ? e['gs:citationDetail']! : ''];
      let ordinal = 0;
      while (ev.has(encode([...base, ordinal]))) ordinal++;
      ev.set(encode([...base, ordinal]), get(e, 'gs:evidenceRelation'));
    }
    const match = new Map<string, Set<string>>();
    for (const prop of MATCH_PROPS) for (const target of ids(n[prop])) {
      if (!match.has(target)) match.set(target, new Set());
      match.get(target)!.add(prop);
    }
    const assoc = new Map<string, JsonObject>();
    for (const associationRecord of aslist(n['gs:externalOntologyAssociations'])) {
      const a = object(associationRecord);
      if (!a) continue;
      assoc.set(encode([ids(a['gs:target'])[0] ?? null, get(a, 'gs:associationType')]),
        Object.fromEntries(Object.entries(a).filter(([k]) => k !== 'gs:target' && k !== 'gs:associationType')));
    }
    s.concepts[n['@id'] as string] = {
      label: get(n, 'skos:prefLabel'), alt: new Set(aslist(n['skos:altLabel'])),
      definition: get(n, 'skos:definition'), explanation: get(n, 'gs:editorialExplanation'),
      type: ids(n['gs:typeCollection'])[0] ?? null, field: ids(n['gs:fieldCollection'])[0] ?? null,
      status: get(n, 'gs:editorialStatus'),
      rel: {
        'skos:broader': new Set(ids(n['skos:broader'])),
        'skos:narrower': new Set(ids(n['skos:narrower'])),
        'skos:related': new Set(ids(n['skos:related'])),
      }, ev, match, assoc,
    };
  }
  return s;
}
/** Encoded tuple sets prevent identity-based duplicate pairs in JavaScript. */
export function pairs(s: Snapshot): Record<'skos:related' | 'skos:broader', Set<string>> {
  const related = new Set<string>(), broader = new Set<string>();
  for (const [c, x] of Object.entries(s.concepts)) {
    for (const o of x.rel['skos:related']) related.add(encode([c, o].sort(compareText)));
    for (const o of x.rel['skos:broader']) broader.add(encode([c, o]));
    for (const o of x.rel['skos:narrower']) broader.add(encode([o, c]));
  }
  return { 'skos:related': related, 'skos:broader': broader };
}
export function memberships(s: Snapshot): Set<string> {
  const result = new Set<string>();
  for (const [col, x] of Object.entries(s.collections)) for (const m of x.members) result.add(encode([m, col]));
  return result;
}
export function evidence(s: Snapshot): Map<string, JsonValue> {
  const result = new Map<string, JsonValue>();
  for (const [c, x] of Object.entries(s.concepts)) for (const [k, rel] of x.ev) result.set(encode([c, ...decode(k)]), rel);
  return result;
}
export function mappings(s: Snapshot): Map<string, Set<string>> {
  const result = new Map<string, Set<string>>();
  for (const [c, x] of Object.entries(s.concepts)) for (const [t, ps] of x.match) result.set(encode([c, t]), ps);
  return result;
}
export function associations(s: Snapshot): Map<string, JsonObject> {
  const result = new Map<string, JsonObject>();
  for (const [c, x] of Object.entries(s.concepts)) for (const [k, v] of x.assoc) result.set(encode([c, ...decode(k)]), v);
  return result;
}
export function changed_fields(a: JsonObject, b: JsonObject): Record<string, [JsonValue, JsonValue]> {
  const out: Record<string, [JsonValue, JsonValue]> = {};
  for (const k of sorted(new Set([...Object.keys(a), ...Object.keys(b)]))) {
    if (!equal(get(a, k), get(b, k))) out[k] = [get(a, k), get(b, k)];
  }
  return out;
}
export function diff(p: Snapshot, s: Snapshot): HistoryEvent[] {
  const ev: HistoryEvent[] = [], pc = p.concepts, sc = s.concepts;
  const pk = new Set(Object.keys(pc)), sk = new Set(Object.keys(sc));
  for (const c of sorted(difference(sk, pk))) ev.push({ kind: 'concept-added', concept: c });
  for (const c of sorted(difference(pk, sk))) ev.push({ kind: 'concept-removed', concept: c });
  const scalarKinds = [
    ['label', 'label-changed'], ['definition', 'definition-revised'], ['explanation', 'explanation-revised'],
    ['type', 'type-changed'], ['field', 'field-changed'], ['status', 'status-changed'],
  ] as const;
  for (const c of sorted(intersection(sk, pk))) {
    const a = pc[c]!, b = sc[c]!;
    for (const [field, kind] of scalarKinds) if (!equal(a[field], b[field])) {
      ev.push({ kind, concept: c, prior: a[field], new: b[field] });
    }
    for (const alt of [...difference(b.alt, a.alt)].sort((a, b) => compareText(a as string, b as string))) {
      ev.push({ kind: 'alt-label-added', concept: c, new: alt });
    }
    for (const alt of [...difference(a.alt, b.alt)].sort((a, b) => compareText(a as string, b as string))) {
      ev.push({ kind: 'alt-label-removed', concept: c, prior: alt });
    }
  }
  const pp = pairs(p), sp = pairs(s);
  for (const prop of ['skos:related', 'skos:broader'] as const) {
    for (const key of [...difference(sp[prop], pp[prop])].sort(tupleCompare)) {
      const [x, y] = decode(key) as unknown as Pair;
      ev.push({ kind: 'relationship-added', property: prop, a: x, b: y });
    }
    for (const key of [...difference(pp[prop], sp[prop])].sort(tupleCompare)) {
      const [x, y] = decode(key) as unknown as Pair;
      ev.push({ kind: 'relationship-removed', property: prop, a: x, b: y });
    }
  }
  const pm = memberships(p), sm = memberships(s);
  for (const key of [...difference(sm, pm)].sort(tupleCompare)) {
    const [m, col] = decode(key) as unknown as Pair;
    ev.push({ kind: 'membership-added', concept: m, collection: col });
  }
  for (const key of [...difference(pm, sm)].sort(tupleCompare)) {
    const [m, col] = decode(key) as unknown as Pair;
    ev.push({ kind: 'membership-removed', concept: m, collection: col });
  }
  for (const [name, label] of [['collections', 'collection'], ['sources', 'source']] as const) {
    const before = p[name], after = s[name], bk = new Set(Object.keys(before)), ak = new Set(Object.keys(after));
    for (const id of sorted(difference(ak, bk))) ev.push({ kind: label + '-added', [label]: id });
    for (const id of sorted(difference(bk, ak))) ev.push({ kind: label + '-removed', [label]: id });
    for (const id of sorted(intersection(ak, bk))) {
      const a = name === 'collections' ? p.collections[id]!.meta : p.sources[id]!;
      const b = name === 'collections' ? s.collections[id]!.meta : s.sources[id]!;
      if (!equal(a, b)) ev.push({ kind: label + '-revised', [label]: id, fields: changed_fields(a, b) });
    }
  }
  const pe = evidence(p), se = evidence(s);
  for (const key of reprSorted(difference(keyset(se), keyset(pe)))) {
    const k = decode(key);
    ev.push({ kind: 'evidence-added', concept: k[0] as string, source: k[1]!, new: se.get(key)! });
  }
  for (const key of reprSorted(difference(keyset(pe), keyset(se)))) {
    const k = decode(key);
    ev.push({ kind: 'evidence-removed', concept: k[0] as string, source: k[1]!, prior: pe.get(key)! });
  }
  for (const key of reprSorted(intersection(keyset(se), keyset(pe)))) {
    const before = pe.get(key)!, after = se.get(key)!;
    if (!equal(after, before)) {
      const k = decode(key), kind = before === null ? 'evidence-classified' : 'evidence-reclassified';
      ev.push({ kind, concept: k[0] as string, source: k[1]!, prior: before, new: truthy(after) ? after : 'unclassified' });
    }
  }
  const pmx = mappings(p), smx = mappings(s);
  for (const key of [...difference(keyset(smx), keyset(pmx))].sort(tupleCompare)) {
    const [c, t] = decode(key);
    for (const prop of sorted(smx.get(key)!)) ev.push({ kind: 'external-mapping-added', concept: c as string, target: t!, new: prop });
  }
  for (const key of [...new Set([...pmx.keys(), ...smx.keys()])].sort(tupleCompare)) {
    const before = pmx.get(key), after = smx.get(key);
    if (before?.size && !equal(before, after)) {
      const [c, t] = decode(key);
      ev.push({ kind: 'external-mapping-revised', concept: c as string, target: t!,
        prior: sorted(before).join(' '), new: after?.size ? sorted(after).join(' ') : null });
    }
  }
  const pa = associations(p), sa = associations(s);
  for (const key of reprSorted(difference(keyset(sa), keyset(pa)))) {
    const k = decode(key);
    ev.push({ kind: 'association-added', concept: k[0] as string, target: k[1]!, new: k[2]!, status: get(sa.get(key)!, 'gs:reviewStatus') });
  }
  for (const key of reprSorted(intersection(keyset(pa), keyset(sa)))) {
    if (!equal(pa.get(key), sa.get(key))) {
      const k = decode(key);
      ev.push({ kind: 'association-revised', concept: k[0] as string, target: k[1]!, new: k[2]!, fields: changed_fields(pa.get(key)!, sa.get(key)!) });
    }
  }
  for (const key of reprSorted(difference(keyset(pa), keyset(sa)))) {
    const k = decode(key);
    ev.push({ kind: 'association-removed', concept: k[0] as string, target: k[1]!, prior: k[2]! });
  }
  return ev;
}
export function releases(clone: string, gpath: string): Release[] {
  const sh = (args: string[]): string => execFileSync('git', args, { cwd: clone, encoding: 'utf8', maxBuffer: 128 * 1024 * 1024 });
  const byVersion = new Map<string, Release>();
  for (const line of sh(['log', '--reverse', '--format=%H %cI', '--', gpath]).split('\n').filter(Boolean)) {
    const i = line.indexOf(' '), commit = line.slice(0, i), date = line.slice(i + 1);
    const snap = snapshot(JSON.parse(sh(['show', commit + ':' + gpath])) as JsonObject);
    let entry = byVersion.get(snap.version);
    if (!entry) {
      entry = { version: snap.version, commits: 0, commit, date, snap, events: [], previous: null };
      byVersion.set(snap.version, entry);
    }
    Object.assign(entry, { commit, date, snap });
    entry.commits++;
  }
  const out = [...byVersion.values()];
  for (let i = 1; i < out.length; i++) {
    out[i]!.events = diff(out[i - 1]!.snap, out[i]!.snap);
    out[i]!.previous = out[i - 1]!.version;
  }
  return out;
}
export function touched(e: HistoryEvent): string[] {
  return Object.hasOwn(e, 'a') ? [e.a!, e.b!] : Object.hasOwn(e, 'concept') ? [e.concept!] : [];
}
export function totals(s: Snapshot): Totals {
  const p = pairs(s);
  return { concepts: Object.keys(s.concepts).length, related: p['skos:related'].size, broader: p['skos:broader'].size,
    memberships: memberships(s).size, evidence: evidence(s).size, sources: Object.keys(s.sources).length,
    collections: Object.keys(s.collections).length, mappings: mappings(s).size, associations: associations(s).size };
}
export function reconcile(rels: Release[]): Record<string, [number, number]> {
  if (rels.length === 0) throw new RangeError('Reconciliation requires at least one release');
  const first = totals(rels[0]!.snap), last = totals(rels.at(-1)!.snap);
  const signed = {
    concepts: ['concept-added', 'concept-removed'], memberships: ['membership-added', 'membership-removed'],
    evidence: ['evidence-added', 'evidence-removed'], sources: ['source-added', 'source-removed'],
    collections: ['collection-added', 'collection-removed'], associations: ['association-added', 'association-removed'],
  } as const;
  const out: Record<string, [number, number]> = {};
  for (const [name, [plus, minus]] of Object.entries(signed)) {
    let n = first[name as keyof Totals];
    for (const r of rels.slice(1)) for (const e of r.events) n += e.kind === plus ? 1 : e.kind === minus ? -1 : 0;
    out[name] = [n, last[name as keyof Totals]];
  }
  for (const [name, prop] of [['related', 'skos:related'], ['broader', 'skos:broader']] as const) {
    let n = first[name];
    for (const r of rels.slice(1)) for (const e of r.events) if (e.property === prop) {
      n += e.kind === 'relationship-added' ? 1 : e.kind === 'relationship-removed' ? -1 : 0;
    }
    out[name] = [n, last[name]];
  }
  // Preserve Python's event-count accounting for asserted mapping additions.
  let n = first.mappings;
  for (const r of rels.slice(1)) for (const e of r.events) {
    if (e.kind === 'external-mapping-added') n++;
    else if (e.kind === 'external-mapping-revised' && e.new === null) n--;
  }
  out.mappings = [n, last.mappings];
  return out;
}
/** Stable JSON projection for the one-time Python/TypeScript parity oracle. */
export function serializeSnapshot(s: Snapshot): JsonObject {
  const concepts: JsonObject = {}, collections: JsonObject = {};
  for (const c of sorted(Object.keys(s.concepts))) {
    const x = s.concepts[c]!;
    concepts[c] = { label: x.label, alt: [...x.alt].sort((a, b) => compareText(a as string, b as string)),
      definition: x.definition, explanation: x.explanation, type: x.type, field: x.field, status: x.status,
      rel: Object.fromEntries(REL_PROPS.map(p => [p, sorted(x.rel[p])])),
      ev: reprSorted(x.ev.keys()).map(k => [decode(k), x.ev.get(k)!]),
      match: sorted(x.match.keys()).map(k => [k, sorted(x.match.get(k)!)]),
      assoc: reprSorted(x.assoc.keys()).map(k => [decode(k), x.assoc.get(k)!]) };
  }
  for (const col of sorted(Object.keys(s.collections))) {
    collections[col] = { members: sorted(s.collections[col]!.members), meta: s.collections[col]!.meta };
  }
  return { version: s.version, concepts, sources: s.sources, collections };
}
