/**
 * jsonld 9.0.0's `fromRDF` misreads RDF that this repository produces, so no code here may call it
 * until a release fixes it.
 *
 * jsonld 9 changed its dataset terms to the RDF/JS form, where a blank node's `value` carries no
 * `_:`. `fromRDF` was updated for subjects and objects but not for graph names, so a quad in a
 * graph named by a blank node comes back in a graph whose `@id` is the bare label, a relative IRI.
 * `_:b0` becomes `b0`, which is a different node from `_:b0`, so the result no longer says what the
 * RDF says. VC Data Integrity proofs are exactly such graphs: the Foxxi credential fixtures with an
 * embedded proof (`ob3-embedded-proof`, `foxxi-clr`) come back this way. This was found by running
 * the W3C JSON-LD and RDF canonicalization test suites and the repository's own RDF under jsonld 8
 * and jsonld 9 and comparing the output. With `useNativeTypes: true`, `fromRDF` also now writes
 * `"@type": xsd:string` on every plain string. Upstream main still has the same `quad.graph.value`
 * line, so the next release may not fix it.
 *
 * Nothing in the repository calls `fromRDF` today. The first test keeps it that way. The second
 * pins the defect itself: when a jsonld release reads the graph name correctly, it fails, which
 * means both tests can be deleted.
 *
 * A walk of the working tree rather than `git ls-files`, like the other source guards here, so
 * the base-without-verticals job runs it over the tree it keeps.
 */
import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import jsonld from 'jsonld';

const ROOT = fileURLToPath(new URL('../', import.meta.url));
const SELF = fileURLToPath(import.meta.url);
const SKIP = new Set(['node_modules', 'dist', 'build', 'coverage', 'scratchpad']);
const SOURCE = /\.(ts|tsx|mts|cts|js|mjs|cjs)$/;

function sourceFiles(): string[] {
  const out: string[] = [];
  const walk = (dir: string): void => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      if (SKIP.has(e.name) || e.name.startsWith('.')) continue;
      const p = join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else if (SOURCE.test(e.name) && p !== SELF) out.push(p);
    }
  };
  walk(ROOT);
  return out;
}

describe('no code reads RDF back through jsonld.fromRDF', () => {
  it('has no caller in any source file', () => {
    const files = sourceFiles();
    expect(files.length, 'the walk found almost nothing, so this check would pass on any tree').toBeGreaterThan(500);
    // A call or a reference to the function (`jsonld.fromRDF`, `fromRDF(`), not a mention in prose.
    const callers = files.filter(f => /\.fromRDF\b|\bfromRDF\s*\(/.test(readFileSync(f, 'utf8'))).map(f => relative(ROOT, f));
    expect(callers, 'jsonld 9.0.0 fromRDF renames a blank-node graph name to a relative IRI; read RDF with n3 instead').toEqual([]);
  });

  it('still drops the _: from a blank-node graph name (delete both tests when this fails)', async () => {
    const nquads = '<urn:s> <urn:p> "o" _:g .\n';
    const expanded = await jsonld.fromRDF(nquads, { format: 'application/n-quads' }) as unknown as Array<Record<string, unknown>>;
    expect(expanded.map(node => node['@id'])).toEqual(['g']);
  });
});
