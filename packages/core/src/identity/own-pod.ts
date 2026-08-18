/**
 * Which pod segment an identity's OWN pod lives at.
 *
 * ── ★★ ONE FACT, PREVIOUSLY DERIVED IN FOUR PLACES ACROSS TWO LAYERS ────────────────────────
 *
 * "The pod belonging to this identity" is a substrate fact — every vertical and the relay need it,
 * and each had written it out again. A system audit found the copies AGREE on the canonical
 * `did:ethr:0x<40 hex>` spelling and DIVERGE on exactly the spellings the signature layer actually
 * emits: a bare address, a `did:ethr:` without the `0x`, an identity with an embedded pod id. That
 * is the worse kind of divergence — invisible in every test written against the canonical form, and
 * live wherever the recovered value takes another shape.
 *
 * The cost of getting it wrong is not cosmetic: the resolver this was extracted from used to fall
 * through to the SHARED TENANT POD for an identity form it did not recognise, so every agent that
 * enrolled itself enrolled the tenant pod and was told it had succeeded. Returning `null` here
 * rather than a fallback is deliberate — a caller must decide what an unresolvable identity means,
 * because "I could not tell whose pod this is" and "it is the default pod" are different answers and
 * only one of them is ever safe.
 *
 * ★ WHAT IS DELIBERATELY *NOT* UNIFIED. The relay's `resolveNotifyTarget` looks like a fifth copy
 * and is not: it resolves a DELIVERY target, passes external URLs through untouched as best-effort,
 * and returns undefined rather than falling back. Folding it in would change notify_agent's
 * behaviour for non-Interego recipients. It shares this derivation for the identity branch and keeps
 * its own contract — a capability only one caller needs does not belong lower.
 */

/** An identity carrying a pod id, in any spelling the substrate emits. */
const EMBEDDED_POD_ID = /(u-pk-|u-did-|u-eth-|eth-)[0-9a-z]+/i;
/** `did:ethr:` with or without the `0x`, or a bare 40-hex address. */
const DID_ETHR = /^did:ethr:(?:0x)?([0-9a-fA-F]{40})\b/;
const BARE_ADDRESS = /^(?:0x)?([0-9a-fA-F]{40})$/;

/**
 * The pod segment for `identity` (`eth-<12 hex>`, `u-pk-…`, …), or `null` when the identity carries
 * nothing to derive one from.
 *
 * ★ The embedded-id branch is checked FIRST so an identity-service WebID like
 * `…/users/u-pk-abc/profile` resolves to the agent id and not to `users`.
 */
export function ownPodSegment(identity: string | undefined | null): string | null {
  const id = (identity ?? '').trim();
  if (!id) return null;
  const embedded = EMBEDDED_POD_ID.exec(id);
  if (embedded) return embedded[0].toLowerCase();
  const hex = DID_ETHR.exec(id)?.[1] ?? BARE_ADDRESS.exec(id)?.[1];
  if (hex) return `eth-${hex.slice(0, 12).toLowerCase()}`;
  return null;
}

/**
 * The pod segment for an already-recovered Ethereum address (`0x…`).
 *
 * A thin alias so the two relay sites that had `` `eth-${addr.slice(2, 14)}` `` inline stop
 * re-deriving it — that expression is correct only for a `0x`-prefixed, lowercased address, and
 * nothing at either site enforced either property.
 */
export function ownPodSegmentForAddress(address: string): string | null {
  return ownPodSegment(address);
}
