/**
 * Following a page's own advertised Turtle representation.
 *
 * ★ WHY THIS SUITE IS HERE AND NOT ONLY IN THE RELAY. `looksLikeHtml` and `alternateTurtleHref`
 * were written in `deploy/mcp-relay/alternate-turtle.ts` because GitHub Pages ignores Accept and
 * serves `text/html` for our own ontology IRIs, and that bit the publish path three times. It
 * then bit a SECOND reader: `dereferenceRoleProfile` in `applications/shared-workspace` called
 * the only published role profile in existence `unreadable — unknown bareword "Default"` on the
 * day `docs/applications/shared-workspace/wsp-roles-default.html` shipped so the vocabulary's
 * IRIs would dereference at all.
 *
 * The two predicates therefore moved to @interego/core, and the resolution and hop that had
 * lived inline in `server.ts` came with them as `alternateTurtleUrl` and
 * `followAlternateTurtle`. The relay's own suite
 * (`deploy/mcp-relay/tests/alternate-turtle-link.test.ts`) still pins the two predicates through
 * the relay's re-export, byte for byte against real published markup. This file pins the parts
 * that are new: WHERE the href resolves to, WHOSE origin may answer, and HOW MANY times the
 * follower may hop.
 *
 * ★ EVERY GUARD BELOW IS A REFUSAL PAIRED WITH A CONTROL. A follower that refused everything
 * would satisfy each refusal case on its own and be useless, which is the failure mode the
 * workspace suites are a record of.
 */

import { describe, it, expect, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  looksLikeHtml, alternateTurtleHref, alternateTurtleUrl, followAlternateTurtle,
  type FetchedRepresentation,
} from '@interego/core';

const PAGE = 'https://pages.test/ns/roles';
const TTL = '@prefix wsp: <https://wsp.test/wsp#> .\n<https://pages.test/ns/roles> a wsp:RoleProfile .\n';

/** A page advertising `href` as its Turtle, in the shape our generator actually emits. */
const pageAdvertising = (href: string): string =>
  '<!doctype html>\n<html lang="en">\n<head>\n<meta charset="utf-8" />\n'
  + `<link rel="alternate" type="text/turtle" href="${href}" />\n`
  + `<link rel="describedby" type="text/turtle" href="${href}" />\n`
  + '</head>\n<body><h1>Roles</h1></body>\n</html>\n';

const served = (
  url: string, body: string, over: Partial<FetchedRepresentation> = {},
): FetchedRepresentation => ({
  status: 200, url, contentType: looksLikeHtml(body) ? 'text/html' : 'text/turtle', body, ...over,
});

/** A web of URL → representation, recording every URL the follower asked for. */
const webOf = (web: Record<string, FetchedRepresentation>) => {
  const asked: string[] = [];
  const fetchDocument = vi.fn(async (url: string) => {
    asked.push(url);
    const r = web[url];
    if (r === undefined) {
      return served(url, '<!doctype html><h1>404</h1>', { status: 404 });
    }
    return r;
  });
  return { asked, fetchDocument };
};

describe('alternateTurtleUrl — where the advertised Turtle actually is', () => {
  it('★ resolves a RELATIVE href against the page\'s own URL, which is what every page we publish writes', () => {
    // ★ THE ONE THAT MATTERS FOR THE DEPLOYED ARTIFACT. `wsp-roles-default.html` advertises
    // `href="wsp-roles-default.ttl"` and `docs/ns/iep.html` advertises `href="iep.ttl"`. Treating
    // either as absolute yields a URL with no scheme and no host, so a follower that skipped the
    // resolution would fetch nothing for the only pages the mechanism exists to read — and would
    // look like a working follower right up until somebody published an absolute href.
    expect(alternateTurtleUrl(PAGE, pageAdvertising('roles.ttl')))
      .toEqual({ url: 'https://pages.test/ns/roles.ttl' });
    // …and the resolution is a real URL resolution, not a concatenation: `..`, a root-relative
    // path and a protocol-relative href all land where RFC 3986 says they land.
    expect(alternateTurtleUrl(PAGE, pageAdvertising('../vocab/roles.ttl')))
      .toEqual({ url: 'https://pages.test/vocab/roles.ttl' });
    expect(alternateTurtleUrl(PAGE, pageAdvertising('/r.ttl')))
      .toEqual({ url: 'https://pages.test/r.ttl' });
    // An ABSOLUTE href on the same origin is passed through unchanged, which is the control that
    // stops "resolve relative" being implemented as "always prepend the directory".
    expect(alternateTurtleUrl(PAGE, pageAdvertising('https://pages.test/elsewhere/r.ttl')))
      .toEqual({ url: 'https://pages.test/elsewhere/r.ttl' });
  });

  it('★★ refuses a CROSS-ORIGIN alternate — a foreign origin naming our Turtle is not our Turtle', () => {
    // For a document nobody signs, the origin is the entire evidence. A page that names a
    // foreign origin's Turtle as its own representation hands that claim to a party the caller
    // never asked, while the caller still believes it read what the IRI returns.
    const foreign = alternateTurtleUrl(PAGE, pageAdvertising('https://evil.test/roles.ttl'));
    expect('why' in foreign && foreign.why).toMatch(/different origin/);
    // Port and scheme are part of an origin, so neither may be changed by an href either. A
    // same-HOST check would admit both.
    expect('why' in alternateTurtleUrl(PAGE, pageAdvertising('https://pages.test:8443/r.ttl'))).toBe(true);
    expect('why' in alternateTurtleUrl(PAGE, pageAdvertising('http://pages.test/r.ttl'))).toBe(true);
  });

  it('★ refuses an OPAQUE origin on either side rather than comparing two of them', () => {
    // ★ `data:` and `file:` both report the origin string 'null' in Node, so a bare `!==` reads
    // them as SAME-origin and admits exactly the case with no origin to trust. Measured: a
    // `file:` page advertising a `data:` URI compares equal.
    expect('why' in alternateTurtleUrl(PAGE, pageAdvertising('data:text/turtle,<a><b><c>.'))).toBe(true);
    expect('why' in alternateTurtleUrl('file:///tmp/roles.html', pageAdvertising('roles.ttl'))).toBe(true);
  });

  it('★ says which step failed when there is no alternate to follow at all', () => {
    // The distinction a caller acts on: "this page does not advertise Turtle" sends somebody to
    // the publisher, "the href does not resolve" sends them to the markup.
    const none = alternateTurtleUrl(PAGE, '<!doctype html><html><body>404</body></html>');
    expect('why' in none && none.why).toMatch(/advertises no <link rel="alternate"/);
    const unresolvable = alternateTurtleUrl('not a url', pageAdvertising('roles.ttl'));
    expect('why' in unresolvable && unresolvable.why).toMatch(/does not resolve to a URL/);
  });

  it('★ reads the REAL published page, so a change to the generator breaks this rather than production', () => {
    // The same discipline as the relay suite's byte-for-byte fixture, applied to the page whose
    // absence caused the outage: this is the file `docs/` deploys, read off disk.
    const html = readFileSync(
      fileURLToPath(new URL('../docs/applications/shared-workspace/wsp-roles-default.html', import.meta.url)),
      'utf8',
    );
    expect(looksLikeHtml(html)).toBe(true);
    expect(alternateTurtleHref(html)).toBe('wsp-roles-default.ttl');
    const iri = 'https://markjspivey-xwisee.github.io/interego/applications/shared-workspace/wsp-roles-default';
    expect(alternateTurtleUrl(iri, html)).toEqual({ url: `${iri}.ttl` });
  });
});

describe('followAlternateTurtle — one hop, and only one', () => {
  it('★ a body that is already Turtle is returned untouched, with no fetch at all', async () => {
    const { fetchDocument, asked } = webOf({});
    const got = await followAlternateTurtle(served(PAGE, TTL), fetchDocument);
    expect('representation' in got && got.representation.body).toBe(TTL);
    expect('representation' in got && got.hops).toBe(0);
    // Calling the follower on Turtle is the identity. That matters because the alternative shape
    // — every call site checking `looksLikeHtml` first — puts the HTML predicate back at every
    // call site, which is the duplication this module exists to remove.
    expect(asked).toEqual([]);
  });

  it('★★ follows the href the PAGE names, not an extension a reader guessed', async () => {
    // ★ THE CASE NO LIVE RUN CAN MAKE. Our own page advertises `wsp-roles-default.ttl`, which is
    // also what a `.ttl`-appending guesser would derive, so production cannot separate following
    // from guessing. Here the advertised name is DIFFERENT from the guess, and only a follower
    // reaches it.
    const { fetchDocument, asked } = webOf({
      'https://pages.test/ns/governance-v2.ttl': served('https://pages.test/ns/governance-v2.ttl', TTL),
      // The guess is right there in the web and answers with something else, so a guesser
      // succeeds — with the wrong document — instead of failing loudly.
      'https://pages.test/ns/roles.ttl': served('https://pages.test/ns/roles.ttl', '# not this one\n'),
    });
    const got = await followAlternateTurtle(
      served(PAGE, pageAdvertising('governance-v2.ttl')), fetchDocument,
    );
    expect('representation' in got && got.representation.body).toBe(TTL);
    expect('representation' in got && got.hops).toBe(1);
    expect(asked).toEqual(['https://pages.test/ns/governance-v2.ttl']);
  });

  it('★★ HOPS EXACTLY ONCE — a page whose alternate is another page is refused, not chased', async () => {
    // ★ THE BOUND IS THE GUARD, AND THE ASSERTION IS THE FETCH COUNT RATHER THAN THE OUTCOME. A
    // self-referential `href`, a directory index, a soft-404 that advertises itself: all real
    // shapes a misconfigured static host produces, and an unbounded follower spins on one
    // forever inside an authorization path. Raising the budget to 2 still terminates and still
    // refuses — only `asked` can see the difference, so `asked` is what is asserted.
    const selfPointing = pageAdvertising('roles.ttl');
    const { fetchDocument, asked } = webOf({
      'https://pages.test/ns/roles.ttl': served(
        'https://pages.test/ns/roles.ttl', pageAdvertising('roles.ttl'),
      ),
    });
    const got = await followAlternateTurtle(served(PAGE, selfPointing), fetchDocument);
    expect('why' in got && got.why).toMatch(/bounded at 1 hop/);
    expect(asked).toEqual(['https://pages.test/ns/roles.ttl']);
  });

  it('★ a REDIRECT off the origin on the hop is refused, which an href check alone cannot see', async () => {
    // `alternateTurtleUrl` refuses a cross-origin HREF. A same-origin href that redirects away
    // arrives here instead, and reading the response without this check would let a redirect
    // reach exactly what a foreign href is refused for.
    const { fetchDocument } = webOf({
      'https://pages.test/ns/roles.ttl': served('https://evil.test/roles.ttl', TTL),
    });
    const got = await followAlternateTurtle(served(PAGE, pageAdvertising('roles.ttl')), fetchDocument);
    expect('why' in got && got.why).toMatch(/a different origin from the page that advertised it/);
    // …and the CONTROL: a same-origin redirect is followed, because a host serving `/x` as
    // `/x.ttl` has not changed who is answering.
    const same = webOf({
      'https://pages.test/ns/roles.ttl': served('https://pages.test/ns/roles-v3.ttl', TTL),
    });
    const okGot = await followAlternateTurtle(
      served(PAGE, pageAdvertising('roles.ttl')), same.fetchDocument,
    );
    expect('representation' in okGot && okGot.representation.url).toBe('https://pages.test/ns/roles-v3.ttl');
  });

  it('★ an absent, missing or throwing alternate all refuse, and each names its own step', async () => {
    // Every branch is a refusal with a reason that sends a reader somewhere different: the
    // publisher, the URL, or the network.
    const { fetchDocument: noLink } = webOf({});
    const absent = await followAlternateTurtle(
      served(PAGE, '<!doctype html><h1>Not found</h1>'), noLink,
    );
    expect('why' in absent && absent.why).toMatch(/advertises no <link rel="alternate"/);

    // A page that advertises a Turtle that 404s — the state `docs/` was in before the `.html`
    // page shipped, one level down.
    const { fetchDocument: missing } = webOf({});
    const gone = await followAlternateTurtle(served(PAGE, pageAdvertising('roles.ttl')), missing);
    expect('why' in gone && gone.why).toMatch(/answered 404/);

    const throwing = vi.fn(async () => { throw new Error('socket hang up'); });
    const threw = await followAlternateTurtle(served(PAGE, pageAdvertising('roles.ttl')), throwing);
    expect('why' in threw && threw.why).toMatch(/threw: socket hang up/);
  });
});
