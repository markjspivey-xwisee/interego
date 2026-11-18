/**
 * The DASHBOARD's general guest: identity's door (deploy/identity/PROVISIONAL-PLAY.md, "General
 * guest"), a binding of the visit to one browser tab, and a caller that is the GUEST.
 *
 * Off unless FOXXI_PLAY_GENERAL_GUEST is exactly `1`. With it unset nothing here is built or
 * attached, and the paths below are paths this bridge never had.
 *
 * ── The door round trip, with no cookie ─────────────────────────────────────────────────────
 * The dashboard is a static site on another origin than the bridge, so the HttpOnly cookie the
 * learner workbench binds a visit with (src/i2idlx-learning-auth.ts) would be a cross-site one.
 *
 *   1. start: the dashboard's page asks (answered only for the dashboard's `Origin`). The answer
 *      carries the door address and the door's `binding`, a random value the page keeps in its
 *      tab's sessionStorage.
 *   2. The browser goes to the door and comes back to the DASHBOARD's registered return path with
 *      `?code=…&state=…`. The code is not a bearer: it is exchanged only with the PKCE verifier,
 *      which never leaves this process.
 *   3. finish: the page makes a key K for its tab and sends `{code, state, binding}` in a request
 *      K signs. The bridge finishes the visit only with the binding it issued for that state,
 *      exchanges the code itself, checks identity's answer again against this deployment, and
 *      admits K as that guest. The page may also send `record_key`: an X25519 public key it made
 *      for the tab (its secret stays in the tab). The guest's record is sealed for it as well as
 *      for the bridge, so the tab can open its own record from its own pod
 *      (src/guest-learning-record.ts, "Who can decrypt").
 *
 * A stranger holding a return address has no binding and no verifier; a return address planted in
 * another browser finishes nothing there.
 *
 * ── Who the caller is ───────────────────────────────────────────────────────────────────────
 * After step 3 a request K signs at the one guest route is the GUEST's: its principal's subject
 * is the guest's DID and its records are on the guest's own pod (`generalGuestPrincipal`,
 * src/caller-principal.ts). K itself is nobody: it shows only that this is the tab that finished
 * the visit. K is refused on every signed `/agent/*` route while it is admitted here.
 *
 * ── What a guest can do ─────────────────────────────────────────────────────────────────────
 * Exactly the operations in src/guest-operations.ts, by name, at `POST /play/general/act`.
 * Everything else is refused there, and a request that claims another identity, an authority or a
 * pod is refused as a delegation claim.
 *
 * ── Who is NOT let in yet ───────────────────────────────────────────────────────────────────
 * A guest identity states is LINKED to a registered account (`subjectAttributes.linkedTo`), or
 * acting on another's behalf (`onBehalfOf`). Both are refused at finish, whatever else is true of
 * them. A plain, unlinked guest is the only caller this module makes.
 *
 * Identity's token for the guest is not kept: the bridge writes the guest's pod with the gate's
 * operator bearer (src/guest-learning-record.ts) and presents the guest's token nowhere.
 */
import type { Express, Request, RequestHandler, Response } from 'express';
import { rateLimit } from 'express-rate-limit';
import { GeneralGuestDoor, type DoorFetch, type DoorGrant, type GeneralGuestSession } from '../../_shared/guest-access/door.js';
import { guestSessionStanding } from '../../_shared/guest-access/session.js';
import { recoverSignedRequest, type RecoveredSignedRequest } from './auth.js';
import { generalGuestPrincipal, type GeneralGuestAdmission, type GuestCallerPrincipal } from './caller-principal.js';
import { GuestPodError, isTabRecordKey } from './guest-learning-record.js';
import { GUEST_OPERATION_PURPOSE, decideGuestOperation, type GuestOperation } from './guest-operations.js';
import type { PlayGrantConfig } from './play-grant.js';
import { routeJson } from './route-json.js';

/** The path on the DASHBOARD's origin identity returns a browser to (its `generalGuestReturnPath`). */
export const DASHBOARD_GENERAL_GUEST_RETURN_PATH = '/guest/general/return';
const PREFIX = '/play/general';
export const DASHBOARD_GENERAL_GUEST_PATHS = Object.freeze({ offer: PREFIX, start: PREFIX + '/start', finish: PREFIX + '/finish', act: PREFIX + '/act' });
/** What a tab key signs to finish a visit, so a signature made for one route is no use at another. */
export const DASHBOARD_GENERAL_GUEST_FINISH_PURPOSE = 'foxxi-dashboard-general-guest-finish-v1';
/**
 * The ceiling of a guest session here. Identity cannot be asked again about a general guest (its
 * token is checked only for a holder of the introspection secret), so the session is bounded when
 * it is made, as the learner workbench's is: one hour, or the guest's own deadline if sooner.
 */
export const DASHBOARD_GUEST_SESSION_MS = 60 * 60 * 1000;
/** Tab keys one guest may hold at once (one per open tab). A further tab ends the oldest. */
export const DASHBOARD_GUEST_KEYS_PER_GUEST = 4;
/** Per guest, per minute. */
export const DASHBOARD_GUEST_LIMITS = Object.freeze({ operations: 120, writes: 30, finishes: 6 });

export interface DashboardGeneralGuestSettings {
  /** The dashboard's origin, as identity's PROVISIONAL_PLAY_CLIENTS names it. */
  readonly audience: string;
  readonly identityUrl: string;
  /** Where identity serves the door page, when that is a dedicated origin. */
  readonly doorOrigin?: string;
}

/** Is the dashboard's general guest switched on? Exactly `1`, as the workbench's switch is read. */
export function dashboardGeneralGuestOn(env: Readonly<Record<string, string | undefined>>): boolean {
  return env['FOXXI_PLAY_GENERAL_GUEST'] === '1';
}

/**
 * The identity host a general guest's DID is written under, or undefined where the dashboard's
 * general guest is off. This is what the bridge's pod resolver is given for guest DIDs
 * (`resolveSubjectPodUrlGuarded`), so with the switch off the resolver answers as it always has.
 */
export function dashboardGuestIdentityHost(env: Readonly<Record<string, string | undefined>>): string | undefined {
  if (!dashboardGeneralGuestOn(env)) return undefined;
  try { return new URL(env['INTEREGO_IDENTITY_URL'] ?? 'https://identity.interego.xwisee.com').host.toLowerCase(); } catch { return undefined; }
}

/**
 * The settings, or null where the dashboard's general guest is off. It is the same application to
 * identity as the guest the browser keeps: the dashboard's origin (FOXXI_PLAY_AUDIENCE), the same
 * service account (FOXXI_PLAY_SERVICE_PRIVATE_KEY), the same entry in PROVISIONAL_PLAY_CLIENTS.
 * `1` without those stops the bridge at start instead of leaving a door nobody can sign for.
 */
export function dashboardGeneralGuestSettings(env: Readonly<Record<string, string | undefined>>, play: PlayGrantConfig | null): DashboardGeneralGuestSettings | null {
  if (!dashboardGeneralGuestOn(env)) return null;
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

export class DashboardGuestError extends Error {
  constructor(readonly status: number, readonly code: string, readonly detail?: Record<string, unknown>) { super(code); this.name = 'DashboardGuestError'; }
}
function refuse(status: number, code: string): never { throw new DashboardGuestError(status, code); }
const record = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);
/** A request body as the browser sent it: the bridge's own two additions carry no authority here. */
const asked = (body: unknown): Record<string, unknown> | null => {
  if (!record(body)) return null;
  const { __client_ip: _ip, __caller_token: _token, ...rest } = body;
  return rest;
};

/**
 * What a guest operation does, for a verified guest. Everything here is given the PRINCIPAL, and
 * takes whose record it is and which pod it touches from `principal.guest` alone.
 */
export type DashboardGuestHandler = (principal: GuestCallerPrincipal, args: Record<string, unknown>) => Promise<Record<string, unknown>>;
/** The operations this module does not answer itself. Every name in the allow-list has a handler, or this does not compile. */
export type DashboardGuestPorts = Record<Exclude<GuestOperation, 'guest.standing' | 'guest.sign_out'>, DashboardGuestHandler>;

export interface DashboardGeneralGuestOptions {
  readonly door: DashboardGuestDoor;
  readonly ports: DashboardGuestPorts;
  /**
   * The guest's own pod, from the bridge's one pod resolver (which is given the identity host for
   * a guest DID and refuses a guest that would land on the tenant pod). May throw.
   */
  readonly podFor: (guestDid: string) => string;
  readonly now?: () => number;
  /** Most admitted tab keys at once. Default 1000. */
  readonly maxBindings?: number;
  /** Reads a signed request (src/auth.ts). */
  readonly recover?: (body: unknown) => RecoveredSignedRequest;
  /**
   * Are two origins this deployment's own store under two spellings (its public address and its
   * address inside the cluster)? Used only to read identity's stated pod (`statedPodIsOwn`).
   * Absent, only the one origin is the store.
   */
  readonly sameStore?: (a: string, b: string) => boolean;
  /**
   * The guest's sealed record, for the answers that tell a tab where it is and who sealed it.
   * Absent, those answers say nothing of it.
   */
  readonly record?: { addressOf(owner: GeneralGuestAdmission): string; sealedBy(owner: GeneralGuestAdmission): string };
}

/**
 * Does the pod identity STATED for a guest name the pod the bridge DERIVED for it?
 *
 * The derived pod is the only one ever used: `<tenant pod origin>/<guest id>/`, from the bridge's
 * own resolver. Identity's statement is a cross-check, and identity writes it from its own
 * configuration (`new URL('<id>/', CSS_PUBLIC_URL).href`). Comparing the two as strings made the
 * check depend on both services spelling one store identically. So they are compared as URLs:
 *
 *   - the path must be exactly `/<guest id>/`: one segment, the guest's own, with its slash;
 *   - no credentials, query or fragment;
 *   - the origin must be the derived pod's (a default port or the host's case are not a
 *     difference), or, where `sameStore` says so, another spelling of this deployment's own store.
 *
 * Nothing here widens where a guest's records go. A stated pod on any other origin, on the tenant
 * pod, on another guest's pod or deeper than the pod root is refused, as before.
 */
export function statedPodIsOwn(stated: unknown, derived: string, userId: string, sameStore?: (a: string, b: string) => boolean): boolean {
  if (typeof stated !== 'string' || stated.length > 2048 || !/^u-try-guest-[0-9a-f]{32}$/.test(userId)) return false;
  let s: URL, d: URL;
  try { s = new URL(stated); d = new URL(derived); } catch { return false; }
  if (d.pathname !== `/${userId}/` || s.pathname !== `/${userId}/`) return false;
  if ((s.protocol !== 'https:' && s.protocol !== 'http:') || s.username || s.password || s.search || s.hash) return false;
  // The path AS WRITTEN is the pod root too: a dot segment, an empty segment or an escape that a
  // URL parser would fold into `/<id>/` is not the pod root as stated.
  const scheme = stated.indexOf('://'), path = scheme < 0 ? -1 : stated.indexOf('/', scheme + 3);
  if (path < 0 || stated.slice(path) !== `/${userId}/`) return false;
  if (s.origin === d.origin) return true;
  try { return sameStore?.(s.origin + '/', d.origin + '/') === true; } catch { return false; }
}

export class DashboardGeneralGuest {
  readonly audience: string;
  private readonly door: DashboardGuestDoor;
  private readonly ports: DashboardGuestPorts;
  private readonly podFor: (guestDid: string) => string;
  private readonly now: () => number;
  private readonly maxBindings: number;
  private readonly recover: (body: unknown) => RecoveredSignedRequest;
  private readonly sameStore?: (a: string, b: string) => boolean;
  private readonly record?: DashboardGeneralGuestOptions['record'];
  /** Keyed by the tab key's lowercased address. In memory only: a restart forgets every one. */
  private readonly bindings = new Map<string, GeneralGuestAdmission>();
  /** Guests the gate said are closed or expired, until their own deadline: not admitted again here. */
  private readonly goneGuests = new Map<string, number>();
  private readonly rates = new Map<string, { at: number; count: number }>();

  constructor(options: DashboardGeneralGuestOptions) {
    this.door = options.door; this.audience = options.door.audience;
    this.ports = options.ports; this.podFor = options.podFor;
    this.now = options.now ?? Date.now;
    this.maxBindings = options.maxBindings ?? 1000;
    if (!Number.isSafeInteger(this.maxBindings) || this.maxBindings < 1 || this.maxBindings > 10_000) throw new Error('Invalid general guest capacity');
    this.recover = options.recover ?? recoverSignedRequest;
    if (options.sameStore) this.sameStore = options.sameStore;
    if (options.record) this.record = options.record;
  }

  /**
   * The record keys (X25519 public keys) of the tabs admitted as this guest now, oldest first:
   * who, beside the bridge, the guest's record is sealed for at its next write.
   */
  recordKeysOf(userId: string): string[] {
    const now = this.now(), keys: string[] = [];
    for (const admission of this.bindings.values()) if (admission.userId === userId && admission.expiresAt > now && admission.recordKey) keys.push(admission.recordKey);
    return [...new Set(keys)];
  }

  /** What an answer says of the guest's record: where it is, who sealed it, and whether this tab is sealed for. */
  private standing(admission: GeneralGuestAdmission): Record<string, unknown> {
    const standing = publicStanding(admission);
    if (!this.record) return standing;
    try { return { ...standing, record: { url: this.record.addressOf(admission), sealed: true, sealedBy: this.record.sealedBy(admission), forThisTab: admission.recordKey !== undefined } }; }
    catch { return standing; }
  }

  /** How many tab keys are admitted now, after those past their bound are dropped. */
  get size(): number { this.sweep(); return this.bindings.size; }

  private sweep(): void {
    const now = this.now();
    for (const [key, admission] of this.bindings) if (admission.expiresAt <= now) this.bindings.delete(key);
    for (const [id, until] of this.goneGuests) if (until <= now) this.goneGuests.delete(id);
    for (const [key, rate] of this.rates) if (rate.at + 60_000 <= now) this.rates.delete(key);
  }
  private admit(key: string, limit: number): void {
    const now = this.now(), rate = this.rates.get(key);
    if (rate && rate.at + 60_000 > now) { if (rate.count >= limit) refuse(429, 'general_guest_busy'); rate.count += 1; return; }
    if (!rate && this.rates.size >= 8000) refuse(429, 'general_guest_busy');
    this.rates.set(key, { at: now, count: 1 });
  }
  private fromDashboard(req: Request): void {
    // A browser sets Origin itself, so another site's page gets no answer. It is no defence against
    // a client that is not a browser; nothing here relies on it for more than that.
    if (req.get('Origin') !== this.audience || Object.keys(req.query).length) refuse(403, 'general_guest_origin');
  }
  /**
   * The tab key that signed this request, for exactly `purpose`. Only a key signing as itself:
   * not a session key standing for a wallet, and not a relay signing for an agent.
   */
  private signedBy(req: Request, purpose: string): { address: string; payload: Record<string, unknown> } {
    const body = asked(req.body);
    if (!body || Object.keys(body).some(key => key !== '_signed_payload' && key !== '_signature')) refuse(400, 'general_guest_input_invalid');
    const rec = this.recover(body);
    if (!rec.ok) return refuse(401, 'general_guest_signature_required');
    if (rec.sessionKey !== undefined || rec.agentId.toLowerCase() !== `did:ethr:${rec.signer.toLowerCase()}`) refuse(401, 'general_guest_signature_required');
    if (rec.payload['purpose'] !== purpose) refuse(400, 'general_guest_input_invalid');
    return { address: rec.signer.toLowerCase(), payload: rec.payload };
  }

  /** Is this address a tab key admitted as a general guest now? The signed `/agent/*` routes refuse one. */
  holds(address: string): boolean { return this.admissionOf(address) !== null; }

  private admissionOf(address: string): GeneralGuestAdmission | null {
    const key = address.toLowerCase(), admission = this.bindings.get(key);
    if (!admission) return null;
    if (admission.expiresAt <= this.now()) { this.bindings.delete(key); return null; }
    return admission;
  }

  /** The gate said this guest is closed or expired: every session of it ends, and it is not admitted again here. */
  private gone(guest: GeneralGuestAdmission): void {
    for (const [key, admission] of this.bindings) if (admission.userId === guest.userId) this.bindings.delete(key);
    this.goneGuests.set(guest.userId, guest.expiresAt);
    if (this.goneGuests.size > 5000) { const oldest = this.goneGuests.keys().next().value; if (oldest !== undefined) this.goneGuests.delete(oldest); }
  }

  /** What `GET /play/general` answers, so the sign-in page asks for nothing it would be refused. */
  offer(): Record<string, unknown> {
    return { enabled: true, audience: this.audience, start: DASHBOARD_GENERAL_GUEST_PATHS.start, finish: DASHBOARD_GENERAL_GUEST_PATHS.finish,
      act: DASHBOARD_GENERAL_GUEST_PATHS.act, returnPath: DASHBOARD_GENERAL_GUEST_RETURN_PATH };
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
   * binding issued for its state; a request without it is refused and spends nothing.
   */
  async finish(req: Request): Promise<Record<string, unknown>> {
    this.fromDashboard(req); this.sweep(); this.admit('finishes', 100);
    const { address, payload } = this.signedBy(req, DASHBOARD_GENERAL_GUEST_FINISH_PURPOSE);
    const expected = ['agent_id', 'timestamp', 'purpose', 'code', 'state', 'binding'];
    // `record_key` is the one optional field: the tab's own X25519 public key, to seal its record for.
    const recordKey = payload['record_key'];
    if (Object.keys(payload).length !== expected.length + (recordKey === undefined ? 0 : 1) || expected.some(key => typeof payload[key] !== 'string')) refuse(400, 'general_guest_input_invalid');
    if (recordKey !== undefined && !isTabRecordKey(recordKey)) refuse(400, 'general_guest_input_invalid');
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
    // Every canonical field is checked again against this deployment's own identity, as the workbench does.
    const host = new URL(this.door.identityUrl).host.replace(/:/g, '%3A'), users = `did:web:${host}:users:`;
    const id = guest.userId;
    if (typeof id !== 'string' || !/^u-try-guest-[0-9a-f]{32}$/.test(id) || guest.ownerDid !== users + id) refuse(401, 'general_guest_return_invalid');
    // Not yet: a guest linked to an account, or one acting on another's behalf. Refused on the
    // stated attribute alone, before anything is derived from it.
    const facts = record(guest.attributes) ? guest.attributes as unknown as Record<string, unknown> : null;
    if (!facts) refuse(401, 'general_guest_return_invalid');
    if (facts['linkedTo'] !== undefined && facts['linkedTo'] !== null) refuse(403, 'general_guest_linked_refused');
    if (facts['onBehalfOf'] !== undefined && facts['onBehalfOf'] !== null) refuse(403, 'general_guest_delegation_refused');
    let standing: ReturnType<typeof guestSessionStanding>;
    try { standing = guestSessionStanding(guest, this.now(), DASHBOARD_GUEST_SESSION_MS); } catch { return refuse(401, 'general_guest_return_invalid'); }
    if (standing.linked) refuse(403, 'general_guest_linked_refused');
    if (standing.guestDid !== guest.ownerDid || standing.subject !== guest.ownerDid) refuse(401, 'general_guest_return_invalid');
    // The guest's records go to the guest's own pod, as the bridge's one resolver places it, and
    // identity must have stated the same pod (`statedPodIsOwn`: the same pod root on the same
    // store, read as a URL). A guest the resolver would put on the tenant pod is refused. The pod
    // that is kept and used is the DERIVED one, never identity's string.
    let podUrl: string;
    try { podUrl = this.podFor(guest.ownerDid); } catch { return refuse(403, 'general_guest_pod_refused'); }
    if (typeof podUrl !== 'string' || !podUrl.endsWith(`/${id}/`) || !statedPodIsOwn(guest.podUrl, podUrl, id, this.sameStore)) refuse(403, 'general_guest_pod_refused');
    if (this.goneGuests.has(id)) refuse(410, 'general_guest_gone');
    this.admit('finish:' + id, DASHBOARD_GUEST_LIMITS.finishes);
    if (this.bindings.size >= this.maxBindings && !this.bindings.has(address)) refuse(429, 'general_guest_busy');
    // One guest, a few tabs: a further tab ends the oldest (Map order is insertion order).
    const held = [...this.bindings].filter(([key, admission]) => admission.userId === id && key !== address).map(([key]) => key);
    for (const key of held.slice(0, Math.max(0, held.length - (DASHBOARD_GUEST_KEYS_PER_GUEST - 1)))) this.bindings.delete(key);
    const admission: GeneralGuestAdmission = { userId: id, guestDid: guest.ownerDid, podUrl, expiresAt: standing.expiresAt,
      ...(typeof recordKey === 'string' ? { recordKey } : {}) };
    this.bindings.delete(address); this.bindings.set(address, admission);
    return { generalGuest: this.standing(admission) };
  }

  /**
   * The one guest route: a request the tab key signed, naming one operation of the allow-list.
   * The caller is decided first (a key admitted here, as its guest), then the operation
   * (default-deny), then the guest's own limits. Only then does anything run.
   */
  async act(req: Request): Promise<Record<string, unknown>> {
    this.fromDashboard(req); this.sweep(); this.admit('acts', 6000);
    const { address, payload } = this.signedBy(req, GUEST_OPERATION_PURPOSE);
    const admission = this.admissionOf(address);
    if (!admission) refuse(401, 'general_guest_not_admitted');
    const decided = decideGuestOperation(payload);
    if (!decided.ok) refuse(decided.status, decided.code);
    // Keyed on the guest, not the tab key or the address: opening tabs buys nothing.
    this.admit('op:' + admission.userId, DASHBOARD_GUEST_LIMITS.operations);
    if (decided.spec.writes) this.admit('write:' + admission.userId, DASHBOARD_GUEST_LIMITS.writes);
    const principal = generalGuestPrincipal(address, payload, admission);
    if (decided.operation === 'guest.standing') return { generalGuest: this.standing(admission) };
    if (decided.operation === 'guest.sign_out') { this.bindings.delete(address); return { signed_out: true }; }
    try { return await this.ports[decided.operation](principal, decided.args); }
    catch (error) {
      if (error instanceof GuestPodError) {
        // 410: the guest is closed or expired. Every session of it ends here and it is not retried.
        if (error.gone) this.gone(admission);
        throw new DashboardGuestError(error.status, error.code);
      }
      throw error;
    }
  }

  dispose(): void { this.bindings.clear(); this.goneGuests.clear(); this.rates.clear(); }
}

const publicStanding = (admission: GeneralGuestAdmission): Record<string, unknown> =>
  ({ guestDid: admission.guestDid, userId: admission.userId, linked: false, expiresAt: new Date(admission.expiresAt).toISOString() });

/**
 * The routes. Called only where the general guest is configured. Each has a limiter by address in
 * front of it; the limits that matter are the guest's own, inside `act`.
 */
export function attachDashboardGeneralGuestRoutes(app: Express, guests: DashboardGeneralGuest): void {
  const body = routeJson({ limit: '64kb', strict: true });
  const limiter = (limit: number, identifier: string): RequestHandler => rateLimit({
    windowMs: 60_000, limit, ipv6Subnet: 56, identifier, standardHeaders: 'draft-8', legacyHeaders: false, message: { error: 'general_guest_busy' },
  });
  const route = (work: (req: Request) => Promise<Record<string, unknown>> | Record<string, unknown>) => (req: Request, res: Response) => {
    res.set('Cache-Control', 'no-store').set('Referrer-Policy', 'no-referrer').set('X-Content-Type-Options', 'nosniff');
    void (async () => work(req))().then(answer => { res.json(answer); }, error => {
      if (error instanceof DashboardGuestError) { res.status(error.status).json({ error: error.code, ...(error.detail ?? {}) }); return; }
      res.status(503).json({ error: 'general_guest_unavailable' });
    });
  };
  app.get(DASHBOARD_GENERAL_GUEST_PATHS.offer, limiter(60, 'general-guest-offer'), route(() => guests.offer()));
  app.post(DASHBOARD_GENERAL_GUEST_PATHS.start, limiter(10, 'general-guest-start'), body, route(req => guests.start(req)));
  app.post(DASHBOARD_GENERAL_GUEST_PATHS.finish, limiter(20, 'general-guest-finish'), body, route(req => guests.finish(req)));
  app.post(DASHBOARD_GENERAL_GUEST_PATHS.act, limiter(600, 'general-guest-act'), body, route(req => guests.act(req)));
}
