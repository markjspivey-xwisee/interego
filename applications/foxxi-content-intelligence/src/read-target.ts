/**
 * WHOSE RECORD AM I ASKING FOR — a different question from WHOSE POD AM I.
 *
 * ── ★★ ONE FIELD WAS ANSWERING BOTH, SO THE SECOND QUESTION COULD NOT BE ASKED ──────────────
 *
 * `subject_pod_url` began as the read target. Then the relay's `sign_request` began STAMPING it
 * from the caller's own session — correctly, because every WRITE site binds to it, and a caller
 * who can name the pod a write lands in can write into somebody else's record. That stamp is a
 * load-bearing part of the authority model and it stays.
 *
 * But the same field was also what a READ path consulted to decide which pod to read. So on the
 * relay route — the route every relay-mediated agent actually has — the read target silently became
 * "your own pod", whatever `subject_did` said. The handler then answered: subject = the DID you
 * asked about, data = your own records. Not an error, not a refusal; a well-formed answer to a
 * question nobody asked. Cross-subject reads were advertised, and could not happen.
 *
 * ★ THE UNAUTHENTICATED ROUTE IS THE ONE THAT GETS IT RIGHT. `GET /agent/:did/affordances` takes no
 * pod at all: it DERIVES the pod from the identity and asserts the result is in its own pod space.
 * Having no signature to lean on forced the honest design. The signed routes accepted a caller's pod
 * because a valid signature felt like enough authority — and a signature says who is asking, never
 * whose pod they may name.
 *
 * So the two questions are separated here:
 *
 *   whose pod am I          — the SIGNER's pod. Relay-stamped, or derived from the recovered key.
 *                             Authoritative. Never a read target.
 *   whose record am I asking for — DERIVED from the subject's identity, exactly as the unauthenticated
 *                             route does. A caller may NAME a pod instead, but that name carries no
 *                             authority: it is honoured only inside this deployment's own pod space,
 *                             and it is refused out loud rather than quietly replaced.
 *
 * `isSelf` is then what it always meant and could not previously compute: these two reduce to the
 * same principal. The privacy gate downstream is unchanged and still decides what a non-self reader
 * may see — this module only decides WHICH pod is read, and says why.
 *
 * ★ AND IT REFUSES RATHER THAN FALLS BACK. Every silent fallback on this path has cost us a bug that
 * survived because the caller got a plausible answer: the shared-tenant-pod default that enrolled
 * everyone onto one pod, the discarded pod override that returned the right pod for the wrong
 * reason. A read target that cannot be resolved is an error with the reason in it.
 */

/** How the read target was arrived at — reported to the caller so a surprising answer is legible. */
export type ReadTargetBasis = 'caller' | 'subject-identity' | 'named-pod';

export type ReadTargetDecision =
  | {
    readonly ok: true;
    readonly podUrl: string;
    readonly isSelf: boolean;
    readonly basis: ReadTargetBasis;
    /** Another pod of the same principal that this deployment also reads — see otherPodForPrincipal. */
    readonly alsoHeld?: string;
  }
  | { readonly ok: false; readonly error: string };

export interface ReadTargetInput {
  /** WHOSE POD AM I: the pod bound to the signer. Authoritative; never a read target by itself. */
  readonly callerPodUrl: string;
  /** Did the caller name a subject at all (`subject_did` / `learner_did`)? If not, this is a self-read. */
  readonly subjectIdentityGiven: boolean;
  /** The pod derived from the subject's identity ALONE — no caller-supplied pod anywhere in it. */
  readonly subjectPodUrl: string;
  /** What the caller literally named as a read target, for the diagnostic. Undefined if it named none. */
  readonly namedAs?: string | undefined;
  /**
   * That name resolved to a pod root — or undefined when it was rejected as an unsafe fetch target.
   * The distinction matters: an unsafe name must be REFUSED, not quietly turned into the derived pod.
   */
  readonly namedPodUrl?: string | undefined;
  /** The shared tenant pod. It is nobody's subject, so resolving TO it means nothing resolved. */
  readonly tenantPodUrl: string;
  /** Is this pod in the pod space this deployment reads? The bound on a caller-named target. */
  readonly inPodSpace: (podUrl: string) => boolean;
  /** Do two pod URLs name the same principal? (Folds this store's twin spellings.) */
  readonly samePrincipal: (a: string, b: string) => boolean;
  /**
   * ★★ THE OTHER POD THIS PRINCIPAL HOLDS — REPORTED, NEVER SUBSTITUTED.
   *
   * One wallet has two pods here: `eth-<12hex>`, which a bare `did:ethr:` derives, and
   * `u-eth-<12hex>`, which the identity service creates. Both can exist and both can hold records,
   * because which one a write lands in depends on which identity form the writer presented.
   *
   * ★ I TRIED SUBSTITUTION FIRST AND IT WAS WRONG WITHIN THE HOUR. The rule was "read whichever
   * spelling the enrolment register knows", which is right for a relay-mediated agent whose work
   * really is in the `u-` twin — and I then enrolled my `u-` pod while every record I had was in
   * the other one, so the same rule would have answered my own review with somebody's empty pod.
   * A heuristic that picks between two real pods is wrong in one direction or the other and gives
   * no sign which time it is.
   *
   * So the target is exactly what was derived or named, and this only supplies a POINTER: another
   * pod, in the set this deployment reads, whose principal is the same and which is not the one
   * being read. An empty answer names it, and `read_pod_url` is how a caller acts on that. Nothing
   * is guessed and nothing is hidden.
   */
  readonly otherPodForPrincipal: (podUrl: string) => string | undefined;
}

export function resolveReadTarget(input: ReadTargetInput): ReadTargetDecision {
  const { callerPodUrl, subjectIdentityGiven, subjectPodUrl, namedAs, namedPodUrl, tenantPodUrl, inPodSpace, samePrincipal, otherPodForPrincipal } = input;

  let podUrl: string;
  let basis: ReadTargetBasis;

  if (namedAs) {
    // ★ An unsafe name is an ERROR. `resolveSubjectPodUrlPure` drops one and derives from the
    // identity instead, which is the right SSRF behaviour and the wrong reporting behaviour: the
    // caller asked to read pod A, was given pod B, and had no way to find out.
    if (!namedPodUrl) {
      return { ok: false, error: `the pod you named (${namedAs}) is not a safe public target, so it was not read — name a pod on this deployment's own store, or omit it and let the subject's identity resolve its pod` };
    }
    // The name carries no authority. It selects among pods this deployment already reads; it can
    // never point a server-side read at a host of the caller's choosing.
    if (!inPodSpace(namedPodUrl)) {
      return { ok: false, error: `the pod you named (${namedAs}) is outside the pod space this deployment reads — a named pod selects among pods here, it does not authorise a read anywhere else` };
    }
    podUrl = namedPodUrl;
    basis = 'named-pod';
  } else {
    podUrl = subjectPodUrl;
    basis = subjectIdentityGiven ? 'subject-identity' : 'caller';
  }

  /**
   * ── ★★ THE POD THAT WAS READ AND THE SUBJECT THAT GETS NAMED MUST BE ONE PRINCIPAL ──────────
   *
   * MEASURED LIVE by a delegate auditing this very split before it shipped. It signed a review with
   * `subject_did` set to `did:ethr:0x…dEaD` — an address that cannot have a pod, a wallet or a
   * history — and got HTTP 200 with its OWN 750 records, its own pod, its own lens, `self: true`,
   * and `learner.did: did:ethr:0x…dEaD`. The identity was passed straight through to the subject of
   * a document that conforms to IEEE P2997 and asserts nothing about the party it names.
   *
   * ★ IT IS THE MIRROR OF THE BYPASS THIS FILE FIXES, NOT THE SAME ONE. In the leak, identity
   * decided and the data came from elsewhere, so a caller read someone else's record under its own
   * name. Here the data decides correctly and the identity is unreconciled, so a caller MINTS a
   * record in someone else's name out of its own history. Nothing leaks; a credential-shaped
   * artifact simply says on its face that a party with almost no work has 750 performance records.
   * The delegate's words for it: "the way it fails is by succeeding."
   *
   * So there is one assertion, and it covers every route into this function: whoever the answer
   * NAMES must be the principal whose pod was READ. Deriving the pod from the identity satisfies it
   * for free; naming a pod, or naming no subject while naming somebody else's pod, does not.
   */
  if (!samePrincipal(podUrl, subjectPodUrl)) {
    return { ok: false, error: `the subject named and the pod read are different principals (${subjectPodUrl} vs ${podUrl}) — a record that names one party and reports another's work is an attribution, not a record. Name the subject whose pod you are reading, or omit the pod and let the subject's identity resolve it.` };
  }

  const isSelf = samePrincipal(podUrl, callerPodUrl);

  // Nothing resolved: the identity form was not one we can map to a pod, and the resolver's
  // last-resort answer is the SHARED tenant pod. Reading it would answer a question about one
  // subject with a store belonging to everybody.
  if (!isSelf && samePrincipal(podUrl, tenantPodUrl)) {
    return { ok: false, error: 'that identity does not resolve to a pod of its own, and the fallback is the shared tenant pod — which is nobody\'s record. Name the pod explicitly if the subject holds one here.' };
  }

  if (!inPodSpace(podUrl)) {
    return { ok: false, error: `that subject's pod resolves outside the pod space this deployment reads (${podUrl}) — records here are read only from pods on this store` };
  }

  const alsoHeld = otherPodForPrincipal(podUrl);
  return { ok: true, podUrl, isSelf, basis, ...(alsoHeld ? { alsoHeld } : {}) };
}
