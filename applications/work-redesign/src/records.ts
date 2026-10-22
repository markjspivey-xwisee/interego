/**
 * Records: who signed (envelopes), what they are called (IRIs, record ids, slugs), what they
 * carry (payload types), and the two forms they are written in (the payload graph and the
 * context descriptor).
 *
 * Identity is only ever the address recovered from an EIP-191 signature over the canonical
 * JSON of an envelope's payload. No payload field names a signer, and nothing here accepts a
 * caller's claim of who they are. Every payload binds the pod it is for, a time and a nonce.
 *
 * Turtle is built only from the judgment kit's iri/lit/dbl/int/bool helpers, which refuse an
 * unsafe IRI and escape literals; there is no local escaper and no raw IRI interpolation.
 * Names are projected as dct:title because rdfs: is not among the payload prefixes.
 *
 * Pure: no environment reads, no network, no clock (every time is passed in).
 */
import {
  canonicalJson, sha256Hex, recoverMessageSigner, parseTrig, findSubjectsOfType, readStringValue, ContextDescriptor, validate, turtleIriRef,
  type ContextDescriptorData, type IRI,
} from '@interego/core';
import { iri, lit, dbl, int, bool, payloadPrefixes } from '../../_shared/judgment-kit/index.js';
import {
  WRD_NS, wrdTerm, levelIri, regimeIri, methodIri,
  type AllocationLevel, type ComparisonBasis, type GrantPolicy, type OutcomeDisposition, type OutcomeMetric, type PodPolicy,
  type ProbeSignal, type Regime, type RegistryRole, type MethodToken,
} from './ontology.js';
import type { Allocation, ClassificationAnswers, PlanKind, Probe, QuoteVerdict } from './work.js';
import type { Band, BandVerdict, GrantEvaluation, ValuationInputs, ValuationResult } from './valuation.js';

// ── Kinds ─────────────────────────────────────────────────────────────────────────────────

export type RecordKind = 'RoleRegistry' | 'Workflow' | 'Task' | 'Classification' | 'Plan' | 'Valuation'
  | 'Decision' | 'Acknowledgement' | 'AgentRun' | 'Grant' | 'HolderCopy';
export const RECORD_KINDS: readonly RecordKind[] = [
  'RoleRegistry', 'Workflow', 'Task', 'Classification', 'Plan', 'Valuation', 'Decision', 'Acknowledgement', 'AgentRun', 'Grant', 'HolderCopy',
];
export const RECORD_CLASS: Readonly<Record<RecordKind, string>> = Object.fromEntries(
  RECORD_KINDS.map((k) => [k, wrdTerm(k)]),
) as Record<RecordKind, string>;

/** The statuses each kind's lifecycle allows; the shapes in wrd-shapes.ttl say the same. */
export const RECORD_STATUSES = {
  RoleRegistry: ['registered'],
  Workflow: ['captured'],
  Task: ['captured', 'ratified', 'disputed', 'retired'],
  Classification: ['classified', 'ratified', 'disputed'],
  Plan: ['proposed'],
  Valuation: ['valued'],
  Decision: ['submitted', 'countersigned', 'declined', 'measured'],
  Acknowledgement: ['acknowledged', 'objected'],
  AgentRun: ['acted-under-grant', 'reviewed'],
  Grant: ['granted', 'revoked'],
  HolderCopy: ['copied', 'exported'],
} as const satisfies Record<RecordKind, readonly string[]>;
export type StatusOf<K extends RecordKind> = (typeof RECORD_STATUSES)[K][number];

export type ModalChoice = 'Hypothetical' | 'Asserted' | 'Retracted' | 'Counterfactual';

// ── Identity ──────────────────────────────────────────────────────────────────────────────

export const didOf = (address: string): string => `did:ethr:${address.toLowerCase()}`;
export const isAddress = (v: unknown): v is string => typeof v === 'string' && /^0x[0-9a-fA-F]{40}$/.test(v);
const ISO_INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,9})?(Z|[+-]\d{2}:\d{2})$/;
/** An absolute IRI the Turtle helpers accept (scheme, no spaces or angle brackets). */
export function isAbsoluteIri(v: unknown): v is string {
  return typeof v === 'string' && v.length <= 2000 && /^[A-Za-z][A-Za-z0-9+.-]*:/.test(v) && turtleIriRef(v) !== null;
}
/** An ISO-8601 date-time with seconds and a zone, that Date can read. */
export const isIsoInstant = (v: unknown): v is string => typeof v === 'string' && ISO_INSTANT.test(v) && Number.isFinite(Date.parse(v));

/** A pod URL as records compare it: http(s) only, no query or fragment, trailing slash. */
export function normalisePodUrl(u: string): string {
  const url = new URL(u);
  if (url.protocol !== 'https:' && url.protocol !== 'http:') throw new TypeError(`a pod URL must be http(s): ${u.slice(0, 120)}`);
  url.search = '';
  url.hash = '';
  if (!url.pathname.endsWith('/')) url.pathname = `${url.pathname}/`;
  return url.href;
}

function samePod(a: string, b: string): boolean {
  try { return normalisePodUrl(a) === normalisePodUrl(b); } catch { return false; }
}

// ── Envelopes (DECISIONS #1, #3) ──────────────────────────────────────────────────────────

export interface SignedEnvelope { readonly payload: Record<string, unknown>; readonly signature: string }
export type EnvelopeIntent = 'wrd:update-registry' | 'wrd:capture-workflow' | 'wrd:record-task-map' | 'wrd:revise-task'
  | 'wrd:ratify-task' | 'wrd:classify-task' | 'wrd:propose-allocation' | 'wrd:value-plan' | 'wrd:submit-decision'
  | 'wrd:countersign-decision' | 'wrd:record-outcome' | 'wrd:agent-run' | 'wrd:review-agent-run' | 'wrd:grant-autonomy'
  | 'wrd:revoke-grant' | 'wrd:holder-copy';

/** The exact string an envelope's signature covers. */
export const envelopeMessage = (payload: Record<string, unknown>): string => canonicalJson(payload);
/** A stable digest of a whole envelope (payload and signature). */
export function envelopeSha256(env: SignedEnvelope): string {
  return sha256Hex(canonicalJson({ payload: env.payload, signature: env.signature }));
}

export const DEFAULT_ENVELOPE_WINDOW = { pastMs: 15 * 60_000, futureMs: 2 * 60_000 } as const;
const NONCE = /^[A-Za-z0-9_-]{16,64}$/;

const ENVELOPE_REQUIRED = 'A signed envelope is required.';
const ENVELOPE_MALFORMED = 'The envelope is malformed.';
const ENVELOPE_UNVERIFIED = 'The envelope signature does not verify.';
const ENVELOPE_STALE = 'The envelope is stale or from the future.';

export type OpenedEnvelope =
  | { readonly ok: true; readonly signer: string; readonly did: string; readonly payload: Record<string, unknown>; readonly envelope: SignedEnvelope }
  | { readonly ok: false; readonly status: 400 | 401; readonly error: string; readonly why: string };

function envelopeShape(raw: unknown): SignedEnvelope | null {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return null;
  const o = raw as Record<string, unknown>;
  const payload = o['payload'];
  const signature = o['signature'];
  if (typeof payload !== 'object' || payload === null || Array.isArray(payload) || typeof signature !== 'string') return null;
  return { payload: payload as Record<string, unknown>, signature };
}

function recoverSigner(env: SignedEnvelope): string | null {
  try { return recoverMessageSigner(envelopeMessage(env.payload), env.signature).toLowerCase(); } catch { return null; }
}

/** Shape, intent and pod binding: the checks a stored and a fresh envelope share. */
function bindingFailure(env: SignedEnvelope, intent: EnvelopeIntent, podUrl: string): string | null {
  const p = env.payload;
  if (p['intent'] !== intent) return `payload.intent must be ${intent}`;
  if (typeof p['podUrl'] !== 'string') return 'payload.podUrl is required';
  if (!isIsoInstant(p['issuedAt'])) return 'payload.issuedAt must be an ISO-8601 date-time';
  if (typeof p['nonce'] !== 'string' || !NONCE.test(p['nonce'])) return 'payload.nonce must be 16 to 64 characters of [A-Za-z0-9_-]';
  if (!samePod(p['podUrl'], podUrl)) return 'payload.podUrl does not name the pod this call targets';
  return null;
}

/**
 * Open an envelope that authorises the CURRENT call: shape, intent, pod, signature and
 * freshness, first failure wins. The nonce is claimed by the caller afterwards (so a refused
 * call with a bad signature burns no nonce). An altered payload does not fail here: it recovers
 * a different, unregistered address, which the caller's role check refuses.
 */
export function openEnvelope(raw: unknown, intent: EnvelopeIntent, podUrl: string, now: Date,
  window: { readonly pastMs: number; readonly futureMs: number } = DEFAULT_ENVELOPE_WINDOW): OpenedEnvelope {
  if (raw === undefined || raw === null) return { ok: false, status: 401, error: ENVELOPE_REQUIRED, why: 'no envelope was sent' };
  const env = envelopeShape(raw);
  if (env === null) return { ok: false, status: 400, error: ENVELOPE_MALFORMED, why: 'an envelope is {payload: object, signature: string}' };
  const binding = bindingFailure(env, intent, podUrl);
  if (binding !== null) return { ok: false, status: 400, error: ENVELOPE_MALFORMED, why: binding };
  const signer = recoverSigner(env);
  if (signer === null) return { ok: false, status: 401, error: ENVELOPE_UNVERIFIED, why: 'no address can be recovered from this signature' };
  const issued = Date.parse(String(env.payload['issuedAt']));
  const t = now.getTime();
  if (issued < t - window.pastMs || issued > t + window.futureMs) {
    return { ok: false, status: 401, error: ENVELOPE_STALE, why: `issuedAt must fall within ${Math.round(window.pastMs / 60_000)} minutes before and ${Math.round(window.futureMs / 60_000)} minutes after the server's clock` };
  }
  return { ok: true, signer, did: didOf(signer), payload: env.payload, envelope: env };
}

/**
 * Re-check an envelope ALREADY STORED in a record (a countersign weeks old, a run logged an
 * hour ago): shape, intent, pod and recovered signer — no freshness window and no nonce. Never
 * used for an envelope that authorises the current call.
 */
export function verifyStoredEnvelope(env: unknown, intent: EnvelopeIntent, podUrl: string):
  { readonly ok: true; readonly signer: string; readonly did: string } | { readonly ok: false; readonly why: string } {
  const shaped = envelopeShape(env);
  if (shaped === null) return { ok: false, why: 'the stored envelope is not {payload, signature}' };
  const binding = bindingFailure(shaped, intent, podUrl);
  if (binding !== null) return { ok: false, why: binding };
  const signer = recoverSigner(shaped);
  if (signer === null) return { ok: false, why: 'no address can be recovered from the stored signature' };
  return { ok: true, signer, did: didOf(signer) };
}

/**
 * (signer, nonce) pairs seen inside a time window: the fast, in-process half of replay
 * protection. It forgets on restart and is not shared between processes, so the durable half is
 * the pod itself — every record carries the (signer, nonce) that authorised it, and a write is
 * refused when its graph's chain already holds that pair (handlers.ts, write()).
 *
 * Bounded: entries expire in insertion order (a Map iterates in insertion order, so expiry
 * stops at the first live entry instead of scanning the map), and beyond `maxEntries` the oldest
 * are dropped — the durable check still stands behind them. Callers claim only for registered
 * signers, so keys nobody registered cannot fill it.
 */
export class NonceLedger {
  private readonly seen = new Map<string, number>();
  constructor(private readonly ttlMs: number, private readonly maxEntries = 100_000) {}
  claim(signer: string, nonce: string, now: Date): boolean {
    const t = now.getTime();
    for (const [k, at] of this.seen) {
      if (at >= t - this.ttlMs) break;
      this.seen.delete(k);
    }
    const key = `${signer.toLowerCase()}|${nonce}`;
    if (this.seen.has(key)) return false;
    this.seen.set(key, t);
    while (this.seen.size > this.maxEntries) {
      const oldest = this.seen.keys().next();
      if (oldest.done) break;
      this.seen.delete(oldest.value);
    }
    return true;
  }
  get size(): number { return this.seen.size; }
}

// ── IRIs, record ids, slugs ───────────────────────────────────────────────────────────────

export const h16 = (seed: string): string => sha256Hex(seed).slice(0, 16);
export type EntityKind = 'registry' | 'workflow' | 'task' | 'classification' | 'plan' | 'valuation' | 'decision'
  | 'acknowledgement' | 'run' | 'grant' | 'holder-copy';
/** `urn:wrd:<kind>:<h16(scope)>:<h16(id)>` — the scope segment lets a reader select graphs from the manifest before reading any. */
export const entityIri = (kind: EntityKind, scope: string, id: string): string => `urn:wrd:${kind}:${h16(scope)}:${h16(id)}`;
export const scopePrefix = (kind: EntityKind, scope: string): string => `urn:wrd:${kind}:${h16(scope)}:`;
export const graphIriOf = (entity: string): string => `${entity}:graph`;
/** One id per write attempt: the nonce makes it unique, so a retry never lands on a partial write's URL. */
export const recordIdFor = (kind: EntityKind, graphIri: string, version: number, nonce: string): string =>
  `urn:wrd:record:${kind}-${h16(`${graphIri}|${version}|${nonce}`)}`;
export function slugOf(recordId: string): string {
  const i = recordId.lastIndexOf(':');
  return i < 0 ? recordId : recordId.slice(i + 1);
}

// ── Payloads ──────────────────────────────────────────────────────────────────────────────

export interface PolicyRef { readonly ontologyIri: string; readonly ontologySha256: string; readonly podPolicyHead: string | null }
export interface SignedAct { readonly did: string; readonly envelope: SignedEnvelope }

export interface RegistryMember {
  readonly address: string; readonly did: string; readonly roles: readonly RegistryRole[]; readonly label: string;
  readonly softwareAgent: boolean; readonly personRef: string | null; readonly principal: string | null; readonly model: string | null;
}
export interface RegistryTaskKind { readonly slug: string; readonly label: string; readonly definition: string; readonly retired: boolean }
export interface RegistryPayload {
  readonly members: readonly RegistryMember[]; readonly taskKinds: readonly RegistryTaskKind[]; readonly podPolicy: PodPolicy | null;
  readonly replacedUntrusted: boolean; readonly change: { readonly envelope: SignedEnvelope; readonly signer: string };
}

export interface DraftedBy { readonly kind: 'person' | 'agent' | 'not-declared'; readonly agent?: string; readonly model?: string }
export interface WorkflowPayload {
  readonly title: string; readonly unitLabel: string; readonly description?: string; readonly captureMode: 'manual' | 'document';
  readonly capturedBy: SignedAct; readonly taskIris: readonly string[]; readonly retiredTaskIris: readonly string[];
  readonly document?: { readonly title: string; readonly sha256: string; readonly chars: number; readonly textStored: boolean };
  readonly documentText?: string; readonly draftedBy?: DraftedBy; readonly draftSha256?: string;
  readonly revision?: {
    readonly op: 'add' | 'retire'; readonly taskIri: string; readonly by: SignedAct;
    /**
     * Set when this version finishes a retirement whose own workflow write did not land: the
     * retired task version, and who retired it when. `by` is whoever sent the call that finished it.
     */
    readonly repairs?: { readonly taskDescriptorUrl: string; readonly retiredBy: string | null; readonly retiredAt: string | null };
  };
}

export interface PartyVerdict {
  readonly party: string; readonly verdict: 'ratify' | 'dispute'; readonly note?: string; readonly envelope: SignedEnvelope; readonly at: string;
}
export interface TaskPayload {
  readonly workflowIri: string; readonly index: number; readonly name: string; readonly description: string; readonly textSha256: string;
  readonly current: Allocation; readonly performer: string; readonly namedParties: readonly string[];
  readonly taskKind: string; readonly taskKindDefinition: string; readonly externalTaskTerm?: string;
  readonly quotes: readonly QuoteVerdict[]; readonly quoteStatus: 'verified' | 'partly-verified' | 'unverified' | 'none';
  readonly ratifications: readonly PartyVerdict[];
  /**
   * Parties a revision removed from the task who have not yet ratified it. Removing someone from
   * a task is a statement about them: it does not take effect as ratified until they ratify it
   * (they may also dispute it), so a dispute is answered, never edited away.
   */
  readonly owedRatification?: readonly string[];
  /**
   * Who signed this task's description into being, and the digest of that envelope. The
   * envelope itself (which may describe sixty tasks) is stored once, verbatim, on the workflow
   * record the same call wrote: its `capturedBy`, or the `revision.by` of the version that added
   * the task. envelopeSha256 of that stored envelope equals this digest.
   */
  readonly capturedBy?: { readonly did: string; readonly envelopeSha256: string };
  readonly revision?: { readonly by: SignedAct; readonly note?: string; readonly answers: ReadonlyArray<{ readonly party: string; readonly note: string; readonly at: string }>; readonly quotesCleared: boolean };
  readonly retirement?: { readonly by: SignedAct; readonly why: string; readonly at: string };
}

export interface ClassificationPayload {
  readonly taskIri: string; readonly taskTextSha256: string; readonly answers: ClassificationAnswers;
  readonly regime: Regime; readonly method: MethodToken; readonly regimeSource: 'rule-on-signed-answers'; readonly regimeSourceIri: string;
  readonly rulesFired: readonly string[]; readonly notes: readonly string[];
  /**
   * role: 'performer' only for a registered PERSON named on the task; an agent named on it
   * answers as 'agent' (its answers need the people's ratification and are never expert
   * evidence); otherwise 'approver' when the signer holds that role, else 'operator'.
   */
  readonly answeredBy: { readonly did: string; readonly address: string; readonly personRef: string; readonly role: 'operator' | 'approver' | 'performer' | 'agent'; readonly envelope: SignedEnvelope };
  readonly ratifications: ReadonlyArray<PartyVerdict & { readonly answers?: ClassificationAnswers }>;
  readonly policyRef: PolicyRef;
}

export interface PlanTaskRow {
  readonly taskIri: string; readonly taskKind: string; readonly regime: Regime; readonly current: Allocation; readonly proposed: Allocation;
  readonly changed: boolean; readonly probes?: readonly Probe[];
  readonly grant?: { readonly grantIri: string; readonly evidenceFromThisTask: boolean; readonly runsCounted: number };
}
export interface PlanPayload {
  readonly workflowIri: string; readonly title: string; readonly planKind: PlanKind; readonly proposedBy: SignedAct;
  readonly tasks: readonly PlanTaskRow[]; readonly classificationHeads: Readonly<Record<string, string>>;
  readonly taskTextSha256: Readonly<Record<string, string>>; readonly policyRef: PolicyRef;
}

/** Who answered the seven classification questions — never an analysis artefact, and never an input's self-declared basis label. */
export type ExpertEvidenceBasis = 'approver-answers' | 'performer-answers' | 'ratified-classification';
export interface ValuationPayload {
  readonly planIri: string; readonly planDescriptorUrl: string; readonly inputs: ValuationInputs; readonly result: ValuationResult;
  readonly valuedTasks: readonly string[]; readonly unratifiedTasks: readonly string[];
  readonly expertEvidence: ReadonlyArray<{ readonly taskIri: string; readonly satisfiedBy: ExpertEvidenceBasis }>;
  readonly valuationHash: string; readonly requestedBy: SignedAct; readonly policyRef: PolicyRef;
}

export interface MeasurementPlan {
  readonly metric: OutcomeMetric; readonly comparisonBasis: ComparisonBasis; readonly windowWeeks: number; readonly comparisonDescription?: string;
}
export interface MeasuredValue {
  readonly weeklyValueDelta: number; readonly interval?: { readonly low: number; readonly high: number };
  readonly comparisonBasis: ComparisonBasis; readonly windowStart: string; readonly windowEnd: string; readonly method: string;
  readonly runsObserved?: number; readonly criticalFailuresObserved?: number;
}
export interface DecisionPayload {
  readonly decisionKind: 'valued' | 'probe'; readonly planIri: string; readonly valuationIri?: string; readonly valuationHash?: string;
  readonly prediction?: { readonly metric: OutcomeMetric; readonly band: Band; readonly npv: Band; readonly rampMonths: number; readonly status: 'unmeasured' | 'measured' | 'not-to-be-measured' };
  readonly freedHours?: ValuationResult['freedPersonHours'];
  readonly decisionLevel: AllocationLevel;
  readonly subjects: ReadonlyArray<{ readonly address: string; readonly personRef: string }>;
  readonly assignments: ReadonlyArray<{ readonly taskIri: string; readonly personAddress: string; readonly state: 'acknowledged' | 'objected' | 'not-acknowledged'; readonly note?: string }>;
  readonly measurementPlan?: MeasurementPlan; readonly comparisonGroup?: boolean; readonly basisLabel?: string;
  readonly probes?: ReadonlyArray<{ readonly taskIri: string; readonly index: number } & Probe>;
  readonly submittedBy: { readonly did: string; readonly personRef: string; readonly envelope: SignedEnvelope };
  /** Everyone whose signed inputs set the prediction: who proposed the plan, requested the valuation and submitted. None of them countersigns or grades it. */
  readonly preparedBy?: ReadonlyArray<{ readonly role: 'proposed' | 'valued' | 'submitted'; readonly did: string; readonly personRef: string }>;
  readonly grantChecks: ReadonlyArray<{ readonly taskIri: string; readonly grantIri: string; readonly active: boolean; readonly evidenceFromThisTask: boolean }>;
  readonly countersign?: {
    readonly verdict: 'approve' | 'decline'; readonly did: string; readonly personRef: string; readonly envelope: SignedEnvelope;
    readonly objectionsConsidered: readonly string[]; readonly assignmentsAtCountersign: DecisionPayload['assignments']; readonly at: string;
    /** Tasks whose named person had not acknowledged the assignment, which the approver approved over by naming them. */
    readonly unacknowledgedConsidered?: readonly string[];
  };
  readonly outcome?: {
    readonly did: string; readonly personRef: string; readonly envelope: SignedEnvelope; readonly disposition: OutcomeDisposition;
    readonly dispositionNote?: string; readonly at: string;
    readonly valued?: {
      readonly measured: MeasuredValue; readonly metric: OutcomeMetric; readonly verdict: BandVerdict; readonly adjustedBand: Band;
      readonly rampFactor: number; readonly rampAdjusted: boolean; readonly basisChanged: boolean;
      /** Measured over less than the declared window (a change stopped early or reverted): kept out of calibration cells. */
      readonly windowShorterThanPlanned?: boolean;
      readonly windowWeeks?: number;
      /**
       * The rule-of-three check, from the person-reviewed AgentRun records on the changed agent-level
       * tasks performed inside the window — never from typed counts. Counts the grader typed are
       * shown beside them as `declared`.
       */
      readonly pilotCheck?: {
        readonly runsNeeded: number; readonly reviewedRuns: number; readonly criticalFailures: number; readonly ceilingSupported: boolean;
        readonly declared?: { readonly runsObserved?: number; readonly criticalFailuresObserved?: number };
      };
    };
    readonly probes?: ReadonlyArray<{ readonly taskIri: string; readonly index: number; readonly signal: ProbeSignal; readonly observed: string; readonly windowStart: string; readonly windowEnd: string; readonly pastTimebox: boolean }>;
  };
}

export interface AcknowledgementPayload {
  readonly planIri: string; readonly taskIri: string; readonly personAddress: string; readonly verdict: 'acknowledge' | 'object';
  readonly note?: string; readonly envelope: SignedEnvelope;
}

export type RunVerdict = 'accepted' | 'reworked' | 'critical-failure';
export interface AgentRunPayload {
  readonly agentDid: string; readonly agentAddress: string; readonly principal: string; readonly model: string; readonly runId: string;
  readonly taskIri: string; readonly taskKind: string; readonly outputSha256: string;
  readonly selfAssessment: { readonly answer: RunVerdict; readonly probabilities?: Readonly<Record<string, number>> };
  readonly underGrant: string | null; readonly costPerRun?: { readonly amount: number; readonly currency: string };
  readonly runEnvelope: SignedEnvelope;
  readonly review?: { readonly verdict: RunVerdict; readonly did: string; readonly address: string; readonly personRef: string; readonly envelope: SignedEnvelope; readonly at: string };
}

export interface GrantPayload {
  readonly agentAddress: string; readonly agentDid: string; readonly principal: string; readonly model: string; readonly taskKind: string;
  readonly taskKindDefinition: string; readonly policy: GrantPolicy; readonly evaluation: GrantEvaluation;
  readonly grantedBy: { readonly did: string; readonly personRef: string; readonly envelope: SignedEnvelope };
  readonly revocation?: { readonly did: string; readonly envelope: SignedEnvelope; readonly why: string; readonly at: string };
  readonly policyRef: PolicyRef;
}

export interface HolderCopyPayload {
  readonly holder: { readonly address: string; readonly did: string }; readonly targetPodUrl: string | null;
  readonly copied: ReadonlyArray<{ readonly originalDescriptorUrl: string; readonly copyDescriptorUrl: string | null; readonly skipped: boolean }>;
  readonly envelope: SignedEnvelope;
}

export interface RecordSigner {
  readonly did: string; readonly address: string; readonly personRef: string | null; readonly softwareAgent: boolean;
  readonly facetRole: 'Curator' | 'Validator'; readonly acted: string;
}
export interface PlatformRef { readonly did: string; readonly address: string; readonly keyKind: 'configured' | 'ephemeral' | 'demo' }

interface RecordBase<K extends RecordKind, P> {
  readonly recordKind: K;
  readonly entityIri: string;
  readonly version: number;
  readonly status: StatusOf<K>;
  readonly payload: P;
  readonly signers: readonly RecordSigner[];
  readonly platform: PlatformRef;
  /** The recovered signer and nonce of the envelope that authorised this version: the durable replay record. */
  readonly authorisedBy?: { readonly signer: string; readonly nonce: string };
  /** Present only on records written by the offline demo. */
  readonly demo?: true;
}
export type WrdRecord =
  | RecordBase<'RoleRegistry', RegistryPayload> | RecordBase<'Workflow', WorkflowPayload> | RecordBase<'Task', TaskPayload>
  | RecordBase<'Classification', ClassificationPayload> | RecordBase<'Plan', PlanPayload> | RecordBase<'Valuation', ValuationPayload>
  | RecordBase<'Decision', DecisionPayload> | RecordBase<'Acknowledgement', AcknowledgementPayload> | RecordBase<'AgentRun', AgentRunPayload>
  | RecordBase<'Grant', GrantPayload> | RecordBase<'HolderCopy', HolderCopyPayload>;
export type RecordOf<K extends RecordKind> = Extract<WrdRecord, { readonly recordKind: K }>;

// ── Payload graph ─────────────────────────────────────────────────────────────────────────

const W = (local: string): string => `wrd:${local}`;
/** A double literal, refusing a number that is not finite: the kit's dbl() would silently write 0, a number nobody computed. */
const num = (n: number, what: string): string => {
  if (!Number.isFinite(n)) throw new RangeError(`${what} is not a finite number; nothing is published`);
  return dbl(n);
};

function kindTriples(rec: WrdRecord, S: string): string[] {
  const t: string[] = [];
  const add = (pred: string, obj: string): void => { t.push(`${S} ${pred} ${obj} .`); };
  switch (rec.recordKind) {
    case 'RoleRegistry':
      for (const m of rec.payload.members) add(W('member'), iri(m.did));
      break;
    case 'Workflow': {
      const p = rec.payload;
      add('dct:title', lit(p.title));
      for (const task of p.taskIris) add(W('hasTask'), iri(task));
      add(W('captureMode'), lit(p.captureMode));
      if (p.document) add(W('documentSha256'), lit(p.document.sha256));
      break;
    }
    case 'Task': {
      const p = rec.payload;
      add('dct:title', lit(p.name));
      add(W('inWorkflow'), iri(p.workflowIri));
      add(W('performer'), iri(didOf(p.performer)));
      for (const party of p.namedParties) add(W('namedParty'), iri(didOf(party)));
      add(W('taskKind'), lit(p.taskKind));
      add(W('currentLevel'), iri(levelIri(p.current.level)));
      add(W('quoteStatus'), lit(p.quoteStatus));
      if (p.externalTaskTerm) add(W('externalTaskTerm'), iri(p.externalTaskTerm));
      break;
    }
    case 'Classification': {
      const p = rec.payload;
      add(W('classifies'), iri(p.taskIri));
      add(W('regime'), iri(regimeIri(p.regime)));
      add(W('method'), iri(methodIri(p.method)));
      add(W('regimeSource'), iri(p.regimeSourceIri));
      for (const r of p.rulesFired) add(W('ruleFired'), iri(r));
      add(W('checkability'), lit(p.answers.checkability));
      add(W('feedbackLatency'), lit(p.answers.feedbackLatency));
      add(W('ontologySha256'), lit(p.policyRef.ontologySha256));
      break;
    }
    case 'Plan': {
      const p = rec.payload;
      add(W('forWorkflow'), iri(p.workflowIri));
      for (const row of p.tasks) if (row.changed) add(W('changesTask'), iri(row.taskIri));
      add(W('planKind'), lit(p.planKind));
      add(W('ontologySha256'), lit(p.policyRef.ontologySha256));
      break;
    }
    case 'Valuation': {
      const p = rec.payload;
      const r = p.result;
      add(W('values'), iri(p.planIri));
      add(W('seed'), lit(r.seed));
      add(W('draws'), int(r.draws));
      add(W('valuationMethod'), iri(r.method));
      add(W('cashWeeklyDeltaP10'), num(r.scenarios.cash.weeklyDelta.p10, 'cash P10'));
      add(W('cashWeeklyDeltaP50'), num(r.scenarios.cash.weeklyDelta.p50, 'cash P50'));
      add(W('cashWeeklyDeltaP90'), num(r.scenarios.cash.weeklyDelta.p90, 'cash P90'));
      add(W('redeployedWeeklyDeltaP10'), num(r.scenarios.redeployed.weeklyDelta.p10, 'redeployed P10'));
      add(W('redeployedWeeklyDeltaP50'), num(r.scenarios.redeployed.weeklyDelta.p50, 'redeployed P50'));
      add(W('redeployedWeeklyDeltaP90'), num(r.scenarios.redeployed.weeklyDelta.p90, 'redeployed P90'));
      add(W('cashNpvP50'), num(r.scenarios.cash.npv.p50, 'cash NPV P50'));
      add(W('redeployedNpvP50'), num(r.scenarios.redeployed.npv.p50, 'redeployed NPV P50'));
      add(W('valuationHash'), lit(p.valuationHash));
      add(W('ontologySha256'), lit(p.policyRef.ontologySha256));
      break;
    }
    case 'Decision': {
      const p = rec.payload;
      add(W('decides'), iri(p.planIri));
      add(W('decisionKind'), lit(p.decisionKind));
      if (p.valuationIri) add(W('boundValuation'), iri(p.valuationIri));
      if (p.valuationHash) add(W('valuationHash'), lit(p.valuationHash));
      if (p.measurementPlan) add(W('comparisonBasis'), lit(p.measurementPlan.comparisonBasis));
      if (p.outcome?.valued) {
        add(W('measuredWeeklyDelta'), num(p.outcome.valued.measured.weeklyValueDelta, 'the measured weekly change'));
        add(W('bandVerdict'), lit(p.outcome.valued.verdict));
      }
      if (p.outcome) add(W('disposition'), lit(p.outcome.disposition));
      if (p.prediction) {
        const P = iri(`${rec.entityIri}:prediction`);
        add(W('prediction'), P);
        t.push(`${P} a wrd:Prediction .`);
        t.push(`${P} wrd:predictionStatus ${lit(p.prediction.status)} .`);
        t.push(`${P} wrd:outcomeMetric ${lit(p.prediction.metric)} .`);
        t.push(`${P} wrd:predictedP10 ${num(p.prediction.band.p10, 'predicted P10')} .`);
        t.push(`${P} wrd:predictedP50 ${num(p.prediction.band.p50, 'predicted P50')} .`);
        t.push(`${P} wrd:predictedP90 ${num(p.prediction.band.p90, 'predicted P90')} .`);
      }
      break;
    }
    case 'Acknowledgement': {
      const p = rec.payload;
      add(W('acknowledges'), iri(p.planIri));
      add(W('forTask'), iri(p.taskIri));
      add(W('assignee'), iri(didOf(p.personAddress)));
      break;
    }
    case 'AgentRun': {
      const p = rec.payload;
      add(W('agent'), iri(p.agentDid));
      add(W('task'), iri(p.taskIri));
      add(W('model'), lit(p.model));
      if (p.review) {
        add(W('verdict'), lit(p.review.verdict));
        add(W('reviewer'), iri(p.review.did));
      }
      break;
    }
    case 'Grant': {
      const p = rec.payload;
      add(W('grantee'), iri(p.agentDid));
      add(W('principal'), iri(didOf(p.principal)));
      add(W('model'), lit(p.model));
      add(W('taskKind'), lit(p.taskKind));
      add(W('underPolicy'), iri(p.policy.iri));
      add(W('ontologySha256'), lit(p.policyRef.ontologySha256));
      break;
    }
    case 'HolderCopy': {
      const p = rec.payload;
      add(W('holder'), iri(p.holder.did));
      for (const c of p.copied) add(W('copiedRecord'), iri(c.originalDescriptorUrl));
      break;
    }
  }
  return t;
}

/**
 * The payload graph: one subject typed with the record's class, its status, the whole record
 * as canonical JSON (the lossless form the engine reads back, envelopes included so any reader
 * can re-verify every signature), the did of every signer, the demo marker, and the kind's
 * projection triples — exactly what the kind's shape names.
 */
export function buildGraphTurtle(rec: WrdRecord): string {
  const S = iri(rec.entityIri);
  const lines = [payloadPrefixes(WRD_NS, 'wrd'), ''];
  lines.push(`${S} a wrd:${rec.recordKind} .`);
  lines.push(`${S} wrd:status ${lit(rec.status)} .`);
  lines.push(`${S} wrd:payloadJson ${lit(canonicalJson(rec))} .`);
  for (const did of [...new Set(rec.signers.map((s) => s.did))]) lines.push(`${S} wrd:signedBy ${iri(did)} .`);
  if (rec.demo) lines.push(`${S} wrd:demoRecord ${bool(true)} .`);
  lines.push(...kindTriples(rec, S));
  return `${lines.join('\n')}\n`;
}

/** The record a payload graph carries, or null when the graph is not a well-formed wrd record. */
export function parseRecordGraph(graphTurtle: string): WrdRecord | null {
  let doc;
  try { doc = parseTrig(graphTurtle); } catch { return null; }
  for (const kind of RECORD_KINDS) {
    for (const subject of findSubjectsOfType(doc, RECORD_CLASS[kind] as IRI)) {
      const json = readStringValue(subject, wrdTerm('payloadJson') as IRI);
      if (json === undefined) continue;
      let parsed: unknown;
      try { parsed = JSON.parse(json); } catch { return null; }
      if (typeof parsed !== 'object' || parsed === null) return null;
      const o = parsed as Record<string, unknown>;
      const statuses: readonly string[] = RECORD_STATUSES[kind];
      if (o['recordKind'] !== kind || o['entityIri'] !== subject.subject) return null;
      if (typeof o['status'] !== 'string' || !statuses.includes(o['status'])) return null;
      if (typeof o['version'] !== 'number' || !Array.isArray(o['signers'])) return null;
      if (typeof o['payload'] !== 'object' || o['payload'] === null || typeof o['platform'] !== 'object' || o['platform'] === null) return null;
      return parsed as WrdRecord;
    }
  }
  return null;
}

// ── Descriptor ────────────────────────────────────────────────────────────────────────────

export interface DescriptorSpec {
  readonly recordId: string;
  readonly graphIri: string;
  readonly recordKind: RecordKind;
  /** generatedAtTime of this version. */
  readonly now: string;
  /** = now, EXCEPT Retracted versions, which carry the window of what they retract. */
  readonly validFrom: string;
  /** Must be strictly after validFrom. */
  readonly validUntil?: string;
  readonly modal: ModalChoice;
  readonly confidence?: number;
  /** The predecessor's descriptorUrl (never its urn id). */
  readonly supersedes?: string;
  readonly platformDid: string;
  readonly signers: ReadonlyArray<{ readonly did: string; readonly softwareAgent: boolean; readonly role: 'Curator' | 'Validator' }>;
  readonly derivedFrom: readonly string[];
}

/**
 * The context descriptor of one record version. Throws on a spec the substrate validator
 * refuses (for example a Retracted window whose end is not after its start), so a caller can
 * never publish an invalid descriptor.
 */
export function buildDescriptor(spec: DescriptorSpec): ContextDescriptorData {
  if ((spec.modal === 'Retracted') !== (spec.validUntil !== undefined)) {
    throw new Error('a Retracted version carries validUntil, and only a Retracted version does');
  }
  const b = ContextDescriptor.create(spec.recordId as IRI)
    .describes(spec.graphIri as IRI)
    .conformsTo(RECORD_CLASS[spec.recordKind] as IRI)
    .temporal({ validFrom: spec.validFrom, ...(spec.validUntil ? { validUntil: spec.validUntil } : {}) })
    .provenance({
      wasAttributedTo: spec.platformDid as IRI,
      generatedAtTime: spec.now,
      ...(spec.derivedFrom.length > 0 ? { wasDerivedFrom: spec.derivedFrom.map((d) => d as IRI) } : {}),
    })
    .agent({ identity: spec.platformDid as IRI, isSoftwareAgent: true }, 'Author');
  for (const s of spec.signers) b.agent({ identity: s.did as IRI, isSoftwareAgent: s.softwareAgent }, s.role);
  b.selfAsserted(spec.platformDid as IRI);
  if (spec.modal === 'Hypothetical') b.hypothetical(spec.confidence);
  else if (spec.modal === 'Asserted') b.asserted(spec.confidence);
  else b.semiotic({ modalStatus: spec.modal, groundTruth: false });
  if (spec.validUntil) b.validFrom(spec.validFrom).validUntil(spec.validUntil);
  if (spec.supersedes) b.supersedes(spec.supersedes as IRI);
  const d = b.build();
  const v = validate(d);
  if (!v.conforms) throw new Error(`descriptor ${spec.recordId} does not validate: ${v.violations.map((x) => x.message).join('; ')}`);
  return d;
}
