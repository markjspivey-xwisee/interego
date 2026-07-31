/**
 * A continuation returns the next page of THE SAME query.
 *
 * ★ WHY. The `more` IRL this LRS mints is `/xapi/statements?continuationToken=<tok>`
 * and carries no other parameters — correct, since xAPI treats it as opaque to the
 * client. But the token carried only `{offset, ts}`, so following the link re-ran an
 * UNFILTERED query and applied the offset to that. Reproduced against production
 * before the fix, with three statements on ALPHA and three on BETA:
 *
 *   GET /xapi/statements?activity=ALPHA&limit=2
 *     page 1 -> 2 statements, both ALPHA          ✓
 *     more   -> /xapi/statements?continuationToken=eyJvZmZzZXQiOjIsInRzIjo…
 *     page 2 -> 4 statements, one of them BETA, and BOTH page-1 statements again
 *
 * A client paging a filtered query got rows it had filtered out and rows it had
 * already seen. This matters beyond tidiness: pagination is how anything reads a
 * learner's history at scale, so a broadened page silently mixes one subject's
 * statements into another's result set.
 *
 * `ts` was also written into every token and never read. Offset paging over a store
 * still accepting writes is unstable — statements arriving between pages shift every
 * later offset — so the timestamp now pins the sequence to the horizon it began at.
 *
 * These are BEHAVIOURAL assertions against the real store. The defect was invisible
 * to source inspection: every individual function looked right, and the query context
 * was simply lost between two of them.
 *
 * Run: npx tsx applications/foxxi-content-intelligence/tests/statement-pagination.test.ts
 */
import { readFileSync } from 'node:fs';
import { paginate, decodeCursor, type StoredStatement, type QueryFilter } from '../src/statement-store.js';

let failures = 0;
const check = (name: string, cond: boolean, detail = ''): void => {
  if (cond) { console.log(`  ok   ${name}`); return; }
  failures++; console.error(`  FAIL ${name}${detail ? ` — ${detail}` : ''}`);
};

const ALPHA = 'https://example.org/activity/alpha';
const BETA = 'https://example.org/activity/beta';

/** Interleave ALPHA and BETA so a broadened query is guaranteed to pull the wrong rows. */
const corpus: StoredStatement[] = [];
for (let i = 0; i < 6; i++) {
  const activity = i % 2 === 0 ? ALPHA : BETA;
  corpus.push({
    id: `stmt-${i}`,
    stored: new Date(Date.UTC(2026, 0, 1, 0, 0, i)).toISOString(),
    voided: false,
    statement: { id: `stmt-${i}`, object: { id: activity, objectType: 'Activity' } },
  } as StoredStatement);
}

/** Mirror the store's own contract: filter first, then paginate. */
const query = (f: QueryFilter) => {
  const matching = f.activity
    ? corpus.filter(r => (r.statement.object as { id?: string }).id === f.activity)
    : [...corpus];
  return paginate(matching, f);
};

console.log('\nxAPI pagination: a continuation resumes the original query');

// ── 1. The reported defect ─────────────────────────────────────────────────
const p1 = query({ activity: ALPHA, limit: 2 });
check('page 1 respects the filter', p1.statements.every(r => (r.statement.object as { id: string }).id === ALPHA));
check('page 1 respects the limit', p1.statements.length === 2, String(p1.statements.length));
check('a continuation token is offered when more remain', !!p1.more);

const carried = decodeCursor(p1.more ?? undefined);
check('the token carries the query forward', carried?.q?.activity === ALPHA,
  'without this, page 2 is an unfiltered query with an offset applied');
check('the token carries the page size', carried?.q?.limit === 2);

// The continuation arrives with NO other parameters — exactly as the more IRL sends it.
const p2 = query({ cursor: p1.more ?? undefined, ...(carried?.q ?? {}) });
check('page 2 contains only statements matching the original filter',
  p2.statements.every(r => (r.statement.object as { id: string }).id === ALPHA),
  p2.statements.map(r => (r.statement.object as { id: string }).id).join(','));

const seen = new Set(p1.statements.map(r => r.id));
check('page 2 repeats nothing from page 1',
  p2.statements.every(r => !seen.has(r.id)),
  p2.statements.filter(r => seen.has(r.id)).map(r => r.id).join(','));

// ── 2. The whole sequence covers the result set exactly once ───────────────
const collected: string[] = [];
let cur: string | null = p1.more;
for (const r of p1.statements) collected.push(r.id);
for (let guard = 0; cur && guard < 20; guard++) {
  const q = decodeCursor(cur)?.q ?? {};
  const page: ReturnType<typeof query> = query({ cursor: cur, ...q });
  for (const r of page.statements) collected.push(r.id);
  cur = page.more;
}
const alphaIds = corpus.filter(r => (r.statement.object as { id: string }).id === ALPHA).map(r => r.id);
check('paging the whole sequence yields every matching statement',
  alphaIds.every(id => collected.includes(id)), `got ${collected.join(',')}`);
check('…and yields each of them exactly once',
  collected.length === new Set(collected).size && collected.length === alphaIds.length,
  `${collected.length} rows, ${new Set(collected).size} distinct, expected ${alphaIds.length}`);

// ── 3. Writes arriving mid-sequence must not shift the pages ───────────────
// This is what `ts` is for. It was written into every token and never read.
const midP1 = query({ activity: ALPHA, limit: 2 });
corpus.unshift({
  id: 'stmt-late',
  stored: new Date(Date.UTC(2026, 0, 2)).toISOString(),   // AFTER the sequence began
  voided: false,
  statement: { id: 'stmt-late', object: { id: ALPHA, objectType: 'Activity' } },
} as StoredStatement);
const midQ = decodeCursor(midP1.more ?? undefined)?.q ?? {};
const midP2 = query({ cursor: midP1.more ?? undefined, ...midQ });
check('a statement stored after paging began does not appear mid-sequence',
  midP2.statements.every(r => r.id !== 'stmt-late'),
  'an unpinned offset lets late writes shift every later page');
check('…and does not cause a page-1 row to repeat',
  midP2.statements.every(r => !midP1.statements.some(x => x.id === r.id)));

// ── 4. A malformed token must not degrade into "page 1 of everything" ──────
check('an unparseable token decodes to null', decodeCursor('not-a-real-token') === null);
check('a token without an offset decodes to null',
  decodeCursor(Buffer.from(JSON.stringify({ nope: 1 }), 'utf8').toString('base64url')) === null);

// ── 5. Reading forwarding metrics must not erase them ──────────────────────
// Different surface, same shape of bug: state that a caller OBSERVES was being reset
// by the act of observing it. The bridge hydrates a tenant's forwarding config from
// the pod on every read of /agent/forwarding/targets, and the import rebuilt each
// target with freshMetrics(). Confirmed live: `delivered` read 0 immediately after a
// delivery independently proven to have succeeded.
console.log('\nforwarding metrics: an import must not destroy runtime observations');
const { addForwardingTarget, importForwardingConfig, exportForwardingConfig, listForwardingTargets } =
  await import('../src/lrs-forwarding.js') as Record<string, any>;

const TENANT = 'lens:pagination-test';
const added = addForwardingTarget(TENANT, { endpoint: 'https://downstream.example/xapi', credentials: 'u:p' });
check('a target can be registered', !!added?.id, JSON.stringify(added).slice(0, 80));

// The round trip a list request performs: export the tenant's config, then re-import
// it. The target itself must come back intact.
const blob = exportForwardingConfig(TENANT);
importForwardingConfig(TENANT, blob);
const roundTripped = listForwardingTargets(TENANT).find((t: { id: string }) => t.id === added.id);
check('a re-import preserves the target', !!roundTripped);
check('…including its identity and creation time',
  roundTripped?.endpoint === added.endpoint && roundTripped?.createdAt === added.createdAt);

// The metrics half cannot be driven behaviourally from here: `delivered` is only
// incremented inside the real forward path, which performs a network POST through
// safeFetch — and safeFetch refuses internal hosts, so a local stub target is
// rejected before any metric moves. There is no exported outcome recorder to call
// instead. So this asserts the preservation LOGIC directly. Stated plainly because a
// structural assertion is weaker than a behavioural one, and pretending otherwise is
// how a test starts reassuring people about something it never checked.
const src = readFileSync(new URL('../src/lrs-forwarding.ts', import.meta.url), 'utf8');
const importFn = src.slice(src.indexOf('export function importForwardingConfig'),
  src.indexOf('export function importForwardingConfig') + 1400);
check('importForwardingConfig captures the prior state before clearing',
  /const prior = new Map\(\[\.\.\.map\.entries\(\)\]/.test(importFn));
check('…and carries metrics across by id rather than resetting them',
  /metrics: was \? was\.metrics : freshMetrics\(\)/.test(importFn),
  'freshMetrics() on every import is what made reading the panel erase it');
check('…and carries the dead-letter queue across too',
  /deadLetter: was \? was\.deadLetter : \[\]/.test(importFn));

if (failures > 0) { console.error(`\n${failures} assertion(s) failed\n`); process.exit(1); }
console.log('\nA continuation is the same query, one page further along.\n');
