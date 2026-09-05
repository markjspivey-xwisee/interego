/**
 * A bearer narrowed to `mcp:read` cannot write, and the classification cannot go stale.
 *
 * ── WHAT THIS EXISTS FOR ────────────────────────────────────────────────────
 *
 * The OAuth scope gate asked `WRITE_SIDE_TOOLS.has(name)` against a hand-maintained list of
 * eighteen names, so any tool nobody remembered to add was ungated — the list failed OPEN. An
 * adversarial pass measured nine pod- or state-mutating tools missing from it, including
 * `record_trajectory_step`, whose handler ends in `handlePublishContext(…)` with
 * `sign_authorship` defaulting true; `set_reachability`, which durably rewrites the caller's
 * federation directory row; `rebuild_manifest`; and `sign_request`, which signs as the caller.
 * Two of the eighteen named tools that do not exist at all, which is what a hand-maintained
 * list looks like after a year.
 *
 * The gate is now `!READ_SIDE_TOOLS.has(name)` — default-deny. This file keeps that honest in
 * the only two ways that matter: the classification must COVER the registered surface, and the
 * tools that provably write must land on the write side of it.
 *
 * ── WHY IT READS THE SOURCE RATHER THAN IMPORTING ───────────────────────────
 *
 * `server.ts` calls `app.listen()` at import, so importing it to read one Set starts a relay.
 * The names are extracted from the source text instead — which is also what makes the coverage
 * assertion meaningful: it compares the two lists AS WRITTEN, and a set that stopped matching
 * the registered tools is exactly the drift being guarded.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const SRC = readFileSync(new URL('../server.ts', import.meta.url), 'utf8');
const HERE = fileURLToPath(new URL('.', import.meta.url));

let failures = 0;
function check(label: string, ok: boolean, detail = ''): void {
  if (ok) { console.log(`  ok   ${label}`); return; }
  failures += 1;
  console.log(`  FAIL ${label}${detail ? ` — ${detail}` : ''}`);
}

/** Every tool registered in the TOOLS table. */
function registeredTools(): string[] {
  const at = SRC.indexOf('const TOOLS: Record<string, ToolEntry> = gateRequiredArgs({');
  if (at < 0) throw new Error('TOOLS table not found — this guard is reading the wrong file');
  const seg = SRC.slice(at, at + 40_000);
  // Top-level keys only (two-space indent); nested schema objects sit deeper.
  const names = [...seg.matchAll(/^ {2}([a-z][a-z0-9_]*):\s*\{/gm)].map(m => m[1] as string);
  return [...new Set(names)].filter(n => n !== 'properties');
}

/** The declared read-side allowlist, read out of the source. */
function readSideTools(): Set<string> {
  const at = SRC.indexOf('const READ_SIDE_TOOLS = new Set<string>([');
  if (at < 0) throw new Error('READ_SIDE_TOOLS not found — the gate was renamed or removed');
  const seg = SRC.slice(at, SRC.indexOf(']);', at));
  return new Set([...seg.matchAll(/'([a-z][a-z0-9_]*)'/g)].map(m => m[1] as string));
}

const tools = registeredTools();
const readSide = readSideTools();
check('generic resource read admission is capability-classified', SRC.includes('resourceCompositions.access(') && SRC.includes('isWriteSideTool(name, rawArgs ?? {})'));
check('no application tools in the substrate', !tools.some(name => /application/.test(name)));

// Guards the guard: an extractor that stopped matching would make every assertion vacuous.
check('the registered-tool scan still finds the tool table', tools.length > 40,
  `found ${tools.length}`);
check('the read-side allowlist still parses', readSide.size > 10, `found ${readSide.size}`);

/**
 * ★ THE TOOLS THAT PROVABLY WRITE. Each is here because its handler was read and found to
 * publish, persist, or sign — not because it looked like a writer. The six after the blank
 * line are the ones the old hand-maintained list had missed.
 */
const MUST_BE_WRITE_GATED = [
  'publish_context', 'remember', 'register_agent', 'revoke_agent', 'add_pod', 'remove_pod',
  'subscribe_to_pod', 'unsubscribe_from_pod', 'subscribe_all', 'pgsl_ingest', 'publish_node',
  'publish_directory', 'link_wallet', 'setup_identity', 'invoke_affordance', 'act',

  'record_trajectory_step', 'notify_agent', 'set_reachability', 'sign_request',
  'rebuild_manifest', 'mint', 'promote',
];

const leaked = MUST_BE_WRITE_GATED.filter(t => readSide.has(t));
check('no tool that writes pod state is on the read-side allowlist', leaked.length === 0,
  leaked.join(', '));

const unregistered = MUST_BE_WRITE_GATED.filter(t => !tools.includes(t));
check('every tool this file names is actually registered (else it is guarding a ghost)',
  unregistered.length === 0, unregistered.join(', '));

/**
 * ★★ THE CLASSIFICATION MUST COVER THE SURFACE.
 *
 * Under default-deny an unclassified tool is refused rather than granted, so this cannot leak.
 * It can still go WRONG the other way — a read that starts answering 403 to a read-only bearer
 * — and, more importantly, an entry left in the allowlist for a tool that no longer exists is
 * the same rot that put two phantom names in the old list. Both are reported here.
 */
const stale = [...readSide].filter(t => !tools.includes(t));
check('the read-side allowlist names no tool that has been removed', stale.length === 0,
  stale.join(', '));

console.log(`\n${tools.length} registered tool(s); ${readSide.size} classified read-side, `
  + `${tools.length - [...readSide].filter(t => tools.includes(t)).length} write-gated by default.`);

if (failures) {
  console.error(`\n${failures} FAILURE(S) — ${HERE}`);
  process.exit(1);
}
console.log('All checks passed — the read-only grant is read-only.');
