/**
 * @module federation-store
 * @description Persistent storage for the relay's federation registry —
 *              the `knownPods` map that backs `list_known_pods`,
 *              `discover_all`, `subscribe_all`, and the cross-pod
 *              fan-out shims.
 *
 * Background:
 *   Before this module, `server.ts` declared `knownPods` as a process-
 *   local `Map`. Every `add_pod`, `discover_directory`, and
 *   webfinger-resolution call mutated that map in place; nothing was
 *   ever persisted. A container restart wiped the federation entirely
 *   and cold-start saw only the synthetic per-bearer `self` entry.
 *   `list_known_pods` returned a one-entry list and downstream
 *   `discover_all` / `subscribe_all` had nothing to fan out to until
 *   the operator manually re-added every peer pod.
 *
 *   This module mirrors each persisted entry (manual / directory /
 *   webfinger — never `self`, which is projected per-call from the
 *   bearer) onto the relay's service-account pod as a small JSON-LD
 *   file:
 *
 *     ${federationPodUrl}/<sha256(podUrl).hex>.jsonld
 *
 *   sha256(podUrl) is purely a stable opaque slug — pod URLs can carry
 *   characters Solid containers handle awkwardly (case differences,
 *   trailing-slash variation, percent encoding), and hashing sidesteps
 *   all of that. The URL itself is carried inside the file body, so
 *   reloads recover the canonical form.
 *
 *   Storage layout mirrors `oauth-token-store.ts`: same service-account
 *   pod (`svc-relay-dcr/` by default), one subcontainer
 *   (`federation/`), one tiny JSON-LD file per entry. Operational
 *   state — not a `cg:` Context Descriptor — because federation entries
 *   are flat operational metadata (URL + label + owner + how-we-learned-
 *   about-it) with no facet semantics worth serializing as RDF.
 *
 *   Cold-start safety: missing container = empty Map (legacy behaviour
 *   — `list_known_pods` falls back to just the synthetic `self`).
 */

import { createHash } from 'node:crypto';

import type {
  FetchFn,
} from '@interego/core';

// ── Configuration ────────────────────────────────────────────

export interface FederationStoreConfig {
  /** Service-account pod URL. Same pod the DCR client store + token store use. */
  readonly podUrl: string;
  /** Optional custom fetch — defaults to plain global fetch. */
  readonly fetch?: FetchFn;
  /** Optional logger — defaults to silent. */
  readonly log?: (msg: string) => void;
}

/**
 * The four origins of a known-pod entry. Mirrors the `KnownPodVia`
 * type in `server.ts` exactly; redeclared here to avoid a circular
 * import (server.ts imports this module).
 *
 * `'self'` is the per-call synthetic projection of the bearer's own
 * pod and is NEVER persisted — see `selfPodEntry()` in server.ts. The
 * union still includes it for type compatibility with the in-memory
 * shape, but `saveEntry()` rejects it.
 */
export type FederationVia = 'manual' | 'directory' | 'webfinger' | 'self';

/**
 * The shape persisted on the pod. `addedAt` is an ISO-8601 timestamp
 * we mint at first save — useful for operators auditing what showed up
 * when. Optional `label` / `owner` mirror the in-memory entry.
 */
export interface FederationEntry {
  readonly url: string;
  readonly via: FederationVia;
  readonly addedAt: string;
  readonly label?: string;
  readonly owner?: string;
}

// Subcontainer below the service-account pod root. Sibling to the
// existing OAuth `tokens/` + `tokens-refresh/` subcontainers and the
// DCR client descriptors.
const FEDERATION_CONTAINER = 'federation/';

// ── Helpers ─────────────────────────────────────────────────

function ensureTrailingSlash(s: string): string {
  return s.endsWith('/') ? s : `${s}/`;
}

/**
 * sha256 the pod URL. The filename in the pod is this hex string —
 * opaque, stable across restarts, and dodges any Solid-container
 * funny-character handling. The original URL round-trips via the file
 * body.
 */
export function sha256Hex(podUrl: string): string {
  return createHash('sha256').update(podUrl, 'utf8').digest('hex');
}

function entryUrl(podUrl: string, sha: string): string {
  return `${ensureTrailingSlash(podUrl)}${FEDERATION_CONTAINER}${sha}.jsonld`;
}

function defaultFetch(): FetchFn {
  return (async (url, init) => {
    const r = await fetch(url, init as RequestInit);
    return {
      ok: r.ok,
      status: r.status,
      statusText: r.statusText,
      headers: { get: (n: string) => r.headers.get(n) },
      text: () => r.text(),
      json: () => r.json(),
    };
  }) as FetchFn;
}

// ── Wire shape ──────────────────────────────────────────────
//
// Each file is one small JSON-LD document. Keeping it JSON-LD (rather
// than plain JSON) leaves room for SPARQL/RDF tooling to index the
// federation later without a migration; callers round-trip only via
// the top-level keys.

interface PersistedEntry {
  '@context': Record<string, string>;
  '@id': string;
  '@type': string;
  url: string;
  via: FederationVia;
  addedAt: string;
  label?: string;
  owner?: string;
}

const JSONLD_CTX: Record<string, string> = {
  relay: 'https://interego-emergent.example/ns/mcp-relay#',
};
const TYPE_ENTRY = 'urn:cg:relay:FederationEntry';

// ── save ────────────────────────────────────────────────────

/**
 * Write a single federation entry to the service-account pod.
 *
 * Silently rejects `via: 'self'` entries — the calling user's own pod
 * is projected per-call from the bearer and MUST NOT be baked into
 * persistent storage (it would lock the entry to whichever user
 * happened to add it first on a shared relay instance).
 *
 * Idempotent: PUT overwrites the existing file at the same sha-keyed
 * URL, so repeated `saveEntry` calls for the same pod URL collapse to
 * a single file. Best-effort: a failed PUT logs but does not throw —
 * the in-memory map is still the source of truth for the live process.
 */
export async function saveEntry(
  entry: FederationEntry,
  cfg: FederationStoreConfig,
): Promise<void> {
  if (entry.via === 'self') return;

  const log = cfg.log ?? (() => {});
  const fetchFn = cfg.fetch ?? defaultFetch();
  const sha = sha256Hex(entry.url);
  const url = entryUrl(cfg.podUrl, sha);

  const body: PersistedEntry = {
    '@context': JSONLD_CTX,
    '@id': `urn:interego:mcp-relay:federation:${sha.slice(0, 16)}`,
    '@type': TYPE_ENTRY,
    url: entry.url,
    via: entry.via,
    addedAt: entry.addedAt,
    ...(entry.label !== undefined ? { label: entry.label } : {}),
    ...(entry.owner !== undefined ? { owner: entry.owner } : {}),
  };

  try {
    const r = await fetchFn(url, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/ld+json' },
      body: JSON.stringify(body, null, 2),
    });
    if (!r.ok) {
      log(`[federation-store] PUT ${url} failed: ${r.status} ${r.statusText}`);
      return;
    }
    log(`[federation-store] persisted ${entry.via} entry ${entry.url} at ${url}`);
  } catch (err) {
    log(`[federation-store] saveEntry(${entry.url}) failed: ${(err as Error).message}`);
  }
}

// ── delete ──────────────────────────────────────────────────

/**
 * Remove a federation entry's file from the service-account pod.
 * Called from `handleRemovePod`. Best-effort: 404 is fine (already
 * gone), other transport errors are logged and swallowed — the
 * in-memory delete already happened and is what `list_known_pods`
 * reads from.
 */
export async function removeEntry(
  podUrl: string,
  cfg: FederationStoreConfig,
): Promise<void> {
  const log = cfg.log ?? (() => {});
  const fetchFn = cfg.fetch ?? defaultFetch();
  const sha = sha256Hex(podUrl);
  const url = entryUrl(cfg.podUrl, sha);

  try {
    const r = await fetchFn(url, { method: 'DELETE' });
    if (!r.ok && r.status !== 404) {
      log(`[federation-store] DELETE ${url} failed: ${r.status} ${r.statusText}`);
    }
  } catch (err) {
    log(`[federation-store] removeEntry(${podUrl}) failed: ${(err as Error).message}`);
  }
}

// ── load: bulk-at-startup ───────────────────────────────────

/**
 * List a Solid/LDP container. Returns the URLs of every contained
 * `.jsonld` resource. Cold-start safe: returns [] when the container
 * doesn't yet exist (404) or can't be parsed.
 *
 * Copied from `oauth-token-store.ts:listContainer` because the two
 * modules are intentionally decoupled — sharing the helper would
 * couple their lifecycles.
 */
async function listContainer(
  containerUrl: string,
  cfg: FederationStoreConfig,
): Promise<string[]> {
  const fetchFn = cfg.fetch ?? defaultFetch();
  try {
    const r = await fetchFn(containerUrl, {
      method: 'GET',
      headers: { Accept: 'text/turtle, application/ld+json;q=0.9, */*;q=0.5' },
    });
    if (r.status === 404) return [];
    if (!r.ok) return [];
    const body = await r.text();
    const urls = new Set<string>();
    // Turtle: <child.jsonld> or absolute <https://.../child.jsonld>
    const reTurtle = /<([^>\s]+\.jsonld)>/g;
    let m: RegExpExecArray | null;
    while ((m = reTurtle.exec(body)) !== null) {
      const raw = m[1]!;
      try {
        const resolved = new URL(raw, containerUrl).toString();
        urls.add(resolved);
      } catch {
        // skip malformed entries
      }
    }
    // JSON: "@id":"...child.jsonld"
    const reJson = /"@id"\s*:\s*"([^"]+\.jsonld)"/g;
    while ((m = reJson.exec(body)) !== null) {
      const raw = m[1]!;
      try {
        const resolved = new URL(raw, containerUrl).toString();
        urls.add(resolved);
      } catch {
        // skip
      }
    }
    return [...urls];
  } catch {
    return [];
  }
}

/**
 * Read every previously-saved federation entry off the service-account
 * pod and return them as a fresh array. Cold-start safe: an empty
 * container, a missing container, or a transport failure all return
 * an empty array (the relay continues with just the synthetic `self`
 * entry).
 *
 * Individual-file failures are logged and skipped — losing one
 * malformed entry is preferable to crashing the relay's startup and
 * locking out every other peer pod.
 *
 * The caller is responsible for inserting these entries into the
 * in-memory `knownPods` map — this module deliberately knows nothing
 * about that map's representation.
 */
export async function loadEntries(
  cfg: FederationStoreConfig,
): Promise<FederationEntry[]> {
  const log = cfg.log ?? (() => {});
  const fetchFn = cfg.fetch ?? defaultFetch();
  const out: FederationEntry[] = [];
  const containerUrl = `${ensureTrailingSlash(cfg.podUrl)}${FEDERATION_CONTAINER}`;

  const urls = await listContainer(containerUrl, cfg);
  if (urls.length === 0) {
    log(`[federation-store] no federation files found at ${containerUrl}`);
    return out;
  }

  await Promise.allSettled(urls.map(async url => {
    try {
      const r = await fetchFn(url, { method: 'GET' });
      if (!r.ok) {
        log(`[federation-store] GET ${url} -> ${r.status}; skipping`);
        return;
      }
      const body = JSON.parse(await r.text()) as PersistedEntry;
      if (!body.url || !body.via) {
        log(`[federation-store] malformed federation entry at ${url}; skipping`);
        return;
      }
      if (body.via === 'self') {
        // Defensive: an older buggy writer might have leaked a self
        // entry to disk. Drop it on load — self is projected
        // per-call, never persisted.
        log(`[federation-store] dropping leaked 'self' entry at ${url}`);
        return;
      }
      const entry: FederationEntry = {
        url: body.url,
        via: body.via,
        addedAt: body.addedAt ?? new Date(0).toISOString(),
        ...(body.label !== undefined ? { label: body.label } : {}),
        ...(body.owner !== undefined ? { owner: body.owner } : {}),
      };
      out.push(entry);
    } catch (err) {
      log(`[federation-store] failed to read ${url}: ${(err as Error).message}`);
    }
  }));

  log(`[federation-store] loaded ${out.length} federation entry/entries from ${containerUrl}`);
  return out;
}
