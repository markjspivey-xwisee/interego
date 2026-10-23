import { createHash } from 'node:crypto';

/** Provider-asserted restriction, retained through OAuth persistence and gate introspection. */
export interface ProvisionalPlay {
  audience: string;
  proofKeyThumbprint: string;
  /** Unix seconds, fixed at guest creation. Never extended by an exchange. */
  expiresAt: number;
}
export interface ProvisionalPrincipal {
  userId: string; agentId: string; ownerWebId: string; ownerDid: string; podUrl: string;
  provisionalPlay: ProvisionalPlay;
}
export interface PlayFetchResponse { ok: boolean; status: number; headers?: { get(name: string): string | null }; text(): Promise<string>; json(): Promise<any> }
export type PlayFetch = (url: string, init?: any) => Promise<PlayFetchResponse>;

export class ProvisionalPlayError extends Error {
  status: number;
  code: string;
  constructor(status: number, code: string) { super(code); this.status = status; this.code = code; }
}
const refuse = (status: number, code: string): never => { throw new ProvisionalPlayError(status, code); };
export const playHash = (value: string) => createHash('sha256').update(value, 'utf8').digest('hex');
export function parseProvisionalPlay(value: unknown): ProvisionalPlay | undefined {
  if (value === undefined) return undefined;
  const p = value as ProvisionalPlay;
  if (!p || typeof p.audience !== 'string' || !p.audience || p.audience.length > 256
    || typeof p.proofKeyThumbprint !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(p.proofKeyThumbprint)
    || !Number.isSafeInteger(p.expiresAt) || p.expiresAt <= 0) refuse(401, 'invalid_provisional_authority');
  return { audience: p.audience, proofKeyThumbprint: p.proofKeyThumbprint, expiresAt: p.expiresAt };
}
export function assertLivePlay(play: ProvisionalPlay, now = Date.now()): void {
  parseProvisionalPlay(play);
  if (play.expiresAt * 1000 <= now) refuse(401, 'provisional_authority_expired');
}
const canonicalPod = (value: string) => {
  const u = new URL(value);
  if (!['http:', 'https:'].includes(u.protocol) || u.username || u.password || u.search || u.hash) refuse(401, 'invalid_provisional_pod');
  return u.href.replace(/\/$/, '') + '/';
};
const string = (value: unknown, max: number): value is string => typeof value === 'string' && value.length > 0 && value.length <= max;
export interface VerifiedPlayIdentity extends ProvisionalPrincipal { identityToken: string; expiresAt: number }

/** Only configured provider URLs are fetched; no issuer, pod, or URL from the wire is followed. */
export async function verifyProvisionalExchange(body: unknown, cfg: {
  identityUrl: string; fetch: PlayFetch; now?: () => number;
}): Promise<VerifiedPlayIdentity> {
  const b = body as Record<string, unknown>;
  if (!b || !string(b.identityToken, 4096) || !string(b.attestation, 16_384)
    || !string(b.audience, 256) || !string(b.proof, 256)
    || Object.keys(b).some(k => !['identityToken', 'attestation', 'audience', 'proof'].includes(k))) refuse(400, 'invalid_provisional_exchange');
  const identityToken = b.identityToken as string;
  const challenge = createHash('sha256').update(identityToken, 'utf8').digest('base64url');
  const init = { redirect: 'error', signal: AbortSignal.timeout(15_000) };
  let me: any, verified: any;
  try {
    const mr = await cfg.fetch(new URL('/me', cfg.identityUrl).href, {
      ...init, headers: { Authorization: 'Bearer ' + identityToken },
    });
    if (!mr.ok) refuse(401, 'invalid_identity_credential');
    me = await mr.json();
    const vr = await cfg.fetch(new URL('/play/provisional/verify', cfg.identityUrl).href, {
      ...init, method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ attestation: b.attestation, audience: b.audience, challenge, proof: b.proof }),
    });
    if (!vr.ok) refuse(401, 'invalid_provisional_proof');
    verified = await vr.json();
  } catch (error) {
    if (error instanceof ProvisionalPlayError) throw error;
    refuse(503, 'provisional_provider_unavailable');
  }
  const play = parseProvisionalPlay(me?.provisionalPlay);
  if (!play || verified?.valid !== true || verified.provisional !== true
    || !string(me.userId, 256) || !string(me.webId, 2048) || !string(me.podUrl, 2048)
    || !string(me.authenticatedAgentId, 256) || !string(me.authenticatedAgentDid, 2048)
    || !string(verified.ownerDid, 2048) || !string(verified.podUrl, 2048)
    || verified.userId !== me.userId || verified.webId !== me.webId
    || verified.ownerDid !== me.did || verified.authenticatedAgentId !== me.authenticatedAgentId
    || verified.authenticatedAgentDid !== me.authenticatedAgentDid
    || canonicalPod(verified.podUrl) !== canonicalPod(me.podUrl)
    || verified.audience !== b.audience || play.audience !== b.audience
    || verified.proofKeyThumbprint !== play.proofKeyThumbprint) refuse(401, 'provisional_identity_mismatch');
  const now = (cfg.now ?? Date.now)();
  assertLivePlay(play, now);
  const verifiedExpiry = Date.parse(verified.expiresAt);
  const tokenExpiry = Date.parse(me.tokenExpiresAt);
  if (!Number.isFinite(verifiedExpiry) || !Number.isFinite(tokenExpiry)
    || verifiedExpiry !== play.expiresAt * 1000 || tokenExpiry <= now || tokenExpiry > verifiedExpiry) refuse(401, 'invalid_provisional_expiry');
  if (!Array.isArray(verified.capabilities) || verified.capabilities.length !== 2
    || !verified.capabilities.includes('human-play') || !verified.capabilities.includes('own-pod-checkpoint')) refuse(401, 'invalid_provisional_capabilities');
  return { userId: me.userId, agentId: me.authenticatedAgentDid, ownerWebId: me.webId, ownerDid: verified.ownerDid,
    podUrl: canonicalPod(me.podUrl), identityToken, provisionalPlay: play,
    expiresAt: Math.min(Math.floor(tokenExpiry / 1000), play.expiresAt) };
}

/** Durable single-use receipt: conditional creation is the cross-process replay gate. */
export async function claimProvisionalExchange(identityToken: string, expiresAt: number, cfg: {
  podUrl: string; fetch: PlayFetch;
}): Promise<void> {
  const response = await cfg.fetch(cfg.podUrl.replace(/\/$/, '') + '/play-exchanges/' + playHash(identityToken) + '.jsonld', {
    method: 'PUT', headers: { 'Content-Type': 'application/ld+json', 'If-None-Match': '*' },
    body: JSON.stringify({ '@type': 'urn:iep:relay:ProvisionalExchange', expiresAt }),
  });
  if (response.status === 412 || response.status === 409) refuse(409, 'provisional_exchange_replayed');
  if (!response.ok) refuse(503, 'provisional_receipt_unavailable');
}

export const PROVISIONAL_EXCHANGE_LIMIT = 256;
/** A fresh native bearer never resets the fixed guest's lifetime relay budget.
 * Charge before replay receipts, pod bootstrap, or token issuance. The counter is
 * one small CAS record, not a snapshot of the growing access-token collection. */
export async function chargeProvisionalExchange(p: ProvisionalPrincipal, cfg: {
  podUrl: string; fetch: PlayFetch; withMutex: <T>(key: string, fn: () => Promise<T>) => Promise<T>;
}): Promise<void> {
  assertLivePlay(p.provisionalPlay);
  const url = cfg.podUrl.replace(/\/$/, '') + '/play-exchange-limits/' + playHash(p.userId) + '.jsonld';
  const binding = playHash(JSON.stringify([p.userId, p.provisionalPlay.audience,
    p.provisionalPlay.proofKeyThumbprint, p.provisionalPlay.expiresAt]));
  await cfg.withMutex(url, async () => {
    const response = await cfg.fetch(url, { method: 'GET' });
    if (!response.ok && response.status !== 404) refuse(503, 'provisional_exchange_budget_unavailable');
    const record = response.status === 404
      ? { binding, expiresAt: p.provisionalPlay.expiresAt, attempts: 0 }
      : await response.json();
    if (record.binding !== binding || record.expiresAt !== p.provisionalPlay.expiresAt
      || !Number.isSafeInteger(record.attempts) || record.attempts < 0) refuse(403, 'provisional_exchange_budget_mismatch');
    if (record.attempts >= PROVISIONAL_EXCHANGE_LIMIT) refuse(429, 'provisional_exchange_limit');
    const etag = response.headers?.get('etag');
    if (response.status !== 404 && !etag) refuse(503, 'provisional_exchange_budget_unavailable');
    const saved = await cfg.fetch(url, { method: 'PUT',
      headers: { 'Content-Type': 'application/ld+json', ...(response.status === 404 ? { 'If-None-Match': '*' } : { 'If-Match': etag }) },
      body: JSON.stringify({ binding, expiresAt: p.provisionalPlay.expiresAt, attempts: record.attempts + 1 }),
    });
    if (!saved.ok) refuse(saved.status === 412 ? 409 : 503, 'provisional_exchange_budget_unavailable');
  });
}

export const PROVISIONAL_TOOLS = new Set(['get_pod_status', 'get_current_head', 'get_descriptor',
  'get_encrypted_graph', 'register_agent', 'publish_context']);
const MAX_INITIAL_GRAPH_BYTES = 1024 * 1024;
function samePodSelector(args: Record<string, unknown>, p: ProvisionalPrincipal): void {
  if (args.pod_name !== undefined && args.pod_name !== p.userId) refuse(403, 'provisional_own_pod_only');
  if (args.pod_url !== undefined && (typeof args.pod_url !== 'string'
    || canonicalPod(args.pod_url) !== canonicalPod(p.podUrl))) refuse(403, 'provisional_own_pod_only');
  if (args.agent_id !== undefined && args.agent_id !== p.agentId && !String(args.agent_id).startsWith(p.podUrl + 'agents#browser-encryption-')) refuse(403, 'provisional_actor_mismatch');
  if (args.owner_webid !== undefined && args.owner_webid !== p.ownerWebId) refuse(403, 'provisional_owner_mismatch');
}
export function provisionalGraphs(p: ProvisionalPrincipal): string[] {
  const suffix = playHash(p.ownerDid);
  return ['urn:graph:hallowmarch:player-profile:' + suffix, 'urn:graph:hallowmarch:player-profile-index:' + suffix];
}
/** Returns a finite durable reservation key for mutations, otherwise undefined. */
export function validateProvisionalTool(name: string, args: Record<string, unknown>, p: ProvisionalPrincipal): string | undefined {
  assertLivePlay(p.provisionalPlay);
  if (!PROVISIONAL_TOOLS.has(name)) refuse(403, 'provisional_tool_forbidden');
  samePodSelector(args, p);
  if (Buffer.byteLength(JSON.stringify(args), 'utf8') > MAX_INITIAL_GRAPH_BYTES + 8192) refuse(413, 'provisional_payload_too_large');
  if (name === 'get_pod_status') return;
  if (name === 'get_current_head') {
    if (!provisionalGraphs(p).includes(args.urn as string)) refuse(403, 'provisional_graph_forbidden');
    return;
  }
  if (name === 'get_descriptor' || name === 'get_encrypted_graph') {
    const target = name === 'get_descriptor' ? args.url ?? args.descriptor_url : args.url;
    if (typeof target !== 'string' || (!new RegExp('^' + escapeRegex(p.podUrl) + 'context-graphs/[^/?#]+\\.ttl$').test(target)
      && !(name === 'get_descriptor' && target === p.podUrl + 'agents'))) refuse(403, 'provisional_resource_forbidden');
    return;
  }
  if (name === 'register_agent') {
    const key = args.encryption_public_key;
    if (typeof key !== 'string' || !/^[A-Za-z0-9+/]{43}=$/.test(key) || Buffer.from(key, 'base64').length !== 32
      || args.scope !== 'ReadOnly' || args.label !== 'Browser-held encryption recipient'
      || args.agent_id !== p.podUrl + 'agents#browser-encryption-' + playHash(key)
      || Object.keys(args).some(k => !k.startsWith('_') && !['agent_id','pod_name','pod_url','owner_webid','scope','encryption_public_key','label'].includes(k))) refuse(403, 'provisional_recipient_only');
    return 'recipient';
  }
  if (!provisionalGraphs(p).includes(args.graph_iri as string) || args.sealed_payload !== true
    || args.visibility !== 'private' || args.sign_authorship !== true || args.sync !== true
    || typeof args.descriptor_id !== 'string' || !/^urn:uuid:[0-9a-f-]{36}$/i.test(args.descriptor_id)
    || typeof args.graph_content !== 'string' || Buffer.byteLength(args.graph_content, 'utf8') > MAX_INITIAL_GRAPH_BYTES
    || typeof args.content_digest !== 'string' || !/^(?:graph-nquads-sha256:)[0-9a-f]{64}$/i.test(args.content_digest)
    || (args.cleartext_mirror !== undefined && args.cleartext_mirror !== '')
    || Object.keys(args).some(k => !k.startsWith('_') && !['agent_id','pod_name','pod_url','owner_webid','graph_iri','sealed_payload','visibility','sign_authorship','sync','descriptor_id','graph_content','content_digest','cleartext_mirror','auto_supersede_prior','if_match','supersedes'].includes(k))) refuse(403, 'provisional_checkpoint_only');
  // Initial graph bindings are immutable. All later state goes through the two bounded
  // conditional NativeResource checkpoint paths enforced by the storage gate.
  if (args.supersedes || args.if_match || args.auto_supersede_prior !== false) refuse(403, 'provisional_initial_binding_only');
  return 'graph:' + args.graph_iri;
}
function escapeRegex(value: string) { return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }

interface LimitRecord { expiresAt: number; entries: Record<string, { fingerprint: string; result?: string; attempts: number; publicKey?: string }> }
/** One recipient + two immutable publications per guest, durable across relay restarts. */
export function createProvisionalToolGuard(cfg: {
  podUrl: string; fetch: PlayFetch; withMutex: <T>(key: string, fn: () => Promise<T>) => Promise<T>;
  assertUnpublished: (graphIri: string, principal: ProvisionalPrincipal) => Promise<void>;
}) {
  return async (name: string, args: Record<string, unknown>, p: ProvisionalPrincipal, invoke: () => Promise<string>): Promise<string> => {
    const reservation = validateProvisionalTool(name, args, p);
    if (!reservation) return invoke();
    const url = cfg.podUrl.replace(/\/$/, '') + '/play-limits/' + playHash(p.userId) + '.jsonld';
    return cfg.withMutex(url, async () => {
      assertLivePlay(p.provisionalPlay);
      const r = await cfg.fetch(url, { method: 'GET' });
      if (!r.ok && r.status !== 404) refuse(503, 'provisional_limits_unavailable');
      const record: LimitRecord = r.status === 404 ? { expiresAt: p.provisionalPlay.expiresAt, entries: {} } : await r.json();
      if (record.expiresAt !== p.provisionalPlay.expiresAt || !record.entries || Object.keys(record.entries).length > 3) refuse(403, 'provisional_limits_mismatch');
      const publicArgs = Object.fromEntries(Object.entries(args).filter(([k]) => !k.startsWith('_')
        && !['pod_name','pod_url','owner_webid'].includes(k) && !(name === 'publish_context' && k === 'agent_id')).sort(([a],[b])=>a.localeCompare(b)));
      const fingerprint = playHash(JSON.stringify(publicArgs));
      const existing = record.entries[reservation];
      if (existing && existing.fingerprint !== fingerprint) refuse(409, 'provisional_initial_binding_exists');
      if (existing?.result !== undefined) return existing.result;
      if (name === 'publish_context') {
        const recipient = record.entries['recipient'];
        let envelope: any;
        try { envelope = JSON.parse(args.graph_content as string); } catch { refuse(403, 'provisional_sealed_binding_required'); }
        if (!recipient?.result || !recipient.publicKey || envelope?.version !== 1 || envelope.algorithm !== 'X25519-XSalsa20-Poly1305'
          || envelope.content?.algorithm !== 'XSalsa20-Poly1305' || envelope.wrappedKeys?.length !== 1
          || envelope.wrappedKeys[0].senderPublicKey !== recipient.publicKey
          || envelope.wrappedKeys[0].recipientPublicKey !== recipient.publicKey) refuse(403, 'provisional_owner_recipient_only');
        // A lost native acknowledgement must be reconciled by reading the immutable
        // original. Re-publishing a known head can create a second descriptor/history.
        await cfg.assertUnpublished(args.graph_iri as string, p);
      }
      if ((existing?.attempts ?? 0) >= 3) refuse(409, 'provisional_binding_retry_limit');
      {
        const etag = r.headers?.get('etag');
        if (r.status !== 404 && !etag) refuse(503, 'provisional_limits_unavailable');
        record.entries[reservation] = { fingerprint, attempts: (existing?.attempts ?? 0) + 1,
          ...(name === 'register_agent' ? { publicKey: args.encryption_public_key as string } : {}) };
        const saved = await cfg.fetch(url, { method: 'PUT',
          headers: { 'Content-Type': 'application/ld+json', ...(r.status === 404 ? { 'If-None-Match': '*' } : { 'If-Match': etag }) },
          body: JSON.stringify(record) });
        if (!saved.ok) refuse(saved.status === 412 ? 409 : 503, 'provisional_limits_unavailable');
      }
      const result = await invoke();
      let parsed: any;
      try { parsed = JSON.parse(result); } catch { return result; }
      if (!parsed.error && Buffer.byteLength(result, 'utf8') <= 32 * 1024) {
        const current = await cfg.fetch(url, { method: 'GET' });
        const etag = current.headers?.get('etag');
        if (!current.ok || !etag) refuse(503, 'provisional_limits_unavailable');
        const completed = await current.json() as LimitRecord;
        if (completed.entries[reservation]?.fingerprint !== fingerprint) refuse(409, 'provisional_initial_binding_exists');
        completed.entries[reservation]!.result = result;
        const saved = await cfg.fetch(url, { method: 'PUT', headers: { 'Content-Type': 'application/ld+json', 'If-Match': etag }, body: JSON.stringify(completed) });
        if (!saved.ok) refuse(503, 'provisional_limits_unavailable');
      }
      return result;
    });
  };
}

