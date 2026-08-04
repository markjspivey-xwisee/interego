/**
 * docs-package-layout — the hand-maintained prose renderings of `packages/core/src/*` must
 * describe the tree that exists, and must not promise a package split that already shipped.
 *
 * WHY THIS EXISTS: `@interego/solid` and `@interego/pgsl` were extracted out of core and the
 * docs were not touched. For every commit afterwards, CLAUDE.md / ARCHITECTURAL-FOUNDATIONS.md
 * / packages/core/README.md told the reader that `solid/` and `pgsl/` "currently ship from
 * core" and that splitting them "requires lifting back-references into injection points" —
 * work the extraction had already done, via `kernel/index.ts`'s dynamic `'@interego/solid'`
 * specifier and `lattice/adapter.ts`'s registration seam. They also listed `naming/`, which
 * shipped with Solid, and omitted `lattice/`, `http/`, `manifest/` and `mcp/` entirely —
 * including the very seam that made the split possible.
 *
 * Every gate in this repo reads TypeScript; nothing read the prose, so the drift was not
 * merely unnoticed, it was unnoticeable. That matters more than usual because CLAUDE.md is
 * the bootstrap context every agent loads: an agent told to "do the pgsl split" would try to
 * redo shipped work, and one told "rdf/system-ontology back-references PGSL" would go hunting
 * for an import that does not exist. This test is the missing reader.
 *
 * Two failure classes, one per describe block:
 *   (a) stale inventory — a doc names a src/<dir>/ that is not on disk.
 *   (b) expired promise — a doc promises `@interego/<pkg>` while packages/<pkg> already
 *       exists. `@interego/crypto-impls` and `@interego/affordance-engine` are legitimately
 *       promised today; this starts failing the moment either one lands, which is exactly
 *       when the prose must change.
 *
 * SCOPE NOTE: README.md renders the same listing as an ASCII tree and is NOT covered here.
 * The round that added this test did not own that file; its tree still names `naming/`,
 * `solid/`, `pgsl/` and a `compat.ts` that is not on disk. Adding it is one `cases` entry
 * plus the fixes it then demands.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const read = (rel: string): string => readFileSync(resolve(repoRoot, rel), 'utf8');

const actualCoreDirs = new Set(
  readdirSync(resolve(repoRoot, 'packages/core/src'), { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .map((e) => e.name),
);

const DOCS = [
  'CLAUDE.md',
  'docs/ARCHITECTURAL-FOUNDATIONS.md',
  'packages/core/README.md',
] as const;

// Future-tense only. Past-tense statements ("split out of core into its own standalone
// workspace") describe completed work and must NOT match, or the guard would flag the very
// sentences that are correct.
const PROMISE = /slated for|is planned|on the roadmap|will move|requires lifting/i;
const PKG_TOKEN = /@interego\/([a-z0-9-]+)/g;

describe('docs do not promise a split that already shipped', () => {
  it.each(DOCS)('%s', (rel) => {
    const lines = read(rel).split('\n');
    const offenders: string[] = [];
    lines.forEach((line, i) => {
      // ★ SAME LINE, NOT A WINDOW. A ±2-line window was tried first and false-positived
      // immediately: `docs/ARCHITECTURAL-FOUNDATIONS.md`'s `crypto/` row legitimately says
      // "a follow-up @interego/crypto-impls split is planned" and the very next row
      // mentions `@interego/pgsl` as the package that registers on the lattice seam. Two
      // correct sentences, adjacent, flagged as one false promise — and widening or
      // narrowing the window by one line does not separate them.
      //
      // Same-line still catches the defect this exists for: both stale sentences put the
      // verb and the token together — "Splitting these into `@interego/solid` and
      // `@interego/pgsl` requires lifting those back-references…". The cost is a real gap:
      // a promise that wraps between the verb and the package name slips through. That is
      // a smaller hole than a guard that cries wolf, which is a guard people delete.
      if (!PROMISE.test(line)) return;
      for (const m of line.matchAll(PKG_TOKEN)) {
        const pkg = m[1];
        if (pkg !== undefined && existsSync(resolve(repoRoot, 'packages', pkg))) {
          offenders.push(
            `${rel}:${i + 1} promises a future @interego/${pkg} split, `
            + `but packages/${pkg} already exists`,
          );
        }
      }
    });
    expect(offenders).toEqual([]);
  });
});

describe('every core/src directory a doc names actually exists', () => {
  // Each doc renders the listing in its own format; each regex is anchored tightly enough
  // that it cannot pick up the sibling-package tables (whose rows start `@interego/...`).
  const cases: Array<[string, RegExp, number]> = [
    ['CLAUDE.md', /^\s+src\/([a-z0-9-]+)\//gm, 8],
    ['packages/core/README.md', /^- \*\*`([a-z0-9-]+)\/`\*\*/gm, 8],
    ['docs/ARCHITECTURAL-FOUNDATIONS.md', /^\| `([a-z0-9-]+)\/`/gm, 5],
  ];

  it.each(cases)('%s', (rel, re, minimum) => {
    const claimed = [...read(rel).matchAll(re)]
      .map((m) => m[1])
      .filter((d): d is string => d !== undefined);
    // Vacuity guard: if a reformat makes the regex match nothing, the subset assertion
    // below passes trivially and the gate silently stops gating.
    expect(
      claimed.length,
      `${rel}: the listing regex matched ${claimed.length} entries — below the floor of `
      + `${minimum}. The parser is broken, not the document.`,
    ).toBeGreaterThanOrEqual(minimum);
    expect(
      claimed.filter((d) => !actualCoreDirs.has(d)),
      `${rel} names packages/core/src directories that do not exist`,
    ).toEqual([]);
  });
});
