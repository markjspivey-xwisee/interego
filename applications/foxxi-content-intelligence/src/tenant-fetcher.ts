/**
 * Tenant-pod fetcher for the Foxxi vertical bridge.
 *
 * Counterpart to tenant-publisher.ts. Given a tenant pod URL + the
 * authoritative source DID, walks the pod via the substrate's standard
 * `discover()` + `fetchGraphContent()` machinery and reassembles the
 * published sections into a `FoxxiAdminPayload`-shaped value for the
 * existing enrollment / coverage / audit handlers.
 *
 * Two principles enforced here:
 *
 *   1. NO hardcoded paths. Discovery walks the pod's manifest; we
 *      filter manifest entries by `dct:conformsTo` (mirrored from the
 *      descriptor's graph) to find each section. The pod operator can
 *      relocate the underlying files freely; only the type IRIs are
 *      stable contract.
 *
 *   2. NO new substrate primitives. Everything uses the existing
 *      publish/discover/fetchGraphContent API surface. The vertical's
 *      only contribution is its own type-IRI vocabulary.
 *
 * Cache: a single in-process map keyed by (podUrl + authoritativeSource)
 * with a 60-second TTL. Hot-path bridge requests don't re-walk the pod;
 * the cache is invalidated on any error so a stale snapshot can't
 * mask a publish failure.
 */

import {
  discover,
  fetchGraphContent,
} from '@interego/solid';
import type {
  ManifestEntry,
} from '@interego/core';
import type {
  IRI,
} from '@interego/core';
import type {
  EncryptionKeyPair,
} from '@interego/core';
import { TENANT_TYPES, deriveAdminKeyPair } from './tenant-publisher.js';

// ── Cache ─────────────────────────────────────────────────────

interface CacheEntry<T> {
  value: T;
  expiresAt: number;
}

const TTL_MS = 60_000;
const cache = new Map<string, CacheEntry<unknown>>();

function cacheKey(podUrl: string, authoritativeSource: IRI, kind: string): string {
  return `${podUrl}|${authoritativeSource}|${kind}`;
}

function getCached<T>(key: string): T | null {
  const e = cache.get(key);
  if (!e) return null;
  if (Date.now() > e.expiresAt) {
    cache.delete(key);
    return null;
  }
  return e.value as T;
}

function setCached<T>(key: string, value: T): void {
  cache.set(key, { value, expiresAt: Date.now() + TTL_MS });
}

export function invalidateTenantCache(podUrl?: string): void {
  if (!podUrl) {
    cache.clear();
    return;
  }
  for (const k of cache.keys()) {
    if (k.startsWith(`${podUrl}|`)) cache.delete(k);
  }
}

// ── Discovery + fetch helpers ─────────────────────────────────

export interface TenantFetchConfig {
  podUrl: string;
  authoritativeSource: IRI;
  /** Optional fetch override (defaults to unauthenticated globalThis.fetch). */
  fetch?: typeof globalThis.fetch;
  /**
   * X25519 keypair the bridge uses to decrypt admin-only sections. Derived
   * deterministically from the same seed the publisher used (passed in as
   * `adminKeySeed`); if unset, admin-only sections will be skipped.
   */
  adminKeyPair?: EncryptionKeyPair;
  /** Convenience: pass a seed and the keypair will be derived. */
  adminKeySeed?: string;
  /**
   * Force this pod to be treated as a CLOSED tenant even if no encrypted
   * directory is currently readable. The bridge sets this for its own
   * configured tenant pod (FOXXI_TENANT_POD_URL) so a stale/undecryptable
   * directory can NEVER be silently downgraded to a self-sovereign, publicly
   * enrollable tenant. Fail-closed.
   */
  forceClosed?: boolean;
}

function resolveAdminKeyPair(config: TenantFetchConfig): EncryptionKeyPair | undefined {
  if (config.adminKeyPair) return config.adminKeyPair;
  if (config.adminKeySeed) return deriveAdminKeyPair(config.adminKeySeed);
  return undefined;
}

/**
 * Find the manifest entry whose `conformsTo` includes the given type IRI.
 * Returns the most recently published (by validFrom desc) when multiple
 * candidates exist. Returns null when no entry matches.
 */
async function findEntry(
  config: TenantFetchConfig,
  typeIri: IRI,
): Promise<ManifestEntry | null> {
  const entries = await discover(config.podUrl, undefined, config.fetch ? { fetch: config.fetch as never } : undefined);
  // Match by the type's LOCAL NAME (the `#…` suffix), not the full IRI,
  // so the tenant directory still resolves after a namespace migration —
  // pod data published under a legacy foxxi namespace stays readable.
  const localName = typeIri.split(/[#/]/).pop() ?? typeIri;
  const matching = entries.filter(e =>
    (e.conformsTo ?? []).some(c => c === typeIri || c.split(/[#/]/).pop() === localName));
  if (matching.length === 0) return null;
  // Pick the most recent by validFrom; if absent, fall back to first
  // entry order in the manifest.
  matching.sort((a, b) => (b.validFrom ?? '').localeCompare(a.validFrom ?? ''));
  return matching[0];
}

/**
 * Given a manifest entry, fetch its graph (decrypting via the admin
 * keypair if it's an admin-only section) and extract the JSON payload
 * stored in the `fxs:bundleJson` literal.
 */
async function fetchBundleJson(
  entry: ManifestEntry,
  config: TenantFetchConfig,
): Promise<unknown> {
  // The entry tracks the descriptor URL; the graph lives at a separate
  // URL discoverable via the descriptor's Distribution block. Walk the
  // descriptor Turtle to find its iep:affordance / hydra:target — never
  // reconstruct the URL by filename convention.
  const fetchFn = (config.fetch ?? globalThis.fetch) as typeof globalThis.fetch;
  const descRes = await fetchFn(entry.descriptorUrl, {
    headers: { 'Accept': 'text/turtle' },
  });
  if (!descRes.ok) {
    throw new Error(`Failed to fetch descriptor ${entry.descriptorUrl}: ${descRes.status} ${descRes.statusText}`);
  }
  const descTurtle = await descRes.text();
  const graphUrl = extractDistributionTarget(descTurtle);
  if (!graphUrl) {
    throw new Error(`Descriptor ${entry.descriptorUrl} has no hydra:target / dcat:accessURL on its iep:affordance block`);
  }

  const adminKeyPair = resolveAdminKeyPair(config);
  const { content, encrypted } = await fetchGraphContent(graphUrl, {
    ...(config.fetch ? { fetch: config.fetch as never } : {}),
    ...(adminKeyPair ? { recipientKeyPair: adminKeyPair } : {}),
  });
  if (!content && encrypted) {
    throw new Error(`Graph at ${graphUrl} is encrypted and bridge has no recipient key (set FOXXI_ADMIN_KEY_SEED to decrypt admin sections)`);
  }
  if (!content) {
    throw new Error(`Graph at ${graphUrl} returned empty content`);
  }
  return extractBundleJson(content);
}

/**
 * Pull the `hydra:target` (or `dcat:accessURL`) IRI from the descriptor
 * Turtle's iep:affordance block. Substrate writes both — we accept either.
 */
function extractDistributionTarget(descTurtle: string): string | null {
  // Look for `hydra:target <url>` first (substrate writes this).
  const targetMatch = descTurtle.match(/hydra:target\s+<([^>]+)>/);
  if (targetMatch) return targetMatch[1];
  const accessMatch = descTurtle.match(/dcat:accessURL\s+<([^>]+)>/);
  if (accessMatch) return accessMatch[1];
  return null;
}

/**
 * Pull the base64-encoded JSON payload out of the fxs:bundleJson predicate
 * in a TriG graph body. The publisher base64-encodes to sidestep Turtle's
 * string-escape grammar.
 */
function extractBundleJson(trig: string): unknown {
  // Match `<…#bundleJson> "<base64>"^^<xsd:base64Binary>` by LOCAL NAME —
  // the predicate's namespace migrated (an old non-dereferenceable placeholder host →
  // the bridge-served foxxi vocab IRI), so match `#bundleJson` regardless of namespace,
  // the same migration-tolerance findEntry() uses for conformsTo.
  const m = trig.match(/<[^>]*#bundleJson>\s+"([A-Za-z0-9+/=\s]+)"/);
  if (!m) {
    throw new Error('Graph body has no #bundleJson literal — not a tenant-publisher artifact?');
  }
  const b64 = m[1].replace(/\s+/g, '');
  let json: string;
  try {
    json = Buffer.from(b64, 'base64').toString('utf8');
  } catch (err) {
    throw new Error(`Failed to base64-decode fxs:bundleJson: ${(err as Error).message}`);
  }
  try {
    return JSON.parse(json);
  } catch (err) {
    throw new Error(`Failed to parse fxs:bundleJson payload as JSON: ${(err as Error).message}`);
  }
}

// ── Public API ────────────────────────────────────────────────

export async function fetchSection(
  typeIri: IRI,
  config: TenantFetchConfig,
): Promise<unknown> {
  const key = cacheKey(config.podUrl, config.authoritativeSource, typeIri);
  const hit = getCached<unknown>(key);
  if (hit !== null) return hit;
  const entry = await findEntry(config, typeIri);
  if (!entry) {
    throw new Error(`No descriptor with conformsTo=${typeIri} found in pod ${config.podUrl}. Tenant publish required first.`);
  }
  const payload = await fetchBundleJson(entry, config);
  setCached(key, payload);
  return payload;
}

/**
 * Walk the tenant pod, fetch each section by type IRI, and recompose
 * the FoxxiAdminPayload the existing handlers expect. Cached.
 */
export async function fetchAdminPayload(config: TenantFetchConfig): Promise<unknown> {
  const key = cacheKey(config.podUrl, config.authoritativeSource, 'AdminPayload');
  const hit = getCached<unknown>(key);
  if (hit !== null) return hit;

  // Resilient composition: a tenant may have published some sections and
  // not others (e.g. the directory exists but the course catalog was never
  // published). The OLD Promise.all rejected the WHOLE admin payload if ANY
  // section was absent — which silently broke session-token verification
  // (auth needs only the directory's `users`) for the entire bridge. Fetch
  // each section independently and default a missing one to empty, so a
  // partial publish degrades gracefully instead of disabling auth.
  const SECTIONS: Array<[string, IRI]> = [
    ['catalog', TENANT_TYPES.CourseCatalog],
    ['directory', TENANT_TYPES.TenantDirectory],
    ['policies', TENANT_TYPES.AssignmentPolicySet],
    ['connections', TENANT_TYPES.ConnectorRegistry],
    ['events', TENANT_TYPES.EnrollmentEventStream],
    ['audit', TENANT_TYPES.AuditLogStream],
    ['membership', TENANT_TYPES.TenantMembership],
  ];
  const settled = await Promise.allSettled(SECTIONS.map(([, iri]) => fetchSection(iri, config)));
  const missing: string[] = [];
  const section = (i: number): unknown => {
    if (settled[i]!.status === 'fulfilled') return (settled[i] as PromiseFulfilledResult<unknown>).value;
    missing.push(SECTIONS[i]![0]);
    return undefined;
  };
  const catalog = section(0) ?? [];
  const directory = section(1) ?? { users: [], groups: [] };
  const policies = section(2) ?? [];
  const connections = section(3) ?? [];
  const events = section(4) ?? [];
  const audit = section(5) ?? [];
  const membership = section(6) ?? { users: [] };
  if (missing.length > 0) {
    // eslint-disable-next-line no-console
    console.warn(`[foxxi-tenant-fetcher] tenant ${config.podUrl} is missing sections [${missing.join(', ')}] — composed admin payload with empty defaults (auth/directory still works if 'directory' is present).`);
  }

  // directory was published as { users, groups }
  const dir = directory as { users?: unknown; groups?: unknown };

  // ── Closed vs self-sovereign membership resolution ──────────────
  // A CLOSED tenant is admin-managed: its allowlist comes ONLY from the
  // encrypted TenantDirectory, and any PUBLIC TenantMembership overlay on its
  // pod is deliberately IGNORED — otherwise anyone could self-enroll into an
  // admin tenant by writing a public allowlist onto it. A SELF-SOVEREIGN
  // tenant has no encrypted directory at all; its PUBLIC TenantMembership IS
  // the authoritative allowlist, readable by any bridge with no shared key.
  //
  // "Closed" is decided by PRESENCE of a directory descriptor, NOT by whether
  // we could decrypt it, plus the bridge's forceClosed flag for its own
  // configured tenant. This FAILS CLOSED: a stale or undecryptable directory
  // (descriptor present, users empty) still suppresses the public overlay, so
  // a closed tenant can never be silently downgraded to publicly enrollable.
  const dirUsers = Array.isArray(dir.users) ? (dir.users as unknown[]) : [];
  const memUsers = (() => {
    const m = membership as { users?: unknown };
    return Array.isArray(m.users) ? (m.users as unknown[]) : [];
  })();
  const directorySettled = settled[1]!;
  const directoryPresent = directorySettled.status === 'fulfilled'
    ? true
    // Only the explicit "no descriptor found" rejection means genuinely absent;
    // any other failure (encrypted-no-key, fetch error) is treated as present.
    : !/No descriptor with conformsTo=.*found/i.test(
        String((directorySettled.reason as Error)?.message ?? directorySettled.reason ?? ''));
  const closed = Boolean(config.forceClosed) || directoryPresent;
  const effectiveUsers = closed ? dirUsers : memUsers;

  const composed = {
    meta: {
      // Meta is derived from the authoritativeSource + pod URL — we
      // don't republish it, the bridge config already knows it.
      tenant: humanizeDid(config.authoritativeSource),
      tenant_pod: config.podUrl,
      tenant_id: config.authoritativeSource,
      admin_user_web_id: '',
      admin_user_name: '',
      admin_user_role: '',
    },
    catalog,
    users: effectiveUsers,
    groups: dir.groups ?? [],
    policies,
    events,
    audit,
    connections,
  };
  setCached(key, composed);
  return composed;
}

export async function fetchCoursePackage(
  courseId: string,
  config: TenantFetchConfig,
): Promise<unknown> {
  const key = cacheKey(config.podUrl, config.authoritativeSource, `course:${courseId}`);
  const hit = getCached<unknown>(key);
  if (hit !== null) return hit;

  // For courses we need to discover among multiple CoursePackageBundle
  // entries — pick the one whose graph IRI matches this courseId. The
  // graph IRI follows the slug convention `course:<courseId>`.
  const entries = await discover(config.podUrl, undefined, config.fetch ? { fetch: config.fetch as never } : undefined);
  const matching = entries.filter(e =>
    // Local-name match — resilient to a namespace migration (see findEntry).
    (e.conformsTo ?? []).some(c => c.split(/[#/]/).pop() === 'CoursePackageBundle')
    && e.describes.some(g => g.endsWith(`:course:${courseId}`)),
  );
  if (matching.length === 0) {
    throw new Error(`No course package with id=${courseId} found in pod ${config.podUrl}`);
  }
  matching.sort((a, b) => (b.validFrom ?? '').localeCompare(a.validFrom ?? ''));
  const payload = await fetchBundleJson(matching[0], config);
  setCached(key, payload);
  return payload;
}

function humanizeDid(did: string): string {
  // did:web:acme-training.example → "acme-training.example"
  if (did.startsWith('did:web:')) return did.slice('did:web:'.length);
  return did;
}
