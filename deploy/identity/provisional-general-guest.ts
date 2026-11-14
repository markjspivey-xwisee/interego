/**
 * The general guest: one provisional owner per browser key across every application, admitted
 * through a door on identity's own origin. Off unless PROVISIONAL_GENERAL_GUEST=1, and an
 * application takes part only when its PROVISIONAL_PLAY_CLIENTS entry says `"generalGuest": true`.
 *
 * A per-application guest (provisional-play.ts) keeps its key in the application's origin, so each
 * application sees a different owner. Here the key is held by the door page, on identity's origin,
 * and the owner id is a function of the key alone (generalGuestUserId). An application sends the
 * browser to the door by a top-level navigation with a grant its service agent signed (the same
 * sign_request envelope as a per-application grant, another purpose), and gets the browser back at
 * its registered return path with a one-use code that its backend exchanges for what identity
 * knows about the guest. Nothing an application or a browser supplies names the owner: the id
 * comes from the key that signed, the return address from configuration.
 *
 * The anchor, the admission ledger and its caps, the deadline, the hosted-terms gate, the replay
 * receipts and the cleanup are the per-application guest's (provisional-play-store.ts,
 * provisional-play-admission.ts, provisional-play-cleanup.ts). The first application to send a
 * browser pays the admission from its own cap; each application that sends it is recorded on the
 * owner's record, and that list is one of the guest's attributes.
 *
 * Two kinds of token are issued, both carrying the `provisionalPlay` marker without an `audience`
 * (so a relay or css-gate from before this change, whose parsers require one, refuses them):
 *   - an application token ({ general: true, application, ... }), returned to the application's
 *     backend by the exchange. Identity itself accepts it on token introspection only: it cannot
 *     enrol a credential, delete the account, renew itself or read /me.
 *   - a door token ({ general: true, door: true, ... }), returned only to the door page on this
 *     origin for the existing claim flow (/connect?claim=).
 */
import * as crypto from 'node:crypto';
import { hostedPrivacyUrl, type HostedTermsPolicy, type TermsAcceptance } from './hosted-terms.js';
import { DEFAULT_PLAY_NAMESPACE, PlayError, generalGuestUserId, isBase64Url, playKeyThumbprint, playOrigin, publicPlayKey,
  verifyPlayProof, type PlayClaims, type PlayClient, type PlayGrant, type ProvisionalPlay } from './provisional-play.js';
import type { PlayAnchorDocument, PlayReceipt } from './provisional-play-store.js';
import { GuestLink, LINKED_TO_FIELD, LINK_CODE_MAX_ATTEMPTS, LINK_CODE_TTL_SECONDS, guestLinkedTo } from './provisional-guest-link.js';

export const GENERAL_GUEST_PURPOSE = 'interego-general-guest-v1';
/** How long a door code lives. The application's backend exchanges it at once. */
export const GUEST_CODE_TTL_SECONDS = 60;
const CODE_DOMAIN = 'interego-general-guest-code-v1\0';

/** The marker of a general guest's token (server.ts ProvisionalTokenGrant). It never has an `audience`. */
export interface GeneralTokenGrant {
  general: true;
  proofKeyThumbprint: string;
  expiresAt: number;
  /** The application the token is for. Absent on a door token. */
  application?: string;
  /** That application's namespace, where it configures one that is not the default. */
  namespace?: string;
  /** Set on the token the door page uses for the claim flow, on identity's origin only. */
  door?: true;
}
/** One application that admitted or has used a general guest (the owner record's provisionalGuestApplications). */
export interface GuestApplication { audience: string; admittedAt: number }
/**
 * What identity states about a subject, in its exchange and introspection answers: the facts
 * `@interego/abac/portable`'s `subjectAttributeGraph` takes (docs/ns/passport.ttl). Times in Unix
 * seconds. `admittedBy` holds only the asking application's own origin, where it is one this
 * subject was admitted to or has used: an application is not told which others there are.
 */
export interface SubjectAttributes {
  subject: string;
  provisional: true;
  claimed: boolean;
  establishedAt: number;
  standingUntil: number;
  admittedBy: string[];
  proofKeyThumbprint: string;
  acceptedTermsVersion?: string;
  /**
   * The DID of the registered account this guest is linked to (provisional-guest-link.ts), stated
   * only while the account's own record lists this guest. Absent otherwise.
   */
  linkedTo?: string;
}

const fail = (status: number, code: string): never => { throw new PlayError(status, code); };
/** The bytes a browser key signs at the door: never the bytes of any other proof this provider accepts. */
export function doorProofPayload(grant: PlayGrant, termsVersion?: string): string {
  const proof = `interego-general-guest-door-v1\n${grant._signed_payload}\n${grant._signature}`;
  return termsVersion ? `${proof}\nHosted-Interego-Terms: ${termsVersion}` : proof;
}
/** The bytes a browser key signs to open the claim flow for its own guest. */
export function claimProofPayload(issuer: string, thumbprint: string, expiresAt: number): string {
  return `interego-general-guest-claim-v1\n${issuer}\n${thumbprint}\n${expiresAt}`;
}
const listed = (value: unknown) => Array.isArray(value) && value.length > 0;
/** The applications recorded on an owner's record, malformed entries dropped. */
export function guestApplications(document: PlayAnchorDocument): GuestApplication[] {
  const rows = document['provisionalGuestApplications'];
  if (!Array.isArray(rows)) return [];
  return rows.filter((row): row is GuestApplication => !!row && typeof row === 'object'
    && typeof (row as GuestApplication).audience === 'string' && Number.isInteger((row as GuestApplication).admittedAt)).slice(0, 64);
}
/**
 * The subject's attributes as stated to `application` (none for the door's own token), from its
 * opened anchor and its record as read from the pod. Every value is one identity holds; nothing is
 * taken from a request. `linkedTo` is what GuestLink.confirmed answered for this record: the
 * account's side of a link is on another record, which the caller has read.
 */
export function subjectAttributes(claims: PlayClaims, document: PlayAnchorDocument, application?: string, linkedTo?: string): SubjectAttributes {
  const terms = document['termsAcceptance'] as TermsAcceptance | undefined;
  return {
    subject: claims.ownerDid, provisional: true,
    claimed: listed(document['webAuthnCredentials']) || listed(document['walletAddresses']) || listed(document['didKeys']),
    establishedAt: claims.issuedAt, standingUntil: claims.expiresAt,
    admittedBy: guestApplications(document).map(row => row.audience).filter(audience => audience === application),
    proofKeyThumbprint: claims.proofKeyThumbprint,
    ...(terms && typeof terms.version === 'string' ? { acceptedTermsVersion: terms.version } : {}),
    ...(linkedTo !== undefined ? { linkedTo } : {}),
  };
}

export interface GeneralGuestDependencies {
  issuer: string;
  publicPodBase: string;
  signingKey: Uint8Array;
  clients: ReadonlyMap<string, PlayClient>;
  /** PROVISIONAL_GENERAL_GUEST=1. */
  enabled: boolean;
  /**
   * The dedicated origin the door page is served from (GENERAL_GUEST_DOOR_ORIGIN), where one is
   * configured: the only origin whose requests the door and the claim answer, and the origin that
   * holds every guest key. Unset, the door is on identity's own origin (development).
   */
  doorOrigin?: string;
  hostedTerms?: HostedTermsPolicy;
  now?: () => number;
  verifyGrantSignature(grant: PlayGrant, client: PlayClient): Promise<boolean>;
  /** The per-application guest's provisioning, which also records the application and the door code. */
  provision(claims: PlayClaims, attestation: string, maxPods: number, receipt: PlayReceipt,
    termsAcceptance: TermsAcceptance | undefined, code: PlayReceipt): Promise<string>;
  /**
   * Change an existing owner's record under its lock, conditionally on the revision read: `change`
   * may throw a PlayError to refuse, and nothing is written then. Throws 401
   * provisional_owner_unavailable where there is no record.
   */
  update(userId: string, change: (document: PlayAnchorDocument) => void | false): Promise<PlayAnchorDocument>;
  /** A record as the pod holds it now (a guest's, or the account a guest names), or null where there is none. */
  read(userId: string): Promise<PlayAnchorDocument | null>;
  /** `update` for a registered account's record (provisional-guest-link.ts GuestLinkDependencies.updateAccount). */
  updateAccount(userId: string, change: (document: PlayAnchorDocument) => void | false): Promise<PlayAnchorDocument>;
  issueToken(claims: PlayClaims, grant: GeneralTokenGrant): Promise<{ token: string; expiresAt: string }>;
}

interface DoorCode { v: 1; userId: string; audience: string; state: string; codeChallenge: string; expiresAt: number; nonce: string }

export class GeneralGuest {
  private readonly now: () => number;
  /** Linking this door's guests to registered accounts (provisional-guest-link.ts). On with the door. */
  readonly link: GuestLink;
  constructor(private readonly play: ProvisionalPlay, private readonly deps: GeneralGuestDependencies) {
    this.now = deps.now ?? (() => Math.floor(Date.now() / 1000));
    this.link = new GuestLink({ issuer: deps.issuer, enabled: () => this.enabled, doorOrigin: () => this.doorOrigin, now: this.now,
      open: anchor => play.open(anchor), read: deps.read, update: deps.update, updateAccount: deps.updateAccount });
  }
  /** On only with the setting and at least one application that opted in. */
  get enabled(): boolean {
    return this.deps.enabled && [...this.deps.clients.values()].some(client => client.generalGuest === true);
  }
  /** The application at `audience`, where it opted in. */
  client(audience: string): PlayClient | undefined {
    const client = this.deps.clients.get(audience);
    return client?.generalGuest === true ? client : undefined;
  }
  /** The origin the door page is served from, and the only one its requests are answered for. */
  get doorOrigin(): string { return this.deps.doorOrigin ?? new URL(this.deps.issuer).origin; }
  /** The marker of an application's token for this guest: its namespace from configuration, as for a per-application guest. */
  applicationGrant(claims: PlayClaims, audience: string): GeneralTokenGrant {
    const namespace = this.client(audience)?.namespace;
    return { general: true, application: audience, proofKeyThumbprint: claims.proofKeyThumbprint, expiresAt: claims.expiresAt,
      ...(namespace !== undefined ? { namespace } : {}) };
  }
  private sealCode(code: DoorCode): string {
    const encoded = Buffer.from(JSON.stringify(code)).toString('base64url');
    return `igc1_${encoded}.${crypto.createHmac('sha256', this.deps.signingKey).update(`${CODE_DOMAIN}${encoded}`).digest('base64url')}`;
  }
  private openCode(value: unknown): DoorCode {
    const match = typeof value === 'string' && value.length <= 2048 ? /^igc1_([A-Za-z0-9_-]+)\.([A-Za-z0-9_-]+)$/.exec(value) : null;
    if (!match || !isBase64Url(match[2], 32)) return fail(401, 'invalid_guest_code');
    const expected = crypto.createHmac('sha256', this.deps.signingKey).update(`${CODE_DOMAIN}${match[1]}`).digest();
    if (!crypto.timingSafeEqual(expected, Buffer.from(match[2]!, 'base64url'))) return fail(401, 'invalid_guest_code');
    let code: DoorCode;
    try { code = JSON.parse(Buffer.from(match[1]!, 'base64url').toString('utf8')); } catch { return fail(401, 'invalid_guest_code'); }
    if (!code || code.v !== 1 || !Number.isInteger(code.expiresAt)) return fail(401, 'invalid_guest_code');
    return code;
  }
  private static hash(value: string): string { return crypto.createHash('sha256').update(value, 'utf8').digest('base64url'); }

  /**
   * The door page's request: `{ playGrant, publicKeyJwk, proof, termsVersion? }`, sent from this
   * origin only. Admits the key's guest (or finds it), records the application on it, and answers
   * where to send the browser: the application's registered return path with a one-use code and the
   * grant's `state`. The address is built from configuration alone.
   */
  async door(input: unknown, requestOrigin: unknown): Promise<{ redirect: string }> {
    if (!this.enabled) return fail(404, 'general_guest_disabled');
    // The door page is the only caller: a page of any other origin has no business here, and could
    // not hold the key the door's origin keeps anyway.
    if (requestOrigin !== this.doorOrigin) return fail(403, 'general_guest_door_origin');
    const body = input as { playGrant?: PlayGrant; publicKeyJwk?: unknown; proof?: unknown; termsVersion?: unknown };
    const key = publicPlayKey(body?.publicKeyJwk);
    const grant = body?.playGrant;
    if (!grant || typeof grant._signed_payload !== 'string' || grant._signed_payload.length > 8192
      || typeof grant._signature !== 'string' || !/^0x[0-9a-fA-F]{130}$/.test(grant._signature)) return fail(400, 'invalid_play_grant');
    let payload: Record<string, unknown>;
    try { payload = JSON.parse(grant._signed_payload); } catch { return fail(400, 'invalid_play_grant'); }
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return fail(400, 'invalid_play_grant');
    const audience = playOrigin(payload['audience']);
    const client = this.client(audience);
    const timestamp = typeof payload['timestamp'] === 'string' ? Date.parse(payload['timestamp']) / 1000 : NaN;
    const now = this.now();
    const state = payload['state'];
    const codeChallenge = payload['codeChallenge'];
    if (!client || payload['purpose'] !== GENERAL_GUEST_PURPOSE
      || payload['agent_id'] !== client.agentDid || payload['subject_pod_url'] !== client.podUrl
      || !isBase64Url(state) || state.length < 20 || state.length > 128 || !isBase64Url(codeChallenge, 32)
      || !Number.isFinite(timestamp) || timestamp > now + 5 || timestamp < now - 120
      || !Number.isInteger(payload['expiresAt']) || Number(payload['expiresAt']) <= now
      || Number(payload['expiresAt']) > timestamp + 120) return fail(401, 'invalid_play_grant');
    const policy = this.deps.hostedTerms;
    const termsVersion = policy && body.termsVersion === policy.version ? policy.version : undefined;
    if (body.termsVersion !== undefined && !termsVersion) return fail(428, 'hosted_terms_required');
    if (!verifyPlayProof(key, doorProofPayload(grant, termsVersion), body.proof)) return fail(401, 'invalid_browser_proof');
    if (!await this.deps.verifyGrantSignature(grant, client)) return fail(401, 'invalid_play_grant');
    const thumbprint = playKeyThumbprint(key);
    const userId = generalGuestUserId(thumbprint);
    const agentId = `mcp-client-${userId}`;
    const identityHost = new URL(this.deps.issuer).host;
    const proposed: PlayClaims = {
      version: 1, issuer: this.deps.issuer, audience, userId,
      ownerDid: `did:web:${identityHost}:users:${userId}`,
      webId: `${this.deps.issuer}/users/${userId}/profile#me`,
      podUrl: new URL(`${userId}/`, this.deps.publicPodBase).href,
      authenticatedAgentId: agentId, authenticatedAgentDid: `did:web:${identityHost}:agents:${agentId}`,
      publicKeyJwk: key, proofKeyThumbprint: thumbprint, issuedAt: now,
      expiresAt: now + this.play.ttlSeconds, capabilities: ['human-play', 'own-pod-checkpoint'], provisional: true, general: true,
    };
    const receipt = { hash: GeneralGuest.hash(`${grant._signed_payload}\n${grant._signature}`), expiresAt: Number(payload['expiresAt']) };
    const code = this.sealCode({ v: 1, userId, audience, state, codeChallenge, expiresAt: now + GUEST_CODE_TTL_SECONDS,
      nonce: crypto.randomBytes(16).toString('base64url') });
    const termsAcceptance = termsVersion ? { version: termsVersion, acceptedAt: new Date(now * 1000).toISOString() } : undefined;
    const attestation = await this.deps.provision(proposed, this.play.seal(proposed), this.play.maxPods, receipt, termsAcceptance,
      { hash: GeneralGuest.hash(code), expiresAt: now + GUEST_CODE_TTL_SECONDS });
    const claims = this.play.open(attestation);
    if (claims.general !== true || claims.userId !== userId || claims.proofKeyThumbprint !== thumbprint) return fail(409, 'provisional_owner_conflict');
    const target = new URL(client.generalGuestReturnPath!, audience);
    if (target.origin !== audience) return fail(503, 'general_guest_return_unavailable');
    target.search = new URLSearchParams({ code, state }).toString();
    return { redirect: target.href };
  }

  /**
   * An application backend's exchange of a door code: `{ code, codeVerifier, audience, state }`.
   * The code is spent on the owner's record (one use, on every instance), bound to the audience and
   * state the grant named and to the verifier whose challenge the application's service agent
   * signed. Answers what identity knows about the guest and an application token for it.
   */
  async exchange(input: unknown): Promise<Record<string, unknown>> {
    if (!this.enabled) return fail(404, 'general_guest_disabled');
    const body = input as { code?: unknown; codeVerifier?: unknown; audience?: unknown; state?: unknown };
    if (!body || typeof body !== 'object') return fail(400, 'invalid_guest_exchange');
    const audience = playOrigin(body.audience);
    const code = this.openCode(body.code);
    const now = this.now();
    const verifier = body.codeVerifier;
    if (!this.client(audience) || code.audience !== audience || code.expiresAt <= now
      || typeof body.state !== 'string' || body.state !== code.state
      || !isBase64Url(verifier) || verifier.length < 43 || verifier.length > 128
      || crypto.createHash('sha256').update(verifier, 'utf8').digest('base64url') !== code.codeChallenge
      || typeof code.userId !== 'string' || !/^u-try-guest-[a-f0-9]{32}$/.test(code.userId)) return fail(401, 'invalid_guest_code');
    const hash = GeneralGuest.hash(body.code as string);
    let claims!: PlayClaims;
    const document = await this.deps.update(code.userId, record => {
      claims = this.openGeneral(record, code.userId);
      const codes = (Array.isArray(record['provisionalGuestCodes']) ? record['provisionalGuestCodes'] as PlayReceipt[] : [])
        .filter(row => Number.isInteger(row.expiresAt) && row.expiresAt > now);
      if (!codes.some(row => row.hash === hash)) throw new PlayError(409, 'guest_code_already_used');
      if (!guestApplications(record).some(row => row.audience === audience)) throw new PlayError(401, 'invalid_guest_code');
      record['provisionalGuestCodes'] = codes.filter(row => row.hash !== hash);
    });
    const linkedTo = await this.link.confirmed(document, claims);
    const token = await this.deps.issueToken(claims, this.applicationGrant(claims, audience));
    return {
      valid: true, provisional: true, general: true, issuer: this.deps.issuer, audience,
      userId: claims.userId, ownerDid: claims.ownerDid, webId: claims.webId, podUrl: claims.podUrl,
      authenticatedAgentId: claims.authenticatedAgentId, authenticatedAgentDid: claims.authenticatedAgentDid,
      proofKeyThumbprint: claims.proofKeyThumbprint, guestExpiresAt: new Date(claims.expiresAt * 1000).toISOString(),
      namespace: this.client(audience)?.namespace ?? DEFAULT_PLAY_NAMESPACE,
      subjectAttributes: subjectAttributes(claims, document, audience, linkedTo),
      token: token.token, tokenExpiresAt: token.expiresAt,
    };
  }
  /** The record's anchor, opened (410 once its deadline has passed) and held to be this general guest's. */
  private openGeneral(record: PlayAnchorDocument, userId: string): PlayClaims {
    if (!record.provisionalPlayAnchor) return fail(401, 'provisional_owner_unavailable');
    const claims = this.play.open(record.provisionalPlayAnchor);
    if (claims.general !== true || claims.userId !== userId) return fail(401, 'provisional_owner_unavailable');
    return claims;
  }

  /**
   * The door page's request to open the claim flow for the guest its key holds:
   * `{ publicKeyJwk, expiresAt, proof }`, from this origin only. Answers a door token, which the
   * existing add-device flow (/connect?claim=) takes as the guest's bearer. The proof is spent on
   * the owner's record like a grant.
   */
  async claim(input: unknown, requestOrigin: unknown): Promise<{ token: string; expiresAt: string }> {
    if (!this.enabled) return fail(404, 'general_guest_disabled');
    if (requestOrigin !== this.doorOrigin) return fail(403, 'general_guest_door_origin');
    const body = input as { publicKeyJwk?: unknown; expiresAt?: unknown; proof?: unknown };
    const key = publicPlayKey(body?.publicKeyJwk);
    const now = this.now();
    const expiresAt = body.expiresAt;
    if (typeof expiresAt !== 'number' || !Number.isInteger(expiresAt) || expiresAt <= now || expiresAt > now + 120) return fail(401, 'invalid_browser_proof');
    const thumbprint = playKeyThumbprint(key);
    const signed = claimProofPayload(this.deps.issuer, thumbprint, expiresAt);
    if (!verifyPlayProof(key, signed, body.proof)) return fail(401, 'invalid_browser_proof');
    const userId = generalGuestUserId(thumbprint);
    const receipt = { hash: GeneralGuest.hash(`${signed}\n${body.proof as string}`), expiresAt };
    let claims!: PlayClaims;
    const document = await this.deps.update(userId, record => {
      claims = this.openGeneral(record, userId);
      if (claims.proofKeyThumbprint !== thumbprint) throw new PlayError(401, 'provisional_owner_unavailable');
      const receipts = (record.provisionalPlayReceipts ?? []).filter(row => Number.isInteger(row.expiresAt) && row.expiresAt > now);
      if (receipts.some(row => row.hash === receipt.hash)) throw new PlayError(409, 'play_grant_already_used');
      if (receipts.length >= 16) throw new PlayError(429, 'play_grant_receipt_capacity');
      record.provisionalPlayReceipts = [...receipts, receipt];
    });
    // A guest linked to an account is kept through that account. Giving it a credential of its own
    // would make it a second account: the owner unlinks it first.
    if (await this.link.confirmed(document, claims)) return fail(409, 'guest_linked');
    // A guest's side of a link that no account confirms is what a failed write left. It is cleared
    // before the claim opens: the record's writer refuses a credential to a guest that names an
    // account (server.ts playChangeRefused), and a leftover must not hold back a claim for good.
    if (guestLinkedTo(document)) {
      await this.deps.update(userId, record => {
        if (!guestLinkedTo(record)) return false;
        delete record[LINKED_TO_FIELD];
        return;
      });
    }
    return this.deps.issueToken(claims, { general: true, door: true, proofKeyThumbprint: thumbprint, expiresAt: claims.expiresAt });
  }

  /** What `/.well-known/play-provisional` adds while the door is on. */
  metadata() {
    const policy = this.deps.hostedTerms;
    return {
      doorUrl: `${this.doorOrigin}/guest/door`, exchangeEndpoint: `${this.deps.issuer}/guest/exchange`,
      grantPurpose: GENERAL_GUEST_PURPOSE, grantFields: ['purpose', 'audience', 'state', 'codeChallenge', 'expiresAt'],
      doorFragment: 'grant={base64url(JSON {_signed_payload,_signature})}',
      codeChallengeMethod: 'S256', codeTtlSeconds: GUEST_CODE_TTL_SECONDS,
      applications: [...this.deps.clients].filter(([, client]) => client.generalGuest === true).map(([audience]) => audience),
      ...(policy ? { terms: { version: policy.version, url: policy.termsUrl, privacyUrl: hostedPrivacyUrl } } : {}),
      linkability: 'One guest per browser across the listed applications: each learns the same owner DID, WebID and pod URL.',
      // Linking this browser's guest to a registered account: where its owner sends the browser, with a code from the account's dashboard.
      accountLink: { doorUrl: `${this.doorOrigin}/guest/door#link`, codeEndpoint: `${this.deps.issuer}/guest/link/code`,
        codeTtlSeconds: LINK_CODE_TTL_SECONDS, codeMaxAttempts: LINK_CODE_MAX_ATTEMPTS },
    };
  }
}
