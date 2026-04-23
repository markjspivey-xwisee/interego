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
 */

import type { FetchFn } from './types.js';
import { getDefaultFetch } from './client.js';

const TURTLE_CONTENT_TYPE = 'text/turtle';

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

async function fetchManifestEntries(
  podUrl: string,
  fetchFn: FetchFn,
  timeoutMs: number,
): Promise<string[]> {
  const url = `${podUrl}.well-known/context-graphs`;
  try {
    // We can't easily pass AbortController through FetchFn, so we
    // rely on the runtime fetch default timeout via Promise.race.
    const p = fetchFn(url, {
      method: 'GET',
      headers: { Accept: TURTLE_CONTENT_TYPE },
    });
    const timeout = new Promise<null>((resolve) => setTimeout(() => resolve(null), timeoutMs));
    const resp = await Promise.race([p, timeout]);
    if (!resp || !resp.ok) return [];
    const ttl = await resp.text();
    const urls: string[] = [];
    for (const m of ttl.matchAll(/<([^>]+)>\s+a\s+cg:ManifestEntry/g)) urls.push(m[1]!);
    return urls;
  } catch { return []; }
}

async function extractCitations(
  descriptorUrl: string,
  fetchFn: FetchFn,
  timeoutMs: number,
): Promise<string[]> {
  try {
    const p = fetchFn(descriptorUrl, {
      method: 'GET',
      headers: { Accept: TURTLE_CONTENT_TYPE },
    });
    const timeout = new Promise<null>((resolve) => setTimeout(() => resolve(null), timeoutMs));
    const resp = await Promise.race([p, timeout]);
    if (!resp || !resp.ok) return [];
    const ttl = await resp.text();
    const citations: string[] = [];
    for (const m of ttl.matchAll(/prov:wasDerivedFrom\s+<([^>]+)>/g)) citations.push(m[1]!);
    return citations;
  } catch { return []; }
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
