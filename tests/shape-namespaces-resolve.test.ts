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
  // ★ THIS LIST IS ENUMERATED BY HAND, AND THAT IS WHAT LET AGGREGATE_NS THROUGH. It was
  // added later, in a different tree (applications/_shared/), and nobody came back here —
  // so a namespace whose ELEVEN terms are written to participant pods by publish() 404'd
  // at its own authority while this file stayed green with a single entry in it. A
  // one-entry allowlist does not catch the namespace nobody remembered; every new
  // Pages-base namespace constant is registered here at the moment it is written.
  //
  // NOT converted to whole-tree discovery on purpose: applications/foxxi-content-
  // intelligence declares ns/iep/v1#, ns/pgsl/v1#, ns/ac/v1# and ns/amta/v1#, none of
  // which are published. Auto-discovery would fail this gate on a different vertical's
  // defect and take master red for something this change does not fix.
  {
    source: 'applications/_shared/aggregate-privacy/index.ts',
    constant: 'AGGREGATE_NS',
    re: /AGGREGATE_NS\s*=\s*['"]([^'"]+)['"]/,
  },
];

/**
 * How GitHub Pages actually resolves the request, which is not what `existsSync` on the
 * bare path answers. Pages serves an extensionless request from `<path>.html`; that is why
 * `…/organizational-working-memory/owm` returns 200 with only owm.html and owm.ttl on disk.
 * A gate that checked the bare path alone would have REJECTED the correct fix — publish a
 * .ttl and its .html companion, exactly as every sibling vocabulary does.
 */
const PAGES_CANDIDATES = ['', '.html', '.ttl'] as const;

/** The agg: terms the runtime actually writes to a pod. Grep `agg:` against publish(). */
const AGG_PUBLISHED_TERMS = [
  'CohortParticipation', 'AttestedHomomorphicSumBundle', 'AttestedHomomorphicDistributionBundle',
  'SignedBudgetAuditLog', 'CommitteeAuthorization', 'EncryptedShareDistribution',
  'CommitteeReconstructionAttestation', 'cohort', 'participant', 'policy', 'bundleJson',
] as const;

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
      const hit = PAGES_CANDIDATES.find((ext) => existsSync(join(REPO, 'docs', path + ext)));
      expect(hit,
        `${constant} declares ${ns}\n  → nothing at docs/${path}`
        + PAGES_CANDIDATES.map((e) => e || ' (no extension)').join(', ')
        + '\n  → publish the bytes at the declared path; do NOT rename the IRI to match the file')
        .toBeDefined();
    });
  }

  it('the aggregate-privacy vocabulary declares every term the runtime publishes', () => {
    // ★ A namespace document that EXISTS but omits the terms is the same 404 one level
    // down: an RDF client following its nose from agg:bundleJson lands on bytes that never
    // mention it. Without this, the .ttl added alongside could have been an empty file and
    // the path assertion above would still be green.
    const ttl = readFileSync(join(REPO, 'docs/applications/_shared/aggregate-privacy.ttl'), 'utf8');
    const missing = AGG_PUBLISHED_TERMS.filter((t) => !ttl.includes(`agg:${t} a owl:`));
    expect(
      missing,
      `published to pods but undeclared in the namespace document: ${missing.join(', ')}`,
    ).toEqual([]);
  });

  it('the design specs cite paths that exist', () => {
    // ★ Both specs cited `src/crypto/zk/` and `src/crdt/`. There is no top-level src/ in
    // this repo — the tree moved under packages/ and nothing re-read a Status block, so the
    // citations pointed at a directory that has not existed for two restructures. Prose
    // sentiment cannot be pinned by a test; a cited path can, and that is the part that
    // silently rots. Scoped to these two files deliberately: a repo-wide sweep finds 138
    // dead links across 153 markdown files and would fail on documents this change does
    // not touch.
    for (const spec of ['spec/AGGREGATE-PRIVACY.md', 'spec/CRDT-OFFLINE-MERGE.md']) {
      const text = readFileSync(join(REPO, spec), 'utf8');
      for (const m of text.matchAll(/`((?:src|packages|applications|tests|tools|docs|spec)\/[^`]*)`/g)) {
        const raw = m[1];
        if (raw === undefined) continue;
        const cited = raw.replace(/\/$/, '');
        expect(existsSync(join(REPO, cited)), `${spec} cites \`${raw}\`, which does not exist`).toBe(true);
      }
    }
  });

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
