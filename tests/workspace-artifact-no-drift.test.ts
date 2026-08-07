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
    // The readers, the locator, the naming scheme, the chain walk.
    'scanTurtle', 'graphRegion', 'maskFill', 'literalAt', 'readLiteral', 'readIri',
    'readIriList', 'readInt', 'hasTrue', 'hasType', 'parseRoleProfile', 'orderChain',
    'assignPodMarks', 'podOfWebid', 'podClaimVsServed', 'parseAcceptanceIri', 'preconditionLine',
    // ── AND THE I/O, which is the copy this increment closed ──────────────────
    // Each of these was a hand-written wrapper in the page, interleaved with the panel that
    // reports it, while the module carried an equivalent the desktop shell used. Two copies of
    // one intention is the failure this file exists to prevent, and the byte-comparison above
    // does not see it: a re-pasted `async function currentHead(...)` below the region leaves the
    // region identical and silently takes over every read on the page.
    'tool', 'resolveServer', 'currentHead', 'descriptor', 'manifest', 'resolveMemberDoc',
    'publishAndConfirm', 'fetchProfileTurtle', 'readWorkspaceRecord', 'foldRoster', 'postEntry',
    'toChainRow', 'entryShapeAnswer', 'grantPodFor', 'watchStream', 'invalidateStreams',
    'connectorLabel', 'CLIENT',
    // ── THE DOCUMENTS, MEMBERSHIP AND THE CANVAS, which is the copy this
    // increment closed ────────────────────────────────────────────────────────
    // Each of these existed twice: once in the module, once written out beside
    // the panel in the page that reports it. They had measurably come apart —
    // the page's document writers interpolated IRIs read off OTHER PEOPLE'S PODS
    // with no guard at all, where the module refuses an unserialisable one; the
    // page's `findSeat` dropped its own saturation flag on the floor; the page's
    // `awaitHead` and the module's disagreed about what licenses "Saved". A
    // re-paste of any one of them below the region would leave the byte
    // comparison above green and silently take over.
    'turtleIri', 'shapesTurtle', 'rolesTurtle', 'workspaceTurtle', 'grantTurtle',
    'acceptanceTurtle', 'canvasTurtle',
    'readViewer', 'composedHandle', 'ownHandleCheck', 'checkWriteEligibility',
    'resolveInvitee', 'GRANT_IRI_RX', 'verifyGrantIri',
    'INBOX_LIMIT', 'readInbox', 'verifyInvitation',
    'SEAT_SCAN_LIMIT', 'SEAT_READ_CAP', 'findSeat',
    'listWorkspaces', 'verifyWorkspaceEntry',
    'roleName', 'roleWhy', 'roleKnown', 'checkRoleForWorkspace',
    'readCanvas', 'awaitHead', 'staleDetail',
  ])('declares %s ONLY inside the generated region', (name) => {
    const html = artifact();
    const from = html.indexOf(BEGIN);
    const to = html.indexOf(END);
    // Every declaration form the hand-written half used before extraction. A re-introduced copy
    // would take one of them — and because the generated region ends with `const X = WSPC.X`
    // bindings, the symbol is legitimately declared twice INSIDE it. What must never happen is a
    // declaration OUTSIDE it: that one would shadow the module and win.
    //
    // ★ `async` IS PART OF THE PATTERN, and leaving it out was a hole. Every wrapper this gate
    // now covers was written `async function currentHead(…)`, so the form a re-paste would most
    // naturally take was the one form the regex did not match — the gate would have reported the
    // symbol "not declared at all" for the generated copy and said nothing about a second one.
    const decl = new RegExp('(?:^|\\n)\\s*(?:(?:async\\s+)?function\\s+' + name + '\\s*\\(|(?:const|let|var)\\s+' + name + '\\s*=)', 'g');
    const hits = [...html.matchAll(decl)].map((m) => m.index ?? -1);
    expect(hits.length, name + ' is not declared at all').toBeGreaterThan(0);
    const outside = hits.filter((i) => i < from || i > to);
    expect(outside, name + ' is declared outside the generated region, which shadows the module').toEqual([]);
  });

  it('touches the connector host in exactly one place, and never calls it directly', () => {
    const html = artifact();
    const from = html.indexOf(BEGIN);
    const to = html.indexOf(END);
    const outside = html.slice(0, from) + html.slice(to);
    // ★ WHY THE HOST OBJECT IS THE THING BEING COUNTED. `window.claude.mcp` is the whole of the
    // page's access to the substrate. While the page held its own `tool()` it also held the
    // connector's resolved display name, and passed it back by hand to `watchTool` and
    // `invalidate` — two call sites reaching around the transport that had resolved it, each
    // free to drift from how every other read was made. One accessor, handed once to the
    // module's transport, is what makes "every read goes the same way" checkable.
    // Counted by LINE, not by occurrence: the accessor itself names `window.claude` twice in one
    // expression — the guard and the property — and that is one place, not two.
    const lines = outside.split('\n').filter((l) => l.includes('window.claude'));
    expect(lines, 'window.claude is reached from more than one place').toHaveLength(1);
    expect(lines[0]).toContain('const mcp =');
    for (const m of ['.callTool(', '.listTools(', '.watchTool(', '.invalidate(']) {
      expect(outside.includes(m), 'the hand-written half calls ' + m + ' on the host directly').toBe(false);
    }
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
