import * as crypto from 'node:crypto';
import { ProvisionalPlay, PlayError, parsePlayClients, type PlayClaims } from './provisional-play.js';
import { provisionPlayAnchor, type PlayAnchorDocument } from './provisional-play-store.js';
import { reservePlayAdmission, type PlayAdmissionLedger } from './provisional-play-admission.js';

export interface PlayProviderOptions {
  issuer: string;
  cssUrl: string;
  publicPodBase: string;
  relayUrl: string;
  signingKey: Uint8Array;
  /** Never issue long-lived anchors under the development ephemeral key. */
  stableSigningKey: boolean;
  clientsJson?: string;
  ttlSeconds?: number;
  maxPods?: number;
  fetcher?: typeof fetch;
  listPods(): Promise<string[]>;
  empty(claims: PlayClaims): PlayAnchorDocument;
  committed(document: PlayAnchorDocument): void;
  issueCredential(claims: PlayClaims): Promise<Record<string, unknown>>;
  recoverSigner(message: string, signature: string): Promise<string>;
}
export function createProvisionalPlayProvider(options: PlayProviderOptions): ProvisionalPlay {
  const fetcher = options.fetcher ?? fetch;
  const clients = parsePlayClients(options.clientsJson);
  if (clients.size && !options.stableSigningKey) throw new Error('Provisional Play requires a stable TOKEN_SIGNING_KEY');
  const pod = new URL(options.publicPodBase);
  if (clients.size && (pod.protocol !== 'https:' || pod.username || pod.password || pod.search || pod.hash || !pod.pathname.endsWith('/')))
    throw new Error('Provisional Play requires canonical HTTPS CSS_PUBLIC_URL');
  const request = (url: string, init: RequestInit = {}) => fetcher(url, {
    ...init, redirect: 'error', signal: AbortSignal.timeout(15000),
  });
  const read = async (userId: string) => {
    const response = await request(new URL(`${userId}/auth-methods.jsonld`, options.cssUrl).href, { headers: { Accept: 'application/ld+json' } });
    if (response.status === 404) return null;
    if (!response.ok) throw new Error('Provisional anchor unavailable');
    const etag = response.headers.get('etag');
    if (!etag) throw new Error('Provisional anchor lacks conditional-write validator');
    const document = await response.json() as PlayAnchorDocument;
    if (!document || typeof document !== 'object' || document.userId !== userId) throw new PlayError(409, 'provisional_owner_conflict');
    return { document, etag };
  };
  // One admission writer per deployment. Canonical anchor CAS separately
  // prevents duplicate/replayed issuance across restarts and concurrent requests.
  let admission = Promise.resolve();
  const play = new ProvisionalPlay({
    issuer: options.issuer, publicPodBase: options.publicPodBase, signingKey: options.signingKey,
    clients, ttlSeconds: options.ttlSeconds ?? 86400, maxPods: options.maxPods ?? 100,
    verifyGrantSignature: async (grant, client) => {
      const response = await request(new URL('/tool/verify_agent', options.relayUrl).href, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ agent_id: client.agentDid, pod_url: client.podUrl }),
      });
      if (!response.ok) throw new Error('Native grant verification unavailable');
      const result = await response.json() as {
        verified?: boolean; subject_pod_url?: string;
        signing?: { relayAnchor?: string; canSignDelegatedRequests?: boolean };
      };
      if (result.verified !== true || result.subject_pod_url !== client.podUrl
        || result.signing?.canSignDelegatedRequests !== true || !/^0x[0-9a-fA-F]{40}$/.test(result.signing?.relayAnchor ?? '')) return false;
      const message = `sha256:${crypto.createHash('sha256').update(grant._signed_payload, 'utf8').digest('hex')}`;
      try { return (await options.recoverSigner(message, grant._signature)).toLowerCase() === result.signing!.relayAnchor!.toLowerCase(); }
      catch { return false; }
    },
    readAnchor: async userId => (await read(userId))?.document.provisionalPlayAnchor ?? null,
    provision: async (claims, attestation, maxPods, receipt) => {
      const before = admission;
      let release!: () => void;
      admission = new Promise(resolve => { release = resolve; });
      await before;
      try {
        return await provisionPlayAnchor({
          read,
          write: async (userId, document, etag) => {
            if (etag === null) {
              const container = await request(new URL(`${userId}/`, options.cssUrl).href, {
                method: 'PUT', headers: { 'Content-Type': 'text/turtle', Link: '<http://www.w3.org/ns/ldp#BasicContainer>; rel="type"' }, body: '',
              });
              if (!container.ok && container.status !== 409) throw new Error('Provisional pod creation unavailable');
            }
            const response = await request(new URL(`${userId}/auth-methods.jsonld`, options.cssUrl).href, {
              method: 'PUT', headers: { 'Content-Type': 'application/ld+json',
                ...(etag === null ? { 'If-None-Match': '*' } : { 'If-Match': etag }) }, body: JSON.stringify(document),
            });
            if (response.status === 412) return false;
            if (!response.ok) throw new Error('Provisional anchor persistence failed');
            return true;
          },
          reserveAdmission: (owner, anchor, limit) => reservePlayAdmission({
            read: async () => {
              const response = await request(new URL('provisional-play-admission.json', options.cssUrl).href);
              if (response.status === 404) return null;
              if (!response.ok || !response.headers.get('etag')) throw new Error('Provisional admission unavailable');
              return { ledger: await response.json() as PlayAdmissionLedger, etag: response.headers.get('etag')! };
            },
            write: async (ledger, etag) => {
              const response = await request(new URL('provisional-play-admission.json', options.cssUrl).href, {
                method: 'PUT', headers: { 'Content-Type': 'application/json',
                  ...(etag === null ? { 'If-None-Match': '*' } : { 'If-Match': etag }) }, body: JSON.stringify(ledger),
              });
              if (response.status === 412) return false;
              if (!response.ok) throw new Error('Provisional admission persistence failed');
              return true;
            },
            validate: value => play.open(value),
            checkActiveCapacity: async maximum => {
              const pods = await options.listPods();
              if (pods.filter(name => name.startsWith('u-try-play-')).length >= maximum) throw new PlayError(503, 'provisional_play_capacity');
            },
          }, owner, anchor, limit),
          empty: options.empty, validate: anchor => play.open(anchor), committed: options.committed,
        }, claims, attestation, maxPods, receipt);
      } finally { release(); }
    },
    issueCredential: options.issueCredential,
  });
  return play;
}
