/**
 * The DASHBOARD's use of identity's GENERAL guest door: one guest per browser across Interego
 * applications (deploy/identity/PROVISIONAL-PLAY.md, "General guest"), offered beside "Start as a
 * guest" (DURABLE-GUEST.md, "The general guest").
 *
 * ★ WHAT THIS IS, AND WHAT IT DELIBERATELY IS NOT. A dashboard guest is a secp256k1 key its tab
 * makes, and the bridge reads "who is calling" from that key's signature in several independent
 * places (resolveCaller, verifyDelegatedCaller, bindSignedCaller and inline recoveries in
 * bridge/server.ts), most of which go on to derive a pod, an owner and a public-or-private regime
 * from the WALLET ADDRESS. None of that changes here. A general guest on the dashboard is still a
 * tab key, and every request it signs is authenticated and authorized as that key and nothing
 * else: same role, same pods, same limits as any tab guest, linked to an account or not.
 *
 * What this adds is a STATEMENT the bridge keeps beside the caller model, never inside it:
 * "tab key K was admitted through identity's door as guest G, which identity said acts for
 * subject S, until T". S is `canonicalSubject` of what identity stated at the exchange (the
 * account a guest is linked to, else the guest itself) and T is `guestSessionStanding`'s bound.
 * Nothing in the bridge's authorization reads the statement. It says whom to ATTRIBUTE the key's
 * activity to; it grants the key nothing an account or even the guest's own earlier key had.
 *
 * ★ HOW A VISIT IS BOUND TO THE BROWSER THAT STARTED IT, WITH NO COOKIE. The dashboard is a static
 * site on another origin than the bridge, so the HttpOnly cookie the other adopters use would be a
 * cross-site one. Instead:
 *
 *   1. start: the dashboard's page asks (a POST answered only for the dashboard's `Origin`). The
 *      answer carries the door address and the door's `binding`, a random value the page keeps in
 *      its tab's sessionStorage. The bridge's CORS lets only the dashboard's origins read it.
 *   2. The browser goes to the door and comes back to the DASHBOARD's registered return path with
 *      `?code=…&state=…`. The page removes them from the address before it does anything else.
 *      The code is not a bearer: it is exchanged only with the PKCE verifier, which never leaves
 *      this process, and it is spent after one use or sixty seconds.
 *   3. finish: the page makes its tab key K (in memory, as every tab guest's is) and sends
 *      `{code, state, binding}` in a request K signs. The bridge finishes the visit only with the
 *      binding it issued for that state, exchanges the code itself, and keeps the statement for K.
 *
 * So a stranger who obtains a return address gains nothing (no binding, no verifier), and a
 * return address planted in another browser finishes nothing there (that tab holds no binding
 * for its state): neither login CSRF nor fixation has anything to carry.
 *
 * This module reads no environment beyond `dashboardGeneralGuestSettings` and names no deployment.
 */
import type { Express, Request, Response } from 'express';
import { GeneralGuestDoor, type DoorFetch, type DoorGrant, type GeneralGuestSession } from '../../_shared/guest-access/door.js';
import { guestSessionStanding } from '../../_shared/guest-access/session.js';
import { recoverSignedRequest, type RecoveredSignedRequest } from './auth.js';
import type { PlayGrantConfig } from './play-grant.js';
import { routeJson } from './route-json.js';

/** The path on the DASHBOARD's origin identity returns a browser to (its `generalGuestReturnPath`). */
export const DASHBOARD_GENERAL_GUEST_RETURN_PATH = '/guest/general/return';
const PREFIX = '/play/general';
export const DASHBOARD_GENERAL_GUEST_PATHS = Object.freeze({
  start: PREFIX + '/start', finish: PREFIX + '/finish', standing: PREFIX + '/standing', signOut: PREFIX + '/sign-out',
});
/** What a tab key signs with each request here, so a signature made for one is no use at another. */
export const DASHBOARD_GENERAL_GUEST_PURPOSES = Object.freeze({
  finish: 'foxxi-dashboard-general-guest-finish-v1',
  standing: 'foxxi-dashboard-general-guest-standing-v1',
  signOut: 'foxxi-dashboard-general-guest-sign-out-v1',
});
/** The ceiling of a statement: a tab guest's own session lasts eight hours (dashboard-app/src/auth/session.ts). */
export const DASHBOARD_GUEST_SESSION_MS = 8 * 60 * 60 * 1000;

export interface DashboardGeneralGuestSettings {
  /** The dashboard's origin, as identity's PROVISIONAL_PLAY_CLIENTS names it. */
  readonly audience: string;
  readonly identityUrl: string;
  /** Where identity serves the door page, when that is a dedicated origin. */
  readonly doorOrigin?: string;
}

/**
 * The settings, or null where the dashboard's general guest is off. Off unless
 * FOXXI_PLAY_GENERAL_GUEST is exactly `1`. It is the same application to identity as the guest the
 * browser keeps: the dashboard's origin (FOXXI_PLAY_AUDIENCE), the same service account
 * (FOXXI_PLAY_SERVICE_PRIVATE_KEY), the same entry in PROVISIONAL_PLAY_CLIENTS. `1` without those
 * stops the bridge at start instead of leaving a door nobody can sign for.
 */
export function dashboardGeneralGuestSettings(env: Readonly<Record<string, string | undefined>>, play: PlayGrantConfig | null): DashboardGeneralGuestSettings | null {
  if (env['FOXXI_PLAY_GENERAL_GUEST'] !== '1') return null;
  if (!play) throw new Error('FOXXI_PLAY_GENERAL_GUEST=1 needs FOXXI_PLAY_SERVICE_PRIVATE_KEY and FOXXI_PLAY_AUDIENCE: the general guest door is signed for by the dashboard\'s own service agent');
  const stated = env['FOXXI_PLAY_GENERAL_GUEST_DOOR_ORIGIN']?.trim();
  if (!stated) return { audience: play.audience, identityUrl: play.identityUrl };
  let door: URL;
  try { door = new URL(stated); } catch { throw new Error('FOXXI_PLAY_GENERAL_GUEST_DOOR_ORIGIN is not a URL'); }
  if (door.origin !== stated || door.protocol !== 'https:') throw new Error('FOXXI_PLAY_GENERAL_GUEST_DOOR_ORIGIN must be an HTTPS origin, with no path');
  // The door's own origin holds every general guest's key; the dashboard must never be it.
  if (door.origin === play.audience) throw new Error('FOXXI_PLAY_GENERAL_GUEST_DOOR_ORIGIN must not be the dashboard\'s own origin');
  return { audience: play.audience, identityUrl: play.identityUrl, doorOrigin: door.origin };
}

/** The door for those settings, signed for by `signGrant` (`PlayGrantService.generalGuestGrant`). */
export function dashboardGeneralGuestDoor(settings: DashboardGeneralGuestSettings,
  signGrant: (request: { purpose: string; audience: string; state: string; codeChallenge: string; expiresAt: number }) => Promise<DoorGrant>,
  deps: { fetch?: DoorFetch; now?: () => number } = {}): GeneralGuestDoor {
  return new GeneralGuestDoor({
    identityUrl: settings.identityUrl, audience: settings.audience,
    ...(settings.doorOrigin ? { doorOrigin: settings.doorOrigin } : {}),
    signGrant, maxVisits: 200,
    ...(deps.fetch ? { fetch: deps.fetch } : {}), ...(deps.now ? { now: deps.now } : {}),
  });
}

/** `GeneralGuestDoor`, or a stand-in with its shape. */
export interface DashboardGuestDoor {
  readonly audience: string;
  readonly identityUrl: string;
  start(): Promise<{ url: string; state: string; binding: string }>;
  finish(returned: { code: unknown; state: unknown; binding: unknown }): Promise<GeneralGuestSession>;
}

/** What the bridge holds about one tab key that came through the door. Not an authority. */
export interface DashboardGuestStanding {
  /** The guest that arrived: identity's own DID for it. */
  readonly guestDid: string;
  /** Whom to attribute the key's activity to: the linked account's DID, else the guest's own. */
  readonly subject: string;
  readonly linked: boolean;
  /** Unix milliseconds: after this the statement is gone and the key is a tab guest's alone. */
  readonly expiresAt: number;
}

export class DashboardGuestError extends Error {
  constructor(readonly status: number, readonly code: string) { super(code); this.name = 'DashboardGuestError'; }
}
function refuse(status: number, code: string): never { throw new DashboardGuestError(status, code); }
const record = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);
/** A request body as the browser sent it: the bridge's own two additions carry no authority here. */
const asked = (body: unknown): Record<string, unknown> | null => {
  if (!record(body)) return null;
  const { __client_ip: _ip, __caller_token: _token, ...rest } = body;
  return rest;
};

export interface DashboardGeneralGuestOptions {
  readonly door: DashboardGuestDoor;
  readonly now?: () => number;
  /** Most statements kept at once. Default 1000. */
  readonly maxBindings?: number;
  /** Reads a signed request (src/auth.ts). Tests may pass their own clock through it. */
  readonly recover?: (body: unknown) => RecoveredSignedRequest;
}

export class DashboardGeneralGuest {
  readonly audience: string;
  private readonly door: DashboardGuestDoor;
  private readonly now: () => number;
  private readonly maxBindings: number;
  private readonly recover: (body: unknown) => RecoveredSignedRequest;
  /** Keyed by the tab key's lowercased address. In memory only: a restart forgets every one. */
  private readonly bindings = new Map<string, DashboardGuestStanding>();
  private readonly rates = new Map<string, { at: number; count: number }>();

  constructor(options: DashboardGeneralGuestOptions) {
    this.door = options.door; this.audience = options.door.audience;
    this.now = options.now ?? Date.now;
    this.maxBindings = options.maxBindings ?? 1000;
    if (!Number.isSafeInteger(this.maxBindings) || this.maxBindings < 1 || this.maxBindings > 10_000) throw new Error('Invalid general guest capacity');
    this.recover = options.recover ?? recoverSignedRequest;
  }

  /** How many statements are held now, after those past their bound are dropped. */
  get size(): number { this.sweep(); return this.bindings.size; }

  private sweep(): void {
    const now = this.now();
    for (const [key, standing] of this.bindings) if (standing.expiresAt <= now) this.bindings.delete(key);
    for (const [key, rate] of this.rates) if (rate.at + 60_000 <= now) this.rates.delete(key);
  }
  private admit(key: string, limit: number): void {
    const now = this.now(), rate = this.rates.get(key);
    if (rate && rate.at + 60_000 > now) { if (rate.count >= limit) refuse(429, 'general_guest_busy'); rate.count += 1; return; }
    if (!rate && this.rates.size >= 4000) refuse(429, 'general_guest_busy');
    this.rates.set(key, { at: now, count: 1 });
  }
  private fromDashboard(req: Request): void {
    // A browser sets Origin itself, so another site's page gets no answer. It is no defence against
    // a client that is not a browser; nothing here relies on it for more than that.
    if (req.get('Origin') !== this.audience || Object.keys(req.query).length) refuse(403, 'general_guest_origin');
  }
  /**
   * The tab key that signed this request, for exactly `purpose`. Only a key signing as itself: not
   * a session key standing for a wallet, and not a relay signing for an agent.
   */
  private signedBy(req: Request, purpose: string, fields: readonly string[]): { address: string; payload: Record<string, unknown> } {
    const body = asked(req.body);
    if (!body || Object.keys(body).some(key => key !== '_signed_payload' && key !== '_signature')) refuse(400, 'general_guest_input_invalid');
    const rec = this.recover(body);
    if (!rec.ok) return refuse(401, 'general_guest_signature_required');
    if (rec.sessionKey !== undefined || rec.agentId.toLowerCase() !== `did:ethr:${rec.signer.toLowerCase()}`) refuse(401, 'general_guest_signature_required');
    const payload = rec.payload, expected = ['agent_id', 'timestamp', 'purpose', ...fields];
    if (payload['purpose'] !== purpose || Object.keys(payload).length !== expected.length || expected.some(key => typeof payload[key] !== 'string')) refuse(400, 'general_guest_input_invalid');
    return { address: rec.signer.toLowerCase(), payload };
  }

  /**
   * Whom this wallet address is attributed to now, or null: it never came through the door, signed
   * out, or its statement has reached its bound. The bridge's only reading of the table. It is an
   * attribution, and no caller may treat it as an identity the address authenticated as.
   */
  standingOf(address: string): DashboardGuestStanding | null {
    const key = address.toLowerCase(), standing = this.bindings.get(key);
    if (!standing) return null;
    if (standing.expiresAt <= this.now()) { this.bindings.delete(key); return null; }
    return standing;
  }

  /** Step 1: a door visit for the dashboard's page. Each one has the service agent sign a grant, so it is limited. */
  async start(req: Request): Promise<Record<string, unknown>> {
    this.fromDashboard(req); this.sweep();
    const body = asked(req.body);
    if (!body || Object.keys(body).length) refuse(400, 'general_guest_input_invalid');
    const supplied = record(req.body) ? req.body['__client_ip'] : undefined;
    const caller = typeof supplied === 'string' && supplied.length <= 64 && /^[0-9A-Fa-f:.]+$/.test(supplied) ? supplied : req.ip ?? 'unknown';
    this.admit('start:' + caller, 5); this.admit('starts', 30);
    let visit: { url: string; state: string; binding: string };
    try { visit = await this.door.start(); }
    catch (error) { const busy = (error as { status?: unknown } | null)?.status === 429; return refuse(busy ? 429 : 503, busy ? 'general_guest_busy' : 'general_guest_unavailable'); }
    if (typeof visit.url !== 'string' || typeof visit.state !== 'string' || !/^[A-Za-z0-9_-]{20,128}$/.test(visit.state)
      || typeof visit.binding !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(visit.binding)) refuse(503, 'general_guest_unavailable');
    return { doorUrl: visit.url, state: visit.state, binding: visit.binding, returnPath: DASHBOARD_GENERAL_GUEST_RETURN_PATH };
  }

  /**
   * Step 3: the tab is back from the door and has made its key. The visit is finished only with the
   * binding issued for its state; a request without it is refused and spends nothing, so the visit
   * stays as it was for the tab that started it.
   */
  async finish(req: Request): Promise<Record<string, unknown>> {
    this.fromDashboard(req); this.sweep(); this.admit('finishes', 100);
    const { address, payload } = this.signedBy(req, DASHBOARD_GENERAL_GUEST_PURPOSES.finish, ['code', 'state', 'binding']);
    const { code, state, binding } = payload as { code: string; state: string; binding: string };
    if (!/^[\x21-\x7e]{1,2048}$/.test(code) || !/^[A-Za-z0-9_-]{20,128}$/.test(state) || !/^[A-Za-z0-9_-]{43}$/.test(binding)) refuse(400, 'general_guest_input_invalid');
    // Room is checked before the code is spent: a full table costs the visitor nothing but a retry.
    if (this.bindings.size >= this.maxBindings && !this.bindings.has(address)) refuse(429, 'general_guest_busy');
    let guest: GeneralGuestSession;
    try { guest = await this.door.finish({ code, state, binding }); }
    catch (error) {
      const status = (error as { status?: unknown } | null)?.status;
      if (status === 403) return refuse(403, 'general_guest_refused');
      return refuse(status === 401 ? 401 : 503, status === 401 ? 'general_guest_return_invalid' : 'general_guest_unavailable');
    }
    // Every canonical field is checked again against this deployment's own identity, as the
    // workbench does: a guest of this identity, and a linked subject that is one of its accounts.
    const host = new URL(this.door.identityUrl).host.replace(/:/g, '%3A'), users = `did:web:${host}:users:`;
    const id = guest.userId;
    if (typeof id !== 'string' || !/^u-try-guest-[0-9a-f]{32}$/.test(id) || guest.ownerDid !== users + id) refuse(401, 'general_guest_return_invalid');
    let standing: ReturnType<typeof guestSessionStanding>;
    try { standing = guestSessionStanding(guest, this.now(), DASHBOARD_GUEST_SESSION_MS); } catch { return refuse(401, 'general_guest_return_invalid'); }
    const subjectId = standing.subject.startsWith(users) ? standing.subject.slice(users.length) : '';
    if (standing.guestDid !== guest.ownerDid || (standing.linked
      ? (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,255}$/.test(subjectId) || subjectId === id)
      : standing.subject !== guest.ownerDid)) refuse(401, 'general_guest_return_invalid');
    if (this.bindings.size >= this.maxBindings && !this.bindings.has(address)) refuse(429, 'general_guest_busy');
    // Identity's token for the guest is not kept: nothing here would present it anywhere.
    const kept: DashboardGuestStanding = { guestDid: standing.guestDid, subject: standing.subject, linked: standing.linked, expiresAt: standing.expiresAt };
    this.bindings.set(address, kept);
    return { generalGuest: publicStanding(kept) };
  }

  /** Whom the bridge attributes this tab key to now. Signed by the key, so only its holder can ask. */
  standing(req: Request): Record<string, unknown> {
    this.fromDashboard(req); this.admit('standings', 600);
    const { address } = this.signedBy(req, DASHBOARD_GENERAL_GUEST_PURPOSES.standing, []);
    const standing = this.standingOf(address);
    return standing ? { generalGuest: publicStanding(standing) } : { generalGuest: null };
  }

  /** Sign-out: the statement for this tab key is dropped at once. The key is then a tab guest's alone. */
  signOut(req: Request): Record<string, unknown> {
    this.fromDashboard(req); this.admit('sign-outs', 600);
    const { address } = this.signedBy(req, DASHBOARD_GENERAL_GUEST_PURPOSES.signOut, []);
    this.bindings.delete(address);
    return { signed_out: true };
  }

  dispose(): void { this.bindings.clear(); this.rates.clear(); }
}

const publicStanding = (standing: DashboardGuestStanding): Record<string, unknown> =>
  ({ guestDid: standing.guestDid, subject: standing.subject, linked: standing.linked, expiresAt: new Date(standing.expiresAt).toISOString() });

/** What `GET /play/guest` and `/play/status` add while this is on, so the sign-in page asks for nothing it would be refused. */
export function dashboardGeneralGuestOffer(settings: DashboardGeneralGuestSettings): Record<string, unknown> {
  return { enabled: true, ...DASHBOARD_GENERAL_GUEST_PATHS, returnPath: DASHBOARD_GENERAL_GUEST_RETURN_PATH, doorOrigin: settings.doorOrigin ?? settings.identityUrl };
}

/** The four routes. Called only where the general guest is configured, so with it off these paths are any path this bridge never had. */
export function attachDashboardGeneralGuestRoutes(app: Express, guests: DashboardGeneralGuest): void {
  const body = routeJson({ limit: '16kb', strict: true });
  const route = (work: (req: Request) => Promise<Record<string, unknown>> | Record<string, unknown>) => (req: Request, res: Response) => {
    res.set('Cache-Control', 'no-store').set('Referrer-Policy', 'no-referrer').set('X-Content-Type-Options', 'nosniff');
    void (async () => work(req))().then(answer => { res.json(answer); }, error => {
      res.status(error instanceof DashboardGuestError ? error.status : 503).json({ error: error instanceof DashboardGuestError ? error.code : 'general_guest_unavailable' });
    });
  };
  app.post(DASHBOARD_GENERAL_GUEST_PATHS.start, body, route(req => guests.start(req)));
  app.post(DASHBOARD_GENERAL_GUEST_PATHS.finish, body, route(req => guests.finish(req)));
  app.post(DASHBOARD_GENERAL_GUEST_PATHS.standing, body, route(req => guests.standing(req)));
  app.post(DASHBOARD_GENERAL_GUEST_PATHS.signOut, body, route(req => guests.signOut(req)));
}
