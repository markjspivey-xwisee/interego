/**
 * Guest admission for this world.
 *
 * Local play runs the identity server's own `ProvisionalPlay` in process, with
 * the same proof templates (`interego-play-provisional-v1`, `interego-play-proof-v1`)
 * and the same `u-try-play-` owner id. Production, when a service key is set,
 * asks the relay for the grant through Foxxi's `PlayGrantService` and asks
 * identity's `/play/provisional/verify` before a session exists. The world
 * never accepts a caller-supplied user id.
 */
import { createHash, randomBytes } from 'node:crypto';
import { verifyMessage, Wallet } from 'ethers';
import { PlayGrantService, type PlayGrantConfig } from '../../foxxi-content-intelligence/src/play-grant.js';
import {
  PlayError, ProvisionalPlay, type PlayClaims, type PlayClient, type PlayGrant,
} from '../../../deploy/identity/provisional-play.js';

export interface VerifiedGuest {
  readonly ownerDid: string;
  readonly userId: string;
  readonly podUrl: string;
  readonly agentDid: string;
}

export interface GuestDoor {
  readonly audience: string;
  readonly identityUrl: string;
  readonly local: boolean;
  grant(thumbprint: string, challenge: string): Promise<{ playGrant: PlayGrant }>;
  verify(body: unknown): Promise<VerifiedGuest>;
  bootstrap?(body: unknown): Promise<Record<string, unknown>>;
}

function didHost(origin: string): string {
  const url = new URL(origin);
  return url.port ? `${url.hostname}%3A${url.port}` : url.hostname;
}

export function createLocalDoor(origin: string): GuestDoor {
  const wallet = Wallet.createRandom();
  const agentDid = `did:web:${didHost(origin)}:agents:coached-world-service`;
  const podUrl = `${origin}/service/`;
  const clients = new Map<string, PlayClient>([[origin, { agentDid, podUrl }]]);
  const anchors = new Map<string, string>();
  const receipts = new Set<string>();
  const play = new ProvisionalPlay({
    issuer: origin,
    publicPodBase: `${origin}/pods/`,
    signingKey: randomBytes(32),
    clients,
    ttlSeconds: 86_400,
    maxPods: 100,
    verifyGrantSignature: async grant => {
      const message = `sha256:${createHash('sha256').update(grant._signed_payload, 'utf8').digest('hex')}`;
      try { return verifyMessage(message, grant._signature).toLowerCase() === wallet.address.toLowerCase(); }
      catch { return false; }
    },
    readAnchor: async userId => anchors.get(userId) ?? null,
    provision: async (claims, attestation, _maxPods, receipt) => {
      if (receipts.has(receipt.hash)) throw new PlayError(409, 'play_grant_already_used');
      receipts.add(receipt.hash);
      const first = anchors.get(claims.userId);
      if (first) return first;
      anchors.set(claims.userId, attestation);
      return attestation;
    },
    issueCredential: async (claims: PlayClaims) => ({
      token: 'not-a-world-session', userId: claims.userId, did: claims.ownerDid, webId: claims.webId,
      podUrl: claims.podUrl, agentId: claims.authenticatedAgentId, agentDid: claims.authenticatedAgentDid,
      provisional: true,
    }),
  });
  return {
    audience: origin,
    identityUrl: origin,
    local: true,
    async grant(thumbprint, challenge) {
      const now = Math.floor(Date.now() / 1000);
      const payload = {
        purpose: 'interego-play-provisional-v1', audience: origin, publicKeyThumbprint: thumbprint, challenge,
        expiresAt: now + 90, agent_id: agentDid, subject_pod_url: podUrl, timestamp: new Date(now * 1000).toISOString(),
      };
      const _signed_payload = JSON.stringify(payload);
      const message = `sha256:${createHash('sha256').update(_signed_payload, 'utf8').digest('hex')}`;
      return { playGrant: { _signed_payload, _signature: await wallet.signMessage(message) } };
    },
    bootstrap: body => play.bootstrap(body),
    async verify(body) {
      const claims = await play.verify(body);
      return { ownerDid: claims.ownerDid, userId: claims.userId, podUrl: claims.podUrl, agentDid: claims.authenticatedAgentDid };
    },
  };
}

export function createRelayDoor(config: PlayGrantConfig): GuestDoor {
  const grants = new PlayGrantService(config);
  return {
    audience: config.audience,
    identityUrl: config.identityUrl,
    local: false,
    async grant(thumbprint, challenge) {
      const granted = await grants.grant({ publicKeyThumbprint: thumbprint, challenge });
      return { playGrant: granted.playGrant };
    },
    async verify(body) {
      const response = await fetch(`${config.identityUrl}/play/provisional/verify`, {
        method: 'POST', headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify(body), redirect: 'error', signal: AbortSignal.timeout(15_000),
      });
      const parsed = await response.json() as Partial<VerifiedGuest> & { valid?: boolean; authenticatedAgentDid?: string };
      if (!response.ok || parsed.valid !== true || !parsed.ownerDid || !parsed.userId || !parsed.podUrl || !parsed.authenticatedAgentDid) {
        throw new PlayError(401, 'invalid_browser_proof');
      }
      return { ownerDid: parsed.ownerDid, userId: parsed.userId, podUrl: parsed.podUrl, agentDid: parsed.authenticatedAgentDid };
    },
  };
}

export { PlayError };
