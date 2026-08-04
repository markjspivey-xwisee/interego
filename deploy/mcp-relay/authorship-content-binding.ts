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
 * ★ THE GATE IS `bound`, NEVER `basis`, AND THE DIFFERENCE IS MEASURED. Every descriptor_id
 * the substrate mints is a `urn:`, which can only ever bind `slug-only`. A sweep of 272
 * live pods on 2026-08-03 read 1,375 descriptors; 134 carried a proof; 134 bound
 * `slug-only`, 0 bound `exact-url`, 0 were unbound. So refusing on `bound === false`
 * refuses nothing that is live, and the obvious tightening — demanding `exact-url` —
 * refuses all 134 honest records. That is the fail-closed-on-honest-data direction this
 * area has already shipped once.
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
