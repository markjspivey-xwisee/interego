/**
 * Interrogative router — the runtime realization of the `ie:` grammar.
 *
 * The published Interego Interrogatives Core Ontology (docs/ns/interego.ttl)
 * defines eleven canonical interrogatives (Who/What/Where/When/Why/How/Which/
 * WhatKind/HowMuch/Whose/Whether), and docs/ns/alignment.ttl maps each to the
 * layer/facet that ANSWERS it. This module turns that published grammar into a
 * runtime read: given a context-descriptor's Turtle, it classifies a question
 * into interrogative type(s) and PROJECTS the answering facet(s) already present
 * on the descriptor — composing the existing typed-context machinery, not
 * reinventing retrieval.
 *
 * Honesty is structural: every answer carries a `status`
 *   - 'full'    — the interrogative is wholly answered from the descriptor facet
 *   - 'partial' — part is answered here; the rest needs another primitive (nextStep)
 *   - 'pointer' — not on the descriptor at all; only a nextStep pointer is emitted
 *   - 'absent'  — the answering facet is not present on this descriptor
 * The runtime resolution is verified against the actual serializer output
 * (packages/core/src/rdf/serializer.ts), NOT the aspirational ontology mapping.
 *
 * PURE: no I/O, no network, no top-level side effects. The grammar table is the
 * frozen, build-time-derived `INTERROGATIVE_TABLE` (single-sourced from the .ttl
 * via `deriveInterrogativeTable`, drift-guarded by a test). The relay tool is a
 * thin composer over this + the existing get_descriptor read.
 */
import {
  parseTrig, findSubjectsOfType, readStringValue, readStringValues, readIriValue,
  type IRI, type ParsedDocument, type ParsedSubject, type ParsedTerm,
} from '@interego/core';
import { INTERROGATIVE_TABLE } from './interrogative-table.generated.js';

// ── Namespaces (verified against packages/core/src/rdf/namespaces.ts) ─────────
const CG = 'https://markjspivey-xwisee.github.io/interego/ns/cg#';
const PROV = 'http://www.w3.org/ns/prov#';
const ACL = 'http://www.w3.org/ns/auth/acl#';
const DCAT = 'http://www.w3.org/ns/dcat#';
const RDFS = 'http://www.w3.org/2000/01/rdf-schema#';
const IE = 'https://markjspivey-xwisee.github.io/interego/ns/interego#';
const SKOS = 'http://www.w3.org/2004/02/skos/core#';
const ALIGN = 'https://markjspivey-xwisee.github.io/interego/ns/alignment#';
const P = (s: string): IRI => s as IRI;

export type InterrogativeType =
  | 'Who' | 'What' | 'Where' | 'When' | 'Why' | 'How'
  | 'Which' | 'WhatKind' | 'HowMuch' | 'Whose' | 'Whether';

/** Canonical order — keeps generated table + classification output deterministic. */
export const CANONICAL_ORDER: readonly InterrogativeType[] = [
  'Who', 'What', 'Where', 'When', 'Why', 'How', 'Which', 'WhatKind', 'HowMuch', 'Whose', 'Whether',
];

export interface InterrogativeEntry {
  /** localname, e.g. 'WhatKind'. */
  type: InterrogativeType;
  /** full ie: IRI. */
  iri: string;
  /** skos:prefLabel. */
  prefLabel: string;
  /** skos:altLabel[] (lexical classification cues). */
  altLabels: string[];
  /** answering classes (compacted curies) declared by align:answersInterrogative. */
  answeredBy: string[];
}

// ── 1. Build-time derivation (pure; used by the codegen + the drift test) ─────

const CURIE_PREFIXES: ReadonlyArray<readonly [string, string]> = [
  ['cg:', CG], ['prov:', PROV], ['acl:', ACL], ['dcat:', DCAT],
  ['rdfs:', RDFS], ['ie:', IE], ['skos:', SKOS], ['align:', ALIGN],
  ['pgsl:', 'https://markjspivey-xwisee.github.io/interego/ns/pgsl#'],
  ['cgh:', 'https://markjspivey-xwisee.github.io/interego/ns/harness#'],
];
function compact(iri: string): string {
  for (const [pfx, ns] of CURIE_PREFIXES) if (iri.startsWith(ns)) return pfx + iri.slice(ns.length);
  return iri;
}
function localOf(iri: string): string {
  // Split on #, /, or : so both full IRIs (…#Who, …/Who) and curies (ie:Who) reduce
  // to the localname. For IRIs the # or / always follows the scheme ':' so it wins.
  const i = Math.max(iri.lastIndexOf('#'), iri.lastIndexOf('/'), iri.lastIndexOf(':'));
  return i >= 0 ? iri.slice(i + 1) : iri;
}
function iriValuesOf(subject: ParsedSubject, predicate: IRI): string[] {
  return (subject.properties.get(predicate) ?? []).filter((t): t is Extract<ParsedTerm, { kind: 'iri' }> => t.kind === 'iri').map(t => t.iri);
}

/**
 * Derive the interrogative table from the two ontology source documents.
 * PURE (takes the .ttl strings). The generator writes its output to
 * interrogative-table.generated.ts; the drift test re-runs it and compares.
 */
export function deriveInterrogativeTable(interegoTtl: string, alignmentTtl: string): InterrogativeEntry[] {
  const ie = parseTrig(interegoTtl);
  const al = parseTrig(alignmentTtl);

  // interrogative -> answering classes, inverted from align:answersInterrogative
  const answeredBy = new Map<string, string[]>();
  for (const subj of al.subjects) {
    const targets = iriValuesOf(subj, P(ALIGN + 'answersInterrogative'));
    if (targets.length === 0 || typeof subj.subject !== 'string') continue;
    const cls = compact(subj.subject);
    for (const t of targets) {
      const loc = localOf(t);
      const list = answeredBy.get(loc) ?? [];
      if (!list.includes(cls)) list.push(cls);
      answeredBy.set(loc, list);
    }
  }

  const byLocal = new Map<string, InterrogativeEntry>();
  for (const subj of findSubjectsOfType(ie, P(IE + 'Interrogative'))) {
    if (typeof subj.subject !== 'string') continue;
    const type = localOf(subj.subject) as InterrogativeType;
    if (!CANONICAL_ORDER.includes(type)) continue; // skip the ie:Interrogative scheme itself
    const prefLabel = readStringValue(subj, P(SKOS + 'prefLabel')) ?? type;
    const altLabels = [...readStringValues(subj, P(SKOS + 'altLabel'))];
    byLocal.set(type, { type, iri: subj.subject, prefLabel, altLabels, answeredBy: (answeredBy.get(type) ?? []).sort() });
  }

  return CANONICAL_ORDER.filter(t => byLocal.has(t)).map(t => byLocal.get(t)!);
}

// ── 2. Classification (lexical, multi-label, no LLM) ──────────────────────────

export interface ClassificationCue { interrogative: InterrogativeType; matchedLabel: string; source: 'prefLabel' | 'altLabel'; }

const norm = (s: string): string => ' ' + s.toLowerCase().replace(/[^a-z0-9\s]/g, ' ').replace(/\s+/g, ' ').trim() + ' ';

/**
 * Classify a natural-language question into interrogative type(s) by matching the
 * SKOS prefLabel + altLabel cues from the table. Multi-label by design (one
 * question often poses several interrogatives). Longest cues first, with span
 * consumption so 'what kind' beats bare 'what' and 'how much' beats 'how'.
 */
export function classifyInterrogatives(question: string): { interrogatives: InterrogativeType[]; cues: ClassificationCue[] } {
  let hay = norm(question);
  const cues: ClassificationCue[] = [];
  const found = new Set<InterrogativeType>();
  const all = INTERROGATIVE_TABLE.flatMap(e => [
    { t: e.type, label: e.prefLabel, source: 'prefLabel' as const },
    ...e.altLabels.map(a => ({ t: e.type, label: a, source: 'altLabel' as const })),
  ]).map(c => ({ ...c, n: norm(c.label) }))
    .sort((a, b) => b.n.length - a.n.length);
  for (const c of all) {
    if (c.n === '  ' || c.n.trim() === '') continue;
    if (hay.includes(c.n)) {
      cues.push({ interrogative: c.t, matchedLabel: c.label, source: c.source });
      found.add(c.t);
      hay = hay.split(c.n).join(' '); // consume the span so shorter cues don't double-match it
    }
  }
  const interrogatives = CANONICAL_ORDER.filter(t => found.has(t));
  return { interrogatives, cues };
}

/** Resolve explicit interrogative input (IRI / localname / prefLabel / altLabel) to canonical types. */
export function normalizeInterrogatives(input: string | readonly string[]): InterrogativeType[] {
  const items = Array.isArray(input) ? input : [input];
  const out = new Set<InterrogativeType>();
  for (const raw of items as string[]) {
    const want = norm(raw).trim();
    const wantLocal = localOf(raw.trim());
    for (const e of INTERROGATIVE_TABLE) {
      if (
        e.type.toLowerCase() === wantLocal.toLowerCase() ||
        norm(e.prefLabel).trim() === want ||
        e.altLabels.some(a => norm(a).trim() === want) ||
        e.type.toLowerCase() === want.replace(/\s+/g, '')
      ) { out.add(e.type); break; }
    }
  }
  return CANONICAL_ORDER.filter(t => out.has(t));
}

// ── 3. Facet projection helpers (operate on a ParsedDocument) ─────────────────

function facetOf(doc: ParsedDocument, facetLocal: string): ParsedSubject | undefined {
  return findSubjectsOfType(doc, P(CG + facetLocal))[0];
}
function derefBnode(doc: ParsedDocument, term: ParsedTerm | undefined): ParsedSubject | undefined {
  if (!term || term.kind !== 'bnode') return undefined;
  return doc.subjects.find(s => typeof s.subject === 'object' && s.subject.bnode === term.id);
}
function firstBnode(subj: ParsedSubject, pred: IRI): ParsedTerm | undefined {
  return (subj.properties.get(pred) ?? []).find(t => t.kind === 'bnode');
}
function allBnodes(subj: ParsedSubject, pred: IRI): ParsedTerm[] {
  return (subj.properties.get(pred) ?? []).filter(t => t.kind === 'bnode');
}
/** Drop undefined/empty so an answer's `values` only carries what's actually present. */
function clean(o: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(o)) {
    if (v === undefined || v === null) continue;
    if (Array.isArray(v) && v.length === 0) continue;
    out[k] = v;
  }
  return out;
}

// ── 4. Result types ───────────────────────────────────────────────────────────

export type AnswerStatus = 'full' | 'partial' | 'pointer' | 'absent';
export interface NextStep { tool: string; target?: string; reason: string; }
export interface InterrogativeAnswer {
  interrogative: InterrogativeType;
  status: AnswerStatus;
  answeredBy: string[];
  values?: Record<string, unknown>;
  nextStep?: NextStep;
  sharesFacetWith?: InterrogativeType[];
  caveat?: string;
}
export interface RouteClassification {
  method: 'explicit' | 'lexical' | 'all';
  interrogatives: InterrogativeType[];
  cues?: ClassificationCue[];
}
export interface RouteResult {
  ok: true;
  target?: string;
  targetKind: 'descriptor';
  classification: RouteClassification;
  answers: InterrogativeAnswer[];
  authorship?: unknown;
  act: Record<string, unknown>;
  response: Record<string, unknown>;
  caveats: string[];
}
export interface RouteError { ok: false; error: string; detail?: string; }

// ── 5. Per-interrogative projection (verified against serializer.ts) ──────────

function describesTargets(doc: ParsedDocument): string[] {
  const subj = doc.subjects.find(s => s.properties.has(P(CG + 'describes')));
  return subj ? iriValuesOf(subj, P(CG + 'describes')) : [];
}

function projectOne(
  doc: ParsedDocument,
  t: InterrogativeType,
  answeredBy: string[],
  authorship: { effectiveTrustLevel?: string; authorshipVerified?: boolean; signedBy?: string } | undefined,
): InterrogativeAnswer {
  const base = { interrogative: t, answeredBy } as const;
  const targets = describesTargets(doc);
  const firstTarget = targets[0];

  switch (t) {
    case 'When': {
      const f = facetOf(doc, 'TemporalFacet');
      if (!f) return { ...base, status: 'absent', caveat: 'no cg:TemporalFacet on this descriptor' };
      return { ...base, status: 'full', values: clean({
        validFrom: readStringValue(f, P(CG + 'validFrom')),
        validUntil: readStringValue(f, P(CG + 'validUntil')),
        temporalResolution: readStringValue(f, P(CG + 'temporalResolution')),
        temporalRelation: readIriValue(f, P(CG + 'temporalRelation')),
      }) };
    }
    case 'WhatKind': {
      const f = facetOf(doc, 'SemioticFacet');
      if (!f) return { ...base, status: 'absent', caveat: 'no cg:SemioticFacet on this descriptor' };
      const conf = readStringValue(f, P(CG + 'epistemicConfidence'));
      return { ...base, status: 'full', values: clean({
        interpretationFrame: readIriValue(f, P(CG + 'interpretationFrame')),
        signSystem: readIriValue(f, P(CG + 'signSystem')),
        groundTruth: readStringValue(f, P(CG + 'groundTruth')),
        modalStatus: readIriValue(f, P(CG + 'modalStatus')),
        epistemicConfidence: conf !== undefined ? Number(conf) : 0.5,
        languageTag: readStringValue(f, P(CG + 'languageTag')),
      }) };
    }
    case 'Where': {
      const f = facetOf(doc, 'FederationFacet');
      if (!f) return { ...base, status: 'absent', caveat: 'no cg:FederationFacet on this descriptor' };
      const dist = derefBnode(doc, firstBnode(f, P(DCAT + 'distribution')));
      return { ...base, status: 'full', values: clean({
        origin: readIriValue(f, P(CG + 'origin')),
        storageEndpoint: readIriValue(f, P(CG + 'storageEndpoint')),
        endpointURL: readIriValue(f, P(DCAT + 'endpointURL')),
        syncProtocol: readIriValue(f, P(CG + 'syncProtocol')),
        replicaOf: readIriValue(f, P(CG + 'replicaOf')),
        lastSynced: readStringValue(f, P(CG + 'lastSynced')),
        distribution: dist ? clean({
          mediaType: readStringValue(dist, P(DCAT + 'mediaType')),
          accessURL: readIriValue(dist, P(DCAT + 'accessURL')),
        }) : undefined,
      }) };
    }
    case 'Who': {
      const f = facetOf(doc, 'AgentFacet');
      if (!f) return { ...base, status: 'absent', caveat: 'no cg:AgentFacet on this descriptor' };
      const agent = derefBnode(doc, firstBnode(f, P(CG + 'assertingAgent')));
      const identity = agent ? readIriValue(agent, P(CG + 'agentIdentity')) : undefined;
      const values = clean({
        assertingAgent: agent ? clean({
          identity,
          label: readStringValue(agent, P(RDFS + 'label')),
          types: iriValuesOf(agent, P('http://www.w3.org/1999/02/22-rdf-syntax-ns#type')),
        }) : undefined,
        agentRole: readIriValue(f, P(CG + 'agentRole')),
        onBehalfOf: readIriValue(f, P(CG + 'onBehalfOf')),
      });
      // FULL only if the asserting identity is actually present (the substance of Who).
      const status: AnswerStatus = identity ? 'full' : 'partial';
      return { ...base, status, values, ...(status === 'partial' ? { caveat: 'AgentFacet present but no cg:assertingAgent identity — only role/delegation available' } : {}) };
    }
    case 'Whose': {
      const ac = facetOf(doc, 'AccessControlFacet');
      const ag = facetOf(doc, 'AgentFacet');
      if (!ac && !ag) return { ...base, status: 'absent', caveat: 'no cg:AccessControlFacet or cg:AgentFacet on this descriptor' };
      const authorizations = ac ? allBnodes(ac, P(CG + 'authorization')).map(b => derefBnode(doc, b)).filter((s): s is ParsedSubject => !!s).map(a => clean({
        agent: readIriValue(a, P(ACL + 'agent')),
        agentClass: readIriValue(a, P(ACL + 'agentClass')),
        mode: iriValuesOf(a, P(ACL + 'mode')),
      })) : [];
      return { ...base, status: 'full', values: clean({
        authorizations,
        consentBasis: ac ? readIriValue(ac, P(CG + 'consentBasis')) : undefined,
        onBehalfOf: ag ? readIriValue(ag, P(CG + 'onBehalfOf')) : undefined,
      }) };
    }
    case 'Whether': {
      const tr = facetOf(doc, 'TrustFacet');
      const sem = facetOf(doc, 'SemioticFacet');
      const values = clean({
        trustLevel: tr ? readIriValue(tr, P(CG + 'trustLevel')) : undefined,
        issuer: tr ? readIriValue(tr, P(CG + 'issuer')) : undefined,
        verifiableCredential: tr ? readIriValue(tr, P(CG + 'verifiableCredential')) : undefined,
        proofMechanism: tr ? readIriValue(tr, P(CG + 'proofMechanism')) : undefined,
        revocationStatus: tr ? readIriValue(tr, P(CG + 'revocationStatus')) : undefined,
        modalStatus: sem ? readIriValue(sem, P(CG + 'modalStatus')) : undefined,
        // The SUBSTRATE-verified trust — re-derived by get_descriptor from the
        // authorship proof + delegation chain, not merely the declared body.
        effectiveTrustLevel: authorship?.effectiveTrustLevel,
        authorshipVerified: authorship?.authorshipVerified,
      });
      const hasAny = Object.keys(values).length > 0;
      return {
        ...base,
        status: hasAny ? 'partial' : 'absent',
        values: hasAny ? values : undefined,
        nextStep: { tool: 'pgsl_decide', reason: 'permission/deontic "whether" (is it allowed?) is a cgh:PolicyDecision — not on the descriptor' },
        caveat: 'certainty/modality answered from Trust/Semiotic facets + substrate-verified authorship; permission requires a policy decision',
      };
    }
    case 'Why': {
      const f = facetOf(doc, 'ProvenanceFacet');
      if (!f) return { ...base, status: 'absent', sharesFacetWith: ['How'], caveat: 'no cg:ProvenanceFacet on this descriptor' };
      const act = derefBnode(doc, firstBnode(f, P(PROV + 'wasGeneratedBy')));
      return { ...base, status: 'partial', sharesFacetWith: ['How'], values: clean({
        wasDerivedFrom: iriValuesOf(f, P(PROV + 'wasDerivedFrom')),
        wasAttributedTo: readIriValue(f, P(PROV + 'wasAttributedTo')),
        generatedAtTime: readStringValue(f, P(PROV + 'generatedAtTime')),
        activity: act ? clean({
          agent: readIriValue(act, P(PROV + 'wasAssociatedWith')),
          startedAt: readStringValue(act, P(PROV + 'startedAtTime')),
          endedAt: readStringValue(act, P(PROV + 'endedAtTime')),
          used: iriValuesOf(act, P(PROV + 'used')),
        }) : undefined,
      }), nextStep: { tool: 'pgsl_decide', reason: 'motivating reason (vs causal provenance) is a cgh:Decision justification — not on the descriptor' }, caveat: 'causal provenance answered here; motive needs the decision record. Shares cg:ProvenanceFacet with How.' };
    }
    case 'How': {
      const f = facetOf(doc, 'ProvenanceFacet');
      if (!f) return { ...base, status: 'absent', sharesFacetWith: ['Why'], caveat: 'no cg:ProvenanceFacet on this descriptor' };
      const act = derefBnode(doc, firstBnode(f, P(PROV + 'wasGeneratedBy')));
      return { ...base, status: 'partial', sharesFacetWith: ['Why'], values: clean({
        productionActivity: act ? clean({
          agent: readIriValue(act, P(PROV + 'wasAssociatedWith')),
          startedAt: readStringValue(act, P(PROV + 'startedAtTime')),
          used: iriValuesOf(act, P(PROV + 'used')),
        }) : undefined,
        wasDerivedFrom: iriValuesOf(f, P(PROV + 'wasDerivedFrom')),
      }), nextStep: { tool: 'pgsl_resolve', target: firstTarget, reason: 'compositional "how" (pgsl:PullbackSquare — how the content is composed) lives in the substrate lattice, reachable by resolving cg:describes' }, caveat: 'production-method answered here; compositional structure via pgsl_resolve/decompose. Shares cg:ProvenanceFacet with Why.' };
    }
    case 'HowMuch': {
      const sem = facetOf(doc, 'SemioticFacet');
      const conf = sem ? readStringValue(sem, P(CG + 'epistemicConfidence')) : undefined;
      return { ...base, status: 'partial', values: clean({ epistemicConfidence: conf !== undefined ? Number(conf) : undefined }),
        nextStep: { tool: 'pgsl_lattice_status', target: firstTarget, reason: 'cardinality/extent (pgsl:level, atomCount, fragmentCount) is a substrate-lattice quantity' },
        caveat: 'degree-of-certainty answerable from the Semiotic facet; quantity/extent needs the lattice' };
    }
    case 'What': {
      return { ...base, status: 'pointer',
        ...(targets.length ? { values: { describes: targets } } : {}),
        nextStep: { tool: 'pgsl_resolve', target: firstTarget, reason: 'the VALUE (pgsl:Atom/Fragment) lives in the substrate lattice; the descriptor only points at it via cg:describes' },
        caveat: 'not on the descriptor — resolve cg:describes in the PGSL lattice' };
    }
    case 'Which': {
      return { ...base, status: 'pointer',
        nextStep: { tool: 'pgsl_decide', reason: 'selection among alternatives is a cgh:Decision (the OODA decision functor) — not a descriptor facet' },
        caveat: 'not on the descriptor — a selection is produced by the decision functor' };
    }
  }
}

// ── 6. Top-level route (the thin relay tool composes this over get_descriptor) ─

export interface RouteOptions {
  /** Descriptor Turtle (or decrypted TriG/Turtle content) to project. */
  turtle: string;
  question?: string;
  interrogatives?: string | readonly string[];
  /** Project ALL eleven (only honored when no question / interrogatives given). */
  all?: boolean;
  authorship?: { effectiveTrustLevel?: string; authorshipVerified?: boolean; signedBy?: string };
  /** The descriptor URL/IRI (for the response provenance + act `about`). */
  target?: string;
}

export function resolveRequestedInterrogatives(opts: { question?: string; interrogatives?: string | readonly string[]; all?: boolean }): RouteClassification | RouteError {
  if (opts.interrogatives !== undefined && (Array.isArray(opts.interrogatives) ? opts.interrogatives.length : String(opts.interrogatives).trim())) {
    const interrogatives = normalizeInterrogatives(opts.interrogatives);
    if (interrogatives.length === 0) return { ok: false, error: 'no recognized interrogative in `interrogatives` — use one of: ' + CANONICAL_ORDER.join(', ') };
    return { method: 'explicit', interrogatives };
  }
  if (opts.question && opts.question.trim()) {
    const { interrogatives, cues } = classifyInterrogatives(opts.question);
    if (interrogatives.length === 0) return { ok: false, error: 'could not classify any interrogative from the question — pass `interrogatives` explicitly (one of: ' + CANONICAL_ORDER.join(', ') + ')' };
    return { method: 'lexical', interrogatives, cues };
  }
  if (opts.all) return { method: 'all', interrogatives: [...CANONICAL_ORDER] };
  return { ok: false, error: 'specify a `question`, an `interrogatives` list, or `all:true`' };
}

export function routeInterrogatives(opts: RouteOptions): RouteResult | RouteError {
  const cls = resolveRequestedInterrogatives(opts);
  if ('ok' in cls && cls.ok === false) return cls;
  const classification = cls as RouteClassification;

  let doc: ParsedDocument;
  try { doc = parseTrig(opts.turtle); }
  catch (e) { return { ok: false, error: 'descriptor-not-parseable', detail: (e as Error).message }; }

  const answers = classification.interrogatives.map(t => {
    const entry = INTERROGATIVE_TABLE.find(e => e.type === t);
    return projectOne(doc, t, entry ? entry.answeredBy : [], opts.authorship);
  });

  const caveats: string[] = [];
  if (answers.some(a => a.sharesFacetWith)) caveats.push('Why and How are both answered from the same cg:ProvenanceFacet; the split is by which properties are surfaced + the nextStep, not two distinct facets.');
  if (answers.some(a => a.status === 'pointer')) caveats.push('Some interrogatives (What/Which) are not descriptor facets — only a nextStep pointer to the answering primitive is returned.');
  if (answers.every(a => a.status === 'absent')) caveats.push('None of the requested interrogatives are answerable from this descriptor (the answering facets are absent).');

  // ie:Act / ie:Response shaped JSON-LD (NOT published; describes this read).
  const act = {
    '@type': 'ie:Act',
    'ie:interrogativeType': classification.interrogatives.map(t => `ie:${t}`),
    ...(opts.target ? { 'ie:about': opts.target } : {}),
  };
  const response = {
    '@type': 'ie:Response',
    ...(opts.target ? { 'ie:grounds': opts.target } : {}),
    'prov:wasAttributedTo': 'urn:interego:interrogative-router',
  };

  return {
    ok: true,
    ...(opts.target ? { target: opts.target } : {}),
    targetKind: 'descriptor',
    classification,
    answers,
    ...(opts.authorship ? { authorship: opts.authorship } : {}),
    act,
    response,
    caveats,
  };
}
