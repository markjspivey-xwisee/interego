/**
 * Does the proof on this descriptor cover the graph served beside it?
 *
 * ★ THE DEFECT THIS MODULE CLOSES. `publish_context{sign_authorship: true}` has committed a
 * `contentHash` into the signed payload since the proof stopped signing only a filename,
 * and the descriptor Turtle has carried it, and `get_descriptor` read it back — and then
 * called `verifySignedAuthorship(proof, verifier)` with no observed payload at all and
 * threw the answer away. The read path reported `authorshipVerified: true` on the strength
 * of a signature that had never been compared against a single byte of the graph it was
 * served with, which is a statement about a URL wearing the appearance of a statement
 * about a document.
 *
 * ★ WHY THE OBVIOUS FIX IS A REGRESSION. The digest cannot be recomputed by hashing what
 * the reader receives. `publish()` rewrites the payload through `wrapAsTriG` — hoisting the
 * caller's `@prefix` lines out of the graph block to document scope, indenting the body
 * four spaces, and interleaving the descriptor's own triples into the same document — so
 * the served bytes are never the signed bytes. A read path that compared them would have
 * failed EVERY honest content-bound proof and called it tampering. So the digest is taken
 * over the graph's TRIPLES, recovered from the served document by the inverse of the wrap,
 * which is stable across exactly the rewrites publishing performs and sensitive to the ones
 * that change meaning. `tests/authorship-content-binding.test.ts` pins the byte difference
 * and the triple agreement on the same payload.
 *
 * ★ AND THE SCOPE IS NOT THIS MODULE'S TO CHOOSE. The region a proof covers is decided once,
 * by `digestedGraphRegion` in @interego/solid, and every party that reads a payload goes
 * through it. When this module owned the decision privately, a reader in
 * `applications/shared-workspace` parsed the whole served document while this digested only
 * the named-graph block — so a forged `wsp:MembershipAcceptance` in the DEFAULT graph left
 * the digest byte-identical and manufactured a workspace participant out of a verbatim copy
 * of somebody else's honest record. A digest scope that only one side knows is not a scope.
 *
 * Lives outside server.ts because server.ts opens a listener on import, so nothing defined
 * inside it can be exercised by a test.
 */
import {
  canonicalGraphDigest,
  digestAlgorithmOf,
  GRAPH_DIGEST_ALGORITHM,
  type DescriptorBindingBasis,
} from '@interego/core';
import { digestedGraphRegion, graphIriFromDescriptorTurtle } from '@interego/solid';

/**
 * Re-exported, not redefined. It used to be declared here, which put it out of reach of the
 * only other party that needs it — a reader deciding which bytes of a served document it may
 * parse — and that reader consequently parsed all of them. It now lives beside `wrapAsTriG`
 * and `extractNamedGraphTurtle` in @interego/solid, and this re-export keeps the relay's
 * import surface unchanged.
 */
export { graphIriFromDescriptorTurtle };

/**
 * What `get_descriptor` publishes about content binding, kept as its own type so the
 * workspace layer consumes a named contract rather than pattern-matching a loose string.
 */
export type ReadContentBinding = 'bound' | 'mismatched' | 'declared' | 'unbound';

/**
 * Digest the graph a descriptor's proof should be covering, from the document actually
 * served — or `undefined` when it cannot be computed, which is NOT the same as a mismatch.
 *
 * `undefined` is returned for every "I could not look" case, and each is ordinary rather
 * than suspicious: a private payload the relay is not a recipient of decrypts to null; a
 * descriptor with no `dcat:accessURL` has no graph to fetch; a fetch or decrypt failure
 * leaves the caller holding nothing. The caller must render all of these as `'declared'`,
 * never as `'bound'` and never as tampering — a reader that cannot see the payload has
 * learned nothing about it, and both other answers would be inventions.
 */
export function observedGraphDigest(args: {
  /** Plaintext graph document as served (the TriG wrap), or null when unreadable. */
  readonly graphContent: string | null | undefined;
  /**
   * The descriptor Turtle served with it. Takes the TURTLE, not a pre-extracted graph IRI:
   * `digestedGraphRegion` derives the IRI itself, so the digester and every reader are
   * handed the same two strings and cannot disagree about which region is covered. Passing
   * the IRI separately is how the scopes came apart in the first place.
   */
  readonly descriptorTurtle: string | null | undefined;
}): string | undefined {
  // The payload is served wrapped, with the descriptor's own triples in the same document.
  // Digesting it whole would fold the descriptor into the answer — and the descriptor
  // contains the proof, so the digest could never match anything the publisher computed.
  const region = digestedGraphRegion(args);
  if (!region.ok) return undefined;

  return canonicalGraphDigest(region.turtle) ?? undefined;
}

/**
 * The pod root a descriptor URL sits in — `https://host/pod/` — or null.
 *
 * ★ EXTRACTED RATHER THAN COPIED, and the copy is the reason. This exact regex was inline in
 * `get_descriptor`, deriving the pod for the delegation-chain walk. The descriptor binding now
 * needs the same pod to ask who owns it, and a second spelling of "which pod is this" would
 * eventually disagree with the first — at which point the trust label and the binding verdict
 * would be about different pods while reading as if they were about one. One rule, both
 * callers.
 *
 * The `context-graphs/` segment is required, not optional: it is the layout `publish()`
 * produces, and matching without it would call the first path segment of ANY URL a pod.
 *
 * ★★ AND THE PATH IS RESOLVED BEFORE IT IS READ, WHICH THE INLINE REGEX DID NOT DO. Found
 * while building the live demonstration for this round: a regex anchored on the raw request
 * string reads the pod out of the text a caller typed, and `fetch` reads it out of the
 * RESOLVED path. So `…/alice-pod/context-graphs/../../mallory-pod/context-graphs/x.ttl`
 * fetches mallory's document while the regex reports alice's pod — which would hand a lifted
 * proof the one owner that makes it bind. `new URL` performs WHATWG dot-segment removal
 * (including the `%2e%2e` spellings), so the pod named here is the pod the bytes came from.
 */
export function podRootOfDescriptorUrl(url: string): string | null {
  if (typeof url !== 'string') return null;
  let u: URL;
  try { u = new URL(url); } catch { return null; }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
  const segments = u.pathname.split('/').filter(s => s.length > 0);
  if (segments.length < 3 || segments[1] !== 'context-graphs') return null;
  return `${u.origin}/${segments[0]!}/`;
}

/** What {@link makeServingPodOwnerReader} hands back and how long it may be reused. */
export interface PodOwnerReaderOptions {
  /**
   * Reads the pod's agent registry and returns the WebID it publishes as its owner, or null
   * when there is no registry there. Throwing is allowed and is treated as null.
   */
  readonly readOwner: (podUrl: string) => Promise<string | null>;
  /** Injected so a test can age the cache without sleeping. */
  readonly now?: () => number;
  readonly ttlMs?: number;
  readonly maxEntries?: number;
  /** Called with the reason a lookup produced nothing. Wired to the relay's `log`. */
  readonly onUnavailable?: (podUrl: string, reason: string) => void;
}

/**
 * "Who does the pod that served these bytes say it belongs to?", cached.
 *
 * ★ THIS IS THE EVIDENCE HALF OF THE DESCRIPTOR BINDING — see `ProofOwnerScope` in
 * @interego/core for what the comparison does with it and for the measurement that says the
 * refusal costs no honest read. The registry document is the same one `runScopeGate` consults
 * before letting anyone publish into that pod, so the binding is anchored on the substrate's
 * own notion of pod ownership rather than on a second, weaker one invented here.
 *
 * ★ EVERY FAILURE RETURNS NULL, AND NULL MEANS `unchecked`. A 404, a timeout, a pod on
 * infrastructure we do not run: all of them leave the binding exactly where it was before this
 * function existed (`slug-only`, bound). Failing closed on an unreachable registry would turn
 * a network blip into a wave of records reported as forgeries.
 *
 * ★ THE CACHE IS PER-READER, NOT MODULE STATE, so a test cannot inherit another test's answers
 * and so the TTL is exercisable. It caches the null too: without that, a pod with no registry
 * costs one fetch on EVERY descriptor read of it, which is the hot path this whole check sits
 * on. The cost of caching a null is bounded by the TTL and can never produce a refusal.
 */
export function makeServingPodOwnerReader(
  opts: PodOwnerReaderOptions,
): (podUrl: string) => Promise<string | null> {
  const now = opts.now ?? (() => Date.now());
  const ttlMs = opts.ttlMs ?? 5 * 60_000;
  const maxEntries = opts.maxEntries ?? 500;
  const cache = new Map<string, { owner: string | null; expiresAt: number }>();

  return async (podUrl: string): Promise<string | null> => {
    const hit = cache.get(podUrl);
    if (hit && hit.expiresAt > now()) return hit.owner;
    if (hit) cache.delete(podUrl);

    let owner: string | null = null;
    try {
      const read = await opts.readOwner(podUrl);
      owner = typeof read === 'string' && read.trim().length > 0 ? read.trim() : null;
      if (owner === null) opts.onUnavailable?.(podUrl, 'the pod publishes no owner WebID');
    } catch (err) {
      opts.onUnavailable?.(podUrl, `reading the pod's registry threw: ${(err as Error).message}`);
      owner = null;
    }

    if (cache.size >= maxEntries) {
      const oldest = cache.keys().next().value;
      if (oldest !== undefined) cache.delete(oldest);
    }
    cache.set(podUrl, { owner, expiresAt: now() + ttlMs });
    return owner;
  };
}

/**
 * Explain a content-binding outcome in the terms a reader has to act on.
 *
 * ★ `'declared'` GETS THE LONGEST SENTENCE ON PURPOSE. It is the value most likely to be
 * skimmed as a near-miss of `'bound'`, and it is the one that licenses nothing at all.
 *
 * ★ WHY `signatureVerified` IS A PARAMETER. `'unbound'`'s note used to end "It is not a
 * forgery" unconditionally, and `'unbound'` was also what a FAILED signature reported — so
 * the one case where forgery is live got the sentence exonerating it. A note about content
 * binding cannot assert anything about the signature unless it is told what the signature
 * did, so it is told. Defaults true because every caller that omits it is on a path where
 * the signature already verified.
 */
export function contentBindingNote(
  binding: ReadContentBinding,
  claimed?: string,
  signatureVerified = true,
): string {
  if (binding === 'bound') {
    return 'The signature covers this graph\'s content: the digest in the signed payload was '
      + 'recomputed over the payload served with this descriptor and matched. "Covers" means '
      + 'the graph STATES the same triples it was signed over — not that the bytes are '
      + 'identical, which they are not: the payload is rewritten when it is published.';
  }
  if (binding === 'mismatched') {
    return 'TAMPERING: the digest in the signed payload WAS recomputed over the payload '
      + 'served with this descriptor and did NOT match. The signature is authentic and it is '
      + 'a signature over different content, so the graph beside it has been altered since '
      + 'signing. This is evidence against the content, not an absence of evidence. Do not '
      + 'act on this record.';
  }
  if (binding === 'unbound') {
    const closing = signatureVerified
      ? 'On its own it is no evidence of forgery; it establishes who signed a URL and '
        + 'nothing about what is served there now.'
      : 'The signature on this proof did NOT verify, so it establishes nothing at all — '
        + 'not the signer, and not the content.';
    return 'The signature names this descriptor and does NOT cover its content — the proof '
      + 'carries no content digest, which is every proof written before content binding '
      + `existed and any payload the digester could not parse. ${closing}`;
  }
  const why = !signatureVerified
    ? 'the signature failed first, so the content was never reached'
    : claimed !== undefined && digestAlgorithmOf(claimed) !== GRAPH_DIGEST_ALGORITHM
      ? `the proof's digest is a \`${digestAlgorithmOf(claimed) ?? 'label-less'}\` form this `
        + 'verifier cannot recompute from a served document'
      : 'the payload could not be read here (encrypted to other recipients, absent, or '
        + 'unparseable)';
  return 'The proof commits to a content digest but NOTHING WAS CHECKED against it: '
    + `${why}. Treat this exactly as an unverified content claim — it is neither an `
    + 'attestation of the content nor evidence against it. A digest that WAS checked and '
    + 'failed is reported as `mismatched`, never here.';
}

/**
 * Is a verified signature enough to call this record authored?
 *
 * ★ THE DEFECT THIS CLOSES, AND WHY IT IS NOT THE CONTENT-BINDING ONE AGAIN. A proof block
 * is signed over its OWN fields — issuer, ownerWebId, descriptorId, created, contentHash —
 * so `verifySignedAuthorship` re-derives the payload from the block and checks the
 * signature against that. The computation is closed over the block and cannot fail because
 * of where the block sits. Measured live on build 7c9124a, before this function existed:
 * one public descriptor's bytes re-served at a URL its signer never named answered
 * `authorshipVerified: true`, `contentBinding: 'bound'`, naming that signer — every field a
 * consumer reads saying attested, and the one field that dissented,
 * `descriptorBinding.bound`, reported beside them and read by no branch.
 *
 * `contentBinding` is deliberately NOT folded into the verdict, and that is not this. It
 * REFINES a true statement — this signer signed this record, and here is what the signature
 * does and does not cover. `bound: false` FALSIFIES the statement.
 *
 * ★ THE GATE IS `bound`, NEVER `basis`, AND THE DIFFERENCE IS MEASURED — TWICE, because the
 * figures in this paragraph went stale the moment the binding got stronger and a stale
 * measurement quoted as a current one is how a true claim stops being checkable.
 *
 *   2026-08-03: 272 pods, 1,375 descriptors, 134 proofs — 134 `slug-only`, 0 `exact-url`,
 *               0 unbound. What it established: refusing on `bound === false` refuses
 *               nothing live, and demanding `exact-url` would refuse all 134.
 *   2026-08-04: 278 pods, 2,314 descriptors, 633 proofs on 13 pods — still 633 `slug-only`
 *               and 0 `exact-url`, and every one of the 13 pods publishes a registry owner
 *               EXACTLY equal to the `iep:ownerWebId` its proofs sign. That is what let the
 *               URN branch start comparing the owner (`slug-and-owner`) and REFUSING a
 *               disagreement: 633 of 633 honest proofs PREDICTED to keep binding, 0 to lose it.
 *   2026-08-05: the same 633 descriptors re-read against the DEPLOYED build carrying the
 *               refusal — 633 `slug-and-owner`, 633 `authorshipVerified: true`, 0 refused.
 *               The prediction is now an observation, and the two are listed apart because
 *               a figure derived from a comparison and a figure read off the running system
 *               are different kinds of claim; this file has shipped the first wearing the
 *               clothes of the second before.
 *
 * Both tightenings that look equally reasonable from here are still refused, and now for a
 * measured reason rather than a cautious one: demanding `exact-url` refuses all 633, and
 * demanding the delegation chain refuses 605 of them (only 28 reach
 * `CryptographicallyVerified`). That is the fail-closed-on-honest-data direction this area
 * has already shipped once.
 *
 * ★ THE REASON DOES NOT ACCUSE. `bound: false` has readings that are not forgeries: a
 * publisher that names its descriptors some other way reaches it too (the PGSL-primary
 * projection writes `holon-<hash>.ttl`). Stating forgery as fact in the one channel
 * operators are told to watch is how a true report stops being believed, so this withholds
 * the attestation and names both readings.
 *
 * Lives here, not in server.ts, for the reason at the top of this file: server.ts opens a
 * listener on import, so a decision declared there can only ever be pinned by a regex over
 * its own source. This one can be executed.
 */
export function authorshipVerdict(args: {
  /** What `verifySignedAuthorship` decided about the SIGNATURE alone. */
  readonly signatureValid: boolean;
  /** Its own diagnostic, used verbatim when the signature is what failed. */
  readonly signatureReason?: string;
  /** The relay's `{bound, basis, note}`, built from `proofBindsToDescriptorUrl`. */
  readonly descriptorBinding: {
    readonly bound: boolean;
    readonly basis: DescriptorBindingBasis;
    readonly note?: string;
  };
}): { readonly verified: boolean; readonly reason?: string } {
  // Signature first: when it failed, nothing was established about the signer, and the
  // binding diagnostic would mislead by implying the signature had been reached.
  if (!args.signatureValid) {
    return { verified: false, reason: args.signatureReason ?? 'verification returned false' };
  }
  if (!args.descriptorBinding.bound) {
    return {
      verified: false,
      reason:
        'the authorship proof\'s signature is intact, but the proof is not about this '
        + 'record: '
        + (args.descriptorBinding.note
          ?? 'it does not name the URL this document was served from')
        + '. A proof block is signed over its own fields, so it verifies wherever it is '
        + 'pasted; this says only that it was not written for the document served here. '
        + 'Two readings fit — a proof lifted off another record, or a publisher that names '
        + 'its descriptors some other way — and this layer cannot tell which, so it '
        + 'withholds the attestation rather than naming a forger.',
    };
  }
  return { verified: true };
}
