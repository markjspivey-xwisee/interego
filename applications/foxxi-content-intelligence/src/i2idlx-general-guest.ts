/**
 * The I2IDL-X learner workbench's use of identity's GENERAL guest door: one guest per browser
 * across Interego applications (deploy/identity/PROVISIONAL-PLAY.md, "General guest"), offered
 * beside the workbench's own guest (i2idlx/LEARNING-CONNECTIONS.md, "Guest learners").
 *
 * Off unless FOXXI_I2IDLX_GENERAL_GUEST is exactly `1`. It is the same application to identity as
 * the workbench's own guest: the same origin (the bridge's own, never a request's), the same
 * service account, the same entry in PROVISIONAL_PLAY_CLIENTS. So it needs that service's key
 * (FOXXI_I2IDLX_GUEST_SERVICE_PRIVATE_KEY), and `1` without it stops the bridge at start instead
 * of leaving a door nobody can sign for.
 *
 * This module only reads the settings and builds the shared client
 * (applications/_shared/guest-access/door.ts). The routes, the cookie and the session's bounds are
 * in i2idlx-learning-auth.ts.
 */
import { GeneralGuestDoor, type DoorFetch, type DoorGrant } from '../../_shared/guest-access/door.js';
import type { PlayGrantConfig } from './play-grant.js';

export { GENERAL_GUEST_RETURN_PATH } from './i2idlx-learning-auth.js';

export interface LearnerGeneralGuestSettings {
  /** The workbench's origin, as identity's PROVISIONAL_PLAY_CLIENTS names it. */
  readonly audience: string;
  readonly identityUrl: string;
  /** Where identity serves the door page, when that is a dedicated origin. */
  readonly doorOrigin?: string;
}

/** What signs a door grant as the workbench's service agent: `PlayGrantService.generalGuestGrant`. */
export type DoorGrantSigner = (request: { purpose: string; audience: string; state: string; codeChallenge: string; expiresAt: number }) => Promise<DoorGrant>;

/**
 * The settings, or null where the general guest is off. `learnerGuest` is what
 * `learnerGuestGrantConfig` answered for the same environment (null where the workbench has no
 * guest service key).
 */
export function learnerGeneralGuestSettings(env: Readonly<Record<string, string | undefined>>, learnerGuest: PlayGrantConfig | null): LearnerGeneralGuestSettings | null {
  if (env['FOXXI_I2IDLX_GENERAL_GUEST'] !== '1') return null;
  if (!learnerGuest) throw new Error('FOXXI_I2IDLX_GENERAL_GUEST=1 needs FOXXI_I2IDLX_GUEST_SERVICE_PRIVATE_KEY: the general guest door is signed for by the workbench\'s own service agent');
  const stated = env['FOXXI_I2IDLX_GENERAL_GUEST_DOOR_ORIGIN']?.trim();
  if (!stated) return { audience: learnerGuest.audience, identityUrl: learnerGuest.identityUrl };
  let door: URL;
  try { door = new URL(stated); } catch { throw new Error('FOXXI_I2IDLX_GENERAL_GUEST_DOOR_ORIGIN is not a URL'); }
  if (door.origin !== stated || door.protocol !== 'https:') throw new Error('FOXXI_I2IDLX_GENERAL_GUEST_DOOR_ORIGIN must be an HTTPS origin, with no path');
  // The door's own origin holds every general guest's key; this workbench must never be it.
  if (door.origin === learnerGuest.audience) throw new Error('FOXXI_I2IDLX_GENERAL_GUEST_DOOR_ORIGIN must not be the workbench\'s own origin');
  return { audience: learnerGuest.audience, identityUrl: learnerGuest.identityUrl, doorOrigin: door.origin };
}

/** The door for those settings, signed for by `signGrant`. */
export function learnerGeneralGuestDoor(settings: LearnerGeneralGuestSettings, signGrant: DoorGrantSigner, deps: { fetch?: DoorFetch; now?: () => number } = {}): GeneralGuestDoor {
  return new GeneralGuestDoor({
    identityUrl: settings.identityUrl, audience: settings.audience,
    ...(settings.doorOrigin ? { doorOrigin: settings.doorOrigin } : {}),
    signGrant,
    // No more visits in progress than the sign-in keeps (LearningAccountAuth's maxPending default).
    maxVisits: 200,
    ...(deps.fetch ? { fetch: deps.fetch } : {}), ...(deps.now ? { now: deps.now } : {}),
  });
}
