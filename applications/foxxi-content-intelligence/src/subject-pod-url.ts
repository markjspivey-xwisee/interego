/**
 * Which pod is a given identity's OWN pod.
 *
 * ── ★★ EXTRACTED BECAUSE IT FAILED OPEN TO A SHARED POD, UNTESTED ──────────────────────────
 *
 * This lived private inside bridge/server.ts, so nothing could unit-test it — and it decides, for
 * every self-sovereign read and write, WHOSE pod is touched. Measured live: the enrolment path passed
 * the recovered ADDRESS (what the signature layer actually returns) rather than a `did:ethr:` string.
 * No branch matched, so it returned the FALLBACK — the shared Foxxi tenant pod. Every agent that
 * enrolled itself enrolled the tenant pod; the first caller poisoned the projector's sweep set with
 * it, and every caller after was told `alreadyEnrolled: true` while its own pod was read by nothing.
 *
 * The failure mode is the shape worth naming: a resolver whose contract is "give me a DID", whose
 * parameter is merely NAMED `didOrWebId`, and whose misuse returns a SHARED pod instead of throwing.
 * Every caller that gets it wrong gets a plausible answer. So it is a module with tests now, and a
 * bare 0x address resolves exactly the way its did:ethr spelling does.
 */

import { ownPodSegment } from '@interego/core';

/**
 * Does this string contain a C0 control character, DEL, or a Unicode line/paragraph separator?
 *
 * ── ★ THE ONE PLACE THAT KNOWS WHAT "A SINGLE LINE OF PRINTABLE TEXT" MEANS ─────────────────
 *
 * Caller-supplied identity strings reach a Turtle literal on a PUBLIC register, a persisted pod row,
 * and pod-URL derivation. A raw newline inside a Turtle short-string literal is a syntax error, so
 * one unvalidated identity makes an entire register unreadable to every consumer — and once such a
 * row is durable, it stays broken across restarts with no in-band way to remove it.
 *
 * ★ WRITTEN AS CODE-POINT ARITHMETIC, NOT A CHARACTER-CLASS REGEX, on purpose: a regex for this
 * needs escapes that are easy to mangle into the very control characters it is meant to reject, and
 * a guard containing a literal NUL is worse than no guard. This form is unambiguous in review.
 */
export function hasControlChars(s: string): boolean {
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c < 0x20 || c === 0x7f || c === 0x2028 || c === 0x2029) return true;
  }
  return false;
}

/** Signature of the SSRF choke point (src/ssrf-guard.ts) — injected so this module stays pure. */
export type SafeUrlFn = (rawUrl: string) => string | undefined;

export interface SubjectPodUrlOptions {
  /** The Foxxi tenant pod — supplies the ORIGIN pods are derived on, and the last-resort fallback. */
  tenantPodUrl: string;
  /** An identity in any accepted form: did:ethr, did:web, a bare 0x address, a WebID URL, a pod id. */
  identity: string | undefined;
  /** A caller-supplied pod URL. Honoured only when it is a safe public target. */
  explicit?: string | undefined;
  safeUrl: SafeUrlFn;
  /**
   * The identity service's host (`identity.example`, or `identity.example:8443`), from config.
   * When given, a subject `did:web:<this host>:users:<id>` that `ownPodSegment` does not recognise
   * and whose `<id>` is one of identity's own user id shapes resolves to `<pod origin>/<id>/`
   * (see `identityUserIdOf`). Absent, the resolver answers exactly as it did before this option
   * existed. `resolveSubjectPodUrlGuarded` passes it, for a general guest's DID only.
   */
  identityHost?: string | undefined;
}

/**
 * The user ids the identity service mints, and nothing else:
 *
 *   u-pk-<12 hex>, u-eth-<12 hex>, u-did-<12 hex>   deploy/identity/derive-userid.ts
 *   u-try-<12 hex>                                  deploy/identity/server.ts (`/try` evaluation account)
 *   u-try-play-<32 hex>, u-try-guest-<32 hex>       deploy/identity/provisional-play.ts
 *
 * Lowercase hex only, as identity writes them. A seeded legacy id (a display alias such as a
 * name) is deliberately NOT here: it has no shape to check, and the tenant pod's own segment
 * would be one.
 */
const IDENTITY_USER_ID = /^(?:u-(?:pk|eth|did)-[0-9a-f]{12}|u-try-[0-9a-f]{12}|u-try-(?:play|guest)-[0-9a-f]{32})$/;
/** A general guest's DID by shape, under any did:web host (deploy/identity/provisional-play.ts). */
const GENERAL_GUEST_DID = /^did:web:[^\s/?#]+:users:u-try-guest-[0-9a-f]{32}$/i;
/** A configured identity host: a DNS name, optionally with a port. No trailing dot, no IPv6 literal. */
const IDENTITY_HOST = /^[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?(?::[0-9]{1,5})?$/;
/** Longer than any DID identity issues; a longer subject is not parsed at all. */
export const IDENTITY_SUBJECT_MAX_LENGTH = 512;

/**
 * The prefixes `did:web:<host>:users:` a configured identity host is written with, lowercased.
 *
 * Two spellings of a host that has a port, because both are in use: the identity service writes
 * `new URL(BASE_URL).host` as it is (deploy/identity/server.ts), and Foxxi's learning sign-in
 * writes the did:web form with the colon percent-encoded (src/i2idlx-learning-auth.ts). A host
 * without a port has one spelling. An unusable configured host yields none, which turns the rule off.
 */
function identityUserPrefixes(identityHost: string | undefined): string[] {
  const host = (identityHost ?? '').trim().toLowerCase();
  if (!host || !IDENTITY_HOST.test(host)) return [];
  return [...new Set([host, host.replace(/:/g, '%3a')])].map(h => `did:web:${h}:users:`);
}

/** What follows `did:web:<configured host>:users:` in `subject`, or undefined when it is not that. */
function identityUserTail(subject: string, identityHost: string | undefined): string | undefined {
  if (typeof subject !== 'string' || subject.length > IDENTITY_SUBJECT_MAX_LENGTH || hasControlChars(subject)) return undefined;
  // The method and the `:users:` label are exact; only the host is compared case-insensitively.
  if (!subject.startsWith('did:web:')) return undefined;
  for (const prefix of identityUserPrefixes(identityHost)) {
    if (subject.length <= prefix.length || subject.slice(0, prefix.length).toLowerCase() !== prefix) continue;
    if (subject.slice(prefix.length - ':users:'.length, prefix.length) !== ':users:') continue;
    return subject.slice(prefix.length);
  }
  return undefined;
}

/**
 * The user id of `did:web:<configured identity host>:users:<id>`, or undefined.
 *
 * Strict on both halves. The host must be the configured one exactly (case-insensitive; a
 * look-alike, a longer name ending in it, a trailing dot or another port is a different host).
 * The id must be one of identity's own shapes in full, so it holds no slash, dot, colon, percent
 * escape, uppercase letter or control character, and is at most 44 characters.
 */
export function identityUserIdOf(subject: string, identityHost: string | undefined): string | undefined {
  const tail = identityUserTail(subject, identityHost);
  return tail !== undefined && IDENTITY_USER_ID.test(tail) ? tail : undefined;
}

/** Is `subject` a DID under the configured identity host's `:users:`, whatever follows it? */
export function isIdentityUserDid(subject: string, identityHost: string | undefined): boolean {
  return identityUserTail(subject, identityHost) !== undefined;
}

/** Is `subject` shaped as a general guest's DID (`…:users:u-try-guest-<32 hex>`), under any host? */
export function isGeneralGuestDid(subject: string): boolean {
  return typeof subject === 'string' && subject.length <= IDENTITY_SUBJECT_MAX_LENGTH && !hasControlChars(subject) && GENERAL_GUEST_DID.test(subject);
}

/**
 * A caller-supplied pod URL reduced to a pod root — or undefined when it is not one we may fetch.
 *
 * ★ EXPORTED SO THERE IS ONE COPY. Two rules live in here and both are security-relevant: the SSRF
 * choke point, and the collapse to a single path segment. A second caller needs the same answer (is
 * this named pod usable, and what is it exactly?) and a second copy of these two rules is precisely
 * how the pair drifts apart — the multi-segment case below is a bug we already shipped once.
 *
 * SSRF choke point: honoured ONLY when it is a public http(s) target. A loopback/link-local/private
 * literal (127.0.0.1, 169.254.169.254, 10.*, internal hosts) yields undefined, so a caller cannot
 * steer a server-side pod fetch at an internal address. (A public hostname that DNS-resolves to a
 * private IP is additionally caught by assertSafeFetchTarget right before each fetch.)
 *
 * Canonicalize to a SINGLE-SEGMENT pod root <origin>/<firstSeg>/ — a pod is exactly one segment
 * under its origin. Returning a multi-segment override verbatim let a caller pass the selfBoundPod
 * last-segment actor check (…/eth-victim/eth-CALLER/) while a first-segment consumer
 * (void-credential's ownership check, the encryption-key write path) acted on a DIFFERENT segment
 * (eth-victim) — a cross-agent write/delete. Collapsing to the first segment makes last==first, so
 * the actor comparison and the consumers agree.
 */
export function explicitPodRoot(explicit: string, safeUrl: SafeUrlFn): string | undefined {
  const safe = safeUrl(explicit);
  if (!safe) return undefined;
  try {
    const u = new URL(safe);
    const seg = u.pathname.split('/').filter(Boolean)[0];
    return seg ? `${u.origin}/${seg}/` : undefined;
  } catch { return undefined; }
}

/**
 * Resolve the pod that IS this identity's own.
 *
 * Precedence: a safe explicit override (canonicalized to a single-segment pod root) → an embedded
 * agent pod id → a WebID/URL account root → a did:ethr (or bare) address → (only with
 * `identityHost`) an identity user DID's `<pod origin>/<userId>/` → the tenant pod.
 */
export function resolveSubjectPodUrlPure(opts: SubjectPodUrlOptions): string {
  const { tenantPodUrl, identity, explicit, safeUrl, identityHost } = opts;
  // The SSRF choke point and the pod-root collapse both live in explicitPodRoot; an override it
  // cannot vouch for is IGNORED here and the pod is derived from the identity instead. NOTE that
  // "ignored" is the right answer for a resolver whose job is "whose pod is this identity's" and the
  // WRONG one for a caller asking to READ a named pod — see src/read-target.ts, which asks
  // explicitPodRoot directly so it can refuse out loud instead of answering about someone else.
  if (explicit) {
    const root = explicitPodRoot(explicit, safeUrl);
    if (root) return root;
    // else: unsafe or unusable explicit target — ignore it and derive from the identity below.
  }
  const id = (identity ?? '').trim();
  if (!id) return tenantPodUrl;
  const tenantOrigin = (() => { try { return new URL(tenantPodUrl).origin; } catch { return ''; } })();
  // An agent pod id (u-pk-/u-did-/eth-) embedded in ANY identity form — a did:web
  // (…:agents:codex-u-pk-<id>), a bare id, or a WebID path — resolves to that agent's OWN CSS pod.
  // WITHOUT this, did:web/u-pk agents (e.g. a Codex agent like boozer) fell through to the tenant
  // pod, so their self-sovereign records (performance, course completions, SCORM outcomes)
  // misrouted to …/foxxi/ instead of …/<id>/ — the writer-side analogue of the WebID inbox-routing
  // defect. Checked FIRST so an identity-service WebID (…/users/<id>/profile) maps to <id>, not its
  // first path segment ("users").
  /**
   * ★ THE DERIVATION IS THE SUBSTRATE'S NOW. It was written out here, twice in the relay, and once
   * more in a relay lookalike — copies that agreed on canonical `did:ethr:0x<40 hex>` and diverged
   * on the spellings the signature layer actually emits (a bare address, a did:ethr without the 0x,
   * an identity with an embedded pod id). `ownPodSegment` covers all of them in one place.
   *
   * What stays HERE is the part that is genuinely this deployment's: which origin pods live on, and
   * the fail-closed tenant-pod default.
   */
  const seg = ownPodSegment(id);
  if (seg && tenantOrigin) return `${tenantOrigin}/${seg}/`;
  // An identity user DID `ownPodSegment` has no rule for (a guest's `u-try-…` id): its pod is
  // `<pod origin>/<userId>/`, where the identity service creates it and the css-gate scopes that
  // user's bearer. Only with a configured identity host; without one this line is never reached.
  const userId = identityHost ? identityUserIdOf(id, identityHost) : undefined;
  if (userId && tenantOrigin) return `${tenantOrigin}/${userId}/`;
  if (/^https?:\/\//.test(id)) {
    try {
      const u = new URL(id);
      const first = u.pathname.split('/').filter(Boolean)[0];
      if (first) return `${u.origin}/${first}/`;
    } catch { /* fall through */ }
  }
  return tenantPodUrl;
}

/** `<origin>/<first path segment>`, decoded and lowercased, for comparing two pod roots; undefined when not a URL. */
function podRootKey(podUrl: string): string | undefined {
  try {
    const u = new URL(podUrl);
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return undefined;
    const first = u.pathname.split('/').filter(Boolean)[0] ?? '';
    let seg = first;
    try { seg = decodeURIComponent(first); } catch { /* compared as written */ }
    return `${u.origin}/${seg.toLowerCase()}`;
  } catch { return undefined; }
}

export interface SubjectPodGuardInput {
  /** The principal's subject, as the caller decision produced it. */
  subject: string;
  /** The pod that subject resolved to. */
  podUrl: string;
  tenantPodUrl: string;
  /** The identity service's host, as given to the resolver. */
  identityHost?: string | undefined;
}

export type SubjectPodGuardRefusal =
  | 'pod-unreadable'
  | 'shared-tenant-pod'
  | 'not-own-pod';

export type SubjectPodGuardDecision = { ok: true } | { ok: false; reason: SubjectPodGuardRefusal; error: string };

/**
 * May this subject's records be kept on this pod?
 *
 * Refuses a general guest (by shape, under any host) and any DID under the configured identity
 * host's `:users:` whose resolved pod is the shared tenant pod: that is the resolver's fallback,
 * and for these subjects it would put one person's records where everyone else's fallback lands.
 * It also refuses one of identity's own user ids whose pod is not `<tenant pod origin>/<that id>/`,
 * and any pod URL it cannot read. Every other subject is answered `ok`: this is not a general
 * authorization check, and a wallet or agent subject keeps the checks it already has.
 *
 * Pure. Called by `resolveSubjectPodUrlGuarded`.
 */
export function guardSubjectPod(input: SubjectPodGuardInput): SubjectPodGuardDecision {
  const { subject, podUrl, tenantPodUrl, identityHost } = input;
  if (!isGeneralGuestDid(subject) && !isIdentityUserDid(subject, identityHost)) return { ok: true };
  const pod = podRootKey(podUrl), tenant = podRootKey(tenantPodUrl);
  if (!pod) return { ok: false, reason: 'pod-unreadable', error: 'the pod resolved for this identity is not a pod URL' };
  // An unreadable tenant pod is what the resolver hands back when it has nothing else, so a pod
  // equal to it as written is the fallback too.
  if (pod === tenant || podUrl === tenantPodUrl) {
    return { ok: false, reason: 'shared-tenant-pod', error: 'this identity has no pod of its own here: it resolved to the shared tenant pod, which is not used for a guest or an identity account' };
  }
  const userId = identityUserIdOf(subject, identityHost);
  if (userId) {
    const tenantOrigin = (() => { try { return new URL(tenantPodUrl).origin; } catch { return ''; } })();
    if (!tenantOrigin || pod !== `${tenantOrigin}/${userId}`) {
      return { ok: false, reason: 'not-own-pod', error: `the pod resolved for this identity is not its own (${userId})` };
    }
  }
  return { ok: true };
}

/** A subject's pod was refused by `guardSubjectPod`. Carries the HTTP status a route answers it with. */
export class SubjectPodRefusedError extends Error {
  readonly status = 403;
  constructor(readonly reason: SubjectPodGuardRefusal, message: string) { super(message); this.name = 'SubjectPodRefusedError'; }
}

/**
 * `resolveSubjectPodUrlPure`, with the guest rule applied when `guestIdentityHost` is given.
 *
 * Without `guestIdentityHost` this is `resolveSubjectPodUrlPure` exactly, for every identity.
 * With it, an identity shaped as a general guest's DID (and no other identity) is resolved with
 * that host as `identityHost`, and the answer is checked by `guardSubjectPod`: a guest whose pod
 * would be the shared tenant pod (another host's guest, an explicit override naming the tenant
 * pod), or a pod that is not the guest's own, throws `SubjectPodRefusedError` instead of being
 * answered. Every other identity is resolved as before and is not guarded.
 */
export function resolveSubjectPodUrlGuarded(opts: SubjectPodUrlOptions & { guestIdentityHost?: string | undefined }): string {
  const { guestIdentityHost, ...rest } = opts;
  const subject = (rest.identity ?? '').trim();
  if (!guestIdentityHost || !isGeneralGuestDid(subject)) return resolveSubjectPodUrlPure(rest);
  const podUrl = resolveSubjectPodUrlPure({ ...rest, identityHost: guestIdentityHost });
  const guard = guardSubjectPod({ subject, podUrl, tenantPodUrl: rest.tenantPodUrl, identityHost: guestIdentityHost });
  if (!guard.ok) throw new SubjectPodRefusedError(guard.reason, guard.error);
  return podUrl;
}

/**
 * `resolveSubjectPodUrlGuarded` for an identity SOMEONE ELSE named (a statement's actor, a stored
 * author, the learner a play was started for): `undefined` where the guest rule refuses the
 * identity, instead of a throw.
 *
 * The guest rule throws so a caller acting AS a guest is never handed the tenant pod. A name the
 * bridge was merely given is another matter: the request carrying it is usually fine (a statement
 * already committed, a void already applied, a course being read), and a throw there turned what
 * used to succeed into an error answer (at the LRS, a refusal sent after the statement was
 * stored). Those call sites ask here and treat `undefined` as they already treat an identity with
 * no pod on this store.
 *
 * Without `guestIdentityHost` nothing is ever refused: this is `resolveSubjectPodUrlPure` exactly
 * and never answers `undefined`. Any error that is not the guest rule's refusal still throws.
 */
export function namedSubjectPodUrlGuarded(opts: SubjectPodUrlOptions & { guestIdentityHost?: string | undefined }): string | undefined {
  try { return resolveSubjectPodUrlGuarded(opts); }
  catch (error) { if (error instanceof SubjectPodRefusedError) return undefined; throw error; }
}

/**
 * The pod of the identity a statement's actor names, for per-owner forwarding: `null` when the
 * actor is no recognizable self-sovereign identity (a generic upstream account name), or is one
 * the guest rule refuses. `null` means "nobody's here": the caller's own tenant is used.
 *
 * `podOf` is the bridge's named resolver. A general guest of this deployment's identity resolves
 * to its own pod, which is where the course player already keeps that guest's statements.
 */
export function statementOwnerPod(statement: Record<string, unknown> | null | undefined, podOf: (identity: string) => string | undefined): string | null {
  const name = (statement?.['actor'] as { account?: { name?: unknown } } | undefined)?.account?.name;
  if (typeof name !== 'string' || !name) return null;
  if (!/^did:(ethr|web|key):/.test(name) && !/(u-pk-|u-did-|u-eth-|eth-0x)/.test(name)) return null;
  const pod = podOf(name);
  return pod === undefined ? null : pod;
}
