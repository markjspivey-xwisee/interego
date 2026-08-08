/**
 * @module solid/social-walk
 * @description Tier 5 discovery — walk the cross-pod citation graph.
 *
 * Given a seed pod URL, breadth-first traverse every pod reachable
 * via `prov:wasDerivedFrom` citations in the seed's (and subsequently
 * discovered pods') manifests. No publisher opt-in needed: whoever
 * cites another pod makes that pod reachable from theirs.
 *
 * Bounded by `maxDepth` and `maxPods` to avoid runaway fanout.
 *
 * A pod whose manifest has rolled over holds only its most recent entries in
 * `.well-known/context-graphs` and the rest in write-once archive segments the
 * manifest links to. This walk follows those links, because both numbers it
 * reports — descriptor counts and citation edges — are claims about the whole
 * pod, not about one document on it.
 */

import type { FetchFn } from './types.js';
import { getDefaultFetch } from './client.js';

const TURTLE_CONTENT_TYPE = 'text/turtle';

// A cap on chain-following, so a malformed or adversarial `iep:manifestArchive` cycle on a
// stranger's pod — and this walk visits strangers' pods by design — cannot make one node of
// the BFS fetch forever. 512 segments is far past any real pod's index.
const MANIFEST_ARCHIVE_MAX_SEGMENTS = 512;

export interface SocialWalkOptions {
  readonly fetch?: FetchFn;
  /** Max BFS depth from seed (default 3). */
  readonly maxDepth?: number;
  /** Max pods to visit before stopping (default 25). */
  readonly maxPods?: number;
  /** Per-request timeout in ms (default 5000). */
  readonly timeoutMs?: number;
}

export interface PodNode {
  readonly url: string;
  readonly depth: number;
  readonly descriptorCount: number;
  readonly reachedVia: string | null;
}

export interface PodEdge {
  readonly from: string;
  readonly to: string;
  /** Number of descriptors on `from` that cite into `to`. */
  readonly weight: number;
}

export interface SocialWalkResult {
  readonly seed: string;
  readonly nodes: readonly PodNode[];
  readonly edges: readonly PodEdge[];
  readonly stats: {
    readonly podsVisited: number;
    readonly descriptorsScanned: number;
    readonly crossPodCitations: number;
    readonly depthReached: number;
  };
}

function extractPodRoot(url: string): string | null {
  try {
    const u = new URL(url);
    // Pod root is host + first path segment (e.g. /markj/).
    const parts = u.pathname.split('/').filter(Boolean);
    if (parts.length === 0) return `${u.protocol}//${u.host}/`;
    return `${u.protocol}//${u.host}/${parts[0]}/`;
  } catch { return null; }
}

/**
 * One bounded Turtle GET. We can't easily pass an AbortController through FetchFn, so we
 * rely on the runtime fetch default timeout via Promise.race. Every request this walk makes
 * — the hot manifest, each archive segment, each descriptor — gets the same `timeoutMs`
 * budget, so following a chain cannot make one slow pod stall the whole traversal.
 */
async function fetchTurtle(
  url: string,
  fetchFn: FetchFn,
  timeoutMs: number,
): Promise<string | null> {
  try {
    const p = fetchFn(url, {
      method: 'GET',
      headers: { Accept: TURTLE_CONTENT_TYPE },
    });
    const timeout = new Promise<null>((resolve) => setTimeout(() => resolve(null), timeoutMs));
    const resp = await Promise.race([p, timeout]);
    if (!resp || !resp.ok) return null;
    return await resp.text();
  } catch { return null; }
}

function absolutize(iri: string, baseUrl: string): string {
  try { return new URL(iri, baseUrl).href; } catch { return iri; }
}

/**
 * The archive segments a manifest — or a segment — says the rest of its index lives in.
 *
 * The objects arrive as a comma-separated list on one line, which is how the manifest header
 * emits them. `hydra:previous` is read as well because a segment links BACKWARD under that
 * predicate: the chain stays walkable when this walk reaches a segment first.
 */
function parseArchiveLinks(turtle: string, baseUrl: string): string[] {
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

function parseEntryUrls(turtle: string, baseUrl: string): string[] {
  const urls: string[] = [];
  for (const m of turtle.matchAll(/<([^>]+)>\s+a\s+iep:ManifestEntry/g)) {
    urls.push(absolutize(m[1]!, baseUrl));
  }
  return urls;
}

/**
 * Every manifest entry a pod's index holds — the hot document AND the archive segments it
 * points at.
 *
 * ★ THIS READER MUST FOLLOW THE CHAIN BECAUSE WHAT IT RETURNS IS REPORTED AS A FACT ABOUT
 * THE POD. Its length becomes `PodNode.descriptorCount` and the citations sampled out of it
 * become `stats.crossPodCitations` — numbers a caller presents as "this is what is on that
 * pod". Once a pod rolls over, the hot manifest holds only the most recent entries, so
 * reading it alone would report a 600-descriptor pod as a 100-descriptor one, and every edge
 * into a pod cited only by an archived descriptor would silently drop out of the graph. A
 * halved count that looks exactly like a real one is worse than a fetch failure, because
 * nothing downstream can tell it apart.
 *
 * ★ AND FOLLOWING IS DRIVEN ENTIRELY BY THE DATA — the `iep:manifestArchive` links present in
 * the document actually fetched. A pod that has never rolled over advertises none, so this
 * still makes exactly one request and behaves precisely as it did before.
 */
async function fetchManifestEntries(
  podUrl: string,
  fetchFn: FetchFn,
  timeoutMs: number,
): Promise<string[]> {
  const manifestUrl = `${podUrl}.well-known/context-graphs`;
  const hot = await fetchTurtle(manifestUrl, fetchFn, timeoutMs);
  if (hot === null) return [];

  // Segments are fetched in PARALLEL: the hot document names all of them at once, so the
  // whole chain costs one extra round-trip of latency rather than one per segment — which
  // matters here, where this runs once per pod inside a BFS that is already serialised.
  const archiveUrls: string[] = [];
  const archiveBodies: string[] = [];
  const visited = new Set<string>([manifestUrl]);
  let frontier = parseArchiveLinks(hot, manifestUrl).filter(u => !visited.has(u));
  while (frontier.length > 0 && visited.size < MANIFEST_ARCHIVE_MAX_SEGMENTS) {
    frontier = frontier.slice(0, MANIFEST_ARCHIVE_MAX_SEGMENTS - visited.size);
    for (const u of frontier) visited.add(u);
    const fetched = await Promise.all(
      frontier.map(async (url) => ({ url, body: await fetchTurtle(url, fetchFn, timeoutMs) })),
    );
    const next: string[] = [];
    for (const f of fetched) {
      if (f.body === null) continue;
      archiveUrls.push(f.url);
      archiveBodies.push(f.body);
      for (const link of parseArchiveLinks(f.body, f.url)) {
        if (!visited.has(link) && !next.includes(link)) next.push(link);
      }
    }
    frontier = next;
  }

  // Roll-over writes the archive segment before it shortens the hot document, so an
  // interruption between the two leaves an entry in both. Dedupe by subject URL and let the
  // HOT copy hold the position: it is the one a CAS cycle has been maintaining, and keeping
  // it last preserves the oldest-to-newest ordering the caller's `slice(-20)` relies on to
  // sample the most recent descriptors.
  const hotUrls = parseEntryUrls(hot, manifestUrl);
  const hotSet = new Set(hotUrls);
  const merged: string[] = [];
  const seen = new Set<string>();
  for (let i = 0; i < archiveBodies.length; i++) {
    for (const u of parseEntryUrls(archiveBodies[i]!, archiveUrls[i]!)) {
      if (hotSet.has(u) || seen.has(u)) continue;
      seen.add(u);
      merged.push(u);
    }
  }
  for (const u of hotUrls) {
    if (seen.has(u)) continue;
    seen.add(u);
    merged.push(u);
  }
  return merged;
}

async function extractCitations(
  descriptorUrl: string,
  fetchFn: FetchFn,
  timeoutMs: number,
): Promise<string[]> {
  const ttl = await fetchTurtle(descriptorUrl, fetchFn, timeoutMs);
  if (ttl === null) return [];
  const citations: string[] = [];
  for (const m of ttl.matchAll(/prov:wasDerivedFrom\s+<([^>]+)>/g)) citations.push(m[1]!);
  return citations;
}

/**
 * BFS the citation graph. Returns every pod reachable from seed
 * within `maxDepth` hops, up to `maxPods` total, plus the edges
 * (and weights = citation counts).
 */
export async function socialWalk(
  seedPodUrl: string,
  options: SocialWalkOptions = {},
): Promise<SocialWalkResult> {
  const fetchFn = options.fetch ?? getDefaultFetch();
  const maxDepth = options.maxDepth ?? 3;
  const maxPods = options.maxPods ?? 25;
  const timeoutMs = options.timeoutMs ?? 5000;

  const visited = new Set<string>();
  const nodes: PodNode[] = [];
  const edgesMap = new Map<string, PodEdge>(); // key = `${from}→${to}`
  const queue: Array<{ pod: string; depth: number; reachedVia: string | null }> = [
    { pod: seedPodUrl, depth: 0, reachedVia: null },
  ];

  let descriptorsScanned = 0;
  let crossPodCitations = 0;
  let depthReached = 0;

  while (queue.length > 0 && visited.size < maxPods) {
    const { pod, depth, reachedVia } = queue.shift()!;
    if (visited.has(pod)) continue;
    if (depth > maxDepth) continue;
    visited.add(pod);
    depthReached = Math.max(depthReached, depth);

    const entries = await fetchManifestEntries(pod, fetchFn, timeoutMs);
    nodes.push({ url: pod, depth, descriptorCount: entries.length, reachedVia });

    // Sample up to 20 descriptors to avoid O(n) fanout per pod.
    const sample = entries.slice(-20);
    for (const entry of sample) {
      descriptorsScanned++;
      const citations = await extractCitations(entry, fetchFn, timeoutMs);
      for (const c of citations) {
        const targetPod = extractPodRoot(c);
        if (!targetPod || targetPod === pod) continue;
        crossPodCitations++;
        const key = `${pod}→${targetPod}`;
        const existing = edgesMap.get(key);
        edgesMap.set(key, {
          from: pod,
          to: targetPod,
          weight: (existing?.weight ?? 0) + 1,
        });
        if (!visited.has(targetPod) && visited.size < maxPods) {
          queue.push({ pod: targetPod, depth: depth + 1, reachedVia: pod });
        }
      }
    }
  }

  return {
    seed: seedPodUrl,
    nodes,
    edges: [...edgesMap.values()],
    stats: {
      podsVisited: visited.size,
      descriptorsScanned,
      crossPodCitations,
      depthReached,
    },
  };
}
