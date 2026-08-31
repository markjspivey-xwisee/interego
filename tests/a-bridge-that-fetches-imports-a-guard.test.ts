/**
 * A deployed bridge that makes outbound requests imports an egress guard.
 *
 * ── WHY, MEASURED ────────────────────────────────────────────────────────────
 *
 * `agentic-performance-practice` was deployed on 2026-08-30. Every one of its nine handlers
 * takes `pod_url` from the request body, the bridge authenticates NOBODY, and its pod writes
 * went out through a plain `globalThis.fetch`. Driven against the live service:
 *
 *   pod_url: http://169.254.169.254/latest/meta-data/  -> ATTEMPTED, hung to timeout
 *   pod_url: http://10.0.0.5/pod/                      -> ATTEMPTED, hung to timeout
 *   pod_url: http://127.0.0.1:3456/x/                  -> connected
 *
 * Blind and credential-free — that bridge has no authority to lend — but a caller-aimed
 * outbound connection all the same, which is what `project_relay_invoke_ssrf_guard` forbids
 * for every caller-URL fetch. THREE sites, and one of them was a handler written the same day.
 * The code had existed for weeks; deploying the service is what put it on the internet.
 *
 * ── WHAT THIS CHECKS, AND WHAT IT DELIBERATELY DOES NOT ──────────────────────
 *
 * Proving "every caller-derived URL reaches a guard" needs dataflow analysis this repo does
 * not have. What IS checkable, cheaply and without false comfort: a bridge that fetches at all
 * must have the guard in scope. A bridge with no fetch surface needs nothing — `shared-workspace`
 * makes zero fetch calls and declares no url-shaped input, and demanding an unused import there
 * would be decoration.
 *
 * So this is a NECESSARY condition, not a sufficient one. It would have failed on agp before
 * the fix, which is the case it exists for. It cannot tell you the guard is applied at every
 * site — only a census and a live drive do that, and both are recorded in the commit.
 */
import { describe, it, expect } from 'vitest';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

/** The verticals with a built image — the ones reachable from the internet. */
function deployedVerticals(): string[] {
  const images = JSON.parse(readFileSync(join(ROOT, 'deploy/images.json'), 'utf8')) as
    | { image?: string; dockerfile?: string }[]
    | { images?: { image?: string; dockerfile?: string }[] };
  const rows = Array.isArray(images) ? images : (images.images ?? []);
  const out = new Set<string>();
  for (const r of rows) {
    const df = r.dockerfile ?? '';
    if (!df || !existsSync(join(ROOT, df))) continue;
    const text = readFileSync(join(ROOT, df), 'utf8');
    // A vertical is IN this image if the Dockerfile's CMD runs its bridge.
    const cmd = /CMD\s+\[[^\]]*applications\/([a-z-]+)\/bridge/.exec(text);
    if (cmd?.[1]) out.add(cmd[1]);
  }
  return [...out].sort();
}

/**
 * ★ AN IMPORT, NOT A MENTION — AND THE FIRST VERSION OF THIS GATE FAILED ITS OWN MUTATION
 * TEST FOR EXACTLY THAT REASON.
 *
 * It matched the bare names anywhere in the file. Stripping every guard from agp's bridge left
 * the gate GREEN, because the long comment explaining why the guards are there names them in
 * prose. The gate was matching its own documentation.
 *
 * So: the names must appear in an `import ... from` statement. Prose cannot satisfy that, and
 * a file that stops importing a guard stops passing.
 */
const GUARD_NAMES = ['guardedFetchFn', 'assertSafeFetchTarget', 'safeFetch', 'guardedInvokeFetch', 'safePublicUrlOrUndefined'];

function importsAGuard(text: string): boolean {
  // Every `import { … } from '…'` in the file, including multi-line specifier lists.
  for (const m of text.matchAll(/import\s*(?:type\s*)?\{([\s\S]*?)\}\s*from\s*['"][^'"]+['"]/g)) {
    const specifiers = (m[1] ?? '').split(',').map(x => x.trim().split(/\s+as\s+/)[0]?.trim() ?? '');
    if (specifiers.some(sp => GUARD_NAMES.includes(sp))) return true;
  }
  return false;
}

function bridgeSources(vertical: string): { file: string; text: string }[] {
  const dir = join(ROOT, 'applications', vertical, 'bridge');
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter(f => f.endsWith('.ts'))
    .map(f => ({ file: `${vertical}/bridge/${f}`, text: readFileSync(join(dir, f), 'utf8') }));
}

describe('the predicate itself', () => {
  /**
   * ★ THIS IS THE CASE THE FIRST VERSION OF THIS GATE GOT WRONG, PINNED SO IT STAYS WRONG-PROOF.
   *
   * The gate originally tested `/guardedFetchFn|assertSafeFetchTarget|.../.test(fileText)`.
   * Stripping every guard from agp's bridge left it GREEN, because the comment explaining why
   * the guards are there names them in prose. It was matching its own documentation.
   *
   * Note also why the fleet sweep below cannot be mutation-tested by deleting an import: the
   * identifiers are still USED, so removal breaks the typecheck, which runs as vitest's global
   * setup and fails before any test executes. The realistic regression is a NEW deployed bridge
   * that fetches and never imported a guard at all — exactly the agp case — and that is what
   * these two assertions cover directly.
   */
  it('prose that merely names a guard does not satisfy it', () => {
    const proseOnly = `
      // We should route this through guardedFetchFn and call assertSafeFetchTarget first.
      const r = await globalThis.fetch(url);
    `;
    expect(importsAGuard(proseOnly), 'a comment naming a guard counted as importing one').toBe(false);
  });

  it('a real import satisfies it, including a multi-line specifier list', () => {
    expect(importsAGuard("import { guardedFetchFn } from '@interego/core';")).toBe(true);
    expect(importsAGuard([
      'import {',
      '  type IRI,',
      '  guardedFetchFn, assertSafeFetchTarget,',
      "} from '@interego/core';",
    ].join(String.fromCharCode(10))), 'a multi-line import was not recognised').toBe(true);
    expect(importsAGuard("import { somethingElse } from '@interego/core';")).toBe(false);
  });
});

describe('a deployed bridge that fetches has a guard in scope', () => {
  const verticals = deployedVerticals();

  it('finds the deployed bridges, and does not silently narrow to none', () => {
    // A discovery that stops matching would make every assertion below vacuous.
    expect(verticals.length, 'no deployed vertical bridges discovered').toBeGreaterThan(0);
    expect(verticals).toContain('agentic-performance-practice');
  });

  it.each(deployedVerticals())('%s', (vertical) => {
    const sources = bridgeSources(vertical);
    expect(sources.length, `${vertical} has a built image but no bridge sources`).toBeGreaterThan(0);
    const all = sources.map(s => s.text).join('\n');
    // Does this bridge reach the network at all?
    const fetches = (all.match(/\bfetch\s*\(/g) ?? []).length
      + (all.match(/globalThis\.fetch/g) ?? []).length;
    if (fetches === 0) return;   // no surface, nothing to guard — see the header
    expect(
      importsAGuard(all),
      `${vertical}'s bridge makes ${fetches} outbound call(s) and imports no egress guard. `
        + `A caller-supplied pod_url becomes a caller-chosen fetch target; screen it with `
        + `assertSafeFetchTarget and hand walkers guardedFetchFn.`,
    ).toBe(true);
  });
});
