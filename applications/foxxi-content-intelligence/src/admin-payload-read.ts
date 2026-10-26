/** The request-time admin-payload read the bridge's autoFetchAdmin performs, in one shared place. */
import { fetchAdminPayload, fetchSectionStamped, type TenantFetchConfig } from './tenant-fetcher.js';
import { directoryObserverFor, type DirectorySnapshot, type DirectoryUser } from './directory-demand.js';
import { TENANT_TYPES } from './tenant-publisher.js';

/**
 * The bridge's demand loader for its configured tenant directory: every HTTP hop is aborted with
 * `signal`, and the snapshot carries when the pod read behind it started, which for a section
 * served from tenant-fetcher's 60 s cache is the original read's start, not now.
 */
export async function loadConfiguredDirectory(config: TenantFetchConfig, signal: AbortSignal): Promise<DirectorySnapshot> {
  const { value, fetchedAt } = await fetchSectionStamped(TENANT_TYPES.TenantDirectory, {
    ...config,
    fetch: (input, init) => (config.fetch ?? globalThis.fetch)(input, {
      ...init, signal: init?.signal ? AbortSignal.any([init.signal, signal]) : signal,
    }),
  });
  const users = (value as { users?: unknown } | null)?.users;
  if (!Array.isArray(users)) throw new Error('tenant directory users unavailable');
  return { users: users as ReadonlyArray<DirectoryUser>, fetchedAt };
}

export interface AdminPayloadRead {
  /** The fetcher configuration without a pod: the bridge's `fetcherConfig()`. */
  base: Omit<TenantFetchConfig, 'podUrl' | 'forceClosed' | 'onDirectoryLoaded'>;
  /** The pod this read targets, possibly named by an unauthenticated caller. */
  podUrl: string;
  /** The bridge's configured tenant pod (FOXXI_TENANT_POD_URL). */
  configuredPodUrl: string;
  /** Treat the pod as a closed tenant: the bridge sets this for its own pod by `samePod`. */
  forceClosed: boolean;
  /** The process-wide directory every operator gate reads. */
  directory: { observe(users: ReadonlyArray<DirectoryUser>, fetchedAt: number): unknown };
}

/**
 * Read the admin payload for `podUrl`, sharing its directory with the process-wide copy only
 * through `directoryObserverFor`: only a directory section that actually loaded, only from a read
 * of exactly the configured pod URL, and stamped with when that read started. The bridge calls
 * this and nothing else for its request-time read, so a test of this function tests the bridge.
 */
export function readAdminPayload(read: AdminPayloadRead): Promise<unknown> {
  const onDirectoryLoaded = directoryObserverFor(read.podUrl, read.configuredPodUrl, read.directory);
  return fetchAdminPayload({ ...read.base, podUrl: read.podUrl, forceClosed: read.forceClosed,
    ...(onDirectoryLoaded ? { onDirectoryLoaded } : {}) });
}
