/**
 * The judgment kit: what a System One judgment needs to become an Interego artifact, shared
 * by every vertical that publishes one.
 *
 * ── WHY ────────────────────────────────────────────────────────────────────────────────────
 *
 * jev-harness proved the shape between 2026-09-19 and 2026-09-21: a judgment (a Choice, a
 * Noul, a Score, or policy in code over them) becomes a Hypothetical Context Descriptor whose
 * payload graph carries the judgment AND the controls an agent may follow next (hmd:control,
 * authority-closed inside the signed payload); an Outcome is Asserted and supersedes it; the
 * calibration view is computed over the pairs. Nothing in that is about repositories. So the
 * kit holds the parts that are the same for any vertical — Turtle literals and IRI references,
 * the payload prefixes the relay's note projection recognises, the control triples, the
 * seven-facet descriptor in TriG, the HyperMarkdown projection, and the scoring arithmetic —
 * and each vertical keeps its own kinds: what a judgment says, which controls emerge from it,
 * how it reads as prose. jev-harness is the first instance; Foxxi's content judgment the
 * second. The System One client is beside this file (./jev-client.ts).
 *
 * The TriG and HyperMarkdown renderers reproduce jev-harness's output byte for byte for the
 * same inputs; its tests are what pinned them while they were extracted.
 */

import { turtleIriRef } from '@interego/core';

// ── Vocabularies ──────────────────────────────────────────────────────────────────────────

export const IEP = 'https://markjspivey-xwisee.github.io/interego/ns/iep#';
export const IEH = 'https://markjspivey-xwisee.github.io/interego/ns/harness#';
export const HMD = 'https://relay.interego.xwisee.com/ns/maintainer/hmd#';
export const HMD_PROFILE = 'https://relay.interego.xwisee.com/ns/maintainer/hmd';
export const HYDRA = 'http://www.w3.org/ns/hydra/core#';
export const PROV = 'http://www.w3.org/ns/prov#';
export const DCT = 'http://purl.org/dc/terms/';
export const SKOS = 'http://www.w3.org/2004/02/skos/core#';
export const SCHEMA = 'https://schema.org/';
export const XSD = 'http://www.w3.org/2001/XMLSchema#';
export const RDF = 'http://www.w3.org/1999/02/22-rdf-syntax-ns#';
export const AS = 'https://www.w3.org/ns/activitystreams#';
export const DCAT = 'http://www.w3.org/ns/dcat#';

// ── Turtle ────────────────────────────────────────────────────────────────────────────────

/** Turtle STRING_LITERAL_QUOTE escaping: backslash, quote, LF, CR, TAB. */
export function escapeTurtleLiteral(s: string): string {
  return s.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n').replace(/\r/g, '\\r').replace(/\t/g, '\\t');
}

export const lit = (s: string): string => `"${escapeTurtleLiteral(s)}"`;
export const dbl = (n: number): string => `"${Number.isFinite(n) ? n : 0}"^^xsd:double`;
export const int = (n: number): string => `"${Number.isFinite(n) ? Math.trunc(n) : 0}"^^xsd:integer`;
export const bool = (b: boolean): string => `"${b}"^^xsd:boolean`;
export const dateTime = (iso: string): string => `"${iso}"^^xsd:dateTime`;

/** `<value>`, or throw: for IRIs the code itself minted, where a refusal is a programming error. */
export function iri(value: string): string {
  const ref = turtleIriRef(value);
  if (ref === null) throw new TypeError(`not a usable IRI reference: ${JSON.stringify(value).slice(0, 120)}`);
  return ref;
}

export const prefixLine = (prefix: string, ns: string): string => `@prefix ${prefix}: ${iri(ns)} .`;

/**
 * Prefixes a payload body uses. Predicates are written as prefixed names on purpose: the
 * relay's note projection recognises a payload as readable by the tokens `schema:text`,
 * `schema:name`, `dct:title` and friends in the Turtle it stores (deploy/mcp-relay/note-view.ts),
 * and projects `hmd:control` entries into :::control blocks the same way. Absolute IRIs are
 * semantically identical and render nothing — measured on the first published judgment.
 */
export const PAYLOAD_PREFIXES: ReadonlyArray<readonly [string, string]> = [
  ['rdf', RDF], ['dct', DCT], ['schema', SCHEMA], ['prov', PROV], ['skos', SKOS], ['hmd', HMD], ['iep', IEP], ['hydra', HYDRA], ['xsd', XSD],
];

/** The @prefix block for a payload: the shared prefixes plus the vertical's own. */
export function payloadPrefixes(ns: string, prefix: string): string {
  return [...PAYLOAD_PREFIXES.map(([p, n]) => prefixLine(p, n)), prefixLine(prefix, ns)].join('\n');
}

// ── Controls: the next steps a judgment affords ──────────────────────────────────────────

export interface Control {
  readonly id: string;
  readonly name: string;
  readonly title: string;
  readonly action: string;
  readonly method: 'GET' | 'POST';
  readonly target?: string;
  readonly expects?: string;
  readonly returns?: string;
  readonly arguments?: unknown;
  readonly scopeNote: string;
  /** true when the control names no executable target: a follower or a person performs it. */
  readonly declarative: boolean;
}

/**
 * The opening triples of a payload document: its types, the HyperMarkdown profile it conforms
 * to, and the title and prose the viewer renders. `S` is the subject reference, `types` are
 * already prefixed names or references.
 */
export function documentHeadLines(S: string, doc: { readonly types: readonly string[]; readonly title: string; readonly prose: string }): string[] {
  const lines: string[] = [];
  for (const t of doc.types) lines.push(`${S} a ${t} .`);
  lines.push(`${S} a hmd:Document .`);
  lines.push(`${S} dct:conformsTo ${iri(HMD_PROFILE)} .`);
  lines.push(`${S} dct:title ${lit(doc.title)} .`);
  lines.push(`${S} schema:name ${lit(doc.title)} .`);
  lines.push(`${S} schema:text ${lit(doc.prose)} .`);
  lines.push(`${S} schema:encodingFormat ${lit('text/markdown; charset=UTF-8; variant=CommonMark')} .`);
  return lines;
}

/** Who asserted the document and when. */
export function attributionLines(S: string, agentId: string, createdAt: string): string[] {
  return [`${S} prov:wasAttributedTo ${iri(agentId)} .`, `${S} dct:created ${dateTime(createdAt)} .`];
}

/**
 * The control triples: each control is an hmd:Control, an iep:Affordance and a hydra:Operation
 * hanging off the document, with its prefilled arguments as JSON under the vertical's own
 * `argumentsJson` term and its executability under `declarative`. `P` prefixes a local name
 * with the vertical's namespace.
 */
export function controlLines(S: string, controls: readonly Control[], P: (local: string) => string): string[] {
  const lines: string[] = [];
  for (const c of controls) {
    const C = iri(c.id);
    lines.push(`${S} hmd:control ${C} .`);
    lines.push(`${C} a hmd:Control, iep:Affordance, hydra:Operation .`);
    lines.push(`${C} dct:title ${lit(c.title)} .`);
    lines.push(`${C} hmd:rel ${iri(c.action)} .`);
    lines.push(`${C} iep:action ${iri(c.action)} .`);
    lines.push(`${C} hmd:method ${lit(c.method)} .`);
    lines.push(`${C} hydra:method ${lit(c.method)} .`);
    if (c.target) lines.push(`${C} hydra:target ${iri(c.target)} .`);
    if (c.expects) { lines.push(`${C} hydra:expects ${iri(c.expects)} .`); lines.push(`${C} iep:inputShape ${iri(c.expects)} .`); }
    if (c.returns) lines.push(`${C} hydra:returns ${iri(c.returns)} .`);
    if (c.arguments !== undefined) lines.push(`${C} ${P('argumentsJson')} ${lit(JSON.stringify(c.arguments))} .`);
    lines.push(`${C} ${P('declarative')} ${bool(c.declarative)} .`);
    lines.push(`${C} skos:scopeNote ${lit(c.scopeNote)} .`);
  }
  return lines;
}

// ── The descriptor ────────────────────────────────────────────────────────────────────────

export interface DescriptorSpec {
  readonly descriptorIri: string;
  readonly graphIri: string;
  /** Hypothetical for a judgment; Asserted (with groundTruth) for an outcome. */
  readonly status: 'Asserted' | 'Hypothetical';
  readonly confidence: number;
  readonly createdAt: string;
  readonly validFrom?: string;
  /** The model that produced it, recorded as prov:used urn:typesafe:model:<model>. */
  readonly model: string;
  readonly agentId: string;
  /** The person the agent acts for; the descriptor's issuer when present. */
  readonly ownerWebId?: string;
  /** The publishing service's origin, no trailing slash. */
  readonly base: string;
  /** What the descriptor conforms to: the payload shape and the HyperMarkdown profile. */
  readonly conformsTo: readonly string[];
  /** Where the payload can be fetched from, and as what. */
  readonly payloadUrl: string;
  readonly payloadMediaType: string;
  readonly supersedes?: readonly string[];
  /** The @prefix block the payload body needs (see payloadPrefixes), plus any extras. */
  readonly prefixes: string;
  /** The payload graph's triples, prefixed names, one per line. */
  readonly payloadBody: string;
}

/** A self-contained descriptor (seven facets, the fetch affordance, the payload graph) in TriG. */
export function renderDescriptorTrig(spec: DescriptorSpec): string {
  const D = iri(spec.descriptorIri);
  const validFrom = spec.validFrom ?? spec.createdAt;
  const issuer = spec.ownerWebId ?? spec.agentId;
  const prefixes = [spec.prefixes, prefixLine('ieh', IEH), prefixLine('as', AS), prefixLine('dcat', DCAT)].join('\n');
  const supersedes = (spec.supersedes ?? []).map((s) => `    iep:supersedes ${iri(s)} ;`).join('\n');
  const semiotic = spec.status === 'Asserted'
    ? `        iep:groundTruth ${bool(true)} ;\n        iep:modalStatus iep:Asserted ;`
    : `        iep:modalStatus iep:Hypothetical ;`;
  const conforms = spec.conformsTo.map((c) => `    dct:conformsTo ${iri(c)} ;`).join('\n');
  const descriptor = `${D}
    a iep:ContextDescriptor ;
    iep:version "1"^^xsd:integer ;
    iep:validFrom "${validFrom}"^^xsd:dateTime ;
${supersedes}
${conforms}
    iep:describes ${iri(spec.graphIri)} ;
    iep:hasFacet [
        a iep:TemporalFacet ;
        iep:validFrom "${validFrom}"^^xsd:dateTime
    ] ;
    iep:hasFacet [
        a iep:ProvenanceFacet ;
        prov:wasGeneratedBy [
            a prov:Activity ;
            prov:wasAssociatedWith ${iri(spec.agentId)} ;
            prov:used ${iri(`urn:typesafe:model:${spec.model}`)} ;
            prov:endedAtTime "${spec.createdAt}"^^xsd:dateTime
        ] ;
        prov:wasAttributedTo ${iri(issuer)} ;
        prov:generatedAtTime "${spec.createdAt}"^^xsd:dateTime
    ] ;
    iep:hasFacet [
        a iep:AgentFacet ;
        iep:assertingAgent [
            a prov:SoftwareAgent, as:Application ;
            iep:agentIdentity ${iri(spec.agentId)}
        ] ;
        iep:agentRole iep:Author${spec.ownerWebId ? ` ;\n        iep:onBehalfOf ${iri(spec.ownerWebId)}` : ''}
    ] ;
    iep:hasFacet [
        a iep:SemioticFacet ;
${semiotic}
        iep:epistemicConfidence ${dbl(spec.confidence)}
    ] ;
    iep:hasFacet [
        a iep:TrustFacet ;
        iep:issuer ${iri(issuer)} ;
        iep:trustLevel iep:SelfAsserted
    ] ;
    iep:hasFacet [
        a iep:FederationFacet ;
        iep:origin ${iri(spec.base + '/')} ;
        iep:storageEndpoint ${iri(spec.base + '/')}
    ] .

${D} iep:affordance [
    a iep:Affordance, ieh:Affordance, hydra:Operation, dcat:Distribution ;
    iep:action iep:canFetchPayload ;
    hydra:method "GET" ;
    hydra:target ${iri(spec.payloadUrl)} ;
    hydra:returns iep:GraphPayload ;
    hydra:title "Fetch graph payload" ;
    dcat:accessURL ${iri(spec.payloadUrl)} ;
    dcat:mediaType ${lit(spec.payloadMediaType)} ;
    iep:encrypted false ;
    iep:visibility "public"
] .

${iri(spec.graphIri)} {
${spec.payloadBody.split('\n').filter(Boolean).map((l) => `    ${l}`).join('\n')}
}
`;
  return `${prefixes}\n\n${descriptor}`;
}

// ── The HyperMarkdown projection ──────────────────────────────────────────────────────────

export interface HmdSpec {
  /** The judgment's own URL; the descriptor is served beside it as <url>.trig. */
  readonly url: string;
  readonly nsPrefix: string;
  readonly ns: string;
  /** The payload type's local name in the vertical's namespace. */
  readonly payloadType: string;
  readonly state: 'asserted' | 'hypothetical';
  readonly graphIri: string;
  readonly prose: string;
  readonly controls: readonly Control[];
}

/** The document a person reads in the viewer: front matter, the prose, one :::control block per control. */
export function hmdDocument(spec: HmdSpec): string {
  const front = [
    '---',
    '"@context":',
    `  - iep: "${IEP}"`,
    `    hydra: "${HYDRA}"`,
    `    hmd: "${HMD}"`,
    `    ${spec.nsPrefix}: "${spec.ns}"`,
    `"@id": "${spec.url}"`,
    `"@type": ["${spec.nsPrefix}:${spec.payloadType}", "hmd:Document"]`,
    `descriptorUrl: "${spec.url}.trig"`,
    `state: "${spec.state}"`,
    `graph: "${spec.graphIri}"`,
    '---',
    '',
  ];
  const status = spec.state === 'asserted' ? 'Asserted' : 'Hypothetical';
  const body = [spec.prose, '', `_${status} judgment — its controls are below. Executable controls name this bridge's own targets; declarative ones are performed by the follower or a person._`, ''];
  for (const c of spec.controls) {
    body.push(`:::control ${c.name}`);
    body.push('type: ["hmd:Control", "hydra:Operation"]');
    body.push(`title: ${JSON.stringify(c.title)}`);
    body.push(`rel: "${c.action}"`);
    body.push(`method: "${c.method}"`);
    if (c.target) body.push(`target: "${c.target}"`);
    else body.push('declarative: true');
    if (c.expects) body.push(`expects: "${c.expects}"`);
    if (c.returns) body.push(`returns: "${c.returns}"`);
    if (c.arguments !== undefined) body.push(`arguments: ${JSON.stringify(c.arguments)}`);
    body.push(`source: "${spec.url}.trig"`);
    body.push(`note: ${JSON.stringify(c.scopeNote)}`);
    body.push(':::', '');
  }
  body.push('> To act: dereference the descriptor and follow a control by its `rel` — the follower re-resolves the live `target` from the signed source, never from this rendering.');
  return `${front.join('\n')}${body.join('\n')}\n`;
}

// ── Scoring ───────────────────────────────────────────────────────────────────────────────

const normalizePath = (p: string): string => p.replace(/\\/g, '/').replace(/^\.\//, '');

/** Whether the top-ranked answer, and any of the top three, was among the truths; null when no truth was observed. */
export function rankHits(ranked: readonly string[], truth: ReadonlySet<string>): { hitAt1: boolean | null; hitAt3: boolean | null } {
  if (truth.size === 0) return { hitAt1: null, hitAt3: null };
  const norm = new Set([...truth].map(normalizePath));
  return {
    hitAt1: norm.has(normalizePath(ranked[0] ?? '')),
    hitAt3: ranked.slice(0, 3).some((r) => norm.has(normalizePath(r))),
  };
}

/** The mean squared distance between each candidate's probability and whether it was a truth; null without truths or candidates. */
export function brierScore(candidates: readonly { readonly key: string; readonly probability: number }[], truth: ReadonlySet<string>): number | null {
  if (truth.size === 0 || candidates.length === 0) return null;
  const norm = new Set([...truth].map(normalizePath));
  const sum = candidates.reduce((s, c) => s + (c.probability - (norm.has(normalizePath(c.key)) ? 1 : 0)) ** 2, 0);
  return Math.round((sum / candidates.length) * 1e4) / 1e4;
}
