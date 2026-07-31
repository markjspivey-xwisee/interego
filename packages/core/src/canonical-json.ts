/**
 * Deterministic JSON for content-addressing.
 *
 * ★ WHY THIS IS A SHARED MODULE. Three call sites independently needed "hash this
 * object to a stable id", and all three reached for the same wrong idiom:
 *
 *     JSON.stringify(obj, Object.keys(obj).sort())
 *
 * That reads as "stringify with sorted keys". It is not. `JSON.stringify`'s second
 * argument is the REPLACER, and an array there is an allow-list of property names
 * applied RECURSIVELY AT EVERY DEPTH — it does not sort anything. Only the top-level
 * key names survive; every nested object is emptied to `{}`.
 *
 * Measured against the live relay before the fix, three descriptors differing only in
 * their single facet — a Temporal facet, a Trust facet naming a different issuer, and
 * an AccessControl facet granting public read to `*` — all minted to the SAME id:
 *
 *     urn:iep:descriptor:eb25ebe8cf199176ca63bc846892924b357667cb
 *
 * In a substrate whose first invariant is identity-by-reference, that is the dangerous
 * direction of collision: not "same content, different id" but DIFFERENT CONTENT, SAME
 * ID. An access-control claim became indistinguishable from a temporal one.
 *
 * The other two sites keyed durable, published IRIs that drive auto-supersede
 * (`urn:owm:policy:…`, `urn:lpc:credential-template:…`), so the collision silently
 * superseded unrelated records.
 *
 * ★ The correct implementation already existed as a private function inside
 * packages/core/src/kernel/index.ts — used by the ATOM path, with a comment warning
 * about precisely this collision class — fifty lines above the descriptor branch that
 * did not use it. It is exported here so a fourth copy cannot drift and a fourth site
 * cannot re-derive the broken idiom.
 */

/**
 * Serialize `v` to JSON with object keys sorted recursively, so two structurally equal
 * values always produce the same string and therefore the same content-address.
 *
 * Array ORDER is preserved — arrays are sequences, and reordering one is a different
 * value. Only object key order, which carries no meaning, is normalized.
 *
 * `undefined`, functions and symbols follow `JSON.stringify` semantics: dropped from
 * objects, rendered as `null` inside arrays. Callers that must distinguish an absent
 * key from an explicit `undefined` should normalize before hashing.
 */
export function canonicalJson(v: unknown): string {
  if (v === null || typeof v !== 'object') return JSON.stringify(v) ?? 'null';
  if (Array.isArray(v)) return `[${v.map(canonicalJson).join(',')}]`;
  const o = v as Record<string, unknown>;
  const keys = Object.keys(o).sort();
  const parts: string[] = [];
  for (const k of keys) {
    // Match JSON.stringify: a key whose value is undefined is omitted entirely,
    // rather than emitted as the literal `undefined` (which is not valid JSON).
    if (o[k] === undefined) continue;
    parts.push(`${JSON.stringify(k)}:${canonicalJson(o[k])}`);
  }
  return `{${parts.join(',')}}`;
}
