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
 * agent pod id → a WebID/URL account root → a did:ethr (or bare) address → the tenant pod.
 */
export function resolveSubjectPodUrlPure(opts: SubjectPodUrlOptions): string {
  const { tenantPodUrl, identity, explicit, safeUrl } = opts;
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
  if (/^https?:\/\//.test(id)) {
    try {
      const u = new URL(id);
      const first = u.pathname.split('/').filter(Boolean)[0];
      if (first) return `${u.origin}/${first}/`;
    } catch { /* fall through */ }
  }
  return tenantPodUrl;
}
