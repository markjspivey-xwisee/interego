/** A session agent may keep its controlling person's activity only after the native
 * identity authority, owner registry, signed delegation and live relay agree.
 * A signed subject/pod field corroborates that authority; it never chooses it. */
import { findKeyAgreementKey, readAgentRegistry, readDelegationCredential, verifyAgentDelegation, type DidDocument } from '@interego/solid';
import { assertSafeFetchTarget, makeWalletDelegationVerifier, type IRI } from '@interego/core';

type Json = Record<string, unknown>;
export interface OwnSubjectXapiAuthority {
  ok: true; callerDid: string; subjectDid: string; podUrl: string;
  ownerPublicKey: string; payload: Json;
}
type Refusal = { ok: false; status: number; error: string };
export interface OwnSubjectXapiAuthConfig {
  identityOrigin: string; relayOrigin: string;
  recover(body: unknown): { ok: true; agentId: string; signer: string; payload: Json } | { ok: false; reason: string };
  ownPod(subject: string): string;
  /** Compare the complete resource URL after rewriting only configured store aliases. */
  samePod(a: string | undefined, b: string): boolean;
  document(did: string): Promise<DidDocument>;
  delegation(pod: string, agent: string): Promise<{
    verification: { valid: boolean; trustLevel?: string; owner?: string; agent?: string; chainLength?: number; scope?: string };
    registry: { webId: string; authorizedAgents: Array<{ agentId: string; delegatedBy: string; scope: string; revoked?: boolean; validFrom: string; validUntil?: string }> } | null;
    credential: { issuer: string; issuanceDate: string; expirationDate?: string; credentialSubject: { id: string; pod: string; delegatedBy: string; scope: readonly string[] }; proof?: { signerAddress?: string } } | null;
    relay: { verified?: boolean; valid?: boolean; trustLevel?: string; agent?: string; owner?: string; subjectPodUrl?: string; subject_pod_url?: string; chainLength?: number; delegationChain?: { anchored?: boolean; owner?: string; agent?: string; length?: number }; signing?: { relayAnchor?: string; credentialAnchor?: string; canSignDelegatedRequests?: boolean } };
  }>;
  now?: () => number;
}
const scopes: Record<string, string[]> = { ReadWrite: ['discover', 'publish', 'subscribe'], ReadOnly: ['discover', 'subscribe'], PublishOnly: ['publish'], DiscoverOnly: ['discover'] };
const refusal = (error: string, status = 403): Refusal => ({ ok: false, status, error });
const addressEqual = (a: unknown, b: string) => typeof a === 'string' && /^0x[0-9a-f]{40}$/i.test(a) && a.toLowerCase() === b.toLowerCase();

export function makeOwnSubjectXapiVerifier(config: OwnSubjectXapiAuthConfig) {
  const identity = new URL(config.identityOrigin), relay = new URL(config.relayOrigin);
  if (identity.protocol !== 'https:' || identity.pathname !== '/' || relay.protocol !== 'https:' || relay.pathname !== '/') throw new Error('Own-subject xAPI requires configured HTTPS identity and relay origins');
  const prefix = `did:web:${identity.host.replace(/:/g, '%3A')}:`;
  const named = (did: string, kind: 'users' | 'agents') => {
    const start = `${prefix}${kind}:`, tail = did.startsWith(start) ? did.slice(start.length) : '';
    return /^[A-Za-z0-9][A-Za-z0-9._-]{0,255}$/.test(tail) ? tail : null;
  };
  const sameService = (doc: DidDocument, type: string, target: string) => {
    const found = doc.service?.filter(s => s.type === type);
    return found?.length === 1 && config.samePod(found[0]!.serviceEndpoint, target);
  };
  const current = (from: string, until?: string) => {
    const start = Date.parse(from), end = until === undefined ? Infinity : Date.parse(until), now = config.now?.() ?? Date.now();
    return Number.isFinite(start) && start <= now && end > now;
  };
  return async (body: unknown, write: boolean): Promise<OwnSubjectXapiAuthority | Refusal> => {
    const recovered = config.recover(body);
    if (!recovered.ok) return refusal('A fresh signed request is required.', 401);
    const { agentId, signer, payload } = recovered;
    if (!named(agentId, 'agents') || typeof payload.subject_did !== 'string' || !named(payload.subject_did, 'users')) return refusal('This action requires a native session agent and its controlling subject. Independent agents use the existing own-agent xAPI actions.');
    if (payload.purpose !== 'personal-performance') return refusal('The signed purpose must be personal-performance.');
    try {
      const agent = await config.document(agentId), subjectDid = payload.subject_did;
      if (agent.id !== agentId || agent.controller !== subjectDid) return refusal('The requested subject does not control this authenticated agent.');
      const pod = config.ownPod(subjectDid), ownerId = named(subjectDid, 'users')!, webId = `${identity.origin}/users/${ownerId}/profile#me`;
      if (!sameService(agent, 'SolidStorage', pod)) return refusal('Native agent storage does not match the controlling subject own pod.');
      const registries = agent.service?.filter(s => s.type === 'ContextGraphsAgentRegistry');
      const relays = agent.service?.filter(s => s.type === 'InteregoRelay');
      if (registries?.length !== 1 || !config.samePod(registries[0]!.serviceEndpoint, `${pod}agents`)
        || relays?.length !== 1 || new URL(relays[0]!.serviceEndpoint).origin !== relay.origin) return refusal('The native agent registry or relay binding is invalid.');
      if (typeof payload.subject_pod_url !== 'string' || !config.samePod(payload.subject_pod_url, pod)) return refusal('The signed pod stamp does not match the independently verified subject own pod.');
      const [owner, delegation] = await Promise.all([config.document(subjectDid), config.delegation(pod, agentId)]);
      if (owner.id !== subjectDid || owner.controller !== subjectDid || !sameService(owner, 'SolidStorage', pod)) return refusal('Native subject identity or own storage binding is invalid.');
      const refs = owner.keyAgreement;
      const key = refs?.length === 1 ? (typeof refs[0] === 'string' ? owner.verificationMethod?.find(k => k.id === refs[0]) : refs[0]) : null;
      const ownerPublicKey = findKeyAgreementKey(owner);
      if (!key || key.controller !== subjectDid || key.type !== 'X25519KeyAgreementKey2020' || !ownerPublicKey) return refusal('The native subject has no unique owner-bound encryption key.');
      const { verification: verified, credential: vc, registry, relay: live } = delegation;
      const rows = registry?.authorizedAgents.filter(r => r.agentId === agentId), entry = rows?.length === 1 ? rows[0] : null;
      if (!entry || registry?.webId !== webId || entry.delegatedBy !== webId || entry.revoked || !current(entry.validFrom, entry.validUntil)
        || !verified.valid || verified.trustLevel !== 'CryptographicallyVerified' || verified.owner !== webId || verified.agent !== agentId
        || verified.chainLength !== 1 || verified.scope !== entry.scope) return refusal('The native owner delegation is inactive or does not verify.');
      const scope = vc?.credentialSubject.scope, expected = scopes[entry.scope];
      if (!vc || vc.issuer !== webId || vc.credentialSubject.id !== agentId || vc.credentialSubject.delegatedBy !== webId
        || !config.samePod(vc.credentialSubject.pod, pod) || !current(vc.issuanceDate, vc.expirationDate)
        || !expected || !Array.isArray(scope) || [...scope].sort().join(',') !== [...expected].sort().join(',')
        || !scope.includes('discover') || (write && !scope.includes('publish')) || !addressEqual(vc.proof?.signerAddress, signer)) return refusal('Own-subject activity requires an owner-issued, signed discover delegation and publish authority for writes.');
      if (!live.verified || !live.valid || live.trustLevel !== 'CryptographicallyVerified' || live.owner !== webId || live.agent !== agentId
        || live.chainLength !== 1 || !config.samePod(live.subjectPodUrl, pod) || !config.samePod(live.subject_pod_url, pod)
        || live.delegationChain?.anchored !== true || live.delegationChain.owner !== webId || live.delegationChain.agent !== agentId || live.delegationChain.length !== 1
        || live.signing?.canSignDelegatedRequests !== true || !addressEqual(live.signing.relayAnchor, signer) || !addressEqual(live.signing.credentialAnchor, signer)) return refusal('The configured native relay cannot currently attest this subject delegation and signing anchor.');
      return { ok: true, callerDid: agentId, subjectDid, podUrl: pod, ownerPublicKey, payload };
    } catch { return refusal('Native subject authority is unavailable; no activity was read or written.', 503); }
  };
}

/** Production composition over native discovery and the configured identity authority.
 * The relay signing key is learned afresh from its live verify_agent response,
 * rather than a caller field or the credential being checked. */
export function composeOwnSubjectXapiVerifier(options: Pick<OwnSubjectXapiAuthConfig, 'identityOrigin' | 'relayOrigin' | 'recover' | 'ownPod' | 'samePod'> & { fetch: typeof fetch }) {
  const identity = new URL(options.identityOrigin), relay = new URL(options.relayOrigin);
  async function exactFetch(url: string, init: RequestInit = {}): Promise<Response> {
    await assertSafeFetchTarget(url);
    const headers = new Headers(init.headers); headers.set('Cache-Control', 'no-cache');
    const response = await options.fetch(url, { ...init, headers, cache: 'no-store', redirect: 'manual', signal: AbortSignal.timeout(8000) });
    if (response.status >= 300 && response.status < 400 || response.url && response.url !== url) throw new Error('Native authority redirects are refused');
    // Native SDK readers consume response.text/json themselves. Bound those
    // registry and credential bodies before handing them to a parser too.
    const reader = response.body?.getReader();
    if (!reader) return response;
    const parts: Buffer[] = []; let size = 0;
    try { for (;;) { const part = await reader.read(); if (part.done) break; size += part.value.length; if (size > 1024 * 1024) { await reader.cancel(); throw new Error('Native authority exceeds capacity'); } parts.push(Buffer.from(part.value)); } }
    finally { reader.releaseLock(); }
    return new Response(Buffer.concat(parts), { status: response.status, statusText: response.statusText, headers: response.headers });
  }
  async function json(url: string, init: RequestInit = {}, maxBytes = 131072): Promise<Record<string, unknown>> {
    const response = await exactFetch(url, init);
    if (!response.ok) throw new Error('Native authority unavailable');
    const reader = response.body?.getReader(); if (!reader) throw new Error('Native authority has no response body');
    const parts: Buffer[] = []; let size = 0;
    try { for (;;) { const part = await reader.read(); if (part.done) break; size += part.value.length; if (size > maxBytes) { await reader.cancel(); throw new Error('Native authority exceeds capacity'); } parts.push(Buffer.from(part.value)); } }
    finally { reader.releaseLock(); }
    const value: unknown = JSON.parse(Buffer.concat(parts).toString('utf8'));
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid native authority');
    return value as Record<string, unknown>;
  }
  // Only the discoverable target is cached. Every request rechecks live delegation,
  // revocation and relay signing readiness, so target caching grants no authority.
  let cachedTarget: { url: string; until: number } | undefined;
  async function relayTarget(): Promise<string> {
    if (cachedTarget && cachedTarget.until > Date.now()) return cachedTarget.url;
    const source = `${relay.origin}/.well-known/operations`, catalog = await json(source, {}, 1024 * 1024);
    const members = catalog['hydra:member'];
    if (catalog['@id'] !== source || !Array.isArray(members) || members.length > 256) throw new Error('Invalid native operations catalog');
    const matches = members.filter((m: Record<string, unknown>) => m['@id'] === 'urn:iep:operation:verify_agent');
    if (matches.length !== 1) throw new Error('Native verify-agent operation is unavailable');
    const operation = matches[0] as Record<string, unknown>, target = new URL(String(operation.target));
    const headers = operation['hydra:expectsHeader'];
    if (operation.method !== 'POST' || target.origin !== relay.origin || target.username || target.password || target.hash || target.search
      || !Array.isArray(headers) || !headers.some(h => h['hydra:headerName'] === 'Authorization' && h['hydra:required'] === false)) throw new Error('Invalid native verify-agent operation');
    cachedTarget = { url: target.href, until: Date.now() + 300000 }; return target.href;
  }
  return makeOwnSubjectXapiVerifier({ ...options,
    document: async did => {
      const prefix = `did:web:${identity.host.replace(/:/g, '%3A')}:`, segments = did.slice(prefix.length).split(':');
      if (!did.startsWith(prefix) || segments.length !== 2 || !['users', 'agents'].includes(segments[0]!) || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,255}$/.test(segments[1]!)) throw new Error('Unsupported native identity');
      return await json(`${identity.origin}/${segments[0]}/${segments[1]}/did.json`) as unknown as DidDocument;
    },
    delegation: async (pod, agent) => {
      const base = new URL(pod);
      const podFetch = async (url: string, init: RequestInit = {}) => {
        const target = new URL(String(url));
        if (target.origin !== base.origin || !target.pathname.startsWith(base.pathname) || !['GET', 'HEAD'].includes(init.method ?? 'GET') || target.username || target.password || target.hash || target.search) throw new Error('Native delegation escaped own pod');
        return exactFetch(target.href, init);
      };
      const [verification, registry, credential, live] = await Promise.all([
        verifyAgentDelegation(agent as IRI, pod, { verifier: makeWalletDelegationVerifier(), fetch: podFetch as never }),
        readAgentRegistry(pod, { fetch: podFetch as never }), readDelegationCredential(pod, agent as IRI, { fetch: podFetch as never }),
        relayTarget().then(target => json(target, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ agent_id: agent, pod_url: pod }) })),
      ]);
      return { verification, registry, credential, relay: live } as Awaited<ReturnType<OwnSubjectXapiAuthConfig['delegation']>>;
    },
  });
}
