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
 * Lives outside server.ts because server.ts opens a listener on import, so nothing defined
 * inside it can be exercised by a test.
 */
import { canonicalGraphDigest, digestAlgorithmOf, GRAPH_DIGEST_ALGORITHM } from '@interego/core';
import { extractNamedGraphTurtle } from '@interego/solid';

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
  /** The graph IRI the descriptor's `iep:describes` names — which block to digest. */
  readonly graphIri: string | null | undefined;
}): string | undefined {
  const { graphContent, graphIri } = args;
  if (typeof graphContent !== 'string' || graphContent.length === 0) return undefined;
  if (typeof graphIri !== 'string' || graphIri.length === 0) return undefined;

  // The payload is served wrapped, with the descriptor's own triples in the same document.
  // Digesting it whole would fold the descriptor into the answer — and the descriptor
  // contains the proof, so the digest could never match anything the publisher computed.
  const graphOnly = extractNamedGraphTurtle(graphContent, graphIri);
  if (graphOnly === null) return undefined;

  return canonicalGraphDigest(graphOnly) ?? undefined;
}

/**
 * The `iep:describes` object of a descriptor — the graph IRI whose block carries the
 * payload. Read from the Turtle rather than reconstructed from the descriptor URL, because
 * the two are related only by the relay's naming convention and a descriptor is free to
 * describe a graph named some other way.
 */
export function graphIriFromDescriptorTurtle(turtle: string): string | null {
  // `iep:describes <IRI>` in the emitted descriptor; the legacy `cg:` alias is still on
  // pods written before the protocol rename, and refusing to read those would silently
  // downgrade every one of them to unverifiable.
  const m = turtle.match(/\b(?:iep|cg):describes\s+<([^>]+)>/);
  return m ? m[1]! : null;
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
