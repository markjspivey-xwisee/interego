/**
 * Where a value sits in Turtle, which for the #168 fix is the whole question.
 *
 * The caller's `operator_did` IS published — dropping it would lose real information. What
 * must never happen is its promotion from a claim to an identity, and in Turtle that
 * distinction is positional: `agp:claimedOperator "did:ethr:0x…"` is a claim, while
 * `prov:wasAttributedTo <did:ethr:0x…>` is an assertion that the DID did something.
 *
 * A test asking only "does the DID appear?" cannot tell those apart, and answers yes to both.
 */

/** True when `needle` occurs inside angle brackets — i.e. in IRI position, not as a literal. */
export function asIri(turtle: string, needle: string): boolean {
  return turtle.split('<').slice(1).some(seg => {
    const close = seg.indexOf('>');
    return close !== -1 && seg.slice(0, close).includes(needle);
  });
}
