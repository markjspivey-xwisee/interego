/**
 * Following a page's own advertised Turtle representation.
 *
 * ★ WHY THIS IS ITS OWN MODULE. Our ontology IRIs do not content-negotiate: GitHub Pages
 * ignores Accept and serves `text/html` for `https://…/ns/iep`. That bit the publish path
 * three separate times — a good shape looked unreachable, an `owl:imports` of one corrupted
 * the graph it was glued into, and last-known-good had to distrust any body that did not
 * parse.
 *
 * These two predicates are the fragile part of the fix (regexes over untrusted markup), so
 * they live apart from `server.ts`, which starts an HTTP listener on import and therefore
 * cannot be pulled into a unit test.
 */

/**
 * A body is HTML if it OPENS as HTML. Leading whitespace, a BOM, and a leading comment are
 * tolerated.
 *
 * ★ The dangerous direction here is a false positive, not a false negative: Turtle is full
 * of angle brackets (`<https://…> a <…> .`), and a loose predicate would send a perfectly
 * good shape down the HTML path and drop it. Hence an explicit HTML opener rather than
 * "starts with `<`".
 */
export function looksLikeHtml(body: string): boolean {
  return /^﻿?\s*<(?:!doctype\s+html|html[\s>]|!--)/i.test(body);
}

/**
 * The Turtle representation a page advertises for itself, or null.
 *
 * The reflex fix for a non-negotiating IRI is to append `.ttl`. That reinvents a mechanism
 * that already exists AND is already published — every generated page in `docs/ns` carries
 * its own `<link rel="alternate" type="text/turtle">`. The publishing side was already
 * standards-correct; we simply were not reading it. Following the advertised link works for
 * ANY publisher that does the same thing, where guessing an extension only ever works for
 * ours.
 *
 * ★ `rel` and `type` are matched independently inside one tag rather than in a fixed
 * sequence: HTML does not fix attribute order, and an ordered rel-then-type regex passes a
 * hand-written test while missing real markup that spells the attributes the other way.
 *
 * Only `alternate` and `describedby` qualify. `rel=preload` also names a Turtle file, but it
 * is a resource to go fetch rather than an encoding of THIS resource — following one would
 * glue an unrelated graph into the shapes graph.
 */
export function alternateTurtleHref(html: string): string | null {
  for (const tag of html.match(/<link\b[^>]*>/gi) ?? []) {
    if (!/\btype\s*=\s*["']?text\/turtle["']?/i.test(tag)) continue;
    if (!/\brel\s*=\s*["']?(?:alternate|describedby)["']?/i.test(tag)) continue;
    const href = tag.match(/\bhref\s*=\s*["']([^"']+)["']/i)?.[1]?.trim();
    if (href) return href;
  }
  return null;
}
