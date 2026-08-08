/**
 * Reading a pod's whole index from the browser, when the index is more than one document.
 *
 * A pod's manifest at `<pod>/.well-known/context-graphs` is BOUNDED. Past a threshold the
 * oldest entries roll into write-once segments at `<pod>/.well-known/context-graphs-archive-NNNN`
 * and the manifest keeps only the most recent ones. The hot document still parses as a
 * perfectly valid manifest — which is exactly why a reader that stops there is dangerous: it
 * gets a plausible, well-formed, silently truncated answer and has no way to notice.
 *
 * ★ WHAT MAKES A READER FOLLOW IS THE DATA IT FETCHED, NEVER A BUILD FLAG. The manifest
 * self-describes as partial by carrying `iep:manifestArchive` (and `hydra:view`) links to its
 * segments; a segment links backward with `iep:manifestArchive` / `hydra:previous`. A pod that
 * has never rolled over advertises nothing, so this module makes exactly one request against
 * it and behaves identically to the plain `fetch` it replaced. Nothing here consults
 * `import.meta.env`, and nothing should: the microsite is served from one bundle to viewers
 * looking at many different pods, so a build-time answer to "is this pod bounded" would be
 * wrong for most of them.
 *
 * Deliberately dependency-free — plain `fetch` plus the same tolerant regexes the rest of
 * this SPA parses Turtle with. The microsite bundle carries no @interego/* package, and this
 * is not a reason to start.
 */

const TURTLE_ACCEPT = 'text/turtle';

// A cap on chain-following, so a malformed or cyclic link set on some pod a viewer typed into
// the URL bar cannot make the tab fetch forever.
const MAX_SEGMENTS = 512;

function absolutize(iri: string, baseUrl: string): string {
  try { return new URL(iri, baseUrl).href; } catch { return iri; }
}

/**
 * The archive segments a manifest — or a segment — says the rest of its index lives in.
 *
 * The objects arrive as a comma-separated list on one line, which is how the manifest header
 * emits them. `hydra:previous` counts too: a segment links backward under that predicate, so
 * the chain stays walkable from whichever end a reader entered.
 */
export function parseManifestArchiveLinks(turtle: string, baseUrl: string): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  const predicate = /(?:iep:manifestArchive|hydra:previous)\s*((?:<[^>]*>\s*,\s*)*<[^>]*>)/g;
  let m: RegExpExecArray | null;
  while ((m = predicate.exec(turtle)) !== null) {
    for (const iri of m[1]!.matchAll(/<([^>]*)>/g)) {
      const abs = absolutize(iri[1]!, baseUrl);
      if (!seen.has(abs)) { seen.add(abs); out.push(abs); }
    }
  }
  return out;
}

/** Bare entry subject IRIs, for a caller that only needs to count what the index holds. */
export function parseManifestEntryUrls(turtle: string): string[] {
  const out: string[] = [];
  for (const m of turtle.matchAll(/<([^>]+)>\s+a\s+iep:ManifestEntry/g)) out.push(m[1]!);
  return out;
}

export interface ManifestIndex<T> {
  /** Hot entries and archived entries, oldest first, deduplicated. */
  items: T[];
  /** Archive segments actually read. 0 on a pod that has never rolled over. */
  archivesFollowed: number;
  /** False when a segment the data advertised could not be read, or the cap was hit. */
  complete: boolean;
}

/**
 * Read a pod's entire manifest index: the hot document plus every archive segment reachable
 * from it, parsed by the caller's own parser and deduplicated by the caller's own key.
 *
 * The parser is a parameter because the two pages that use this want different amounts of
 * each entry — but the walking, the cap, the cycle guard and the hot-wins merge are one
 * implementation, so the two pages cannot drift into disagreeing about what a pod contains.
 *
 * Throws `manifest HTTP <status>` when the hot document itself cannot be read, so a caller
 * can distinguish "this pod is not answering" from "this pod has an empty index".
 */
export async function readManifestIndex<T>(
  manifestUrl: string,
  parse: (turtle: string) => T[],
  keyOf: (item: T) => string,
): Promise<ManifestIndex<T>> {
  const r = await fetch(manifestUrl, { headers: { Accept: TURTLE_ACCEPT } });
  if (!r.ok) throw new Error(`manifest HTTP ${r.status}`);
  const hot = await r.text();

  // Segments are fetched in PARALLEL: the hot document names them all at once, so the whole
  // chain costs one extra round-trip of latency, not one per segment.
  const bodies: string[] = [];
  const visited = new Set<string>([manifestUrl]);
  let unreachable = 0;
  let truncated = false;
  let frontier = parseManifestArchiveLinks(hot, manifestUrl).filter(u => !visited.has(u));
  while (frontier.length > 0) {
    if (visited.size + frontier.length > MAX_SEGMENTS) {
      truncated = true;
      frontier = frontier.slice(0, Math.max(0, MAX_SEGMENTS - visited.size));
    }
    for (const u of frontier) visited.add(u);
    const fetched = await Promise.all(frontier.map(async (url) => {
      try {
        const resp = await fetch(url, { headers: { Accept: TURTLE_ACCEPT } });
        return resp.ok ? await resp.text() : null;
      } catch { return null; }
    }));
    const next: string[] = [];
    for (let i = 0; i < fetched.length; i++) {
      const body = fetched[i];
      if (body === null || body === undefined) { unreachable++; continue; }
      bodies.push(body);
      for (const link of parseManifestArchiveLinks(body, frontier[i]!)) {
        if (!visited.has(link) && !next.includes(link)) next.push(link);
      }
    }
    if (truncated) break;
    frontier = next;
  }

  // Roll-over writes the archive segment before it shortens the hot document, so an
  // interruption between the two leaves one entry in both. Dedupe with the HOT copy winning:
  // it is the one the publish path has been maintaining. Archives are merged first, so the
  // oldest entries stay first and the list reads in the order it did when the index was one
  // file.
  const byKey = new Map<string, T>();
  for (const body of bodies) {
    for (const item of parse(body)) byKey.set(keyOf(item), item);
  }
  for (const item of parse(hot)) byKey.set(keyOf(item), item);

  return {
    items: [...byKey.values()],
    archivesFollowed: bodies.length,
    complete: unreachable === 0 && !truncated,
  };
}
