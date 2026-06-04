#!/usr/bin/env node
/**
 * Same migration as migrate-compat-imports.mjs but for the emergent
 * harnesses in examples/emergent/. They reach into
 * '../../packages/core/dist/index.js' directly (no workspace specifier).
 *
 * Reuses the dynamic symbol→package map.
 */

import { readFile, writeFile, readdir } from 'node:fs/promises';
import { resolve, dirname, join } from 'node:path';

async function extractExportedNames(file) {
  const text = await readFile(file, 'utf8');
  const out = new Set();
  const re = /export(?:\s+type)?\s*\{([^{}]+)\}/g;
  for (const m of text.matchAll(re)) {
    for (const raw of m[1].split(',')) {
      const t = raw.trim().replace(/^type\s+/, '');
      const mm = t.match(/^([A-Za-z_$][\w$]*)(?:\s+as\s+([A-Za-z_$][\w$]*))?$/);
      if (mm) out.add(mm[2] || mm[1]);
    }
  }
  const reBare = /^export\s+(?:async\s+)?(?:function|class|const|let|var|interface|type|enum)\s+([A-Za-z_$][\w$]*)/gm;
  for (const m of text.matchAll(reBare)) out.add(m[1]);
  const reStar = /export\s*\*\s*(?:as\s+[A-Za-z_$][\w$]*\s+)?from\s*['"]([^'"]+)['"]/g;
  for (const m of text.matchAll(reStar)) {
    const ref = m[1];
    if (!ref.startsWith('.')) continue;
    const refPath = resolve(dirname(file), ref.replace(/\.js$/, '.ts'));
    try {
      const subNames = await extractExportedNames(refPath);
      for (const n of subNames) out.add(n);
    } catch { /* ignore */ }
  }
  return [...out];
}

const PACKAGES = [
  ['../../packages/abac/dist/index.js',          'packages/abac/src/index.ts'],
  ['../../packages/compliance/dist/index.js',    'packages/compliance/src/index.ts'],
  ['../../packages/connectors/dist/index.js',    'packages/connectors/src/index.ts'],
  ['../../packages/constitutional/dist/index.js','packages/constitutional/src/index.ts'],
  ['../../packages/extractors/dist/index.js',    'packages/extractors/src/index.ts'],
  ['../../packages/ops/dist/index.js',           'packages/ops/src/index.ts'],
  ['../../packages/p2p/dist/index.js',           'packages/p2p/src/index.ts'],
  ['../../packages/passport/dist/index.js',      'packages/passport/src/index.ts'],
  ['../../packages/pgsl/dist/index.js',          'packages/pgsl/src/index.ts'],
  ['../../packages/privacy/dist/index.js',       'packages/privacy/src/index.ts'],
  ['../../packages/registry/dist/index.js',      'packages/registry/src/index.ts'],
  ['../../packages/security-txt/dist/index.js',  'packages/security-txt/src/index.ts'],
  ['../../packages/skills/dist/index.js',        'packages/skills/src/index.ts'],
  ['../../packages/solid/dist/index.js',         'packages/solid/src/index.ts'],
  ['../../packages/solid/dist/naming.js',        'packages/solid/src/naming.ts'],
  ['../../packages/transactions/dist/index.js',  'packages/transactions/src/index.ts'],
];

const MAP = {};
for (const [pkg, src] of PACKAGES) {
  for (const name of await extractExportedNames(src)) {
    if (!MAP[name]) MAP[name] = { pkg };
  }
}

// Apply the alias overrides that the compat shim used.
const ALIASES = {
  evaluateAbac:               { pkg: '../../packages/abac/dist/index.js', realName: 'evaluate' },
  evaluateAbacPolicy:         { pkg: '../../packages/abac/dist/index.js', realName: 'evaluateSingle' },
  validateAbacShape:          { pkg: '../../packages/abac/dist/index.js', realName: 'validateAgainstShape' },
  AbacPolicyContext:          { pkg: '../../packages/abac/dist/index.js', realName: 'PolicyContext' },
  AbacPolicyDecision:         { pkg: '../../packages/abac/dist/index.js', realName: 'PolicyDecision' },
  SkillDescriptorBundle:      { pkg: '../../packages/skills/dist/index.js', realName: 'DescriptorBundle' },
  computeSolidCid:            { pkg: '../../packages/solid/dist/index.js', realName: 'computeCid' },
  SDKPublishOptions:          { pkg: '../../packages/solid/dist/index.js', realName: 'PublishOptions' },
  SDKPublishResult:           { pkg: '../../packages/solid/dist/index.js', realName: 'PublishResult' },
  NameResolveOptions:         { pkg: '../../packages/solid/dist/naming.js', realName: 'ResolveOptions' },
  sparqlMatchPattern:         { pkg: '../../packages/pgsl/dist/index.js', realName: 'matchPattern' },
  pgslResolve:                { pkg: '../../packages/pgsl/dist/index.js', realName: 'resolve' },
  computeDecisionAffordances: { pkg: '../../packages/pgsl/dist/index.js', realName: 'computeAffordances' },
  decideFromObservations:     { pkg: '../../packages/pgsl/dist/index.js', realName: 'decide' },
  DecisionAffordance:         { pkg: '../../packages/pgsl/dist/index.js', realName: 'Affordance' },
  PGSLNode:                   { pkg: '../../packages/pgsl/dist/index.js', realName: 'Node' },
  PgslDeonticMode:            { pkg: '../../packages/pgsl/dist/index.js', realName: 'DeonticMode' },
  PgslPolicyContext:          { pkg: '../../packages/pgsl/dist/index.js', realName: 'PolicyContext' },
  PgslPolicyDecision:         { pkg: '../../packages/pgsl/dist/index.js', realName: 'PolicyDecision' },
  evaluate:                   { pkg: '../../packages/pgsl/dist/index.js', realName: 'evaluatePolicy' },
  PolicyContext:              { pkg: '../../packages/pgsl/dist/index.js' },
  PolicyDecision:             { pkg: '../../packages/pgsl/dist/index.js' },
};
for (const [aliasName, target] of Object.entries(ALIASES)) MAP[aliasName] = target;

const SUBSTRATE_OWNED = new Set([
  'computeAffordances', 'decide', 'observe', 'orient', 'oodaAct',
  'evaluateSurprise', 'createStigmergicField', 'updateStigmergicField',
  'createOODACycle', 'createAgentState', 'addDesire', 'commitToAffordance',
  'assimilateDescriptor',
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
  'ManifestEntry',
  'FetchFn', 'FetchResponse', 'WebSocketLike', 'WebSocketConstructor',
  'TransientRetryOptions',
  'followAffordance', 'DescriptorNotFoundError', 'AffordanceNotFoundError',
  'FollowAffordanceOptions', 'FollowAffordanceResult', 'ResolvedAffordance', 'AffordanceMethod',
  'signDescriptor', 'verifyDescriptorSignature', 'SignedDescriptor',
  'computeCid',
  'withTransientRetry', 'isTransientNetworkError',
  'getDefaultFetch', 'getDefaultWebSocket',
]);
for (const name of SUBSTRATE_OWNED) delete MAP[name];

// Find all .mjs files under examples/emergent/.
const dir = 'examples/emergent';
const files = (await readdir(dir)).filter(f => f.endsWith('.mjs')).map(f => join(dir, f));

const IMPORT_RE = /(?<kind>import|export)(?<typeKw>\s+type)?\s*\{(?<body>[^{}]*?)\}\s*from\s*['"](?:\.\.\/)+packages\/core\/dist\/index\.js['"]\s*;?/g;

let totalFiles = 0, changedFiles = 0, totalStmts = 0;

for (const file of files) {
  const text = await readFile(file, 'utf8');
  totalFiles++;
  let mutated = false;
  const newText = text.replace(IMPORT_RE, (whole, ...rest) => {
    totalStmts++;
    const g = rest[rest.length - 1];
    const kind = g.kind;
    const wholeIsType = !!g.typeKw;
    const body = g.body
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/\/\/[^\n]*/g, '');
    const entries = [];
    for (const raw of body.split(',')) {
      const tok = raw.trim();
      if (!tok) continue;
      const m = tok.match(/^(type\s+)?([A-Za-z_$][\w$]*)\s*(?:as\s+([A-Za-z_$][\w$]*))?$/);
      if (!m) { console.warn(`[${file}] unparseable: ${tok}`); return whole; }
      entries.push({ isType: wholeIsType || !!m[1], name: m[2], alias: m[3] || null });
    }
    const buckets = new Map();
    const coreBucket = [];
    for (const e of entries) {
      const m = MAP[e.name];
      if (!m) { coreBucket.push(e); continue; }
      const importedName = m.realName || e.name;
      const localName = e.alias || e.name;
      const entry = { isType: e.isType, importedName, localName };
      const arr = buckets.get(m.pkg) || [];
      arr.push(entry);
      buckets.set(m.pkg, arr);
    }
    if (buckets.size === 0) return whole;
    const out = [];
    if (coreBucket.length > 0) {
      out.push(emitStmt(kind, '../../packages/core/dist/index.js', coreBucket.map(e => ({
        isType: e.isType, importedName: e.name, localName: e.alias || e.name,
      })), wholeIsType));
    }
    for (const pkg of [...buckets.keys()].sort()) {
      out.push(emitStmt(kind, pkg, buckets.get(pkg), wholeIsType));
    }
    mutated = true;
    return out.join('\n');
  });
  if (mutated) {
    changedFiles++;
    await writeFile(file, newText, 'utf8');
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
console.log(`Import statements rewritten: ${totalStmts}`);
