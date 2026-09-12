import { randomUUID } from 'node:crypto';

/** A registry graph has RDF-like triples; terms retain exact-value matching semantics. */
export type Triple = [unknown, unknown, unknown];
export type Bindings = Record<string, unknown>;

export interface HolonView {
  id: string;
  graph?: Triple[];
  preconditions?: Triple[];
  lenses?: string[];
  granularities?: string[];
  valence?: string;
  affordance?: unknown;
  parts?: unknown[];
  wholes?: unknown[];
  [key: string]: unknown;
}

export interface Holon {
  id: string;
  label?: string;
  views?: HolonView[];
  valence?: string;
  evidence?: { successes?: number; failures?: number };
  registryDescriptor?: unknown;
  pgslAtom?: unknown;
  [key: string]: unknown;
}

export interface Invocation {
  descriptor_url: string;
  action_iri: string;
  method: unknown;
  target: unknown;
  media_type: unknown;
  payload: unknown;
}

export interface Precondition { triple: Triple; satisfied: boolean }
export interface Invariant { pattern: Triple; realizedAs: Triple }
export interface Metrics {
  alignment: number;
  coverage: number;
  evidence: number;
  editCost: number;
  constraintFit: number;
}

export interface Candidate {
  id: string;
  kind: 'reuse' | 'composition';
  label: string;
  sourceHolons: string[];
  views: string[];
  lenses: string[];
  granularities: string[];
  valence: string;
  bindings: Bindings;
  invariants: Invariant[];
  differential: { proposedAdditions: Triple[]; unexplainedCurrent: Triple[] };
  preconditions: Precondition[];
  affordance: unknown;
  invocations: Invocation[];
  metrics: Metrics;
  provenance: Record<string, unknown>;
  neuralScore: number;
}

export interface Reaction {
  id: string;
  createdAt: string;
  input: { graph: Triple[]; context: Record<string, unknown> };
  search: { holonsExamined: number; viewsExamined: number; candidatesGenerated: number };
  frontier: Candidate[];
  options: Candidate[];
}

export type ResolutionPolicy = 'verified-minimal-edit' | 'evidence-first' | 'neural-rank';
export type Resolution = {
  reactionId: string;
  policy: ResolutionPolicy;
} & ({
  disposition: 'ask' | 'abstain';
  selected: null;
  missing: Precondition[];
} | {
  disposition: 'invoke' | 'plan';
  selected: Candidate & { execution: Invocation | null };
  retainedAlternatives: Candidate[];
  antiPatterns: Candidate[];
});

const MAX_HOLONS = 256;
const MAX_VIEWS = 256;
const MAX_TRIPLES = 128;
const MAX_SEARCH_STEPS = 500_000;
const MAX_VALUE_NODES = 32_768;
const MAX_VALUE_DEPTH = 32;
const isVariable = (term: unknown): term is string => typeof term === 'string' && term.startsWith('?');
const round = (value: number): number => Math.round(value * 1000) / 1000;
const clone = <T>(value: T): T => structuredClone(value);
const sigmoid = (value: number): number => 1 / (1 + Math.exp(-value));
const record = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);

/** Reject malformed and overlarge inputs before ranking, never silently truncate evidence. */
function assertGraph(value: unknown): asserts value is Triple[] {
  if (!Array.isArray(value) || value.length > MAX_TRIPLES
    || value.some((triple) => !Array.isArray(triple) || triple.length !== 3)) {
    throw new TypeError(`graph must contain at most ${MAX_TRIPLES} [subject, predicate, object] triples.`);
  }
}

function assertBoundedValue(value: unknown): void {
  let nodes = 0;
  const ancestors = new Set<object>();
  function visit(current: unknown, depth: number): void {
    if (++nodes > MAX_VALUE_NODES || depth > MAX_VALUE_DEPTH) {
      throw new RangeError('Differential input exceeds the value traversal budget.');
    }
    if (current === null || typeof current !== 'object') return;
    if (ancestors.has(current)) throw new TypeError('Differential input must not contain cycles.');
    ancestors.add(current);
    for (const child of Object.values(current)) visit(child, depth + 1);
    ancestors.delete(current);
  }
  visit(value, 0);
}

function parseHolons(values: unknown[]): Map<string, Holon> {
  if (!Array.isArray(values) || values.length > MAX_HOLONS) {
    throw new RangeError(`At most ${MAX_HOLONS} registry holons are supported per reaction.`);
  }
  assertBoundedValue(values);
  let viewCount = 0;
  const result = new Map<string, Holon>();
  for (const value of values) {
    if (!record(value) || typeof value.id !== 'string' || !value.id) throw new TypeError('A holon requires an id.');
    if (result.has(value.id)) throw new TypeError(`Duplicate holon id: ${value.id}`);
    if (value.label !== undefined && typeof value.label !== 'string') throw new TypeError('A holon label must be a string.');
    if (value.valence !== undefined && typeof value.valence !== 'string') throw new TypeError('A holon valence must be a string.');
    if (value.evidence !== undefined) {
      if (!record(value.evidence)) throw new TypeError('Holon evidence must be an object.');
      for (const key of ['successes', 'failures']) {
        const count = value.evidence[key];
        if (count !== undefined && (typeof count !== 'number' || !Number.isFinite(count) || count < 0)) {
          throw new TypeError('Evidence counts must be finite nonnegative numbers.');
        }
      }
    }
    if (value.views !== undefined && !Array.isArray(value.views)) throw new TypeError('Holon views must be an array.');
    for (const view of value.views || []) {
      if (++viewCount > MAX_VIEWS) throw new RangeError(`At most ${MAX_VIEWS} registry views are supported per reaction.`);
      if (!record(view) || typeof view.id !== 'string' || !view.id) throw new TypeError('A view requires an id.');
      if (view.graph !== undefined) assertGraph(view.graph);
      if (view.preconditions !== undefined) assertGraph(view.preconditions);
      if (view.valence !== undefined && typeof view.valence !== 'string') throw new TypeError('A view valence must be a string.');
      for (const field of ['lenses', 'granularities']) {
        const list = view[field];
        if (list !== undefined && (!Array.isArray(list) || list.some((item) => typeof item !== 'string'))) {
          throw new TypeError(`${field} must be a string array.`);
        }
      }
      for (const field of ['parts', 'wholes']) {
        if (view[field] !== undefined && !Array.isArray(view[field])) throw new TypeError(`${field} must be an array.`);
      }
    }
    result.set(value.id, clone(value as Holon));
  }
  return result;
}

function bindTerm(term: unknown, bindings: Bindings): unknown {
  return isVariable(term) && Object.hasOwn(bindings, term) ? bindings[term] : term;
}

function bindValue(value: unknown, bindings: Bindings): unknown {
  if (typeof value === 'string') return bindTerm(value, bindings);
  if (Array.isArray(value)) return value.map((item) => bindValue(item, bindings));
  if (record(value)) return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, bindValue(item, bindings)]));
  return value;
}

function bindTriple(triple: Triple, bindings: Bindings): Triple {
  return [bindTerm(triple[0], bindings), bindTerm(triple[1], bindings), bindTerm(triple[2], bindings)];
}

function unifyTerm(pattern: unknown, actual: unknown, bindings: Bindings): Bindings | null {
  if (!isVariable(pattern)) return pattern === actual ? bindings : null;
  if (Object.hasOwn(bindings, pattern)) return bindings[pattern] === actual ? bindings : null;
  return { ...bindings, [pattern]: actual };
}

function unifyTriple(pattern: Triple, actual: Triple, bindings: Bindings): Bindings | null {
  let next: Bindings | null = bindings;
  for (let index = 0; index < 3; index += 1) {
    next = unifyTerm(pattern[index], actual[index], next);
    if (!next) return null;
  }
  return next;
}

interface Alignment {
  matches: Array<{ patternIndex: number; actualIndex: number }>;
  bindings: Bindings;
  used: Set<number>;
}
interface SearchBudget { remaining: number }

function spend(budget: SearchBudget): void {
  if (--budget.remaining < 0) {
    throw new RangeError('Differential matching search budget exhausted; no partial plan is available.');
  }
}

function bestAlignment(patterns: Triple[], actuals: Triple[], budget: SearchBudget): Alignment {
  let best: Alignment = { matches: [], bindings: {}, used: new Set<number>() };
  function visit(index: number, bindings: Bindings, matches: Alignment['matches'], used: Set<number>): void {
    spend(budget);
    if (index === patterns.length) {
      if (matches.length > best.matches.length) best = { matches, bindings, used };
      return;
    }
    // Equal-size alignments never replace the first one; pruning preserves that original tie order.
    if (matches.length + Math.min(patterns.length - index, actuals.length - used.size) <= best.matches.length) return;
    visit(index + 1, bindings, matches, used);
    for (const [actualIndex, actual] of actuals.entries()) {
      spend(budget);
      if (used.has(actualIndex)) continue;
      const nextBindings = unifyTriple(patterns[index]!, actual, bindings);
      if (!nextBindings) continue;
      const nextUsed = new Set(used);
      nextUsed.add(actualIndex);
      visit(index + 1, nextBindings, [...matches, { patternIndex: index, actualIndex }], nextUsed);
    }
  }
  visit(0, {}, [], new Set<number>());
  return best;
}

function compatibleBindings(left: Bindings, right: Bindings): boolean {
  return Object.keys(left).every((key) => !Object.hasOwn(right, key) || left[key] === right[key]);
}

function affordanceInvocations(affordance: unknown): Invocation[] {
  if (!record(affordance)) return [];
  const own: Invocation[] = typeof affordance.descriptor_url === 'string' && affordance.descriptor_url
    && typeof affordance.action_iri === 'string' && affordance.action_iri
    ? [{
      descriptor_url: affordance.descriptor_url,
      action_iri: affordance.action_iri,
      method: affordance.method || null,
      target: affordance.target || null,
      media_type: affordance.media_type || null,
      payload: clone(affordance.payload || {}),
    }] : [];
  const nested = Array.isArray(affordance.steps) ? affordance.steps.flatMap(affordanceInvocations) : [];
  return [...own, ...nested].filter((item, index, all) =>
    all.findIndex((other) => other.descriptor_url === item.descriptor_url && other.action_iri === item.action_iri) === index);
}

function dominates(left: Candidate, right: Candidate): boolean {
  const a = left.metrics;
  const b = right.metrics;
  const all = a.alignment >= b.alignment && a.coverage >= b.coverage && a.evidence >= b.evidence
    && a.constraintFit >= b.constraintFit && a.editCost <= b.editCost;
  const strict = a.alignment > b.alignment || a.coverage > b.coverage || a.evidence > b.evidence
    || a.constraintFit > b.constraintFit || a.editCost < b.editCost;
  return all && strict;
}

function unique<T>(values: T[]): T[] {
  const seen = new Set<string | undefined>();
  return values.filter((value) => {
    const key = JSON.stringify(value);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/** Pure proposal/resolution kernel. Verification and invocation belong to the shared runtime. */
export class DifferentialKernel {
  private readonly holons: Map<string, Holon>;
  private readonly reactions = new Map<string, Reaction>();
  private readonly weights: Record<string, number> = {
    bias: -0.15, alignment: 1.05, coverage: 0.7, evidence: 0.8,
    editEconomy: 0.4, constraintFit: 1.2, abstraction: 0.12,
    episode: 0.08, fragment: 0.1, antiPattern: -0.2,
  };

  constructor(holons: unknown[] = []) { this.holons = parseHolons(holons); }

  listHolons(): Holon[] { return [...this.holons.values()].map((holon) => clone(holon)); }

  private features(candidate: Candidate): Record<string, number> {
    return {
      bias: 1,
      alignment: candidate.metrics.alignment,
      coverage: candidate.metrics.coverage,
      evidence: candidate.metrics.evidence,
      editEconomy: 1 / (1 + candidate.metrics.editCost),
      constraintFit: candidate.metrics.constraintFit,
      abstraction: candidate.granularities.includes('abstraction') ? 1 : 0,
      episode: candidate.granularities.includes('episode') ? 1 : 0,
      fragment: candidate.granularities.includes('fragment') ? 1 : 0,
      antiPattern: candidate.valence === 'avoid' ? 1 : 0,
    };
  }

  private score(candidate: Candidate): number {
    const activation = Object.entries(this.features(candidate))
      .reduce((sum, [name, value]) => sum + (this.weights[name] || 0) * value, 0);
    return sigmoid(activation);
  }

  private enumerate(graph: Triple[], budget: SearchBudget): Candidate[] {
    const candidates: Candidate[] = [];
    for (const holon of this.holons.values()) {
      for (const view of holon.views || []) {
        const patterns = view.graph || [];
        const alignment = bestAlignment(patterns, graph, budget);
        if (alignment.matches.length === 0) continue;
        const matchedPatterns = new Set(alignment.matches.map((match) => match.patternIndex));
        const proposedAdditions = patterns.filter((_, index) => !matchedPatterns.has(index))
          .map((triple) => bindTriple(triple, alignment.bindings));
        const unexplained = graph.filter((_, index) => !alignment.used.has(index));
        const preconditions = (view.preconditions || []).map((pattern) => ({
          triple: bindTriple(pattern, alignment.bindings),
          satisfied: graph.some((actual) => { spend(budget); return Boolean(unifyTriple(pattern, actual, alignment.bindings)); }),
        }));
        const matched = alignment.matches.length;
        const successes = holon.evidence?.successes || 0;
        const failures = holon.evidence?.failures || 0;
        const candidate: Candidate = {
          id: `candidate:${randomUUID()}`,
          kind: 'reuse',
          label: holon.label || view.id,
          sourceHolons: [holon.id],
          views: [view.id],
          lenses: [...new Set(view.lenses || ['unspecified'])],
          granularities: [...new Set(view.granularities || ['unspecified'])],
          valence: view.valence || holon.valence || 'reuse',
          bindings: alignment.bindings,
          invariants: alignment.matches.map(({ patternIndex, actualIndex }) => ({
            pattern: patterns[patternIndex]!, realizedAs: graph[actualIndex]!,
          })),
          differential: { proposedAdditions, unexplainedCurrent: unexplained },
          preconditions,
          affordance: bindValue(view.affordance || null, alignment.bindings),
          invocations: [],
          neuralScore: 0,
          metrics: {
            alignment: round(matched / Math.max(patterns.length, 1)),
            coverage: round(matched / Math.max(graph.length, 1)),
            evidence: round((successes + 1) / (successes + failures + 2)),
            editCost: proposedAdditions.length + unexplained.length,
            constraintFit: round(1 - preconditions.filter((item) => !item.satisfied).length / Math.max(preconditions.length, 1)),
          },
          provenance: {
            registryDescriptor: holon.registryDescriptor || null,
            pgslAtom: holon.pgslAtom || null,
            parts: view.parts || [], wholes: view.wholes || [],
          },
        };
        candidate.invocations = affordanceInvocations(candidate.affordance);
        candidate.neuralScore = round(this.score(candidate));
        candidates.push(candidate);
      }
    }
    return candidates;
  }

  private compose(candidates: Candidate[], budget: SearchBudget): Candidate[] {
    const positive = candidates.filter((candidate) => candidate.valence !== 'avoid' && candidate.affordance);
    const composites: Candidate[] = [];
    for (let leftIndex = 0; leftIndex < positive.length; leftIndex += 1) {
      for (let rightIndex = leftIndex + 1; rightIndex < positive.length; rightIndex += 1) {
        spend(budget);
        const left = positive[leftIndex]!;
        const right = positive[rightIndex]!;
        if (!compatibleBindings(left.bindings, right.bindings)) continue;
        const lensGain = right.lenses.some((lens) => !left.lenses.includes(lens));
        const scaleGain = right.granularities.some((scale) => !left.granularities.includes(scale));
        if (!lensGain && !scaleGain) continue;
        const preconditions = unique([...left.preconditions, ...right.preconditions]);
        const additions = unique([...left.differential.proposedAdditions, ...right.differential.proposedAdditions]);
        const unexplained = left.differential.unexplainedCurrent.filter((triple) =>
          right.differential.unexplainedCurrent.some((other) => JSON.stringify(other) === JSON.stringify(triple)));
        const invariants = unique([...left.invariants, ...right.invariants]);
        const candidate: Candidate = {
          id: `candidate:${randomUUID()}`,
          kind: 'composition',
          label: `${left.label} + ${right.label}`,
          sourceHolons: [...new Set([...left.sourceHolons, ...right.sourceHolons])],
          views: [...new Set([...left.views, ...right.views])],
          lenses: [...new Set([...left.lenses, ...right.lenses])],
          granularities: [...new Set([...left.granularities, ...right.granularities])],
          valence: 'reuse',
          bindings: { ...left.bindings, ...right.bindings },
          invariants,
          differential: { proposedAdditions: additions, unexplainedCurrent: unexplained },
          preconditions,
          affordance: { type: 'graft', steps: [left.affordance, right.affordance] },
          invocations: [],
          neuralScore: 0,
          metrics: {
            alignment: Math.max(left.metrics.alignment, right.metrics.alignment),
            coverage: round(1 - unexplained.length / Math.max(invariants.length + unexplained.length, 1)),
            evidence: Math.min(left.metrics.evidence, right.metrics.evidence),
            editCost: additions.length + unexplained.length,
            constraintFit: round(preconditions.filter((item) => item.satisfied).length / Math.max(preconditions.length, 1)),
          },
          provenance: { composedFrom: [left.id, right.id] },
        };
        candidate.invocations = affordanceInvocations(candidate.affordance);
        candidate.neuralScore = round(this.score(candidate));
        composites.push(candidate);
      }
    }
    return composites.sort((left, right) => right.neuralScore - left.neuralScore).slice(0, 12);
  }

  react({ graph, context = {}, limit = 40 }: { graph: unknown; context?: Record<string, unknown>; limit?: number }): Reaction {
    assertGraph(graph);
    assertBoundedValue({ graph, context });
    if (!record(context)) throw new TypeError('Reaction context must be an object.');
    if (!Number.isInteger(limit) || limit < 1 || limit > MAX_VIEWS + 12) throw new RangeError('Invalid reaction candidate limit.');
    const budget = { remaining: MAX_SEARCH_STEPS };
    const atomic = this.enumerate(graph, budget);
    const candidates = [...atomic, ...this.compose(atomic, budget)]
      .sort((left, right) => right.neuralScore - left.neuralScore).slice(0, limit);
    const frontier = candidates.filter((candidate, index, all) =>
      !all.some((other, otherIndex) => otherIndex !== index && dominates(other, candidate)));
    const reaction: Reaction = {
      id: `reaction:${randomUUID()}`,
      createdAt: new Date().toISOString(),
      input: { graph: clone(graph), context: clone(context) },
      search: {
        holonsExamined: this.holons.size,
        viewsExamined: [...this.holons.values()].reduce((sum, holon) => sum + (holon.views?.length || 0), 0),
        candidatesGenerated: candidates.length,
      },
      frontier: clone(frontier), options: clone(candidates),
    };
    this.reactions.set(reaction.id, reaction);
    return clone(reaction);
  }

  resolve({ reactionId, policy = 'verified-minimal-edit' }: { reactionId: string; policy?: string }): Resolution {
    if (policy !== 'verified-minimal-edit' && policy !== 'evidence-first' && policy !== 'neural-rank') {
      throw new Error(`Unknown resolution policy: ${policy}`);
    }
    const reaction = this.reactions.get(reactionId);
    if (!reaction) throw new Error(`Unknown reaction: ${reactionId}`);
    const eligible = reaction.frontier.filter((candidate) =>
      candidate.valence !== 'avoid' && candidate.preconditions.every((item) => item.satisfied));
    const blocked = reaction.frontier.filter((candidate) =>
      candidate.valence !== 'avoid' && candidate.preconditions.some((item) => !item.satisfied));
    if (policy === 'verified-minimal-edit') eligible.sort((a, b) => a.metrics.editCost - b.metrics.editCost || b.neuralScore - a.neuralScore);
    else if (policy === 'evidence-first') eligible.sort((a, b) => b.metrics.evidence - a.metrics.evidence || b.neuralScore - a.neuralScore);
    else eligible.sort((a, b) => b.neuralScore - a.neuralScore);
    if (!eligible.length) return clone({
      reactionId, policy, disposition: blocked.length ? 'ask' : 'abstain', selected: null,
      missing: blocked.flatMap((candidate) => candidate.preconditions.filter((item) => !item.satisfied)),
    });
    const selected = eligible[0]!;
    const execution = selected.invocations[0] || null;
    return clone({
      reactionId, policy, disposition: execution ? 'invoke' : 'plan',
      selected: { ...selected, execution },
      retainedAlternatives: reaction.frontier.filter((candidate) => candidate.id !== selected.id),
      antiPatterns: reaction.options.filter((candidate) => candidate.valence === 'avoid'),
    });
  }
}
