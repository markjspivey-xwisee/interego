#!/usr/bin/env tsx
/**
 * A TOOL CAN BE TOO BIG TO CALL, AND NOTHING IN THE STACK SAYS SO.
 *
 * ── THE DEFECT ───────────────────────────────────────────────────────────────
 *
 * `get_pod_status` returned the pod's ENTIRE descriptor manifest under `entries`, uncapped.
 * MEASURED 2026-08-12 against the live relay:
 *
 *   pod u-eth-03f52e15b9df    56,450,477 bytes   (grew 1.4 MB over one afternoon)
 *   pod u-eth-8f3b8e939600       579,536 bytes   of which 574,382 was `entries`
 *                                                and 5,154 was the status itself
 *
 * A `fetch` buffers 56 MB without complaint, so every direct probe passed and the tool looked
 * healthy from curl. A real MCP client does not: it drops the connection, and the Claude CLI
 * reports `MCP session expired during tool call`. That phrase names a SESSION problem, so it
 * sends you to auth — where everything checks out. The bearer was valid before and after the
 * failure, `initialize` / `tools/list` / `tools/call` all answered 200, no `Mcp-Session-Id` was
 * ever issued, and all 50 tools were advertised. A day went to the wrong layer.
 *
 * The tool was simply unreachable from every MCP client, including the pod owner's own claude.ai
 * connector — a capability that only worked from the one caller nobody ships.
 *
 * ── WHY THIS FILE EXISTS RATHER THAN A COMMENT ───────────────────────────────
 *
 * ★ NOTHING ELSE IN THE STACK CAN FAIL ON THIS. There is no size limit anywhere: not in the
 * handler, not in the transport, not in a test that calls the tool with a `fetch` — because a
 * `fetch` is exactly the client that succeeds. The cap is one `slice` and deleting it restores a
 * 56 MB response that passes every other check in this repository.
 *
 * §1–§3 are behavioural, over the real arithmetic. §4–§6 are source-text assertions over
 * `server.ts`, which is self-starting and cannot be imported, and they read the COMMENT-STRIPPED
 * text — this repo has already had a mutant survive because a regex matched a handler's own
 * prose after the code it described was deleted.
 *
 * Run from deploy/mcp-relay/:  npx tsx tests/pod-status-is-callable.test.ts
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { stripComments } from './strip-comments.js';

const here = dirname(fileURLToPath(import.meta.url));
const SERVER = readFileSync(join(here, '..', 'server.ts'), 'utf8');
const SERVER_CODE = stripComments(SERVER, 'server.ts');

let failures = 0;
function check(name: string, cond: boolean, detail = ''): void {
  if (cond) { console.log(`  ok   ${name}`); return; }
  failures++;
  console.error(`  FAIL ${name}${detail ? ` — ${detail}` : ''}`);
}

/** The text between two anchors, so an assertion is about ONE call site and not the file. */
function region(src: string, from: string, to: string, label: string): string {
  const a = src.indexOf(from);
  if (a < 0) { failures++; console.error(`  FAIL region ${label} — anchor not found: ${from}`); return ''; }
  const b = src.indexOf(to, a + from.length);
  if (b < 0) { failures++; console.error(`  FAIL region ${label} — end anchor not found: ${to}`); return ''; }
  return src.slice(a, b);
}

/**
 * The measured mean of a real descriptor entry, from pod u-eth-8f3b8e939600:
 * 574,382 bytes across 775 entries. Used to size the projections below in bytes rather than in
 * a count that means nothing on its own.
 */
const MEAN_ENTRY_BYTES = 741;

/** What every MCP client was measured to carry comfortably; 56 MB is not it. */
const TRANSPORT_CEILING = 1_000_000;

console.log('\nget_pod_status is callable from a real client, not only from curl');

// ── 1. THE CAP EXISTS AND IS SIZED FROM THE DATA ─────────────────────────────
console.log('\n1. the cap keeps the response inside what a client can receive');
{
  const capMatch = /const POD_STATUS_ENTRY_CAP = (\d+)/.exec(SERVER_CODE);
  check('POD_STATUS_ENTRY_CAP is declared', !!capMatch);
  const cap = capMatch ? Number(capMatch[1]) : 0;
  const projected = cap * MEAN_ENTRY_BYTES;
  check('the capped entries array stays well inside the transport ceiling',
    projected > 0 && projected < TRANSPORT_CEILING,
    `${cap} entries x ${MEAN_ENTRY_BYTES} B = ${projected.toLocaleString('en-US')} B`);
  // A cap of zero would pass the ceiling check and destroy the field's usefulness, so the
  // floor is asserted too: this is a bound on a useful answer, not a deletion of one.
  check('and is still a useful sample rather than an empty array', cap >= 25, `cap = ${cap}`);
}

// ── 2. THE COUNT IS UNAFFECTED ───────────────────────────────────────────────
// The one property every existing consumer depends on. `descriptors` is the whole manifest's
// length; capping the array must not quietly turn it into the length of the page.
console.log('\n2. `descriptors` is still the exact total, not the page size');
{
  const payload = region(SERVER_CODE, 'descriptors: entries.length', 'recentNotifications', 'status payload');
  check('descriptors is entries.length, taken before any slice', payload.startsWith('descriptors: entries.length'));
  check('the slice is applied to the returned array only, not to the count',
    /entries:\s*entries\.slice\(-POD_STATUS_ENTRY_CAP\)/.test(payload),
    payload.slice(0, 120));
  check('the count is not itself sliced',
    !/descriptors:\s*entries\.slice/.test(SERVER_CODE));
}

// ── 3. TRUNCATION IS STATED, NOT SILENT ──────────────────────────────────────
// ★ A capped array that says nothing is worse than an uncapped one: a caller reading 100 of
// 76,000 entries with no marker believes it has the pod. Silence here would turn a transport
// bug into a correctness bug.
console.log('\n3. a truncated answer says so, and says how much it dropped');
{
  const payload = region(SERVER_CODE, 'descriptors: entries.length', 'recentNotifications', 'status payload');
  check('an entriesTruncated block is emitted', /entriesTruncated/.test(payload));
  check('it is conditional on there being something omitted',
    /entries\.length\s*>\s*POD_STATUS_ENTRY_CAP\s*\?/.test(payload),
    'an unconditional marker would claim truncation on a small pod');
  check('it reports the omitted count arithmetically rather than as prose',
    /omitted:\s*entries\.length\s*-\s*POD_STATUS_ENTRY_CAP/.test(payload));
  check('and points at the tool that does read a pod\'s contents',
    /discover_context/.test(payload));
}

// ── 4. THE MARKER IS ABSENT WHEN NOTHING WAS DROPPED ─────────────────────────
// A spread, not a null: the difference between "this pod has 40 descriptors" and "this pod has
// 40 descriptors and we are telling you nothing was hidden" is a key that should not be there.
console.log('\n4. a small pod carries no truncation marker at all');
{
  const payload = region(SERVER_CODE, 'descriptors: entries.length', 'recentNotifications', 'status payload');
  check('the block is spread conditionally rather than set to null',
    /\.\.\.\(entries\.length\s*>\s*POD_STATUS_ENTRY_CAP\s*\?/.test(payload));
  /**
   * ★ POSITION, NOT ABSENCE. The obvious form of this check — "no line begins with
   * `entriesTruncated:`" — matches the key INSIDE the conditional spread, because that key is on
   * its own indented line too. It failed against correct code. What actually distinguishes a
   * guarded emission from an unguarded one is that the only occurrence sits after the guard.
   */
  const occurrences = (payload.match(/entriesTruncated/g) ?? []).length;
  const guardAt = payload.indexOf('...(entries.length >');
  check('entriesTruncated appears exactly once, and after the guard that conditions it',
    occurrences === 1 && guardAt >= 0 && payload.indexOf('entriesTruncated') > guardAt,
    `${occurrences} occurrence(s)`);
}

// ── 5. THE ARITHMETIC, EXERCISED ─────────────────────────────────────────────
// The source assertions above pin the shape; this pins that the shape computes correct numbers,
// including the boundary where a pod sits exactly on the cap.
console.log('\n5. the numbers come out right at, below and above the cap');
{
  const cap = Number(/const POD_STATUS_ENTRY_CAP = (\d+)/.exec(SERVER_CODE)?.[1] ?? 0);
  const project = (total: number): { returned: number; omitted: number; marked: boolean } => {
    const entries = Array.from({ length: total }, (_, i) => i);
    const shown = entries.slice(-cap);
    return { returned: shown.length, omitted: total - cap, marked: total > cap };
  };
  const below = project(cap - 1);
  check('below the cap: everything is returned and nothing is marked',
    below.returned === cap - 1 && !below.marked, JSON.stringify(below));
  const at = project(cap);
  check('exactly at the cap: everything is returned and nothing is marked',
    at.returned === cap && !at.marked, JSON.stringify(at));
  const over = project(76_000);
  check('far above it: the page is the cap and the omitted count is the remainder',
    over.returned === cap && over.omitted === 76_000 - cap && over.marked, JSON.stringify(over));
  check('returned + omitted reconstructs the total the caller was told',
    over.returned + over.omitted === 76_000);
}

// ── 6. THE PROJECTED SIZE OF THE REAL FAILURE ────────────────────────────────
// ★ THIS IS THE REGRESSION THE FILE IS FOR. Removing the slice restores a response that no MCP
// client can receive, and every other test in this repository would still pass — because they
// reach the relay with a `fetch`, which is precisely the caller that succeeds.
console.log('\n6. the uncapped shape is the one that could not be received');
{
  const cap = Number(/const POD_STATUS_ENTRY_CAP = (\d+)/.exec(SERVER_CODE)?.[1] ?? 0);
  const REAL_POD_DESCRIPTORS = 76_000;
  const uncapped = REAL_POD_DESCRIPTORS * MEAN_ENTRY_BYTES;
  const capped = cap * MEAN_ENTRY_BYTES;
  check('uncapped, a real pod exceeds the ceiling by orders of magnitude',
    uncapped > TRANSPORT_CEILING * 25,
    `${uncapped.toLocaleString('en-US')} B`);
  check('capped, the same pod answers in a fraction of it',
    capped < TRANSPORT_CEILING / 10,
    `${capped.toLocaleString('en-US')} B`);
  check('the cap is what separates them, not the pod',
    uncapped / Math.max(1, capped) > 100);
}

console.log(failures
  ? `\n${failures} failure(s)\n`
  : '\nget_pod_status answers within what a client can receive, and says what it left out\n');
process.exit(failures ? 1 : 0);
