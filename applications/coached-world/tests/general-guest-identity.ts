/**
 * Identity for the general guest tests: the real provider
 * (deploy/identity/provisional-play-provider.ts) run in process over fake conditional storage, with
 * a service key generated here, and the door page played by a generated P-256 key. No identity,
 * relay or pod is called. Not a test module, and it imports nothing that reads the environment.
 */
import { createHash, generateKeyPairSync, sign as signWith, type KeyObject } from 'node:crypto';
import { verifyMessage, Wallet } from 'ethers';
import { GeneralGuestDoor, type DoorFetch } from '../../_shared/guest-access/door.js';
import { createProvisionalPlayProvider } from '../../../deploy/identity/provisional-play-provider.js';
import { PlayError, type PlayClaims } from '../../../deploy/identity/provisional-play.js';
import { doorProofPayload } from '../../../deploy/identity/provisional-general-guest.js';
import { linkPreviewPayload, linkProofPayload } from '../../../deploy/identity/provisional-guest-link.js';
import { playKeyThumbprint, publicPlayKey } from '../../../deploy/identity/provisional-play.js';

/** The world's registered return path (src/server.ts GENERAL_GUEST_RETURN_PATH; shared-world.test.ts holds the two equal). */
export const RETURN_PATH = '/play/general/return';
export const ISSUER = 'https://identity.example';
export const WORLD = 'https://world.example';
export const OTHER = 'https://other.example';
export const agent = { agentDid: 'did:web:identity.example:agents:world-service', podUrl: 'https://pods.example/world/' };
export const otherAgent = { agentDid: 'did:web:identity.example:agents:other-service', podUrl: 'https://pods.example/other/' };

/** Identity, with the general guest door on for the world and for one other application. */
export function identity() {
  const service = Wallet.createRandom();
  const documents = new Map<string, { body: string; revision: number }>();
  const play = createProvisionalPlayProvider({
    issuer: ISSUER, cssUrl: 'https://css.internal.example/', publicPodBase: 'https://pods.example/', relayUrl: 'https://relay.example',
    signingKey: Buffer.alloc(32, 7), stableSigningKey: true, generalGuest: true,
    clientsJson: JSON.stringify({ [WORLD]: { ...agent, generalGuest: true, generalGuestReturnPath: RETURN_PATH },
      [OTHER]: { ...otherAgent, generalGuest: true, generalGuestReturnPath: '/return' } }),
    withOwnerLock: <T>(_userId: string, work: () => Promise<T>) => work(),
    empty: (c: PlayClaims) => ({ userId: c.userId, agentId: c.authenticatedAgentId }), committed: () => {},
    issueCredential: async () => ({ token: 'unused' }),
    issueGuestToken: async claims => ({ token: `cg2_fixture.${claims.userId}`, expiresAt: new Date(Date.now() + 3_600_000).toISOString() }),
    recoverSigner: async (message, signature) => verifyMessage(message, signature),
    fetcher: (async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      if (url === 'https://relay.example/tool/verify_agent') {
        const asked = JSON.parse(String(init?.body)) as { pod_url: string };
        return Response.json({ verified: true, subject_pod_url: asked.pod_url, signing: { relayAnchor: service.address, canSignDelegatedRequests: true } });
      }
      if (init?.method === 'PUT') {
        const current = documents.get(url); const headers = init.headers as Record<string, string>;
        if ((headers['If-None-Match'] === '*' && current) || (headers['If-Match'] && headers['If-Match'] !== String(current?.revision))) return new Response(null, { status: 412 });
        documents.set(url, { body: String(init.body), revision: (current?.revision ?? 0) + 1 });
        return new Response(null, { status: 201 });
      }
      const current = documents.get(url);
      return current ? new Response(current.body, { headers: { etag: String(current.revision) } }) : new Response(null, { status: 404 });
    }) as typeof fetch,
  });
  const general = play.general!;
  /** What the relay's sign_request does for a service agent: adds who and when, and signs. */
  const signAs = (who: { agentDid: string; podUrl: string }) => async (request: Record<string, unknown>) => {
    const _signed_payload = JSON.stringify({ ...request, agent_id: who.agentDid, subject_pod_url: who.podUrl, timestamp: new Date().toISOString() });
    return { _signed_payload, _signature: await service.signMessage(`sha256:${createHash('sha256').update(_signed_payload, 'utf8').digest('hex')}`) };
  };
  const exchanges: unknown[] = [];
  const exchange: DoorFetch = async (url, init) => {
    if (url !== `${ISSUER}/guest/exchange`) throw new Error(`unexpected request to ${url}`);
    exchanges.push(JSON.parse(init.body));
    try { const body = await general.exchange(JSON.parse(init.body)); return { ok: true, status: 200, json: async () => body }; }
    catch (error) {
      if (!(error instanceof PlayError)) throw error;
      return { ok: false, status: error.status, json: async () => ({ valid: false, error: error.code }) };
    }
  };
  const doorFor = (audience: string, who: { agentDid: string; podUrl: string }, over: Partial<ConstructorParameters<typeof GeneralGuestDoor>[0]> = {}) =>
    new GeneralGuestDoor({ identityUrl: ISSUER, audience, signGrant: signAs(who), fetch: exchange, ...over });
  /** The door page: the browser's key signs the grant from the address it was sent to, and identity answers where to go back. */
  const page = async (key: { privateKey: KeyObject; publicKey: KeyObject }, doorUrl: string): Promise<URL> => {
    const url = new URL(doorUrl);
    if (url.origin + url.pathname !== `${ISSUER}/guest/door` || url.search !== '') throw new Error(`not the door: ${doorUrl}`);
    const playGrant = JSON.parse(Buffer.from(new URLSearchParams(url.hash.slice(1)).get('grant')!, 'base64url').toString('utf8')) as { _signed_payload: string; _signature: string };
    const proof = signWith('sha256', Buffer.from(doorProofPayload(playGrant)), { key: key.privateKey, dsaEncoding: 'ieee-p1363' }).toString('base64url');
    const answer = await general.door({ playGrant, publicKeyJwk: key.publicKey.export({ format: 'jwk' }), proof }, ISSUER);
    return new URL(answer.redirect);
  };
  /** A fictional registered account, by its record alone (a wallet is its credential). */
  const account = (userId: string, name: string): string => {
    documents.set(`https://css.internal.example/${userId}/auth-methods.jsonld`, { revision: 1,
      body: JSON.stringify({ userId, name, walletAddresses: [`0x${'5a'.repeat(20)}`], webAuthnCredentials: [], didKeys: [] }) });
    return userId;
  };
  /**
   * The link ceremony for the guest `key` holds: the account's owner asks for a code (identity has
   * verified their fresh credential proof by then), and the door page's two clicks follow.
   */
  const linkGuest = async (key: { privateKey: KeyObject; publicKey: KeyObject }, ownerId: string): Promise<string> => {
    const jwk = key.publicKey.export({ format: 'jwk' });
    const thumbprint = playKeyThumbprint(publicPlayKey(jwk));
    const { code } = await general.link.issueCode(ownerId);
    const expiresAt = Math.floor(Date.now() / 1000) + 60;
    const proof = (text: string) => signWith('sha256', Buffer.from(text), { key: key.privateKey, dsaEncoding: 'ieee-p1363' }).toString('base64url');
    const shown = await general.link.link({ publicKeyJwk: jwk, code, expiresAt, proof: proof(linkPreviewPayload(ISSUER, thumbprint, code, expiresAt)) }, ISSUER);
    await general.link.link({ publicKeyJwk: jwk, code, expiresAt, account: shown.account.did,
      proof: proof(linkProofPayload(ISSUER, thumbprint, code, expiresAt, shown.account.did)) }, ISSUER);
    return shown.account.did;
  };
  return { general, doorFor, page, exchanges, account, linkGuest };
}
export const newKey = () => generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
export const cookieOf = (response: Response) => (response.headers.get('set-cookie') ?? '').split(';')[0]!;

