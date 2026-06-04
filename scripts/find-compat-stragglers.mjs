#!/usr/bin/env node
/**
 * Find any file still importing a compat-only symbol from @interego/core.
 * Prints file → straggler-symbol pairs so they can be hand-checked.
 *
 * Drives off the same symbol→package map as migrate-compat-imports.mjs.
 */

import { readdir, readFile, stat } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { execSync } from 'node:child_process';

const COMPAT_SYMBOLS = new Set([
  // Extractors
  'extract', 'detectFormat', 'ExtractionResult', 'TextChunk', 'SourceFormat',
  // Connectors
  'createConnector', 'createNotionConnector', 'createSlackConnector', 'createWebConnector',
  'ConnectorType', 'ConnectorConfig', 'ConnectorEvent', 'Connector', 'SyncState',
  // Registry
  'createRegistry', 'registerAgent', 'refreshReputation', 'queryEntries', 'federateLookup',
  'aggregateReputation', 'registryToDescriptor', 'DEFAULT_AGGREGATION_POLICY',
  'Registry', 'RegistryConfig', 'RegistryEntry', 'ReputationSnapshot', 'AttestationInput', 'AggregationPolicy',
  // Constitutional
  'proposeAmendment', 'vote', 'tryRatify', 'communityModal', 'forkConstitution', 'DEFAULT_RULES',
  'ConstitutionalPolicy', 'RatificationRule', 'Amendment', 'AmendmentDiff', 'Vote', 'ConstitutionalFork', 'Tier',
  // Compliance
  'checkComplianceInputs', 'generateFrameworkReport', 'walkLineage', 'FRAMEWORK_CONTROLS',
  'loadOrCreateComplianceWallet', 'rotateComplianceWallet', 'importComplianceWallet',
  'listValidSignerAddresses', 'listValidSignerAddressesAt',
  'ComplianceFramework', 'ComplianceCheckResult', 'FrameworkReport', 'FrameworkReportEntry',
  'AuditableDescriptor', 'LineageNode', 'PersistedComplianceWallet', 'ComplianceWalletEntry', 'ComplianceWalletStore',
  // Privacy
  'screenForSensitiveContent', 'formatSensitivityWarning', 'shouldBlockOnSensitivity',
  'SensitivityFlag', 'SensitivityKind',
  // security.txt
  'buildSecurityTxt', 'buildSecurityTxtFromEnv', 'SecurityTxtOptions',
  // P2P
  'KIND_DESCRIPTOR', 'KIND_DIRECTORY', 'KIND_ATTESTATION', 'KIND_ENCRYPTED_SHARE',
  'P2pClient', 'InMemoryRelay', 'FileBackedRelay', 'WebSocketRelayMirror',
  'verifyEvent', 'detectSignatureScheme', 'isInteregoEvent',
  'P2pEvent', 'P2pFilter', 'P2pRelay', 'P2pSubscription', 'DescriptorAnnouncement',
  'DirectoryEntry', 'EncryptedShare', 'SignatureScheme', 'PublishDescriptorInput',
  'PublishDirectoryInput', 'PublishEncryptedShareInput', 'RelayConnectionStatus',
  'MirrorOptions', 'FileBackedRelayOptions',
  // Ops
  'buildDeployEvent', 'buildAccessChangeEvent', 'buildWalletRotationEvent',
  'buildIncidentEvent', 'buildQuarterlyReviewEvent',
  'OpsEventPayload', 'DeployEventInput', 'AccessChangeInput', 'AccessAction',
  'WalletRotationInput', 'IncidentInput', 'IncidentSeverity', 'QuarterlyReviewInput', 'ReviewKind',
  // Transactions
  'createTransaction', 'executeTransaction', 'transactionStatus',
  'Transaction', 'TransactionStep', 'TxnResult', 'TxnState', 'StepState', 'IsolationLevel',
  // Passport
  'createPassport', 'recordLifeEvent', 'stateValue', 'registerOn', 'migrateInfrastructure',
  'demonstratedCapabilities', 'activeValues', 'detectValueDrift',
  'passportToDescriptor', 'passportSummary', 'loadAgentKeypair',
  'Passport', 'LifeEvent', 'LifeEventKind', 'StatedValue', 'AgentKeypair', 'AgentWallet', 'LoadAgentKeypairOptions',
  // ABAC
  'evaluateAbac', 'evaluateAbacPolicy', 'validateAbacShape', 'resolveAttributes',
  'extractAttribute', 'filterAttributeGraph', 'createDecisionCache', 'defaultValidUntil',
  'AttributeGraph', 'AbacPolicyContext', 'AbacPolicyDecision', 'PolicyPredicateShape',
  'PredicateConstraint', 'AbacVerdict', 'DecisionCacheEntry', 'PolicyRegistry', 'DecisionCache',
  // Skills
  'parseSkillMd', 'emitSkillMd', 'skillBundleToDescriptor', 'descriptorGraphToSkillBundle',
  'descriptorGraphToSkillMd',
  'SkillFrontmatter', 'SkillDocument', 'SkillParseResult', 'SkillValidationError',
  'SkillBundle', 'SkillToDescriptorOptions', 'SkillDescriptorBundle',
  // Solid (selected — there are many more; this list catches the common ones)
  'publish', 'discover', 'subscribe', 'parseManifest',
  'writeAgentRegistry', 'readAgentRegistry', 'writeDelegationCredential', 'verifyAgentDelegation',
  'AGENT_REGISTRY_PATH', 'CREDENTIALS_PATH',
  'podDirectoryToTurtle', 'parsePodDirectory', 'fetchPodDirectory', 'publishPodDirectory', 'POD_DIRECTORY_PATH',
  'resolveWebFinger', 'didWebToUrl', 'resolveDidWeb', 'resolveDid',
  'extractPublicKey', 'findStorageEndpoint',
  'computeSolidCid', 'pinToIPFS', 'computeDescriptorAnchor',
  'writeAnchor', 'writeAnchors', 'readAnchors',
  'fetchGraphContent', 'parseDistributionFromDescriptorTurtle',
  'resolveHandleToPodUrl', 'resolveRecipient', 'resolveRecipients',
  'resolveShape', 'listPodShapes', 'parseShapeIndex', 'shapeIndexTurtle',
  'POD_SHAPES_PATH', 'POD_SHAPES_INDEX_PATH',
  'resolveIdentifier', 'fetchWellKnownAgents', 'parseAgentsCatalog', 'agentsCatalogTurtle',
  'WELL_KNOWN_AGENTS_PATH', 'socialWalk', 'predictDescriptorUrl', 'ContextGraphsSDK',
  'PublishResult', 'PublishOptions', 'DiscoverFilter', 'DiscoverOptions',
  'ContextChangeEvent', 'ContextChangeCallback', 'Subscription', 'SubscribeOptions',
  'ContextGraphsManifest', 'RegistryOptions', 'WebFingerResult', 'WebFingerLink',
  'DidDocument', 'VerificationMethod', 'ServiceEndpoint', 'DidResolutionResult',
  'IpfsAnchorReceipt', 'SignatureAnchorReceipt', 'EncryptionAnchorReceipt',
  'PgslAnchorReceipt', 'ActivityAnchorReceipt', 'AnchorReceipt',
  'ShareHandle', 'ResolvedRecipientPod', 'ResolveRecipientsOptions', 'DistributionLink',
  'ResolvedShape', 'ShapeIndexEntry', 'DiscoveryResult', 'DiscoveryTier',
  'AgentCatalogEntry', 'SocialWalkResult', 'PodNode', 'PodEdge', 'SocialWalkOptions',
  'ContextGraphsConfig', 'SDKPublishOptions', 'SearchOptions', 'SearchResult', 'SDKPublishResult',
  // Naming
  'buildNameAttestation', 'attestName', 'resolveName', 'namesFor',
  'defaultNameTrustPolicy', 'directoryNameIndex',
  'NamingConfig', 'AttestNameArgs', 'AttestNameResult', 'NameCandidate',
  'NameResolveOptions', 'NameTrustPolicy', 'NameHint',
  // PGSL
  'mintAtom', 'createPGSL', 'pullbackSquare', 'ingest', 'embedInPGSL',
  'latticeStats', 'latticeMeet', 'liftToDescriptor', 'computeCognitiveStrategy',
  'extractEntities', 'shouldAbstain', 'virtualizedLayer', 'pgslToTurtle',
  'sparqlMatchPattern', 'pgslResolve', 'computeDecisionAffordances', 'decideFromObservations',
  'DecisionAffordance', 'PGSLNode', 'PgslDeonticMode', 'PgslPolicyContext', 'PgslPolicyDecision',
]);

// Discover all live consumers (not worktrees/node_modules/dist).
const files = execSync('git ls-files', { cwd: process.cwd(), encoding: 'utf8' })
  .split(/\r?\n/)
  .filter(f => /\.(ts|tsx|mjs|js)$/.test(f) && !/^\.claude\//.test(f) && !/\bdist\//.test(f));

const IMPORT_RE = /(?:import|export)(?:\s+type)?\s*\{([^{}]*?)\}\s*from\s*['"]@interego\/core['"]/g;

let stragglers = 0;
for (const f of files) {
  let txt;
  try { txt = await readFile(f, 'utf8'); }
  catch { continue; }
  for (const m of txt.matchAll(IMPORT_RE)) {
    const body = m[1].replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
    for (const raw of body.split(',')) {
      const tok = raw.trim();
      const nm = tok.match(/^(?:type\s+)?([A-Za-z_$][\w$]*)/);
      if (!nm) continue;
      if (COMPAT_SYMBOLS.has(nm[1])) {
        console.log(`${f}\t${nm[1]}`);
        stragglers++;
      }
    }
  }
}

console.error(`Stragglers: ${stragglers}`);
process.exit(stragglers > 0 ? 1 : 0);
