/**
 * Tenant-pod publisher for the Foxxi vertical.
 *
 * Splits a tenant snapshot into discrete, independently-versionable
 * sections (catalog / directory / policies / connectors / events / audit)
 * and publishes each as a `iep:ContextDescriptor` + graph pair on the
 * tenant's Solid pod via the substrate's standard `publish()` machinery.
 *
 * Each descriptor declares `dct:conformsTo` pointing at the section's
 * foxxi type IRI (fxs:CourseCatalog, fxa:AuditLogStream, etc.) so the
 * bridge later discovers and fetches each section via `iep:discover()`
 * filtered on the manifest entry's `conformsTo` field — NO hardcoded
 * pod paths anywhere.
 *
 * The publisher does not validate the section payloads — they're
 * shovelled into the graph as `fxs:bundleJson` literals. Type shape is
 * enforced at the bridge-side parse (tenant-fetcher.ts). This keeps
 * the publisher orthogonal to ongoing schema evolution.
 */

import {
  publish,
} from '@interego/solid';
import { iesc } from './turtle-escape.js';
import type {
  ContextDescriptorData,
  IRI,
} from '@interego/core';
import type {
  FetchFn,
} from '@interego/core';
import type {
  PublishResult,
} from '@interego/solid';
import {
  deriveEncryptionKeyPair,
  type EncryptionKeyPair,
  generateKeyPair,
} from '@interego/core';
import { attachDeterministicAddresses } from './auth.js';
import { createHash } from 'node:crypto';
import { FOXXI_NS } from './foxxi-vocab.js';

// ── Foxxi namespace IRIs (the canonical base — see foxxi-vocab.ts) ──

const FXS = FOXXI_NS;
const FXA = FOXXI_NS;

export const TENANT_TYPES = {
  CourseCatalog: `${FXS}CourseCatalog` as IRI,
  TenantDirectory: `${FXS}TenantDirectory` as IRI,
  /**
   * PUBLIC membership allowlist — the self-sovereign counterpart to
   * TenantDirectory. Carries only public identifiers (user_id, web_id,
   * wallet_address), published UNENCRYPTED so ANY bridge can read it via
   * the substrate with no shared admin key. A tenant that publishes this
   * (and no encrypted TenantDirectory) is a self-sovereign, open tenant;
   * one with an encrypted TenantDirectory is a closed, admin-managed tenant
   * and its public-membership overlay (if any) is deliberately IGNORED.
   */
  TenantMembership: `${FXS}TenantMembership` as IRI,
  AssignmentPolicySet: `${FXS}AssignmentPolicySet` as IRI,
  /**
   * PUBLIC audience→course assignment policies — the self-sovereign counterpart
   * to the admin-encrypted AssignmentPolicySet (same rationale as
   * TenantMembership). A self-sovereign tenant publishes its assignments in the
   * clear so ANY bridge reads them via the substrate with no admin key; a closed
   * tenant keeps its encrypted AssignmentPolicySet and its public overlay (if
   * any) is ignored by the closed-tenant guard. NOTE: CourseCatalog is ALREADY
   * public (not in ADMIN_ONLY_TYPES), so the catalog needs no public twin —
   * ingest upserts the existing CourseCatalog section directly.
   */
  TenantAssignments: `${FXS}TenantAssignments` as IRI,
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
  /** The tenant's pod root URL (e.g. https://interego-css.../foxxi/). */
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
  // iesc the IRIs (defence in depth — graphIri/authoritativeSource are server/config-minted
  // today, but this is the same sink class every other publisher was hardened for).
  return `<${iesc(args.graphIri)}> a <${iesc(args.typeIri)}> ;
    <http://www.w3.org/ns/prov#wasAttributedTo> <${iesc(args.authoritativeSource)}> ;
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

  // publish() PUTs the graph + descriptor with `If-None-Match: '*'` (create-only)
  // and SILENTLY tolerates the 412 when the resource already exists — so a
  // re-publish to a FIXED-slug section keeps the OLD content (the caller sees a
  // success but nothing changed on the pod). Tenant sections are MUTABLE: updated
  // in place under a stable slug, single-owner + sequential. So delete the
  // existing descriptor + graph FIRST, then publish fresh. Best-effort — a 404
  // (first write) or a transient failure is fine; the publish still lands.
  const containerPath = args.config.containerPath ?? 'foxxi/';
  const base = `${args.config.podUrl.replace(/\/?$/, '/')}${containerPath}`;
  const stale = [
    `${base}${args.slug}.ttl`,                       // descriptor
    `${base}${args.slug}-graph.trig`,                // plaintext graph
    `${base}${args.slug}-graph.envelope.jose.json`,  // encrypted graph
  ];
  await Promise.allSettled(stale.map(u => args.config.fetch(u, { method: 'DELETE' })));

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
 * Publish a PUBLIC tenant-membership allowlist (see TENANT_TYPES.TenantMembership).
 *
 * Unlike publishTenantDirectory this section is NOT encrypted: it holds only
 * public identifiers (user_id, web_id, wallet_address), so a self-sovereign
 * tenant can publish it to its own pod and ANY bridge reads it via the
 * substrate — no shared admin key, no per-tenant bridge env var. Only entries
 * that carry a real `wallet_address` are kept (a membership entry with no
 * verifiable address is meaningless for proof-of-possession); addresses are
 * NOT derived from the demo seed here — self-sovereign members bring their own.
 */
export async function publishTenantMembership(users: unknown, config: TenantPublishConfig): Promise<PublishResult> {
  const list = (users as ReadonlyArray<{ user_id?: string; web_id?: string; wallet_address?: string }>) ?? [];
  const members = list.filter(u => typeof u.wallet_address === 'string' && u.wallet_address.length > 0);
  return publishSection({
    config,
    slug: 'tenant-membership',
    graphIri: `urn:foxxi:tenant:${slugSourceDid(config.authoritativeSource)}:membership` as IRI,
    typeIri: TENANT_TYPES.TenantMembership,
    payload: { users: members },
  });
}

/**
 * Publish a PUBLIC audience→course assignment policy set (see
 * TENANT_TYPES.TenantAssignments). Unencrypted, so a self-sovereign tenant's
 * assignments are readable by any bridge via the substrate. The payload is the
 * array of policy rows discover joins against (audience_group_id, course_id,
 * requirement_type, due_relative_days, …).
 */
export async function publishTenantAssignments(policies: unknown, config: TenantPublishConfig): Promise<PublishResult> {
  const list = Array.isArray(policies) ? policies : [];
  return publishSection({
    config,
    slug: 'tenant-assignments',
    graphIri: `urn:foxxi:tenant:${slugSourceDid(config.authoritativeSource)}:assignments` as IRI,
    typeIri: TENANT_TYPES.TenantAssignments,
    payload: list,
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
