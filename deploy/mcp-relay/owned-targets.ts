/** Reconstruct owner-scoped transport addresses without accepting a caller's authority. */
import type { FetchFn } from '@interego/core';

interface Location {
  readonly origin: string;
  readonly parts: readonly string[];
  readonly directory: boolean;
}

function location(value: string): Location {
  if (typeof value !== 'string' || value.length > 16_384 || /[\\\u0000-\u0020\u007f?#]/.test(value)
    || /^https?:\/\/[^/?#]*@/i.test(value)) throw new Error('Unsafe resource URL');
  const rawPath = /^https?:\/\/[^/?#]+(\/[^?#]*)?(?:[?#].*)?$/i.exec(value)?.[1] ?? '';
  if (!/^https?:\/\//i.test(value)) throw new Error('Resource URL must use HTTP or HTTPS');
  const parsed = new URL(value);
  if (!['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password || parsed.search || parsed.hash) throw new Error('Unsafe resource URL');
  const rawParts = rawPath.split('/').slice(1);
  if (rawParts.at(-1) === '') rawParts.pop();
  if (rawParts.length > 64) throw new Error('Resource path is too deep');
  const parts = rawParts.map(part => {
    const decoded = decodeURIComponent(part);
    if (!decoded || decoded.length > 1024 || decoded === '.' || decoded === '..'
      || /[/\\\u0000-\u001f\u007f]/.test(decoded) || /%[0-9a-f]{2}/i.test(decoded)) throw new Error('Unsafe resource path');
    return decoded;
  });
  // Inspect components before WHATWG URL normalization can erase dot segments.
  return { origin: parsed.origin, parts, directory: parsed.pathname.endsWith('/') };
}

function within(parts: readonly string[], prefix: readonly string[]): boolean {
  return parts.length >= prefix.length && prefix.every((part, index) => parts[index] === part);
}

function address(origin: string, parts: readonly string[], directory = false): string {
  let path = '';
  for (const part of parts) path += '/' + encodeURIComponent(part);
  return origin + (path || '/') + (directory && parts.length ? '/' : '');
}

export function createOwnedTargets(cssUrl: string, storeOrigins: ReadonlySet<string>) {
  const css = location(cssUrl);
  if (!css.directory || !storeOrigins.has(css.origin)) throw new Error('Configure a canonical storage base');

  /** Admin maintenance deliberately operates only on this deployment's storage. */
  function maintenancePod(value: string): string {
    const pod = location(value);
    const slug = pod.parts[css.parts.length];
    if (!storeOrigins.has(pod.origin) || !within(pod.parts, css.parts) || pod.parts.length !== css.parts.length + 1
      || !slug || !/^[A-Za-z0-9_-]{1,200}$/.test(slug)) throw new Error('Maintenance requires a pod on this deployment storage');
    return address(css.origin, [...css.parts, slug], true);
  }

  function maintenanceTarget(value: string, selectedPod: string, indexOnly = false): string {
    const pod = location(maintenancePod(selectedPod));
    const target = location(value);
    if (!storeOrigins.has(target.origin) || !within(target.parts, pod.parts) || target.parts.length <= pod.parts.length
      || target.directory) throw new Error('Resource is outside the selected maintenance pod');
    const relative = target.parts.slice(pod.parts.length);
    if (indexOnly && (relative.length !== 2 || relative[0] !== '.well-known'
      || !/^context-graphs(?:-archive-\d+)?$/.test(relative[1]!))) throw new Error('Maintenance writes only manifest indexes');
    return address(css.origin, [...pod.parts, ...relative]);
  }

  /** The base comes from verified OAuth attribution, including third-party owned pods. */
  function ownedResource(value: string, verifiedOwnerPod: string): string {
    const owner = location(verifiedOwnerPod);
    const target = location(value);
    const storeAlias = storeOrigins.has(owner.origin) && storeOrigins.has(target.origin);
    if ((owner.origin !== target.origin && !storeAlias) || !within(target.parts, owner.parts)
      || target.parts.length <= owner.parts.length || target.directory) throw new Error('Resource is outside the verified owner pod');
    const relative = target.parts.slice(owner.parts.length);
    if (storeAlias) {
      const canonical = location(maintenancePod(verifiedOwnerPod));
      return address(css.origin, [...canonical.parts, ...relative]);
    }
    // The requested URL contributes only escaped path components. The authority and
    // owning directory come exclusively from the verified OAuth account binding.
    return address(owner.origin, [...owner.parts, ...relative]);
  }

  return { maintenancePod, maintenanceTarget, ownedResource };
}

/** Existing guarded egress honors manual redirects; callers reject every redirect response. */
export async function fetchWithoutRedirect(fetcher: FetchFn, url: string, init?: Parameters<FetchFn>[1]): Promise<Awaited<ReturnType<FetchFn>>> {
  const callerSignal = (init as { signal?: AbortSignal } | undefined)?.signal;
  const deadline = AbortSignal.timeout(15_000);
  const request = { ...init, redirect: 'manual', signal: callerSignal ? AbortSignal.any([callerSignal, deadline]) : deadline };
  const response = await fetcher(url, request);
  if (response.status >= 300 && response.status < 400) {
    const body = (response as { body?: ReadableStream<Uint8Array> | null }).body;
    await body?.cancel().catch(() => {});
    throw new Error('Owner-scoped requests do not follow redirects');
  }
  return response;
}
