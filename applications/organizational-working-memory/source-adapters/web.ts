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
import { refuse } from '../../_shared/vertical-bridge/refusal.js';

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

/**
 * ★★ EVERY DECLINE BELOW ANSWERED HTTP 200.
 *
 * `owm.navigate_source` returns this adapter's value unchanged, and the dispatcher derives its
 * status from `kind` — which none of these carried. So the SSRF screen refused a link-local
 * target and the caller was told the fetch SUCCEEDED, with the refusal sitting in a `reason`
 * field it had no reason to read.
 *
 * A repo-wide source census had already cleared this file. It filtered on a key
 * (error|reason|refused|denied) AND a hand-written phrase list, and while `reason` and
 * `refused` both matched the key, no phrase in the list matches
 * "target host is private/loopback/link-local". A census is only as wide as its narrowest
 * conjunct. This was found by POSTING to the bridge instead.
 */
/**
 * ★ THE REFUSALS BELOW KEEP `ok` AND `reason` AS WELL AS THE TYPED FIELDS, DELIBERATELY.
 *
 * `{ ok: false, reason }` is this adapter's PUBLISHED shape — tests/web-adapter-ssrf-screen
 * reads `.reason`, and any client that has been consuming this adapter reads it too. The first
 * attempt at typing these replaced that shape with `{ error }`, which is a breaking change
 * dressed as a fix; the SSRF tests caught it, and nothing else would have.
 *
 * So the message appears twice: once as `reason` for existing readers, once as `error` because
 * that is the field the shared refusal carries. The duplication is the compatibility, not an
 * oversight — removing it silently breaks whoever is still reading `reason`.
 */
async function cat(args: NavigateArgs): Promise<unknown> {
  const uri = String(args['uri'] ?? '');
  if (!/^https?:\/\//.test(uri)) {
    return { ok: false as const, reason: 'web.cat requires an http(s) URI',
      ...refuse(400, 'web.cat requires an http(s) URI',
        'the request named a target this adapter cannot fetch') };
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
    // 403: the target is well-formed and the caller is who they are; the ADDRESS is refused.
    return { ok: false as const, reason: `refused: ${(e as Error).message}`,
      ...refuse(403, `refused: ${(e as Error).message}`,
        'the caller named a target outside the address space this deployment will fetch') };
  }
  let res: Response;
  try {
    res = await guardedFetchFn(globalThis.fetch)(uri, {
      redirect: 'follow',
      headers: { Accept: 'text/html, text/plain, application/xhtml+xml; q=0.9, */*; q=0.1' },
      signal: AbortSignal.timeout(15_000),
    });
  } catch (e) {
    // 502: the request was permitted and the upstream did not answer. Not the caller's doing.
    return { ok: false as const, reason: `fetch failed: ${(e as Error).message}`,
      ...refuse(502, `fetch failed: ${(e as Error).message}`,
        'the upstream this adapter fetches did not complete the request') };
  }
  const ctype = res.headers.get('content-type') ?? '';
  const isText = /^text\//.test(ctype) || ctype.includes('json') || ctype.includes('xml');
  if (!isText) {
    // 415: the upstream answered, with a media type this adapter will not parse. `res.status`
    // is the UPSTREAM's and is kept as data; the refusal status is this bridge's own answer.
    return { ok: false as const, reason: 'non-text content rejected',
      ...refuse(415, 'non-text content rejected',
        'the target returned a media type this adapter does not read'),
      upstream_status: res.status, content_type: ctype };
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
    if (verb !== 'cat') return { ok: false as const, reason: `web adapter does not implement verb "${verb}"`,
      ...refuse(501, `web adapter does not implement verb "${verb}"`,
        'this adapter declares the verb but has no implementation behind it') };
    return cat(args);
  },
};
