/**
 * Is any Railway volume close to full? Exit 1 when one is at or above the threshold.
 *
 * ── WHY THIS EXISTS ────────────────────────────────────────────────────────────────────────
 *
 * On 2026-09-20 the Postgres volume behind every pod reached 50,196 MB of 50,000 MB. Postgres
 * could not write its transaction status files, the pod store answered 500 on every pod, the
 * relay could not persist tokens, and nothing in this repository had said a word beforehand,
 * because nothing looked. The fleet audit already runs every morning against the live API;
 * this is the one question it did not ask. Growing a volume is a dashboard action, so the
 * point of the check is to say "grow it" a week early, not to grow it.
 *
 *   RAILWAY_PROJECT_TOKEN=... node tools/railway-volume-check.mjs            # threshold 80%
 *   RAILWAY_PROJECT_TOKEN=... node tools/railway-volume-check.mjs --at 70    # a stricter one
 *
 * Exit codes: 0 every volume is under the threshold · 1 a volume is at or over it · 2 usage/auth.
 */

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { railwayGql } from './railway-pins.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

function token() {
  const fromEnv = process.env['RAILWAY_PROJECT_TOKEN'];
  if (fromEnv) return fromEnv;
  try {
    return readFileSync(join(ROOT, '.interego', 'railway-token.txt'), 'utf8').trim();
  } catch {
    process.stderr.write('RAILWAY_PROJECT_TOKEN is not set and .interego/railway-token.txt is unreadable.\n');
    process.exit(2);
  }
}

const at = process.argv.indexOf('--at');
const threshold = at >= 0 ? Number(process.argv[at + 1]) : 80;
if (!Number.isFinite(threshold) || threshold <= 0 || threshold > 100) {
  process.stderr.write('--at takes a percentage between 1 and 100\n');
  process.exit(2);
}

/** Pure, so the rule is testable: rows in, findings out. */
export function volumeFindings(rows, pct = 80) {
  return rows
    .map((r) => ({ ...r, usedPct: r.sizeMB > 0 ? Math.round((100 * r.currentSizeMB) / r.sizeMB) : 0 }))
    .filter((r) => r.usedPct >= pct);
}

async function main() {
  const gql = railwayGql(token());
  const { projectToken: { projectId } } = await gql('{ projectToken { projectId } }');
  const r = await gql(
    'query($p:String!){ project(id:$p){ services{ edges{ node{ id name } } } volumes{ edges{ node{ name volumeInstances{ edges{ node{ serviceId mountPath sizeMB currentSizeMB } } } } } } } }',
    { p: projectId },
  );
  const names = new Map(r.project.services.edges.map((e) => [e.node.id, e.node.name]));
  const rows = [];
  for (const v of r.project.volumes.edges) {
    for (const i of v.node.volumeInstances.edges) {
      rows.push({ volume: v.node.name, service: names.get(i.node.serviceId) ?? i.node.serviceId, mountPath: i.node.mountPath, sizeMB: i.node.sizeMB, currentSizeMB: i.node.currentSizeMB });
    }
  }
  if (rows.length === 0) {
    process.stderr.write('Railway returned no volumes. An empty answer would pass by saying nothing, so this is a failure.\n');
    process.exit(2);
  }
  for (const row of rows) {
    const pct = row.sizeMB > 0 ? Math.round((100 * row.currentSizeMB) / row.sizeMB) : 0;
    process.stdout.write(`  ${row.volume.padEnd(20)} on ${row.service.padEnd(12)} ${String(pct).padStart(3)}%  ${Math.round(row.currentSizeMB)} of ${row.sizeMB} MB at ${row.mountPath}\n`);
  }
  const full = volumeFindings(rows, threshold);
  if (full.length === 0) {
    process.stdout.write(`every volume is under ${threshold}%\n`);
    return;
  }
  process.stderr.write(`\n★ ${full.length} volume(s) at or over ${threshold}%: grow them in the Railway dashboard before Postgres runs out of room to write.\n`);
  for (const f of full) process.stderr.write(`  ${f.volume} on ${f.service}: ${f.usedPct}%\n`);
  process.exit(1);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main().catch((err) => { process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`); process.exit(2); });
}
