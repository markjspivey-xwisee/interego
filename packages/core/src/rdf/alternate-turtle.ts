/**
 * Following a page's own advertised Turtle representation.
 *
 * ★ WHY THIS IS ITS OWN MODULE. Our ontology IRIs do not content-negotiate: GitHub Pages
 * ignores Accept and serves `text/html` for `https://…/ns/iep`. That bit the publish path
 * three separate times — a good shape looked unreachable, an `owl:imports` of one corrupted
 * the graph it was glued into, and last-known-good had to distrust any body that did not
 * parse.
 *
 * ★★ AND WHY IT IS IN @interego/core RATHER THAN IN THE RELAY, WHICH IS WHERE IT WAS WRITTEN.
 * It bit a SECOND reader, on a page the same publishing convention produced. Shipping
 * `docs/applications/shared-workspace/wsp-roles-default.html` so the vocabulary's extensionless
 * IRIs finally dereference turned that IRI from a 404 into a 200 `text/html` — and
 * `dereferenceRoleProfile` in `applications/shared-workspace/src/membership.ts`, which fetches
 * the role-profile IRI a workspace declares and parses the body as Turtle, answered
 * `unreadable: … unknown bareword "Default"`. Every workspace in that vertical declares that
 * IRI, so the published governance became unreadable to the only reader of it.
 *
 * Two independent readers of the same web needed the same follower. The alternative — a second
 * regex over untrusted markup in `applications/` — is precisely the duplication this module was
 * carved out of `server.ts` to prevent, and the two copies would drift in exactly the way that
 * is invisible until a page is written the other way round. So the predicates moved to the one
 * package both sides already depend on, and `deploy/mcp-relay/alternate-turtle.ts` re-exports
 * them so the relay's import surface is unchanged. Same move and same reason as
 * `graphIriFromDescriptorTurtle` and `digestedGraphRegion`, which left the relay for
 * @interego/solid when a reader outside the relay turned out to need them.
 *
 * These predicates are the fragile part of the fix (regexes over untrusted markup), so they
 * live apart from any module that opens a listener on import and therefore cannot be pulled
 * into a unit test.
 */

/**
 * A body is HTML if it OPENS as HTML. Leading whitespace, a BOM, and a leading comment are
 * tolerated.
 *
 * ★ The dangerous direction here is a false positive, not a false negative: Turtle is full of
 * angle brackets (`<https://…> a <…> .`), and a loose predicate would send a perfectly good
 * shape down the HTML path and drop it. Hence an explicit HTML opener rather than
 * "starts with `<`".
 */
export function looksLikeHtml(body: string): boolean {
  // ★ `\uFEFF` AS AN ESCAPE, NOT AS A LITERAL BOM. The relay's copy carried the raw character,
  // which `no-irregular-whitespace` refuses under this package's eslint config — `deploy/` is not
  // in the lint targets and `packages/` is, so the move surfaced it. Same character, same match;
  // the escape is also the only spelling a reviewer can SEE in a diff.
  return /^\uFEFF?\s*<(?:!doctype\s+html|html[\s>]|!--)/i.test(body);
}

/**
 * The Turtle representation a page advertises for itself, or null.
 *
 * The reflex fix for a non-negotiating IRI is to append `.ttl`. That reinvents a mechanism
 * that already exists AND is already published — every generated page in `docs/ns` and every
 * page in `docs/applications/shared-workspace` carries its own
 * `<link rel="alternate" type="text/turtle">`. The publishing side was already
 * standards-correct; we simply were not reading it. Following the advertised link works for
 * ANY publisher that does the same thing, where guessing an extension only ever works for
 * ours.
 *
 * ★ `rel` and `type` are matched independently inside one tag rather than in a fixed
 * sequence: HTML does not fix attribute order, and an ordered rel-then-type regex passes a
 * hand-written test while missing real markup that spells the attributes the other way.
 *
 * Only `alternate` and `describedby` qualify. `rel=preload` also names a Turtle file, but it
 * is a resource to go fetch rather than an encoding of THIS resource — following one would
 * glue an unrelated graph into the shapes graph.
 */
export function alternateTurtleHref(html: string): string | null {
  for (const tag of html.match(/<link\b[^>]*>/gi) ?? []) {
    if (!/\btype\s*=\s*["']?text\/turtle["']?/i.test(tag)) continue;
    if (!/\brel\s*=\s*["']?(?:alternate|describedby)["']?/i.test(tag)) continue;
    const href = tag.match(/\bhref\s*=\s*["']([^"']+)["']/i)?.[1]?.trim();
    if (href) return href;
  }
  return null;
}

/**
 * The ABSOLUTE, SAME-ORIGIN URL a page advertises its Turtle at — or the reason there is none.
 *
 * ★ RESOLVED AGAINST THE PAGE'S OWN URL, BECAUSE EVERY PAGE WE PUBLISH WRITES A RELATIVE HREF.
 * `wsp-roles-default.html` advertises `href="wsp-roles-default.ttl"` and `docs/ns/iep.html`
 * advertises `href="iep.ttl"`. Treating either as absolute yields a URL with no scheme and no
 * host, so a follower that skipped this step would fetch nothing for the only pages the
 * mechanism exists to read — and would look like a working follower until somebody published a
 * page with an absolute href.
 *
 * ★★ AND A CROSS-ORIGIN ALTERNATE IS REFUSED, NOT FOLLOWED. This is the one thing the resolver
 * decides that is a security property rather than a convenience. For a document nobody signs —
 * a static Pages file has nowhere to put a proof a reader could bind to it — the ORIGIN is the
 * entire evidence, so "this origin served these bytes" is the whole of what a fetch establishes.
 * A page that names a foreign origin's Turtle as its own representation would hand that claim
 * to a party the caller never asked, while the caller still believes it read what the IRI
 * returns. A foreign origin naming our Turtle is not our Turtle, and the same in reverse.
 *
 * An opaque origin (`file:`, `data:` — Node reports the string `'null'` for both) is refused on
 * either side rather than compared: two opaque origins compare EQUAL, so a plain `!==` would
 * read `data:` and `file:` as same-origin and admit exactly the case with no origin to trust.
 */
export function alternateTurtleUrl(
  pageUrl: string,
  html: string,
): { readonly url: string } | { readonly why: string } {
  const href = alternateTurtleHref(html);
  if (href === null) {
    return { why:
      'it advertises no <link rel="alternate" type="text/turtle">, so the page does not say '
      + 'where its Turtle is. Appending an extension instead would be guessing a URL on the '
      + 'publisher\'s behalf, which only ever works for publishers that spell things the way '
      + 'we do',
    };
  }
  let page: URL;
  let target: URL;
  try {
    page = new URL(pageUrl);
    target = new URL(href, pageUrl);
  } catch {
    return { why:
      `its rel=alternate href "${href}" does not resolve to a URL against <${pageUrl}>, so `
      + 'there is nothing to fetch',
    };
  }
  if (page.origin === 'null' || target.origin === 'null') {
    return { why:
      `its rel=alternate resolves to <${target.toString()}>, and one of that URL and <${pageUrl}> `
      + 'has no origin to compare. A document nobody signed is worth exactly the origin that '
      + 'served it, and an opaque origin is not one',
    };
  }
  if (target.origin !== page.origin) {
    return { why:
      `its rel=alternate points at <${target.toString()}>, which is a different origin from the `
      + `page at <${pageUrl}>. The origin IS the authority for an unsigned document, so a page `
      + 'naming somebody else\'s Turtle as its own representation is refused rather than '
      + 'followed',
    };
  }
  return { url: target.toString() };
}

/** One fetched representation, as the caller's own HTTP client reported it. */
export interface FetchedRepresentation {
  readonly status: number;
  /** The URL the bytes actually came FROM, after any redirect. Not the URL asked for. */
  readonly url: string;
  readonly contentType: string | null;
  readonly body: string;
}

/**
 * How many times {@link followAlternateTurtle} may hop from a page to its advertised Turtle.
 *
 * ★ ONE, AND THE BOUND IS A CONSTANT RATHER THAN THE ABSENCE OF A LOOP so that it can be
 * mutated and the mutation killed. A page whose alternate points at another HTML page — a
 * self-referential `href`, a directory index, a soft-404 that advertises itself — is not
 * hypothetical: it is what a misconfigured static host produces, and an unbounded follower
 * spins on it forever inside an authorization path. Two hops is not "more thorough"; it is a
 * reader that will chase a chain of pages some publisher controls.
 */
const ALTERNATE_HOP_BUDGET = 1;

/**
 * Given a page already fetched, yield the representation whose bytes are Turtle — following
 * the page's own advertised alternate AT MOST ONCE — or the reason there is none.
 *
 * ★ A BODY THAT IS ALREADY NOT HTML IS RETURNED UNTOUCHED, with `hops: 0`. The caller does not
 * have to decide whether to call this; calling it on Turtle is the identity. That matters
 * because the alternative shape — "caller checks `looksLikeHtml` and only then follows" — puts
 * the HTML predicate back at every call site, which is the duplication this module exists to
 * remove.
 *
 * ★ FOLLOWING AN ALTERNATE IS TRANSPORT AND NOTHING MORE. The extra hop must never read as a
 * stronger guarantee than the first fetch: a static page carries no authorship proof and no
 * digested region either side of the hop, and the same-origin refusal in
 * {@link alternateTurtleUrl} is what stops it becoming a WEAKER one. What a caller has after
 * this returns is exactly what it had before — this origin served these bytes at this URL —
 * and any caller that grades a followed document above an unfollowed one is reporting a
 * guarantee nobody made.
 *
 * `fetchDocument` is the caller's own client, so the guards it already applies (SSRF
 * allowlisting in the relay, `https:`-only in the workspace reader) apply to the hop too. This
 * function performs no I/O of its own.
 */
export async function followAlternateTurtle(
  page: FetchedRepresentation,
  fetchDocument: (url: string) => Promise<FetchedRepresentation>,
): Promise<
  | { readonly representation: FetchedRepresentation; readonly hops: number }
  | { readonly why: string }
> {
  let current = page;
  let hops = 0;
  while (looksLikeHtml(current.body)) {
    if (hops >= ALTERNATE_HOP_BUDGET) {
      return { why:
        `the Turtle <${page.url}> advertised is at <${current.url}>, and that is HTML too. The `
        + `follow is bounded at ${ALTERNATE_HOP_BUDGET} hop: a page whose alternate points at `
        + 'another page would otherwise be chased for as long as its publisher kept the chain '
        + 'going',
      };
    }
    const target = alternateTurtleUrl(current.url, current.body);
    if ('why' in target) return { why: target.why };

    let next: FetchedRepresentation;
    try {
      next = await fetchDocument(target.url);
    } catch (e) {
      return { why:
        `fetching the Turtle it advertises at <${target.url}> threw: `
        + `${e instanceof Error ? e.message : String(e)}`,
      };
    }
    hops += 1;
    if (next.status !== 200) {
      return { why:
        `the Turtle it advertises at <${target.url}> answered ${next.status}, so the page names `
        + 'a representation of itself that does not exist',
      };
    }
    // ★ THE LANDED URL, NOT THE URL ASKED FOR. `alternateTurtleUrl` refuses a cross-origin
    // HREF; a same-origin href that REDIRECTS off the origin arrives here instead, and reading
    // the response without this check would let a redirect do what the href was refused for.
    let landedElsewhere: boolean;
    try {
      const landed = new URL(next.url);
      landedElsewhere = landed.origin === 'null' || landed.origin !== new URL(page.url).origin;
    } catch {
      // An unparseable final URL is not a same-origin answer, and reading it as one would make
      // a malformed response the way past this guard.
      landedElsewhere = true;
    }
    if (landedElsewhere) {
      return { why:
        `the Turtle it advertises at <${target.url}> was served from <${next.url}>, a different `
        + 'origin from the page that advertised it. A redirect must not reach what a '
        + 'cross-origin href is refused for',
      };
    }
    current = next;
  }
  return { representation: current, hops };
}
