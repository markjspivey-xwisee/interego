/**
 * A composition, named the ways a person or an agent might hand one over: its IRI on any authority
 * (`https://<host>/ns/foxxi/composition/<sha256>`), a link under that IRI (its efficacy, its cmi5
 * course structure, its SCORM package, its player page), this portal's own link to it
 * (`…/learn/<sha256>`), or the bare hash.
 *
 * Content is named by its hash, so each of these names the same composition on whichever bridge
 * this portal talks to. Whether that bridge holds it is for the bridge to say.
 */

const HASH = /^[0-9a-f]{64}$/;

export type CompositionRef = { hash: string } | { why: string };

/** The composition a pasted text names, or why it names none. */
export function compositionRefFrom(input: string): CompositionRef {
  const text = input.trim();
  if (!text) return { why: 'Paste a composition\'s link, IRI or hash.' };
  if (HASH.test(text.toLowerCase())) return { hash: text.toLowerCase() };
  let path: string;
  try { path = new URL(text).pathname; } catch { return { why: 'That is not a composition\'s link, IRI or hash.' }; }
  const named = /\/ns\/foxxi\/composition\/([0-9a-f]{64})(?:\/[^/]+)?\/?$/.exec(path) ?? /\/learn\/([0-9a-f]{64})\/?$/.exec(path);
  if (named?.[1]) return { hash: named[1] };
  if (/\/ns\/foxxi\/fragment\/[0-9a-f]{64}/.test(path)) {
    return { why: 'That names a fragment, not a composition. A fragment is played as a step of a composition that holds it.' };
  }
  return { why: 'That link names no composition.' };
}

/** A composition's IRI on the bridge at `origin`. */
export function compositionIriOn(origin: string, hash: string): string {
  return `${origin.replace(/\/+$/, '')}/ns/foxxi/composition/${hash}`;
}

/** The hash a composition IRI carries, on any authority, or undefined. */
export function hashOfComposition(iri: string): string | undefined {
  return /^https?:\/\/[^/?#]+\/ns\/foxxi\/composition\/([0-9a-f]{64})$/.exec(iri)?.[1];
}
