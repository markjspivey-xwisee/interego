#!/usr/bin/env -S npx tsx
/**
 * publish-tenant — one-time CLI that seeds a tenant pod with the Foxxi
 * vertical's published descriptors so the bridge can discover + fetch
 * them at runtime (no inline bundle required).
 *
 * Usage:
 *   FOXXI_TENANT_POD_URL=https://interego-css.../markj/ \
 *   FOXXI_AUTHORITATIVE_SOURCE=did:web:acme-training.example \
 *   npx tsx applications/foxxi-content-intelligence/tools/publish-tenant.ts
 *
 * Auth: if POD_BEARER is set, requests carry `Authorization: Bearer
 * $POD_BEARER`. Otherwise unauthenticated — which works only if the
 * pod's `foxxi/` container has public-write ACL (default CSS install
 * does NOT).
 *
 * What it publishes (one descriptor + graph per section, each tagged
 * with a dct:conformsTo type from the foxxi vocab so the bridge can
 * discover by type filter):
 *   - fxs:CourseCatalog        — admin_payload.catalog
 *   - fxs:TenantDirectory      — admin_payload.users + groups
 *   - fxs:AssignmentPolicySet  — admin_payload.policies
 *   - fxs:ConnectorRegistry    — admin_payload.connections
 *   - fxa:EnrollmentEventStream — admin_payload.events
 *   - fxa:AuditLogStream       — admin_payload.audit
 *   - fxa:CoursePackageBundle  — per-course dashboard_data.json
 */

import { readFileSync, readdirSync } from 'node:fs';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  publishTenantSnapshot,
  publishCoursePackage,
  type TenantPublishConfig,
} from '../src/tenant-publisher.js';
import type { IRI } from '@interego/core';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const FOXXI_ROOT = resolve(__dirname, '..');
const IMPORTED = join(FOXXI_ROOT, 'imported');

function envOrDie(name: string): string {
  const v = process.env[name];
  if (!v) {
    console.error(`Missing required env var ${name}`);
    process.exit(2);
  }
  return v;
}

function authFetch(bearer?: string): typeof globalThis.fetch {
  if (!bearer) return globalThis.fetch.bind(globalThis);
  return ((url: RequestInfo | URL, init?: RequestInit) => {
    const headers = new Headers(init?.headers);
    headers.set('Authorization', `Bearer ${bearer}`);
    return globalThis.fetch(url, { ...init, headers });
  }) as typeof globalThis.fetch;
}

async function main() {
  const podUrl = envOrDie('FOXXI_TENANT_POD_URL');
  const authoritativeSource = envOrDie('FOXXI_AUTHORITATIVE_SOURCE') as IRI;
  const adminWebId = envOrDie('FOXXI_ADMIN_WEB_ID');
  const adminKeySeed = envOrDie('FOXXI_ADMIN_KEY_SEED');
  const walletSeed = process.env.FOXXI_WALLET_SEED;
  const bearer = process.env.POD_BEARER;
  const fetchFn = authFetch(bearer);
  const config: TenantPublishConfig = {
    podUrl,
    authoritativeSource,
    fetch: fetchFn,
    containerPath: 'foxxi/',
    adminWebId,
    adminKeySeed,
    walletSeed,
  };

  console.log('=== publish-tenant ===');
  console.log(`pod:    ${podUrl}`);
  console.log(`source: ${authoritativeSource}`);
  console.log(`admin:  ${adminWebId}`);
  console.log(`auth:   ${bearer ? 'bearer' : 'anonymous'}`);
  console.log(`E2EE:   admin sections encrypted to deterministic X25519 keypair derived from FOXXI_ADMIN_KEY_SEED`);
  console.log('');

  // Substrate publish() uses If-None-Match: * to enforce content-addressed
  // immutability — but for our demo re-seed flow we want overwrites. Clean
  // the foxxi/ container's old resources + the manifest first so each
  // publish writes fresh.
  if (process.env.PUBLISH_CLEAN !== '0') {
    await cleanOldResources(podUrl, fetchFn);
  }

  // ── Load the tenant admin payload from imported/ ──
  const adminPath = join(IMPORTED, 'admin_payload.json');
  console.log(`loading: ${adminPath}`);
  const admin = JSON.parse(readFileSync(adminPath, 'utf8'));

  console.log('publishing tenant snapshot…');
  const snap = await publishTenantSnapshot(admin, config);
  for (const [k, r] of Object.entries(snap)) {
    console.log(`  ${k.padEnd(11)} → ${r.descriptorUrl}`);
  }

  // ── Load each course's dashboard_data.json and publish as a bundle ──
  const courseFiles = readdirSync(IMPORTED).filter(f => /^(lesson\d+_)?dashboard_data(_v\d+)?\.json$/.test(f));
  console.log('');
  console.log(`publishing ${courseFiles.length} course package${courseFiles.length === 1 ? '' : 's'}…`);
  for (const file of courseFiles) {
    const courseId = /^lesson(\d+)/.exec(file)?.[0] ?? 'golf-explained';
    const payload = JSON.parse(readFileSync(join(IMPORTED, file), 'utf8'));
    const transcripts = (() => {
      const tp = join(IMPORTED, courseId === 'golf-explained' ? 'transcripts.json' : `${courseId}_transcripts.json`);
      try { return JSON.parse(readFileSync(tp, 'utf8')); } catch { return {}; }
    })();
    // Match the agentic payload shape the bridge's payloadToAgenticCourse expects.
    const agentic = {
      packageMeta: payload.package ?? { id: courseId, title: courseId },
      stats: payload.stats ?? {},
      scenes: payload.scenes ?? [],
      slides: payload.slides ?? [],
      concepts: payload.concepts ?? [],
      prereq_edges: payload.prereq_edges ?? [],
      modifier_pairs: payload.modifier_pairs ?? [],
      transcripts,
    };
    const result = await publishCoursePackage({ courseId, payload: agentic }, config);
    console.log(`  ${courseId.padEnd(11)} → ${result.descriptorUrl}`);
  }

  console.log('');
  console.log('done. bridge can now call cg:discover() on the pod and find every section.');
}

/**
 * Delete every TTL we know we wrote in a previous run so the next publish
 * can write fresh. CSS rejects PUT on existing resources with the
 * substrate's If-None-Match: * header (412 Precondition Failed) and the
 * substrate treats that as success — silent no-op. DELETE first works
 * around that for the demo seed flow.
 */
async function cleanOldResources(podUrl: string, fetchFn: typeof globalThis.fetch): Promise<void> {
  const container = podUrl.endsWith('/') ? `${podUrl}foxxi/` : `${podUrl}/foxxi/`;
  const knownSlugs = [
    'course-catalog', 'tenant-directory', 'assignment-policies',
    'connector-registry', 'enrollment-events', 'audit-log',
    'course-golf-explained', 'course-golf-fundamentals',
    'admin-encryption-key',
    'abac-policy-admin-full-access', 'abac-policy-manager-direct-reports', 'abac-policy-learner-self',
  ];
  const exts = ['.ttl', '-graph.trig', '.envelope.jose.json', '-graph.envelope.jose.json'];
  console.log('cleaning old resources…');
  let deleted = 0;
  for (const slug of knownSlugs) {
    for (const ext of exts) {
      const url = `${container}${slug}${ext}`;
      const r = await fetchFn(url, { method: 'DELETE' });
      if (r.ok) deleted++;
    }
  }
  // Manifest update is per-entry CAS, so clearing it lets the publishes seed fresh.
  const manifest = `${podUrl.replace(/\/$/, '')}/.well-known/context-graphs`;
  await fetchFn(manifest, { method: 'DELETE' });
  console.log(`  ${deleted} stale resource${deleted === 1 ? '' : 's'} deleted + manifest cleared.`);
  console.log('');
}

main().catch(err => {
  console.error('publish-tenant failed:', err);
  process.exit(1);
});
