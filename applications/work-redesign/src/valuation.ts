/**
 * The valuation engine: honest ranges in, percentiles out, and later, the world's answer
 * graded against what was predicted.
 *
 * Every input is a triangle (low, likely, high) with a stated basis: measured, from a
 * document, reported by the performer, or an estimate. A seeded Monte Carlo (xoshiro128**,
 * seeded from the plan and its inputs, so anyone can recompute it) draws each input
 * independently and reports P10/P50/P90 for two figures side by side: the cash figure, in which
 * freed person-hours count only where the work is left unfilled, and the figure if freed hours
 * are redeployed at their current cost. Nothing here invents a number: every figure is
 * arithmetic over the inputs a person signed, and the arithmetic is stated in wrd.ttl
 * (wrd:valuationMethodV1) and in the record's own assumptions list.
 *
 * Outcomes are graded against the predicted band scaled by the declared ramp over the window
 * actually measured. Calibration and earned grants run on the shared judgment kit; the kit
 * counts outcomes, so the vertical adds its own count of distinct people (by the person
 * reference an admin attests) and its own ordinal error measure.
 *
 * Pure: no environment reads, no network, no clock (every time is passed in).
 */
import { canonicalJson, sha256Hex } from '@interego/core';
import {
  judgment, outcome, calibration, attestation, reputations, autonomy,
  type DecisionKind, type LoopOutcome,
} from '../../_shared/judgment-kit/loop.js';
import {
  FREED_HOURS_DISPOSITIONS, INPUT_BASES, isOneOf,
  type AllocationLevel, type ComparisonBasis, type FreedHoursDisposition, type GrantPolicy, type InputBasis,
  type OutcomeDisposition, type OutcomeMetric, type ProbeSignal,
} from './ontology.js';
import { h16, isAbsoluteIri, isIsoInstant } from './records.js';

// ── Inputs ────────────────────────────────────────────────────────────────────────────────

export interface Tri {
  readonly low: number;
  readonly likely: number;
  readonly high: number;
  readonly basis: InputBasis;
  readonly note?: string;
  /** Absolute IRI of a descriptor or document the number came from. */
  readonly source?: string;
}
export const STATE_FIELDS = [
  'performerHoursPerRun', 'oversightHoursPerRun', 'agentCostPerRun',
  'minorFailureRate', 'minorFailureCost', 'criticalFailureRate', 'criticalFailureCost',
] as const;
export type StateField = typeof STATE_FIELDS[number];
/** One way of doing a task: the performer's hours, the oversight person's hours, the agent's cost, and expected failures. */
export type TaskState = Readonly<Record<StateField, Tri>>;
export interface TaskInputs {
  readonly runsPerUnit: Tri;
  /** Default: the workflow's hourlyCost. */
  readonly hourlyCost?: Tri;
  readonly current: TaskState;
  readonly proposed?: TaskState;
}
export interface ValuationInputs {
  readonly currency: string;
  readonly unitsPerWeek: { readonly current: Tri; readonly proposed?: Tri };
  readonly valuePerUnit: Tri;
  readonly hourlyCost: Tri;
  readonly oneOffCost: Tri;
  readonly horizonMonths: number;
  readonly rampMonths: number;
  readonly annualDiscountRate: number;
  readonly criticalFailureCeiling: number;
  readonly freedHours: Readonly<Record<string, { readonly disposition: FreedHoursDisposition; readonly note?: string }>>;
  readonly tasks: Readonly<Record<string, TaskInputs>>;
}

type Coerced<T> = { readonly ok: true; readonly inputs: T } | { readonly ok: false; readonly why: string };
const RATE_FIELDS: ReadonlySet<string> = new Set(['minorFailureRate', 'criticalFailureRate']);
const NOTE_MAX = 300;

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}
function unknownKey(o: Record<string, unknown>, allowed: readonly string[], path: string): string | null {
  for (const k of Object.keys(o)) if (!allowed.includes(k)) return `${path}.${k} is not a valuation input`;
  return null;
}

/**
 * The largest magnitude any input may take. Products of several inputs must stay finite: two
 * inputs of 1e200 multiply to Infinity, and a valuation that contains Infinity or NaN is a
 * number the engine never computed. 1e12 per input keeps every product the model forms (at most
 * four factors) far inside double range.
 */
export const MAX_INPUT = 1e12;

interface TriRules {
  /** Only a task state's own fields may be marked not applicable (0, 0, 0). */
  readonly allowNotApplicable?: boolean;
  /** A proposed state has never run: 'measured' there must cite where it was measured. */
  readonly proposedState?: boolean;
}

function coerceTri(v: unknown, path: string, kind: 'rate' | 'amount', rules: TriRules = {}): Tri | string {
  if (!isObject(v)) return `${path} must be {low, likely, high, basis}`;
  const extra = unknownKey(v, ['low', 'likely', 'high', 'basis', 'note', 'source'], path);
  if (extra) return extra;
  const { low, likely, high } = v;
  if (typeof low !== 'number' || typeof likely !== 'number' || typeof high !== 'number'
    || !Number.isFinite(low) || !Number.isFinite(likely) || !Number.isFinite(high)) return `${path}: low, likely and high must be finite numbers`;
  if (!(low <= likely && likely <= high)) return `${path}: low <= likely <= high is required`;
  if (low < 0) return `${path} cannot be negative`;
  if (high > MAX_INPUT) return `${path}: values above ${MAX_INPUT} are refused, so that every product of inputs stays a finite number`;
  if (kind === 'rate' && high > 1) return `${path} is a rate and must lie within [0, 1]`;
  if (!isOneOf(INPUT_BASES, v['basis'])) return `${path}.basis must be one of ${INPUT_BASES.join(', ')}`;
  if (v['note'] !== undefined && (typeof v['note'] !== 'string' || v['note'].length > NOTE_MAX)) return `${path}.note must be text of at most ${NOTE_MAX} characters`;
  if (v['source'] !== undefined && !isAbsoluteIri(v['source'])) return `${path}.source must be an absolute IRI`;
  if (v['basis'] === 'not-applicable') {
    if (!rules.allowNotApplicable) return `${path}.basis not-applicable is only for a task state's own fields`;
    if (low !== 0 || likely !== 0 || high !== 0) return `${path}: basis not-applicable means 0, 0, 0`;
  }
  if (v['basis'] === 'measured' && rules.proposedState && v['source'] === undefined) {
    return `${path}: a proposed state has not run yet, so basis measured needs a source (the IRI of the runs, outcome or pilot it was measured on); otherwise mark it an estimate`;
  }
  return {
    low, likely, high, basis: v['basis'],
    ...(typeof v['note'] === 'string' ? { note: v['note'] } : {}),
    ...(typeof v['source'] === 'string' ? { source: v['source'] } : {}),
  };
}

function coerceState(v: unknown, path: string, which: 'current' | 'proposed'): TaskState | string {
  if (!isObject(v)) return `${path} must be an object of ${STATE_FIELDS.join(', ')}`;
  const extra = unknownKey(v, STATE_FIELDS, path);
  if (extra) return extra;
  const out: Partial<Record<StateField, Tri>> = {};
  for (const f of STATE_FIELDS) {
    const t = coerceTri(v[f], `${path}.${f}`, RATE_FIELDS.has(f) ? 'rate' : 'amount', { allowNotApplicable: true, proposedState: which === 'proposed' });
    if (typeof t === 'string') return t;
    out[f] = t;
  }
  return out as TaskState;
}

/**
 * Check valuation inputs against the plan they value: every triangle finite, ordered, at most
 * MAX_INPUT, with a basis; rates within [0, 1]; amounts not negative; 'not-applicable' only as
 * 0/0/0 inside a task state; 'measured' on a proposed state only with a source; freed-hours
 * dispositions for exactly the valued changed tasks; task keys within the plan; changed tasks
 * with current AND proposed states; oversight costed wherever a person decides on or audits an
 * agent's work; unchanged tasks with no proposed state, and with inputs whenever throughput
 * changes (then they no longer cancel). Returns a normalised copy holding only known fields.
 */
export function coerceValuationInputs(v: unknown, plan: {
  readonly taskIris: readonly string[]; readonly valuedChanged: ReadonlySet<string>;
  /** Changed tasks whose proposed level has a person decide on or audit an agent's work. */
  readonly personOversees?: ReadonlySet<string>;
}): Coerced<ValuationInputs> {
  const fail = (why: string): Coerced<ValuationInputs> => ({ ok: false, why });
  if (!isObject(v)) return fail('inputs must be an object');
  const extra = unknownKey(v, ['currency', 'unitsPerWeek', 'valuePerUnit', 'hourlyCost', 'oneOffCost', 'horizonMonths', 'rampMonths',
    'annualDiscountRate', 'criticalFailureCeiling', 'freedHours', 'tasks'], 'inputs');
  if (extra) return fail(extra);
  if (typeof v['currency'] !== 'string' || !/^[A-Z]{3}$/.test(v['currency'])) return fail('inputs.currency must be a three-letter ISO 4217 code');
  const upw = v['unitsPerWeek'];
  if (!isObject(upw)) return fail('inputs.unitsPerWeek must be {current, proposed?}');
  const upwExtra = unknownKey(upw, ['current', 'proposed'], 'inputs.unitsPerWeek');
  if (upwExtra) return fail(upwExtra);
  const unitsCurrent = coerceTri(upw['current'], 'inputs.unitsPerWeek.current', 'amount');
  if (typeof unitsCurrent === 'string') return fail(unitsCurrent);
  let unitsProposed: Tri | undefined;
  if (upw['proposed'] !== undefined) {
    const t = coerceTri(upw['proposed'], 'inputs.unitsPerWeek.proposed', 'amount');
    if (typeof t === 'string') return fail(t);
    unitsProposed = t;
  }
  const top: Partial<Record<'valuePerUnit' | 'hourlyCost' | 'oneOffCost', Tri>> = {};
  for (const k of ['valuePerUnit', 'hourlyCost', 'oneOffCost'] as const) {
    const t = coerceTri(v[k], `inputs.${k}`, 'amount');
    if (typeof t === 'string') return fail(t);
    top[k] = t;
  }
  const horizon = v['horizonMonths'];
  if (typeof horizon !== 'number' || !Number.isInteger(horizon) || horizon < 1 || horizon > 120) return fail('inputs.horizonMonths must be a whole number from 1 to 120');
  const ramp = v['rampMonths'];
  if (typeof ramp !== 'number' || !Number.isFinite(ramp) || ramp < 0 || ramp > 60) return fail('inputs.rampMonths must be from 0 to 60');
  const rate = v['annualDiscountRate'];
  if (typeof rate !== 'number' || !Number.isFinite(rate) || rate < 0 || rate > 1) return fail('inputs.annualDiscountRate must lie within [0, 1]');
  const ceiling = v['criticalFailureCeiling'];
  if (typeof ceiling !== 'number' || !Number.isFinite(ceiling) || ceiling <= 0 || ceiling >= 1) return fail('inputs.criticalFailureCeiling must lie strictly between 0 and 1');

  const fh = v['freedHours'];
  if (!isObject(fh)) return fail('inputs.freedHours must name a disposition for every changed task');
  const freedHours: Record<string, { disposition: FreedHoursDisposition; note?: string }> = {};
  for (const [iri, entry] of Object.entries(fh)) {
    if (!plan.valuedChanged.has(iri)) return fail(`inputs.freedHours[${iri}]: only changed tasks take a freed-hours disposition`);
    if (!isObject(entry) || !isOneOf(FREED_HOURS_DISPOSITIONS, entry['disposition'])) return fail(`inputs.freedHours[${iri}].disposition must be one of ${FREED_HOURS_DISPOSITIONS.join(', ')}`);
    const e = unknownKey(entry, ['disposition', 'note'], `inputs.freedHours[${iri}]`);
    if (e) return fail(e);
    if (entry['note'] !== undefined && (typeof entry['note'] !== 'string' || entry['note'].length > NOTE_MAX)) return fail(`inputs.freedHours[${iri}].note must be text of at most ${NOTE_MAX} characters`);
    freedHours[iri] = { disposition: entry['disposition'], ...(typeof entry['note'] === 'string' ? { note: entry['note'] } : {}) };
  }
  for (const iri of plan.valuedChanged) if (!freedHours[iri]) return fail(`inputs.freedHours[${iri}] is required: say what happens to any hours the change frees`);

  const rawTasks = v['tasks'];
  if (!isObject(rawTasks)) return fail('inputs.tasks must be an object keyed by task IRI');
  const planTasks = new Set(plan.taskIris);
  const tasks: Record<string, TaskInputs> = {};
  for (const [iri, raw] of Object.entries(rawTasks)) {
    const path = `inputs.tasks[${iri}]`;
    if (!planTasks.has(iri)) return fail(`${path}: this task is not in the plan`);
    if (!isObject(raw)) return fail(`${path} must be {runsPerUnit, hourlyCost?, current, proposed?}`);
    const e = unknownKey(raw, ['runsPerUnit', 'hourlyCost', 'current', 'proposed'], path);
    if (e) return fail(e);
    const runs = coerceTri(raw['runsPerUnit'], `${path}.runsPerUnit`, 'amount');
    if (typeof runs === 'string') return fail(runs);
    let hourly: Tri | undefined;
    if (raw['hourlyCost'] !== undefined) {
      const h = coerceTri(raw['hourlyCost'], `${path}.hourlyCost`, 'amount');
      if (typeof h === 'string') return fail(h);
      hourly = h;
    }
    const current = coerceState(raw['current'], `${path}.current`, 'current');
    if (typeof current === 'string') return fail(current);
    let proposed: TaskState | undefined;
    if (plan.valuedChanged.has(iri)) {
      if (raw['proposed'] === undefined) return fail(`${path}.proposed is required: this task changes`);
      const pState = coerceState(raw['proposed'], `${path}.proposed`, 'proposed');
      if (typeof pState === 'string') return fail(pState);
      if (plan.personOversees?.has(iri) && pState.oversightHoursPerRun.high === 0) {
        return fail(`${path}.proposed.oversightHoursPerRun is 0: a person decides on or audits the agent's work at this level, so that time must be costed (a range, even a narrow one)`);
      }
      proposed = pState;
    } else if (raw['proposed'] !== undefined) {
      return fail(`${path}.proposed: this task does not change, so it has no proposed state`);
    }
    tasks[iri] = { runsPerUnit: runs, ...(hourly ? { hourlyCost: hourly } : {}), current, ...(proposed ? { proposed } : {}) };
  }
  for (const iri of plan.valuedChanged) if (!tasks[iri]) return fail(`inputs.tasks[${iri}] is required: this task changes`);
  if (unitsProposed) {
    for (const iri of plan.taskIris) {
      if (!tasks[iri]) return fail(`inputs.tasks[${iri}] is required: throughput changes, so unchanged tasks no longer cancel`);
    }
  }
  return {
    ok: true,
    inputs: {
      currency: v['currency'],
      unitsPerWeek: { current: unitsCurrent, ...(unitsProposed ? { proposed: unitsProposed } : {}) },
      valuePerUnit: top.valuePerUnit as Tri, hourlyCost: top.hourlyCost as Tri, oneOffCost: top.oneOffCost as Tri,
      horizonMonths: horizon, rampMonths: ramp, annualDiscountRate: rate, criticalFailureCeiling: ceiling,
      freedHours, tasks,
    },
  };
}

/**
 * The path of the first number in a valuation result that is not finite, or null. A result that
 * holds NaN or Infinity is refused, never published: JSON would carry it as null, and the graph
 * as a number nobody computed.
 */
export function nonFiniteIn(v: unknown, path = 'result'): string | null {
  if (typeof v === 'number') return Number.isFinite(v) ? null : path;
  if (Array.isArray(v)) {
    for (const [i, x] of v.entries()) { const bad = nonFiniteIn(x, `${path}[${i}]`); if (bad) return bad; }
    return null;
  }
  if (isObject(v)) {
    for (const [k, x] of Object.entries(v)) { const bad = nonFiniteIn(x, `${path}.${k}`); if (bad) return bad; }
  }
  return null;
}

// ── Primitives ────────────────────────────────────────────────────────────────────────────

export const DRAWS = 5000;

/** sha256 of the canonical JSON of the plan IRI and the inputs: the same plan and inputs always draw the same numbers. */
export function seedFor(planIri: string, inputs: ValuationInputs): string {
  return sha256Hex(canonicalJson({ planIri, inputs }));
}

const rotl = (x: number, k: number): number => ((x << k) | (x >>> (32 - k))) >>> 0;

/**
 * xoshiro128** (Blackman & Vigna) seeded from the first 128 bits of a hex seed; returns
 * uniform numbers in [0, 1). An all-zero state is replaced by s0 = 1.
 */
export function prng(seedHex: string): () => number {
  if (!/^[0-9a-f]{32,}$/i.test(seedHex)) throw new TypeError('the seed must be at least 32 hex characters');
  let s0 = parseInt(seedHex.slice(0, 8), 16) >>> 0;
  let s1 = parseInt(seedHex.slice(8, 16), 16) >>> 0;
  let s2 = parseInt(seedHex.slice(16, 24), 16) >>> 0;
  let s3 = parseInt(seedHex.slice(24, 32), 16) >>> 0;
  if ((s0 | s1 | s2 | s3) === 0) s0 = 1;
  return () => {
    const result = Math.imul(rotl(Math.imul(s1, 5) >>> 0, 7), 9) >>> 0;
    const t = (s1 << 9) >>> 0;
    s2 = (s2 ^ s0) >>> 0;
    s3 = (s3 ^ s1) >>> 0;
    s1 = (s1 ^ s2) >>> 0;
    s0 = (s0 ^ s3) >>> 0;
    s2 = (s2 ^ t) >>> 0;
    s3 = rotl(s3, 11);
    return result / 4294967296;
  };
}

/** Inverse CDF of the triangular distribution (a = low, m = likely, b = high). */
export function sampleTriangular(t: Pick<Tri, 'low' | 'likely' | 'high'>, u: number): number {
  const a = t.low; const m = t.likely; const b = t.high;
  if (a === b) return a;
  const f = (m - a) / (b - a);
  return u < f ? a + Math.sqrt(u * (b - a) * (m - a)) : b - Math.sqrt((1 - u) * (b - a) * (b - m));
}

/** Percentile, type 7 (h = (N − 1)p, linear interpolation), over an ascending array. */
export function percentile(sortedAsc: readonly number[], p: number): number {
  const n = sortedAsc.length;
  if (n === 0) throw new RangeError('percentile of an empty sample');
  const h = (n - 1) * p;
  const lo = Math.floor(h);
  const x0 = sortedAsc[lo] as number;
  const x1 = sortedAsc[Math.min(lo + 1, n - 1)] as number;
  return h === lo ? x0 : x0 + (h - lo) * (x1 - x0);
}

/** The number of runs with zero critical failures that bound the rate below `ceiling` at 95% (rule of three). */
export function runsForRuleOfThree(ceiling: number): number {
  if (!(ceiling > 0 && ceiling < 1)) throw new RangeError('the ceiling must lie strictly between 0 and 1');
  return Math.ceil(3 / ceiling);
}

/**
 * NPV of a steady-state weekly change over the horizon: monthly = weekly × 52/12, ramped in
 * linearly over `rampMonths` (min(1, m / ramp) in month m), discounted monthly at
 * (1 + annual)^(1/12) − 1, net of the one-off cost. Payback is the first month the discounted
 * cumulative turns non-negative, else null.
 */
export function npvOf(weeklyDelta: number, p: { readonly horizonMonths: number; readonly rampMonths: number; readonly annualDiscountRate: number; readonly oneOffCost: number }):
  { readonly npv: number; readonly paybackMonth: number | null } {
  const i = Math.pow(1 + p.annualDiscountRate, 1 / 12) - 1;
  const monthly = (weeklyDelta * 52) / 12;
  let cumulative = -p.oneOffCost;
  let payback: number | null = null;
  for (let m = 1; m <= p.horizonMonths; m += 1) {
    const ramp = p.rampMonths <= 0 ? 1 : Math.min(1, m / p.rampMonths);
    cumulative += (monthly * ramp) / Math.pow(1 + i, m);
    if (payback === null && cumulative >= 0) payback = m;
  }
  return { npv: cumulative, paybackMonth: payback };
}

// ── The model ─────────────────────────────────────────────────────────────────────────────

export interface Band { readonly p10: number; readonly p50: number; readonly p90: number }
export interface Breakdown { readonly value: number; readonly loss: number; readonly personCost: number; readonly oversightCost: number; readonly agentCost: number }
export interface SensitivityRow { readonly input: string; readonly basis: InputBasis; readonly npvAtLow: number; readonly npvAtHigh: number; readonly swing: number }
export interface ScenarioResult {
  readonly weeklyDelta: Band;
  readonly npv: Band;
  readonly probabilityNpvPositive: number;
  readonly payback: { readonly p50Month: number | null; readonly probabilityWithinHorizon: number };
  readonly sensitivity: readonly SensitivityRow[];
  readonly baseNpvAtLikely: number;
}
export interface ValuationResult {
  readonly seed: string; readonly draws: number; readonly currency: string; readonly method: string;
  readonly scenarios: { readonly cash: ScenarioResult; readonly redeployed: ScenarioResult };
  readonly freedPersonHours: {
    readonly total: Band;
    readonly perTask: ReadonlyArray<{ readonly taskIri: string; readonly band: Band; readonly disposition: FreedHoursDisposition; readonly note: string | null }>;
  };
  readonly valueToCost: { readonly current: Band | null; readonly proposed: Band | null; readonly why: string | null };
  readonly breakdown: {
    readonly current: { readonly total: Breakdown; readonly perTask: ReadonlyArray<{ readonly taskIri: string } & Breakdown> };
    readonly proposed: { readonly total: Breakdown; readonly perTask: ReadonlyArray<{ readonly taskIri: string } & Breakdown> };
  };
  readonly inputs: {
    readonly byBasis: Readonly<Record<InputBasis, number>>;
    readonly noRange: readonly string[];
    readonly topSensitivityEstimates: readonly string[];
    readonly unchangedTasks: 'entered' | 'not entered: unchanged tasks cancel when throughput is unchanged';
    readonly unconfirmed: ReadonlyArray<{ readonly path: string; readonly why: string }>;
    /** The mean cost per run the agent itself declared on runs a person reviewed: agent-reported, not instrumented. */
    readonly reportedAgentCost: ReadonlyArray<{ readonly taskKind: string; readonly runs: number; readonly mean: number; readonly currency: string; readonly basis: typeof REPORTED_COST_BASIS }>;
  };
  readonly pilot: ReadonlyArray<{
    readonly taskIri: string; readonly ceiling: number; readonly confidence: 0.95; readonly runsNeeded: number;
    readonly weeksAtLikelyThroughput: number | null; readonly likelyRateExceedsCeiling: boolean;
  }>;
  readonly assumptions: readonly string[];
}

interface StatePoint { readonly performer: number; readonly oversight: number; readonly agentCost: number; readonly minorRate: number; readonly minorCost: number; readonly criticalRate: number; readonly criticalCost: number }
interface TaskPoint { readonly iri: string; readonly runs: number; readonly hourly: number; readonly current: StatePoint; readonly proposed: StatePoint }
interface Point { readonly unitsCurrent: number; readonly unitsProposed: number; readonly valuePerUnit: number; readonly oneOff: number; readonly tasks: readonly TaskPoint[] }
type Draw = (path: string, t: Tri) => number;

/** Resolve every input to a number, calling `draw` in the normative order (§6.3 of the spec; wrd:valuationMethodV1). */
function resolvePoint(inputs: ValuationInputs, taskOrder: readonly string[], valuedChanged: ReadonlySet<string>, draw: Draw): Point {
  const unitsCurrent = draw('unitsPerWeek.current', inputs.unitsPerWeek.current);
  const unitsProposed = inputs.unitsPerWeek.proposed ? draw('unitsPerWeek.proposed', inputs.unitsPerWeek.proposed) : unitsCurrent;
  const valuePerUnit = draw('valuePerUnit', inputs.valuePerUnit);
  const hourly = draw('hourlyCost', inputs.hourlyCost);
  const oneOff = draw('oneOffCost', inputs.oneOffCost);
  const state = (path: string, s: TaskState): StatePoint => ({
    performer: draw(`${path}.performerHoursPerRun`, s.performerHoursPerRun),
    oversight: draw(`${path}.oversightHoursPerRun`, s.oversightHoursPerRun),
    agentCost: draw(`${path}.agentCostPerRun`, s.agentCostPerRun),
    minorRate: draw(`${path}.minorFailureRate`, s.minorFailureRate),
    minorCost: draw(`${path}.minorFailureCost`, s.minorFailureCost),
    criticalRate: draw(`${path}.criticalFailureRate`, s.criticalFailureRate),
    criticalCost: draw(`${path}.criticalFailureCost`, s.criticalFailureCost),
  });
  const tasks: TaskPoint[] = [];
  for (const iri of taskOrder) {
    const ti = inputs.tasks[iri];
    if (!ti) continue;
    const runs = draw(`tasks[${iri}].runsPerUnit`, ti.runsPerUnit);
    const taskHourly = ti.hourlyCost ? draw(`tasks[${iri}].hourlyCost`, ti.hourlyCost) : hourly;
    const current = state(`tasks[${iri}].current`, ti.current);
    const proposed = valuedChanged.has(iri) && ti.proposed ? state(`tasks[${iri}].proposed`, ti.proposed) : current;
    tasks.push({ iri, runs, hourly: taskHourly, current, proposed });
  }
  return { unitsCurrent, unitsProposed, valuePerUnit, oneOff, tasks };
}

function stateCosts(units: number, t: TaskPoint, s: StatePoint): Omit<Breakdown, 'value'> {
  const runs = units * t.runs;
  return {
    loss: runs * (s.minorRate * s.minorCost + s.criticalRate * s.criticalCost),
    personCost: runs * s.performer * t.hourly,
    oversightCost: runs * s.oversight * t.hourly,
    agentCost: runs * s.agentCost,
  };
}

interface Evaluated {
  readonly redeployed: number;
  readonly cash: number;
  readonly freed: ReadonlyMap<string, number>;
  readonly current: { readonly total: Breakdown; readonly perTask: ReadonlyArray<{ readonly taskIri: string } & Breakdown> };
  readonly proposed: { readonly total: Breakdown; readonly perTask: ReadonlyArray<{ readonly taskIri: string } & Breakdown> };
}

const net = (b: Breakdown): number => b.value - b.loss - b.personCost - b.oversightCost - b.agentCost;

function evaluatePoint(pt: Point, inputs: ValuationInputs, valuedChanged: ReadonlySet<string>): Evaluated {
  const side = (which: 'current' | 'proposed'): Evaluated['current'] => {
    const units = which === 'current' ? pt.unitsCurrent : pt.unitsProposed;
    const perTask = pt.tasks.map((t) => ({ taskIri: t.iri, value: 0, ...stateCosts(units, t, t[which]) }));
    const total: Breakdown = {
      value: units * pt.valuePerUnit,
      loss: perTask.reduce((n, r) => n + r.loss, 0),
      personCost: perTask.reduce((n, r) => n + r.personCost, 0),
      oversightCost: perTask.reduce((n, r) => n + r.oversightCost, 0),
      agentCost: perTask.reduce((n, r) => n + r.agentCost, 0),
    };
    return { total, perTask };
  };
  const current = side('current');
  const proposed = side('proposed');
  const redeployed = net(proposed.total) - net(current.total);
  const freed = new Map<string, number>();
  let notCash = 0;
  for (const t of pt.tasks) {
    if (!valuedChanged.has(t.iri)) continue;
    const hours = pt.unitsCurrent * t.runs * (t.current.performer + t.current.oversight)
      - pt.unitsProposed * t.runs * (t.proposed.performer + t.proposed.oversight);
    freed.set(t.iri, hours);
    if (inputs.freedHours[t.iri]?.disposition !== 'unfilled') notCash += t.hourly * Math.max(0, hours);
  }
  return { redeployed, cash: redeployed - notCash, freed, current, proposed };
}

const round = (x: number, places: number): number => {
  const f = 10 ** places;
  const r = Math.round(x * f) / f;
  return Object.is(r, -0) ? 0 : r;
};
const bandOf = (values: number[], places = 2): Band => {
  const s = [...values].sort((a, b) => a - b);
  return { p10: round(percentile(s, 0.1), places), p50: round(percentile(s, 0.5), places), p90: round(percentile(s, 0.9), places) };
};
const roundBreakdown = <T extends Breakdown>(b: T): T => ({
  ...b, value: round(b.value, 2), loss: round(b.loss, 2), personCost: round(b.personCost, 2), oversightCost: round(b.oversightCost, 2), agentCost: round(b.agentCost, 2),
});

export const VALUATION_ASSUMPTIONS: readonly string[] = [
  'Each input is drawn independently from its triangular range (low, likely, high); correlation between inputs is not modelled.',
  'Value per unit is unchanged by the change.',
  'The change ramps in linearly over the stated ramp months.',
  'Failure costs are expected costs: rate times cost per failure.',
  "Oversight (deciding on or auditing an agent's output) is costed at the task's hourly cost.",
  "Freed person-hours count as savings in the 'if redeployed' figures at current hourly cost; in the cash figures they count only for tasks whose disposition is 'unfilled'. Hours a change adds always cost.",
  'Payback is the first month the discounted cumulative turns non-negative.',
  "Inputs marked 'estimate' are unmeasured.",
];

const UNCONFIRMED_AGENT_COST = 'no person-reviewed run of this kind of task reports a cost yet';
export const REPORTED_COST_BASIS = 'agent-reported on person-reviewed runs';
const RATIO_NEEDS_EVERY_TASK = "unchanged tasks were not entered; the ratio needs every task's cost";

/**
 * Value a plan. `taskOrder` is the plan's task order (it fixes the draw order); `valuedChanged`
 * the changed tasks; `agentLevelTasks` the changed tasks whose proposed level names an agent;
 * `reportedAgentCost` the mean cost per run, by task kind, that the agent declared on runs a
 * person reviewed, in the inputs' currency (shown beside the estimate, labelled agent-reported).
 */
export function valuePlan(inputs: ValuationInputs, opts: {
  readonly planIri: string;
  readonly taskOrder: readonly string[];
  readonly valuedChanged: ReadonlySet<string>;
  readonly agentLevelTasks: ReadonlySet<string>;
  readonly taskKindOf: ReadonlyMap<string, string>;
  readonly reportedAgentCost: ReadonlyMap<string, { readonly runs: number; readonly mean: number }>;
  readonly methodIri: string;
  readonly draws?: number;
}): ValuationResult {
  const draws = opts.draws ?? DRAWS;
  if (!Number.isInteger(draws) || draws < 1) throw new RangeError('draws must be a positive whole number');
  const seed = seedFor(opts.planIri, inputs);
  const horizon = { horizonMonths: inputs.horizonMonths, rampMonths: inputs.rampMonths, annualDiscountRate: inputs.annualDiscountRate };
  const changedInOrder = opts.taskOrder.filter((t) => opts.valuedChanged.has(t) && inputs.tasks[t]);
  const everyTaskEntered = opts.taskOrder.every((t) => inputs.tasks[t] !== undefined);

  // Monte Carlo
  const next = prng(seed);
  const draw: Draw = (_path, t) => sampleTriangular(t, next());
  const cash: number[] = []; const redeployed: number[] = [];
  const npvCash: number[] = []; const npvRedeployed: number[] = [];
  const paybackCash: (number | null)[] = []; const paybackRedeployed: (number | null)[] = [];
  const freedTotal: number[] = [];
  const freedPer = new Map<string, number[]>(changedInOrder.map((t) => [t, []]));
  const vtc = { current: [] as number[], proposed: [] as number[], currentDegenerate: false, proposedDegenerate: false };
  for (let d = 0; d < draws; d += 1) {
    const pt = resolvePoint(inputs, opts.taskOrder, opts.valuedChanged, draw);
    const ev = evaluatePoint(pt, inputs, opts.valuedChanged);
    cash.push(ev.cash); redeployed.push(ev.redeployed);
    const c = npvOf(ev.cash, { ...horizon, oneOffCost: pt.oneOff });
    const r = npvOf(ev.redeployed, { ...horizon, oneOffCost: pt.oneOff });
    npvCash.push(c.npv); npvRedeployed.push(r.npv);
    paybackCash.push(c.paybackMonth); paybackRedeployed.push(r.paybackMonth);
    let total = 0;
    for (const [t, h] of ev.freed) { freedPer.get(t)?.push(h); total += h; }
    freedTotal.push(total);
    if (everyTaskEntered) {
      for (const which of ['current', 'proposed'] as const) {
        const b = ev[which].total;
        const cost = b.personCost + b.oversightCost + b.agentCost;
        if (cost <= 0) { if (which === 'current') vtc.currentDegenerate = true; else vtc.proposedDegenerate = true; continue; }
        vtc[which].push((b.value - b.loss) / cost);
      }
    }
  }

  // Deterministic: the all-likely point, and one-at-a-time sensitivity around it.
  const paths: { path: string; tri: Tri }[] = [];
  resolvePoint(inputs, opts.taskOrder, opts.valuedChanged, (path, t) => { paths.push({ path, tri: t }); return t.likely; });
  const atLikely = (override?: { path: string; at: 'low' | 'high' }): { pt: Point; ev: Evaluated } => {
    const pt = resolvePoint(inputs, opts.taskOrder, opts.valuedChanged, (path, t) => (override && override.path === path ? t[override.at] : t.likely));
    return { pt, ev: evaluatePoint(pt, inputs, opts.valuedChanged) };
  };
  const base = atLikely();
  const npvAt = (x: { pt: Point; ev: Evaluated }, scenario: 'cash' | 'redeployed'): number =>
    npvOf(x.ev[scenario], { ...horizon, oneOffCost: x.pt.oneOff }).npv;
  const sensitivity = (scenario: 'cash' | 'redeployed'): SensitivityRow[] => paths
    .map(({ path, tri }) => {
      const lo = npvAt(atLikely({ path, at: 'low' }), scenario);
      const hi = npvAt(atLikely({ path, at: 'high' }), scenario);
      return { input: path, basis: tri.basis, npvAtLow: round(lo, 2), npvAtHigh: round(hi, 2), swing: round(Math.abs(hi - lo), 2) };
    })
    .map((row, index) => ({ row, index }))
    .sort((a, b) => b.row.swing - a.row.swing || a.index - b.index)
    .slice(0, 8)
    .map(({ row }) => row);

  const scenario = (weekly: number[], npvs: number[], paybacks: (number | null)[], which: 'cash' | 'redeployed'): ScenarioResult => {
    const nulls = paybacks.filter((p) => p === null).length;
    const sortedPayback = paybacks.map((p) => p ?? Number.POSITIVE_INFINITY).sort((a, b) => a - b);
    return {
      weeklyDelta: bandOf(weekly),
      npv: bandOf(npvs),
      probabilityNpvPositive: round(npvs.filter((n) => n > 0).length / npvs.length, 4),
      payback: {
        p50Month: nulls * 2 >= paybacks.length ? null : round(percentile(sortedPayback, 0.5), 2),
        probabilityWithinHorizon: round((paybacks.length - nulls) / paybacks.length, 4),
      },
      sensitivity: sensitivity(which),
      baseNpvAtLikely: round(npvAt(base, which), 2),
    };
  };
  const cashScenario = scenario(cash, npvCash, paybackCash, 'cash');
  const redeployedScenario = scenario(redeployed, npvRedeployed, paybackRedeployed, 'redeployed');

  // Inputs report
  const byBasis = Object.fromEntries(INPUT_BASES.map((b) => [b, 0])) as Record<InputBasis, number>;
  for (const { tri } of paths) byBasis[tri.basis] += 1;
  const basisOf = new Map(paths.map(({ path, tri }) => [path, tri.basis]));
  const unconfirmed: { path: string; why: string }[] = [];
  const reported: { taskKind: string; runs: number; mean: number; currency: string; basis: typeof REPORTED_COST_BASIS }[] = [];
  const seenKinds = new Set<string>();
  for (const t of changedInOrder) {
    if (!opts.agentLevelTasks.has(t)) continue;
    const kind = opts.taskKindOf.get(t) ?? '';
    const m = opts.reportedAgentCost.get(kind);
    if (!m) unconfirmed.push({ path: `tasks[${t}].proposed.agentCostPerRun`, why: UNCONFIRMED_AGENT_COST });
    else if (!seenKinds.has(kind)) { seenKinds.add(kind); reported.push({ taskKind: kind, runs: m.runs, mean: round(m.mean, 4), currency: inputs.currency, basis: REPORTED_COST_BASIS }); }
  }

  const vtcWhy = !everyTaskEntered ? RATIO_NEEDS_EVERY_TASK
    : vtc.currentDegenerate || vtc.proposedDegenerate
      ? `the ${[vtc.currentDegenerate ? 'current' : '', vtc.proposedDegenerate ? 'proposed' : ''].filter(Boolean).join(' and ')} cost is zero in some draws, so its ratio is undefined`
      : null;

  const unitsProposed = inputs.unitsPerWeek.proposed ?? inputs.unitsPerWeek.current;
  const pilot = changedInOrder.filter((t) => opts.agentLevelTasks.has(t)).map((t) => {
    const ti = inputs.tasks[t] as TaskInputs;
    const runsNeeded = runsForRuleOfThree(inputs.criticalFailureCeiling);
    const perWeek = unitsProposed.likely * ti.runsPerUnit.likely;
    return {
      taskIri: t, ceiling: inputs.criticalFailureCeiling, confidence: 0.95 as const, runsNeeded,
      weeksAtLikelyThroughput: perWeek > 0 ? Math.ceil(runsNeeded / perWeek) : null,
      likelyRateExceedsCeiling: (ti.proposed ?? ti.current).criticalFailureRate.likely > inputs.criticalFailureCeiling,
    };
  });

  return {
    seed, draws, currency: inputs.currency, method: opts.methodIri,
    scenarios: { cash: cashScenario, redeployed: redeployedScenario },
    freedPersonHours: {
      total: bandOf(freedTotal),
      perTask: changedInOrder.map((t) => ({
        taskIri: t, band: bandOf(freedPer.get(t) ?? [0]),
        disposition: inputs.freedHours[t]?.disposition ?? 'undecided', note: inputs.freedHours[t]?.note ?? null,
      })),
    },
    valueToCost: {
      current: everyTaskEntered && !vtc.currentDegenerate && vtc.current.length > 0 ? bandOf(vtc.current, 4) : null,
      proposed: everyTaskEntered && !vtc.proposedDegenerate && vtc.proposed.length > 0 ? bandOf(vtc.proposed, 4) : null,
      why: vtcWhy,
    },
    breakdown: {
      current: { total: roundBreakdown(base.ev.current.total), perTask: base.ev.current.perTask.map(roundBreakdown) },
      proposed: { total: roundBreakdown(base.ev.proposed.total), perTask: base.ev.proposed.perTask.map(roundBreakdown) },
    },
    inputs: {
      byBasis,
      noRange: paths.filter(({ tri }) => tri.basis !== 'not-applicable' && tri.low === tri.likely && tri.likely === tri.high).map(({ path }) => path),
      topSensitivityEstimates: cashScenario.sensitivity.slice(0, 3).filter((r) => basisOf.get(r.input) === 'estimate').map((r) => r.input),
      unchangedTasks: everyTaskEntered ? 'entered' : 'not entered: unchanged tasks cancel when throughput is unchanged',
      unconfirmed,
      reportedAgentCost: reported,
    },
    pilot,
    assumptions: VALUATION_ASSUMPTIONS,
  };
}

// ── Outcome grading ───────────────────────────────────────────────────────────────────────

export type BandAnswer = 'below-band' | 'in-band' | 'above-band';
export type BandVerdict = BandAnswer | 'inconclusive';
/** In ordinal order. */
export const BAND_ALTERNATIVES: readonly BandAnswer[] = ['below-band', 'in-band', 'above-band'];
export const MONTH_DAYS = 30.436875;

export function monthsBetween(fromIso: string, toIso: string): number {
  return (Date.parse(toIso) - Date.parse(fromIso)) / 86_400_000 / MONTH_DAYS;
}

/**
 * The mean of the linear ramp factor min(1, t / R) over [t0, t1] months since countersign:
 * F(t) = t²/(2R) for t ≤ R, else R/2 + (t − R); mean = (F(t1) − F(t0)) / (t1 − t0). R = 0 ⇒ 1.
 * The same ramp the NPV uses, taken continuously.
 */
export function meanRampFactor(t0Months: number, t1Months: number, rampMonths: number): number {
  if (rampMonths <= 0) return 1;
  const R = rampMonths;
  const F = (t: number): number => (t <= R ? (t * t) / (2 * R) : R / 2 + (t - R));
  if (t1Months <= t0Months) return Math.min(1, Math.max(0, t0Months) / R);
  return (F(Math.max(0, t1Months)) - F(Math.max(0, t0Months))) / (t1Months - t0Months);
}

/**
 * A measurement window must be well formed, start at or after countersign, and have ended.
 * `why` is the headline; `detail` names the dates that decided it, so the person refused can
 * see when the window may be recorded rather than guess.
 */
export function checkOutcomeWindow(w: { readonly countersignedAt: string; readonly windowStart: string; readonly windowEnd: string; readonly now: Date }):
  null | { readonly status: 400 | 409; readonly why: string; readonly detail: string } {
  if (!isIsoInstant(w.windowStart) || !isIsoInstant(w.windowEnd)) {
    return { status: 400, why: 'windowStart and windowEnd must be ISO-8601 date-times', detail: 'windowStart and windowEnd must be ISO-8601 date-times' };
  }
  if (Date.parse(w.windowStart) >= Date.parse(w.windowEnd)) return { status: 400, why: 'windowStart must be before windowEnd', detail: 'windowStart must be before windowEnd' };
  if (Date.parse(w.windowStart) < Date.parse(w.countersignedAt)) {
    return {
      status: 409, why: 'The measurement window starts before the decision was countersigned.',
      detail: `the window starts ${w.windowStart}; the decision was countersigned ${w.countersignedAt}`,
    };
  }
  if (Date.parse(w.windowEnd) > w.now.getTime()) {
    return {
      status: 409, why: 'The measurement window has not ended yet.',
      detail: `the window ends ${w.windowEnd}; it is now ${w.now.toISOString()}`,
    };
  }
  return null;
}

const WEEK_MS = 7 * 86_400_000;

/**
 * A measurement window must be as long as the plan declared (windowWeeks). A kept change
 * measured over a shorter window is refused: a grader could otherwise pick a short, favourable
 * stretch. A change stopped early or reverted may be measured over less, says so
 * (shorterThanPlanned), and stays out of the calibration cells.
 */
export function checkWindowLength(w: { readonly windowStart: string; readonly windowEnd: string; readonly windowWeeks: number; readonly disposition: OutcomeDisposition }):
  { readonly ok: false; readonly status: 409; readonly why: string; readonly detail: string } | { readonly ok: true; readonly weeks: number; readonly shorterThanPlanned: boolean } {
  const weeks = (Date.parse(w.windowEnd) - Date.parse(w.windowStart)) / WEEK_MS;
  const shorter = weeks + 1e-9 < w.windowWeeks;
  if (shorter && w.disposition === 'kept') {
    return {
      ok: false, status: 409, why: 'The measurement window is shorter than the plan declared.',
      detail: `the window is ${round(weeks, 2)} weeks; the measurement plan declared ${w.windowWeeks}. Measure the whole window, or record the change as stopped early or reverted, with a note`,
    };
  }
  return { ok: true, weeks: round(weeks, 4), shorterThanPlanned: shorter };
}

/**
 * Grade a measured weekly change against the predicted steady-state band scaled by the mean
 * ramp factor over the window. With an interval: wholly above P90 → above-band, wholly below
 * P10 → below-band, wholly inside → in-band, straddling an edge → inconclusive.
 */
export function gradeOutcome(i: {
  readonly band: Band; readonly rampMonths: number; readonly countersignedAt: string; readonly windowStart: string; readonly windowEnd: string;
  readonly measured: number; readonly interval?: { readonly low: number; readonly high: number };
}): { readonly verdict: BandVerdict; readonly adjustedBand: Band; readonly rampFactor: number; readonly rampAdjusted: boolean } {
  const factor = meanRampFactor(monthsBetween(i.countersignedAt, i.windowStart), monthsBetween(i.countersignedAt, i.windowEnd), i.rampMonths);
  const adjusted: Band = { p10: i.band.p10 * factor, p50: i.band.p50 * factor, p90: i.band.p90 * factor };
  let verdict: BandVerdict;
  if (i.interval) {
    const { low, high } = i.interval;
    if (low > adjusted.p90) verdict = 'above-band';
    else if (high < adjusted.p10) verdict = 'below-band';
    else if (low >= adjusted.p10 && high <= adjusted.p90) verdict = 'in-band';
    else verdict = 'inconclusive';
  } else {
    verdict = i.measured < adjusted.p10 ? 'below-band' : i.measured > adjusted.p90 ? 'above-band' : 'in-band';
  }
  return {
    verdict,
    adjustedBand: { p10: round(adjusted.p10, 2), p50: round(adjusted.p50, 2), p90: round(adjusted.p90, 2) },
    rampFactor: round(factor, 6),
    rampAdjusted: factor < 1,
  };
}

// ── Calibration (DECISIONS #5) ────────────────────────────────────────────────────────────

export type RunAnswer = 'accepted' | 'reworked' | 'critical-failure';
/** In ordinal order of severity. */
export const RUN_ALTERNATIVES: readonly ['accepted', 'reworked', 'critical-failure'] = ['accepted', 'reworked', 'critical-failure'];
export const VALUATION_JUDGE = 'urn:wrd:judge:valuation-engine:v1';
export const DEMO_LABEL = 'scripted by the offline demo, not evidence';
export const DISTINCT_PEOPLE_NOTE = 'distinct registered reviewers the admin attests are different people; this bridge cannot verify that';
export const NO_COMPARISON_GROUP = 'no comparison group';
export const PROBE_SIGNALS_LABEL = 'not a calibration of predictions: a probe predicts nothing';
/** The nominal coverage of a P10–P90 band, which a valued decision's judgment states as its confidence. */
export const NOMINAL_BAND_COVERAGE = 0.8;

const basisClass = (b: ComparisonBasis): 'controlled' | 'uncontrolled' => (b === 'before-after' ? 'uncontrolled' : 'controlled');

/** One calibration kind per (metric × decision level × whether there was a comparison group). */
export function predictionKind(metric: OutcomeMetric, level: AllocationLevel, basis: ComparisonBasis): DecisionKind {
  return { kind: `prediction:${metric}:${level}:${basisClass(basis)}`, alternatives: BAND_ALTERNATIVES, axis: 'accuracy' };
}
export function runKind(taskKind: string): DecisionKind {
  return { kind: `agent-run:${taskKind}`, alternatives: RUN_ALTERNATIVES, axis: 'competence' };
}

/** Mean |index(answer) − index(confirmed)| over the ordinal alternatives; null with no outcomes. The kit's Brier treats levels as nominal. */
export function meanOrdinalDistance(outcomes: readonly LoopOutcome[], alternatives: readonly string[]): number | null {
  const rows = outcomes.filter((o) => alternatives.includes(o.answer) && alternatives.includes(o.confirmedAnswer));
  if (rows.length === 0) return null;
  const sum = rows.reduce((n, o) => n + Math.abs(alternatives.indexOf(o.answer) - alternatives.indexOf(o.confirmedAnswer)), 0);
  return round(sum / rows.length, 4);
}

export interface DecisionForCalibration {
  readonly decisionIri: string; readonly level: AllocationLevel; readonly metric: OutcomeMetric; readonly basis: ComparisonBasis;
  readonly verdict: BandVerdict; readonly rampAdjusted: boolean; readonly disposition: OutcomeDisposition;
  readonly measuredBy: string; readonly submittedAt: string; readonly measuredAt: string; readonly demo: boolean;
  /** Measured over less than the declared window (only a change stopped early or reverted can be): kept out of the cells and counted. */
  readonly shortWindow: boolean;
}
export interface ReviewedRun {
  readonly runIri: string; readonly taskIri: string; readonly agentDid: string; readonly taskKind: string; readonly model: string;
  readonly selfAnswer: RunAnswer; readonly selfProbabilities?: Readonly<Record<string, number>>;
  readonly verdict: RunAnswer; readonly reviewerDid: string; readonly reviewerPersonRef: string;
  readonly reviewedAt: string; readonly performedAt: string; readonly demo: boolean;
}
export interface ProbeOutcome { readonly decisionIri: string; readonly taskIri: string; readonly index: number; readonly signal: ProbeSignal; readonly demo: boolean }

export interface PredictionCell {
  readonly kind: string; readonly metric: OutcomeMetric; readonly level: AllocationLevel; readonly basisClass: 'controlled' | 'uncontrolled'; readonly label: string;
  readonly samples: number; readonly hitRate: number | null; readonly meanBrier: number | null; readonly meanOrdinalDistance: number | null;
  readonly status: 'Hypothetical' | 'Asserted'; readonly excludedInconclusive: number; readonly excludedShortWindow: number; readonly rampAdjusted: number;
  readonly dispositions: Readonly<Record<OutcomeDisposition, number>>; readonly demoSamples: number; readonly scriptedLabel: string | null;
  readonly decisions: readonly string[];
}
export interface AgentCell {
  readonly kind: string; readonly agentDid: string; readonly taskKind: string; readonly model: string; readonly currentModel: boolean;
  /** hitRate, meanBrier and meanOrdinalDistance measure how well the agent's OWN assessment of each run agreed with the person's verdict. */
  readonly samples: number; readonly hitRate: number | null; readonly meanBrier: number | null; readonly meanOrdinalDistance: number | null;
  /** The share of reviewed runs a person accepted: how often the work itself was good enough. */
  readonly acceptedShare: number | null;
  readonly readyClaims: number;
  readonly readyClaimPrecision: number | null; readonly distinctConfirmers: number; readonly distinctConfirmersNote: string;
  readonly status: 'Hypothetical' | 'Asserted'; readonly demoSamples: number; readonly scriptedLabel: string | null;
}
export interface CalibrationReport {
  readonly minSamples: number;
  readonly nominalBandCoverage: number;
  readonly predictionCells: readonly PredictionCell[];
  readonly agentCells: readonly AgentCell[];
  readonly probeSignals: {
    readonly label: string; readonly probes: number; readonly amplify: number; readonly dampen: number; readonly neither: number;
    readonly conditionFired: number; readonly demoSamples: number; readonly scriptedLabel: string | null;
  };
}

const PREDICTION_PROBABILITIES = { 'below-band': (1 - NOMINAL_BAND_COVERAGE) / 2, 'in-band': NOMINAL_BAND_COVERAGE, 'above-band': (1 - NOMINAL_BAND_COVERAGE) / 2 };

/** The agent's own assessment of each run, scored against the person's verdict: calibration of its self-assessment. */
function runOutcomes(runs: readonly ReviewedRun[], kind: DecisionKind): LoopOutcome[] {
  return runs.map((r) => {
    const j = judgment(kind, {
      id: r.runIri, subject: r.runIri, answer: r.selfAnswer, judge: r.agentDid, createdAt: r.performedAt,
      ...(r.selfProbabilities ? { probabilities: r.selfProbabilities } : {}),
    });
    return outcome(j, r.verdict, { did: r.reviewerDid, kind: 'human' }, new Date(r.reviewedAt));
  });
}

/**
 * Every run scored as the fixed claim "this work will be accepted", the way a prediction is
 * scored as the fixed claim "in band": a hit is a run a person accepted. The kit's competence
 * rating over these outcomes is the share of the agent's work people accepted — what a grant
 * to act alone has to rest on — whatever the agent said about its own runs.
 */
function acceptanceOutcomes(runs: readonly ReviewedRun[], kind: DecisionKind): LoopOutcome[] {
  return runs.map((r) => {
    const j = judgment(kind, { id: r.runIri, subject: r.runIri, answer: 'accepted', judge: r.agentDid, createdAt: r.performedAt });
    return outcome(j, r.verdict, { did: r.reviewerDid, kind: 'human' }, new Date(r.reviewedAt));
  });
}

function acceptedShareOf(runs: readonly ReviewedRun[]): number | null {
  return runs.length === 0 ? null : round(runs.filter((r) => r.verdict === 'accepted').length / runs.length, 4);
}

function readyClaimPrecisionOf(runs: readonly ReviewedRun[]): number | null {
  const ready = runs.filter((r) => r.selfAnswer === 'accepted');
  return ready.length === 0 ? null : round(ready.filter((r) => r.verdict === 'accepted').length / ready.length, 4);
}

/**
 * Prediction cells (did the measured value land in the ramp-adjusted band?), agent-run cells
 * (did a person agree with the agent's own assessment?), and probe signals — the last reported
 * apart, because a probe predicts nothing. Inconclusive verdicts are excluded from the cells
 * and counted. Every cell built on a demo record carries DEMO_LABEL.
 */
export function calibrationReport(input: {
  readonly decisions: readonly DecisionForCalibration[]; readonly runs: readonly ReviewedRun[]; readonly probes: readonly ProbeOutcome[];
  readonly minSamples: number; readonly policy: GrantPolicy; readonly currentModelOf: (agentDid: string) => string | null;
}): CalibrationReport {
  const byKind = new Map<string, DecisionForCalibration[]>();
  for (const d of input.decisions) {
    const k = predictionKind(d.metric, d.level, d.basis).kind;
    byKind.set(k, [...(byKind.get(k) ?? []), d]);
  }
  const predictionCells: PredictionCell[] = [...byKind.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([k, ds]) => {
    const first = ds[0] as DecisionForCalibration;
    const kind = predictionKind(first.metric, first.level, first.basis);
    const graded = ds.filter((d) => d.verdict !== 'inconclusive' && !d.shortWindow);
    const outcomes = graded.map((d) => {
      const j = judgment(kind, { id: d.decisionIri, subject: d.decisionIri, answer: 'in-band', probabilities: PREDICTION_PROBABILITIES, judge: VALUATION_JUDGE, createdAt: d.submittedAt });
      return outcome(j, d.verdict, { did: d.measuredBy, kind: 'human' }, new Date(d.measuredAt));
    });
    const cell = calibration(outcomes, [kind], input.minSamples)[0];
    const demoSamples = ds.filter((d) => d.demo).length;
    const cls = basisClass(first.basis);
    return {
      kind: k, metric: first.metric, level: first.level, basisClass: cls,
      label: `${first.metric}, ${first.level}${cls === 'uncontrolled' ? ` — ${NO_COMPARISON_GROUP}` : ''}`,
      samples: cell?.samples ?? 0, hitRate: cell?.hitRate ?? null, meanBrier: cell?.meanBrier ?? null,
      meanOrdinalDistance: meanOrdinalDistance(outcomes, BAND_ALTERNATIVES),
      status: cell?.status ?? 'Hypothetical',
      excludedInconclusive: ds.filter((d) => d.verdict === 'inconclusive' && !d.shortWindow).length,
      excludedShortWindow: ds.filter((d) => d.shortWindow).length,
      rampAdjusted: ds.filter((d) => d.rampAdjusted).length,
      dispositions: { kept: ds.filter((d) => d.disposition === 'kept').length, reverted: ds.filter((d) => d.disposition === 'reverted').length, 'stopped-early': ds.filter((d) => d.disposition === 'stopped-early').length },
      demoSamples, scriptedLabel: demoSamples > 0 ? DEMO_LABEL : null,
      decisions: ds.map((d) => d.decisionIri),
    };
  });

  const byAgent = new Map<string, ReviewedRun[]>();
  for (const r of input.runs) {
    const k = `${r.agentDid}|${r.taskKind}|${r.model}`;
    byAgent.set(k, [...(byAgent.get(k) ?? []), r]);
  }
  const agentCells: AgentCell[] = [...byAgent.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([, rs]) => {
    const first = rs[0] as ReviewedRun;
    const kind = runKind(first.taskKind);
    const outcomes = runOutcomes(rs, kind);
    const cell = calibration(outcomes, [kind], input.minSamples)[0];
    const demoSamples = rs.filter((r) => r.demo).length;
    return {
      kind: kind.kind, agentDid: first.agentDid, taskKind: first.taskKind, model: first.model,
      currentModel: input.currentModelOf(first.agentDid) === first.model,
      samples: cell?.samples ?? 0, hitRate: cell?.hitRate ?? null, meanBrier: cell?.meanBrier ?? null,
      meanOrdinalDistance: meanOrdinalDistance(outcomes, RUN_ALTERNATIVES),
      acceptedShare: acceptedShareOf(rs), readyClaims: rs.filter((r) => r.selfAnswer === 'accepted').length,
      readyClaimPrecision: readyClaimPrecisionOf(rs),
      distinctConfirmers: new Set(rs.map((r) => r.reviewerPersonRef)).size, distinctConfirmersNote: DISTINCT_PEOPLE_NOTE,
      status: cell?.status ?? 'Hypothetical', demoSamples, scriptedLabel: demoSamples > 0 ? DEMO_LABEL : null,
    };
  });

  const amplify = input.probes.filter((p) => p.signal === 'amplify').length;
  const dampen = input.probes.filter((p) => p.signal === 'dampen').length;
  const probeDemo = input.probes.filter((p) => p.demo).length;
  return {
    minSamples: input.minSamples,
    nominalBandCoverage: NOMINAL_BAND_COVERAGE,
    predictionCells,
    agentCells,
    probeSignals: {
      label: PROBE_SIGNALS_LABEL, probes: input.probes.length, amplify, dampen, neither: input.probes.length - amplify - dampen,
      conditionFired: amplify + dampen, demoSamples: probeDemo, scriptedLabel: probeDemo > 0 ? DEMO_LABEL : null,
    },
  };
}

// ── Earned grants (DECISIONS #5, #10, #13) ────────────────────────────────────────────────

export interface GrantEvaluation {
  readonly earned: boolean;
  readonly why: string;
  readonly kitWhy: string | null;
  readonly samples: number;
  readonly humanConfirmations: number;
  readonly distinctConfirmers: number;
  readonly distinctConfirmersNote: string;
  /** The kit's competence rating over acceptance outcomes: the share of reviewed runs a person accepted. */
  readonly rating: number | null;
  readonly acceptedShare: number | null;
  /** Runs the agent itself called ready ('accepted'); precision is measured over these. */
  readonly readyClaims: number;
  readonly readyClaimPrecision: number | null;
  readonly criticalFailuresOnReadyClaims: number;
  readonly criticalFailures: number;
  readonly countedSince: string | null;
  readonly model: string;
  readonly runIris: readonly string[];
  readonly taskIris: readonly string[];
}

const pct = (x: number): string => `${round(x * 100, 1)}%`;

/**
 * Whether an agent has earned a grant on one kind of task, checks in order:
 *   1. only runs a person reviewed, on the agent's currently declared model, after the latest
 *      revocation, and at least minSamples of them;
 *   2. the kit's autonomy rule over ACCEPTANCE outcomes — each run is the fixed claim "this
 *      work will be accepted", so the competence rating is the share of reviewed runs a person
 *      accepted, and it must clear the floor (an agent whose work is reworked 95% of the time
 *      does not earn, however truthfully it labels its own runs);
 *   3. enough DISTINCT reviewers by attested person reference (the kit counts outcomes);
 *   4. at least minSamples runs the agent itself called ready, because under a grant the agent
 *      acts alone only on runs it calls ready (the rest go to a person) — precision over one
 *      ready claim proves nothing;
 *   5. precision on those ready claims, with no critical failure among them.
 */
export function evaluateGrant(input: {
  readonly agentDid: string; readonly taskKind: string; readonly model: string; readonly runs: readonly ReviewedRun[];
  readonly policy: GrantPolicy; readonly attestor: string; readonly since: string | null; readonly now: Date; readonly grantGraphUrl: string;
}): GrantEvaluation {
  const p = input.policy;
  const sinceMs = input.since === null ? Number.NEGATIVE_INFINITY : Date.parse(input.since);
  const counted = input.runs
    .filter((r) => r.agentDid === input.agentDid && r.taskKind === input.taskKind && r.model === input.model && Date.parse(r.reviewedAt) > sinceMs)
    .sort((a, b) => a.reviewedAt.localeCompare(b.reviewedAt) || a.runIri.localeCompare(b.runIri));
  const samples = counted.length;
  const accepted = counted.filter((r) => r.verdict === 'accepted').length;
  const distinct = new Set(counted.map((r) => r.reviewerPersonRef)).size;
  const ready = counted.filter((r) => r.selfAnswer === 'accepted');
  const precision = readyClaimPrecisionOf(counted);
  const criticalOnReady = ready.filter((r) => r.verdict === 'critical-failure').length;
  const base = {
    samples, humanConfirmations: samples, distinctConfirmers: distinct, distinctConfirmersNote: DISTINCT_PEOPLE_NOTE,
    acceptedShare: acceptedShareOf(counted), readyClaims: ready.length,
    readyClaimPrecision: precision, criticalFailuresOnReadyClaims: criticalOnReady,
    criticalFailures: counted.filter((r) => r.verdict === 'critical-failure').length,
    countedSince: input.since, model: input.model,
    runIris: counted.map((r) => r.runIri), taskIris: [...new Set(counted.map((r) => r.taskIri))].sort(),
  };
  const sinceText = input.since === null ? '' : ` since ${input.since}`;
  if (samples < p.minSamples) {
    return { ...base, earned: false, why: `${samples} person-reviewed runs on model ${input.model}${sinceText}; the policy needs ${p.minSamples}.`, kitWhy: null, rating: null };
  }
  const kind = runKind(input.taskKind);
  const outcomes = acceptanceOutcomes(counted, kind);
  const cells = calibration(outcomes, [kind], p.minSamples);
  const fromExecution = `urn:wrd:grant-evaluation:${h16(canonicalJson({ agent: input.agentDid, taskKind: input.taskKind, model: input.model, runs: base.runIris }))}`;
  const att = attestation(cells, [kind], { attestor: input.attestor, subject: input.agentDid, descriptorUrl: input.grantGraphUrl, fromExecution, attestedAt: input.now.toISOString() });
  const snap = reputations(att ? [att] : [], 'wrd-grant-policy', input.now.toISOString()).get(input.agentDid) ?? null;
  const rated = snap?.axes[kind.axis];
  const rating = typeof rated === 'number' ? round(rated, 4) : null;
  const decision = autonomy({ kind: kind.kind, floor: p.floor, minSamples: p.minSamples, minHumanConfirmers: p.minHumanConfirmations }, kind, snap, att);
  const acceptedText = `a person accepted ${accepted} of ${samples} reviewed runs (${pct(accepted / samples)})`;
  if (!decision.granted) {
    return {
      ...base, earned: false, kitWhy: decision.why, rating,
      why: rating !== null && rating < p.floor ? `${acceptedText}; the policy needs at least ${pct(p.floor)}.` : decision.why,
    };
  }
  if (distinct < p.minDistinctConfirmers) {
    return {
      ...base, earned: false, kitWhy: decision.why, rating,
      why: `reviewed by ${distinct} ${DISTINCT_PEOPLE_NOTE.replace('; this bridge cannot verify that', '')}; the policy needs ${p.minDistinctConfirmers}. This bridge cannot verify that they are different people.`,
    };
  }
  if (ready.length < p.minSamples) {
    return {
      ...base, earned: false, kitWhy: decision.why, rating,
      why: `the agent called ${ready.length} of its reviewed runs ready; at least ${p.minSamples} ready claims are needed before their precision means anything (under a grant the agent acts alone only on runs it calls ready).`,
    };
  }
  if (precision === null || precision < p.minReadyClaimPrecision) {
    return { ...base, earned: false, kitWhy: decision.why, rating, why: `a person accepted ${pct(precision ?? 0)} of the ${ready.length} runs the agent called ready; the policy needs ${pct(p.minReadyClaimPrecision)}.` };
  }
  if (criticalOnReady > 0) {
    return { ...base, earned: false, kitWhy: decision.why, rating, why: `${criticalOnReady} run(s) the agent called ready were critical failures.` };
  }
  return {
    ...base, earned: true, kitWhy: decision.why, rating,
    why: `earned: ${acceptedText}, clearing ${pct(p.floor)}; reviewed by ${distinct} ${DISTINCT_PEOPLE_NOTE}; ${pct(precision)} of ${ready.length} ready claims accepted.`,
  };
}
