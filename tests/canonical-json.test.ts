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
  it('JSON.stringify(x, Object.keys(...)) appears nowhere in source', async () => {
    const { readdirSync, readFileSync, statSync } = await import('node:fs');
    const { join, resolve, dirname } = await import('node:path');
    const { fileURLToPath } = await import('node:url');

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
        try { if (statSync(p).size > 4_000_000) continue; } catch { continue; }
        // Strip comments before matching: the fix's own commit notes QUOTE the broken
        // idiom to explain it, and a guard that fires on its own explanation gets
        // deleted. Only real code counts.
        const src = readFileSync(p, 'utf8')
          .replace(/\/\*[\s\S]*?\*\//g, '')
          .replace(/(^|[^:])\/\/.*$/gm, '$1');
        if (re.test(src)) offenders.push(p.slice(root.length + 1).replace(/\\/g, '/'));
      }
    };
    walk(root);

    expect(offenders, `re-derived the replacer-as-sorter idiom:\n  ${offenders.join('\n  ')}`)
      .toEqual([]);
  });
});
