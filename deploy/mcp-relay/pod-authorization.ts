/**
 * @module pod-authorization
 * @description Deciding whether a bearer may act on a pod URL — and whose URL it is.
 *
 * ★★ THE RELAY WAS SCREENING ITS OWN VALUE WITH THE ATTACKER-URL GUARD, AND IT MADE A LIVE
 * ENDPOINT UNREACHABLE.
 *
 * `requireAuthorizedPodUrl` ran every pod URL through `assertPublicPodUrl` — a function whose
 * entire job is refusing an address an attacker chose. `/notifications/:podSlug` does not take a
 * pod URL from the caller: it looks the slug up in `podSlugToUrl`, a map the relay populated
 * itself from `CSS_URL`. In production `CSS_URL` is `http://css.railway.internal:3456/`.
 *
 * Measured directly against the shipped guard:
 *
 *   assertPublicPodUrl('http://css.railway.internal:3456/u-eth-…/')  -> throws "pod URL must use https"
 *   assertPublicPodUrl('https://gate.interego.xwisee.com/u-eth-…/')  -> accepted
 *
 * So the endpoint answered 400 `pod_url_rejected` for every caller — and `publish_context` hands
 * that exact URL back as `notifications.sse_url`, with a comment inviting `EventSource(...)` on it.
 * The public spelling did not work either: the owner URL the token resolves to is built from
 * `CSS_URL` too, so a public supplied URL cleared the screen and then failed the origin comparison
 * with 403. Both spellings of one store were refused, for two different reasons.
 *
 * ★ WHAT IS DELIBERATELY NOT DONE HERE. The screen is not weakened and is not moved. It still runs,
 * unchanged, on every URL that arrived from outside. The only change is that a URL the relay minted
 * is authorized against the store it came from instead of being screened as though a stranger had
 * proposed it. That distinction — screen the RAW caller value and nothing else — is the same one
 * the `recipientKeyFor` fix turned on, and getting it backwards is how a fold upstream of a screen
 * becomes decoration.
 */

export interface PodAuthorizationInput {
  /** The pod URL to authorize. */
  readonly suppliedUrl: string;
  /** The pod the bearer resolves to. */
  readonly ownerPodUrl: string;
  /** Every origin that is this deployment's own store — both spellings of it. */
  readonly storeOrigins: ReadonlySet<string>;
  /**
   * TRUE only when `suppliedUrl` came out of the relay's own state (a slug map, a stored
   * registration) rather than from the request. A caller can never set this.
   */
  readonly relayMinted: boolean;
  /**
   * The SSRF screen, injected so this module can be tested without importing server.ts (which
   * calls app.listen() at module scope and cannot be imported). Applied to caller-supplied URLs
   * ONLY. Throws to refuse.
   */
  readonly screen: (url: string) => URL;
}

/**
 * A single shape with optional fields rather than a discriminated union: `deploy/mcp-relay`
 * compiles with `"strict": false` (tsconfig.json:11), and without `strictNullChecks` TypeScript
 * does not narrow a union on an `ok: true | false` discriminant — `if (!d.ok) d.status` fails to
 * compile. `action-authority.ts` uses the same shape for the same reason. `ok` is the only field
 * a caller may branch on; the rest are present exactly when it says they are.
 */
export interface PodAuthorization {
  readonly ok: boolean;
  /** The authorized URL, when ok. */
  readonly url?: string;
  /** HTTP status to answer with, when not ok. */
  readonly status?: number;
  /** Stable error code, when not ok. */
  readonly error?: string;
  /** Human-readable reason, when not ok. */
  readonly detail?: string;
}

/** Normalise a path for prefix comparison: always exactly one trailing slash. */
function dirPath(u: URL): string {
  return u.pathname.endsWith('/') ? u.pathname : `${u.pathname}/`;
}

export function authorizePodUrl(input: PodAuthorizationInput): PodAuthorization {
  const { suppliedUrl, ownerPodUrl, storeOrigins, relayMinted, screen } = input;

  let parsed: URL;
  if (relayMinted) {
    // Ours. It still has to BE ours — parse it and require the origin to be this deployment's
    // store. That is a real check, not a bypass: if the slug map ever held something else, this
    // refuses rather than trusting the flag.
    try {
      parsed = new URL(suppliedUrl);
    } catch {
      return { ok: false, status: 500, error: 'pod_url_malformed', detail: 'The relay holds a malformed URL for this pod.' };
    }
    if (!storeOrigins.has(parsed.origin)) {
      return {
        ok: false,
        status: 500,
        error: 'pod_url_not_our_store',
        detail: 'The relay holds a pod URL whose origin is not this deployment\'s store.',
      };
    }
  } else {
    // Caller-supplied. Screened exactly as before, on the raw value.
    try {
      parsed = screen(suppliedUrl);
    } catch (err) {
      return { ok: false, status: 400, error: 'pod_url_rejected', detail: (err as Error).message };
    }
  }

  let ownerParsed: URL;
  try {
    ownerParsed = new URL(ownerPodUrl);
  } catch {
    return { ok: false, status: 500, error: 'owner_pod_malformed', detail: 'owner pod URL is malformed' };
  }

  /**
   * ONE STORE, TWO SPELLINGS — folded by exact-origin set membership, never by prefix or suffix.
   *
   * The owner URL is composed from `CSS_URL` (internal) while a caller legitimately holds the
   * public spelling, so requiring byte-identical origins refused a pod against its own owner. Both
   * origins must be in `storeOrigins` for the fold to apply; anything else still demands an exact
   * match, so a third-party pod host admitted by the host allowlist is unaffected.
   *
   * The path-prefix test below is what actually contains this: folding the origin lets
   * `https://gate…/someone-else/` reach the comparison, and the prefix check then refuses it.
   */
  const sameOrigin = parsed.origin === ownerParsed.origin
    || (storeOrigins.has(parsed.origin) && storeOrigins.has(ownerParsed.origin));

  if (!sameOrigin || !dirPath(parsed).startsWith(dirPath(ownerParsed))) {
    return {
      ok: false,
      status: 403,
      error: 'pod_not_owned',
      detail: 'pod URL does not belong to the authenticated user',
    };
  }
  return { ok: true, url: suppliedUrl };
}
