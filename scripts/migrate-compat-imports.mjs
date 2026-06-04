#!/usr/bin/env node
/**
 * Mechanical migration: rewrite every `import { ... } from '@interego/core'`
 * statement so each symbol resolves to the package that actually owns it
 * (substrate stays in @interego/core, everything else moves to the right
 * @interego/<vertical> package).
 *
 * Drives off a single symbol→package table derived from packages/core/src/compat.ts
 * + each leaf's index.ts. Run once across the live (non-worktree) consumers
 * and then delete the compat shim.
 */

import { readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';

// ───────────────────────────────────────────────────────────
// Symbol → owner package map.
//
// "core" means stays in @interego/core. Anything else is a per-vertical
// package. Aliases on the LEFT are the historical names callers used
// (what they wrote in `from '@interego/core'`); the RIGHT side is the
// real name as exported from the leaf — encoded as { name, pkg, realName? }.
// ───────────────────────────────────────────────────────────

const MAP = {
  // ── Extractors ─────────────────────────────────────────────
  extract: { pkg: '@interego/extractors' },
  detectFormat: { pkg: '@interego/extractors' },
  ExtractionResult: { pkg: '@interego/extractors' },
  TextChunk: { pkg: '@interego/extractors' },
  SourceFormat: { pkg: '@interego/extractors' },

  // ── Connectors ─────────────────────────────────────────────
  createConnector: { pkg: '@interego/connectors' },
  createNotionConnector: { pkg: '@interego/connectors' },
  createSlackConnector: { pkg: '@interego/connectors' },
  createWebConnector: { pkg: '@interego/connectors' },
  ConnectorType: { pkg: '@interego/connectors' },
  ConnectorConfig: { pkg: '@interego/connectors' },
  ConnectorEvent: { pkg: '@interego/connectors' },
  Connector: { pkg: '@interego/connectors' },
  SyncState: { pkg: '@interego/connectors' },

  // ── Registry ───────────────────────────────────────────────
  createRegistry: { pkg: '@interego/registry' },
  registerAgent: { pkg: '@interego/registry' },
  refreshReputation: { pkg: '@interego/registry' },
  queryEntries: { pkg: '@interego/registry' },
  federateLookup: { pkg: '@interego/registry' },
  aggregateReputation: { pkg: '@interego/registry' },
  registryToDescriptor: { pkg: '@interego/registry' },
  DEFAULT_AGGREGATION_POLICY: { pkg: '@interego/registry' },
  Registry: { pkg: '@interego/registry' },
  RegistryConfig: { pkg: '@interego/registry' },
  RegistryEntry: { pkg: '@interego/registry' },
  ReputationSnapshot: { pkg: '@interego/registry' },
  AttestationInput: { pkg: '@interego/registry' },
  AggregationPolicy: { pkg: '@interego/registry' },

  // ── Constitutional ─────────────────────────────────────────
  proposeAmendment: { pkg: '@interego/constitutional' },
  vote: { pkg: '@interego/constitutional' },
  tryRatify: { pkg: '@interego/constitutional' },
  communityModal: { pkg: '@interego/constitutional' },
  forkConstitution: { pkg: '@interego/constitutional' },
  DEFAULT_RULES: { pkg: '@interego/constitutional' },
  ConstitutionalPolicy: { pkg: '@interego/constitutional' },
  RatificationRule: { pkg: '@interego/constitutional' },
  Amendment: { pkg: '@interego/constitutional' },
  AmendmentDiff: { pkg: '@interego/constitutional' },
  Vote: { pkg: '@interego/constitutional' },
  ConstitutionalFork: { pkg: '@interego/constitutional' },
  Tier: { pkg: '@interego/constitutional' },

  // ── Compliance ─────────────────────────────────────────────
  checkComplianceInputs: { pkg: '@interego/compliance' },
  generateFrameworkReport: { pkg: '@interego/compliance' },
  walkLineage: { pkg: '@interego/compliance' },
  FRAMEWORK_CONTROLS: { pkg: '@interego/compliance' },
  loadOrCreateComplianceWallet: { pkg: '@interego/compliance' },
  rotateComplianceWallet: { pkg: '@interego/compliance' },
  importComplianceWallet: { pkg: '@interego/compliance' },
  listValidSignerAddresses: { pkg: '@interego/compliance' },
  listValidSignerAddressesAt: { pkg: '@interego/compliance' },
  ComplianceFramework: { pkg: '@interego/compliance' },
  ComplianceCheckResult: { pkg: '@interego/compliance' },
  FrameworkReport: { pkg: '@interego/compliance' },
  FrameworkReportEntry: { pkg: '@interego/compliance' },
  AuditableDescriptor: { pkg: '@interego/compliance' },
  LineageNode: { pkg: '@interego/compliance' },
  PersistedComplianceWallet: { pkg: '@interego/compliance' },
  ComplianceWalletEntry: { pkg: '@interego/compliance' },
  ComplianceWalletStore: { pkg: '@interego/compliance' },

  // ── Privacy ────────────────────────────────────────────────
  screenForSensitiveContent: { pkg: '@interego/privacy' },
  formatSensitivityWarning: { pkg: '@interego/privacy' },
  shouldBlockOnSensitivity: { pkg: '@interego/privacy' },
  SensitivityFlag: { pkg: '@interego/privacy' },
  SensitivityKind: { pkg: '@interego/privacy' },

  // ── security.txt ───────────────────────────────────────────
  buildSecurityTxt: { pkg: '@interego/security-txt' },
  buildSecurityTxtFromEnv: { pkg: '@interego/security-txt' },
  SecurityTxtOptions: { pkg: '@interego/security-txt' },

  // ── P2P ────────────────────────────────────────────────────
  KIND_DESCRIPTOR: { pkg: '@interego/p2p' },
  KIND_DIRECTORY: { pkg: '@interego/p2p' },
  KIND_ATTESTATION: { pkg: '@interego/p2p' },
  KIND_ENCRYPTED_SHARE: { pkg: '@interego/p2p' },
  P2pClient: { pkg: '@interego/p2p' },
  InMemoryRelay: { pkg: '@interego/p2p' },
  FileBackedRelay: { pkg: '@interego/p2p' },
  WebSocketRelayMirror: { pkg: '@interego/p2p' },
  verifyEvent: { pkg: '@interego/p2p' },
  detectSignatureScheme: { pkg: '@interego/p2p' },
  isInteregoEvent: { pkg: '@interego/p2p' },
  P2pEvent: { pkg: '@interego/p2p' },
  P2pFilter: { pkg: '@interego/p2p' },
  P2pRelay: { pkg: '@interego/p2p' },
  P2pSubscription: { pkg: '@interego/p2p' },
  DescriptorAnnouncement: { pkg: '@interego/p2p' },
  DirectoryEntry: { pkg: '@interego/p2p' },
  EncryptedShare: { pkg: '@interego/p2p' },
  SignatureScheme: { pkg: '@interego/p2p' },
  PublishDescriptorInput: { pkg: '@interego/p2p' },
  PublishDirectoryInput: { pkg: '@interego/p2p' },
  PublishEncryptedShareInput: { pkg: '@interego/p2p' },
  RelayConnectionStatus: { pkg: '@interego/p2p' },
  MirrorOptions: { pkg: '@interego/p2p' },
  FileBackedRelayOptions: { pkg: '@interego/p2p' },

  // ── Ops ────────────────────────────────────────────────────
  buildDeployEvent: { pkg: '@interego/ops' },
  buildAccessChangeEvent: { pkg: '@interego/ops' },
  buildWalletRotationEvent: { pkg: '@interego/ops' },
  buildIncidentEvent: { pkg: '@interego/ops' },
  buildQuarterlyReviewEvent: { pkg: '@interego/ops' },
  OpsEventPayload: { pkg: '@interego/ops' },
  DeployEventInput: { pkg: '@interego/ops' },
  AccessChangeInput: { pkg: '@interego/ops' },
  AccessAction: { pkg: '@interego/ops' },
  WalletRotationInput: { pkg: '@interego/ops' },
  IncidentInput: { pkg: '@interego/ops' },
  IncidentSeverity: { pkg: '@interego/ops' },
  QuarterlyReviewInput: { pkg: '@interego/ops' },
  ReviewKind: { pkg: '@interego/ops' },

  // ── Transactions ───────────────────────────────────────────
  createTransaction: { pkg: '@interego/transactions' },
  executeTransaction: { pkg: '@interego/transactions' },
  transactionStatus: { pkg: '@interego/transactions' },
  Transaction: { pkg: '@interego/transactions' },
  TransactionStep: { pkg: '@interego/transactions' },
  TxnResult: { pkg: '@interego/transactions' },
  TxnState: { pkg: '@interego/transactions' },
  StepState: { pkg: '@interego/transactions' },
  IsolationLevel: { pkg: '@interego/transactions' },

  // ── Passport ───────────────────────────────────────────────
  createPassport: { pkg: '@interego/passport' },
  recordLifeEvent: { pkg: '@interego/passport' },
  stateValue: { pkg: '@interego/passport' },
  registerOn: { pkg: '@interego/passport' },
  migrateInfrastructure: { pkg: '@interego/passport' },
  demonstratedCapabilities: { pkg: '@interego/passport' },
  activeValues: { pkg: '@interego/passport' },
  detectValueDrift: { pkg: '@interego/passport' },
  passportToDescriptor: { pkg: '@interego/passport' },
  passportSummary: { pkg: '@interego/passport' },
  loadAgentKeypair: { pkg: '@interego/passport' },
  Passport: { pkg: '@interego/passport' },
  LifeEvent: { pkg: '@interego/passport' },
  LifeEventKind: { pkg: '@interego/passport' },
  StatedValue: { pkg: '@interego/passport' },
  AgentKeypair: { pkg: '@interego/passport' },
  AgentWallet: { pkg: '@interego/passport' },
  LoadAgentKeypairOptions: { pkg: '@interego/passport' },

  // ── ABAC ───────────────────────────────────────────────────
  // The compat shim exposes ABAC under prefixed names to avoid PGSL
  // collisions. Restore the real names.
  evaluateAbac: { pkg: '@interego/abac', realName: 'evaluate' },
  evaluateAbacPolicy: { pkg: '@interego/abac', realName: 'evaluateSingle' },
  validateAbacShape: { pkg: '@interego/abac', realName: 'validateAgainstShape' },
  resolveAttributes: { pkg: '@interego/abac' },
  extractAttribute: { pkg: '@interego/abac' },
  filterAttributeGraph: { pkg: '@interego/abac' },
  createDecisionCache: { pkg: '@interego/abac' },
  defaultValidUntil: { pkg: '@interego/abac' },
  AttributeGraph: { pkg: '@interego/abac' },
  AbacPolicyContext: { pkg: '@interego/abac', realName: 'PolicyContext' },
  AbacPolicyDecision: { pkg: '@interego/abac', realName: 'PolicyDecision' },
  PolicyPredicateShape: { pkg: '@interego/abac' },
  PredicateConstraint: { pkg: '@interego/abac' },
  AbacVerdict: { pkg: '@interego/abac' },
  DecisionCacheEntry: { pkg: '@interego/abac' },
  PolicyRegistry: { pkg: '@interego/abac' },
  DecisionCache: { pkg: '@interego/abac' },

  // ── Skills ─────────────────────────────────────────────────
  parseSkillMd: { pkg: '@interego/skills' },
  emitSkillMd: { pkg: '@interego/skills' },
  skillBundleToDescriptor: { pkg: '@interego/skills' },
  descriptorGraphToSkillBundle: { pkg: '@interego/skills' },
  descriptorGraphToSkillMd: { pkg: '@interego/skills' },
  SkillFrontmatter: { pkg: '@interego/skills' },
  SkillDocument: { pkg: '@interego/skills' },
  SkillParseResult: { pkg: '@interego/skills' },
  SkillValidationError: { pkg: '@interego/skills' },
  SkillBundle: { pkg: '@interego/skills' },
  SkillToDescriptorOptions: { pkg: '@interego/skills' },
  SkillDescriptorBundle: { pkg: '@interego/skills', realName: 'DescriptorBundle' },

  // ── Solid ──────────────────────────────────────────────────
  publish: { pkg: '@interego/solid' },
  discover: { pkg: '@interego/solid' },
  subscribe: { pkg: '@interego/solid' },
  parseManifest: { pkg: '@interego/solid' },
  writeAgentRegistry: { pkg: '@interego/solid' },
  readAgentRegistry: { pkg: '@interego/solid' },
  writeDelegationCredential: { pkg: '@interego/solid' },
  verifyAgentDelegation: { pkg: '@interego/solid' },
  AGENT_REGISTRY_PATH: { pkg: '@interego/solid' },
  CREDENTIALS_PATH: { pkg: '@interego/solid' },
  podDirectoryToTurtle: { pkg: '@interego/solid' },
  parsePodDirectory: { pkg: '@interego/solid' },
  fetchPodDirectory: { pkg: '@interego/solid' },
  publishPodDirectory: { pkg: '@interego/solid' },
  POD_DIRECTORY_PATH: { pkg: '@interego/solid' },
  resolveWebFinger: { pkg: '@interego/solid' },
  didWebToUrl: { pkg: '@interego/solid' },
  resolveDidWeb: { pkg: '@interego/solid' },
  resolveDid: { pkg: '@interego/solid' },
  extractPublicKey: { pkg: '@interego/solid' },
  findStorageEndpoint: { pkg: '@interego/solid' },
  computeSolidCid: { pkg: '@interego/solid', realName: 'computeCid' },
  pinToIPFS: { pkg: '@interego/solid' },
  computeDescriptorAnchor: { pkg: '@interego/solid' },
  writeAnchor: { pkg: '@interego/solid' },
  writeAnchors: { pkg: '@interego/solid' },
  readAnchors: { pkg: '@interego/solid' },
  fetchGraphContent: { pkg: '@interego/solid' },
  parseDistributionFromDescriptorTurtle: { pkg: '@interego/solid' },
  resolveHandleToPodUrl: { pkg: '@interego/solid' },
  resolveRecipient: { pkg: '@interego/solid' },
  resolveRecipients: { pkg: '@interego/solid' },
  resolveShape: { pkg: '@interego/solid' },
  listPodShapes: { pkg: '@interego/solid' },
  parseShapeIndex: { pkg: '@interego/solid' },
  shapeIndexTurtle: { pkg: '@interego/solid' },
  POD_SHAPES_PATH: { pkg: '@interego/solid' },
  POD_SHAPES_INDEX_PATH: { pkg: '@interego/solid' },
  resolveIdentifier: { pkg: '@interego/solid' },
  fetchWellKnownAgents: { pkg: '@interego/solid' },
  parseAgentsCatalog: { pkg: '@interego/solid' },
  agentsCatalogTurtle: { pkg: '@interego/solid' },
  WELL_KNOWN_AGENTS_PATH: { pkg: '@interego/solid' },
  socialWalk: { pkg: '@interego/solid' },
  predictDescriptorUrl: { pkg: '@interego/solid' },
  ContextGraphsSDK: { pkg: '@interego/solid' },
  PublishResult: { pkg: '@interego/solid' },
  PublishOptions: { pkg: '@interego/solid' },
  DiscoverFilter: { pkg: '@interego/solid' },
  DiscoverOptions: { pkg: '@interego/solid' },
  ContextChangeEvent: { pkg: '@interego/solid' },
  ContextChangeCallback: { pkg: '@interego/solid' },
  Subscription: { pkg: '@interego/solid' },
  SubscribeOptions: { pkg: '@interego/solid' },
  ContextGraphsManifest: { pkg: '@interego/solid' },
  RegistryOptions: { pkg: '@interego/solid' },
  WebFingerResult: { pkg: '@interego/solid' },
  WebFingerLink: { pkg: '@interego/solid' },
  DidDocument: { pkg: '@interego/solid' },
  VerificationMethod: { pkg: '@interego/solid' },
  ServiceEndpoint: { pkg: '@interego/solid' },
  DidResolutionResult: { pkg: '@interego/solid' },
  IpfsAnchorReceipt: { pkg: '@interego/solid' },
  SignatureAnchorReceipt: { pkg: '@interego/solid' },
  EncryptionAnchorReceipt: { pkg: '@interego/solid' },
  PgslAnchorReceipt: { pkg: '@interego/solid' },
  ActivityAnchorReceipt: { pkg: '@interego/solid' },
  AnchorReceipt: { pkg: '@interego/solid' },
  ShareHandle: { pkg: '@interego/solid' },
  ResolvedRecipientPod: { pkg: '@interego/solid' },
  ResolveRecipientsOptions: { pkg: '@interego/solid' },
  DistributionLink: { pkg: '@interego/solid' },
  ResolvedShape: { pkg: '@interego/solid' },
  ShapeIndexEntry: { pkg: '@interego/solid' },
  DiscoveryResult: { pkg: '@interego/solid' },
  DiscoveryTier: { pkg: '@interego/solid' },
  AgentCatalogEntry: { pkg: '@interego/solid' },
  SocialWalkResult: { pkg: '@interego/solid' },
  PodNode: { pkg: '@interego/solid' },
  PodEdge: { pkg: '@interego/solid' },
  SocialWalkOptions: { pkg: '@interego/solid' },
  ContextGraphsConfig: { pkg: '@interego/solid' },
  SDKPublishOptions: { pkg: '@interego/solid', realName: 'PublishOptions' },
  SearchOptions: { pkg: '@interego/solid' },
  SearchResult: { pkg: '@interego/solid' },
  SDKPublishResult: { pkg: '@interego/solid', realName: 'PublishResult' },

  // ── Naming (lives in @interego/solid/naming) ──────────────
  buildNameAttestation: { pkg: '@interego/solid/naming' },
  attestName: { pkg: '@interego/solid/naming' },
  resolveName: { pkg: '@interego/solid/naming' },
  namesFor: { pkg: '@interego/solid/naming' },
  defaultNameTrustPolicy: { pkg: '@interego/solid/naming' },
  directoryNameIndex: { pkg: '@interego/solid/naming' },
  NamingConfig: { pkg: '@interego/solid/naming' },
  AttestNameArgs: { pkg: '@interego/solid/naming' },
  AttestNameResult: { pkg: '@interego/solid/naming' },
  NameCandidate: { pkg: '@interego/solid/naming' },
  NameResolveOptions: { pkg: '@interego/solid/naming', realName: 'ResolveOptions' },
  NameTrustPolicy: { pkg: '@interego/solid/naming' },
  NameHint: { pkg: '@interego/solid/naming' },

  // ── PGSL ───────────────────────────────────────────────────
  // (Compat does `export * from '@interego/pgsl'` plus a handful of aliases.)
  mintAtom: { pkg: '@interego/pgsl' },
  createPGSL: { pkg: '@interego/pgsl' },
  pullbackSquare: { pkg: '@interego/pgsl' },
  ingest: { pkg: '@interego/pgsl' },
  embedInPGSL: { pkg: '@interego/pgsl' },
  latticeStats: { pkg: '@interego/pgsl' },
  latticeMeet: { pkg: '@interego/pgsl' },
  liftToDescriptor: { pkg: '@interego/pgsl' },
  computeCognitiveStrategy: { pkg: '@interego/pgsl' },
  extractEntities: { pkg: '@interego/pgsl' },
  shouldAbstain: { pkg: '@interego/pgsl' },
  virtualizedLayer: { pkg: '@interego/pgsl' },
  pgslToTurtle: { pkg: '@interego/pgsl' },
  // Aliased PGSL exports from the compat shim:
  sparqlMatchPattern: { pkg: '@interego/pgsl', realName: 'matchPattern' },
  pgslResolve: { pkg: '@interego/pgsl', realName: 'resolve' },
  computeDecisionAffordances: { pkg: '@interego/pgsl', realName: 'computeAffordances' },
  decideFromObservations: { pkg: '@interego/pgsl', realName: 'decide' },
  DecisionAffordance: { pkg: '@interego/pgsl', realName: 'Affordance' },
  PGSLNode: { pkg: '@interego/pgsl', realName: 'Node' },
  PgslDeonticMode: { pkg: '@interego/pgsl', realName: 'DeonticMode' },
  PgslPolicyContext: { pkg: '@interego/pgsl', realName: 'PolicyContext' },
  PgslPolicyDecision: { pkg: '@interego/pgsl', realName: 'PolicyDecision' },
};

// ───────────────────────────────────────────────────────────
// Live list of files to migrate.
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

// ───────────────────────────────────────────────────────────
// Per-file rewriter.
//
// We rewrite any `import [type] { ... } from '@interego/core'` (and the
// same with `import type { ... }`) where the brace-list is multiline OK.
// We do NOT touch namespace imports (`import * as ... from`) or bare
// `import '...';` side-effect imports.
// ───────────────────────────────────────────────────────────

// Match (export|import) [type ]{ ... } from '@interego/core'
// Body must not contain a brace or semicolon or `from` keyword on its own —
// we tempered the inner pattern so we only match a single brace pair.
const IMPORT_RE = /(?<kind>import|export)(?<typeKw>\s+type)?\s*\{(?<body>[^{}]*?)\}\s*from\s*['"]@interego\/core['"]\s*;?/g;

let totalFiles = 0;
let changedFiles = 0;
let totalImportStatements = 0;
let unmappedSymbols = new Map(); // name → set of files

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
    const kind = groups.kind; // import | export
    const wholeIsType = !!groups.typeKw;
    const body = groups.body;

    // Parse the symbol list. Each entry: optional `type` prefix, name,
    // optional `as Alias`. Strip `//` line comments and `/* */` block
    // comments inside the brace list first.
    const cleanBody = body
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/\/\/[^\n]*/g, '');
    const entries = [];
    for (const raw of cleanBody.split(',')) {
      const tok = raw.trim();
      if (!tok) continue;
      const m = tok.match(/^(type\s+)?([A-Za-z_$][\w$]*)\s*(?:as\s+([A-Za-z_$][\w$]*))?$/);
      if (!m) {
        // unparseable — emit as-is and warn
        console.warn(`[${rel}] unparseable import entry: ${tok}`);
        return whole;
      }
      entries.push({
        isType: wholeIsType || !!m[1],
        name: m[2],
        alias: m[3] || null,
      });
    }

    // Group entries by target package.
    const buckets = new Map(); // pkg → [{ isType, importedName, localName }]
    const coreBucket = [];
    for (const e of entries) {
      const m = MAP[e.name];
      if (!m) {
        // Stays in @interego/core.
        coreBucket.push(e);
        continue;
      }
      const importedName = m.realName || e.name;
      const localName = e.alias || e.name;
      const entry = {
        isType: e.isType,
        importedName,
        localName,
      };
      const arr = buckets.get(m.pkg) || [];
      arr.push(entry);
      buckets.set(m.pkg, arr);
    }

    // Emit one statement per bucket. We split each bucket into a `type`
    // statement and a value statement only if mixing would otherwise
    // change semantics — but `import { type A, B }` is fine in TS, so
    // we keep a single statement per bucket with `type` prefixed entries.
    const out = [];

    // Keep coreBucket as one import.
    if (coreBucket.length > 0) {
      out.push(emitStmt(kind, '@interego/core', coreBucket.map(e => ({
        isType: e.isType,
        importedName: e.name,
        localName: e.alias || e.name,
      })), wholeIsType));
    }

    // Sort buckets by package name for stable output.
    const pkgNames = [...buckets.keys()].sort();
    for (const pkg of pkgNames) {
      out.push(emitStmt(kind, pkg, buckets.get(pkg), wholeIsType));
    }

    if (out.length === 0) {
      // No symbols at all? Drop the import.
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
  // entries: [{ isType, importedName, localName }]
  // Stable sort by importedName for determinism.
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
