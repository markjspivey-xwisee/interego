/**
 * The decorator kit: an external system — a learning record store, an LMS, a specification, a
 * reference architecture — decorated from one declarative spec, the way I2IDL-X decorates the
 * I2IDL glossary (docs/patterns/decorating-an-external-system.md describes the pattern).
 *
 * ★ THE SYSTEM IS REFERRED TO, NEVER RESTATED. A decoration names the system's parts by the
 * system's own identifiers where it has them (an LTI claim's URI, an xAPI resource's path), cites the
 * section that defines each, and describes it in the decorator's own words. The specification's text
 * is not copied.
 *
 * ★ ORIGINS ARE KEPT APART, IN SEPARATE DOCUMENTS. The catalog — the parts, and controls saying how
 * to act on each through the system's own interface — is the decorator's, Asserted. Alignments to
 * other vocabularies and enactments (which Foxxi capability realizes a part) are proposals,
 * Hypothetical until reviewers ratify them, and live in their own document, so a reader can take the
 * catalog without the proposals.
 *
 * ★ CONTROLS ARE TEMPLATES THE CALLER BINDS. An instance decoration (an LRS, an LMS) describes how to
 * act on any conformant instance; binding fills its variables (the instance's endpoint) without the
 * bridge contacting anything. Templates follow RFC 6570: {var}, {+var} and {?a,b}. `{+bridge}` is
 * the one variable no caller binds: the bridge serving the decoration fills it with its own base, for
 * the controls that act through Foxxi rather than on the decorated system.
 *
 * ★ IT SAYS WHO MADE IT, AND THAT THE SYSTEM'S PUBLISHER DID NOT. Every document carries the
 * decorator and the not-affiliated statement.
 *
 * Layer: L3 vertical (Foxxi). The graphs use W3C vocabularies (DCAT, DCTerms, SKOS, PROV, Hydra), the
 * L2 catalog shape (hyprcat:FederatedCatalog, hyprcat:FederatedDistribution) and the L1 affordance
 * terms (iep:Affordance, iep:affordance, iep:action); no term is minted.
 */
import { EXTERNAL_PREFIXES } from '../ns/catalog.js';
import { DCT, Graph, PROV, RDF, RDFS, SKOS, STD_PREFIXES, bool, en, iri, str, toJsonLd, toTurtle, type Prefixes } from '../ns/rdf.js';

export type DecorationId = 'lrs-x' | 'lms-x' | 'lti-x' | 'ler-x' | 'tla-x';
export type SystemKind = 'instance' | 'specification' | 'architecture';
export type Relation = 'exactMatch' | 'closeMatch' | 'broadMatch' | 'narrowMatch' | 'relatedMatch';
export type EnactmentRole = 'realizes' | 'operationalizes' | 'implements' | 'measures';

/** The system a decoration decorates, and the publisher it is not affiliated with. */
export interface DecoratedSystem {
  readonly name: string;
  readonly kind: SystemKind;
  /** Who publishes the specification (or architecture). */
  readonly publisher: string;
  /** Anyone else the decoration must not be taken as speaking for: an instance's vendor, say. */
  readonly alsoNotEndorsedBy?: string;
  /** The published specification (or architecture) that defines the system. */
  readonly specification: { readonly title: string; readonly url: string; readonly version?: string; readonly rights?: string };
  /** For an instance decoration: the variables binding names, each with what to give it. */
  readonly bindings?: Readonly<Record<string, { readonly description: string; readonly example: string }>>;
}

/** A part of the system: one of its resources, claims, services or components. */
export interface DecoratedPart {
  readonly id: string;
  readonly label: string;
  /** The system's own identifier for the part, when the system has one. */
  readonly identifier?: string;
  /** The decorator's own words. */
  readonly description: string;
  /** Where the system defines it. */
  readonly cites: string;
  readonly citeUrl?: string;
  /** A term in one of Foxxi's ontologies that models the part (rdfs:seeAlso). */
  readonly modelledBy?: string;
}

/** How to act on a part through the system's own interface. */
export interface Control {
  readonly id: string;
  readonly part: string;
  readonly title: string;
  readonly method: 'GET' | 'POST' | 'PUT' | 'DELETE';
  /** An RFC 6570 template over the decoration's bindings, or an absolute URL. */
  readonly target: string;
  readonly accept?: string;
  readonly contentType?: string;
  readonly headers?: Readonly<Record<string, string>>;
  /** What the system asks of a caller to be let in, in words. */
  readonly auth?: string;
  readonly readOnly: boolean;
  readonly cites?: string;
}

/** A proposed alignment of a part to a term elsewhere (Hypothetical). */
export interface Alignment {
  readonly part: string;
  readonly relation: Relation;
  readonly target: string;
  readonly targetLabel: string;
  readonly rationale: string;
}

/** A proposal that a Foxxi capability enacts a part (Hypothetical). */
export interface Enactment {
  readonly part: string;
  /** The Foxxi affordance's action IRI. */
  readonly action: string;
  readonly role: EnactmentRole;
  readonly rationale: string;
}

/** A gap: a part with no counterpart in a vocabulary that was looked in. */
export interface Gap { readonly part: string; readonly vocabulary: string; readonly note: string }

export interface DecorationSpec {
  readonly id: DecorationId;
  readonly title: string;
  readonly version: string;
  readonly summary: string;
  readonly decorates: DecoratedSystem;
  readonly parts: readonly DecoratedPart[];
  readonly controls: readonly Control[];
  readonly alignments: readonly Alignment[];
  readonly enactments: readonly Enactment[];
  readonly gaps?: readonly Gap[];
}

export const DECORATOR = { name: 'Foxxi Mediums Inc.', creator: 'Mark Spivey', contributor: 'Claude (Anthropic)', license: 'https://opensource.org/licenses/MIT' } as const;

/** Whom a decoration does not speak for. */
export const notEndorsedBy = (spec: Pick<DecorationSpec, 'decorates'>): string =>
  `${spec.decorates.publisher}${spec.decorates.alsoNotEndorsedBy ? `, or ${spec.decorates.alsoNotEndorsedBy}` : ''}`;

/** The not-affiliated statement every document of a decoration carries. */
export const notAffiliated = (spec: Pick<DecorationSpec, 'title' | 'decorates'>): string =>
  `${spec.title} is independent work by ${DECORATOR.creator} (${DECORATOR.name}), drafted with ${DECORATOR.contributor}. It is not affiliated with or endorsed by ${notEndorsedBy(spec)}. It refers to ${spec.decorates.specification.title} by its own names and identifiers and does not reproduce its text; where this decoration and the specification differ, the specification governs.`;

/** The origin labels, in I2IDL-X's what's-whose. */
export const originOf = (spec: Pick<DecorationSpec, 'title'>) => ({
  catalog: `${spec.title} · added`,
  proposals: `${spec.title} · proposed`,
  system: 'the decorated system',
}) as const;

// ── Checking a spec ─────────────────────────────────────────────────────────────────────────────

const TEMPLATE_EXPR = /\{([+?]?)([A-Za-z0-9_,]+)\}/g;
/** The variable the serving bridge fills with its own base URL. */
export const BRIDGE_VAR = 'bridge';

/** The variables a template uses, by kind. */
export function templateVariables(t: string): { path: string[]; query: string[] } {
  const path: string[] = []; const query: string[] = [];
  for (const m of t.matchAll(TEMPLATE_EXPR)) (m[1] === '?' ? query : path).push(...m[2]!.split(','));
  return { path, query };
}

/** Everything wrong with a spec; empty when it holds together. */
export function checkDecoration(spec: DecorationSpec): string[] {
  const out: string[] = [];
  const ids = new Set<string>();
  for (const p of spec.parts) { if (ids.has(p.id)) out.push(`part ${p.id} is declared twice`); ids.add(p.id); }
  const has = (part: string, where: string): void => { if (!ids.has(part)) out.push(`${where} names no part: ${part}`); };
  const controlIds = new Set<string>();
  const bound = new Set([...Object.keys(spec.decorates.bindings ?? {}), BRIDGE_VAR]);
  for (const c of spec.controls) {
    if (controlIds.has(c.id)) out.push(`control ${c.id} is declared twice`);
    controlIds.add(c.id);
    has(c.part, `control ${c.id}`);
    for (const v of templateVariables(c.target).path) if (!bound.has(v)) out.push(`control ${c.id} uses {${v}}, which the decoration does not bind`);
    if (!templateVariables(c.target).path.length && !/^https:\/\//.test(c.target)) out.push(`control ${c.id} has neither a bound template nor an https target`);
    if (c.method === 'GET' && !c.readOnly) out.push(`control ${c.id}: a GET changes nothing, so it is read-only`);
  }
  for (const a of spec.alignments) { has(a.part, `alignment to ${a.target}`); if (!/^https?:\/\//.test(a.target)) out.push(`alignment target ${a.target} is not an IRI`); }
  for (const e of spec.enactments) { has(e.part, `enactment ${e.action}`); if (!/^urn:iep:action:foxxi:[a-z0-9-]+$/.test(e.action)) out.push(`enactment action ${e.action} is not a Foxxi action`); }
  for (const g of spec.gaps ?? []) has(g.part, `gap in ${g.vocabulary}`);
  if (spec.decorates.kind === 'instance' && !Object.keys(spec.decorates.bindings ?? {}).length) out.push('an instance decoration must say what binds it to an instance');
  if (BRIDGE_VAR in (spec.decorates.bindings ?? {})) out.push(`{${BRIDGE_VAR}} is the serving bridge's, not a binding`);
  return out;
}

// ── Binding controls to an instance ─────────────────────────────────────────────────────────────

const pctEncode = (s: string, reserved: boolean): string =>
  reserved ? encodeURI(s).replace(/%25([0-9A-Fa-f]{2})/g, '%$1') : encodeURIComponent(s).replace(/[!'()*]/g, ch => `%${ch.charCodeAt(0).toString(16).toUpperCase()}`);

/** Expand an RFC 6570 template ({var}, {+var}, {?a,b}); absent query variables are left out. */
export function expandTemplate(t: string, values: Readonly<Record<string, string | undefined>>, keepUnbound = false): string {
  return t.replace(TEMPLATE_EXPR, (m, op: string, names: string) => {
    const vars = names.split(',');
    if (keepUnbound && vars.some(v => values[v] === undefined)) return m;
    if (op === '?') {
      const pairs = vars.filter(v => values[v] !== undefined).map(v => `${v}=${pctEncode(values[v]!, false)}`);
      return pairs.length ? `?${pairs.join('&')}` : '';
    }
    return vars.map(v => (values[v] === undefined ? '' : pctEncode(values[v]!, op === '+'))).join(',');
  });
}

export interface BoundControl {
  readonly id: string; readonly part: string; readonly title: string; readonly method: Control['method'];
  readonly href: string; readonly template: string; readonly readOnly: boolean;
  readonly accept?: string; readonly contentType?: string; readonly headers?: Readonly<Record<string, string>>; readonly auth?: string;
}

/**
 * The controls with the decoration's variables filled. Each binding is a URL the caller supplies; it
 * must be https (or http on a loopback host), and nothing is fetched. Query variables stay in the
 * template for the caller to fill per call.
 */
export function bindControls(spec: DecorationSpec, values: Readonly<Record<string, string>>, bridgeBase: string): { ok: true; controls: BoundControl[] } | { ok: false; error: string } {
  const bindings = spec.decorates.bindings ?? {};
  for (const name of Object.keys(bindings)) {
    const v = values[name];
    if (v === undefined) continue;
    let u: URL;
    try { u = new URL(v); } catch { return { ok: false, error: `${name} is not a URL` }; }
    const loopback = ['localhost', '127.0.0.1', '[::1]'].includes(u.hostname);
    if (u.protocol !== 'https:' && !(u.protocol === 'http:' && loopback)) return { ok: false, error: `${name} must be an https URL` };
    if (u.username || u.password) return { ok: false, error: `${name} must not carry credentials` };
  }
  for (const k of Object.keys(values)) if (!(k in bindings)) return { ok: false, error: `${spec.title} binds no variable named ${k}` };
  const filled: Record<string, string> = { ...Object.fromEntries(Object.entries(values).map(([k, v]) => [k, v.replace(/\/+$/, '')])), [BRIDGE_VAR]: bridgeBase.replace(/\/+$/, '') };
  const controls: BoundControl[] = [];
  for (const c of spec.controls) {
    const { path } = templateVariables(c.target);
    if (path.some(v => filled[v] === undefined)) continue;
    const pathOnly = c.target.replace(/\{\?[^}]*\}/g, '');
    const query = c.target.match(/\{\?[^}]*\}/)?.[0] ?? '';
    controls.push({
      id: c.id, part: c.part, title: c.title, method: c.method, readOnly: c.readOnly,
      href: expandTemplate(pathOnly, filled) + query, template: c.target,
      ...(c.accept ? { accept: c.accept } : {}), ...(c.contentType ? { contentType: c.contentType } : {}),
      ...(c.headers ? { headers: c.headers } : {}), ...(c.auth ? { auth: c.auth } : {}),
    });
  }
  return { ok: true, controls };
}

// ── The documents ───────────────────────────────────────────────────────────────────────────────

const DCAT = 'http://www.w3.org/ns/dcat#';
const HYDRA = 'http://www.w3.org/ns/hydra/core#';
const HYPRCAT = 'https://markjspivey-xwisee.github.io/interego/ns/hyprcat#';
const IEP = EXTERNAL_PREFIXES.iep!;
export const DECORATION_PREFIXES: Prefixes = Object.freeze({
  ...STD_PREFIXES, dcat: DCAT, hydra: HYDRA, hyprcat: HYPRCAT, iep: IEP,
  i2idl: 'https://id.i2idl.org/concepts/',
  'foxxi-xapi': 'https://foxxi-bridge.interego.xwisee.com/ns/xapi#',
  'foxxi-ieee-ler': 'https://foxxi-bridge.interego.xwisee.com/ns/ieee-ler#',
  'foxxi-adl-tla': 'https://foxxi-bridge.interego.xwisee.com/ns/adl-tla#',
  'foxxi-cmi5': 'https://foxxi-bridge.interego.xwisee.com/ns/cmi5#',
  xapi: 'https://w3id.org/xapi/ontology#',
  fxa: 'https://relay.interego.xwisee.com/ns/iep/action/foxxi/',
  sssom: 'https://w3id.org/sssom/',
});

/** Where a decoration's documents dereference. */
export const decorationIri = (baseUrl: string, id: DecorationId): string => `${baseUrl.replace(/\/$/, '')}/decorations/${id}`;
export const proposalsIri = (baseUrl: string, id: DecorationId): string => `${decorationIri(baseUrl, id)}/proposals`;
/** A Foxxi action IRI as the relay dereferences it. */
export const actionIri = (urn: string): string => `https://relay.interego.xwisee.com/ns/iep/action/foxxi/${urn.split(':').pop()}`;

function header(g: Graph, doc: string, spec: DecorationSpec, title: string, description: string): ReturnType<typeof iri> {
  const D = iri(doc);
  g.add(D, iri(DCT + 'title'), en(title));
  g.add(D, iri(DCT + 'description'), en(description));
  g.add(D, iri(RDFS + 'comment'), en(notAffiliated(spec)));
  g.add(D, iri(DCT + 'creator'), str(DECORATOR.creator));
  g.add(D, iri(DCT + 'publisher'), str(DECORATOR.name));
  g.add(D, iri(DCT + 'contributor'), str(DECORATOR.contributor));
  g.add(D, iri(DCT + 'license'), iri(DECORATOR.license));
  g.add(D, iri(DCAT + 'version'), str(spec.version));
  g.add(D, iri(DCT + 'subject'), iri(spec.decorates.specification.url));
  g.add(D, iri(PROV + 'wasDerivedFrom'), iri(spec.decorates.specification.url));
  return D;
}

/**
 * The catalog: the decoration, the parts it names, and the controls on each, as a HyprCat catalog.
 * Each part is a SKOS concept in the decoration's scheme; each control is an affordance-bearing
 * distribution (iep:Affordance, hydra:Operation, dcat:Distribution) with an IRI template.
 */
export function catalogGraph(spec: DecorationSpec, baseUrl: string): Graph {
  const g = new Graph();
  const doc = decorationIri(baseUrl, spec.id);
  const D = header(g, doc, spec, spec.title, spec.summary);
  g.add(D, iri(RDF + 'type'), iri(DCAT + 'Catalog'));
  g.add(D, iri(RDF + 'type'), iri(HYPRCAT + 'FederatedCatalog'));
  g.add(D, iri(RDF + 'type'), iri(SKOS + 'ConceptScheme'));
  g.add(D, iri(RDFS + 'seeAlso'), iri(proposalsIri(baseUrl, spec.id)));
  const sys = spec.decorates;
  g.add(D, iri(DCT + 'source'), en(`${sys.specification.title}${sys.specification.version ? `, ${sys.specification.version}` : ''}, by ${sys.publisher}${sys.specification.rights ? ` (${sys.specification.rights})` : ''}`));
  for (const [name, b] of Object.entries(sys.bindings ?? {})) g.add(D, iri(RDFS + 'comment'), en(`Bind {${name}}: ${b.description} For example ${b.example}.`));
  for (const p of spec.parts) {
    const P = iri(`${doc}#${p.id}`);
    g.add(P, iri(RDF + 'type'), iri(SKOS + 'Concept'));
    g.add(P, iri(SKOS + 'inScheme'), D);
    g.add(P, iri(SKOS + 'prefLabel'), en(p.label));
    g.add(P, iri(SKOS + 'definition'), en(p.description));
    g.add(P, iri(DCT + 'source'), en(p.cites));
    if (p.identifier) g.add(P, iri(SKOS + 'notation'), str(p.identifier));
    if (p.citeUrl) g.add(P, iri(RDFS + 'isDefinedBy'), iri(p.citeUrl));
    if (p.modelledBy) g.add(P, iri(RDFS + 'seeAlso'), iri(p.modelledBy));
    for (const c of spec.controls.filter(c => c.part === p.id)) {
      const C = iri(`${doc}#control-${c.id}`);
      g.add(P, iri(IEP + 'affordance'), C);
      g.add(D, iri(DCAT + 'distribution'), C);
      for (const t of [IEP + 'Affordance', HYDRA + 'Operation', DCAT + 'Distribution', HYPRCAT + 'FederatedDistribution']) g.add(C, iri(RDF + 'type'), iri(t));
      g.add(C, iri(DCT + 'title'), en(c.title));
      g.add(C, iri(HYDRA + 'method'), str(c.method));
      if (c.accept) g.add(C, iri(DCAT + 'mediaType'), str(c.accept));
      if (c.contentType) g.add(C, iri(RDFS + 'comment'), en(`Send the body as ${c.contentType}.`));
      // Hydra has no term for a safe operation; a GET is one by its method, and any other read says so in words.
      if (c.readOnly && c.method !== 'GET') g.add(C, iri(RDFS + 'comment'), en('Changes nothing: it only reads.'));
      if (c.auth) g.add(C, iri(RDFS + 'comment'), en(`To be let in: ${c.auth}`));
      for (const [h, v] of Object.entries(c.headers ?? {})) g.add(C, iri(RDFS + 'comment'), en(`Send the header ${h}: ${v}.`));
      if (c.cites) g.add(C, iri(DCT + 'source'), en(c.cites));
      // The serving bridge's own base is filled in; what is left is the caller's to bind.
      const target = expandTemplate(c.target.replace(/\{\?[^}]*\}/g, ''), { [BRIDGE_VAR]: baseUrl.replace(/\/+$/, '') }, true) + (c.target.match(/\{\?[^}]*\}/)?.[0] ?? '');
      if (templateVariables(target).path.length || templateVariables(target).query.length) {
        const T = g.bnode();
        g.add(C, iri(HYDRA + 'target'), T);
        g.add(T, iri(RDF + 'type'), iri(HYDRA + 'IriTemplate'));
        g.add(T, iri(HYDRA + 'template'), str(target));
        const { path, query } = templateVariables(target);
        for (const v of [...path, ...query]) {
          const M = g.bnode();
          g.add(T, iri(HYDRA + 'mapping'), M);
          g.add(M, iri(RDF + 'type'), iri(HYDRA + 'IriTemplateMapping'));
          g.add(M, iri(HYDRA + 'variable'), str(v));
          g.add(M, iri(HYDRA + 'required'), bool(path.includes(v)));
        }
      } else {
        g.add(C, iri(HYDRA + 'target'), iri(target));
      }
    }
  }
  return g;
}

/**
 * The proposals: alignments as SKOS mapping triples, each annotated with its rationale, enactments
 * as the Foxxi action a part is enacted through, and gaps. All Hypothetical.
 */
export function proposalsGraph(spec: DecorationSpec, baseUrl: string): Graph {
  const g = new Graph();
  const doc = decorationIri(baseUrl, spec.id);
  const D = header(g, proposalsIri(baseUrl, spec.id), spec, `${spec.title} — proposals`,
    `Proposals ${spec.title} makes about the parts of ${spec.decorates.name}: alignments to other vocabularies and the Foxxi capabilities that enact each part. Hypothetical: none is settled until reviewers ratify it, and none is a statement by ${spec.decorates.publisher}.`);
  g.add(D, iri(RDF + 'type'), iri(DCAT + 'Dataset'));
  g.add(D, iri(PROV + 'wasDerivedFrom'), iri(doc));
  for (const a of spec.alignments) {
    const s = iri(`${doc}#${a.part}`); const p = iri(SKOS + a.relation); const o = iri(a.target);
    g.add(s, p, o);
    const ax = g.bnode();
    g.add(ax, iri(RDF + 'type'), iri('http://www.w3.org/2002/07/owl#Axiom'));
    g.add(ax, iri('http://www.w3.org/2002/07/owl#annotatedSource'), s);
    g.add(ax, iri('http://www.w3.org/2002/07/owl#annotatedProperty'), p);
    g.add(ax, iri('http://www.w3.org/2002/07/owl#annotatedTarget'), o);
    g.add(ax, iri(RDFS + 'comment'), en(a.rationale));
    g.add(o, iri(RDFS + 'label'), en(a.targetLabel));
  }
  for (const e of spec.enactments) {
    const E = g.bnode();
    g.add(iri(`${doc}#${e.part}`), iri(IEP + 'affordance'), E);
    g.add(E, iri(RDF + 'type'), iri(IEP + 'Affordance'));
    g.add(E, iri(IEP + 'action'), iri(actionIri(e.action)));
    g.add(E, iri(RDFS + 'comment'), en(`Proposed: Foxxi ${e.role} this part. ${e.rationale}`));
  }
  for (const gap of spec.gaps ?? []) g.add(iri(`${doc}#${gap.part}`), iri(RDFS + 'comment'), en(`Gap: no term in ${gap.vocabulary}. ${gap.note}`));
  return g;
}

/** A document's Turtle, headed with what it is and whose. */
export function turtleOf(g: Graph, spec: DecorationSpec, what: 'catalog' | 'proposals'): string {
  return toTurtle(g, DECORATION_PREFIXES, { header: [
    `${spec.title} ${what === 'catalog' ? 'catalog' : 'proposals (Hypothetical)'}, version ${spec.version}.`,
    `Origin: ${what === 'catalog' ? originOf(spec).catalog : originOf(spec).proposals}. Not affiliated with or endorsed by ${notEndorsedBy(spec)}.`,
  ] });
}

export const jsonLdOf = (g: Graph): Record<string, unknown> => toJsonLd(g, DECORATION_PREFIXES);

/** The proposals as an SSSOM/TSV mapping set (SSSOM 1.0), one row an alignment. */
export function proposalsSssom(spec: DecorationSpec, baseUrl: string): string {
  const doc = decorationIri(baseUrl, spec.id);
  const curie = (v: string): string => {
    for (const [p, ns] of Object.entries({ ...DECORATION_PREFIXES, [spec.id]: `${doc}#` }).sort((a, b) => b[1].length - a[1].length)) {
      if (v.startsWith(ns) && v.length > ns.length) return `${p}:${v.slice(ns.length)}`;
    }
    throw new Error(`no prefix for ${v}`);
  };
  const rows = [...spec.alignments].map(a => [
    curie(`${doc}#${a.part}`), spec.parts.find(p => p.id === a.part)!.label, `skos:${a.relation}`, curie(a.target), a.targetLabel,
    'semapv:ManualMappingCuration', a.rationale,
  ]);
  for (const gap of spec.gaps ?? []) rows.push([curie(`${doc}#${gap.part}`), spec.parts.find(p => p.id === gap.part)!.label, 'skos:exactMatch', 'sssom:NoTermFound', '', 'semapv:ManualMappingCuration', `${gap.vocabulary}: ${gap.note}`]);
  rows.sort((a, b) => (a.slice(0, 4).join('\u0000') < b.slice(0, 4).join('\u0000') ? -1 : 1));
  const used = new Set(rows.flatMap(r => [r[0]!, r[3]!]).map(c => c.slice(0, c.indexOf(':'))));
  const curieMap = Object.entries({ ...DECORATION_PREFIXES, [spec.id]: `${doc}#` }).filter(([p]) => used.has(p) && !['skos', 'sssom', 'owl', 'rdf', 'rdfs', 'semapv'].includes(p)).sort();
  const y = (s: string): string => `"${s.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
  const lines = [
    '#curie_map:', ...curieMap.map(([p, ns]) => `#  ${p}: ${y(ns)}`),
    `#mapping_set_id: ${y(`${proposalsIri(baseUrl, spec.id)}.sssom.tsv`)}`,
    `#mapping_set_version: ${y(spec.version)}`,
    `#mapping_set_title: ${y(`${spec.title} — proposed alignments`)}`,
    `#mapping_set_description: ${y(`Alignments ${spec.title} proposes for the parts of ${spec.decorates.name}. Hypothetical until reviewers ratify them; a part with no counterpart in a vocabulary that was looked in is listed against sssom:NoTermFound.`)}`,
    '#creator_label:', `#  - ${y(DECORATOR.creator)}`,
    `#license: ${y(DECORATOR.license)}`,
    `#comment: ${y(notAffiliated(spec))}`,
    ['subject_id', 'subject_label', 'predicate_id', 'object_id', 'object_label', 'mapping_justification', 'comment'].join('\t'),
    ...rows.map(r => r.map(c => (/[\t\r\n]/.test(c) ? (() => { throw new Error(`a tab or line break in ${r[0]}`); })() : c)).join('\t')),
  ];
  return `${lines.join('\n')}\n`;
}

/** What an agent reads: the decoration as JSON, every part with its controls and its proposals. */
export function decorationView(spec: DecorationSpec, baseUrl: string): Record<string, unknown> {
  const doc = decorationIri(baseUrl, spec.id);
  return {
    kind: 'decoration', id: spec.id, title: spec.title, version: spec.version, summary: spec.summary, iri: doc,
    decorates: spec.decorates, notAffiliated: notAffiliated(spec),
    origins: { catalog: originOf(spec).catalog, proposals: `${originOf(spec).proposals} (Hypothetical)` },
    documents: { catalog: doc, proposals: proposalsIri(baseUrl, spec.id), sssom: `${proposalsIri(baseUrl, spec.id)}.sssom.tsv` },
    parts: spec.parts.map(p => ({
      ...p, iri: `${doc}#${p.id}`,
      controls: spec.controls.filter(c => c.part === p.id),
      proposed: {
        modalStatus: 'Hypothetical',
        alignments: spec.alignments.filter(a => a.part === p.id),
        enactments: spec.enactments.filter(e => e.part === p.id).map(e => ({ ...e, affordance: actionIri(e.action) })),
        gaps: (spec.gaps ?? []).filter(gp => gp.part === p.id),
      },
    })),
    ...(spec.decorates.bindings ? { bind: { method: 'POST', affordance: actionIri('urn:iep:action:foxxi:bind-decoration'), body: { decoration: spec.id, values: Object.fromEntries(Object.entries(spec.decorates.bindings).map(([k, b]) => [k, b.example])) } } } : {}),
  };
}
