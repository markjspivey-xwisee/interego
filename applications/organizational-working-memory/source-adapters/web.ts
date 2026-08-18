/**
 * Reference web source adapter.
 *
 * Read-only. Verbs:
 *   cat:  fetch a URL, return text (HTML stripped to body text;
 *         non-text content rejected with a clear payload).
 *
 * Intentionally minimal — proves the per-source isolation pattern
 * without the noise of auth flows or pagination. New adapters
 * (drive, slack, github, gmail) follow the same shape with their
 * own quirk handlers.
 */

import { assertSafeFetchTarget, guardedFetchFn } from '@interego/core';
import type { SourceAdapter, NavigationVerb, NavigateArgs } from './index.js';

const MAX_BYTES = 100_000;

function stripHtml(s: string): string {
  // Tiny stripper — enough for casual reading, not a full parser.
  return s
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\s+/g, ' ')
    .trim();
}

async function cat(args: NavigateArgs): Promise<unknown> {
  const uri = String(args['uri'] ?? '');
  if (!/^https?:\/\//.test(uri)) {
    return { ok: false, reason: 'web.cat requires an http(s) URI' };
  }
  /**
   * ── ★★ THIS FETCH HAD NO SSRF SCREEN AT ALL ─────────────────────────────────────────────
   *
   * `uri` is caller-supplied and this fetches it server-side, so without a screen it is a blind
   * SSRF primitive: an internal service, or the cloud metadata endpoint at 169.254.169.254, is one
   * argument away — and this adapter RETURNS THE BODY to the caller, so it is not even blind.
   *
   * The scheme test above is not a screen. `http://169.254.169.254/latest/meta-data/` passes it.
   *
   * ★ The screen is the substrate's now (it was previously implemented inside one vertical and
   * re-implemented at the relay, while this one had neither). `assertSafeFetchTarget` resolves the
   * hostname before allowing the request, so a public name that resolves into private space is
   * caught too — and `guardedFetchFn` re-screens every redirect hop, which matters here because
   * this call follows redirects.
   */
  try {
    await assertSafeFetchTarget(uri);
  } catch (e) {
    return { ok: false, reason: `refused: ${(e as Error).message}` };
  }
  let res: Response;
  try {
    res = await guardedFetchFn(globalThis.fetch)(uri, {
      redirect: 'follow',
      headers: { Accept: 'text/html, text/plain, application/xhtml+xml; q=0.9, */*; q=0.1' },
      signal: AbortSignal.timeout(15_000),
    });
  } catch (e) {
    return { ok: false, reason: `fetch failed: ${(e as Error).message}` };
  }
  const ctype = res.headers.get('content-type') ?? '';
  const isText = /^text\//.test(ctype) || ctype.includes('json') || ctype.includes('xml');
  if (!isText) {
    return { ok: false, status: res.status, content_type: ctype, reason: 'non-text content rejected' };
  }
  let body = await res.text();
  const truncated = body.length > MAX_BYTES;
  if (truncated) body = body.slice(0, MAX_BYTES);
  const stripped = ctype.includes('html') ? stripHtml(body) : body;
  return {
    ok: true,
    uri,
    status: res.status,
    content_type: ctype,
    truncated,
    body_excerpt: stripped.slice(0, 8000),
  };
}

export const webAdapter: SourceAdapter = {
  key: 'web',
  description: 'Read-only web fetch via cat(uri). HTML is stripped to body text; output truncated to keep main-agent context lean.',
  supportedVerbs: ['cat'] as const,
  supportedActions: [] as const,
  navigate: async (verb: NavigationVerb, args: NavigateArgs) => {
    if (verb !== 'cat') return { ok: false, reason: `web adapter does not implement verb "${verb}"` };
    return cat(args);
  },
};
