/**
 * Collect the unreferenced history of the pod store's Postgres table, or measure it.
 *
 *   PGSL_PG_CONNSTR=... npx tsx tools/pgsl-store-gc.ts                 # dry run: reads only, reports the live set
 *   PGSL_PG_CONNSTR=... npx tsx tools/pgsl-store-gc.ts --rebuild       # copy the live rows into a new table and swap
 *   PGSL_PG_CONNSTR=... npx tsx tools/pgsl-store-gc.ts --drop <old>    # drop the previous table once the store checks out
 *   ... --table pgsl_kv                                                # the table (default pgsl_kv)
 *
 * WHY A REBUILD AND NOT A DELETE: deleting tens of millions of rows leaves the table the same
 * size until it is rewritten, and rewriting a 45 GB table needs 45 GB free, which is precisely
 * what a full volume does not have. The live set is small, so `rebuildTable` copies it into a
 * new table under an EXCLUSIVE lock (readers continue, writers wait for the minutes it takes),
 * swaps the names in the same transaction, and leaves the old table for `--drop` after the
 * store has been checked. See packages/pgsl-store/src/gc.ts for what "live" means.
 *
 * The connection string is read from the environment and never printed.
 */

import { Client } from 'pg';
import { collectLive, keysBySubspace, readerFromPg, rebuildTable } from '../packages/pgsl-store/src/gc.js';

function flag(name: string): string | undefined {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
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
  } finally {
    await client.end();
  }
}

main().catch((err) => { console.error(err instanceof Error ? err.message : String(err)); process.exit(1); });
