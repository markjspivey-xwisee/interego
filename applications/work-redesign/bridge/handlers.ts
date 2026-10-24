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
 * Identity is the principal an envelope's signature establishes, never anything a caller typed:
 * the address recovered from a key the person holds, or, for a request the Interego relay signed
 * for a person who signs in with their Interego account (relay-delegated: the relay's signature
 * recovers to a relay this bridge trusts, and the identity host says whose agent it signed for),
 * that person's user DID. A user DID is never lower-cased into an address or the other way round.
 * Roles, the person an admin attests is behind each key or DID, agents' principals and declared
 * models all come from the pod's role registry, whose every change an admin signed. Separation of
 * duties compares those person references, never keys, and never anything a caller typed. Acts
 * that change who may do what take a relay-delegated request only from this bridge's own web UI
 * (an agent whose slug starts work-redesign-), unless the operator lets chat agents decide.
 *
 * Reads are scoped: wrd.read_records, wrd.read_calibration and wrd.read_envelope_template answer
 * a signed read (wrd:read-records), always in a POST body, from an admin or a key the registry
 * holds, decided on the whole manifest; the GET read model (wrd.list_records, wrd.calibration)
 * answers 401 unless the operator opens it (publicReads), and the GET wrd.envelope_template fills
 * only an allowlist (the caller's own IRIs and the head binding), never reads with a signed read,
 * and refuses (400) the forms of one it detects in its URL (see signedReadIn). Every call names a
 * pod this bridge serves, or is refused (403) before the pod is read.
 *
 * With a record key, the entity IRIs this bridge derives from a tuple (an address and a task, an
 * agent and a kind of task, a plan and "probe") are keyed with it, each segment separated by kind
 * and position, so the public manifest does not give the tuple away; records written before the
 * key keep their unkeyed IRIs and are still found, and their graphs stay plaintext on the pod (the
 * read model counts them). Every keyed IRI, and the record id of every version written with a
 * record key, carries the key's public fingerprint, signed by the platform: when the pod holds a
 * version written under a key this bridge does not hold (or under any, and it holds none), the
 * bridge would find those records absent, so it refuses every write and every lookup by tuple
 * (409, naming WRD_RECORD_KEY and both fingerprints), whoever signs, before the registry is read;
 * every read too while it cannot use the registry (registryForRead), and otherwise its read model
 * marks what it cannot know. The record id shows it from that key's first write, before any IRI
 * is keyed.
 *
 * Every refusal is a typed `refuse()` with an HTTP status; every success carries an outcome
 * flag. No environment reads: bridge/server.ts composes this with its configuration.
 */
import { randomBytes } from 'node:crypto';
import { canonicalJson, sha256Hex, createWallet, signMessageRaw, recoverMessageSigner, type EncryptionKeyPair, type FetchFn, type ManifestEntry, type Wallet } from '@interego/core';
import { fetchAllManifestEntries, predictManifestUrl, PublishShapeViolationError } from '@interego/solid';
import { refuse, type BridgeRefusal } from '../../_shared/vertical-bridge/refusal.js';
import {
  readPublishedPolicy, effectivePolicy, coercePodPolicy, podPolicyLoosens, isOneOf,
  WRD_ONTOLOGY_IRI, REGIME_SOURCE, REGISTRY_ROLES, COMPARISON_BASES, OUTCOME_METRICS, INPUT_BASES, FREED_HOURS_DISPOSITIONS,
  OUTCOME_DISPOSITIONS, PROBE_SIGNALS,
  type AllocationLevel, type ComparisonBasis, type EffectivePolicy, type OutcomeMetric, type PodPolicy, type RegistryRole,
} from '../src/ontology.js';
import {
  CLASSIFICATION_QUESTIONS, classifyTask, coerceAnswers, checkParties, checkAllocation, checkActingUnderGrant, currentAllocationNote,
  coerceChange, planKindOf, performerOf, namedPartiesOf, verifyTaskQuotes, quoteStatusOf, coerceCapture, coerceRevision, applyTaskChanges,
  taskTextSha256, buildTaskMapPacket, TASK_KIND_SLUG, LIMITS,
  type Allocation, type AllocationChange, type CaptureTask, type ClassificationAnswers, type GrantState, type QuoteVerdict,
  type TaskForAllocation,
} from '../src/work.js';
import {
  coerceValuationInputs, valuePlan, nonFiniteIn, checkOutcomeWindow, checkWindowLength, gradeOutcome, calibrationReport, evaluateGrant,
  DRAWS, DEMO_LABEL, DISTINCT_PEOPLE_NOTE, NOMINAL_BAND_COVERAGE, NO_COMPARISON_GROUP, RUN_ALTERNATIVES, REPORTED_COST_BASIS,
  type DecisionForCalibration, type GrantEvaluation, type ProbeOutcome, type ReviewedRun, type RunAnswer, type ValuationResult,
} from '../src/valuation.js';
import { payloadSchema, isEnvelopeIntent, RELAY_SIGNING } from '../src/payloads.js';
import { openRelayDelegated, relayEnvelopeOf, agentSlugOf, isUserDid, type RelayDelegationPolicy } from '../src/relay-delegated.js';
import {
  openEnvelope, verifyStoredEnvelope, bindRelayDelegated, NonceLedger, envelopeSha256, didOf, isAddress, isUserPrincipal, principalKey, principalOfDid,
  isIsoInstant, entityIri, entityIriKey, scopePrefix, graphIriOf,
  recordIdFor, normalisePodUrl, illFormedTextPath, iriKeyFingerprint, fingerprintOfIri, fingerprintOfRecord, kindOfIri, DEFAULT_ENVELOPE_WINDOW, ENTITY_IRI_PATTERN,
  UNKEYED_RECORD_URL,
  type DecisionPayload, type DescriptorSpec, type EntityKind, type EnvelopeIntent, type ExpertEvidenceBasis, type MeasuredValue,
  type MeasurementPlan, type OpenedEnvelope, type PartyVerdict, type PlanTaskRow, type PlatformRef, type PolicyRef, type RecordKind, type RecordOf,
  type RecordSigner, type RegistryMember, type RegistryTaskKind, type SignedEnvelope, type StoredRelayCheck, type TaskPayload, type WrdRecord,
} from '../src/records.js';
import {
  PodView, publishRecord, copyRecordToHolder, openPod, modalFor, isSealedShut, KeyedMutex, StaleHeadError, PodWriteError, PodReadError,
  IncompleteManifestError, RecordNotSealableError, MORE_THAN_ONE_CURRENT,
  type GraphHeads, type LineCut, type LoadedRecord, type PlatformSigner, type VerifyCache,
} from './pod-helpers.js';

export type { PlatformSigner };

export interface DemoPersona { readonly id: string; readonly label: string; readonly wallet: Wallet }

export interface WrdDeps {
  /** Pod transport; tests and the demo inject an in-memory pod. Never patch globalThis.fetch. server.ts passes operatorPodFetch(…). */
  readonly fetchFn?: FetchFn;
  /** Holder-copy transport: never carries the operator's pod credential. Defaults to `fetchFn`; server.ts passes plain fetch. */
  readonly holderFetchFn?: FetchFn;
  readonly defaultPodUrl?: string;
  /** Pods this bridge reads and writes records on. Default: [defaultPodUrl] when set, else none, so every call is refused (403). */
  readonly servedPods?: readonly string[];
  /** The record key: every new version's graph is sealed to it, and sealed graphs are opened with it. Absent → plaintext records. */
  readonly recordKey?: EncryptionKeyPair;
  /**
   * The operator opens the read model to anyone who can reach the bridge: wrd.list_records and
   * wrd.calibration answer unsigned GETs, and wrd.envelope_template fills its context from the pod.
   * Default false: reads need a signed read (wrd.read_records, wrd.read_calibration).
   */
  readonly publicReads?: boolean;
  /** Determinism. */
  readonly now?: () => Date;
  /** Absent → a key is generated once, and every record discloses keyKind 'ephemeral'. */
  readonly platform?: PlatformSigner;
  /** Further platform signers whose records are trusted (key rotation). */
  readonly trustedPlatformAddresses?: readonly string[];
  /** May sign wrd:update-registry: 0x addresses (compared lower-cased); anything else throws, so a user DID never enters the admins lower-cased (it goes in adminDids). */
  readonly adminAddresses?: readonly string[];
  /**
   * Interego user DIDs (did:web:<identity host>:users:<id>) who are admins too, alongside
   * adminAddresses: a person who signs in with their Interego account, through a relay-delegated
   * request. Kept exactly as spelled; a value that is not a user DID throws.
   */
  readonly adminDids?: readonly string[];
  /**
   * Relay-delegated identity ("Sign in with your Interego account"). A request in the relay's
   * signed shape ({_signed_payload, _signature}, at the top level of the body or under the
   * envelope input) is taken as relay-delegated only when its signature recovers to one of
   * `relayAddresses`; it then names the person the agent it was signed for belongs to (its DID
   * document on `identityHost`, read through `fetchDidDocument`), and is checked as a key-held
   * envelope is. Any other request in that shape keeps the key-held route. Absent, or with no
   * relay address, no request is relay-delegated; with an identityHost, the registry still accepts
   * user DIDs on it. RELAY-ATTESTED, NOT USER-HELD: whoever holds a listed relay key, or controls
   * the identity host, can act here as any person.
   */
  readonly relayDelegation?: {
    /** 0x addresses of the relay delegation keys trusted for new requests (compared lower-cased). */
    readonly relayAddresses: readonly string[];
    /**
     * 0x addresses of relay delegation keys retired from new requests (key rotation): no request
     * they sign now is relay-delegated, and a stored countersign they signed still re-verifies
     * when its outcome is recorded (verifyStoredEnvelope reads these and relayAddresses).
     */
    readonly retiredRelayAddresses?: readonly string[];
    /** The identity host, e.g. identity.interego.xwisee.com. */
    readonly identityHost: string;
    /** GET a DID document by URL; SSRF-guarded, time-limited, size-capped and cached by the caller (server.ts). */
    readonly fetchDidDocument: (url: string) => Promise<unknown>;
    /** True lifts the limit on decisive acts (DECISIVE_INTENTS) to this bridge's own UI agent: WRD_CHAT_AGENTS_DECIDE=1. */
    readonly chatAgentsDecide?: boolean;
    /** The relay a person signs in through, reported in the read model for the web UI (WRD_RELAY_URL). */
    readonly relayUrl?: string;
  };
  /** ONLY the offline demo sets this: adds the wrd.demo_envelope handler and marks every record demo. */
  readonly demoPersonas?: ReadonlyMap<string, DemoPersona>;
  /** ONLY the offline demo sets this (with demoPersonas): moves its scripted clock forward, for wrd.demo_advance_clock. */
  readonly demoClockAdvance?: (ms: number) => void;
  /** Default 15 minutes back, 2 minutes ahead. */
  readonly envelopeWindow?: { readonly pastMs: number; readonly futureMs: number };
  /** Monte Carlo draws; default DRAWS (5000), recorded on every valuation. */
  readonly draws?: number;
  /**
   * wrd.holder_copy reads every version on the pod. Default: signers neither an admin nor in the
   * registry (their keys cost nothing to make) share one lane, one copy at a time, and
   * HOLDER_COPY_STRANGERS_PER_MINUTE calls a minute, charged when a call arrives; admins and
   * registry members have their own HOLDER_COPY_CONCURRENT copies at once, which strangers never take.
   */
  readonly holderCopyLimits?: { readonly strangersPerMinute: number; readonly concurrent: number };
}

/** The default holderCopyLimits: a few copies a minute, one at a time, from keys the registry does not hold, and two at once for admins and members. */
export const HOLDER_COPY_STRANGERS_PER_MINUTE = 4;
export const HOLDER_COPY_CONCURRENT = 2;

export type WrdHandler = (args: Record<string, unknown>) => Promise<unknown>;

// ── Prose, kept out of return literals ───────────────────────────────────────────────────

const READS_SIGNED = 'Reads through this bridge need a signed read from an admin or a key in this pod\'s registry.';
const READS_PUBLIC = 'Anyone who can reach this bridge can read every record on this pod (the operator opened reads).';
/** What keyed entity IRIs still show, said exactly (README, "Keyed entity IRIs"). */
const KEYED_IRI_LINKS = 'A keyed IRI is urn:wrd:<kind>:k<fingerprint>:<scope>:<id>. The fingerprint (8 hex) names the record key it was derived under and reveals nothing about the key. Each segment is keyed with its kind and position, so segments of different kinds or positions never match, and equal segments mean the same thing in the same kind: the scope segment groups records of one kind by what they are scoped to (tasks, classifications, plans and decisions of one workflow; valuations and acknowledgements of one plan; runs of one agent on one kind of task; grants of one agent; holder copies of one holder; every workflow on the pod), which the bridge needs to select them from the manifest, and the id segment is equal where the id is (a task\'s position across workflows, one person\'s acknowledgements of one task across plans, grants on one kind of task across agents, valuations of the same inputs, runs given the same runId). Times link what one call writes: its records share generatedAtTime and validFrom and are written one after another, and capturing a workflow (or recording a task map) writes its first version with its tasks, and adding or retiring a task writes the task with the workflow version that lists or drops it, so which workflow a task belongs to, and its place among the tasks captured with it, are public whatever the IRIs hide. Every other call writes one record.';
const AT_REST_SEALED = 'Record graphs this bridge writes are sealed to its record key on the pod (the record id of each version written so ends with the key\'s fingerprint), and the entity IRIs this bridge derives from who and what a record is about are keyed with it (records written before the key keep their unkeyed IRIs). Graphs written before the key (versions whose record id names no key) stay plaintext on the pod: this bridge never re-seals a version, so anyone the pod lets read wrd/records/ reads them, and a pod that serves anonymous reads serves them to everyone, until they are removed from the pod; the read model counts them under plaintext. Descriptors and the manifest stay public: each record\'s kind, its signers and whether each signed as curator or validator, its modal status and confidence, its times, and the versions it supersedes and was derived from. What those show together stays public too: for example, a task version signed by a validator alone and left Hypothetical is a dispute by one party, and a decision that carries a confidence and derives from a valuation is a valued one. ' + KEYED_IRI_LINKS;
const AT_REST_PLAIN = 'Records are written in plaintext: anyone the pod lets read wrd/records/ reads them, and a pod that serves anonymous reads serves them to everyone.';
const SIGNED_READ_NEEDED = 'Reading records through this bridge needs a signed read.';
const CONTEXT_WITHHELD = 'Withheld: without a signed read this template carries only the intent, the pod, issuedAt, nonce, the IRIs you named and the head binding (descriptorUrl, graphDigest, recordId). Fields that depend on what a record says (a task\'s text digest, a plan\'s tasks, a decision\'s kind, valuation or window) are left empty. POST the same arguments to wrd.read_envelope_template with a signed wrd:read-records envelope as read_envelope in the JSON body, from an admin or a key in the registry, to have them filled.';
const SIGNED_READ_IN_URL = 'A signed read is never sent in a URL.';
const KEY_MISMATCH = 'This pod holds records whose IRIs were derived under a record key this bridge does not hold.';
const KEY_SEALED_MISMATCH = 'This pod holds records sealed to a record key this bridge does not hold.';
/** Said beside the versions written before the record key, whose graphs are plaintext on the pod. */
const PLAINTEXT_NOTE = 'These versions were written without a record key (their record ids name none), so their graphs are plaintext on the pod: anyone the pod lets read wrd/records/ reads them, and a pod that serves anonymous reads serves them to everyone. This bridge never re-seals a version (its proof binds the bytes and the URL it was written at); they stay readable until they are removed from the pod. Each descriptor links its graph.';
/** How many of those versions the read model lists by URL (it counts them all). */
const PLAINTEXT_LISTED = 20;
const SEALED_RECORDS = 'Records this bridge cannot open (sealed to another WRD_RECORD_KEY, or their sealed bytes changed on the pod) are listed here and never read as absent: a figure that would depend on one is marked rather than computed without it (see unreadable).';
const NEXT_RECLASSIFY = 'Re-classify this task, then propose a plan.';
const CONTRARY_NOTE = 'Reviewed runs on this task disagree with its classification often enough to look again; nothing changes until someone re-classifies it.';
const UNACKNOWLEDGED = 'named by the operator, not acknowledged';
const UNREADABLE_ACK = 'the acknowledgement record cannot be read, so whether the person named acknowledged is unknown';
const ACKNOWLEDGED = 'acknowledged by the person named';
const OBJECTED = 'objected to by the person named';
const NOT_DECLARED = 'not declared';
const INTEGRITY = 'A record this call depends on was altered after signing, or more than one version claims to be current.';
const DISTRUSTED_LINE = 'A record this call depends on has an earlier version signed by a platform key this bridge no longer trusts.';
const BAD_PAYLOAD = 'The envelope payload is malformed.';
const NOT_WELL_FORMED = 'The request holds text that is not well-formed Unicode.';
const REPLAYED = 'This envelope was already used.';
const HOLDER_COPY_BUSY = 'Too many copies are being taken from this bridge right now; nothing was copied.';
const NOT_FOUND_TASK = 'No such task on this pod.';
const RETIRED = 'This task was retired.';
const TASK_MOVED = 'The task changed since you read it.';
const DECISION_MOVED = 'The decision changed since you read it.';
const STALE_PLAN = 'A task was re-classified or revised after this plan was proposed; propose again.';
const RETIRED_IN_PLAN = 'A task in this plan was retired; propose again.';
const RETIREMENT_UNFINISHED = 'This task was retired, but its workflow still lists it as current: retire it again to finish.';
const ADD_UNLISTED = 'The task was recorded, but its workflow does not list it: add it again.';
const CLOCK_SKEW = 'The clock reads earlier than the start of what is being withdrawn; retry.';
const UNKNOWN_KIND = 'This task kind is not registered, or was retired.';
const KIND_FIX = 'an admin declares task kinds in the registry';
const SUSPENDED = 'this work has no authorised performer until a new decision changes it';
const SIGNING_RULE = `Sign EIP-191 personal_sign over canonicalJson(payload) — keys sorted recursively, arrays in order, undefined dropped — and send {payload, signature} as the envelope input of toolName. ${RELAY_SIGNING}`;
/**
 * Acts that change who may do what: the registry (roles, admins' attestations, agents'
 * principals), approving or declining a decision (and approving over an objection or silence),
 * recording an approved decision's outcome (reverted or stopped early, it takes the decision's
 * allocation out of force, which for a within-grant change withdraws an agent's authority as a
 * revocation does; kept, it closes the measurement for good), and granting or withdrawing an
 * agent's autonomy. A relay-delegated request for one of these is taken only from this bridge's
 * own web UI, whose agent slug starts UI_AGENT_PREFIX (the relay derives it from the OAuth
 * client's name), unless the operator sets WRD_CHAT_AGENTS_DECIDE=1.
 */
const DECISIVE_INTENTS: ReadonlySet<EnvelopeIntent> = new Set(['wrd:update-registry', 'wrd:countersign-decision', 'wrd:record-outcome', 'wrd:grant-autonomy', 'wrd:revoke-grant']);
const UI_AGENT_PREFIX = 'work-redesign-';
/** The arguments wrd.envelope_template reads beside pod_url; a relay-signed read may name them under `template` in its signed payload. */
const TEMPLATE_ARGS = ['intent', 'subject', 'task_iri', 'workflow_iri', 'plan_iri', 'decision_iri', 'grant_iri'] as const;
const CHAT_AGENT_DECIDES = 'This act changes who may do what, and a chat agent signed it in: it is taken from this bridge\'s own web UI, or from a chat agent only when the operator sets WRD_CHAT_AGENTS_DECIDE=1.';
const RELAY_UNVERIFIED = 'The relay-signed request does not name a person this bridge can verify.';
/** The tool each write intent is sent to. */
const TOOL_OF_INTENT: Readonly<Record<EnvelopeIntent, string>> = {
  'wrd:update-registry': 'wrd.update_registry', 'wrd:capture-workflow': 'wrd.capture_workflow', 'wrd:record-task-map': 'wrd.record_task_map',
  'wrd:revise-task': 'wrd.revise_task', 'wrd:ratify-task': 'wrd.ratify_task', 'wrd:classify-task': 'wrd.classify_task',
  'wrd:propose-allocation': 'wrd.propose_allocation', 'wrd:value-plan': 'wrd.value_plan', 'wrd:submit-decision': 'wrd.submit_decision',
  'wrd:countersign-decision': 'wrd.countersign_decision', 'wrd:record-outcome': 'wrd.record_outcome', 'wrd:agent-run': 'wrd.log_agent_run',
  'wrd:review-agent-run': 'wrd.log_agent_run', 'wrd:grant-autonomy': 'wrd.grant_autonomy', 'wrd:revoke-grant': 'wrd.revoke_grant',
  'wrd:holder-copy': 'wrd.holder_copy', 'wrd:read-records': 'wrd.read_records',
};

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

/** A read_envelope parameter, however a client spelled the object into the URL: read_envelope, read_envelope[signature] (qs, jQuery), read_envelope.payload, read_envelope[]. */
const SIGNED_READ_KEY = /^read[-_]?envelope(?:$|[[.])/i;
/**
 * A key with a step named for a signature, bare, bracketed or dotted, and whatever bracketed or
 * dotted steps follow it: signature, signature[], signature[0], x[signature], x[signature][],
 * x.signature, x.signature.0.
 */
const SIGNATURE_KEY = /(?:^|[[.])signature\]?(?:\[[^\]]*\]|\.[^.[\]]*)*$/i;
/** Text holding a 0x-prefixed 65-byte signature (130 hex), or a "signature" JSON field: what a signed read carries, in a key or a value. */
const SIGNATURE_TEXT = /0x[0-9a-f]{130}|"signature"\s*:/i;
/**
 * Where a GET's arguments carry a signed read, or null. A GET's arguments are its query string,
 * every parameter of it (each composition installs parseEveryQueryPair: Express's default parser
 * drops every pair after the first 1000, and those would never reach this check), so every key
 * and every value is looked at, nested to any depth, for exactly these: a
 * read_envelope parameter in any spelling above; a key with a step named for a signature,
 * whatever bracketed or dotted steps follow it (SIGNATURE_KEY); and a key or a
 * value holding a 0x-prefixed 65-byte signature or a "signature" JSON field (so a signed read
 * sent as a bare key with no value is found). Nothing else is: a signature written without its
 * 0x, or JSON naming it some other way, passes this check, and the GET still never reads with it.
 * The answer names the top-level argument, never text that holds a signature.
 */
function signedReadIn(args: Obj): string | null {
  const keyCarries = (k: string): boolean => SIGNED_READ_KEY.test(k) || SIGNATURE_KEY.test(k) || SIGNATURE_TEXT.test(k);
  for (const [k, v] of Object.entries(args)) {
    const where = SIGNATURE_TEXT.test(k) ? 'an argument whose name holds a signature (not repeated here)' : `the argument ${JSON.stringify(k.slice(0, 64))}`;
    if (keyCarries(k)) return where;
    const stack: unknown[] = [v];
    while (stack.length > 0) {
      const x = stack.pop();
      if (typeof x === 'string') {
        if (SIGNATURE_TEXT.test(x)) return where;
      } else if (typeof x === 'object' && x !== null) {
        for (const [kk, xx] of Object.entries(x)) {
          if (keyCarries(kk)) return where;
          stack.push(xx);
        }
      }
    }
  }
  return null;
}

/** A refusal raised from a helper; the handler wrapper returns it as the answer. */
class Declined extends Error {
  constructor(readonly refusal: BridgeRefusal) { super(refusal.error); }
}
const decline = (status: number, error: string, why: string, resolvedBy?: Record<string, unknown>): Declined =>
  new Declined(refuse(status, error, why, resolvedBy));
/** The affordance that resolves a refusal. */
const via = (tool: string): Record<string, unknown> => ({ action: `urn:iep:action:wrd:${tool.replace(/_/g, '-')}`, toolName: `wrd.${tool}` });
const viaToolName = (toolName: string): Record<string, unknown> => via(toolName.replace(/^wrd\./, ''));
/** The tools a signed read (wrd:read-records) is sent to, always in a POST body. */
type SignedReadTool = 'read_records' | 'read_calibration' | 'read_envelope_template';
/** The signed read that resolves a refusal: the tool, and the intent its envelope carries. */
const readVia = (tool: SignedReadTool): Record<string, unknown> => ({ ...via(tool), intent: 'wrd:read-records' });

function need(p: Obj, key: string, max: number, path = 'payload'): string {
  const v = p[key];
  if (typeof v !== 'string' || v.trim() === '') throw decline(400, BAD_PAYLOAD, `${path}.${key} is required text`);
  if (v.length > max) throw decline(400, BAD_PAYLOAD, `${path}.${key} is longer than ${max} characters`);
  return v;
}
function maybe(p: Obj, key: string, max: number, path = 'payload'): string | undefined {
  return p[key] === undefined ? undefined : need(p, key, max, path);
}
const ENTITY_IRI = new RegExp(ENTITY_IRI_PATTERN);
function needIri(p: Obj, key: string): string {
  const v = p[key];
  if (typeof v !== 'string' || !ENTITY_IRI.test(v)) throw decline(400, BAD_PAYLOAD, `payload.${key} must be a wrd entity IRI`);
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

/**
 * Why a forked or altered graph cannot be used, naming the head that is not trusted (a sealed one
 * first): its descriptor need not be one the graph's own chain wrote, since a manifest listing can
 * put a version of another graph of the kind among its heads (see ofGraph), so the operator is
 * pointed at the bytes to restore. A fork of trusted heads, or of none (a cycle), says which.
 */
const unusableWhy = (g: GraphHeads): string => {
  const bad = g.heads.find(isSealedShut) ?? g.heads.find((h) => !h.authorship.trusted);
  const why = bad?.why ?? 'it was altered after signing';
  if (g.state === 'forked') return `${g.why ?? MORE_THAN_ONE_CURRENT}${bad ? `, and one of them (${bad.descriptorUrl}) is not trusted: ${why}` : ''}`;
  return `its current version${bad ? ` (${bad.descriptorUrl})` : ''} is not trusted: ${why}`;
};
/** The refusal for a graph a head of which is sealed and does not open: 409, naming that head and the setting that opens it. */
const sealedRefusal = (g: GraphHeads): Declined => decline(409, INTEGRITY, `${g.graphIri}: ${unusableWhy(g)}`, { env: 'WRD_RECORD_KEY' });
/** Why a graph's line does not reach its first version (see PodView.line). */
const cutWhy = (graphIri: string, cut: LineCut): string => `${graphIri}: ${cut.why}`;
/** The setting that restores a cut line, when one does: the record key for a version sealed shut, the trusted addresses for one a distrusted platform key signed. */
const cutSetting = (cut: LineCut): Record<string, unknown> | undefined => (cut.sealed ? { env: 'WRD_RECORD_KEY' }
  : cut.untrustedKey !== null ? { env: 'WRD_TRUSTED_PLATFORM_ADDRESSES', address: cut.untrustedKey } : undefined);

/**
 * The current version of a graph as a record of `kind`, null when the graph is absent; 409 when
 * forked or altered. A head whose sealed graph does not open is altered (never absent): the 409
 * names WRD_RECORD_KEY.
 */
function headIn<K extends RecordKind>(g: GraphHeads, kind: K): Head<K> | null {
  if (g.state === 'absent') return null;
  if (g.state !== 'ok') {
    if (g.heads.some(isSealedShut)) throw sealedRefusal(g);
    // A forked graph says which way (two current versions, or none); an altered head says which and why: changed bytes, modal status, describes or link.
    throw decline(409, INTEGRITY, `${g.graphIri}: ${unusableWhy(g)}`);
  }
  const loaded = g.heads[0];
  if (!loaded || !loaded.record || loaded.record.recordKind !== kind) throw decline(409, INTEGRITY, `${g.graphIri} does not hold a ${kind} record`);
  return { loaded, record: loaded.record as RecordOf<K>, graph: g };
}

const bindingOf = (l: { readonly descriptorUrl: string; readonly graphDigest: string }): Obj => ({ descriptorUrl: l.descriptorUrl, graphDigest: l.graphDigest });

/**
 * A retirement writes the task, then its workflow. A retired task whose workflow's current
 * version still lists it as a task, or never lists it as retired, is one whose second write did
 * not land.
 */
const retirementUnfinished = (task: RecordOf<'Task'>, wf: RecordOf<'Workflow'> | null | undefined): boolean =>
  task.status === 'retired' && !!wf && (wf.payload.taskIris.includes(task.entityIri) || !wf.payload.retiredTaskIris.includes(task.entityIri));

/** The call that finishes such a retirement: retire the task again, bound to its retired version. */
const finishRetirementVia = (taskIri: string, retired: { readonly descriptorUrl: string; readonly graphDigest: string }): Record<string, unknown> =>
  ({ ...via('revise_task'), op: 'retire', taskIri, ...bindingOf(retired) });

/** Refuse (409) work on a workflow that still lists a retired task, naming the call that finishes the retirement. */
function unfinishedRetirement(task: Head<'Task'>, workflowIri: string): BridgeRefusal {
  const r = task.record.payload.retirement;
  return refuse(409, RETIREMENT_UNFINISHED,
    `${task.record.entityIri} was retired${r ? ` by ${r.by.did} at ${r.at}` : ''} (${task.loaded.descriptorUrl}), but the current version of ${workflowIri} still lists it`,
    finishRetirementVia(task.record.entityIri, task.loaded));
}

/**
 * A call that wrote its task and then failed on the workflow: says what landed and what to do
 * next, at the status the failure itself deserves.
 */
function partlyWritten(e: unknown, error: string, landed: string, resolvedBy: Record<string, unknown>): BridgeRefusal {
  const f = failureOf(e);
  return refuse(f['iep:refusalStatus'] ?? 500, error, `${landed}. The workflow write: ${f.error} ${f['iep:refusalReason'] ?? ''}`.trim(), resolvedBy);
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
/** A registry entry by principal: an address lower-cased, a user DID as spelled (principalKey). */
const memberOf = (reg: Registry, a: string | undefined): RegistryMember | undefined => (a ? reg.members.get(principalKey(a)) : undefined);
const isPerson = (reg: Registry, a: string | undefined): boolean => { const m = memberOf(reg, a); return !!m && !m.softwareAgent; };
const isAgent = (reg: Registry, a: string | undefined): boolean => { const m = memberOf(reg, a); return !!m && m.softwareAgent && m.roles.includes('agent'); };
const holds = (reg: Registry, a: string, role: RegistryRole): boolean => {
  const m = memberOf(reg, a);
  return !!m && m.roles.includes(role) && (role === 'agent' ? m.softwareAgent : !m.softwareAgent);
};
/**
 * The person an admin attests is behind a key or a user DID; an unregistered key is only ever its
 * own person (`address:<0x>`), and an unregistered user DID its own (the DID): never the same.
 */
const personRefOf = (reg: Registry, a: string): string => memberOf(reg, a)?.personRef ?? (isUserPrincipal(a) ? a : `address:${lower(a)}`);
/** The principal a stored did names (a did:ethr's address, a user DID itself). */
const addressOfDid = (did: string): string => principalOfDid(did);
/**
 * Added to a role refusal when the recovered address is not in the registry at all. A payload
 * changed after signing does not fail the signature check: it recovers a different address, so
 * "this key holds no role" may really mean "these bytes were altered".
 */
const unregisteredHint = (reg: Registry, a: string): string => (memberOf(reg, a) ? ''
  : isUserPrincipal(a) ? '. This Interego user is not in the registry at all: an admin registers their user DID'
    : '. This address is not in the registry at all: if the envelope was signed by a registered key, its payload was changed after signing');
const kindUsable = (reg: Registry, slug: string): RegistryTaskKind | null => {
  const k = reg.kinds.get(slug);
  return k && !k.retired ? k : null;
};

function signerOf(reg: Registry, address: string, facetRole: 'Curator' | 'Validator', acted: string): RecordSigner {
  const a = principalKey(address);
  const m = reg.members.get(a);
  return {
    did: didOf(a), address: a, personRef: m && !m.softwareAgent ? m.personRef : null, softwareAgent: m?.softwareAgent ?? false, facetRole, acted,
    // A user DID holds no key: whatever it signed, the relay signed for it.
    ...(isUserPrincipal(a) ? { authority: 'relay-delegated' as const } : {}),
  };
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

/** An allocation a decision put in force, and since when. */
interface Effective {
  readonly allocation: Allocation; readonly decisionIri: string; readonly at: string;
  readonly source: 'approved-decision' | 'measured-decision';
}

/** Whether (and as what) a decision puts its plan's allocations in force: see effectiveFrom. */
function inForceAs(d: RecordOf<'Decision'>): Effective['source'] | null {
  const p = d.payload;
  if (p.decisionKind !== 'valued' || !p.countersign || p.countersign.verdict !== 'approve') return null;
  if (d.status === 'countersigned') return 'approved-decision';
  if (d.status === 'measured' && p.outcome?.disposition === 'kept') return 'measured-decision';
  return null;
}

/**
 * The allocation each task actually has: from the newest valued decision that changed it and is
 * either approved and still being measured ('approved-decision': the change is in force for its
 * measurement window) or measured and kept ('measured-decision'), ordered by when it was
 * approved. A decision measured as reverted or stopped early puts nothing in force, so the task
 * falls back to an earlier decision or to how it was captured. Probe decisions never move it.
 */
function effectiveFrom(decisions: ReadonlyArray<RecordOf<'Decision'>>, planOf: (planIri: string) => RecordOf<'Plan'> | null): Map<string, Effective> {
  const out = new Map<string, Effective>();
  for (const d of decisions) {
    const p = d.payload;
    const source = inForceAs(d);
    if (source === null || !p.countersign) continue;
    const at = p.countersign.at;
    for (const row of planOf(p.planIri)?.payload.tasks ?? []) {
      if (!row.changed) continue;
      const prev = out.get(row.taskIri);
      if (!prev || prev.at < at) out.set(row.taskIri, { allocation: row.proposed, decisionIri: d.entityIri, at, source });
    }
  }
  return out;
}

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
  const copyLimits = deps.holderCopyLimits ?? { strangersPerMinute: HOLDER_COPY_STRANGERS_PER_MINUTE, concurrent: HOLDER_COPY_CONCURRENT };
  /** When each recent holder copy from a key the registry does not hold was let through (the last minute's). */
  const strangerCopies: number[] = [];
  /** Copies in progress for admins and registry members, and for every other signer, kept apart. */
  let copiesInProgress = 0;
  let strangerCopiesInProgress = 0;
  const mutex = new KeyedMutex();
  const verifyCache: VerifyCache = new Map();
  for (const a of deps.adminAddresses ?? []) if (!isAddress(a)) throw new TypeError(`adminAddresses holds ${String(a).slice(0, 120)}, which is not a 0x address (40 hex characters); a user DID is an admin through adminDids`);
  for (const d of deps.adminDids ?? []) if (!isUserPrincipal(d)) throw new TypeError(`adminDids holds ${String(d).slice(0, 120)}, which is not an Interego user DID (did:web:<host>:users:<id>)`);
  /** Admins by principal: addresses lower-cased, user DIDs as spelled (principalKey), so neither can stand for the other. */
  const admins = new Set([...(deps.adminAddresses ?? []).map(lower), ...(deps.adminDids ?? [])]);
  const isAdmin = (principal: string): boolean => admins.has(principalKey(principal));
  const relay = deps.relayDelegation;
  /** The identity host user DIDs must be on to enter the registry or act; null when none is configured (then no DID does either). */
  const identityHost = relay ? relay.identityHost.toLowerCase() : null;
  const relayAddresses = new Set((relay?.relayAddresses ?? []).map(lower));
  /** The verifier's policy; null when no relay is trusted, and then no request is relay-delegated. */
  const relayPolicy: RelayDelegationPolicy | null = relay && identityHost !== null && relayAddresses.size > 0
    ? { relayAddresses: [...relayAddresses], identityHost, fetchDidDocument: relay.fetchDidDocument } : null;
  /** Relay keys retired from new requests: read only where a stored envelope is re-checked. */
  const retiredRelays = new Set((relay?.retiredRelayAddresses ?? []).map(lower));
  /** What a stored relay-delegated envelope is re-checked against, offline (verifyStoredEnvelope): the relays trusted now and the retired ones. */
  const storedRelay: StoredRelayCheck | undefined = identityHost === null ? undefined : { relayAddresses: [...new Set([...relayAddresses, ...retiredRelays])], identityHost };
  /** A user DID this bridge accepts as a principal: one on its identity host. */
  const isHostUser = (v: unknown): v is string => typeof v === 'string' && identityHost !== null && isUserDid(v, identityHost);
  const demo = deps.demoPersonas && deps.demoPersonas.size > 0 ? deps.demoPersonas : null;
  const draws = deps.draws ?? DRAWS;
  const clock = (): Date => (deps.now ? deps.now() : new Date());
  const publicReads = deps.publicReads === true;
  const recordKey = deps.recordKey;
  const podOrNull = (u: string): string | null => { try { return normalisePodUrl(u); } catch { return null; } };
  const served: readonly string[] = (deps.servedPods ?? (deps.defaultPodUrl ? [deps.defaultPodUrl] : []))
    .map(podOrNull).filter((u): u is string => u !== null);
  /** What reads and the pod expose, for a read model; `plaintext` is the number of versions written before the record key (with one). */
  const readExposureOf = (plaintext: number): string => `${publicReads ? READS_PUBLIC : READS_SIGNED} ${recordKey === undefined ? AT_REST_PLAIN
    : `${plaintext > 0 ? `This pod holds ${plaintext} record version(s) written before the record key, whose graphs are plaintext (listed under plaintext). ` : ''}${AT_REST_SEALED}`}`;
  /** The key entity IRIs are derived under: present only with a record key. */
  const iriKey = recordKey ? entityIriKey(recordKey) : undefined;
  /** The public fingerprint every IRI this bridge keys carries (see iriKeyFingerprint); null without a record key. */
  const ownFingerprint = iriKey === undefined ? null : iriKeyFingerprint(iriKey);

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
    /** Set when the relay signed this call for the actor (relay-delegated): the agent it signed for and the relay address. */
    readonly relayed?: { readonly agentId: string; readonly relaySigner: string };
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
    // The served list first, with no network: resolving a caller's host before refusing it would
    // let anyone tell a privately resolving name from any other by the refusal it gets.
    if (!served.includes(podUrl)) {
      throw served.length === 0
        ? decline(403, 'This bridge serves no pod.', 'pod-not-served: the operator sets WRD_DEFAULT_POD_URL or WRD_SERVED_PODS', { env: 'WRD_SERVED_PODS' })
        : decline(403, `This bridge reads and writes records only on the pods it serves (${served.join(', ')}).`, `pod-not-served: ${podUrl} is not one of them`);
    }
    let fetchFn: FetchFn;
    try { fetchFn = await openPod(podUrl, deps.fetchFn); } catch (e) { throw decline(400, 'The pod URL is not a safe target.', messageOf(e)); }
    const p = await platform();
    const now = clock();
    const trusted = new Set([lower(p.wallet.address), ...(deps.trustedPlatformAddresses ?? []).map(lower)]);
    return {
      podUrl, fetchFn, now, at: now.toISOString(), view: new PodView(podUrl, fetchFn, trusted, verifyCache, strict, recordKey), platform: p,
      platformRef: { did: didOf(p.wallet.address), address: lower(p.wallet.address), keyKind: p.keyKind }, trusted,
    };
  }

  // ── Relay-delegated requests ─────────────────────────────────────────────────────────

  /** A request in the relay's signed shape whose signature recovers to a relay this bridge trusts. */
  interface RelayForm { readonly signedPayload: string; readonly signature: string; readonly parsed: Obj | null }
  /**
   * The relay-signed form of a request (under `key`, or at the top level of the body, where the
   * relay's act puts it), but only when its signature over sha256 of the signed text recovers to
   * a relay this bridge trusts; otherwise null, and the request takes the key-held route exactly as
   * before (a request any other key signed in the same shape included). Reads no network.
   */
  function relayFormIn(args: Obj, key: string): RelayForm | null {
    if (relayPolicy === null) return null;
    const found = relayEnvelopeOf(key === 'envelope' ? args : { ...args, envelope: args[key] });
    if (found === null || typeof found.signedPayload !== 'string' || typeof found.signature !== 'string') return null;
    if (found.signedPayload === '' || !/^0x[0-9a-fA-F]{130}$/.test(found.signature)) return null;
    let signer: string;
    try { signer = recoverMessageSigner(`sha256:${sha256Hex(found.signedPayload)}`, found.signature).toLowerCase(); } catch { return null; }
    if (!relayAddresses.has(signer)) return null;
    let parsed: Obj | null = null;
    try { const v: unknown = JSON.parse(found.signedPayload); parsed = isObj(v) ? v : null; } catch { parsed = null; }
    return { signedPayload: found.signedPayload, signature: found.signature, parsed };
  }
  /** What openCall reads the pod from for a relay-signed request: its pod_url, never subject_pod_url. */
  const relayPodCarrier = (form: RelayForm): Obj => ({ payload: { ...(typeof form.parsed?.['pod_url'] === 'string' ? { podUrl: form.parsed['pod_url'] } : {}) } });
  /**
   * Open a trusted relay-signed request for the current call: openRelayDelegated names the
   * person (reading the agent's DID document from the identity host), then bindRelayDelegated
   * checks it as openEnvelope checks a key-held envelope (intent, pod_url, nonce, the relay's
   * timestamp within the window).
   */
  async function openRelay(form: RelayForm, intent: EnvelopeIntent, call: Call, win = window): Promise<OpenedEnvelope> {
    if (relayPolicy === null) return { ok: false, status: 401, error: RELAY_UNVERIFIED, why: 'this bridge trusts no relay (WRD_TRUSTED_RELAY_ADDRESSES)' };
    const v = await openRelayDelegated(form.signedPayload, form.signature, relayPolicy);
    if (!v.ok) return { ok: false, status: v.status, error: RELAY_UNVERIFIED, why: `${v.code}: ${v.message}` };
    return bindRelayDelegated(v, intent, call.podUrl, call.now, win);
  }
  /**
   * The limit on decisive acts: a relay-delegated request for one of DECISIVE_INTENTS is refused
   * (403, naming WRD_CHAT_AGENTS_DECIDE) unless its agent is this bridge's own web UI (its slug
   * starts UI_AGENT_PREFIX) or the operator lifted the limit. Key-held envelopes are not affected.
   */
  function refuseChatDecision(opened: Extract<OpenedEnvelope, { ok: true }>, intent: EnvelopeIntent): void {
    if (opened.authority !== 'relay-delegated' || !DECISIVE_INTENTS.has(intent) || relay?.chatAgentsDecide === true) return;
    const slug = identityHost === null ? null : agentSlugOf(opened.agentId ?? '', identityHost);
    if (slug !== null && slug.startsWith(UI_AGENT_PREFIX)) return;
    throw decline(403, CHAT_AGENT_DECIDES,
      `${intent} was signed by the relay for ${opened.signer} through the agent ${opened.agentId ?? '(none)'}, whose slug does not start ${UI_AGENT_PREFIX} (this bridge's web UI); the operator sets WRD_CHAT_AGENTS_DECIDE=1 to take decisive acts from chat agents too`,
      { env: 'WRD_CHAT_AGENTS_DECIDE' });
  }
  /** The envelope that authorises a call, by either route: relay-delegated when relayFormIn found a trusted relay form, else key-held. */
  async function openAuthorising(call: Call, form: RelayForm | null, raw: unknown, intent: EnvelopeIntent, win = window): Promise<OpenedEnvelope> {
    return form ? openRelay(form, intent, call, win) : openEnvelope(raw, intent, call.podUrl, call.now, win);
  }

  /**
   * Open the envelope that authorises this call, then claim its nonce in the in-process ledger —
   * only for a signer the registry knows (or an admin), so keys nobody registered cannot fill
   * the ledger (wrd.holder_copy claims any other signer's too, within the budget it bounds them by).
   * Every write is also checked against the pod itself (write(), below), which is the replay
   * protection that survives a restart and holds across bridge processes. Both are by principal:
   * a relay-delegated request spends its nonce as the person it names, never as the relay, which
   * signs for everyone.
   */
  async function openSigned(args: Obj, intent: EnvelopeIntent, key = 'envelope'): Promise<Signed> {
    const form = relayFormIn(args, key);
    const raw = form ? undefined : args[key];
    const call = await openCall(args, form ? relayPodCarrier(form) : raw, true);
    const opened = await openAuthorising(call, form, raw, intent);
    if (!opened.ok) throw new Declined(refuse(opened.status, opened.error, opened.why));
    refuseChatDecision(opened, intent);
    const nonce = String(opened.payload['nonce']);
    // Nothing is written on a pod holding records written under another record key, whoever signs (write() checks again).
    // Checked before the registry is read: on such a pod the registry may be sealed to that key, and the refusal names it.
    await refuseKeyConflict(call);
    if (isAdmin(opened.signer) || memberOf(await registryOf(call), opened.signer)) {
      if (!ledger.claim(opened.signer, nonce, call.now)) throw decline(409, REPLAYED, `${opened.signer} already used the nonce ${nonce} on this bridge`);
    }
    return {
      ...call, actor: opened.signer, actorDid: opened.did, payload: opened.payload, envelope: opened.envelope, nonce,
      ...(opened.authority === 'relay-delegated' ? { relayed: { agentId: opened.agentId ?? '', relaySigner: opened.relaySigner ?? '' } } : {}),
    };
  }

  /**
   * The document text a call sends: beside the envelope, or, for a relay-delegated request (the
   * relay's act POSTs only the signed pair), inside the payload the relay signed, whose sha256 is
   * bound as it is beside the envelope. `signed` says it came from the signed payload: the record
   * then keeps it whatever the payload says about storing it, since it stores the text the relay
   * signed, so the callers take it from there only where the document's text is stored anyway.
   */
  const documentTextOf = (args: Obj, call: Signed): { readonly text: unknown; readonly signed: boolean } =>
    args['document_text'] === undefined && call.relayed ? { text: call.payload['document_text'], signed: true } : { text: args['document_text'], signed: false };
  const RELAY_DOCUMENT_KEPT = 'document_text inside the relay-signed payload is kept with the record, which stores the text the relay signed';

  /**
   * Open a signed read (wrd:read-records): shape, intent, pod binding, signature and freshness,
   * exactly as for a write; then the signer must be an admin or a key the pod's registry holds.
   * A read changes nothing, so its nonce is not claimed: the same envelope reads again until its
   * issuedAt leaves the window, which is what lets the web UI sign one read and reuse it.
   */
  async function openRead(args: Obj, tool: 'read_records' | 'read_calibration'): Promise<{ readonly call: Call; readonly signer: string }> {
    const form = relayFormIn(args, 'envelope');
    const raw = form ? undefined : args['envelope'];
    const call = await openCall(args, form ? relayPodCarrier(form) : raw, false);
    const opened = await openAuthorising(call, form, raw, 'wrd:read-records');
    await authoriseRead(call, opened, tool);
    return { call, signer: opened.ok ? opened.signer : '' };
  }

  /**
   * Check an opened signed read (wrd:read-records, key-held or relay-delegated, already checked for
   * shape, intent, pod binding, signature and freshness): the signer must be an admin, or a key or
   * user DID the pod's registry holds.
   * Registry membership is decided on the WHOLE manifest: a lenient view would read an older
   * registry when the version that removed this key sits behind a segment that did not answer,
   * so for any signer but an admin an incomplete walk is refused as a write's is (502).
   */
  async function authoriseRead(call: Call, opened: OpenedEnvelope, tool: SignedReadTool): Promise<void> {
    if (!opened.ok) throw new Declined(refuse(opened.status, opened.error, opened.why, opened.status === 401 ? readVia(tool) : undefined));
    if (isAdmin(opened.signer)) return;
    if (!(await call.view.walk()).complete) throw new IncompleteManifestError(call.podUrl);
    const reg = await registryForRead(call);
    if (!memberOf(reg, opened.signer)) {
      throw decline(403, 'Only an admin or a key in this pod\'s registry can read its records.', `${opened.signer} is not an admin of this bridge and holds no role in this pod's registry${unregisteredHint(reg, opened.signer)}`, via('update_registry'));
    }
  }

  /** The refusal an unsigned GET of the read model gets while reads are not public. */
  const unsignedRead = (tool: 'read_records' | 'read_calibration'): BridgeRefusal => refuse(401, SIGNED_READ_NEEDED,
    `this bridge answers unsigned reads only when its operator opens them (WRD_PUBLIC_READS=1); sign a wrd:read-records payload as an admin or a key in the pod's registry and send it as the envelope of wrd.${tool}`,
    readVia(tool));

  async function headOf<K extends RecordKind>(call: Call, entity: string, kind: K): Promise<Head<K> | null> {
    return headIn(await call.view.graph(graphIriOf(entity)), kind);
  }

  // ── Records written under another record key ────────────────────────────────────────

  /**
   * A version on the pod written under a record key this bridge does not hold (any, when it holds
   * none): its signed record id names that key's fingerprint (recordIdFor), which shows it from the
   * key's very first write, a new version of a chain written before the key included; or its
   * signed content names a graph whose IRI was derived under that key.
   */
  interface KeyConflict {
    readonly graphIri: string; readonly descriptorUrl: string;
    /** The fingerprint of the record key the version was written under. */
    readonly fingerprint: string;
    /** The graph's IRI is keyed under that key (else it is an unkeyed IRI: a chain written before the key, sealed to it). */
    readonly keyedIri: boolean;
  }
  /** A fingerprint other than this bridge's own (any, when this bridge holds no record key). */
  const foreignFingerprint = (fp: string | null): fp is string => fp !== null && fp !== ownFingerprint;
  /** An IRI keyed under another key than this bridge's (or under any, when this bridge holds none). */
  const foreignKeyed = (iri: string): boolean => foreignFingerprint(fingerprintOfIri(iri));
  const conflicts = new WeakMap<PodView, Promise<KeyConflict | null>>();
  /**
   * The first version on the pod written under another record key, or null; looked for once per
   * call, in the manifest the call walks anyway. Only manifest entries whose descriptor URL ends
   * with another key's fingerprint, or which name a graph keyed under another key, are read, so a
   * pod keyed throughout under this bridge's key, or written without any, costs no read here, and
   * a version the pod cannot serve stops nothing unless its URL names another key. Of those, a
   * version counts only when a trusted platform key signed it where its proof says (eligible), and
   * then by what that key signed: the record id, which the URL repeats, or a graph IRI in content
   * that opened. Never by the envelope's recipient list or the descriptor's iep:describes, which a
   * pod writer can change: a version of this bridge's own key whose envelope a pod writer edited
   * does not open, answers 409 where it is used (altered), and stops nothing else. A version found
   * is a sign this bridge is not the one holding the key the pod's records are written under: it
   * derives other IRIs for new records than they carry and cannot open what is sealed, so a lookup
   * by tuple would find nothing and answer from that absence, and a write would start a second
   * chain beside the one it cannot see, and would seal what the key's own bridge then cannot read
   * (the registry, say) or, holding no key, write in plaintext what that key would have sealed.
   */
  function keyConflict(call: Call): Promise<KeyConflict | null> {
    let found = conflicts.get(call.view);
    if (!found) {
      found = (async (): Promise<KeyConflict | null> => {
        const names = (e: ManifestEntry): boolean => e.describes.some(foreignKeyed);
        // Entries naming a keyed IRI first: a conflict found there is reported by the IRI it keys, the plainer account.
        const candidates = (await call.view.entries()).filter((e) => names(e) || foreignFingerprint(fingerprintOfRecord(e.descriptorUrl)))
          .sort((a, b) => Number(names(b)) - Number(names(a)));
        for (const e of candidates) {
          const l = await call.view.read(e);
          if (!l.authorship.eligible) continue;
          const signed = fingerprintOfRecord(l.recordId);
          const keyedIn = l.authorship.trusted ? fingerprintOfIri(l.graphIri) : null;
          const fp = foreignFingerprint(signed) ? signed : foreignFingerprint(keyedIn) ? keyedIn : null;
          if (fp !== null) return { fingerprint: fp, keyedIri: fingerprintOfIri(l.graphIri) === fp, graphIri: l.graphIri, descriptorUrl: l.descriptorUrl };
        }
        return null;
      })();
      conflicts.set(call.view, found);
    }
    return found;
  }
  /** Why a bridge facing a KeyConflict cannot answer from what it finds, naming WRD_RECORD_KEY. */
  const keyConflictWhy = (c: KeyConflict): string => {
    const mine = ownFingerprint === null ? 'holds no record key' : `holds the one with fingerprint k${ownFingerprint}`;
    return c.keyedIri
      ? `${c.graphIri} (${c.descriptorUrl}) was derived under the record key with fingerprint k${c.fingerprint}, and this bridge ${mine} (WRD_RECORD_KEY): it derives other IRIs for the same records, so it would find them absent`
      : `${c.graphIri} (${c.descriptorUrl}) is sealed to the record key with fingerprint k${c.fingerprint} (its record id, which the platform signed, names it), and this bridge ${mine} (WRD_RECORD_KEY): it cannot open what was written under that key, nor derive the IRIs that key gives new records, so it would find them absent, and what it wrote would be ${recordKey === undefined ? 'in plaintext' : 'sealed where that key\'s bridge could not open it'}`;
  };
  /** The refusal (409, naming WRD_RECORD_KEY and both fingerprints) for a call a KeyConflict stops, saying what it stops. */
  const keyConflictRefusal = (c: KeyConflict, stops: string): Declined =>
    decline(409, c.keyedIri ? KEY_MISMATCH : KEY_SEALED_MISMATCH, `${keyConflictWhy(c)}; ${stops}`, { env: 'WRD_RECORD_KEY' });
  /** Refuse (409, naming WRD_RECORD_KEY) a write or a lookup by tuple on a pod holding records written under another record key. */
  async function refuseKeyConflict(call: Call): Promise<void> {
    const c = await keyConflict(call);
    if (c) throw keyConflictRefusal(c, 'it writes nothing and looks nothing up by tuple until it runs with that key');
  }

  // ── Entity IRIs derived from a tuple: keyed when this bridge holds a record key ─────────

  /** The IRIs a tuple can have on this pod: the keyed form first (with a record key), then the unkeyed form records written without one carry. */
  const iriForms = (kind: EntityKind, scope: string, id: string): string[] =>
    (iriKey === undefined ? [entityIri(kind, scope, id)] : [entityIri(kind, scope, id, iriKey), entityIri(kind, scope, id)]);
  /** The IRI a NEW entity is written under: keyed whenever this bridge holds a record key. */
  const newEntity = (kind: EntityKind, scope: string, id: string): string => entityIri(kind, scope, id, iriKey);
  /** The scope prefixes a scope can have on this pod, keyed first. */
  const scopeForms = (kind: EntityKind, scope: string): string[] =>
    (iriKey === undefined ? [scopePrefix(kind, scope)] : [scopePrefix(kind, scope, iriKey), scopePrefix(kind, scope)]);
  /**
   * The entity a tuple names on this pod: the first form whose graph has a current version
   * (trusted or not, so a sealed or altered one is found and refused, never passed over), which
   * keeps an existing unkeyed chain growing under its own IRI; otherwise the form a new entity is
   * written under. On a pod holding IRIs keyed under another record key, refused (409): the
   * entity may be there under a form this bridge cannot derive.
   */
  async function resolveEntity(call: Call, kind: EntityKind, scope: string, id: string): Promise<string> {
    await refuseKeyConflict(call);
    const forms = iriForms(kind, scope, id);
    for (const e of forms) if ((await call.view.graph(graphIriOf(e))).state !== 'absent') return e;
    return forms[0] ?? newEntity(kind, scope, id);
  }
  /** Every graph on the pod under a scope, in either form; refused (409) as resolveEntity is on a pod keyed under another record key. */
  async function scopedGraphs(call: Call, kind: EntityKind, scope: string): Promise<string[]> {
    await refuseKeyConflict(call);
    const out = new Set<string>();
    for (const prefix of scopeForms(kind, scope)) for (const g of await call.view.graphIris(prefix)) out.add(g);
    return [...out].sort();
  }

  /**
   * The registry's IRI is never keyed: it is derived from the pod URL alone, which is public, and
   * every bridge on the pod must find the same one. A bridge holding another record key, or none,
   * therefore meets the sealed registry and refuses (409), rather than start a second registry
   * under an IRI only its own key would derive.
   */
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

  /**
   * The registry, for a read (who may read, and the read model, calibration and template built on
   * it). The key-conflict check runs first: on a pod holding records written under another record
   * key whose registry this bridge cannot use (sealed to that key, as it is when that key's bridge
   * wrote the registry first, the usual go-live order), every read is refused with that conflict
   * (409, naming WRD_RECORD_KEY and both fingerprints), by an admin or anyone else, rather than as
   * one sealed record; nothing about who may read, or what the records say, can be answered
   * without it. Where the registry is usable the read goes on, and the read model and calibration
   * say so under recordKeyMismatch.
   */
  async function registryForRead(call: Call): Promise<Registry> {
    const c = await keyConflict(call);
    if (c) {
      const g = await call.view.graph(graphIriOf(entityIri('registry', call.podUrl, 'registry')));
      if (g.state === 'forked' || g.state === 'altered') {
        throw keyConflictRefusal(c, `nor can it use the pod's registry (${g.graphIri}: ${unusableWhy(g)}), so it answers no read, whoever signs it, until it runs with that key`);
      }
    }
    return registryOf(call);
  }

  const policyRefOf = (reg: Registry): PolicyRef => ({ ontologyIri: WRD_ONTOLOGY_IRI, ontologySha256: published.ontologySha256, podPolicyHead: reg.policy.podPolicyHead });

  interface Written { readonly descriptorUrl: string; readonly graphUrl: string; readonly recordId: string; readonly graphDigest: string }

  /**
   * A graph's whole trusted line, oldest first, for an answer that depends on all of it: 409 when
   * the line does not reach its first version (PodView.line: an earlier version that is not
   * trusted, or one that is missing), naming WRD_RECORD_KEY when that version is sealed and does
   * not open, never the part of the line after it as if it were the whole.
   */
  async function wholeLine(call: Call, g: GraphHeads): Promise<LoadedRecord[]> {
    const l = await call.view.line(g);
    if (l.cut) throw decline(409, l.cut.untrustedKey !== null ? DISTRUSTED_LINE : INTEGRITY, cutWhy(g.graphIri, l.cut), cutSetting(l.cut));
    return l.versions;
  }

  /** The durable replay check: 409 when a version of this graph was already authorised by this signer and nonce. */
  async function refuseReused(call: Signed, g: GraphHeads): Promise<void> {
    for (const v of await wholeLine(call, g)) {
      const by = v.record?.authorisedBy;
      if (by && by.signer === call.actor && by.nonce === call.nonce) {
        throw decline(409, REPLAYED, `${call.actor} already used the nonce ${call.nonce} on ${g.graphIri} (version ${v.record?.version ?? '?'})`);
      }
    }
  }

  /**
   * Publish one version of `entity`: superseding `head` when given, else starting the graph.
   * Every version records the (signer, nonce) of the envelope that authorised it, and a write is
   * refused (409) when the graph's chain already holds that pair: the durable replay check, which
   * holds after a restart and between processes because it reads the pod. A write that starts a
   * graph needs no check: the graph IRIs such writes mint carry the nonce or are unique to their
   * subject, so a replay finds the graph already there and is refused as stale.
   */
  async function write<K extends RecordKind>(call: Signed, w: {
    readonly kind: K; readonly entity: string; readonly status: RecordOf<K>['status']; readonly payload: RecordOf<K>['payload'];
    readonly signers: readonly RecordSigner[]; readonly head: Head<K> | null; readonly tag?: string;
    readonly validFrom?: string; readonly validUntil?: string; readonly confidence?: number; readonly derivedFrom?: readonly string[];
  }): Promise<Written> {
    await refuseKeyConflict(call);
    if (w.head) await refuseReused(call, w.head.graph);
    const version = w.head ? w.head.record.version + 1 : 1;
    const graphIri = graphIriOf(w.entity);
    // With a record key the id ends with its fingerprint, so the manifest names the key from this version on (recordIdFor).
    const recordId = recordIdFor(ENTITY_KIND[w.kind], graphIri, version, w.tag === undefined ? call.nonce : `${call.nonce}:${w.tag}`, ownFingerprint);
    const signers = dedupeSigners(w.signers);
    const record = {
      recordKind: w.kind, entityIri: w.entity, version, status: w.status, payload: w.payload, signers, platform: call.platformRef,
      authorisedBy: {
        signer: call.actor, nonce: call.nonce,
        // A version the relay signed for the actor says so, so a reader can tell it from a key-held one.
        ...(call.relayed ? { authority: 'relay-delegated' as const, agentId: call.relayed.agentId, relaySigner: call.relayed.relaySigner } : {}),
      },
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
      { podUrl: call.podUrl, fetchFn: call.fetchFn, platform: call.platform, trusted: call.trusted, mutex, cache: verifyCache, ...(recordKey ? { recordKey } : {}) });
  }

  // ── Shared loads ───────────────────────────────────────────────────────────────────────

  function requireOperatorPerson(reg: Registry, actor: string): void {
    if (!holds(reg, actor, 'operator')) throw decline(403, 'Only a registered operator can do this.', `${actor} does not hold the operator role in this pod's registry${unregisteredHint(reg, actor)}`, via('update_registry'));
  }

  async function taskHead(call: Call, taskIri: string): Promise<Head<'Task'>> {
    const t = await headOf(call, taskIri, 'Task');
    if (!t) throw decline(404, NOT_FOUND_TASK, `${taskIri} has no record on ${call.podUrl}`);
    return t;
  }

  /** A task's classification entity (keyed or not, see resolveEntity). */
  const classificationOf = (call: Call, workflowIri: string, taskIri: string): Promise<string> => resolveEntity(call, 'classification', workflowIri, taskIri);

  interface WorkflowTask { readonly taskIri: string; readonly task: Head<'Task'>; readonly classification: Head<'Classification'> | null }
  async function workflowTasks(call: Call, wf: Head<'Workflow'>): Promise<WorkflowTask[]> {
    const out: WorkflowTask[] = [];
    for (const taskIri of wf.record.payload.taskIris) {
      const task = await headOf(call, taskIri, 'Task');
      if (!task) throw decline(409, INTEGRITY, `the workflow lists ${taskIri}, which has no trusted record`);
      // A retired task the workflow still lists: nothing is proposed on a task list that is
      // wrong, and the refusal names the call that corrects it (classifying it would be refused).
      if (task.record.status === 'retired') throw new Declined(unfinishedRetirement(task, wf.record.entityIri));
      out.push({ taskIri, task, classification: await headOf(call, await classificationOf(call, wf.record.entityIri, taskIri), 'Classification') });
    }
    return out;
  }

  /** The allocation each task actually has (see effectiveFrom), for one workflow, read from its decision graphs. */
  async function effectiveAllocations(call: Call, workflowIri: string): Promise<Map<string, Effective>> {
    const decisions: Array<RecordOf<'Decision'>> = [];
    const plans = new Map<string, RecordOf<'Plan'>>();
    for (const g of await scopedGraphs(call, 'decision', workflowIri)) {
      const d = headIn(await call.view.graph(g), 'Decision');
      if (!d) continue;
      decisions.push(d.record);
      const plan = await headOf(call, d.record.payload.planIri, 'Plan');
      if (plan) plans.set(plan.record.entityIri, plan.record);
    }
    return effectiveFrom(decisions, (iri) => plans.get(iri) ?? null);
  }

  /** The task as checkAllocation reads it, with the allocation it has now. */
  async function taskForAllocation(call: Call, task: Head<'Task'>, current: Allocation): Promise<TaskForAllocation> {
    const tp = task.record.payload;
    const cls = await headOf(call, await classificationOf(call, tp.workflowIri, task.record.entityIri), 'Classification');
    return {
      taskIri: task.record.entityIri, taskKind: tp.taskKind, current,
      descriptionStatus: task.record.status === 'retired' ? 'captured' : task.record.status,
      regime: cls?.record.payload.regime ?? null, answers: cls?.record.payload.answers ?? null,
      classificationStatus: cls?.record.status ?? null, classificationCurrent: cls ? cls.record.payload.taskTextSha256 === tp.textSha256 : false,
    };
  }

  /**
   * Whether the changed tasks of a plan still stand as they must for a decision to be submitted
   * or approved: every changed task ratified by everyone named on it, no classification disputed,
   * and, where an agent is put on the work, the classification ratified. Null when they do.
   */
  function standingOf(ps: PlanState): BridgeRefusal | null {
    for (const row of ps.plan.record.payload.tasks) {
      if (!row.changed) continue;
      const t = ps.tasks.get(row.taskIri);
      const c = ps.classifications.get(row.taskIri);
      if (t?.record.status !== 'ratified') {
        return refuse(409, 'Every changed task must be ratified by everyone named on it before a decision is submitted or approved.',
          `${row.taskIri} is ${t?.record.status ?? 'absent'}`, via(t?.record.status === 'disputed' ? 'revise_task' : 'ratify_task'));
      }
      if (c?.record.status === 'disputed') {
        return refuse(409, 'Someone named on a changed task disputes its classification; classify it again with them.', `the classification of ${row.taskIri} is disputed`, via('classify_task'));
      }
      if (row.proposed.agentAddress !== undefined && c?.record.status !== 'ratified') {
        return refuse(409, 'An agent is put on this work only when everyone named on the task has ratified how knowable it is; their silence is not assent.',
          `the classification of ${row.taskIri} is ${c?.record.status ?? 'absent'}`, via('ratify_task'));
      }
    }
    return null;
  }

  /**
   * Another decision that is approved and not yet measured and changes one of these tasks, or
   * null. Two such decisions at once would each measure the other's effect.
   */
  async function openDecisionOn(call: Call, workflowIri: string, self: string, taskIris: ReadonlySet<string>): Promise<{ readonly decisionIri: string; readonly taskIri: string } | null> {
    for (const g of await scopedGraphs(call, 'decision', workflowIri)) {
      const d = headIn(await call.view.graph(g), 'Decision');
      if (!d || d.record.entityIri === self || d.record.status !== 'countersigned' || d.record.payload.countersign?.verdict !== 'approve') continue;
      const plan = await headOf(call, d.record.payload.planIri, 'Plan');
      const overlap = plan?.record.payload.tasks.find((r) => r.changed && taskIris.has(r.taskIri));
      if (overlap) return { decisionIri: d.record.entityIri, taskIri: overlap.taskIri };
    }
    return null;
  }
  const openDecisionRefusal = (o: { readonly decisionIri: string; readonly taskIri: string }): BridgeRefusal => refuse(409,
    `Another approved decision on ${o.taskIri} has not been measured yet: ${o.decisionIri}. Record its outcome first (kept, reverted or stopped early), so neither measurement carries the other's effect.`,
    `${o.decisionIri} is countersigned and unmeasured`, via('record_outcome'));

  /** Who prepared the prediction: the plan's proposer, the valuation's requester, the submitter — by the person the CURRENT registry attests. */
  function preparersOf(reg: Registry, plan: Head<'Plan'> | null, valuation: Head<'Valuation'> | null, submittedBy: { readonly did: string; readonly personRef: string }):
    Array<{ role: 'proposed' | 'valued' | 'submitted'; did: string; personRef: string }> {
    return [
      ...(plan ? [{ role: 'proposed' as const, did: plan.record.payload.proposedBy.did, personRef: personRefOf(reg, addressOfDid(plan.record.payload.proposedBy.did)) }] : []),
      ...(valuation ? [{ role: 'valued' as const, did: valuation.record.payload.requestedBy.did, personRef: personRefOf(reg, addressOfDid(valuation.record.payload.requestedBy.did)) }] : []),
      { role: 'submitted' as const, did: submittedBy.did, personRef: personRefOf(reg, addressOfDid(submittedBy.did)) },
    ];
  }
  /** The accountable principals (person references) of the agents a plan names on its changed tasks, now or after the change. */
  function principalsOf(reg: Registry, plan: Head<'Plan'> | null): Set<string> {
    const out = new Set<string>();
    for (const row of plan?.record.payload.tasks ?? []) {
      if (!row.changed) continue;
      for (const a of [row.current.agentAddress, row.proposed.agentAddress]) {
        const principal = a ? memberOf(reg, a)?.principal : null;
        if (principal) out.add(personRefOf(reg, principal));
      }
    }
    return out;
  }

  /** The grant an agent holds on a kind of task on this pod (keyed or not, see resolveEntity). */
  const grantEntity = (call: Call, agent: string, taskKind: string): Promise<string> => resolveEntity(call, 'grant', lower(agent), `${call.podUrl}|${taskKind}`);

  type GrantInfo = GrantState & { readonly grantIri: string; readonly evaluation: GrantEvaluation | null };
  /**
   * Whether a grant is usable right now. Checked on every use: revocation, the agent's
   * registration and declared model, the principal, the task kind. A grant whose sealed record
   * does not open is not "inactive": it is refused (409, naming WRD_RECORD_KEY).
   */
  async function grantState(call: Call, reg: Registry, agent: string, taskKind: string): Promise<GrantInfo> {
    const entity = await grantEntity(call, agent, taskKind);
    const g = await call.view.graph(graphIriOf(entity));
    const inactive = (why: string, evaluation: GrantEvaluation | null = null): GrantInfo => ({ active: false, why, grantIri: entity, evaluation });
    if (g.state === 'absent') return inactive(g.untrusted.length > 0 ? "grant record not signed by this bridge's key" : 'no grant');
    if (g.heads.some(isSealedShut)) throw sealedRefusal(g);
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
      classifications.set(row.taskIri, await headOf(call, await classificationOf(call, workflowIri, row.taskIri), 'Classification'));
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

  /**
   * A plan that changes a task since retired. Checked before anything else about the plan, so a
   * retired task is never reported as merely unratified: when the workflow still lists it, the
   * refusal names the call that finishes the retirement; otherwise, propose again.
   */
  function retiredInPlan(ps: PlanState): BridgeRefusal | null {
    for (const row of ps.plan.record.payload.tasks) {
      const t = ps.tasks.get(row.taskIri);
      if (!row.changed || !t || t.record.status !== 'retired') continue;
      if (ps.workflow.record.payload.taskIris.includes(row.taskIri)) return unfinishedRetirement(t, ps.workflow.record.entityIri);
      return refuse(409, RETIRED_IN_PLAN, `${row.taskIri} was retired after ${ps.plan.record.entityIri} was proposed`, via('propose_allocation'));
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

  /** The tuple a person's acknowledgement of their assignment on a plan's task is keyed by. */
  const ackTuple = (planIri: string, taskIri: string, person: string): readonly [string, string] => [planIri, `${taskIri}|${principalKey(person)}`];
  const ackEntity = (call: Call, planIri: string, taskIri: string, person: string): Promise<string> =>
    resolveEntity(call, 'acknowledgement', ...ackTuple(planIri, taskIri, person));
  async function assignmentStates(call: Call, plan: Head<'Plan'>): Promise<DecisionPayload['assignments']> {
    const out: Array<DecisionPayload['assignments'][number]> = [];
    for (const row of plan.record.payload.tasks) {
      const person = row.proposed.personAddress;
      if (!row.changed || !person) continue;
      const ack = await headOf(call, await ackEntity(call, plan.record.entityIri, row.taskIri, person), 'Acknowledgement');
      const state = ack ? (ack.record.status === 'objected' ? 'objected' : 'acknowledged') : 'not-acknowledged';
      out.push({ taskIri: row.taskIri, personAddress: person, state, ...(ack?.record.payload.note ? { note: ack.record.payload.note } : {}) });
    }
    return out;
  }

  /**
   * Mean cost per run, by task kind, that agents declared on runs a PERSON REVIEWED, in this
   * currency. Agent-reported, not instrumented; unreviewed runs under a grant are left out.
   */
  async function reportedRunCosts(call: Call, reg: Registry, kinds: ReadonlySet<string>, currency: string): Promise<Map<string, { runs: number; mean: number }>> {
    const out = new Map<string, { runs: number; mean: number }>();
    for (const kind of kinds) {
      let n = 0;
      let sum = 0;
      for (const m of reg.members.values()) {
        if (!m.softwareAgent) continue;
        for (const g of await scopedGraphs(call, 'run', `${m.address}|${kind}`)) {
          const run = headIn(await call.view.graph(g), 'AgentRun');
          const cost = run?.record.payload.costPerRun;
          if (!cost || cost.currency !== currency || run?.record.status !== 'reviewed') continue;
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
      return { ...refuse(403, 'Only a registered operator or agent can capture a workflow.', `${call.actor} is neither in this pod's registry${unregisteredHint(reg, call.actor)}`, via('update_registry')) };
    }
    const c = coerceCapture(call.payload, mode);
    if (!c.ok) return { ...refuse(400, BAD_PAYLOAD, c.why) };
    let documentText: string | null = null;
    if (mode === 'document') {
      const { text: t, signed } = documentTextOf(args, call);
      if (typeof t !== 'string' || t.trim() === '') return { ...refuse(400, 'The document text is required.', 'send document_text beside the envelope, or, relay-signed, inside the payload the relay signs; its sha256 is what the payload binds') };
      if (t.length > LIMITS.documentChars) return { ...refuse(400, 'The document is too long.', `document_text is longer than ${LIMITS.documentChars} characters`) };
      if (sha256Hex(t) !== c.value.document?.sha256) return { ...refuse(400, 'The document is not the one the signer bound.', 'sha256(document_text) differs from payload.document.sha256') };
      if (signed && c.value.document?.storeText !== true) {
        return { ...refuse(400, 'This document would be stored with the record.', `${RELAY_DOCUMENT_KEPT}, so it is taken only with payload.document.storeText true; or send document_text beside the signed pair, as this bridge's web UI does`) };
      }
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

    const workflowIri = newEntity('workflow', call.podUrl, `${call.actor}|${call.nonce}`);
    const capturedBy = { did: call.actorDid, envelopeSha256: envelopeSha256(call.envelope) };
    const tasks: Array<{ taskIri: string; name: string; quoteStatus: string; descriptorUrl: string; graphDigest: string; link: string }> = [];
    for (const [i, t] of c.value.tasks.entries()) {
      const taskIri = newEntity('task', workflowIri, String(i + 1));
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
    const owed = p.owedRatification ?? [];
    if (!p.namedParties.includes(call.actor) && !owed.includes(call.actor)) {
      return { ...refuse(403, 'Only a person or agent named on this task can ratify or dispute it.', `${call.actor} is not named on ${task.record.entityIri}, and no revision removed them from it${unregisteredHint(reg, call.actor)}`) };
    }
    if (task.record.status === 'retired') return { ...refuse(409, RETIRED, `${task.record.entityIri} was retired`) };
    const b = needBinding(call.payload);
    if (b.descriptorUrl !== task.loaded.descriptorUrl || b.graphDigest !== task.loaded.graphDigest) {
      return { ...refuse(409, TASK_MOVED, `the current version is ${task.loaded.descriptorUrl}`, via('read_records')) };
    }
    const mine = p.ratifications.find((r) => r.party === call.actor);
    if (mine && mine.verdict === verdict && (mine.note ?? '') === (note ?? '')) {
      return { subject: 'description', taskIri: task.record.entityIri, status: task.record.status, changed: false, descriptorUrl: task.loaded.descriptorUrl, recordId: task.loaded.recordId, graphDigest: task.loaded.graphDigest, recorded: false };
    }
    const ratifications: PartyVerdict[] = [
      ...p.ratifications.filter((r) => r.party !== call.actor),
      { party: call.actor, verdict, ...(note ? { note } : {}), envelope: call.envelope, at: call.at },
    ];
    const s = verdictStatus([...p.namedParties, ...owed], ratifications);
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
    const cls = await headOf(call, await classificationOf(call, p.workflowIri, task.record.entityIri), 'Classification');
    if (!cls) return { ...refuse(404, 'This task has not been classified.', `${task.record.entityIri} has no classification`, via('classify_task')) };
    const b = needBinding(call.payload);
    if (b.descriptorUrl !== cls.loaded.descriptorUrl || b.graphDigest !== cls.loaded.graphDigest) {
      return { ...refuse(409, 'The classification changed since you read it.', `the current version is ${cls.loaded.descriptorUrl}`, via('read_records')) };
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
      return { ...refuse(409, 'The plan you read is not this plan.', `the plan's record is ${plan.loaded.descriptorUrl}`, via('read_records')) };
    }
    const entity = await ackEntity(call, planIri, task.record.entityIri, call.actor);
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
    const { text, signed } = documentTextOf(args, call);
    if (typeof text !== 'string' || sha256Hex(text) !== doc.sha256) {
      throw decline(400, 'The document is not the one this workflow was captured from.', 'send document_text whose sha256 equals the workflow\'s document.sha256, beside the envelope or, relay-signed, inside the payload the relay signs');
    }
    if (signed && !doc.textStored) {
      throw decline(400, 'This document would be stored with the record.', `${RELAY_DOCUMENT_KEPT}, and this workflow did not store its document text; send document_text beside the signed pair, as this bridge's web UI does`);
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
        return { ...refuse(403, 'Only a registered operator or someone named on this task can revise it.', `${call.actor} is neither${unregisteredHint(reg, call.actor)}`) };
      }
      if (task.record.status === 'retired') return { ...refuse(409, RETIRED, `${r.taskIri} was retired`) };
      if (r.descriptorUrl !== task.loaded.descriptorUrl || r.graphDigest !== task.loaded.graphDigest) {
        return { ...refuse(409, TASK_MOVED, `the current version is ${task.loaded.descriptorUrl}`, via('read_records')) };
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
      // Removing someone from a task is a statement about them: they must ratify the revision (or
      // dispute it) before it stands, so a dispute is answered, never edited away. Someone owed by
      // an earlier revision stays owed until they ratify; someone named again is simply a party.
      const ratifiedBefore = new Set(p.ratifications.filter((x) => x.verdict === 'ratify').map((x) => x.party));
      const owed = [...new Set([
        ...(p.owedRatification ?? []).filter((x) => !ratifiedBefore.has(x)),
        ...p.namedParties.filter((x) => !parties.includes(x)),
      ])].filter((x) => !parties.includes(x));
      // The reviser's own ratification counts only if they were already named before this revision:
      // naming yourself does not let you ratify your own description of yourself into force.
      const selfRatifies = parties.includes(call.actor) && p.namedParties.includes(call.actor);
      const ratifications: PartyVerdict[] = selfRatifies ? [{ party: call.actor, verdict: 'ratify', envelope: call.envelope, at: call.at }] : [];
      const status = verdictStatus([...parties, ...owed], ratifications) === 'ratified' ? 'ratified' : 'captured';
      const { owedRatification: _previouslyOwed, ...rest } = p;
      const payload: TaskPayload = {
        ...rest, ...(owed.length > 0 ? { owedRatification: owed } : {}),
        name: next.name, description: next.description, textSha256: taskTextSha256(next.name, next.description),
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
      return { op: 'revise', taskIri: r.taskIri, workflowIri: p.workflowIri, status, answeredDisputes: answers, owedRatification: owed, descriptorUrl: w.descriptorUrl, recordId: w.recordId, graphDigest: w.graphDigest, recorded: true };
    }

    if (r.op === 'add') {
      const wf = await headOf(call, r.workflowIri, 'Workflow');
      if (!wf) return { ...refuse(404, 'No such workflow on this pod.', `${r.workflowIri} has no record on ${call.podUrl}`) };
      requireOperatorPerson(reg, call.actor);
      if (r.descriptorUrl !== wf.loaded.descriptorUrl || r.graphDigest !== wf.loaded.graphDigest) {
        return { ...refuse(409, 'The workflow changed since you read it.', `the current version is ${wf.loaded.descriptorUrl}`, via('read_records')) };
      }
      if (!kindUsable(reg, r.task.taskKind)) return { ...refuse(400, UNKNOWN_KIND, `${r.task.taskKind}: ${KIND_FIX}`, via('update_registry')) };
      partyCheck(r.task.current);
      const quotes = r.task.sourceQuotes ? await quotesAgainstWorkflow(args, call, r.workflowIri, r.task.sourceQuotes) : [];
      const wp = wf.record.payload;
      // The next index no task of this workflow has taken, under either form of its IRI.
      let index = wp.taskIris.length + wp.retiredTaskIris.length + 1;
      const taken = async (i: number): Promise<boolean> => {
        for (const e of iriForms('task', r.workflowIri, String(i))) if ((await call.view.graph(graphIriOf(e))).chain.length > 0) return true;
        return false;
      };
      while (await taken(index)) index += 1;
      const taskIri = newEntity('task', r.workflowIri, String(index));
      const payload: TaskPayload = {
        workflowIri: r.workflowIri, index, name: r.task.name, description: r.task.description, textSha256: taskTextSha256(r.task.name, r.task.description),
        current: r.task.current, performer: performerOf(r.task.current), namedParties: namedPartiesOf(r.task.current),
        taskKind: r.task.taskKind, taskKindDefinition: kindUsable(reg, r.task.taskKind)?.definition ?? '',
        ...(r.task.externalTaskTerm ? { externalTaskTerm: r.task.externalTaskTerm } : {}),
        quotes, quoteStatus: r.task.sourceQuotes ? quoteStatusOf(quotes) : 'none', ratifications: [],
        capturedBy: { did: call.actorDid, envelopeSha256: envelopeSha256(call.envelope) },
      };
      const tw = await write(call, { kind: 'Task', entity: taskIri, status: 'captured', payload, head: null, tag: 'task', signers: [signerOf(reg, call.actor, 'Curator', 'added the task')] });
      let ww: Written;
      try {
        ww = await write(call, {
          kind: 'Workflow', entity: r.workflowIri, status: 'captured', head: wf, tag: 'workflow',
          payload: { ...wp, taskIris: [...wp.taskIris, taskIri], revision: { op: 'add', taskIri, by: { did: call.actorDid, envelope: call.envelope } } },
          signers: [signerOf(reg, call.actor, 'Curator', 'added a task')],
        });
      } catch (e) {
        // The task landed and the workflow did not: an orphan, which blocks nothing (no plan can
        // name it, and the next add takes the next free index) but must not be reported as added.
        return { ...partlyWritten(e, ADD_UNLISTED,
          `${taskIri} was recorded (${tw.descriptorUrl}) but ${r.workflowIri} does not list it, so it shows as orphaned and no plan can name it; add the task again (it gets a new IRI), and retire ${taskIri} to clear it`,
          { ...via('revise_task'), op: 'add', workflowIri: r.workflowIri }) };
      }
      return { op: 'add', taskIri, workflowIri: r.workflowIri, status: 'captured', answeredDisputes: [], descriptorUrl: tw.descriptorUrl, recordId: tw.recordId, graphDigest: tw.graphDigest, workflowDescriptorUrl: ww.descriptorUrl, link: taskLink(taskIri), recorded: true };
    }

    // retire
    const task = await taskHead(call, r.taskIri);
    requireOperatorPerson(reg, call.actor);
    if (task.record.status === 'retired') return finishRetirement(call, reg, task, r);
    if (r.descriptorUrl !== task.loaded.descriptorUrl || r.graphDigest !== task.loaded.graphDigest) {
      return { ...refuse(409, TASK_MOVED, `the current version is ${task.loaded.descriptorUrl}`, via('read_records')) };
    }
    const wf = await headOf(call, task.record.payload.workflowIri, 'Workflow');
    if (!wf) throw decline(409, INTEGRITY, `the task's workflow ${task.record.payload.workflowIri} has no trusted record`);
    const first = (await wholeLine(call, task.graph))[0];
    const startedAt = first?.validFrom ?? null;
    if (!startedAt || Date.parse(startedAt) >= call.now.getTime()) return { ...refuse(409, CLOCK_SKEW, `the task's first version is valid from ${startedAt ?? 'an unknown time'}`) };
    const payload: TaskPayload = { ...task.record.payload, retirement: { by: { did: call.actorDid, envelope: call.envelope }, why: r.why, at: call.at } };
    const tw = await write(call, {
      kind: 'Task', entity: r.taskIri, status: 'retired', payload, head: task, tag: 'task', validFrom: startedAt, validUntil: call.at,
      signers: [signerOf(reg, call.actor, 'Curator', 'retired the task')],
    });
    const wp = wf.record.payload;
    let ww: Written;
    try {
      ww = await write(call, {
        kind: 'Workflow', entity: wf.record.entityIri, status: 'captured', head: wf, tag: 'workflow',
        payload: { ...wp, taskIris: wp.taskIris.filter((t) => t !== r.taskIri), retiredTaskIris: [...wp.retiredTaskIris, r.taskIri], revision: { op: 'retire', taskIri: r.taskIri, by: { did: call.actorDid, envelope: call.envelope } } },
        signers: [signerOf(reg, call.actor, 'Curator', 'retired a task')],
      });
    } catch (e) {
      // The task is retired and the workflow still lists it. Retiring it again finishes the job (finishRetirement).
      return { ...partlyWritten(e, RETIREMENT_UNFINISHED, `${r.taskIri} is retired (${tw.descriptorUrl}), but ${wf.record.entityIri} still lists it`, finishRetirementVia(r.taskIri, tw)) };
    }
    return { op: 'retire', taskIri: r.taskIri, workflowIri: wf.record.entityIri, status: 'retired', answeredDisputes: [], descriptorUrl: tw.descriptorUrl, recordId: tw.recordId, graphDigest: tw.graphDigest, workflowDescriptorUrl: ww.descriptorUrl, recorded: true };
  }

  /**
   * Retire a task that is already retired. When its workflow still lists it (the retirement's
   * own workflow write did not land), write only the workflow version that drops it: signed by
   * this requester, derived from the retired task version, and naming the retirement it finishes
   * (`revision.repairs`). Otherwise refuse as already retired. The envelope binds the retired
   * version, or the version that retirement superseded (the original request retried with a fresh
   * nonce); the envelope that retired the task cannot be the one that finishes it.
   */
  async function finishRetirement(call: Signed, reg: Registry, task: Head<'Task'>, r: { readonly taskIri: string; readonly descriptorUrl: string; readonly graphDigest: string }): Promise<unknown> {
    const tp = task.record.payload;
    const wf = await headOf(call, tp.workflowIri, 'Workflow');
    if (!wf) throw decline(409, INTEGRITY, `the task's workflow ${tp.workflowIri} has no trusted record`);
    if (!retirementUnfinished(task.record, wf.record)) return { ...refuse(409, RETIRED, `${r.taskIri} was already retired`) };
    const versions = await wholeLine(call, task.graph);
    const superseded = versions.length >= 2 ? versions[versions.length - 2] : undefined;
    if (![task.loaded, superseded].some((v) => v !== undefined && v.descriptorUrl === r.descriptorUrl && v.graphDigest === r.graphDigest)) {
      return { ...refuse(409, TASK_MOVED, `the current version is ${task.loaded.descriptorUrl}, which retired the task; bind it to finish the retirement`, finishRetirementVia(r.taskIri, task.loaded)) };
    }
    await refuseReused(call, task.graph);
    const retirement = tp.retirement;
    const repairs = { taskDescriptorUrl: task.loaded.descriptorUrl, retiredBy: retirement?.by.did ?? null, retiredAt: retirement?.at ?? task.loaded.validUntil };
    const wp = wf.record.payload;
    const ww = await write(call, {
      kind: 'Workflow', entity: wf.record.entityIri, status: 'captured', head: wf, tag: 'workflow',
      payload: {
        ...wp, taskIris: wp.taskIris.filter((t) => t !== r.taskIri),
        retiredTaskIris: wp.retiredTaskIris.includes(r.taskIri) ? wp.retiredTaskIris : [...wp.retiredTaskIris, r.taskIri],
        revision: { op: 'retire', taskIri: r.taskIri, by: { did: call.actorDid, envelope: call.envelope }, repairs },
      },
      signers: [signerOf(reg, call.actor, 'Curator', 'finished retiring a task')],
      derivedFrom: [task.loaded.descriptorUrl],
    });
    return {
      op: 'retire', taskIri: r.taskIri, workflowIri: wf.record.entityIri, status: 'retired', answeredDisputes: [],
      descriptorUrl: task.loaded.descriptorUrl, recordId: task.loaded.recordId, graphDigest: task.loaded.graphDigest,
      workflowDescriptorUrl: ww.descriptorUrl, repairs, repaired: true, recorded: true,
    };
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
        const roles = raw['roles'];
        // A key's 0x address, or, for a person who signs in with their Interego account, their user
        // DID on this bridge's identity host (kept as spelled: never lower-cased into an address).
        // A DID already listed can always be removed, whatever host is configured now.
        const removing = Array.isArray(roles) && roles.length === 0;
        if (!isAddress(address) && !isHostUser(address) && !(removing && isUserPrincipal(address) && members.has(address))) {
          throw bad(`entries[${i}].address must be a 0x address${identityHost === null ? '' : `, or an Interego user DID did:web:${identityHost}:users:<id>`}`);
        }
        const a = principalKey(address);
        if (seen.has(a)) throw bad(`entries[${i}]: ${a} appears twice in one change`);
        seen.add(a);
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
        if (isAgentEntry && isUserPrincipal(a)) throw bad(`entries[${i}]: ${a} is a person the Interego identity host names; an agent is registered by the key it signs its runs with`);
        if (isAgentEntry) {
          const principal = raw['principal'];
          const model = raw['model'];
          if (!isAddress(principal) && !isHostUser(principal)) {
            throw bad(`entries[${i}].principal is required: the address${identityHost === null ? '' : ' or Interego user DID'} of the registered person accountable for this agent`);
          }
          if (typeof model !== 'string' || model.trim() === '' || model.length > 120) throw bad(`entries[${i}].model is required: the model the agent runs on, 1 to 120 characters`);
          if (raw['personRef'] !== undefined) throw bad(`entries[${i}].personRef belongs to people; an agent has a principal instead`);
          members.set(a, { address: a, did: didOf(a), roles: uniqueRoles, label, softwareAgent: true, personRef: null, principal: principalKey(principal), model });
        } else {
          const personRef = raw['personRef'];
          if (typeof personRef !== 'string' || !PERSON_REF.test(personRef)) {
            throw bad(`entries[${i}].personRef is required: the admin's stable reference for the person who holds this key or user DID (1 to 80 of [A-Za-z0-9_.:-]; give a person's key and their user DID the same one to make them one person)`);
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
    // Who authorised this version, and how: a key the signer holds, or the relay signing for a person who holds none.
    ...(l.record?.authorisedBy?.authority === 'relay-delegated'
      ? { authority: 'relay-delegated', authorisedBy: l.record.authorisedBy.signer, agentId: l.record.authorisedBy.agentId ?? null, relaySigner: l.record.authorisedBy.relaySigner ?? null }
      : l.record?.authorisedBy ? { authority: 'key-held', authorisedBy: l.record.authorisedBy.signer } : {}),
  });

  // ── Payload templates ────────────────────────────────────────────────────────────────

  const TRI_TEMPLATE = (): Obj => ({ low: null, likely: null, high: null, basis: null });
  const STATE_TEMPLATE = (): Obj => Object.fromEntries(['performerHoursPerRun', 'oversightHoursPerRun', 'agentCostPerRun', 'minorFailureRate', 'minorFailureCost', 'criticalFailureRate', 'criticalFailureCost'].map((f) => [f, TRI_TEMPLATE()]));
  /** Every path in a template whose value is still null: what the signer decides. */
  const nullPaths = (v: unknown, path = ''): string[] => {
    if (v === null) return [path];
    if (Array.isArray(v)) return v.flatMap((x, i) => nullPaths(x, `${path}[${i}]`));
    if (isObj(v)) return Object.entries(v).flatMap(([k, x]) => nullPaths(x, path === '' ? k : `${path}.${k}`));
    return [];
  };
  const WEEK_MS = 7 * 86_400_000;

  /**
   * The signed read wrd.read_envelope_template fills a template with: `read_envelope` in the JSON
   * body, the wrd:read-records envelope wrd.read_records takes, as an object or its JSON text.
   * Undefined when none was sent (authoriseRead then answers 401).
   */
  function readEnvelopeArg(args: Obj): unknown {
    const v = args['read_envelope'];
    if (v === undefined || v === null || v === '') return undefined;
    if (typeof v !== 'string') return v;
    const malformed = (why: string): Declined => decline(400, 'The envelope is malformed.', why, readVia('read_envelope_template'));
    if (v.length > 20_000) throw malformed('read_envelope is longer than 20000 characters');
    let parsed: unknown;
    try { parsed = JSON.parse(v); } catch { throw malformed('read_envelope must be {payload, signature}, or its JSON text'); }
    const ill = illFormedTextPath(parsed, 'read_envelope');
    if (ill !== null) throw decline(400, NOT_WELL_FORMED, `${ill} holds a lone UTF-16 surrogate`);
    return parsed;
  }

  /**
   * The payload a write intent needs: its JSON Schema and a template, with the fields the bridge
   * may fill filled and the rest null and listed in `fill`. Reads only.
   *
   * WHAT IT FILLS DEPENDS ON WHO ASKS. Through wrd.read_envelope_template, with a valid signed read
   * (`read_envelope` in the POST body: the wrd:read-records envelope wrd.read_records takes, from an
   * admin or a registered key), or through wrd.envelope_template with reads opened by the operator,
   * it fills what the pod knows: the plan's changed tasks for a valuation, the valuation a decision
   * binds, the declared window for an outcome, and the context it read. Otherwise it fills an
   * ALLOWLIST and nothing else: intent, podUrl, issuedAt, nonce, the IRIs the caller named, and the
   * head binding of each record they name (descriptorUrl, graphDigest, recordId: what the public
   * descriptors carry). Nothing else in that template is read out of a graph, and its shape does
   * not depend on one either: it never branches on a plan's kind, a decision's kind or a task's
   * retirement. `signed` is true for wrd.read_envelope_template, which needs the signed read.
   */
  async function envelopeTemplate(body: Obj, signed: boolean): Promise<unknown> {
    // A relay-signed read arrives under read_envelope or at the top level of the body; a key-held one under read_envelope.
    const relayRead = signed ? relayFormIn(body, 'read_envelope') : null;
    // The relay's act POSTs only the signed pair, and the read's own intent is wrd:read-records, so
    // a relay-signed read names the template it asks for under `template` in the payload the relay
    // signed; an argument beside the pair still wins.
    const named = relayRead?.parsed?.['template'];
    const asked: Obj = isObj(named) ? named : {};
    const args: Obj = { ...Object.fromEntries(TEMPLATE_ARGS.filter((k) => typeof asked[k] === 'string').map((k) => [k, asked[k]])), ...body };
    const intent = args['intent'];
    if (!isEnvelopeIntent(intent)) return { ...refuse(400, 'Unknown intent.', `intent must be one of ${Object.keys(TOOL_OF_INTENT).join(', ')}${relayRead ? ' (relay-signed: under template in the payload the relay signs)' : ''}`) };
    const signedRead = signed && !relayRead ? readEnvelopeArg(args) : undefined;
    const call = await openCall(args, relayRead ? relayPodCarrier(relayRead) : signedRead, false);
    if (signed) await authoriseRead(call, await openAuthorising(call, relayRead, signedRead, 'wrd:read-records'), 'read_envelope_template');
    const full = publicReads || signed;
    // The registry is read only to fill context, which an unsigned call does not get.
    const reg = full ? await registryForRead(call) : null;
    const arg = (k: string): string | null => (typeof args[k] === 'string' && args[k] !== '' ? String(args[k]) : null);
    const t: Obj = { intent, podUrl: call.podUrl, issuedAt: call.at, nonce: randomBytes(16).toString('hex') };
    const context: Obj = {};
    const people = reg ? [...reg.members.values()].filter((m) => !m.softwareAgent).map((m) => ({ address: m.address, label: m.label, roles: m.roles })) : [];
    const agents = reg ? [...reg.members.values()].filter((m) => m.softwareAgent).map((m) => ({ address: m.address, label: m.label, principal: m.principal, model: m.model })) : [];
    const kinds = reg ? [...reg.kinds.values()].filter((k) => !k.retired).map((k) => ({ slug: k.slug, label: k.label })) : [];
    /** The head of the record the caller named (404 when there is none; 409 when it is altered, forked or sealed shut), and the IRI as they named it. */
    const found = async <K extends RecordKind>(key: string, kind: K, what: string): Promise<{ readonly iri: string; readonly head: Head<K> } | null> => {
      const iri = arg(key);
      if (iri === null) return null;
      const h = await headOf(call, iri, kind);
      if (!h) throw decline(404, `No such ${what} on this pod.`, `${iri} has no record on ${call.podUrl}`);
      return { iri, head: h };
    };
    const noBinding = { descriptorUrl: null, graphDigest: null };
    const captureTask = (quotes: boolean): Obj => ({ name: null, description: null, currentLevel: null, personAddress: null, taskKind: null, ...(quotes ? { sourceQuotes: [null] } : {}) });
    switch (intent) {
      case 'wrd:update-registry':
        Object.assign(t, { entries: [{ address: null, roles: [null], label: null, softwareAgent: null, personRef: null }] });
        if (reg) Object.assign(context, { members: [...reg.members.values()], taskKinds: [...reg.kinds.values()], podPolicy: reg.podPolicy });
        break;
      case 'wrd:capture-workflow':
      case 'wrd:record-task-map':
        Object.assign(t, { workflow: { title: null, unitLabel: null }, tasks: [captureTask(intent === 'wrd:record-task-map')] });
        if (intent === 'wrd:record-task-map') Object.assign(t, { document: { title: null, sha256: null, storeText: false }, draftedBy: { kind: null } });
        if (reg) Object.assign(context, { people, agents, taskKinds: kinds, levels: [...reg.policy.levels.keys()].filter((l) => l !== 'agent-acts-within-grant') });
        break;
      case 'wrd:revise-task': {
        const task = await found('task_iri', 'Task', 'task');
        const wf = await found('workflow_iri', 'Workflow', 'workflow');
        if (task && !full) {
          // Revise or retire again: which one depends on whether the task was retired and its
          // workflow still lists it, which only its graph says. op is left to the signer.
          Object.assign(t, { op: null, taskIri: task.iri, ...bindingOf(task.head.loaded) });
        } else if (task) {
          const taskWf = task.head.record.status === 'retired' ? await headOf(call, task.head.record.payload.workflowIri, 'Workflow') : null;
          // A retired task its workflow still lists: the call to make is the retirement again, which finishes it.
          if (retirementUnfinished(task.head.record, taskWf?.record)) Object.assign(t, { op: 'retire', taskIri: task.iri, ...bindingOf(task.head.loaded), why: null });
          else Object.assign(t, { op: 'revise', taskIri: task.iri, ...bindingOf(task.head.loaded), description: task.head.record.payload.description, note: null });
        } else if (wf) {
          Object.assign(t, { op: 'add', workflowIri: wf.iri, ...bindingOf(wf.head.loaded), task: captureTask(false) });
        } else {
          Object.assign(t, { op: null, taskIri: null, ...noBinding });
        }
        if (reg) Object.assign(context, { people, agents, taskKinds: kinds });
        break;
      }
      case 'wrd:ratify-task': {
        const subject = arg('subject') ?? 'description';
        const task = await found('task_iri', 'Task', 'task');
        Object.assign(t, { subject, taskIri: task?.iri ?? null, verdict: null });
        if (subject === 'assignment') {
          const plan = await found('plan_iri', 'Plan', 'plan');
          Object.assign(t, { planIri: plan?.iri ?? null, ...(plan ? bindingOf(plan.head.loaded) : noBinding) });
        } else if (subject === 'classification' && task) {
          // The head binding of the task's classification. Which classification is the task's is
          // public: its first version's descriptor is derived from the task's.
          const cls = await headOf(call, await classificationOf(call, task.head.record.payload.workflowIri, task.iri), 'Classification');
          Object.assign(t, cls ? bindingOf(cls.loaded) : noBinding);
          if (cls) Object.assign(context, { answers: cls.record.payload.answers, regime: cls.record.payload.regime });
        } else {
          Object.assign(t, task ? bindingOf(task.head.loaded) : noBinding);
        }
        Object.assign(context, { verdicts: subject === 'assignment' ? ['acknowledge', 'object'] : ['ratify', 'dispute'], noteRequiredWith: ['dispute', 'object'] });
        break;
      }
      case 'wrd:classify-task': {
        const task = await found('task_iri', 'Task', 'task');
        Object.assign(t, {
          taskIri: task?.iri ?? null, taskTextSha256: full ? task?.head.record.payload.textSha256 ?? null : null,
          answers: Object.fromEntries(CLASSIFICATION_QUESTIONS.map((q) => [q.id, null])),
        });
        Object.assign(context, { questions: CLASSIFICATION_QUESTIONS, ...(task ? { name: task.head.record.payload.name, description: task.head.record.payload.description } : {}) });
        break;
      }
      case 'wrd:propose-allocation': {
        const wf = await found('workflow_iri', 'Workflow', 'workflow');
        Object.assign(t, { workflowIri: wf?.iri ?? null, title: null, changes: [{ taskIri: null, proposedLevel: null }] });
        if (wf && reg) {
          const effective = await effectiveAllocations(call, wf.iri);
          const rows: Obj[] = [];
          for (const wt of await workflowTasks(call, wf.head)) {
            const c = wt.classification?.record;
            rows.push({
              taskIri: wt.taskIri, name: wt.task.record.payload.name, inForce: effective.get(wt.taskIri)?.allocation ?? wt.task.record.payload.current,
              regime: c?.payload.regime ?? null, classificationStatus: c?.status ?? null, permittedLevels: c ? reg.policy.regimes.get(c.payload.regime)?.permittedLevels ?? [] : [],
            });
          }
          Object.assign(context, { tasks: rows, people, agents });
        }
        break;
      }
      case 'wrd:value-plan': {
        const plan = await found('plan_iri', 'Plan', 'plan');
        // Which tasks a plan changes is in its graph: without a signed read the rows stay empty.
        const changed = full ? plan?.head.record.payload.tasks.filter((r) => r.changed) ?? [] : [];
        Object.assign(t, {
          planIri: plan?.iri ?? null,
          inputs: {
            currency: null, unitsPerWeek: { current: TRI_TEMPLATE() }, valuePerUnit: TRI_TEMPLATE(), hourlyCost: TRI_TEMPLATE(), oneOffCost: TRI_TEMPLATE(),
            horizonMonths: null, rampMonths: null, annualDiscountRate: null, criticalFailureCeiling: null,
            freedHours: Object.fromEntries(changed.map((r) => [r.taskIri, { disposition: null }])),
            tasks: Object.fromEntries(changed.map((r) => [r.taskIri, { runsPerUnit: TRI_TEMPLATE(), current: STATE_TEMPLATE(), proposed: STATE_TEMPLATE() }])),
          },
        });
        if (plan && reg) {
          const pp = plan.head.record.payload;
          Object.assign(context, {
            planKind: pp.planKind,
            changedTasks: changed.map((r) => {
              const l = reg.policy.levels.get(r.proposed.level);
              return { taskIri: r.taskIri, regime: r.regime, current: r.current, proposed: r.proposed, oversightRequired: !!l && l.requiresAgent && l.requiresPerson };
            }),
            unchangedTasks: pp.tasks.filter((r) => !r.changed).map((r) => r.taskIri),
            unchangedTasksNote: 'optional, without proposed; required for every task when you give unitsPerWeek.proposed',
            inputBases: INPUT_BASES,
          });
        }
        break;
      }
      case 'wrd:submit-decision': {
        const plan = await found('plan_iri', 'Plan', 'plan');
        Object.assign(t, { planIri: plan?.iri ?? null });
        // Without a signed read the shape is the valued one whatever the plan's kind (which is in its graph); a probe decision drops these fields.
        if (!full || !plan || plan.head.record.payload.planKind === 'valued') {
          const valuations: Obj[] = [];
          if (plan && full) {
            for (const g of await scopedGraphs(call, 'valuation', plan.iri)) {
              const v = headIn(await call.view.graph(g), 'Valuation');
              if (v) valuations.push({ valuationIri: v.record.entityIri, valuationHash: v.record.payload.valuationHash, cashWeeklyDelta: v.record.payload.result.scenarios.cash.weeklyDelta });
            }
          }
          const only = valuations.length === 1 ? valuations[0] : undefined;
          Object.assign(t, {
            valuationIri: only?.['valuationIri'] ?? null, valuationHash: only?.['valuationHash'] ?? null,
            measurementPlan: { metric: null, comparisonBasis: null, windowWeeks: null },
          });
          Object.assign(context, { valuations, metrics: OUTCOME_METRICS, comparisonBases: COMPARISON_BASES });
        }
        break;
      }
      case 'wrd:countersign-decision':
      case 'wrd:record-outcome': {
        const d = await found('decision_iri', 'Decision', 'decision');
        Object.assign(t, { decisionIri: d?.iri ?? null, recordId: d?.head.loaded.recordId ?? null, ...(d ? bindingOf(d.head.loaded) : noBinding) });
        // What the decision says (its kind, its countersign time, its plan) is read only for a full template.
        const dp = full ? d?.head.record.payload : undefined;
        if (intent === 'wrd:countersign-decision') {
          Object.assign(t, { verdict: null, objectionsConsidered: [], unacknowledgedConsidered: [] });
          const plan = dp ? await headOf(call, dp.planIri, 'Plan') : null;
          if (plan) {
            const a = await assignmentStates(call, plan);
            Object.assign(context, {
              objections: a.filter((x) => x.state === 'objected').map((x) => x.taskIri), unacknowledged: a.filter((x) => x.state === 'not-acknowledged').map((x) => x.taskIri),
              note: 'Approval must name each objection in objectionsConsidered and each unacknowledged assignment in unacknowledgedConsidered; naming them is your decision, not the template\'s.',
            });
          }
        } else {
          Object.assign(t, { disposition: null });
          const at = dp?.countersign?.at;
          if (dp?.decisionKind === 'probe') {
            Object.assign(t, { probeResults: (dp.probes ?? []).map((pr) => ({ taskIri: pr.taskIri, index: pr.index, signal: null, observed: null, windowStart: at ?? null, windowEnd: at ? new Date(Date.parse(at) + pr.timeboxWeeks * WEEK_MS).toISOString() : null })) });
          } else {
            // Without a signed read this is the shape whatever the decision's kind; a probe decision sends probeResults instead.
            const weeks = dp?.measurementPlan?.windowWeeks;
            Object.assign(t, { measured: {
              weeklyValueDelta: null, comparisonBasis: dp?.measurementPlan?.comparisonBasis ?? null, windowStart: at ?? null,
              windowEnd: at && weeks ? new Date(Date.parse(at) + weeks * WEEK_MS).toISOString() : null, method: null,
            } });
          }
          Object.assign(context, { dispositions: OUTCOME_DISPOSITIONS, ...(dp?.prediction ? { prediction: dp.prediction } : {}), now: call.at });
        }
        break;
      }
      case 'wrd:agent-run': {
        const task = await found('task_iri', 'Task', 'task');
        Object.assign(t, {
          runId: null, taskIri: task?.iri ?? null, taskKind: full ? task?.head.record.payload.taskKind ?? null : null, model: null, outputSha256: null,
          selfAssessment: { answer: null }, performedAt: call.at,
        });
        Object.assign(context, { agents });
        break;
      }
      case 'wrd:review-agent-run':
        Object.assign(t, { runEnvelopeSha256: null, verdict: null });
        Object.assign(context, { runEnvelopeSha256: 'sha256Hex(canonicalJson({payload, signature})) of the run envelope you review; wrd.read_records kind=runs lists runs awaiting review with their envelopes' });
        break;
      case 'wrd:grant-autonomy':
        Object.assign(t, { agentAddress: null, taskKind: null });
        Object.assign(context, { agents, taskKinds: kinds });
        break;
      case 'wrd:revoke-grant': {
        const g = await found('grant_iri', 'Grant', 'grant');
        Object.assign(t, { grantIri: g?.iri ?? null, recordId: g?.head.loaded.recordId ?? null, ...(g ? bindingOf(g.head.loaded) : noBinding), why: null });
        break;
      }
      case 'wrd:holder-copy':
        Object.assign(context, { targetPodUrl: 'optional: a pod you hold; without it the bundle is returned for download' });
        break;
      case 'wrd:read-records':
        Object.assign(context, {
          tools: ['wrd.read_records', 'wrd.read_calibration', 'wrd.read_envelope_template (as read_envelope)'],
          reuse: 'the same envelope reads again until issuedAt leaves the window; its nonce is not spent',
          neverInAUrl: 'send it only in a POST body: a URL is kept in server, proxy and browser logs, and whoever holds a copy reads every record until it is stale',
        });
        break;
    }
    const answer = { intent, toolName: TOOL_OF_INTENT[intent], schema: payloadSchema(intent), template: t, fill: nullPaths(t) };
    // Unsigned, with reads closed: the allowlisted template only, and no context (some of it is read out of graphs).
    if (!full) return { ...answer, context: {}, contextWithheld: CONTEXT_WITHHELD, signing: SIGNING_RULE, status: 'templated', computed: true };
    return { ...answer, context, signing: SIGNING_RULE, status: 'templated', computed: true };
  }

  // ── The map ──────────────────────────────────────────────────────────────────────────

  /**
   * The copy itself (wrd.holder_copy, once its caller is let through): every graph's whole line is
   * read, and every version of the graphs that name the signer, or that it signed, is copied or
   * returned.
   */
  async function holderCopy(call: Signed): Promise<unknown> {
    const rawTarget = call.payload['targetPodUrl'];
    let target: string | null = null;
    if (rawTarget !== undefined && rawTarget !== null) {
      if (typeof rawTarget !== 'string') return { ...refuse(400, 'The target pod must be an http(s) URL.', 'payload.targetPodUrl must be a string') };
      try { target = normalisePodUrl(rawTarget); } catch (e) { return { ...refuse(400, 'The target pod must be an http(s) URL.', messageOf(e)) }; }
      if (target === call.podUrl) return { ...refuse(400, 'Copies go to a pod you hold, not to this one.', 'payload.targetPodUrl is the platform pod') };
    }
    const reg = await registryOf(call);
    const snap = await snapshot(call.view);
    // A record this bridge cannot read may name the holder: a copy without it would read as
    // "nothing else names you". Refused rather than answered short, naming the setting when it is
    // sealed. That holds for a current version that is sealed, altered or forked, and for an
    // earlier version as much as a current one: a line that does not reach its first version
    // (PodView.line) would come back without it and every version before it.
    const shut: Array<{ readonly why: string; readonly sealed: boolean; readonly setting?: Record<string, unknown> }> = snap.graphs
      .filter((s) => s.g.state === 'altered' || s.g.state === 'forked')
      .map((s) => (s.g.heads.some(isSealedShut) ? { why: `${s.graphIri}: ${s.g.heads.find(isSealedShut)?.why ?? ''}`, sealed: true } : { why: whyUnusable(s), sealed: false }));
    const lines = new Map<string, LoadedRecord[]>();
    for (const s of snap.graphs) {
      if (s.g.state !== 'ok') continue;
      const l = await call.view.line(s.g);
      if (l.cut) shut.push({ why: cutWhy(s.graphIri, l.cut), sealed: l.cut.sealed, ...(l.cut.untrustedKey !== null ? { setting: cutSetting(l.cut) } : {}) });
      lines.set(s.graphIri, l.versions);
    }
    if (shut.length > 0) {
      // A sealed one is named first: the setting that opens it is the likeliest fix; then one a platform key no longer trusted cut.
      const sealed = shut.filter((x) => x.sealed);
      const named = sealed[0] ?? shut.find((x) => x.setting !== undefined) ?? shut[0];
      return { ...refuse(409, sealed.length > 0
        ? 'Some records on this pod are sealed to a key this bridge does not hold, so it cannot tell whether they name you; nothing was copied.'
        : 'Some records on this pod were altered after signing, have more than one current version or none, have an earlier version signed by a key this bridge no longer trusts, or are missing an earlier version, so it cannot tell whether they name you; nothing was copied.',
      `${shut.length} graph(s) cannot be read in full, for example ${named?.why ?? ''}`, sealed.length > 0 ? { env: 'WRD_RECORD_KEY' } : named?.setting) };
    }
    const me = call.actor;
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
      // The holder's pod is reached through the holder transport, which never carries the operator's credential.
      try { targetFetch = await openPod(target, deps.holderFetchFn ?? deps.fetchFn); } catch (e) { return { ...refuse(400, 'The target pod is not a safe target.', messageOf(e)) }; }
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
      kind: 'HolderCopy', entity: newEntity('holder-copy', me, `${target ?? 'export'}|${call.nonce}`), status, head: null,
      payload: { holder: { address: me, did: call.actorDid }, targetPodUrl: target, copied, envelope: call.envelope },
      signers: [signerOf(reg, me, 'Curator', status === 'copied' ? 'copied their record' : 'exported their record')],
    });
    return { holder: { address: me, did: call.actorDid }, status, targetPodUrl: target, copied, bundle, receiptUrl: w.descriptorUrl, platform: call.platformRef, recorded: true };
  }

  const handlers: Record<string, WrdHandler> = {
    'wrd.update_registry': async (args) => {
      const call = await openSigned(args, 'wrd:update-registry');
      if (admins.size === 0) return { ...refuse(403, 'This bridge has no admin addresses configured.', 'nobody can change the registry until the bridge is started with admin addresses or admin user DIDs (WRD_ADMIN_ADDRESSES, WRD_ADMIN_DIDS)') };
      const reg = await registryOf(call);
      if (!isAdmin(call.actor)) return { ...refuse(403, 'Only an admin can change the registry.', `${call.actor} is not one of this bridge's admin ${isUserPrincipal(call.actor) ? 'user DIDs (WRD_ADMIN_DIDS)' : 'addresses (WRD_ADMIN_ADDRESSES)'}`) };
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
      const boundText = call.payload['taskTextSha256'];
      if (typeof boundText !== 'string' || !/^[0-9a-f]{64}$/.test(boundText)) {
        return { ...refuse(400, BAD_PAYLOAD, "payload.taskTextSha256 must be the task's textSha256 (from wrd.read_records): it binds the answers to the description they are about") };
      }
      const personNote = maybe(call.payload, 'notes', LIMITS.note);
      const reg = await registryOf(call);
      const task = await taskHead(call, taskIri);
      const tp = task.record.payload;
      const named = tp.namedParties.includes(call.actor);
      if (!named && !holds(reg, call.actor, 'operator') && !holds(reg, call.actor, 'approver')) {
        return { ...refuse(403, 'Only a registered operator or approver, or someone named on this task, can classify it.', `${call.actor} is none of these${unregisteredHint(reg, call.actor)}`) };
      }
      if (task.record.status === 'retired') return { ...refuse(409, RETIRED, `${taskIri} was retired`) };
      if (boundText !== tp.textSha256) {
        return { ...refuse(409, "The task's description changed since you read it; answer for the current text.", `the current description's textSha256 is ${tp.textSha256}`, via('read_records')) };
      }
      const answers = coerceAnswers(call.payload['answers']);
      if (!answers) return { ...refuse(400, BAD_PAYLOAD, 'answers must give one of the published options for each of the seven questions') };
      const result = classifyTask(answers, published);
      if (!result.placed) return { ...refuse(400, 'No evidence places this task in a regime.', result.why) };
      const entity = await classificationOf(call, tp.workflowIri, taskIri);
      const head = await headOf(call, entity, 'Classification');
      // 'performer' is a registered PERSON named on the task; an agent named on it answers as
      // 'agent': its answers count as its own ratification, never as expert evidence, and the
      // people named must still ratify them.
      const role = named && isPerson(reg, call.actor) ? 'performer' : named ? 'agent' : holds(reg, call.actor, 'approver') ? 'approver' : 'operator';
      const ratifications = named ? [{ party: call.actor, verdict: 'ratify' as const, envelope: call.envelope, at: call.at }] : [];
      const status = verdictStatus(tp.namedParties, ratifications) === 'ratified' ? 'ratified' : 'classified';
      const decided = (await effectiveAllocations(call, tp.workflowIri)).get(taskIri);
      const currentNote = currentAllocationNote(decided?.allocation ?? tp.current, result.regime, answers, reg.policy, decided ? 'decision' : 'captured');
      const notes = [...result.notes, ...(currentNote ? [currentNote] : []), ...(personNote ? [`Classifier's note: ${personNote}`] : [])];
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
        const suspended = current.level === 'agent-acts-within-grant' && !!current.agentAddress
          && !(await grantState(call, reg, current.agentAddress, tp.taskKind)).active;
        const forCheck: TaskForAllocation = {
          taskIri: c.taskIri, taskKind: tp.taskKind, current, ...(suspended ? { currentSuspended: true } : {}),
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
      const planIri = newEntity('plan', workflowIri, `${call.actor}|${call.nonce}`);
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
      const retired = retiredInPlan(ps);
      if (retired) return { ...retired };
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
      const personOversees = new Set(changedRows.filter((r) => {
        const l = reg.policy.levels.get(r.proposed.level);
        return !!l && l.requiresAgent && l.requiresPerson;
      }).map((r) => r.taskIri));
      const coerced = coerceValuationInputs(rawInputs, { taskIris: pp.tasks.map((r) => r.taskIri), valuedChanged, personOversees });
      if (!coerced.ok) return { ...refuse(400, 'The valuation inputs are malformed.', coerced.why) };
      const inputs = coerced.inputs;
      // Expert evidence is WHO answered the seven questions — an approver, a person named on the
      // task, or a classification everyone named ratified — never a basis label on an input,
      // which the requesting operator types.
      const expertEvidence: Array<{ taskIri: string; satisfiedBy: ExpertEvidenceBasis }> = [];
      for (const row of changedRows) {
        if (!reg.policy.regimes.get(row.regime)?.requiresExpertEvidence) continue;
        const cls = ps.classifications.get(row.taskIri);
        const role = cls?.record.payload.answeredBy.role;
        const satisfiedBy: ExpertEvidenceBasis | null = role === 'approver' ? 'approver-answers' : role === 'performer' ? 'performer-answers'
          : cls?.record.status === 'ratified' ? 'ratified-classification' : null;
        if (!satisfiedBy) {
          return { ...refuse(409, 'Knowable work is valued only with expert analysis: classification answers from an approver or from a person named on the task, or a classification everyone named on it ratified.', `${row.taskIri} has none of these`, via('classify_task')) };
        }
        expertEvidence.push({ taskIri: row.taskIri, satisfiedBy });
      }
      const valuationIri = await resolveEntity(call, 'valuation', planIri, sha256Hex(canonicalJson(inputs)));
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
      const reportedAgentCost = await reportedRunCosts(call, reg, kindsNeeded, inputs.currency);
      const result: ValuationResult = valuePlan(inputs, {
        planIri, taskOrder: pp.tasks.map((r) => r.taskIri), valuedChanged, agentLevelTasks, taskKindOf, reportedAgentCost,
        methodIri: published.valuationMethodIri, draws,
      });
      const notFinite = nonFiniteIn(result);
      if (notFinite) {
        return { ...refuse(400, 'These inputs do not give a finite valuation; nothing was recorded.', `${notFinite} is not a finite number; check the magnitudes of the inputs it multiplies`) };
      }
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
        if (valuation.record.payload.valuationHash !== valuationHash) return { ...refuse(409, 'The valuation hash does not match the valuation on the pod.', `the record's hash is ${valuation.record.payload.valuationHash}`, via('read_records')) };
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
      const retired = retiredInPlan(ps);
      if (retired) return { ...retired };
      const standing = standingOf(ps);
      if (standing) return { ...standing };
      const stale = staleness(ps);
      if (stale) return { ...refuse(409, stale, `${planIri} was proposed against task versions that are no longer current`, via('propose_allocation')) };
      const grantChecks = await grantChecksFor(call, reg, pp.tasks);
      const inactive = grantChecks.find((g) => !g.active);
      if (inactive) return { ...refuse(409, `No active grant for this agent on this kind of task: ${inactive.why ?? ''}`, `${inactive.taskIri}: ${inactive.why ?? ''}`, via('grant_autonomy')) };
      const decisionIri = await resolveEntity(call, 'decision', pp.workflowIri, valuation ? `${planIri}|${valuation.record.payload.valuationHash}` : `${planIri}|probe`);
      if (await headOf(call, decisionIri, 'Decision')) return { ...refuse(409, 'This decision was already submitted.', `${decisionIri} exists`, via('read_records')) };
      const busy = await openDecisionOn(call, pp.workflowIri, decisionIri, new Set(changedRows.map((r) => r.taskIri)));
      if (busy) return { ...openDecisionRefusal(busy) };

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
        preparedBy: preparersOf(reg, plan, valuation, { did: call.actorDid, personRef: personRefOf(reg, call.actor) }),
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
      const overSilence = p['unacknowledgedConsidered'] ?? [];
      if (!Array.isArray(overSilence) || !overSilence.every((x) => typeof x === 'string')) return { ...refuse(400, BAD_PAYLOAD, 'payload.unacknowledgedConsidered must be a list of task IRIs') };
      maybe(p, 'note', LIMITS.note);
      const reg = await registryOf(call);
      const decision = await headOf(call, decisionIri, 'Decision');
      if (!decision) return { ...refuse(404, 'No such decision on this pod.', `${decisionIri} has no record on ${call.podUrl}`) };
      const dp = decision.record.payload;
      if (!holds(reg, call.actor, 'approver')) return { ...refuse(403, 'Only a registered approver can countersign.', `${call.actor} does not hold the approver role in this pod's registry${unregisteredHint(reg, call.actor)}`) };
      const plan = await headOf(call, dp.planIri, 'Plan');
      if (!plan) throw decline(409, INTEGRITY, `the decision's plan ${dp.planIri} has no trusted record`);
      const valuation = dp.valuationIri ? await headOf(call, dp.valuationIri, 'Valuation') : null;
      // Separation of duties, by the person the admin attests is behind each key: the approver
      // prepared none of the prediction, is not a person it changes, and is not accountable for
      // an agent it puts on the work.
      const me = personRefOf(reg, call.actor);
      const preparers = preparersOf(reg, plan, valuation, dp.submittedBy);
      if (me === dp.submittedBy.personRef || preparers.some((x) => x.role === 'submitted' && x.personRef === me)) {
        return { ...refuse(403, 'The person who submitted a decision cannot countersign it, from any of their registered keys.', `${call.actor} is attested as ${me}, the submitter`) };
      }
      if (preparers.some((x) => x.role === 'proposed' && x.personRef === me)) {
        return { ...refuse(403, 'The person who proposed this plan cannot countersign it, from any of their registered keys.', `${call.actor} is attested as ${me}, who proposed ${dp.planIri}`) };
      }
      if (preparers.some((x) => x.role === 'valued' && x.personRef === me)) {
        return { ...refuse(403, 'The person who requested the valuation cannot countersign the decision it predicts.', `${call.actor} is attested as ${me}, who requested ${dp.valuationIri ?? 'the valuation'}`) };
      }
      const subjectRefs = new Set(dp.subjects.flatMap((s) => [s.personRef, personRefOf(reg, s.address)]));
      if (subjectRefs.has(me)) return { ...refuse(403, 'A person whose work this decision changes cannot countersign it.', `${call.actor} is attested as ${me}, who is named on a changed task`) };
      if (principalsOf(reg, plan).has(me)) {
        return { ...refuse(403, 'The person accountable for an agent this decision puts on the work cannot countersign it.', `${call.actor} is attested as ${me}, the principal of an agent named on a changed task`) };
      }
      if (recordId !== decision.loaded.recordId || b.descriptorUrl !== decision.loaded.descriptorUrl || b.graphDigest !== decision.loaded.graphDigest) {
        return { ...refuse(409, DECISION_MOVED, `the current version is ${decision.loaded.descriptorUrl}`, via('read_records')) };
      }
      if (decision.record.status !== 'submitted') return { ...refuse(409, 'Only a submitted decision can be countersigned or declined.', `${decisionIri} is ${decision.record.status}`) };
      const assignmentsNow = await assignmentStates(call, plan);
      let grantChecks = dp.grantChecks;
      if (verdict === 'approve') {
        // Re-check at approval what submission checked: the people named may have disputed since.
        const ps = await planState(call, plan);
        const retired = retiredInPlan(ps);
        if (retired) return { ...retired };
        const standing = standingOf(ps);
        if (standing) return { ...standing };
        const stale = staleness(ps);
        if (stale) return { ...refuse(409, stale, `${dp.planIri} was proposed against task versions that are no longer current`, via('propose_allocation')) };
        const checks = await grantChecksFor(call, reg, plan.record.payload.tasks);
        const inactive = checks.find((g) => !g.active);
        if (inactive) return { ...refuse(409, `No active grant for this agent on this kind of task: ${inactive.why ?? ''}`, `${inactive.taskIri}: ${inactive.why ?? ''}`, via('grant_autonomy')) };
        grantChecks = checks.map((g) => ({ taskIri: g.taskIri, grantIri: g.grantIri, active: g.active, evidenceFromThisTask: g.evidenceFromThisTask }));
        const busy = await openDecisionOn(call, plan.record.payload.workflowIri, decisionIri, new Set(plan.record.payload.tasks.filter((r) => r.changed).map((r) => r.taskIri)));
        if (busy) return { ...openDecisionRefusal(busy) };
        const objected = new Set(assignmentsNow.filter((a) => a.state === 'objected').map((a) => a.taskIri));
        const named = new Set(considered as string[]);
        const missing = [...objected].filter((t) => !named.has(t));
        const extra = [...named].filter((t) => !objected.has(t));
        if (missing.length > 0) {
          return { ...refuse(409, `A person named in this plan objects to their assignment on ${missing.join(', ')}: name it in objectionsConsidered to approve over it.`, 'approval must name every current objection') };
        }
        if (extra.length > 0) return { ...refuse(409, 'objectionsConsidered names tasks nobody objected to.', `no current objection on ${extra.join(', ')}`) };
        // Silence is not assent: an assignment nobody acknowledged is approved over only by naming it.
        const silent = new Set(assignmentsNow.filter((a) => a.state === 'not-acknowledged').map((a) => a.taskIri));
        const namedSilent = new Set(overSilence as string[]);
        const unnamed = [...silent].filter((t) => !namedSilent.has(t));
        if (unnamed.length > 0) {
          return { ...refuse(409, `A person this plan names has not acknowledged their assignment on ${unnamed.join(', ')}: ask them to, or name it in unacknowledgedConsidered to approve over their silence.`, 'approval must name every assignment nobody acknowledged', via('ratify_task')) };
        }
        const notSilent = [...namedSilent].filter((t) => !silent.has(t));
        if (notSilent.length > 0) return { ...refuse(409, 'unacknowledgedConsidered names tasks with no unacknowledged assignment.', `nothing is waiting on ${notSilent.join(', ')}`) };
      }
      const status = verdict === 'approve' ? 'countersigned' : 'declined';
      const payload: DecisionPayload = {
        ...dp,
        ...(dp.prediction && verdict === 'decline' ? { prediction: { ...dp.prediction, status: 'not-to-be-measured' as const } } : {}),
        grantChecks,
        countersign: {
          verdict, did: call.actorDid, personRef: me, envelope: call.envelope, objectionsConsidered: considered as string[],
          ...(verdict === 'approve' ? { unacknowledgedConsidered: overSilence as string[] } : {}),
          assignmentsAtCountersign: assignmentsNow, at: call.at,
        },
      };
      const w = await write(call, {
        kind: 'Decision', entity: decisionIri, status, payload, head: decision,
        signers: [
          signerOf(reg, principalOfDid(dp.submittedBy.did), 'Curator', 'submitted'),
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
        return { ...refuse(403, 'Only a registered operator or approver can record an outcome.', `${call.actor} holds neither role in this pod's registry${unregisteredHint(reg, call.actor)}`) };
      }
      const me = personRefOf(reg, call.actor);
      const submitter = addressOfDid(dp.submittedBy.did);
      const plan = await headOf(call, dp.planIri, 'Plan');
      const valuationHead = dp.valuationIri ? await headOf(call, dp.valuationIri, 'Valuation') : null;
      const preparers = preparersOf(reg, plan, valuationHead, dp.submittedBy);
      if (me === dp.submittedBy.personRef || preparers.some((x) => x.personRef === me)) {
        const role = preparers.find((x) => x.personRef === me)?.role ?? 'submitted';
        return { ...refuse(403, 'The person who predicted cannot grade the prediction.', `${call.actor} is attested as ${me}, who ${role} ${role === 'proposed' ? 'the plan' : role === 'valued' ? 'the valuation' : 'the decision'}`) };
      }
      if (dp.countersign && (me === dp.countersign.personRef || me === personRefOf(reg, addressOfDid(dp.countersign.did)))) {
        return { ...refuse(403, 'The person who approved a decision cannot grade it.', `${call.actor} is attested as ${me}, who countersigned ${decisionIri}`) };
      }
      if (recordId !== decision.loaded.recordId || b.descriptorUrl !== decision.loaded.descriptorUrl || b.graphDigest !== decision.loaded.graphDigest) {
        return { ...refuse(409, DECISION_MOVED, `the current version is ${decision.loaded.descriptorUrl}`, via('read_records')) };
      }
      if (decision.record.status !== 'countersigned' || !dp.countersign || dp.countersign.verdict !== 'approve') {
        return { ...refuse(409, 'An outcome can be recorded only for a countersigned decision.', `${decisionIri} is ${decision.record.status}`, via('countersign_decision')) };
      }
      // The countersign is weeks old by design: re-verify the stored envelope against the CURRENT
      // registry and the same separation rules, never the modal status alone. A relay-delegated one
      // is re-verified offline: the relay's signature against the relays trusted now, the agent and
      // principal stored beside it (verifyStoredEnvelope); the agent's DID document is not re-read.
      const cs = dp.countersign;
      const stored = verifyStoredEnvelope(cs.envelope, 'wrd:countersign-decision', call.podUrl, storedRelay);
      const approver = stored.ok ? stored.signer : '';
      const approverRef = approver ? personRefOf(reg, approver) : '';
      const subjectRefs = new Set(dp.subjects.flatMap((s) => [s.personRef, personRefOf(reg, s.address)]));
      const boundTo = cs.envelope.payload;
      if (!stored.ok || !holds(reg, approver, 'approver') || approverRef === dp.submittedBy.personRef || preparers.some((x) => x.personRef === approverRef)
        || subjectRefs.has(approverRef) || principalsOf(reg, plan).has(approverRef) || boundTo['decisionIri'] !== decisionIri || boundTo['verdict'] !== 'approve') {
        return { ...refuse(409, 'The countersign on this decision no longer verifies.', stored.ok ? `${approver} is no longer a registered approver who prepared nothing in this decision, is not a subject of it, and answers for no agent it names` : stored.why) };
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
      let shorterThanPlanned = false;
      if (dp.decisionKind === 'valued' && dp.measurementPlan) {
        const w0 = windows[0];
        const length = checkWindowLength({ windowStart: String(w0?.windowStart ?? ''), windowEnd: String(w0?.windowEnd ?? ''), windowWeeks: dp.measurementPlan.windowWeeks, disposition });
        if (!length.ok) return { ...refuse(length.status, length.why, length.detail) };
        shorterThanPlanned = length.shorterThanPlanned;
      }

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
        // The pilot check counts the person-reviewed runs on the pod, on the changed agent-level
        // tasks, performed inside the window — never counts the grader typed, which are shown beside it.
        const pilot = valuationHead?.record.payload.result.pilot ?? [];
        const needed = Math.max(0, ...pilot.map((x) => x.runsNeeded));
        let pilotCheck: NonNullable<NonNullable<NonNullable<DecisionPayload['outcome']>['valued']>['pilotCheck']> | undefined;
        if (needed > 0) {
          const pilotTasks = new Set(pilot.map((x) => x.taskIri));
          const t0 = Date.parse(measured.windowStart);
          const t1 = Date.parse(measured.windowEnd);
          let reviewedRuns = 0;
          let criticalFailures = 0;
          for (const row of plan?.record.payload.tasks ?? []) {
            if (!row.changed || !pilotTasks.has(row.taskIri) || !row.proposed.agentAddress) continue;
            for (const g of await scopedGraphs(call, 'run', `${lower(row.proposed.agentAddress)}|${row.taskKind}`)) {
              const run = headIn(await call.view.graph(g), 'AgentRun');
              const r = run ? reviewedRunOf(run.record) : null;
              if (!r || r.taskIri !== row.taskIri) continue;
              const at = Date.parse(r.performedAt);
              if (at < t0 || at > t1) continue;
              reviewedRuns += 1;
              if (r.verdict === 'critical-failure') criticalFailures += 1;
            }
          }
          const declared = {
            ...(measured.runsObserved !== undefined ? { runsObserved: measured.runsObserved } : {}),
            ...(measured.criticalFailuresObserved !== undefined ? { criticalFailuresObserved: measured.criticalFailuresObserved } : {}),
          };
          pilotCheck = {
            runsNeeded: needed, reviewedRuns, criticalFailures, ceilingSupported: reviewedRuns >= needed && criticalFailures === 0,
            ...(Object.keys(declared).length > 0 ? { declared } : {}),
          };
        }
        const valued = {
          measured, metric: prediction.metric, verdict: graded.verdict, adjustedBand: graded.adjustedBand, rampFactor: graded.rampFactor,
          rampAdjusted: graded.rampAdjusted, basisChanged: measured.comparisonBasis !== dp.measurementPlan.comparisonBasis,
          windowWeeks: dp.measurementPlan.windowWeeks, ...(shorterThanPlanned ? { windowShorterThanPlanned: true } : {}),
          ...(pilotCheck ? { pilotCheck } : {}),
        };
        outcome = { did: call.actorDid, personRef: me, envelope: call.envelope, disposition, ...(dispositionNote ? { dispositionNote } : {}), at: call.at, valued };
        const comparisonGroup = measured.comparisonBasis !== 'before-after';
        reply = {
          valued: {
            verdict: graded.verdict, predictedBand: prediction.band, adjustedBand: graded.adjustedBand, rampFactor: graded.rampFactor, rampAdjusted: graded.rampAdjusted,
            measured: measured.weeklyValueDelta, comparisonGroup, basisLabel: comparisonGroup ? measured.comparisonBasis : `before-after — ${NO_COMPARISON_GROUP}`,
            windowShorterThanPlanned: shorterThanPlanned, countsTowardCalibration: !shorterThanPlanned && graded.verdict !== 'inconclusive',
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
      // The review may be relay-delegated (a person signed in with their Interego account): under
      // review_envelope, or at the top level of the body as the relay's act sends it, in which case
      // the agent's own run envelope may travel inside the payload the relay signed. The run itself
      // is always key-held: an agent signs its runs with its own key.
      const reviewRelay = relayFormIn(args, 'review_envelope');
      const runRaw = args['run_envelope'] ?? reviewRelay?.parsed?.['run_envelope'];
      const reviewRaw = reviewRelay ? undefined : args['review_envelope'];
      const call = await openCall(args, runRaw, true);
      // The run may be an hour old (logged under a grant, reviewed later): check it as a stored envelope first, freshness later.
      const runOpened = openEnvelope(runRaw, 'wrd:agent-run', call.podUrl, call.now, { pastMs: Number.POSITIVE_INFINITY, futureMs: window.futureMs });
      if (!runOpened.ok) return { ...refuse(runOpened.status, runOpened.error, `run_envelope: ${runOpened.why}`) };
      // As in openSigned: nothing is written on a pod holding records written under another record key, checked before the registry is read.
      await refuseKeyConflict(call);
      const reg = await registryOf(call);
      let review: Extract<ReturnType<typeof openEnvelope>, { ok: true }> | null = null;
      if (reviewRelay !== null || (reviewRaw !== undefined && reviewRaw !== null)) {
        const r = await openAuthorising(call, reviewRelay, reviewRaw, 'wrd:review-agent-run');
        if (!r.ok) return { ...refuse(r.status, r.error, `review_envelope: ${r.why}`) };
        // The review authorises this call: its nonce is claimed as soon as it verifies (for a key the registry knows), like every other write's envelope.
        if (memberOf(reg, r.signer) && !ledger.claim(r.signer, String(r.payload['nonce']), call.now)) return { ...refuse(409, REPLAYED, `${r.signer} already used the nonce ${String(r.payload['nonce'])}`) };
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
      const entity = await resolveEntity(call, 'run', `${agent}|${taskKind}`, runId);
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
        if (memberOf(reg, agent) && !ledger.claim(agent, String(rp['nonce']), call.now)) return { ...refuse(409, REPLAYED, `${agent} already used the nonce ${String(rp['nonce'])}`) };
      }
      if (!isAgent(reg, agent)) {
        return { ...refuse(403, 'Only a registered software agent can log a run.', `${agent}, the address recovered from run_envelope, is not a registered agent${unregisteredHint(reg, agent)}`, via('update_registry')) };
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
          return { ...refuse(403, 'Only a registered operator or approver can review a run.', `${reviewer} holds neither role in this pod's registry${unregisteredHint(reg, reviewer)}`) };
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
        // Under a grant the agent acts alone only on runs it calls ready; anything else goes to a person.
        if (sa['answer'] !== 'accepted') {
          return { ...refuse(409, `Under a grant the agent acts alone only on runs it calls accepted; it calls this one ${String(sa['answer'])}. Route it to a person: log it with a review_envelope.`, 'a run the agent does not call ready is never acted on alone', via('log_agent_run')) };
        }
        // A grant is held per (agent, kind of task); acting on THIS task needs an approved decision
        // that put it at agent-acts-within-grant for this agent, and the task as it stands now must
        // still allow it (regime, checkability, worst case, ratified and current classification).
        const authorised = (await effectiveAllocations(call, task.record.payload.workflowIri)).get(taskIri);
        if (!authorised || authorised.allocation.level !== 'agent-acts-within-grant' || authorised.allocation.agentAddress !== agent) {
          return { ...refuse(409, 'No approved decision puts this task at agent-acts-within-grant for this agent, so it may not act on it alone.',
            `${taskIri} is in force at ${authorised?.allocation.level ?? task.record.payload.current.level}${authorised ? ` (${authorised.decisionIri})` : ' (as captured)'}`, via('propose_allocation')) };
        }
        const standing = checkActingUnderGrant(agent, await taskForAllocation(call, task, authorised.allocation), {
          policy: reg.policy, isRegisteredAgent: (a) => isAgent(reg, a), isRegisteredPerson: (a) => isPerson(reg, a), grantFor: () => g,
        });
        if (!standing.ok) return { ...refuse(standing.status, standing.error, `${taskIri}: ${standing.why}`, standing.resolvedBy ? viaToolName(standing.resolvedBy) : undefined) };
      }
      const status = reviewPart ? 'reviewed' : 'acted-under-grant';
      // The record id carries the nonce of the envelope that authorises THIS write: the review's when there is one.
      const authorising: Signed = review
        ? {
          ...call, actor: review.signer, actorDid: review.did, payload: review.payload, envelope: review.envelope, nonce: String(review.payload['nonce']),
          ...(review.authority === 'relay-delegated' ? { relayed: { agentId: review.agentId ?? '', relaySigner: review.relaySigner ?? '' } } : {}),
        }
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
      if (!holds(reg, call.actor, 'approver')) return { ...refuse(403, 'Only a registered approver can grant autonomy.', `${call.actor} does not hold the approver role in this pod's registry${unregisteredHint(reg, call.actor)}`) };
      if (!isAgent(reg, agent)) return { ...refuse(403, 'Grants are for registered software agents only; people are never given enforced grants.', `${agent} is not a registered software agent`) };
      const member = memberOf(reg, agent);
      if (member?.principal && personRefOf(reg, call.actor) === personRefOf(reg, member.principal)) {
        return { ...refuse(403, 'The person accountable for this agent cannot grant it autonomy.', `${call.actor} is attested as the agent's principal`) };
      }
      const kind = kindUsable(reg, taskKind);
      if (!kind) return { ...refuse(400, UNKNOWN_KIND, `${taskKind}: ${KIND_FIX}`, via('update_registry')) };
      const entity = await grantEntity(call, agent, taskKind);
      const head = await headOf(call, entity, 'Grant');
      if (head && head.record.status === 'granted') return { ...refuse(409, 'This agent already holds a grant on this kind of task.', `${entity} is granted; revoke it first to re-evaluate`, via('revoke_grant')) };
      const since = head && head.record.status === 'revoked' ? head.record.payload.revocation?.at ?? head.loaded.validUntil : null;
      const runs: ReviewedRun[] = [];
      for (const g of await scopedGraphs(call, 'run', `${agent}|${taskKind}`)) {
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
      if (typeof recordId !== 'string' || recordId === '') return { ...refuse(400, BAD_PAYLOAD, 'payload.recordId must name the grant head you read') };
      const b = needBinding(p);
      const why = need(p, 'why', LIMITS.note);
      const reg = await registryOf(call);
      if (!holds(reg, call.actor, 'approver')) return { ...refuse(403, 'Only a registered approver can revoke a grant.', `${call.actor} does not hold the approver role in this pod's registry${unregisteredHint(reg, call.actor)}`) };
      const head = await headOf(call, grantIri, 'Grant');
      if (!head) return { ...refuse(404, 'No such grant on this pod.', `${grantIri} has no record on ${call.podUrl}`) };
      if (recordId !== head.loaded.recordId || b.descriptorUrl !== head.loaded.descriptorUrl || b.graphDigest !== head.loaded.graphDigest) {
        return { ...refuse(409, 'The grant changed since you read it.', `the current version is ${head.loaded.descriptorUrl}`, via('read_records')) };
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
      // A copy reads every version on the pod, so it is bounded before anything else is read. openSigned
      // claimed the nonce of an admin or a registered key; any other signer (a key made for the purpose
      // costs nothing, and someone removed from the registry is one) draws on one budget shared by all of
      // them, and its nonce is claimed too, so no envelope is answered twice.
      const stranger = !isAdmin(call.actor) && !memberOf(await registryOf(call), call.actor);
      // Wall-clock time, not the bridge's clock (which the offline demo scripts): this bounds load, not what a record says.
      const t = Date.now();
      while (strangerCopies.length > 0 && (strangerCopies[0] ?? t) <= t - 60_000) strangerCopies.shift();
      if (stranger) {
        // Strangers have their own lane, so keys made for the purpose can never hold the slots an
        // admin or a member needs, and a stranger's call is charged when it arrives, whether or not
        // its lane is free, so filling the lane does not leave the budget untouched.
        if (strangerCopies.length >= copyLimits.strangersPerMinute) {
          return { ...refuse(429, HOLDER_COPY_BUSY, `this bridge answers at most ${copyLimits.strangersPerMinute} holder copies a minute from keys that are neither an admin nor in this pod's registry, all such keys together; try again in a minute`) };
        }
        if (!ledger.claim(call.actor, call.nonce, call.now)) return { ...refuse(409, REPLAYED, `${call.actor} already used the nonce ${call.nonce} on this bridge`) };
        strangerCopies.push(t);
        if (strangerCopiesInProgress >= 1) {
          return { ...refuse(429, HOLDER_COPY_BUSY, 'this bridge makes one holder copy at a time for keys that are neither an admin nor in this pod\'s registry; try again shortly with a fresh envelope') };
        }
        strangerCopiesInProgress += 1;
        try {
          return await holderCopy(call);
        } finally {
          strangerCopiesInProgress -= 1;
        }
      }
      if (copiesInProgress >= copyLimits.concurrent) {
        return { ...refuse(429, HOLDER_COPY_BUSY, `this bridge makes at most ${copyLimits.concurrent} holder copies at once for admins and registry members; try again shortly`) };
      }
      copiesInProgress += 1;
      try {
        return await holderCopy(call);
      } finally {
        copiesInProgress -= 1;
      }
    },

    // The unsigned template is a GET: its arguments travel in the URL, where server, proxy and
    // browser logs keep them. It never reads with a signed read, and a signed read reads every
    // record until it is stale, so the forms of one it detects (signedReadIn: a read_envelope
    // parameter in any spelling, a key with a step named for a signature, a key or value holding a 0x
    // signature or a "signature" JSON field) are refused before anything is read, and the
    // refusal points at the POST form.
    'wrd.envelope_template': async (args) => {
      const inUrl = signedReadIn(args);
      if (inUrl !== null) {
        return { ...refuse(400, SIGNED_READ_IN_URL,
          `${inUrl} carries a signed read or a signature and was sent to wrd.envelope_template, whose arguments travel in the URL, where logs keep them; nothing was read or filled. POST the same arguments to wrd.read_envelope_template with read_envelope in the JSON body, and sign a new read: one that has been in a URL should be taken as seen by whoever keeps those logs`,
          { ...via('read_envelope_template'), method: 'POST', intent: 'wrd:read-records' }) };
      }
      return envelopeTemplate(args, false);
    },

    'wrd.read_envelope_template': async (args) => envelopeTemplate(args, true),

    'wrd.list_records': async (args) => {
      if (!publicReads) return unsignedRead('read_records');
      const bad = badListKind(args);
      if (bad) return bad;
      return listRecords(await openCall(args, undefined, false), args);
    },

    'wrd.read_records': async (args) => {
      const bad = badListKind(args);
      if (bad) return bad;
      const { call, signer } = await openRead(args, 'read_records');
      const listed = await listRecords(call, args);
      // Who read: whether the signer is an admin, so a client offers registry changes only to one (every change is checked again).
      return listed['status'] === 'listed' ? { ...listed, reader: { admin: isAdmin(signer) } } : listed;
    },

    'wrd.calibration': async (args) => {
      if (!publicReads) return unsignedRead('read_calibration');
      const bad = badCalibrationKind(args);
      if (bad) return bad;
      return calibrate(await openCall(args, undefined, false), args);
    },

    'wrd.read_calibration': async (args) => {
      const bad = badCalibrationKind(args);
      if (bad) return bad;
      return calibrate((await openRead(args, 'read_calibration')).call, args);
    },
  };

  // ── The read model (the GET when reads are public, the signed read always) ───────────

  const LIST_SECTIONS = ['registry', 'workflows', 'tasks', 'plans', 'valuations', 'decisions', 'grants', 'runs'];
  const kindArg = (args: Obj): string | null => (typeof args['kind'] === 'string' && args['kind'] !== '' ? args['kind'] : null);
  const badListKind = (args: Obj): BridgeRefusal | null => {
    const kind = kindArg(args);
    return kind !== null && !LIST_SECTIONS.includes(kind) ? refuse(400, 'Unknown kind.', `kind must be one of ${LIST_SECTIONS.join(', ')}`) : null;
  };
  const badCalibrationKind = (args: Obj): BridgeRefusal | null => {
    const kind = kindArg(args);
    return kind !== null && kind !== 'predictions' && kind !== 'agents' && kind !== 'probes' ? refuse(400, 'Unknown kind.', 'kind must be predictions, agents or probes') : null;
  };

  /** A grant as the read model shows it: active, inactive with why, or (null) a record that cannot be read, with why. */
  interface GrantView { readonly active: boolean | null; readonly why: string | null }
  async function grantView(call: Call, reg: Registry, agent: string, taskKind: string): Promise<GrantView> {
    try {
      const g = await grantState(call, reg, agent, taskKind);
      return { active: g.active, why: g.active ? null : g.why };
    } catch (e) {
      // Sealed shut: neither active nor inactive. The listing says so and goes on; a lifecycle call refuses (409).
      if (e instanceof Declined && isObj(e.refusal['iep:resolvedBy']) && e.refusal['iep:resolvedBy']['env'] === 'WRD_RECORD_KEY') {
        return { active: null, why: String(e.refusal['iep:refusalReason'] ?? '') };
      }
      throw e;
    }
  }
  /** The graphs whose current version is sealed and does not open, with why. */
  const sealedOf = (snap: Snapshot): Obj[] => snap.graphs.filter((s) => s.g.heads.some(isSealedShut))
    .map((s) => ({ graphIri: s.graphIri, why: s.g.heads.find(isSealedShut)?.why ?? null }));
  /** Why a graph cannot be used: the head's own why, which names WRD_RECORD_KEY when it is sealed and does not open. */
  const whyUnusable = (s: SnapGraph): string => `${s.graphIri}: ${unusableWhy(s.g)}`;
  /** The whys of some graphs, the first three spelled out (every one is listed under sealed, altered or forked). */
  const whysOf = (shut: readonly SnapGraph[]): string =>
    `${shut.slice(0, 3).map(whyUnusable).join('; ')}${shut.length > 3 ? `; and ${shut.length - 3} more, listed under sealed, altered or forked` : ''}`;
  /**
   * Graphs of one kind whose current version cannot be used (altered, forked, or sealed and not
   * opened). The kind is public in every entity IRI, keyed or not, so a figure counted from records
   * of a kind knows when one of them is missing from the count, even when it cannot tell which.
   */
  const shutOfKind = (snap: Snapshot, kind: EntityKind): SnapGraph[] =>
    snap.graphs.filter((s) => kindOfIri(s.graphIri) === kind && (s.g.state === 'altered' || s.g.state === 'forked'));
  /**
   * The mark a figure counted from records of these kinds carries when any of them cannot be read
   * (null when every one opens): the figure is the count of the records that open, and says so,
   * never presented as if the others were absent.
   */
  const countedWithout = (snap: Snapshot, kinds: readonly EntityKind[], figure: string): string | null => {
    const shut = kinds.flatMap((k) => shutOfKind(snap, k));
    return shut.length === 0 ? null
      : `${figure} counts only the records that can be read: ${shut.length} ${kinds.join(' or ')} record(s) cannot be (${whysOf(shut)}), so ${figure} may differ`;
  };
  /** What the read model says when the pod holds records written under another record key (see keyConflict). */
  const keyConflictNote = (c: KeyConflict): Obj => ({
    why: `${keyConflictWhy(c)}. Writes and lookups by tuple are refused (409), and every answer below that rests on a record written under that key is marked unreadable.`,
    env: 'WRD_RECORD_KEY', podKey: `k${c.fingerprint}`, bridgeKey: ownFingerprint === null ? null : `k${ownFingerprint}`,
  });
  /**
   * The versions the manifest lists at the URL of a version written without a record key (see
   * recordIdFor), for a bridge holding one: their graphs are plaintext on the pod. Read from the
   * manifest alone, so every version is counted, not only current ones. Null when there are none,
   * or this bridge holds no key (then every record is plaintext, and readExposure says so).
   */
  async function plaintextOf(call: Call): Promise<Obj | null> {
    if (recordKey === undefined) return null;
    const urls = (await call.view.walk()).entries.map((e) => e.descriptorUrl).filter((u) => UNKEYED_RECORD_URL.test(u));
    return urls.length === 0 ? null : { versions: urls.length, why: PLAINTEXT_NOTE, descriptorUrls: urls.slice(0, PLAINTEXT_LISTED) };
  }

  async function listRecords(call: Call, args: Obj): Promise<Obj> {
    const kind = kindArg(args);
    const subject = typeof args['subject'] === 'string' && args['subject'] !== '' ? args['subject'] : null;
    const workflowFilter = typeof args['workflow'] === 'string' && args['workflow'] !== '' ? args['workflow'] : null;
    const want = (s: string): boolean => kind === null || kind === s;
    const keep = (iri: string, workflowIri: string | null): boolean => (subject === null || subject === iri) && (workflowFilter === null || workflowFilter === workflowIri);
    const reg = await registryForRead(call);
    const snap = await snapshot(call.view);
    const policy = reg.policy;
    const conflict = await keyConflict(call);
    const plaintext = await plaintextOf(call);
    /**
     * Records of a kind keyed under another record key: this bridge cannot derive their IRIs from a
     * tuple, so when a lookup by tuple finds nothing, the record may be one of them. Null when the
     * absence is an answer (no record of that kind is keyed under another key).
     */
    const unknownAbsence = new Map<EntityKind, string | null>();
    const absenceUnknown = (entityKind: EntityKind): string | null => {
      if (!unknownAbsence.has(entityKind)) {
        const foreign = shutOfKind(snap, entityKind).filter((x) => foreignKeyed(x.graphIri));
        unknownAbsence.set(entityKind, foreign.length === 0 ? null
          : `${foreign.length} ${entityKind} record(s) on this pod were keyed under another record key and cannot be read, and this may be one of them (${whysOf(foreign)})${conflict ? `: ${keyConflictWhy(conflict)}` : ''}`);
      }
      return unknownAbsence.get(entityKind) ?? null;
    };
    // Figures counted from runs: their kind is public, which reviewed run each is about is not.
    const runsUnreadable = (figure: string): string | null => countedWithout(snap, ['run'], figure);
    /** Every task's contraryEvidence counts reviewed runs: one that does not open may be on any task. */
    const contraryShut = want('tasks') ? runsUnreadable('contraryEvidence') : null;

    const tasksRec = recordsOf(snap, 'Task');
    const graphByIri = new Map(snap.graphs.map((s) => [s.graphIri, s]));
    const classificationByTask = new Map(recordsOf(snap, 'Classification').map((c) => [c.record.payload.taskIri, c]));
    const plansRec = recordsOf(snap, 'Plan');
    const planByIri = new Map(plansRec.map((pl) => [pl.record.entityIri, pl]));
    const decisionsRec = recordsOf(snap, 'Decision');
    const runsRec = recordsOf(snap, 'AgentRun');
    const workflowsRec = recordsOf(snap, 'Workflow');
    /**
     * A plan's workflow: from the plan when it opens, else from the plan IRI's scope (a plan is
     * minted under its workflow), so a record about a plan that does not open is not filtered
     * out of a workflow's answer as if it were not there.
     */
    const workflowOfPlan = (planIri: string): string | null => planByIri.get(planIri)?.record.payload.workflowIri
      ?? (workflowFilter !== null && scopeForms('plan', workflowFilter).some((pre) => planIri.startsWith(pre)) ? workflowFilter : null);
    const label = (a: string): string => memberOf(reg, a)?.label ?? a;
    const demoRecords = snap.graphs.filter((s) => s.record?.demo === true).length;
    const records = snap.graphs.filter((s) => s.record !== null).length;

    const effective = effectiveFrom(decisionsRec.map((d) => d.record), (iri) => planByIri.get(iri)?.record ?? null);
    // Work a decision put under a grant is checked against the grant NOW: revoked or lapsed, it has no authorised performer.
    const effectiveGrant = new Map<string, GrantView>();
    for (const t of tasksRec) {
      const eff = effective.get(t.record.entityIri);
      if (!eff || eff.allocation.level !== 'agent-acts-within-grant' || !eff.allocation.agentAddress) continue;
      effectiveGrant.set(t.record.entityIri, await grantView(call, reg, eff.allocation.agentAddress, t.record.payload.taskKind));
    }
    /** A graph of the snapshot whose current version cannot be used (altered, forked, or sealed shut), under any of the given IRIs. */
    const unusable = (iris: readonly string[]): SnapGraph | undefined =>
      iris.map((e) => graphByIri.get(graphIriOf(e))).find((s) => s !== undefined && (s.g.state === 'altered' || s.g.state === 'forked'));
    /**
     * Decisions on a workflow that cannot be read: the allocation in force may come from one of
     * them, so the read model says so rather than show the captured allocation as certain. A
     * decision keyed under another record key cannot be placed on a workflow (its scope is keyed),
     * so it counts against every workflow.
     */
    const unreadableDecisions = (workflowIri: string): string[] => [...new Set([
      ...scopeForms('decision', workflowIri).flatMap((prefix) => snap.graphs.filter((s) => s.graphIri.startsWith(prefix) && (s.g.state === 'altered' || s.g.state === 'forked')).map((s) => s.graphIri)),
      ...shutOfKind(snap, 'decision').filter((s) => foreignKeyed(s.graphIri)).map((s) => s.graphIri),
    ])];
    /**
     * The plans that cannot be read of decisions on a workflow that put their plan in force: the
     * allocation such a decision put in force is its plan's, so without the plan it is unknown.
     */
    const unreadablePlansInForce = (workflowIri: string): SnapGraph[] => {
      const prefixes = scopeForms('decision', workflowIri);
      const out: SnapGraph[] = [];
      for (const d of decisionsRec) {
        if (!prefixes.some((pre) => d.s.graphIri.startsWith(pre)) || inForceAs(d.record) === null) continue;
        const shut = unusable([d.record.payload.planIri]);
        if (shut && !out.includes(shut)) out.push(shut);
      }
      return out;
    };
    /** Graphs whose line was found cut short by an earlier version that does not open (see PodView.line), listed under sealed. */
    const cutLines: Obj[] = [];
    /**
     * Every graph whose current version is usable but whose line does not reach its first version
     * (PodView.line), with why: a write that checks the whole line refuses on it (409), so it is
     * named here whatever its kind, not only where a decision's chain or a grant's grantedAt shows
     * it. `untrustedKey` names the platform key, when a version before was signed by one this bridge
     * no longer trusts.
     */
    const chainCuts: Obj[] = [];
    for (const s of snap.graphs) {
      if (s.g.state !== 'ok') continue;
      const cut = (await call.view.line(s.g)).cut;
      if (!cut) continue;
      chainCuts.push({ graphIri: s.graphIri, why: cut.why, sealed: cut.sealed, ...(cut.untrustedKey !== null ? { untrustedKey: cut.untrustedKey } : {}) });
      if (cut.sealed) cutLines.push({ graphIri: s.graphIri, why: cutWhy(s.graphIri, cut) });
    }
    /** Sections counted from records that cannot all be read, with why (rows say so too where they can). */
    const unreadable: Obj = {};
    /** Tasks whose currentNotPermitted is unknown because a record it is read from cannot be read. */
    const permittedShut: string[] = [];
    const listedTasks = new Set(workflowsRec.flatMap((w) => [...w.record.payload.taskIris, ...w.record.payload.retiredTaskIris]));
    const workflowByIri = new Map(workflowsRec.map((w) => [w.record.entityIri, w.record]));
    const acks = new Map(recordsOf(snap, 'Acknowledgement').map((a) => [`${a.record.payload.planIri}|${a.record.payload.taskIri}|${a.record.payload.personAddress}`, a.record]));

    const out: Obj = {
      podUrl: call.podUrl, complete: snap.complete, status: 'listed', readExposure: readExposureOf(Number(plaintext?.['versions'] ?? 0)), records, demoRecords, demoLabel: demoRecords > 0 ? DEMO_LABEL : null,
      ...(plaintext ? { plaintext } : {}),
      bridge: {
        platform: call.platformRef, admins: admins.size, reads: publicReads ? 'public' : 'signed', recordsSealed: recordKey !== undefined,
        // Sign in with an Interego account: relay-attested, not user-held (see README, "Signing in with an Interego account").
        relayDelegation: relayPolicy === null ? { enabled: false, identityHost, relayUrl: relay?.relayUrl ?? null, retiredRelays: [...retiredRelays] }
          : { enabled: true, trustedRelays: relayPolicy.relayAddresses, retiredRelays: [...retiredRelays], identityHost, relayUrl: relay?.relayUrl ?? null, uiAgentPrefix: UI_AGENT_PREFIX, chatAgentsDecide: relay?.chatAgentsDecide === true, decisiveIntents: [...DECISIVE_INTENTS] },
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
          taskIris: p.taskIris, retiredTaskIris: p.retiredTaskIris,
          ...(p.revision ? { revision: { op: p.revision.op, taskIri: p.revision.taskIri, by: p.revision.by.did, ...(p.revision.repairs ? { repairs: p.revision.repairs } : {}) } } : {}),
          head: headInfo(w.head), demo: w.record.demo === true,
        };
      });
    }
    if (want('tasks')) {
      out['tasks'] = tasksRec.filter((t) => keep(t.record.entityIri, t.record.payload.workflowIri)).map((t) => {
        const p = t.record.payload;
        const cls = classificationByTask.get(t.record.entityIri);
        const clsGraph = unusable(iriForms('classification', p.workflowIri, t.record.entityIri));
        const eff = effective.get(t.record.entityIri);
        const effGrant = effectiveGrant.get(t.record.entityIri);
        // The allocation in force may come from a decision that cannot be read, or from the plan of one that can.
        const allocationShut = [
          ...unreadableDecisions(p.workflowIri).map((g) => graphByIri.get(g)).filter((x): x is SnapGraph => x !== undefined),
          ...unreadablePlansInForce(p.workflowIri),
        ];
        // The workflow says whether it lists this task: when it cannot be read, that is unknown, not "no".
        const wfShut = unusable([p.workflowIri]);
        const clsP = cls?.record.payload;
        // No classification found by tuple, on a pod where classifications are keyed under another record key: unknown, not "not classified".
        const clsUnknown = cls || clsGraph ? null : absenceUnknown('classification');
        // Whether the allocation in force is one the classification allows is read from both: when
        // a decision or plan it may come from, or the classification, cannot be read, it is
        // unknown (null, with why), never worked out from the captured allocation as if that
        // decision were absent. With no classification at all there is nothing to check.
        const permittedUnknown = !(cls || clsGraph || clsUnknown !== null) ? null
          : allocationShut.length > 0 ? `whether the allocation in force is one this task's classification allows is unknown: ${allocationShut.length} decision or plan record(s) it may come from cannot be read (${whysOf(allocationShut)})`
            : clsGraph && !cls ? `whether the allocation in force is one this task's classification allows is unknown: the classification cannot be read (${whyUnusable(clsGraph)})`
              : clsUnknown !== null ? `whether the allocation in force is one this task's classification allows is unknown: ${clsUnknown}` : null;
        if (permittedUnknown !== null) permittedShut.push(t.record.entityIri);
        const currentNote = clsP && permittedUnknown === null ? currentAllocationNote(eff?.allocation ?? p.current, clsP.regime, clsP.answers, policy, eff ? 'decision' : 'captured') : null;
        const owed = p.owedRatification ?? [];
        const reviewed = runsRec.filter((r) => r.record.status === 'reviewed' && r.record.payload.taskIri === t.record.entityIri);
        const reworked = reviewed.filter((r) => r.record.payload.review?.verdict !== 'accepted').length;
        const critical = reviewed.filter((r) => r.record.payload.review?.verdict === 'critical-failure').length;
        const share = reviewed.length > 0 ? reworked / reviewed.length : 0;
        const suggest = (reviewed.length >= policy.grantPolicy.contraryMinRuns && share > policy.grantPolicy.contraryReworkShare) || critical > 0;
        // A run that cannot be read may be a reviewed run on this task: the counts are of the runs
        // that open, and a suggestion only a run that opens can settle (a critical failure) stands.
        const runsShut = contraryShut;
        return {
          taskIri: t.record.entityIri, workflowIri: p.workflowIri, name: p.name, description: p.description, textSha256: p.textSha256, current: p.current, performer: p.performer,
          namedParties: p.namedParties.map((a) => {
            const r = p.ratifications.find((x) => x.party === a);
            return { address: a, kind: isAgent(reg, a) ? 'agent' : isPerson(reg, a) ? 'person' : 'unregistered', label: label(a), ratification: r ? { verdict: r.verdict, ...(r.note ? { note: r.note } : {}), at: r.at } : null };
          }),
          // People a revision removed from the task, whose ratification it still needs.
          owedRatification: owed.map((a) => {
            const r = p.ratifications.find((x) => x.party === a);
            return { address: a, label: label(a), ratification: r ? { verdict: r.verdict, ...(r.note ? { note: r.note } : {}), at: r.at } : null };
          }),
          taskKind: p.taskKind, taskKindDefinition: p.taskKindDefinition, ...(p.externalTaskTerm ? { externalTaskTerm: p.externalTaskTerm } : {}),
          effective: {
            ...(eff
              ? {
                ...eff.allocation, source: eff.source, decisionIri: eff.decisionIri,
                ...(effGrant ? {
                  grant: effGrant, suspended: effGrant.active === false,
                  ...(effGrant.active === false ? { suspendedWhy: `grant ${effGrant.why ?? 'inactive'}: ${SUSPENDED}` } : {}),
                  ...(effGrant.active === null ? { unreadable: `the grant this work is under cannot be read: ${effGrant.why ?? ''}` } : {}),
                } : {}),
              }
              : { ...p.current, source: 'captured' }),
            // A decision on this workflow, or the plan of one in force, that cannot be read may have changed the allocation: never shown as certain.
            ...(allocationShut.length > 0 && !(effGrant?.active === null)
              ? { unreadable: `${allocationShut.length} decision or plan record(s) the allocation in force may come from cannot be read (${whysOf(allocationShut)}), so the allocation in force may differ from this one` }
              : {}),
          },
          currentNotPermitted: currentNote, ...(permittedUnknown !== null ? { currentNotPermittedUnreadable: permittedUnknown } : {}),
          status: t.record.status, quoteStatus: p.quoteStatus, quotes: p.quotes, ...(p.revision ? { revision: { note: p.revision.note ?? null, answers: p.revision.answers, quotesCleared: p.revision.quotesCleared, by: p.revision.by.did } } : {}),
          ...(p.retirement ? { retirement: { why: p.retirement.why, at: p.retirement.at, by: p.retirement.by.did } } : {}),
          // Both answered from the task's workflow: null (with why) when that cannot be read.
          orphaned: wfShut ? null : !listedTasks.has(t.record.entityIri),
          // Retired, but the workflow still lists it: retiring it again finishes the retirement.
          retirementUnfinished: wfShut ? null : retirementUnfinished(t.record, workflowByIri.get(p.workflowIri)),
          ...(wfShut ? { workflowUnreadable: `whether the workflow lists this task is unknown: ${whyUnusable(wfShut)}` } : {}),
          classification: cls ? {
            regime: cls.record.payload.regime, method: cls.record.payload.method, rulesFired: cls.record.payload.rulesFired, notes: cls.record.payload.notes,
            answers: cls.record.payload.answers,
            answeredBy: { did: cls.record.payload.answeredBy.did, address: cls.record.payload.answeredBy.address, personRef: cls.record.payload.answeredBy.personRef, role: cls.record.payload.answeredBy.role },
            status: cls.record.status, current: cls.record.payload.taskTextSha256 === p.textSha256,
            ratifications: cls.record.payload.ratifications.map((r) => ({ party: r.party, verdict: r.verdict, ...(r.note ? { note: r.note } : {}), at: r.at })),
            disagreement: cls.record.payload.ratifications.filter((r) => r.answers).map((r) => ({ party: r.party, answers: r.answers })),
            contraryEvidence: reviewed.length > 0 || runsShut !== null ? {
              reviewedRuns: reviewed.length, reworkedShare: Math.round(share * 10_000) / 10_000, criticalFailures: critical,
              suggestReclassify: runsShut === null ? suggest : critical > 0 ? true : null, note: CONTRARY_NOTE, ...(runsShut !== null ? { unreadable: runsShut } : {}),
            } : null,
            state: 'ok', trusted: true, head: headInfo(cls.head), demo: cls.record.demo === true,
          } : clsGraph && (clsGraph.g.state === 'altered' || clsGraph.g.state === 'forked') ? {
            state: clsGraph.g.state, trusted: false,
            heads: clsGraph.g.heads.map((h) => ({ descriptorUrl: h.descriptorUrl, contentBinding: h.authorship.contentBinding, why: h.why })),
          } : clsUnknown !== null ? { state: 'unreadable', trusted: false, unreadable: `whether this task is classified is unknown: ${clsUnknown}` } : null,
          link: taskLink(t.record.entityIri), head: headInfo(t.head), demo: t.record.demo === true,
        };
      });
      if (permittedShut.length > 0) {
        unreadable['currentNotPermitted'] = `${permittedShut.length} task(s) have currentNotPermitted null because a decision, plan or classification it is read from cannot be read: whether their allocation in force is one their classification allows is unknown (each says why under currentNotPermittedUnreadable: WRD_RECORD_KEY when one is sealed)`;
      }
    }
    if (want('plans')) {
      const out2: Obj[] = [];
      for (const pl of plansRec) {
        const p = pl.record.payload;
        if (!keep(pl.record.entityIri, p.workflowIri)) continue;
        let stale: string | null = null;
        const wf = workflowsRec.find((w) => w.record.entityIri === p.workflowIri);
        // Staleness is read from the workflow, each task and its classification. A record that
        // cannot be read (sealed shut, altered or forked) is not absent: nothing is concluded from
        // it, and when the records that can be read do not show the plan stale, whether it is
        // stale is unknown: `stale` is null and `unreadable` says why.
        const shut: string[] = [];
        const wfShut = unusable([p.workflowIri]);
        if (wfShut) shut.push(whyUnusable(wfShut));
        for (const row of p.tasks) {
          const tShut = unusable([row.taskIri]);
          const cGraph = unusable(iriForms('classification', p.workflowIri, row.taskIri));
          const t = tasksRec.find((x) => x.record.entityIri === row.taskIri);
          const c = classificationByTask.get(row.taskIri);
          // The classification is found by tuple: not found where classifications are keyed under another record key, it is unknown, not absent.
          const cShut = cGraph ? whyUnusable(cGraph) : c ? null : absenceUnknown('classification');
          if (tShut) shut.push(whyUnusable(tShut));
          if (cShut !== null) shut.push(cShut);
          if (row.changed && (t?.record.status === 'retired' || (wf && !wf.record.payload.taskIris.includes(row.taskIri)))) { stale = RETIRED_IN_PLAN; break; }
          if (tShut) continue;
          if (!t || t.record.payload.textSha256 !== p.taskTextSha256[row.taskIri]) { stale = STALE_PLAN; break; }
          if (cShut !== null) continue;
          if (!c || c.head.descriptorUrl !== p.classificationHeads[row.taskIri]) { stale = STALE_PLAN; break; }
        }
        const assignments = p.tasks.filter((r) => r.changed && r.proposed.personAddress).map((r) => {
          const a = acks.get(`${pl.record.entityIri}|${r.taskIri}|${r.proposed.personAddress ?? ''}`);
          // An acknowledgement that exists and cannot be read is not "not acknowledged".
          const shutGraph = a ? undefined : unusable(iriForms('acknowledgement', ...ackTuple(pl.record.entityIri, r.taskIri, r.proposed.personAddress ?? '')));
          // Found by tuple: where acknowledgements are keyed under another record key, one not found is unknown, not "not acknowledged".
          const shut = shutGraph ? unusableWhy(shutGraph.g) : a ? null : absenceUnknown('acknowledgement');
          if (shut !== null) return { taskIri: r.taskIri, personAddress: r.proposed.personAddress, state: 'unreadable', label: `${UNREADABLE_ACK}: ${shut}` };
          const state = a ? a.status : 'not-acknowledged';
          return { taskIri: r.taskIri, personAddress: r.proposed.personAddress, state, ...(a?.payload.note ? { note: a.payload.note } : {}), label: state === 'acknowledged' ? ACKNOWLEDGED : state === 'objected' ? OBJECTED : UNACKNOWLEDGED };
        });
        out2.push({
          planIri: pl.record.entityIri, workflowIri: p.workflowIri, title: p.title, planKind: p.planKind, tasks: p.tasks, proposedBy: p.proposedBy.did, stale,
          ...(stale === null && shut.length > 0 ? { unreadable: `whether this plan is stale is unknown: ${shut.length} record(s) it was proposed against cannot be read (${shut.join('; ')})` } : {}),
          assignments, head: headInfo(pl.head), demo: pl.record.demo === true,
        });
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
        const line = await call.view.line(d.s.g);
        const chain = line.versions.map((l) => ({
          version: l.record?.version ?? null, status: l.record?.status ?? null, modalStatus: l.modalStatus, signedBy: l.record?.signers.map((s) => s.did) ?? [],
          at: l.generatedAt, descriptorUrl: l.descriptorUrl, recordId: l.recordId, graphDigest: l.graphDigest,
        }));
        // A chain that does not reach its first version says so: never shown as the whole chain. A sealed version is also listed under sealed.
        const chainCut = line.cut ? cutWhy(d.s.graphIri, line.cut) : null;
        out3.push({
          decisionIri: d.record.entityIri, decisionKind: p.decisionKind, planIri: p.planIri, ...(p.valuationIri ? { valuationIri: p.valuationIri, valuationHash: p.valuationHash } : {}),
          status: d.record.status, statusLabel: statusLabelOf(d.record.status, p.decisionKind), decisionLevel: p.decisionLevel,
          ...(p.prediction ? { prediction: p.prediction } : {}), ...(p.freedHours ? { freedHours: p.freedHours } : {}),
          ...(p.measurementPlan ? { measurementPlan: p.measurementPlan, basisLabel: p.basisLabel } : {}),
          subjects: p.subjects, assignments: p.assignments, submittedBy: { did: p.submittedBy.did, personRef: p.submittedBy.personRef },
          ...(p.preparedBy ? { preparedBy: p.preparedBy } : {}),
          ...(p.countersign ? { countersign: { verdict: p.countersign.verdict, did: p.countersign.did, personRef: p.countersign.personRef, objectionsConsidered: p.countersign.objectionsConsidered, unacknowledgedConsidered: p.countersign.unacknowledgedConsidered ?? [], assignmentsAtCountersign: p.countersign.assignmentsAtCountersign, at: p.countersign.at } } : {}),
          ...(p.outcome ? { outcome: { did: p.outcome.did, personRef: p.outcome.personRef, disposition: p.outcome.disposition, ...(p.outcome.dispositionNote ? { dispositionNote: p.outcome.dispositionNote } : {}), at: p.outcome.at, ...(p.outcome.valued ? { valued: p.outcome.valued } : {}), ...(p.outcome.probes ? { probes: p.outcome.probes } : {}) } } : {}),
          ...(p.probes ? { probes: p.probes } : {}),
          ...(p.outcome?.probes?.some((x) => x.signal !== 'neither') ? { next: NEXT_RECLASSIFY } : {}),
          grantChecks: p.grantChecks, chain, ...(chainCut !== null ? { chainUnreadable: `the chain below is incomplete: ${chainCut}` } : {}),
          head: headInfo(d.head), demo: d.record.demo === true,
        });
      }
      out['decisions'] = out3;
    }
    if (want('grants')) {
      const out4: Obj[] = [];
      for (const gr of recordsOf(snap, 'Grant')) {
        const p = gr.record.payload;
        if (subject !== null && subject !== gr.record.entityIri) continue;
        const state = await grantView(call, reg, p.agentAddress, p.taskKind);
        const line = await call.view.line(gr.s.g);
        const grantedAt = [...line.versions].reverse().find((l) => l.record?.status === 'granted')?.generatedAt ?? null;
        const chainCut = line.cut ? cutWhy(gr.s.graphIri, line.cut) : null;
        out4.push({
          grantIri: gr.record.entityIri, agentAddress: p.agentAddress, principal: p.principal, model: p.model, taskKind: p.taskKind, status: gr.record.status,
          active: state.active, why: state.why, evaluation: p.evaluation, evidenceTaskIris: p.evaluation.taskIris, grantedAt,
          // grantedAt is read from the versions that open: with an earlier one that does not, it may be missing or not the first.
          ...(chainCut !== null ? { chainUnreadable: `grantedAt may be missing: ${chainCut}` } : {}),
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
        if (r.record.status === 'reviewed' && p.costPerRun && (a.currency === null || a.currency === p.costPerRun.currency)) { a.costs.push(p.costPerRun.amount); a.currency = p.costPerRun.currency; }
        agg.set(k, a);
        if (r.record.status === 'acted-under-grant') awaiting.push({ runIri: r.record.entityIri, agentAddress: p.agentAddress, taskIri: p.taskIri, taskKind: p.taskKind, runEnvelope: p.runEnvelope, demo: r.record.demo === true });
      }
      // A run that cannot be read belongs to an agent and kind of task this bridge cannot see: every row, and the section, says so.
      const shut = runsUnreadable('runs');
      out['runs'] = [...agg.values()].map((a) => ({
        agentAddress: a.agentAddress, taskKind: a.taskKind, model: a.model, reviewed: a.reviewed, actedUnderGrant: a.actedUnderGrant,
        ...(a.costs.length > 0 ? { reportedCost: { runs: a.costs.length, mean: a.costs.reduce((x, y) => x + y, 0) / a.costs.length, currency: a.currency, basis: REPORTED_COST_BASIS } } : {}),
        ...(shut !== null ? { unreadable: shut } : {}),
      }));
      out['awaitingReview'] = awaiting;
      if (shut !== null) unreadable['runs'] = shut;
      const awaitingShut = runsUnreadable('awaitingReview');
      if (awaitingShut !== null) unreadable['awaitingReview'] = awaitingShut;
    }
    out['untrusted'] = [
      ...snap.graphs.flatMap((s) => s.g.untrusted),
      ...snap.foreign.map((e) => ({ descriptorUrl: e.descriptorUrl, why: 'it is outside this pod\'s wrd/records/ container (for example a holder copy)' })),
    ];
    out['forked'] = snap.graphs.filter((s) => s.g.state === 'forked').map((s) => s.graphIri);
    // Current versions that do not open, then earlier ones this answer met in a line it walked.
    const sealed = [...sealedOf(snap), ...cutLines];
    out['sealed'] = sealed;
    if (sealed.length > 0) out['sealedNote'] = SEALED_RECORDS;
    // contraryEvidence is per task, marked on each row; the section-level mark says it once for the whole list.
    if (contraryShut !== null) unreadable['contraryEvidence'] = contraryShut;
    if (Object.keys(unreadable).length > 0) out['unreadable'] = unreadable;
    if (conflict) out['recordKeyMismatch'] = keyConflictNote(conflict);
    out['altered'] = snap.graphs.filter((s) => s.g.state === 'altered').map((s) => s.graphIri);
    out['chainCuts'] = chainCuts;
    out['integrity'] = snap.graphs.filter((s) => s.g.state === 'altered' || s.g.state === 'forked').map((s) => ({
      graphIri: s.graphIri, state: s.g.state, why: s.g.why,
      heads: s.g.heads.map((h) => ({ descriptorUrl: h.descriptorUrl, trusted: h.authorship.trusted, contentBinding: h.authorship.contentBinding, why: h.why })),
    }));
    return out;
  }

  async function calibrate(call: Call, args: Obj): Promise<Obj> {
    const kind = kindArg(args);
    const reg = await registryForRead(call);
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
          submittedAt: typeof issued === 'string' ? issued : o.at, measuredAt: o.at, demo: demoRecord, shortWindow: o.valued.windowShorterThanPlanned === true,
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
      currentModelOf: (did) => memberOf(reg, principalOfDid(did))?.model ?? null,
    });
    // Cells are computed from the records that open. A decision or run that does not open (its
    // kind is public in its IRI, its metric, level, agent and kind of task are not) may belong to
    // any cell: every cell of its section, and the section, is marked, never counted as if absent.
    const marks = {
      predictionCells: countedWithout(snap, ['decision'], 'predictionCells'),
      probeSignals: countedWithout(snap, ['decision'], 'probeSignals'),
      agentCells: countedWithout(snap, ['run'], 'agentCells'),
      awaitingAPerson: countedWithout(snap, ['run'], 'awaitingAPerson'),
    };
    const mark = (why: string | null): Obj => (why === null ? {} : { unreadable: why });
    const agentCells: Obj[] = [];
    for (const c of report.agentCells) {
      const address = principalOfDid(c.agentDid);
      agentCells.push({ ...c, agentAddress: address, principal: memberOf(reg, address)?.principal ?? null, grant: await grantView(call, reg, address, c.taskKind), ...mark(marks.agentCells) });
    }
    const demoRecords = snap.graphs.filter((s) => s.record?.demo === true).length;
    const sealed = sealedOf(snap);
    const wanted: Readonly<Record<keyof typeof marks, boolean>> = {
      predictionCells: kind === null || kind === 'predictions', probeSignals: kind === null || kind === 'probes', agentCells: kind === null || kind === 'agents', awaitingAPerson: true,
    };
    const unreadable = Object.fromEntries(Object.entries(marks).filter(([k, why]) => why !== null && wanted[k as keyof typeof marks]));
    const conflict = await keyConflict(call);
    return {
      podUrl: call.podUrl, complete: snap.complete, status: 'calibrated', computed: true, minSamples: report.minSamples, nominalBandCoverage: report.nominalBandCoverage,
      demoRecords, demoLabel: demoRecords > 0 ? DEMO_LABEL : null, sealed, ...(sealed.length > 0 ? { sealedNote: SEALED_RECORDS } : {}),
      ...(Object.keys(unreadable).length > 0 ? { unreadable } : {}), ...(conflict ? { recordKeyMismatch: keyConflictNote(conflict) } : {}),
      ...(wanted.predictionCells ? { predictionCells: report.predictionCells.map((c) => ({ ...c, ...mark(marks.predictionCells) })) } : {}),
      ...(wanted.agentCells ? { agentCells } : {}),
      ...(wanted.probeSignals ? { probeSignals: { ...report.probeSignals, ...mark(marks.probeSignals) } } : {}),
      awaitingAPerson: awaiting, grantPolicy: policy, podPolicy: reg.podPolicy,
    };
  }

  if (demo) {
    handlers['wrd.demo_envelope'] = async (args) => {
      const id = args['persona'];
      // Without a persona: who the demo can sign as, so a page can sign its first read.
      if (id === undefined || id === null || id === '') {
        return { personas: [...demo.values()].map((d) => ({ id: d.id, label: d.label, address: lower(d.wallet.address) })), demoKey: true, scriptedLabel: DEMO_LABEL, status: 'listed' };
      }
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

  if (demo) {
    const advance = deps.demoClockAdvance;
    handlers['wrd.demo_advance_clock'] = async (args) => {
      if (!advance) return { ...refuse(501, 'This demo composition has no scripted clock to move.', 'it reads the real clock; only the offline demo server moves its own') };
      const weeks = Number(args['weeks']);
      if (!Number.isInteger(weeks) || weeks < 1 || weeks > 104) return { ...refuse(400, BAD_PAYLOAD, 'weeks must be a whole number from 1 to 104') };
      advance(weeks * 7 * 86_400_000);
      return { now: clock().toISOString(), movedWeeks: weeks, scriptedLabel: DEMO_LABEL, status: 'advanced', moved: true };
    };
  }

  const out: Record<string, WrdHandler> = {};
  for (const [name, fn] of Object.entries(handlers)) {
    out[name] = async (args) => {
      // Text that is not well-formed UTF-16 (a lone surrogate) cannot be signed, hashed, sealed or
      // stored as what was sent: refused before any work, so it never reaches a seal or the pod.
      const ill = illFormedTextPath(args, 'arguments');
      if (ill !== null) return refuse(400, NOT_WELL_FORMED, `${ill} holds a lone UTF-16 surrogate; nothing was read or written`);
      let result: unknown;
      try {
        result = await fn(args);
      } catch (e) {
        result = failureOf(e);
      }
      return withExpectedPayload(name, result);
    };
  }
  return out;
}

const INTENTS_OF_TOOL = new Map<string, EnvelopeIntent[]>();
for (const [intent, tool] of Object.entries(TOOL_OF_INTENT) as Array<[EnvelopeIntent, string]>) INTENTS_OF_TOOL.set(tool, [...(INTENTS_OF_TOOL.get(tool) ?? []), intent]);
// The one intent sent to two tools: a signed read reads the records or their calibration.
INTENTS_OF_TOOL.set('wrd.read_calibration', ['wrd:read-records']);

/**
 * A malformed payload is answered with the whole shape it should have had, not only the first
 * field that was wrong: the refusal carries `expectedPayload` (the intent's JSON Schema) and
 * points at wrd.envelope_template.
 */
function withExpectedPayload(toolName: string, result: unknown): unknown {
  if (!isObj(result) || result['kind'] !== 'refusal' || result['iep:refusalStatus'] !== 400) return result;
  if (!/malformed/i.test(String(result['error'] ?? ''))) return result;
  const intents = INTENTS_OF_TOOL.get(toolName);
  if (!intents || intents.length === 0) return result;
  const reason = String(result['iep:refusalReason'] ?? '');
  const intent = intents.length > 1 && /^review/.test(reason) ? intents.find((i) => i === 'wrd:review-agent-run') ?? intents[0] : intents[0];
  if (!intent) return result;
  return {
    ...result, expectedPayload: payloadSchema(intent),
    ...(result['iep:resolvedBy'] === undefined ? { 'iep:resolvedBy': { action: 'urn:iep:action:wrd:envelope-template', toolName: 'wrd.envelope_template', intent } } : {}),
  };
}

/** The status a failure deserves, as a typed refusal. Unexpected failures are the bridge's (500), never the caller's. */
function failureOf(e: unknown): BridgeRefusal {
  if (e instanceof Declined) return e.refusal;
  if (e instanceof StaleHeadError) return refuse(409, 'The record changed since it was read; read it again and retry.', e.message, via('read_records'));
  if (e instanceof IncompleteManifestError) return refuse(502, "The pod's manifest could not be read in full; nothing was written.", e.message);
  if (e instanceof PodWriteError) return refuse(502, e.status === null ? 'The pod did not accept the write.' : `The pod answered ${e.status} to the write.`, e.message);
  if (e instanceof PodReadError) return refuse(502, e.status === null ? 'The pod could not be read.' : `The pod answered ${e.status} to a read.`, e.message);
  // Sealing happens in this process: its failure is the bridge's, never reported as the pod's.
  if (e instanceof RecordNotSealableError) return refuse(500, 'The bridge could not seal this record; nothing was written.', e.message);
  if (e instanceof PublishShapeViolationError) {
    return refuse(500, 'The bridge built a record its own shapes refuse; nothing was written.', `${e.message}: ${e.violations.map((v) => v.message).join('; ')}`);
  }
  return refuse(500, 'The bridge failed while handling this call.', messageOf(e));
}
