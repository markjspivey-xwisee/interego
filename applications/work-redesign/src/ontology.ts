/**
 * The wrd: vocabulary, and the published policy the engines apply.
 *
 * ontology/wrd.ttl is the canonical source. It is not only documentation: the regimes, the
 * method each one routes to, the allocation levels each one permits, the classification rules
 * and the default grant policy are individuals in that file, and readPublishedPolicy() parses
 * them at runtime. Nothing here falls back to constants when the file lacks them — a policy
 * that cannot be read is a refusal to classify, not a silent default. Every record cites the
 * sha256 of the exact text that was parsed, so a later edit to the file never reinterprets
 * an old record.
 *
 * Pure: no environment reads, no network. The only I/O is reading the two Turtle files that ship
 * beside this module.
 */
import { readFileSync } from 'node:fs';
import {
  parseTrig, findSubjectsOfType, readStringValue, readStringValues, readIriValue, readIntegerValue, sha256Hex,
  type IRI, type ParsedSubject,
} from '@interego/core';

export const WRD_NS = 'https://markjspivey-xwisee.github.io/interego/applications/work-redesign/wrd#';
export const WRD_ONTOLOGY_IRI = 'https://markjspivey-xwisee.github.io/interego/applications/work-redesign/wrd';
export const WRD_SHAPES_NS = 'https://markjspivey-xwisee.github.io/interego/applications/work-redesign/wrd/shapes#';

export const wrdTerm = (local: string): string => `${WRD_NS}${local}`;

function readOntologyFile(file: string): string {
  const candidates = [
    new URL(`../ontology/${file}`, import.meta.url),
    new URL(`../../ontology/${file}`, import.meta.url),
  ];
  for (const url of candidates) {
    try { return readFileSync(url, 'utf8'); } catch { /* try the next candidate */ }
  }
  throw new Error(`wrd ontology artifact not found: ${file}`);
}

export const readOntologyTurtle = (): string => readOntologyFile('wrd.ttl');
export const readShapesTurtle = (): string => readOntologyFile('wrd-shapes.ttl');

// ── Vocabulary types ──────────────────────────────────────────────────────────────────────

export type Regime = 'Evident' | 'Knowable' | 'Emergent' | 'Turbulent';
export type MethodToken = 'standardise' | 'expert-analysis' | 'probe-portfolio' | 'stabilise-first';
export type AllocationLevel = 'person' | 'person-with-agent-assist' | 'agent-drafts-person-decides'
  | 'agent-acts-person-audits' | 'agent-acts-within-grant';
export type Checkability = 'before-effect' | 'after-effect' | 'not-checkable' | 'unknown';
export type ComparisonBasis = 'holdout' | 'staggered' | 'before-after';
export type InputBasis = 'measured' | 'document' | 'performer-reported' | 'estimate';
export type FreedHoursDisposition = 'redeployed' | 'absorbed' | 'unfilled' | 'undecided';
export type OutcomeDisposition = 'kept' | 'reverted' | 'stopped-early';
export type OutcomeMetric = 'weekly-cash-delta' | 'weekly-delta-if-redeployed';
export type ProbeSignal = 'amplify' | 'dampen' | 'neither';
export type RegistryRole = 'approver' | 'operator' | 'worker' | 'agent';

export const REGIMES: readonly Regime[] = ['Evident', 'Knowable', 'Emergent', 'Turbulent'];
/** In autonomy order. Internal ordering only: the UI shows level names, never a rank. */
export const ALLOCATION_LEVELS: readonly AllocationLevel[] = [
  'person', 'person-with-agent-assist', 'agent-drafts-person-decides', 'agent-acts-person-audits', 'agent-acts-within-grant',
];
export const CHECKABILITIES: readonly Checkability[] = ['before-effect', 'after-effect', 'not-checkable', 'unknown'];
export const COMPARISON_BASES: readonly ComparisonBasis[] = ['holdout', 'staggered', 'before-after'];
export const INPUT_BASES: readonly InputBasis[] = ['measured', 'document', 'performer-reported', 'estimate'];
export const FREED_HOURS_DISPOSITIONS: readonly FreedHoursDisposition[] = ['redeployed', 'absorbed', 'unfilled', 'undecided'];
export const OUTCOME_DISPOSITIONS: readonly OutcomeDisposition[] = ['kept', 'reverted', 'stopped-early'];
export const OUTCOME_METRICS: readonly OutcomeMetric[] = ['weekly-cash-delta', 'weekly-delta-if-redeployed'];
export const PROBE_SIGNALS: readonly ProbeSignal[] = ['amplify', 'dampen', 'neither'];
export const REGISTRY_ROLES: readonly RegistryRole[] = ['approver', 'operator', 'worker', 'agent'];

/** A published rule applied to answers a named person signed — never agp's 'derived'. */
export const REGIME_SOURCE = 'rule-on-signed-answers';

const LEVEL_LOCAL: Readonly<Record<AllocationLevel, string>> = {
  'person': 'LevelPerson',
  'person-with-agent-assist': 'LevelPersonWithAgentAssist',
  'agent-drafts-person-decides': 'LevelAgentDraftsPersonDecides',
  'agent-acts-person-audits': 'LevelAgentActsPersonAudits',
  'agent-acts-within-grant': 'LevelAgentActsWithinGrant',
};
/** The IRI of a level individual in wrd.ttl (readPublishedPolicy checks the file agrees). */
export const levelIri = (level: AllocationLevel): string => wrdTerm(LEVEL_LOCAL[level]);
/** The IRI of a regime individual in wrd.ttl. */
export const regimeIri = (regime: Regime): string => wrdTerm(regime);
const METHOD_LOCAL: Readonly<Record<MethodToken, string>> = {
  'standardise': 'Standardise', 'expert-analysis': 'ExpertAnalysis', 'probe-portfolio': 'ProbePortfolio', 'stabilise-first': 'StabiliseFirst',
};
/** The IRI of a method individual in wrd.ttl. */
export const methodIri = (method: MethodToken): string => wrdTerm(METHOD_LOCAL[method]);

export const isRegime = (v: unknown): v is Regime => typeof v === 'string' && (REGIMES as readonly string[]).includes(v);
export const isLevel = (v: unknown): v is AllocationLevel => typeof v === 'string' && (ALLOCATION_LEVELS as readonly string[]).includes(v);
export const isOneOf = <T extends string>(options: readonly T[], v: unknown): v is T => typeof v === 'string' && (options as readonly string[]).includes(v);

// ── Published policy ──────────────────────────────────────────────────────────────────────

export interface RegimeRule {
  readonly regime: Regime;
  readonly iri: string;
  readonly method: MethodToken;
  readonly methodIri: string;
  readonly permitsChange: boolean;
  readonly requiresProbe: boolean;
  readonly pointValuation: boolean;
  readonly requiresExpertEvidence: boolean;
  readonly permittedLevels: readonly AllocationLevel[];
  readonly note: string;
}
export interface LevelRule {
  readonly level: AllocationLevel;
  readonly iri: string;
  readonly autonomyRank: number;
  readonly requiresAgent: boolean;
  readonly requiresPerson: boolean;
  readonly requiresGrant: boolean;
  readonly requiresCheckability: readonly Checkability[];
}
export interface GrantPolicy {
  readonly iri: string;
  readonly floor: number;
  readonly minSamples: number;
  readonly minHumanConfirmations: number;
  readonly minDistinctConfirmers: number;
  readonly minReadyClaimPrecision: number;
  /** 0.01 → ceil(3 / 0.01) = 300 clean runs before a grant covers critical work. */
  readonly criticalWorkFailureCeiling: number;
  readonly contraryReworkShare: number;
  readonly contraryMinRuns: number;
}
export type RuleId = 'R0' | 'R1' | 'R2' | 'R3a' | 'R3b' | 'R4';
export const RULE_IDS: readonly RuleId[] = ['R0', 'R1', 'R2', 'R3a', 'R3b', 'R4'];
export interface ClassificationRule {
  readonly id: RuleId;
  readonly iri: string;
  readonly condition: string;
  /** The regime the rule places a task in, read from wrd:yields; null only for R0. */
  readonly yields: Regime | null;
}
export interface PublishedPolicy {
  readonly regimes: ReadonlyMap<Regime, RegimeRule>;
  readonly levels: ReadonlyMap<AllocationLevel, LevelRule>;
  readonly grantPolicy: GrantPolicy;
  readonly rules: ReadonlyMap<RuleId, ClassificationRule>;
  readonly regimeSourceIri: string;
  readonly valuationMethodIri: string;
  /** sha256Hex of the exact wrd.ttl text parsed. */
  readonly ontologySha256: string;
}

const RDFS_COMMENT = 'http://www.w3.org/2000/01/rdf-schema#comment' as IRI;
const p = (local: string): IRI => wrdTerm(local) as IRI;

function subjectIri(s: ParsedSubject): string {
  return typeof s.subject === 'string' ? s.subject : '';
}

function readBool(s: ParsedSubject, local: string, what: string): boolean {
  const v = readStringValue(s, p(local));
  if (v === 'true') return true;
  if (v === 'false') return false;
  throw new Error(`wrd.ttl: ${what} has no boolean wrd:${local}`);
}

function readNumber(s: ParsedSubject, local: string, what: string): number {
  const raw = readStringValue(s, p(local));
  const n = raw === undefined ? Number.NaN : Number(raw);
  if (!Number.isFinite(n)) throw new Error(`wrd.ttl: ${what} has no numeric wrd:${local}`);
  return n;
}

function iriValues(s: ParsedSubject, local: string): string[] {
  const out: string[] = [];
  for (const t of s.properties.get(p(local)) ?? []) if (t.kind === 'iri') out.push(t.iri);
  return out;
}

/**
 * Parse the published policy out of wrd.ttl. Throws — never falls back — if any regime lacks
 * wrd:routesTo, any of the five levels is missing, a regime permits an undeclared level, any of
 * the six rules is missing or yields an undeclared regime, the regime source or the valuation
 * method individual is missing, or the default grant policy is missing or non-numeric.
 */
export function readPublishedPolicy(turtle: string = readOntologyTurtle()): PublishedPolicy {
  const doc = parseTrig(turtle);
  const byIri = new Map<string, ParsedSubject>();
  for (const s of doc.subjects) if (typeof s.subject === 'string') byIri.set(s.subject, s);

  // Levels first: regimes refer to them.
  const levels = new Map<AllocationLevel, LevelRule>();
  const levelByIri = new Map<string, AllocationLevel>();
  for (const s of findSubjectsOfType(doc, p('AllocationLevel'))) {
    const token = readStringValue(s, p('levelToken'));
    if (!isLevel(token)) throw new Error(`wrd.ttl: allocation level ${subjectIri(s)} has an unknown wrd:levelToken ${String(token)}`);
    const rank = readIntegerValue(s, p('autonomyRank'));
    if (rank === undefined) throw new Error(`wrd.ttl: level ${token} has no wrd:autonomyRank`);
    const checks = readStringValues(s, p('requiresCheckability'));
    for (const c of checks) if (!isOneOf(CHECKABILITIES, c)) throw new Error(`wrd.ttl: level ${token} requires an unknown checkability ${c}`);
    const rule: LevelRule = {
      level: token, iri: subjectIri(s), autonomyRank: rank,
      requiresAgent: readBool(s, 'requiresAgent', `level ${token}`),
      requiresPerson: readBool(s, 'requiresPerson', `level ${token}`),
      requiresGrant: readBool(s, 'requiresGrant', `level ${token}`),
      requiresCheckability: checks as Checkability[],
    };
    if (rule.iri !== levelIri(token)) throw new Error(`wrd.ttl: level ${token} is declared at ${rule.iri}, not where the records name it`);
    levels.set(token, rule);
    levelByIri.set(rule.iri, token);
  }
  for (const l of ALLOCATION_LEVELS) if (!levels.has(l)) throw new Error(`wrd.ttl: allocation level ${l} is not declared`);

  const regimes = new Map<Regime, RegimeRule>();
  const regimeByIri = new Map<string, Regime>();
  const regimeSubjects = findSubjectsOfType(doc, p('Regime'));
  const routes = regimeSubjects.filter((s) => readIriValue(s, p('routesTo')) !== undefined).length;
  if (routes === 0) throw new Error('wrd.ttl: zero wrd:routesTo edges — refusing to classify');
  for (const s of regimeSubjects) {
    const token = readStringValue(s, p('regimeToken'));
    if (!isRegime(token)) throw new Error(`wrd.ttl: regime ${subjectIri(s)} has an unknown wrd:regimeToken ${String(token)}`);
    const routedIri = readIriValue(s, p('routesTo'));
    if (routedIri === undefined) throw new Error(`wrd.ttl: regime ${token} has no wrd:routesTo`);
    const methodSubject = byIri.get(routedIri);
    const method = methodSubject ? readStringValue(methodSubject, p('methodToken')) : undefined;
    if (method !== 'standardise' && method !== 'expert-analysis' && method !== 'probe-portfolio' && method !== 'stabilise-first') {
      throw new Error(`wrd.ttl: regime ${token} routes to ${routedIri}, which has no known wrd:methodToken`);
    }
    if (routedIri !== wrdTerm(METHOD_LOCAL[method])) throw new Error(`wrd.ttl: method ${method} is declared at ${routedIri}, not where the records name it`);
    const permittedLevels: AllocationLevel[] = [];
    for (const li of iriValues(s, 'permitsLevel')) {
      const level = levelByIri.get(li);
      if (level === undefined) throw new Error(`wrd.ttl: regime ${token} permits an undeclared level ${li}`);
      permittedLevels.push(level);
    }
    permittedLevels.sort((a, b) => (levels.get(a)?.autonomyRank ?? 0) - (levels.get(b)?.autonomyRank ?? 0));
    const rule: RegimeRule = {
      regime: token, iri: subjectIri(s), method, methodIri: routedIri,
      permitsChange: readBool(s, 'permitsChange', `regime ${token}`),
      requiresProbe: readBool(s, 'requiresProbe', `regime ${token}`),
      pointValuation: readBool(s, 'pointValuation', `regime ${token}`),
      requiresExpertEvidence: readBool(s, 'requiresExpertEvidence', `regime ${token}`),
      permittedLevels,
      note: readStringValue(s, RDFS_COMMENT) ?? '',
    };
    if (rule.iri !== regimeIri(token)) throw new Error(`wrd.ttl: regime ${token} is declared at ${rule.iri}, not where the records name it`);
    regimes.set(token, rule);
    regimeByIri.set(rule.iri, token);
  }
  for (const r of REGIMES) if (!regimes.has(r)) throw new Error(`wrd.ttl: regime ${r} is not declared`);

  const rules = new Map<RuleId, ClassificationRule>();
  for (const s of findSubjectsOfType(doc, p('ClassificationRule'))) {
    const id = readStringValue(s, p('ruleId'));
    if (!isOneOf(RULE_IDS, id)) throw new Error(`wrd.ttl: classification rule ${subjectIri(s)} has an unknown wrd:ruleId ${String(id)}`);
    const condition = readStringValue(s, p('condition'));
    if (!condition) throw new Error(`wrd.ttl: rule ${id} has no wrd:condition`);
    const yieldsIri = readIriValue(s, p('yields'));
    let yields: Regime | null = null;
    if (yieldsIri !== undefined) {
      const r = regimeByIri.get(yieldsIri);
      if (r === undefined) throw new Error(`wrd.ttl: rule ${id} yields an undeclared regime ${yieldsIri}`);
      yields = r;
    }
    if (id === 'R0' && yields !== null) throw new Error('wrd.ttl: rule R0 places nothing and must not yield a regime');
    if (id !== 'R0' && yields === null) throw new Error(`wrd.ttl: rule ${id} has no wrd:yields`);
    rules.set(id, { id, iri: subjectIri(s), condition, yields });
  }
  for (const id of RULE_IDS) if (!rules.has(id)) throw new Error(`wrd.ttl: classification rule ${id} is not declared`);

  const sourceSubject = findSubjectsOfType(doc, p('RegimeSource'))
    .find((s) => readStringValue(s, p('sourceToken')) === REGIME_SOURCE);
  if (!sourceSubject) throw new Error(`wrd.ttl: no wrd:RegimeSource with token ${REGIME_SOURCE}`);
  const methodSubject = byIri.get(wrdTerm('valuationMethodV1'));
  if (!methodSubject) throw new Error('wrd.ttl: wrd:valuationMethodV1 is not declared');

  const gp = byIri.get(wrdTerm('defaultGrantPolicy'));
  if (!gp) throw new Error('wrd.ttl: wrd:defaultGrantPolicy is not declared');
  const grantPolicy: GrantPolicy = {
    iri: wrdTerm('defaultGrantPolicy'),
    floor: readNumber(gp, 'floor', 'the default grant policy'),
    minSamples: readNumber(gp, 'minSamples', 'the default grant policy'),
    minHumanConfirmations: readNumber(gp, 'minHumanConfirmations', 'the default grant policy'),
    minDistinctConfirmers: readNumber(gp, 'minDistinctConfirmers', 'the default grant policy'),
    minReadyClaimPrecision: readNumber(gp, 'minReadyClaimPrecision', 'the default grant policy'),
    criticalWorkFailureCeiling: readNumber(gp, 'criticalWorkFailureCeiling', 'the default grant policy'),
    contraryReworkShare: readNumber(gp, 'contraryReworkShare', 'the default grant policy'),
    contraryMinRuns: readNumber(gp, 'contraryMinRuns', 'the default grant policy'),
  };
  if (grantPolicy.floor <= 0 || grantPolicy.floor > 1) throw new Error('wrd.ttl: the grant floor must be in (0, 1]');
  if (grantPolicy.criticalWorkFailureCeiling <= 0 || grantPolicy.criticalWorkFailureCeiling >= 1) throw new Error('wrd.ttl: the critical work failure ceiling must be in (0, 1)');

  return {
    regimes, levels, grantPolicy, rules,
    regimeSourceIri: subjectIri(sourceSubject),
    valuationMethodIri: wrdTerm('valuationMethodV1'),
    ontologySha256: sha256Hex(turtle),
  };
}

// ── Pod policy: an admin may tighten, never loosen ────────────────────────────────────────

export interface PodPolicy {
  readonly maxLevel?: AllocationLevel;
  readonly floor?: number;
  readonly minSamples?: number;
  readonly minHumanConfirmations?: number;
  readonly minDistinctConfirmers?: number;
}

/** Shape check of a pod policy as it arrives in a registry envelope. */
export function coercePodPolicy(v: unknown): { readonly ok: true; readonly value: PodPolicy } | { readonly ok: false; readonly why: string } {
  if (typeof v !== 'object' || v === null || Array.isArray(v)) return { ok: false, why: 'podPolicy must be an object or null' };
  const o = v as Record<string, unknown>;
  const allowed = new Set(['maxLevel', 'floor', 'minSamples', 'minHumanConfirmations', 'minDistinctConfirmers']);
  for (const k of Object.keys(o)) if (!allowed.has(k)) return { ok: false, why: `podPolicy.${k} is not a pod policy field` };
  const out: { -readonly [K in keyof PodPolicy]: PodPolicy[K] } = {};
  if (o['maxLevel'] !== undefined) {
    if (!isLevel(o['maxLevel'])) return { ok: false, why: 'podPolicy.maxLevel must be an allocation level' };
    out.maxLevel = o['maxLevel'];
  }
  if (o['floor'] !== undefined) {
    const f = o['floor'];
    if (typeof f !== 'number' || !Number.isFinite(f) || f <= 0 || f > 1) return { ok: false, why: 'podPolicy.floor must be a number in (0, 1]' };
    out.floor = f;
  }
  for (const k of ['minSamples', 'minHumanConfirmations', 'minDistinctConfirmers'] as const) {
    const n = o[k];
    if (n === undefined) continue;
    if (typeof n !== 'number' || !Number.isInteger(n) || n < 1 || n > 100_000) return { ok: false, why: `podPolicy.${k} must be a positive integer` };
    out[k] = n;
  }
  return { ok: true, value: out };
}

/** null when every field only tightens the published policy; otherwise the first field that would loosen it. */
export function podPolicyLoosens(published: PublishedPolicy, pod: PodPolicy): string | null {
  const g = published.grantPolicy;
  if (pod.floor !== undefined && pod.floor < g.floor) return 'floor';
  if (pod.minSamples !== undefined && pod.minSamples < g.minSamples) return 'minSamples';
  if (pod.minHumanConfirmations !== undefined && pod.minHumanConfirmations < g.minHumanConfirmations) return 'minHumanConfirmations';
  if (pod.minDistinctConfirmers !== undefined && pod.minDistinctConfirmers < g.minDistinctConfirmers) return 'minDistinctConfirmers';
  // maxLevel is a ceiling: any declared level caps, none can add a level a regime does not permit.
  return null;
}

export interface EffectivePolicy extends PublishedPolicy {
  readonly podPolicy: PodPolicy | null;
  readonly podPolicyHead: string | null;
}

/** permittedLevels filtered to autonomyRank ≤ maxLevel's; grant numbers = max(published, pod). */
export function effectivePolicy(published: PublishedPolicy, pod: PodPolicy | null, podPolicyHead: string | null): EffectivePolicy {
  if (pod === null) return { ...published, podPolicy: null, podPolicyHead };
  const loosens = podPolicyLoosens(published, pod);
  if (loosens !== null) throw new Error(`a pod policy can only tighten the published policy: ${loosens}`);
  const cap = pod.maxLevel === undefined ? Number.POSITIVE_INFINITY : (published.levels.get(pod.maxLevel)?.autonomyRank ?? Number.POSITIVE_INFINITY);
  const regimes = new Map<Regime, RegimeRule>();
  for (const [r, rule] of published.regimes) {
    regimes.set(r, { ...rule, permittedLevels: rule.permittedLevels.filter((l) => (published.levels.get(l)?.autonomyRank ?? 0) <= cap) });
  }
  const g = published.grantPolicy;
  return {
    ...published,
    regimes,
    grantPolicy: {
      ...g,
      floor: Math.max(g.floor, pod.floor ?? g.floor),
      minSamples: Math.max(g.minSamples, pod.minSamples ?? g.minSamples),
      minHumanConfirmations: Math.max(g.minHumanConfirmations, pod.minHumanConfirmations ?? g.minHumanConfirmations),
      minDistinctConfirmers: Math.max(g.minDistinctConfirmers, pod.minDistinctConfirmers ?? g.minDistinctConfirmers),
    },
    podPolicy: pod,
    podPolicyHead,
  };
}
