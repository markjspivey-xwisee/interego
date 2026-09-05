/** L3, offline preview of the existing signed-domain/v1 interpreter. */
import {
  canonicalJson, prepareApplicationAction, sha256Hex,
  type ApplicationAction, type ApplicationState, type Json,
  type ResolvedApplicationLab, type VerifiedApplicationEvidence,
} from '../../deploy/mcp-relay/application-lab-runtime.js';

export interface SimulationSample {
  readonly actionIri: string;
  readonly payload: Record<string, Json>;
  readonly evidence?: readonly VerifiedApplicationEvidence[];
}

export interface SimulationInput {
  readonly actor: string;
  readonly now: string;
  readonly expectedHead: string;
  /** Additional, non-exhaustive payloads. Evidence must already come from the verifier. */
  readonly samples?: readonly SimulationSample[];
  /** Refuse the entire request on overflow; never return a silently truncated frontier. */
  readonly maxCandidates?: number;
}

export type StateChange =
  | { readonly path: string; readonly op: 'add'; readonly after: Json }
  | { readonly path: string; readonly op: 'remove'; readonly before: Json }
  | { readonly path: string; readonly op: 'replace'; readonly before: Json; readonly after: Json };

type Candidate = { readonly id: string; readonly actionIri: string; readonly payload: Record<string, Json> };
export type SimulationAlternative = Candidate & (
  | { readonly status: 'simulated'; readonly successor: ApplicationState; readonly stateDigest: string;
      readonly receiptDigest: string; readonly changes: readonly StateChange[]; readonly changeCount: number }
  | { readonly status: 'refused'; readonly reason: string }
  | { readonly status: 'needs-input'; readonly inputs: readonly string[]; readonly reason: string }
);

export interface SimulationFrontier {
  readonly kind: 'application-simulation';
  readonly basis: {
    readonly applicationId: string;
    readonly catalogDescriptorUrl: string;
    readonly catalogDigest: string;
    readonly contractDescriptorUrl: string;
    readonly contractDigest: string;
    readonly stateDescriptorUrl: string;
    readonly stateHead: string;
    readonly stateDigest: string;
    readonly actor: string;
    readonly at: string;
  };
  readonly coverage: readonly { readonly actionIri: string; readonly inputSpace: 'finite' | 'open'; readonly suppliedSamples: number }[];
  readonly alternatives: readonly SimulationAlternative[];
}

const compare = (a: string, b: string) => a < b ? -1 : a > b ? 1 : 0;
const clone = <T>(value: T): T => JSON.parse(canonicalJson(value)) as T;
const unique = <T>(values: readonly T[]): T[] => [...new Map(values.map(v => [canonicalJson(v), v])).entries()]
  .sort(([a], [b]) => compare(a, b)).map(([, v]) => v);

/** Objects recurse; arrays are one replacement, so count measures changed JSON locations. */
function changes(before: Json, after: Json, path = ''): StateChange[] {
  if (canonicalJson(before) === canonicalJson(after)) return [];
  if (before !== null && after !== null && typeof before === 'object' && typeof after === 'object'
      && !Array.isArray(before) && !Array.isArray(after)) {
    return [...new Set([...Object.keys(before), ...Object.keys(after)])].sort(compare).flatMap(key => {
      const at = `${path}/${key.replace(/~/g, '~0').replace(/\//g, '~1')}`;
      if (!Object.hasOwn(before, key)) return [{ op: 'add', path: at, after: after[key]! }];
      if (!Object.hasOwn(after, key)) return [{ op: 'remove', path: at, before: before[key]! }];
      return changes(before[key]!, after[key]!, at);
    });
  }
  return [{ op: 'replace', path, before, after }];
}

function enumerate(action: ApplicationAction, budget: number): { payloads: Record<string, Json>[]; open: string[] } {
  let payloads: Record<string, Json>[] = [{}];
  const open: string[] = [];
  const names = new Set<string>();
  for (const input of [...(action.inputs ?? [])].sort((a, b) => compare(a.name, b.name))) {
    if (names.has(input.name)) throw new Error(`duplicate input declaration: ${input.name}`);
    names.add(input.name);
    const declaredOptions = input.options ?? (input.type === 'boolean' ? [false, true] : undefined);
    if (!declaredOptions) {
      open.push(input.name);
      if (input.required) payloads = [];
      else {
        if (payloads.length * 2 > budget) throw new Error(`simulation candidate budget exceeded: ${budget}`);
        payloads = payloads.flatMap(payload => [payload, { ...payload, [input.name]: null }]);
      }
      continue;
    }
    // Optional null is accepted before options validation by the executor.
    const options = unique([...declaredOptions, ...(input.required ? [] : [null])]);
    if (payloads.length * (options.length + (input.required ? 0 : 1)) > budget) {
      throw new Error(`simulation candidate budget exceeded: ${budget}`);
    }
    payloads = payloads.flatMap(payload => [
      ...(input.required ? [] : [payload]),
      ...options.map(value => ({ ...payload, [input.name]: value })),
    ]);
  }
  return { payloads: unique(payloads), open };
}

/**
 * Takes an already resolved snapshot, fixed time/actor/head, and no read or write capability.
 * Every concrete candidate calls the executor's prepare function. No domain dispatch here.
 * Resolve again before executing a selected action; this result grants no authority to write.
 */
export function simulateApplication(resolved: ResolvedApplicationLab, input: SimulationInput): SimulationFrontier {
  if (!input.actor || !input.now || !Number.isFinite(Date.parse(input.now)) || !input.expectedHead) {
    throw new Error('simulation requires an actor, explicit timestamp, and expected head');
  }
  if (!resolved.catalogCurrent) throw new Error('simulation requires the current authoritative catalog');
  if (!resolved.replay.complete) throw new Error('simulation requires complete verified replay');
  if (input.expectedHead !== resolved.stateHead.cid) throw new Error('stale application head for simulation');
  const budget = input.maxCandidates ?? 256;
  if (!Number.isSafeInteger(budget) || budget < 1) throw new Error('maxCandidates must be a positive safe integer');
  const actions = [...resolved.activeContract.actions].sort((a, b) => compare(a.actionIri, b.actionIri));
  const actionIds = new Set(actions.map(a => a.actionIri));
  if (actionIds.size !== actions.length) throw new Error('duplicate action IRI in active contract');
  for (const sample of input.samples ?? []) {
    if (!actionIds.has(sample.actionIri)) throw new Error(`sample action is absent from active contract: ${sample.actionIri}`);
  }
  const alternatives: SimulationAlternative[] = [];
  const coverage: SimulationFrontier['coverage'][number][] = [];
  const append = (alternative: SimulationAlternative) => {
    if (alternatives.length >= budget) throw new Error(`simulation candidate budget exceeded: ${budget}`);
    alternatives.push(alternative);
  };
  for (const action of actions) {
    const { payloads, open } = enumerate(action, budget);
    const samples = (input.samples ?? []).filter(s => s.actionIri === action.actionIri);
    coverage.push({ actionIri: action.actionIri, inputSpace: open.length ? 'open' : 'finite', suppliedSamples: samples.length });
    if (open.length) {
      append({ id: sha256Hex(canonicalJson({ actionIri: action.actionIri, open })), actionIri: action.actionIri,
        payload: {}, status: 'needs-input', inputs: open, reason: 'Input space is open; supplied samples do not establish completeness.' });
    }
    // Keep verifier-branded evidence intact until prepare; clone only JSON payloads/results.
    const candidates = unique([
      ...payloads.map(payload => ({ payload, evidence: [] as readonly VerifiedApplicationEvidence[] })),
      ...samples.map(s => ({ payload: clone(s.payload), evidence: s.evidence ?? [] })),
    ]);
    if (alternatives.length + candidates.length > budget) throw new Error(`simulation candidate budget exceeded: ${budget}`);
    for (const candidate of candidates) {
      const base = { id: sha256Hex(canonicalJson({ actionIri: action.actionIri, ...candidate })),
        actionIri: action.actionIri, payload: candidate.payload };
      try {
        const prepared = prepareApplicationAction(resolved, { ...input, ...candidate, actionIri: action.actionIri });
        const diff = changes(resolved.state.data, prepared.successor.data);
        append({ ...base, status: 'simulated', successor: prepared.successor,
          stateDigest: sha256Hex(canonicalJson(prepared.successor)), receiptDigest: prepared.receiptDigest,
          changes: diff, changeCount: diff.length });
      } catch (error) {
        append({ ...base, status: 'refused', reason: error instanceof Error ? error.message : String(error) });
      }
    }
  }
  return clone({ kind: 'application-simulation', basis: {
    applicationId: resolved.state.applicationId, catalogDescriptorUrl: resolved.catalogDescriptor.url,
    catalogDigest: resolved.catalogEnvelope.declaredDigest, contractDescriptorUrl: resolved.activeContractDescriptor.url,
    contractDigest: resolved.activeContractEnvelope.declaredDigest, stateDescriptorUrl: resolved.stateHead.descriptorUrl,
    stateHead: resolved.stateHead.cid, stateDigest: resolved.stateEnvelope.declaredDigest, actor: input.actor, at: input.now,
  }, coverage, alternatives });
}
