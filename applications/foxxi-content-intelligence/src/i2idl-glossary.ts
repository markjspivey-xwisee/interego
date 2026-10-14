/**
 * The I2IDL Digital Learning Glossary as data a course can be asked about, and the I2IDL-X layers
 * that decorate it.
 *
 * ★ I2IDL'S RECORD IS READ, NEVER RESTATED. Labels, definitions, evidence, sources and their rights
 * come from I2IDL's own JSON-LD release (https://id.i2idl.org/glossary.jsonld) as published. What
 * this module adds is computed from that record and labelled as such: the definition's provenance
 * in I2IDL's own card wording ("Direct source definition" when any evidence is direct, else "I2IDL
 * synthesis supported by source evidence"), and the reuse class of the sources a definition rests
 * on. Both are the same derivations I2IDL-X makes (i2idlx/tools/build_app.py), so an answer here
 * and the I2IDL-X workbench say the same thing about the same release.
 *
 * ★ RIGHTS DECIDE WHAT IS QUOTED. I2IDL's own material is CC BY 4.0; a definition that rests directly
 * on a source keeps that source's rights (I2IDL says so in its scheme's rights statement). Foxxi is a
 * commercial service, so a definition whose direct sources are non-commercial or used by I2IDL with
 * permission is not quoted: the answer names the concept, links I2IDL's card and says why.
 *
 * ★ FINDING TERMS IN TEXT. The same surface forms I2IDL-X annotates with: the label; "Label (ACR)"
 * split into its two parts; alternate labels. A form is strong when it is several words, or looks
 * like an acronym (two capitals, or a digit); a single plain word ("feedback") is weak. A form two
 * concepts share goes to the concept whose own label carries it (the shortest such label), else to
 * neither. Short acronyms match case-sensitively. Longest forms are taken first, and spans never
 * overlap, so "Learning Record Store" is not also "Learning".
 *
 * The I2IDL-X layers (referent categories and enactments) are Hypothetical: proposals I2IDL-X
 * publishes about I2IDL concepts, not I2IDL's. They are read from the signed graphs on Interego
 * (the relay's /ns surface, as expanded JSON-LD) and every value carries that origin.
 *
 * Layer: L3 vertical (Foxxi). No protocol term is added.
 */

export const I2IDL_GLOSSARY_URL = 'https://id.i2idl.org/glossary.jsonld';
export const I2IDL_CARD_BASE = 'https://www.i2idl.org/glossary';
/** Where I2IDL-X's signed graphs dereference (config.json: relayNsRoot + owner). */
export const I2IDLX_NS_ROOT = 'https://relay.interego.xwisee.com/ns/u-pk-33d42e6b33dc';
export const I2IDLX_NS = `${I2IDLX_NS_ROOT}/i2idlx#`;
export const I2IDLX_GRAPHS = {
  ontology: `${I2IDLX_NS_ROOT}/i2idlx`,
  referents: `${I2IDLX_NS_ROOT}/i2idlx-referents`,
  enactments: `${I2IDLX_NS_ROOT}/i2idlx-enactments`,
  catalog: `${I2IDLX_NS_ROOT}/i2idlx-catalog`,
} as const;

/** I2IDL's own card wording for where a definition comes from (I2IDL roadmap, next priority 3). */
export const PROVENANCE_WORDING = {
  direct: 'Direct source definition',
  synthesis: 'I2IDL synthesis supported by source evidence',
} as const;

export type ReuseClass = 'open' | 'sharealike' | 'nc' | 'permission';

/** What reuse of a definition grounded in a source asks of you (I2IDL-X's wording; information, not legal advice). */
export const REUSE: Readonly<Record<ReuseClass, { label: string; note: string; quotable: boolean }>> = {
  open: { label: 'Open (attribution)', note: 'Reuse with attribution.', quotable: true },
  sharealike: { label: 'Share-alike', note: 'Reuse with attribution; adaptations carry the same licence.', quotable: true },
  nc: { label: 'Non-commercial', note: 'Not for commercial use without permission from the rights holder.', quotable: false },
  permission: { label: 'Permission / terms', note: 'Used by I2IDL with permission or under the publisher\'s terms; ask before reuse.', quotable: false },
};

export interface I2idlSource {
  readonly iri: string;
  readonly title: string;
  /** I2IDL's short label for the source, as its evidence names it. */
  readonly label: string;
  readonly url?: string;
  readonly rights: string;
  readonly rightsUrl?: string;
  readonly reuse: ReuseClass;
}

export interface I2idlEvidence {
  readonly source: string;
  readonly relation: 'direct' | 'supporting';
  readonly citation?: string;
  readonly url?: string;
}

export interface I2idlConcept {
  /** I2IDL's identifier (the IRI's last segment). */
  readonly id: string;
  readonly iri: string;
  readonly label: string;
  readonly altLabels: readonly string[];
  readonly definition: string;
  readonly definitionIri?: string;
  readonly editorialExplanation?: string;
  readonly provenance: 'direct' | 'synthesis';
  readonly evidence: readonly I2idlEvidence[];
  readonly broader: readonly string[];
  readonly related: readonly string[];
  /** The most restrictive reuse class among the sources the definition directly rests on (open when none). */
  readonly reuse: ReuseClass;
}

export interface I2idlGlossary {
  readonly title: string;
  readonly release: string;
  readonly rights: string;
  readonly scheme: string;
  readonly concepts: readonly I2idlConcept[];
  readonly byIri: ReadonlyMap<string, I2idlConcept>;
  readonly sources: ReadonlyMap<string, I2idlSource>;
}

type Node = Record<string, unknown>;
const asList = (v: unknown): unknown[] => (v === undefined || v === null ? [] : Array.isArray(v) ? v : [v]);
const str = (v: unknown): string => (typeof v === 'string' ? v : '');
const idOf = (v: unknown): string => (v && typeof v === 'object' ? str((v as Node)['@id']) : str(v));
const typesOf = (n: Node): string[] => asList(n['@type']).map(str);
const clean = (s: string): string => s.replace(/\s+/g, ' ').trim();

/** I2IDL-X's rights classifier (build_app.py rights_class), over a source's rights statement. */
export function reuseClassOf(rights: string): ReuseClass {
  const u = rights.toUpperCase();
  if (u.split('-').includes('NC') || u.includes('-NC')) return 'nc';
  if (u.includes('PERMISSION') || u.includes('TERMS APPLY')) return 'permission';
  if (u.replace(/-/g, ' ').split(/\s+/).includes('SA')) return 'sharealike';
  return 'open';
}

const REUSE_ORDER: readonly ReuseClass[] = ['permission', 'nc', 'sharealike', 'open'];

/**
 * Read I2IDL's JSON-LD release: the scheme, the concepts, each concept's active definition and its
 * evidence, and the sources with their rights. Throws when the document is not a glossary release.
 */
export function parseI2idlGlossary(doc: unknown): I2idlGlossary {
  const graph = asList((doc as Node | null)?.['@graph']).filter((n): n is Node => !!n && typeof n === 'object');
  const scheme = graph.find(n => typesOf(n).includes('skos:ConceptScheme'));
  if (!scheme) throw new Error('not an I2IDL glossary release: no skos:ConceptScheme in @graph');
  const definitions = new Map<string, Node>();
  for (const n of graph) if (typesOf(n).includes('gs:Definition')) definitions.set(str(n['@id']), n);
  const shortLabel = new Map<string, string>();
  for (const d of definitions.values()) for (const e of asList(d['gs:evidence']) as Node[]) {
    const sid = idOf(e['dcterms:source']);
    if (sid && !shortLabel.has(sid)) shortLabel.set(sid, str(e['gs:sourceLabel']));
  }
  const sources = new Map<string, I2idlSource>();
  for (const n of graph) {
    if (!typesOf(n).includes('dcterms:BibliographicResource')) continue;
    const iri = str(n['@id']);
    const rights = str(n['dcterms:rights']);
    const title = clean(str(n['dcterms:title']));
    sources.set(iri, {
      iri, title, label: shortLabel.get(iri) || title, rights, reuse: reuseClassOf(rights),
      ...(str(n['schema:url']) ? { url: str(n['schema:url']) } : {}),
      ...(str(n['gs:rightsUrl']) ? { rightsUrl: str(n['gs:rightsUrl']) } : {}),
    });
  }
  const concepts: I2idlConcept[] = [];
  for (const n of graph) {
    if (!typesOf(n).includes('skos:Concept')) continue;
    const iri = str(n['@id']);
    const definitionIri = idOf(n['gs:activeDefinition']);
    const def = definitions.get(definitionIri);
    const evidence: I2idlEvidence[] = (asList(def?.['gs:evidence']) as Node[]).map(e => ({
      source: idOf(e['dcterms:source']),
      relation: str(e['gs:evidenceRelation']) === 'direct' ? 'direct' as const : 'supporting' as const,
      ...(str(e['gs:citationDetail']) ? { citation: clean(str(e['gs:citationDetail'])) } : {}),
      ...(str(e['schema:url']) ? { url: str(e['schema:url']) } : {}),
    })).filter(e => e.source);
    const direct = [...new Set(evidence.filter(e => e.relation === 'direct').map(e => e.source))];
    const classes = direct.map(s => sources.get(s)?.reuse ?? 'permission');
    const reuse = REUSE_ORDER.find(o => classes.includes(o)) ?? 'open';
    concepts.push({
      id: str(n['dcterms:identifier']) || iri.split('/').at(-1)!,
      iri,
      label: clean(str(n['skos:prefLabel'])),
      altLabels: asList(n['skos:altLabel']).map(str).map(clean).filter(Boolean),
      definition: clean(str(n['skos:definition']) || str(def?.['rdf:value'])),
      ...(definitionIri ? { definitionIri } : {}),
      ...(str(n['gs:editorialExplanation']) ? { editorialExplanation: clean(str(n['gs:editorialExplanation'])) } : {}),
      provenance: direct.length ? 'direct' : 'synthesis',
      evidence,
      broader: asList(n['skos:broader']).map(idOf).filter(Boolean),
      related: asList(n['skos:related']).map(idOf).filter(Boolean),
      reuse,
    });
  }
  if (!concepts.length) throw new Error('not an I2IDL glossary release: no skos:Concept in @graph');
  return {
    title: clean(str(scheme['dcterms:title'])),
    release: str(scheme['gs:publicationVersion']),
    rights: clean(str(scheme['dcterms:rights'])),
    scheme: str(scheme['@id']),
    concepts,
    byIri: new Map(concepts.map(c => [c.iri, c])),
    sources,
  };
}

/** The card I2IDL publishes for a concept. */
export const i2idlCardUrl = (c: Pick<I2idlConcept, 'id'>): string => `${I2IDL_CARD_BASE}#${c.id}`;

// ── Finding I2IDL terms in text ─────────────────────────────────────────────────────────────────

const ACRONYMISH = /[A-Z].*[A-Z]|[0-9]/;
const ACRONYM = /^[A-Za-z0-9-]*[A-Z][A-Za-z0-9-]*[A-Z0-9][A-Za-z0-9-]*$/;
const words = (s: string): number => s.trim().split(/\s+/).filter(Boolean).length;

/** The surface forms a concept is found by, each strong or weak (build_app.py surface_forms). */
export function surfaceForms(label: string, altLabels: readonly string[] = []): Array<{ form: string; strong: boolean }> {
  const out: Array<{ form: string; strong: boolean }> = [{ form: label, strong: words(label) > 1 || ACRONYMISH.test(label) }];
  const m = /^(.*?)\s*\(([^)]+)\)$/.exec(label);
  if (m) {
    out.push({ form: m[1]!, strong: words(m[1]!) > 1 });
    out.push({ form: m[2]!, strong: ACRONYMISH.test(m[2]!) });
  }
  for (const a of altLabels) out.push({ form: a, strong: words(a) > 1 || (ACRONYM.test(a) && a.length >= 2) });
  const seen = new Set<string>();
  return out.filter(({ form }) => {
    const k = form.toLowerCase();
    if (form.length < 2 || seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

export interface ConceptMention { readonly start: number; readonly end: number; readonly iri: string; readonly form: string; readonly strong: boolean }

export interface ConceptMatcher {
  /** Every I2IDL term in the text, left to right, longest form first where forms overlap. Weak forms only when asked. */
  find(text: string, opts?: { weak?: boolean }): ConceptMention[];
  /** The forms a concept is found by. */
  formsOf(iri: string): ReadonlyArray<{ form: string; strong: boolean }>;
}

const escapeRe = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** Compile the glossary's surface forms once: shared forms resolved, short acronyms case-sensitive, longest first. */
export function conceptMatcher(concepts: readonly Pick<I2idlConcept, 'iri' | 'label' | 'altLabels'>[]): ConceptMatcher {
  const labelLength = new Map(concepts.map(c => [c.iri, c.label.length]));
  const claims = new Map<string, Array<{ iri: string; fromLabel: boolean }>>();
  for (const c of concepts) {
    const own = new Set(surfaceForms(c.label).map(f => f.form.toLowerCase()));
    for (const f of surfaceForms(c.label, c.altLabels)) {
      const k = f.form.toLowerCase();
      if (!claims.has(k)) claims.set(k, []);
      claims.get(k)!.push({ iri: c.iri, fromLabel: own.has(k) });
    }
  }
  const forms: Array<{ re: RegExp; form: string; iri: string; strong: boolean }> = [];
  const byConcept = new Map<string, Array<{ form: string; strong: boolean }>>();
  for (const c of concepts) {
    for (const f of surfaceForms(c.label, c.altLabels)) {
      const owners = claims.get(f.form.toLowerCase())!;
      if (owners.length > 1) {
        const byLabel = owners.filter(o => o.fromLabel)
          .sort((a, b) => (labelLength.get(a.iri)! - labelLength.get(b.iri)!) || (a.iri < b.iri ? -1 : a.iri > b.iri ? 1 : 0));
        if (!byLabel.length || byLabel[0]!.iri !== c.iri) continue;
      }
      const caseSensitive = /[A-Z].*[A-Z]/.test(f.form) && f.form.length <= 6;
      forms.push({ re: new RegExp(`(?<![\\p{L}\\p{N}_-])${escapeRe(f.form)}(?![\\p{L}\\p{N}_-])`, caseSensitive ? 'gu' : 'giu'), form: f.form, iri: c.iri, strong: f.strong });
      if (!byConcept.has(c.iri)) byConcept.set(c.iri, []);
      byConcept.get(c.iri)!.push(f);
    }
  }
  forms.sort((a, b) => b.form.length - a.form.length);
  return {
    find(text, opts) {
      const taken = new Uint8Array(text.length);
      const spans: ConceptMention[] = [];
      for (const p of forms) {
        if (!p.strong && !opts?.weak) continue;
        p.re.lastIndex = 0;
        let m: RegExpExecArray | null;
        while ((m = p.re.exec(text))) {
          const a = m.index;
          const b = a + m[0].length;
          if (!taken.subarray(a, b).some(Boolean)) { taken.fill(1, a, b); spans.push({ start: a, end: b, iri: p.iri, form: m[0], strong: p.strong }); }
          if (m[0].length === 0) p.re.lastIndex++;
        }
      }
      return spans.sort((x, y) => x.start - y.start);
    },
    formsOf: (iri) => byConcept.get(iri) ?? [],
  };
}

// ── The I2IDL-X layers: referent categories and enactments (Hypothetical) ─────────────────────

export interface I2idlxReferent {
  readonly category: string;
  readonly label: string;
  readonly rationale?: string;
  readonly basis?: string;
}

export interface I2idlxEnactment {
  /** The Foxxi action the concept is enacted through. */
  readonly action: string;
  readonly role: string;
  readonly roleLabel: string;
  readonly rationale?: string;
  readonly confidence?: number;
  readonly status: string;
  readonly statusLabel: string;
}

export interface I2idlxDecorations {
  readonly referents: ReadonlyMap<string, I2idlxReferent>;
  readonly enactments: ReadonlyMap<string, readonly I2idlxEnactment[]>;
}

type Expanded = Record<string, Array<{ '@id'?: string; '@value'?: unknown; '@language'?: string }>> & { '@id'?: string };

function nodesOf(doc: unknown): Map<string, Expanded> {
  const out = new Map<string, Expanded>();
  for (const n of asList((doc as Node | null)?.['@graph'])) {
    if (!n || typeof n !== 'object') continue;
    const id = str((n as Node)['@id']);
    if (id) out.set(id, n as Expanded);
  }
  return out;
}
const first = (n: Expanded | undefined, p: string): { '@id'?: string; '@value'?: unknown } | undefined => (n?.[p] as Expanded[string] | undefined)?.[0];
const firstId = (n: Expanded | undefined, p: string): string => str(first(n, p)?.['@id']);
const firstValue = (n: Expanded | undefined, p: string): string => {
  const v = first(n, p)?.['@value'];
  return typeof v === 'string' ? v : typeof v === 'number' ? String(v) : '';
};
const SKOS_PREF = 'http://www.w3.org/2004/02/skos/core#prefLabel';
const RDF_TYPE = 'http://www.w3.org/1999/02/22-rdf-syntax-ns#type';
/** A node's types, whether the serializer wrote them as `@type` or as rdf:type objects. */
const expandedTypes = (n: Expanded): string[] => [
  ...asList((n as unknown as Node)['@type']).map(str),
  ...((n[RDF_TYPE] ?? []) as Array<{ '@id'?: string }>).map(t => str(t['@id'])),
];

/**
 * Read I2IDL-X's referent categories and enactments from the relay's expanded JSON-LD: the
 * ontology graph (for category, role and status labels), the referents graph and the enactments
 * graph. A concept with no category or enactment is simply absent.
 */
export function parseI2idlxDecorations(graphs: { ontology: unknown; referents: unknown; enactments: unknown }): I2idlxDecorations {
  const onto = nodesOf(graphs.ontology);
  const labelOf = (iri: string): string => firstValue(onto.get(iri), SKOS_PREF) || iri.split('#').at(-1)!;
  const referents = new Map<string, I2idlxReferent>();
  for (const [iri, n] of nodesOf(graphs.referents)) {
    const category = firstId(n, `${I2IDLX_NS}referentCategory`);
    if (!category) continue;
    const rationale = firstValue(n, `${I2IDLX_NS}categoryRationale`);
    const basis = firstValue(n, `${I2IDLX_NS}assignmentBasis`);
    referents.set(iri, { category, label: labelOf(category), ...(rationale ? { rationale } : {}), ...(basis ? { basis } : {}) });
  }
  const enactments = new Map<string, I2idlxEnactment[]>();
  for (const n of nodesOf(graphs.enactments).values()) {
    if (!expandedTypes(n).includes(`${I2IDLX_NS}Enactment`)) continue;
    const concept = firstId(n, `${I2IDLX_NS}enactedConcept`);
    const action = firstId(n, `${I2IDLX_NS}viaAction`);
    if (!concept || !action) continue;
    const role = firstId(n, `${I2IDLX_NS}enactmentRole`);
    const status = firstId(n, `${I2IDLX_NS}reviewStatus`);
    const rationale = firstValue(n, `${I2IDLX_NS}rationale`);
    const confidence = Number(firstValue(n, `${I2IDLX_NS}confidence`));
    if (!enactments.has(concept)) enactments.set(concept, []);
    enactments.get(concept)!.push({
      action, role, roleLabel: role ? labelOf(role) : '', status, statusLabel: status ? labelOf(status) : '',
      ...(rationale ? { rationale } : {}), ...(Number.isFinite(confidence) && firstValue(n, `${I2IDLX_NS}confidence`) ? { confidence } : {}),
    });
  }
  return { referents, enactments };
}

// ── Loading, with a day's cache ─────────────────────────────────────────────────────────────────

export interface GlossarySources {
  readonly glossary: I2idlGlossary;
  readonly matcher: ConceptMatcher;
  /** Absent when I2IDL-X's graphs could not be read: answers then carry I2IDL's record alone. */
  readonly decorations?: I2idlxDecorations;
  readonly loadedAt: number;
}

const DAY_MS = 24 * 60 * 60_000;

/**
 * A loader that reads I2IDL's release and I2IDL-X's graphs at most once a day, and keeps the last
 * good copy when a refresh fails. Concurrent callers share one fetch.
 */
export function glossaryLoader(opts: { fetch: typeof fetch; now?: () => number; ttlMs?: number; glossaryUrl?: string }): () => Promise<GlossarySources | null> {
  const now = opts.now ?? Date.now;
  const ttl = opts.ttlMs ?? DAY_MS;
  let held: GlossarySources | null = null;
  let failedAt = Number.NEGATIVE_INFINITY;
  let pending: Promise<GlossarySources | null> | null = null;
  const getJson = async (url: string, accept: string): Promise<unknown> => {
    const r = await opts.fetch(url, { headers: { Accept: accept }, signal: AbortSignal.timeout(20_000) });
    if (!r.ok) throw new Error(`${url} answered ${r.status}`);
    return r.json();
  };
  const refresh = async (): Promise<GlossarySources | null> => {
    try {
      const glossary = parseI2idlGlossary(await getJson(opts.glossaryUrl ?? I2IDL_GLOSSARY_URL, 'application/ld+json'));
      let decorations: I2idlxDecorations | undefined;
      try {
        const [ontology, referents, enactments] = await Promise.all([I2IDLX_GRAPHS.ontology, I2IDLX_GRAPHS.referents, I2IDLX_GRAPHS.enactments].map(u => getJson(u, 'application/ld+json')));
        decorations = parseI2idlxDecorations({ ontology, referents, enactments });
      } catch { decorations = held?.decorations; }
      held = { glossary, matcher: conceptMatcher(glossary.concepts), ...(decorations ? { decorations } : {}), loadedAt: now() };
    } catch {
      // Keep the last good copy; try again after a tenth of the interval rather than on every ask.
      failedAt = now();
      if (held) held = { ...held, loadedAt: now() - ttl + Math.max(60_000, ttl / 10) };
    }
    return held;
  };
  return async () => {
    if (held && now() - held.loadedAt < ttl) return held;
    if (!held && now() - failedAt < 60_000) return null;
    pending ??= refresh().finally(() => { pending = null; });
    return pending;
  };
}
