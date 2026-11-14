/**
 * Linking a general guest to an existing registered account (PROVISIONAL-PLAY.md, "Linking a guest
 * to an account"). Part of the general guest, so off unless PROVISIONAL_GENERAL_GUEST=1.
 *
 * One ceremony, the same on one device or across two:
 *   1. The account's owner, signed in and freshly proven by an existing passkey or wallet (the
 *      step-up of provisional-guest-link-routes.ts), asks for a link code. Its hash, its expiry
 *      (LINK_CODE_TTL_SECONDS) and an attempt counter are written on the ACCOUNT's record,
 *      conditionally. The code is `<account id>:<secret>`: the id says which record holds the hash.
 *   2. The code is entered on the door page in the browser that holds the guest. The guest's key
 *      signs it once to be told which account it names (`linkPreviewPayload`), and once more, with
 *      that account in the signed bytes, to link (`linkProofPayload`). So the page names the account
 *      before the click that links, the account's name is told only to a holder of a live code, and
 *      the link proof cannot be moved to another account or another code.
 *   3. Identity writes the guest's record first (`provisionalGuestLinkedTo`), then the account's
 *      (the guest joins `linkedGuests`, and the code is spent in that same write). Both writes are
 *      conditional and idempotent: a retry after a failed second write finds the guest's side
 *      written, the code unspent, and completes.
 *
 * The link is stated (subjectAttributes `linkedTo`) only while BOTH records agree: the guest's names
 * the account, the account's lists the guest by id and key, the account still holds a credential,
 * and the guest is unclaimed. A guest's side alone is nothing: it is what a failed second write, an
 * account's deletion or an unlink's failed second write leaves, and a later link replaces it.
 *
 * The code goes from the signed-in device to the guest's device. The other direction (a code shown
 * by the guest's browser, typed into the account) would let anyone who can show a signed-in owner a
 * code attach their own guest to that owner's account, which is the worse of the two confusions:
 * the attached guest would then act as the owner in every application.
 */
import * as crypto from 'node:crypto';
import { PlayError, generalGuestUserId, playKeyThumbprint, publicPlayKey, verifyPlayProof, type PlayClaims } from './provisional-play.js';
import { holdsCredential, type PlayAnchorDocument } from './provisional-play-store.js';

/** How long a link code lives. */
export const LINK_CODE_TTL_SECONDS = 300;
/** Wrong guesses a code survives. One more ends it, the right code included. */
export const LINK_CODE_MAX_ATTEMPTS = 5;
/** Live guests one account may have linked at once. */
export const MAX_LINKED_GUESTS = 16;
/** The account record's fields (server.ts AuthMethods), present only while there is something to hold. */
export const LINKED_GUESTS_FIELD = 'linkedGuests';
export const LINK_CODE_FIELD = 'guestLinkCode';
/** The guest record's field. */
export const LINKED_TO_FIELD = 'provisionalGuestLinkedTo';

export interface LinkedGuest { userId: string; proofKeyThumbprint: string; linkedAt: number; standingUntil: number }
export interface GuestLinkCode { hash: string; expiresAt: number; attempts: number }
export interface GuestLinkedTo { userId: string; linkedAt: number }
/** The account a code names, as the door page shows it before the click. */
export interface LinkAccountView { did: string; userId: string; name: string }

const SECRET_ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
const SECRET_LENGTH = 12;
const CODE = /^([A-Za-z0-9][A-Za-z0-9._-]{0,63}):([0-9A-HJKMNP-TV-Z]{12})$/;
const GUEST_ID = /^u-try-guest-[a-f0-9]{32}$/;
const fail = (status: number, code: string): never => { throw new PlayError(status, code); };

/** The bytes a guest's key signs to be told which account a code names. Never the bytes that link. */
export function linkPreviewPayload(issuer: string, thumbprint: string, code: string, expiresAt: number): string {
  return `interego-general-guest-link-preview-v1\n${issuer}\n${thumbprint}\n${code}\n${expiresAt}`;
}
/** The bytes a guest's key signs to link itself to `account` (the account's DID, as the page showed it). */
export function linkProofPayload(issuer: string, thumbprint: string, code: string, expiresAt: number, account: string): string {
  return `interego-general-guest-link-v1\n${issuer}\n${thumbprint}\n${code}\n${expiresAt}\n${account}`;
}
/** A code in its one canonical form, or null. The door page canonicalises what a person typed before it signs. */
export function parseLinkCode(value: unknown): { userId: string; secret: string } | null {
  const match = typeof value === 'string' && value.length <= 96 ? CODE.exec(value) : null;
  return match ? { userId: match[1]!, secret: match[2]! } : null;
}
export function linkCodeHash(userId: string, secret: string): string {
  return crypto.createHash('sha256').update(`interego-general-guest-link-code-v1\0${userId}\0${secret}`, 'utf8').digest('base64url');
}
const sameHash = (a: string, b: string) => a.length === b.length && crypto.timingSafeEqual(Buffer.from(a), Buffer.from(b));

/** The guests an account's record lists, malformed entries dropped. */
export function linkedGuests(document: PlayAnchorDocument): LinkedGuest[] {
  const rows = document[LINKED_GUESTS_FIELD];
  if (!Array.isArray(rows)) return [];
  return rows.filter((row): row is LinkedGuest => !!row && typeof row === 'object' && typeof (row as LinkedGuest).userId === 'string'
    && GUEST_ID.test((row as LinkedGuest).userId) && typeof (row as LinkedGuest).proofKeyThumbprint === 'string'
    && Number.isInteger((row as LinkedGuest).linkedAt) && Number.isInteger((row as LinkedGuest).standingUntil)).slice(0, 64);
}
/** The account a guest's record names, where it names one. Not yet a link: see GuestLink.confirmed. */
export function guestLinkedTo(document: PlayAnchorDocument): GuestLinkedTo | undefined {
  const value = document[LINKED_TO_FIELD] as GuestLinkedTo | undefined;
  return value && typeof value === 'object' && typeof value.userId === 'string' && Number.isInteger(value.linkedAt) ? value : undefined;
}
function linkCode(document: PlayAnchorDocument): GuestLinkCode | undefined {
  const value = document[LINK_CODE_FIELD] as GuestLinkCode | undefined;
  return value && typeof value === 'object' && typeof value.hash === 'string' && Number.isInteger(value.expiresAt) && Number.isInteger(value.attempts) ? value : undefined;
}
/** A registered account's record: not a deletion's tombstone, and holding a passkey, wallet or DID. */
const isAccount = (document: PlayAnchorDocument) => typeof document['deletedAt'] !== 'string' && holdsCredential(document);
/** Write the list back, or remove the field where it is empty: an account with no guest has no trace of this feature. */
function setLinkedGuests(document: PlayAnchorDocument, guests: LinkedGuest[]): void {
  if (guests.length) document[LINKED_GUESTS_FIELD] = guests; else delete document[LINKED_GUESTS_FIELD];
}

export interface GuestLinkDependencies {
  issuer: string;
  /** Whether the general guest door is on. */
  enabled(): boolean;
  /** The door page's origin: the only one the door's link request is answered for. */
  doorOrigin(): string;
  now?: () => number;
  /** Opens a guest's anchor (ProvisionalPlay.open): throws once its deadline has passed. */
  open(anchor: string): PlayClaims;
  /** A record as the pod holds it now, or null where there is none. Throws when the pod cannot be read. */
  read(userId: string): Promise<PlayAnchorDocument | null>;
  /**
   * Change a record under its owner's lock, conditionally on the revision read
   * (provisional-play-store.ts updatePlayAnchorDocument): `change` throws a PlayError to refuse and
   * returns false to leave the record as it is.
   */
  update(userId: string, change: (document: PlayAnchorDocument) => void | false): Promise<PlayAnchorDocument>;
  /**
   * The same, for a registered account's record. Identity writes these through its own record
   * writer (server.ts), so an account's record keeps the form every other write gives it.
   */
  updateAccount(userId: string, change: (document: PlayAnchorDocument) => void | false): Promise<PlayAnchorDocument>;
  /** Tests only: the secret of the next code. */
  secret?: () => string;
}

export class GuestLink {
  private readonly now: () => number;
  constructor(private readonly deps: GuestLinkDependencies) {
    this.now = deps.now ?? (() => Math.floor(Date.now() / 1000));
  }
  private did(userId: string): string { return `did:web:${new URL(this.deps.issuer).host}:users:${userId}`; }
  private view(document: PlayAnchorDocument): LinkAccountView {
    const name = (typeof document['name'] === 'string' ? document['name'] : '').replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, 160);
    return { did: this.did(document.userId), userId: document.userId, name: name || document.userId };
  }
  /** A record that may not be there, or is not this id's: null, never an error (a link names it, a person may have typed it). */
  private async account(userId: string): Promise<PlayAnchorDocument | null> {
    try {
      const document = await this.deps.read(userId);
      return document && document.userId === userId && isAccount(document) ? document : null;
    } catch (error) {
      if (error instanceof PlayError) return null;
      throw error;
    }
  }
  private static lists(account: PlayAnchorDocument, guestId: string, thumbprint: string): boolean {
    return linkedGuests(account).some(row => row.userId === guestId && row.proofKeyThumbprint === thumbprint);
  }
  /** The guest's anchor, opened (410 once its deadline has passed), held to be this key's general guest and unclaimed. */
  private guest(record: PlayAnchorDocument, guestId: string, thumbprint: string): PlayClaims {
    if (!record.provisionalPlayAnchor) return fail(401, 'provisional_owner_unavailable');
    const claims = this.deps.open(record.provisionalPlayAnchor);
    if (claims.general !== true || claims.userId !== guestId || claims.proofKeyThumbprint !== thumbprint) return fail(401, 'provisional_owner_unavailable');
    // A claimed guest is an account of its own: it is signed in to, not linked.
    if (holdsCredential(record)) return fail(409, 'guest_already_claimed');
    return claims;
  }

  /**
   * The account a guest is linked to, as its DID, where both records say so now: the guest's names
   * the account, the account's lists this guest and this key and still holds a credential, and the
   * guest is unclaimed. Undefined otherwise. Throws when the account's record cannot be read, so
   * that a caller answers "try again" rather than stating the guest as unlinked.
   */
  async confirmed(guest: PlayAnchorDocument, claims: PlayClaims): Promise<string | undefined> {
    const to = guestLinkedTo(guest);
    if (!to || to.userId === claims.userId || holdsCredential(guest)) return undefined;
    const account = await this.account(to.userId);
    return account && GuestLink.lists(account, claims.userId, claims.proofKeyThumbprint) ? this.did(to.userId) : undefined;
  }

  /**
   * A new link code for `ownerId`, whose bearer and fresh credential proof the caller has verified.
   * It replaces the account's previous code, and drops the guests whose standing has ended.
   */
  async issueCode(ownerId: string): Promise<{ code: string; expiresAt: string; account: LinkAccountView }> {
    if (!this.deps.enabled()) return fail(404, 'general_guest_disabled');
    const now = this.now();
    const secret = this.deps.secret?.() ?? Array.from(crypto.randomBytes(SECRET_LENGTH), byte => SECRET_ALPHABET[byte & 31]).join('');
    const code = `${ownerId}:${secret}`;
    if (!parseLinkCode(code)) return fail(409, 'link_account_unavailable');
    const document = await this.ownAccount(ownerId, record => {
      setLinkedGuests(record, linkedGuests(record).filter(row => row.standingUntil > now));
      record[LINK_CODE_FIELD] = { hash: linkCodeHash(ownerId, secret), expiresAt: now + LINK_CODE_TTL_SECONDS, attempts: 0 } satisfies GuestLinkCode;
    });
    return { code, expiresAt: new Date((now + LINK_CODE_TTL_SECONDS) * 1000).toISOString(), account: this.view(document) };
  }

  /** A change to the record of the account whose owner asked for it: 409 where that is no longer a registered account. */
  private async ownAccount(ownerId: string, change: (record: PlayAnchorDocument) => void | false): Promise<PlayAnchorDocument> {
    try {
      return await this.deps.updateAccount(ownerId, record => {
        if (!isAccount(record)) throw new PlayError(409, 'link_account_unavailable');
        return change(record);
      });
    } catch (error) {
      if (error instanceof PlayError && ['provisional_owner_unavailable', 'provisional_owner_conflict'].includes(error.code)) return fail(409, 'link_account_unavailable');
      throw error;
    }
  }

  /**
   * Hold `hash` to the account's live code, under the account's lock. A wrong one is counted on the
   * record; a code that has met LINK_CODE_MAX_ATTEMPTS wrong ones is over. An account that does not
   * exist, holds no credential or has no live code is answered as a wrong code is, and nothing is
   * written. With `spend`, the matching code's write is `spend`'s (which removes the code).
   */
  private async checkCode(ownerId: string, hash: string, spend?: (record: PlayAnchorDocument) => void): Promise<PlayAnchorDocument> {
    const now = this.now();
    // Read first, without the lock: a request that names no account, or an account with no live
    // code, takes no lock and writes nothing.
    const held = await this.account(ownerId);
    const live = held && linkCode(held);
    if (!live || live.expiresAt <= now) return fail(401, 'invalid_link_code');
    const seen = { outcome: 'none' as 'none' | 'wrong' | 'exhausted' | 'ok' };
    let document: PlayAnchorDocument;
    try {
      document = await this.deps.updateAccount(ownerId, record => {
        seen.outcome = 'none';
        if (!isAccount(record)) return false;
        const code = linkCode(record);
        if (!code || code.expiresAt <= now) return false;
        if (code.attempts >= LINK_CODE_MAX_ATTEMPTS) { seen.outcome = 'exhausted'; return false; }
        if (!sameHash(code.hash, hash)) {
          seen.outcome = 'wrong';
          record[LINK_CODE_FIELD] = { ...code, attempts: code.attempts + 1 } satisfies GuestLinkCode;
          return;
        }
        seen.outcome = 'ok';
        if (!spend) return false;
        spend(record);
        return;
      });
    } catch (error) {
      if (error instanceof PlayError && ['provisional_owner_unavailable', 'provisional_owner_conflict'].includes(error.code)) return fail(401, 'invalid_link_code');
      throw error;
    }
    if (seen.outcome === 'exhausted') return fail(429, 'link_code_attempts_exceeded');
    if (seen.outcome !== 'ok') return fail(401, 'invalid_link_code');
    return document;
  }

  /**
   * The door page's request: `{ publicKeyJwk, code, expiresAt, proof, account? }`, from the door's
   * origin only. Without `account` it answers which account the code names and links nothing. With
   * `account` (the DID the page showed, which the proof must have signed) it links this key's guest
   * to that account and spends the code.
   */
  async link(input: unknown, requestOrigin: unknown): Promise<{ linked: boolean; account: LinkAccountView }> {
    if (!this.deps.enabled()) return fail(404, 'general_guest_disabled');
    if (requestOrigin !== this.deps.doorOrigin()) return fail(403, 'general_guest_door_origin');
    const body = (input && typeof input === 'object' ? input : {}) as { publicKeyJwk?: unknown; code?: unknown; expiresAt?: unknown; proof?: unknown; account?: unknown };
    const key = publicPlayKey(body.publicKeyJwk);
    const now = this.now();
    const expiresAt = body.expiresAt;
    if (typeof expiresAt !== 'number' || !Number.isInteger(expiresAt) || expiresAt <= now || expiresAt > now + 120) return fail(401, 'invalid_browser_proof');
    const confirm = body.account !== undefined;
    if (confirm && (typeof body.account !== 'string' || body.account.length > 256 || /[\u0000-\u001f\u007f]/.test(body.account))) return fail(400, 'invalid_link_request');
    const parsed = parseLinkCode(body.code);
    if (!parsed) return fail(401, 'invalid_link_code');
    const thumbprint = playKeyThumbprint(key);
    const code = body.code as string;
    const signed = confirm ? linkProofPayload(this.deps.issuer, thumbprint, code, expiresAt, body.account as string)
      : linkPreviewPayload(this.deps.issuer, thumbprint, code, expiresAt);
    if (!verifyPlayProof(key, signed, body.proof)) return fail(401, 'invalid_browser_proof');
    const guestId = generalGuestUserId(thumbprint);
    const ownerId = parsed.userId;
    if (ownerId === guestId) return fail(401, 'invalid_link_code');
    let guest: PlayAnchorDocument | null;
    try { guest = await this.deps.read(guestId); }
    catch (error) { if (error instanceof PlayError) return fail(401, 'provisional_owner_unavailable'); throw error; }
    if (!guest) return fail(401, 'provisional_owner_unavailable');
    const claims = this.guest(guest, guestId, thumbprint);
    // What the guest's record says now. Only a link the named account confirms holds the guest:
    // one side alone is what a failed write left, and is replaced.
    const current = guestLinkedTo(guest);
    let unconfirmed: string | undefined;
    if (current) {
      const holder = await this.account(current.userId);
      const listed = !!holder && GuestLink.lists(holder, guestId, thumbprint);
      // Already linked to this account (a retry whose answer was lost): nothing to do, and no code is needed to say so.
      if (listed && current.userId === ownerId) return { linked: true, account: this.view(holder) };
      if (listed) return fail(409, 'guest_already_linked');
      unconfirmed = current.userId;
    }
    const hash = linkCodeHash(ownerId, parsed.secret);
    const account = await this.checkCode(ownerId, hash);
    if (!confirm) return { linked: false, account: this.view(account) };
    if (body.account !== this.did(ownerId)) return fail(409, 'link_account_mismatch');
    const room = (record: PlayAnchorDocument) => linkedGuests(record).filter(row => row.standingUntil > now && row.userId !== guestId);
    if (room(account).length >= MAX_LINKED_GUESTS) return fail(429, 'linked_guest_capacity');
    // The guest's record first. Until the account's lists the guest, this states nothing.
    await this.deps.update(guestId, record => {
      this.guest(record, guestId, thumbprint);
      const to = guestLinkedTo(record);
      if (to?.userId === ownerId) return false;
      if (to && to.userId !== unconfirmed) throw new PlayError(409, 'guest_already_linked');
      record[LINKED_TO_FIELD] = { userId: ownerId, linkedAt: now } satisfies GuestLinkedTo;
      return;
    });
    // Then the account's, which spends the code in the same write: the code is held again here, so
    // one code links one guest, and a retry after this write failed finds it unspent.
    const written = await this.checkCode(ownerId, hash, record => {
      const others = room(record);
      if (others.length >= MAX_LINKED_GUESTS) throw new PlayError(429, 'linked_guest_capacity');
      setLinkedGuests(record, [...others, { userId: guestId, proofKeyThumbprint: thumbprint, linkedAt: now, standingUntil: claims.expiresAt }]);
      delete record[LINK_CODE_FIELD];
    });
    return { linked: true, account: this.view(written) };
  }

  /**
   * Unlink `guestId` from `ownerId`, whose bearer and fresh credential proof the caller has verified.
   * The account's side first (the link is no longer stated from that write on), then the guest's;
   * the guest's is attempted whatever the first found, so a retry finishes an unlink whose second
   * write failed. A guest that is gone, or that names another account, is left as it is.
   */
  async unlink(ownerId: string, guestId: unknown): Promise<{ unlinked: true; wasLinked: boolean }> {
    if (!this.deps.enabled()) return fail(404, 'general_guest_disabled');
    if (typeof guestId !== 'string' || !GUEST_ID.test(guestId)) return fail(400, 'invalid_link_request');
    let wasLinked = false;
    await this.ownAccount(ownerId, record => {
      const guests = linkedGuests(record);
      const rest = guests.filter(row => row.userId !== guestId);
      wasLinked = rest.length !== guests.length;
      if (!wasLinked) return false;
      setLinkedGuests(record, rest);
      return;
    });
    try {
      await this.deps.update(guestId, record => {
        if (guestLinkedTo(record)?.userId !== ownerId) return false;
        delete record[LINKED_TO_FIELD];
        wasLinked = true;
        return;
      });
    } catch (error) {
      if (!(error instanceof PlayError) || !['provisional_owner_unavailable', 'provisional_owner_conflict'].includes(error.code)) throw error;
    }
    return { unlinked: true, wasLinked };
  }

  /** The guests an account has linked whose standing has not ended. */
  async list(ownerId: string): Promise<Array<{ userId: string; did: string; linkedAt: number; standingUntil: number }>> {
    if (!this.deps.enabled()) return fail(404, 'general_guest_disabled');
    const account = await this.account(ownerId);
    const now = this.now();
    return (account ? linkedGuests(account) : []).filter(row => row.standingUntil > now)
      .map(row => ({ userId: row.userId, did: this.did(row.userId), linkedAt: row.linkedAt, standingUntil: row.standingUntil }));
  }
}
