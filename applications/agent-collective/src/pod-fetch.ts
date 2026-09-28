/**
 * Which fetch a request to a pod goes through, on this vertical's bridge.
 *
 * ★ A POD A CALLER NAMES IS A URL A CALLER CHOSE (Codex, on #558). The bridge's direct routes are
 * unauthenticated, and every handler takes `pod_url`. With the process-wide fetch, a caller could
 * name a loopback, link-local or private-network host, or a public pod whose manifest redirects to
 * one, and `ac.discover_promoted_tools` would read it server-side and answer with what it found.
 * So a caller-named pod is read and written through `guardedFetchFn`, which refuses such a target
 * at the first request and at every redirect hop.
 *
 * The operator's own pod (`AC_DEFAULT_POD_URL`) is configuration, not caller input, and may well
 * sit on a private network beside the bridge; requests to its origin use the plain fetch.
 */

import { guardedFetchFn } from '@interego/core';

const originOf = (url: string): string | undefined => {
  try { return new URL(url).origin; } catch { return undefined; }
};

/** The fetch for a request to `podUrl`, or undefined to use the plain one (the configured pod's origin). */
export function podFetch(
  podUrl: string,
  configuredPod: string | undefined,
  base: typeof globalThis.fetch = globalThis.fetch,
): typeof globalThis.fetch | undefined {
  const configured = configuredPod ? originOf(configuredPod) : undefined;
  if (configured !== undefined && originOf(podUrl) === configured) return undefined;
  return guardedFetchFn(base);
}
