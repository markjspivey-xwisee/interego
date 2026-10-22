/**
 * The work-redesign bridge's handlers: one per affordance in ../affordances.ts.
 *
 * Every write follows the same order, so each refusal isolates one rule: (1) resolve the pod
 * (400) → (2) open the signed envelope: shape, intent, pod binding, signature, freshness
 * (400/401) → (3) claim its nonce (409 on replay) → (4) load what the call needs, refusing a
 * forked or altered head (409) → (5) existence (404) → (6) who the recovered signer is and what
 * they may do (403) → (7) lifecycle state and the head the signer bound (409/422) → (8) the
 * engines in ../src (400/409) → (9) publish (409 stale, 500 shape, 502 transport).
 *
 * Identity is only ever the address recovered from an envelope's signature. Roles, the person
 * an admin attests is behind each key, agents' principals and declared models all come from
 * the pod's role registry, whose every change an admin signed. Separation of duties compares
 * those person references, never keys, and never anything a caller typed.
 *
 * Every refusal is a typed `refuse()` with an HTTP status; every success carries an outcome
 * flag. No environment reads: bridge/server.ts composes this with its configuration.
 */
import { randomBytes } from 'node:crypto';
import { canonicalJson, sha256Hex, createWallet, signMessageRaw, type FetchFn, type ManifestEntry, type Wallet } from '@interego/core';
import { fetchAllManifestEntries, predictManifestUrl, PublishShapeViolationError } from '@interego/solid';
import { refuse, type BridgeRefusal } from '../../_shared/vertical-bridge/refusal.js';
import {
  readPublishedPolicy, effectivePolicy, coercePodPolicy, podPolicyLoosens, isOneOf,
  WRD_ONTOLOGY_IRI, REGIME_SOURCE, REGISTRY_ROLES, COMPARISON_BASES, OUTCOME_METRICS, INPUT_BASES, FREED_HOURS_DISPOSITIONS,
  OUTCOME_DISPOSITIONS, PROBE_SIGNALS,
  type AllocationLevel, type ComparisonBasis, type EffectivePolicy, type OutcomeMetric, type PodPolicy, type RegistryRole,
} from '../src/ontology.js';
import {
  CLASSIFICATION_QUESTIONS, classifyTask, coerceAnswers, checkParties, checkAllocation, coerceChange, planKindOf, performerOf,
  namedPartiesOf, verifyTaskQuotes, quoteStatusOf, coerceCapture, coerceRevision, applyTaskChanges, taskTextSha256,
  buildTaskMapPacket, TASK_KIND_SLUG, LIMITS,
  type Allocation, type AllocationChange, type CaptureTask, type ClassificationAnswers, type GrantState, type QuoteVerdict,
  type TaskForAllocation,
} from '../src/work.js';
import {
  coerceValuationInputs, valuePlan, checkOutcomeWindow, gradeOutcome, calibrationReport, evaluateGrant,
  DRAWS, DEMO_LABEL, DISTINCT_PEOPLE_NOTE, NOMINAL_BAND_COVERAGE, NO_COMPARISON_GROUP, RUN_ALTERNATIVES,
  type DecisionForCalibration, type GrantEvaluation, type ProbeOutcome, type ReviewedRun, type RunAnswer, type ValuationResult,
} from '../src/valuation.js';
import {
  openEnvelope, verifyStoredEnvelope, NonceLedger, envelopeSha256, didOf, isAddress, isIsoInstant, entityIri, scopePrefix, graphIriOf, recordIdFor,
  normalisePodUrl, DEFAULT_ENVELOPE_WINDOW,
  type DecisionPayload, type DescriptorSpec, type EntityKind, type EnvelopeIntent, type ExpertEvidenceBasis, type MeasuredValue,
  type MeasurementPlan, type PartyVerdict, type PlanTaskRow, type PlatformRef, type PolicyRef, type RecordKind, type RecordOf,
  type RecordSigner, type RegistryMember, type RegistryTaskKind, type SignedEnvelope, type TaskPayload, type WrdRecord,
} from '../src/records.js';
import {
  PodView, publishRecord, copyRecordToHolder, openPod, modalFor, KeyedMutex, StaleHeadError, PodWriteError, PodReadError,
  IncompleteManifestError,
  type GraphHeads, type LoadedRecord, type PlatformSigner, type VerifyCache,
} from './pod-helpers.js';

export type { PlatformSigner };

export interface DemoPersona { readonly id: string; readonly label: string; readonly wallet: Wallet }

export interface WrdDeps {
  /** Pod transport; tests and the demo inject an in-memory pod. Never patch globalThis.fetch. */
  readonly fetchFn?: FetchFn;
  readonly defaultPodUrl?: string;
  /** Determinism. */
  readonly now?: () => Date;
  /** Absent → a key is generated once, and every record discloses keyKind 'ephemeral'. */
  readonly platform?: PlatformSigner;
  /** Further platform signers whose records are trusted (key rotation). */
  readonly trustedPlatformAddresses?: readonly string[];
  /** May sign wrd:update-registry. */
  readonly adminAddresses?: readonly string[];
  /** ONLY the offline demo sets this: adds the wrd.demo_envelope handler and marks every record demo. */
  readonly demoPersonas?: ReadonlyMap<string, DemoPersona>;
  /** Default 15 minutes back, 2 minutes ahead. */
  readonly envelopeWindow?: { readonly pastMs: number; readonly futureMs: number };
  /** Monte Carlo draws; default DRAWS (5000), recorded on every valuation. */
  readonly draws?: number;
}

export type WrdHandler = (args: Record<string, unknown>) => Promise<unknown>;

// ── Prose, kept out of return literals ───────────────────────────────────────────────────

const READ_EXPOSURE = 'Anyone who can reach this bridge can read every record on this pod.';
const NEXT_RECLASSIFY = 'Re-classify this task, then propose a plan.';
const CONTRARY_NOTE = 'Reviewed runs on this task disagree with its classification often enough to look again; nothing changes until someone re-classifies it.';
const UNACKNOWLEDGED = 'named by the operator, not acknowledged';
const ACKNOWLEDGED = 'acknowledged by the person named';
const OBJECTED = 'objected to by the person named';
const NOT_DECLARED = 'not declared';
const INTEGRITY = 'A record this call depends on was altered after signing, or more than one version claims to be current.';
const BAD_PAYLOAD = 'The envelope payload is malformed.';
const REPLAYED = 'This envelope was already used.';
const NOT_FOUND_TASK = 'No such task on this pod.';
const RETIRED = 'This task was retired.';
const TASK_MOVED = 'The task changed since you read it.';
const DECISION_MOVED = 'The decision changed since you read it.';
const STALE_PLAN = 'A task was re-classified or revised after this plan was proposed; propose again.';
const RETIRED_IN_PLAN = 'A task in this plan was retired; propose again.';
const CLOCK_SKEW = 'The clock reads earlier than the start of what is being withdrawn; retry.';
const UNKNOWN_KIND = 'This task kind is not registered, or was retired.';
const KIND_FIX = 'an admin declares task kinds in the registry';

const STATUS_LABEL: Readonly<Record<string, string>> = {
  submitted: 'submitted; not yet countersigned',
  'countersigned:valued': 'approved; prediction unmeasured',
  'countersigned:probe': 'approved; probes not yet read',
  'declined:valued': 'declined; the prediction will not be measured',
  'declined:probe': 'declined; the probes will not run',
  'measured:valued': 'measured',
  'measured:probe': 'probes read',
};
const statusLabelOf = (status: string, kind: 'valued' | 'probe'): string => STATUS_LABEL[`${status}:${kind}`] ?? STATUS_LABEL[status] ?? status;

// ── Small helpers ────────────────────────────────────────────────────────────────────────

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v);
const messageOf = (e: unknown): string => (e instanceof Error ? e.message : String(e));
const lower = (a: string): string => a.toLowerCase();

/** A refusal raised from a helper; the handler wrapper returns it as the answer. */
class Declined extends Error {
  constructor(readonly refusal: BridgeRefusal) { super(refusal.error); }
}
const decline = (status: number, error: string, why: string, resolvedBy?: Record<string, unknown>): Declined =>
  new Declined(refuse(status, error, why, resolvedBy));
/** The affordance that resolves a refusal. */
const via = (tool: string): Record<string, unknown> => ({ action: `urn:iep:action:wrd:${tool.replace(/_/g, '-')}`, toolName: `wrd.${tool}` });
const viaToolName = (toolName: string): Record<string, unknown> => via(toolName.replace(/^wrd\./, ''));

function need(p: Obj, key: string, max: number, path = 'payload'): string {
  const v = p[key];
  if (typeof v !== 'string' || v.trim() === '') throw decline(400, BAD_PAYLOAD, `${path}.${key} is required text`);
  if (v.length > max) throw decline(400, BAD_PAYLOAD, `${path}.${key} is longer than ${max} characters`);
  return v;
}
function maybe(p: Obj, key: string, max: number, path = 'payload'): string | undefined {
  return p[key] === undefined ? undefined : need(p, key, max, path);
}
function needIri(p: Obj, key: string): string {
  const v = p[key];
  if (typeof v !== 'string' || !/^urn:wrd:[a-z-]+:[0-9a-f]{16}:[0-9a-f]{16}$/.test(v)) throw decline(400, BAD_PAYLOAD, `payload.${key} must be a wrd entity IRI`);
  return v;
}
const GRAPH_DIGEST = /^graph-nquads-sha256:[0-9a-f]{64}$/;
function needBinding(p: Obj): { readonly descriptorUrl: string; readonly graphDigest: string } {
  const d = p['descriptorUrl'];
  const g = p['graphDigest'];
  if (typeof d !== 'string' || !/^https?:\/\//.test(d)) throw decline(400, BAD_PAYLOAD, 'payload.descriptorUrl must be the http(s) URL of the head you read');
  if (typeof g !== 'string' || !GRAPH_DIGEST.test(g)) throw decline(400, BAD_PAYLOAD, 'payload.graphDigest must be graph-nquads-sha256:<64 hex> of the head you read');
  return { descriptorUrl: d, graphDigest: g };
}

const ENTITY_KIND: Readonly<Record<RecordKind, EntityKind>> = {
  RoleRegistry: 'registry', Workflow: 'workflow', Task: 'task', Classification: 'classification', Plan: 'plan', Valuation: 'valuation',
  Decision: 'decision', Acknowledgement: 'acknowledgement', AgentRun: 'run', Grant: 'grant', HolderCopy: 'holder-copy',
};

interface Head<K extends RecordKind> { readonly loaded: LoadedRecord; readonly record: RecordOf<K>; readonly graph: GraphHeads }

/** The current version of a graph as a record of `kind`, null when the graph is absent; 409 when forked or altered. */
function headIn<K extends RecordKind>(g: GraphHeads, kind: K): Head<K> | null {
  if (g.state === 'absent') return null;
  if (g.state !== 'ok') {
    throw decline(409, INTEGRITY, `${g.graphIri}: ${g.state === 'forked' ? 'more than one version claims to be current' : 'its current version was altered after signing'}`);
  }
  const loaded = g.heads[0];
  if (!loaded || !loaded.record || loaded.record.recordKind !== kind) throw decline(409, INTEGRITY, `${g.graphIri} does not hold a ${kind} record`);
  return { loaded, record: loaded.record as RecordOf<K>, graph: g };
}

interface Registry {
  readonly entity: string;
  readonly head: Head<'RoleRegistry'> | null;
  readonly graph: GraphHeads;
  readonly members: ReadonlyMap<string, RegistryMember>;
  readonly kinds: ReadonlyMap<string, RegistryTaskKind>;
  readonly podPolicy: PodPolicy | null;
  readonly policy: EffectivePolicy;
}
const memberOf = (reg: Registry, a: string | undefined): RegistryMember | undefined => (a ? reg.members.get(lower(a)) : undefined);
const isPerson = (reg: Registry, a: string | undefined): boolean => { const m = memberOf(reg, a); return !!m && !m.softwareAgent; };
const isAgent = (reg: Registry, a: string | undefined): boolean => { const m = memberOf(reg, a); return !!m && m.softwareAgent && m.roles.includes('agent'); };
const holds = (reg: Registry, a: string, role: RegistryRole): boolean => {
  const m = memberOf(reg, a);
  return !!m && m.roles.includes(role) && (role === 'agent' ? m.softwareAgent : !m.softwareAgent);
};
/** The person an admin attests is behind a key; an unregistered key is only ever its own person. */
const personRefOf = (reg: Registry, a: string): string => memberOf(reg, a)?.personRef ?? `address:${lower(a)}`;
const kindUsable = (reg: Registry, slug: string): RegistryTaskKind | null => {
  const k = reg.kinds.get(slug);
  return k && !k.retired ? k : null;
};

function signerOf(reg: Registry, address: string, facetRole: 'Curator' | 'Validator', acted: string): RecordSigner {
  const a = lower(address);
  const m = reg.members.get(a);
  return { did: didOf(a), address: a, personRef: m && !m.softwareAgent ? m.personRef : null, softwareAgent: m?.softwareAgent ?? false, facetRole, acted };
}

function verdictStatus(parties: readonly string[], verdicts: ReadonlyArray<{ readonly party: string; readonly verdict: string }>): 'open' | 'ratified' | 'disputed' {
  if (verdicts.some((v) => v.verdict === 'dispute')) return 'disputed';
  if (parties.length > 0 && parties.every((p) => verdicts.some((v) => v.party === p && v.verdict === 'ratify'))) return 'ratified';
  return 'open';
}

function taskSigners(reg: Registry, payload: TaskPayload, author: { readonly address: string; readonly acted: string; readonly role: 'Curator' | 'Validator' }): RecordSigner[] {
  const out = [signerOf(reg, author.address, author.role, author.acted)];
  for (const r of payload.ratifications) out.push(signerOf(reg, r.party, 'Validator', r.verdict === 'ratify' ? 'ratified the description' : 'disputed the description'));
  return out;
}

const dedupeSigners = (signers: readonly RecordSigner[]): RecordSigner[] => {
  const seen = new Set<string>();
  return signers.filter((s) => (seen.has(s.did) ? false : (seen.add(s.did), true)));
};

const taskLink = (taskIri: string): string => `/ui#task=${encodeURIComponent(taskIri)}`;

const captureTaskOf = (p: TaskPayload): CaptureTask => ({
  name: p.name, description: p.description, current: p.current, taskKind: p.taskKind,
  ...(p.externalTaskTerm ? { externalTaskTerm: p.externalTaskTerm } : {}),
  ...(p.quotes.length > 0 ? { sourceQuotes: p.quotes.map((q) => q.quote) } : {}),
});

function coerceProbabilities(v: unknown): Readonly<Record<string, number>> | null | undefined {
  if (v === undefined) return undefined;
  if (!isObj(v)) return null;
  let sum = 0;
  for (const [k, n] of Object.entries(v)) {
    if (!(RUN_ALTERNATIVES as readonly string[]).includes(k) || typeof n !== 'number' || !Number.isFinite(n) || n < 0 || n > 1) return null;
    sum += n;
  }
  return sum > 0 ? (v as Record<string, number>) : null;
}

// ── The handlers ─────────────────────────────────────────────────────────────────────────

export function createWrdHandlers(deps: WrdDeps = {}): Record<string, WrdHandler> {
  const published = readPublishedPolicy();
  const window = deps.envelopeWindow ?? DEFAULT_ENVELOPE_WINDOW;
  const ledger = new NonceLedger(window.pastMs + window.futureMs);
  const mutex = new KeyedMutex();
  const verifyCache: VerifyCache = new Map();
  const admins = new Set((deps.adminAddresses ?? []).map(lower));
  const demo = deps.demoPersonas && deps.demoPersonas.size > 0 ? deps.demoPersonas : null;
  const draws = deps.draws ?? DRAWS;
  const clock = (): Date => (deps.now ? deps.now() : new Date());

  let platformP: Promise<PlatformSigner> | null = null;
  const platform = (): Promise<PlatformSigner> => {
    platformP ??= deps.platform
      ? Promise.resolve(deps.platform)
      : createWallet('agent', 'wrd-platform').then((wallet): PlatformSigner => ({ wallet, keyKind: 'ephemeral' }));
    return platformP;
  };

  interface Call {
    readonly podUrl: string; readonly fetchFn: FetchFn; readonly now: Date; readonly at: string; readonly view: PodView;
    readonly platform: PlatformSigner; readonly platformRef: PlatformRef; readonly trusted: ReadonlySet<string>;
  }
  interface Signed extends Call {
    readonly actor: string; readonly actorDid: string; readonly payload: Obj; readonly envelope: SignedEnvelope; readonly nonce: string;
  }

  const envelopePod = (raw: unknown): string | undefined => {
    if (!isObj(raw)) return undefined;
    const p = raw['payload'];
    return isObj(p) && typeof p['podUrl'] === 'string' ? p['podUrl'] : undefined;
  };

  async function openCall(args: Obj, rawEnvelope: unknown, strict: boolean): Promise<Call> {
    const fromArgs = typeof args['pod_url'] === 'string' && args['pod_url'].trim() !== '' ? args['pod_url'] : undefined;
    const raw = fromArgs ?? envelopePod(rawEnvelope) ?? deps.defaultPodUrl;
    if (!raw) throw decline(400, 'No pod to read or write.', 'pass pod_url, set payload.podUrl, or configure the bridge with a default pod');
    let podUrl: string;
    try { podUrl = normalisePodUrl(raw); } catch (e) { throw decline(400, 'The pod URL is not an http(s) URL.', messageOf(e)); }
    let fetchFn: FetchFn;
    try { fetchFn = await openPod(podUrl, deps.fetchFn); } catch (e) { throw decline(400, 'The pod URL is not a safe target.', messageOf(e)); }
    const p = await platform();
    const now = clock();
    const trusted = new Set([lower(p.wallet.address), ...(deps.trustedPlatformAddresses ?? []).map(lower)]);
    return {
      podUrl, fetchFn, now, at: now.toISOString(), view: new PodView(podUrl, fetchFn, trusted, verifyCache, strict), platform: p,
      platformRef: { did: didOf(p.wallet.address), address: lower(p.wallet.address), keyKind: p.keyKind }, trusted,
    };
  }

  async function openSigned(args: Obj, intent: EnvelopeIntent, key = 'envelope'): Promise<Signed> {
    const raw = args[key];
    const call = await openCall(args, raw, true);
    const opened = openEnvelope(raw, intent, call.podUrl, call.now, window);
    if (!opened.ok) throw new Declined(refuse(opened.status, opened.error, opened.why));
    const nonce = String(opened.payload['nonce']);
    if (!ledger.claim(opened.signer, nonce, call.now)) throw decline(409, REPLAYED, `${opened.signer} already used the nonce ${nonce} on this bridge`);
    return { ...call, actor: opened.signer, actorDid: opened.did, payload: opened.payload, envelope: opened.envelope, nonce };
  }

  async function headOf<K extends RecordKind>(call: Call, entity: string, kind: K): Promise<Head<K> | null> {
    return headIn(await call.view.graph(graphIriOf(entity)), kind);
  }

  async function registryOf(call: Call): Promise<Registry> {
    const entity = entityIri('registry', call.podUrl, 'registry');
    const graph = await call.view.graph(graphIriOf(entity));
    const head = headIn(graph, 'RoleRegistry');
    const members = new Map((head?.record.payload.members ?? []).map((m) => [m.address, m]));
    const kinds = new Map((head?.record.payload.taskKinds ?? []).map((k) => [k.slug, k]));
    const podPolicy = head?.record.payload.podPolicy ?? null;
    let policy: EffectivePolicy;
    try { policy = effectivePolicy(published, podPolicy, head?.loaded.descriptorUrl ?? null); } catch (e) { throw decline(409, INTEGRITY, messageOf(e)); }
    return { entity, head, graph, members, kinds, podPolicy, policy };
  }

  const policyRefOf = (reg: Registry): PolicyRef => ({ ontologyIri: WRD_ONTOLOGY_IRI, ontologySha256: published.ontologySha256, podPolicyHead: reg.policy.podPolicyHead });

  interface Written { readonly descriptorUrl: string; readonly graphUrl: string; readonly recordId: string; readonly graphDigest: string }

  /** Publish one version of `entity`: superseding `head` when given, else starting the graph. */
  async function write<K extends RecordKind>(call: Signed, w: {
    readonly kind: K; readonly entity: string; readonly status: RecordOf<K>['status']; readonly payload: RecordOf<K>['payload'];
    readonly signers: readonly RecordSigner[]; readonly head: Head<K> | null; readonly tag?: string;
    readonly validFrom?: string; readonly validUntil?: string; readonly confidence?: number; readonly derivedFrom?: readonly string[];
  }): Promise<Written> {
    const version = w.head ? w.head.record.version + 1 : 1;
    const graphIri = graphIriOf(w.entity);
    const recordId = recordIdFor(ENTITY_KIND[w.kind], graphIri, version, w.tag === undefined ? call.nonce : `${call.nonce}:${w.tag}`);
    const signers = dedupeSigners(w.signers);
    const record = {
      recordKind: w.kind, entityIri: w.entity, version, status: w.status, payload: w.payload, signers, platform: call.platformRef,
      ...(demo ? { demo: true as const } : {}),
    } as unknown as WrdRecord;
    const descriptor: DescriptorSpec = {
      recordId, graphIri, recordKind: w.kind, now: call.at, validFrom: w.validFrom ?? call.at,
      ...(w.validUntil ? { validUntil: w.validUntil } : {}),
      modal: modalFor(w.kind, w.status),
      ...(w.confidence !== undefined ? { confidence: w.confidence } : {}),
      ...(w.head ? { supersedes: w.head.loaded.descriptorUrl } : {}),
      platformDid: call.platformRef.did,
      signers: signers.map((s) => ({ did: s.did, softwareAgent: s.softwareAgent, role: s.facetRole })),
      derivedFrom: w.derivedFrom ?? [],
    };
    return publishRecord({ descriptor, record, expectHead: w.head?.loaded.descriptorUrl ?? null },
      { podUrl: call.podUrl, fetchFn: call.fetchFn, platform: call.platform, trusted: call.trusted, mutex, cache: verifyCache });
  }

  // ── Shared loads ───────────────────────────────────────────────────────────────────────

  function requireOperatorPerson(reg: Registry, actor: string): void {
    if (!holds(reg, actor, 'operator')) throw decline(403, 'Only a registered operator can do this.', `${actor} does not hold the operator role in this pod's registry`, via('update_registry'));
  }

  async function taskHead(call: Call, taskIri: string): Promise<Head<'Task'>> {
    const t = await headOf(call, taskIri, 'Task');
    if (!t) throw decline(404, NOT_FOUND_TASK, `${taskIri} has no record on ${call.podUrl}`);
    return t;
  }

  const classificationEntity = (workflowIri: string, taskIri: string): string => entityIri('classification', workflowIri, taskIri);

  interface WorkflowTask { readonly taskIri: string; readonly task: Head<'Task'>; readonly classification: Head<'Classification'> | null }
  async function workflowTasks(call: Call, wf: Head<'Workflow'>): Promise<WorkflowTask[]> {
    const out: WorkflowTask[] = [];
    for (const taskIri of wf.record.payload.taskIris) {
      const task = await headOf(call, taskIri, 'Task');
      if (!task) throw decline(409, INTEGRITY, `the workflow lists ${taskIri}, which has no trusted record`);
      out.push({ taskIri, task, classification: await headOf(call, classificationEntity(wf.record.entityIri, taskIri), 'Classification') });
    }
    return out;
  }

  /** The allocation each task actually has: from the newest measured, kept, valued decision that changed it, else as captured. */
  async function effectiveAllocations(call: Call, workflowIri: string): Promise<Map<string, { readonly allocation: Allocation; readonly decisionIri: string; readonly at: string }>> {
    const out = new Map<string, { allocation: Allocation; decisionIri: string; at: string }>();
    for (const g of await call.view.graphIris(scopePrefix('decision', workflowIri))) {
      const d = headIn(await call.view.graph(g), 'Decision');
      if (!d || d.record.status !== 'measured' || d.record.payload.decisionKind !== 'valued') continue;
      const outcome = d.record.payload.outcome;
      if (!outcome || outcome.disposition !== 'kept') continue;
      const plan = await headOf(call, d.record.payload.planIri, 'Plan');
      if (!plan) continue;
      for (const row of plan.record.payload.tasks) {
        if (!row.changed) continue;
        const prev = out.get(row.taskIri);
        if (!prev || prev.at < outcome.at) out.set(row.taskIri, { allocation: row.proposed, decisionIri: d.record.entityIri, at: outcome.at });
      }
    }
    return out;
  }

  const grantEntity = (call: Call, agent: string, taskKind: string): string => entityIri('grant', lower(agent), `${call.podUrl}|${taskKind}`);

  type GrantInfo = GrantState & { readonly grantIri: string; readonly evaluation: GrantEvaluation | null };
  /** Whether a grant is usable right now. Checked on every use: revocation, the agent's registration and declared model, the principal, the task kind. */
  async function grantState(call: Call, reg: Registry, agent: string, taskKind: string): Promise<GrantInfo> {
    const entity = grantEntity(call, agent, taskKind);
    const g = await call.view.graph(graphIriOf(entity));
    const inactive = (why: string, evaluation: GrantEvaluation | null = null): GrantInfo => ({ active: false, why, grantIri: entity, evaluation });
    if (g.state === 'absent') return inactive(g.untrusted.length > 0 ? "grant record not signed by this bridge's key" : 'no grant');
    if (g.state !== 'ok') return inactive('the grant record was altered after signing, or more than one version claims to be current');
    const head = g.heads[0];
    const rec = head?.record;
    if (!head || !rec || rec.recordKind !== 'Grant') return inactive('the grant graph holds no grant record');
    const p = rec.payload;
    if (rec.status === 'revoked') return inactive(`revoked at ${p.revocation?.at ?? head.validUntil ?? 'an unknown time'}`, p.evaluation);
    if (head.modalStatus !== 'Asserted') return inactive('the grant is not asserted', p.evaluation);
    if (head.validUntil && Date.parse(head.validUntil) <= call.now.getTime()) return inactive(`expired at ${head.validUntil}`, p.evaluation);
    if (!isAgent(reg, agent)) return inactive('agent no longer registered', p.evaluation);
    const declared = memberOf(reg, agent)?.model ?? null;
    if (declared !== p.model) return inactive(`the agent's declared model changed since the grant (was ${p.model}, now ${declared ?? 'none'})`, p.evaluation);
    if (!isPerson(reg, p.principal)) return inactive("the agent's accountable principal is no longer registered", p.evaluation);
    if (!kindUsable(reg, taskKind)) return inactive('this kind of task is no longer registered', p.evaluation);
    return {
      active: true, grantIri: entity, evaluation: p.evaluation,
      evidenceTaskIris: p.evaluation.taskIris, runsCounted: p.evaluation.samples, criticalFailures: p.evaluation.criticalFailures,
    };
  }

  interface PlanState {
    readonly plan: Head<'Plan'>;
    readonly workflow: Head<'Workflow'>;
    readonly tasks: ReadonlyMap<string, Head<'Task'> | null>;
    readonly classifications: ReadonlyMap<string, Head<'Classification'> | null>;
  }
  async function planState(call: Call, plan: Head<'Plan'>): Promise<PlanState> {
    const workflowIri = plan.record.payload.workflowIri;
    const workflow = await headOf(call, workflowIri, 'Workflow');
    if (!workflow) throw decline(409, INTEGRITY, `the plan's workflow ${workflowIri} has no trusted record`);
    const tasks = new Map<string, Head<'Task'> | null>();
    const classifications = new Map<string, Head<'Classification'> | null>();
    for (const row of plan.record.payload.tasks) {
      tasks.set(row.taskIri, await headOf(call, row.taskIri, 'Task'));
      classifications.set(row.taskIri, await headOf(call, classificationEntity(workflowIri, row.taskIri), 'Classification'));
    }
    return { plan, workflow, tasks, classifications };
  }

  /** Why a plan no longer describes the tasks it was proposed against, or null. */
  function staleness(ps: PlanState): string | null {
    const p = ps.plan.record.payload;
    for (const row of p.tasks) {
      if (row.changed && !ps.workflow.record.payload.taskIris.includes(row.taskIri)) return RETIRED_IN_PLAN;
    }
    for (const row of p.tasks) {
      const t = ps.tasks.get(row.taskIri);
      const c = ps.classifications.get(row.taskIri);
      if (!t || t.record.payload.textSha256 !== p.taskTextSha256[row.taskIri]) return STALE_PLAN;
      if (!c || c.loaded.descriptorUrl !== p.classificationHeads[row.taskIri]) return STALE_PLAN;
    }
    return null;
  }

  async function grantChecksFor(call: Call, reg: Registry, rows: readonly PlanTaskRow[]): Promise<Array<{ taskIri: string; grantIri: string; active: boolean; evidenceFromThisTask: boolean; why: string | null }>> {
    const out: Array<{ taskIri: string; grantIri: string; active: boolean; evidenceFromThisTask: boolean; why: string | null }> = [];
    for (const row of rows) {
      if (!row.changed || row.proposed.level !== 'agent-acts-within-grant' || !row.proposed.agentAddress) continue;
      const g = await grantState(call, reg, row.proposed.agentAddress, row.taskKind);
      out.push({
        taskIri: row.taskIri, grantIri: g.grantIri, active: g.active,
        evidenceFromThisTask: g.active ? g.evidenceTaskIris.includes(row.taskIri) : false, why: g.active ? null : g.why,
      });
    }
    return out;
  }

  const ackEntity = (planIri: string, taskIri: string, person: string): string => entityIri('acknowledgement', planIri, `${taskIri}|${lower(person)}`);
  async function assignmentStates(call: Call, plan: Head<'Plan'>): Promise<DecisionPayload['assignments']> {
    const out: Array<DecisionPayload['assignments'][number]> = [];
    for (const row of plan.record.payload.tasks) {
      const person = row.proposed.personAddress;
      if (!row.changed || !person) continue;
      const ack = await headOf(call, ackEntity(plan.record.entityIri, row.taskIri, person), 'Acknowledgement');
      const state = ack ? (ack.record.status === 'objected' ? 'objected' : 'acknowledged') : 'not-acknowledged';
      out.push({ taskIri: row.taskIri, personAddress: person, state, ...(ack?.record.payload.note ? { note: ack.record.payload.note } : {}) });
    }
    return out;
  }

  /** Mean cost per run, by task kind, of every logged run on the pod that recorded a cost in this currency. */
  async function measuredRunCosts(call: Call, reg: Registry, kinds: ReadonlySet<string>, currency: string): Promise<Map<string, { runs: number; mean: number }>> {
    const out = new Map<string, { runs: number; mean: number }>();
    for (const kind of kinds) {
      let n = 0;
      let sum = 0;
      for (const m of reg.members.values()) {
        if (!m.softwareAgent) continue;
        for (const g of await call.view.graphIris(scopePrefix('run', `${m.address}|${kind}`))) {
          const run = headIn(await call.view.graph(g), 'AgentRun');
          const cost = run?.record.payload.costPerRun;
          if (!cost || cost.currency !== currency) continue;
          n += 1;
          sum += cost.amount;
        }
      }
      if (n > 0) out.set(kind, { runs: n, mean: sum / n });
    }
    return out;
  }

  function reviewedRunOf(rec: RecordOf<'AgentRun'>): ReviewedRun | null {
    const p = rec.payload;
    if (rec.status !== 'reviewed' || !p.review) return null;
    const performedAt = p.runEnvelope.payload['performedAt'];
    return {
      runIri: rec.entityIri, taskIri: p.taskIri, agentDid: p.agentDid, taskKind: p.taskKind, model: p.model,
      selfAnswer: p.selfAssessment.answer, ...(p.selfAssessment.probabilities ? { selfProbabilities: p.selfAssessment.probabilities } : {}),
      verdict: p.review.verdict, reviewerDid: p.review.did, reviewerPersonRef: p.review.personRef,
      reviewedAt: p.review.at, performedAt: typeof performedAt === 'string' ? performedAt : p.review.at, demo: rec.demo === true,
    };
  }

  // ── Capture (one engine for the manual and the document route) ────────────────────────

  async function capture(args: Obj, mode: 'manual' | 'document'): Promise<unknown> {
    const call = await openSigned(args, mode === 'document' ? 'wrd:record-task-map' : 'wrd:capture-workflow');
    const reg = await registryOf(call);
    if (!holds(reg, call.actor, 'operator') && !isAgent(reg, call.actor)) {
      return { ...refuse(403, 'Only a registered operator or agent can capture a workflow.', `${call.actor} is neither in this pod's registry`, via('update_registry')) };
    }
    const c = coerceCapture(call.payload, mode);
    if (!c.ok) return { ...refuse(400, BAD_PAYLOAD, c.why) };
    let documentText: string | null = null;
    if (mode === 'document') {
      const t = args['document_text'];
      if (typeof t !== 'string' || t.trim() === '') return { ...refuse(400, 'The document text is required.', 'send document_text beside the envelope; its sha256 is what the payload binds') };
      if (t.length > LIMITS.documentChars) return { ...refuse(400, 'The document is too long.', `document_text is longer than ${LIMITS.documentChars} characters`) };
      if (sha256Hex(t) !== c.value.document?.sha256) return { ...refuse(400, 'The document is not the one the signer bound.', 'sha256(document_text) differs from payload.document.sha256') };
      documentText = t;
    }
    for (const [i, t] of c.value.tasks.entries()) {
      if (!kindUsable(reg, t.taskKind)) return { ...refuse(400, UNKNOWN_KIND, `tasks[${i}].taskKind ${t.taskKind}: ${KIND_FIX}`, via('update_registry')) };
      const parties = checkParties(t.current, { isRegisteredPerson: (a) => isPerson(reg, a), isRegisteredAgent: (a) => isAgent(reg, a), atCapture: true });
      if (!parties.ok) return { ...refuse(parties.status, parties.error, `tasks[${i}]: ${parties.why}`) };
    }
    const quotes = documentText === null ? null : verifyTaskQuotes(documentText, c.value.tasks.map((t) => ({ sourceQuotes: t.sourceQuotes ?? [] })));
    if (quotes && quotes.verified === 0) {
      return { ...refuse(422, 'None of the quoted spans appear in the document.', `0 of ${quotes.unverified} quotes were found after the published normalisation; nothing was recorded`, via('task_map_packet')) };
    }

    const workflowIri = entityIri('workflow', call.podUrl, `${call.actor}|${call.nonce}`);
    const capturedBy = { did: call.actorDid, envelopeSha256: envelopeSha256(call.envelope) };
    const tasks: Array<{ taskIri: string; name: string; quoteStatus: string; descriptorUrl: string; graphDigest: string; link: string }> = [];
    for (const [i, t] of c.value.tasks.entries()) {
      const taskIri = entityIri('task', workflowIri, String(i + 1));
      const verdicts: readonly QuoteVerdict[] = quotes?.perTask[i] ?? [];
      const payload: TaskPayload = {
        workflowIri, index: i + 1, name: t.name, description: t.description, textSha256: taskTextSha256(t.name, t.description),
        current: t.current, performer: performerOf(t.current), namedParties: namedPartiesOf(t.current),
        taskKind: t.taskKind, taskKindDefinition: kindUsable(reg, t.taskKind)?.definition ?? '',
        ...(t.externalTaskTerm ? { externalTaskTerm: t.externalTaskTerm } : {}),
        quotes: verdicts, quoteStatus: mode === 'document' ? quoteStatusOf(verdicts) : 'none', ratifications: [], capturedBy,
      };
      const w = await write(call, {
        kind: 'Task', entity: taskIri, status: 'captured', payload, head: null, tag: String(i + 1),
        signers: [signerOf(reg, call.actor, 'Curator', 'captured')],
      });
      tasks.push({ taskIri, name: t.name, quoteStatus: payload.quoteStatus, descriptorUrl: w.descriptorUrl, graphDigest: w.graphDigest, link: taskLink(taskIri) });
    }
    const doc = c.value.document;
    const wfWritten = await write(call, {
      kind: 'Workflow', entity: workflowIri, status: 'captured', head: null, tag: 'workflow',
      signers: [signerOf(reg, call.actor, 'Curator', 'captured the workflow')],
      payload: {
        title: c.value.workflow.title, unitLabel: c.value.workflow.unitLabel,
        ...(c.value.workflow.description ? { description: c.value.workflow.description } : {}),
        captureMode: mode, capturedBy: { did: call.actorDid, envelope: call.envelope },
        taskIris: tasks.map((t) => t.taskIri), retiredTaskIris: [],
        ...(doc && documentText !== null ? { document: { title: doc.title, sha256: doc.sha256, chars: documentText.length, textStored: doc.storeText } } : {}),
        ...(doc?.storeText && documentText !== null ? { documentText } : {}),
        ...(c.value.draftedBy ? { draftedBy: c.value.draftedBy } : {}),
        ...(c.value.draftSha256 ? { draftSha256: c.value.draftSha256 } : {}),
      },
    });
    return {
      workflowIri, taskIris: tasks.map((t) => t.taskIri), tasks,
      ...(quotes ? { quotes: { verified: quotes.verified, unverified: quotes.unverified, perTask: quotes.perTask } } : {}),
      descriptorUrl: wfWritten.descriptorUrl, recordId: wfWritten.recordId, status: 'captured', recorded: true,
    };
  }

  // ── Ratify / dispute / acknowledge ──────────────────────────────────────────────────

  async function ratifyDescription(call: Signed, reg: Registry, task: Head<'Task'>, verdict: 'ratify' | 'dispute', note: string | undefined): Promise<unknown> {
    const p = task.record.payload;
    if (!p.namedParties.includes(call.actor)) {
      return { ...refuse(403, 'Only a person or agent named on this task can ratify or dispute it.', `${call.actor} is not named on ${task.record.entityIri}`) };
    }
    if (task.record.status === 'retired') return { ...refuse(409, RETIRED, `${task.record.entityIri} was retired`) };
    const b = needBinding(call.payload);
    if (b.descriptorUrl !== task.loaded.descriptorUrl || b.graphDigest !== task.loaded.graphDigest) {
      return { ...refuse(409, TASK_MOVED, `the current version is ${task.loaded.descriptorUrl}`, via('list_records')) };
    }
    const mine = p.ratifications.find((r) => r.party === call.actor);
    if (mine && mine.verdict === verdict && (mine.note ?? '') === (note ?? '')) {
      return { subject: 'description', taskIri: task.record.entityIri, status: task.record.status, changed: false, descriptorUrl: task.loaded.descriptorUrl, recordId: task.loaded.recordId, graphDigest: task.loaded.graphDigest, recorded: false };
    }
    const ratifications: PartyVerdict[] = [
      ...p.ratifications.filter((r) => r.party !== call.actor),
      { party: call.actor, verdict, ...(note ? { note } : {}), envelope: call.envelope, at: call.at },
    ];
    const s = verdictStatus(p.namedParties, ratifications);
    const status = s === 'open' ? 'captured' : s;
    const payload: TaskPayload = { ...p, ratifications };
    const w = await write(call, {
      kind: 'Task', entity: task.record.entityIri, status, payload, head: task,
      signers: taskSigners(reg, payload, { address: call.actor, role: 'Validator', acted: verdict === 'ratify' ? 'ratified the description' : 'disputed the description' }),
    });
    return { subject: 'description', taskIri: task.record.entityIri, status, changed: true, descriptorUrl: w.descriptorUrl, recordId: w.recordId, graphDigest: w.graphDigest, recorded: true };
  }

  async function ratifyClassification(call: Signed, reg: Registry, task: Head<'Task'>, verdict: 'ratify' | 'dispute', note: string | undefined): Promise<unknown> {
    const p = task.record.payload;
    if (!p.namedParties.includes(call.actor)) {
      return { ...refuse(403, 'Only a person or agent named on this task can ratify or dispute its classification.', `${call.actor} is not named on ${task.record.entityIri}`) };
    }
    if (task.record.status === 'retired') return { ...refuse(409, RETIRED, `${task.record.entityIri} was retired`) };
    const cls = await headOf(call, classificationEntity(p.workflowIri, task.record.entityIri), 'Classification');
    if (!cls) return { ...refuse(404, 'This task has not been classified.', `${task.record.entityIri} has no classification`, via('classify_task')) };
    const b = needBinding(call.payload);
    if (b.descriptorUrl !== cls.loaded.descriptorUrl || b.graphDigest !== cls.loaded.graphDigest) {
      return { ...refuse(409, 'The classification changed since you read it.', `the current version is ${cls.loaded.descriptorUrl}`, via('list_records')) };
    }
    let answers: ClassificationAnswers | undefined;
    if (call.payload['answers'] !== undefined) {
      if (verdict !== 'dispute') return { ...refuse(400, BAD_PAYLOAD, 'answers go with a dispute: they are the party\'s own answers, shown beside the classifier\'s') };
      const a = coerceAnswers(call.payload['answers']);
      if (!a) return { ...refuse(400, BAD_PAYLOAD, 'answers must give one of the published options for each of the seven questions') };
      answers = a;
    }
    const cp = cls.record.payload;
    const mine = cp.ratifications.find((r) => r.party === call.actor);
    if (mine && mine.verdict === verdict && (mine.note ?? '') === (note ?? '') && canonicalJson(mine.answers ?? null) === canonicalJson(answers ?? null)) {
      return { subject: 'classification', taskIri: task.record.entityIri, status: cls.record.status, changed: false, descriptorUrl: cls.loaded.descriptorUrl, recordId: cls.loaded.recordId, graphDigest: cls.loaded.graphDigest, recorded: false };
    }
    const ratifications = [
      ...cp.ratifications.filter((r) => r.party !== call.actor),
      { party: call.actor, verdict, ...(note ? { note } : {}), ...(answers ? { answers } : {}), envelope: call.envelope, at: call.at },
    ];
    const s = verdictStatus(p.namedParties, ratifications);
    const status = s === 'open' ? 'classified' : s;
    const signers = [
      signerOf(reg, cp.answeredBy.address, 'Curator', 'classified'),
      ...ratifications.map((r) => signerOf(reg, r.party, 'Validator', r.verdict === 'ratify' ? 'ratified the classification' : 'disputed the classification')),
    ];
    const w = await write(call, { kind: 'Classification', entity: cls.record.entityIri, status, payload: { ...cp, ratifications }, head: cls, signers });
    return { subject: 'classification', taskIri: task.record.entityIri, status, changed: true, descriptorUrl: w.descriptorUrl, recordId: w.recordId, graphDigest: w.graphDigest, recorded: true };
  }

  async function acknowledgeAssignment(call: Signed, reg: Registry, task: Head<'Task'>, verdict: 'acknowledge' | 'object', note: string | undefined): Promise<unknown> {
    const planIri = needIri(call.payload, 'planIri');
    const plan = await headOf(call, planIri, 'Plan');
    if (!plan) return { ...refuse(404, 'No such plan on this pod.', `${planIri} has no record on ${call.podUrl}`) };
    const row = plan.record.payload.tasks.find((r) => r.taskIri === task.record.entityIri);
    if (!row || !row.changed || row.proposed.personAddress !== call.actor) {
      return { ...refuse(403, 'Only the person this plan names for this task can acknowledge or object.', `${planIri} does not name ${call.actor} on ${task.record.entityIri}`) };
    }
    if (task.record.status === 'retired') return { ...refuse(409, RETIRED, `${task.record.entityIri} was retired`) };
    const b = needBinding(call.payload);
    if (b.descriptorUrl !== plan.loaded.descriptorUrl || b.graphDigest !== plan.loaded.graphDigest) {
      return { ...refuse(409, 'The plan you read is not this plan.', `the plan's record is ${plan.loaded.descriptorUrl}`, via('list_records')) };
    }
    const entity = ackEntity(planIri, task.record.entityIri, call.actor);
    const head = await headOf(call, entity, 'Acknowledgement');
    const status = verdict === 'acknowledge' ? 'acknowledged' : 'objected';
    if (head && head.record.status === status && (head.record.payload.note ?? '') === (note ?? '')) {
      return { subject: 'assignment', taskIri: task.record.entityIri, status, changed: false, descriptorUrl: head.loaded.descriptorUrl, recordId: head.loaded.recordId, graphDigest: head.loaded.graphDigest, recorded: false };
    }
    const w = await write(call, {
      kind: 'Acknowledgement', entity, status, head,
      payload: { planIri, taskIri: task.record.entityIri, personAddress: call.actor, verdict, ...(note ? { note } : {}), envelope: call.envelope },
      signers: [signerOf(reg, call.actor, 'Validator', status === 'acknowledged' ? 'acknowledged the assignment' : 'objected to the assignment')],
      derivedFrom: [plan.loaded.descriptorUrl],
    });
    return { subject: 'assignment', taskIri: task.record.entityIri, planIri, status, changed: true, descriptorUrl: w.descriptorUrl, recordId: w.recordId, graphDigest: w.graphDigest, recorded: true };
  }

  // ── Revise / add / retire ────────────────────────────────────────────────────────────

  async function quotesAgainstWorkflow(args: Obj, call: Signed, workflowIri: string, quotes: readonly string[]): Promise<QuoteVerdict[]> {
    const wf = await headOf(call, workflowIri, 'Workflow');
    if (!wf) throw decline(409, INTEGRITY, `the task's workflow ${workflowIri} has no trusted record`);
    const doc = wf.record.payload.document;
    if (!doc) throw decline(400, 'Quotes need a document, and this workflow was captured by hand.', 'remove sourceQuotes, or capture the workflow from its document');
    const text = args['document_text'];
    if (typeof text !== 'string' || sha256Hex(text) !== doc.sha256) {
      throw decline(400, 'The document is not the one this workflow was captured from.', 'send document_text whose sha256 equals the workflow\'s document.sha256');
    }
    const v = verifyTaskQuotes(text, [{ sourceQuotes: quotes }]);
    return [...(v.perTask[0] ?? [])];
  }

  async function revise(args: Obj): Promise<unknown> {
    const call = await openSigned(args, 'wrd:revise-task');
    const rev = coerceRevision(call.payload);
    if (!rev.ok) return { ...refuse(400, BAD_PAYLOAD, rev.why) };
    const r = rev.value;
    const reg = await registryOf(call);
    const partyCheck = (a: Allocation): void => {
      const c = checkParties(a, { isRegisteredPerson: (x) => isPerson(reg, x), isRegisteredAgent: (x) => isAgent(reg, x), atCapture: true });
      if (!c.ok) throw decline(c.status, c.error, c.why);
    };

    if (r.op === 'revise') {
      const task = await taskHead(call, r.taskIri);
      const p = task.record.payload;
      if (!holds(reg, call.actor, 'operator') && !p.namedParties.includes(call.actor)) {
        return { ...refuse(403, 'Only a registered operator or someone named on this task can revise it.', `${call.actor} is neither`) };
      }
      if (task.record.status === 'retired') return { ...refuse(409, RETIRED, `${r.taskIri} was retired`) };
      if (r.descriptorUrl !== task.loaded.descriptorUrl || r.graphDigest !== task.loaded.graphDigest) {
        return { ...refuse(409, TASK_MOVED, `the current version is ${task.loaded.descriptorUrl}`, via('list_records')) };
      }
      const applied = applyTaskChanges(captureTaskOf(p), r.changes);
      const next = applied.task;
      if (r.changes.taskKind !== undefined && !kindUsable(reg, next.taskKind)) return { ...refuse(400, UNKNOWN_KIND, `${next.taskKind}: ${KIND_FIX}`, via('update_registry')) };
      partyCheck(next.current);
      let quotes: readonly QuoteVerdict[] = p.quotes;
      if (r.changes.sourceQuotes) quotes = await quotesAgainstWorkflow(args, call, p.workflowIri, r.changes.sourceQuotes);
      else if (applied.quotesCleared) quotes = [];
      const parties = namedPartiesOf(next.current);
      const answers = p.ratifications.filter((x) => x.verdict === 'dispute').map((x) => ({ party: x.party, note: x.note ?? '', at: x.at }));
      const ratifications: PartyVerdict[] = parties.includes(call.actor) ? [{ party: call.actor, verdict: 'ratify', envelope: call.envelope, at: call.at }] : [];
      const status = verdictStatus(parties, ratifications) === 'ratified' ? 'ratified' : 'captured';
      const payload: TaskPayload = {
        ...p, name: next.name, description: next.description, textSha256: taskTextSha256(next.name, next.description),
        current: next.current, performer: performerOf(next.current), namedParties: parties, taskKind: next.taskKind,
        taskKindDefinition: reg.kinds.get(next.taskKind)?.definition ?? p.taskKindDefinition,
        ...(next.externalTaskTerm ? { externalTaskTerm: next.externalTaskTerm } : {}),
        quotes, quoteStatus: p.quoteStatus === 'none' && !r.changes.sourceQuotes ? 'none' : quoteStatusOf(quotes),
        ratifications,
        revision: { by: { did: call.actorDid, envelope: call.envelope }, ...(r.note ? { note: r.note } : {}), answers, quotesCleared: applied.quotesCleared },
      };
      const w = await write(call, {
        kind: 'Task', entity: r.taskIri, status, payload, head: task,
        signers: taskSigners(reg, payload, { address: call.actor, role: 'Curator', acted: 'revised the description' }),
      });
      return { op: 'revise', taskIri: r.taskIri, workflowIri: p.workflowIri, status, answeredDisputes: answers, descriptorUrl: w.descriptorUrl, recordId: w.recordId, graphDigest: w.graphDigest, recorded: true };
    }

    if (r.op === 'add') {
      const wf = await headOf(call, r.workflowIri, 'Workflow');
      if (!wf) return { ...refuse(404, 'No such workflow on this pod.', `${r.workflowIri} has no record on ${call.podUrl}`) };
      requireOperatorPerson(reg, call.actor);
      if (r.descriptorUrl !== wf.loaded.descriptorUrl || r.graphDigest !== wf.loaded.graphDigest) {
        return { ...refuse(409, 'The workflow changed since you read it.', `the current version is ${wf.loaded.descriptorUrl}`, via('list_records')) };
      }
      if (!kindUsable(reg, r.task.taskKind)) return { ...refuse(400, UNKNOWN_KIND, `${r.task.taskKind}: ${KIND_FIX}`, via('update_registry')) };
      partyCheck(r.task.current);
      const quotes = r.task.sourceQuotes ? await quotesAgainstWorkflow(args, call, r.workflowIri, r.task.sourceQuotes) : [];
      const wp = wf.record.payload;
      let index = wp.taskIris.length + wp.retiredTaskIris.length + 1;
      while ((await call.view.graph(graphIriOf(entityIri('task', r.workflowIri, String(index))))).chain.length > 0) index += 1;
      const taskIri = entityIri('task', r.workflowIri, String(index));
      const payload: TaskPayload = {
        workflowIri: r.workflowIri, index, name: r.task.name, description: r.task.description, textSha256: taskTextSha256(r.task.name, r.task.description),
        current: r.task.current, performer: performerOf(r.task.current), namedParties: namedPartiesOf(r.task.current),
        taskKind: r.task.taskKind, taskKindDefinition: kindUsable(reg, r.task.taskKind)?.definition ?? '',
        ...(r.task.externalTaskTerm ? { externalTaskTerm: r.task.externalTaskTerm } : {}),
        quotes, quoteStatus: r.task.sourceQuotes ? quoteStatusOf(quotes) : 'none', ratifications: [],
        capturedBy: { did: call.actorDid, envelopeSha256: envelopeSha256(call.envelope) },
      };
      const tw = await write(call, { kind: 'Task', entity: taskIri, status: 'captured', payload, head: null, tag: 'task', signers: [signerOf(reg, call.actor, 'Curator', 'added the task')] });
      const ww = await write(call, {
        kind: 'Workflow', entity: r.workflowIri, status: 'captured', head: wf, tag: 'workflow',
        payload: { ...wp, taskIris: [...wp.taskIris, taskIri], revision: { op: 'add', taskIri, by: { did: call.actorDid, envelope: call.envelope } } },
        signers: [signerOf(reg, call.actor, 'Curator', 'added a task')],
      });
      return { op: 'add', taskIri, workflowIri: r.workflowIri, status: 'captured', answeredDisputes: [], descriptorUrl: tw.descriptorUrl, recordId: tw.recordId, graphDigest: tw.graphDigest, workflowDescriptorUrl: ww.descriptorUrl, link: taskLink(taskIri), recorded: true };
    }

    // retire
    const task = await taskHead(call, r.taskIri);
    requireOperatorPerson(reg, call.actor);
    if (task.record.status === 'retired') return { ...refuse(409, RETIRED, `${r.taskIri} was already retired`) };
    if (r.descriptorUrl !== task.loaded.descriptorUrl || r.graphDigest !== task.loaded.graphDigest) {
      return { ...refuse(409, TASK_MOVED, `the current version is ${task.loaded.descriptorUrl}`, via('list_records')) };
    }
    const wf = await headOf(call, task.record.payload.workflowIri, 'Workflow');
    if (!wf) throw decline(409, INTEGRITY, `the task's workflow ${task.record.payload.workflowIri} has no trusted record`);
    const first = (await call.view.history(task.graph))[0];
    const startedAt = first?.validFrom ?? null;
    if (!startedAt || Date.parse(startedAt) >= call.now.getTime()) return { ...refuse(409, CLOCK_SKEW, `the task's first version is valid from ${startedAt ?? 'an unknown time'}`) };
    const payload: TaskPayload = { ...task.record.payload, retirement: { by: { did: call.actorDid, envelope: call.envelope }, why: r.why, at: call.at } };
    const tw = await write(call, {
      kind: 'Task', entity: r.taskIri, status: 'retired', payload, head: task, tag: 'task', validFrom: startedAt, validUntil: call.at,
      signers: [signerOf(reg, call.actor, 'Curator', 'retired the task')],
    });
    const wp = wf.record.payload;
    const ww = await write(call, {
      kind: 'Workflow', entity: wf.record.entityIri, status: 'captured', head: wf, tag: 'workflow',
      payload: { ...wp, taskIris: wp.taskIris.filter((t) => t !== r.taskIri), retiredTaskIris: [...wp.retiredTaskIris, r.taskIri], revision: { op: 'retire', taskIri: r.taskIri, by: { did: call.actorDid, envelope: call.envelope } } },
      signers: [signerOf(reg, call.actor, 'Curator', 'retired a task')],
    });
    return { op: 'retire', taskIri: r.taskIri, workflowIri: wf.record.entityIri, status: 'retired', answeredDisputes: [], descriptorUrl: tw.descriptorUrl, recordId: tw.recordId, graphDigest: tw.graphDigest, workflowDescriptorUrl: ww.descriptorUrl, recorded: true };
  }

  // ── Registry change validation ───────────────────────────────────────────────────────

  const PERSON_REF = /^[A-Za-z0-9_.:-]{1,80}$/;
  function mergeRegistry(reg: Registry, p: Obj): { members: RegistryMember[]; taskKinds: RegistryTaskKind[]; podPolicy: PodPolicy | null } {
    const bad = (why: string): Declined => decline(400, 'The registry change is malformed.', why);
    if (p['entries'] === undefined && p['taskKinds'] === undefined && p['podPolicy'] === undefined) throw bad('a change carries at least one of entries, taskKinds or podPolicy');
    const members = new Map(reg.members);
    if (p['entries'] !== undefined) {
      const entries = p['entries'];
      if (!Array.isArray(entries) || entries.length > 50) throw bad('entries must be an array of at most 50');
      const seen = new Set<string>();
      for (const [i, raw] of entries.entries()) {
        if (!isObj(raw)) throw bad(`entries[${i}] must be an object`);
        const address = raw['address'];
        if (!isAddress(address)) throw bad(`entries[${i}].address must be a 0x address`);
        const a = lower(address);
        if (seen.has(a)) throw bad(`entries[${i}]: ${a} appears twice in one change`);
        seen.add(a);
        const roles = raw['roles'];
        if (!Array.isArray(roles) || !roles.every((r) => isOneOf(REGISTRY_ROLES, r))) throw bad(`entries[${i}].roles must be a list of ${REGISTRY_ROLES.join(', ')}`);
        if (roles.length === 0) { members.delete(a); continue; }
        const uniqueRoles = [...new Set(roles as RegistryRole[])].sort();
        const label = raw['label'];
        if (typeof label !== 'string' || label.trim() === '' || label.length > 80) throw bad(`entries[${i}].label must be 1 to 80 characters`);
        const softwareAgent = raw['softwareAgent'];
        if (typeof softwareAgent !== 'boolean') throw bad(`entries[${i}].softwareAgent must be true or false`);
        const isAgentEntry = uniqueRoles.includes('agent');
        if (isAgentEntry !== softwareAgent) throw bad(`entries[${i}]: the agent role and softwareAgent: true go together`);
        if (isAgentEntry && uniqueRoles.length > 1) throw bad(`entries[${i}]: an agent holds the agent role only; approver, operator and worker are roles of people`);
        if (isAgentEntry) {
          const principal = raw['principal'];
          const model = raw['model'];
          if (!isAddress(principal)) throw bad(`entries[${i}].principal is required: the address of the registered person accountable for this agent`);
          if (typeof model !== 'string' || model.trim() === '' || model.length > 120) throw bad(`entries[${i}].model is required: the model the agent runs on, 1 to 120 characters`);
          if (raw['personRef'] !== undefined) throw bad(`entries[${i}].personRef belongs to people; an agent has a principal instead`);
          members.set(a, { address: a, did: didOf(a), roles: uniqueRoles, label, softwareAgent: true, personRef: null, principal: lower(principal), model });
        } else {
          const personRef = raw['personRef'];
          if (typeof personRef !== 'string' || !PERSON_REF.test(personRef)) {
            throw bad(`entries[${i}].personRef is required: the admin's stable reference for the person who holds this key (1 to 80 of [A-Za-z0-9_.:-])`);
          }
          if (raw['principal'] !== undefined || raw['model'] !== undefined) throw bad(`entries[${i}]: principal and model belong to agents`);
          members.set(a, { address: a, did: didOf(a), roles: uniqueRoles, label, softwareAgent: false, personRef, principal: null, model: null });
        }
      }
    }
    for (const m of members.values()) {
      if (!m.softwareAgent || m.principal === null) continue;
      const principal = members.get(m.principal);
      if (!principal || principal.softwareAgent) {
        throw bad(reg.members.get(m.principal) && !principal
          ? `${m.principal} is the accountable principal of agent ${m.address}; register another principal for the agent before removing them`
          : `agent ${m.address}'s principal ${m.principal} must be a registered person`);
      }
    }
    const kinds = new Map(reg.kinds);
    if (p['taskKinds'] !== undefined) {
      const list = p['taskKinds'];
      if (!Array.isArray(list) || list.length > 100) throw bad('taskKinds must be an array of at most 100');
      for (const [i, raw] of list.entries()) {
        if (!isObj(raw)) throw bad(`taskKinds[${i}] must be an object`);
        const slug = raw['slug'];
        if (typeof slug !== 'string' || !TASK_KIND_SLUG.test(slug)) throw bad(`taskKinds[${i}].slug must match ${TASK_KIND_SLUG.source}`);
        const retire = raw['retire'];
        if (retire !== undefined && retire !== true) throw bad(`taskKinds[${i}].retire may only be true`);
        const existing = kinds.get(slug);
        const label = raw['label'] ?? existing?.label;
        const definition = raw['definition'] ?? existing?.definition;
        if (typeof label !== 'string' || label.trim() === '' || label.length > 80) throw bad(`taskKinds[${i}].label must be 1 to 80 characters`);
        if (typeof definition !== 'string' || definition.trim() === '' || definition.length > 300 || /[\r\n]/.test(definition)) {
          throw bad(`taskKinds[${i}].definition must be one sentence of at most 300 characters`);
        }
        kinds.set(slug, { slug, label, definition, retired: retire === true });
      }
    }
    let podPolicy = reg.podPolicy;
    if (p['podPolicy'] !== undefined) {
      if (p['podPolicy'] === null) {
        podPolicy = null;
      } else {
        const c = coercePodPolicy(p['podPolicy']);
        if (!c.ok) throw bad(c.why);
        const loosens = podPolicyLoosens(published, c.value);
        if (loosens !== null) throw decline(400, `A pod policy can only tighten the published policy: ${loosens}.`, `podPolicy.${loosens} is below the published value`);
        podPolicy = c.value;
      }
    }
    return {
      members: [...members.values()].sort((x, y) => x.address.localeCompare(y.address)),
      taskKinds: [...kinds.values()].sort((x, y) => x.slug.localeCompare(y.slug)),
      podPolicy,
    };
  }

  // ── Outcome payload ──────────────────────────────────────────────────────────────────

  function coerceMeasured(v: unknown): MeasuredValue {
    const bad = (why: string): Declined => decline(400, 'The measured outcome is malformed.', why);
    if (!isObj(v)) throw bad('measured must be an object');
    const delta = v['weeklyValueDelta'];
    if (typeof delta !== 'number' || !Number.isFinite(delta)) throw bad('measured.weeklyValueDelta must be a finite number');
    let interval: { low: number; high: number } | undefined;
    if (v['interval'] !== undefined) {
      const i = v['interval'];
      if (!isObj(i) || typeof i['low'] !== 'number' || typeof i['high'] !== 'number' || !Number.isFinite(i['low']) || !Number.isFinite(i['high'])) throw bad('measured.interval must be {low, high}');
      if (!(i['low'] <= delta && delta <= i['high'])) throw bad('measured.interval must contain measured.weeklyValueDelta');
      interval = { low: i['low'], high: i['high'] };
    }
    const basis = v['comparisonBasis'];
    if (!isOneOf(COMPARISON_BASES, basis)) throw bad(`measured.comparisonBasis must be one of ${COMPARISON_BASES.join(', ')}`);
    const method = need(v, 'method', 1000, 'measured');
    const counts: { runsObserved?: number; criticalFailuresObserved?: number } = {};
    for (const k of ['runsObserved', 'criticalFailuresObserved'] as const) {
      const n = v[k];
      if (n === undefined) continue;
      if (typeof n !== 'number' || !Number.isInteger(n) || n < 0) throw bad(`measured.${k} must be a whole number`);
      counts[k] = n;
    }
    return {
      weeklyValueDelta: delta, ...(interval ? { interval } : {}), comparisonBasis: basis,
      windowStart: String(v['windowStart'] ?? ''), windowEnd: String(v['windowEnd'] ?? ''), method, ...counts,
    };
  }

  // ── Read models ──────────────────────────────────────────────────────────────────────

  interface SnapGraph { readonly graphIri: string; readonly g: GraphHeads; readonly head: LoadedRecord | null; readonly record: WrdRecord | null }
  interface Snapshot { readonly complete: boolean; readonly graphs: readonly SnapGraph[]; readonly foreign: readonly ManifestEntry[] }
  async function snapshot(view: PodView): Promise<Snapshot> {
    const walk = await view.walk();
    if (!walk.complete && view.strict) throw new IncompleteManifestError(view.podUrl);
    const iris = [...new Set(walk.entries.flatMap((e) => e.describes))].sort();
    const graphs: SnapGraph[] = [];
    for (const graphIri of iris) {
      const g = await view.graph(graphIri);
      const head = g.state === 'ok' ? g.heads[0] ?? null : null;
      graphs.push({ graphIri, g, head, record: head?.record ?? null });
    }
    return { complete: walk.complete, graphs, foreign: walk.foreign };
  }
  function recordsOf<K extends RecordKind>(snap: Snapshot, kind: K): Array<{ readonly s: SnapGraph; readonly head: LoadedRecord; readonly record: RecordOf<K> }> {
    const out: Array<{ s: SnapGraph; head: LoadedRecord; record: RecordOf<K> }> = [];
    for (const s of snap.graphs) if (s.head && s.record && s.record.recordKind === kind) out.push({ s, head: s.head, record: s.record as RecordOf<K> });
    return out;
  }
  const headInfo = (l: LoadedRecord): Obj => ({
    descriptorUrl: l.descriptorUrl, recordId: l.recordId, modalStatus: l.modalStatus, graphDigest: l.graphDigest,
    versions: l.record?.version ?? null, validFrom: l.validFrom, ...(l.validUntil ? { validUntil: l.validUntil } : {}),
    signedBy: l.record?.signers.map((s) => s.did) ?? [], trusted: l.authorship.trusted, contentBinding: l.authorship.contentBinding,
  });

  // ── The map ──────────────────────────────────────────────────────────────────────────

  const handlers: Record<string, WrdHandler> = {
    'wrd.update_registry': async (args) => {
      const call = await openSigned(args, 'wrd:update-registry');
      if (admins.size === 0) return { ...refuse(403, 'This bridge has no admin addresses configured.', 'nobody can change the registry until the bridge is started with admin addresses') };
      const reg = await registryOf(call);
      if (!admins.has(call.actor)) return { ...refuse(403, 'Only an admin can change the registry.', `${call.actor} is not one of this bridge's admin addresses`) };
      const merged = mergeRegistry(reg, call.payload);
      const replacedUntrusted = reg.head === null && reg.graph.untrusted.length > 0;
      const w = await write(call, {
        kind: 'RoleRegistry', entity: reg.entity, status: 'registered', head: reg.head,
        payload: { ...merged, replacedUntrusted, change: { envelope: call.envelope, signer: call.actor } },
        signers: [signerOf(reg, call.actor, 'Curator', 'changed the registry')],
      });
      return {
        registryIri: reg.entity, members: merged.members, taskKinds: merged.taskKinds, podPolicy: merged.podPolicy, replacedUntrusted,
        descriptorUrl: w.descriptorUrl, recordId: w.recordId, graphDigest: w.graphDigest, status: 'registered', recorded: true,
      };
    },

    'wrd.task_map_packet': async (args) => {
      const title = args['document_title'];
      const text = args['document_text'];
      if (typeof title !== 'string' || title.trim() === '' || title.length > LIMITS.documentTitle) {
        return { ...refuse(400, 'A document title is required.', `document_title must be 1 to ${LIMITS.documentTitle} characters`) };
      }
      if (typeof text !== 'string' || text.trim() === '') return { ...refuse(400, 'The document text is required.', 'document_text must be the text of the SOP or document') };
      if (text.length > LIMITS.documentChars) return { ...refuse(400, 'The document is too long.', `document_text is longer than ${LIMITS.documentChars} characters`) };
      const workflowTitle = typeof args['workflow_title'] === 'string' ? args['workflow_title'].slice(0, LIMITS.workflowTitle) : undefined;
      let podUrl: string | undefined;
      if (typeof args['pod_url'] === 'string' && args['pod_url'] !== '') {
        try { podUrl = normalisePodUrl(args['pod_url']); } catch (e) { return { ...refuse(400, 'The pod URL is not an http(s) URL.', messageOf(e)) }; }
      }
      return buildTaskMapPacket({ documentTitle: title, documentText: text, ...(workflowTitle ? { workflowTitle } : {}), ...(podUrl ? { podUrl } : {}) });
    },

    'wrd.record_task_map': async (args) => capture(args, 'document'),

    'wrd.capture_workflow': async (args) => capture(args, 'manual'),

    'wrd.revise_task': async (args) => revise(args),

    'wrd.ratify_task': async (args) => {
      const call = await openSigned(args, 'wrd:ratify-task');
      const p = call.payload;
      const subject = p['subject'];
      if (subject !== 'description' && subject !== 'classification' && subject !== 'assignment') {
        return { ...refuse(400, BAD_PAYLOAD, 'payload.subject must be description, classification or assignment') };
      }
      const taskIri = needIri(p, 'taskIri');
      const verdict = p['verdict'];
      const allowed = subject === 'assignment' ? ['acknowledge', 'object'] : ['ratify', 'dispute'];
      if (typeof verdict !== 'string' || !allowed.includes(verdict)) return { ...refuse(400, BAD_PAYLOAD, `payload.verdict must be ${allowed.join(' or ')}`) };
      const note = maybe(p, 'note', LIMITS.note);
      if ((verdict === 'dispute' || verdict === 'object') && !note) return { ...refuse(400, 'Say why: a dispute or an objection needs a note.', 'payload.note is required with this verdict') };
      needBinding(p);
      const reg = await registryOf(call);
      const task = await taskHead(call, taskIri);
      if (subject === 'description') return ratifyDescription(call, reg, task, verdict as 'ratify' | 'dispute', note);
      if (subject === 'classification') return ratifyClassification(call, reg, task, verdict as 'ratify' | 'dispute', note);
      return acknowledgeAssignment(call, reg, task, verdict as 'acknowledge' | 'object', note);
    },

    'wrd.classify_task': async (args) => {
      const call = await openSigned(args, 'wrd:classify-task');
      const taskIri = needIri(call.payload, 'taskIri');
      const personNote = maybe(call.payload, 'notes', LIMITS.note);
      const reg = await registryOf(call);
      const task = await taskHead(call, taskIri);
      const tp = task.record.payload;
      const named = tp.namedParties.includes(call.actor);
      if (!named && !holds(reg, call.actor, 'operator') && !holds(reg, call.actor, 'approver')) {
        return { ...refuse(403, 'Only a registered operator or approver, or someone named on this task, can classify it.', `${call.actor} is none of these`) };
      }
      if (task.record.status === 'retired') return { ...refuse(409, RETIRED, `${taskIri} was retired`) };
      const answers = coerceAnswers(call.payload['answers']);
      if (!answers) return { ...refuse(400, BAD_PAYLOAD, 'answers must give one of the published options for each of the seven questions') };
      const result = classifyTask(answers, published);
      if (!result.placed) return { ...refuse(400, 'No evidence places this task in a regime.', result.why) };
      const entity = classificationEntity(tp.workflowIri, taskIri);
      const head = await headOf(call, entity, 'Classification');
      const role = named ? 'performer' : holds(reg, call.actor, 'approver') ? 'approver' : 'operator';
      const ratifications = named ? [{ party: call.actor, verdict: 'ratify' as const, envelope: call.envelope, at: call.at }] : [];
      const status = verdictStatus(tp.namedParties, ratifications) === 'ratified' ? 'ratified' : 'classified';
      const notes = [...result.notes, ...(personNote ? [`Classifier's note: ${personNote}`] : [])];
      const w = await write(call, {
        kind: 'Classification', entity, status, head,
        payload: {
          taskIri, taskTextSha256: tp.textSha256, answers, regime: result.regime, method: result.method, regimeSource: REGIME_SOURCE,
          regimeSourceIri: published.regimeSourceIri, rulesFired: result.rulesFired, notes,
          answeredBy: { did: call.actorDid, address: call.actor, personRef: personRefOf(reg, call.actor), role, envelope: call.envelope },
          ratifications, policyRef: policyRefOf(reg),
        },
        signers: [signerOf(reg, call.actor, 'Curator', 'classified')],
        derivedFrom: [task.loaded.descriptorUrl],
      });
      return {
        taskIri, classificationIri: entity, regime: result.regime, method: result.method, regimeSource: REGIME_SOURCE, rulesFired: result.rulesFired,
        notes, permittedLevels: reg.policy.regimes.get(result.regime)?.permittedLevels ?? [], answeredBy: { role },
        status, descriptorUrl: w.descriptorUrl, recordId: w.recordId, graphDigest: w.graphDigest, recorded: true,
      };
    },

    'wrd.propose_allocation': async (args) => {
      const call = await openSigned(args, 'wrd:propose-allocation');
      const p = call.payload;
      const workflowIri = needIri(p, 'workflowIri');
      const title = need(p, 'title', LIMITS.workflowTitle);
      const rawChanges = p['changes'];
      if (!Array.isArray(rawChanges) || rawChanges.length < 1 || rawChanges.length > LIMITS.tasks) return { ...refuse(400, BAD_PAYLOAD, `payload.changes must hold 1 to ${LIMITS.tasks} changes`) };
      const changes: AllocationChange[] = [];
      for (const [i, raw] of rawChanges.entries()) {
        const c = coerceChange(raw);
        if (!c) return { ...refuse(400, BAD_PAYLOAD, `changes[${i}] must be {taskIri, proposedLevel, personAddress?, agentAddress?, probes?}`) };
        changes.push(c);
      }
      const reg = await registryOf(call);
      const wf = await headOf(call, workflowIri, 'Workflow');
      if (!wf) return { ...refuse(404, 'No such workflow on this pod.', `${workflowIri} has no record on ${call.podUrl}`) };
      requireOperatorPerson(reg, call.actor);
      const tasks = await workflowTasks(call, wf);
      const unclassified = tasks.filter((t) => t.classification === null).map((t) => t.taskIri);
      if (unclassified.length > 0) {
        return { ...refuse(409, 'Classify every task before proposing an allocation.', `${tasks.length - unclassified.length} of ${tasks.length} tasks are classified; unclassified: ${unclassified.join(', ')}`, via('classify_task')) };
      }
      const byTask = new Map(tasks.map((t) => [t.taskIri, t]));
      const seen = new Set<string>();
      for (const c of changes) {
        if (seen.has(c.taskIri)) return { ...refuse(400, BAD_PAYLOAD, `${c.taskIri} appears twice in changes`) };
        seen.add(c.taskIri);
        if (!byTask.has(c.taskIri)) return { ...refuse(400, 'A change names a task this workflow does not list.', `${c.taskIri} is not a current task of ${workflowIri}`) };
      }
      const effective = await effectiveAllocations(call, workflowIri);
      const grants = new Map<string, GrantInfo>();
      for (const c of changes) {
        const t = byTask.get(c.taskIri);
        if (c.proposedLevel !== 'agent-acts-within-grant' || !c.agentAddress || !t) continue;
        grants.set(`${c.agentAddress}|${t.task.record.payload.taskKind}`, await grantState(call, reg, c.agentAddress, t.task.record.payload.taskKind));
      }
      const results = new Map<string, { proposed: Allocation; changed: boolean }>();
      for (const c of changes) {
        const t = byTask.get(c.taskIri);
        if (!t || !t.classification) continue;
        const tp = t.task.record.payload;
        const cp = t.classification.record.payload;
        const current = effective.get(c.taskIri)?.allocation ?? tp.current;
        const forCheck: TaskForAllocation = {
          taskIri: c.taskIri, taskKind: tp.taskKind, current,
          descriptionStatus: t.task.record.status === 'retired' ? 'captured' : t.task.record.status,
          regime: cp.regime, answers: cp.answers, classificationStatus: t.classification.record.status,
          classificationCurrent: cp.taskTextSha256 === tp.textSha256,
        };
        const check = checkAllocation(c, forCheck, {
          policy: reg.policy,
          isRegisteredAgent: (a) => isAgent(reg, a),
          isRegisteredPerson: (a) => isPerson(reg, a),
          grantFor: (agent, kind) => grants.get(`${agent}|${kind}`) ?? { active: false, why: 'no grant' },
        });
        if (!check.ok) return { ...refuse(check.status, check.error, `${check.taskIri}: ${check.why}`, check.resolvedBy ? viaToolName(check.resolvedBy) : undefined) };
        results.set(c.taskIri, { proposed: check.proposed, changed: check.changed });
      }
      const changedChanges = changes.filter((c) => results.get(c.taskIri)?.changed);
      if (changedChanges.length === 0) return { ...refuse(409, 'This plan changes nothing.', 'every proposed allocation equals the current one') };
      const planKind = planKindOf(changedChanges, (iri) => byTask.get(iri)?.classification?.record.payload.regime ?? null);
      if (planKind === 'mixed') {
        return { ...refuse(409, "Probe changes and valued changes go in separate plans: a probe's effect would land inside the measured value of the valued change.", 'the changes mix Emergent work with other regimes') };
      }
      const rows: PlanTaskRow[] = tasks.flatMap((t) => {
        const tp = t.task.record.payload;
        const cls = t.classification;
        if (!cls) return [];
        const current = effective.get(t.taskIri)?.allocation ?? tp.current;
        const res = results.get(t.taskIri);
        const change = changes.find((c) => c.taskIri === t.taskIri);
        const proposed = res?.proposed ?? current;
        const changed = res?.changed ?? false;
        const grant = changed && proposed.level === 'agent-acts-within-grant' && proposed.agentAddress ? grants.get(`${proposed.agentAddress}|${tp.taskKind}`) : undefined;
        return [{
          taskIri: t.taskIri, taskKind: tp.taskKind, regime: cls.record.payload.regime, current, proposed, changed,
          ...(changed && change?.probes ? { probes: change.probes } : {}),
          ...(grant && grant.active ? { grant: { grantIri: grant.grantIri, evidenceFromThisTask: grant.evidenceTaskIris.includes(t.taskIri), runsCounted: grant.runsCounted } } : {}),
        }];
      });
      const planIri = entityIri('plan', workflowIri, `${call.actor}|${call.nonce}`);
      const w = await write(call, {
        kind: 'Plan', entity: planIri, status: 'proposed', head: null,
        payload: {
          workflowIri, title, planKind, proposedBy: { did: call.actorDid, envelope: call.envelope }, tasks: rows,
          classificationHeads: Object.fromEntries(tasks.map((t) => [t.taskIri, t.classification?.loaded.descriptorUrl ?? ''])),
          taskTextSha256: Object.fromEntries(tasks.map((t) => [t.taskIri, t.task.record.payload.textSha256])),
          policyRef: policyRefOf(reg),
        },
        signers: [signerOf(reg, call.actor, 'Curator', 'proposed the plan')],
        derivedFrom: [wf.loaded.descriptorUrl],
      });
      const assignments = rows.filter((r) => r.changed && r.proposed.personAddress).map((r) => ({ taskIri: r.taskIri, personAddress: r.proposed.personAddress, state: 'not-acknowledged', label: UNACKNOWLEDGED }));
      return {
        planIri, workflowIri, planKind, tasks: rows, changedTasks: rows.filter((r) => r.changed).map((r) => r.taskIri), assignments,
        descriptorUrl: w.descriptorUrl, recordId: w.recordId, graphDigest: w.graphDigest, status: 'proposed', recorded: true,
      };
    },

    'wrd.value_plan': async (args) => {
      const call = await openSigned(args, 'wrd:value-plan');
      const planIri = needIri(call.payload, 'planIri');
      const rawInputs = call.payload['inputs'];
      if (!isObj(rawInputs)) return { ...refuse(400, BAD_PAYLOAD, 'payload.inputs must be the valuation inputs object') };
      const reg = await registryOf(call);
      const plan = await headOf(call, planIri, 'Plan');
      if (!plan) return { ...refuse(404, 'No such plan on this pod.', `${planIri} has no record on ${call.podUrl}`) };
      requireOperatorPerson(reg, call.actor);
      const pp = plan.record.payload;
      if (pp.planKind === 'probe') {
        return { ...refuse(409, 'This is a probe plan: Emergent work gets probes, not a point valuation; submit it as a probe decision.', `${planIri} changes Emergent work only`, via('submit_decision')) };
      }
      const ps = await planState(call, plan);
      const entered = new Set(isObj(rawInputs['tasks']) ? Object.keys(rawInputs['tasks']) : []);
      for (const row of pp.tasks) {
        if (!row.changed && !entered.has(row.taskIri)) continue;
        if (ps.tasks.get(row.taskIri)?.record.status === 'disputed') {
          return { ...refuse(409, 'A disputed task description blocks valuation until it is revised and ratified.', `${row.taskIri} is disputed`, via('revise_task')) };
        }
        if (ps.classifications.get(row.taskIri)?.record.status === 'disputed') {
          return { ...refuse(409, 'A disputed classification blocks valuation until the task is classified again.', `the classification of ${row.taskIri} is disputed`, via('classify_task')) };
        }
      }
      const stale = staleness(ps);
      if (stale) return { ...refuse(409, stale, `${planIri} was proposed against task versions that are no longer current`, via('propose_allocation')) };
      const grants = await grantChecksFor(call, reg, pp.tasks);
      const inactive = grants.find((g) => !g.active);
      if (inactive) return { ...refuse(409, `No active grant for this agent on this kind of task: ${inactive.why ?? ''}`, `${inactive.taskIri}: ${inactive.why ?? ''}`, via('grant_autonomy')) };
      const changedRows = pp.tasks.filter((r) => r.changed);
      const valuedChanged = new Set(changedRows.map((r) => r.taskIri));
      const coerced = coerceValuationInputs(rawInputs, { taskIris: pp.tasks.map((r) => r.taskIri), valuedChanged });
      if (!coerced.ok) return { ...refuse(400, 'The valuation inputs are malformed.', coerced.why) };
      const inputs = coerced.inputs;
      const expertEvidence: Array<{ taskIri: string; satisfiedBy: ExpertEvidenceBasis }> = [];
      for (const row of changedRows) {
        if (!reg.policy.regimes.get(row.regime)?.requiresExpertEvidence) continue;
        const cls = ps.classifications.get(row.taskIri);
        const role = cls?.record.payload.answeredBy.role;
        const current = inputs.tasks[row.taskIri]?.current;
        const performerInputs = current !== undefined && Object.values(current).every((t) => t.basis === 'measured' || t.basis === 'performer-reported');
        const satisfiedBy: ExpertEvidenceBasis | null = role === 'approver' ? 'approver-answers' : role === 'performer' ? 'performer-answers'
          : cls?.record.status === 'ratified' ? 'ratified-classification' : performerInputs ? 'performer-inputs' : null;
        if (!satisfiedBy) {
          return { ...refuse(409, 'Knowable work is valued only with expert analysis: classification answers from an approver or from someone named on the task, or current inputs they measured or reported.', `${row.taskIri} has none of these`, via('classify_task')) };
        }
        expertEvidence.push({ taskIri: row.taskIri, satisfiedBy });
      }
      const valuationIri = entityIri('valuation', planIri, sha256Hex(canonicalJson(inputs)));
      const existing = await headOf(call, valuationIri, 'Valuation');
      if (existing) {
        const ep = existing.record.payload;
        return {
          valuationIri, planIri, valuationHash: ep.valuationHash, seed: ep.result.seed, draws: ep.result.draws, result: ep.result,
          expertEvidence: ep.expertEvidence, unratifiedTasks: ep.unratifiedTasks, descriptorUrl: existing.loaded.descriptorUrl,
          recordId: existing.loaded.recordId, status: 'valued', recorded: true, reused: true,
        };
      }
      const agentLevelTasks = new Set(changedRows.filter((r) => reg.policy.levels.get(r.proposed.level)?.requiresAgent).map((r) => r.taskIri));
      const taskKindOf = new Map(pp.tasks.map((r) => [r.taskIri, r.taskKind]));
      const kindsNeeded = new Set(changedRows.filter((r) => agentLevelTasks.has(r.taskIri)).map((r) => r.taskKind));
      const measuredAgentCost = await measuredRunCosts(call, reg, kindsNeeded, inputs.currency);
      const result: ValuationResult = valuePlan(inputs, {
        planIri, taskOrder: pp.tasks.map((r) => r.taskIri), valuedChanged, agentLevelTasks, taskKindOf, measuredAgentCost,
        methodIri: published.valuationMethodIri, draws,
      });
      const valuationHash = sha256Hex(canonicalJson({ planIri, planDescriptorUrl: plan.loaded.descriptorUrl, inputs, result }));
      const unratifiedTasks = changedRows.filter((r) => ps.tasks.get(r.taskIri)?.record.status !== 'ratified').map((r) => r.taskIri);
      const w = await write(call, {
        kind: 'Valuation', entity: valuationIri, status: 'valued', head: null,
        payload: {
          planIri, planDescriptorUrl: plan.loaded.descriptorUrl, inputs, result, valuedTasks: [...valuedChanged], unratifiedTasks, expertEvidence,
          valuationHash, requestedBy: { did: call.actorDid, envelope: call.envelope }, policyRef: policyRefOf(reg),
        },
        signers: [signerOf(reg, call.actor, 'Curator', 'requested the valuation')],
        derivedFrom: [plan.loaded.descriptorUrl],
      });
      return {
        valuationIri, planIri, valuationHash, seed: result.seed, draws: result.draws, result, expertEvidence, unratifiedTasks,
        descriptorUrl: w.descriptorUrl, recordId: w.recordId, status: 'valued', recorded: true, reused: false,
      };
    },

    'wrd.submit_decision': async (args) => {
      const call = await openSigned(args, 'wrd:submit-decision');
      const p = call.payload;
      const planIri = needIri(p, 'planIri');
      maybe(p, 'note', LIMITS.note);
      const reg = await registryOf(call);
      const plan = await headOf(call, planIri, 'Plan');
      if (!plan) return { ...refuse(404, 'No such plan on this pod.', `${planIri} has no record on ${call.podUrl}`) };
      requireOperatorPerson(reg, call.actor);
      const pp = plan.record.payload;
      let valuation: Head<'Valuation'> | null = null;
      let measurementPlan: MeasurementPlan | undefined;
      if (pp.planKind === 'valued') {
        const valuationIri = needIri(p, 'valuationIri');
        const valuationHash = p['valuationHash'];
        if (typeof valuationHash !== 'string' || !/^[0-9a-f]{64}$/.test(valuationHash)) return { ...refuse(400, BAD_PAYLOAD, 'payload.valuationHash must be the 64-hex valuation hash wrd.value_plan returned') };
        valuation = await headOf(call, valuationIri, 'Valuation');
        if (!valuation) return { ...refuse(404, 'No such valuation on this pod.', `${valuationIri} has no record on ${call.podUrl}`, via('value_plan')) };
        if (valuation.record.payload.planIri !== planIri) return { ...refuse(409, 'This valuation is for another plan.', `${valuationIri} values ${valuation.record.payload.planIri}`) };
        if (valuation.record.payload.valuationHash !== valuationHash) return { ...refuse(409, 'The valuation hash does not match the valuation on the pod.', `the record's hash is ${valuation.record.payload.valuationHash}`, via('list_records')) };
        const mp = p['measurementPlan'];
        if (!isObj(mp) || !isOneOf(OUTCOME_METRICS, mp['metric']) || !isOneOf(COMPARISON_BASES, mp['comparisonBasis'])
          || typeof mp['windowWeeks'] !== 'number' || !Number.isInteger(mp['windowWeeks']) || mp['windowWeeks'] < 1 || mp['windowWeeks'] > 104) {
          return { ...refuse(400, 'The measurement plan is malformed.', `measurementPlan is {metric: ${OUTCOME_METRICS.join('|')}, comparisonBasis: ${COMPARISON_BASES.join('|')}, windowWeeks: 1..104, comparisonDescription?}`) };
        }
        const description = maybe(mp, 'comparisonDescription', LIMITS.note, 'measurementPlan');
        measurementPlan = { metric: mp['metric'], comparisonBasis: mp['comparisonBasis'], windowWeeks: mp['windowWeeks'], ...(description ? { comparisonDescription: description } : {}) };
      } else {
        for (const k of ['valuationIri', 'valuationHash', 'measurementPlan']) {
          if (p[k] !== undefined) return { ...refuse(400, 'A probe decision carries no valuation and no measurement plan.', `remove payload.${k}: probes are read as amplify, dampen or neither, not priced`) };
        }
      }
      const ps = await planState(call, plan);
      const changedRows = pp.tasks.filter((r) => r.changed);
      for (const row of changedRows) {
        if (ps.tasks.get(row.taskIri)?.record.status !== 'ratified') {
          return { ...refuse(409, 'Every changed task must be ratified by everyone named on it before a decision is submitted.', `${row.taskIri} is ${ps.tasks.get(row.taskIri)?.record.status ?? 'absent'}`, via('ratify_task')) };
        }
        if (ps.classifications.get(row.taskIri)?.record.status === 'disputed') {
          return { ...refuse(409, 'Someone named on a changed task disputes its classification; classify it again with them.', `the classification of ${row.taskIri} is disputed`, via('classify_task')) };
        }
      }
      const stale = staleness(ps);
      if (stale) return { ...refuse(409, stale, `${planIri} was proposed against task versions that are no longer current`, via('propose_allocation')) };
      const grantChecks = await grantChecksFor(call, reg, pp.tasks);
      const inactive = grantChecks.find((g) => !g.active);
      if (inactive) return { ...refuse(409, `No active grant for this agent on this kind of task: ${inactive.why ?? ''}`, `${inactive.taskIri}: ${inactive.why ?? ''}`, via('grant_autonomy')) };
      const decisionIri = entityIri('decision', pp.workflowIri, valuation ? `${planIri}|${valuation.record.payload.valuationHash}` : `${planIri}|probe`);
      if (await headOf(call, decisionIri, 'Decision')) return { ...refuse(409, 'This decision was already submitted.', `${decisionIri} exists`, via('list_records')) };

      const levelRank = (l: AllocationLevel): number => reg.policy.levels.get(l)?.autonomyRank ?? 0;
      const decisionLevel = changedRows.map((r) => r.proposed.level).reduce((a, b) => (levelRank(b) > levelRank(a) ? b : a), changedRows[0]?.proposed.level ?? 'person');
      const subjectAddresses = [...new Set(changedRows.flatMap((r) => [r.current.personAddress, r.proposed.personAddress]).filter((a): a is string => typeof a === 'string'))];
      const subjects = subjectAddresses.map((address) => ({ address, personRef: personRefOf(reg, address) }));
      const assignments = await assignmentStates(call, plan);
      const vp = valuation?.record.payload;
      const scenario = vp && measurementPlan ? (measurementPlan.metric === 'weekly-cash-delta' ? vp.result.scenarios.cash : vp.result.scenarios.redeployed) : null;
      const basis: ComparisonBasis | null = measurementPlan?.comparisonBasis ?? null;
      const basisLabel = basis === null ? undefined : basis === 'before-after' ? `before-after — ${NO_COMPARISON_GROUP}` : basis;
      const probes = pp.planKind === 'probe'
        ? changedRows.flatMap((r) => (r.probes ?? []).map((pr, i) => ({ taskIri: r.taskIri, index: i + 1, ...pr })))
        : undefined;
      const payload: DecisionPayload = {
        decisionKind: pp.planKind, planIri,
        ...(valuation && vp ? { valuationIri: valuation.record.entityIri, valuationHash: vp.valuationHash } : {}),
        ...(scenario && vp && measurementPlan ? { prediction: { metric: measurementPlan.metric, band: scenario.weeklyDelta, npv: scenario.npv, rampMonths: vp.inputs.rampMonths, status: 'unmeasured' as const } } : {}),
        ...(vp ? { freedHours: vp.result.freedPersonHours } : {}),
        decisionLevel, subjects, assignments,
        ...(measurementPlan ? { measurementPlan, comparisonGroup: measurementPlan.comparisonBasis !== 'before-after', basisLabel } : {}),
        ...(probes ? { probes } : {}),
        submittedBy: { did: call.actorDid, personRef: personRefOf(reg, call.actor), envelope: call.envelope },
        grantChecks: grantChecks.map((g) => ({ taskIri: g.taskIri, grantIri: g.grantIri, active: g.active, evidenceFromThisTask: g.evidenceFromThisTask })),
      };
      const w = await write(call, {
        kind: 'Decision', entity: decisionIri, status: 'submitted', payload, head: null,
        ...(pp.planKind === 'valued' ? { confidence: NOMINAL_BAND_COVERAGE } : {}),
        signers: [signerOf(reg, call.actor, 'Curator', 'submitted')],
        derivedFrom: [plan.loaded.descriptorUrl, ...(valuation ? [valuation.loaded.descriptorUrl] : [])],
      });
      return {
        decisionIri, decisionKind: pp.planKind, recordId: w.recordId, descriptorUrl: w.descriptorUrl, graphDigest: w.graphDigest, status: 'submitted',
        ...(payload.prediction ? { prediction: payload.prediction } : {}), ...(probes ? { probes } : {}),
        decisionLevel, subjects, assignments, ...(basisLabel ? { basisLabel } : {}), recorded: true,
      };
    },

    'wrd.countersign_decision': async (args) => {
      const call = await openSigned(args, 'wrd:countersign-decision');
      const p = call.payload;
      const decisionIri = needIri(p, 'decisionIri');
      const recordId = p['recordId'];
      if (typeof recordId !== 'string' || recordId === '') return { ...refuse(400, BAD_PAYLOAD, 'payload.recordId must be the record id of the head you read') };
      const b = needBinding(p);
      const verdict = p['verdict'];
      if (verdict !== 'approve' && verdict !== 'decline') return { ...refuse(400, BAD_PAYLOAD, 'payload.verdict must be approve or decline') };
      const considered = p['objectionsConsidered'] ?? [];
      if (!Array.isArray(considered) || !considered.every((x) => typeof x === 'string')) return { ...refuse(400, BAD_PAYLOAD, 'payload.objectionsConsidered must be a list of task IRIs') };
      maybe(p, 'note', LIMITS.note);
      const reg = await registryOf(call);
      const decision = await headOf(call, decisionIri, 'Decision');
      if (!decision) return { ...refuse(404, 'No such decision on this pod.', `${decisionIri} has no record on ${call.podUrl}`) };
      const dp = decision.record.payload;
      if (!holds(reg, call.actor, 'approver')) return { ...refuse(403, 'Only a registered approver can countersign.', `${call.actor} does not hold the approver role in this pod's registry`) };
      const me = personRefOf(reg, call.actor);
      if (me === dp.submittedBy.personRef || me === personRefOf(reg, dp.submittedBy.did.replace(/^did:ethr:/, ''))) {
        return { ...refuse(403, 'The person who submitted a decision cannot countersign it, from any of their registered keys.', `${call.actor} is attested as ${me}, the submitter`) };
      }
      const subjectRefs = new Set(dp.subjects.flatMap((s) => [s.personRef, personRefOf(reg, s.address)]));
      if (subjectRefs.has(me)) return { ...refuse(403, 'A person whose work this decision changes cannot countersign it.', `${call.actor} is attested as ${me}, who is named on a changed task`) };
      if (recordId !== decision.loaded.recordId || b.descriptorUrl !== decision.loaded.descriptorUrl || b.graphDigest !== decision.loaded.graphDigest) {
        return { ...refuse(409, DECISION_MOVED, `the current version is ${decision.loaded.descriptorUrl}`, via('list_records')) };
      }
      if (decision.record.status !== 'submitted') return { ...refuse(409, 'Only a submitted decision can be countersigned or declined.', `${decisionIri} is ${decision.record.status}`) };
      const plan = await headOf(call, dp.planIri, 'Plan');
      if (!plan) throw decline(409, INTEGRITY, `the decision's plan ${dp.planIri} has no trusted record`);
      const assignmentsNow = await assignmentStates(call, plan);
      let grantChecks = dp.grantChecks;
      if (verdict === 'approve') {
        const stale = staleness(await planState(call, plan));
        if (stale) return { ...refuse(409, stale, `${dp.planIri} was proposed against task versions that are no longer current`, via('propose_allocation')) };
        const checks = await grantChecksFor(call, reg, plan.record.payload.tasks);
        const inactive = checks.find((g) => !g.active);
        if (inactive) return { ...refuse(409, `No active grant for this agent on this kind of task: ${inactive.why ?? ''}`, `${inactive.taskIri}: ${inactive.why ?? ''}`, via('grant_autonomy')) };
        grantChecks = checks.map((g) => ({ taskIri: g.taskIri, grantIri: g.grantIri, active: g.active, evidenceFromThisTask: g.evidenceFromThisTask }));
        const objected = new Set(assignmentsNow.filter((a) => a.state === 'objected').map((a) => a.taskIri));
        const named = new Set(considered as string[]);
        const missing = [...objected].filter((t) => !named.has(t));
        const extra = [...named].filter((t) => !objected.has(t));
        if (missing.length > 0) {
          return { ...refuse(409, `A person named in this plan objects to their assignment on ${missing.join(', ')}: name it in objectionsConsidered to approve over it.`, 'approval must name every current objection') };
        }
        if (extra.length > 0) return { ...refuse(409, 'objectionsConsidered names tasks nobody objected to.', `no current objection on ${extra.join(', ')}`) };
      }
      const status = verdict === 'approve' ? 'countersigned' : 'declined';
      const payload: DecisionPayload = {
        ...dp,
        ...(dp.prediction && verdict === 'decline' ? { prediction: { ...dp.prediction, status: 'not-to-be-measured' as const } } : {}),
        grantChecks,
        countersign: {
          verdict, did: call.actorDid, personRef: me, envelope: call.envelope, objectionsConsidered: considered as string[],
          assignmentsAtCountersign: assignmentsNow, at: call.at,
        },
      };
      const w = await write(call, {
        kind: 'Decision', entity: decisionIri, status, payload, head: decision,
        signers: [
          signerOf(reg, dp.submittedBy.did.replace(/^did:ethr:/, ''), 'Curator', 'submitted'),
          signerOf(reg, call.actor, 'Validator', status),
        ],
      });
      return {
        decisionIri, status, statusLabel: statusLabelOf(status, dp.decisionKind), recordId: w.recordId, descriptorUrl: w.descriptorUrl, graphDigest: w.graphDigest,
        countersignedBy: { did: call.actorDid, personRef: me }, assignments: assignmentsNow, grantChecks, recorded: true,
      };
    },

    'wrd.record_outcome': async (args) => {
      const call = await openSigned(args, 'wrd:record-outcome');
      const p = call.payload;
      const decisionIri = needIri(p, 'decisionIri');
      const recordId = p['recordId'];
      if (typeof recordId !== 'string' || recordId === '') return { ...refuse(400, BAD_PAYLOAD, 'payload.recordId must be the record id of the head you read') };
      const b = needBinding(p);
      const reg = await registryOf(call);
      const decision = await headOf(call, decisionIri, 'Decision');
      if (!decision) return { ...refuse(404, 'No such decision on this pod.', `${decisionIri} has no record on ${call.podUrl}`) };
      const dp = decision.record.payload;
      if (!holds(reg, call.actor, 'operator') && !holds(reg, call.actor, 'approver')) {
        return { ...refuse(403, 'Only a registered operator or approver can record an outcome.', `${call.actor} holds neither role in this pod's registry`) };
      }
      const me = personRefOf(reg, call.actor);
      const submitter = dp.submittedBy.did.replace(/^did:ethr:/, '');
      if (me === dp.submittedBy.personRef || me === personRefOf(reg, submitter)) {
        return { ...refuse(403, 'The person who predicted cannot grade the prediction.', `${call.actor} is attested as ${me}, the submitter`) };
      }
      if (recordId !== decision.loaded.recordId || b.descriptorUrl !== decision.loaded.descriptorUrl || b.graphDigest !== decision.loaded.graphDigest) {
        return { ...refuse(409, DECISION_MOVED, `the current version is ${decision.loaded.descriptorUrl}`, via('list_records')) };
      }
      if (decision.record.status !== 'countersigned' || !dp.countersign || dp.countersign.verdict !== 'approve') {
        return { ...refuse(409, 'An outcome can be recorded only for a countersigned decision.', `${decisionIri} is ${decision.record.status}`, via('countersign_decision')) };
      }
      // The countersign is weeks old by design: re-verify the stored envelope against the CURRENT registry, never the modal status alone.
      const cs = dp.countersign;
      const stored = verifyStoredEnvelope(cs.envelope, 'wrd:countersign-decision', call.podUrl);
      const approver = stored.ok ? stored.signer : '';
      const approverRef = approver ? personRefOf(reg, approver) : '';
      const subjectRefs = new Set(dp.subjects.flatMap((s) => [s.personRef, personRefOf(reg, s.address)]));
      const boundTo = cs.envelope.payload;
      if (!stored.ok || !holds(reg, approver, 'approver') || approverRef === dp.submittedBy.personRef || approverRef === personRefOf(reg, submitter)
        || subjectRefs.has(approverRef) || boundTo['decisionIri'] !== decisionIri || boundTo['verdict'] !== 'approve') {
        return { ...refuse(409, 'The countersign on this decision no longer verifies.', stored.ok ? `${approver} is no longer a registered approver who is neither the submitter nor a subject` : stored.why) };
      }
      const disposition = p['disposition'];
      const dispositionNote = maybe(p, 'dispositionNote', LIMITS.note);
      const windows: Array<{ windowStart: unknown; windowEnd: unknown }> = [];
      const probeResults = p['probeResults'];
      if (dp.decisionKind === 'valued') {
        const m = p['measured'];
        windows.push(isObj(m) ? { windowStart: m['windowStart'], windowEnd: m['windowEnd'] } : { windowStart: undefined, windowEnd: undefined });
      } else {
        if (!Array.isArray(probeResults)) return { ...refuse(400, BAD_PAYLOAD, 'payload.probeResults must list one result per probe') };
        for (const r of probeResults) windows.push(isObj(r) ? { windowStart: r['windowStart'], windowEnd: r['windowEnd'] } : { windowStart: undefined, windowEnd: undefined });
      }
      for (const win of windows) {
        const bad = checkOutcomeWindow({ countersignedAt: cs.at, windowStart: String(win.windowStart ?? ''), windowEnd: String(win.windowEnd ?? ''), now: call.now });
        if (bad) return { ...refuse(bad.status, bad.status === 409 ? bad.why : 'The measurement window is malformed.', bad.detail) };
      }
      if (!isOneOf(OUTCOME_DISPOSITIONS, disposition)) return { ...refuse(400, BAD_PAYLOAD, `payload.disposition must be one of ${OUTCOME_DISPOSITIONS.join(', ')}`) };
      if (disposition !== 'kept' && !dispositionNote) return { ...refuse(400, 'Say what happened: a reverted or stopped change needs a note.', 'payload.dispositionNote is required unless the change was kept') };

      let outcome: NonNullable<DecisionPayload['outcome']>;
      let reply: Obj;
      if (dp.decisionKind === 'valued') {
        const measured = coerceMeasured(p['measured']);
        const prediction = dp.prediction;
        if (!prediction || !dp.measurementPlan) throw decline(409, INTEGRITY, `${decisionIri} is valued but carries no prediction`);
        const graded = gradeOutcome({
          band: prediction.band, rampMonths: prediction.rampMonths, countersignedAt: cs.at, windowStart: measured.windowStart, windowEnd: measured.windowEnd,
          measured: measured.weeklyValueDelta, ...(measured.interval ? { interval: measured.interval } : {}),
        });
        let pilotCheck: { runsNeeded: number; runsObserved: number; criticalFailuresObserved: number; ceilingSupported: boolean } | undefined;
        if (measured.runsObserved !== undefined && dp.valuationIri) {
          const valuation = await headOf(call, dp.valuationIri, 'Valuation');
          const needed = Math.max(0, ...(valuation?.record.payload.result.pilot.map((x) => x.runsNeeded) ?? []));
          if (needed > 0) {
            const crit = measured.criticalFailuresObserved ?? 0;
            pilotCheck = { runsNeeded: needed, runsObserved: measured.runsObserved, criticalFailuresObserved: crit, ceilingSupported: measured.runsObserved >= needed && crit === 0 };
          }
        }
        const valued = {
          measured, metric: prediction.metric, verdict: graded.verdict, adjustedBand: graded.adjustedBand, rampFactor: graded.rampFactor,
          rampAdjusted: graded.rampAdjusted, basisChanged: measured.comparisonBasis !== dp.measurementPlan.comparisonBasis, ...(pilotCheck ? { pilotCheck } : {}),
        };
        outcome = { did: call.actorDid, personRef: me, envelope: call.envelope, disposition, ...(dispositionNote ? { dispositionNote } : {}), at: call.at, valued };
        const comparisonGroup = measured.comparisonBasis !== 'before-after';
        reply = {
          valued: {
            verdict: graded.verdict, predictedBand: prediction.band, adjustedBand: graded.adjustedBand, rampFactor: graded.rampFactor, rampAdjusted: graded.rampAdjusted,
            measured: measured.weeklyValueDelta, comparisonGroup, basisLabel: comparisonGroup ? measured.comparisonBasis : `before-after — ${NO_COMPARISON_GROUP}`,
            ...(pilotCheck ? { pilotCheck } : {}),
          },
        };
      } else {
        const declared = dp.probes ?? [];
        const results = (probeResults as unknown[]).map((raw, i) => {
          if (!isObj(raw)) throw decline(400, BAD_PAYLOAD, `probeResults[${i}] must be an object`);
          const taskIri = raw['taskIri'];
          const index = raw['index'];
          const signal = raw['signal'];
          const probe = declared.find((d) => d.taskIri === taskIri && d.index === index);
          if (!probe) throw decline(400, 'A probe result names no declared probe.', `probeResults[${i}] names ${String(taskIri)} #${String(index)}`);
          if (!isOneOf(PROBE_SIGNALS, signal)) throw decline(400, BAD_PAYLOAD, `probeResults[${i}].signal must be one of ${PROBE_SIGNALS.join(', ')}`);
          const observed = need(raw, 'observed', LIMITS.note, `probeResults[${i}]`);
          const windowStart = String(raw['windowStart']);
          const windowEnd = String(raw['windowEnd']);
          const weeks = (Date.parse(windowEnd) - Date.parse(windowStart)) / (7 * 86_400_000);
          return { taskIri: probe.taskIri, index: probe.index, signal, observed, windowStart, windowEnd, pastTimebox: weeks > probe.timeboxWeeks };
        });
        const keys = new Set(results.map((r) => `${r.taskIri}#${r.index}`));
        if (keys.size !== results.length || results.length !== declared.length) {
          return { ...refuse(400, 'Record exactly one result per declared probe.', `${declared.length} probes were declared; ${results.length} results with ${keys.size} distinct probes were sent`) };
        }
        outcome = { did: call.actorDid, personRef: me, envelope: call.envelope, disposition, ...(dispositionNote ? { dispositionNote } : {}), at: call.at, probes: results };
        reply = {
          probes: results.map((r) => ({ taskIri: r.taskIri, index: r.index, signal: r.signal, pastTimebox: r.pastTimebox })),
          ...(results.some((r) => r.signal !== 'neither') ? { next: NEXT_RECLASSIFY } : {}),
        };
      }
      const payload: DecisionPayload = {
        ...dp, ...(dp.prediction ? { prediction: { ...dp.prediction, status: 'measured' as const } } : {}), outcome,
      };
      const w = await write(call, {
        kind: 'Decision', entity: decisionIri, status: 'measured', payload, head: decision,
        signers: [
          signerOf(reg, submitter, 'Curator', 'submitted'),
          signerOf(reg, approver, 'Validator', 'countersigned'),
          signerOf(reg, call.actor, 'Curator', 'measured'),
        ],
      });
      return { decisionIri, status: 'measured', disposition, ...reply, descriptorUrl: w.descriptorUrl, recordId: w.recordId, graphDigest: w.graphDigest, recorded: true };
    },

    'wrd.log_agent_run': async (args) => {
      const runRaw = args['run_envelope'];
      const reviewRaw = args['review_envelope'];
      const call = await openCall(args, runRaw, true);
      // The run may be an hour old (logged under a grant, reviewed later): check it as a stored envelope first, freshness later.
      const runOpened = openEnvelope(runRaw, 'wrd:agent-run', call.podUrl, call.now, { pastMs: Number.POSITIVE_INFINITY, futureMs: window.futureMs });
      if (!runOpened.ok) return { ...refuse(runOpened.status, runOpened.error, `run_envelope: ${runOpened.why}`) };
      let review: Extract<ReturnType<typeof openEnvelope>, { ok: true }> | null = null;
      if (reviewRaw !== undefined && reviewRaw !== null) {
        const r = openEnvelope(reviewRaw, 'wrd:review-agent-run', call.podUrl, call.now, window);
        if (!r.ok) return { ...refuse(r.status, r.error, `review_envelope: ${r.why}`) };
        // The review authorises this call: its nonce is claimed as soon as it verifies, like every other write's envelope.
        if (!ledger.claim(r.signer, String(r.payload['nonce']), call.now)) return { ...refuse(409, REPLAYED, `${r.signer} already used the nonce ${String(r.payload['nonce'])}`) };
        review = r;
      }
      const rp = runOpened.payload;
      const runId = rp['runId'];
      if (typeof runId !== 'string' || !/^[A-Za-z0-9_.-]{1,80}$/.test(runId)) return { ...refuse(400, BAD_PAYLOAD, 'run payload.runId must be 1 to 80 of [A-Za-z0-9_.-]') };
      const taskIri = needIri(rp, 'taskIri');
      const taskKind = rp['taskKind'];
      if (typeof taskKind !== 'string' || !TASK_KIND_SLUG.test(taskKind)) return { ...refuse(400, BAD_PAYLOAD, 'run payload.taskKind must be a task kind slug') };
      const model = need(rp, 'model', 120, 'run payload');
      const outputSha256 = rp['outputSha256'];
      if (typeof outputSha256 !== 'string' || !/^[0-9a-f]{64}$/.test(outputSha256)) return { ...refuse(400, BAD_PAYLOAD, 'run payload.outputSha256 must be 64 lowercase hex characters') };
      const sa = rp['selfAssessment'];
      if (!isObj(sa) || !isOneOf(RUN_ALTERNATIVES, sa['answer'])) return { ...refuse(400, BAD_PAYLOAD, `run payload.selfAssessment.answer must be one of ${RUN_ALTERNATIVES.join(', ')}`) };
      const probabilities = coerceProbabilities(sa['probabilities']);
      if (probabilities === null) return { ...refuse(400, BAD_PAYLOAD, 'run payload.selfAssessment.probabilities must map the run verdicts to numbers in [0, 1] that do not all equal 0') };
      const underGrant = rp['underGrant'];
      if (underGrant !== undefined && typeof underGrant !== 'string') return { ...refuse(400, BAD_PAYLOAD, 'run payload.underGrant must be a grant IRI') };
      const cost = rp['costPerRun'];
      if (cost !== undefined && (!isObj(cost) || typeof cost['amount'] !== 'number' || !Number.isFinite(cost['amount']) || cost['amount'] < 0
        || typeof cost['currency'] !== 'string' || !/^[A-Z]{3}$/.test(cost['currency']))) {
        return { ...refuse(400, BAD_PAYLOAD, 'run payload.costPerRun must be {amount >= 0, currency: ISO 4217}') };
      }
      if (!isIsoInstant(rp['performedAt'])) return { ...refuse(400, BAD_PAYLOAD, 'run payload.performedAt must be an ISO-8601 date-time') };
      const agent = runOpened.signer;
      const reg = await registryOf(call);
      const entity = entityIri('run', `${agent}|${taskKind}`, runId);
      const head = await headOf(call, entity, 'AgentRun');
      if (head && head.record.status === 'reviewed') return { ...refuse(409, 'This run was already reviewed.', `${entity} is reviewed`) };
      if (head && !review) return { ...refuse(409, 'This run is already logged under its grant; a person reviews it next.', `${entity} is acted-under-grant`, via('log_agent_run')) };
      if (head) {
        if (envelopeSha256(runOpened.envelope) !== envelopeSha256(head.record.payload.runEnvelope)) {
          return { ...refuse(409, 'This is not the run envelope that was logged.', 'the stored run envelope differs from the one sent') };
        }
      } else {
        const issued = Date.parse(String(rp['issuedAt']));
        if (issued < call.now.getTime() - window.pastMs) return { ...refuse(401, 'The envelope is stale or from the future.', 'run_envelope: issuedAt is older than the freshness window allows for a run logged now') };
        if (!ledger.claim(agent, String(rp['nonce']), call.now)) return { ...refuse(409, REPLAYED, `${agent} already used the nonce ${String(rp['nonce'])}`) };
      }
      if (!isAgent(reg, agent)) {
        return { ...refuse(403, 'Only a registered software agent can log a run.', `${agent}, the address recovered from run_envelope, is not a registered agent`, via('update_registry')) };
      }
      const member = memberOf(reg, agent);
      if (member?.model !== model) {
        return { ...refuse(409, `This agent's declared model is ${member?.model ?? 'none'}; the run names ${model}. An admin updates the registry first.`, 'runs count only on the model the registry declares', via('update_registry')) };
      }
      const task = await taskHead(call, taskIri);
      if (task.record.payload.taskKind !== taskKind) return { ...refuse(400, 'The run names a different kind of task than the task has.', `${taskIri} is ${task.record.payload.taskKind}, the run says ${taskKind}`) };
      let reviewPart: { verdict: RunAnswer; did: string; address: string; personRef: string; envelope: SignedEnvelope; at: string } | undefined;
      if (review) {
        const reviewer = review.signer;
        if (!holds(reg, reviewer, 'operator') && !holds(reg, reviewer, 'approver')) {
          return { ...refuse(403, 'Only a registered operator or approver can review a run.', `${reviewer} holds neither role in this pod's registry`) };
        }
        if (reviewer === agent) return { ...refuse(403, 'An agent cannot review its own run.', 'the reviewer is the agent') };
        if (member?.principal && personRefOf(reg, reviewer) === personRefOf(reg, member.principal)) {
          return { ...refuse(403, 'The person accountable for this agent cannot review its runs.', `${reviewer} is attested as the agent's principal`) };
        }
        if (review.payload['runEnvelopeSha256'] !== envelopeSha256(runOpened.envelope)) {
          return { ...refuse(400, 'The review names a different run envelope.', 'review payload.runEnvelopeSha256 must equal envelopeSha256(run_envelope)') };
        }
        const rv = review.payload['verdict'];
        if (!isOneOf(RUN_ALTERNATIVES, rv)) return { ...refuse(400, BAD_PAYLOAD, `review payload.verdict must be one of ${RUN_ALTERNATIVES.join(', ')}`) };
        maybe(review.payload, 'note', LIMITS.note, 'review payload');
        reviewPart = { verdict: rv, did: review.did, address: reviewer, personRef: personRefOf(reg, reviewer), envelope: review.envelope, at: call.at };
      } else {
        if (underGrant === undefined) return { ...refuse(400, "An agent run outside a grant needs a person's review.", 'send review_envelope, or log the run under an active grant (underGrant)') };
        const g = await grantState(call, reg, agent, taskKind);
        if (!g.active) return { ...refuse(409, `This grant is not active: ${g.why}`, g.why, via('grant_autonomy')) };
        if (g.grantIri !== underGrant) return { ...refuse(409, 'This grant is not active: the run names a different grant.', `the active grant for ${agent} on ${taskKind} is ${g.grantIri}`) };
      }
      const status = reviewPart ? 'reviewed' : 'acted-under-grant';
      // The record id carries the nonce of the envelope that authorises THIS write: the review's when there is one.
      const authorising: Signed = review
        ? { ...call, actor: review.signer, actorDid: review.did, payload: review.payload, envelope: review.envelope, nonce: String(review.payload['nonce']) }
        : { ...call, actor: agent, actorDid: runOpened.did, payload: rp, envelope: runOpened.envelope, nonce: String(rp['nonce']) };
      const w = await write(authorising, {
        kind: 'AgentRun', entity, status, head,
        payload: {
          agentDid: didOf(agent), agentAddress: agent, principal: member?.principal ?? '', model, runId, taskIri, taskKind, outputSha256,
          selfAssessment: { answer: sa['answer'], ...(probabilities ? { probabilities } : {}) }, underGrant: typeof underGrant === 'string' ? underGrant : null,
          ...(isObj(cost) ? { costPerRun: { amount: Number(cost['amount']), currency: String(cost['currency']) } } : {}),
          runEnvelope: runOpened.envelope, ...(reviewPart ? { review: reviewPart } : {}),
        },
        signers: [signerOf(reg, agent, 'Curator', 'ran'), ...(reviewPart ? [signerOf(reg, reviewPart.address, 'Validator', 'reviewed')] : [])],
        derivedFrom: [task.loaded.descriptorUrl],
      });
      return { runIri: entity, status, ...(reviewPart ? { verdict: reviewPart.verdict } : {}), countsTowardCalibration: status === 'reviewed', descriptorUrl: w.descriptorUrl, recordId: w.recordId, recorded: true };
    },

    'wrd.grant_autonomy': async (args) => {
      const call = await openSigned(args, 'wrd:grant-autonomy');
      const agentAddress = call.payload['agentAddress'];
      if (!isAddress(agentAddress)) return { ...refuse(400, BAD_PAYLOAD, 'payload.agentAddress must be a 0x address') };
      const agent = lower(agentAddress);
      const taskKind = call.payload['taskKind'];
      if (typeof taskKind !== 'string' || !TASK_KIND_SLUG.test(taskKind)) return { ...refuse(400, BAD_PAYLOAD, 'payload.taskKind must be a task kind slug') };
      const reg = await registryOf(call);
      if (!holds(reg, call.actor, 'approver')) return { ...refuse(403, 'Only a registered approver can grant autonomy.', `${call.actor} does not hold the approver role in this pod's registry`) };
      if (!isAgent(reg, agent)) return { ...refuse(403, 'Grants are for registered software agents only; people are never given enforced grants.', `${agent} is not a registered software agent`) };
      const member = memberOf(reg, agent);
      if (member?.principal && personRefOf(reg, call.actor) === personRefOf(reg, member.principal)) {
        return { ...refuse(403, 'The person accountable for this agent cannot grant it autonomy.', `${call.actor} is attested as the agent's principal`) };
      }
      const kind = kindUsable(reg, taskKind);
      if (!kind) return { ...refuse(400, UNKNOWN_KIND, `${taskKind}: ${KIND_FIX}`, via('update_registry')) };
      const entity = grantEntity(call, agent, taskKind);
      const head = await headOf(call, entity, 'Grant');
      if (head && head.record.status === 'granted') return { ...refuse(409, 'This agent already holds a grant on this kind of task.', `${entity} is granted; revoke it first to re-evaluate`, via('revoke_grant')) };
      const since = head && head.record.status === 'revoked' ? head.record.payload.revocation?.at ?? head.loaded.validUntil : null;
      const runs: ReviewedRun[] = [];
      for (const g of await call.view.graphIris(scopePrefix('run', `${agent}|${taskKind}`))) {
        const run = headIn(await call.view.graph(g), 'AgentRun');
        const r = run ? reviewedRunOf(run.record) : null;
        if (r) runs.push(r);
      }
      const evaluation = evaluateGrant({
        agentDid: didOf(agent), taskKind, model: member?.model ?? '', runs, policy: reg.policy.grantPolicy, attestor: call.platformRef.did,
        since, now: call.now, grantGraphUrl: graphIriOf(entity),
      });
      if (!evaluation.earned) {
        return { ...refuse(409, 'This agent has not earned a grant on this kind of task yet.', evaluation.why, via('log_agent_run')), evaluation };
      }
      const w = await write(call, {
        kind: 'Grant', entity, status: 'granted', head,
        payload: {
          agentAddress: agent, agentDid: didOf(agent), principal: member?.principal ?? '', model: member?.model ?? '', taskKind, taskKindDefinition: kind.definition,
          policy: reg.policy.grantPolicy, evaluation, grantedBy: { did: call.actorDid, personRef: personRefOf(reg, call.actor), envelope: call.envelope },
          policyRef: policyRefOf(reg),
        },
        signers: [signerOf(reg, call.actor, 'Curator', 'granted')],
      });
      return {
        grantIri: entity, agentAddress: agent, principal: member?.principal ?? null, model: member?.model ?? null, taskKind, status: 'granted', evaluation,
        descriptorUrl: w.descriptorUrl, recordId: w.recordId, recorded: true,
      };
    },

    'wrd.revoke_grant': async (args) => {
      const call = await openSigned(args, 'wrd:revoke-grant');
      const p = call.payload;
      const grantIri = needIri(p, 'grantIri');
      const recordId = p['recordId'];
      const descriptorUrl = p['descriptorUrl'];
      if (typeof recordId !== 'string' || typeof descriptorUrl !== 'string') return { ...refuse(400, BAD_PAYLOAD, 'payload.recordId and payload.descriptorUrl must name the grant head you read') };
      const why = need(p, 'why', LIMITS.note);
      const reg = await registryOf(call);
      if (!holds(reg, call.actor, 'approver')) return { ...refuse(403, 'Only a registered approver can revoke a grant.', `${call.actor} does not hold the approver role in this pod's registry`) };
      const head = await headOf(call, grantIri, 'Grant');
      if (!head) return { ...refuse(404, 'No such grant on this pod.', `${grantIri} has no record on ${call.podUrl}`) };
      if (recordId !== head.loaded.recordId || descriptorUrl !== head.loaded.descriptorUrl) {
        return { ...refuse(409, 'The grant changed since you read it.', `the current version is ${head.loaded.descriptorUrl}`, via('list_records')) };
      }
      if (head.record.status === 'revoked') return { ...refuse(409, 'This grant was already revoked.', `${grantIri} is revoked`) };
      const grantedFrom = head.loaded.validFrom;
      if (!grantedFrom || Date.parse(grantedFrom) >= call.now.getTime()) return { ...refuse(409, CLOCK_SKEW, `the grant is valid from ${grantedFrom ?? 'an unknown time'}`) };
      const w = await write(call, {
        kind: 'Grant', entity: grantIri, status: 'revoked', head, validFrom: grantedFrom, validUntil: call.at,
        payload: { ...head.record.payload, revocation: { did: call.actorDid, envelope: call.envelope, why, at: call.at } },
        signers: [signerOf(reg, call.actor, 'Validator', 'revoked')],
      });
      return { grantIri, status: 'revoked', revokedAt: call.at, why, descriptorUrl: w.descriptorUrl, recordId: w.recordId, recorded: true };
    },

    'wrd.holder_copy': async (args) => {
      const call = await openSigned(args, 'wrd:holder-copy');
      const rawTarget = call.payload['targetPodUrl'];
      let target: string | null = null;
      if (rawTarget !== undefined && rawTarget !== null) {
        if (typeof rawTarget !== 'string') return { ...refuse(400, 'The target pod must be an http(s) URL.', 'payload.targetPodUrl must be a string') };
        try { target = normalisePodUrl(rawTarget); } catch (e) { return { ...refuse(400, 'The target pod must be an http(s) URL.', messageOf(e)) }; }
        if (target === call.podUrl) return { ...refuse(400, 'Copies go to a pod you hold, not to this one.', 'payload.targetPodUrl is the platform pod') };
      }
      const reg = await registryOf(call);
      const snap = await snapshot(call.view);
      const me = call.actor;
      const lines = new Map<string, LoadedRecord[]>();
      for (const s of snap.graphs) if (s.g.state === 'ok') lines.set(s.graphIri, await call.view.history(s.g));
      const selected = new Set<string>();
      const myTasks = new Set<string>();
      const recs = (g: string): WrdRecord[] => (lines.get(g) ?? []).flatMap((l) => (l.record ? [l.record] : []));
      for (const g of lines.keys()) {
        const versions = recs(g);
        const last = versions[versions.length - 1];
        if (!last || last.recordKind === 'HolderCopy') continue;
        if (versions.some((v) => v.signers.some((s) => s.address === me))) selected.add(g);
        if (last.recordKind === 'Task' && versions.some((v) => v.recordKind === 'Task' && v.payload.namedParties.includes(me))) { selected.add(g); myTasks.add(last.entityIri); }
        if ((last.recordKind === 'AgentRun' || last.recordKind === 'Grant') && last.payload.agentAddress === me) selected.add(g);
      }
      const myPlans = new Set<string>();
      for (const g of lines.keys()) {
        const last = recs(g).at(-1);
        if (!last) continue;
        if (last.recordKind === 'Task' && myTasks.has(last.entityIri)) selected.add(graphIriOf(last.payload.workflowIri));
        if (last.recordKind === 'Classification' && myTasks.has(last.payload.taskIri)) selected.add(g);
        if (last.recordKind === 'AgentRun' && myTasks.has(last.payload.taskIri)) selected.add(g);
        if (last.recordKind === 'Plan' && last.payload.tasks.some((r) => r.changed
          && [r.current.personAddress, r.current.agentAddress, r.proposed.personAddress, r.proposed.agentAddress].includes(me))) {
          selected.add(g);
          myPlans.add(last.entityIri);
        }
      }
      for (const g of lines.keys()) {
        const last = recs(g).at(-1);
        if (!last) continue;
        if ((last.recordKind === 'Valuation' || last.recordKind === 'Decision' || last.recordKind === 'Acknowledgement') && myPlans.has(last.payload.planIri)) selected.add(g);
      }
      const chains = [...selected].filter((g) => lines.has(g)).sort();
      if (chains.length === 0) return { ...refuse(403, 'No record on this pod names this address or carries its signature.', `${me} is named in nothing and signed nothing here`) };
      const bundle = chains.flatMap((g) => (lines.get(g) ?? []).map((l) => ({
        descriptorUrl: l.descriptorUrl, recordKind: l.record?.recordKind ?? null, entityIri: l.record?.entityIri ?? null,
        descriptorTurtle: l.descriptorTurtle, graphTrig: l.graphContent,
      })));
      const copied: Array<{ originalDescriptorUrl: string; copyDescriptorUrl: string | null; skipped: boolean }> = [];
      if (target !== null) {
        let targetFetch: FetchFn;
        try { targetFetch = await openPod(target, deps.fetchFn); } catch (e) { return { ...refuse(400, 'The target pod is not a safe target.', messageOf(e)) }; }
        let existing: Set<string>;
        try {
          existing = new Set((await fetchAllManifestEntries(predictManifestUrl(target), targetFetch)).entries.map((e) => e.descriptorUrl));
        } catch (e) {
          throw new PodReadError(`the holder's pod manifest could not be read: ${messageOf(e)}`, null);
        }
        for (const g of chains) {
          let prev: string | null = null;
          for (const l of lines.get(g) ?? []) {
            const r = await copyRecordToHolder(l, { targetPodUrl: target, fetchFn: targetFetch, previousCopyUrl: prev, existing });
            copied.push({ originalDescriptorUrl: l.descriptorUrl, copyDescriptorUrl: r.descriptorUrl, skipped: r.skipped });
            prev = r.descriptorUrl;
          }
        }
      }
      const status = target === null ? 'exported' : 'copied';
      const w = await write(call, {
        kind: 'HolderCopy', entity: entityIri('holder-copy', me, `${target ?? 'export'}|${call.nonce}`), status, head: null,
        payload: { holder: { address: me, did: call.actorDid }, targetPodUrl: target, copied, envelope: call.envelope },
        signers: [signerOf(reg, me, 'Curator', status === 'copied' ? 'copied their record' : 'exported their record')],
      });
      return { holder: { address: me, did: call.actorDid }, status, targetPodUrl: target, copied, bundle, receiptUrl: w.descriptorUrl, recorded: true };
    },

    'wrd.list_records': async (args) => {
      const kind = typeof args['kind'] === 'string' && args['kind'] !== '' ? args['kind'] : null;
      const sections = ['registry', 'workflows', 'tasks', 'plans', 'valuations', 'decisions', 'grants', 'runs'];
      if (kind !== null && !sections.includes(kind)) return { ...refuse(400, 'Unknown kind.', `kind must be one of ${sections.join(', ')}`) };
      const subject = typeof args['subject'] === 'string' && args['subject'] !== '' ? args['subject'] : null;
      const workflowFilter = typeof args['workflow'] === 'string' && args['workflow'] !== '' ? args['workflow'] : null;
      const want = (s: string): boolean => kind === null || kind === s;
      const keep = (iri: string, workflowIri: string | null): boolean => (subject === null || subject === iri) && (workflowFilter === null || workflowFilter === workflowIri);
      const call = await openCall(args, undefined, false);
      const reg = await registryOf(call);
      const snap = await snapshot(call.view);
      const policy = reg.policy;

      const tasksRec = recordsOf(snap, 'Task');
      const graphByIri = new Map(snap.graphs.map((s) => [s.graphIri, s]));
      const classificationByTask = new Map(recordsOf(snap, 'Classification').map((c) => [c.record.payload.taskIri, c]));
      const plansRec = recordsOf(snap, 'Plan');
      const planByIri = new Map(plansRec.map((pl) => [pl.record.entityIri, pl]));
      const decisionsRec = recordsOf(snap, 'Decision');
      const runsRec = recordsOf(snap, 'AgentRun');
      const workflowsRec = recordsOf(snap, 'Workflow');
      const workflowOfPlan = (planIri: string): string | null => planByIri.get(planIri)?.record.payload.workflowIri ?? null;
      const label = (a: string): string => memberOf(reg, a)?.label ?? a;
      const demoRecords = snap.graphs.filter((s) => s.record?.demo === true).length;
      const records = snap.graphs.filter((s) => s.record !== null).length;

      const effective = new Map<string, { allocation: Allocation; decisionIri: string; at: string }>();
      for (const d of decisionsRec) {
        const o = d.record.payload.outcome;
        if (d.record.status !== 'measured' || d.record.payload.decisionKind !== 'valued' || !o || o.disposition !== 'kept') continue;
        for (const row of planByIri.get(d.record.payload.planIri)?.record.payload.tasks ?? []) {
          const prev = effective.get(row.taskIri);
          if (row.changed && (!prev || prev.at < o.at)) effective.set(row.taskIri, { allocation: row.proposed, decisionIri: d.record.entityIri, at: o.at });
        }
      }
      const listedTasks = new Set(workflowsRec.flatMap((w) => [...w.record.payload.taskIris, ...w.record.payload.retiredTaskIris]));
      const acks = new Map(recordsOf(snap, 'Acknowledgement').map((a) => [`${a.record.payload.planIri}|${a.record.payload.taskIri}|${a.record.payload.personAddress}`, a.record]));

      const out: Obj = {
        podUrl: call.podUrl, complete: snap.complete, status: 'listed', readExposure: READ_EXPOSURE, records, demoRecords, demoLabel: demoRecords > 0 ? DEMO_LABEL : null,
        bridge: {
          platform: call.platformRef, admins: admins.size,
          demo: { enabled: demo !== null, personas: demo ? [...demo.values()].map((d) => ({ id: d.id, label: d.label, address: lower(d.wallet.address) })) : [] },
        },
        vocabulary: {
          questions: CLASSIFICATION_QUESTIONS,
          regimes: [...policy.regimes.values()].map((r) => ({ regime: r.regime, method: r.method, permitsChange: r.permitsChange, requiresProbe: r.requiresProbe, pointValuation: r.pointValuation, requiresExpertEvidence: r.requiresExpertEvidence, permittedLevels: r.permittedLevels, note: r.note })),
          levels: [...policy.levels.values()].sort((x, y) => x.autonomyRank - y.autonomyRank).map((l) => ({ level: l.level, requiresAgent: l.requiresAgent, requiresPerson: l.requiresPerson, requiresGrant: l.requiresGrant, requiresCheckability: l.requiresCheckability })),
          rules: [...policy.rules.values()].map((r) => ({ id: r.id, iri: r.iri, condition: r.condition })),
          grantPolicy: policy.grantPolicy, podPolicy: reg.podPolicy, comparisonBases: COMPARISON_BASES, metrics: OUTCOME_METRICS, inputBases: INPUT_BASES,
          dispositions: { freedHours: FREED_HOURS_DISPOSITIONS, outcome: OUTCOME_DISPOSITIONS }, distinctPeopleNote: DISTINCT_PEOPLE_NOTE, ontologySha256: published.ontologySha256,
        },
      };
      if (want('registry')) {
        out['registry'] = { members: [...reg.members.values()], taskKinds: [...reg.kinds.values()], head: reg.head ? headInfo(reg.head.loaded) : null };
      }
      if (want('workflows')) {
        out['workflows'] = workflowsRec.filter((w) => keep(w.record.entityIri, w.record.entityIri)).map((w) => {
          const p = w.record.payload;
          return {
            workflowIri: w.record.entityIri, title: p.title, unitLabel: p.unitLabel, ...(p.description ? { description: p.description } : {}), captureMode: p.captureMode,
            capturedBy: p.capturedBy.did, ...(p.document ? { document: p.document } : {}), ...(p.documentText !== undefined ? { documentText: p.documentText } : {}),
            draftedBy: p.draftedBy ?? (p.captureMode === 'document' ? NOT_DECLARED : null), ...(p.draftSha256 ? { draftSha256: p.draftSha256 } : {}),
            taskIris: p.taskIris, retiredTaskIris: p.retiredTaskIris, head: headInfo(w.head), demo: w.record.demo === true,
          };
        });
      }
      if (want('tasks')) {
        out['tasks'] = tasksRec.filter((t) => keep(t.record.entityIri, t.record.payload.workflowIri)).map((t) => {
          const p = t.record.payload;
          const cls = classificationByTask.get(t.record.entityIri);
          const clsGraph = graphByIri.get(graphIriOf(classificationEntity(p.workflowIri, t.record.entityIri)));
          const eff = effective.get(t.record.entityIri);
          const reviewed = runsRec.filter((r) => r.record.status === 'reviewed' && r.record.payload.taskIri === t.record.entityIri);
          const reworked = reviewed.filter((r) => r.record.payload.review?.verdict !== 'accepted').length;
          const critical = reviewed.filter((r) => r.record.payload.review?.verdict === 'critical-failure').length;
          const share = reviewed.length > 0 ? reworked / reviewed.length : 0;
          const suggest = (reviewed.length >= policy.grantPolicy.contraryMinRuns && share > policy.grantPolicy.contraryReworkShare) || critical > 0;
          return {
            taskIri: t.record.entityIri, workflowIri: p.workflowIri, name: p.name, description: p.description, current: p.current, performer: p.performer,
            namedParties: p.namedParties.map((a) => {
              const r = p.ratifications.find((x) => x.party === a);
              return { address: a, kind: isAgent(reg, a) ? 'agent' : isPerson(reg, a) ? 'person' : 'unregistered', label: label(a), ratification: r ? { verdict: r.verdict, ...(r.note ? { note: r.note } : {}), at: r.at } : null };
            }),
            taskKind: p.taskKind, taskKindDefinition: p.taskKindDefinition, ...(p.externalTaskTerm ? { externalTaskTerm: p.externalTaskTerm } : {}),
            effective: eff ? { ...eff.allocation, source: 'measured-decision', decisionIri: eff.decisionIri } : { ...p.current, source: 'captured' },
            status: t.record.status, quoteStatus: p.quoteStatus, quotes: p.quotes, ...(p.revision ? { revision: { note: p.revision.note ?? null, answers: p.revision.answers, quotesCleared: p.revision.quotesCleared, by: p.revision.by.did } } : {}),
            ...(p.retirement ? { retirement: { why: p.retirement.why, at: p.retirement.at, by: p.retirement.by.did } } : {}),
            orphaned: !listedTasks.has(t.record.entityIri),
            classification: cls ? {
              regime: cls.record.payload.regime, method: cls.record.payload.method, rulesFired: cls.record.payload.rulesFired, notes: cls.record.payload.notes,
              answers: cls.record.payload.answers,
              answeredBy: { did: cls.record.payload.answeredBy.did, address: cls.record.payload.answeredBy.address, personRef: cls.record.payload.answeredBy.personRef, role: cls.record.payload.answeredBy.role },
              status: cls.record.status, current: cls.record.payload.taskTextSha256 === p.textSha256,
              ratifications: cls.record.payload.ratifications.map((r) => ({ party: r.party, verdict: r.verdict, ...(r.note ? { note: r.note } : {}), at: r.at })),
              disagreement: cls.record.payload.ratifications.filter((r) => r.answers).map((r) => ({ party: r.party, answers: r.answers })),
              contraryEvidence: reviewed.length > 0 ? { reviewedRuns: reviewed.length, reworkedShare: Math.round(share * 10_000) / 10_000, criticalFailures: critical, suggestReclassify: suggest, note: CONTRARY_NOTE } : null,
              state: 'ok', trusted: true, head: headInfo(cls.head), demo: cls.record.demo === true,
            } : clsGraph && (clsGraph.g.state === 'altered' || clsGraph.g.state === 'forked') ? {
              state: clsGraph.g.state, trusted: false,
              heads: clsGraph.g.heads.map((h) => ({ descriptorUrl: h.descriptorUrl, contentBinding: h.authorship.contentBinding, why: h.why })),
            } : null,
            link: taskLink(t.record.entityIri), head: headInfo(t.head), demo: t.record.demo === true,
          };
        });
      }
      if (want('plans')) {
        const out2: Obj[] = [];
        for (const pl of plansRec) {
          const p = pl.record.payload;
          if (!keep(pl.record.entityIri, p.workflowIri)) continue;
          let stale: string | null = null;
          const wf = workflowsRec.find((w) => w.record.entityIri === p.workflowIri);
          for (const row of p.tasks) {
            const t = tasksRec.find((x) => x.record.entityIri === row.taskIri);
            const c = classificationByTask.get(row.taskIri);
            if (row.changed && wf && !wf.record.payload.taskIris.includes(row.taskIri)) { stale = RETIRED_IN_PLAN; break; }
            if (!t || t.record.payload.textSha256 !== p.taskTextSha256[row.taskIri] || !c || c.head.descriptorUrl !== p.classificationHeads[row.taskIri]) { stale = STALE_PLAN; break; }
          }
          const assignments = p.tasks.filter((r) => r.changed && r.proposed.personAddress).map((r) => {
            const a = acks.get(`${pl.record.entityIri}|${r.taskIri}|${r.proposed.personAddress ?? ''}`);
            const state = a ? a.status : 'not-acknowledged';
            return { taskIri: r.taskIri, personAddress: r.proposed.personAddress, state, ...(a?.payload.note ? { note: a.payload.note } : {}), label: state === 'acknowledged' ? ACKNOWLEDGED : state === 'objected' ? OBJECTED : UNACKNOWLEDGED };
          });
          out2.push({ planIri: pl.record.entityIri, workflowIri: p.workflowIri, title: p.title, planKind: p.planKind, tasks: p.tasks, proposedBy: p.proposedBy.did, stale, assignments, head: headInfo(pl.head), demo: pl.record.demo === true });
        }
        out['plans'] = out2;
      }
      if (want('valuations')) {
        out['valuations'] = recordsOf(snap, 'Valuation').filter((v) => keep(v.record.entityIri, workflowOfPlan(v.record.payload.planIri))).map((v) => ({
          valuationIri: v.record.entityIri, planIri: v.record.payload.planIri, valuationHash: v.record.payload.valuationHash, inputs: v.record.payload.inputs, result: v.record.payload.result,
          expertEvidence: v.record.payload.expertEvidence, unratifiedTasks: v.record.payload.unratifiedTasks, head: headInfo(v.head), demo: v.record.demo === true,
        }));
      }
      if (want('decisions')) {
        const out3: Obj[] = [];
        for (const d of decisionsRec) {
          const p = d.record.payload;
          if (!keep(d.record.entityIri, workflowOfPlan(p.planIri))) continue;
          const chain = (await call.view.history(d.s.g)).map((l) => ({
            version: l.record?.version ?? null, status: l.record?.status ?? null, modalStatus: l.modalStatus, signedBy: l.record?.signers.map((s) => s.did) ?? [],
            at: l.generatedAt, descriptorUrl: l.descriptorUrl, recordId: l.recordId, graphDigest: l.graphDigest,
          }));
          out3.push({
            decisionIri: d.record.entityIri, decisionKind: p.decisionKind, planIri: p.planIri, ...(p.valuationIri ? { valuationIri: p.valuationIri, valuationHash: p.valuationHash } : {}),
            status: d.record.status, statusLabel: statusLabelOf(d.record.status, p.decisionKind), decisionLevel: p.decisionLevel,
            ...(p.prediction ? { prediction: p.prediction } : {}), ...(p.freedHours ? { freedHours: p.freedHours } : {}),
            ...(p.measurementPlan ? { measurementPlan: p.measurementPlan, basisLabel: p.basisLabel } : {}),
            subjects: p.subjects, assignments: p.assignments, submittedBy: { did: p.submittedBy.did, personRef: p.submittedBy.personRef },
            ...(p.countersign ? { countersign: { verdict: p.countersign.verdict, did: p.countersign.did, personRef: p.countersign.personRef, objectionsConsidered: p.countersign.objectionsConsidered, assignmentsAtCountersign: p.countersign.assignmentsAtCountersign, at: p.countersign.at } } : {}),
            ...(p.outcome ? { outcome: { did: p.outcome.did, personRef: p.outcome.personRef, disposition: p.outcome.disposition, ...(p.outcome.dispositionNote ? { dispositionNote: p.outcome.dispositionNote } : {}), at: p.outcome.at, ...(p.outcome.valued ? { valued: p.outcome.valued } : {}), ...(p.outcome.probes ? { probes: p.outcome.probes } : {}) } } : {}),
            ...(p.probes ? { probes: p.probes } : {}),
            ...(p.outcome?.probes?.some((x) => x.signal !== 'neither') ? { next: NEXT_RECLASSIFY } : {}),
            grantChecks: p.grantChecks, chain, head: headInfo(d.head), demo: d.record.demo === true,
          });
        }
        out['decisions'] = out3;
      }
      if (want('grants')) {
        const out4: Obj[] = [];
        for (const gr of recordsOf(snap, 'Grant')) {
          const p = gr.record.payload;
          if (subject !== null && subject !== gr.record.entityIri) continue;
          const state = await grantState(call, reg, p.agentAddress, p.taskKind);
          const history = await call.view.history(gr.s.g);
          const grantedAt = [...history].reverse().find((l) => l.record?.status === 'granted')?.generatedAt ?? null;
          out4.push({
            grantIri: gr.record.entityIri, agentAddress: p.agentAddress, principal: p.principal, model: p.model, taskKind: p.taskKind, status: gr.record.status,
            active: state.active, why: state.active ? null : state.why, evaluation: p.evaluation, evidenceTaskIris: p.evaluation.taskIris, grantedAt,
            ...(p.revocation ? { revokedAt: p.revocation.at, revocationWhy: p.revocation.why } : {}), head: headInfo(gr.head), demo: gr.record.demo === true,
          });
        }
        out['grants'] = out4;
      }
      if (want('runs')) {
        const agg = new Map<string, { agentAddress: string; taskKind: string; model: string; reviewed: number; actedUnderGrant: number; costs: number[]; currency: string | null }>();
        const awaiting: Obj[] = [];
        for (const r of runsRec) {
          const p = r.record.payload;
          const k = `${p.agentAddress}|${p.taskKind}|${p.model}`;
          const a = agg.get(k) ?? { agentAddress: p.agentAddress, taskKind: p.taskKind, model: p.model, reviewed: 0, actedUnderGrant: 0, costs: [], currency: null };
          if (r.record.status === 'reviewed') a.reviewed += 1; else a.actedUnderGrant += 1;
          if (p.costPerRun && (a.currency === null || a.currency === p.costPerRun.currency)) { a.costs.push(p.costPerRun.amount); a.currency = p.costPerRun.currency; }
          agg.set(k, a);
          if (r.record.status === 'acted-under-grant') awaiting.push({ runIri: r.record.entityIri, agentAddress: p.agentAddress, taskIri: p.taskIri, taskKind: p.taskKind, runEnvelope: p.runEnvelope, demo: r.record.demo === true });
        }
        out['runs'] = [...agg.values()].map((a) => ({
          agentAddress: a.agentAddress, taskKind: a.taskKind, model: a.model, reviewed: a.reviewed, actedUnderGrant: a.actedUnderGrant,
          ...(a.costs.length > 0 ? { measuredCost: { runs: a.costs.length, mean: a.costs.reduce((x, y) => x + y, 0) / a.costs.length, currency: a.currency } } : {}),
        }));
        out['awaitingReview'] = awaiting;
      }
      out['untrusted'] = [
        ...snap.graphs.flatMap((s) => s.g.untrusted),
        ...snap.foreign.map((e) => ({ descriptorUrl: e.descriptorUrl, why: 'it is outside this pod\'s wrd/records/ container (for example a holder copy)' })),
      ];
      out['forked'] = snap.graphs.filter((s) => s.g.state === 'forked').map((s) => s.graphIri);
      out['altered'] = snap.graphs.filter((s) => s.g.state === 'altered').map((s) => s.graphIri);
      out['integrity'] = snap.graphs.filter((s) => s.g.state === 'altered' || s.g.state === 'forked').map((s) => ({
        graphIri: s.graphIri, state: s.g.state,
        heads: s.g.heads.map((h) => ({ descriptorUrl: h.descriptorUrl, trusted: h.authorship.trusted, contentBinding: h.authorship.contentBinding, why: h.why })),
      }));
      return out;
    },

    'wrd.calibration': async (args) => {
      const kind = typeof args['kind'] === 'string' && args['kind'] !== '' ? args['kind'] : null;
      if (kind !== null && kind !== 'predictions' && kind !== 'agents' && kind !== 'probes') return { ...refuse(400, 'Unknown kind.', 'kind must be predictions, agents or probes') };
      const call = await openCall(args, undefined, false);
      const reg = await registryOf(call);
      const snap = await snapshot(call.view);
      const decisions: DecisionForCalibration[] = [];
      const probes: ProbeOutcome[] = [];
      for (const d of recordsOf(snap, 'Decision')) {
        const p = d.record.payload;
        const o = p.outcome;
        if (d.record.status !== 'measured' || !o) continue;
        const demoRecord = d.record.demo === true;
        if (p.decisionKind === 'valued' && o.valued && p.prediction) {
          const issued = p.submittedBy.envelope.payload['issuedAt'];
          decisions.push({
            decisionIri: d.record.entityIri, level: p.decisionLevel, metric: p.prediction.metric as OutcomeMetric, basis: o.valued.measured.comparisonBasis,
            verdict: o.valued.verdict, rampAdjusted: o.valued.rampAdjusted, disposition: o.disposition, measuredBy: o.did,
            submittedAt: typeof issued === 'string' ? issued : o.at, measuredAt: o.at, demo: demoRecord,
          });
        }
        for (const pr of o.probes ?? []) probes.push({ decisionIri: d.record.entityIri, taskIri: pr.taskIri, index: pr.index, signal: pr.signal, demo: demoRecord });
      }
      const runs: ReviewedRun[] = [];
      const awaiting: Obj[] = [];
      for (const r of recordsOf(snap, 'AgentRun')) {
        const rr = reviewedRunOf(r.record);
        if (rr) runs.push(rr);
        else if (r.record.status === 'acted-under-grant') awaiting.push({ runIri: r.record.entityIri, agentAddress: r.record.payload.agentAddress, taskKind: r.record.payload.taskKind });
      }
      const policy = reg.policy.grantPolicy;
      const report = calibrationReport({
        decisions, runs, probes, minSamples: policy.minSamples, policy,
        currentModelOf: (did) => memberOf(reg, did.replace(/^did:ethr:/, ''))?.model ?? null,
      });
      const agentCells: Obj[] = [];
      for (const c of report.agentCells) {
        const address = c.agentDid.replace(/^did:ethr:/, '');
        const g = await grantState(call, reg, address, c.taskKind);
        agentCells.push({ ...c, agentAddress: address, principal: memberOf(reg, address)?.principal ?? null, grant: { active: g.active, why: g.active ? null : g.why } });
      }
      const demoRecords = snap.graphs.filter((s) => s.record?.demo === true).length;
      return {
        podUrl: call.podUrl, complete: snap.complete, status: 'calibrated', computed: true, minSamples: report.minSamples, nominalBandCoverage: report.nominalBandCoverage,
        demoRecords, demoLabel: demoRecords > 0 ? DEMO_LABEL : null,
        ...(kind === null || kind === 'predictions' ? { predictionCells: report.predictionCells } : {}),
        ...(kind === null || kind === 'agents' ? { agentCells } : {}),
        ...(kind === null || kind === 'probes' ? { probeSignals: report.probeSignals } : {}),
        awaitingAPerson: awaiting, grantPolicy: policy, podPolicy: reg.podPolicy,
      };
    },
  };

  if (demo) {
    handlers['wrd.demo_envelope'] = async (args) => {
      const id = args['persona'];
      const persona = typeof id === 'string' ? demo.get(id) : undefined;
      if (!persona) return { ...refuse(404, 'No such demo persona.', `persona must be one of ${[...demo.keys()].join(', ')}`) };
      const raw = args['payload'];
      if (!isObj(raw)) return { ...refuse(400, BAD_PAYLOAD, 'payload must be the object to sign') };
      const payload: Obj = {
        ...raw,
        ...(raw['issuedAt'] === undefined ? { issuedAt: clock().toISOString() } : {}),
        ...(raw['nonce'] === undefined ? { nonce: randomBytes(16).toString('hex') } : {}),
      };
      const signature = await signMessageRaw(persona.wallet, canonicalJson(payload));
      return {
        envelope: { payload, signature }, signer: lower(persona.wallet.address), persona: persona.id, label: persona.label,
        demoKey: true, scriptedLabel: DEMO_LABEL, status: 'signed',
      };
    };
  }

  const out: Record<string, WrdHandler> = {};
  for (const [name, fn] of Object.entries(handlers)) {
    out[name] = async (args) => {
      try {
        return await fn(args);
      } catch (e) {
        return failureOf(e);
      }
    };
  }
  return out;
}

/** The status a failure deserves, as a typed refusal. Unexpected failures are the bridge's (500), never the caller's. */
function failureOf(e: unknown): BridgeRefusal {
  if (e instanceof Declined) return e.refusal;
  if (e instanceof StaleHeadError) return refuse(409, 'The record changed since it was read; read it again and retry.', e.message, via('list_records'));
  if (e instanceof IncompleteManifestError) return refuse(502, "The pod's manifest could not be read in full; nothing was written.", e.message);
  if (e instanceof PodWriteError) return refuse(502, e.status === null ? 'The pod did not accept the write.' : `The pod answered ${e.status} to the write.`, e.message);
  if (e instanceof PodReadError) return refuse(502, e.status === null ? 'The pod could not be read.' : `The pod answered ${e.status} to a read.`, e.message);
  if (e instanceof PublishShapeViolationError) {
    return refuse(500, 'The bridge built a record its own shapes refuse; nothing was written.', `${e.message}: ${e.violations.map((v) => v.message).join('; ')}`);
  }
  return refuse(500, 'The bridge failed while handling this call.', messageOf(e));
}
