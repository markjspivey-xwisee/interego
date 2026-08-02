/**
 * A digest of what a graph SAYS, stable across how it is written down.
 *
 * ★ WHY THIS EXISTS RATHER THAN `sha256(bytes)`. An authorship proof is signed over the
 * caller's inbound Turtle, but a reader never receives those bytes. `publish()` rewrites
 * the payload through `wrapAsTriG`: caller `@prefix` lines are hoisted out of the graph
 * block to document scope, every body line outside a long literal is re-indented four
 * spaces, and the descriptor's own triples share the document. A read path that hashed the
 * served bytes and compared would report EVERY content-bound proof as a forgery — a check
 * that fails closed on honest data is worse than no check, because it trains its operators
 * to ignore it. `deploy/mcp-relay/tests/authorship-content-binding.test.ts` measures both
 * halves on one payload: the served bytes differ from the signed bytes, and the triples do
 * not.
 *
 * Hashing the triples instead of the characters is what makes both sides agree: prefix
 * hoisting, re-indentation and reflow are serialization changes that leave the triple set
 * identical, so the digest is unmoved. Rebinding a prefix to a different namespace is NOT
 * a serialization change — it changes which IRI every abbreviated term denotes — and that
 * moves the digest, which is the behaviour a content binding has to have.
 */
import { createHash } from 'node:crypto';
import { parseTrig } from './turtle-parser.js';

/**
 * Algorithm label carried in the digest string. Present so a verifier can tell "a digest I
 * know how to recompute" from "a digest I do not", instead of comparing two opaque hex
 * strings that were never produced the same way and calling the difference tampering.
 * Proofs written before this module exist carry a bare `sha256:` over the raw inbound
 * bytes; nothing can recompute those from a served document, and they must degrade to
 * "declared, unchecked" rather than to "forged".
 */
export const GRAPH_DIGEST_ALGORITHM = 'graph-nquads-sha256';

/**
 * The algorithm label of a `<algorithm>:<hex>` digest, or null when it carries none.
 * Splits on the FIRST colon only: the hex tail never contains one, and an unrecognised
 * label must come back intact rather than be silently coerced into a known one.
 */
export function digestAlgorithmOf(digest: string | undefined): string | null {
  if (typeof digest !== 'string' || digest.length === 0) return null;
  const i = digest.indexOf(':');
  return i <= 0 ? null : digest.slice(0, i);
}

/**
 * Canonical, order-independent line form of the triples in `turtle`.
 *
 * Sorted, so two documents that state the same triples in different order agree. Terms are
 * written in N-Triples form with the prefix already expanded by the parser, so the digest
 * depends on the IRIs a document denotes rather than on the aliases it happens to use.
 *
 * ★ BLANK NODES ARE NOT CANONICALLY RELABELLED (no URDNA2015), AND THAT IS A REAL LIMIT.
 * They carry the parser's own `_:` labels, assigned in document order. `wrapAsTriG`
 * preserves the order of every non-directive line, so publisher and reader label the same
 * statements the same way and agree — which is what makes the digest usable today. It is
 * still weaker than dataset canonicalisation: reordering two blank-node statements leaves
 * the graph unchanged and moves the digest.
 *
 * That direction only ever refuses a proof, never admits one — but do NOT read "refuses"
 * as "harmless". `verifySignedAuthorship` reports a same-algorithm mismatch as
 * `contentBinding: 'mismatched'` with `valid: false`, narrated to readers as tampering, so
 * a re-serialisation that reorders blank-node statements would be ACCUSED, not merely left
 * unattested. Nothing in the substrate reorders them today; a publisher that starts to must
 * bring canonical relabelling with it.
 */
export function canonicalGraphTriples(turtle: string): string {
  const doc = parseTrig(turtle);
  const lines: string[] = [];
  for (const subject of doc.subjects) {
    const s = typeof subject.subject === 'string'
      ? `<${subject.subject}>`
      : `_:${subject.subject.bnode}`;
    for (const [predicate, terms] of subject.properties) {
      for (const term of terms) {
        let o: string;
        if (term.kind === 'iri') {
          o = `<${term.iri}>`;
        } else if (term.kind === 'bnode') {
          o = `_:${term.id}`;
        } else {
          // Datatype and language are part of the term's identity — a plain "5" and
          // "5"^^xsd:integer are different objects, and a digest that conflated them would
          // let one be swapped for the other under a still-valid signature.
          const suffix = term.datatype
            ? `^^<${term.datatype}>`
            : term.language ? `@${term.language}` : '';
          o = `${JSON.stringify(term.value)}${suffix}`;
        }
        lines.push(`${s} <${predicate}> ${o} .`);
      }
    }
  }
  return lines.sort().join('\n');
}

/**
 * The digest, or the reason there is none.
 *
 * ★ WHY THE REASON HAD TO BECOME A RETURN VALUE. `canonicalGraphDigest` swallowed every
 * throw into `null`, and `handlePublishContext` spells that `?? undefined` — so a payload
 * this parser could not read got signed with NO content binding, its proof reports
 * `contentBinding: 'unbound'` for the rest of its life, and a reader is told the proof
 * merely "predates content binding". Nobody was told otherwise, least of all the publisher,
 * who was standing right there holding the payload and could have fixed it.
 *
 * That silence was not confined to legacy data. `'''…'''` literals and SPARQL-style `PREFIX`
 * headers are ordinary valid Turtle and BOTH threw here until the tokeniser was taught them
 * (see turtle-parser.ts). The tokeniser fix removes those two shapes; it cannot remove the
 * class. Annotation syntax `{| |}`, `@base`-relative IRIs — everything this deliberately
 * narrow parser does not implement lands in the same place, and the next one has to arrive
 * as a NAMED refusal an operator can act on rather than as a proof that quietly attests
 * nothing.
 *
 * The reason carries the parser's own message, byte offset included, because "which shape
 * defeated it" is a question about a position in one specific document and no generic label
 * answers it.
 */
export type GraphDigestResult =
  | { readonly digest: string; readonly reason?: undefined }
  | { readonly digest: null; readonly reason: string };

export function canonicalGraphDigestResult(turtle: string): GraphDigestResult {
  let canonical: string;
  try {
    canonical = canonicalGraphTriples(turtle);
  } catch (err) {
    return {
      digest: null,
      reason:
        'the payload did not parse as Turtle/TriG in this build, so NO content digest was '
        + 'computed — an authorship proof signed over it carries no content binding and will '
        + 'report contentBinding "unbound" permanently, which readers are told means the '
        + `proof predates content binding: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
  return {
    digest: `${GRAPH_DIGEST_ALGORITHM}:${createHash('sha256').update(canonical, 'utf8').digest('hex')}`,
  };
}

/**
 * `graph-nquads-sha256:<hex>` over the triples of `turtle`, or null when it does not parse.
 *
 * ★ NULL IS NOT ZERO. An unparseable payload returns null so the caller reports "I could
 * not check this" rather than hashing the empty string — which would produce a real-looking
 * digest that every other unparseable payload also produces, and make two different broken
 * documents verify against each other.
 *
 * Kept as the plain form for the READ path, where a reason has nowhere useful to go: the
 * reader did not write the payload and cannot repair it, and `contentBindingNote` already
 * narrates "could not be read here". On the WRITE path use
 * {@link canonicalGraphDigestResult} — there the publisher can act on the reason, and
 * discarding it is what let unparseable payloads sign themselves into permanent `unbound`.
 */
export function canonicalGraphDigest(turtle: string): string | null {
  return canonicalGraphDigestResult(turtle).digest;
}
