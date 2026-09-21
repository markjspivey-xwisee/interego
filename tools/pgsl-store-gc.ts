/**
 * Collect the unreferenced history of the pod store's Postgres table, or measure it.
 *
 *   PGSL_PG_CONNSTR=... npx tsx tools/pgsl-store-gc.ts                 # dry run: reads only, reports the live set
 *   PGSL_PG_CONNSTR=... npx tsx tools/pgsl-store-gc.ts --rebuild       # copy the live rows into a new table and swap
 *   PGSL_PG_CONNSTR=... npx tsx tools/pgsl-store-gc.ts --drop <old>    # drop the previous table once the store checks out
 *   ... --rebuild-above 0.5 [--min-rows 2000000]                       # measure, then rebuild only above that unreferenced share
 *   ... --drop-previous-older-than 7                                   # first drop <table>_old_YYYYMMDD tables older than that
 *   ... --table pgsl_kv                                                # the table (default pgsl_kv)
 *
 * WHY A REBUILD AND NOT A DELETE: deleting tens of millions of rows leaves the table the same
 * size until it is rewritten, and rewriting a 45 GB table needs 45 GB free, which is precisely
 * what a full volume does not have. The live set is small, so `rebuildTable` copies it into a
 * new table under an ACCESS EXCLUSIVE lock (readers and writers wait for the minutes it takes),
 * swaps the names in the same transaction, and leaves the old table for `--drop` after the
 * store has been checked. See packages/pgsl-store/src/gc.ts for what "live" means.
 *
 * ── THE WEEKLY RUN, AND WHERE ITS LINE IS ──────────────────────────────────────────────────
 *
 * pgsl-store-gc.yml runs `--drop-previous-older-than 7 --rebuild-above 0.5` every Sunday at the
 * quietest hour. The measurement is the same dry run; the decision is `rebuildDecision`, which
 * rebuilds only when at least half of a table of at least --min-rows rows is unreferenced
 * history — the shape the 2026-09-20 outage had (78.7M rows, 1.19M live) and the shape a small
 * weekly gap does not. A table below the row floor is never rebuilt automatically: the lock
 * would cost more than the space. The table a rebuild leaves behind stays a week, so the store
 * has run on the new one before `previousTablesToDrop` lets the next run drop it. Both
 * decisions are pure and tested (tests/pgsl-store-gc-tool.test.ts); a person can still
 * dispatch any mode by hand.
 *
 * The connection string is read from the environment and never printed.
 */

import { basename } from 'node:path';
import { Client } from 'pg';
import { collectLive, keysBySubspace, readerFromPg, rebuildTable } from '../packages/pgsl-store/src/gc.js';

function flag(name: string): string | undefined {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

export interface RebuildDecision {
  readonly rebuild: boolean;
  /** The share of the table's rows that a rebuild would not keep, 0..1. */
  readonly reclaimableShare: number;
  readonly reason: string;
}

/**
 * Whether the weekly run rebuilds: the unreferenced share of a table big enough to matter has
 * crossed the line. An unknown row estimate (a table never analysed reports -1) decides nothing.
 */
export function rebuildDecision(input: { readonly liveKeys: number; readonly tableRows: number; readonly line: number; readonly minRows: number }): RebuildDecision {
  const { liveKeys, tableRows, line, minRows } = input;
  if (!(line > 0 && line <= 1)) throw new Error('--rebuild-above takes a share between 0 and 1');
  if (!Number.isFinite(tableRows) || tableRows < 0) {
    return { rebuild: false, reclaimableShare: 0, reason: 'the table row estimate is unknown (never analysed), so nothing is decided on it' };
  }
  const share = tableRows === 0 ? 0 : Math.max(0, (tableRows - liveKeys) / tableRows);
  const pct = (n: number): string => `${Math.round(n * 100)}%`;
  if (tableRows < minRows) {
    return { rebuild: false, reclaimableShare: share, reason: `${tableRows} rows is below the floor of ${minRows}; a rebuild would reclaim too little to hold a lock for` };
  }
  const history = `${pct(share)} of ${tableRows} rows are unreferenced history (${liveKeys} live)`;
  return share >= line
    ? { rebuild: true, reclaimableShare: share, reason: `${history}, at or above the line of ${pct(line)}` }
    : { rebuild: false, reclaimableShare: share, reason: `${history}, below the line of ${pct(line)}` };
}

/**
 * The tables earlier rebuilds left behind (`<table>_old_YYYYMMDD`) that are older than `days`:
 * the store has run on the new table for that long, so the copy has served its purpose.
 */
export function previousTablesToDrop(names: readonly string[], table: string, now: Date, days: number): string[] {
  const re = new RegExp(`^${table}_old_([0-9]{4})([0-9]{2})([0-9]{2})$`);
  const cutoff = now.getTime() - days * 86_400_000;
  return names
    .filter((n) => {
      const m = re.exec(n);
      if (!m) return false;
      return Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])) <= cutoff;
    })
    .sort();
}

async function main(): Promise<void> {
  const conn = process.env['PGSL_PG_CONNSTR'];
  if (!conn) { console.error('PGSL_PG_CONNSTR is not set'); process.exit(2); }
  const table = (flag('--table') ?? 'pgsl_kv').replace(/[^a-zA-Z0-9_]/g, '');
  const client = new Client({ connectionString: conn, statement_timeout: 0, application_name: 'pgsl-store-gc' });
  await client.connect();
  const log = (line: string): void => { console.log(`[${new Date().toISOString().slice(11, 19)}] ${line}`); };
  try {
    const size = async (t: string): Promise<string> => String((await client.query(`SELECT pg_size_pretty(pg_total_relation_size($1)) AS s`, [t])).rows[0]?.['s']);
    log(`${table}: ${await size(table)} on disk before`);
    const drop = flag('--drop');
    if (drop) {
      const t = drop.replace(/[^a-zA-Z0-9_]/g, '');
      if (t === table) throw new Error('refusing to drop the live table');
      log(`dropping ${t} (${await size(t)})`);
      await client.query(`DROP TABLE ${t}`);
      log('dropped; the space is returned to the volume');
      return;
    }
    if (process.argv.includes('--tune')) {
      // Reclamation settings that fit a table of short keys and large toasted values with a high
      // update rate: Postgres's default scale factor of 0.2 on a table of 78 million rows meant
      // autovacuum waited for 15 million dead tuples, which is to say never. And a transaction left
      // idle pins the horizon every vacuum needs; the store's own transactions are milliseconds.
      await client.query(`ALTER TABLE ${table} SET (autovacuum_vacuum_scale_factor = 0.02, autovacuum_vacuum_threshold = 5000, autovacuum_analyze_scale_factor = 0.02, autovacuum_analyze_threshold = 5000, toast.autovacuum_vacuum_scale_factor = 0.02)`);
      await client.query(`ALTER DATABASE ${String((await client.query('SELECT current_database() AS d')).rows[0]?.['d'])} SET idle_in_transaction_session_timeout = '5min'`);
      log('tuned: autovacuum fires at 2% churn on the table and its toast; idle transactions end after five minutes');
      return;
    }
    const dropOlder = flag('--drop-previous-older-than');
    if (dropOlder !== undefined) {
      const days = Number(dropOlder);
      if (!Number.isInteger(days) || days < 1) throw new Error('--drop-previous-older-than takes a whole number of days');
      const names = (await client.query(`SELECT relname FROM pg_class WHERE relkind = 'r' AND relname LIKE $1`, [`${table}_old_%`])).rows.map((r) => String(r['relname']));
      const due = previousTablesToDrop(names, table, new Date(), days);
      if (due.length === 0) log(`no previous table older than ${days} day(s) to drop (${names.length} present)`);
      for (const t of due) {
        log(`dropping ${t} (${await size(t)}), left by a rebuild more than ${days} day(s) ago`);
        await client.query(`DROP TABLE ${t}`);
      }
    }
    if (process.argv.includes('--rebuild')) {
      const r = await rebuildTable(client, table, { log });
      log(`rebuild done: ${r.newRows} rows live in ${table} (${await size(table)}); previous table ${r.oldTable} (${await size(r.oldTable)}) awaits --drop`);
      await client.query(`ANALYZE ${table}`);
      return;
    }
    const live = await collectLive(readerFromPg(client, table), { log });
    const by = keysBySubspace(live.keys);
    log(`dry run: ${live.keys.size} live keys by subspace ${JSON.stringify(by)}`);
    log(`live nodes ${live.stats.liveNodes} (${live.stats.liveAtoms} atoms, ${live.stats.liveFragments} fragments), ${(live.stats.liveNodeBytes / 1048576).toFixed(1)} MB of node values`);
    log(`scanned rows ${JSON.stringify(live.stats.scanned)}; dangling roots ${live.stats.danglingRoots.length}; unreadable nodes ${live.stats.unreadableNodes}`);
    if (live.stats.danglingRoots.length > 0) log(`first dangling roots: ${live.stats.danglingRoots.slice(0, 5).join(', ')}`);
    const total = await client.query(`SELECT reltuples::bigint AS n FROM pg_class WHERE relname = $1`, [table]);
    log(`table rows (planner estimate): ${total.rows[0]?.['n']}; the rebuild would keep ${live.keys.size}`);
    const line = flag('--rebuild-above');
    if (line !== undefined) {
      const d = rebuildDecision({ liveKeys: live.keys.size, tableRows: Number(total.rows[0]?.['n'] ?? -1), line: Number(line), minRows: Number(flag('--min-rows') ?? 2_000_000) });
      log(`${d.rebuild ? 'rebuilding' : 'not rebuilding'}: ${d.reason}`);
      if (d.rebuild) {
        const r = await rebuildTable(client, table, { log });
        log(`rebuild done: ${r.newRows} rows live in ${table} (${await size(table)}); previous table ${r.oldTable} (${await size(r.oldTable)}) is dropped by a later run's --drop-previous-older-than`);
        await client.query(`ANALYZE ${table}`);
      }
    }
  } finally {
    await client.end();
  }
}

if (process.argv[1] && basename(process.argv[1]) === 'pgsl-store-gc.ts') {
  main().catch((err) => { console.error(err instanceof Error ? err.message : String(err)); process.exit(1); });
}
