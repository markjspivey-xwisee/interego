/**
 * Every relay handler that dials a CALLER-CHOSEN address does it through the screened fetch.
 *
 * ── THE RULE, AND WHY IT NEEDED A GATE ──────────────────────────────────────
 *
 * `server.ts` states it: "the question is not 'is it a pure read' — it is 'does every
 * caller-supplied URL it touches go through `guardedInvokeFetch`'. A read that dials an address
 * of the caller's choosing is not a pure read."
 *
 * The R4 remediation applied that to the directory writers and its own census named three:
 * add_pod, handleDiscoverDirectory, handleResolveWebfinger. Two got `guardedInvokeFetch` with a
 * "caller URL (R4)" comment. The third — `resolve_webfinger` — kept `solidFetch`, which
 * normalises the URL and then dials the global pool, and `egress.ts` is explicit that the
 * address screen attaches PER REQUEST and never as the global dispatcher. So neither the name
 * screen nor the connect-time screen ran on a hostname the caller supplies, and the bypasses
 * that file records work verbatim: `10-0-0-5.nip.io` → 10.0.0.5, `localtest.me` → 127.0.0.1.
 *
 * A census in a comment found it and a census in a comment is what left it: the sentence named
 * all three and nothing re-checked that all three were done.
 *
 * ── WHAT IT CHECKS ──────────────────────────────────────────────────────────
 *
 * For each handler known to take a caller-supplied URL, the `fetch:` option it passes must be
 * the guarded one. That is a syntactic check on a small, named list — it cannot discover a NEW
 * caller-URL handler, and says so rather than implying otherwise. What it does do is make the
 * three-of-three claim hold as code instead of as prose.
 */
import { readFileSync } from 'node:fs';

const SRC = readFileSync(new URL('../server.ts', import.meta.url), 'utf8');

let failures = 0;
function check(label: string, ok: boolean, detail = ''): void {
  if (ok) { console.log(`  ok   ${label}`); return; }
  failures += 1;
  console.log(`  FAIL ${label}${detail ? ` — ${detail}` : ''}`);
}

/**
 * Handlers that build a fetch target from something the caller sent.
 *
 * Each entry is the call as written, minus its `{ fetch: … }` option — matched literally so a
 * refactor that moves the call makes this gate SHOUT rather than pass over a renamed symbol.
 */
const CALLER_URL_CALLS: ReadonlyArray<readonly [string, string]> = [
  ['resolve_webfinger', 'resolveWebFinger(args.resource as string,'],
  ['discover_directory', 'fetchPodDirectory(args.directory_url as string,'],
];

for (const [tool, call] of CALLER_URL_CALLS) {
  const at = SRC.indexOf(call);
  check(`${tool}: its caller-URL call site is still where this gate looks`, at >= 0,
    `no occurrence of ${JSON.stringify(call)} — re-anchor it, do not delete it`);
  if (at < 0) continue;
  // The option object follows the call on the same statement.
  const stmt = SRC.slice(at, SRC.indexOf(';', at) + 1);
  check(`${tool}: dials the caller's address through guardedInvokeFetch`,
    /fetch:\s*guardedInvokeFetch\b/.test(stmt),
    `it passes ${/fetch:\s*(\w+)/.exec(stmt)?.[1] ?? 'no fetch option'}, so neither the name `
      + 'screen nor the connect-time address screen runs');
}

/**
 * ★ AND THE SHARED SINGLETON'S WRITES NEED A CREDENTIAL, NOT ONLY ITS READS.
 *
 * `pgsl_to_turtle` was auth-gated because it serialises the whole process-wide kernel lattice,
 * and `pgsl_ingest` because it writes it. `mint` and `promote` mutate the SAME adapter and were
 * in neither set, so `POST /tool/mint` ran with no credential — unbounded growth of an
 * in-process structure on a relay with an OOM history, seeding nodes every authenticated reader
 * then sees.
 */
const authSet = SRC.slice(SRC.indexOf('const AUTH_REQUIRED_TOOLS = new Set(['));
const authBlock = authSet.slice(0, authSet.indexOf(']);'));
for (const tool of ['mint', 'promote', 'pgsl_ingest', 'pgsl_to_turtle']) {
  check(`${tool} requires a credential`, new RegExp(`'${tool}'`).test(authBlock),
    'it mutates or discloses the process-wide kernel singleton and is reachable at /tool/ '
      + 'without one');
}

// Guards the guard: an extractor that stopped matching would pass everything above vacuously.
check('the auth set was actually read', authBlock.length > 200, `${authBlock.length} chars`);

if (failures) {
  console.error(`\n${failures} FAILURE(S)`);
  process.exit(1);
}
console.log('\nAll checks passed — a caller-chosen address is screened, and the singleton\'s '
  + 'writes need a credential.');
