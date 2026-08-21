/**
 * The @context our JSON-LD points at must exist, and must say what the serializer says.
 *
 * ★ THE DEFECT. `toJsonLd` defaults to `remoteContext: true` and emits
 * CONTEXT_GRAPHS_JSONLD_CONTEXT_URL as the document's `@context`. That URL —
 * `…/ns/iep/v1` — answered 404 on the live host, measured beside its sibling
 * `…/ns/iep.ttl` which answered 200. Dereferencing a remote context is not optional for a
 * consumer: a JSON-LD 1.1 processor that cannot load it fails the ENTIRE document with
 * `loading remote context failed`. So the default output of our JSON-LD projection was
 * unprocessable by anyone who actually tried to read it, and every test in this repo passed
 * because they all read the in-process constant instead of the URL.
 *
 * ★ WHY `.json` AND NOT THE BARE PATH. GitHub Pages serves an extensionless request from
 * `<path>.html`, and anything it does not recognise as `application/octet-stream` —
 * measured on `orgb/.well-known/context-graphs`, 200 with exactly that type. JSON-LD 1.1
 * requires `application/ld+json`, `application/json`, or a `+json` suffix, so publishing at
 * the bare path would have turned a 404 into a 200 the processor still refuses. Fixing the
 * status code without fixing the media type would have looked like a fix and not been one.
 *
 * These tests are offline: they check that the file exists at the path the URL resolves to
 * and that its bytes match the constant. Whether the host serves it is a deploy-time fact
 * this suite cannot assert without a network call, and tests/shape-namespaces-resolve.test.ts
 * is the sibling gate that keeps the published-path convention honest.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { CONTEXT_GRAPHS_JSONLD_CONTEXT, CONTEXT_GRAPHS_JSONLD_CONTEXT_URL } from '@interego/core';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..');
const PAGES_BASE = 'https://markjspivey-xwisee.github.io/interego/';

/** The repo file GitHub Pages would serve for a Pages URL. */
function publishedPathFor(url: string): string {
  expect(url.startsWith(PAGES_BASE), `${url} is not on the Pages base`).toBe(true);
  return join(REPO, 'docs', url.slice(PAGES_BASE.length));
}

describe('the remote @context the serializer advertises', () => {
  it('is published at the path its URL resolves to', () => {
    const file = publishedPathFor(CONTEXT_GRAPHS_JSONLD_CONTEXT_URL);
    expect(existsSync(file), `${CONTEXT_GRAPHS_JSONLD_CONTEXT_URL} has no file behind it at `
      + `${file}. A remote @context that 404s fails the whole document for every consumer.`)
      .toBe(true);
  });

  it('carries a media-type extension this host serves acceptably', () => {
    // Not cosmetic: see the module note. `.html` and extensionless both fail the JSON-LD
    // content-type requirement even when they return 200.
    expect(CONTEXT_GRAPHS_JSONLD_CONTEXT_URL).toMatch(/\.(json|jsonld)$/);
  });

  it('says exactly what the in-process constant says', () => {
    // The drift that matters. A published context that has fallen behind the serializer
    // does not error — it expands terms to the WRONG IRIs, silently, in the consumer.
    const published = JSON.parse(readFileSync(publishedPathFor(CONTEXT_GRAPHS_JSONLD_CONTEXT_URL), 'utf8'));
    expect(published).toEqual(CONTEXT_GRAPHS_JSONLD_CONTEXT);
  });

  it('is a context document, not a graph that merely mentions one', () => {
    const published = JSON.parse(readFileSync(publishedPathFor(CONTEXT_GRAPHS_JSONLD_CONTEXT_URL), 'utf8'));
    expect(Object.keys(published)).toEqual(['@context']);
    expect(Object.keys(published['@context']).length).toBeGreaterThan(20);
  });
});

describe('and the serializer still reaches for it by default', () => {
  it('defaults to the remote context rather than inlining', () => {
    // If this ever flips to inline-by-default the tests above stop protecting anything,
    // because nothing would emit the URL. Recorded so that change is a deliberate one.
    const src = readFileSync(join(REPO, 'packages/core/src/rdf/jsonld.ts'), 'utf8');
    expect(src).toMatch(/remoteContext\s*=\s*true/);
  });
});
