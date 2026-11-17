/**
 * Interego's general guest on the dashboard's sign-in page: one guest per browser across Interego
 * applications, admitted at identity's own door (DURABLE-GUEST.md, "The general guest").
 *
 * The session it ends in is a guest session like any other here: a key this tab makes and holds in
 * memory, which signs every request. The door adds one thing: the bridge has identity's word for
 * which Interego guest this tab is (and which account that guest is linked to, if any), and
 * attributes the tab key's activity to it until the stated time. It gives the tab no more than a
 * guest has.
 *
 * The round trip leaves this page, so two small values are kept in this TAB's sessionStorage for
 * the journey: the visit's `state` and the `binding` the bridge issued with it. Neither is a
 * credential. The tab's key is made only after the return, so it is never stored.
 */
import { ethers } from 'ethers';
import { signAgentRequestAs } from './signed-request.js';

export interface GeneralGuestOffer {
  /** Bridge addresses for the four steps. */
  startUrl: string; finishUrl: string; standingUrl: string; signOutUrl: string;
  /** The path on this page's own origin the door returns to. */
  returnPath: string;
  /** The origin of identity's door page: the only place `start` will send the browser. */
  doorOrigin: string;
}
/** Whom the bridge attributes this tab's key to, as it answered. Not a secret. */
export interface GeneralGuestStanding { guestDid: string; subject: string; linked: boolean; expiresAt: string }

export interface VisitStore { getItem(key: string): string | null; setItem(key: string, value: string): void; removeItem(key: string): void }
export type GuestFetch = (url: string, init?: { method?: string; headers?: Record<string, string>; body?: string }) =>
  Promise<{ ok: boolean; status: number; json(): Promise<unknown> }>;
export interface GeneralGuestDeps { fetch: GuestFetch; store: VisitStore; now?: () => number }

export class GeneralGuestError extends Error {
  constructor(readonly code: string) { super(code); this.name = 'GeneralGuestError'; }
}

/**
 * The path on this page's origin identity's door returns to. The app routes it to the sign-in page,
 * and the bridge must offer exactly this one (its DASHBOARD_GENERAL_GUEST_RETURN_PATH).
 */
export const GENERAL_GUEST_RETURN_PATH = '/guest/general/return';
const VISIT_KEY = 'foxxi:general-guest-visit';
const VISIT_MS = 10 * 60 * 1000;
const FINISH = 'foxxi-dashboard-general-guest-finish-v1', SIGN_OUT = 'foxxi-dashboard-general-guest-sign-out-v1';
const record = (value: unknown): Record<string, unknown> => value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
const text = (value: unknown): string | null => typeof value === 'string' && value.length > 0 && value.length <= 4096 ? value : null;
const base = (url: string) => url.replace(/\/+$/, '');
const path = (value: unknown): string | null => { const p = text(value); return p && /^\/[A-Za-z0-9/_-]{1,127}$/.test(p) && !p.includes('//') ? p : null; };

/** What the bridge offers, or null where the general guest is off, or the bridge cannot be asked. */
export async function generalGuestOffer(bridgeUrl: string, deps: Pick<GeneralGuestDeps, 'fetch'>): Promise<GeneralGuestOffer | null> {
  try {
    const answer = await deps.fetch(`${base(bridgeUrl)}/play/guest`);
    const offered = record(record(await answer.json())['generalGuest']);
    const [start, finish, standing, signOut, returnPath] = [offered['start'], offered['finish'], offered['standing'], offered['signOut'], offered['returnPath']].map(path);
    const doorOrigin = text(offered['doorOrigin']);
    if (!answer.ok || offered['enabled'] !== true || !start || !finish || !standing || !signOut || returnPath !== GENERAL_GUEST_RETURN_PATH || !doorOrigin
      || new URL(doorOrigin).origin !== doorOrigin || new URL(doorOrigin).protocol !== 'https:') return null;
    const at = (p: string) => base(bridgeUrl) + p;
    return { startUrl: at(start), finishUrl: at(finish), standingUrl: at(standing), signOutUrl: at(signOut), returnPath, doorOrigin };
  } catch { return null; }
}

/**
 * Step 1. Asks the bridge for a door visit, remembers its state and binding in this tab, and
 * answers the door address to navigate to (top-level). Only identity's door is ever answered:
 * an address anywhere else is refused, whatever the bridge said.
 */
export async function startGeneralGuest(offer: GeneralGuestOffer, deps: GeneralGuestDeps): Promise<string> {
  const answer = await deps.fetch(offer.startUrl, { method: 'POST', headers: { 'Content-Type': 'application/json', Accept: 'application/json' }, body: '{}' });
  const body = record(await answer.json().catch(() => ({})));
  const doorUrl = text(body['doorUrl']), state = text(body['state']), binding = text(body['binding']);
  if (!answer.ok || !doorUrl || !state || !binding) throw new GeneralGuestError(text(body['error']) ?? 'general_guest_unavailable');
  let door: URL;
  try { door = new URL(doorUrl); } catch { throw new GeneralGuestError('general_guest_unavailable'); }
  if (door.origin !== offer.doorOrigin || door.pathname !== '/guest/door' || door.search) throw new GeneralGuestError('general_guest_unavailable');
  deps.store.setItem(VISIT_KEY, JSON.stringify({ state, binding, startedAt: (deps.now ?? Date.now)() }));
  return door.href;
}

/**
 * Whether this address is the door's return: `{code, state}` when it is, else null. The caller
 * removes them from the address at once, before anything is fetched.
 */
export function generalGuestReturn(location: { pathname: string; search: string }): { code: string; state: string } | null {
  if (location.pathname !== GENERAL_GUEST_RETURN_PATH) return null;
  const query = new URLSearchParams(location.search), code = query.get('code'), state = query.get('state');
  return code && state ? { code, state } : null;
}

/**
 * Step 3. Finishes the visit THIS tab started, and no other: a return whose state this tab does
 * not hold is dropped without a request, so an address someone else made finishes nothing here.
 * The tab's key is made now, and the bridge is asked in a request that key signs.
 */
export async function finishGeneralGuest(offer: GeneralGuestOffer, returned: { code: string; state: string }, deps: GeneralGuestDeps,
  make: () => ethers.HDNodeWallet = () => ethers.Wallet.createRandom()): Promise<{ wallet: ethers.HDNodeWallet; standing: GeneralGuestStanding }> {
  const kept = deps.store.getItem(VISIT_KEY);
  let visit: Record<string, unknown> = {};
  try { visit = record(JSON.parse(kept ?? '{}')); } catch { /* refused below */ }
  const state = text(visit['state']), binding = text(visit['binding']), startedAt = visit['startedAt'];
  // A return that is not this tab's visit is dropped, and the tab's own visit is left as it was.
  if (!state || !binding || state !== returned.state) throw new GeneralGuestError('general_guest_not_started_here');
  // It is this tab's: whatever happens next, the visit is over here.
  deps.store.removeItem(VISIT_KEY);
  if (typeof startedAt !== 'number' || (deps.now ?? Date.now)() - startedAt > VISIT_MS) throw new GeneralGuestError('general_guest_not_started_here');
  const wallet = make();
  const envelope = await signAgentRequestAs(wallet, { purpose: FINISH, code: returned.code, state, binding }, new Date((deps.now ?? Date.now)()));
  const answer = await deps.fetch(offer.finishUrl, { method: 'POST', headers: { 'Content-Type': 'application/json', Accept: 'application/json' }, body: JSON.stringify(envelope) });
  const body = record(await answer.json().catch(() => ({})));
  const stated = record(body['generalGuest']);
  const guestDid = text(stated['guestDid']), subject = text(stated['subject']), expiresAt = text(stated['expiresAt']);
  if (!answer.ok || !guestDid || !subject || !expiresAt || typeof stated['linked'] !== 'boolean' || !Number.isFinite(Date.parse(expiresAt))) throw new GeneralGuestError(text(body['error']) ?? 'general_guest_unavailable');
  return { wallet, standing: { guestDid, subject, linked: stated['linked'], expiresAt } };
}

/** Sign-out: asks the bridge to drop what it holds about this tab's key. Best effort; signing out here never waits on it. */
export async function signOutGeneralGuest(offerOrUrl: Pick<GeneralGuestOffer, 'signOutUrl'>, privateKey: string, deps: Pick<GeneralGuestDeps, 'fetch'>): Promise<boolean> {
  try {
    const envelope = await signAgentRequestAs(new ethers.Wallet(privateKey), { purpose: SIGN_OUT });
    return (await deps.fetch(offerOrUrl.signOutUrl, { method: 'POST', headers: { 'Content-Type': 'application/json', Accept: 'application/json' }, body: JSON.stringify(envelope) })).ok;
  } catch { return false; }
}

/** The browser's own fetch and this tab's sessionStorage. */
export function browserGeneralGuestDeps(): GeneralGuestDeps {
  return { fetch: (url, init) => fetch(url, init), store: sessionStorage };
}
