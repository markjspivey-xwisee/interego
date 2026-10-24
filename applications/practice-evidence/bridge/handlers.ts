/**
 * The practice-evidence handlers: one per affordance, built by `createPevHandlers(deps)`.
 *
 * Nothing here reads the environment. `bridge/server.ts` composes these with a platform key, a
 * pod transport and (optionally) a text model; tests inject an in-memory pod, generated wallets
 * and scripted or doubled models.
 *
 * ── ONE ORDER FOR EVERY ACT (§6.2) ──────────────────────────────────────────────────────────
 *   1. the signed envelope and every payload check that needs no record   → 401 / 400
 *   2. the pod: named in the signed payload and served (from the URL
 *      alone, before its name is resolved), then public                   → 403 / 400;
 *      its records under no record key but this bridge's (key marks), read
 *      from the manifest before any record, the role registry included     → 409
 *   3. the nonce (writes): a signed envelope acts once                   → 409
 *   4. a lock on the one graph the act changes
 *   5. the head record, read back from the pod and checked (trust rule)  → 404 / 409
 *   6. who the signer is, against the record and the role registry       → 403
 *   7. the record's state                                               → 409
 *   8. payload checks that need the record                              → 400 / 409
 *   9. the model call, when the act has one (bounded by its timeouts)    → 400 / 502 / 503
 *  10. the next body, built by pure functions in src/
 *  11. a fresh read of the chain's heads: someone else moved it         → 409
 *  12. the platform signs the exact graph; the descriptor is validated; the publish is a
 *      compare-and-set behind the shapes gate.
 * Every read an act can be refused on (the head, the role registry, the scenario chain an answer
 * rests on) comes before step 12, and nothing after it can refuse: a refused act wrote nothing.
 *
 * Identity is ONLY what a signature proves (DECISIONS #1): the address recovered from a key the
 * person holds, or, for a request the Interego relay signed with a delegation key this bridge
 * trusts (`deps.relayDelegation`), the principal the verifier names (the agent's controller on the
 * identity host, a user DID). That second route is relay-attested, not user-held, and every
 * record made through it says so. Everywhere identity matters (admins, roles, separation of
 * duties, the replay ledger, budgets, attempt keys, the actor stored on records) the principal is
 * the identity, compared by `principalKey`: an address never matches a DID. No input names a
 * person, a provenance, a modal status or a key — except a per-request model key (BYOK), which is
 * used for one call and never stored or echoed.
 *
 * A caller's mistake is never thrown at the dispatcher: every decline is a `refuse(…)` with its
 * status. Internally a decline travels as a thrown `Declined` and is turned back into the
 * returned refusal at the handler boundary; a thrown plain Error is a defect in this code.
 */
import {
  assertSafeFetchTarget, canonicalGraphDigestResult, sha256, validate,
  type EncryptionKeyPair, type ManifestEntry, type Wallet,
} from '@interego/core';
import { predictManifestUrl, PublishPreconditionFailedError, PublishShapeViolationError } from '@interego/solid';
import type { AffordanceHandler } from '../../_shared/vertical-bridge/index.js';
import { refuse } from '../../_shared/vertical-bridge/refusal.js';
import {
  attemptedDisclosure, disclosureOf, resolveTextModel, TextModelCallFailed,
  COUNTERPART_TIMEOUTS, DRAFT_TIMEOUTS, JUDGE_TIMEOUTS,
  type InferenceDisclosure, type TextModel, type TextModelRequest, type TextModelResult,
} from '../src/model.js';
import { isPevAction, PEV_ACTION, type PevActionKey } from '../src/ontology.js';
import { agentSlugOf, isUserDid, openRelayDelegated, type RelayDelegationPolicy } from '../src/relay-delegated.js';
import {
  agreementOf, assembleJudgment, assess, coerceJudgment, coerceScenario, counterpartControl, counterpartPacket,
  counterpartRequest, creditedLevels, criterionContentHash, draftComparableHash, draftPacket, draftRequest,
  judgePacket, judgeRequest, learnerTurnCount, nextLevelGuidance, normaliseForQuote, parseDraftText, parseJudgeText,
  rubricHash, scenarioHash, splitEndSignal, transcriptHash,
  draftReviewNote, BRIEF_MAX, COUNTERPART_PROMPT_TEMPLATE_HASH, DRAFT_PROMPT_TEMPLATE_HASH, JUDGE_PROMPT_TEMPLATE_HASH,
  MAX_CONTESTS, MAX_JUDGMENTS, PRACTICE_LABEL, PROVISIONAL_LABEL, SOURCE_TEXT_MAX, TURN_TEXT_MAX,
  type JudgeChosenBy, type JudgmentResult, type NextLevelGuidance, type ScenarioSpec, type Turn,
} from '../src/practice.js';
import {
  actorOf, applyRoleChange, attemptIri as attemptIriOf, attemptIriSecret, attemptKey, buildRecordDescriptor, checkEnvelope, checkRelayPayload, conflictedReviewersOf,
  didOf, freshNonce, graphIriOf, iriKeyFingerprint, isAddress, isPrincipal, isWellFormedText, judgeSignersOf, modalFor, modelAgentIri, nextActionsFor, nextActionView,
  NonceLedger, podBase, principalDid, principalKey, projectionIri, recordGraphTurtle, recordIdFor, recordLocal, recordSalt, redactBody, registryIri,
  relayDelegatedEnvelope, reverifyStoredEnvelope, rubricIriOf, samePrincipal, scenarioIri as scenarioIriOf, signDraftReceipt, signEnvelope,
  signedRequestOf, signedRequestSigner, slugFor, standingReview, toWellFormedText, verifyDraftReceipt,
  EXPORT_VERIFY_STEPS, REDACTION_NOTE, ROLES,
  type Actor, type AttemptAct, type AttemptBody, type DescriptorPlan, type DraftAssistance, type EnvelopeForm, type EnvelopeOk,
  type FinalLevel, type KeyKind, type NextAction, type PevRecordBody, type ProjectionAuditBody, type RecordTarget,
  type RecentEnvelope, type Redaction, type RelayAttestation, type Reopening, type ReviewResult, type Role, type RoleRegistryBody, type ScenarioBody,
  type ScenarioStatus, type StoredEnvelope,
} from '../src/records.js';
import {
  auditCoverageOf, calibrationCells, outcomeRowsOf, reviewQueue, scenarioResults, suppressSmallCells,
  AUDIT_SAMPLE_RATE, CALIBRATION_SMALL_COUNT_RULE, METRIC_NOTE, RESULTS_K, STANDING_POLICY,
  type CalibrationCellView, type QueueCandidate,
} from '../src/calibration.js';
import { buildStatement, statementProblems, LOSSY, LRS_REQUEST_NOTE, PROJECTION_FORMATS, type ProjectionFormat } from '../src/projections.js';
import {
  createGraphLocks, deleteResource, isDeleted, isTrusted, keyMarksOf, listEntries, normalPod, placementProblem, podEntries, publishPevRecord,
  readCache, readChain, readHead, readHeadsOfKind, readRecord, readRoleRegistry, readRoleRegistryAt, refreshHeads, signRecordAuthorship,
  underPod, withReadBudget,
  ChainForked, GraphMissing, PodTransportFailed, ReadBudget, ReadBudgetSpent, RecordNotSealable, RecordSealed, RecordUnreadable, VerifiedRecords,
  ACT_READ_BUDGET_BYTES, PEV_COPIES_CONTAINER, RECORD_CACHE_MAX_BYTES, RECORD_CACHE_TTL_MS,
  type DeletedVersion, type KeyMark, type ReadCache, type ReadRecord, type RoleRegistryView, type TrustedPlatform,
} from './pod-helpers.js';

// ═════════════════════════════════════════════════════════════════════════════════════════════
//  Dependencies
// ═════════════════════════════════════════════════════════════════════════════════════════════

export type DemoRoleName = 'admin' | 'author' | 'reviewer' | 'second-reviewer' | 'learner' | 'second-learner' | 'judge-agent';
export const DEMO_ROLE_NAMES: readonly DemoRoleName[] = ['admin', 'author', 'reviewer', 'second-reviewer', 'learner', 'second-learner', 'judge-agent'];

/** Role keys this bridge holds for a local demo. Acts they sign are recorded as such. */
export interface DemoSigner { readonly roles: readonly { readonly role: DemoRoleName; readonly label: string; readonly wallet: Wallet }[] }

type Timeouts = { readonly timeoutMs: number; readonly budgetMs: number };

export interface PevDeps {
  /** Signs every record's authorship proof and every draft receipt. Required. */
  readonly platformWallet: Wallet;
  readonly platformKeyKind: KeyKind;
  /** Earlier platform addresses whose records stay trusted (never keys). */
  readonly trustedPlatformAddresses?: readonly string[];
  /**
   * The key pair this bridge seals its operator-pod records to (server.ts derives it from
   * PEV_RECORD_KEY). Absent: records are written in plaintext. Plaintext records stay readable
   * either way; a sealed record is readable only with the key it was sealed to. Holder copies are
   * never sealed: the learner does not hold this key.
   */
  readonly recordKey?: EncryptionKeyPair;
  /** Addresses that may change roles and retract a review. */
  readonly adminAddresses?: readonly string[];
  /**
   * People who may change roles and retract a review when they sign in with their Interego
   * account: `did:web:<identity host>:users:<id>` principals (server.ts reads PEV_ADMIN_DIDS).
   * Anything else is ignored; they count only with `relayDelegation`.
   */
  readonly adminDids?: readonly string[];
  /**
   * Interego sign-in: requests the relay signed (its `sign_request`, as `act … sign_payload:true`
   * posts them) are read as the person whose agent the relay signed for, when the signature
   * recovers to one of `relayAddresses` (server.ts reads PEV_TRUSTED_RELAY_ADDRESSES and
   * PEV_IDENTITY_HOST, and passes an SSRF-guarded, size-capped, cached DID-document fetch). An
   * empty `relayAddresses` disables the route; the identity host still says which user DIDs a role
   * may be given to. Absent: no request is read as relay-delegated and no DID can hold a role.
   * Relay-attested, not user-held: whoever holds a listed relay key, or controls the identity
   * host, can act as any person here.
   */
  readonly relayDelegation?: RelayDelegationPolicy;
  /**
   * Whether a chat agent signed in through the relay (any agent whose slug does not start with
   * `practice-evidence-`, this bridge's own web UI) may take the decisive acts (`DECISIVE_ACTS`:
   * register_role, ratify_scenario, countersign_attempt, override_attempt, retract_review) and
   * redact_attempt on another learner's attempt. Default false (PEV_CHAT_AGENTS_DECIDE=1 sets it).
   */
  readonly chatAgentsDecide?: boolean;
  /** The relay a person signs in through (PEV_RELAY_URL), reported to the web UI with the sign-in route. */
  readonly relayUrl?: string;
  /** Operator pod transport. server.ts passes operatorWriteFetch(…); tests pass an in-memory pod. */
  readonly fetchFn?: typeof fetch;
  /** Holder-copy writes. Never carries the operator's credential. Defaults to `fetchFn`. */
  readonly holderFetchFn?: typeof fetch;
  readonly defaultPodUrl?: string;
  /**
   * Pods this bridge reads and writes records on. Default: [defaultPodUrl] when set, else none.
   * '*' (an explicit choice) is any public pod: then nothing but the trust rule stops records
   * being read from, or written to, a pod the operator does not run.
   */
  readonly servedPods?: readonly string[] | '*';
  /** xAPI account.homePage. */
  readonly deploymentUrl?: string;
  /** This bridge's own model route; absent = no model route. */
  readonly model?: TextModel;
  /** fetch for per-request BYOK model calls. */
  readonly byokFetch?: typeof fetch;
  readonly modelTimeouts?: { readonly counterpart?: Timeouts; readonly judge?: Timeouts; readonly draft?: Timeouts };
  readonly now?: () => Date;
  readonly nonce?: () => string;
  readonly envelopeMaxAgeMs?: number;
  readonly resultsK?: number;
  readonly demoSigner?: DemoSigner;
  /**
   * Who may make this bridge's own model (its operator's key) speak or judge. 'anyone' (the
   * default here) is any signer; 'registered' is a signer holding any role on the pod (an admin
   * can register learners). A per-request key and the packet routes stay open either way.
   */
  readonly bridgeModelFor?: 'anyone' | 'registered';
  /** Per-hour limits held in this process: model calls on the operator's key, and attempts started. */
  readonly budgets?: { readonly modelCallsPerHour?: HourlyLimit; readonly attemptsPerHour?: HourlyLimit };
  /**
   * How long a record read from the pod and found trusted where it sits is reused by later acts
   * without reading it again (ms, default RECORD_CACHE_TTL_MS; 0 reuses nothing). Where it sits is
   * checked again on every read; see `VerifiedRecords`.
   */
  readonly recordCacheMs?: number;
  /** The monotonic clock (ms) that record keep times are measured on (default performance.now). */
  readonly recordCacheClock?: () => number;
  /** What one act may read from pods in all (bytes, default ACT_READ_BUDGET_BYTES). */
  readonly actReadBudgetBytes?: number;
  /**
   * How a pod URL is checked to be a public http(s) address before anything is fetched from it
   * (its DNS name resolved). Default `assertSafeFetchTarget`. It is called only for a pod this
   * bridge serves (or a holder pod it is asked to copy to), never for one it does not serve.
   */
  readonly assertPublicPod?: (podUrl: string) => Promise<void>;
}

/** A per-hour limit for one signer and for everyone together. */
export interface HourlyLimit { readonly perSigner: number; readonly total: number }
export const DEFAULT_BUDGETS: { readonly modelCallsPerHour: HourlyLimit; readonly attemptsPerHour: HourlyLimit } = {
  modelCallsPerHour: { perSigner: 120, total: 2000 },
  attemptsPerHour: { perSigner: 20, total: 500 },
};

const HOUR_MS = 3_600_000;

/**
 * A sliding one-hour window of uses, per principal and in total. Per principal means per person:
 * a relay-delegated act counts against the person it is for, never against the relay address,
 * which signs for everyone. It lives in this process: a restart or a second replica starts its
 * own count, which the README says.
 */
class HourlyBudget {
  private readonly bySigner = new Map<string, number[]>();
  private all: number[] = [];
  constructor(readonly limit: HourlyLimit) {}

  /** Take one use now, or say who ran out and when one frees up. */
  take(signer: string, now: number): { readonly ok: true } | { readonly ok: false; readonly scope: 'signer' | 'total'; readonly retryAfterSeconds: number } {
    const since = now - HOUR_MS;
    this.all = this.all.filter((t) => t > since);
    for (const [k, ts] of this.bySigner) {
      const kept = ts.filter((t) => t > since);
      if (kept.length === 0) this.bySigner.delete(k); else this.bySigner.set(k, kept);
    }
    const key = principalKey(signer);
    const mine = this.bySigner.get(key) ?? [];
    const wait = (oldest: number | undefined): number => Math.max(1, Math.ceil(((oldest ?? now) + HOUR_MS - now) / 1000));
    if (this.all.length >= this.limit.total) return { ok: false, scope: 'total', retryAfterSeconds: wait(this.all[0]) };
    if (mine.length >= this.limit.perSigner) return { ok: false, scope: 'signer', retryAfterSeconds: wait(mine[0]) };
    this.all.push(now);
    this.bySigner.set(key, [...mine, now]);
    return { ok: true };
  }
}

// ═════════════════════════════════════════════════════════════════════════════════════════════
//  Declines
// ═════════════════════════════════════════════════════════════════════════════════════════════

type Out = Record<string, unknown>;

/** A refusal on its way to the handler boundary. */
class Declined extends Error {
  constructor(readonly refusal: Out) {
    super(String(refusal['error'] ?? 'declined'));
    this.name = 'Declined';
  }
}

function decline(status: number, message: string, code: string, resolvedBy?: Record<string, unknown>, extra?: Out): Declined {
  return new Declined({ ...refuse(status, message, code, resolvedBy), ...(extra ?? {}) });
}

const A = PEV_ACTION;

/** Turn anything thrown inside an act into the refusal the caller receives. */
function refusalFor(e: unknown): Out {
  if (e instanceof Declined) return e.refusal;
  if (e instanceof PublishPreconditionFailedError) {
    return { ...refuse(409, 'The record changed while you were acting; read it again and sign a new act.', 'chain-moved') };
  }
  if (e instanceof PublishShapeViolationError) {
    return { ...refuse(500, 'This bridge built a record that does not conform to its own shapes; nothing was written.', 'record-shape') };
  }
  if (e instanceof RecordNotSealable) {
    // A local failure before any write: never reported as the pod's.
    return { ...refuse(500, `This bridge built a record it cannot encrypt to its record key (${e.message}); nothing was written.`, 'record-shape') };
  }
  if (e instanceof ChainForked) {
    return {
      ...refuse(409, `This record has ${e.heads.length} competing latest versions; it can be read and exported but not advanced.`, 'chain-forked'),
      heads: e.heads,
    };
  }
  if (e instanceof RecordSealed) {
    return {
      ...refuse(409, `The record at ${e.descriptorUrl} cannot be used: ${e.message}.`, 'record-not-trusted', { env: 'PEV_RECORD_KEY' }),
      descriptorUrl: e.descriptorUrl,
    };
  }
  if (e instanceof RecordUnreadable || e instanceof GraphMissing) {
    return {
      ...refuse(409, `The record at ${e.descriptorUrl} cannot be used: ${e.message}.`, 'record-not-trusted'),
      descriptorUrl: e.descriptorUrl,
    };
  }
  if (e instanceof ReadBudgetSpent) {
    return {
      ...refuse(409,
        `This act stopped reading the pod at ${e.limit} bytes, the most this bridge reads for one act, before it had the records it needs; nothing was written. No record this bridge writes is that large: someone who can write the pod may have planted large files.`,
        'read-limit-reached'),
      readLimitBytes: e.limit,
    };
  }
  if (e instanceof PodTransportFailed) {
    if (e.refusedStatus !== null && e.direction === 'write') {
      return {
        ...refuse(502,
          `The pod at ${e.podOrigin} refused this bridge's write (HTTP ${e.refusedStatus}). The operator sets PEV_POD_WRITE_SECRET to that pod's write credential, or points the bridge at a pod that accepts its writes.`,
          'pod-refused-write', { env: 'PEV_POD_WRITE_SECRET' }),
      };
    }
    if (e.refusedStatus !== null) {
      return { ...refuse(502, `The pod at ${e.podOrigin} refused this bridge's read (HTTP ${e.refusedStatus}).`, 'pod-refused-read') };
    }
    return { ...refuse(502, `The pod at ${e.podOrigin} could not be reached; nothing is claimed about this act. ${e.message}`, 'pod-unreachable') };
  }
  throw e;
}

// ═════════════════════════════════════════════════════════════════════════════════════════════
//  Context
// ═════════════════════════════════════════════════════════════════════════════════════════════

interface Ctx {
  readonly deps: PevDeps;
  readonly platform: Wallet;
  readonly platformDid: string;
  readonly trusted: TrustedPlatform;
  /**
   * The secret attempt IRIs are keyed with (attemptIriSecret of the record key), or null without a
   * record key, when attempt IRIs are a plain hash of the learner's address.
   */
  readonly attemptSecret: string | null;
  /** The public fingerprint every attempt IRI this bridge keys carries (iriKeyFingerprint); null without a record key. */
  readonly ownFingerprint: string | null;
  readonly admins: ReadonlySet<string>;
  /** Admin principals by user DID, exactly as configured (never lower-cased). */
  readonly adminDids: ReadonlySet<string>;
  /**
   * The relay-delegation policy with lower-cased relay addresses, or null without one. The route is
   * on when it lists any relay address (`relayOn`); its identity host also decides which user DIDs
   * a role may be given to.
   */
  readonly relay: RelayDelegationPolicy | null;
  readonly relayOn: boolean;
  readonly identityHost: string | null;
  readonly fetchFn: typeof fetch;
  readonly holderFetchFn: typeof fetch;
  /** Pod bases this bridge reads and writes records on; null = any public pod (explicit '*'). */
  readonly served: readonly string[] | null;
  readonly modelBudget: HourlyBudget;
  readonly attemptBudget: HourlyBudget;
  readonly ledger: NonceLedger;
  readonly maxAgeMs: number;
  readonly lock: <T>(key: string, fn: () => Promise<T>) => Promise<T>;
  readonly demo: ReadonlyMap<string, { readonly role: DemoRoleName; readonly label: string; readonly wallet: Wallet }>;
  readonly now: () => Date;
  readonly nonce: () => string;
  readonly timeouts: { readonly counterpart: Timeouts; readonly judge: Timeouts; readonly draft: Timeouts };
  readonly homePage: string;
  readonly resultsK: number;
  /** Records read and found trusted, reused across acts (`VerifiedRecords`). */
  readonly verified: VerifiedRecords;
  /** How many records this handler set has written: an act that sees it move re-reads the manifest under its lock. */
  readonly writes: { n: number };
  readonly actReadBudgetBytes: number;
  readonly assertPublicPod: (podUrl: string) => Promise<void>;
}

/**
 * One act: what it has read (`cache`), and `read`, the operator-pod fetch every read of the act
 * goes through, counted against the act's read budget. Writes go through `ctx.fetchFn`.
 */
interface Call {
  readonly ctx: Ctx; readonly cache: ReadCache; readonly budget: ReadBudget; readonly read: typeof fetch;
  /** `ctx.writes.n` when the act began: the records this handler set had written by then. */
  readonly writesAtStart: number;
}

/**
 * The lock on one graph, for one act. When this handler set wrote any record since the act began
 * (another act's write, which may have moved this graph while the act waited), taking the lock
 * forgets the manifests the act read before it, so what it reads under the lock is the pod as it is
 * once the lock is held. Otherwise the manifest it read stands: a write by another process in
 * between is caught as before, by the fresh read of the heads right before the publish and the
 * publish's own compare-and-set.
 */
function locked<T>(call: Call, key: string, fn: () => Promise<T>): Promise<T> {
  return call.ctx.lock(key, () => {
    if (call.ctx.writes.n !== call.writesAtStart) call.cache.manifests?.clear();
    return fn();
  });
}

function makeContext(deps: PevDeps): Ctx {
  const lower = (xs: readonly string[] | undefined): string[] => (xs ?? []).filter((x) => isAddress(x)).map((x) => x.toLowerCase());
  const maxAgeMs = deps.envelopeMaxAgeMs ?? 600_000;
  const fetchFn = deps.fetchFn ?? globalThis.fetch.bind(globalThis);
  const pods = (xs: readonly string[]): string[] => xs.map((p) => normalPod(p)).filter((p): p is string => p !== null);
  const served = deps.servedPods === '*' ? null
    : deps.servedPods !== undefined ? pods(deps.servedPods)
      : deps.defaultPodUrl ? pods([deps.defaultPodUrl]) : [];
  const demo = new Map<string, { role: DemoRoleName; label: string; wallet: Wallet }>();
  for (const r of deps.demoSigner?.roles ?? []) demo.set(r.wallet.address.toLowerCase(), r);
  const attemptSecret = deps.recordKey ? attemptIriSecret(deps.recordKey) : null;
  const rd = deps.relayDelegation;
  const relay: RelayDelegationPolicy | null = rd
    ? { relayAddresses: lower(rd.relayAddresses), identityHost: rd.identityHost, fetchDidDocument: rd.fetchDidDocument } : null;
  return {
    deps,
    platform: deps.platformWallet,
    platformDid: didOf(deps.platformWallet.address),
    trusted: {
      addresses: new Set([deps.platformWallet.address.toLowerCase(), ...lower(deps.trustedPlatformAddresses)]),
      ...(deps.recordKey ? { recordKey: deps.recordKey } : {}),
    },
    attemptSecret,
    ownFingerprint: attemptSecret === null ? null : iriKeyFingerprint(attemptSecret),
    admins: new Set(lower(deps.adminAddresses)),
    adminDids: new Set(relay ? (deps.adminDids ?? []).filter((d) => isUserDid(d, relay.identityHost)) : []),
    relay, relayOn: relay !== null && relay.relayAddresses.length > 0, identityHost: relay?.identityHost ?? null,
    fetchFn,
    holderFetchFn: deps.holderFetchFn ?? fetchFn,
    served,
    modelBudget: new HourlyBudget(deps.budgets?.modelCallsPerHour ?? DEFAULT_BUDGETS.modelCallsPerHour),
    attemptBudget: new HourlyBudget(deps.budgets?.attemptsPerHour ?? DEFAULT_BUDGETS.attemptsPerHour),
    ledger: new NonceLedger(2 * maxAgeMs),
    maxAgeMs,
    lock: createGraphLocks(),
    demo,
    now: deps.now ?? ((): Date => new Date()),
    nonce: deps.nonce ?? freshNonce,
    timeouts: {
      counterpart: deps.modelTimeouts?.counterpart ?? COUNTERPART_TIMEOUTS,
      judge: deps.modelTimeouts?.judge ?? JUDGE_TIMEOUTS,
      draft: deps.modelTimeouts?.draft ?? DRAFT_TIMEOUTS,
    },
    homePage: deps.deploymentUrl ?? 'http://127.0.0.1:6110',
    resultsK: deps.resultsK ?? RESULTS_K,
    verified: new VerifiedRecords(deps.recordCacheMs ?? RECORD_CACHE_TTL_MS, RECORD_CACHE_MAX_BYTES, deps.recordCacheClock),
    writes: { n: 0 },
    actReadBudgetBytes: deps.actReadBudgetBytes ?? ACT_READ_BUDGET_BYTES,
    assertPublicPod: deps.assertPublicPod ?? assertSafeFetchTarget,
  };
}

const iso = (ctx: Ctx): string => ctx.now().toISOString();
const isDemo = (ctx: Ctx, principal: string): boolean => ctx.demo.has(principalKey(principal));
/** An admin: an address in PEV_ADMIN_ADDRESSES, or a user DID in PEV_ADMIN_DIDS (exactly). */
const isAdmin = (ctx: Ctx, principal: string): boolean => (isAddress(principal) ? ctx.admins.has(principal.toLowerCase()) : ctx.adminDids.has(principal));

// ═════════════════════════════════════════════════════════════════════════════════════════════
//  Payload fields
// ═════════════════════════════════════════════════════════════════════════════════════════════

type P = Readonly<Record<string, unknown>>;
const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

function shape(field: string, rule: string): Declined {
  return decline(400, `${field} ${rule}.`, 'payload-shape');
}

/** Text with a lone UTF-16 surrogate: refused at input, before any model call or write. */
function notWellFormed(field: string): Declined {
  return shape(field, 'must be well-formed text (it holds half of a UTF-16 surrogate pair, which cannot be stored as sent)');
}

function needText(p: P, field: string, max: number, code?: string, min = 1): string {
  const v = p[field];
  if (typeof v !== 'string' || v.trim().length < min) {
    throw code ? decline(400, `${field} is required text.`, code) : shape(field, 'must be non-empty text');
  }
  if (v.length > max) throw shape(field, `must be at most ${max} characters`);
  if (!isWellFormedText(v)) throw notWellFormed(field);
  return v;
}

function optText(p: P, field: string, max: number): string | undefined {
  const v = p[field];
  if (v === undefined || v === null || v === '') return undefined;
  if (typeof v !== 'string') throw shape(field, 'must be text');
  if (v.length > max) throw shape(field, `must be at most ${max} characters`);
  if (!isWellFormedText(v)) throw notWellFormed(field);
  return v;
}

/**
 * Where in a signed payload the first text that is not well-formed sits (a key or a string
 * value with a lone UTF-16 surrogate), or null. Every payload is kept in the record it changes,
 * so one such string anywhere would make the record impossible to seal or hash as sent.
 */
function illFormedAt(v: unknown, at: string, depth = 0): string | null {
  if (typeof v === 'string') return isWellFormedText(v) ? null : at;
  if (depth > 64 || typeof v !== 'object' || v === null) return null;
  const children: (readonly [string, unknown, boolean])[] = Array.isArray(v)
    ? (v as unknown[]).map((x, i) => [`${at}[${i}]`, x, true] as const)
    : Object.entries(v).map(([k, x]) => [`${at}.${toWellFormedText(k)}`, x, isWellFormedText(k)] as const);
  for (const [here, x, keyOk] of children) {
    if (!keyOk) return here;
    const found = illFormedAt(x, here, depth + 1);
    if (found !== null) return found;
  }
  return null;
}

function needInt(p: P, field: string, min: number, max: number): number {
  const v = p[field];
  if (typeof v !== 'number' || !Number.isInteger(v) || v < min || v > max) throw shape(field, `must be an integer from ${min} to ${max}`);
  return v;
}

function optBool(p: P, field: string): boolean {
  const v = p[field];
  if (v === undefined || v === null) return false;
  if (typeof v !== 'boolean') throw shape(field, 'must be true or false');
  return v;
}

/** A plain attempt IRI (`urn:pev:attempt:<k16>-<n>`) or a keyed one (`urn:pev:attempt:k<fingerprint>:<k16>-<n>`). */
const ATTEMPT_IRI = /^urn:pev:attempt:(?:k[0-9a-f]{8}:)?[0-9a-f]{16}-[1-9][0-9]{0,5}$/;
const SCENARIO_IRI = /^urn:pev:scenario:[0-9a-f]{16}$/;

function needAttemptIri(p: P): string {
  const v = p['attemptIri'];
  if (typeof v !== 'string' || v.length === 0) throw shape('attemptIri', 'must name the attempt (urn:pev:attempt:…)');
  return v;
}

function needTarget(p: P): RecordTarget {
  const t = p['target'];
  if (!isObj(t) || typeof t['recordId'] !== 'string' || typeof t['descriptorUrl'] !== 'string' || typeof t['graphDigest'] !== 'string') {
    throw decline(400, 'Name the exact record you act on: target {recordId, descriptorUrl, graphDigest}, as get_attempt returns it in currentTarget.', 'target-missing');
  }
  return { recordId: t['recordId'], descriptorUrl: t['descriptorUrl'], graphDigest: t['graphDigest'] };
}

function needWhy(p: P, required: boolean): string | undefined {
  const v = p['why'];
  if (v === undefined || v === null || v === '') {
    if (required) throw decline(400, 'Say why in 10 to 1000 characters.', 'why-too-short');
    return undefined;
  }
  if (typeof v !== 'string' || v.trim().length < 10) throw decline(400, 'Say why in 10 to 1000 characters.', 'why-too-short');
  if (v.length > 1000) throw decline(400, 'Say why in at most 1000 characters.', 'why-too-long');
  return v;
}

// ═════════════════════════════════════════════════════════════════════════════════════════════
//  Steps 1–3: envelope, pod, nonce
// ═════════════════════════════════════════════════════════════════════════════════════════════

interface Signed {
  /** The principal: the recovered address, or the person's user DID when the relay signed for them. */
  readonly signer: string; readonly signerDid: string; readonly payload: P; readonly stored: StoredEnvelope;
  readonly form: EnvelopeForm; readonly payloadSha256: string; readonly pod: string; readonly nonce: string;
  readonly actor: Actor; readonly at: string;
  /** Set when the Interego relay signed this act for the person (authority relay-delegated). */
  readonly relay?: RelayAttestation;
}

/**
 * The decisive acts: the ones that change who may do what, put a reviewer's name behind a rubric
 * or an attempt (a ratification makes results on the rubric eligible to leave as evidence, and a
 * countersign accepts the judge's levels as the reviewer's own, as an override sets them), or
 * withdraw a review. A relay-delegated request for one of them is read only from this bridge's own
 * web UI (an agent whose slug starts with `WEB_UI_AGENT_PREFIX`) unless the operator lets chat
 * agents decide (PEV_CHAT_AGENTS_DECIDE=1), and is refused before anything is read from a pod.
 * `DECISIVE_ON_ANOTHERS_ATTEMPT` holds the acts that are decisive when the signer is not the
 * attempt's learner, checked once the attempt is read.
 */
export const DECISIVE_ACTS: ReadonlySet<PevActionKey> = new Set<PevActionKey>(['registerRole', 'ratifyScenario', 'countersignAttempt', 'overrideAttempt', 'retractReview']);
/** An admin removing another learner's transcript: permanent, so decisive; the learner's own redaction is hers to make from any agent. */
export const DECISIVE_ON_ANOTHERS_ATTEMPT: ReadonlySet<PevActionKey> = new Set<PevActionKey>(['redactAttempt']);
/**
 * The agent slug prefix of this bridge's own web UI: the relay names an OAuth client's agent
 * `<client name>-<userId>`, and the UI registers as `practice-evidence`. Any client can call
 * itself that, so this keeps a chat agent a person connected for other work from deciding here
 * unasked; it does not prove the page made the request.
 */
export const WEB_UI_AGENT_PREFIX = 'practice-evidence-';

/**
 * Refused when a chat agent the relay signed for takes a decisive act and the operator has not let
 * chat agents decide: null when the act may go on (a key-held signer, this bridge's web UI, or
 * PEV_CHAT_AGENTS_DECIDE=1).
 */
function chatAgentRefusal(ctx: Ctx, relay: RelayAttestation | undefined): Declined | null {
  if (relay === undefined || ctx.relay === null || ctx.deps.chatAgentsDecide === true) return null;
  const slug = agentSlugOf(relay.agentId, ctx.relay.identityHost) ?? '';
  if (slug.startsWith(WEB_UI_AGENT_PREFIX)) return null;
  return decline(403,
    `This act is decisive here (it changes who may do what, puts a reviewer's name behind a rubric or an attempt, withdraws a review, or removes another learner's transcript), and the Interego relay signed it for ${relay.agentId}, a chat agent. Such acts are taken from this bridge's own web UI (an agent named ${WEB_UI_AGENT_PREFIX}…) unless the operator sets PEV_CHAT_AGENTS_DECIDE=1. Sign in on this bridge's web UI and take it there.`,
    'chat-agent-may-not-decide', { env: 'PEV_CHAT_AGENTS_DECIDE' }, { agentId: relay.agentId });
}

/**
 * The signed request, opened: relay-delegated when it is in the `{_signed_payload, _signature}`
 * shape and its signature recovers to a relay address this bridge trusts, key-held otherwise
 * (`checkEnvelope`, unchanged: another key signing the same shape is refused there as before).
 * A relay-delegated request passes every check a key-held one does (v, action, freshness from the
 * relay's timestamp, nonce format, the pod from pod_url) before the agent's DID document is
 * fetched, and a decisive act from a chat agent is refused before anything is read from a pod.
 */
async function openEnvelope(ctx: Ctx, args: Record<string, unknown>, key: PevActionKey, now: Date): Promise<EnvelopeOk> {
  const relay = ctx.relay;
  if (relay !== null && ctx.relayOn) {
    const found = signedRequestOf(args);
    const relaySigner = found ? signedRequestSigner(found) : null;
    if (found && relaySigner !== null && relay.relayAddresses.includes(relaySigner)) {
      const checked = checkRelayPayload(found.signedPayload, A[key], now, { maxAgeMs: ctx.maxAgeMs });
      if (!checked.ok) throw decline(checked.status, checked.message, checked.code);
      const opened = await openRelayDelegated(found.signedPayload, found.signature, relay);
      if (!opened.ok) throw decline(opened.status, opened.message, opened.code);
      const limited = DECISIVE_ACTS.has(key)
        ? chatAgentRefusal(ctx, { authority: 'relay-delegated', principal: opened.principal, agentId: opened.agentId, relaySigner: opened.relaySigner })
        : null;
      if (limited !== null) throw limited;
      return relayDelegatedEnvelope(opened, checked);
    }
  }
  const env = checkEnvelope(args, A[key], now, { maxAgeMs: ctx.maxAgeMs });
  if (!env.ok) throw decline(env.status, env.message, env.code);
  return env;
}

function notPublic(raw: string): Declined {
  return decline(400, `The pod ${raw} is not a public http(s) address this bridge may reach.`, 'pod-not-public');
}

/** The pod base of a caller's pod URL, normalised by the URL parser; never resolved or fetched. */
function podOf(raw: string): string {
  const n = normalPod(raw);
  if (n === null) throw notPublic(raw);
  return n;
}

/** Resolve a pod's host and refuse it unless every address is public (`assertPublicPod`). */
async function assertPublic(ctx: Ctx, raw: string, pod: string): Promise<void> {
  try {
    await ctx.assertPublicPod(pod);
  } catch {
    throw notPublic(raw);
  }
}

/**
 * A caller's pod, refused unless this bridge serves it, and only then resolved: an unserved pod is
 * refused (403 pod-not-served) from the URL alone, with no DNS lookup and no request, so the answer
 * cannot tell a caller which names resolve to private addresses (an internal service's name, say).
 */
async function servedPublicPod(ctx: Ctx, raw: string): Promise<string> {
  const pod = podOf(raw);
  if (!servesPod(ctx, pod)) throw notServed(ctx);
  await assertPublic(ctx, raw, pod);
  return pod;
}

const servesPod = (ctx: Ctx, pod: string): boolean => ctx.served === null || ctx.served.includes(pod);

function notServed(ctx: Ctx): Declined {
  return ctx.served !== null && ctx.served.length === 0
    ? decline(403, 'This bridge serves no pod: the operator sets PEV_DEFAULT_POD_URL or PEV_SERVED_PODS.', 'pod-not-served', { env: 'PEV_SERVED_PODS' })
    : decline(403, `This bridge reads and writes records only on the pods it serves (${(ctx.served ?? []).join(', ')}).`, 'pod-not-served');
}

/**
 * A signed act. `write` acts write to the operator pod (and consume their nonce). Every signed
 * act, a read as well as a write, is refused (409 record-key-mismatch) on a pod whose own records
 * name another record key than this bridge's (a keyed attempt IRI or a sealed record's mark), or
 * any, when this bridge holds none: before the nonce is spent and before any record, the role
 * registry included, is read, so the refusal always names both keys rather than whichever sealed
 * record the act would have reached first (on a deployment, where the key seals every record, the
 * role registry).
 */
async function signedAct(
  call: Call, args: Record<string, unknown>, key: PevActionKey,
  o: { readonly write?: boolean; readonly nonce?: boolean; readonly checks?: (p: P) => void } = {},
): Promise<Signed> {
  const { ctx } = call;
  const now = ctx.now();
  const env = await openEnvelope(ctx, args, key, now);
  o.checks?.(env.payload);
  const bad = illFormedAt(env.payload, 'payload');
  if (bad !== null) throw notWellFormed(bad);
  const podUrl = String(env.payload['podUrl']);
  const argPod = args['pod_url'];
  if (typeof argPod === 'string' && argPod.trim() !== '' && podBase(argPod.trim()) !== podBase(podUrl)) {
    throw decline(400, 'pod_url names a different pod than the one in the signed payload.', 'pod-url-differs');
  }
  const pod = await servedPublicPod(ctx, podUrl);
  await refuseOnKeyMismatch(call, pod);
  const nonce = String(env.payload['nonce']);
  // Spent per principal: a relay-delegated nonce is the person's, not the relay's (it signs for everyone).
  if ((o.nonce ?? o.write ?? false) && !ctx.ledger.consume(env.signer, nonce, now)) {
    throw decline(409, 'This signed envelope was already used; sign a new one.', 'envelope-already-used');
  }
  return {
    signer: env.signer, signerDid: env.signerDid, payload: env.payload, stored: env.stored, form: env.form,
    payloadSha256: env.payloadSha256, pod, nonce, actor: actorOf(env.signer, env.relay === undefined && isDemo(ctx, env.signer)), at: now.toISOString(),
    ...(env.relay ? { relay: env.relay } : {}),
  };
}

// ═════════════════════════════════════════════════════════════════════════════════════════════
//  Records under another record key
// ═════════════════════════════════════════════════════════════════════════════════════════════

/** What the pod's manifest says about record keys that are not this bridge's. */
interface KeyMismatch {
  /** The first place in the manifest naming a key that is not this bridge's (any key, when it holds none). */
  readonly mark: KeyMark;
  /** Every such key's fingerprint on the pod, sorted. */
  readonly podKeys: readonly string[];
  /** True when the pod also holds records under this bridge's own key: bridges holding different keys wrote to it. */
  readonly ownKeyToo: boolean;
}

/**
 * The record keys the pod holds records under that are not this bridge's, or null. Every record a
 * bridge seals carries its key's fingerprint in its descriptor URL, and every attempt IRI it keys
 * carries it too (`keyMarksOf`, over the pod's own records container: a holder copy another bridge
 * wrote to this pod for a learner marks nothing), so the manifest alone says which key the pod's
 * records are under, from the first record a key sealed, whether an attempt was started under it
 * or not. A bridge holding another key, or none, would derive other attempt IRIs for the same
 * learners (finding their attempts absent and starting a second chain beside them), write what the
 * pod's key cannot open (or plaintext), and read the records it can open as if they were all, so
 * it writes nothing and answers nothing from the pod but the scenario list. Plain IRIs and
 * plaintext records carry no mark: a pod that never had a key works as before. The check reads the
 * manifest only, so an entry a pod writer adds can stop this bridge, which a pod writer can do in
 * other ways too (forking a chain); it can never make the bridge write.
 */
function keyMismatchIn(ctx: Ctx, marks: readonly KeyMark[]): KeyMismatch | null {
  const foreign = marks.filter((m) => m.fingerprint !== ctx.ownFingerprint);
  const first = foreign[0];
  if (first === undefined) return null;
  return {
    mark: first, podKeys: [...new Set(foreign.map((m) => m.fingerprint))].sort(),
    ownKeyToo: ctx.ownFingerprint !== null && marks.some((m) => m.fingerprint === ctx.ownFingerprint),
  };
}

function keyMismatchWhy(ctx: Ctx, m: KeyMismatch): string {
  const where = m.mark.by === 'attempt-iri'
    ? `the attempt ${m.mark.at}, whose IRI was derived under the record key with fingerprint k${m.mark.fingerprint}`
    : `the record ${m.mark.at}, sealed to the record key with fingerprint k${m.mark.fingerprint}`;
  const more = m.podKeys.length > 1 ? ` (and records under ${m.podKeys.filter((k) => k !== m.mark.fingerprint).map((k) => `k${k}`).join(', ')})` : '';
  return `This pod holds ${where}${more}, and this bridge ${
    ctx.ownFingerprint === null ? 'holds no record key' : `holds the one with fingerprint k${ctx.ownFingerprint}`} (PEV_RECORD_KEY): it derives other attempt IRIs for the same learners, so it would find their attempts absent and start second chains beside them, and what it wrote would not be under the pod's record key`;
}

/**
 * What the operator can do. The pod's records say which keys wrote to it, not which key is the
 * operator's: a bridge holding the wrong key may have written first. So the advice is to switch
 * keys only where that is the one reading (this bridge holds none), and otherwise to check.
 */
function keyMismatchAdvice(ctx: Ctx, m: KeyMismatch): string {
  const pod = m.podKeys.map((k) => `k${k}`).join(' and ');
  if (ctx.ownFingerprint === null) return `Set PEV_RECORD_KEY to the key this pod's records are under (${pod}), from the operator's backup.`;
  if (m.ownKeyToo) {
    return `This pod holds records under this bridge's key (k${ctx.ownFingerprint}) as well as ${pod}: bridges holding different keys wrote to it, or someone who can write the pod added manifest entries. The operator decides which key the pod keeps; this pod does not say which is right, so PEV_RECORD_KEY is not changed on the strength of it.`;
  }
  return `If ${pod} is the operator's record key (a bridge holding a key prints its fingerprint when it starts), set PEV_RECORD_KEY to it from the operator's backup. If this bridge's key (k${ctx.ownFingerprint}) is the operator's, a bridge holding another key wrote to this pod first, or someone who can write the pod added the entry: the operator decides what the pod keeps.`;
}

/** The fields a key mismatch is reported with: where the manifest names the other key, and both keys' fingerprints (never the keys). */
function keyMismatchFields(ctx: Ctx, m: KeyMismatch): Out {
  return {
    markedAt: m.mark.at, markedBy: m.mark.by, podKey: `k${m.mark.fingerprint}`, podKeys: m.podKeys.map((k) => `k${k}`),
    bridgeKey: ctx.ownFingerprint === null ? null : `k${ctx.ownFingerprint}`, bridgeKeyOnPod: m.ownKeyToo,
  };
}

/** The refusal of every act but the scenario list on a pod whose records are under another record key. */
function keyMismatchDecline(ctx: Ctx, m: KeyMismatch): Declined {
  return decline(409, `${keyMismatchWhy(ctx, m)}. It writes nothing on this pod, and answers nothing from it but the scenario list, until every bridge on it holds one record key. ${keyMismatchAdvice(ctx, m)}`,
    'record-key-mismatch', { env: 'PEV_RECORD_KEY' }, keyMismatchFields(ctx, m));
}

/**
 * Every act but the scenario list, first thing on the pod: refused (keyMismatchDecline) when the
 * pod's own records name a record key that is not this bridge's (any, when it holds none).
 */
async function refuseOnKeyMismatch(call: Call, pod: string): Promise<void> {
  const mismatch = keyMismatchIn(call.ctx, keyMarksOf(await podEntries(pod, call.read, call.cache), pod));
  if (mismatch) throw keyMismatchDecline(call.ctx, mismatch);
}

/** What the scenario list, the one read still answered, carries when the pod's records are under another key. */
function keyMismatchMark(ctx: Ctx, m: KeyMismatch): Out {
  return {
    ...keyMismatchFields(ctx, m), resolvedBy: { env: 'PEV_RECORD_KEY' },
    note: 'This pod holds records under a record key this bridge does not hold (keyed attempt IRIs, or records sealed to it). This bridge writes nothing on this pod, and answers nothing from it but this list, until every bridge on it holds one record key; what is shown here is only what it can read.',
  };
}

/**
 * The refusal of an answer that would be computed without records sealed to a record key this
 * bridge does not hold (or sealed while it holds none): counting, ranking or listing without them
 * would read their absence as a fact.
 */
function sealedDecline(n: number, what: string): Declined {
  return decline(409,
    `${n} record(s) on this pod are sealed to a record key this bridge does not hold, or it holds none, so ${what} cannot be computed: without them it would read as complete. If the key that wrote them is the operator's record key, set PEV_RECORD_KEY to it.`,
    'records-sealed', { env: 'PEV_RECORD_KEY' }, { sealedRecordsSkipped: n });
}

/** The pod for an unsigned read: `pod_url`, else the bridge's default. */
async function readPod(ctx: Ctx, args: Record<string, unknown>): Promise<string> {
  const raw = typeof args['pod_url'] === 'string' && args['pod_url'].trim() !== '' ? args['pod_url'].trim() : ctx.deps.defaultPodUrl;
  if (!raw) throw decline(400, 'Name a pod: pass pod_url (this bridge has no default pod).', 'no-pod');
  return servedPublicPod(ctx, raw);
}

function actOf(s: Signed, key: PevActionKey): AttemptAct {
  return {
    action: A[key], signer: s.signer, form: s.form, payloadSha256: s.payloadSha256, at: s.at, signature: s.stored.signature,
    ...(s.actor.serverHeldDemoKey ? { serverHeldDemoKey: true } : {}),
    ...(s.relay ? { authority: s.relay.authority, agentId: s.relay.agentId, relaySigner: s.relay.relaySigner } : {}),
  };
}

// ═════════════════════════════════════════════════════════════════════════════════════════════
//  Step 5: heads, trust, roles
// ═════════════════════════════════════════════════════════════════════════════════════════════

function untrusted(r: ReadRecord): Declined {
  const signer = r.authorship.signerAddress ?? 'no platform signature';
  if (r.misplaced !== undefined && r.authorship.valid && r.authorship.platformKnown) {
    return decline(409, `The record at ${r.descriptorUrl} is signed by this platform, but not for where it sits: ${r.misplaced}. It is not used.`,
      'record-not-trusted', undefined, { misplaced: r.misplaced, descriptorUrl: r.descriptorUrl });
  }
  return decline(409,
    `The record at ${r.descriptorUrl} is not signed by a platform key this bridge trusts (signer: ${signer}; binding: ${r.authorship.contentBinding}). If that address was this bridge's earlier key, add it to PEV_TRUSTED_PLATFORM_ADDRESSES.`,
    'record-not-trusted', { env: 'PEV_TRUSTED_PLATFORM_ADDRESSES' },
    { signerAddress: r.authorship.signerAddress, contentBinding: r.authorship.contentBinding, descriptorUrl: r.descriptorUrl });
}

interface AttemptHead { readonly rec: ReadRecord; readonly body: AttemptBody; readonly seq: number }
interface ScenarioHead { readonly rec: ReadRecord; readonly body: ScenarioBody; readonly seq: number }

async function attemptHead(call: Call, pod: string, iri: string): Promise<AttemptHead> {
  const missing = decline(404, 'No attempt with this IRI is on this pod.', 'attempt-not-found');
  if (!ATTEMPT_IRI.test(iri)) throw missing;
  const h = await readHead(pod, iri, call.ctx.trusted, call.read, call.cache);
  if (!h.head) throw missing;
  if (!isTrusted(h.head)) throw untrusted(h.head);
  if (h.head.body.kind !== 'attempt') throw missing;
  return { rec: h.head, body: h.head.body, seq: h.seq };
}

async function scenarioHead(call: Call, pod: string, iri: string): Promise<ScenarioHead | null> {
  if (!SCENARIO_IRI.test(iri)) return null;
  const h = await readHead(pod, iri, call.ctx.trusted, call.read, call.cache);
  if (!h.head) return null;
  if (!isTrusted(h.head)) throw untrusted(h.head);
  if (h.head.body.kind !== 'scenario') return null;
  return { rec: h.head, body: h.head.body, seq: h.seq };
}

interface Roles { readonly view: RoleRegistryView; of(address: string): ReadonlySet<Role> }

async function rolesOn(call: Call, pod: string): Promise<Roles> {
  const view = await readRoleRegistry(pod, call.ctx.trusted, call.read, call.cache);
  if (!view.trusted && view.head) throw untrusted(view.head);
  return { view, of: (principal: string) => view.roles.get(principalKey(principal)) ?? new Set<Role>() };
}

/**
 * Refuse an envelope already applied to this attempt. Every act on an attempt keeps its payload
 * hash in the record, so a stored envelope cannot act twice, even on another process or after a
 * restart, where the in-memory nonce ledger does not reach.
 */
function notReplayed(a: AttemptBody, s: Signed): void {
  if (a.acts.some((x) => x.payloadSha256 === s.payloadSha256)) {
    throw decline(409, 'This signed envelope was already used on this attempt; sign a new one.', 'envelope-already-used');
  }
}

function targetOf(r: ReadRecord): RecordTarget {
  return { recordId: r.recordId, descriptorUrl: r.descriptorUrl, graphDigest: r.graphDigest };
}

function sameTarget(a: RecordTarget, b: RecordTarget): boolean {
  return a.recordId === b.recordId && a.descriptorUrl === b.descriptorUrl && a.graphDigest === b.graphDigest;
}

function checkTarget(given: RecordTarget, head: ReadRecord): void {
  if (!sameTarget(given, targetOf(head))) {
    throw decline(409, 'The record you signed for is no longer the latest version; read the attempt again and sign for its currentTarget.', 'record-changed',
      undefined, { currentTarget: targetOf(head) });
  }
}

// ═════════════════════════════════════════════════════════════════════════════════════════════
//  Steps 10–12: descriptor plan and the one way a record is written
// ═════════════════════════════════════════════════════════════════════════════════════════════

/**
 * The descriptor plan for a body (§5.1). Pure: holder copies rebuild the same plan from the same
 * body. The descriptor is public even when the graph is sealed (`sealed`), so it names a person
 * only in a role that is public by design: an author, a ratifier, a reviewer or an admin, never
 * a learner. Attempt descriptors name the reviewer alone; a projection audit names whoever asked
 * only when its graph is plaintext anyway.
 */
function planOf(body: PevRecordBody, o: {
  readonly recordId: string; readonly platformDid: string; readonly supersedes?: string; readonly derivedFrom?: readonly string[];
  readonly sealed?: boolean;
}): DescriptorPlan {
  const common = {
    recordId: o.recordId, graphIri: graphIriOf(body), kind: body.kind, modal: modalFor(body), at: body.at, platformDid: o.platformDid,
    ...(o.supersedes !== undefined ? { supersedes: o.supersedes } : {}),
    ...(o.derivedFrom && o.derivedFrom.length > 0 ? { derivedFrom: o.derivedFrom } : {}),
  };
  switch (body.kind) {
    case 'scenario': {
      const da = body.draftAssistance;
      const actors: { did: string; role: 'Curator' | 'Validator' }[] = body.versionAuthors.map((a) => ({ did: principalDid(a), role: 'Curator' }));
      if (body.ratification) actors.push({ did: body.ratification.reviewer.did, role: 'Validator' });
      return {
        ...common, validFrom: body.at, actors,
        ...(da.used && da.measured ? { softwareAuthors: [modelAgentIri(da.provider, da.model)] } : {}),
        trust: body.status === 'ratified' && body.ratification
          ? { level: 'ThirdPartyAttested', issuer: body.ratification.reviewer.did } : { level: 'SelfAsserted' },
      };
    }
    case 'attempt': {
      const review = standingReview(body);
      const reviewed = (body.state === 'countersigned' || body.state === 'overridden') && review !== null;
      if (body.state === 'review-retracted') {
        const withdrawn = [...body.reviews].reverse().find((r) => r.withdrawn !== undefined);
        return { ...common, validFrom: withdrawn?.reviewedAt ?? body.startedAt, validUntil: body.at, actors: [], trust: { level: 'SelfAsserted' } };
      }
      if (body.state === 'redacted') {
        return { ...common, validFrom: body.startedAt, validUntil: body.at, actors: [], trust: { level: 'SelfAsserted' } };
      }
      return {
        ...common, validFrom: body.at,
        actors: reviewed ? [{ did: review.reviewer.did, role: 'Validator' }] : [],
        trust: reviewed ? { level: 'ThirdPartyAttested', issuer: review.reviewer.did } : { level: 'SelfAsserted' },
      };
    }
    case 'role-registry':
      return { ...common, validFrom: body.at, actors: [{ did: body.change.by, role: 'Curator' }], trust: { level: 'SelfAsserted' } };
    case 'projection-audit':
      // Who asked is usually the learner. With a record key the graph is sealed, and naming them
      // on the public descriptor would tell anyone reading the pod which learner holds a reviewed
      // attempt; the body keeps requestedBy either way.
      return {
        ...common, validFrom: body.at, actors: o.sealed ? [] : [{ did: body.requestedBy, role: 'Curator' }], trust: { level: 'SelfAsserted' },
      };
  }
}

interface Written { readonly descriptorUrl: string; readonly graphUrl: string; readonly recordId: string; readonly graphDigest: string }

/**
 * Sign and publish the next record of a chain. The heads are read again right before the
 * publish; anything but exactly the head this act read means someone else moved the chain. With
 * a record key the graph is sealed to it, and its descriptor URL carries the key's fingerprint
 * (`slugFor`); the proof is over the plaintext graph either way. Every version gets a fresh salt in
 * its body (RecordCommon.salt), so its public content hash confirms no guess of what it holds.
 * Nothing an act awaits after this can refuse it: every read it rests on comes first.
 */
async function writeRecord(call: Call, w: {
  readonly pod: string; readonly body: PevRecordBody; readonly seq: number; readonly prev: ReadRecord | null;
  readonly nonce: string; readonly disclosure?: InferenceDisclosure;
}): Promise<Written> {
  const { ctx } = call;
  const { prev: _was, salt: _old, ...unlinked } = w.body;
  const body = {
    ...unlinked, seq: w.seq,
    ...(w.prev ? { prev: { recordId: w.prev.recordId, graphDigest: w.prev.graphDigest } } : {}),
    salt: recordSalt(),
  } as PevRecordBody;
  const graphIri = graphIriOf(body);
  const recordId = recordIdFor(graphIri, w.seq, body.at, w.nonce);
  const graphTurtle = recordGraphTurtle(body);
  const digest = canonicalGraphDigestResult(graphTurtle);
  if (digest.digest === null) throw decline(500, `This bridge built a record graph it cannot digest (${digest.reason}); nothing was written.`, 'record-shape');
  const proof = await signRecordAuthorship(ctx.platform, ctx.platformDid, recordId, graphTurtle, body.at);
  const descriptor = buildRecordDescriptor(planOf(body, {
    recordId, platformDid: ctx.platformDid, ...(w.prev ? { supersedes: w.prev.descriptorUrl } : {}), sealed: ctx.trusted.recordKey !== undefined,
  }));
  const v = validate(descriptor);
  if (!v.conforms) {
    throw decline(500, 'This bridge built a descriptor that does not validate; nothing was written.', 'record-shape', undefined,
      { violations: v.violations.map((x) => String((x as { message?: unknown }).message ?? x)).slice(0, 5) });
  }
  const moved = (): Declined => decline(409, 'The record changed while you were acting; read it again and sign a new act.', 'chain-moved',
    undefined, w.disclosure ? { disclosure: w.disclosure } : undefined);
  const fresh = await refreshHeads(w.pod, graphIri, call.read);
  const expected = w.prev ? [w.prev.descriptorUrl] : [];
  if (fresh.length !== expected.length || fresh.some((h, i) => h !== expected[i])) throw moved();
  try {
    const r = await publishPevRecord({
      podUrl: w.pod, descriptor, graphTurtle, authorshipProof: proof,
      // A sealed record's slug names its key's fingerprint, so the manifest says which key wrote it.
      slug: slugFor(body.kind, graphIri, w.seq, recordId, ctx.ownFingerprint ?? undefined),
      ...(w.prev ? { supersedes: w.prev.descriptorUrl, currentHeads: fresh } : {}), fetchFn: ctx.fetchFn,
      ...(ctx.trusted.recordKey ? { sealTo: ctx.trusted.recordKey } : {}),
    });
    ctx.writes.n += 1;
    return { descriptorUrl: r.descriptorUrl, graphUrl: r.graphUrl, recordId, graphDigest: digest.digest };
  } catch (e) {
    if (e instanceof PublishPreconditionFailedError) throw moved();
    throw e;
  }
}

// ═════════════════════════════════════════════════════════════════════════════════════════════
//  Step 9: models
// ═════════════════════════════════════════════════════════════════════════════════════════════

/**
 * The model for one step: a per-request key first, else this bridge's own. Using the bridge's own
 * model (its operator's key) is limited: by role when the bridge says 'registered', and always by
 * the per-hour budget, taken here before any call is made.
 */
function routeFor(call: Call, args: Record<string, unknown>, packet: { readonly action: string; readonly then: string },
  who: { readonly signer: string; readonly roles: ReadonlySet<Role> }): TextModel {
  const { ctx } = call;
  for (const field of ['llm_model', 'llm_api_key'] as const) {
    const v = args[field];
    if (typeof v === 'string' && !isWellFormedText(v)) throw notWellFormed(field);
  }
  const r = resolveTextModel(ctx.deps.model, args, ctx.deps.byokFetch);
  if ('bad' in r) throw decline(400, r.bad, 'byok-incomplete');
  if ('none' in r) {
    throw decline(503,
      'No model is configured on this bridge, so it cannot run this step itself. Use the client-required packet with your own agent and record the result, or send llm_api_key with llm_model for this request.',
      'no-model-route', packet);
  }
  if (r.model.keySource === 'per-request-byok') return r.model;
  if (ctx.deps.bridgeModelFor === 'registered' && who.roles.size === 0) {
    throw decline(403,
      'This bridge lends its own model only to addresses an admin registered on this pod. Use the client-required packet with your own agent, or send llm_api_key with llm_model for this request.',
      'bridge-model-for-registered-only', packet);
  }
  const taken = ctx.modelBudget.take(who.signer, ctx.now().getTime());
  if (!taken.ok) {
    throw decline(429,
      taken.scope === 'signer'
        ? `You have used this bridge's model ${ctx.modelBudget.limit.perSigner} times in the last hour; try again in ${taken.retryAfterSeconds} s, or use the packet route or your own key.`
        : `This bridge's model has been used ${ctx.modelBudget.limit.total} times in the last hour; try again in ${taken.retryAfterSeconds} s, or use the packet route or your own key.`,
      'model-budget-spent', packet, { scope: taken.scope, retryAfterSeconds: taken.retryAfterSeconds });
  }
  return r.model;
}

function modelFailure(e: unknown, model: TextModel, t: Timeouts): Declined {
  const byok = model.keySource === 'per-request-byok';
  const disclosure = attemptedDisclosure(model);
  const extra = (o: Out = {}): Out => ({ disclosure, ...o });
  if (!(e instanceof TextModelCallFailed)) {
    const msg = e instanceof Error ? e.message : String(e);
    return decline(502, `The model call did not complete (${msg.slice(0, 160)}); nothing was recorded.`, 'model-unreachable', undefined, extra());
  }
  if (e.timedOut) {
    return decline(502, `${e.message}; nothing was recorded.`, 'model-unreachable', undefined, extra({ timedOut: true, timeoutMs: t.timeoutMs, budgetMs: t.budgetMs }));
  }
  const s = e.status;
  const provider = { providerErrorType: e.providerErrorType, providerMessage: e.providerMessage };
  if (s === 401 || s === 403) {
    return byok
      ? decline(400, 'The provider did not accept the key sent with this request; nothing was recorded.', 'byok-key-not-accepted', undefined, extra())
      : decline(503, 'The provider did not accept this bridge\'s model key; the operator sets PEV_LLM_API_KEY.', 'bridge-model-key-not-accepted', { env: 'PEV_LLM_API_KEY' }, extra());
  }
  if (s === 402) return decline(503, 'The model provider reports a billing problem on this key; nothing was recorded.', 'model-billing', undefined, extra(provider));
  if (s === 429) {
    return decline(503, 'The model provider is rate-limiting this key; try again later.', 'model-rate-limited', undefined, extra({ retryAfterSeconds: e.retryAfterSeconds }));
  }
  if (s === null || s >= 500) return decline(502, `${e.message}; nothing was recorded.`, 'model-unreachable', undefined, extra(provider));
  return byok
    ? decline(400, `The provider did not accept this request (HTTP ${s}); check llm_model. Nothing was recorded.`, 'byok-request-not-accepted', undefined, extra(provider))
    : decline(503, `The provider did not accept this bridge's model request (HTTP ${s}); the operator checks PEV_LLM_MODEL.`, 'bridge-model-misconfigured', { env: 'PEV_LLM_MODEL' }, extra(provider));
}

async function callModel(model: TextModel, req: TextModelRequest, t: Timeouts): Promise<TextModelResult> {
  let r: TextModelResult;
  try {
    r = await model.complete({ ...req, timeoutMs: t.timeoutMs, budgetMs: t.budgetMs });
  } catch (e) {
    throw modelFailure(e, model, t);
  }
  const disclosure = attemptedDisclosure(model, r);
  if (r.stopReason === 'refusal') {
    throw decline(502, 'The model declined to answer; nothing was recorded.', 'model-declined', undefined, { category: r.stopCategory ?? null, disclosure });
  }
  if (r.stopReason === 'max_tokens') {
    throw decline(502, 'The model\'s answer was cut off at its token limit; nothing was recorded.', 'model-output-cut-off', undefined, { disclosure });
  }
  // A lone UTF-16 surrogate in what a model returned becomes U+FFFD here, before it is hashed or
  // recorded: that is what a UTF-8 encoder writes for it, and an envelope cannot seal it as is.
  return { ...r, text: toWellFormedText(r.text), model: toWellFormedText(r.model) };
}

// ═════════════════════════════════════════════════════════════════════════════════════════════
//  Eligibility to leave as evidence (§10): decided only by reading the pod
// ═════════════════════════════════════════════════════════════════════════════════════════════

/**
 * Recover a stored envelope's principal and payload from its exact signed bytes, or null, with no
 * network (`reverifyStoredEnvelope`): a key-held envelope's recovered address, or a relay-delegated
 * one's stored principal once the signature recovers to a relay address this bridge still trusts
 * and the signed agent_id is the stored agent. Whether the identity host still names that person as
 * the agent's controller is not asked again: the platform signature over the record carries what
 * it said when the act was taken.
 */
function reverify(ctx: Ctx, e: StoredEnvelope): { readonly signer: string; readonly payload: Record<string, unknown> } | null {
  return reverifyStoredEnvelope(e, { relayAddresses: ctx.relay?.relayAddresses ?? [], identityHost: ctx.identityHost });
}

interface Ratification { readonly ratified: boolean; readonly ratifiedBy: string | null }

/**
 * Whether the scenario version an attempt practised has a trusted ratified record with the same
 * hashes. A version that is read and fails the trust rule is skipped, never used. A chain this
 * bridge cannot read is NOT an answer of "not ratified": a version sealed to a key it does not
 * hold (409 naming PEV_RECORD_KEY), an envelope naming its key that does not open, a graph that is
 * gone, a manifest chaining elsewhere (409 record-not-trusted, saying why) or two heads (409
 * chain-forked) goes on to the caller as a refusal, and nothing (no skip audit, no review) is
 * written on the strength of it: every act reads this before it writes.
 */
async function ratificationOf(call: Call, pod: string, a: AttemptBody): Promise<Ratification> {
  let chain: readonly (ReadRecord | DeletedVersion)[];
  try {
    chain = await readChain(pod, a.scenario.scenarioIri, call.ctx.trusted, call.read, call.cache);
  } catch (e) {
    if (e instanceof ChainForked) {
      throw decline(409, `The scenario ${a.scenario.scenarioIri} has ${e.heads.length} competing latest versions, so whether the rubric version this attempt used was ratified cannot be read; nothing is claimed about it.`,
        'chain-forked', undefined, { heads: e.heads });
    }
    throw e;
  }
  for (const v of chain) {
    if (isDeleted(v) || !isTrusted(v) || v.body.kind !== 'scenario') continue;
    const b = v.body;
    if (b.status === 'ratified' && b.version === a.scenario.version && b.scenarioHash === a.scenario.scenarioHash
      && b.rubricHash === a.scenario.rubricHash && b.ratification) {
      return { ratified: true, ratifiedBy: b.ratification.reviewer.did };
    }
  }
  return { ratified: false, ratifiedBy: null };
}

type Eligibility =
  | { readonly eligible: true; readonly review: ReviewResult; readonly ratifiedBy: string; readonly registryCheckedAt: string }
  | { readonly eligible: false; readonly code: string; readonly why: string; readonly resolvedBy?: Record<string, unknown> };

const EVIDENCE_WHY = {
  authorTest: 'an author trying their own scenario is a test; it never leaves as evidence',
  redacted: 'the transcript was removed from this pod, so this attempt no longer leaves as evidence',
  notReviewed: 'a qualified reviewer has not countersigned or set the levels of this attempt',
  notVerifiable: 'the standing review does not check out against the record and the role registry as it stood when it was signed',
  notRatified: 'the rubric version this attempt used has not been ratified by a reviewer',
  ready: 'a qualified reviewer stood behind this attempt on a ratified rubric, so it can leave as practice evidence',
} as const;

async function eligibility(call: Call, pod: string, h: AttemptHead): Promise<Eligibility> {
  const a = h.body;
  if (a.authorTest) return { eligible: false, code: 'author-test-attempt', why: EVIDENCE_WHY.authorTest };
  if (a.state === 'redacted') return { eligible: false, code: 'attempt-redacted', why: EVIDENCE_WHY.redacted };
  const review = standingReview(a);
  if ((a.state !== 'countersigned' && a.state !== 'overridden') || h.rec.modalStatus !== 'Asserted' || !review) {
    return { eligible: false, code: 'attempt-not-countersigned', why: EVIDENCE_WHY.notReviewed, resolvedBy: { action: A.countersignAttempt } };
  }
  const notVerifiable: Eligibility = { eligible: false, code: 'countersign-not-verifiable', why: EVIDENCE_WHY.notVerifiable };
  const signed = reverify(call.ctx, review.envelope);
  if (!signed || !samePrincipal(signed.signer, review.reviewer.address)) return notVerifiable;
  const act = signed.payload['action'];
  if ((act !== A.countersignAttempt && act !== A.overrideAttempt) || signed.payload['attemptIri'] !== a.attemptIri) return notVerifiable;
  const t = signed.payload['target'];
  if (!isObj(t) || t['recordId'] !== review.target.recordId || t['descriptorUrl'] !== review.target.descriptorUrl
    || t['graphDigest'] !== review.target.graphDigest) return notVerifiable;
  if (!underPod(review.target.descriptorUrl, pod)) return notVerifiable;
  // A target read and found untrusted, or not the version signed for, is not verifiable. One that
  // cannot be read at all (sealed to another key, an envelope naming this key that does not open,
  // its graph gone) is unknown, not "not verifiable": the RecordUnreadable or GraphMissing goes on
  // to the caller as a 409 saying why, and no skip audit is written.
  const before = await readRecord(review.target.descriptorUrl, call.ctx.trusted, call.read, call.cache);
  if (!isTrusted(before) || placementProblem(before.body, pod, a.attemptIri) !== undefined
    || before.recordId !== review.target.recordId || before.graphDigest !== review.target.graphDigest) return notVerifiable;
  const asOf = await readRoleRegistryAt(pod, review.reviewedAt, call.ctx.trusted, call.read, call.cache);
  const held = asOf.roles.get(principalKey(review.reviewer.address)) ?? new Set<Role>();
  if (!held.has('reviewer') || held.has('agent')) return notVerifiable;
  const rat = await ratificationOf(call, pod, a);
  if (!rat.ratified || rat.ratifiedBy === null) {
    return { eligible: false, code: 'rubric-not-ratified', why: EVIDENCE_WHY.notRatified, resolvedBy: { action: A.ratifyScenario } };
  }
  return { eligible: true, review, ratifiedBy: rat.ratifiedBy, registryCheckedAt: review.reviewedAt };
}

// ═════════════════════════════════════════════════════════════════════════════════════════════
//  Views
// ═════════════════════════════════════════════════════════════════════════════════════════════

function scenarioView(rec: ReadRecord, b: ScenarioBody): Out {
  const s = b.scenario;
  return {
    scenarioIri: b.scenarioIri, scenarioKey: s.scenarioKey, version: b.version, status: b.status, ratified: b.status === 'ratified',
    ...(b.ratification ? { ratifiedBy: b.ratification.reviewer.did } : {}),
    title: s.title, learnerGoal: s.learnerGoal, learnerPart: s.learnerPart, situation: s.situation,
    counterpart: { name: s.counterpart.name }, firstLine: s.firstLine, turnLimit: s.turnLimit, language: s.language,
    assessmentUse: s.assessmentUse, workRegime: s.workRegime, passGateWhy: s.passGateWhy, rubric: s.rubric,
    rubricHash: b.rubricHash, scenarioHash: b.scenarioHash, descriptorUrl: rec.descriptorUrl, actor: b.actor.did,
    draftAssistance: b.draftAssistance, at: b.at,
    evidenceNote: b.status === 'ratified'
      ? 'A reviewer ratified this rubric version; reviewed results on it can leave as practice evidence.'
      : 'Results on this version can leave as evidence once a reviewer ratifies it.',
  };
}

function nextStepsOf(a: AttemptBody): NextLevelGuidance[] {
  const review = standingReview(a);
  if (review) return nextLevelGuidance(a.scenarioSpec.rubric, Object.fromEntries(review.finalLevels.map((f) => [f.criterionId, f.levelId])), 'final');
  const primary = a.judgments[0];
  return primary ? nextLevelGuidance(a.scenarioSpec.rubric, creditedLevels(a.scenarioSpec, primary), 'provisional') : [];
}

function nextFor(ctx: Ctx, a: AttemptBody, caller: string, roles: ReadonlySet<Role>, eligible: boolean): NextAction[] {
  return nextActionsFor(nextActionView(a, caller), roles, {
    bridgeHasModel: ctx.deps.model !== undefined, isLearner: samePrincipal(a.learner.address, caller), isAdmin: isAdmin(ctx, caller), eligible,
  });
}

function bridgeRoute(ctx: Ctx): Out {
  const m = ctx.deps.model;
  const route = m ? (m.route === 'scripted' ? 'scripted' : 'bridge-model') : 'none';
  return {
    counterpartRoute: route, judgeRoute: route,
    ...(m ? { provider: m.provider, requestedModel: m.requestedModel } : {}),
    keyKind: ctx.deps.platformKeyKind, platformAddress: ctx.platform.address, demoSigning: ctx.deps.demoSigner !== undefined,
    servedPods: ctx.served ?? 'any public pod',
    ...(m ? { bridgeModelFor: ctx.deps.bridgeModelFor ?? 'anyone', modelCallsPerHour: ctx.modelBudget.limit } : {}),
    attemptsPerHour: ctx.attemptBudget.limit,
    interegoSignIn: interegoSignInOf(ctx),
  };
}

/**
 * What a client needs to sign a person in with their Interego account, or null when the route is
 * off: the relay, the identity host principals live on, the relay addresses this bridge trusts,
 * the agent prefix of its own web UI and whether chat agents may take decisive acts. It says what
 * the route trusts, because the answer is relay-attested, not user-held.
 */
function interegoSignInOf(ctx: Ctx): Out | null {
  if (!ctx.relayOn || ctx.relay === null) return null;
  return {
    authority: 'relay-delegated', relayUrl: ctx.deps.relayUrl ?? null, identityHost: ctx.relay.identityHost,
    relayAddresses: ctx.relay.relayAddresses, webUiAgentPrefix: WEB_UI_AGENT_PREFIX, chatAgentsDecide: ctx.deps.chatAgentsDecide === true,
    decisiveActs: [...DECISIVE_ACTS].map((k) => A[k]),
    decisiveWhenNotTheLearner: [...DECISIVE_ON_ANOTHERS_ATTEMPT].map((k) => A[k]),
    trust: 'Relay-attested, not user-held: the Interego relay signs for the agent of your signed-in session and the identity host says whose agent it is, so whoever holds the relay delegation key or controls the identity host can act as any person here. Records made this way carry authority relay-delegated.',
  };
}

// ═════════════════════════════════════════════════════════════════════════════════════════════
//  Roles: pev.register_role
// ═════════════════════════════════════════════════════════════════════════════════════════════

/** Refused when no admin can act: no admin address, and no admin DID that can sign in (the relay route on). */
function noAdmins(ctx: Ctx): void {
  if (ctx.admins.size === 0 && !(ctx.relayOn && ctx.adminDids.size > 0)) {
    throw decline(503, 'No admin is configured on this bridge (an address in PEV_ADMIN_ADDRESSES, or a person\'s Interego DID in PEV_ADMIN_DIDS with Interego sign-in on), so roles cannot change.',
      'no-admin-configured', { env: 'PEV_ADMIN_ADDRESSES' });
  }
}

async function registerRole(call: Call, args: Record<string, unknown>): Promise<Out> {
  const { ctx } = call;
  noAdmins(ctx);
  let address = '';
  let role: Role = 'reviewer';
  let change: 'add' | 'remove' = 'add';
  const s = await signedAct(call, args, 'registerRole', {
    write: true,
    checks: (p) => {
      // A member is a principal: an address, or a person's Interego DID on the identity host.
      if (!isPrincipal(p['address'], ctx.identityHost)) {
        throw decline(400, ctx.identityHost !== null
          ? `address must be an address 0x followed by 40 hex digits, or a person's Interego DID did:web:${ctx.identityHost}:users:<id>.`
          : 'address must be an address 0x followed by 40 hex digits (a person\'s Interego DID needs PEV_IDENTITY_HOST on this bridge).', 'address-format');
      }
      address = p['address'];
      if (typeof p['role'] !== 'string' || !(ROLES as readonly string[]).includes(p['role'])) {
        throw decline(400, `role must be one of ${ROLES.join(', ')}.`, 'role-unknown');
      }
      role = p['role'] as Role;
      if (p['change'] !== 'add' && p['change'] !== 'remove') throw decline(400, 'change must be add or remove.', 'change-unknown');
      change = p['change'];
    },
  });
  const reg = registryIri(s.pod);
  return locked(call, `${s.pod}|${reg}`, async () => {
    const h = await readHead(s.pod, reg, ctx.trusted, call.read, call.cache);
    if (h.head && (!isTrusted(h.head) || h.head.body.kind !== 'role-registry')) throw untrusted(h.head);
    if (!isAdmin(ctx, s.signer)) throw decline(403, 'Only an admin configured on this bridge (PEV_ADMIN_ADDRESSES, or PEV_ADMIN_DIDS for Interego sign-in) may change roles.', 'not-an-admin');
    const current = h.head && h.head.body.kind === 'role-registry' ? h.head.body : null;
    const nowMs = ctx.now().getTime();
    const window = 2 * ctx.maxAgeMs + 120_000;
    const recent: RecentEnvelope[] = (current?.recentEnvelopes ?? []).filter((e) => nowMs - Date.parse(e.at) <= window);
    if (recent.some((e) => e.payloadSha256 === s.payloadSha256) || current?.envelope.payloadSha256 === s.payloadSha256) {
      throw decline(409, 'This signed envelope was already applied to the role registry; sign a new one.', 'envelope-already-used');
    }
    const applied = applyRoleChange(current?.entries ?? [], address, role, change);
    if (!applied.changed) {
      return {
        registryIri: reg, descriptorUrl: h.head?.descriptorUrl ?? null, seq: current?.seq ?? 0,
        entries: current?.entries ?? [], changed: false,
      };
    }
    const at = iso(ctx);
    const body: RoleRegistryBody = {
      v: 1, kind: 'role-registry', podUrl: s.pod, keyKind: ctx.deps.platformKeyKind, platformSigner: ctx.platform.address, at,
      registryIri: reg, seq: h.seq, entries: applied.entries,
      change: { address, role, change, by: s.signerDid }, actor: s.actor, envelope: s.stored,
      recentEnvelopes: [...recent, { payloadSha256: s.payloadSha256, at }],
    };
    const w = await writeRecord(call, { pod: s.pod, body, seq: h.seq, prev: h.head, nonce: s.nonce });
    return { registryIri: reg, descriptorUrl: w.descriptorUrl, seq: h.seq, entries: applied.entries, changed: true, recorded: true };
  });
}

// ═════════════════════════════════════════════════════════════════════════════════════════════
//  Scenarios: author, draft (packet and model), ratify, list
// ═════════════════════════════════════════════════════════════════════════════════════════════

const PROBLEM_ORDER = ['assessment-use-undeclared', 'work-read-undeclared', 'pass-gate-needs-knowable-work'] as const;

function coercedScenario(raw: unknown): ScenarioSpec {
  const c = coerceScenario(raw);
  if ('value' in c) return c.value;
  const lead = PROBLEM_ORDER.find((code) => c.problems.some((x) => x.code === code));
  const first = c.problems.find((x) => x.code === lead) ?? c.problems[0];
  throw decline(400, first?.message ?? 'The scenario is incomplete.', lead ?? 'scenario-shape', undefined, { problems: c.problems });
}

function declaredAssistance(ctx: Ctx, s: Signed, spec: ScenarioSpec): DraftAssistance {
  const p = s.payload;
  const declared = p['draftAssistance'];
  const receipt = p['draftReceipt'];
  if (declared === undefined && receipt === undefined) {
    throw decline(400, 'Say whether an AI helped draft this; silence is not the same as unassisted.', 'draft-assistance-undeclared');
  }
  if (declared !== undefined && receipt !== undefined) {
    throw decline(400, 'A draft receipt already says who drafted this; send draftAssistance or draftReceipt, not both.', 'draft-assistance-twice');
  }
  if (receipt !== undefined) {
    const v = verifyDraftReceipt(receipt, ctx.trusted.addresses, s.signerDid, ctx.now());
    if (!v.ok) throw decline(400, `The draft receipt does not check out: ${v.why}.`, 'draft-receipt-not-verifiable');
    const d = v.payload.disclosure;
    return {
      used: true, measured: true, by: 'model', provider: d.provider, model: d.model, keySource: d.keySource, route: d.route,
      draftHash: v.payload.draftHash, editedAfterDraft: draftComparableHash(spec) !== v.payload.draftHash, receipt: v.stored,
    };
  }
  if (!isObj(declared) || typeof declared['used'] !== 'boolean') {
    throw decline(400, 'draftAssistance must say {used: true|false} and, when used, by own-agent, model or person.', 'draft-assistance-undeclared');
  }
  if (!declared['used']) return { used: false, declaredBy: s.signerDid };
  const by = declared['by'];
  if (by !== 'own-agent' && by !== 'model' && by !== 'person') {
    throw decline(400, 'draftAssistance.by must be own-agent, model or person.', 'draft-assistance-undeclared');
  }
  const provider = optText(declared, 'provider', 60);
  const model = optText(declared, 'model', 120);
  const note = optText(declared, 'note', 300);
  return {
    used: true, measured: false, declaredBy: s.signerDid, by,
    ...(provider !== undefined ? { provider } : {}), ...(model !== undefined ? { model } : {}), ...(note !== undefined ? { note } : {}),
  };
}

async function authorScenario(call: Call, args: Record<string, unknown>): Promise<Out> {
  const { ctx } = call;
  const s = await signedAct(call, args, 'authorScenario', { write: true });
  const roles = await rolesOn(call, s.pod);
  if (!roles.of(s.signer).has('author')) throw decline(403, 'Only an address registered as an author may write scenarios on this pod.', 'not-an-author');
  const status = s.payload['status'];
  if (status !== 'draft' && status !== 'published') throw decline(400, 'Say whether to save a draft or publish: status draft or published.', 'status-undeclared');
  const spec = coercedScenario(s.payload['scenario']);
  const assistance = declaredAssistance(ctx, s, spec);
  const basedOn = s.payload['basedOnVersion'];
  const iri = scenarioIriOf(s.pod, spec.scenarioKey);
  return locked(call, `${s.pod}|${iri}`, async () => {
    const h = await readHead(s.pod, iri, ctx.trusted, call.read, call.cache);
    if (h.head && (!isTrusted(h.head) || h.head.body.kind !== 'scenario')) throw untrusted(h.head);
    const head = h.head && h.head.body.kind === 'scenario' ? h.head.body : null;
    if (!head && basedOnVersion(basedOn) !== null) {
      throw decline(409, 'This scenario does not exist yet; leave basedOnVersion out for its first version.', 'scenario-changed');
    }
    if (head && basedOnVersion(basedOn) !== head.version) {
      throw decline(409, `This scenario is at version ${head.version}; read it again and send basedOnVersion ${head.version}.`, 'scenario-changed',
        undefined, { currentVersion: head.version });
    }
    const hash = scenarioHash(spec);
    const sameContent = head !== null && head.scenarioHash === hash;
    if (head && sameContent && status === head.status) {
      return { ...scenarioView(h.head!, head), modalStatus: modalFor(head), descriptorUrl: h.head!.descriptorUrl, rubricChanged: false, statusChanged: false, changed: false };
    }
    if (head && sameContent && status === 'draft') {
      throw decline(409, `Version ${head.version} is already ${head.status}; a published version does not go back to draft. Change the content to start a new version.`, 'scenario-already-published');
    }
    if (head && sameContent && head.status === 'ratified') {
      return { ...scenarioView(h.head!, head), modalStatus: modalFor(head), descriptorUrl: h.head!.descriptorUrl, rubricChanged: false, statusChanged: false, changed: false };
    }
    const version = head ? (sameContent ? head.version : head.version + 1) : 1;
    const rh = rubricHash(spec.rubric);
    const keep = head && sameContent && head.draftAssistance.used && head.draftAssistance.measured;
    const versionAuthors = head && sameContent
      ? (head.versionAuthors.some((x) => samePrincipal(x, s.signer)) ? head.versionAuthors : [...head.versionAuthors, s.signer])
      : [s.signer];
    const at = iso(ctx);
    const body: ScenarioBody = {
      v: 1, kind: 'scenario', podUrl: s.pod, keyKind: ctx.deps.platformKeyKind, platformSigner: ctx.platform.address, at,
      scenarioIri: iri, version, status: status as ScenarioStatus, scenario: spec, scenarioHash: hash, rubricHash: rh,
      rubricIri: rubricIriOf(rh),
      criterionContentHashes: Object.fromEntries(spec.rubric.criteria.map((c) => [c.id, criterionContentHash(c)])),
      actor: s.actor, versionAuthors, draftAssistance: keep ? head.draftAssistance : assistance, envelope: s.stored,
    };
    const w = await writeRecord(call, { pod: s.pod, body, seq: h.seq, prev: h.head, nonce: s.nonce });
    return {
      scenarioIri: iri, version, status, modalStatus: modalFor(body), scenarioHash: hash, rubricHash: rh, rubricIri: body.rubricIri,
      descriptorUrl: w.descriptorUrl, ...(h.head ? { supersedes: h.head.descriptorUrl } : {}),
      rubricChanged: head !== null && head.rubricHash !== rh, statusChanged: head !== null && head.status !== status,
      draftAssistance: body.draftAssistance, assessmentUse: spec.assessmentUse, workRegime: spec.workRegime,
      ratified: false, changed: true, recorded: true,
    };
  });
}

function basedOnVersion(v: unknown): number | null {
  return typeof v === 'number' && Number.isInteger(v) && v >= 1 ? v : null;
}

async function draftScenarioPacket(_call: Call, args: Record<string, unknown>): Promise<Out> {
  const brief = typeof args['brief'] === 'string' ? args['brief'].trim() : '';
  if (brief === '') throw decline(400, 'Describe the performance situation to practise in brief.', 'brief-missing');
  if (brief.length > BRIEF_MAX) throw decline(400, `brief must be at most ${BRIEF_MAX} characters.`, 'brief-too-long');
  if (!isWellFormedText(brief)) throw notWellFormed('brief');
  const source = typeof args['source_text'] === 'string' ? args['source_text'] : undefined;
  if (source !== undefined && source.length > SOURCE_TEXT_MAX) throw decline(400, `source_text must be at most ${SOURCE_TEXT_MAX} characters.`, 'source-text-too-long');
  if (source !== undefined && !isWellFormedText(source)) throw notWellFormed('source_text');
  return { ...draftPacket(brief, source) };
}

async function draftScenario(call: Call, args: Record<string, unknown>): Promise<Out> {
  const { ctx } = call;
  const s = await signedAct(call, args, 'draftScenario', { nonce: true });
  const roles = await rolesOn(call, s.pod);
  if (!roles.of(s.signer).has('author')) throw decline(403, 'Only an address registered as an author may draft scenarios on this pod.', 'not-an-author');
  const brief = typeof s.payload['brief'] === 'string' ? s.payload['brief'].trim() : '';
  if (brief === '') throw decline(400, 'Describe the performance situation to practise in brief.', 'brief-missing');
  if (brief.length > BRIEF_MAX) throw decline(400, `brief must be at most ${BRIEF_MAX} characters.`, 'brief-too-long');
  const sourceText = optText(s.payload, 'sourceText', SOURCE_TEXT_MAX);
  const model = routeFor(call, args, { action: A.draftScenarioPacket, then: A.authorScenario }, { signer: s.signer, roles: roles.of(s.signer) });
  const r = await callModel(model, draftRequest(brief, sourceText), ctx.timeouts.draft);
  const disclosure = disclosureOf(model, r, DRAFT_PROMPT_TEMPLATE_HASH);
  const parsed = parseDraftText(r.text);
  if (!('value' in parsed)) {
    throw decline(502, 'The model\'s draft does not fit the scenario rules; nothing was recorded and nothing was repaired.', 'draft-output-unusable',
      undefined, { problems: parsed.problems, text: r.text.slice(0, 300), disclosure });
  }
  if (illFormedAt(parsed.value, 'draft') !== null) {
    throw decline(502, 'The model\'s draft holds text that is not well-formed UTF-16, which no record could hold as sent; nothing was recorded and nothing was repaired.', 'draft-output-unusable',
      undefined, { disclosure });
  }
  const draftHash = draftComparableHash(parsed.value);
  const receipt = await signDraftReceipt(ctx.platform, { draftHash, disclosure, requestedBy: s.signerDid, issuedAt: iso(ctx), nonce: ctx.nonce() });
  return { draft: parsed.value, draftHash, disclosure, receipt, instructions: draftReviewNote(model.route) };
}

async function ratifyScenario(call: Call, args: Record<string, unknown>): Promise<Out> {
  const { ctx } = call;
  const s = await signedAct(call, args, 'ratifyScenario', {
    write: true,
    checks: (p) => {
      needText(p, 'scenarioIri', 200);
      needInt(p, 'version', 1, 1_000_000);
      needText(p, 'scenarioHash', 64);
    },
  });
  const iri = String(s.payload['scenarioIri']);
  return locked(call, `${s.pod}|${iri}`, async () => {
    const h = await scenarioHead(call, s.pod, iri);
    if (!h) throw decline(404, 'No scenario with this IRI is on this pod.', 'scenario-not-found');
    const b = h.body;
    const roles = (await rolesOn(call, s.pod)).of(s.signer);
    if (b.versionAuthors.some((x) => samePrincipal(x, s.signer))) {
      throw decline(403, 'An author of this version cannot ratify it; another reviewer must.', 'ratifier-is-the-author');
    }
    if (ctx.trusted.addresses.has(principalKey(s.signer))) throw decline(403, 'The platform key cannot ratify a rubric.', 'ratifier-is-the-platform');
    if (!roles.has('reviewer')) throw decline(403, 'Only an address registered as a reviewer may ratify a rubric.', 'not-a-reviewer');
    if (roles.has('agent')) throw decline(403, 'A person must ratify a rubric; this address is registered as an agent.', 'agent-cannot-ratify');
    if (s.payload['version'] !== b.version || s.payload['scenarioHash'] !== b.scenarioHash) {
      throw decline(409, `The scenario is at version ${b.version} with a different content hash; read it again.`, 'scenario-revised', undefined, { currentVersion: b.version });
    }
    if (b.status === 'draft') throw decline(409, 'A draft cannot be ratified; the author publishes it first.', 'scenario-not-published');
    if (b.status === 'ratified') throw decline(409, 'This version is already ratified.', 'scenario-already-ratified');
    const at = iso(ctx);
    const body: ScenarioBody = {
      ...b, at, status: 'ratified', actor: s.actor, envelope: s.stored,
      ratification: { reviewer: s.actor, at, envelope: s.stored },
    };
    const w = await writeRecord(call, { pod: s.pod, body, seq: h.seq, prev: h.rec, nonce: s.nonce });
    return {
      scenarioIri: iri, version: b.version, status: 'ratified', modalStatus: 'Asserted', descriptorUrl: w.descriptorUrl,
      supersedes: h.rec.descriptorUrl, ratifiedBy: s.signerDid, recorded: true,
    };
  });
}

/**
 * What a scenario list carries for the scenario heads it could not open: their count, apart from
 * the untrusted, and what opens them. The list is then not the whole pod (`complete: false`).
 */
function sealedScenariosMark(n: number): Out {
  return {
    count: n, resolvedBy: { env: 'PEV_RECORD_KEY' },
    note: `${n} scenario record(s) on this pod are sealed to a record key this bridge does not hold, or it holds none; they are not in this list, so a scenario missing from it may be one of them. If the key that wrote them is the operator's record key, set PEV_RECORD_KEY to it.`,
  };
}

async function listScenarios(call: Call, args: Record<string, unknown>): Promise<Out> {
  const { ctx } = call;
  const pod = await readPod(ctx, args);
  const one = typeof args['scenario_iri'] === 'string' && args['scenario_iri'].trim() !== '' ? args['scenario_iri'].trim() : null;
  if (one) {
    const mismatch = keyMismatchIn(ctx, keyMarksOf(await podEntries(pod, call.read, call.cache), pod));
    let h: ScenarioHead | null;
    let chain: readonly (ReadRecord | DeletedVersion)[];
    try {
      h = await scenarioHead(call, pod, one);
      chain = h ? await readChain(pod, one, ctx.trusted, call.read, call.cache) : [];
    } catch (e) {
      // A scenario sealed on a pod whose records are under another key: the refusal names both keys.
      if (mismatch && e instanceof RecordSealed) throw keyMismatchDecline(ctx, mismatch);
      throw e;
    }
    if (!h) throw decline(404, 'No scenario with this IRI is on this pod.', 'scenario-not-found');
    const versions = chain.flatMap((v) => (!isDeleted(v) && isTrusted(v) && v.body.kind === 'scenario'
      ? [{ version: v.body.version, status: v.body.status, descriptorUrl: v.descriptorUrl, rubricHash: v.body.rubricHash, at: v.body.at }] : []));
    return {
      podUrl: pod,
      scenario: { ...scenarioView(h.rec, h.body), counterpart: h.body.scenario.counterpart, endsWhen: h.body.scenario.endsWhen },
      versions, ...(mismatch ? { recordKeyMismatch: keyMismatchMark(ctx, mismatch) } : {}), bridge: bridgeRoute(ctx),
    };
  }
  const drafts = args['include_drafts'] === true || args['include_drafts'] === 'true';
  const read = await readHeadsOfKind(pod, 'scenario', ctx.trusted, { max: 500, fetchFn: call.read, cache: call.cache });
  const scenarios = read.records
    .flatMap((r) => (r.body.kind === 'scenario' && (drafts || r.body.status !== 'draft') ? [scenarioView(r, r.body)] : []))
    .sort((x, y) => String(x['title']).localeCompare(String(y['title'])));
  const mismatch = keyMismatchIn(ctx, read.keyMarks);
  return {
    podUrl: pod, scenarios, untrustedRecordsSkipped: read.untrusted + read.forked, sealedRecordsSkipped: read.sealed, complete: read.complete,
    ...(read.sealed > 0 ? { sealedRecords: sealedScenariosMark(read.sealed) } : {}),
    ...readLimitMark(call, read.readLimitReached),
    ...(mismatch ? { recordKeyMismatch: keyMismatchMark(ctx, mismatch) } : {}),
    bridge: bridgeRoute(ctx),
  };
}

// ═════════════════════════════════════════════════════════════════════════════════════════════
//  Practice: start, say, packets, record turns, end
// ═════════════════════════════════════════════════════════════════════════════════════════════

async function startAttempt(call: Call, args: Record<string, unknown>): Promise<Out> {
  const { ctx } = call;
  const s = await signedAct(call, args, 'startAttempt', {
    write: true,
    checks: (p) => {
      if (typeof p['coached'] !== 'boolean') throw decline(400, 'Say whether you are coached (true or false); silence is not the same as unassisted.', 'coached-undeclared');
      needText(p, 'scenarioIri', 200);
      needInt(p, 'scenarioVersion', 1, 1_000_000);
      optText(p, 'assistance', 300);
    },
  });
  const sIri = String(s.payload['scenarioIri']);
  const h = await scenarioHead(call, s.pod, sIri);
  if (!h) throw decline(404, 'No scenario with this IRI is on this pod.', 'scenario-not-found');
  const roles = await rolesOn(call, s.pod);
  const sb = h.body;
  if (s.payload['scenarioVersion'] !== sb.version) {
    throw decline(409, `The scenario is now at version ${sb.version}; read the scenario again.`, 'scenario-revised', undefined, { currentVersion: sb.version });
  }
  const isAuthor = sb.versionAuthors.some((x) => samePrincipal(x, s.signer));
  if (sb.status === 'draft' && !isAuthor) throw decline(409, 'This scenario is a draft; learners start published versions only.', 'scenario-not-published');
  // With a record key the new attempt's IRI is keyed (only a key holder can link it to the
  // learner); attempts started before the key keep their plain key and are still this learner's.
  const keys = attemptKeysOf(ctx, s.pod, sIri, s.signer);
  const key = keys[0]!;
  return locked(call, `${s.pod}|attempts|${key}`, async () => {
    const all = await podEntries(s.pod, call.read, call.cache);
    // This lookup is by learner: on the manifest it is made from, every record must be under this
    // bridge's key (or plaintext), or her attempts under another key would read as none.
    const mismatch = keyMismatchIn(ctx, keyMarksOf(all, s.pod));
    if (mismatch) throw keyMismatchDecline(ctx, mismatch);
    const prefixes = keys.map((k) => `urn:pev:attempt:${k}-`);
    const mine = [...new Set(all.flatMap((e) => e.describes.filter((d) => prefixes.some((p) => d.startsWith(p)))))];
    await notAStartedEnvelope(call, s, all, mine);
    const taken = ctx.attemptBudget.take(s.signer, ctx.now().getTime());
    if (!taken.ok) {
      throw decline(429,
        taken.scope === 'signer'
          ? `You have started ${ctx.attemptBudget.limit.perSigner} attempts in the last hour; try again in ${taken.retryAfterSeconds} s.`
          : `${ctx.attemptBudget.limit.total} attempts have been started on this bridge in the last hour; try again in ${taken.retryAfterSeconds} s.`,
        'attempt-budget-spent', undefined, { scope: taken.scope, retryAfterSeconds: taken.retryAfterSeconds });
    }
    // The sealed attemptNumber counts every attempt of hers on this scenario, under either key.
    // The IRI is numbered within its own series only: a keyed series always starts at 1, so how
    // many plain attempts she had (which anyone holding her address can count) picks out no series.
    const n = mine.length + 1;
    const iri = attemptIriOf(key, mine.filter((g) => g.startsWith(prefixes[0]!)).length + 1);
    const at = iso(ctx);
    const spec = sb.scenario;
    const assistance = typeof s.payload['assistance'] === 'string' && s.payload['assistance'] !== '' ? s.payload['assistance'] : undefined;
    const first: Turn = { index: 0, speaker: 'counterpart', text: spec.firstLine, textSha256: sha256(spec.firstLine), at, source: 'authored-first-line' };
    const body: AttemptBody = {
      v: 1, kind: 'attempt', podUrl: s.pod, keyKind: ctx.deps.platformKeyKind, platformSigner: ctx.platform.address, at,
      attemptIri: iri, state: 'in-conversation', evidenceKind: 'practice',
      scenario: {
        scenarioIri: sIri, version: sb.version, scenarioHash: sb.scenarioHash, rubricHash: sb.rubricHash,
        descriptorUrl: h.rec.descriptorUrl, title: spec.title, statusAtStart: sb.status,
      },
      scenarioSpec: spec,
      learner: { ...s.actor, kind: roles.of(s.signer).has('agent') ? 'agent' : 'person' },
      attemptNumber: n, coached: s.payload['coached'] === true, ...(assistance !== undefined ? { assistance } : {}),
      authorTest: isAuthor, startedAt: at, turns: [first], counterpartControlledBy: 'platform',
      judgments: [], reviews: [], reopenings: [], startEnvelope: s.stored, acts: [actOf(s, 'startAttempt')],
    };
    const w = await writeRecord(call, { pod: s.pod, body, seq: 1, prev: null, nonce: s.nonce });
    return {
      attemptIri: iri, descriptorUrl: w.descriptorUrl, state: body.state, attemptNumber: n, coached: body.coached,
      authorTest: body.authorTest, learnerKind: body.learner.kind, assessmentUse: spec.assessmentUse,
      rubricRatified: sb.status === 'ratified', scenario: body.scenario, turns: body.turns, nextTurnIndex: 1, turnLimit: spec.turnLimit,
      routes: { bridgeModel: ctx.deps.model !== undefined, counterpartPacket: true },
      nextActions: nextFor(ctx, body, s.signer, roles.of(s.signer), false), recorded: true,
    };
  });
}

/**
 * The attempt keys one learner's attempts on one scenario can carry, the one new attempts take
 * first: the keyed form (with a record key), then the plain form attempts written without one have.
 */
function attemptKeysOf(ctx: Ctx, pod: string, scenarioIriValue: string, learner: string): string[] {
  const plain = attemptKey(pod, scenarioIriValue, learner);
  return ctx.attemptSecret === null ? [plain] : [attemptKey(pod, scenarioIriValue, learner, ctx.attemptSecret), plain];
}

/**
 * Refuse a start envelope that already started one of this learner's attempts on this scenario.
 * Only attempts with a version inside the replay window are read: an older envelope fails the
 * freshness check anyway.
 */
async function notAStartedEnvelope(call: Call, s: Signed, all: readonly ManifestEntry[], mine: readonly string[]): Promise<void> {
  const since = call.ctx.now().getTime() - (2 * call.ctx.maxAgeMs + 120_000);
  const recent = mine.filter((g) => all.some((e) => e.describes.includes(g) && (e.validFrom === undefined || Date.parse(e.validFrom) >= since)));
  for (const g of recent) {
    const h = await readHead(s.pod, g, call.ctx.trusted, call.read, call.cache);
    if (h.head && h.head.body.kind === 'attempt' && h.head.body.acts.some((x) => x.payloadSha256 === s.payloadSha256)) {
      throw decline(409, 'This signed envelope already started an attempt; sign a new one.', 'envelope-already-used');
    }
  }
}

/** Steps 5–7 shared by every learner act during the conversation. */
async function conversationHead(call: Call, s: Signed, iri: string, turnIndex: number): Promise<AttemptHead> {
  const h = await attemptHead(call, s.pod, iri);
  if (!samePrincipal(h.body.learner.address, s.signer)) throw decline(403, 'Only the learner of this attempt may do this.', 'not-the-learner');
  notReplayed(h.body, s);
  if (h.body.state !== 'in-conversation') {
    throw decline(409, `This attempt is ${h.body.state}; the conversation is over.`, 'attempt-not-in-conversation', undefined, { state: h.body.state });
  }
  if (turnIndex !== h.body.turns.length) {
    throw decline(409, `The next turn is ${h.body.turns.length}; read the attempt again.`, 'turn-out-of-order', undefined, { nextTurnIndex: h.body.turns.length });
  }
  return h;
}

/** Append one exchange and apply the end rules (§6.4). */
function withExchange(a: AttemptBody, learner: Turn, counterpart: Turn, endAfter: boolean, act: AttemptAct, at: string): AttemptBody {
  const turns = [...a.turns, learner, counterpart];
  const { endProposedAtTurn: _cleared, ...rest } = a;
  const learnerTurns = learnerTurnCount(turns);
  let ending: Partial<AttemptBody> = {};
  if (endAfter) ending = { endedBy: 'learner' };
  else if (learnerTurns >= a.scenarioSpec.turnLimit) ending = { endedBy: 'turn-limit' };
  const ended = ending.endedBy !== undefined;
  return {
    ...rest, at, turns, counterpartControlledBy: counterpartControl(turns), acts: [...a.acts, act],
    ...(ended
      ? { state: 'ended', endedBy: ending.endedBy, endedAt: at, transcriptHash: transcriptHash(turns) }
      : counterpart.endSignal ? { endProposedAtTurn: counterpart.index } : {}),
  } as AttemptBody;
}

function exchangeOut(ctx: Ctx, s: Signed, body: AttemptBody, w: Written, learner: Turn, counterpart: Turn, roles: ReadonlySet<Role>): Out {
  const ended = body.state === 'ended';
  return {
    attemptIri: body.attemptIri, descriptorUrl: w.descriptorUrl, state: body.state,
    learnerTurn: { index: learner.index, text: learner.text },
    counterpartTurn: { index: counterpart.index, text: counterpart.text, disclosure: counterpart.disclosure, endSignal: counterpart.endSignal === true },
    endProposed: body.endProposedAtTurn !== undefined, nextTurnIndex: body.turns.length, ended,
    ...(ended ? { endedBy: body.endedBy, transcriptHash: body.transcriptHash } : {}),
    counterpartControlledBy: body.counterpartControlledBy, currentTarget: { recordId: w.recordId, descriptorUrl: w.descriptorUrl, graphDigest: w.graphDigest },
    nextActions: nextFor(ctx, body, s.signer, roles, false), recorded: true,
  };
}

async function say(call: Call, args: Record<string, unknown>): Promise<Out> {
  const { ctx } = call;
  let turnIndex = 0;
  let text = '';
  let endAfter = false;
  const s = await signedAct(call, args, 'say', {
    write: true,
    checks: (p) => {
      needAttemptIri(p);
      turnIndex = needInt(p, 'turnIndex', 1, 10_000);
      text = needText(p, 'text', TURN_TEXT_MAX);
      endAfter = optBool(p, 'endAfter');
    },
  });
  const iri = needAttemptIri(s.payload);
  return locked(call, `${s.pod}|${iri}`, async () => {
    const h = await conversationHead(call, s, iri, turnIndex);
    const roles = (await rolesOn(call, s.pod)).of(s.signer);
    const model = routeFor(call, args, { action: A.counterpartPacket, then: A.recordTurns }, { signer: s.signer, roles });
    const r = await callModel(model, counterpartRequest(h.body.scenarioSpec, h.body.turns, text), ctx.timeouts.counterpart);
    const disclosure = disclosureOf(model, r, COUNTERPART_PROMPT_TEMPLATE_HASH);
    const split = splitEndSignal(r.text);
    if (split.text === '' && !split.endSignal) {
      throw decline(502, 'The model returned an empty line with no end signal; nothing was recorded.', 'model-output-empty', undefined, { disclosure });
    }
    const learner: Turn = { index: turnIndex, speaker: 'learner', text, textSha256: sha256(text), at: s.at, source: 'learner-signed', envelope: s.stored };
    const at = iso(ctx);
    const counterpart: Turn = {
      index: turnIndex + 1, speaker: 'counterpart', text: split.text, textSha256: sha256(split.text), at,
      source: model.route === 'scripted' ? 'scripted' : 'bridge-model', ...(split.endSignal ? { endSignal: true } : {}), disclosure,
    };
    const body = withExchange(h.body, learner, counterpart, endAfter, actOf(s, 'say'), at);
    const w = await writeRecord(call, { pod: s.pod, body, seq: h.seq, prev: h.rec, nonce: s.nonce, disclosure });
    return exchangeOut(ctx, s, body, w, learner, counterpart, roles);
  });
}

async function counterpartPacketAct(call: Call, args: Record<string, unknown>): Promise<Out> {
  let turnIndex = 0;
  let learnerText = '';
  const s = await signedAct(call, args, 'counterpartPacket', {
    checks: (p) => {
      needAttemptIri(p);
      turnIndex = needInt(p, 'turnIndex', 1, 10_000);
      learnerText = needText(p, 'learnerText', TURN_TEXT_MAX);
    },
  });
  const iri = needAttemptIri(s.payload);
  const h = await conversationHead(call, s, iri, turnIndex);
  return { ...counterpartPacket(h.body.scenarioSpec, h.body.turns, learnerText, { podUrl: s.pod, attemptIri: iri, turnIndex }) };
}

async function recordTurns(call: Call, args: Record<string, unknown>): Promise<Out> {
  const { ctx } = call;
  let turnIndex = 0;
  let learnerText = '';
  let endAfter = false;
  let split = { text: '', endSignal: false };
  let declared = { provider: '', model: '' };
  const s = await signedAct(call, args, 'recordTurns', {
    write: true,
    checks: (p) => {
      needAttemptIri(p);
      turnIndex = needInt(p, 'turnIndex', 1, 10_000);
      learnerText = needText(p, 'learnerText', TURN_TEXT_MAX);
      endAfter = optBool(p, 'endAfter');
      const d = p['counterpartDisclosure'];
      if (!isObj(d) || typeof d['provider'] !== 'string' || d['provider'].trim() === '' || d['provider'].length > 60
        || typeof d['model'] !== 'string' || d['model'].trim() === '' || d['model'].length > 120
        || (d['agent'] !== undefined && (typeof d['agent'] !== 'string' || d['agent'].length > 200))) {
        throw decline(400, 'Declare who wrote the other person\'s line: counterpartDisclosure {provider (≤60), model (≤120), agent? (≤200)}.', 'counterpart-undeclared');
      }
      declared = { provider: d['provider'], model: d['model'] };
      const raw = p['counterpartText'];
      if (typeof raw !== 'string' || raw.length > TURN_TEXT_MAX) throw shape('counterpartText', `must be text of at most ${TURN_TEXT_MAX} characters`);
      split = splitEndSignal(raw);
      if (split.text === '' && !split.endSignal) {
        throw decline(400, 'The other person\'s line is empty; send their words, or (end of conversation) alone if they ended it.', 'counterpart-line-empty');
      }
    },
  });
  const iri = needAttemptIri(s.payload);
  return locked(call, `${s.pod}|${iri}`, async () => {
    const h = await conversationHead(call, s, iri, turnIndex);
    const roles = (await rolesOn(call, s.pod)).of(s.signer);
    const learner: Turn = { index: turnIndex, speaker: 'learner', text: learnerText, textSha256: sha256(learnerText), at: s.at, source: 'learner-signed', envelope: s.stored };
    const disclosure: InferenceDisclosure = {
      provider: declared.provider, model: declared.model, keySource: 'mcp-client', route: 'client-packet', declaredBy: s.signerDid,
    };
    const counterpart: Turn = {
      index: turnIndex + 1, speaker: 'counterpart', text: split.text, textSha256: sha256(split.text), at: s.at,
      source: 'client-packet', ...(split.endSignal ? { endSignal: true } : {}), disclosure,
    };
    const body = withExchange(h.body, learner, counterpart, endAfter, actOf(s, 'recordTurns'), iso(ctx));
    const w = await writeRecord(call, { pod: s.pod, body, seq: h.seq, prev: h.rec, nonce: s.nonce });
    return exchangeOut(ctx, s, body, w, learner, counterpart, roles);
  });
}

async function endConversation(call: Call, args: Record<string, unknown>): Promise<Out> {
  const { ctx } = call;
  let turnIndex = 0;
  const s = await signedAct(call, args, 'endConversation', {
    write: true,
    checks: (p) => { needAttemptIri(p); turnIndex = needInt(p, 'turnIndex', 1, 10_000); },
  });
  const iri = needAttemptIri(s.payload);
  return locked(call, `${s.pod}|${iri}`, async () => {
    const h = await conversationHead(call, s, iri, turnIndex);
    if (learnerTurnCount(h.body.turns) === 0) {
      throw decline(409, 'Say something first; an attempt with no learner line has nothing to judge.', 'no-learner-turns');
    }
    const roles = (await rolesOn(call, s.pod)).of(s.signer);
    const last = h.body.turns[h.body.turns.length - 1];
    const endedBy = h.body.endProposedAtTurn !== undefined && last !== undefined && h.body.endProposedAtTurn === last.index
      ? 'learner-confirmed-counterpart-end' : 'learner';
    const at = iso(ctx);
    const { endProposedAtTurn: _cleared, ...rest } = h.body;
    const body: AttemptBody = {
      ...rest, at, state: 'ended', endedBy, endedAt: at, transcriptHash: transcriptHash(h.body.turns), acts: [...h.body.acts, actOf(s, 'endConversation')],
    };
    const w = await writeRecord(call, { pod: s.pod, body, seq: h.seq, prev: h.rec, nonce: s.nonce });
    return {
      attemptIri: iri, descriptorUrl: w.descriptorUrl, state: 'ended', endedBy, transcriptHash: body.transcriptHash,
      currentTarget: { recordId: w.recordId, descriptorUrl: w.descriptorUrl, graphDigest: w.graphDigest },
      nextActions: nextFor(ctx, body, s.signer, roles, false), recorded: true,
    };
  });
}

// ═════════════════════════════════════════════════════════════════════════════════════════════
//  Judging: the bridge's model, the packet, a judge agent's record
// ═════════════════════════════════════════════════════════════════════════════════════════════

/** The state refusals shared by every judging act. */
function judgeable(a: AttemptBody): void {
  if (a.state === 'in-conversation') throw decline(409, 'End the conversation first.', 'attempt-not-ended');
  if (a.state === 'countersigned' || a.state === 'overridden') {
    throw decline(409, 'Judgments close once a person has reviewed; contest the review to reopen it.', 'attempt-already-reviewed');
  }
  if (a.state === 'redacted') throw decline(409, 'The transcript of this attempt was removed; it cannot be judged.', 'attempt-redacted');
  if (a.judgments.length >= MAX_JUDGMENTS) throw decline(409, `This attempt already has ${MAX_JUDGMENTS} judgments.`, 'judgment-limit');
}

function repeatOf(a: AttemptBody, judgeId: string, promptTemplateHash: string): number | null {
  const earlier = a.judgments.find((j) => j.judge.id === judgeId && j.promptTemplateHash === promptTemplateHash);
  return earlier ? earlier.index : null;
}

/** Write a judgment. `roles` are the signer's, read before: nothing after the write can refuse. */
async function recordJudgmentOn(call: Call, s: Signed, h: AttemptHead, j: JudgmentResult, key: PevActionKey, roles: ReadonlySet<Role>, disclosure?: InferenceDisclosure): Promise<Out> {
  const { ctx } = call;
  const a = h.body;
  const judgments = [...a.judgments, j];
  const body: AttemptBody = { ...a, at: j.judgedAt, state: a.state === 'ended' ? 'judged' : a.state, judgments, acts: [...a.acts, actOf(s, key)] };
  const w = await writeRecord(call, { pod: s.pod, body, seq: h.seq, prev: h.rec, nonce: s.nonce, ...(disclosure ? { disclosure } : {}) });
  const primary = judgments[0]!;
  return {
    attemptIri: a.attemptIri, descriptorUrl: w.descriptorUrl, state: body.state, modalStatus: modalFor(body), judgment: j,
    judgmentCount: judgments.length, agreement: agreementOf(a.scenarioSpec, judgments), provisional: primary.provisional,
    provisionalLabel: PROVISIONAL_LABEL, unverifiedCriteria: primary.unverifiedCriteria, nextSteps: nextStepsOf(body),
    currentTarget: { recordId: w.recordId, descriptorUrl: w.descriptorUrl, graphDigest: w.graphDigest },
    nextActions: nextFor(ctx, body, s.signer, roles, false), recorded: true,
  };
}

async function judgeAttempt(call: Call, args: Record<string, unknown>): Promise<Out> {
  const { ctx } = call;
  const s = await signedAct(call, args, 'judgeAttempt', { write: true, checks: (p) => { needAttemptIri(p); } });
  const iri = needAttemptIri(s.payload);
  return locked(call, `${s.pod}|${iri}`, async () => {
    const h = await attemptHead(call, s.pod, iri);
    const isLearner = samePrincipal(h.body.learner.address, s.signer);
    const roles = (await rolesOn(call, s.pod)).of(s.signer);
    if (!isLearner && !roles.has('reviewer')) throw decline(403, 'Only the learner or a reviewer may ask this bridge to judge an attempt.', 'not-learner-or-reviewer');
    notReplayed(h.body, s);
    judgeable(h.body);
    const model = routeFor(call, args, { action: A.judgePacket, then: A.recordJudgment }, { signer: s.signer, roles });
    const r = await callModel(model, judgeRequest(h.body.scenarioSpec, h.body.turns), ctx.timeouts.judge);
    const disclosure = disclosureOf(model, r, JUDGE_PROMPT_TEMPLATE_HASH);
    const parsed = parseJudgeText(r.text, h.body.scenarioSpec.rubric);
    if ('unusable' in parsed) {
      throw decline(502, `The judge's answer is not usable (${parsed.unusable}); nothing was recorded and nothing was repaired.`, 'judge-output-unusable',
        undefined, { text: r.text.slice(0, 300), disclosure });
    }
    // JSON escapes can still decode to a lone surrogate, which no record can hold as sent.
    if (illFormedAt(parsed, 'judgment') !== null) {
      throw decline(502, 'The judge\'s answer is not usable (it holds text that is not well-formed UTF-16); nothing was recorded and nothing was repaired.', 'judge-output-unusable',
        undefined, { disclosure });
    }
    const judgeId = `model:${model.provider}/${r.model}`;
    const chosenBy: JudgeChosenBy = model.keySource === 'per-request-byok' ? (isLearner ? 'learner' : 'reviewer') : 'bridge-config';
    const j = assembleJudgment(h.body.scenarioSpec, h.body.turns, parsed, {
      index: h.body.judgments.length, judgedAt: iso(ctx), judge: { id: judgeId, kind: 'model' }, disclosure, route: model.route,
      promptTemplateHash: JUDGE_PROMPT_TEMPLATE_HASH, chosenBy, requestedBy: { did: s.signerDid, role: isLearner ? 'learner' : 'reviewer' },
      repeatOf: repeatOf(h.body, judgeId, JUDGE_PROMPT_TEMPLATE_HASH), rubricHash: h.body.scenario.rubricHash,
      transcriptHash: h.body.transcriptHash ?? transcriptHash(h.body.turns),
    });
    return recordJudgmentOn(call, s, h, j, 'judgeAttempt', roles, disclosure);
  });
}

async function judgePacketAct(call: Call, args: Record<string, unknown>): Promise<Out> {
  const s = await signedAct(call, args, 'judgePacket', { checks: (p) => { needAttemptIri(p); } });
  const iri = needAttemptIri(s.payload);
  const h = await attemptHead(call, s.pod, iri);
  const roles = (await rolesOn(call, s.pod)).of(s.signer);
  if (!samePrincipal(h.body.learner.address, s.signer) && !roles.has('reviewer') && !roles.has('judge')) {
    throw decline(403, 'Only the learner, a reviewer or a registered judge may fetch the judge packet.', 'not-entitled');
  }
  judgeable(h.body);
  return {
    ...judgePacket(h.body.scenarioSpec, h.body.turns, {
      podUrl: s.pod, attemptIri: iri, attemptHeadUrl: h.rec.descriptorUrl,
      transcriptHash: h.body.transcriptHash ?? transcriptHash(h.body.turns), rubricHash: h.body.scenario.rubricHash,
    }),
  };
}

async function recordJudgment(call: Call, args: Record<string, unknown>): Promise<Out> {
  const { ctx } = call;
  let declared = { provider: '', model: '', usedPacketPrompt: false };
  const s = await signedAct(call, args, 'recordJudgment', {
    write: true,
    checks: (p) => {
      needAttemptIri(p);
      const d = p['judgeDisclosure'];
      if (!isObj(d) || typeof d['provider'] !== 'string' || d['provider'].trim() === '' || d['provider'].length > 60
        || typeof d['model'] !== 'string' || d['model'].trim() === '' || d['model'].length > 120 || typeof d['usedPacketPrompt'] !== 'boolean') {
        throw decline(400, 'Declare the judge: judgeDisclosure {provider (≤60), model (≤120), usedPacketPrompt: true|false}.', 'judge-undeclared');
      }
      declared = { provider: d['provider'], model: d['model'], usedPacketPrompt: d['usedPacketPrompt'] };
    },
  });
  const iri = needAttemptIri(s.payload);
  return locked(call, `${s.pod}|${iri}`, async () => {
    const h = await attemptHead(call, s.pod, iri);
    const roles = (await rolesOn(call, s.pod)).of(s.signer);
    if (samePrincipal(h.body.learner.address, s.signer)) throw decline(403, 'The learner cannot judge their own attempt.', 'judge-is-the-learner');
    if (!roles.has('judge')) throw decline(403, 'Only an address registered as a judge may record a judgment.', 'not-a-judge');
    notReplayed(h.body, s);
    judgeable(h.body);
    const a = h.body;
    const tHash = a.transcriptHash ?? transcriptHash(a.turns);
    if (s.payload['attemptHeadUrl'] !== h.rec.descriptorUrl || s.payload['transcriptHash'] !== tHash || s.payload['rubricHash'] !== a.scenario.rubricHash) {
      throw decline(409, 'This judgment is bound to a different version of the attempt; fetch a fresh judge packet.', 'binding-mismatch',
        undefined, { attemptHeadUrl: h.rec.descriptorUrl, transcriptHash: tHash, rubricHash: a.scenario.rubricHash });
    }
    const parsed = coerceJudgment(s.payload['judgment'], a.scenarioSpec.rubric);
    if ('unusable' in parsed) throw decline(400, `The judgment is not usable: ${parsed.unusable}.`, 'judgment-shape');
    const promptTemplateHash = declared.usedPacketPrompt ? JUDGE_PROMPT_TEMPLATE_HASH : 'own-prompt';
    const disclosure: InferenceDisclosure = {
      provider: declared.provider, model: declared.model, keySource: 'mcp-client', route: 'client-packet', declaredBy: s.signerDid, promptTemplateHash,
    };
    const judge = { id: s.signerDid, kind: roles.has('agent') ? 'agent' as const : 'person' as const, signer: s.signerDid };
    const j = assembleJudgment(a.scenarioSpec, a.turns, parsed, {
      index: a.judgments.length, judgedAt: iso(ctx), judge, disclosure, route: 'client-packet', promptTemplateHash,
      chosenBy: 'judge-registry', requestedBy: { did: s.signerDid, role: 'judge' },
      repeatOf: repeatOf(a, judge.id, promptTemplateHash), rubricHash: a.scenario.rubricHash, transcriptHash: tHash,
    });
    return recordJudgmentOn(call, s, h, j, 'recordJudgment', roles);
  });
}

// ═════════════════════════════════════════════════════════════════════════════════════════════
//  Review: queue, countersign, override, contest, retract
// ═════════════════════════════════════════════════════════════════════════════════════════════

/**
 * The trusted head of every attempt on the pod, for an answer computed from all of them (`what`:
 * the review queue, a list of attempts, results, calibration). Every such answer is a count or a
 * list that would read an attempt this bridge cannot see as absent (nothing awaiting review, no
 * attempt of the signer's, a figure without it), so it is refused (409) rather than computed when
 * the pod's own records name another record key (`record-key-mismatch`: keyed attempt IRIs or
 * sealed records' marks, read from the manifest before any head), or, where a sealed head carries
 * no mark, when any attempt head is sealed to a record key this bridge does not hold
 * (`records-sealed`); both name PEV_RECORD_KEY. Untrusted and forked heads, and heads over the
 * read limit, are skipped and counted.
 */
async function attemptBodies(call: Call, pod: string, what: string): Promise<{
  readonly heads: readonly ReadRecord[]; readonly bodies: readonly AttemptBody[]; readonly untrusted: number; readonly complete: boolean;
  /** `readLimitReached` (with the act's limit and why) when the act's read budget left heads unread; else nothing. */
  readonly limit: Out;
}> {
  const read = await readHeadsOfKind(pod, 'attempt', call.ctx.trusted, {
    max: 2000, fetchFn: call.read, cache: call.cache,
    beforeReading: (marks) => {
      const mismatch = keyMismatchIn(call.ctx, marks);
      if (mismatch) throw keyMismatchDecline(call.ctx, mismatch);
    },
  });
  if (read.sealed > 0) throw sealedDecline(read.sealed, what);
  const heads = read.records.filter((r) => r.body.kind === 'attempt');
  return {
    heads, bodies: heads.map((r) => r.body as AttemptBody), untrusted: read.untrusted + read.forked, complete: read.complete,
    limit: readLimitMark(call, read.readLimitReached),
  };
}

/**
 * What a listing carries when the act's read budget ran out before it had read every head: the
 * limit, and that the answer is not the whole pod (it also says `complete: false`).
 */
function readLimitMark(call: Call, reached: boolean): Out {
  if (!reached) return {};
  const bytes = call.ctx.actReadBudgetBytes;
  return {
    readLimitReached: {
      bytes,
      note: `This answer stopped reading the pod at ${bytes} bytes, the most this bridge reads for one act, so it is not the whole pod. Records this bridge has read and checked are reused for a while, so asking again can read further; no record this bridge writes is that large, so someone who can write the pod may have planted large files.`,
    },
  };
}

function cellsFor(ctx: Ctx, pod: string, bodies: readonly AttemptBody[], groupBy: 'rubric-version' | 'criterion-content'): { cells: CalibrationCellView[]; outcomes: number } {
  const counted = bodies.filter((a) => !a.authorTest);
  const rows = counted.flatMap((a) => outcomeRowsOf(a));
  return {
    cells: calibrationCells(rows, { platformDid: ctx.platformDid, manifestUrl: predictManifestUrl(pod), now: ctx.now(), groupBy, auditCoverage: auditCoverageOf(counted) }),
    outcomes: rows.length,
  };
}

async function reviewQueueAct(call: Call, args: Record<string, unknown>): Promise<Out> {
  const { ctx } = call;
  let limit = 20;
  const s = await signedAct(call, args, 'reviewQueue', {
    checks: (p) => { if (p['limit'] !== undefined) limit = needInt(p, 'limit', 1, 100); },
  });
  const roles = (await rolesOn(call, s.pod)).of(s.signer);
  if (!roles.has('reviewer')) throw decline(403, 'Only an address registered as a reviewer may read the review queue.', 'not-a-reviewer');
  const read = await attemptBodies(call, s.pod, 'the review queue (what awaits review)');
  const { cells } = cellsFor(ctx, s.pod, read.bodies, 'rubric-version');
  const candidates: QueueCandidate[] = read.heads.flatMap((r) => {
    const a = r.body as AttemptBody;
    if (a.authorTest || (a.state !== 'judged' && a.state !== 'contested' && a.state !== 'review-retracted')) return [];
    const primary = a.judgments[0];
    if (!primary) return [];
    return [{
      attemptIri: a.attemptIri, state: a.state, judgedAt: primary.judgedAt, scenarioSpec: a.scenarioSpec, rubricHash: a.scenario.rubricHash,
      judgments: a.judgments, counterpartControlledBy: a.counterpartControlledBy, learnerDid: a.learner.did,
      excludedReviewers: conflictedReviewersOf(a),
      currentTarget: targetOf(r), authorTest: a.authorTest,
    }];
  });
  const q = reviewQueue(candidates, cells, { limit, reviewer: s.signer });
  const entries = q.entries.map((e) => {
    const { scenarioSpec, ...rest } = e;
    const primary = e.judgments[0];
    return {
      ...rest, scenarioTitle: scenarioSpec.title, assessmentUse: scenarioSpec.assessmentUse,
      judges: e.judgments.map((j) => ({ index: j.index, judgeId: j.judge.id, kind: j.judge.kind, route: j.route, chosenBy: j.chosenBy, repeatOf: j.repeatOf })),
      provisional: primary?.provisional ?? null, unverifiedCriteria: primary?.unverifiedCriteria ?? [],
      agreement: agreementOf(scenarioSpec, e.judgments), rubric: scenarioSpec.rubric,
    };
  });
  return {
    podUrl: s.pod, entries, awaitingReview: q.awaitingReview, excludedAsConflicted: q.excludedAsConflicted, weights: q.weights,
    computedAt: iso(ctx), attemptsRead: read.heads.length, untrustedRecordsSkipped: read.untrusted, complete: read.complete, ...read.limit,
  };
}

interface LevelPick { readonly criterionId: string; readonly levelId: string; readonly why?: string }

function levelPicks(p: P): LevelPick[] {
  const raw = p['levels'];
  const bad = decline(400, 'levels must list {criterionId, levelId, why?} for every criterion of the rubric, each exactly once.', 'levels-incomplete');
  if (!Array.isArray(raw)) throw bad;
  return (raw as unknown[]).map((x) => {
    if (!isObj(x) || typeof x['criterionId'] !== 'string' || typeof x['levelId'] !== 'string') throw bad;
    const why = x['why'];
    if (why !== undefined && (typeof why !== 'string' || why.length > 1000)) throw bad;
    return { criterionId: x['criterionId'], levelId: x['levelId'], ...(typeof why === 'string' && why.trim() !== '' ? { why } : {}) };
  });
}

/** Steps 5–8 shared by countersign and override. */
async function reviewable(call: Call, s: Signed, iri: string, picks: readonly LevelPick[]): Promise<{ h: AttemptHead; primary: JudgmentResult; roles: ReadonlySet<Role> }> {
  const { ctx } = call;
  const h = await attemptHead(call, s.pod, iri);
  const a = h.body;
  const me = principalKey(s.signer);
  const roles = (await rolesOn(call, s.pod)).of(s.signer);
  if (principalKey(a.learner.address) === me) throw decline(403, 'The learner cannot review their own attempt.', 'reviewer-is-the-learner');
  if (judgeSignersOf(a).includes(me)) throw decline(403, 'A judge of this attempt cannot review it.', 'reviewer-is-the-judge');
  if (conflictedReviewersOf(a).includes(me) && !a.reviews.some((r) => principalKey(r.reviewer.address) === me)) {
    throw decline(403, 'You asked for the judgment a countersign would confirm, or had this attempt judged by a model you chose with your own key; another reviewer must review it.', 'reviewer-requested-the-judgment');
  }
  if (ctx.trusted.addresses.has(me)) throw decline(403, 'The platform key cannot review an attempt.', 'reviewer-is-the-platform');
  if (a.reviews.some((r) => principalKey(r.reviewer.address) === me)) {
    throw decline(403, 'You reviewed this attempt before; another reviewer must look at it again.', 'reviewer-already-reviewed');
  }
  if (!roles.has('reviewer')) throw decline(403, 'Only an address registered as a reviewer may review an attempt.', 'not-a-reviewer');
  if (roles.has('agent')) throw decline(403, 'A person must countersign; this address is registered as an agent.', 'agent-cannot-countersign');
  if (a.authorTest) throw decline(409, 'An author trying their own scenario is a test; tests are not reviewed.', 'author-test-attempt');
  if (a.state !== 'judged' && a.state !== 'contested' && a.state !== 'review-retracted') {
    throw decline(409, `This attempt is ${a.state}; only a judged, contested or withdrawn-review attempt can be reviewed.`, 'attempt-not-judged', undefined, { state: a.state });
  }
  notReplayed(a, s);
  checkTarget(needTarget(s.payload), h.rec);
  const primary = a.judgments[0];
  if (!primary) throw decline(409, 'This attempt has no judgment to review.', 'attempt-not-judged');
  const crit = a.scenarioSpec.rubric.criteria;
  const seen = new Set<string>();
  const problems: string[] = [];
  for (const pick of picks) {
    const c = crit.find((x) => x.id === pick.criterionId);
    if (!c) { problems.push(`unknown criterion ${pick.criterionId}`); continue; }
    if (seen.has(c.id)) problems.push(`${c.id} listed twice`);
    seen.add(c.id);
    if (!c.levels.some((l) => l.id === pick.levelId)) problems.push(`${pick.levelId} is not a level of ${c.id}`);
  }
  const missing = crit.filter((c) => !seen.has(c.id)).map((c) => c.id);
  if (missing.length > 0) problems.push(`missing: ${missing.join(', ')}`);
  if (problems.length > 0) throw decline(400, `List every criterion exactly once with a level of that criterion (${problems.join('; ')}).`, 'levels-incomplete', undefined, { problems });
  return { h, primary, roles };
}

/**
 * Write a review. Whether the rubric version is ratified is read first: a scenario chain this
 * bridge cannot read refuses the review before anything is written, never after.
 */
async function writeReview(call: Call, s: Signed, h: AttemptHead, primary: JudgmentResult, outcome: 'countersigned' | 'overridden',
  finalLevels: readonly FinalLevel[], key: PevActionKey, roles: ReadonlySet<Role>): Promise<Out> {
  const { ctx } = call;
  const a = h.body;
  const rat = await ratificationOf(call, s.pod, a);
  const at = iso(ctx);
  const assessment = assess(a.scenarioSpec, Object.fromEntries(finalLevels.map((f) => [f.criterionId, f.levelId])), false);
  const review: ReviewResult = {
    index: a.reviews.length, outcome, reviewer: s.actor, reviewedAt: at, target: targetOf(h.rec), envelope: s.stored,
    finalLevels, sawJudgeLevelsFirst: s.payload['sawJudgeLevelsFirst'] === true, assessment,
  };
  const body: AttemptBody = { ...a, at, state: outcome, reviews: [...a.reviews, review], acts: [...a.acts, actOf(s, key)] };
  const w = await writeRecord(call, { pod: s.pod, body, seq: h.seq, prev: h.rec, nonce: s.nonce });
  const nonRepeat = a.judgments.filter((j) => j.repeatOf === null).length;
  return {
    attemptIri: a.attemptIri, descriptorUrl: w.descriptorUrl, state: outcome, modalStatus: 'Asserted', supersedes: h.rec.descriptorUrl,
    assessment, finalLevels, reviewer: s.signerDid, reviewIndex: review.index,
    primaryJudgeLevels: Object.fromEntries(primary.criteria.map((c) => [c.criterionId, c.levelId])),
    outcomesRecorded: a.scenarioSpec.rubric.criteria.length * nonRepeat,
    projectable: rat.ratified, projectableWhy: rat.ratified ? EVIDENCE_WHY.ready : EVIDENCE_WHY.notRatified,
    currentTarget: { recordId: w.recordId, descriptorUrl: w.descriptorUrl, graphDigest: w.graphDigest },
    nextActions: nextFor(ctx, body, s.signer, roles, rat.ratified), recorded: true,
  };
}

function reviewChecks(p: P): void {
  if (typeof p['sawJudgeLevelsFirst'] !== 'boolean') {
    throw decline(400, 'Say whether you saw the judge\'s levels before choosing yours (sawJudgeLevelsFirst: true or false).', 'review-order-undeclared');
  }
  needAttemptIri(p);
  needTarget(p);
  levelPicks(p);
}

async function countersignAttempt(call: Call, args: Record<string, unknown>): Promise<Out> {
  const s = await signedAct(call, args, 'countersignAttempt', { write: true, checks: reviewChecks });
  const iri = needAttemptIri(s.payload);
  const picks = levelPicks(s.payload);
  return locked(call, `${s.pod}|${iri}`, async () => {
    const { h, primary, roles } = await reviewable(call, s, iri, picks);
    if (primary.unverifiedCriteria.length > 0) {
      throw decline(409, `A quote did not check out for ${primary.unverifiedCriteria.join(', ')}; set those levels yourself with an override.`, 'unverified-criteria-need-override',
        { action: A.overrideAttempt, criteria: primary.unverifiedCriteria });
    }
    const differ = picks.filter((pk) => primary.criteria.find((c) => c.criterionId === pk.criterionId)?.levelId !== pk.levelId).map((pk) => pk.criterionId);
    if (differ.length > 0) {
      throw decline(409, `Your levels differ from the judgment for ${differ.join(', ')}; that is an override, with your reasons.`, 'levels-differ-from-judge',
        { action: A.overrideAttempt, criteria: differ });
    }
    const finalLevels: FinalLevel[] = h.body.scenarioSpec.rubric.criteria.map((c) => {
      const pk = picks.find((x) => x.criterionId === c.id)!;
      return { criterionId: c.id, levelId: pk.levelId, from: 'judge', ...(pk.why !== undefined ? { why: pk.why } : {}) };
    });
    return writeReview(call, s, h, primary, 'countersigned', finalLevels, 'countersignAttempt', roles);
  });
}

async function overrideAttempt(call: Call, args: Record<string, unknown>): Promise<Out> {
  const s = await signedAct(call, args, 'overrideAttempt', { write: true, checks: reviewChecks });
  const iri = needAttemptIri(s.payload);
  const picks = levelPicks(s.payload);
  return locked(call, `${s.pod}|${iri}`, async () => {
    const { h, primary, roles } = await reviewable(call, s, iri, picks);
    const needWhyFor: string[] = [];
    let changes = false;
    const finalLevels: FinalLevel[] = h.body.scenarioSpec.rubric.criteria.map((c) => {
      const pk = picks.find((x) => x.criterionId === c.id)!;
      const cj = primary.criteria.find((x) => x.criterionId === c.id);
      const asJudged = cj !== undefined && cj.status !== 'unverified' && cj.levelId === pk.levelId;
      if (!asJudged) {
        changes = true;
        if (pk.why === undefined || pk.why.trim().length < 10) needWhyFor.push(c.id);
      }
      return { criterionId: c.id, levelId: pk.levelId, from: asJudged ? 'judge' : 'reviewer', ...(pk.why !== undefined ? { why: pk.why } : {}) };
    });
    if (needWhyFor.length > 0) {
      throw decline(400, `Say why (10 to 1000 characters) for ${needWhyFor.join(', ')}: each differs from the judgment or its quote did not check out.`, 'override-why-missing',
        undefined, { criteria: needWhyFor });
    }
    if (!changes) {
      throw decline(409, 'Every level equals the judgment and every quote checked out; countersign it instead.', 'override-changes-nothing', { action: A.countersignAttempt });
    }
    return writeReview(call, s, h, primary, 'overridden', finalLevels, 'overrideAttempt', roles);
  });
}

async function contestReview(call: Call, args: Record<string, unknown>): Promise<Out> {
  const { ctx } = call;
  const s = await signedAct(call, args, 'contestReview', {
    write: true,
    checks: (p) => { needWhy(p, true); needAttemptIri(p); needTarget(p); },
  });
  const iri = needAttemptIri(s.payload);
  return locked(call, `${s.pod}|${iri}`, async () => {
    const h = await attemptHead(call, s.pod, iri);
    const a = h.body;
    if (!samePrincipal(a.learner.address, s.signer)) throw decline(403, 'Only the learner of this attempt may contest its review.', 'not-the-learner');
    const review = standingReview(a);
    if ((a.state !== 'countersigned' && a.state !== 'overridden') || !review) {
      throw decline(409, `This attempt is ${a.state}; only a reviewed attempt can be contested.`, 'attempt-not-reviewed', undefined, { state: a.state });
    }
    if (a.reopenings.filter((r) => r.kind === 'contest').length >= MAX_CONTESTS) {
      throw decline(409, `This attempt has been contested ${MAX_CONTESTS} times already.`, 'contest-limit');
    }
    notReplayed(a, s);
    checkTarget(needTarget(s.payload), h.rec);
    const roles = (await rolesOn(call, s.pod)).of(s.signer);
    const at = iso(ctx);
    const reopening: Reopening = {
      index: a.reopenings.length, kind: 'contest', by: s.actor, role: 'learner', at, why: String(s.payload['why']),
      reviewIndex: review.index, target: targetOf(h.rec), envelope: s.stored,
    };
    const body: AttemptBody = { ...a, at, state: 'contested', reopenings: [...a.reopenings, reopening], acts: [...a.acts, actOf(s, 'contestReview')] };
    const w = await writeRecord(call, { pod: s.pod, body, seq: h.seq, prev: h.rec, nonce: s.nonce });
    return {
      attemptIri: iri, descriptorUrl: w.descriptorUrl, state: 'contested', modalStatus: 'Hypothetical', reopening,
      currentTarget: { recordId: w.recordId, descriptorUrl: w.descriptorUrl, graphDigest: w.graphDigest },
      nextActions: nextFor(ctx, body, s.signer, roles, false), recorded: true,
    };
  });
}

async function retractReview(call: Call, args: Record<string, unknown>): Promise<Out> {
  const { ctx } = call;
  noAdmins(ctx);
  const s = await signedAct(call, args, 'retractReview', {
    write: true,
    checks: (p) => { needWhy(p, true); needAttemptIri(p); needTarget(p); },
  });
  const iri = needAttemptIri(s.payload);
  return locked(call, `${s.pod}|${iri}`, async () => {
    const h = await attemptHead(call, s.pod, iri);
    const a = h.body;
    if (!isAdmin(ctx, s.signer)) throw decline(403, 'Only an admin may withdraw a review for cause.', 'not-an-admin');
    const review = standingReview(a);
    if ((a.state !== 'countersigned' && a.state !== 'overridden' && a.state !== 'contested') || !review) {
      throw decline(409, `This attempt is ${a.state}; there is no standing review to withdraw.`, 'attempt-not-reviewed', undefined, { state: a.state });
    }
    notReplayed(a, s);
    checkTarget(needTarget(s.payload), h.rec);
    const at = iso(ctx);
    const reopening: Reopening = {
      index: a.reopenings.length, kind: 'retract-for-cause', by: s.actor, role: 'admin', at, why: String(s.payload['why']),
      reviewIndex: review.index, target: targetOf(h.rec), envelope: s.stored,
    };
    const reviews = a.reviews.map((r) => (r.index === review.index ? { ...r, withdrawn: { reopeningIndex: reopening.index, at } } : r));
    const body: AttemptBody = {
      ...a, at, state: 'review-retracted', reviews, reopenings: [...a.reopenings, reopening], acts: [...a.acts, actOf(s, 'retractReview')],
    };
    const w = await writeRecord(call, { pod: s.pod, body, seq: h.seq, prev: h.rec, nonce: s.nonce });
    return {
      attemptIri: iri, descriptorUrl: w.descriptorUrl, state: 'review-retracted', modalStatus: 'Retracted', reopening,
      validFrom: review.reviewedAt, validUntil: at,
      currentTarget: { recordId: w.recordId, descriptorUrl: w.descriptorUrl, graphDigest: w.graphDigest }, recorded: true,
    };
  });
}

// ═════════════════════════════════════════════════════════════════════════════════════════════
//  Calibration and results
// ═════════════════════════════════════════════════════════════════════════════════════════════

/**
 * Unsigned: anyone who reaches the bridge reads this, and the bridge opens sealed attempts to
 * compute it. So it returns aggregates only, with the small-count rule of results: a rate over 1
 * to k − 1 outcomes is null and only its count stays, and so is any rate from which one could be
 * worked out by subtraction, within a cell or between a pooled cell and the rubric-version cells it
 * pools (CALIBRATION_SMALL_COUNT_RULE); person-judge cells are left out.
 */
async function calibrationAct(call: Call, args: Record<string, unknown>): Promise<Out> {
  const { ctx } = call;
  const pod = await readPod(ctx, args);
  const groupRaw = typeof args['group_by'] === 'string' && args['group_by'] !== '' ? args['group_by'] : 'rubric-version';
  if (groupRaw !== 'rubric-version' && groupRaw !== 'criterion-content') {
    throw decline(400, 'group_by must be rubric-version or criterion-content.', 'group-by-unknown');
  }
  const read = await attemptBodies(call, pod, 'calibration');
  const { cells, outcomes } = cellsFor(ctx, pod, read.bodies, groupRaw);
  const rubricFilter = typeof args['rubric_hash'] === 'string' && args['rubric_hash'] !== '' ? args['rubric_hash'] : null;
  const judgeFilter = typeof args['judge'] === 'string' && args['judge'] !== '' ? args['judge'] : null;
  const chosen = cells.filter((c) => (rubricFilter === null || c.rubricHash === rubricFilter) && (judgeFilter === null || c.judgeId === judgeFilter));
  // A pooled cell is checked against every rubric-version cell it pools, which the same endpoint shows.
  const versionCells = groupRaw === 'criterion-content' ? cellsFor(ctx, pod, read.bodies, 'rubric-version').cells : cells;
  const shown = suppressSmallCells(chosen.filter((c) => c.judgeKind !== 'person'), ctx.resultsK, versionCells);
  return {
    podUrl: pod, cells: shown, personJudgeCellsWithheld: chosen.length - shown.length, k: ctx.resultsK, smallCountRule: CALIBRATION_SMALL_COUNT_RULE,
    policy: STANDING_POLICY,
    auditSampleRate: AUDIT_SAMPLE_RATE, minSamplesForAsserted: STANDING_POLICY.minSamples, outcomesRead: outcomes,
    attemptsRead: read.heads.length, untrustedRecordsSkipped: read.untrusted, complete: read.complete, ...read.limit, computedAt: iso(ctx), metricNote: METRIC_NOTE,
  };
}

async function scenarioResultsAct(call: Call, args: Record<string, unknown>): Promise<Out> {
  const { ctx } = call;
  let versions: number[] = [];
  const s = await signedAct(call, args, 'scenarioResults', {
    checks: (p) => {
      needText(p, 'scenarioIri', 200);
      const v = p['versions'];
      if (v !== undefined) {
        if (!Array.isArray(v) || !(v as unknown[]).every((x) => typeof x === 'number' && Number.isInteger(x) && x >= 1)) throw shape('versions', 'must be a list of version numbers');
        versions = v as number[];
      }
    },
  });
  const roles = (await rolesOn(call, s.pod)).of(s.signer);
  if (!roles.has('reviewer') && !roles.has('author') && !isAdmin(ctx, s.signer)) {
    throw decline(403, 'Only a reviewer, an author or an admin may read results.', 'not-entitled');
  }
  // Reviewers and admins may read any attempt through get_attempt, so they see each change a
  // reviewer made and why; an author sees changes only as suppressed counts.
  const detail = (roles.has('reviewer') && !roles.has('agent')) || isAdmin(ctx, s.signer);
  const iri = String(s.payload['scenarioIri']);
  const h = await scenarioHead(call, s.pod, iri);
  if (!h) throw decline(404, 'No scenario with this IRI is on this pod.', 'scenario-not-found');
  const read = await attemptBodies(call, s.pod, 'the results of this scenario');
  const mine = read.bodies.filter((a) => a.scenario.scenarioIri === iri && (versions.length === 0 || versions.includes(a.scenario.version)));
  const view = scenarioResults({ scenarioIri: iri, spec: h.body.scenario, versions, attempts: mine, k: ctx.resultsK, detail });
  const { cells } = cellsFor(ctx, s.pod, mine, 'rubric-version');
  return {
    ...view, personJudgeCells: cells.filter((c) => c.judgeKind === 'person'),
    attemptsRead: mine.length, untrustedRecordsSkipped: read.untrusted, complete: read.complete, ...read.limit,
  };
}

// ═════════════════════════════════════════════════════════════════════════════════════════════
//  Projection (§10)
// ═════════════════════════════════════════════════════════════════════════════════════════════

async function projectAttempt(call: Call, args: Record<string, unknown>): Promise<Out> {
  const { ctx } = call;
  const s = await signedAct(call, args, 'projectAttempt', {
    write: true,
    checks: (p) => {
      needAttemptIri(p);
      const f = p['format'];
      if (f !== 'scorm' && !(PROJECTION_FORMATS as readonly unknown[]).includes(f)) throw decline(400, 'format must be xapi, cmi5 or scorm.', 'format-unknown');
    },
  });
  const format = s.payload['format'] as ProjectionFormat | 'scorm';
  const iri = needAttemptIri(s.payload);
  const h = await attemptHead(call, s.pod, iri);
  const roles = (await rolesOn(call, s.pod)).of(s.signer);
  if (!samePrincipal(h.body.learner.address, s.signer) && !roles.has('reviewer') && !isAdmin(ctx, s.signer)) {
    throw decline(403, 'Only the learner, a reviewer or an admin may project this attempt.', 'not-entitled');
  }
  if (format === 'scorm') {
    return { ...refuse(501, 'A SCORM projection is not built.', 'projection-not-built'), lossy: LOSSY.scorm };
  }
  const fmt: ProjectionFormat = format;
  const e = await eligibility(call, s.pod, h);
  const pIri = projectionIri(iri, fmt, s.nonce);
  const at = iso(ctx);
  const audit = (o: Partial<ProjectionAuditBody> & Pick<ProjectionAuditBody, 'outcome'>): ProjectionAuditBody => ({
    v: 1, kind: 'projection-audit', podUrl: s.pod, keyKind: ctx.deps.platformKeyKind, platformSigner: ctx.platform.address, at,
    projectionIri: pIri, attemptIri: iri, format: fmt, headDescriptorUrl: h.rec.descriptorUrl, requestedBy: s.signerDid, lossy: LOSSY[fmt], ...o,
  });
  if (!e.eligible) {
    const w = await writeRecord(call, { pod: s.pod, body: audit({ outcome: 'skipped', skipWhy: e.code }), seq: 1, prev: null, nonce: s.nonce });
    return {
      ...refuse(409, `Projections are available only for a reviewed attempt on a ratified rubric: ${e.why}.`, e.code, e.resolvedBy),
      skipAudit: { descriptorUrl: w.descriptorUrl },
    };
  }
  const statement = buildStatement(fmt, { attempt: h.body, headDescriptorUrl: h.rec.descriptorUrl, homePage: ctx.homePage, ratifiedBy: e.ratifiedBy });
  const problems = statementProblems(statement, fmt, h.body.scenarioSpec.assessmentUse);
  if (problems.length > 0) {
    throw decline(500, 'This bridge built a statement that fails its own checks; nothing was recorded.', 'statement-shape', undefined, { problems });
  }
  const statementId = String(statement['id']);
  const w = await writeRecord(call, {
    pod: s.pod, body: audit({ outcome: 'projected', statementId, statement, registryCheckedAt: e.registryCheckedAt }), seq: 1, prev: null, nonce: s.nonce,
  });
  return {
    attemptIri: iri, format: fmt, statementId, statement, checks: { problems: [] }, lossy: LOSSY[fmt], lrsRequest: LRS_REQUEST_NOTE,
    auditDescriptorUrl: w.descriptorUrl, practiceEvidence: true, recorded: true,
  };
}

// ═════════════════════════════════════════════════════════════════════════════════════════════
//  The learner's record: holder copy, export, redaction
// ═════════════════════════════════════════════════════════════════════════════════════════════

/**
 * The chain of an attempt, refused (409 record-not-trusted) unless every version still on the pod
 * is trusted and sits where it was written. Every act that hands a version's bytes or text to a
 * caller, or deletes a version's graph, reads the chain this way: a version the pod's manifest
 * chains in from elsewhere (a forged `supersedes`) is never returned, copied or deleted.
 */
async function trustedChain(call: Call, pod: string, iri: string): Promise<readonly (ReadRecord | DeletedVersion)[]> {
  const chain = await readChain(pod, iri, call.ctx.trusted, call.read, call.cache);
  for (const v of chain) if (!isDeleted(v) && !isTrusted(v)) throw untrusted(v);
  return chain;
}

async function holderCopy(call: Call, args: Record<string, unknown>): Promise<Out> {
  const { ctx } = call;
  const s = await signedAct(call, args, 'holderCopy', {
    nonce: true,
    checks: (p) => { needAttemptIri(p); needText(p, 'targetPodUrl', 2000); },
  });
  const iri = needAttemptIri(s.payload);
  const h = await attemptHead(call, s.pod, iri);
  if (!samePrincipal(h.body.learner.address, s.signer)) throw decline(403, 'Only the learner of this attempt may copy it.', 'not-the-learner');
  const notPublicTarget = (): Declined => decline(400, 'targetPodUrl must be a public http(s) pod address.', 'target-pod-not-public');
  const target = normalPod(String(s.payload['targetPodUrl']));
  if (target === null) throw notPublicTarget();
  // A served pod is refused from the URL alone, before the target's name is resolved.
  if (target === s.pod || (ctx.served ?? []).includes(target)) {
    throw decline(400, 'Copy to a pod you hold, not to a pod this bridge writes its records to.', 'target-pod-is-served');
  }
  try {
    await ctx.assertPublicPod(target);
  } catch {
    throw notPublicTarget();
  }
  const chain = await trustedChain(call, s.pod, iri);
  const copies: Out[] = [];
  let prev: string | undefined;
  let skippedContentDeleted = 0;
  try {
    for (const [i, v] of chain.entries()) {
      if (isDeleted(v)) { skippedContentDeleted += 1; continue; }
      if (!v.proof) throw untrusted(v);
      const signerDid = didOf(v.authorship.signerAddress ?? ctx.platform.address);
      const descriptor = buildRecordDescriptor(planOf(v.body, {
        recordId: v.recordId, platformDid: signerDid, ...(prev !== undefined ? { supersedes: prev } : {}), derivedFrom: [v.descriptorUrl],
      }));
      // Never sealed (no sealTo): the copy is for the learner's own pod, and the learner does not
      // hold this bridge's record key. The region is the opened plaintext the proof binds.
      const r = await publishPevRecord({
        podUrl: target, descriptor, graphTurtle: v.regionTurtle, slug: `copy-${recordLocal(v.recordId)}`, containerPath: PEV_COPIES_CONTAINER,
        authorshipProof: v.proof, ...(prev !== undefined ? { supersedes: prev } : {}), ifMatch: false, fetchFn: ctx.holderFetchFn,
      });
      copies.push({
        seq: i + 1, state: v.body.kind === 'attempt' ? v.body.state : null, recordId: v.recordId,
        sourceDescriptorUrl: v.descriptorUrl, copyDescriptorUrl: r.descriptorUrl,
      });
      prev = r.descriptorUrl;
    }
  } catch (e) {
    if (e instanceof PodTransportFailed && e.refusedStatus !== null) {
      throw decline(502, `The pod at ${e.podOrigin} refused this bridge's write (HTTP ${e.refusedStatus}). Download your record with export_record and write it with your own credentials.`,
        'holder-pod-refused-write', { action: A.exportRecord }, { copied: copies });
    }
    if (e instanceof PodTransportFailed) {
      throw decline(502, `The pod at ${e.podOrigin} could not be reached. ${e.message}`, 'holder-pod-unreachable', { action: A.exportRecord }, { copied: copies });
    }
    throw e;
  }
  let copiesVerified = 0;
  // Read back from the holder pod, never from the operator pod's cache, within the act's read budget.
  const copyCache: ReadCache = { records: new Map() };
  const holderRead = withReadBudget(ctx.holderFetchFn, call.budget);
  for (const c of copies) {
    try {
      const back = await readRecord(String(c['copyDescriptorUrl']), ctx.trusted, holderRead, copyCache);
      if (isTrusted(back) && back.recordId === c['recordId']) copiesVerified += 1;
    } catch (e) {
      if (e instanceof ReadBudgetSpent) break;
      if (!(e instanceof RecordUnreadable || e instanceof GraphMissing || e instanceof PodTransportFailed)) throw e;
    }
  }
  return { attemptIri: iri, targetPodUrl: target, copies, copiesVerified, skippedContentDeleted, recorded: true };
}

async function exportRecord(call: Call, args: Record<string, unknown>): Promise<Out> {
  const { ctx } = call;
  const s = await signedAct(call, args, 'exportRecord', { checks: (p) => { needAttemptIri(p); } });
  const iri = needAttemptIri(s.payload);
  const h = await attemptHead(call, s.pod, iri);
  if (!samePrincipal(h.body.learner.address, s.signer)) throw decline(403, 'Only the learner of this attempt may export it.', 'not-the-learner');
  // Every version's opened bytes go to the caller, so every version must be this attempt's own.
  const chain = await trustedChain(call, s.pod, iri);
  return {
    attemptIri: iri, exportedAt: iso(ctx), platformAddresses: [...ctx.trusted.addresses],
    // What an envelope with authority relay-delegated is re-verified against (see verify).
    relayAddresses: ctx.relay?.relayAddresses ?? [], identityHost: ctx.identityHost, verify: EXPORT_VERIFY_STEPS,
    versions: chain.map((v, i) => (isDeleted(v)
      ? { seq: i + 1, recordId: v.recordId, state: null, modalStatus: null, sourceDescriptorUrl: v.descriptorUrl, descriptorTurtle: v.descriptorTurtle, graphTrig: null, contentDeleted: true }
      : {
        seq: i + 1, recordId: v.recordId, state: v.body.kind === 'attempt' ? v.body.state : null, modalStatus: v.modalStatus,
        sourceDescriptorUrl: v.descriptorUrl, descriptorTurtle: v.descriptorTurtle, graphTrig: v.graphContent, contentDeleted: false,
      })),
  };
}

async function deleteEarlierGraphs(call: Call, pod: string, chain: readonly (ReadRecord | DeletedVersion)[], keep: string): Promise<{ deleted: number; stillPresent: string[] }> {
  let deleted = 0;
  const stillPresent: string[] = [];
  for (const v of chain) {
    if (v.descriptorUrl === keep) continue;
    if (isDeleted(v)) { deleted += 1; continue; }
    if (!v.graphUrl.startsWith(pod)) { stillPresent.push(v.graphUrl); continue; }
    // Its text is gone from the pod: no later act may hand it back from the records kept across acts.
    call.ctx.verified.drop(v.descriptorUrl);
    const r = await deleteResource(v.graphUrl, call.ctx.fetchFn);
    if (r === 'deleted' || r === 'absent') deleted += 1; else stillPresent.push(v.graphUrl);
  }
  return { deleted, stillPresent };
}

async function redactAttempt(call: Call, args: Record<string, unknown>): Promise<Out> {
  const { ctx } = call;
  const s = await signedAct(call, args, 'redactAttempt', {
    write: true,
    checks: (p) => { needWhy(p, false); needAttemptIri(p); },
  });
  const iri = needAttemptIri(s.payload);
  const why = needWhy(s.payload, false);
  return locked(call, `${s.pod}|${iri}`, async () => {
    const h = await attemptHead(call, s.pod, iri);
    const a = h.body;
    const isLearner = samePrincipal(a.learner.address, s.signer);
    if (!isLearner && !isAdmin(ctx, s.signer)) throw decline(403, 'Only the learner or an admin may remove the transcript.', 'not-learner-or-admin');
    // Removing another learner's transcript is permanent, so decisive (DECISIVE_ON_ANOTHERS_ATTEMPT): not from a chat agent unasked.
    const limited = isLearner ? null : chatAgentRefusal(ctx, s.relay);
    if (limited !== null) throw limited;
    if (!isLearner && why === undefined) throw decline(400, 'An admin removing a learner\'s transcript says why (10 to 1000 characters).', 'why-required-for-admin');
    const kept = { transcriptHash: a.transcriptHash ?? null, turns: a.turns.length, quotes: a.judgments.reduce((n, j) => n + j.criteria.reduce((m, c) => m + c.quotes.length, 0), 0) };
    if (a.state === 'redacted') {
      const chain = await trustedChain(call, s.pod, iri);
      const d = await deleteEarlierGraphs(call, s.pod, chain, h.rec.descriptorUrl);
      return {
        attemptIri: iri, descriptorUrl: h.rec.descriptorUrl, state: 'redacted', modalStatus: 'Retracted',
        graphsDeleted: d.deleted, graphsStillPresent: d.stillPresent, kept, note: REDACTION_NOTE, changed: false,
      };
    }
    notReplayed(a, s);
    checkTarget(needTarget(s.payload), h.rec);
    const chain = await trustedChain(call, s.pod, iri);
    const at = iso(ctx);
    const redaction: Redaction = {
      by: s.actor, role: isLearner ? 'learner' : 'admin', at, ...(why !== undefined ? { why } : {}), envelope: s.stored, target: targetOf(h.rec),
    };
    const redacted = redactBody(a, redaction, at);
    const body: AttemptBody = { ...redacted, acts: [...redacted.acts, actOf(s, 'redactAttempt')] };
    const w = await writeRecord(call, { pod: s.pod, body, seq: h.seq, prev: h.rec, nonce: s.nonce });
    const d = await deleteEarlierGraphs(call, s.pod, chain, w.descriptorUrl);
    return {
      attemptIri: iri, descriptorUrl: w.descriptorUrl, state: 'redacted', modalStatus: 'Retracted',
      graphsDeleted: d.deleted, graphsStillPresent: d.stillPresent, kept, note: REDACTION_NOTE, changed: true, recorded: true,
    };
  });
}

// ═════════════════════════════════════════════════════════════════════════════════════════════
//  Reading an attempt (§12.26)
// ═════════════════════════════════════════════════════════════════════════════════════════════

function percentOf(x: { readonly use: string; readonly percent?: string } | undefined): string | undefined {
  return x && x.use === 'pass-gate' ? x.percent : undefined;
}

/**
 * Who a signed read was read as: the principal, how the bridge knows it (a key the person holds,
 * or the Interego relay signing for their agent), and for a relay-delegated read the agent and the
 * relay address. The web UI shows a person signed in with their Interego account this principal,
 * the DID they give an admin to be given a role, from this answer and from nothing it guessed.
 */
function signedAsOf(s: Signed): Out {
  return s.relay
    ? { principal: s.signer, authority: 'relay-delegated', agentId: s.relay.agentId, relaySigner: s.relay.relaySigner }
    : { principal: s.signer, authority: 'key-held' };
}

async function getAttempt(call: Call, args: Record<string, unknown>): Promise<Out> {
  const { ctx } = call;
  const s = await signedAct(call, args, 'getAttempt', {
    checks: (p) => { if (p['attemptIri'] !== undefined) needAttemptIri(p); },
  });
  const roles = (await rolesOn(call, s.pod)).of(s.signer);
  const admin = isAdmin(ctx, s.signer);
  if (s.payload['attemptIri'] === undefined) {
    const wide = roles.has('reviewer') || admin;
    const read = await attemptBodies(call, s.pod, 'the list of attempts');
    const list = read.bodies
      .filter((a) => samePrincipal(a.learner.address, s.signer) || (wide && !a.authorTest))
      .sort((x, y) => y.startedAt.localeCompare(x.startedAt))
      .slice(0, 100)
      .map((a) => {
        const review = standingReview(a);
        const reviewed = (a.state === 'countersigned' || a.state === 'overridden') && review !== null;
        const primary = a.judgments[0];
        const prov = percentOf(primary?.provisional);
        const fin = reviewed ? percentOf(review.assessment) : undefined;
        return {
          attemptIri: a.attemptIri, scenarioTitle: a.scenario.title, state: a.state, attemptNumber: a.attemptNumber, startedAt: a.startedAt,
          authorTest: a.authorTest, learner: a.learner.did,
          ...(prov !== undefined ? { provisionalPercent: prov } : {}),
          ...(fin !== undefined ? { finalPercent: fin } : {}),
          ...(reviewed && review.assessment.use === 'pass-gate' ? { finalMeetsPassRule: review.assessment.meetsPassRule } : {}),
        };
      });
    return { podUrl: s.pod, attempts: list, untrustedRecordsSkipped: read.untrusted, complete: read.complete, ...read.limit, signedAs: signedAsOf(s) };
  }
  const iri = needAttemptIri(s.payload);
  const h = await attemptHead(call, s.pod, iri);
  const a = h.body;
  const isLearner = samePrincipal(a.learner.address, s.signer);
  if (!isLearner && !roles.has('reviewer') && !admin && !judgeSignersOf(a).includes(principalKey(s.signer))) {
    throw decline(403, 'Only the learner, a reviewer, a judge of this attempt or an admin may read it.', 'not-entitled');
  }
  const [e, rat, chain] = await Promise.all([
    eligibility(call, s.pod, h), ratificationOf(call, s.pod, a), readChain(s.pod, iri, ctx.trusted, call.read, call.cache),
  ]);
  const review = standingReview(a);
  const judged = a.judgments.length > 0;
  return {
    attemptIri: iri, podUrl: s.pod, state: a.state, modalStatus: h.rec.modalStatus, headDescriptorUrl: h.rec.descriptorUrl, recordId: h.rec.recordId,
    scenario: { ...a.scenario, rubricRatified: rat.ratified, ...(rat.ratifiedBy ? { ratifiedBy: rat.ratifiedBy } : {}) },
    rubric: a.scenarioSpec.rubric, assessmentUse: a.scenarioSpec.assessmentUse, workRegime: a.scenarioSpec.workRegime,
    counterpartName: a.scenarioSpec.counterpart.name, turnLimit: a.scenarioSpec.turnLimit,
    learner: { did: a.learner.did, kind: a.learner.kind }, attemptNumber: a.attemptNumber, coached: a.coached,
    ...(a.assistance !== undefined ? { assistance: a.assistance } : {}), authorTest: a.authorTest,
    startedAt: a.startedAt, ...(a.endedAt !== undefined ? { endedAt: a.endedAt, endedBy: a.endedBy } : {}),
    ...(a.endProposedAtTurn !== undefined ? { endProposedAtTurn: a.endProposedAtTurn } : {}),
    ...(a.transcriptHash !== undefined ? { transcriptHash: a.transcriptHash } : {}),
    counterpartControlledBy: a.counterpartControlledBy,
    turns: a.turns.map((t) => ({
      index: t.index, speaker: t.speaker, ...(t.text !== undefined ? { text: t.text } : {}), textSha256: t.textSha256, source: t.source,
      ...(t.disclosure ? { disclosure: t.disclosure } : {}), ...(t.endSignal ? { endSignal: true } : {}),
      ...(judged && t.speaker === 'learner' && t.text !== undefined ? { normalisedText: normaliseForQuote(t.text) } : {}),
    })),
    judgments: a.judgments, agreement: agreementOf(a.scenarioSpec, a.judgments), provisional: a.judgments[0]?.provisional ?? null,
    reviews: a.reviews, ...(review ? { standingReview: review, finalAssessment: review.assessment } : {}),
    reopenings: a.reopenings, ...(a.redaction ? { redaction: a.redaction } : {}),
    nextSteps: nextStepsOf(a),
    highlights: a.judgments.flatMap((j) => j.criteria.flatMap((c) => c.quotes.flatMap((q) => (
      q.verified && q.turnIndex !== undefined && q.start !== undefined && q.end !== undefined
        ? [{ judgmentIndex: j.index, turnIndex: q.turnIndex, start: q.start, end: q.end, criterionId: c.criterionId }] : [])))),
    currentTarget: targetOf(h.rec),
    projectable: e.eligible, projectableWhy: e.eligible ? EVIDENCE_WHY.ready : e.why,
    // A version that is not trusted where it sits shows no state read from its body.
    versions: chain.map((v) => (isDeleted(v)
      ? { descriptorUrl: v.descriptorUrl, recordId: v.recordId, state: null, modalStatus: null, contentDeleted: true }
      : !isTrusted(v)
        ? { descriptorUrl: v.descriptorUrl, recordId: v.recordId, state: null, modalStatus: null, contentDeleted: false, trusted: false }
        : { descriptorUrl: v.descriptorUrl, recordId: v.recordId, state: v.body.kind === 'attempt' ? v.body.state : null, modalStatus: v.modalStatus, contentDeleted: false })),
    authorship: h.rec.authorship, keyKind: a.keyKind, evidenceKind: a.evidenceKind, label: PRACTICE_LABEL, provisionalLabel: PROVISIONAL_LABEL,
    nextActions: nextFor(ctx, a, s.signer, roles, e.eligible),
    signedAs: signedAsOf(s),
  };
}

// ═════════════════════════════════════════════════════════════════════════════════════════════
//  Demo signing (§12.27): only when the operator gave this bridge demo role keys
// ═════════════════════════════════════════════════════════════════════════════════════════════

async function signAsDemoRole(call: Call, args: Record<string, unknown>): Promise<Out> {
  const { ctx } = call;
  const roles = ctx.deps.demoSigner?.roles;
  if (!roles) throw decline(404, 'Demo signing is off on this bridge; sign with your own wallet.', 'demo-signing-off');
  const payload = args['payload'];
  if (payload === undefined || payload === null) {
    return { roles: roles.map((r) => ({ role: r.role, label: r.label, address: r.wallet.address })), demo: true };
  }
  const entry = roles.find((r) => r.role === args['role']);
  if (!entry) throw decline(400, `role must be one of ${roles.map((r) => r.role).join(', ')}.`, 'role-unknown');
  if (!isObj(payload) || !isPevAction(payload['action'])) throw decline(400, 'payload.action must be a pev action IRI (urn:iep:action:pev:…).', 'not-a-pev-action');
  if (ctx.trusted.addresses.has(entry.wallet.address.toLowerCase())) throw decline(400, 'This bridge never signs as the platform.', 'role-unknown');
  const filled: Record<string, unknown> = {
    v: 1, issuedAt: iso(ctx), nonce: ctx.nonce(), ...(ctx.deps.defaultPodUrl ? { podUrl: ctx.deps.defaultPodUrl } : {}), ...payload,
  };
  const envelope = await signEnvelope(entry.wallet, filled);
  return { envelope, signer: entry.wallet.address, role: entry.role, label: entry.label, serverHeldDemoKey: true };
}

// ═════════════════════════════════════════════════════════════════════════════════════════════
//  The handler map
// ═════════════════════════════════════════════════════════════════════════════════════════════

type Act = (call: Call, args: Record<string, unknown>) => Promise<Out>;

/** The handlers, keyed by tool name: exactly one per affordance. */
export function createPevHandlers(deps: PevDeps): Record<string, AffordanceHandler> {
  const ctx = makeContext(deps);
  const run = (act: Act): AffordanceHandler => async (args: Record<string, unknown>) => {
    const budget = new ReadBudget(ctx.actReadBudgetBytes);
    const call: Call = { ctx, cache: readCache(ctx.verified), budget, read: withReadBudget(ctx.fetchFn, budget), writesAtStart: ctx.writes.n };
    try {
      return await act(call, args ?? {});
    } catch (e) {
      return refusalFor(e);
    }
  };
  return {
    'pev.register_role': run(registerRole),
    'pev.author_scenario': run(authorScenario),
    'pev.draft_scenario_packet': run(draftScenarioPacket),
    'pev.draft_scenario': run(draftScenario),
    'pev.ratify_scenario': run(ratifyScenario),
    'pev.list_scenarios': run(listScenarios),
    'pev.start_attempt': run(startAttempt),
    'pev.say': run(say),
    'pev.counterpart_packet': run(counterpartPacketAct),
    'pev.record_turns': run(recordTurns),
    'pev.end_conversation': run(endConversation),
    'pev.judge_attempt': run(judgeAttempt),
    'pev.judge_packet': run(judgePacketAct),
    'pev.record_judgment': run(recordJudgment),
    'pev.review_queue': run(reviewQueueAct),
    'pev.countersign_attempt': run(countersignAttempt),
    'pev.override_attempt': run(overrideAttempt),
    'pev.contest_review': run(contestReview),
    'pev.retract_review': run(retractReview),
    'pev.calibration': run(calibrationAct),
    'pev.scenario_results': run(scenarioResultsAct),
    'pev.project_attempt': run(projectAttempt),
    'pev.holder_copy': run(holderCopy),
    'pev.export_record': run(exportRecord),
    'pev.redact_attempt': run(redactAttempt),
    'pev.get_attempt': run(getAttempt),
    'pev.sign_as_demo_role': run(signAsDemoRole),
  };
}

/**
 * What the operator should know at startup about the default pod's role registry. When it was
 * signed by a platform key this bridge does not trust, the lines name that key, say what trusting
 * it would mean, and give the setting only as something to apply after checking the address
 * against one this bridge printed when it started before: the pod's content alone is no evidence
 * the key was this operator's.
 */
export async function describeStartup(deps: PevDeps): Promise<{ readonly lines: readonly string[]; readonly registryTrusted: boolean | null; readonly untrustedSigner?: string }> {
  if (!deps.defaultPodUrl) {
    const served = deps.servedPods;
    const line = served === '*' ? 'No default pod is set: every act names its pod in its signed payload, and any public pod is served.'
      : served !== undefined && served.length > 0 ? `No default pod is set: every act names one of the served pods (${served.join(', ')}) in its signed payload.`
        : 'No pod is served: every act is refused until the operator sets PEV_DEFAULT_POD_URL or PEV_SERVED_PODS.';
    return { lines: [line], registryTrusted: null };
  }
  const ctx = makeContext(deps);
  const pod = podBase(deps.defaultPodUrl);
  const registry = await registryStartup(ctx, pod);
  // Records under another record key: every act on this pod but the scenario list will be refused.
  let mismatch: KeyMismatch | null = null;
  try { mismatch = keyMismatchIn(ctx, keyMarksOf(await listEntries(pod, ctx.fetchFn), pod)); } catch { mismatch = null; }
  if (!mismatch) return registry;
  return {
    ...registry,
    lines: [...registry.lines, `${keyMismatchWhy(ctx, mismatch)}. This bridge writes nothing on ${pod}, and answers nothing from it but the scenario list, until every bridge on it holds one record key. ${keyMismatchAdvice(ctx, mismatch)} Or set PEV_DEFAULT_POD_URL to a fresh pod path.`],
  };
}

async function registryStartup(ctx: Ctx, pod: string): Promise<{ readonly lines: readonly string[]; readonly registryTrusted: boolean | null; readonly untrustedSigner?: string }> {
  try {
    const view = await readRoleRegistry(pod, ctx.trusted, ctx.fetchFn);
    if (!view.head) return { lines: [`The role registry on ${pod} is empty; an admin registers roles with pev.register_role.`], registryTrusted: null };
    if (!view.trusted) {
      const signer = view.head.authorship.signerAddress ?? 'unknown';
      if (view.head.misplaced !== undefined && view.head.authorship.valid && view.head.authorship.platformKnown) {
        return {
          lines: [`The role registry on ${pod} is signed by this platform but not for where it sits (${view.head.misplaced}); it is not used. Someone who can write the pod changed it; restore it or use a fresh pod path.`],
          registryTrusted: false,
        };
      }
      return {
        lines: [
          `The role registry on ${pod} was signed by ${signer}, which this bridge does not trust, so no role on that pod counts.`,
          `WARNING: trust that key only if ${signer} is an address this bridge printed as its own platform key when it started before (an ephemeral key). Anyone who can write the pod can put a record there signed by a key of their own, and a trusted key can sign every record: registries, reviews and projections.`,
          `If it is yours: PEV_TRUSTED_PLATFORM_ADDRESSES=${signer}. Otherwise set PEV_DEFAULT_POD_URL to a fresh pod path.`,
        ],
        registryTrusted: false, untrustedSigner: signer,
      };
    }
    return { lines: [`The role registry on ${pod} is trusted; ${view.roles.size} member(s) (addresses or Interego DIDs) hold roles.`], registryTrusted: true };
  } catch (e) {
    if (e instanceof RecordSealed) {
      return {
        lines: [e.bridgeHasKey
          ? `The role registry on ${pod} is sealed to a record key this bridge does not hold, so no role on that pod counts. If the key that wrote it is the operator's record key, set PEV_RECORD_KEY to it (from the operator's backup); if this bridge's is, a bridge holding another key wrote it. Or set PEV_DEFAULT_POD_URL to a fresh pod path.`
          : `The role registry on ${pod} is sealed, and this bridge has no record key, so no role on that pod counts. Set PEV_RECORD_KEY to the key that wrote it (from the operator's backup).`],
        registryTrusted: false,
      };
    }
    const msg = e instanceof Error ? e.message : String(e);
    return { lines: [`The role registry on ${pod} could not be read: ${msg.slice(0, 200)}`], registryTrusted: null };
  }
}
