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
 * Resolve the pod that IS this identity's own.
 *
 * Precedence: a safe explicit override (canonicalized to a single-segment pod root) → an embedded
 * agent pod id → a WebID/URL account root → a did:ethr (or bare) address → the tenant pod.
 */
export function resolveSubjectPodUrlPure(opts: SubjectPodUrlOptions): string {
  const { tenantPodUrl, identity, explicit, safeUrl } = opts;
  // SSRF choke point: an explicit caller-supplied pod URL is honored ONLY when it is a public
  // http(s) target. A loopback/link-local/private literal (127.0.0.1, 169.254.169.254, 10.*,
  // internal hosts) is IGNORED — we fall through to deriving the pod from the identity — so a caller
  // cannot steer any server-side pod fetch at an internal address. (A public hostname that
  // DNS-resolves to a private IP is additionally caught by assertSafeFetchTarget right before each
  // delegation/credential fetch.)
  if (explicit) {
    const safe = safeUrl(explicit);
    if (safe) {
      // Canonicalize to a SINGLE-SEGMENT pod root <origin>/<firstSeg>/ — a pod is exactly one
      // segment under its origin. Returning a multi-segment override verbatim let a caller pass the
      // selfBoundPod last-segment actor check (…/eth-victim/eth-CALLER/) while a first-segment
      // consumer (void-credential's ownership check, the encryption-key write path) acted on a
      // DIFFERENT segment (eth-victim) — a cross-agent write/delete. Collapsing to the first segment
      // makes last==first, so the actor comparison and the consumers agree.
      try {
        const u = new URL(safe);
        const seg = u.pathname.split('/').filter(Boolean)[0];
        if (seg) return `${u.origin}/${seg}/`;
      } catch { /* fall through to identity derivation below */ }
    }
    // else: unsafe explicit target — ignore it and derive from the identity below.
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
  const idm = id.match(/(u-pk-|u-did-|u-eth-|eth-)[0-9a-z]+/i);
  if (idm && tenantOrigin) return `${tenantOrigin}/${idm[0].toLowerCase()}/`;
  if (/^https?:\/\//.test(id)) {
    try {
      const u = new URL(id);
      const seg = u.pathname.split('/').filter(Boolean)[0];
      if (seg) return `${u.origin}/${seg}/`;
    } catch { /* fall through */ }
  }
  // A did:ethr identity, or — ★★ — a BARE 0x address, which is what the signature layer actually
  // returns. Falling through to the shared tenant pod is the defect described at the top of this
  // file, so both spellings resolve through one branch and cannot diverge again.
  const addrHex = /^did:ethr:(?:0x)?([0-9a-fA-F]{40})\b/.exec(id)?.[1]
    ?? /^(?:0x)?([0-9a-fA-F]{40})$/.exec(id)?.[1];
  if (addrHex && tenantOrigin) return `${tenantOrigin}/eth-${addrHex.slice(0, 12).toLowerCase()}/`;
  return tenantPodUrl;
}
