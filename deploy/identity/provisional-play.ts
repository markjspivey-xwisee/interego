/** Browser-key provisional owners. All authoritative state is a signed pod anchor. */
import * as crypto from 'node:crypto';

export type PublicPlayKey = { kty: 'EC'; crv: 'P-256'; x: string; y: string };
export type PlayClient = { agentDid: string; podUrl: string };
export type PlayGrant = { _signed_payload: string; _signature: string };
export interface PlayClaims {
  version: 1;
  issuer: string;
  audience: string;
  userId: string;
  ownerDid: string;
  webId: string;
  podUrl: string;
  authenticatedAgentId: string;
  authenticatedAgentDid: string;
  publicKeyJwk: PublicPlayKey;
  proofKeyThumbprint: string;
  issuedAt: number;
  expiresAt: number;
  capabilities: readonly ['human-play', 'own-pod-checkpoint'];
  provisional: true;
}
export class PlayError extends Error {
  constructor(readonly status: number, readonly code: string) { super(code); }
}
const fail = (status: number, code: string): never => { throw new PlayError(status, code); };
const b64 = (value: unknown, bytes?: number): value is string => typeof value === 'string'
  && /^[A-Za-z0-9_-]+$/.test(value) && (!bytes || (value.length === Math.ceil(bytes * 4 / 3)
    && Buffer.from(value, 'base64url').length === bytes && Buffer.from(value, 'base64url').toString('base64url') === value));

export function publicPlayKey(value: unknown): PublicPlayKey {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return fail(400, 'invalid_public_key');
  const key = value as Record<string, unknown>;
  if (key.kty !== 'EC' || key.crv !== 'P-256' || !b64(key.x, 32) || !b64(key.y, 32)
    || Object.hasOwn(key, 'd')) return fail(400, 'invalid_public_key');
  const out: PublicPlayKey = { crv: 'P-256', kty: 'EC', x: key.x, y: key.y };
  try { crypto.createPublicKey({ key: out, format: 'jwk' }); } catch { return fail(400, 'invalid_public_key'); }
  return out;
}
export function playKeyThumbprint(key: PublicPlayKey): string {
  return crypto.createHash('sha256').update(JSON.stringify({ crv: key.crv, kty: key.kty, x: key.x, y: key.y })).digest('base64url');
}
export function provisionalUserId(audience: string, thumbprint: string): string {
  return `u-try-play-${crypto.createHash('sha256').update(`${audience}\n${thumbprint}`).digest('hex').slice(0, 32)}`;
}
export function bootstrapProofPayload(grant: PlayGrant): string {
  return `interego-play-provisional-v1\n${grant._signed_payload}\n${grant._signature}`;
}
export function playProofPayload(attestation: string, audience: string, challenge: string): string {
  return `interego-play-proof-v1\n${attestation}\n${audience}\n${challenge}`;
}
export function verifyPlayProof(key: PublicPlayKey, payload: string, proof: unknown): boolean {
  if (!b64(proof, 64)) return false;
  try {
    return crypto.verify('sha256', Buffer.from(payload, 'utf8'), {
      key: crypto.createPublicKey({ key, format: 'jwk' }), dsaEncoding: 'ieee-p1363',
    }, Buffer.from(proof, 'base64url'));
  } catch { return false; }
}
function origin(value: unknown): string {
  if (typeof value !== 'string' || value.length > 256) return fail(400, 'invalid_audience');
  let url: URL; try { url = new URL(value); } catch { return fail(400, 'invalid_audience'); }
  if (url.origin !== value || (url.protocol !== 'https:' && !(url.protocol === 'http:'
    && ['localhost', '127.0.0.1'].includes(url.hostname)))) return fail(400, 'invalid_audience');
  return value;
}
export function parsePlayClients(raw: string | undefined): ReadonlyMap<string, PlayClient> {
  if (!raw) return new Map();
  const parsed = JSON.parse(raw);
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('Invalid PROVISIONAL_PLAY_CLIENTS');
  const clients = new Map<string, PlayClient>();
  for (const [audience, client] of Object.entries(parsed)) {
    origin(audience);
    const value = client as PlayClient;
    if (!value || typeof value.agentDid !== 'string' || !/^did:web:[^\s]+:agents:[A-Za-z0-9._~-]+$/.test(value.agentDid))
      throw new Error('Invalid provisional Play principal');
    const pod = new URL(value.podUrl);
    if (pod.protocol !== 'https:' || pod.username || pod.password || pod.search || pod.hash || !pod.pathname.endsWith('/'))
      throw new Error('Invalid provisional Play pod');
    clients.set(audience, { agentDid: value.agentDid, podUrl: pod.href });
  }
  return clients;
}

export interface PlayDependencies {
  issuer: string;
  publicPodBase: string;
  signingKey: Uint8Array;
  clients: ReadonlyMap<string, PlayClient>;
  ttlSeconds: number;
  maxPods: number;
  now?: () => number;
  /** Uses a fixed configured relay and configured principal/pod, never caller URLs. */
  verifyGrantSignature(grant: PlayGrant, client: PlayClient): Promise<boolean>;
  /** Read a canonical pod anchor; null only on 404. Errors must fail closed. */
  readAnchor(userId: string): Promise<string | null>;
  /** Serialize + compare/create durably; enforce admission capacity before creating. */
  provision(claims: PlayClaims, attestation: string, maxPods: number, receipt: { hash: string; expiresAt: number }): Promise<string>;
  issueCredential(claims: PlayClaims): Promise<Record<string, unknown>>;
}

export class ProvisionalPlay {
  readonly ttlSeconds: number;
  readonly maxPods: number;
  private readonly now: () => number;
  constructor(private readonly deps: PlayDependencies) {
    if (deps.signingKey.byteLength < 32) throw new Error('Provisional Play signing key must be stable and at least 32 bytes');
    this.ttlSeconds = Math.min(604800, Math.max(3600, Math.floor(deps.ttlSeconds || 86400)));
    this.maxPods = Math.min(1000, Math.max(1, Math.floor(deps.maxPods || 100)));
    this.now = deps.now ?? (() => Math.floor(Date.now() / 1000));
  }
  private seal(claims: PlayClaims): string {
    const encoded = Buffer.from(JSON.stringify(claims)).toString('base64url');
    const signature = crypto.createHmac('sha256', this.deps.signingKey).update(`interego-play-attestation-v1\0${encoded}`).digest('base64url');
    return `ipa1_${encoded}.${signature}`;
  }
  open(attestation: unknown, allowExpired = false): PlayClaims {
    if (typeof attestation !== 'string' || attestation.length > 8192) return fail(400, 'invalid_attestation');
    const match = /^ipa1_([A-Za-z0-9_-]+)\.([A-Za-z0-9_-]+)$/.exec(attestation);
    if (!match || !b64(match[2], 32)) return fail(401, 'invalid_attestation');
    const expected = crypto.createHmac('sha256', this.deps.signingKey).update(`interego-play-attestation-v1\0${match[1]}`).digest();
    if (!crypto.timingSafeEqual(expected, Buffer.from(match[2], 'base64url'))) return fail(401, 'invalid_attestation');
    let c: PlayClaims; try { c = JSON.parse(Buffer.from(match[1], 'base64url').toString('utf8')); }
    catch { return fail(401, 'invalid_attestation'); }
    if (c.version !== 1 || c.provisional !== true || c.issuer !== this.deps.issuer || (!allowExpired && !this.deps.clients.has(c.audience))
      || c.userId !== provisionalUserId(c.audience, c.proofKeyThumbprint)
      || c.proofKeyThumbprint !== playKeyThumbprint(publicPlayKey(c.publicKeyJwk))
      || !Number.isInteger(c.issuedAt) || !Number.isInteger(c.expiresAt) || c.expiresAt <= c.issuedAt
      || c.expiresAt - c.issuedAt > 604800 || c.issuedAt > this.now() + 5) return fail(401, 'invalid_attestation');
    if (!allowExpired && c.expiresAt <= this.now()) return fail(410, 'provisional_owner_expired');
    return c;
  }
  async bootstrap(input: unknown): Promise<Record<string, unknown>> {
    if (!this.deps.clients.size) return fail(503, 'provisional_play_disabled');
    const body = input as { playGrant?: PlayGrant; publicKeyJwk?: unknown; proof?: unknown };
    const key = publicPlayKey(body?.publicKeyJwk);
    const grant = body?.playGrant;
    if (!grant || typeof grant._signed_payload !== 'string' || grant._signed_payload.length > 8192
      || typeof grant._signature !== 'string' || !/^0x[0-9a-fA-F]{130}$/.test(grant._signature)) return fail(400, 'invalid_play_grant');
    let payload: Record<string, unknown>;
    try { payload = JSON.parse(grant._signed_payload); } catch { return fail(400, 'invalid_play_grant'); }
    const audience = origin(payload.audience);
    const client = this.deps.clients.get(audience);
    const timestamp = typeof payload.timestamp === 'string' ? Date.parse(payload.timestamp) / 1000 : NaN;
    const now = this.now();
    if (!client || payload.purpose !== 'interego-play-provisional-v1'
      || payload.agent_id !== client.agentDid || payload.subject_pod_url !== client.podUrl
      || payload.publicKeyThumbprint !== playKeyThumbprint(key)
      || !b64(payload.challenge) || payload.challenge.length < 20 || payload.challenge.length > 128
      || !Number.isFinite(timestamp) || timestamp > now + 5 || timestamp < now - 120
      || !Number.isInteger(payload.expiresAt) || Number(payload.expiresAt) <= now
      || Number(payload.expiresAt) > timestamp + 120) return fail(401, 'invalid_play_grant');
    if (!verifyPlayProof(key, bootstrapProofPayload(grant), body.proof)) return fail(401, 'invalid_browser_proof');
    if (!await this.deps.verifyGrantSignature(grant, client)) return fail(401, 'invalid_play_grant');
    const thumbprint = playKeyThumbprint(key);
    const userId = provisionalUserId(audience, thumbprint);
    const agentId = `mcp-client-${userId}`;
    const identityHost = new URL(this.deps.issuer).host;
    const proposed: PlayClaims = {
      version: 1, issuer: this.deps.issuer, audience, userId,
      ownerDid: `did:web:${identityHost}:users:${userId}`,
      webId: `${this.deps.issuer}/users/${userId}/profile#me`,
      podUrl: new URL(`${userId}/`, this.deps.publicPodBase).href,
      authenticatedAgentId: agentId, authenticatedAgentDid: `did:web:${identityHost}:agents:${agentId}`,
      publicKeyJwk: key, proofKeyThumbprint: thumbprint, issuedAt: now,
      expiresAt: now + this.ttlSeconds, capabilities: ['human-play', 'own-pod-checkpoint'], provisional: true,
    };
    // Storage returns the first committed anchor. Replays/refreshes never extend its TTL.
    const receipt = { hash: crypto.createHash('sha256').update(`${grant._signed_payload}\n${grant._signature}`).digest('base64url'),
      expiresAt: Number(payload.expiresAt) };
    const attestation = await this.deps.provision(proposed, this.seal(proposed), this.maxPods, receipt);
    const claims = this.open(attestation);
    if (claims.userId !== userId || claims.audience !== audience || claims.proofKeyThumbprint !== thumbprint)
      return fail(409, 'provisional_owner_conflict');
    return {
      ...await this.deps.issueCredential(claims), attestation, provisional: true,
      guestExpiresAt: new Date(claims.expiresAt * 1000).toISOString(), proofKeyThumbprint: thumbprint,
    };
  }
  async verify(input: unknown): Promise<Omit<PlayClaims, 'expiresAt'> & { valid: true; expiresAt: string }> {
    const body = input as { attestation?: unknown; audience?: unknown; challenge?: unknown; proof?: unknown };
    const claims = this.open(body?.attestation);
    const audience = origin(body.audience);
    if (claims.audience !== audience || !b64(body.challenge) || body.challenge.length < 20 || body.challenge.length > 128)
      return fail(401, 'invalid_browser_proof');
    if (!verifyPlayProof(claims.publicKeyJwk, playProofPayload(body.attestation as string, audience, body.challenge), body.proof))
      return fail(401, 'invalid_browser_proof');
    const live = await this.deps.readAnchor(claims.userId);
    if (live !== body.attestation) return fail(401, 'provisional_owner_unavailable');
    this.open(live);
    return { ...claims, valid: true, expiresAt: new Date(claims.expiresAt * 1000).toISOString() };
  }
  metadata() {
    return {
      issuer: this.deps.issuer, enabled: this.deps.clients.size > 0,
      bootstrapEndpoint: `${this.deps.issuer}/play/provisional`,
      verificationEndpoint: `${this.deps.issuer}/play/provisional/verify`,
      grantMethod: 'interego-sign_request', proofAlgorithm: 'ECDSA-P256-SHA256', proofEncoding: 'base64url-ieee-p1363',
      bootstrapProofTemplate: 'interego-play-provisional-v1\\n{_signed_payload}\\n{_signature}',
      proofTemplate: 'interego-play-proof-v1\\n{attestation}\\n{audience}\\n{challenge}',
      ttlSeconds: this.ttlSeconds, maxGuestPods: this.maxPods,
      maxLifetimeGuestOwners: this.maxPods,
      storageLimits: { maxWriteBytes: 4194304, lifetimeWriteBytes: 33554432, lifetimeWriteAttempts: 1024 },
      capabilities: ['human-play', 'own-pod-checkpoint'],
      assurance: 'Browser key possession; does not identify a human or authorize autonomous agents.',
    };
  }
}
