/**
 * Proposed subordinate-key proof format. Deliberately not a client-signature/v1
 * admission path: a future, explicitly versioned policy and trusted grant store
 * must opt in. This module never enrolls a credential, creates a key or publishes.
 */
import { createHash } from 'node:crypto';
import { canonicalJson } from './application-lab-runtime.js';
import { clientKeyId, verifyClientAuthorization, type ClientSignature, type ClientSigningKey } from './client-authorization.js';

export interface ClientSigningGrant {
  readonly schema: 'interego.client-signing-grant/v1';
  readonly id: string;
  readonly issuer: string;
  readonly actor: string;
  readonly audience: string;
  readonly podUrl: string;
  readonly applicationId: string;
  readonly actionIri: string;
  readonly contractDigest: string;
  readonly key: { readonly scheme: 'ed25519'; readonly publicKeyMultibase: string };
  readonly notBefore: string;
  readonly expiresAt: string;
}

export interface SignedClientSigningGrant {
  readonly grant: ClientSigningGrant;
  readonly issuerProof: ClientSignature;
  readonly possessionProof: ClientSignature;
}

export interface DelegatedClientSignature {
  readonly schema: 'interego.delegated-client-signature/v1';
  readonly grant: SignedClientSigningGrant;
  readonly proof: ClientSignature;
}

export interface GrantBinding {
  readonly id: string;
  readonly digest: string;
  readonly issuer: string;
  readonly actor: string;
  readonly keyId: string;
}

export interface VerifiedDelegatedClientAuthorization {
  readonly authorizationBasis: 'delegated-client-signature';
  readonly keyId: string;
  readonly issuerKeyId: string;
  readonly grantDigest: string;
  readonly receipt: string;
  readonly proof: DelegatedClientSignature;
}

const admitted = new WeakMap<object, () => void>();
const MAX_GRANT_LIFETIME = 3_600_000;
const MAX_RECEIPT_AGE = 600_000;
const GRANT_FIELDS = ['schema', 'id', 'issuer', 'actor', 'audience', 'podUrl', 'applicationId', 'actionIri', 'contractDigest', 'key', 'notBefore', 'expiresAt'];
const digest = (value: string) => createHash('sha256').update(value).digest('hex');

function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('expected a proof object');
  return value as Record<string, unknown>;
}

function fields(value: unknown, allowed: readonly string[]): Record<string, unknown> {
  const record = object(value);
  if (Object.keys(record).some(key => !allowed.includes(key)) || allowed.some(key => !(key in record))) {
    throw new Error('unexpected or missing proof field');
  }
  return record;
}

function snapshot<T>(value: T): T {
  const bytes = JSON.stringify(value);
  if (!bytes || bytes.length > 131_072) throw new Error('invalid or oversized proof');
  return JSON.parse(bytes) as T;
}

function freeze<T>(value: T): T {
  if (value && typeof value === 'object') {
    for (const child of Object.values(value)) freeze(child);
    Object.freeze(value);
  }
  return value;
}

function instant(value: unknown): number {
  if (typeof value !== 'string') throw new Error('invalid grant or receipt time');
  const time = Date.parse(value);
  if (!Number.isFinite(time) || new Date(time).toISOString() !== value) throw new Error('invalid grant or receipt time');
  return time;
}

function validateGrant(raw: unknown): ClientSigningGrant {
  const g = fields(raw, GRANT_FIELDS);
  for (const name of ['issuer', 'actor', 'applicationId', 'actionIri']) {
    if (typeof g[name] !== 'string' || !/^[a-z][a-z0-9+.-]*:[^\s*]+$/i.test(g[name])) throw new Error('grant scope requires exact IRIs');
  }
  if (g['schema'] !== 'interego.client-signing-grant/v1'
    || typeof g['id'] !== 'string' || !/^urn:uuid:[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(g['id'])
    || typeof g['contractDigest'] !== 'string' || !/^[0-9a-f]{64}$/.test(g['contractDigest'])) throw new Error('invalid grant identity or contract');
  if (typeof g['audience'] !== 'string') throw new Error('grant audience must be an exact HTTPS origin');
  const audience = new URL(g['audience']);
  if (audience.protocol !== 'https:' || audience.origin !== g['audience']) throw new Error('grant audience must be an exact HTTPS origin');
  if (typeof g['podUrl'] !== 'string') throw new Error('grant requires an exact resource pod');
  const pod = new URL(g['podUrl']);
  if (!['http:', 'https:'].includes(pod.protocol) || pod.username || pod.password || pod.search || pod.hash
    || !pod.pathname.endsWith('/') || pod.href !== g['podUrl']) throw new Error('grant requires an exact resource pod');
  const key = fields(g['key'], ['scheme', 'publicKeyMultibase']);
  if (key['scheme'] !== 'ed25519' || typeof key['publicKeyMultibase'] !== 'string') throw new Error('grant requires an Ed25519 subordinate key');
  clientKeyId(key as unknown as ClientSigningKey);
  const lifetime = instant(g['expiresAt']) - instant(g['notBefore']);
  if (lifetime <= 0 || lifetime > MAX_GRANT_LIFETIME) throw new Error('grant lifetime must be positive and at most one hour');
  return raw as ClientSigningGrant;
}

function validAt(grant: ClientSigningGrant, at: number): void {
  if (!Number.isFinite(at) || at < instant(grant.notBefore) || at >= instant(grant.expiresAt)) throw new Error('grant is not active at this time');
}

function receiptFor(message: string, grant: ClientSigningGrant): Record<string, unknown> {
  const receipt = object(JSON.parse(message));
  if (message !== canonicalJson(receipt)) throw new Error('receipt must be canonical');
  for (const name of ['actor', 'applicationId', 'actionIri', 'contractDigest'] as const) {
    if (receipt[name] !== grant[name]) throw new Error('receipt is outside grant scope');
  }
  if (object(receipt['authority'])['podUrl'] !== grant.podUrl) throw new Error('receipt is outside grant resource pod');
  validAt(grant, instant(receipt['at']));
  return receipt;
}

/** Both signatures at enrollment bind these exact bytes, using their own key domains. */
export function clientSigningGrantMessage(grant: ClientSigningGrant): string {
  return canonicalJson(validateGrant(grant));
}

/** An action signature also binds the grant and audience, so it cannot become a direct proof. */
export function delegatedClientSigningMessage(grant: ClientSigningGrant, receipt: string): string {
  const grantMessage = clientSigningGrantMessage(grant);
  return canonicalJson({ schema: 'interego.delegated-client-action/v1', grantId: grant.id,
    grantDigest: digest(grantMessage), audience: grant.audience, receipt: receiptFor(receipt, grant) });
}

async function verifyGrantProofs(raw: unknown, issuerKeys?: readonly ClientSigningKey[]) {
  const envelope = fields(raw, ['grant', 'issuerProof', 'possessionProof']) as unknown as SignedClientSigningGrant;
  const grant = validateGrant(envelope.grant);
  const message = clientSigningGrantMessage(grant);
  const owner = await verifyClientAuthorization(envelope.issuerProof, message, issuerKeys);
  const possession = await verifyClientAuthorization(envelope.possessionProof, message, [grant.key]);
  if (owner.keyId === possession.keyId) throw new Error('subordinate key must differ from the issuer key');
  return { grant, owner, possession, message };
}

/**
 * Checks an enrollment proposal. The adapter must independently authorize issuer
 * to delegate to actor and obtain issuerKeys from the issuer's current identity.
 * A valid proposal is not a registered login method or a committed grant.
 */
export async function verifyClientSigningGrant(raw: unknown, context: {
  readonly issuer: string; readonly actor: string; readonly audience: string;
  readonly issuerKeys: readonly ClientSigningKey[]; readonly now: () => number;
}) {
  const envelope = freeze(snapshot(raw));
  const { issuer, actor, audience, now } = context;
  const keys = freeze(snapshot(context.issuerKeys));
  const verified = await verifyGrantProofs(envelope, keys);
  const grant = verified.grant;
  if (grant.issuer !== issuer || grant.actor !== actor || grant.audience !== audience) throw new Error('grant authority differs from authenticated context');
  validAt(grant, now());
  return freeze({ envelope: { grant, issuerProof: verified.owner.proof, possessionProof: verified.possession.proof }, binding: {
    id: grant.id, digest: digest(verified.message), issuer, actor, keyId: verified.possession.keyId,
  }, issuerKeyId: verified.owner.keyId });
}

/**
 * Proposed live admission verifier. readStatus is a TRUSTED adapter read of the
 * exact grant binding, never a model-supplied boolean or a cached grant envelope.
 * Missing, unavailable or revoked status refuses admission. Publication still
 * requires current resource authority, CAS, and an explicit delegated-proof policy.
 */
export async function verifyDelegatedClientAuthorization(raw: unknown, expectedReceipt: string, context: {
  readonly issuer: string; readonly actor: string; readonly audience: string;
  readonly issuerKeys: readonly ClientSigningKey[]; readonly now: () => number;
  readonly readStatus: (binding: Readonly<GrantBinding>) => Promise<'active' | 'revoked' | 'unknown'>;
}): Promise<VerifiedDelegatedClientAuthorization> {
  const proof = freeze(snapshot(raw)) as DelegatedClientSignature;
  fields(proof, ['schema', 'grant', 'proof']);
  if (proof.schema !== 'interego.delegated-client-signature/v1') throw new Error('a delegated client proof is required');
  const { issuer, actor, audience, now, readStatus } = context;
  const issuerKeys = freeze(snapshot(context.issuerKeys));
  const verified = await verifyClientSigningGrant(proof.grant, { issuer, actor, audience, issuerKeys, now });
  const grant = verified.envelope.grant;
  const receipt = receiptFor(expectedReceipt, grant);
  const checkTime = () => {
    const time = now();
    validAt(grant, time);
    const age = time - instant(receipt['at']);
    if (age < -30_000 || age >= MAX_RECEIPT_AGE) throw new Error('delegated action receipt is not fresh');
  };
  checkTime();
  const action = await verifyClientAuthorization(proof.proof, delegatedClientSigningMessage(grant, expectedReceipt), [grant.key]);
  if (await readStatus(verified.binding) !== 'active') throw new Error('grant is revoked, unknown or unavailable');
  checkTime();
  const result = freeze({ authorizationBasis: 'delegated-client-signature' as const, keyId: action.keyId,
    issuerKeyId: verified.issuerKeyId, grantDigest: verified.binding.digest, receipt: expectedReceipt,
    proof: { ...proof, grant: verified.envelope, proof: action.proof } });
  admitted.set(result, checkTime);
  return result;
}

export function requireVerifiedDelegatedClientAuthorization(value: VerifiedDelegatedClientAuthorization | undefined, receipt: string) {
  if (!value || !admitted.has(value) || value.receipt !== receipt) throw new Error('independently verified delegated authorization is required');
  admitted.get(value)!();
  return value;
}

/**
 * Historical cryptographic evidence ONLY. Retained keys cannot establish issuer
 * authority, registration or revocation at action time. A future replay adapter
 * must verify those from pinned historical authority, separately. No live capability.
 */
export async function replayDelegatedClientSignature(raw: unknown, expectedReceipt: string) {
  const proof = freeze(snapshot(raw)) as DelegatedClientSignature;
  fields(proof, ['schema', 'grant', 'proof']);
  if (proof.schema !== 'interego.delegated-client-signature/v1') throw new Error('a delegated client proof is required');
  const verified = await verifyGrantProofs(proof.grant);
  receiptFor(expectedReceipt, verified.grant);
  const action = await verifyClientAuthorization(proof.proof, delegatedClientSigningMessage(verified.grant, expectedReceipt), [verified.grant.key]);
  return freeze({ signaturesVerified: true as const, grantTimeVerified: true as const,
    authorityVerified: false as const, revocationVerified: false as const,
    keyId: action.keyId, issuerKeyId: verified.owner.keyId, grantDigest: digest(verified.message), receipt: expectedReceipt });
}
