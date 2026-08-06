/**
 * THE ANTI-DRIFT GATE.
 *
 * The published artifact must stay ONE self-contained file, so it cannot `import`
 * `@interego/workspace-client`. The alternative everyone reaches for is a copy, and a copy is
 * how every drift defect in this vertical happened: a Turtle reader is hardened in one place,
 * the other place keeps the bug, and the bug is found again a session later wearing a
 * different hat.
 *
 * So the artifact's substrate block is GENERATED from the package, and this test is what makes
 * that claim enforceable rather than aspirational. It asserts three things:
 *
 *   1. the committed artifact's generated region is byte-identical to a fresh build;
 *   2. every extracted symbol is defined EXACTLY ONCE in the whole file — inside that region,
 *      never beside it, so a well-meaning "quick fix" in the hand-written half cannot shadow
 *      the module and win;
 *   3. the file still carries the markers at all.
 *
 * (1) alone is not enough: a second `function graphRegion(...)` pasted BELOW the region would
 * leave (1) green and silently take over, which is precisely the failure mode being closed.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';

const ROOT = join(import.meta.dirname, '..');
const ARTIFACT = join(ROOT, 'applications/shared-workspace/artifact/channel.html');
const BEGIN = '/* ══ BEGIN GENERATED — @interego/workspace-client ══════════════════════════';
const END = '/* ══ END GENERATED ════════════════════════════════════════════════════════ */';

const artifact = (): string => readFileSync(ARTIFACT, 'utf8');

describe('the published artifact is generated from @interego/workspace-client', () => {
  it('carries exactly one generated region', () => {
    const html = artifact();
    expect(html.split(BEGIN).length - 1, 'BEGIN marker count').toBe(1);
    expect(html.split(END).length - 1, 'END marker count').toBe(1);
    expect(html.indexOf(BEGIN)).toBeLessThan(html.indexOf(END));
  });

  it('matches a fresh build of the package, byte for byte', () => {
    // The builder is invoked as a child process rather than imported, because that is how CI
    // and a developer both run it — a test that imported the module could pass while the
    // command everyone actually types was broken.
    const out = execFileSync(process.execPath, [join(ROOT, 'tools/build-workspace-artifact.mjs'), '--check'], {
      cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
    });
    expect(out).toContain('matches packages/workspace-client');
  }, 120_000);

  it.each([
    'scanTurtle', 'graphRegion', 'maskFill', 'literalAt', 'readLiteral', 'readIri',
    'readIriList', 'readInt', 'hasTrue', 'hasType', 'parseRoleProfile', 'orderChain',
    'assignPodMarks', 'podOfWebid', 'podClaimVsServed', 'parseAcceptanceIri', 'preconditionLine',
  ])('declares %s ONLY inside the generated region', (name) => {
    const html = artifact();
    const from = html.indexOf(BEGIN);
    const to = html.indexOf(END);
    // Both declaration forms the hand-written half used before extraction. A re-introduced
    // copy would take one of them — and because the generated region ends with `const X =
    // WSPC.X` bindings, the symbol is legitimately declared twice INSIDE it. What must never
    // happen is a declaration OUTSIDE it: that one would shadow the module and win.
    const decl = new RegExp('(?:^|\\n)\\s*(?:function\\s+' + name + '\\s*\\(|(?:const|let|var)\\s+' + name + '\\s*=)', 'g');
    const hits = [...html.matchAll(decl)].map((m) => m.index ?? -1);
    expect(hits.length, name + ' is not declared at all').toBeGreaterThan(0);
    const outside = hits.filter((i) => i < from || i > to);
    expect(outside, name + ' is declared outside the generated region, which shadows the module').toEqual([]);
  });

  it('never reaches a descriptor URL directly — every read is a relay tool', () => {
    const html = artifact();
    // Descriptor URLs come back as http://css.railway.internal:3456/… and are unreachable
    // from outside the fleet. A `fetch(` in this file would work in CI, inside the fleet, and
    // fail on every viewer's machine.
    expect(/[^.\w]fetch\s*\(/.test(html), 'the artifact must not call fetch() at all').toBe(false);
    expect(html).toContain('get_descriptor');
  });

  it('never puts anything but a string literal into innerHTML', () => {
    const html = artifact();
    // Every value this page displays came off somebody else's pod, so the rule that matters is
    // not "innerHTML is banned" — one static block of explanatory prose with a <br> in it is
    // harmless — it is that no VALUE may reach it. Concatenating a variable into innerHTML is
    // the whole of the XSS surface, so what is asserted is that each assignment is literals
    // and `+` and nothing else.
    const uses = [...html.matchAll(/\.innerHTML\s*=\s*([\s\S]*?);\n/g)].map((m) => m[1] ?? '');
    expect(uses.length, 'expected to find the innerHTML sites').toBeGreaterThan(0);
    for (const u of uses) {
      const residue = u
        .replace(/"(?:[^"\\]|\\.)*"/g, '')      // double-quoted literals
        .replace(/'(?:[^'\\]|\\.)*'/g, '')      // single-quoted literals
        .replace(/[+\s]/g, '');
      expect(residue, 'innerHTML is assigned something other than string literals: ' + u.slice(0, 80)).toBe('');
    }
  });
});
