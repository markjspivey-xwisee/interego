/** Missing-only, same-session delegation repair. This module never writes a registry. */
import { createHash } from 'node:crypto';
import {
  createSignedDelegationCredential, delegationCredentialToJsonLd, canonicalCredentialPayload, isPgslNodeId,
  type AuthorizedAgentData, type OwnerProfileData, type IRI,
  type DelegationSigner, type DelegationVerifier, type SignedDelegationCredential,
  createDelegationCredential, ownerProfileToTurtle, parseOwnerProfile,
} from '@interego/core';
import type { FetchFn, FetchResponse } from '@interego/core/http';
import { readAgentRegistry, writeDelegationCredential } from '@interego/solid';
import { canonicalSessionActorId } from './session-actor.js';
import { verifyPrincipalDelegation } from './principal-delegation.js';

const NATIVE_TYPE = 'application/vnd.interego.native-commit+json';
const CREDENTIAL_TYPE = 'application/ld+json';
const MAX_BYTES = 32 * 1024;
const REVISION = /^sha256:[a-f0-9]{64}$/;
const ALLOWED_FIELDS = new Set([
  'agent_id', 'pod_name', 'pod_url', 'owner_webid', 'repair_only',
  '_session_bearer', '_session_principal', '_identity_token',
  '_session_agent_did', '_session_agent_id', '_session_user_id', '_session_owner_webid',
  '_session_native_lifecycle',
  '_pod_url_injected', '_pod_name_injected',
]);

export interface DelegationRepairOptions {
  readonly podUrl: string;
  /** Proven by the transport; never derived from caller-supplied pod selectors. */
  readonly ownPodUrl: string | undefined;
  readonly identityBaseUrl: string;
  readonly canonicalPodKey: (url: string) => string;
  readonly fetch: FetchFn;
  readonly getSigner: () => Promise<DelegationSigner>;
  readonly verifier: DelegationVerifier;
  readonly now?: () => number;
}

/** Also suppress implicit writes before a malformed repair flag is refused. */
export function isDelegationRepairRequest(name: string, args: Record<string, unknown>): boolean {
  return name === 'register_agent' && Object.hasOwn(args, 'repair_only') && args.repair_only !== false;
}

function object(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}
function digest(bytes: Uint8Array): string {
  return 'sha256:' + createHash('sha256').update(bytes).digest('hex');
}
type StreamResponse = FetchResponse & { readonly body?: ReadableStream<Uint8Array> | null };
function selectedGrant(profile: OwnerProfileData | null, agent: string, now: number): AuthorizedAgentData | null {
  if (!profile || !profile.webId || !Number.isFinite(now)) return null;
  const rows = profile.authorizedAgents.filter(row => row.agentId === agent);
  if (rows.length !== 1) return null;
  const row = rows[0];
  if (!row) return null;
  if (row.revoked || !['ReadWrite', 'PublishOnly'].includes(row.scope)
    || row.delegatedBy !== profile.webId || !Number.isFinite(Date.parse(row.validFrom))
    || Date.parse(row.validFrom) > now
    || (row.validUntil !== undefined && (!Number.isFinite(Date.parse(row.validUntil)) || Date.parse(row.validUntil) <= now))
    || (row.capabilities?.length ?? 0) !== 0) return null;
  return row;
}
/** Include every authority/key/label field; a repair cannot rescope or rotate a row. */
function grantSnapshot(profile: OwnerProfileData, row: AuthorizedAgentData): string {
  return JSON.stringify([
    profile.webId, row.agentId, row.delegatedBy, row.scope, row.validFrom,
    row.validUntil ?? null, row.revoked ?? false, row.label ?? null,
    row.isSoftwareAgent ?? null, row.encryptionPublicKey ?? null,
    row.encryptionKeyHistory ?? null, row.capabilities ?? [],
  ]);
}
async function boundedBytes(response: FetchResponse, limit = MAX_BYTES, signal?: AbortSignal): Promise<Uint8Array> {
  const length = response.headers?.get('Content-Length');
  if (length && (!/^[0-9]+$/.test(length) || Number(length) > limit)) throw new Error('capacity');
  const reader = (response as StreamResponse).body?.getReader();
  if (reader) {
    const chunks: Uint8Array[] = [];
    let size = 0;
    const cancel = (): void => { void reader.cancel().catch(() => undefined); };
    signal?.addEventListener('abort', cancel, { once: true });
    try {
      if (signal?.aborted) throw new Error('deadline');
      for (;;) {
        const part = await reader.read();
        if (part.done) break;
        size += part.value.length;
        if (size > limit) throw new Error('capacity');
        chunks.push(part.value);
      }
      return Buffer.concat(chunks);
    } finally {
      signal?.removeEventListener('abort', cancel);
      await reader.cancel().catch(() => undefined);
      reader.releaseLock();
    }
  }
  if (!response.arrayBuffer) throw new Error('binary transport required');
  const bytes = new Uint8Array(await response.arrayBuffer());
  if (bytes.length > limit) throw new Error('capacity');
  return bytes;
}
function revisionEtag(revision: string): string {
  return '"' + revision + '-' + createHash('sha256').update(CREDENTIAL_TYPE).digest('hex').slice(0, 16) + '"';
}
function validReceipt(value: unknown, response: FetchResponse, target: string, bytes: Uint8Array, expectedRevision: string | null): value is Record<string, unknown> & { revision: string } {
  if (!object(value) || value.version !== 1 || value.status !== 'committed'
    || value.expectedRevision !== expectedRevision || value.resource !== target || value.path !== target
    || typeof value.revision !== 'string' || !REVISION.test(value.revision)
    || value.bodyDigest !== digest(bytes) || value.contentType !== CREDENTIAL_TYPE
    || value.size !== bytes.length || value.pod !== 'css'
    || !Number.isSafeInteger(value.updatedAt) || Number(value.updatedAt) < 0
    || !isPgslNodeId(value.topUri) || !isPgslNodeId(value.opaqueUri)) return false;
  const revisionHeader = response.headers?.get('Interego-Revision');
  return (revisionHeader === null || revisionHeader === undefined || revisionHeader === value.revision)
    && response.headers?.get('ETag') === revisionEtag(value.revision)
    && response.headers?.get('Content-Type')?.split(';', 1)[0]?.trim().toLowerCase() === 'application/json';
}
function nativeReadMatches(response: FetchResponse, revision: string, bytes: Uint8Array): boolean {
  return response.ok && response.headers?.get('Interego-Revision') === revision
    && response.headers?.get('Interego-Body-Digest') === digest(bytes)
    && response.headers?.get('ETag') === revisionEtag(revision)
    && response.headers?.get('Content-Type')?.split(';', 1)[0]?.trim().toLowerCase() === CREDENTIAL_TYPE;
}

function credentialTransport(fetchFn: FetchFn, podUrl: string) {
  const deadline = Date.now() + 20_000;
  const controller = new AbortController();
  const responses = new Set<StreamResponse>();
  const pendingTimers = new Set<ReturnType<typeof setTimeout>>();
  async function withinDeadline<T>(operation: () => Promise<T>): Promise<T> {
    const remaining = deadline - Date.now();
    if (remaining <= 0) throw new Error('deadline');
    let timer: ReturnType<typeof setTimeout>;
    try {
      return await Promise.race([operation(), new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => { controller.abort(); reject(new Error('deadline')); }, remaining);
        pendingTimers.add(timer);
      })]);
    } finally { if (timer!) { clearTimeout(timer); pendingTimers.delete(timer); } }
  }
  const freshFetch: FetchFn = async (url, init) => {
    const request = {
      ...init, redirect: 'manual' as const, cache: 'no-store' as const,
      signal: controller.signal,
      headers: { ...init?.headers, 'Cache-Control': 'no-cache' },
    };
    const response = await withinDeadline(() => fetchFn(url, request));
    responses.add(response);
    const bytes = () => withinDeadline(() => boundedBytes(response, url === podUrl + 'agents' ? 256 * 1024 : MAX_BYTES, controller.signal));
    return {
      ok: response.ok, status: response.status, statusText: response.statusText,
      headers: response.headers, url: response.url,
      text: async () => new TextDecoder('utf-8', { fatal: true }).decode(await bytes()),
      json: async () => JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(await bytes())) as unknown,
      arrayBuffer: async () => Uint8Array.from(await bytes()).buffer,
    };
  };
  return {
    fetch: freshFetch, withinDeadline,
    close(): void {
      controller.abort();
      for (const response of responses) {
        if (response.body && !response.body.locked) void response.body.cancel().catch(() => undefined);
      }
      for (const timer of pendingTimers) clearTimeout(timer);
    },
  };
}

/**
 * Called only by the existing explicit full-registration path, after its own-pod
 * and permission checks. A repaired native-managed VC must remain replaceable by
 * that authorized path without weakening native-managed resource protection.
 */
export async function writeRegistrationDelegationCredential(
  credential: SignedDelegationCredential, podUrl: string,
  options: {
    readonly fetch: FetchFn; readonly verifier: DelegationVerifier;
    readonly profile: OwnerProfileData; readonly agent: AuthorizedAgentData;
  },
): Promise<string> {
  const target = podUrl + 'credentials/' + encodeURIComponent(credential.credentialSubject.id) + '.jsonld';
  const intended = createDelegationCredential(options.profile, options.agent, podUrl as IRI);
  const normalized = parseOwnerProfile(ownerProfileToTurtle(options.profile));
  const expectedRows = normalized.authorizedAgents.filter(row => row.agentId === options.agent.agentId);
  const expectedRow = expectedRows[0];
  if (!expectedRow || expectedRows.length !== 1 || credential.id !== target || intended.id !== target
    || credential.issuer !== intended.issuer || credential.expirationDate !== intended.expirationDate
    || JSON.stringify(credential.credentialSubject) !== JSON.stringify(intended.credentialSubject)) {
    throw new Error('Registration credential does not match its authorized grant.');
  }
  const bytes = Buffer.from(delegationCredentialToJsonLd(credential), 'utf8');
  if (bytes.length > MAX_BYTES) throw new Error('Registration credential exceeds capacity.');
  const expected = grantSnapshot(normalized, expectedRow);
  const transport = credentialTransport(options.fetch, podUrl);
  const fetch = transport.fetch;
  let dispatched = false;
  let committedRevision: string | undefined;
  const confirmGrant = async (): Promise<void> => {
    const profile = await readAgentRegistry(podUrl, { fetch });
    const rows = profile?.authorizedAgents.filter(row => row.agentId === options.agent.agentId) ?? [];
    const row = rows[0];
    const now = Date.now();
    if (!profile || rows.length !== 1 || !row || row.revoked || grantSnapshot(profile, row) !== expected
      || !Number.isFinite(Date.parse(row.validFrom)) || Date.parse(row.validFrom) > now
      || (row.validUntil !== undefined && (!Number.isFinite(Date.parse(row.validUntil)) || Date.parse(row.validUntil) <= now))) {
      throw new Error('Registration grant changed; confirm current delegation by reads.');
    }
  };
  try {
    if (!await transport.withinDeadline(() => options.verifier(canonicalCredentialPayload(credential), credential.proof))) {
      throw new Error('Registration credential signature is invalid.');
    }
    await confirmGrant();
    const current = await fetch(target, { method: 'GET', headers: { Accept: CREDENTIAL_TYPE } });
    if (current.status === 404) {
      dispatched = true;
      // A concurrent native creator remains protected by the engine's
      // nativeManaged guard. This is initial legacy behavior, never a retry.
      await writeDelegationCredential(credential, podUrl, { fetch });
    } else {
      if (!current.ok) throw new Error('Registration credential could not be read.');
      const discovery = await fetch(target, { method: 'OPTIONS' });
      const native = discovery.ok && discovery.headers?.get('Interego-Native-Commit') === '1'
        && discovery.headers?.get('Accept-Put')?.split(',').map(value => value.trim()).includes(NATIVE_TYPE);
      const revision = current.headers?.get('Interego-Revision');
      const bodyDigest = current.headers?.get('Interego-Body-Digest');
      if (!native) {
        if (revision || bodyDigest) throw new Error('Native registration credential transport is unavailable.');
        dispatched = true;
        await writeDelegationCredential(credential, podUrl, { fetch });
      } else {
        const etag = current.headers?.get('ETag');
        const etagRevision = etag?.match(/^"(sha256:[a-f0-9]{64})(?:-[a-f0-9]{16})?"$/)?.[1];
        if (!revision || !REVISION.test(revision) || etagRevision !== revision
          || bodyDigest !== digest(await boundedBytes(current))) {
          throw new Error('Native registration credential read is unverified.');
        }
        await confirmGrant();
        dispatched = true;
        const written = await fetch(target, {
          method: 'PUT',
          headers: { 'Content-Type': NATIVE_TYPE, Accept: 'application/json', 'If-Match': etag! },
          body: JSON.stringify({ version: 1, expectedRevision: revision, contentType: CREDENTIAL_TYPE, bodyBase64: bytes.toString('base64') }),
        });
        if (!written.ok) throw new Error('Native registration credential write was not confirmed.');
        const receipt: unknown = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(await boundedBytes(written)));
        if (!validReceipt(receipt, written, target, bytes, revision)) throw new Error('Native registration credential receipt is unverified.');
        committedRevision = receipt.revision;
      }
    }
    const readback = await fetch(target, { method: 'GET', headers: { Accept: CREDENTIAL_TYPE } });
    if (!readback.ok || (committedRevision && !nativeReadMatches(readback, committedRevision, bytes))
      || digest(await boundedBytes(readback)) !== digest(bytes)) throw new Error('Registration credential readback is unverified.');
    await confirmGrant();
    return target;
  } catch {
    throw new Error(dispatched
      ? 'Registration credential write is unconfirmed; verify current delegation by reads before retrying.'
      : 'Registration credential could not be updated safely.');
  } finally { transport.close(); }
}

/**
 * Only an authenticated own-pod session can repair its exact, currently live row.
 * A true native create-only CAS publishes the missing VC; ordinary LDP PUT is never
 * a fallback. A lost ACK is explicitly uncertain and must be resolved by reads.
 */
export async function repairOnlySessionDelegation(
  args: Record<string, unknown>, options: DelegationRepairOptions,
): Promise<Record<string, unknown>> {
  let dispatched = false;
  const refuse = (error: string): Record<string, unknown> => ({
    error, repair_only: true, repaired: false, dispatched,
    ...(dispatched ? { read_confirm_only: true } : {}),
  });
  const transport = credentialTransport(options.fetch, options.podUrl);
  const { fetch: freshFetch, withinDeadline } = transport;
  try {
    if (args.repair_only !== true || Object.keys(args).some(key => !ALLOWED_FIELDS.has(key))) {
      return refuse('delegation_repair_parameters_refused');
    }
    const pod = new URL(options.podUrl);
    // The relay also uses its private CSS HTTP origin. These URLs are server
    // configuration, not caller-directed fetch targets; preserve the exact origin.
    if (!['http:', 'https:'].includes(pod.protocol) || pod.username || pod.password || pod.search || pod.hash
      || !pod.pathname.endsWith('/') || pod.href !== options.podUrl
      || /%2f|%5c|%2e/i.test(pod.pathname)) return refuse('delegation_repair_pod_refused');
    if (!options.ownPodUrl || options.canonicalPodKey(options.ownPodUrl) !== options.canonicalPodKey(options.podUrl)) {
      return refuse('delegation_repair_own_pod_required');
    }
    if (Object.hasOwn(args, 'pod_name') && (typeof args.pod_name !== 'string'
      || !/^[A-Za-z0-9._~-]+$/.test(args.pod_name)
      || args.pod_name !== decodeURIComponent(pod.pathname.slice(0, -1).split('/').at(-1) ?? ''))) {
      return refuse('delegation_repair_pod_refused');
    }
    if (Object.hasOwn(args, 'pod_url') && (typeof args.pod_url !== 'string'
      || options.canonicalPodKey(args.pod_url) !== options.canonicalPodKey(options.podUrl))) {
      return refuse('delegation_repair_pod_refused');
    }
    if (typeof args._session_agent_did !== 'string') return refuse('delegation_repair_session_required');
    const session = canonicalSessionActorId(args._session_agent_did, options.identityBaseUrl);
    if (!session || args.agent_id !== session) return refuse('delegation_repair_session_mismatch');
    const now = options.now ?? Date.now;
    const profile = await readAgentRegistry(options.podUrl, { fetch: freshFetch });
    const row = selectedGrant(profile, session, now());
    if (!profile || !row) return refuse('delegation_repair_live_grant_required');
    if (typeof args._session_owner_webid !== 'string' || args._session_owner_webid !== profile.webId
      || (Object.hasOwn(args, 'owner_webid') && args.owner_webid !== profile.webId)) {
      return refuse('delegation_repair_owner_mismatch');
    }
    const before = grantSnapshot(profile, row);
    const credentialUrl = options.podUrl + 'credentials/' + encodeURIComponent(session) + '.jsonld';
    const current = await freshFetch(credentialUrl, { method: 'GET', headers: { Accept: CREDENTIAL_TYPE } });
    if (current.status !== 404) return refuse(current.ok ? 'delegation_repair_not_missing' : 'delegation_repair_read_failed');
    const discovery = await freshFetch(credentialUrl, { method: 'OPTIONS' });
    if (!discovery.ok || discovery.headers?.get('Interego-Native-Commit') !== '1'
      || !discovery.headers?.get('Accept-Put')?.split(',').map(value => value.trim()).includes(NATIVE_TYPE)) {
      return refuse('delegation_repair_native_cas_required');
    }
    const signer = await withinDeadline(options.getSigner);
    // Only the registry's existing coarse scope is carried forward. No caller
    // capability, delegator or key claim participates in the new credential.
    const credential = await withinDeadline(() => createSignedDelegationCredential(profile, row, options.podUrl as IRI, signer));
    const bytes = Buffer.from(delegationCredentialToJsonLd(credential), 'utf8');
    if (bytes.length > MAX_BYTES) return refuse('delegation_repair_capacity');
    const preflight = await readAgentRegistry(options.podUrl, { fetch: freshFetch });
    const preflightRow = selectedGrant(preflight, session, now());
    if (!preflight || !preflightRow || grantSnapshot(preflight, preflightRow) !== before) {
      return refuse('delegation_repair_grant_changed');
    }
    dispatched = true;
    const written = await freshFetch(credentialUrl, {
      method: 'PUT',
      headers: { 'Content-Type': NATIVE_TYPE, Accept: 'application/json', 'If-None-Match': '*' },
      body: JSON.stringify({ version: 1, expectedRevision: null, contentType: CREDENTIAL_TYPE, bodyBase64: bytes.toString('base64') }),
    });
    if (!written.ok) {
      return refuse(written.status === 412 ? 'delegation_repair_conflict' : 'delegation_repair_write_unconfirmed');
    }
    const receipt: unknown = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(await boundedBytes(written)));
    if (!validReceipt(receipt, written, credentialUrl, bytes, null)) return refuse('delegation_repair_write_unconfirmed');
    const readback = await freshFetch(credentialUrl, { method: 'GET', headers: { Accept: CREDENTIAL_TYPE } });
    if (!nativeReadMatches(readback, receipt.revision, bytes)
      || digest(await boundedBytes(readback)) !== digest(bytes)) return refuse('delegation_repair_readback_unconfirmed');
    const verified = await verifyPrincipalDelegation(session as IRI, options.podUrl, {
      fetch: freshFetch, verifier: options.verifier, identityBaseUrl: options.identityBaseUrl,
    });
    const after = await readAgentRegistry(options.podUrl, { fetch: freshFetch });
    const afterRow = selectedGrant(after, session, now());
    if (!after || !afterRow || grantSnapshot(after, afterRow) !== before
      || !verified.valid || verified.trustLevel !== 'CryptographicallyVerified' || verified.scope !== row.scope) {
      return refuse('delegation_repair_grant_changed');
    }
    return {
      registered: false, repaired: true, repair_only: true,
      agent: session, scope: row.scope, credential: credentialUrl,
      proof: { type: credential.proof.type, signerAddress: credential.proof.signerAddress },
    };
  } catch {
    return refuse(dispatched ? 'delegation_repair_write_unconfirmed' : 'delegation_repair_unavailable');
  } finally {
    transport.close();
  }
}
