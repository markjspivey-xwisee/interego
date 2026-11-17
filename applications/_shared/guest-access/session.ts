/**
 * What an application session made for a general guest may be: who it acts as, and when it must
 * end (deploy/identity/PROVISIONAL-PLAY.md, "General guest" and "Linking a guest to an account").
 *
 * An application that let a guest in through `GeneralGuestDoor` holds identity's statement about
 * that guest as of the exchange, and nothing after it: identity's token for the guest can be
 * re-checked only by a caller holding identity's introspection secret, which an application does
 * not. So a session is bounded here, by what was stated when it was made:
 *
 *   - it never outlives the guest (`guestExpiresAt`), nor the application's own ceiling;
 *   - a session for a LINKED guest acts as the registered account identity named, and the
 *     application is not told when the owner unlinks. It ends after LINKED_GUEST_SESSION_MS, and
 *     the browser returns through the door, where the link is read again.
 *
 * Reads no environment and keeps no state.
 */
import { canonicalSubject } from '@interego/abac/portable';
import { GuestDoorError, type GeneralGuestSession } from './door.js';

/** How long a session made for a linked guest lasts before the link is read again at the door. */
export const LINKED_GUEST_SESSION_MS = 10 * 60 * 1000;

export interface GuestStanding {
  /** Whom to attribute the session to: the linked account's DID, else the guest's own. */
  readonly subject: string;
  /** Whether identity stated a link to a registered account. */
  readonly linked: boolean;
  /** The guest that arrived, whoever the session is attributed to. */
  readonly guestDid: string;
  /** Unix milliseconds: the latest moment the session may be honoured. */
  readonly expiresAt: number;
}

/**
 * The standing of a session made now for `guest`. `maxSessionMs` is the application's own ceiling
 * for a guest session. Throws GuestDoorError 401 when identity's statement names no usable subject
 * (it builds no attribute graph, or states a link to the guest itself), or leaves no time at all.
 */
export function guestSessionStanding(guest: Pick<GeneralGuestSession, 'ownerDid' | 'guestExpiresAt' | 'attributes'>, now: number, maxSessionMs: number): GuestStanding {
  if (!Number.isFinite(now) || !Number.isFinite(maxSessionMs) || maxSessionMs <= 0) throw new Error('A guest session needs a clock and a positive ceiling');
  let who: { subject: string; linked: boolean };
  try { who = canonicalSubject(guest.attributes, now); } catch { throw new GuestDoorError(401, 'guest_door_exchange_refused'); }
  if (typeof who.subject !== 'string' || !who.subject || (who.linked && who.subject === guest.ownerDid) || (!who.linked && who.subject !== guest.ownerDid)) {
    throw new GuestDoorError(401, 'guest_door_exchange_refused');
  }
  const expiresAt = Math.min(guest.guestExpiresAt, now + maxSessionMs, who.linked ? now + LINKED_GUEST_SESSION_MS : Infinity);
  if (!Number.isFinite(expiresAt) || expiresAt <= now) throw new GuestDoorError(401, 'guest_door_exchange_refused');
  return { subject: who.subject, linked: who.linked, guestDid: guest.ownerDid, expiresAt };
}
