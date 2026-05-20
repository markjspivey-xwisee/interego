/**
 * Tenant-pod publisher for the Foxxi vertical.
 *
 * Splits a tenant snapshot into discrete, independently-versionable
 * sections (catalog / directory / policies / connectors / events / audit)
 * and publishes each as a `cg:ContextDescriptor` + graph pair on the
 * tenant's Solid pod via the substrate's standard `publish()` machinery.
 *
 * Each descriptor declares `dct:conformsTo` pointing at the section's
 * foxxi type IRI (fxs:CourseCatalog, fxa:AuditLogStream, etc.) so the
 * bridge later discovers and fetches each section via `cg:discover()`
 * filtered on the manifest entry's `conformsTo` field — NO hardcoded
 * pod paths anywhere.
 *
 * The publisher does not validate the section payloads — they're
 * shovelled into the graph as `fxs:bundleJson` literals. Type shape is
 * enforced at the bridge-side parse (tenant-fetcher.ts). This keeps
 * the publisher orthogonal to ongoing schema evolution.
 */

import { publish } from '../../../src/index.js';
import type {
  ContextDescriptorData,
  IRI,
} from '../../../src/index.js';
import type { FetchFn, PublishResult } from '../../../src/solid/types.js';
import { generateKeyPair, deriveEncryptionKeyPair, type EncryptionKeyPair } from '../../../src/crypto/encryption.js';
import { attachDeterministicAddresses } from './auth.js';
import { createHash } from 'node:crypto';

// ── Foxxi namespace IRIs (declared in ns/foxxi-content-graph-v0.2.ttl) ──

const FXS = 'https://interego-foxxi-bridge.livelysky-8b81abb0.eastus.azurecontainerapps.io/ns/foxxi#';
const FXA = 'https://interego-foxxi-bridge.livelysky-8b81abb0.eastus.azurecontainerapps.io/ns/foxxi#';

export const TENANT_TYPES = {
  CourseCatalog: `${FXS}CourseCatalog` as IRI,
  TenantDirectory: `${FXS}TenantDirectory` as IRI,
  AssignmentPolicySet: `${FXS}AssignmentPolicySet` as IRI,
  ConnectorRegistry: `${FXS}ConnectorRegistry` as IRI,
  EnrollmentEventStream: `${FXA}EnrollmentEventStream` as IRI,
  AuditLogStream: `${FXA}AuditLogStream` as IRI,
  CoursePackageBundle: `${FXA}CoursePackageBundle` as IRI,
  AdminEncryptionKey: `${FXS}AdminEncryptionKey` as IRI,
  AbacPolicy: `${FXA}AbacPolicy` as IRI,
} as const;

/** Sections that hold PII or admin-internal data — encrypted to the admin recipient at publish time. */
export const ADMIN_ONLY_TYPES = new Set<string>([
  TENANT_TYPES.TenantDirectory,
  TENANT_TYPES.AssignmentPolicySet,
  TENANT_TYPES.ConnectorRegistry,
  TENANT_TYPES.EnrollmentEventStream,
  TENANT_TYPES.AuditLogStream,
]);

const BUNDLE_JSON_PRED = `${FXS}bundleJson` as IRI;

// ── Config + helpers ──────────────────────────────────────────

export interface TenantPublishConfig {
  /** The tenant's pod root URL (e.g. https://interego-css.../markj/). */
  podUrl: string;
  /** Authoritative source DID (e.g. did:web:acme-training.example) — recorded as prov:wasAttributedTo. */
  authoritativeSource: IRI;
  /** Authenticated fetch — must have write permission on the pod. */
  fetch: FetchFn;
  /** Container path under the pod (default: 'foxxi/'). */
  containerPath?: string;
  /** L&D admin WebID — the recipient of every admin-only encrypted section. */
  adminWebId: string;
  /** Wallet seed used for deterministic per-user signing keys (must match what the dashboard/CLI/MCP-client uses to mint). */
  walletSeed?: string;
  /** Seed for the deterministic admin X25519 keypair. Same seed → same keys; both bridge and CLI derive locally. */
  adminKeySeed: string;
}

/**
 * Derive the admin's X25519 encryption keypair deterministically from a
 * seed phrase. The publisher uses this to encrypt admin sections; the
 * bridge derives the same keypair from the same seed and decrypts on
 * fetch. The seed never leaves the operator/bridge; what hits the pod
 * is (a) the public key in a fxs:AdminEncryptionKey descriptor and
 * (b) the ciphertext envelopes.
 */
export function deriveAdminKeyPair(seed: string): EncryptionKeyPair {
  const priv = createHash('sha256').update(`foxxi-admin-x25519:${seed}`).digest();
  return deriveEncryptionKeyPair(priv.toString('hex'));
}

function buildSectionGraph(args: {
  graphIri: IRI;
  typeIri: IRI;
  authoritativeSource: IRI;
  payload: unknown;
}): string {
  // Payload is base64'd for round-trip robustness — Turtle string literals
  // have their own escape grammar (\u, \\, \n, etc.) that interacts badly
  // with JSON.stringify output. base64 sidesteps escape issues entirely.
  const json = JSON.stringify(args.payload);
  const b64 = Buffer.from(json, 'utf8').toString('base64');
  return `<${args.graphIri}> a <${args.typeIri}> ;
    <http://www.w3.org/ns/prov#wasAttributedTo> <${args.authoritativeSource}> ;
    <http://purl.org/dc/terms/identifier> "len:${json.length}" ;
    <${BUNDLE_JSON_PRED}> "${b64}"^^<http://www.w3.org/2001/XMLSchema#base64Binary> .
`;
}

function descriptorFor(args: {
  graphIri: IRI;
  typeIri: IRI;
  authoritativeSource: IRI;
}): ContextDescriptorData {
  const now = new Date().toISOString();
  return {
    id: `${args.graphIri}#descriptor` as IRI,
    describes: [args.graphIri],
    conformsTo: [args.typeIri],
    facets: [
      { type: 'Temporal', validFrom: now },
      { type: 'Provenance', wasAttributedTo: args.authoritativeSource },
      { type: 'Semiotic', modalStatus: 'Asserted' },
    ],
  };
}

function slugSourceDid(did: string): string {
  // did:web:acme-training.example → acme-training.example
  return did.replace(/^did:/, '').replace(/[^a-zA-Z0-9.-]/g, '-');
}

async function publishSection(args: {
  config: TenantPublishConfig;
  slug: string;
  graphIri: IRI;
  typeIri: IRI;
  payload: unknown;
}): Promise<PublishResult> {
  const graphContent = buildSectionGraph({
    graphIri: args.graphIri,
    typeIri: args.typeIri,
    authoritativeSource: args.config.authoritativeSource,
    payload: args.payload,
  });
  const descriptor = descriptorFor({
    graphIri: args.graphIri,
    typeIri: args.typeIri,
    authoritativeSource: args.config.authoritativeSource,
  });

  // Admin-only sections get end-to-end encrypted: the substrate's
  // publish() wraps the graph body in a nacl-box envelope keyed to the
  // admin's X25519 public key. Pod stores only ciphertext; the bridge
  // (or any other holder of the admin keypair) decrypts on fetch.
  // Descriptor metadata (Provenance / Temporal / conformsTo) stays
  // plaintext so discover() still finds it without decryption.
  const isAdminOnly = ADMIN_ONLY_TYPES.has(args.typeIri);
  const encryptOpts = isAdminOnly
    ? {
        encrypt: {
          recipients: [deriveAdminKeyPair(args.config.adminKeySeed).publicKey],
          senderKeyPair: deriveAdminKeyPair(args.config.adminKeySeed),
        },
      }
    : {};

  return publish(descriptor, graphContent, args.config.podUrl, {
    fetch: args.config.fetch,
    containerPath: args.config.containerPath ?? 'foxxi/',
    descriptorSlug: args.slug,
    graphSlug: `${args.slug}-graph`,
    ...encryptOpts,
  });
}

// ── Section-by-section publish API ────────────────────────────

export async function publishCourseCatalog(catalog: unknown, config: TenantPublishConfig): Promise<PublishResult> {
  return publishSection({
    config,
    slug: 'course-catalog',
    graphIri: `urn:foxxi:tenant:${slugSourceDid(config.authoritativeSource)}:course-catalog` as IRI,
    typeIri: TENANT_TYPES.CourseCatalog,
    payload: catalog,
  });
}

export async function publishTenantDirectory(directory: unknown, config: TenantPublishConfig): Promise<PublishResult> {
  // Inject wallet_address into each user so the bridge can verify
  // session-token signatures against a known address set. The directory
  // section is admin-encrypted, so the addresses are not publicly
  // visible — only the bridge (which holds the admin keypair) can read
  // them and build its address→webId map at fetch time.
  const dir = directory as { users?: ReadonlyArray<{ user_id: string }>; groups?: unknown };
  const enrichedDir = {
    ...dir,
    users: attachDeterministicAddresses(dir.users ?? [], config.walletSeed),
  };
  return publishSection({
    config,
    slug: 'tenant-directory',
    graphIri: `urn:foxxi:tenant:${slugSourceDid(config.authoritativeSource)}:directory` as IRI,
    typeIri: TENANT_TYPES.TenantDirectory,
    payload: enrichedDir,
  });
}

/**
 * Publish the admin's X25519 *public* key as a discoverable descriptor.
 * Any holder of the matching private key can decrypt admin-only sections;
 * publishing the public key lets agents verify "I am about to encrypt to
 * X — is this the admin the tenant declares?" Pure transparency artifact.
 */
export async function publishAdminEncryptionKey(config: TenantPublishConfig): Promise<PublishResult> {
  const kp = deriveAdminKeyPair(config.adminKeySeed);
  return publishSection({
    config,
    slug: 'admin-encryption-key',
    graphIri: `urn:foxxi:tenant:${slugSourceDid(config.authoritativeSource)}:admin-encryption-key` as IRI,
    typeIri: TENANT_TYPES.AdminEncryptionKey,
    payload: {
      admin_web_id: config.adminWebId,
      algorithm: 'X25519-XSalsa20-Poly1305',
      public_key_base64: kp.publicKey,
    },
  });
}

/**
 * Publish ABAC policy descriptors as substrate artifacts. The bridge
 * fetches them at startup and applies them when filtering responses;
 * regulators / auditors can fetch them to verify exactly what access
 * decisions are baked into the deployment.
 *
 * Policies are intentionally declarative + minimal: each one names a
 * role, the sections it can read, and the scoping rule. The bridge's
 * policy.ts module enforces the rule; this artifact is the
 * authoritative declaration.
 */
export async function publishAbacPolicy(args: {
  policyId: string;
  payload: {
    role: 'admin' | 'manager' | 'learner';
    sections: string[];
    scoping: string;
    description: string;
  };
}, config: TenantPublishConfig): Promise<PublishResult> {
  return publishSection({
    config,
    slug: `abac-policy-${args.policyId}`,
    graphIri: `urn:foxxi:tenant:${slugSourceDid(config.authoritativeSource)}:abac:${args.policyId}` as IRI,
    typeIri: TENANT_TYPES.AbacPolicy,
    payload: args.payload,
  });
}

export async function publishAssignmentPolicies(policies: unknown, config: TenantPublishConfig): Promise<PublishResult> {
  return publishSection({
    config,
    slug: 'assignment-policies',
    graphIri: `urn:foxxi:tenant:${slugSourceDid(config.authoritativeSource)}:policies` as IRI,
    typeIri: TENANT_TYPES.AssignmentPolicySet,
    payload: policies,
  });
}

export async function publishConnectorRegistry(connections: unknown, config: TenantPublishConfig): Promise<PublishResult> {
  return publishSection({
    config,
    slug: 'connector-registry',
    graphIri: `urn:foxxi:tenant:${slugSourceDid(config.authoritativeSource)}:connectors` as IRI,
    typeIri: TENANT_TYPES.ConnectorRegistry,
    payload: connections,
  });
}

export async function publishEnrollmentEventStream(events: unknown, config: TenantPublishConfig): Promise<PublishResult> {
  return publishSection({
    config,
    slug: 'enrollment-events',
    graphIri: `urn:foxxi:tenant:${slugSourceDid(config.authoritativeSource)}:enrollment-events` as IRI,
    typeIri: TENANT_TYPES.EnrollmentEventStream,
    payload: events,
  });
}

export async function publishAuditLog(audit: unknown, config: TenantPublishConfig): Promise<PublishResult> {
  return publishSection({
    config,
    slug: 'audit-log',
    graphIri: `urn:foxxi:tenant:${slugSourceDid(config.authoritativeSource)}:audit` as IRI,
    typeIri: TENANT_TYPES.AuditLogStream,
    payload: audit,
  });
}

// ── Course package publisher ──────────────────────────────────

export async function publishCoursePackage(
  args: { courseId: string; payload: unknown },
  config: TenantPublishConfig,
): Promise<PublishResult> {
  return publishSection({
    config,
    slug: `course-${args.courseId}`,
    graphIri: `urn:foxxi:tenant:${slugSourceDid(config.authoritativeSource)}:course:${args.courseId}` as IRI,
    typeIri: TENANT_TYPES.CoursePackageBundle,
    payload: args.payload,
  });
}

// ── Full-payload convenience ──────────────────────────────────

interface AdminSnapshot {
  catalog: unknown;
  users: unknown;
  groups: unknown;
  policies: unknown;
  connections: unknown;
  events: unknown;
  audit: unknown;
}

export interface PublishTenantSnapshotResult {
  adminKey: PublishResult;
  catalog: PublishResult;
  directory: PublishResult;
  policies: PublishResult;
  connectors: PublishResult;
  events: PublishResult;
  audit: PublishResult;
  abacPolicies: PublishResult[];
}

const DEFAULT_ABAC_POLICIES = [
  {
    policyId: 'admin-full-access',
    payload: {
      role: 'admin' as const,
      sections: ['catalog', 'directory', 'policies', 'connectors', 'events', 'audit', 'coverage', 'all-courses'],
      scoping: 'unrestricted',
      description: 'The L&D admin (admin_web_id in tenant config) reads every section without filtering.',
    },
  },
  {
    policyId: 'manager-direct-reports',
    payload: {
      role: 'manager' as const,
      sections: ['catalog', 'directory(self+reports)', 'events(self+reports)', 'audit(self+reports)', 'all-courses'],
      scoping: 'caller.manager_user_id back-reference defines visible user_ids',
      description: 'Managers see their own data + every direct report (transitive disabled).',
    },
  },
  {
    policyId: 'learner-self',
    payload: {
      role: 'learner' as const,
      sections: ['catalog', 'self-record', 'self-events', 'self-audit', 'all-courses'],
      scoping: 'caller.user_id = subject.user_id',
      description: 'Learners see their own user record + events + audit entries about themselves. Catalog + parsed course content public to authenticated callers.',
    },
  },
];

export async function publishTenantSnapshot(
  admin: AdminSnapshot,
  config: TenantPublishConfig,
): Promise<PublishTenantSnapshotResult> {
  // Sequential — same pod root; manifest CAS is per-entry but serial keeps
  // the churn deterministic and the log easy to follow.
  const adminKey = await publishAdminEncryptionKey(config);
  const catalog = await publishCourseCatalog(admin.catalog, config);
  const directory = await publishTenantDirectory({ users: admin.users, groups: admin.groups }, config);
  const policies = await publishAssignmentPolicies(admin.policies, config);
  const connectors = await publishConnectorRegistry(admin.connections, config);
  const events = await publishEnrollmentEventStream(admin.events, config);
  const audit = await publishAuditLog(admin.audit, config);
  const abacPolicies: PublishResult[] = [];
  for (const p of DEFAULT_ABAC_POLICIES) {
    abacPolicies.push(await publishAbacPolicy(p, config));
  }
  return { adminKey, catalog, directory, policies, connectors, events, audit, abacPolicies };
}
