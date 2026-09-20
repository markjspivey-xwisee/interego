/**
 * IRI references for emitted Turtle, built without raw dollar-brace interpolation inside an
 * IRI reference. Delegates to the substrate's own `turtleIriRef` (packages/core/src/rdf/escape.ts)
 * so this vertical shares the one injection guard the repo's Turtle IRI ratchet trusts.
 */

import { turtleIriRef as coreTurtleIriRef } from '@interego/core';

/** `<value>` when the value is a usable absolute IRI reference, else null. */
export function turtleIriRef(value: unknown): string | null {
  return coreTurtleIriRef(value);
}

/** `<value>`, or throw: for values the code itself minted, where a refusal is a programming error. */
export function iriRef(value: string): string {
  const ref = coreTurtleIriRef(value);
  if (ref === null) throw new TypeError(`not a usable IRI reference: ${JSON.stringify(value).slice(0, 120)}`);
  return ref;
}

/** True when a caller-supplied value may be used as an IRI (request validation). */
export function isIri(value: unknown): value is string {
  return coreTurtleIriRef(value) !== null;
}
