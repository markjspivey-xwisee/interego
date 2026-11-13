/**
 * The Profile Server's RDF dataset (xAPI Profiles, Part Three, section 1).
 *
 *   - every profile version sits in a named graph whose IRI is the version's IRI;
 *   - the default graph holds the current version of every profile;
 *   - both carry the inferred triples, so `skos:inScheme` answers for concepts, templates and
 *     patterns alike, and SKOS relationships answer in both directions.
 *
 * The graphs are @interego/pgsl triple stores and the queries run on that package's SPARQL engine,
 * the same one the lattice is queried with. That engine evaluates SELECT and ASK over basic graph
 * patterns with OPTIONAL, UNION, FILTER, VALUES, GROUP BY, ORDER BY and LIMIT. What it does not
 * evaluate it used to pass over in silence, so this module refuses those forms by name instead of
 * returning an answer to a different question.
 */
import { createTripleStore, addTriples, executeSparqlString, type Triple, type TripleStore } from '@interego/pgsl';
import { inferred, profileTriples, toRdfTerm, versionsOf, type Json, type ProfileVersion, type RdfTerm } from './rdf.js';

export interface HeldProfile {
  /** The profile's IRI. */
  readonly id: string;
  /** The IRI of the version this document is, which is also its named graph. */
  readonly version: string;
  readonly generatedAtTime?: string;
  readonly versions: readonly ProfileVersion[];
  /** The document exactly as it was given. */
  readonly doc: Json;
  readonly stated: readonly Triple[];
}

export class SparqlRefused extends Error {}

export interface SparqlAnswer {
  readonly head: { readonly vars?: readonly string[] };
  readonly results?: { readonly bindings: ReadonlyArray<Record<string, RdfTerm>> };
  readonly boolean?: boolean;
}

export interface QueryDataset { readonly defaultGraphUris?: readonly string[]; readonly namedGraphUris?: readonly string[] }

const storeOf = (stated: readonly Triple[]): TripleStore => {
  const store = createTripleStore();
  addTriples(store, [...stated, ...inferred(stated)]);
  return store;
};

export class ProfileDataset {
  /** version IRI → the document that is that version. */
  private readonly byVersion = new Map<string, HeldProfile>();
  private readonly graphs = new Map<string, TripleStore>();
  private defaultGraph: TripleStore | undefined;

  /** Hold a profile document. A version already held is replaced by the same version given again. */
  add(doc: Json): HeldProfile {
    const { versions, current } = versionsOf(doc);
    const id = (doc as { id: string }).id;
    const held: HeldProfile = {
      id, version: current.id, versions, doc,
      ...(current.generatedAtTime ? { generatedAtTime: current.generatedAtTime } : {}),
      stated: profileTriples(doc, current.id),
    };
    this.byVersion.set(held.version, held);
    this.graphs.delete(held.version);
    this.defaultGraph = undefined;
    return held;
  }

  /** Stop holding every version of a profile, or one version. Returns the versions dropped. */
  remove(iri: string): string[] {
    const gone = [...this.byVersion.values()].filter(h => h.id === iri || h.version === iri).map(h => h.version);
    for (const v of gone) { this.byVersion.delete(v); this.graphs.delete(v); }
    if (gone.length > 0) this.defaultGraph = undefined;
    return gone;
  }

  /** Every held version, oldest first within a profile. */
  all(): HeldProfile[] { return [...this.byVersion.values()]; }

  /**
   * The current version of each profile: the held version no other held version of that profile
   * revises, the latest by date among those.
   */
  current(): HeldProfile[] {
    const byProfile = new Map<string, HeldProfile[]>();
    for (const h of this.byVersion.values()) byProfile.set(h.id, [...(byProfile.get(h.id) ?? []), h]);
    return [...byProfile.values()].map(held => {
      const revised = new Set(held.flatMap(h => h.versions.filter(v => v.id === h.version).flatMap(v => v.wasRevisionOf)));
      const heads = held.filter(h => !revised.has(h.version));
      return [...(heads.length > 0 ? heads : held)].sort((a, b) => (Date.parse(b.generatedAtTime ?? '') || 0) - (Date.parse(a.generatedAtTime ?? '') || 0))[0]!;
    });
  }

  /** A profile by its IRI (its current version) or by a version IRI. */
  get(iri: string): HeldProfile | undefined {
    return this.byVersion.get(iri) ?? this.current().find(h => h.id === iri);
  }

  graphNames(): string[] { return [...this.byVersion.keys()]; }

  private graph(version: string): TripleStore | undefined {
    const held = this.byVersion.get(version);
    if (!held) return undefined;
    let store = this.graphs.get(version);
    if (!store) { store = storeOf(held.stated); this.graphs.set(version, store); }
    return store;
  }

  /** The default graph: current versions together, inferred over the whole so a match between two profiles answers both ways. */
  private defaults(): TripleStore {
    return this.defaultGraph ??= storeOf(dedupe(this.current().flatMap(h => h.stated)));
  }

  private merged(iris: readonly string[]): TripleStore {
    if (iris.length === 1) return this.graph(iris[0]!) ?? createTripleStore();
    return storeOf(dedupe(iris.flatMap(i => this.byVersion.get(i)?.stated ?? [])));
  }

  /**
   * Answer a SPARQL query in the SPARQL 1.1 JSON results format.
   *
   * The dataset is the default graph unless the query says `FROM <version>`, wraps its pattern in
   * `GRAPH <version> { … }` or `GRAPH ?g { … }`, or the protocol's `default-graph-uri` is given.
   */
  query(text: string, dataset: QueryDataset = {}): SparqlAnswer {
    const q = prepare(text);
    const from = [...(dataset.defaultGraphUris ?? []), ...q.from];
    const run = (store: TripleStore) => {
      try { return executeSparqlString(store, q.text); }
      catch (e) { throw new SparqlRefused((e as Error).message); }
    };
    if (q.ask) {
      const stores = q.graph === undefined ? [from.length > 0 ? this.merged(from) : this.defaults()]
        : q.graph.startsWith('?') ? this.namedIn(dataset, q.fromNamed).map(g => this.graph(g)!) : [this.merged([q.graph])];
      return { head: {}, boolean: stores.some(s => run(s).boolean === true) };
    }
    let rows: Array<Map<string, string>>;
    if (q.graph === undefined) rows = run(from.length > 0 ? this.merged(from) : this.defaults()).bindings;
    else if (!q.graph.startsWith('?')) rows = run(this.merged([q.graph])).bindings;
    else {
      rows = [];
      for (const name of this.namedIn(dataset, q.fromNamed))
        for (const b of run(this.graph(name)!).bindings) rows.push(new Map([...b, [q.graph, name]]));
    }
    if (q.offset > 0) rows = rows.slice(q.offset);
    if (q.limit !== undefined) rows = rows.slice(0, q.limit);
    const vars = new Set<string>(q.vars);
    if (q.vars.length === 0) for (const b of rows) for (const k of b.keys()) vars.add(k.replace(/^\?/, ''));
    if (q.graph?.startsWith('?') && q.vars.length === 0) vars.add(q.graph.slice(1));
    return {
      head: { vars: [...vars] },
      results: { bindings: rows.map(b => Object.fromEntries([...b].filter(([k]) => vars.has(k.replace(/^\?/, ''))).map(([k, v]) => [k.replace(/^\?/, ''), toRdfTerm(v)]))) },
    };
  }

  private namedIn(dataset: QueryDataset, fromNamed: readonly string[]): string[] {
    const asked = [...(dataset.namedGraphUris ?? []), ...fromNamed];
    return asked.length > 0 ? asked.filter(g => this.byVersion.has(g)) : this.graphNames();
  }
}

function dedupe(triples: readonly Triple[]): Triple[] {
  const seen = new Set<string>();
  return triples.filter(t => { const k = `${t.subject}\u0000${t.predicate}\u0000${t.object}`; return seen.has(k) ? false : (seen.add(k), true); });
}

// ── Reading the query before the engine does ──────────────────────────────────────────────────

interface Prepared { text: string; ask: boolean; vars: string[]; from: string[]; fromNamed: string[]; graph?: string; offset: number; limit?: number }

/** The text with every IRI and string blanked to same-length filler, so keywords can be looked for safely. */
function masked(text: string): string {
  let out = '', i = 0;
  while (i < text.length) {
    const c = text[i]!;
    if (c === '<') {
      const end = text.indexOf('>', i);
      // `<` as a comparison has whitespace or `=` after it; an IRI does not.
      if (end > i && !/[\s=]/.test(text.slice(i + 1, end))) { out += `<${'x'.repeat(end - i - 1)}>`; i = end + 1; continue; }
    }
    if (c === '"' || c === "'") {
      let j = i + 1;
      while (j < text.length && text[j] !== c) j += text[j] === '\\' ? 2 : 1;
      out += `${c}${'x'.repeat(Math.max(0, j - i - 1))}${c}`; i = j + 1; continue;
    }
    if (c === '#') { const end = text.indexOf('\n', i); const stop = end < 0 ? text.length : end; out += ' '.repeat(stop - i); i = stop; continue; }
    out += c; i++;
  }
  return out;
}

const REFUSED: Array<[RegExp, string]> = [
  [/\b(INSERT|DELETE|LOAD|CLEAR|DROP|CREATE|COPY|MOVE|ADD)\b\s*(DATA|WHERE|SILENT|GRAPH|\{|<)/i, 'This endpoint answers queries; it does not take SPARQL Update. Profiles are added through the add-profile affordance.'],
  [/\b(CONSTRUCT|DESCRIBE)\b/i, 'CONSTRUCT and DESCRIBE are not evaluated here; SELECT and ASK are.'],
  [/\bSERVICE\b/i, 'Federated SERVICE patterns are not evaluated here.'],
  [/\bMINUS\b/i, 'MINUS is not evaluated here.'],
  [/\bEXISTS\b/i, 'EXISTS and NOT EXISTS are not evaluated here; OPTIONAL with FILTER(!BOUND(?v)) is.'],
  [/\bHAVING\b/i, 'HAVING is not evaluated here.'],
  [/\bSELECT\b[\s\S]*\bSELECT\b/i, 'Subqueries are not evaluated here.'],
  [/[\w>][+*?]?\s*[/^]\s*[\w<]|[\w>]\s*\|\s*[\w<]|[\w>:][+*](?=\s)|\s\^[\w<]/, 'Property paths are not evaluated here. The transitive SKOS relationships are already inferred: ask for skos:broaderTransitive or skos:narrowerTransitive.'],
];

function prepare(original: string): Prepared {
  if (typeof original !== 'string' || original.trim() === '') throw new SparqlRefused('No query was given.');
  if (original.length > 20_000) throw new SparqlRefused('The query is longer than 20,000 characters.');
  let text = original, mask = masked(original);
  // Splice the same edit into the text and its mask, which stay the same length throughout.
  const splice = (start: number, end: number, replacement: string) => {
    text = text.slice(0, start) + replacement + text.slice(end);
    mask = mask.slice(0, start) + replacement.replace(/[^\s{}]/g, ' ') + mask.slice(end);
  };
  const blank = (start: number, end: number) => splice(start, end, ' '.repeat(end - start));
  for (let i = 0; i < mask.length; i++) if (original[i] === '#' && mask[i] === ' ') { const e = mask.indexOf('\n', i); blank(i, e < 0 ? mask.length : e); }

  // Decimal points are not triple separators: 1.5 has to stay out of the path check as well.
  for (const [pattern, why] of REFUSED) if (pattern.test(mask.replace(/\bPREFIX\s+\w*:\s*<x*>/gi, m => ' '.repeat(m.length)))) throw new SparqlRefused(why);

  const whereAt = mask.search(/\bWHERE\b|\{/i);
  if (whereAt < 0) throw new SparqlRefused('The query has no pattern: expected SELECT … WHERE { … } or ASK { … }.');
  const head = mask.slice(0, whereAt);
  const ask = /\bASK\b/i.test(head) && !/\bSELECT\b/i.test(head);
  if (!ask && !/\bSELECT\b/i.test(head)) throw new SparqlRefused('Only SELECT and ASK queries are answered here.');

  // The specification writes its examples as `select ?a, ?b`. Commas there are not SPARQL; read them as spaces.
  for (let i = 0; i < whereAt; i++) if (mask[i] === ',') splice(i, i + 1, ' ');

  const from: string[] = [], fromNamed: string[] = [];
  for (const m of [...mask.slice(0, whereAt).matchAll(/\bFROM\s+(NAMED\s+)?<x*>/gi)]) {
    const iri = text.slice(m.index!, m.index! + m[0].length).replace(/^[\s\S]*</, '').replace(/>$/, '');
    (m[1] ? fromNamed : from).push(iri);
    blank(m.index!, m.index! + m[0].length);
  }

  const open = mask.indexOf('{', whereAt), close = matching(mask, open);
  if (open < 0 || close < 0) throw new SparqlRefused('The braces of the pattern do not balance.');
  if (!/\bWHERE\b/i.test(mask.slice(whereAt, open))) splice(open, open, ' WHERE ');

  // GRAPH is honoured when it holds the whole pattern, which is how a version is asked for.
  let graph: string | undefined;
  const o2 = mask.indexOf('{', whereAt), c2 = matching(mask, o2);
  const inner = mask.slice(o2 + 1, c2);
  const g = /^\s*GRAPH\s+(<x*>|\?\w+)\s*\{/i.exec(inner);
  if (g) {
    const gOpen = o2 + 1 + g[0].length - 1, gClose = matching(mask, gOpen);
    if (mask.slice(gClose + 1, c2).replace(/[\s.]/g, '') !== '') throw new SparqlRefused('GRAPH is evaluated when it holds the whole pattern: WHERE { GRAPH <version> { … } }. Patterns beside it are not joined across graphs.');
    const name = text.slice(o2 + 1 + g.index + g[0].indexOf(g[1]!), o2 + 1 + g.index + g[0].indexOf(g[1]!) + g[1]!.length);
    graph = name.startsWith('<') ? name.slice(1, -1) : name;
    blank(gClose, gClose + 1);
    blank(o2 + 1, gOpen + 1);
  } else if (/\bGRAPH\b/i.test(inner)) {
    throw new SparqlRefused('GRAPH is evaluated when it holds the whole pattern: WHERE { GRAPH <version> { … } }.');
  }

  // The specification's `(A || B) .` between triple patterns means either; SPARQL writes it as UNION.
  for (;;) {
    const m = /(^|[{.\s])\((\s*[^()]*?\|\|[^()]*?)\)\s*\.?/.exec(mask);
    if (!m || /\b(FILTER|BIND|AS)\s*$/i.test(mask.slice(0, m.index + m[1]!.length))) break;
    const start = m.index + m[1]!.length, end = m.index + m[0].length;
    const alternatives = text.slice(start + 1, start + 1 + m[2]!.length).split('||').map(a => `{ ${a.trim()} }`);
    splice(start, end, ` ${alternatives.join(' UNION ')} `);
  }

  let offset = 0, limit: number | undefined;
  const tailAt = matching(mask, mask.indexOf('{', whereAt));
  const off = /\bOFFSET\s+(\d+)/i.exec(mask.slice(tailAt));
  if (off) { offset = Number(off[1]); blank(tailAt + off.index, tailAt + off.index + off[0].length); }
  const lim = /\bLIMIT\s+(\d+)/i.exec(mask.slice(tailAt));
  // With an offset, or rows gathered across graphs, the limit is applied after they are put together.
  if (lim && (offset > 0 || graph?.startsWith('?'))) { limit = Number(lim[1]); blank(tailAt + lim.index, tailAt + lim.index + lim[0].length); }

  const selected = ask ? '' : (/\bSELECT\b([\s\S]*?)\bWHERE\b/i.exec(mask)?.[1] ?? '');
  const vars = /\*/.test(selected) ? [] : [...selected.matchAll(/(?:\bAS\s+)?\?(\w+)(?=\s*\)|\s|$)/gi)]
    .filter(m => !/\(\s*(?:DISTINCT\s+)?$/i.test(selected.slice(0, m.index))).map(m => m[1]!);
  return { text, ask, vars: [...new Set(vars)], from, fromNamed, ...(graph !== undefined ? { graph } : {}), offset, ...(limit !== undefined ? { limit } : {}) };
}

function matching(mask: string, open: number): number {
  if (open < 0) return -1;
  let depth = 0;
  for (let i = open; i < mask.length; i++) {
    if (mask[i] === '{') depth++;
    else if (mask[i] === '}' && --depth === 0) return i;
  }
  return -1;
}
