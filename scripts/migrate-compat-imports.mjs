#!/usr/bin/env node
/**
 * Mechanical migration: rewrite every `import { ... } from '@interego/core'`
 * statement so each symbol resolves to the package that actually owns it
 * (substrate stays in @interego/core, everything else moves to the right
 * @interego/<vertical> package).
 *
 * Drives off a dynamically computed symbol→package map built from each
 * leaf package's exports + a small alias table for the renames the
 * compat shim performed (evaluateAbac → @interego/abac::evaluate, etc.).
 */

import { readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';

// ───────────────────────────────────────────────────────────
// Build the map dynamically by scanning each leaf package's index.
// ───────────────────────────────────────────────────────────

async function extractExportedNames(file) {
  const text = await readFile(file, 'utf8');
  const out = new Set();
  // Match `export { a, b, type C } [from '...']` blocks.
  const re = /export(?:\s+type)?\s*\{([^{}]+)\}/g;
  for (const m of text.matchAll(re)) {
    for (const raw of m[1].split(',')) {
      const t = raw.trim().replace(/^type\s+/, '');
      const mm = t.match(/^([A-Za-z_$][\w$]*)(?:\s+as\s+([A-Za-z_$][\w$]*))?$/);
      if (mm) out.add(mm[2] || mm[1]);
    }
  }
  // Top-level `export function|class|const|let|var|interface|type|enum X`.
  const reBare = /^export\s+(?:async\s+)?(?:function|class|const|let|var|interface|type|enum)\s+([A-Za-z_$][\w$]*)/gm;
  for (const m of text.matchAll(reBare)) out.add(m[1]);
  // Resolve `export * from './foo.js'` by recursing into the referenced file.
  const reStar = /export\s*\*\s*(?:as\s+[A-Za-z_$][\w$]*\s+)?from\s*['"]([^'"]+)['"]/g;
  for (const m of text.matchAll(reStar)) {
    const ref = m[1];
    if (!ref.startsWith('.')) continue;
    // Resolve relative to the current file.
    const refPath = resolve(dirname(file), ref.replace(/\.js$/, '.ts'));
    try {
      const subNames = await extractExportedNames(refPath);
      for (const n of subNames) out.add(n);
    } catch {
      // Ignore unresolvable refs.
    }
  }
  return [...out];
}

const PACKAGES = [
  ['@interego/abac',          'packages/abac/src/index.ts'],
  ['@interego/compliance',    'packages/compliance/src/index.ts'],
  ['@interego/connectors',    'packages/connectors/src/index.ts'],
  ['@interego/constitutional','packages/constitutional/src/index.ts'],
  ['@interego/extractors',    'packages/extractors/src/index.ts'],
  ['@interego/ops',           'packages/ops/src/index.ts'],
  ['@interego/p2p',           'packages/p2p/src/index.ts'],
  ['@interego/passport',      'packages/passport/src/index.ts'],
  ['@interego/pgsl',          'packages/pgsl/src/index.ts'],
  ['@interego/privacy',       'packages/privacy/src/index.ts'],
  ['@interego/registry',      'packages/registry/src/index.ts'],
  ['@interego/security-txt',  'packages/security-txt/src/index.ts'],
  ['@interego/skills',        'packages/skills/src/index.ts'],
  ['@interego/solid',         'packages/solid/src/index.ts'],
  ['@interego/solid/naming',  'packages/solid/src/naming.ts'],
  ['@interego/transactions',  'packages/transactions/src/index.ts'],
];

const MAP = {};
for (const [pkg, src] of PACKAGES) {
  for (const name of await extractExportedNames(src)) {
    // First package to claim a name wins; PGSL claims a few names that
    // also appear in solid (e.g. computeLatticeCids). The PGSL package
    // comes before solid in our table for kernel/lattice-adapter ordering.
    if (!MAP[name]) MAP[name] = { pkg };
  }
}

// Apply the compat shim's renames.
//
// These are the spots where the compat shim re-exported a leaf symbol
// under a different name to avoid collisions with another leaf
// (ABAC vs PGSL `evaluate` / `PolicyContext`) or to disambiguate
// kernel vs OODA `act`.
const ALIASES = {
  evaluateAbac:               { pkg: '@interego/abac', realName: 'evaluate' },
  evaluateAbacPolicy:         { pkg: '@interego/abac', realName: 'evaluateSingle' },
  validateAbacShape:          { pkg: '@interego/abac', realName: 'validateAgainstShape' },
  AbacPolicyContext:          { pkg: '@interego/abac', realName: 'PolicyContext' },
  AbacPolicyDecision:         { pkg: '@interego/abac', realName: 'PolicyDecision' },
  SkillDescriptorBundle:      { pkg: '@interego/skills', realName: 'DescriptorBundle' },
  computeSolidCid:            { pkg: '@interego/solid', realName: 'computeCid' },
  SDKPublishOptions:          { pkg: '@interego/solid', realName: 'PublishOptions' },
  SDKPublishResult:           { pkg: '@interego/solid', realName: 'PublishResult' },
  NameResolveOptions:         { pkg: '@interego/solid/naming', realName: 'ResolveOptions' },
  // PGSL aliases — kept under the names the compat shim surfaced.
  sparqlMatchPattern:         { pkg: '@interego/pgsl', realName: 'matchPattern' },
  pgslResolve:                { pkg: '@interego/pgsl', realName: 'resolve' },
  computeDecisionAffordances: { pkg: '@interego/pgsl', realName: 'computeAffordances' },
  decideFromObservations:     { pkg: '@interego/pgsl', realName: 'decide' },
  DecisionAffordance:         { pkg: '@interego/pgsl', realName: 'Affordance' },
  PGSLNode:                   { pkg: '@interego/pgsl', realName: 'Node' },
  PgslDeonticMode:            { pkg: '@interego/pgsl', realName: 'DeonticMode' },
  PgslPolicyContext:          { pkg: '@interego/pgsl', realName: 'PolicyContext' },
  PgslPolicyDecision:         { pkg: '@interego/pgsl', realName: 'PolicyDecision' },
  // The compat shim surfaced bare `evaluate` as PGSL's `evaluatePolicy`
  // (and reserved abac's `evaluate` under `evaluateAbac`). Preserve that
  // historical binding for the migration.
  evaluate:                   { pkg: '@interego/pgsl', realName: 'evaluatePolicy' },
  // Bare `PolicyContext` / `PolicyDecision` from core were PGSL's. Abac's
  // forms are exposed via the prefixed aliases above.
  PolicyContext:              { pkg: '@interego/pgsl' },
  PolicyDecision:             { pkg: '@interego/pgsl' },
};
for (const [aliasName, target] of Object.entries(ALIASES)) {
  MAP[aliasName] = target;
}

// A handful of names are AMBIGUOUS — they're exported by BOTH the
// substrate (@interego/core) and a leaf. The substrate owns them: the
// migrator must NOT redirect to a leaf. List them here so the dynamic
// scan doesn't pick the leaf.
//
// These come from cases where the substrate kernel + a leaf both define
// the same conceptual name (e.g. `Affordance`, `computeAffordances`,
// `act`, `PolicyContext`). For the leaf the unprefixed name is *that
// leaf's*; for core the unprefixed name is core's. Historical compat
// surfaced core's by default.
const SUBSTRATE_OWNED = new Set([
  // Kernel/affordance verbs that the substrate's own index re-exports.
  'computeAffordances', 'decide', 'observe', 'orient', 'oodaAct',
  'evaluateSurprise', 'createStigmergicField', 'updateStigmergicField',
  'createOODACycle', 'createAgentState', 'addDesire', 'commitToAffordance',
  'assimilateDescriptor',
  // Affordance types lifted into the kernel as substrate-shaped affordance results
  'Signifier', 'AgentProfile', 'AgentCapability', 'TrustPolicy',
  'CausalAffordanceEffect', 'OODAPhase', 'Orientation',
  'OODACycle', 'CompletedAction',
  'SituationalAwarenessLevel', 'PerceptionState', 'ComprehensionState',
  'ProjectionState', 'AnticipatedChange', 'AgentState', 'BeliefEntry',
  'Desire', 'CommittedAffordance', 'ReconsiderationTrigger',
  'FreeEnergyEvaluation', 'FreeEnergyResponse', 'StigmergicField',
  'AffordanceAction', 'AffordanceReason', 'AntiAffordance', 'AffordanceSet',
  'AffordanceTrustEvaluation', 'AffordanceResult',
  'PodFieldState', 'TrustDistribution',
  // Manifest type that lives in core's substrate-shape manifest.
  'ManifestEntry',
  // Naming/HTTP helpers that the kernel re-exports
  'FetchFn', 'FetchResponse', 'WebSocketLike', 'WebSocketConstructor',
  'TransientRetryOptions',
  'followAffordance', 'DescriptorNotFoundError', 'AffordanceNotFoundError',
  'FollowAffordanceOptions', 'FollowAffordanceResult', 'ResolvedAffordance', 'AffordanceMethod',
  // Crypto signed-descriptor / siwe types — substrate's, not compliance's
  'signDescriptor', 'verifyDescriptorSignature', 'SignedDescriptor',
  // computeCid — core has it under the bare name; solid has computeSolidCid alias.
  'computeCid',
  // Substrate HTTP plumbing — historically lived in solid/, moved out
  // to core/http when the binding split. Both core + solid re-export
  // for back-compat; the substrate owns the name.
  'withTransientRetry', 'isTransientNetworkError',
  'getDefaultFetch', 'getDefaultWebSocket',
]);
for (const name of SUBSTRATE_OWNED) delete MAP[name];

// ───────────────────────────────────────────────────────────
// File list + rewriter.
// ───────────────────────────────────────────────────────────

const args = process.argv.slice(2);
let listFile = null;
let dryRun = false;
for (let i = 0; i < args.length; i++) {
  if (args[i] === '--list') listFile = args[++i];
  else if (args[i] === '--dry') dryRun = true;
}
if (!listFile) {
  console.error('usage: migrate-compat-imports.mjs --list <file-list> [--dry]');
  process.exit(2);
}

const list = (await readFile(listFile, 'utf8'))
  .split(/\r?\n/)
  .map(s => s.trim())
  .filter(s => s && !s.startsWith('#'));

// Match (export|import) [type ]{ ... } from '@interego/core'
const IMPORT_RE = /(?<kind>import|export)(?<typeKw>\s+type)?\s*\{(?<body>[^{}]*?)\}\s*from\s*['"]@interego\/core['"]\s*;?/g;

let totalFiles = 0;
let changedFiles = 0;
let totalImportStatements = 0;
const unmapped = new Map();

for (const rel of list) {
  const abs = resolve('d:/devstuff/harness', rel.replace(/\\/g, '/'));
  let src;
  try { src = await readFile(abs, 'utf8'); }
  catch (e) { console.warn(`SKIP missing ${abs}: ${e.message}`); continue; }
  totalFiles++;
  let mutated = false;

  const newSrc = src.replace(IMPORT_RE, (whole, ...rest) => {
    totalImportStatements++;
    const groups = rest[rest.length - 1];
    const kind = groups.kind;
    const wholeIsType = !!groups.typeKw;
    const body = groups.body;

    const cleanBody = body
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/\/\/[^\n]*/g, '');
    const entries = [];
    for (const raw of cleanBody.split(',')) {
      const tok = raw.trim();
      if (!tok) continue;
      const m = tok.match(/^(type\s+)?([A-Za-z_$][\w$]*)\s*(?:as\s+([A-Za-z_$][\w$]*))?$/);
      if (!m) {
        console.warn(`[${rel}] unparseable import entry: ${tok}`);
        return whole;
      }
      entries.push({
        isType: wholeIsType || !!m[1],
        name: m[2],
        alias: m[3] || null,
      });
    }

    const buckets = new Map();
    const coreBucket = [];
    for (const e of entries) {
      const m = MAP[e.name];
      if (!m) {
        coreBucket.push(e);
        continue;
      }
      const importedName = m.realName || e.name;
      const localName = e.alias || e.name;
      const entry = { isType: e.isType, importedName, localName };
      const arr = buckets.get(m.pkg) || [];
      arr.push(entry);
      buckets.set(m.pkg, arr);
    }

    if (buckets.size === 0) {
      return whole;
    }

    const out = [];
    if (coreBucket.length > 0) {
      out.push(emitStmt(kind, '@interego/core', coreBucket.map(e => ({
        isType: e.isType,
        importedName: e.name,
        localName: e.alias || e.name,
      })), wholeIsType));
    }
    const pkgNames = [...buckets.keys()].sort();
    for (const pkg of pkgNames) {
      out.push(emitStmt(kind, pkg, buckets.get(pkg), wholeIsType));
    }
    if (out.length === 0) {
      mutated = true;
      return '';
    }
    mutated = true;
    return out.join('\n');
  });

  if (mutated) {
    changedFiles++;
    if (!dryRun) await writeFile(abs, newSrc, 'utf8');
  }
}

function emitStmt(kind, pkg, entries, allType) {
  entries = [...entries].sort((a, b) => a.importedName.localeCompare(b.importedName));
  const lines = entries.map(e => {
    const aliasPart = e.localName !== e.importedName ? ` as ${e.localName}` : '';
    const typePart = (!allType && e.isType) ? 'type ' : '';
    return `  ${typePart}${e.importedName}${aliasPart},`;
  });
  const typeKw = allType ? ' type' : '';
  return `${kind}${typeKw} {\n${lines.join('\n')}\n} from '${pkg}';`;
}

console.log(`Files scanned: ${totalFiles}`);
console.log(`Files changed: ${changedFiles}`);
console.log(`Import statements rewritten: ${totalImportStatements}`);
console.log(`Map symbol count: ${Object.keys(MAP).length}`);
