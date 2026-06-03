#!/usr/bin/env node
/**
 * append-compat-reexport.mjs
 *
 * The substrate (`@interego/core`) builds in two passes:
 *
 *   1. `tsc` compiles `src/**` minus `compat.ts` against intra-package
 *      files only — produces `dist/index.js` + `dist/index.d.ts`.
 *   2. `tsc -p tsconfig.compat.json` compiles `src/compat.ts` after the
 *      sibling `@interego/*` leaves have built and become resolvable.
 *
 * This script runs AFTER step 2. It appends an `export * from
 * './compat.js'` line to both `dist/index.js` and `dist/index.d.ts` so
 * the moved-out vertical symbols (createConnector, evaluateAbac,
 * createPassport, ...) remain available via the bare `@interego/core`
 * import for back-compat. New code should import the vertical it
 * needs from `@interego/<vertical>` directly — see
 * `docs/ARCHITECTURAL-FOUNDATIONS.md §12` for the principled boundary.
 */
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const coreDist = resolve(here, '..', 'packages', 'core', 'dist');
const indexJs = resolve(coreDist, 'index.js');
const indexDts = resolve(coreDist, 'index.d.ts');

const MARKER = '// ── compat re-export (appended post-build) ──';
const SUFFIX_JS = `\n${MARKER}\nexport * from './compat.js';\n`;
const SUFFIX_DTS = `\n${MARKER}\nexport * from './compat.js';\n`;

function appendIfMissing(file, suffix) {
  if (!existsSync(file)) {
    console.error(`append-compat-reexport: missing ${file}`);
    process.exit(1);
  }
  const body = readFileSync(file, 'utf8');
  if (body.includes(MARKER)) return false;
  writeFileSync(file, body + suffix);
  return true;
}

const a = appendIfMissing(indexJs, SUFFIX_JS);
const b = appendIfMissing(indexDts, SUFFIX_DTS);

if (a || b) {
  console.log(`append-compat-reexport: appended re-export to ${a ? 'index.js' : ''}${a && b ? ' + ' : ''}${b ? 'index.d.ts' : ''}`);
} else {
  console.log('append-compat-reexport: already present, no-op');
}
