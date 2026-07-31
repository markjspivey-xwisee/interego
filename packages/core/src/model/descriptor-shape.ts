/**
 * Is this actually a Context Descriptor?
 *
 * ★ WHY THIS EXISTS. `mint(kind:'descriptor')` accepted literally any value, hashed it,
 * and handed back an IRI. `compose()` then required a well-formed `ContextDescriptorData`
 * and spread `data.facets`, so a caller who passed anything else — including the IRI that
 * `mint` had just given them — got this back, verbatim, as their tool result:
 *
 *     Error: facets is not iterable
 *
 * That is a raw JS TypeError leaking through an API boundary. It names an internal field,
 * says nothing about what was expected, and is indistinguishable from the substrate being
 * broken. Two separate faults compounded: nothing validated at the point where a bad value
 * ENTERED, and the failure surfaced far away from the mistake.
 *
 * A refusal should say what was wanted. That is all this module does.
 */
import type { ContextDescriptorData } from './types.js';

/**
 * Returns a human-readable problem description, or `null` if `v` is shaped like a
 * `ContextDescriptorData`.
 *
 * Structural only — it does not validate facet internals, because facet types are an open
 * extension point and an unknown facet is legal.
 */
export function descriptorProblem(v: unknown, label = 'descriptor'): string | null {
  if (typeof v === 'string') {
    // The most common mistake by far, because mint(kind:'descriptor') hands back an IRI
    // and it is entirely reasonable to assume that IRI is what you pass on. It is not:
    // descriptors are not stored anywhere, so nothing can resolve one back.
    return `${label} must be a descriptor OBJECT, not an IRI string. Descriptor operations `
      + `take the descriptor's data, not a reference to it — pass `
      + `{ id, describes: [...], facets: [...] }. `
      + `(Received: ${JSON.stringify(v.slice(0, 80))})`;
  }
  if (v === null || typeof v !== 'object' || Array.isArray(v)) {
    return `${label} must be an object with { id, describes, facets }. `
      + `(Received: ${Array.isArray(v) ? 'an array' : v === null ? 'null' : typeof v})`;
  }
  const o = v as Record<string, unknown>;
  const missing: string[] = [];
  if (typeof o['id'] !== 'string' || !o['id']) missing.push('id (an IRI string)');
  if (!Array.isArray(o['describes'])) missing.push('describes (an array of graph IRIs)');
  if (!Array.isArray(o['facets'])) {
    missing.push(o['facets'] === undefined
      ? 'facets (an array of facet objects)'
      : `facets (an ARRAY of facet objects — received ${
          Array.isArray(o['facets']) ? 'an array' : typeof o['facets']})`);
  }
  if (missing.length === 0) return null;
  return `${label} is missing or malformed: ${missing.join(', ')}.`;
}

/** Throwing form, for call sites that cannot return a refusal. */
export function assertDescriptor(v: unknown, label = 'descriptor'): asserts v is ContextDescriptorData {
  const problem = descriptorProblem(v, label);
  if (problem) throw new TypeError(problem);
}
