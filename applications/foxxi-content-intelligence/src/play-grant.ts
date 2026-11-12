/**
 * Grants for a guest who is kept by their browser (deploy/identity/PROVISIONAL-PLAY.md).
 *
 * ★ WHY. The dashboard's guest is a wallet the tab makes (dashboard-app/src/auth/session.ts,
 * connectAsGuest). It is gone on a reload unless the guest wrote its recovery phrase down. The
 * substrate's provisional owners give a browser key a pod of its own for a bounded time, in which
 * that guest can keep the wallet, sealed to a key only the browser holds
 * (dashboard-app/src/auth/durable-guest.ts). Identity admits such an owner only on a grant the
 * application's own service agent had the relay sign, so that no page can mint guests for an
 * application that did not ask for them. This module is where the bridge asks for that grant.
 *
 * Off unless configured (playGrantConfig): no key, no audience, no route. When it is on:
 *
 *   - The service signs in to identity with its own wallet (ERC-4361), `existingOnly`, so the
 *     bridge never creates an account: the operator makes the service account once, registers its
 *     agent with the relay, and names both in identity's PROVISIONAL_PLAY_CLIENTS
 *     (DURABLE-GUEST.md has the steps). The token is kept in memory and asked for again
 *     shortly before it expires.
 *   - A grant names only what the browser sent that the bridge can check the shape of: the
 *     thumbprint of its P-256 key and a challenge. The audience is this deployment's own
 *     configured origin, never the request's. The relay adds who signed and when.
 *   - What comes back from the relay is checked before it is handed on: it must carry this
 *     request's thumbprint, challenge and audience, or nothing is returned.
 *
 * The grant is not a credential. It lets the one browser key it names ask identity for an owner,
 * within identity's own admission caps and rate limits, for two minutes.
 */
import { Wallet } from 'ethers';

/** What identity's PROVISIONAL-PLAY.md calls the grant's purpose. */
export const PLAY_GRANT_PURPOSE = 'interego-play-provisional-v1';
/** A grant is asked for with this lifetime; identity refuses one that outlives its timestamp by more than 120 s. */
const GRANT_LIFETIME_S = 90;
/** The token is asked for again when it has less than this left. */
const TOKEN_RENEW_BEFORE_MS = 10 * 60 * 1000;

export interface PlayGrantConfig {
  /** The dashboard's origin: the application audience identity is configured with. */
  readonly audience: string;
  readonly identityUrl: string;
  readonly relayUrl: string;
  /** The service wallet's private key (FOXXI_PLAY_SERVICE_PRIVATE_KEY). Never logged, never returned. */
  readonly servicePrivateKey: string;
}

export class PlayGrantError extends Error {
  constructor(readonly status: number, readonly code: string, detail?: string) { super(detail ?? code); }
}

function httpsOrigin(value: string, name: string): string {
  let url: URL;
  try { url = new URL(value); } catch { throw new Error(`${name} is not a URL`); }
  const local = url.protocol === 'http:' && ['localhost', '127.0.0.1'].includes(url.hostname);
  if (url.origin !== value.replace(/\/+$/, '') || (url.protocol !== 'https:' && !local)) throw new Error(`${name} must be an HTTPS origin, with no path`);
  return url.origin;
}

/**
 * The configuration, or null where the feature is off: it is on only when both
 * FOXXI_PLAY_SERVICE_PRIVATE_KEY and FOXXI_PLAY_AUDIENCE are set. One without the other, or a
 * value that is not what it should be, throws at start instead of leaving the route half-on.
 */
export function playGrantConfig(env: Readonly<Record<string, string | undefined>>): PlayGrantConfig | null {
  const key = env['FOXXI_PLAY_SERVICE_PRIVATE_KEY']?.trim();
  const audience = env['FOXXI_PLAY_AUDIENCE']?.trim();
  if (!key && !audience) return null;
  if (!key || !audience) throw new Error('Durable guests need both FOXXI_PLAY_SERVICE_PRIVATE_KEY and FOXXI_PLAY_AUDIENCE');
  if (!/^0x[0-9a-fA-F]{64}$/.test(key)) throw new Error('FOXXI_PLAY_SERVICE_PRIVATE_KEY must be a 32-byte hex private key');
  return {
    audience: httpsOrigin(audience, 'FOXXI_PLAY_AUDIENCE'),
    identityUrl: httpsOrigin(env['INTEREGO_IDENTITY_URL'] ?? 'https://identity.interego.xwisee.com', 'INTEREGO_IDENTITY_URL'),
    relayUrl: httpsOrigin(env['INTEREGO_RELAY_URL'] ?? 'https://relay.interego.xwisee.com', 'INTEREGO_RELAY_URL'),
    servicePrivateKey: key,
  };
}

/**
 * What a grant request's body is once the bridge's own additions are taken off. The bridge's
 * request middleware writes `__client_ip` (and `__caller_token` where a bearer was sent) into every
 * JSON body before any route sees it (bridge/server.ts). `grant` refuses a body with any key but
 * its two, so handed the body as the route receives it, it refused every request from a real
 * browser (400 invalid_play_grant_request) while every test, which called `grant` directly, passed.
 * Only those two names are dropped: anything else a caller adds is still refused.
 */
export function playGrantRequestBody(body: unknown): unknown {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return body;
  const { __client_ip: _ip, __caller_token: _token, ...asked } = body as Record<string, unknown>;
  return asked;
}

/**
 * The I2IDL-X learner workbench's own grant signer, or null where guest learners are off
 * (i2idlx/LEARNING-CONNECTIONS.md, "Guest learners"). The workbench is a SECOND application to
 * identity, apart from the dashboard: its own origin (the bridge's own, never a request's), its own
 * service account, its own entry in PROVISIONAL_PLAY_CLIENTS, and so its own guests and admission
 * cap. On only when FOXXI_I2IDLX_GUEST_SERVICE_PRIVATE_KEY is set. A value that would make the two
 * applications one (the dashboard's key, or the dashboard's origin) throws at start.
 */
export function learnerGuestGrantConfig(env: Readonly<Record<string, string | undefined>>, workbenchUrl: string): PlayGrantConfig | null {
  const key = env['FOXXI_I2IDLX_GUEST_SERVICE_PRIVATE_KEY']?.trim();
  if (!key) return null;
  if (!/^0x[0-9a-fA-F]{64}$/.test(key)) throw new Error('FOXXI_I2IDLX_GUEST_SERVICE_PRIVATE_KEY must be a 32-byte hex private key');
  if (key.toLowerCase() === env['FOXXI_PLAY_SERVICE_PRIVATE_KEY']?.trim().toLowerCase()) {
    throw new Error('FOXXI_I2IDLX_GUEST_SERVICE_PRIVATE_KEY must not be FOXXI_PLAY_SERVICE_PRIVATE_KEY: the learner workbench is its own application');
  }
  const audience = httpsOrigin(workbenchUrl.replace(/\/+$/, ''), 'The workbench URL (BRIDGE_DEPLOYMENT_URL)');
  if (!audience.startsWith('https://')) throw new Error('Guest learners need the workbench on a public HTTPS origin (BRIDGE_DEPLOYMENT_URL)');
  const dashboard = env['FOXXI_PLAY_AUDIENCE']?.trim().replace(/\/+$/, '');
  if (dashboard && dashboard === audience) throw new Error('The learner workbench and FOXXI_PLAY_AUDIENCE are the same origin: identity admits one application per origin');
  return {
    audience,
    identityUrl: httpsOrigin(env['INTEREGO_IDENTITY_URL'] ?? 'https://identity.interego.xwisee.com', 'INTEREGO_IDENTITY_URL'),
    relayUrl: httpsOrigin(env['INTEREGO_RELAY_URL'] ?? 'https://relay.interego.xwisee.com', 'INTEREGO_RELAY_URL'),
    servicePrivateKey: key,
  };
}

export type PlayFetch = (url: string, init?: { method?: string; headers?: Record<string, string>; body?: string; signal?: AbortSignal }) =>
  Promise<{ ok: boolean; status: number; json(): Promise<unknown> }>;

interface ServiceSession { token: string; expiresAt: number; userId: string; agentDid: string; podUrl: string }

const record = (value: unknown): Record<string, unknown> =>
  value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
const text = (value: unknown): string | undefined => typeof value === 'string' && value.length > 0 ? value : undefined;

export interface PlayGrant { readonly _signed_payload: string; readonly _signature: string }

export class PlayGrantService {
  private readonly wallet: Wallet;
  private session: ServiceSession | undefined;
  private signingIn: Promise<ServiceSession> | undefined;
  private readonly now: () => number;
  private readonly fetch: PlayFetch;

  constructor(readonly config: PlayGrantConfig, deps: { fetch?: PlayFetch; now?: () => number } = {}) {
    this.wallet = new Wallet(config.servicePrivateKey);
    this.now = deps.now ?? Date.now;
    this.fetch = deps.fetch ?? ((url, init) => fetch(url, { ...init, redirect: 'error', signal: init?.signal ?? AbortSignal.timeout(15_000) }));
  }

  private async post(url: string, body: unknown, bearer?: string): Promise<{ ok: boolean; status: number; body: Record<string, unknown> }> {
    let response;
    try {
      response = await this.fetch(url, { method: 'POST', body: JSON.stringify(body),
        headers: { 'Content-Type': 'application/json', Accept: 'application/json', ...(bearer ? { Authorization: `Bearer ${bearer}` } : {}) } });
    } catch { throw new PlayGrantError(503, 'play_grant_unavailable', `no answer from ${new URL(url).host}`); }
    let parsed: unknown;
    try { parsed = await response.json(); } catch { parsed = {}; }
    return { ok: response.ok, status: response.status, body: record(parsed) };
  }

  /** Sign in to identity as the service wallet. `existingOnly`: an account is never created from here. */
  private async signIn(): Promise<ServiceSession> {
    const base = this.config.identityUrl;
    const challenge = await this.post(`${base}/challenges`, { purpose: 'siwe' });
    const nonce = text(challenge.body['nonce']);
    if (!challenge.ok || !nonce) throw new PlayGrantError(503, 'play_service_sign_in_unavailable', `identity answered ${challenge.status} to the challenge`);
    const message = `${new URL(base).host} wants you to sign in with your Ethereum account:\n${this.wallet.address}`
      + `\n\nSign in to Interego\n\nURI: ${base}\nVersion: 1\nChain ID: 1\nNonce: ${nonce}\nIssued At: ${new Date(this.now()).toISOString()}`;
    const auth = await this.post(`${base}/auth/siwe`, { message, signature: await this.wallet.signMessage(message), nonce, existingOnly: true });
    const token = text(auth.body['token']), userId = text(auth.body['userId']), agentDid = text(auth.body['agentDid']), podUrl = text(auth.body['podUrl']);
    const expiresAt = Date.parse(text(auth.body['expiresAt']) ?? '');
    if (!auth.ok || !token || !userId || !agentDid || !podUrl || !Number.isFinite(expiresAt)) {
      // The service account does not exist yet, or identity refused the sign-in. Its own words are
      // the operator's best lead, and name no secret.
      throw new PlayGrantError(503, 'play_service_sign_in_refused', `identity answered ${auth.status}: ${text(auth.body['error']) ?? 'no reason given'}`);
    }
    return { token, expiresAt, userId, agentDid, podUrl };
  }

  private async serviceSession(fresh = false): Promise<ServiceSession> {
    if (!fresh && this.session && this.session.expiresAt - this.now() > TOKEN_RENEW_BEFORE_MS) return this.session;
    this.signingIn ??= this.signIn().finally(() => { this.signingIn = undefined; });
    this.session = await this.signingIn;
    return this.session;
  }

  /** The relay's signed grant for one browser key, checked against what was asked for. */
  async grant(input: unknown): Promise<{ playGrant: PlayGrant; audience: string; identityUrl: string }> {
    const body = record(input);
    const thumbprint = body['publicKeyThumbprint'], challenge = body['challenge'];
    if (typeof thumbprint !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(thumbprint)
      || typeof challenge !== 'string' || !/^[A-Za-z0-9_-]{20,128}$/.test(challenge)
      || Object.keys(body).some(key => key !== 'publicKeyThumbprint' && key !== 'challenge')) {
      throw new PlayGrantError(400, 'invalid_play_grant_request');
    }
    const payload = { purpose: PLAY_GRANT_PURPOSE, audience: this.config.audience, publicKeyThumbprint: thumbprint, challenge,
      expiresAt: Math.floor(this.now() / 1000) + GRANT_LIFETIME_S };
    let session = await this.serviceSession();
    let signed = await this.post(`${this.config.relayUrl}/tool/sign_request`, payload, session.token);
    if (signed.status === 401) {
      // The token was refused though it had not expired here (the account's sessions were ended):
      // sign in once more, and let a second refusal stand.
      session = await this.serviceSession(true);
      signed = await this.post(`${this.config.relayUrl}/tool/sign_request`, payload, session.token);
    }
    const signature = text(signed.body['_signature']), signedPayload = text(signed.body['_signed_payload']);
    if (!signed.ok || !signature || !signedPayload) throw new PlayGrantError(503, 'play_grant_unavailable', `the relay answered ${signed.status}`);
    let echoed: Record<string, unknown>;
    try { echoed = record(JSON.parse(signedPayload)); } catch { echoed = {}; }
    if (!/^0x[0-9a-fA-F]{130}$/.test(signature) || echoed['purpose'] !== PLAY_GRANT_PURPOSE || echoed['audience'] !== this.config.audience
      || echoed['publicKeyThumbprint'] !== thumbprint || echoed['challenge'] !== challenge || echoed['expiresAt'] !== payload.expiresAt
      || typeof echoed['agent_id'] !== 'string' || typeof echoed['subject_pod_url'] !== 'string') {
      throw new PlayGrantError(502, 'play_grant_mismatch', 'the relay signed something other than what was asked');
    }
    return { playGrant: { _signed_payload: signedPayload, _signature: signature }, audience: this.config.audience, identityUrl: this.config.identityUrl };
  }

  /**
   * What an operator needs to finish or check the setup: who the service is to identity, and
   * whether the relay would sign for it. Nothing here is secret (the agent DID and pod are what
   * identity's PROVISIONAL_PLAY_CLIENTS names in public configuration).
   */
  async status(): Promise<Record<string, unknown>> {
    const base = { enabled: true, audience: this.config.audience, identityUrl: this.config.identityUrl, relayUrl: this.config.relayUrl,
      serviceWallet: this.wallet.address };
    let session: ServiceSession;
    try { session = await this.serviceSession(); }
    catch (error) { return { ...base, ready: false, service: null, problem: (error as Error).message }; }
    // What the relay signs as, read from a signature of its own over a payload that is no grant
    // (identity accepts only PLAY_GRANT_PURPOSE): `agent_id` and `subject_pod_url` are compared by
    // identity to PROVISIONAL_PLAY_CLIENTS exactly, so these are the two values to configure there.
    let signsAs: { agentDid: string; podUrl: string } | null = null;
    try {
      const probe = await this.post(`${this.config.relayUrl}/tool/sign_request`, { purpose: 'foxxi-play-status-probe' }, session.token);
      const echoed = record(JSON.parse(text(probe.body['_signed_payload']) ?? '{}'));
      const agentDid = text(echoed['agent_id']), podUrl = text(echoed['subject_pod_url']);
      if (probe.ok && agentDid && podUrl) signsAs = { agentDid, podUrl };
    } catch { /* reported below as not ready */ }
    const service = { userId: session.userId, agentDid: signsAs?.agentDid ?? session.agentDid, podUrl: signsAs?.podUrl ?? session.podUrl,
      asSignedByRelay: signsAs !== null };
    let verify;
    try { verify = await this.post(`${this.config.relayUrl}/tool/verify_agent`, { agent_id: session.agentDid, pod_url: session.podUrl }); }
    catch (error) { return { ...base, ready: false, service, problem: (error as Error).message }; }
    const signing = record(verify.body['signing']);
    const verified = verify.body['verified'] === true, canSign = signing['canSignDelegatedRequests'] === true;
    return { ...base, ready: verify.ok && verified && canSign && signsAs !== null, service,
      relay: { verified, canSignDelegatedRequests: signing['canSignDelegatedRequests'] ?? null, note: text(signing['note']) ?? null },
      ...(verify.ok && verified && canSign ? {} : { problem: 'the relay does not yet sign for this agent: register it with the relay (DURABLE-GUEST.md)' }) };
  }
}
