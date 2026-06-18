/**
 * Codegen: derive the frozen interrogative table from the published ontologies
 * (docs/ns/interego.ttl + docs/ns/alignment.ttl) and write it to
 * packages/pgsl/src/interrogative-table.generated.ts.
 *
 * Run from anywhere in the workspace:
 *   npx tsx packages/pgsl/scripts/gen-interrogative-table.ts
 *
 * The committed output ships in the @interego/pgsl tarball (files: ["dist/","src/"])
 * so the relay never reads .ttl at runtime. The drift test
 * (tests/interrogative-router.test.ts) re-runs this derivation and asserts the
 * committed table matches — so editing the .ttl + forgetting to regen fails CI.
 */
import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { loadOntology } from '../src/static-ontology.js';
import { deriveInterrogativeTable } from '../src/interrogative-router.js';

const here = dirname(fileURLToPath(import.meta.url));
const outPath = resolve(here, '../src/interrogative-table.generated.ts');

const table = deriveInterrogativeTable(loadOntology('interego'), loadOntology('alignment'));
if (table.length !== 11) {
  console.error(`Expected 11 interrogatives, derived ${table.length}. Aborting.`);
  process.exit(1);
}

const body = table.map(e => '  ' + JSON.stringify(e)).join(',\n');
const out = `// AUTO-GENERATED — do not edit by hand.
// Source: docs/ns/interego.ttl (skos labels) + docs/ns/alignment.ttl (align:answersInterrogative).
// Regenerate: npx tsx packages/pgsl/scripts/gen-interrogative-table.ts
// Drift-guarded by tests/interrogative-router.test.ts.
import type { InterrogativeEntry } from './interrogative-router.js';

export const INTERROGATIVE_TABLE: readonly InterrogativeEntry[] = [
${body},
];
`;
writeFileSync(outPath, out);
console.log(`Wrote ${table.length} interrogatives -> ${outPath}`);
for (const e of table) console.log(`  ${e.type.padEnd(9)} cues=[${e.prefLabel}, ${e.altLabels.join(', ')}]  answeredBy=[${e.answeredBy.join(', ')}]`);
