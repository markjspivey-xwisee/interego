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
import {
  POD_STATUS_ENTRY_BUDGET_BYTES, POD_STATUS_ENTRY_CAP, podStatusEntryPage,
} from '../pod-status-page.js';

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

// ── 1. THE BOUND EXISTS AND IS SIZED FROM THE DATA ───────────────────────────
console.log('\n1. the bound keeps the response inside what a client can receive');
{
  check('a byte budget is declared', POD_STATUS_ENTRY_BUDGET_BYTES > 0);
  check('and sits well inside the transport ceiling',
    POD_STATUS_ENTRY_BUDGET_BYTES < TRANSPORT_CEILING / 2,
    `${POD_STATUS_ENTRY_BUDGET_BYTES.toLocaleString('en-US')} B vs ceiling ${TRANSPORT_CEILING.toLocaleString('en-US')} B`);
  check('a count cap is declared on top of it', POD_STATUS_ENTRY_CAP > 0);
  // A cap of zero would satisfy every ceiling check and destroy the field, so the floor is
  // asserted too: this is a bound on a useful answer, not a deletion of one.
  check('and is still a useful sample rather than an empty array',
    POD_STATUS_ENTRY_CAP >= 25, `cap = ${POD_STATUS_ENTRY_CAP}`);
  // ★ THE RELAY MUST USE THE SHARED MODULE. Re-declaring either constant inside `server.ts` would
  // give the deployed path its own copy, and every assertion in this file would then be about a
  // function the relay does not call.
  check('server.ts imports the paging module rather than re-declaring it',
    /from '\.\/pod-status-page\.js'/.test(SERVER_CODE)
    && !/const POD_STATUS_ENTRY_(CAP|BUDGET_BYTES)\s*=/.test(SERVER_CODE));
}

// ── 2. THE COUNT IS UNAFFECTED ───────────────────────────────────────────────
// The one property every existing consumer depends on. `descriptors` is the whole manifest's
// length; capping the array must not quietly turn it into the length of the page.
console.log('\n2. `descriptors` is still the exact total, not the page size');
{
  const payload = region(SERVER_CODE, 'descriptors: entries.length', 'recentNotifications', 'status payload');
  check('descriptors is entries.length, taken before any slice', payload.startsWith('descriptors: entries.length'));
  check('the page is what is returned, not the whole array',
    /entries:\s*entryPage\.page/.test(payload), payload.slice(0, 120));
  check('the count is not itself paged',
    !/descriptors:\s*(entryPage|entries\.slice)/.test(SERVER_CODE));
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
    /entryPage\.omitted\s*>\s*0\s*\?/.test(payload),
    'an unconditional marker would claim truncation on a small pod');
  check('it reports the omitted count from the page rather than as prose',
    /omitted:\s*entryPage\.omitted/.test(payload));
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
    /\.\.\.\(entryPage\.omitted\s*>\s*0\s*\?/.test(payload));
  /**
   * ★ POSITION, NOT ABSENCE. The obvious form of this check — "no line begins with
   * `entriesTruncated:`" — matches the key INSIDE the conditional spread, because that key is on
   * its own indented line too. It failed against correct code. What actually distinguishes a
   * guarded emission from an unguarded one is that the only occurrence sits after the guard.
   */
  const occurrences = (payload.match(/entriesTruncated/g) ?? []).length;
  const guardAt = payload.indexOf('...(entryPage.omitted >');
  check('entriesTruncated appears exactly once, and after the guard that conditions it',
    occurrences === 1 && guardAt >= 0 && payload.indexOf('entriesTruncated') > guardAt,
    `${occurrences} occurrence(s)`);
}

// ── 5. THE ARITHMETIC, EXERCISED ─────────────────────────────
/**
 * The source assertions above pin the shape; these pin that it computes correct numbers.
 *
 * ★ THE MODEL BELOW MIRRORS `podStatusEntryPage` RATHER THAN CALLING IT, because `server.ts` is
 * self-starting and cannot be imported — the same reason every other assertion in this file is
 * over its text. That is a real weakness and it is bounded deliberately: §1–§4 pin the actual call
 * site, so a divergence between this model and the shipped function shows up there as a shape that
 * no longer matches, not as a green test over a fiction.
 */
const CAP = POD_STATUS_ENTRY_CAP;
const BUDGET = POD_STATUS_ENTRY_BUDGET_BYTES;

/**
 * ★ THE REAL FUNCTION, NOT A MODEL OF IT.
 *
 * This file first carried its own copy of the paging algorithm, because `server.ts` is
 * self-starting and cannot be imported. MEASURED: deleting the budget check from the server
 * produced ZERO failures here — the test agreed with itself about a function it never called, and
 * would have waved through exactly the defect it was written for. The function now lives in
 * `pod-status-page.ts` so both the relay and this file use the one implementation.
 *
 * Entries are sized by their JSON length, so a fixture of strings of a known length gives a page
 * whose byte total is predictable without inventing a second notion of size.
 */
function page(entrySizes: readonly number[]): { returned: number; omitted: number; bytes: number } {
  // A JSON string of n characters serialises to n + 2 bytes (the quotes), so ask for n - 2.
  const entries = entrySizes.map((n) => 'x'.repeat(Math.max(1, n - 2)));
  const out = podStatusEntryPage(entries);
  return {
    returned: out.page.length,
    omitted: out.omitted,
    // `reduce<number>`, not an annotated parameter: `page` is `readonly unknown[]`, so without the
    // explicit type argument TypeScript infers the accumulator as `unknown` and the addition fails.
    bytes: out.page.reduce<number>((sum, e) => sum + JSON.stringify(e).length, 0),
  };
}

const sized = (n: number, each: number): number[] => Array.from({ length: n }, () => each);

console.log('\n5. the page is bounded in bytes, and the totals still reconcile');
{
  check('the byte budget is declared', BUDGET > 0, `BUDGET = ${BUDGET}`);
  check('and is comfortably inside the transport ceiling', BUDGET > 0 && BUDGET < TRANSPORT_CEILING / 2,
    `${BUDGET.toLocaleString('en-US')} B vs ceiling ${TRANSPORT_CEILING.toLocaleString('en-US')} B`);

  const small = page(sized(10, MEAN_ENTRY_BYTES));
  check('a small pod returns everything and omits nothing',
    small.returned === 10 && small.omitted === 0, JSON.stringify(small));

  const many = page(sized(76_000, MEAN_ENTRY_BYTES));
  check('a huge pod of ordinary entries is bounded by the COUNT, and reconciles',
    many.returned === CAP && many.returned + many.omitted === 76_000, JSON.stringify(many));
  check('and lands well inside the ceiling', many.bytes < TRANSPORT_CEILING / 3,
    `${many.bytes.toLocaleString('en-US')} B`);
}

// ── 6. THE CASE A COUNT CAP GOT WRONG ────────────────────────
/**
 * ★ THIS SECTION EXISTS BECAUSE THE FIRST FIX WAS WRONG AND SHIPPED.
 *
 * The cap was a COUNT, sized from a 741-byte mean measured on one pod. MEASURED against the next
 * pod after deploying it: 100 entries came to 989,903 bytes, because that pod's entries average
 * 9.9 KB. It sat a hair under the ceiling it was meant to keep the response far below, and would
 * have gone over for any pod whose entries ran larger still. The 56 MB case was fixed by luck.
 */
const HEAVY_ENTRY_BYTES = 9_900;

console.log('\n6. a pod whose entries are 13x heavier is still bounded');
{
  const heavy = page(sized(76_000, HEAVY_ENTRY_BYTES));
  check('the heavy pod is bounded by BYTES, not by the count',
    heavy.returned < CAP, `returned ${heavy.returned} of a ${CAP} cap`);
  check('★ and the payload stays far under the ceiling, which a count cap did not achieve',
    heavy.bytes <= BUDGET && heavy.bytes < TRANSPORT_CEILING / 3,
    `${heavy.bytes.toLocaleString('en-US')} B (a count cap of ${CAP} gave 989,903 B)`);
  check('the totals still reconcile', heavy.returned + heavy.omitted === 76_000);

  // What the old cap would have produced on that same pod, stated so the regression is legible.
  check('a count-only cap would have exceeded three quarters of the ceiling',
    CAP * HEAVY_ENTRY_BYTES > TRANSPORT_CEILING * 0.75,
    `${(CAP * HEAVY_ENTRY_BYTES).toLocaleString('en-US')} B`);
}

// ── 7. NEVER AN EMPTY PAGE WHEN THERE IS SOMETHING TO SHOW ──────────
// An entry larger than the entire budget must still be returned. An empty array on a pod that has
// descriptors reads as "this pod has nothing", which is the false-negative this whole file is
// about — a wrong answer that looks like a healthy one.
console.log('\n7. an oversized single entry is returned rather than silently dropped');
{
  const one = page([BUDGET * 3]);
  check('the one entry comes back', one.returned === 1 && one.omitted === 0, JSON.stringify(one));
  const firstOfMany = page([...sized(50, 10), BUDGET * 3]);
  check('and when it is the newest of many, it comes back with the rest omitted',
    firstOfMany.returned === 1 && firstOfMany.omitted === 50, JSON.stringify(firstOfMany));
}

// ── 8. THE UNCAPPED SHAPE IS THE ONE THAT COULD NOT BE RECEIVED ───────
// ★ THE REGRESSION THE FILE IS FOR. Removing the bound restores a response no MCP client can
// receive, and every other test in this repository would still pass — because they reach the relay
// with a `fetch`, which is precisely the caller that succeeds.
console.log('\n8. unbounded, the same pod is unreachable');
{
  const uncapped = 76_000 * MEAN_ENTRY_BYTES;
  check('uncapped, a real pod exceeds the ceiling by orders of magnitude',
    uncapped > TRANSPORT_CEILING * 25, `${uncapped.toLocaleString('en-US')} B`);
  check('bounded, it answers in a fraction of it',
    page(sized(76_000, MEAN_ENTRY_BYTES)).bytes < TRANSPORT_CEILING / 3);
}

console.log(failures
  ? `\n${failures} failure(s)\n`
  : '\nget_pod_status answers within what a client can receive, and says what it left out\n');
process.exit(failures ? 1 : 0);
