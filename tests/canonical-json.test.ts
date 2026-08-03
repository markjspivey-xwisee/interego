/**
 * Content-addressing must distinguish content.
 *
 * ★ WHY THIS EXISTS. Three call sites derived a "content-stable" id with
 *
 *     JSON.stringify(obj, Object.keys(obj).sort())
 *
 * believing it sorted keys. It does not — the second argument is the REPLACER, and an
 * array there is an allow-list of property NAMES applied recursively at every depth. So
 * only the top-level names survived and every nested object was emptied to `{}`.
 *
 * Measured live against the relay before the fix, three descriptors identical but for
 * their single facet all minted to `urn:iep:descriptor:eb25ebe8…`:
 *
 *     Temporal(validFrom 2020) | Trust(issuer attacker.example) | AccessControl(public, *)
 *
 * The first two assertions below are written against the BROKEN idiom directly, so this
 * file documents and pins the defect rather than merely exercising the replacement.
 */
import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { canonicalJson } from '@interego/core';

/** The exact broken idiom, kept so the test can prove it is broken. */
const brokenIdiom = (o: Record<string, unknown>): string =>
  JSON.stringify(o, Object.keys(o).sort());

describe('canonicalJson', () => {
  // ── the defect, pinned ────────────────────────────────────────────────
  it('the replacer-as-sorter idiom really does collapse nested content', () => {
    const a = { facets: [{ type: 'Temporal', validFrom: '2020-01-01T00:00:00Z' }] };
    const b = { facets: [{ type: 'AccessControl', mode: 'public', readers: ['*'] }] };
    // Both become {"facets":[{}]} — this is the bug, asserted so nobody "fixes" the
    // helper back into it.
    expect(brokenIdiom(a)).toBe(brokenIdiom(b));
    expect(brokenIdiom(a)).toBe('{"facets":[{}]}');
  });

  it('distinguishes what the broken idiom conflated', () => {
    const a = { facets: [{ type: 'Temporal', validFrom: '2020-01-01T00:00:00Z' }] };
    const b = { facets: [{ type: 'AccessControl', mode: 'public', readers: ['*'] }] };
    expect(canonicalJson(a)).not.toBe(canonicalJson(b));
  });

  it('distinguishes the three descriptors that collided on the live relay', () => {
    const desc = (facets: unknown[]) => ({
      id: 'https://example.org/desc/1',
      describes: ['https://example.org/graph/1'],
      facets,
      version: 1,
    });
    const ids = [
      desc([{ type: 'Temporal', validFrom: '2020-01-01T00:00:00Z' }]),
      desc([{ type: 'Trust', level: 'high', issuer: 'https://attacker.example/' }]),
      desc([{ type: 'AccessControl', mode: 'public', readers: ['*'] }]),
    ].map(canonicalJson);
    expect(new Set(ids).size).toBe(3);
  });

  // ── the property that makes it a canonicalizer ────────────────────────
  it('is insensitive to key order at every depth', () => {
    const x = { b: 1, a: { d: 2, c: [{ f: 3, e: 4 }] } };
    const y = { a: { c: [{ e: 4, f: 3 }], d: 2 }, b: 1 };
    expect(canonicalJson(x)).toBe(canonicalJson(y));
  });

  it('preserves array order, which carries meaning', () => {
    expect(canonicalJson([1, 2])).not.toBe(canonicalJson([2, 1]));
  });

  it('does not conflate structurally different shapes', () => {
    const shapes: unknown[] = [
      {}, { a: 1 }, { a: '1' }, { a: [1] }, { a: { b: 1 } },
      [], [1], [[1]], null, 0, '', false,
    ];
    const out = shapes.map(canonicalJson);
    expect(new Set(out).size).toBe(shapes.length);
  });

  it('emits valid JSON that round-trips to an equal value', () => {
    const v = { z: [1, 'two', null, { y: false }], a: { nested: { deep: true } } };
    expect(JSON.parse(canonicalJson(v))).toEqual(v);
  });

  it('omits undefined-valued keys rather than emitting invalid JSON', () => {
    expect(canonicalJson({ a: 1, b: undefined })).toBe('{"a":1}');
    expect(() => JSON.parse(canonicalJson({ b: undefined }))).not.toThrow();
  });

  it('handles a top-level undefined without returning the string "undefined"', () => {
    expect(() => JSON.parse(canonicalJson(undefined))).not.toThrow();
  });
});

describe('no call site re-derives the broken idiom', () => {
  /**
   * ★ A grep-based guard, deliberately. The three original sites were in three separate
   * packages and none of their unit tests noticed, because each asserted only "the same
   * input yields the same id" — which the broken idiom satisfies. The invariant that
   * fails is cross-input, so the durable protection is that the idiom cannot reappear.
   */
  it('JSON.stringify(x, Object.keys(...)) appears nowhere in source', () => {
    const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
    const skip = new Set(['node_modules', 'dist', '.git', 'coverage', 'scratchpad', 'build']);
    const offenders: string[] = [];
    // The pattern, spelled so this file's own occurrences are not matched by it.
    const re = /JSON\.stringify\([^,)]*,\s*Object\.keys\(/;

    const walk = (dir: string): void => {
      let entries;
      try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return; }
      for (const e of entries) {
        if (skip.has(e.name) || e.name.startsWith('.')) continue;
        const p = join(dir, e.name);
        if (e.isDirectory()) { walk(p); continue; }
        if (!/\.(ts|mts|mjs|js)$/.test(e.name)) continue;
        if (p.endsWith('canonical-json.test.ts')) continue;   // the pinned counter-example
        // ★ THE READ IS THE ONLY SYSCALL PER FILE, DELIBERATELY. This used to `statSync`
        // first to skip anything over 4 MB, which doubled the syscall count across 950
        // files to protect against a case that does not exist here — the largest file the
        // walk reaches is benchmarks/locomo/static/js/fontawesome.all.min.js at 1.19 MB, and
        // `node_modules`/`dist`/`build`/`coverage` (where a bundle that size would live) are
        // already pruned above. Measured, the stat cost ~140 ms of a ~200 ms collect. The
        // size guard survives as a check on `raw.length` because what it actually protects
        // is the two comment-stripping regexes below, not the read: the lazy `/*…*/` scan
        // over a multi-megabyte single-line bundle is the part that gets expensive. Bytes
        // vs UTF-16 units differ for non-ASCII, which does not matter for a bound this
        // coarse. The try/catch is now around the READ, where it belongs — `statSync`
        // follows symlinks and `Dirent.isDirectory()` does not, so a symlink-to-directory
        // named `*.ts` used to pass the stat and throw EISDIR out of an unguarded read.
        let raw: string;
        try { raw = readFileSync(p, 'utf8'); } catch { continue; }
        if (raw.length > 4_000_000) continue;
        // Strip comments before matching: the fix's own commit notes QUOTE the broken
        // idiom to explain it, and a guard that fires on its own explanation gets
        // deleted. Only real code counts.
        //
        // ★ AND IT IS UNCONDITIONAL, THOUGH IT LOOKS LIKE FREE MONEY TO SKIP IT. Only 5 of
        // the 950 files contain the pattern in raw form, so pre-filtering on `re.test(raw)`
        // and stripping just those would save the ~57 ms this costs. It would also be
        // WRONG, because stripping can CREATE a match the raw text does not have: a comment
        // sitting between the two arguments defeats `\s*` before it is removed and satisfies
        // it after. Both spellings were planted as mutants in `packages/core/src` and both
        // are caught here — a block comment between the arguments, and a line comment with
        // the `Object.keys(` on the next line. Under a raw pre-filter neither would be
        // reported at all, and 57 ms is not worth a hole in the one guard standing between
        // this idiom and three more silent id collisions.
        const src = raw
          .replace(/\/\*[\s\S]*?\*\//g, '')
          .replace(/(^|[^:])\/\/.*$/gm, '$1');
        if (re.test(src)) offenders.push(p.slice(root.length + 1).replace(/\\/g, '/'));
      }
    };
    walk(root);

    expect(offenders, `re-derived the replacer-as-sorter idiom:\n  ${offenders.join('\n  ')}`)
      .toEqual([]);
    // ★ WHY THIS CARRIES A TIMEOUT AND THE NINE CASES ABOVE DO NOT. This one walks the tree
    // and reads every `.ts`/`.mts`/`.mjs`/`.js` file outside the pruned directories — 950
    // files, 16.0 MB, one pass (the walk is not repeated per assertion; there is one
    // assertion). It is therefore filesystem-bound, and filesystem is the resource the other
    // 186 modules of a whole-suite run are contending for at the same time on a
    // single-threaded pool.
    //
    // Measured on this tree, a whole-suite run over all 187 modules versus this file alone:
    //
    //                                 alone       in a whole-suite run
    //   before the changes above      779 ms            1 548 ms
    //   after                         540 ms        519 ms and 1 182 ms
    //
    // ★ TWO NUMBERS IN THE LAST CELL, AND THE SECOND ONE IS THE ONE TO PLAN AGAINST. Both are
    // post-change whole-suite runs; the 1 182 ms one had `node_modules/.vite` deleted first
    // and ran with other work on the machine, so it is the cold-cache, contended case. Only
    // the fast one is quoted below where the improvement is being described — the bound at
    // the end is sized off the slow one.
    //
    // ★ AND THE SECOND COLUMN IS THE POINT: the old version cost TWICE as much inside a full
    // run as it did alone, and the new one costs the same either way. Two things changed, and
    // they do not split evenly. Alone, the whole improvement is 239 ms and all of it is
    // plausibly the halved syscall count above. In a full run the improvement is 1 029 ms, so
    // roughly 790 ms of it has to come from the other change — moving `node:fs`, `node:path`
    // and `node:url` off the three `await import(...)` calls that used to open this test and
    // onto static imports at the top of the file, paid once at collection.
    //
    // That attribution is by elimination rather than by isolating the two, and the mechanism
    // is not proven here: the likely one is that a dynamic import resolves through vite's
    // module runner, which is contended by the other 186 modules on the single-threaded pool
    // in a way that a plain `readFileSync` is not. What IS established is the shape — the
    // load-sensitive part of this test was never the tree walk. Static imports are also what
    // `tests/test-files-are-runnable.test.ts`, the other tree-walking guard here, already did.
    //
    // 1 548 ms against the default 5 000 ms bound is a 3.2x margin, which is how this timed
    // out during a full Node 20 run alongside concurrent work and passed on every re-run. The
    // bound is 30 s — ~25x the slowest post-change measurement, deliberately far past
    // anything load can explain. At 30 s this test has stopped working rather than slowed
    // down (a pruned directory stopped being pruned, or the walk is following a symlink
    // cycle) and a longer wait would not save it.
    //
    // ★ AND IT IS SET HERE RATHER THAN ON `testTimeout` IN vitest.config.ts, which would have
    // been one line for the whole class. A global raise also covers every test whose duration
    // IS the defect — the runaway retry loop, the request that never resolves — and those are
    // the ones the default bound is for. This test is slow for a reason that is written down;
    // the next one might not be.
  }, 30_000);
});
