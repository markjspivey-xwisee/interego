/**
 * One-time migration parity helper; not an application runtime dependency.
 * Arguments: full upstream clone, glossary path, optional output path.
 */
import { writeFileSync } from 'node:fs';
import { snapshot, diff, releases, reconcile, totals, serializeSnapshot, type JsonObject } from './history.js';
import { readFileSync } from 'node:fs';
const [clone, gpath, output] = process.argv.slice(2);
if (!clone || !gpath) throw new Error('Usage: tsx history-parity.ts CLONE GLOSSARY_PATH [OUTPUT]');
const rels = releases(clone, gpath);
const fixture = JSON.parse(readFileSync(new URL('./fixtures/history.json', import.meta.url), 'utf8')) as { before: JsonObject; after: JsonObject };
const result = {
  kinds: (await import('./history.js')).KINDS,
  releases: rels.map(r => ({ ...r, snap: serializeSnapshot(r.snap) })),
  reconciliation: reconcile(rels),
  totals: rels.map(r => totals(r.snap)),
  fixture: { before: serializeSnapshot(snapshot(fixture.before)), after: serializeSnapshot(snapshot(fixture.after)),
    events: diff(snapshot(fixture.before), snapshot(fixture.after)) },
};
const json = JSON.stringify(result, null, 2) + '\n';
if (output) writeFileSync(output, json);
else process.stdout.write(json);
