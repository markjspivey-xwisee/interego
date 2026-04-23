#!/usr/bin/env node
// Ontology consistency lint.
//
// Scans TS source for `<prefix>:<Term>` emissions and verifies each
// term exists in the corresponding `docs/ns/<prefix>.ttl` ontology.
// Catches the drift pattern where runtime code invents new predicates
// or classes without defining them, which erodes the protocol's
// self-description guarantee.
//
// Exit non-zero when any undefined term is found. Intended to run in
// CI so drift never lands on master.
//
// Known-external namespaces (W3C, common vocabs) are ignored — we
// don't own those, so a reference to `dcat:Distribution` is always OK.

import { readFileSync, readdirSync, statSync } from 'node:fs';
import { resolve, relative, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = resolve(__filename, '..');
const ROOT = resolve(__dirname, '..');

// ── Config ───────────────────────────────────────────────────

const OWNED_NAMESPACES = {
  // prefix    : ontology file
  cg:         'docs/ns/cg.ttl',
  cgh:        'docs/ns/harness.ttl',
  pgsl:       'docs/ns/pgsl.ttl',
  ie:         'docs/ns/interego.ttl',
  align:      'docs/ns/alignment.ttl',
  hyprcat:    'docs/ns/hyprcat.ttl',
  hypragent:  'docs/ns/hypragent.ttl',
  hela:       'docs/ns/hela.ttl',
  sat:        'docs/ns/sat.ttl',
  cts:        'docs/ns/cts.ttl',
  olke:       'docs/ns/olke.ttl',
  amta:       'docs/ns/amta.ttl',
  // Domain ontologies (L3)
  code:       'docs/ns/code.ttl',
};

// Known-external prefixes we don't own — references are always valid
const EXTERNAL_PREFIXES = new Set([
  'rdf', 'rdfs', 'xsd', 'owl', 'sh', 'skos', 'vann', 'dct', 'dcat',
  'dprod', 'prov', 'time', 'foaf', 'vc', 'hydra', 'acl', 'solid',
  'ldp', 'odrl', 'did', 'schema', 'oa', 'as',
]);

const SCAN_PATHS = [
  'src',
  'deploy/identity',
  'deploy/mcp-relay',
  'mcp-server',
];

// Known-drift baseline. Entries here are terms emitted by code that
// aren't yet in the ontology — tracked so CI doesn't block on
// accumulated pre-existing drift, but new drift still fails. Over
// time, items migrate OUT of this file INTO docs/ns/<prefix>.ttl and
// the allowlist shrinks. A grown allowlist is a signal to schedule
// an ontology-definition pass.
const ALLOWLIST_PATH = 'tools/ontology-lint.allowlist.txt';

const TS_EXTS = new Set(['.ts', '.mts', '.cts']);

// ── Ontology extraction ─────────────────────────────────────

/**
 * Parse a .ttl file and return the set of locally-defined term names
 * (the Xxx in `prefix:Xxx a owl:Class`, `prefix:xxx a owl:ObjectProperty`,
 * etc.). Approximate parser — matches bare `prefix:Name ` at the start
 * of declarations, which covers how every ontology in this project is
 * written. Also picks up `a prefix:Xxx` on the right-hand side since
 * individuals of owned classes are also "defined".
 */
function extractDefinedTerms(ttlPath, prefix) {
  const body = readFileSync(ttlPath, 'utf8');
  const defined = new Set();
  // Lines like: `cg:Foo a owl:Class ;` or `cg:foo a owl:ObjectProperty ;`
  const defRegex = new RegExp(`(?:^|\\n)\\s*${prefix}:([A-Za-z][A-Za-z0-9_-]*)\\s+a\\s`, 'g');
  let m;
  while ((m = defRegex.exec(body)) !== null) {
    defined.add(m[1]);
  }
  // Individuals referenced as `a cg:Xxx` — our existing cg:canPublish etc.
  // are defined by `cg:canPublish a cg:Affordance`. Since Affordance is
  // already defined by the first regex, no extra work here.
  return defined;
}

// ── TS source scan ──────────────────────────────────────────

function* walkFiles(dir) {
  const entries = readdirSync(dir);
  for (const entry of entries) {
    if (entry === 'node_modules' || entry === 'dist' || entry === 'tests' || entry.startsWith('.')) continue;
    const full = join(dir, entry);
    const s = statSync(full);
    if (s.isDirectory()) {
      yield* walkFiles(full);
    } else if (TS_EXTS.has(full.slice(full.lastIndexOf('.')))) {
      yield full;
    }
  }
}

function findReferencesInFile(tsPath, prefixes) {
  const body = readFileSync(tsPath, 'utf8');
  const refs = [];
  // Match `prefix:Term` inside TS string literals + template literals.
  // Negative lookbehind for `:` or word-char skips matches inside longer
  // URIs like `urn:cg:my-context` where `my-context` is example text,
  // not a real ontology term.
  const refRegex = new RegExp(
    `['"\`][^'"\`]*?(?<![:\\w])(${prefixes.join('|')}):([A-Za-z][A-Za-z0-9_]*)`,
    'g',
  );
  let m;
  while ((m = refRegex.exec(body)) !== null) {
    refs.push({ prefix: m[1], term: m[2], path: tsPath, offset: m.index });
  }
  return refs;
}

// ── Main ─────────────────────────────────────────────────────

const prefixes = Object.keys(OWNED_NAMESPACES);
const definedByPrefix = {};
for (const [prefix, file] of Object.entries(OWNED_NAMESPACES)) {
  definedByPrefix[prefix] = extractDefinedTerms(resolve(ROOT, file), prefix);
}

// Load the allowlist (one `prefix:term` per line). Missing-file = empty.
const allowlist = new Set();
try {
  const body = readFileSync(resolve(ROOT, ALLOWLIST_PATH), 'utf8');
  for (const line of body.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    allowlist.add(trimmed);
  }
} catch { /* no allowlist — strict mode */ }

const missing = []; // { prefix, term, path }

for (const scanPath of SCAN_PATHS) {
  const absScan = resolve(ROOT, scanPath);
  for (const tsFile of walkFiles(absScan)) {
    const refs = findReferencesInFile(tsFile, prefixes);
    for (const ref of refs) {
      if (!definedByPrefix[ref.prefix].has(ref.term)) {
        // Case-insensitive fallback — most of the ontology is case-
        // sensitive but some old code uses mixed case.
        const lowerMatch = [...definedByPrefix[ref.prefix]]
          .some(t => t.toLowerCase() === ref.term.toLowerCase());
        if (lowerMatch) continue;
        // Allowlist — pre-existing drift that is known and tracked.
        if (allowlist.has(`${ref.prefix}:${ref.term}`)) continue;
        missing.push(ref);
      }
    }
  }
}

// ── Report ───────────────────────────────────────────────────

if (missing.length === 0) {
  console.log(`\u2713 Ontology lint: every owned-namespace reference in TS is defined (or allowlisted).`);
  console.log(`  prefixes checked:    ${prefixes.join(', ')}`);
  console.log(`  allowlisted drift:   ${allowlist.size} term(s) in ${ALLOWLIST_PATH}`);
  console.log(`  defined term counts:`);
  for (const p of prefixes) {
    console.log(`    ${p}: ${definedByPrefix[p].size}`);
  }
  process.exit(0);
}

// Group by (prefix, term) for readable output
const grouped = new Map();
for (const r of missing) {
  const key = `${r.prefix}:${r.term}`;
  if (!grouped.has(key)) grouped.set(key, []);
  grouped.get(key).push(r.path);
}

console.error(`\u2717 Ontology lint: found ${grouped.size} undefined term(s) emitted by code.`);
console.error(`  Every owned-namespace reference in TS must have a matching`);
console.error(`  declaration in its docs/ns/<prefix>.ttl file.\n`);
for (const [qn, paths] of [...grouped.entries()].sort()) {
  const uniq = [...new Set(paths.map(p => relative(ROOT, p).replace(/\\/g, '/')))];
  console.error(`  ${qn}`);
  for (const p of uniq.slice(0, 5)) {
    console.error(`      in ${p}`);
  }
  if (uniq.length > 5) console.error(`      ... and ${uniq.length - 5} more`);
}
console.error(`\nFix: either add the term to the appropriate docs/ns/*.ttl file`);
console.error(`or change the TS emission to use an existing term.`);
process.exit(1);
