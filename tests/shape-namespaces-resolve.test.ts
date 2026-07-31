/**
 * A declared shape namespace must have a file published at the path it names.
 *
 * ★ WHY. `AGP_SHAPES_NS` is `…/agentic-performance-practice/agp/shapes#`, but the file
 * was only ever published at `…/agp-shapes.ttl`. So every `agpsh:` shape IRI 404'd at its
 * own declared authority — and it was the ONE vertical that actually runs shapes.
 *
 * That is invisible until something dereferences it, and it became load-bearing the
 * moment the publish gate started failing closed: a pod declaring an `agpsh:` shape would
 * have had every publish refused, for a reason nothing in the shape or the data explains.
 *
 * The fix was to move the BYTES to the identifier, never the identifier to the bytes — an
 * IRI is what other parties cite, and renaming it to tidy a filename breaks every existing
 * reference. This test pins that the path keeps existing.
 */
import { describe, it, expect } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const PAGES_BASE = 'https://markjspivey-xwisee.github.io/interego/';

/** Namespace constants declared in TS, paired with where docs/ must publish them. */
const DECLARED: ReadonlyArray<{
  readonly source: string; readonly constant: string; readonly re: RegExp;
}> = [
  // Real RegExp literals, not strings passed to `new RegExp` — building the pattern from
  // a string swallowed the backslashes and the guard matched nothing, i.e. it passed
  // vacuously. Exactly the failure class this file exists to catch, one level up.
  {
    source: 'applications/agentic-performance-practice/src/ontology.ts',
    constant: 'AGP_SHAPES_NS',
    re: /AGP_SHAPES_NS\s*=\s*['"]([^'"]+)['"]/,
  },
];

describe('every declared shape namespace resolves to a published file', () => {
  for (const { source, constant, re } of DECLARED) {
    it(`${constant} has a file at the path it declares`, () => {
      const src = readFileSync(join(REPO, source), 'utf8');
      const m = src.match(re);
      expect(m, `${constant} not found in ${source}`).not.toBeNull();

      const ns = m![1]!;
      expect(ns.startsWith(PAGES_BASE), `${constant} is not under the Pages base: ${ns}`).toBe(true);

      // Strip the fragment: the IRI dereferences to the document, not the term.
      const path = ns.slice(PAGES_BASE.length).replace(/#.*$/, '');
      const onDisk = join(REPO, 'docs', path);
      expect(existsSync(onDisk),
        `${constant} declares ${ns}\n  → expected a file at docs/${path}\n  `
        + '→ publish the bytes at the declared path; do NOT rename the IRI to match the file')
        .toBe(true);
    });
  }

  it('the published copy matches its source of truth', () => {
    // Line endings are normalised: git's autocrlf rewrites them on checkout, so a raw
    // byte comparison fails on Windows for content that is in fact identical. What must
    // not drift is the CONTENT.
    const norm = (p: string) =>
      readFileSync(join(REPO, p), 'utf8').split('\r\n').join('\n');
    expect(
      norm('docs/applications/agentic-performance-practice/agp/shapes'),
      'the copy served at the declared IRI has drifted from agp-shapes.ttl',
    ).toBe(norm('docs/applications/agentic-performance-practice/agp-shapes.ttl'));
  });
});
