/**
 * @module solid/directory
 * @description Pod Directory — serialize, parse, fetch, and publish
 * directories of known Solid pods for federated discovery.
 *
 * A PodDirectory is itself an RDF resource that can be published
 * to a Solid pod. Other agents fetch it to discover new pods.
 */

import type { IRI, PodDirectoryData, PodDirectoryEntry } from '../model/types.js';
import { turtlePrefixes } from '../rdf/namespaces.js';
import type { FetchFn } from './types.js';

/** Default path within a pod where the directory is stored. */
export const POD_DIRECTORY_PATH = 'directory';

/**
 * Serialize a PodDirectory to Turtle.
 */
export function podDirectoryToTurtle(directory: PodDirectoryData): string {
  const prefixes = turtlePrefixes(['cg', 'rdfs']);
  const lines: string[] = [prefixes, ''];

  lines.push(`<${directory.id}> a cg:PodDirectory .`);

  for (let i = 0; i < directory.entries.length; i++) {
    const e = directory.entries[i]!;
    const bnode = `_:pod${i}`;
    lines.push('');
    lines.push(`<${directory.id}> cg:hasPod ${bnode} .`);
    lines.push(`${bnode} cg:podUrl <${e.podUrl}> .`);
    if (e.owner) {
      lines.push(`${bnode} cg:owner <${e.owner}> .`);
    }
    if (e.label) {
      lines.push(`${bnode} rdfs:label "${escapeTurtle(e.label)}" .`);
    }
  }

  return lines.join('\n') + '\n';
}

/**
 * Parse Turtle back into a PodDirectoryData.
 *
 * Handles both blank node and inline formats. Defensive —
 * skips malformed entries rather than throwing.
 */
export function parsePodDirectory(turtle: string): PodDirectoryData {
  // Extract directory IRI
  const idMatch = turtle.match(/<([^>]+)>\s+a\s+cg:PodDirectory/);
  const id = (idMatch?.[1] ?? 'urn:directory:unknown') as IRI;

  // Extract hasPod entries — each has a podUrl, optional owner, optional label
  const entries: PodDirectoryEntry[] = [];

  // Find all bnode references from hasPod
  const hasPodRe = /<[^>]+>\s+cg:hasPod\s+(_:\w+)\s*\./g;
  let match: RegExpExecArray | null;

  while ((match = hasPodRe.exec(turtle)) !== null) {
    const bnode = match[1]!;

    // Find podUrl for this bnode
    const podUrlRe = new RegExp(`${escapeRegex(bnode)}\\s+cg:podUrl\\s+<([^>]+)>`, 'm');
    const podUrlMatch = turtle.match(podUrlRe);
    if (!podUrlMatch?.[1]) continue;

    const podUrl = podUrlMatch[1] as IRI;

    // Find optional owner
    const ownerRe = new RegExp(`${escapeRegex(bnode)}\\s+cg:owner\\s+<([^>]+)>`, 'm');
    const ownerMatch = turtle.match(ownerRe);
    const owner = ownerMatch?.[1] ? (ownerMatch[1] as IRI) : undefined;

    // Find optional label
    const labelRe = new RegExp(`${escapeRegex(bnode)}\\s+rdfs:label\\s+"([^"]*)"`, 'm');
    const labelMatch = turtle.match(labelRe);
    const label = labelMatch?.[1] ?? undefined;

    entries.push({ podUrl, owner, label });
  }

  return { id, entries };
}

/**
 * Fetch a directory graph from a URL and parse it.
 */
export async function fetchPodDirectory(
  url: string,
  options?: { fetch?: FetchFn },
): Promise<PodDirectoryData> {
  const fetchFn = options?.fetch ?? (globalThis.fetch as unknown as FetchFn);
  const resp = await fetchFn(url, {
    headers: { 'Accept': 'text/turtle' },
  });

  if (!resp.ok) {
    throw new Error(`Failed to fetch pod directory at ${url}: ${resp.status} ${resp.statusText}`);
  }

  const turtle = await resp.text();
  return parsePodDirectory(turtle);
}

/**
 * Publish (PUT) a directory graph to a pod.
 * Returns the URL it was written to.
 */
export async function publishPodDirectory(
  directory: PodDirectoryData,
  podUrl: string,
  options?: { fetch?: FetchFn; path?: string },
): Promise<string> {
  const fetchFn = options?.fetch ?? (globalThis.fetch as unknown as FetchFn);
  const path = options?.path ?? POD_DIRECTORY_PATH;
  const normalizedPod = podUrl.endsWith('/') ? podUrl : podUrl + '/';
  const url = `${normalizedPod}${path}`;
  const turtle = podDirectoryToTurtle(directory);

  const resp = await fetchFn(url, {
    method: 'PUT',
    headers: {
      'Content-Type': 'text/turtle',
    },
    body: turtle,
  });

  if (!resp.ok) {
    throw new Error(`Failed to publish directory to ${url}: ${resp.status} ${resp.statusText}`);
  }

  return url;
}

// ── Helpers ──────────────────────────────────────────────────

function escapeTurtle(s: string): string {
  return s.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
