/**
 * Collect the unreferenced history of the pod store's Postgres table, or measure it.
 *
 *   PGSL_PG_CONNSTR=... npx tsx tools/pgsl-store-gc.ts                 # dry run: reads only, reports the live set
 *   PGSL_PG_CONNSTR=... npx tsx tools/pgsl-store-gc.ts --rebuild       # copy the live rows into a new table and swap
 *   PGSL_PG_CONNSTR=... npx tsx tools/pgsl-store-gc.ts --drop <old>    # drop the previous table once the store checks out
 *   ... --rebuild-above 0.5 [--min-rows 2000000]                       # measure, then rebuild only above that unreferenced share
 *   ... --drop-previous-older-than-hours 1                             # verify current closure, then retire hour-old rollback copies
 *   ... --drop-previous-older-than 7                                   # legacy whole-day retention, with the same verification
 *   ... --table pgsl_kv                                                # the table (default pgsl_kv)
 *
 * WHY A REBUILD AND NOT A DELETE: deleting tens of millions of rows leaves the table the same
 * size until it is rewritten, and rewriting a 45 GB table needs 45 GB free, which is precisely
 * what a full volume does not have. The live set is small, so `rebuildTable` copies it into a
 * new table under an ACCESS EXCLUSIVE lock with a five-second SQL work budget,
 * swaps the names in the same transaction only if it finishes, and leaves the old table for `--drop` after the
 * store has been checked. See packages/pgsl-store/src/gc.ts for what "live" means.
 *
 * ── THE SCHEDULED RUN, AND WHERE ITS LINE IS ──────────────────────────────────────────────────
 *
 * pgsl-store-gc.yml runs `--drop-previous-older-than-hours 1 --rebuild-above 0.5` every hour.
 * The measurement is the same dry run; the decision is `rebuildDecision`, which
 * rebuilds when at least half of a table of at least --min-rows rows is unreferenced history —
 * the shape the 2026-09-20 outage had (78.7M rows, 1.19M live) — or when the table on disk holds
 * at least four times its live values and at least 1 GiB, the TOAST-and-index bloat the
 * 2026-09-21 measurement showed (2 GB on disk, 0.5 GB live, 7% of rows unreferenced). Below both
 * a table is never rebuilt automatically: the lock would cost more than the space. A rollback
 * copy stays at least one hour and is retired only after a complete current live-set check.
 * A fresh platform volume measurement must cover two table copies plus 1 GiB before a rebuild.
 * Collectors serialize before relation lookup. Rebuild uses NOWAIT and a monotonic total SQL
 * work budget, remaining server statement timeouts and a short idle-transaction timeout.
 * A large rebuild is deferred safely; this does not guarantee physical reclamation, online
 * compaction or an absolute wall-clock lock bound during durable COMMIT/network stalls.
 * A person can still dispatch any mode by hand, including explicit `--drop`.
 *
 * The connection string is read from the environment and never printed.
 */

import { basename } from 'node:path';
import { Client } from 'pg';
import { acquireCollectorLock, collectLive, keysBySubspace, readerFromPg, rebuildTable, RebuildDeferredError, type LiveSet } from '../packages/pgsl-store/src/gc.js';
import { requestFreshCollectorHeadroom } from './pgsl-store-gc-headroom-ipc.mjs';

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
 * Whether the scheduled run rebuilds: the unreferenced share of a table big enough to matter has
 * crossed the line. An unknown row estimate (a table never analysed reports -1) decides nothing.
 */
export function rebuildDecision(input: {
  readonly liveKeys: number;
  readonly tableRows: number;
  readonly line: number;
  readonly minRows: number;
  /** What the table takes on disk, heap + TOAST + indexes; with liveBytes, the second criterion. */
  readonly totalBytes?: number;
  /** The bytes of node values the live set holds: what a rebuilt table would carry. */
  readonly liveBytes?: number;
  /** On-disk bytes per live byte at or above which a rebuild is worth its lock (default 4). */
  readonly bloatFactor?: number;
  /** Below this many bytes on disk the bloat criterion never fires (default 1 GiB). */
  readonly minBytes?: number;
}): RebuildDecision {
  const { liveKeys, tableRows, line, minRows } = input;
  const bloatFactor = input.bloatFactor ?? 4;
  const minBytes = input.minBytes ?? 1_073_741_824;
  if (!(line > 0 && line <= 1)) throw new Error('--rebuild-above takes a share between 0 and 1');
  const mb = (n: number): string => `${Math.round(n / 1_048_576)} MB`;
  const pct = (n: number): string => `${Math.round(n * 100)}%`;
  // TOAST and index space: the rows can be few and live while the table on disk holds several
  // times what they need, which the 2026-09-21 measurement showed (2 GB on disk, 0.5 GB live,
  // 7% of rows unreferenced). A rebuild copies the live rows into a fresh table and returns it.
  const bloat = input.totalBytes !== undefined && input.liveBytes !== undefined && input.liveBytes > 0 ? input.totalBytes / input.liveBytes : undefined;
  const bloated = bloat !== undefined && (input.totalBytes as number) >= minBytes && bloat >= bloatFactor;
  const bloatNote = bloat === undefined ? '' : `; ${mb(input.totalBytes as number)} on disk holds ${mb(input.liveBytes as number)} of live values (${bloat.toFixed(1)}x, ${bloat >= bloatFactor ? 'at or above' : 'below'} ${bloatFactor}x${(input.totalBytes as number) < minBytes ? `, under the ${mb(minBytes)} floor` : ''})`;
  if (!Number.isFinite(tableRows) || tableRows < 0) {
    return { rebuild: false, reclaimableShare: 0, reason: `the table row estimate is unknown (never analysed), so nothing is decided on it${bloatNote}` };
  }
  const share = tableRows === 0 ? 0 : Math.max(0, (tableRows - liveKeys) / tableRows);
  if (bloated) {
    return { rebuild: true, reclaimableShare: share, reason: `${mb(input.totalBytes as number)} on disk holds ${mb(input.liveBytes as number)} of live values (${(bloat as number).toFixed(1)}x, at or above ${bloatFactor}x with at least ${mb(minBytes)}): TOAST and index space a rebuild returns` };
  }
  if (tableRows < minRows) {
    return { rebuild: false, reclaimableShare: share, reason: `${tableRows} rows is below the floor of ${minRows}; a rebuild would reclaim too little to hold a lock for${bloatNote}` };
  }
  const history = `${pct(share)} of ${tableRows} rows are unreferenced history (${liveKeys} live)`;
  return share >= line
    ? { rebuild: true, reclaimableShare: share, reason: `${history}, at or above the line of ${pct(line)}` }
    : { rebuild: false, reclaimableShare: share, reason: `${history}, below the line of ${pct(line)}${bloatNote}` };
}

/**
 * The tables earlier rebuilds left behind (`<table>_old_YYYYMMDD[_HHMMSSmmm]`) that are older than `days`:
 * the store has run on the new table for that long, so the copy has served its purpose.
 */
export function previousTablesToDrop(names: readonly string[], table: string, now: Date, days: number): string[] {
  const re = new RegExp(`^${table}_old_([0-9]{4})([0-9]{2})([0-9]{2})(?:_([0-9]{2})([0-9]{2})([0-9]{2})([0-9]{3}))?$`);
  const cutoff = now.getTime() - days * 86_400_000;
  return names
    .filter((n) => {
      const m = re.exec(n);
      if (!m) return false;
      const time = Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]),
        Number(m[4] ?? 0), Number(m[5] ?? 0), Number(m[6] ?? 0), Number(m[7] ?? 0));
      // Reject calendar/time overflow rather than aging a malformed name.
      const stamp = new Date(time).toISOString().replace(/[-:.TZ]/g, '');
      if (stamp !== m.slice(1, 4).join('') + m.slice(4).map(v => v ?? '').join('').padEnd(9, '0')) return false;
      return time <= cutoff;
    })
    .sort();
}

/** Date-only legacy names cannot establish an hour: keep them until the end
 * of their named UTC day plus the retention window. New backups carry millis. */
export function previousTablesToDropAfterHours(names: readonly string[], table: string, now: Date, hours: number): string[] {
  if (!Number.isSafeInteger(hours) || hours < 1 || !Number.isFinite(now.getTime())) throw new Error('backup retention takes a positive whole number of hours');
  return previousTablesToDrop(names, table, now, hours / 24).filter(name => {
    if (/_\d{9}$/.test(name)) return true;
    const date = /_(\d{4})(\d{2})(\d{2})$/.exec(name)!;
    const latestPossibleTime = Date.UTC(Number(date[1]), Number(date[2]) - 1, Number(date[3])) + 86_400_000;
    return latestPossibleTime <= now.getTime() - hours * 3_600_000;
  });
}

export function assertCompleteLiveSet(live: Pick<LiveSet, 'keys' | 'stats'>): void {
  if (live.keys.size === 0 || live.stats.danglingRoots.length > 0 || live.stats.unreadableNodes > 0) {
    throw new Error(`refusing backup cleanup: ${live.keys.size} live keys, ${live.stats.danglingRoots.length} dangling roots, ${live.stats.unreadableNodes} unreadable nodes`);
  }
}

type CollectorClient = Pick<Client, 'query'>;
/** Only a complete current store authorizes retiring its generated rollback copies. */
export async function dropExpiredPreviousTables(client: CollectorClient, table: string, live: Pick<LiveSet, 'keys' | 'stats'>,
  retention: { hours: number } | { days: number }, now = new Date(), log: (line: string) => void = () => {}): Promise<string[]> {
  assertCompleteLiveSet(live);
  if (!/^[a-zA-Z0-9_]+$/.test(table)) throw new Error('invalid collector table');
  const names = (await client.query(`SELECT c.relname FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relkind = 'r' AND c.relname LIKE $1`, [`${table}_old_%`])).rows.map(row => String(row['relname']));
  const due = 'hours' in retention ? previousTablesToDropAfterHours(names, table, now, retention.hours)
    : previousTablesToDrop(names, table, now, retention.days);
  for (const old of due) {
    log(`dropping verified rollback copy ${old} after ${'hours' in retention ? `${retention.hours} hour(s)` : `${retention.days} day(s)`}`);
    await client.query(`DROP TABLE public.${old}`);
  }
  log(`rollback cleanup verified current closure; ${due.length} expired copy/copies dropped (${names.length} present)`);
  return due;
}

/** A copy also generates WAL and indexes. Reserve two source-table sizes plus
 * 1 GiB for concurrent traffic; unknown/stale platform usage never permits it. */
export function assertRebuildHeadroom(input: { capacityBytes: number; usedBytes: number; sampledAt: number; tableBytes: number }, now = Date.now()): void {
  const { capacityBytes, usedBytes, sampledAt, tableBytes } = input;
  if (![capacityBytes, usedBytes, sampledAt, tableBytes, now].every(Number.isSafeInteger)
    || capacityBytes <= 0 || usedBytes < 0 || usedBytes > capacityBytes || tableBytes <= 0
    || sampledAt > now || now - sampledAt > 10 * 60_000) throw new Error('refusing rebuild: fresh verified volume headroom is unavailable');
  const required = tableBytes * 2 + 1_073_741_824;
  if (!Number.isSafeInteger(required)) throw new Error('refusing rebuild: required headroom exceeds a safe byte count');
  if (capacityBytes - usedBytes < required) throw new Error(`refusing rebuild: ${capacityBytes - usedBytes} free bytes, need ${required} for copy, WAL and reserve`);
}

async function main(): Promise<void> {
  const conn = process.env['PGSL_PG_CONNSTR'];
  if (!conn) { console.error('PGSL_PG_CONNSTR is not set'); process.exit(2); }
  const table = (flag('--table') ?? 'pgsl_kv').replace(/[^a-zA-Z0-9_]/g, '');
  const client = new Client({ connectionString: conn, statement_timeout: 0, application_name: 'pgsl-store-gc' });
  await client.connect();
  const log = (line: string): void => { console.log(`[${new Date().toISOString().slice(11, 19)}] ${line}`); };
  let release: (() => Promise<void>) | undefined;
  try {
    release = await acquireCollectorLock(client, table);
    await client.query("SET lock_timeout = '5s'");
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
    const dropOlder = flag('--drop-previous-older-than'), dropHours = flag('--drop-previous-older-than-hours');
    if (dropOlder !== undefined && dropHours !== undefined) throw new Error('choose hours or days for backup retention');
    if (dropOlder !== undefined && (!Number.isSafeInteger(Number(dropOlder)) || Number(dropOlder) < 1)) throw new Error('--drop-previous-older-than takes a whole number of days');
    if (dropHours !== undefined && (!Number.isSafeInteger(Number(dropHours)) || Number(dropHours) < 1)) throw new Error('--drop-previous-older-than-hours takes a positive whole number of hours');
    const headroom = async (): Promise<void> => {
      // The remote parent's platform token stays outside this collector. Ask
      // for a NEW numeric sample only once a write attempt is actually needed,
      // after an arbitrarily long read-only scan and verified backup retirement.
      // An IPC failure must never fall back to the stale startup environment.
      const measured = typeof process.send === 'function' ? await requestFreshCollectorHeadroom()
        : { capacityBytes: Number(process.env['PGSL_GC_VOLUME_CAPACITY_BYTES']),
          usedBytes: Number(process.env['PGSL_GC_VOLUME_USED_BYTES']), sampledAt: Number(process.env['PGSL_GC_VOLUME_SAMPLED_AT']) };
      const bytes = Number((await client.query(`SELECT pg_total_relation_size($1) AS b`, [table])).rows[0]?.['b']);
      assertRebuildHeadroom({ tableBytes: bytes, ...measured });
      log('fresh volume headroom covers copy, WAL and reserve');
    };
    const attemptRebuild = async (): Promise<Awaited<ReturnType<typeof rebuildTable>> | null> => {
      try { return await rebuildTable(client, table, { log }); }
      catch (error) {
        if (!(error instanceof RebuildDeferredError)) throw error;
        log(`${error.message}; original table remains authoritative, no physical reclamation is claimed`);
        return null;
      }
    };
    if (process.argv.includes('--rebuild')) {
      await headroom();
      const r = await attemptRebuild();
      if (!r) return;
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
    if (dropOlder !== undefined || dropHours !== undefined) {
      await dropExpiredPreviousTables(client, table, live, dropHours !== undefined ? { hours: Number(dropHours) } : { days: Number(dropOlder) }, new Date(), log);
    }
    const total = await client.query(`SELECT reltuples::bigint AS n FROM pg_class WHERE relname = $1`, [table]);
    log(`table rows (planner estimate): ${total.rows[0]?.['n']}; the rebuild would keep ${live.keys.size}`);
    const line = flag('--rebuild-above');
    if (line !== undefined) {
      const bytes = await client.query(`SELECT pg_total_relation_size($1) AS b`, [table]);
      const d = rebuildDecision({ liveKeys: live.keys.size, tableRows: Number(total.rows[0]?.['n'] ?? -1), line: Number(line), minRows: Number(flag('--min-rows') ?? 2_000_000), totalBytes: Number(bytes.rows[0]?.['b'] ?? -1), liveBytes: live.stats.liveNodeBytes });
      log(`${d.rebuild ? 'rebuilding' : 'not rebuilding'}: ${d.reason}`);
      if (d.rebuild) {
        await headroom();
        const r = await attemptRebuild();
        if (!r) return;
        log(`rebuild done: ${r.newRows} rows live in ${table} (${await size(table)}); previous table ${r.oldTable} (${await size(r.oldTable)}) is dropped by a later run's --drop-previous-older-than`);
        await client.query(`ANALYZE ${table}`);
      }
    }
  } finally {
    await release?.().catch(() => undefined);
    await client.end();
  }
}

if (process.argv[1] && basename(process.argv[1]) === 'pgsl-store-gc.ts') {
  main().catch((err) => { console.error(err instanceof Error ? err.message : String(err)); process.exit(1); });
}
