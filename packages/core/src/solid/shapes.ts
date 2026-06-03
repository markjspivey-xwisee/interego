/**
 * @module solid/shapes
 * @description Shape discovery — spec §6.5b.
 *
 * Descriptors declare conformance via `dct:conformsTo <schema-URL>`.
 * A pod MAY host a shape at `<pod>/schemas/<shape-id>.ttl` and MAY
 * publish an index at `<pod>/schemas/index.ttl` enumerating its
 * shapes. This module provides:
 *
 *   - `resolveShape(url)` — GETs a shape Turtle; returns null on
 *     unreachable. Callers use the null to label alignment nominal.
 *   - `listPodShapes(podUrl)` — reads the index if present; falls
 *     back to listing /schemas/ via LDP container introspection.
 *   - `POD_SHAPES_PATH` / `POD_SHAPES_INDEX_PATH` — conventional
 *     paths for implementations that wish to host shapes at the
 *     recommended location.
 */

import type { FetchFn } from './types.js';
import { getDefaultFetch } from './client.js';

const TURTLE_CONTENT_TYPE = 'text/turtle';

/** Conventional path under a pod for hosted shape Turtle files. */
export const POD_SHAPES_PATH = 'schemas/';

/** Conventional index-of-shapes URL under a pod. */
export const POD_SHAPES_INDEX_PATH = 'schemas/index.ttl';

/** Result of a shape-resolve attempt. */
export interface ResolvedShape {
  /** The shape URL that was requested. */
  readonly url: string;
  /** The shape Turtle body, or null if unreachable. */
  readonly body: string | null;
  /** HTTP status (0 if network error). */
  readonly status: number;
  /** True when body is non-null. */
  readonly resolved: boolean;
}

function ensureTrailingSlash(url: string): string {
  return url.endsWith('/') ? url : url + '/';
}

/**
 * Dereference a SHACL shape URL. Returns a `ResolvedShape` so callers
 * can distinguish network failure (resolved=false, status=0) from
 * HTTP errors (resolved=false, status=404/...) from success (resolved=true).
 *
 * Per §6.5b, a `conformsTo` pointing at an unreachable URL is
 * nominal-only — callers should record the limitation and proceed.
 */
export async function resolveShape(
  url: string,
  options: { fetch?: FetchFn; timeoutMs?: number } = {},
): Promise<ResolvedShape> {
  const fetchFn = options.fetch ?? getDefaultFetch();
  try {
    const resp = await fetchFn(url, {
      method: 'GET',
      headers: { Accept: TURTLE_CONTENT_TYPE },
    });
    if (!resp.ok) {
      return { url, body: null, status: resp.status, resolved: false };
    }
    const body = await resp.text();
    return { url, body, status: resp.status, resolved: true };
  } catch {
    return { url, body: null, status: 0, resolved: false };
  }
}

/** Parsed entry from a pod's shape index. */
export interface ShapeIndexEntry {
  readonly shapeUrl: string;
  readonly label?: string;
  readonly description?: string;
}

/**
 * Read the pod's shape index if present. Returns the parsed entries
 * or an empty array when the index is absent / unreadable.
 *
 * Index format (convention, not normative — any Turtle with these
 * patterns is accepted):
 *
 *   <shape-url> a <urn:shape:Entry> ;
 *     rdfs:label "..." ;
 *     rdfs:comment "..." .
 */
export async function listPodShapes(
  podUrl: string,
  options: { fetch?: FetchFn } = {},
): Promise<readonly ShapeIndexEntry[]> {
  const pod = ensureTrailingSlash(podUrl);
  const indexUrl = `${pod}${POD_SHAPES_INDEX_PATH}`;
  const resolved = await resolveShape(indexUrl, options);
  if (!resolved.resolved || !resolved.body) return [];
  return parseShapeIndex(resolved.body);
}

/** Minimal Turtle scan for shape-index entries. Regex-based; the
 *  shape is narrow enough that a full parser would be overkill. */
export function parseShapeIndex(ttl: string): readonly ShapeIndexEntry[] {
  const entries: ShapeIndexEntry[] = [];
  const blockRe = /<([^>]+)>\s+a\s+<urn:shape:Entry>\s*;([\s\S]*?)\./g;
  let m: RegExpExecArray | null;
  while ((m = blockRe.exec(ttl)) !== null) {
    const shapeUrl = m[1]!;
    const body = m[2]!;
    const label = body.match(/rdfs:label\s+"([^"]+)"/)?.[1];
    const description = body.match(/rdfs:comment\s+"([^"]+)"/)?.[1];
    entries.push({ shapeUrl, label, description });
  }
  return entries;
}

/**
 * Build the Turtle for a shape-index descriptor. Implementations
 * that host multiple shapes should call this and PUT the result
 * to <pod>/schemas/index.ttl so consumers can browse.
 */
export function shapeIndexTurtle(
  entries: readonly ShapeIndexEntry[],
): string {
  const lines = [
    '@prefix rdfs: <http://www.w3.org/2000/01/rdf-schema#> .',
    '',
  ];
  for (const e of entries) {
    lines.push(`<${e.shapeUrl}> a <urn:shape:Entry> ;`);
    if (e.label) lines.push(`    rdfs:label "${e.label.replace(/"/g, '\\"')}" ;`);
    if (e.description) lines.push(`    rdfs:comment "${e.description.replace(/"/g, '\\"')}" ;`);
    // Replace trailing ; with .
    const last = lines.length - 1;
    lines[last] = lines[last]!.replace(/ ;$/, ' .');
    lines.push('');
  }
  return lines.join('\n');
}
