/**
 * Records: who signed what, what a record body holds, how it becomes Turtle and a Context
 * Descriptor, and how it is read back.
 *
 * Pure: no pod I/O and no environment. Signing helpers take a Wallet that was imported or created
 * in this process; verification needs nothing but the bytes.
 *
 * ── IDENTITY (DECISIONS #1–#3) ────────────────────────────────────────────────────────────────
 * A person is identified ONLY by a signature over the exact bytes they sent. No caller field names
 * an identity. Two authorities are read:
 *   · key-held: the address recovered from a signature the person made with a key they hold, in
 *     either envelope form:
 *       form A `pev-canonical`: `{payload, signature}`, the message is canonicalJson(payload);
 *       form B `signed-request`: `{_signed_payload, _signature}`, the repo's existing wire shape,
 *       the message is `sha256:` + sha256Hex(_signed_payload), and its `agent_id` must name the
 *       recovered signer;
 *   · relay-delegated (Interego sign-in): form B signed by a relay delegation key this bridge
 *     trusts, for the agent of the person's authenticated session (`agent_id`, which the caller
 *     cannot choose). The person is that agent's controller on the identity host, a
 *     `did:web:<host>:users:<id>` principal (src/relay-delegated.ts). Freshness is the relay's
 *     `timestamp` and the pod is `pod_url`; `subject_pod_url` (the caller's own pod) is never read.
 *     This is relay-attested, not user-held: whoever holds the relay key or controls the identity
 *     host can act as any person, so every envelope accepted this way is stored with authority
 *     `relay-delegated`, the principal, the agent and the relay address.
 * A principal is an address (compared case-insensitively) or a user DID (compared exactly): the
 * two never collide, and a DID is never lower-cased (`principalKey`).
 * A tampered payload does not throw: it recovers a DIFFERENT address, which then fails the act's
 * identity or role check (or, in the relay shape, is no trusted relay). That is the documented
 * behaviour.
 *
 * ── BODIES ────────────────────────────────────────────────────────────────────────────────────
 * Every record graph carries typed pev: triples AND `pev:recordJson` (canonical JSON of the whole
 * body) with `pev:recordJsonSha256`. One function writes both from the same object, so they cannot
 * disagree; read-back takes the body from the literal and refuses one whose hash does not match.
 */
import { createHmac, randomBytes } from 'node:crypto';
import {
  canonicalJson, sha256, sha256Hex, escapeTurtleLiteral, turtleIriRef, recoverMessageSigner, signMessageRaw,
  parseTrig, readStringValue, ContextDescriptor,
  type ContextDescriptorData, type IRI, type Wallet,
} from '@interego/core';
import type { InferenceDisclosure, InferenceRoute, LlmKeySource } from './model.js';
import { PEV_ACTION, PEV_NS, PEV_SHAPES_NS, pevTerm, toolNameOf, type PevActionKey } from './ontology.js';
import { agentSlugOf, isUserDid } from './relay-delegated.js';
import {
  criterionContentHash, learnerTurnCount, MAX_CONTESTS, MAX_JUDGMENTS,
  type Assessment, type JudgmentResult, type ScenarioSpec, type Turn,
} from './practice.js';

// ═════════════════════════════════════════════════════════════════════════════════════════════
//  Body types (§5.2)
// ═════════════════════════════════════════════════════════════════════════════════════════════

export type KeyKind = 'configured' | 'ephemeral' | 'demo-fixture';
export type ScenarioStatus = 'draft' | 'published' | 'ratified';
export type LifecycleState = 'in-conversation' | 'ended' | 'judged' | 'countersigned' | 'overridden'
  | 'contested' | 'review-retracted' | 'redacted';
export const LIFECYCLE_STATES: readonly LifecycleState[] = [
  'in-conversation', 'ended', 'judged', 'countersigned', 'overridden', 'contested', 'review-retracted', 'redacted',
];
export type EnvelopeForm = 'pev-canonical' | 'signed-request';
export type Role = 'reviewer' | 'author' | 'judge' | 'agent' | 'learner';
export const ROLES: readonly Role[] = ['reviewer', 'author', 'judge', 'agent', 'learner'];

/** Who stands behind a signature: a key the person holds, or the Interego relay signing for their session. */
export type Authority = 'key-held' | 'relay-delegated';

/**
 * What an act accepted from the relay records beside its envelope, so a later reader can tell a
 * relay-attested act from a key-held one: the relay key signed for `agentId`, and the identity
 * host said, when the bridge accepted it, that `principal` controls that agent.
 */
export interface RelayAttestation {
  readonly authority: 'relay-delegated';
  /** The person: `did:web:<identity host>:users:<id>`. */
  readonly principal: string;
  /** The agent the relay signed for: `did:web:<identity host>:agents:<slug>`. */
  readonly agentId: string;
  /** The relay address the signature recovered to, lower case. */
  readonly relaySigner: string;
}

export interface StoredEnvelope extends Partial<RelayAttestation> {
  readonly form: EnvelopeForm;
  readonly signature: string;
  /** sha256 of exactly the signed text. */
  readonly payloadSha256: string;
  /** Form A: the payload as signed. */
  readonly payload?: Readonly<Record<string, unknown>>;
  /** Form B: the signed JSON text. */
  readonly signedPayload?: string;
  /** Set when redaction removed the payload text; the signature and hash stay. */
  readonly redacted?: true;
}

/**
 * Who acted. `address` is the principal: the signer's 0x address for a key-held act, or the
 * person's `did:web:<host>:users:<id>` for a relay-delegated one (then `did` is the same DID).
 */
export interface Actor { readonly address: string; readonly did: string; readonly serverHeldDemoKey: boolean }
/** The version a record supersedes, as the platform signed it into the record itself. */
export interface RecordLink { readonly recordId: string; readonly graphDigest: string }
export interface RecordCommon {
  readonly v: 1; readonly podUrl: string; readonly keyKind: KeyKind;
  /** The platform address that signs this record's authorship proof. */
  readonly platformSigner: string;
  readonly at: string;
  /**
   * The record's place in its chain, stamped by the bridge as it writes and signed with the rest of
   * the body: `seq` counts versions from 1, `prev` names the version this one supersedes. A reader
   * refuses a head whose seq is not the chain's length, or a version whose prev is not the version
   * before it, so an old signed version re-published on top of a newer one is caught.
   */
  readonly seq?: number;
  readonly prev?: RecordLink;
  /**
   * Fresh server randomness (`recordSalt()`, 144 bits), drawn for every version the bridge writes
   * and kept only in the body (the `pev:recordJson` literal: no triple of its own). The record's
   * content hash is on its public descriptor, and with a record key the body is sealed; a body
   * whose every field is public or one of a few values (a projection audit's are, but for who
   * asked) could otherwise be confirmed from that hash by guessing, for each candidate address,
   * the one field left. With the salt nothing short of the key opens a body or confirms a guess.
   */
  readonly salt?: string;
}

export type DraftAssistance =
  | { readonly used: false; readonly declaredBy: string }
  | {
    readonly used: true; readonly measured: false; readonly declaredBy: string; readonly by: 'own-agent' | 'model' | 'person';
    readonly provider?: string; readonly model?: string; readonly note?: string;
  }
  | {
    readonly used: true; readonly measured: true; readonly by: 'model'; readonly provider: string; readonly model: string;
    readonly keySource: LlmKeySource; readonly route: InferenceRoute; readonly draftHash: string; readonly editedAfterDraft: boolean;
    readonly receipt: StoredEnvelope;
  };

export interface ScenarioBody extends RecordCommon {
  readonly kind: 'scenario'; readonly scenarioIri: string; readonly version: number; readonly status: ScenarioStatus;
  readonly scenario: ScenarioSpec; readonly scenarioHash: string; readonly rubricHash: string; readonly rubricIri: string;
  readonly criterionContentHashes: Readonly<Record<string, string>>;
  /** Who signed THIS record's act (the author, or the ratifying reviewer). */
  readonly actor: Actor;
  /** Addresses of every author who signed a record of this version (carried forward). */
  readonly versionAuthors: readonly string[];
  readonly draftAssistance: DraftAssistance;
  readonly ratification?: { readonly reviewer: Actor; readonly at: string; readonly envelope: StoredEnvelope };
  readonly envelope: StoredEnvelope;
}

export interface FinalLevel {
  readonly criterionId: string; readonly levelId: string; readonly from: 'judge' | 'reviewer';
  readonly why?: string; readonly whySha256?: string;
}

export interface ReviewResult {
  readonly index: number; readonly outcome: 'countersigned' | 'overridden'; readonly reviewer: Actor; readonly reviewedAt: string;
  readonly target: RecordTarget;
  readonly envelope: StoredEnvelope;
  /** EVERY criterion, as the reviewer's signed payload listed it. */
  readonly finalLevels: readonly FinalLevel[];
  readonly sawJudgeLevelsFirst: boolean;
  readonly assessment: Assessment;
  readonly withdrawn?: { readonly reopeningIndex: number; readonly at: string };
}

export interface RecordTarget { readonly recordId: string; readonly descriptorUrl: string; readonly graphDigest: string }

export interface Reopening {
  readonly index: number; readonly kind: 'contest' | 'retract-for-cause'; readonly by: Actor; readonly role: 'learner' | 'admin';
  readonly at: string; readonly why?: string; readonly whySha256?: string; readonly reviewIndex: number;
  readonly target: RecordTarget; readonly envelope: StoredEnvelope;
}

export interface Redaction {
  readonly by: Actor; readonly role: 'learner' | 'admin'; readonly at: string; readonly why?: string;
  readonly envelope: StoredEnvelope; readonly target: RecordTarget;
}

export interface AttemptAct {
  /** `signer` is the principal (an address, or a user DID for a relay-delegated act). */
  readonly action: string; readonly signer: string; readonly form: EnvelopeForm; readonly payloadSha256: string;
  readonly at: string; readonly serverHeldDemoKey?: boolean;
  /** The act's signature over the payload whose sha256 is `payloadSha256`, so the act can be re-verified. */
  readonly signature?: string;
  /** Set on a relay-delegated act: the relay signed it for `agentId`, recovering to `relaySigner`. */
  readonly authority?: 'relay-delegated'; readonly agentId?: string; readonly relaySigner?: string;
}

export interface AttemptBody extends RecordCommon {
  readonly kind: 'attempt'; readonly attemptIri: string; readonly state: LifecycleState; readonly evidenceKind: 'practice';
  readonly scenario: {
    readonly scenarioIri: string; readonly version: number; readonly scenarioHash: string; readonly rubricHash: string;
    readonly descriptorUrl: string; readonly title: string; readonly statusAtStart: ScenarioStatus;
  };
  /** A frozen copy of the version practised. */
  readonly scenarioSpec: ScenarioSpec;
  readonly learner: Actor & { readonly kind: 'person' | 'agent' };
  readonly attemptNumber: number; readonly coached: boolean; readonly assistance?: string; readonly assistanceSha256?: string;
  readonly authorTest: boolean;
  readonly startedAt: string; readonly endedAt?: string;
  readonly endedBy?: 'learner' | 'learner-confirmed-counterpart-end' | 'turn-limit';
  readonly endProposedAtTurn?: number;
  readonly turns: readonly Turn[];
  readonly counterpartControlledBy: 'platform' | 'learner-model' | 'learner';
  readonly transcriptHash?: string;
  /** judgments[0] is the PRIMARY judgment. */
  readonly judgments: readonly JudgmentResult[];
  readonly reviews: readonly ReviewResult[];
  readonly reopenings: readonly Reopening[];
  readonly redaction?: Redaction;
  readonly startEnvelope: StoredEnvelope;
  readonly acts: readonly AttemptAct[];
}

/** One member's roles: `address` is the principal, a 0x address or a `did:web:<host>:users:<id>`. */
export interface RoleEntry { readonly address: string; readonly roles: readonly Role[] }

/** An envelope that changed this chain, kept while it could still pass the freshness check. */
export interface RecentEnvelope { readonly payloadSha256: string; readonly at: string }

export interface RoleRegistryBody extends RecordCommon {
  readonly kind: 'role-registry'; readonly registryIri: string; readonly seq: number;
  readonly entries: readonly RoleEntry[];
  /**
   * The payload hashes of the admin envelopes applied within the replay window, carried forward
   * from version to version, so a stored envelope cannot be applied again by another process.
   */
  readonly recentEnvelopes?: readonly RecentEnvelope[];
  readonly change: { readonly address: string; readonly role: Role; readonly change: 'add' | 'remove'; readonly by: string };
  readonly actor: Actor;
  readonly envelope: StoredEnvelope;
}

export interface ProjectionAuditBody extends RecordCommon {
  readonly kind: 'projection-audit'; readonly projectionIri: string; readonly attemptIri: string; readonly format: 'xapi' | 'cmi5';
  readonly outcome: 'projected' | 'skipped'; readonly headDescriptorUrl: string | null; readonly requestedBy: string;
  readonly statementId?: string; readonly statement?: Readonly<Record<string, unknown>>; readonly skipWhy?: string;
  readonly lossy: readonly string[];
  /** The reviewedAt the reviewer's role was checked at. */
  readonly registryCheckedAt?: string;
}

export type PevRecordBody = ScenarioBody | AttemptBody | RoleRegistryBody | ProjectionAuditBody;

export const RECORD_CLASS: Readonly<Record<PevRecordBody['kind'], string>> = {
  'scenario': pevTerm('Scenario'),
  'attempt': pevTerm('Attempt'),
  'role-registry': pevTerm('RoleRegistry'),
  'projection-audit': pevTerm('ProjectionAudit'),
};
export const RECORD_SHAPE: Readonly<Record<PevRecordBody['kind'], string>> = {
  'scenario': `${PEV_SHAPES_NS}ScenarioShape`,
  'attempt': `${PEV_SHAPES_NS}AttemptShape`,
  'role-registry': `${PEV_SHAPES_NS}RoleRegistryShape`,
  'projection-audit': `${PEV_SHAPES_NS}ProjectionAuditShape`,
};

/** The graph IRI a body describes. */
export function graphIriOf(body: PevRecordBody): string {
  switch (body.kind) {
    case 'scenario': return body.scenarioIri;
    case 'attempt': return body.attemptIri;
    case 'role-registry': return body.registryIri;
    case 'projection-audit': return body.projectionIri;
  }
}

/** Modal status per kind and state (§5.1). */
export function modalFor(body: PevRecordBody): 'Hypothetical' | 'Asserted' | 'Retracted' {
  switch (body.kind) {
    case 'scenario': return body.status === 'ratified' ? 'Asserted' : 'Hypothetical';
    case 'attempt':
      if (body.state === 'countersigned' || body.state === 'overridden') return 'Asserted';
      if (body.state === 'review-retracted' || body.state === 'redacted') return 'Retracted';
      return 'Hypothetical';
    case 'role-registry':
    case 'projection-audit':
      return 'Asserted';
  }
}

/** The last review that has not been withdrawn; null when none stands. */
export function standingReview(a: AttemptBody): ReviewResult | null {
  const last = a.reviews[a.reviews.length - 1];
  return last && !last.withdrawn ? last : null;
}

/** True when any act on the attempt was signed with a key this bridge held for a demo role. */
export function anyDemoSigner(a: AttemptBody): boolean {
  return a.learner.serverHeldDemoKey
    || a.acts.some((x) => x.serverHeldDemoKey === true)
    || a.reviews.some((r) => r.reviewer.serverHeldDemoKey)
    || a.reopenings.some((r) => r.by.serverHeldDemoKey);
}

// ═════════════════════════════════════════════════════════════════════════════════════════════
//  Envelopes (§4.2)
// ═════════════════════════════════════════════════════════════════════════════════════════════

const SIGNATURE = /^0x[0-9a-fA-F]{130}$/;
const NONCE = /^[A-Za-z0-9_-]{16,128}$/;
const ADDRESS = /^0x[0-9a-fA-F]{40}$/;
const DID_ETHR = /^did:ethr:(?:[A-Za-z0-9]+:)?(0x[0-9a-fA-F]{40})$/;

export const didOf = (address: string): string => `did:ethr:${address}`;
export function isAddress(s: unknown): s is string { return typeof s === 'string' && ADDRESS.test(s); }
/**
 * The key a principal is compared and indexed by: an address lower-cased (addresses are
 * case-insensitive), anything else (a user DID) exactly as it is. An address starts `0x` and a DID
 * `did:`, so the two never collide, and a DID is never lower-cased into another principal.
 */
export function principalKey(p: string): string { return ADDRESS.test(p) ? p.toLowerCase() : p; }
/** True when two principals are the same person: addresses case-insensitively, DIDs exactly. */
export function samePrincipal(a: string, b: string): boolean { return principalKey(a) === principalKey(b); }
/** Two principals compared (`samePrincipal`): an address case-insensitively, never a DID lower-cased. */
export function sameAddress(a: string, b: string): boolean { return samePrincipal(a, b); }
/** A principal's DID: `did:ethr:<address>` for an address, the DID itself for a user DID. */
export function principalDid(p: string): string { return ADDRESS.test(p) ? didOf(p) : p; }
/** The address inside `did:ethr:[network:]0x…`, or a bare address; null otherwise. */
export function addressOfDid(did: string): string | null {
  if (ADDRESS.test(did)) return did;
  const m = DID_ETHR.exec(did);
  return m ? (m[1] ?? null) : null;
}
/** The principal a DID names: the address inside a `did:ethr`, or the DID itself (a user DID). */
export function principalOfDid(did: string): string { return addressOfDid(did) ?? did; }
/**
 * True for a principal a role may be given to: an address, or, with an identity host, a person's
 * `did:web:<host>:users:<id>` on it (never an agent DID: an agent acts for its controller).
 */
export function isPrincipal(s: unknown, identityHost: string | null): s is string {
  return isAddress(s) || (typeof s === 'string' && identityHost !== null && isUserDid(s, identityHost));
}
export function freshNonce(): string { return randomBytes(18).toString('base64url'); }
/**
 * A record body's salt: 18 bytes (144 bits) from the operating system's random source, as
 * base64url. Never from an injected nonce source, which tests make predictable.
 */
export function recordSalt(): string { return randomBytes(18).toString('base64url'); }
export function actorOf(principal: string, serverHeldDemoKey: boolean): Actor {
  return { address: principal, did: principalDid(principal), serverHeldDemoKey };
}

export interface EnvelopeOk {
  readonly ok: true; readonly form: EnvelopeForm;
  /** The principal: the recovered address (key-held), or the person's user DID (relay-delegated). */
  readonly signer: string; readonly signerDid: string;
  /** The payload with `issuedAt` and `podUrl` normalised (form B's `timestamp`/`pod_url` read too). */
  readonly payload: Readonly<Record<string, unknown>>;
  readonly payloadSha256: string; readonly stored: StoredEnvelope;
  readonly authority: Authority;
  /** Set when the relay signed this request for the person (`authority: 'relay-delegated'`). */
  readonly relay?: RelayAttestation;
}
export interface EnvelopeNo { readonly ok: false; readonly status: 400 | 401; readonly code: string; readonly message: string }

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const no = (status: 400 | 401, code: string, message: string): EnvelopeNo => ({ ok: false, status, code, message });

interface Located {
  readonly form: EnvelopeForm; readonly signature: unknown; readonly payload?: unknown; readonly signedPayload?: unknown;
}

function locate(args: Record<string, unknown>): Located | null {
  let raw: unknown = args['envelope'];
  if (typeof raw === 'string') {
    try { raw = JSON.parse(raw); } catch { return null; }
  }
  if (isRecord(raw)) {
    if ('_signed_payload' in raw || '_signature' in raw) return { form: 'signed-request', signature: raw['_signature'], signedPayload: raw['_signed_payload'] };
    if ('payload' in raw || 'signature' in raw) return { form: 'pev-canonical', signature: raw['signature'], payload: raw['payload'] };
    return null;
  }
  if (raw !== undefined && raw !== null) return null;
  if (args['_signed_payload'] !== undefined || args['_signature'] !== undefined) {
    return { form: 'signed-request', signature: args['_signature'], signedPayload: args['_signed_payload'] };
  }
  return null;
}

/**
 * Check an envelope in the documented order and return the recovered signer. Identity is the
 * recovered address and nothing else. Reads stop here; writes then consume the nonce.
 */
export function checkEnvelope(
  args: Record<string, unknown>, expectedAction: string, now: Date,
  o: { maxAgeMs?: number; maxSkewMs?: number } = {},
): EnvelopeOk | EnvelopeNo {
  const maxAgeMs = o.maxAgeMs ?? 600_000;
  const maxSkewMs = o.maxSkewMs ?? 120_000;
  const found = locate(args);
  const missing = 'Sign this act: send envelope {payload, signature} (or {_signed_payload, _signature}) signed by your own key.';
  if (!found || typeof found.signature !== 'string' || !SIGNATURE.test(found.signature)) return no(401, 'envelope-missing', missing);

  let payload: Record<string, unknown>;
  let message: string;
  let signedText: string;
  let stored: StoredEnvelope;
  if (found.form === 'pev-canonical') {
    if (!isRecord(found.payload)) return no(401, 'envelope-missing', missing);
    payload = found.payload;
    signedText = canonicalJson(payload);
    message = signedText;
  } else {
    if (typeof found.signedPayload !== 'string' || found.signedPayload.length === 0) return no(401, 'envelope-missing', missing);
    // The signature is over this text's UTF-8 bytes, and one with a lone surrogate has none: refused
    // before it is hashed, as any other text that is not well-formed is (the pev-canonical form's
    // JSON escapes such a code unit, so its payload is checked field by field after this).
    if (!isWellFormedText(found.signedPayload)) {
      return no(400, 'payload-shape', '_signed_payload must be well-formed text (it holds half of a UTF-16 surrogate pair, which cannot be stored as sent).');
    }
    let parsed: unknown;
    try { parsed = JSON.parse(found.signedPayload); } catch { parsed = undefined; }
    if (!isRecord(parsed)) return no(400, 'envelope-payload-format', 'The signed payload must be a JSON object.');
    payload = parsed;
    signedText = found.signedPayload;
    message = `sha256:${sha256Hex(signedText)}`;
  }
  const payloadSha256 = sha256(signedText);

  let signer: string;
  try { signer = recoverMessageSigner(message, found.signature); } catch {
    return no(401, 'signature-unrecoverable', 'No signer can be recovered from this signature over these bytes.');
  }

  if (found.form === 'signed-request') {
    const agentId = typeof payload['agent_id'] === 'string' ? payload['agent_id'] : '';
    const named = addressOfDid(agentId);
    if (!named || !samePrincipal(named, signer)) {
      return no(401, 'signer-is-not-the-named-agent',
        `This envelope was signed by ${signer} on behalf of ${agentId || '(no agent_id)'}. A key-held envelope's agent_id names the signer's own key (did:ethr:<address>), and a request the Interego relay signs is read only when it recovers to a relay address this bridge trusts (PEV_TRUSTED_RELAY_ADDRESSES); this one is neither. Sign with your own wallet, or sign in with your Interego account.`);
    }
    stored = { form: 'signed-request', signature: found.signature, payloadSha256, signedPayload: signedText };
  } else {
    stored = { form: 'pev-canonical', signature: found.signature, payloadSha256, payload };
  }

  const issuedRaw = found.form === 'signed-request' ? (payload['issuedAt'] ?? payload['timestamp']) : payload['issuedAt'];
  const podRaw = found.form === 'signed-request' ? (payload['podUrl'] ?? payload['pod_url']) : payload['podUrl'];
  const checked = payloadChecks(payload, expectedAction, now, { maxAgeMs, maxSkewMs }, {
    issuedRaw, podRaw,
    noIssued: 'The envelope carries no readable issuedAt.',
    noPod: 'The payload must name podUrl, the absolute http(s) URL of the pod you act on.',
  });
  if (!checked.ok) return checked;

  return {
    ok: true, form: found.form, signer, signerDid: didOf(signer),
    payload: { ...payload, issuedAt: issuedRaw, podUrl: checked.podUrl },
    payloadSha256, stored, authority: 'key-held',
  };
}

/**
 * The checks every signed payload passes, key-held or relay-delegated, in the documented order:
 * v, the action it was signed for, freshness, the nonce's format, the pod it names.
 */
function payloadChecks(
  payload: Readonly<Record<string, unknown>>, expectedAction: string, now: Date, o: { maxAgeMs: number; maxSkewMs: number },
  read: { issuedRaw: unknown; podRaw: unknown; noIssued: string; noPod: string },
): { readonly ok: true; readonly podUrl: string } | EnvelopeNo {
  if (payload['v'] !== 1) return no(400, 'envelope-version', 'This bridge reads envelope payloads with v: 1.');
  if (payload['action'] !== expectedAction) {
    return no(400, 'envelope-for-another-action', `This envelope was signed for ${String(payload['action'])}, not for ${expectedAction}.`);
  }
  const issued = typeof read.issuedRaw === 'string' ? Date.parse(read.issuedRaw) : Number.NaN;
  if (!Number.isFinite(issued)) return no(401, 'envelope-expired', read.noIssued);
  const age = now.getTime() - issued;
  if (age > o.maxAgeMs) return no(401, 'envelope-expired', `The envelope was issued ${Math.round(age / 1000)} s ago; sign a new one (limit ${Math.round(o.maxAgeMs / 1000)} s).`);
  if (-age > o.maxSkewMs) return no(401, 'envelope-expired', 'The envelope is dated in the future beyond the allowed clock skew.');
  const nonce = payload['nonce'];
  if (typeof nonce !== 'string' || !NONCE.test(nonce)) return no(400, 'nonce-format', 'nonce must be 16 to 128 letters, digits, - or _.');
  let podUrl = '';
  if (typeof read.podRaw === 'string') {
    try {
      const u = new URL(read.podRaw);
      if (u.protocol === 'https:' || u.protocol === 'http:') podUrl = read.podRaw;
    } catch { /* not a URL */ }
  }
  if (!podUrl) return no(400, 'envelope-pod-missing', read.noPod);
  return { ok: true, podUrl };
}

// ── Relay-delegated requests (Interego sign-in) ──────────────────────────────────────────────

/**
 * The `{_signed_payload, _signature}` form of a request, found where `checkEnvelope` finds it
 * (under `envelope` first, then at the top level, where the relay posts it), with a signature in
 * the 65-byte shape; null for anything else.
 */
export function signedRequestOf(args: Record<string, unknown>): { readonly signedPayload: string; readonly signature: string } | null {
  const found = locate(args);
  if (!found || found.form !== 'signed-request' || typeof found.signedPayload !== 'string' || found.signedPayload.length === 0
    || typeof found.signature !== 'string' || !SIGNATURE.test(found.signature)) return null;
  return { signedPayload: found.signedPayload, signature: found.signature };
}

/** The lower-cased address a signed request's signature over `sha256:<hex>` recovers to, or null. */
export function signedRequestSigner(r: { readonly signedPayload: string; readonly signature: string }): string | null {
  try { return recoverMessageSigner(`sha256:${sha256Hex(r.signedPayload)}`, r.signature).toLowerCase(); } catch { return null; }
}

/**
 * The checks of a request the relay signed that need no network, the same as a key-held
 * envelope's (v, action, freshness, nonce format, pod) with two differences the relay's signing
 * fixes: freshness is the relay's own `timestamp` (a caller's `issuedAt` is not read), and the pod
 * is `pod_url` (the relay renames a caller's `podUrl` to it). `subject_pod_url`, the caller's OWN
 * pod, is never read as the pod an act targets. Run before the agent's DID document is fetched, so
 * a stale or misdirected request costs no fetch.
 */
export function checkRelayPayload(
  signedPayload: string, expectedAction: string, now: Date, o: { maxAgeMs?: number; maxSkewMs?: number } = {},
): { readonly ok: true; readonly payload: Readonly<Record<string, unknown>>; readonly issuedAt: string; readonly podUrl: string } | EnvelopeNo {
  if (!isWellFormedText(signedPayload)) {
    return no(400, 'payload-shape', '_signed_payload must be well-formed text (it holds half of a UTF-16 surrogate pair, which cannot be stored as sent).');
  }
  let parsed: unknown;
  try { parsed = JSON.parse(signedPayload); } catch { parsed = undefined; }
  if (!isRecord(parsed)) return no(400, 'envelope-payload-format', 'The signed payload must be a JSON object.');
  const checked = payloadChecks(parsed, expectedAction, now, { maxAgeMs: o.maxAgeMs ?? 600_000, maxSkewMs: o.maxSkewMs ?? 120_000 }, {
    issuedRaw: parsed['timestamp'], podRaw: parsed['pod_url'],
    noIssued: 'The relay-signed payload carries no readable timestamp (the relay sets it when it signs).',
    noPod: 'The relay-signed payload names no pod_url: put pod_url (or podUrl, which the relay keeps as pod_url), the absolute http(s) URL of the pod you act on, in the payload you ask the relay to sign. subject_pod_url, your own pod, is never read as the pod an act targets.',
  });
  if (!checked.ok) return checked;
  return { ok: true, payload: parsed, issuedAt: String(parsed['timestamp']), podUrl: checked.podUrl };
}

/** The accepted envelope of a relay-delegated request: the verifier's principal is the signer. */
export function relayDelegatedEnvelope(
  d: { readonly principal: string; readonly agentId: string; readonly relaySigner: string; readonly signedPayload: string; readonly signature: string },
  checked: { readonly payload: Readonly<Record<string, unknown>>; readonly issuedAt: string; readonly podUrl: string },
): EnvelopeOk {
  const relay: RelayAttestation = { authority: 'relay-delegated', principal: d.principal, agentId: d.agentId, relaySigner: d.relaySigner.toLowerCase() };
  const payloadSha256 = sha256(d.signedPayload);
  return {
    ok: true, form: 'signed-request', signer: d.principal, signerDid: d.principal,
    payload: { ...checked.payload, issuedAt: checked.issuedAt, podUrl: checked.podUrl },
    payloadSha256,
    stored: { form: 'signed-request', signature: d.signature, payloadSha256, signedPayload: d.signedPayload, ...relay },
    authority: 'relay-delegated', relay,
  };
}

/** What re-verifying a stored envelope trusts beyond the bytes: the relay addresses and the identity host. */
export interface StoredEnvelopeTrust { readonly relayAddresses: readonly string[]; readonly identityHost: string | null }

/**
 * Re-verify an envelope kept in a record from its exact signed bytes, with no network: the
 * principal it names and its payload, or null.
 *   · key-held: the address recovered from the signature (form B: `agent_id` names it);
 *   · relay-delegated: the signature recovers to a relay address `trust` still lists and to the
 *     `relaySigner` stored beside it, the signed `agent_id` is the stored `agentId`, an agent on
 *     the identity host, and the stored `principal` is a user on that host. The principal is then
 *     the stored one: whether the identity host still names that person as the agent's controller
 *     is NOT asked again, so a reader trusts the relay key for the signature and this bridge's
 *     platform signature over the record for what the identity host said when the act was taken.
 */
export function reverifyStoredEnvelope(e: StoredEnvelope, trust: StoredEnvelopeTrust):
  { readonly signer: string; readonly payload: Record<string, unknown>; readonly authority: Authority } | null {
  try {
    if (e.form === 'pev-canonical' && e.payload) {
      if (e.authority !== undefined) return null;
      const text = canonicalJson(e.payload);
      if (sha256(text) !== e.payloadSha256) return null;
      return { signer: recoverMessageSigner(text, e.signature), payload: { ...e.payload }, authority: 'key-held' };
    }
    if (e.form === 'signed-request' && e.signedPayload !== undefined) {
      if (sha256(e.signedPayload) !== e.payloadSha256) return null;
      const parsed: unknown = JSON.parse(e.signedPayload);
      if (!isRecord(parsed)) return null;
      const signer = recoverMessageSigner(`sha256:${sha256Hex(e.signedPayload)}`, e.signature);
      if (e.authority === 'relay-delegated') {
        const host = trust.identityHost;
        const relay = signer.toLowerCase();
        if (host === null || !trust.relayAddresses.map((x) => x.toLowerCase()).includes(relay) || e.relaySigner?.toLowerCase() !== relay) return null;
        if (typeof e.agentId !== 'string' || parsed['agent_id'] !== e.agentId || agentSlugOf(e.agentId, host) === null) return null;
        if (typeof e.principal !== 'string' || !isUserDid(e.principal, host)) return null;
        return { signer: e.principal, payload: parsed, authority: 'relay-delegated' };
      }
      if (e.authority !== undefined) return null;
      const named = typeof parsed['agent_id'] === 'string' ? addressOfDid(parsed['agent_id']) : null;
      if (named === null || !samePrincipal(named, signer)) return null;
      return { signer, payload: parsed, authority: 'key-held' };
    }
  } catch {
    return null;
  }
  return null;
}

/**
 * Nonces seen per principal, in this process: per person, never per relay address (the relay
 * signs for everyone). An entry lives for `ttlMs` (twice the envelope age limit), after which the
 * envelope is too old to pass `checkEnvelope` anyway.
 */
export class NonceLedger {
  private readonly seen = new Map<string, number>();
  constructor(private readonly ttlMs: number) {}
  /** True the first time a (principal, nonce) pair is seen within the window; false on reuse. */
  consume(signer: string, nonce: string, now: Date): boolean {
    const t = now.getTime();
    for (const [k, expires] of this.seen) if (expires <= t) this.seen.delete(k);
    const key = `${principalKey(signer)}|${nonce}`;
    if (this.seen.has(key)) return false;
    this.seen.set(key, t + this.ttlMs);
    return true;
  }
}

/** Form A: sign canonicalJson(payload). */
export async function signEnvelope(wallet: Wallet, payload: Record<string, unknown>): Promise<{ payload: Record<string, unknown>; signature: string }> {
  return { payload, signature: await signMessageRaw(wallet, canonicalJson(payload)) };
}

/** Form B: sign `sha256:` + sha256Hex(JSON). `agent_id` defaults to the wallet's own did. */
export async function signedRequestEnvelope(wallet: Wallet, payload: Record<string, unknown>): Promise<{ _signed_payload: string; _signature: string }> {
  const body = 'agent_id' in payload ? payload : { agent_id: didOf(wallet.address), ...payload };
  const signedPayload = JSON.stringify(body);
  return { _signed_payload: signedPayload, _signature: await signMessageRaw(wallet, `sha256:${sha256Hex(signedPayload)}`) };
}

// ═════════════════════════════════════════════════════════════════════════════════════════════
//  Draft receipts (§12.4): a platform-signed statement of which model drafted what
// ═════════════════════════════════════════════════════════════════════════════════════════════

export const DRAFT_RECEIPT_KIND = 'pev-draft-receipt';
export const DRAFT_RECEIPT_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;

export interface DraftReceiptPayload {
  readonly v: 1; readonly kind: typeof DRAFT_RECEIPT_KIND; readonly draftHash: string; readonly disclosure: InferenceDisclosure;
  readonly requestedBy: string; readonly issuedAt: string; readonly nonce: string;
}

export async function signDraftReceipt(
  platform: Wallet,
  p: { draftHash: string; disclosure: InferenceDisclosure; requestedBy: string; issuedAt: string; nonce: string },
): Promise<{ payload: Record<string, unknown>; signature: string }> {
  const payload: Record<string, unknown> = {
    v: 1, kind: DRAFT_RECEIPT_KIND, draftHash: p.draftHash, disclosure: p.disclosure,
    requestedBy: p.requestedBy, issuedAt: p.issuedAt, nonce: p.nonce,
  };
  return signEnvelope(platform, payload);
}

/** Verify a receipt: signed by a trusted platform address, for this signer, recent, of the right kind. */
export function verifyDraftReceipt(
  r: unknown, trusted: ReadonlySet<string>, signerDid: string, now: Date,
): { readonly ok: true; readonly payload: DraftReceiptPayload; readonly signer: string; readonly stored: StoredEnvelope } | { readonly ok: false; readonly why: string } {
  if (!isRecord(r) || !isRecord(r['payload']) || typeof r['signature'] !== 'string' || !SIGNATURE.test(r['signature'])) {
    return { ok: false, why: 'the receipt must be {payload, signature} as pev.draft_scenario returned it' };
  }
  const payload = r['payload'];
  const text = canonicalJson(payload);
  let signer: string;
  try { signer = recoverMessageSigner(text, r['signature']); } catch { return { ok: false, why: 'no signer can be recovered from the receipt' }; }
  if (!trusted.has(signer.toLowerCase())) return { ok: false, why: `the receipt was signed by ${signer}, which is not a trusted platform address` };
  if (payload['v'] !== 1 || payload['kind'] !== DRAFT_RECEIPT_KIND) return { ok: false, why: 'this is not a draft receipt' };
  if (typeof payload['requestedBy'] !== 'string' || !samePrincipal(principalOfDid(payload['requestedBy']), principalOfDid(signerDid))) {
    return { ok: false, why: 'the receipt was issued to someone else' };
  }
  const issued = typeof payload['issuedAt'] === 'string' ? Date.parse(payload['issuedAt']) : Number.NaN;
  if (!Number.isFinite(issued) || now.getTime() - issued > DRAFT_RECEIPT_MAX_AGE_MS || issued - now.getTime() > 120_000) {
    return { ok: false, why: 'the receipt is older than 7 days or not dated' };
  }
  if (typeof payload['draftHash'] !== 'string' || !/^[0-9a-f]{64}$/.test(payload['draftHash'])) return { ok: false, why: 'the receipt names no draft hash' };
  const d = payload['disclosure'];
  if (!isRecord(d) || typeof d['provider'] !== 'string' || typeof d['model'] !== 'string') return { ok: false, why: 'the receipt carries no model disclosure' };
  if (typeof payload['nonce'] !== 'string') return { ok: false, why: 'the receipt carries no nonce' };
  return {
    ok: true, signer,
    payload: payload as unknown as DraftReceiptPayload,
    stored: { form: 'pev-canonical', signature: r['signature'], payloadSha256: sha256(text), payload },
  };
}

// ═════════════════════════════════════════════════════════════════════════════════════════════
//  Roles
// ═════════════════════════════════════════════════════════════════════════════════════════════

/**
 * Apply one role change; `changed: false` when the principal already held (or lacked) the role.
 * Members are keyed by `principalKey`: an address in any case is one member, a DID only exactly.
 */
export function applyRoleChange(
  entries: readonly RoleEntry[], address: string, role: Role, change: 'add' | 'remove',
): { readonly entries: readonly RoleEntry[]; readonly changed: boolean } {
  const map = new Map<string, { address: string; roles: Set<Role> }>();
  for (const e of entries) map.set(principalKey(e.address), { address: e.address, roles: new Set(e.roles) });
  const key = principalKey(address);
  const cur = map.get(key);
  const had = cur?.roles.has(role) ?? false;
  if ((change === 'add' && had) || (change === 'remove' && !had)) return { entries, changed: false };
  if (change === 'add') {
    if (cur) cur.roles.add(role); else map.set(key, { address, roles: new Set([role]) });
  } else if (cur) {
    cur.roles.delete(role);
    if (cur.roles.size === 0) map.delete(key);
  }
  const out = [...map.values()]
    .sort((a, b) => principalKey(a.address).localeCompare(principalKey(b.address)))
    .map((e) => ({ address: e.address, roles: ROLES.filter((r) => e.roles.has(r)) }));
  return { entries: out, changed: true };
}

/** The roles a principal holds in a registry body (an address case-insensitively, a DID exactly). */
export function rolesOf(entries: readonly RoleEntry[], address: string): ReadonlySet<Role> {
  const e = entries.find((x) => samePrincipal(x.address, address));
  return new Set(e?.roles ?? []);
}

// ═════════════════════════════════════════════════════════════════════════════════════════════
//  Redaction (§11.3): keep every hash and level, drop personal text
// ═════════════════════════════════════════════════════════════════════════════════════════════

function redactEnvelope(e: StoredEnvelope): StoredEnvelope {
  // Who stood behind the signature stays: it is not the text, and a reader still tells a
  // relay-attested act from a key-held one.
  const relay = e.authority === 'relay-delegated'
    ? { authority: e.authority, ...(e.principal !== undefined ? { principal: e.principal } : {}), ...(e.agentId !== undefined ? { agentId: e.agentId } : {}), ...(e.relaySigner !== undefined ? { relaySigner: e.relaySigner } : {}) }
    : {};
  return { form: e.form, signature: e.signature, payloadSha256: e.payloadSha256, ...relay, redacted: true };
}

export function redactBody(a: AttemptBody, redaction: Redaction, at: string): AttemptBody {
  const { assistance, ...rest } = a;
  return {
    ...rest,
    ...(assistance !== undefined ? { assistanceSha256: sha256(assistance) } : {}),
    state: 'redacted',
    at,
    startEnvelope: redactEnvelope(a.startEnvelope),
    turns: a.turns.map((t) => {
      const { text: _text, envelope, ...keep } = t;
      return { ...keep, ...(envelope ? { envelope: redactEnvelope(envelope) } : {}) };
    }),
    judgments: a.judgments.map((j) => ({
      ...j,
      criteria: j.criteria.map((c) => {
        const { rationale: _rationale, ...keep } = c;
        return {
          ...keep,
          quotes: c.quotes.map((q) => {
            const { text: _qt, normalised: _qn, ...qk } = q;
            return qk;
          }),
        };
      }),
    })),
    reviews: a.reviews.map((r) => ({
      ...r,
      envelope: redactEnvelope(r.envelope),
      finalLevels: r.finalLevels.map((f) => {
        const { why, ...keep } = f;
        return why !== undefined ? { ...keep, whySha256: sha256(why) } : keep;
      }),
    })),
    reopenings: a.reopenings.map((o) => {
      const { why, ...keep } = o;
      return { ...keep, envelope: redactEnvelope(o.envelope), ...(why !== undefined ? { whySha256: sha256(why) } : {}) };
    }),
    acts: a.acts,
    redaction,
  };
}

export const REDACTION_NOTE = 'The text of this attempt was removed from this pod. Hashes remain, so a copy you hold can still be checked against this record. The hashes are plain sha256 of each line and quote: anyone who can read this pod can confirm a guess of a short or predictable line against them.';

/** How a learner checks an exported record with no pod and no bridge. */
export const EXPORT_VERIFY_STEPS: readonly string[] = [
  'parseAuthorshipProofFromDescriptorTurtle(descriptorTurtle), from @interego/solid, gives the platform proof.',
  'digestedGraphRegion({ descriptorTurtle, graphContent: graphTrig }), from @interego/solid, gives the signed region.',
  'canonicalGraphDigest(region.turtle), from @interego/core, gives the content hash the proof must bind.',
  'verifySignedAuthorship(proof, makeWalletDelegationVerifier(), { contentHash }), from @interego/core, must answer valid with contentBinding bound.',
  'proof.signerAddress must be one of platformAddresses.',
  'An envelope kept in a record with authority relay-delegated was signed by the Interego relay for agentId, not by the person: recoverMessageSigner(\'sha256:\' + sha256Hex(signedPayload), signature), from @interego/core, must be its relaySigner and one of relayAddresses, and the signed payload\'s agent_id must be agentId (did:web:<identityHost>:agents:…). principal (did:web:<identityHost>:users:…) is who the identity host said controlled that agent when the act was taken, as this platform signed it into the record; a reader who wants it asked again fetches https://<identityHost>/agents/<slug>/did.json, whose controller may have changed since.',
];

// ═════════════════════════════════════════════════════════════════════════════════════════════
//  Next actions (§12.26, A4): what this caller can do next, from the record's own state
// ═════════════════════════════════════════════════════════════════════════════════════════════

export interface NextAction { readonly action: string; readonly toolName: string; readonly label: string; readonly why: string }
export interface NextActionView {
  readonly state: LifecycleState; readonly authorTest: boolean; readonly judgmentCount: number; readonly contestCount: number;
  readonly learnerTurns: number; readonly mayCountersignAsIs: boolean;
  /** True when the caller is the learner, a judge signer, a reviewer who asked for the primary judgment or chose a judge's model, or an earlier reviewer. */
  readonly callerConflicted: boolean;
}

const NEXT: Readonly<Partial<Record<PevActionKey, { label: string; why: string }>>> = {
  say: { label: 'Send your line', why: 'Say your next line; this bridge\'s model answers as the other person.' },
  counterpartPacket: { label: 'Get a packet for your own agent', why: 'Let your own agent speak as the other person; the record will say so.' },
  recordTurns: { label: 'Record a line from your agent', why: 'Record your line together with the line your own agent wrote for the other person.' },
  endConversation: { label: 'End the conversation', why: 'Stop here; the transcript is then fixed and can be judged.' },
  judgeAttempt: { label: 'Ask this bridge to judge', why: 'A model chooses levels and quotes; the platform checks every quote and computes the result.' },
  judgePacket: { label: 'Get a judge packet', why: 'An independent judge agent can judge this attempt from the packet.' },
  exportRecord: { label: 'Download my record', why: 'Every version of this record with its platform signature, checkable offline.' },
  holderCopy: { label: 'Copy to my pod', why: 'Writes a copy of every version to a pod you name.' },
  redactAttempt: { label: 'Remove the transcript from this pod', why: 'Deletes the text from the operator pod; hashes stay, so copies you hold can still be checked.' },
  projectAttempt: { label: 'Build an xAPI statement', why: 'A reviewer stood behind this attempt on a ratified rubric, so it can leave as practice evidence.' },
  contestReview: { label: 'Contest this review', why: 'Ask a different reviewer to look again, saying why.' },
  countersignAttempt: { label: 'Countersign as judged', why: 'Confirm every level the primary judgment chose.' },
  overrideAttempt: { label: 'Set the levels', why: 'Choose every level yourself, saying why wherever it differs from the judge or a quote did not check out.' },
  retractReview: { label: 'Withdraw the review for cause', why: 'Withdraws the standing review; the learner sees why and the attempt returns to the queue.' },
};

function nextAction(key: PevActionKey, labelOverride?: string): NextAction {
  const action = PEV_ACTION[key];
  const n = NEXT[key] ?? { label: key, why: '' };
  return { action, toolName: toolNameOf(action) ?? '', label: labelOverride ?? n.label, why: n.why };
}

/** The acts this caller may take on this attempt now. The UI renders its controls from this list. */
export function nextActionsFor(
  view: NextActionView, callerRoles: ReadonlySet<string>,
  o: { bridgeHasModel: boolean; isLearner: boolean; isAdmin: boolean; eligible: boolean },
): NextAction[] {
  const out = new Map<string, NextAction>();
  const add = (key: PevActionKey, label?: string): void => { if (!out.has(PEV_ACTION[key])) out.set(PEV_ACTION[key], nextAction(key, label)); };
  const s = view.state;
  const reviewed = s === 'countersigned' || s === 'overridden';
  const moreJudgments = view.judgmentCount < MAX_JUDGMENTS;
  if (o.isLearner) {
    if (s === 'in-conversation') {
      if (o.bridgeHasModel) add('say');
      add('counterpartPacket');
      add('recordTurns');
      if (view.learnerTurns >= 1) add('endConversation');
    } else if (s === 'ended') {
      if (o.bridgeHasModel) add('judgeAttempt');
      add('judgePacket');
    } else if (s === 'judged') {
      if (o.bridgeHasModel && moreJudgments) add('judgeAttempt', 'Ask for a second opinion');
      if (moreJudgments) add('judgePacket');
      add('exportRecord'); add('holderCopy'); add('redactAttempt');
    } else if (reviewed) {
      if (o.eligible) add('projectAttempt');
      if (view.contestCount < MAX_CONTESTS) add('contestReview');
      add('exportRecord'); add('holderCopy'); add('redactAttempt');
    } else if (s === 'contested' || s === 'review-retracted') {
      add('exportRecord'); add('holderCopy'); add('redactAttempt');
    } else if (s === 'redacted') {
      add('exportRecord');
    }
  }
  if (callerRoles.has('reviewer') && !callerRoles.has('agent')) {
    if (!view.callerConflicted && !view.authorTest && (s === 'judged' || s === 'contested' || s === 'review-retracted')) {
      if (view.mayCountersignAsIs) add('countersignAttempt');
      add('overrideAttempt');
      if (o.bridgeHasModel && moreJudgments) add('judgeAttempt', 'Ask for a second opinion');
    }
    if (reviewed && o.eligible) add('projectAttempt');
  }
  if (o.isAdmin) {
    if (reviewed || s === 'contested') add('retractReview');
    if (s !== 'redacted') add('redactAttempt');
  }
  return [...out.values()];
}

/** The principal keys (`principalKey`) of every judge that signed a judgment of this attempt (the packet route). */
export function judgeSignersOf(a: AttemptBody): string[] {
  return a.judgments.flatMap((j) => (j.judge.signer !== undefined ? [principalKey(principalOfDid(j.judge.signer))] : []));
}

/**
 * The principal keys of reviewers who signed the act that produced the primary judgment (the one
 * a countersign confirms), or had any judgment made by a model they chose with their own key.
 */
export function judgeRequestersOf(a: AttemptBody): string[] {
  return a.judgments.flatMap((j, i) => {
    const requestedPrimary = i === 0 && j.requestedBy.role === 'reviewer';
    if (!requestedPrimary && j.chosenBy !== 'reviewer') return [];
    return [principalKey(principalOfDid(j.requestedBy.did))];
  });
}

/**
 * Everyone who may not review this attempt, as principal keys (`principalKey`: addresses lower
 * case, user DIDs as they are): the learner, every judge that signed a judgment, a reviewer who
 * asked for the primary judgment or chose a judge's model with their own key, and every earlier
 * reviewer (DECISIONS #2: the countersigner differs from the original signer, the subject and the
 * judge).
 */
export function conflictedReviewersOf(a: AttemptBody): string[] {
  return [...new Set([
    principalKey(a.learner.address), ...judgeSignersOf(a), ...judgeRequestersOf(a), ...a.reviews.map((r) => principalKey(r.reviewer.address)),
  ])];
}

/** The figures nextActionsFor reads, from an attempt body and a caller (a principal). */
export function nextActionView(a: AttemptBody, caller: string): NextActionView {
  const primary = a.judgments[0];
  return {
    state: a.state, authorTest: a.authorTest, judgmentCount: a.judgments.length,
    contestCount: a.reopenings.filter((r) => r.kind === 'contest').length,
    learnerTurns: learnerTurnCount(a.turns),
    mayCountersignAsIs: primary !== undefined && primary.unverifiedCriteria.length === 0,
    callerConflicted: conflictedReviewersOf(a).includes(principalKey(caller)),
  };
}

// ═════════════════════════════════════════════════════════════════════════════════════════════
//  Identifiers (§3)
// ═════════════════════════════════════════════════════════════════════════════════════════════

/** The URL with exactly one trailing slash. */
export function podBase(url: string): string { return `${url.replace(/\/+$/, '')}/`; }
export function scenarioIri(podUrl: string, scenarioKey: string): string {
  return `urn:pev:scenario:${sha256(`${podBase(podUrl)}|${scenarioKey}`).slice(0, 16)}`;
}
/**
 * The key shared by every attempt of one learner on one scenario on one pod: the part of the
 * attempt IRI before `-<n>`.
 *
 * Without `secret` it is k16, a plain sha256 of the pod, the scenario and the learner's address,
 * so anyone who can read the pod's manifest and holds a candidate address can tell which attempts
 * are that learner's. With `secret` (`attemptIriSecret` of the bridge's record key) it is
 * `k<fingerprint>:<k16>`, where k16 is an HMAC-SHA256 under that secret, so only a holder of the
 * record key can link an attempt IRI to an address, and the fingerprint (`iriKeyFingerprint`)
 * names the key it was derived under. Attempts started before the key was set keep their plain
 * key, so a lookup tries the keyed form first and then the plain one.
 */
export function attemptKey(podUrl: string, scenarioIriValue: string, learner: string, secret?: string): string {
  // The learner is a principal: an address lower-cased (as before), a user DID exactly as it is.
  const message = `${podBase(podUrl)}|${scenarioIriValue}|${principalKey(learner)}`;
  return secret === undefined
    ? sha256(message).slice(0, 16)
    : `k${iriKeyFingerprint(secret)}:${createHmac('sha256', Buffer.from(secret, 'hex')).update(message, 'utf8').digest('hex').slice(0, 16)}`;
}
/**
 * The attempt-IRI secret derived from the record key pair (an HMAC of its secret key under the
 * label `pev-attempt-iri`), hex. Every bridge holding the same PEV_RECORD_KEY derives the same one.
 */
export function attemptIriSecret(recordKey: { readonly secretKey: string }): string {
  return createHmac('sha256', Buffer.from(recordKey.secretKey, 'base64')).update('pev-attempt-iri', 'utf8').digest('hex');
}
/**
 * The public identifier of an attempt-IRI secret: the first 8 hex of
 * HMAC-SHA256(secret, 'pev-iri-key-fingerprint'). Every keyed attempt IRI carries it, so a bridge
 * can tell that a pod holds attempts keyed under a record key it does not hold before it answers a
 * lookup from their absence. It is a key identifier: an HMAC output under a secret key says
 * nothing about the key, and the label is not the one any IRI segment is keyed with, so it says
 * nothing about any learner either.
 */
export function iriKeyFingerprint(secret: string): string {
  return createHmac('sha256', Buffer.from(secret, 'hex')).update('pev-iri-key-fingerprint', 'utf8').digest('hex').slice(0, 8);
}
/** A keyed attempt IRI: `urn:pev:attempt:k<fingerprint>:<k16>-<n>`. */
const KEYED_ATTEMPT_IRI = /^urn:pev:attempt:k([0-9a-f]{8}):[0-9a-f]{16}-[1-9][0-9]*$/;
/** The key fingerprint a keyed attempt IRI carries, or null for a plain (or any other) IRI. */
export function fingerprintOfAttemptIri(iri: string): string | null {
  return KEYED_ATTEMPT_IRI.exec(iri)?.[1] ?? null;
}

/** A UTF-16 code unit that is half of a surrogate pair with no other half. */
const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;
/**
 * True when `s` is well-formed UTF-16: no lone surrogate. Text that is not cannot be encoded as
 * UTF-8 without loss, so it cannot be sealed or hashed as what was sent.
 */
export function isWellFormedText(s: string): boolean { return !LONE_SURROGATE.test(s); }
/** `s` with every lone surrogate replaced by U+FFFD, which is what a UTF-8 encoder writes for it. */
export function toWellFormedText(s: string): string {
  return isWellFormedText(s) ? s : s.replace(new RegExp(LONE_SURROGATE.source, 'g'), '�');
}
export function attemptIri(key: string, n: number): string { return `urn:pev:attempt:${key}-${n}`; }
export function registryIri(podUrl: string): string { return `urn:pev:role-registry:${sha256(podBase(podUrl)).slice(0, 16)}`; }
export function projectionIri(attemptIriValue: string, format: string, nonce: string): string {
  return `urn:pev:projection:${sha256(`${attemptIriValue}|${format}|${nonce}`).slice(0, 16)}`;
}
export function recordIdFor(graphIri: string, seq: number, at: string, nonce: string): string {
  return `urn:pev:record:${sha256(`${graphIri}|${seq}|${at}|${nonce}`).slice(0, 16)}`;
}
export function rubricIriOf(rubricHashValue: string): string { return `urn:pev:rubric:${rubricHashValue}`; }
export function criterionIri(rubricHashValue: string, criterionId: string): string {
  return `${rubricIriOf(rubricHashValue)}#criterion-${criterionId}`;
}
export function levelIri(rubricHashValue: string, criterionId: string, levelId: string): string {
  return `${criterionIri(rubricHashValue, criterionId)}-level-${levelId}`;
}

/** The local part of a record id (`urn:pev:record:<local>`). */
export function recordLocal(recordId: string): string {
  return recordId.startsWith('urn:pev:record:') ? recordId.slice('urn:pev:record:'.length) : sha256(recordId).slice(0, 16);
}

/**
 * Descriptor slug, unique per record (§3): a race from one head writes two resources, never one
 * twice. A record sealed to a record key ends in `-k<fingerprint>` (`keyFingerprint`, the key's
 * `iriKeyFingerprint`), so the pod's manifest names, for every sealed record, which key sealed it:
 * see `fingerprintOfRecordUrl`.
 */
export function slugFor(kind: PevRecordBody['kind'], graphIri: string, seq: number, recordId: string, keyFingerprint?: string): string {
  const rec8 = recordLocal(recordId).slice(0, 8);
  const tail = graphIri.slice(graphIri.lastIndexOf(':') + 1);
  const mark = keyFingerprint === undefined ? '' : `-k${keyFingerprint}`;
  switch (kind) {
    case 'scenario': return `scenario-${tail}-s${seq}-${rec8}${mark}`;
    case 'attempt': return `attempt-${tail}-s${seq}-${rec8}${mark}`;
    case 'role-registry': return `roles-${tail}-s${seq}-${rec8}${mark}`;
    case 'projection-audit': return `projection-${tail}${mark}`;
  }
}

/** A sealed record's descriptor URL: `…-k<fingerprint>.ttl` (no unsealed slug ends in `-k` and 8 hex). */
const SEALED_RECORD_URL = /-k([0-9a-f]{8})\.ttl$/;
/**
 * The key fingerprint a sealed record's descriptor URL carries (see `slugFor`), or null for a
 * plaintext record's. Like a keyed attempt IRI's, it is a key identifier and says nothing else.
 */
export function fingerprintOfRecordUrl(descriptorUrl: string): string | null {
  return SEALED_RECORD_URL.exec(descriptorUrl)?.[1] ?? null;
}

const SAFE_SEGMENT = /^[A-Za-z0-9._-]{1,120}$/;
/** The software agent IRI for a model that drafted or judged. */
export function modelAgentIri(provider: string, model: string): string {
  return SAFE_SEGMENT.test(provider) && SAFE_SEGMENT.test(model)
    ? `urn:pev:model:${provider}:${model}`
    : `urn:pev:model:sha-${sha256(`${provider}/${model}`).slice(0, 16)}`;
}

// ═════════════════════════════════════════════════════════════════════════════════════════════
//  Graph Turtle (§14) and read-back
// ═════════════════════════════════════════════════════════════════════════════════════════════

const RDF_TYPE = 'http://www.w3.org/1999/02/22-rdf-syntax-ns#type';

/** An IRI reference, or a thrown TypeError: never an unchecked `<…>`. */
function ref(v: string): string {
  const r = turtleIriRef(v);
  if (r === null) throw new TypeError(`unsafe IRI: ${JSON.stringify(v).slice(0, 120)}`);
  return r;
}
const lit = (s: string): string => `"${escapeTurtleLiteral(s)}"`;
const int = (n: number): string => `"${Math.trunc(n)}"^^xsd:integer`;
const bool = (b: boolean): string => `"${b ? 'true' : 'false'}"^^xsd:boolean`;
const dec = (n: number, places: number): string => `"${n.toFixed(places)}"^^xsd:decimal`;
const when = (iso: string): string => `"${escapeTurtleLiteral(iso)}"^^xsd:dateTime`;

const PREFIXES = [
  `@prefix pev: ${ref(PEV_NS)} .`,
  `@prefix dct: ${ref('http://purl.org/dc/terms/')} .`,
  `@prefix rdfs: ${ref('http://www.w3.org/2000/01/rdf-schema#')} .`,
  `@prefix xsd: ${ref('http://www.w3.org/2001/XMLSchema#')} .`,
  `@prefix prov: ${ref('http://www.w3.org/ns/prov#')} .`,
].join('\n');

type Obj = string | readonly string[] | undefined;
type Pair = readonly [string, Obj];

function block(subject: string, type: string, pairs: readonly Pair[]): string {
  const lines = [`${ref(subject)} a ${type}`];
  for (const [p, o] of pairs) {
    if (o === undefined) continue;
    const objs = typeof o === 'string' ? [o] : o;
    if (objs.length === 0) continue;
    lines.push(`    ${p} ${objs.join(', ')}`);
  }
  return `${lines.join(' ;\n')} .`;
}

function envelopePairs(e: StoredEnvelope | undefined): Pair[] {
  if (!e) return [];
  return [['pev:envelopeForm', lit(e.form)], ['pev:envelopeSignature', lit(e.signature)], ['pev:envelopePayloadSha256', lit(e.payloadSha256)]];
}

function commonPairs(b: PevRecordBody, json: string): Pair[] {
  return [
    ['pev:keyKind', lit(b.keyKind)],
    ['pev:platformSigner', lit(b.platformSigner)],
    ['pev:recordJson', lit(json)],
    ['pev:recordJsonSha256', lit(sha256(json))],
  ];
}

function disclosureBlock(iri: string, d: InferenceDisclosure): string {
  return block(iri, 'pev:InferenceDisclosure', [
    ['pev:provider', lit(d.provider)],
    ['pev:model', lit(d.model)],
    ['pev:requestedModel', d.requestedModel !== undefined ? lit(d.requestedModel) : undefined],
    ['pev:keySource', lit(d.keySource)],
    ['pev:route', lit(d.route)],
    ['pev:promptTemplateHash', d.promptTemplateHash !== undefined ? lit(d.promptTemplateHash) : undefined],
    ['pev:inputTokens', d.usage ? int(d.usage.inputTokens) : undefined],
    ['pev:outputTokens', d.usage ? int(d.usage.outputTokens) : undefined],
    ['pev:latencyMs', d.latencyMs !== undefined ? int(Math.round(d.latencyMs)) : undefined],
    ['pev:stopReason', typeof d.stopReason === 'string' ? lit(d.stopReason) : undefined],
    ['pev:declaredBy', d.declaredBy !== undefined ? ref(d.declaredBy) : undefined],
  ]);
}

function rubricBlocks(s: ScenarioSpec, hash: string, contentHashes?: Readonly<Record<string, string>>): string[] {
  const R = rubricIriOf(hash);
  const r = s.rubric;
  const out: string[] = [block(R, 'pev:Rubric', [
    ['pev:rubricHash', lit(hash)],
    ['pev:hasCriterion', r.criteria.map((c) => ref(criterionIri(hash, c.id)))],
    ['pev:minPercent', r.passRule ? int(r.passRule.minPercent) : undefined],
    ['pev:requiresLevel', r.passRule ? Object.entries(r.passRule.requiredLevels).map(([c, l]) => ref(levelIri(hash, c, l))) : undefined],
  ])];
  for (const c of r.criteria) {
    out.push(block(criterionIri(hash, c.id), 'pev:Criterion', [
      ['pev:criterionId', lit(c.id)],
      ['pev:criterionContentHash', lit(contentHashes?.[c.id] ?? criterionContentHash(c))],
      ['dct:title', lit(c.title)],
      ['dct:description', lit(c.description)],
      ['pev:weight', c.weight !== null ? int(c.weight) : undefined],
      ['pev:hasLevel', c.levels.map((l) => ref(levelIri(hash, c.id, l.id)))],
    ]));
    c.levels.forEach((l, j) => {
      out.push(block(levelIri(hash, c.id, l.id), 'pev:Level', [
        ['pev:levelId', lit(l.id)],
        ['rdfs:label', lit(l.label)],
        ['pev:levelDescriptor', lit(l.descriptor)],
        ['pev:levelValue', l.value !== null ? int(l.value) : undefined],
        ['pev:levelOrder', int(j)],
      ]));
    });
  }
  return out;
}

function scenarioGraph(b: ScenarioBody, json: string): string[] {
  const s = b.scenario;
  const S = b.scenarioIri;
  const counterpart = `${S}#counterpart-v${b.version}`;
  const ratification = `${S}#ratification-v${b.version}`;
  const da = b.draftAssistance;
  const blocks = [block(S, 'pev:Scenario', [
    ['pev:scenarioKey', lit(s.scenarioKey)],
    ['pev:scenarioVersion', int(b.version)],
    ['pev:scenarioStatus', lit(b.status)],
    ['pev:assessmentUse', lit(s.assessmentUse)],
    ['pev:workRegime', lit(s.workRegime)],
    ['pev:passGateWhy', s.passGateWhy !== null ? lit(s.passGateWhy) : undefined],
    ['dct:title', lit(s.title)],
    ['pev:learnerGoal', lit(s.learnerGoal)],
    ['pev:learnerPart', lit(s.learnerPart)],
    ['pev:situation', lit(s.situation)],
    ['dct:language', lit(s.language)],
    ['pev:firstLine', lit(s.firstLine)],
    ['pev:endsWhen', lit(s.endsWhen)],
    ['pev:turnLimit', int(s.turnLimit)],
    ['pev:scenarioHash', lit(b.scenarioHash)],
    ['pev:rubricHash', lit(b.rubricHash)],
    ['pev:hasCounterpart', ref(counterpart)],
    ['pev:hasRubric', ref(b.rubricIri)],
    ['pev:author', b.versionAuthors.map((a) => ref(principalDid(a)))],
    ['pev:draftAssistance', lit(canonicalJson(da))],
    ['pev:draftMeasured', bool(da.used && da.measured)],
    ['pev:editedAfterDraft', da.used && da.measured ? bool(da.editedAfterDraft) : undefined],
    ['pev:hasRatification', b.ratification ? ref(ratification) : undefined],
    ['pev:serverHeldDemoKey', b.actor.serverHeldDemoKey ? bool(true) : undefined],
    ...envelopePairs(b.envelope),
    ...commonPairs(b, json),
  ])];
  blocks.push(block(counterpart, 'pev:Counterpart', [
    ['pev:counterpartName', lit(s.counterpart.name)],
    ['pev:counterpartProfile', lit(s.counterpart.profile)],
    ['pev:counterpartWants', lit(s.counterpart.wants)],
    ['pev:counterpartKnows', lit(s.counterpart.knows)],
    ['pev:counterpartReactions', lit(s.counterpart.reactions)],
  ]));
  blocks.push(...rubricBlocks(s, b.rubricHash, b.criterionContentHashes));
  if (b.ratification) {
    blocks.push(block(ratification, 'pev:Ratification', [
      ['pev:ratifiedBy', ref(b.ratification.reviewer.did)],
      ['prov:endedAtTime', when(b.ratification.at)],
      ['pev:serverHeldDemoKey', b.ratification.reviewer.serverHeldDemoKey ? bool(true) : undefined],
      ...envelopePairs(b.ratification.envelope),
    ]));
  }
  return blocks;
}

function assessmentPairs(x: Assessment | undefined): Pair[] {
  if (!x) return [];
  const pairs: Pair[] = [['pev:assessmentProvisional', bool(x.provisional)], ['pev:scoreComputedBy', lit(x.computedBy)]];
  if (x.use === 'pass-gate') {
    pairs.push(['pev:scorePoints', int(x.points)], ['pev:maxPoints', int(x.maxPoints)],
      ['pev:scorePercent', `"${x.percent}"^^xsd:decimal`], ['pev:meetsPassRule', bool(x.meetsPassRule)]);
  }
  return pairs;
}

function attemptGraph(a: AttemptBody, json: string): string[] {
  const A = a.attemptIri;
  const H = a.scenario.rubricHash;
  const standing = standingReview(a);
  const blocks: string[] = [];
  blocks.push(block(A, 'pev:Attempt', [
    ['pev:lifecycleState', lit(a.state)],
    ['pev:evidenceKind', lit(a.evidenceKind)],
    ['pev:scenario', ref(a.scenario.scenarioIri)],
    ['pev:scenarioVersion', int(a.scenario.version)],
    ['pev:scenarioHash', lit(a.scenario.scenarioHash)],
    ['pev:rubricHash', lit(H)],
    ['pev:learner', ref(a.learner.did)],
    ['pev:learnerKind', lit(a.learner.kind)],
    ['pev:attemptNumber', int(a.attemptNumber)],
    ['pev:coached', bool(a.coached)],
    ['pev:assistance', a.assistance !== undefined ? lit(a.assistance) : undefined],
    ['pev:authorTest', bool(a.authorTest)],
    ['prov:startedAtTime', when(a.startedAt)],
    ['prov:endedAtTime', a.endedAt !== undefined ? when(a.endedAt) : undefined],
    ['pev:endedBy', a.endedBy !== undefined ? lit(a.endedBy) : undefined],
    ['pev:endProposedAtTurn', a.endProposedAtTurn !== undefined ? int(a.endProposedAtTurn) : undefined],
    ['pev:transcriptHash', a.transcriptHash !== undefined ? lit(a.transcriptHash) : undefined],
    ['pev:counterpartControlledBy', lit(a.counterpartControlledBy)],
    ['pev:judgmentCount', int(a.judgments.length)],
    ['pev:hasTurn', a.turns.map((t) => ref(`${A}#turn-${t.index}`))],
    ['pev:hasJudgment', a.judgments.map((j) => ref(`${A}#judgment-${j.index}`))],
    ['pev:hasReview', a.reviews.map((r) => ref(`${A}#review-${r.index}`))],
    ['pev:hasReopening', a.reopenings.map((o) => ref(`${A}#reopening-${o.index}`))],
    ['pev:hasRedaction', a.redaction ? ref(`${A}#redaction`) : undefined],
    ...assessmentPairs(standing?.assessment ?? a.judgments[0]?.provisional),
    ['pev:serverHeldDemoKey', anyDemoSigner(a) ? bool(true) : undefined],
    ...envelopePairs(a.startEnvelope),
    ...commonPairs(a, json),
  ]));
  for (const t of a.turns) {
    const T = `${A}#turn-${t.index}`;
    blocks.push(block(T, 'pev:Turn', [
      ['pev:turnIndex', int(t.index)],
      ['pev:speaker', lit(t.speaker)],
      ['pev:text', t.text !== undefined ? lit(t.text) : undefined],
      ['pev:textSha256', lit(t.textSha256)],
      ['pev:turnSource', lit(t.source)],
      ['pev:endSignal', t.endSignal ? bool(true) : undefined],
      ['pev:disclosure', t.disclosure ? ref(`${T}-disclosure`) : undefined],
      ['prov:generatedAtTime', when(t.at)],
      ...envelopePairs(t.envelope),
    ]));
    if (t.disclosure) blocks.push(disclosureBlock(`${T}-disclosure`, t.disclosure));
  }
  for (const j of a.judgments) {
    const J = `${A}#judgment-${j.index}`;
    blocks.push(block(J, 'pev:Judgment', [
      ['pev:judgmentIndex', int(j.index)],
      ['pev:judgeId', lit(j.judge.id)],
      ['pev:judgeKind', lit(j.judge.kind)],
      ['pev:judgeChosenBy', lit(j.chosenBy)],
      ['pev:promptTemplateHash', lit(j.promptTemplateHash)],
      ['pev:repeatOf', j.repeatOf !== null ? int(j.repeatOf) : undefined],
      ['pev:judgeSigner', j.judge.signer !== undefined ? ref(j.judge.signer) : undefined],
      ['pev:disclosure', ref(`${J}-disclosure`)],
      ['pev:rubricHash', lit(j.rubricHash)],
      ['pev:transcriptHash', lit(j.transcriptHash)],
      ['prov:endedAtTime', when(j.judgedAt)],
      ['pev:hasCriterionJudgment', j.criteria.map((c) => ref(`${A}#j${j.index}-cj-${c.criterionId}`))],
    ]));
    blocks.push(disclosureBlock(`${J}-disclosure`, j.disclosure));
    for (const c of j.criteria) {
      const C = `${A}#j${j.index}-cj-${c.criterionId}`;
      blocks.push(block(C, 'pev:CriterionJudgment', [
        ['pev:criterion', ref(criterionIri(j.rubricHash, c.criterionId))],
        ['pev:judgedLevel', ref(levelIri(j.rubricHash, c.criterionId, c.levelId))],
        ['pev:verificationStatus', lit(c.status)],
        ['pev:quoteWhy', c.why !== undefined ? lit(c.why) : undefined],
        ['pev:declaredConfidence', c.confidence !== null ? dec(c.confidence, 4) : undefined],
        ['pev:rationale', c.rationale !== undefined ? lit(c.rationale) : undefined],
        ['pev:rationaleSha256', lit(c.rationaleSha256)],
        ['pev:hasQuote', c.quotes.map((_q, k) => ref(`${C}-q${k}`))],
      ]));
      c.quotes.forEach((q, k) => {
        blocks.push(block(`${C}-q${k}`, 'pev:Quote', [
          ['pev:quoteText', q.text !== undefined ? lit(q.text) : undefined],
          ['pev:quoteSha256', lit(q.quoteSha256)],
          ['pev:verified', bool(q.verified)],
          ['pev:turnIndex', q.verified && q.turnIndex !== undefined ? int(q.turnIndex) : undefined],
          ['pev:startOffset', q.start !== undefined ? int(q.start) : undefined],
          ['pev:endOffset', q.end !== undefined ? int(q.end) : undefined],
          ['pev:quoteWhy', q.why !== undefined ? lit(q.why) : undefined],
        ]));
      });
    }
  }
  for (const r of a.reviews) {
    const V = `${A}#review-${r.index}`;
    blocks.push(block(V, 'pev:Review', [
      ['pev:reviewIndex', int(r.index)],
      ['pev:reviewOutcome', lit(r.outcome)],
      ['pev:reviewer', ref(r.reviewer.did)],
      ['pev:reviewedRecord', ref(r.target.recordId)],
      ['pev:reviewedGraphDigest', lit(r.target.graphDigest)],
      ['pev:sawJudgeLevelsFirst', bool(r.sawJudgeLevelsFirst)],
      ['prov:endedAtTime', when(r.reviewedAt)],
      ['pev:withdrawn', r.withdrawn ? bool(true) : undefined],
      ['pev:serverHeldDemoKey', r.reviewer.serverHeldDemoKey ? bool(true) : undefined],
      ['pev:hasReviewedLevel', r.finalLevels.map((f) => ref(`${V}-level-${f.criterionId}`))],
      ...envelopePairs(r.envelope),
    ]));
    for (const f of r.finalLevels) {
      blocks.push(block(`${V}-level-${f.criterionId}`, 'pev:ReviewedLevel', [
        ['pev:criterion', ref(criterionIri(H, f.criterionId))],
        ['pev:finalLevel', ref(levelIri(H, f.criterionId, f.levelId))],
        ['pev:levelFrom', lit(f.from)],
        ['pev:overrideWhy', f.why !== undefined ? lit(f.why) : undefined],
      ]));
    }
  }
  for (const o of a.reopenings) {
    blocks.push(block(`${A}#reopening-${o.index}`, 'pev:Reopening', [
      ['pev:reopenKind', lit(o.kind)],
      ['pev:reopenedBy', ref(o.by.did)],
      ['pev:reopenWhy', o.why !== undefined ? lit(o.why) : undefined],
      ['pev:reviewIndex', int(o.reviewIndex)],
      ['pev:reviewedRecord', ref(o.target.recordId)],
      ['pev:reviewedGraphDigest', lit(o.target.graphDigest)],
      ['prov:startedAtTime', when(o.at)],
      ...envelopePairs(o.envelope),
    ]));
  }
  if (a.redaction) {
    blocks.push(block(`${A}#redaction`, 'pev:Redaction', [
      ['pev:redactedBy', ref(a.redaction.by.did)],
      ['pev:redactionRole', lit(a.redaction.role)],
      ['prov:endedAtTime', when(a.redaction.at)],
      ...envelopePairs(a.redaction.envelope),
    ]));
  }
  return blocks;
}

function registryGraph(b: RoleRegistryBody, json: string): string[] {
  const G = b.registryIri;
  const blocks = [block(G, 'pev:RoleRegistry', [
    ['pev:hasAssignment', b.entries.map((e) => ref(`${G}#${principalKey(e.address)}`))],
    ['pev:serverHeldDemoKey', b.actor.serverHeldDemoKey ? bool(true) : undefined],
    ...envelopePairs(b.envelope),
    ...commonPairs(b, json),
  ])];
  for (const e of b.entries) {
    blocks.push(block(`${G}#${principalKey(e.address)}`, 'pev:RoleAssignment', [
      ['pev:address', lit(e.address)],
      ['pev:role', e.roles.map((r) => lit(r))],
    ]));
  }
  return blocks;
}

function projectionGraph(b: ProjectionAuditBody, json: string): string[] {
  return [block(b.projectionIri, 'pev:ProjectionAudit', [
    ['pev:projectionFormat', lit(b.format)],
    ['pev:projectionOutcome', lit(b.outcome)],
    ['pev:projectedAttempt', ref(b.attemptIri)],
    ['pev:projectedRecord', b.headDescriptorUrl !== null ? ref(b.headDescriptorUrl) : undefined],
    ['pev:statementId', b.statementId !== undefined ? lit(b.statementId) : undefined],
    ['pev:skipWhy', b.skipWhy !== undefined ? lit(b.skipWhy) : undefined],
    ['pev:lossyNote', b.lossy.map((x) => lit(x))],
    ['pev:registryCheckedAt', b.registryCheckedAt !== undefined ? when(b.registryCheckedAt) : undefined],
    ...commonPairs(b, json),
  ])];
}

/** The Turtle of a record graph: typed pev: triples plus the body as canonical JSON with its hash. */
export function recordGraphTurtle(body: PevRecordBody): string {
  const json = canonicalJson(body);
  let blocks: string[];
  switch (body.kind) {
    case 'scenario': blocks = scenarioGraph(body, json); break;
    case 'attempt': blocks = attemptGraph(body, json); break;
    case 'role-registry': blocks = registryGraph(body, json); break;
    case 'projection-audit': blocks = projectionGraph(body, json); break;
  }
  return `${PREFIXES}\n\n${blocks.join('\n\n')}\n`;
}

const RECORD_CLASS_BY_IRI = new Map<string, PevRecordBody['kind']>(
  (Object.entries(RECORD_CLASS) as [PevRecordBody['kind'], string][]).map(([k, v]) => [v, k]),
);

/**
 * The body a record graph carries, taken from its `pev:recordJson` literal and refused unless the
 * literal's sha256 equals `pev:recordJsonSha256` and the body describes the subject it sits on.
 */
export function recordBodyFromGraph(regionTurtle: string): { readonly body: PevRecordBody } | { readonly unreadable: string } {
  let doc: ReturnType<typeof parseTrig>;
  try { doc = parseTrig(regionTurtle); } catch {
    return { unreadable: 'the record graph does not parse as Turtle' };
  }
  const records = doc.subjects.flatMap((s) => {
    if (typeof s.subject !== 'string') return [];
    const kinds = (s.properties.get(RDF_TYPE as IRI) ?? [])
      .map((t) => (t.kind === 'iri' ? RECORD_CLASS_BY_IRI.get(t.iri) : undefined))
      .filter((k): k is PevRecordBody['kind'] => k !== undefined);
    return kinds.length === 1 ? [{ s, kind: kinds[0]!, iri: s.subject }] : [];
  });
  if (records.length !== 1) return { unreadable: `expected one pev record subject in the graph, found ${records.length}` };
  const { s, kind, iri } = records[0]!;
  const json = readStringValue(s, pevTerm('recordJson') as IRI);
  const declared = readStringValue(s, pevTerm('recordJsonSha256') as IRI);
  if (json === undefined || declared === undefined) return { unreadable: 'the record graph carries no recordJson with its hash' };
  if (sha256(json) !== declared) return { unreadable: 'the record body does not match its recorded hash' };
  let body: unknown;
  try { body = JSON.parse(json); } catch { return { unreadable: 'the record body is not JSON' }; }
  if (!isRecord(body) || body['kind'] !== kind || body['v'] !== 1) return { unreadable: `the record body is not a ${kind} body` };
  const typed = body as unknown as PevRecordBody;
  if (graphIriOf(typed) !== iri) return { unreadable: 'the record body describes a different graph than the one it sits in' };
  return { body: typed };
}

// ═════════════════════════════════════════════════════════════════════════════════════════════
//  Descriptor (§5.1)
// ═════════════════════════════════════════════════════════════════════════════════════════════

export interface DescriptorPlan {
  readonly recordId: string; readonly graphIri: string; readonly kind: PevRecordBody['kind'];
  readonly modal: 'Hypothetical' | 'Asserted' | 'Retracted'; readonly at: string; readonly validFrom: string; readonly validUntil?: string;
  readonly platformDid: string;
  readonly actors: readonly { readonly did: string; readonly role: 'Curator' | 'Validator' }[];
  /** Software agents that authored content, e.g. the model that drafted a scenario. */
  readonly softwareAuthors?: readonly string[];
  readonly supersedes?: string;
  readonly derivedFrom?: readonly string[];
  readonly trust: { readonly level: 'SelfAsserted' } | { readonly level: 'ThirdPartyAttested'; readonly issuer: string };
}

/**
 * The record's descriptor. The platform is the Author (software); the acting person is Curator
 * (or Validator when they reviewed). Hypothetical leaves groundTruth unset; Asserted sets it true;
 * Retracted sets it false with the interval the withdrawn claim stood. No AccessControl facet is
 * ever added: who may read is the operator pod's own access control.
 */
export function buildRecordDescriptor(p: DescriptorPlan): ContextDescriptorData {
  const b = ContextDescriptor.create(p.recordId as IRI)
    .describes(p.graphIri as IRI)
    .conformsTo(RECORD_CLASS[p.kind] as IRI, RECORD_SHAPE[p.kind] as IRI)
    .temporal(p.validUntil !== undefined ? { validFrom: p.validFrom, validUntil: p.validUntil } : { validFrom: p.validFrom })
    .provenance({
      wasAttributedTo: p.platformDid as IRI,
      generatedAtTime: p.at,
      ...(p.derivedFrom && p.derivedFrom.length > 0 ? { wasDerivedFrom: p.derivedFrom.map((x) => x as IRI) } : {}),
    })
    .agent({ identity: p.platformDid as IRI, isSoftwareAgent: true }, 'Author');
  for (const s of p.softwareAuthors ?? []) b.agent({ identity: s as IRI, isSoftwareAgent: true }, 'Author');
  for (const a of p.actors) b.agent({ identity: a.did as IRI }, a.role);
  if (p.modal === 'Hypothetical') b.hypothetical();
  else if (p.modal === 'Asserted') b.asserted();
  else b.semiotic({ modalStatus: 'Retracted', groundTruth: false });
  if (p.trust.level === 'SelfAsserted') b.selfAsserted(p.platformDid as IRI);
  else b.trust({ trustLevel: 'ThirdPartyAttested', issuer: p.trust.issuer as IRI });
  if (p.supersedes !== undefined) b.supersedes(p.supersedes as IRI);
  return b.build();
}
