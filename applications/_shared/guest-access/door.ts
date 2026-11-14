/**
 * An application backend's side of identity's general guest door
 * (deploy/identity/PROVISIONAL-PLAY.md, "General guest").
 *
 * `start()` prepares one visit: a state, a PKCE verifier kept here, a grant the application's own
 * service agent signs over the state and the verifier's challenge, and the door address to send the
 * browser to (a top-level navigation; the grant rides in the fragment). `finish()` takes what the
 * browser brought back to the registered return path, exchanges the code with identity, and
 * answers the guest only if identity's answer is this application's, well formed, and permitted by
 * the application's policies over the guest's attributes (default-deny).
 *
 * A visit is bound to the browser that started it by `binding`, a random value the caller keeps in
 * an HttpOnly cookie and hands back to `finish()`: a return address carrying someone else's code
 * and state finishes nothing in a browser that did not start that visit.
 *
 * This module reads no environment and names no deployment. The caller supplies identity's origin,
 * its own origin, and how its service agent signs.
 */
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { GUEST_ACTIONS, decide, guestAttributeGraph, guestPolicies, type GuestFacts, type GuestPolicySet } from './guest-access.mjs';

export const GENERAL_GUEST_PURPOSE = 'interego-general-guest-v1';
const VISIT_MS = 10 * 60 * 1000;

export interface DoorGrant { readonly _signed_payload: string; readonly _signature: string }
export type DoorFetch = (url: string, init: { method: 'POST'; headers: Record<string, string>; body: string; redirect: 'error'; signal: AbortSignal }) =>
  Promise<{ ok: boolean; status: number; json(): Promise<unknown> }>;

export interface GeneralGuestDoorOptions {
  /** Identity's origin. */
  readonly identityUrl: string;
  /** This application's origin, as identity's PROVISIONAL_PLAY_CLIENTS names it. */
  readonly audience: string;
  /** Has the application's service agent sign the grant (the relay's sign_request). */
  signGrant(request: { purpose: string; audience: string; state: string; codeChallenge: string; expiresAt: number }): Promise<DoorGrant>;
  /** What a guest must satisfy to be let in. Default: the standard set, a live provisional guest this application admitted may use it. */
  readonly policies?: GuestPolicySet;
  readonly fetch?: DoorFetch;
  readonly now?: () => number;
  /** Most visits in progress at once. Default 1024. */
  readonly maxVisits?: number;
}

/** The guest identity vouched for, and the application token it issued. */
export interface GeneralGuestSession {
  readonly userId: string;
  readonly ownerDid: string;
  readonly webId: string;
  readonly podUrl: string;
  readonly agentDid: string;
  readonly namespace: string;
  /** Unix milliseconds. */
  readonly guestExpiresAt: number;
  readonly attributes: GuestFacts;
  /** Identity's token for this guest in this application. Kept by the backend; never sent to a browser by this module. */
  readonly token: string;
  readonly tokenExpiresAt: string;
}

export class GuestDoorError extends Error {
  constructor(readonly status: number, readonly code: string) { super(code); this.name = 'GuestDoorError'; }
}

const origin = (value: string, name: string): string => {
  let url: URL;
  try { url = new URL(value); } catch { throw new Error(`${name} is not a URL`); }
  const local = url.protocol === 'http:' && ['localhost', '127.0.0.1'].includes(url.hostname);
  if (url.origin !== value || (url.protocol !== 'https:' && !local)) throw new Error(`${name} must be an HTTPS origin with no path`);
  return url.origin;
};
const text = (value: unknown, max: number): value is string => typeof value === 'string' && value.length > 0 && value.length <= max;
const same = (a: string, b: string): boolean => {
  const x = Buffer.from(a), y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
};

export class GeneralGuestDoor {
  readonly identityUrl: string;
  readonly audience: string;
  private readonly visits = new Map<string, { verifier: string; binding: string; expiresAt: number }>();
  private readonly policies: GuestPolicySet;
  private readonly now: () => number;
  private readonly fetch: DoorFetch;
  private readonly maxVisits: number;

  constructor(private readonly options: GeneralGuestDoorOptions) {
    this.identityUrl = origin(options.identityUrl, 'The identity URL');
    this.audience = origin(options.audience, 'The application audience');
    this.policies = options.policies ?? guestPolicies({ application: this.audience, provisionalMay: [GUEST_ACTIONS.useApplication] });
    this.now = options.now ?? Date.now;
    this.fetch = options.fetch ?? ((url, init) => fetch(url, init));
    this.maxVisits = options.maxVisits ?? 1024;
  }

  /**
   * Prepare one visit. `url` is where to send the browser (top-level), `binding` what to keep in an
   * HttpOnly cookie until it returns. Throws GuestDoorError 429 while too many visits are in
   * progress, and 503 when the service agent's grant is not what was asked for.
   */
  async start(): Promise<{ url: string; state: string; binding: string }> {
    const now = this.now();
    for (const [state, visit] of this.visits) if (visit.expiresAt <= now) this.visits.delete(state);
    if (this.visits.size >= this.maxVisits) throw new GuestDoorError(429, 'guest_door_busy');
    const state = randomBytes(32).toString('base64url');
    const verifier = randomBytes(32).toString('base64url');
    const binding = randomBytes(32).toString('base64url');
    const request = { purpose: GENERAL_GUEST_PURPOSE, audience: this.audience, state,
      codeChallenge: createHash('sha256').update(verifier, 'utf8').digest('base64url'), expiresAt: Math.floor(now / 1000) + 90 };
    let grant: DoorGrant;
    try { grant = await this.options.signGrant(request); } catch { throw new GuestDoorError(503, 'guest_door_unavailable'); }
    // What the relay signed is what was asked for, or nothing leaves here.
    let signed: Record<string, unknown> = {};
    try { signed = JSON.parse(grant._signed_payload) as Record<string, unknown>; } catch { /* refused below */ }
    if (!grant || !text(grant._signed_payload, 8192) || typeof grant._signature !== 'string' || !/^0x[0-9a-fA-F]{130}$/.test(grant._signature)
      || !signed || (Object.keys(request) as Array<keyof typeof request>).some(key => signed[key] !== request[key])) {
      throw new GuestDoorError(503, 'guest_door_unavailable');
    }
    this.visits.set(state, { verifier, binding, expiresAt: now + VISIT_MS });
    const fragment = Buffer.from(JSON.stringify({ _signed_payload: grant._signed_payload, _signature: grant._signature })).toString('base64url');
    return { url: `${this.identityUrl}/guest/door#grant=${fragment}`, state, binding };
  }

  /**
   * Finish the visit the browser returned from: `code` and `state` from the return address,
   * `binding` from this browser's cookie. A return presented with the visit's own binding spends
   * the visit, whatever identity then answers; one presented without it, or with another's, is
   * refused and spends nothing, so a stranger holding a return address cannot end the visit of the
   * browser that started it. Throws
   * GuestDoorError: 401 for a return this browser did not start or identity does not confirm, 403
   * when the application's policies do not permit the guest, 503 when identity cannot be asked.
   */
  async finish(returned: { code: unknown; state: unknown; binding: unknown }): Promise<GeneralGuestSession> {
    const { code, state, binding } = returned;
    if (!text(state, 256) || !text(code, 2048) || !text(binding, 256)) throw new GuestDoorError(401, 'guest_door_return_invalid');
    const visit = this.visits.get(state);
    if (!visit || visit.expiresAt <= this.now() || !same(visit.binding, binding)) throw new GuestDoorError(401, 'guest_door_return_invalid');
    this.visits.delete(state);
    let response: { ok: boolean; status: number; json(): Promise<unknown> };
    let body: Record<string, unknown>;
    try {
      response = await this.fetch(`${this.identityUrl}/guest/exchange`, { method: 'POST', redirect: 'error', signal: AbortSignal.timeout(15_000),
        headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify({ code, codeVerifier: visit.verifier, audience: this.audience, state }) });
      const parsed = await response.json().catch(() => ({}));
      body = parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed as Record<string, unknown> : {};
    } catch { throw new GuestDoorError(503, 'guest_door_unavailable'); }
    if (response.status >= 500) throw new GuestDoorError(503, 'guest_door_unavailable');
    const facts = body['guestAttributes'] as GuestFacts | undefined;
    const expires = Date.parse(String(body['guestExpiresAt'] ?? ''));
    if (!response.ok || body['valid'] !== true || body['provisional'] !== true || body['general'] !== true
      || body['issuer'] !== this.identityUrl || body['audience'] !== this.audience
      || !text(body['userId'], 64) || !/^u-try-guest-[a-f0-9]{32}$/.test(body['userId'])
      || !text(body['ownerDid'], 2048) || !body['ownerDid'].endsWith(`:users:${body['userId']}`)
      || !text(body['webId'], 2048) || !text(body['podUrl'], 2048) || !text(body['authenticatedAgentDid'], 2048)
      || !text(body['namespace'], 32) || !text(body['token'], 4096) || !text(body['tokenExpiresAt'], 64)
      || !Number.isFinite(expires) || expires <= this.now()
      || !facts || typeof facts !== 'object' || facts.subject !== body['ownerDid'] || facts.expiresAt * 1000 !== expires) {
      throw new GuestDoorError(401, 'guest_door_exchange_refused');
    }
    // The application's own decision over what identity stated, default-deny. A malformed answer builds no graph.
    let allowed = false;
    try { allowed = decide(GUEST_ACTIONS.useApplication, this.policies, guestAttributeGraph(facts, this.now())).allowed; } catch { allowed = false; }
    if (!allowed) throw new GuestDoorError(403, 'guest_access_denied');
    return { userId: body['userId'], ownerDid: body['ownerDid'], webId: body['webId'], podUrl: body['podUrl'],
      agentDid: body['authenticatedAgentDid'], namespace: body['namespace'], guestExpiresAt: expires, attributes: facts,
      token: body['token'], tokenExpiresAt: body['tokenExpiresAt'] };
  }
}
