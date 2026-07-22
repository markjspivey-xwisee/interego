/**
 * OneRoster 1.2 connector for the Foxxi vertical.
 *
 * Exposes the tenant's roster as a conformant OneRoster 1.2 REST
 * service so any SIS / HR system that speaks OneRoster (PowerSchool,
 * Infinite Campus, Skyward, Workday Student, BambooHR via OneRoster
 * adapters) can pull the tenant's roster — or push to it via a CSV
 * bundle.
 *
 * Scope:
 *   - Read-side REST (1EdTech OneRoster Rostering 1.2):
 *       GET  /ims/oneroster/v1p2/users
 *       GET  /ims/oneroster/v1p2/users/{sourcedId}
 *       GET  /ims/oneroster/v1p2/orgs
 *       GET  /ims/oneroster/v1p2/courses
 *       GET  /ims/oneroster/v1p2/courses/{sourcedId}
 *       GET  /ims/oneroster/v1p2/classes
 *       GET  /ims/oneroster/v1p2/enrollments
 *   - Bulk consumer (1EdTech OneRoster CSV 1.2):
 *       POST /ims/oneroster/v1p2/import     CSV bundle ingest — APPLIED
 *
 * Two roster layers are merged on every read:
 *   1. The live published tenant directory + groups + enrollment policies
 *      (`admin_payload.json`) — Foxxi's own roster.
 *   2. An imported overlay populated by `POST .../import` — the
 *      bring-your-own-SIS roster. Imported records win on sourcedId
 *      collision, so an external SIS can be the authoritative source.
 *
 * Multi-tenant: the imported overlay is partitioned by the tenant
 * resolved from `?tenant_pod_url`; single-tenant deployments use
 * DEFAULT_TENANT throughout.
 *
 * Layer: L3 vertical. OneRoster is an external 1EdTech standard; this
 * is a conformant connector — no new ontology term.
 */

import type { Express, Request, Response } from 'express';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DEFAULT_TENANT, tenantIdOf, type TenantId } from './tenant-context.js';
import { callerIsOperator, trustedTenantOf, type OperatorAuthConfig } from './operator-auth.js';

interface OrConfig extends OperatorAuthConfig {
  tenantDid: string;
}

export interface FoxxiUser {
  user_id: string;
  web_id: string;
  name: string;
  email: string;
  department: string;
  job_title: string;
  manager_user_id: string | null;
  audience_tags: readonly string[];
  status: string;
  hire_date: string;
  employee_id: string;
}
interface FoxxiGroup {
  group_id: string;
  name: string;
  kind: string;
  member_count?: number;
  member_ids: readonly string[];
  description?: string;
}
interface FoxxiPolicy {
  policy_id: string;
  course_id: string;
  course_title?: string;
  audience_group_id: string;
  audience_label?: string;
  requirement_type: string;
  enabled: boolean;
  created_at: string;
}
export interface FoxxiAdmin {
  meta: { tenant: string; tenant_did?: string; tenant_id: string };
  users: readonly FoxxiUser[];
  groups: readonly FoxxiGroup[];
  policies: readonly FoxxiPolicy[];
}

/**
 * Load the bundled tenant directory (Foxxi's own roster). Bundled into
 * the bridge image at a known path.
 */
export function loadAdminPayload(): FoxxiAdmin {
  const here = dirname(fileURLToPath(import.meta.url));
  const candidates = [
    resolve(here, '../imported/admin_payload.json'),
    resolve(here, '../../imported/admin_payload.json'),
    resolve(process.cwd(), 'applications/foxxi-content-intelligence/imported/admin_payload.json'),
  ];
  for (const p of candidates) {
    try { return JSON.parse(readFileSync(p, 'utf8')) as FoxxiAdmin; } catch { /* try next */ }
  }
  throw new Error('admin_payload.json not findable for OneRoster connector');
}

// ── OneRoster shapes ────────────────────────────────────────────────

export interface OrUser {
  sourcedId: string;
  status: 'active' | 'tobedeleted';
  dateLastModified: string;
  enabledUser: boolean;
  givenName: string;
  familyName: string;
  middleName?: string;
  role: 'administrator' | 'student' | 'teacher' | 'guardian' | 'relative' | 'aide' | 'parent' | 'proctor';
  username: string;
  identifier: string;
  email: string;
  phone?: string;
  agentSourcedIds: string[];
  orgSourcedIds: string[];
}

interface OrCourse {
  sourcedId: string;
  status: 'active' | 'tobedeleted';
  dateLastModified: string;
  title: string;
  courseCode: string;
  grades: string[];
  subjects: string[];
  org: { sourcedId: string; type: 'org' };
  subjectCodes: string[];
}

interface OrClass {
  sourcedId: string;
  status: string;
  dateLastModified: string;
  title: string;
  classCode: string;
  classType: 'scheduled' | 'homeroom';
  location: string;
  grades: string[];
  subjects: string[];
  course: { sourcedId: string; href: string; type: 'course' };
  school: { sourcedId: string; href: string; type: 'org' };
  terms: unknown[];
  subjectCodes: string[];
  periods: string[];
}

interface OrEnrollment {
  sourcedId: string;
  status: string;
  dateLastModified: string;
  user: { sourcedId: string; href: string; type: 'user' };
  class: { sourcedId: string; href: string; type: 'class' };
  school: { sourcedId: string; href: string; type: 'org' };
  role: 'student' | 'teacher' | 'administrator';
  primary: boolean;
}

interface OrOrg {
  sourcedId: string;
  status: string;
  dateLastModified: string;
  name: string;
  type: string;
  identifier: string;
  parent: { sourcedId: string; type: 'org' } | null;
  children: { sourcedId: string; type: 'org' }[];
}

const ORG_SOURCED_ID = 'org-foxxi-tenant';

function mapFoxxiRole(u: FoxxiUser): OrUser['role'] {
  // OneRoster role vocab is narrow. Map Foxxi audience semantics to the
  // closest OneRoster role: admin tag → administrator, learning-engineer
  // or manager → teacher (instructor-side), else → student.
  const isAdmin = u.audience_tags.includes('admin') || /\b(l&d administrator|administrator)\b/i.test(u.job_title);
  const isInstructorSide = u.audience_tags.includes('learning-engineering')
    || u.audience_tags.includes('managers')
    || /(learning engineer|manager|director|instructor|teacher)/i.test(u.job_title);
  return isAdmin ? 'administrator' : (isInstructorSide ? 'teacher' : 'student');
}

function toOrUser(u: FoxxiUser, orgSourcedId: string): OrUser {
  const [givenName, ...rest] = u.name.split(' ');
  const familyName = rest.length ? rest.join(' ') : givenName ?? '';
  return {
    sourcedId: u.user_id,
    status: u.status === 'active' ? 'active' : 'tobedeleted',
    dateLastModified: u.hire_date || new Date().toISOString(),
    enabledUser: u.status === 'active',
    givenName: givenName ?? '',
    familyName,
    role: mapFoxxiRole(u),
    username: u.user_id,
    identifier: u.employee_id,
    email: u.email,
    agentSourcedIds: [],
    orgSourcedIds: [orgSourcedId],
  };
}

function toOrClass(group: FoxxiGroup, orgSourcedId: string): OrClass {
  return {
    sourcedId: group.group_id,
    status: 'active',
    dateLastModified: new Date().toISOString(),
    title: group.name,
    classCode: group.group_id,
    classType: 'scheduled',
    location: '',
    grades: [],
    subjects: [group.kind],
    course: { sourcedId: '', href: '', type: 'course' },
    school: { sourcedId: orgSourcedId, href: '', type: 'org' },
    terms: [],
    subjectCodes: [],
    periods: [],
  };
}

function toOrEnrollment(policy: FoxxiPolicy, userSourcedId: string, classSourcedId: string, idx: number): OrEnrollment {
  return {
    sourcedId: `enr-${policy.policy_id}-${userSourcedId}-${idx}`,
    status: 'active',
    dateLastModified: policy.created_at,
    user: { sourcedId: userSourcedId, href: '', type: 'user' },
    class: { sourcedId: classSourcedId, href: '', type: 'class' },
    school: { sourcedId: ORG_SOURCED_ID, href: '', type: 'org' },
    role: 'student',
    primary: idx === 0,
  };
}

/** Foxxi's enrollment policies are course-level — surface them as
 *  OneRoster `courses` (deduplicated by course id). */
function adminCourses(admin: FoxxiAdmin): OrCourse[] {
  const seen = new Set<string>();
  const out: OrCourse[] = [];
  for (const p of admin.policies) {
    if (!p.course_id || seen.has(p.course_id)) continue;
    seen.add(p.course_id);
    out.push({
      sourcedId: p.course_id,
      status: 'active',
      dateLastModified: p.created_at || new Date().toISOString(),
      title: p.course_title || p.course_id,
      courseCode: p.course_id,
      grades: [],
      subjects: [],
      org: { sourcedId: ORG_SOURCED_ID, type: 'org' },
      subjectCodes: [],
    });
  }
  return out;
}

// ── Imported roster overlay (the OneRoster CSV consumer) ─────────────

interface ImportedRoster {
  users: Map<string, OrUser>;
  orgs: Map<string, OrOrg>;
  courses: Map<string, OrCourse>;
  classes: Map<string, OrClass>;
  enrollments: Map<string, OrEnrollment>;
  importedAt: string;
}

const importedRosters = new Map<TenantId, ImportedRoster>();

// ── Pod projection (foxxi:OneRosterSnapshot) ─────────────────────────
// Every applyCsvBundle() publishes a snapshot to the tenant pod; the
// overlay survives container restart via hydrate-on-startup.
import {
  registerSnapshot, dirty as markOneRosterDirty, loadLatestSnapshot, FOXXI_SNAPSHOT_TYPES,
} from './pod-snapshot-publisher.js';
interface OneRosterSnapshot {
  byTenant: Record<string, {
    users: Array<[string, unknown]>;
    orgs: Array<[string, unknown]>;
    courses: Array<[string, unknown]>;
    classes: Array<[string, unknown]>;
    enrollments: Array<[string, unknown]>;
    importedAt: string;
  }>;
}
function collectOneRosterSnapshot(): OneRosterSnapshot {
  const byTenant: OneRosterSnapshot['byTenant'] = {};
  for (const [tenant, r] of importedRosters) {
    byTenant[String(tenant)] = {
      users: [...r.users.entries()],
      orgs: [...r.orgs.entries()],
      courses: [...r.courses.entries()],
      classes: [...r.classes.entries()],
      enrollments: [...r.enrollments.entries()],
      importedAt: r.importedAt,
    };
  }
  return { byTenant };
}
async function hydrateOneRosterFromPod(): Promise<void> {
  const snap = await loadLatestSnapshot<OneRosterSnapshot>('oneroster');
  if (!snap?.byTenant) return;
  for (const [tenant, r] of Object.entries(snap.byTenant)) {
    importedRosters.set(tenant as TenantId, {
      users: new Map(r.users as Array<[string, OrUser]>),
      orgs: new Map(r.orgs as Array<[string, OrOrg]>),
      courses: new Map(r.courses as Array<[string, OrCourse]>),
      classes: new Map(r.classes as Array<[string, OrClass]>),
      enrollments: new Map(r.enrollments as Array<[string, OrEnrollment]>),
      importedAt: r.importedAt,
    });
  }
}
registerSnapshot({ surface: 'oneroster', typeIri: FOXXI_SNAPSHOT_TYPES.OneRoster, collect: collectOneRosterSnapshot });
void hydrateOneRosterFromPod();
const oneRosterPodDirty = (): void => markOneRosterDirty('oneroster');

function importedFor(tenant: TenantId): ImportedRoster {
  let r = importedRosters.get(tenant);
  if (!r) {
    r = { users: new Map(), orgs: new Map(), courses: new Map(), classes: new Map(), enrollments: new Map(), importedAt: '' };
    importedRosters.set(tenant, r);
  }
  return r;
}

/**
 * The merged user roster for a tenant — Foxxi's own directory plus the
 * imported overlay (imported wins on sourcedId collision). Exported so
 * the LTI 1.3 NRPS service answers with the same roster.
 */
export function tenantOrUsers(tenant: TenantId = DEFAULT_TENANT): OrUser[] {
  const byId = new Map<string, OrUser>();
  try {
    for (const u of loadAdminPayload().users) byId.set(u.user_id, toOrUser(u, ORG_SOURCED_ID));
  } catch { /* admin payload optional once an import has happened */ }
  for (const [id, u] of importedFor(tenant).users) byId.set(id, u);
  return [...byId.values()];
}

// ── OneRoster CSV → record mapping ──────────────────────────────────

function normRole(raw: string): OrUser['role'] {
  const r = (raw || '').trim().toLowerCase();
  if (r.includes('admin')) return 'administrator';
  if (r.includes('teacher') || r.includes('instructor')) return 'teacher';
  if (r === 'aide') return 'aide';
  if (r === 'guardian') return 'guardian';
  if (r === 'parent') return 'parent';
  if (r === 'relative') return 'relative';
  if (r === 'proctor') return 'proctor';
  return 'student';
}

function pick(row: Record<string, string>, ...keys: string[]): string {
  for (const k of keys) {
    const v = row[k];
    if (v !== undefined && v !== '') return v;
  }
  return '';
}

function csvRowToUser(row: Record<string, string>): OrUser | null {
  const sourcedId = pick(row, 'sourcedId', 'sourced_id');
  if (!sourcedId) return null;
  const orgs = pick(row, 'orgSourcedIds', 'orgSourcedId').split(/[,;]/).map(s => s.trim()).filter(Boolean);
  const status = pick(row, 'status').toLowerCase() === 'tobedeleted' ? 'tobedeleted' : 'active';
  return {
    sourcedId,
    status,
    dateLastModified: pick(row, 'dateLastModified') || new Date().toISOString(),
    enabledUser: (pick(row, 'enabledUser') || 'true').toLowerCase() !== 'false' && status === 'active',
    givenName: pick(row, 'givenName', 'given_name'),
    familyName: pick(row, 'familyName', 'family_name'),
    ...(pick(row, 'middleName') ? { middleName: pick(row, 'middleName') } : {}),
    role: normRole(pick(row, 'role', 'roles', 'primaryRole')),
    username: pick(row, 'username') || sourcedId,
    identifier: pick(row, 'identifier', 'userMasterIdentifier'),
    email: pick(row, 'email'),
    ...(pick(row, 'phone', 'sms') ? { phone: pick(row, 'phone', 'sms') } : {}),
    agentSourcedIds: pick(row, 'agentSourcedIds').split(/[,;]/).map(s => s.trim()).filter(Boolean),
    orgSourcedIds: orgs.length ? orgs : [ORG_SOURCED_ID],
  };
}

function csvRowToOrg(row: Record<string, string>): OrOrg | null {
  const sourcedId = pick(row, 'sourcedId', 'sourced_id');
  if (!sourcedId) return null;
  const parent = pick(row, 'parentSourcedId', 'parent');
  return {
    sourcedId,
    status: pick(row, 'status') || 'active',
    dateLastModified: pick(row, 'dateLastModified') || new Date().toISOString(),
    name: pick(row, 'name'),
    type: pick(row, 'type') || 'school',
    identifier: pick(row, 'identifier'),
    parent: parent ? { sourcedId: parent, type: 'org' } : null,
    children: [],
  };
}

function csvRowToCourse(row: Record<string, string>): OrCourse | null {
  const sourcedId = pick(row, 'sourcedId', 'sourced_id');
  if (!sourcedId) return null;
  const status = pick(row, 'status').toLowerCase() === 'tobedeleted' ? 'tobedeleted' : 'active';
  return {
    sourcedId,
    status,
    dateLastModified: pick(row, 'dateLastModified') || new Date().toISOString(),
    title: pick(row, 'title'),
    courseCode: pick(row, 'courseCode', 'course_code') || sourcedId,
    grades: pick(row, 'grades').split(/[,;]/).map(s => s.trim()).filter(Boolean),
    subjects: pick(row, 'subjects').split(/[,;]/).map(s => s.trim()).filter(Boolean),
    org: { sourcedId: pick(row, 'orgSourcedId', 'schoolSourcedId') || ORG_SOURCED_ID, type: 'org' },
    subjectCodes: pick(row, 'subjectCodes').split(/[,;]/).map(s => s.trim()).filter(Boolean),
  };
}

function csvRowToClass(row: Record<string, string>): OrClass | null {
  const sourcedId = pick(row, 'sourcedId', 'sourced_id');
  if (!sourcedId) return null;
  const classType = pick(row, 'classType').toLowerCase() === 'homeroom' ? 'homeroom' : 'scheduled';
  const school = pick(row, 'schoolSourcedId', 'orgSourcedId') || ORG_SOURCED_ID;
  return {
    sourcedId,
    status: pick(row, 'status') || 'active',
    dateLastModified: pick(row, 'dateLastModified') || new Date().toISOString(),
    title: pick(row, 'title'),
    classCode: pick(row, 'classCode', 'class_code') || sourcedId,
    classType,
    location: pick(row, 'location'),
    grades: pick(row, 'grades').split(/[,;]/).map(s => s.trim()).filter(Boolean),
    subjects: pick(row, 'subjects').split(/[,;]/).map(s => s.trim()).filter(Boolean),
    course: { sourcedId: pick(row, 'courseSourcedId', 'course_sourced_id'), href: '', type: 'course' },
    school: { sourcedId: school, href: '', type: 'org' },
    terms: [],
    subjectCodes: pick(row, 'subjectCodes').split(/[,;]/).map(s => s.trim()).filter(Boolean),
    periods: pick(row, 'periods').split(/[,;]/).map(s => s.trim()).filter(Boolean),
  };
}

function csvRowToEnrollment(row: Record<string, string>): OrEnrollment | null {
  const sourcedId = pick(row, 'sourcedId', 'sourced_id');
  if (!sourcedId) return null;
  const role = normRole(pick(row, 'role'));
  const enrollRole: OrEnrollment['role'] = role === 'teacher' ? 'teacher' : role === 'administrator' ? 'administrator' : 'student';
  return {
    sourcedId,
    status: pick(row, 'status') || 'active',
    dateLastModified: pick(row, 'dateLastModified') || new Date().toISOString(),
    user: { sourcedId: pick(row, 'userSourcedId', 'user_sourced_id'), href: '', type: 'user' },
    class: { sourcedId: pick(row, 'classSourcedId', 'class_sourced_id'), href: '', type: 'class' },
    school: { sourcedId: pick(row, 'schoolSourcedId') || ORG_SOURCED_ID, href: '', type: 'org' },
    role: enrollRole,
    primary: (pick(row, 'primary') || 'false').toLowerCase() === 'true',
  };
}

// ── Pagination helpers (OneRoster §3) ───────────────────────────────

function paginate<T>(arr: readonly T[], req: Request): T[] {
  const limit = Math.min(Number(req.query.limit) || 100, 1000);
  const offset = Number(req.query.offset) || 0;
  return arr.slice(offset, offset + limit);
}

// ── CSV parsing (RFC 4180 — quoted fields, embedded commas + newlines) ──

function parseCsv(text: string): Array<Record<string, string>> {
  const rows: string[][] = [];
  let row: string[] = [];
  let cur = '';
  let inQuote = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i]!;
    if (inQuote) {
      if (c === '"' && text[i + 1] === '"') { cur += '"'; i++; }
      else if (c === '"') { inQuote = false; }
      else { cur += c; }
    } else {
      if (c === '"') { inQuote = true; }
      else if (c === ',') { row.push(cur); cur = ''; }
      else if (c === '\r') { /* ignore — handled with \n */ }
      else if (c === '\n') { row.push(cur); cur = ''; rows.push(row); row = []; }
      else { cur += c; }
    }
  }
  if (cur.length > 0 || row.length > 0) { row.push(cur); rows.push(row); }
  if (rows.length === 0) return [];
  const headers = rows[0]!.map(h => h.trim().replace(/^﻿/, ''));
  return rows.slice(1)
    .filter(r => r.some(c => c.length > 0))
    .map(r => {
      const o: Record<string, string> = {};
      headers.forEach((h, idx) => { o[h] = r[idx] ?? ''; });
      return o;
    });
}

/** Match a bundle key to a OneRoster resource regardless of casing /
 *  `.csv` suffix / path prefix (`users.csv`, `Users`, `csv/users.csv`). */
function resourceOf(filename: string): 'users' | 'orgs' | 'courses' | 'classes' | 'enrollments' | null {
  const base = filename.toLowerCase().split('/').pop()?.replace(/\.csv$/, '') ?? '';
  if (base === 'users' || base === 'user') return 'users';
  if (base === 'orgs' || base === 'org') return 'orgs';
  if (base === 'courses' || base === 'course') return 'courses';
  if (base === 'classes' || base === 'class') return 'classes';
  if (base === 'enrollments' || base === 'enrollment') return 'enrollments';
  return null;
}

/**
 * Apply a OneRoster CSV bundle into the tenant's imported overlay. The
 * overlay is then served by every GET endpoint, merged over Foxxi's own
 * directory. Returns per-resource applied/skipped counts.
 */
export function applyCsvBundle(tenant: TenantId, bundle: Record<string, string>): {
  applied: Record<string, number>;
  skipped: Record<string, number>;
  ignored: string[];
} {
  const overlay = importedFor(tenant);
  const applied: Record<string, number> = {};
  const skipped: Record<string, number> = {};
  const ignored: string[] = [];

  for (const [filename, csv] of Object.entries(bundle)) {
    if (typeof csv !== 'string') { ignored.push(filename); continue; }
    const resource = resourceOf(filename);
    if (!resource) { ignored.push(filename); continue; }
    const rows = parseCsv(csv);
    let ok = 0;
    let bad = 0;
    for (const r of rows) {
      switch (resource) {
        case 'users': { const v = csvRowToUser(r); if (v) { overlay.users.set(v.sourcedId, v); ok++; } else bad++; break; }
        case 'orgs': { const v = csvRowToOrg(r); if (v) { overlay.orgs.set(v.sourcedId, v); ok++; } else bad++; break; }
        case 'courses': { const v = csvRowToCourse(r); if (v) { overlay.courses.set(v.sourcedId, v); ok++; } else bad++; break; }
        case 'classes': { const v = csvRowToClass(r); if (v) { overlay.classes.set(v.sourcedId, v); ok++; } else bad++; break; }
        case 'enrollments': { const v = csvRowToEnrollment(r); if (v) { overlay.enrollments.set(v.sourcedId, v); ok++; } else bad++; break; }
      }
    }
    applied[resource] = (applied[resource] ?? 0) + ok;
    skipped[resource] = (skipped[resource] ?? 0) + bad;
  }
  overlay.importedAt = new Date().toISOString();
  oneRosterPodDirty();
  return { applied, skipped, ignored };
}

// ── merge helpers (Foxxi directory + imported overlay) ───────────────

function mergeById<T>(base: readonly T[], overlay: ReadonlyMap<string, T>, idOf: (t: T) => string): T[] {
  const m = new Map<string, T>();
  for (const b of base) m.set(idOf(b), b);
  for (const [id, o] of overlay) m.set(id, o);
  return [...m.values()];
}

// ── Route attachment ────────────────────────────────────────────────

export function attachOneRosterRoutes(app: Express, config: OrConfig): void {
  // Honor ?tenant_pod_url ONLY for a verified operator; pin everyone else
  // to DEFAULT_TENANT so an anonymous caller can never read or write a
  // victim tenant's roster (the old `tenantIdOf(?tenant_pod_url)` was the
  // cross-tenant hole). Default-tenant reads still work (1EdTech conformance).
  const tenantOf = (req: Request): TenantId => trustedTenantOf(req, config);

  app.get('/ims/oneroster/v1p2', (_req, res) => {
    res.json({
      service: '1EdTech OneRoster Rostering 1.2',
      version: '1.2',
      endpoints: [
        '/ims/oneroster/v1p2/users',
        '/ims/oneroster/v1p2/users/{sourcedId}',
        '/ims/oneroster/v1p2/orgs',
        '/ims/oneroster/v1p2/courses',
        '/ims/oneroster/v1p2/courses/{sourcedId}',
        '/ims/oneroster/v1p2/classes',
        '/ims/oneroster/v1p2/enrollments',
        '/ims/oneroster/v1p2/import',
      ],
      conformance: 'https://www.imsglobal.org/spec/oneroster/v1p2/',
    });
  });

  // OneRoster 1.2 REST binding requires OAuth2 Bearer on ALL service endpoints. These GETs
  // return roster PII (names, emails, employee IDs, enrollments) and were previously ANONYMOUS.
  // Gate every read on the same operator auth the write path (/import) uses — an unauthenticated
  // caller must not be able to enumerate a tenant's roster.
  const rosterAuth = (req: Request, res: Response): boolean => {
    if (!callerIsOperator(req, config)) {
      res.status(401).json({ error: 'OneRoster access requires an authenticated operator session (OAuth2 Bearer / operator token)' });
      return false;
    }
    return true;
  };

  app.get('/ims/oneroster/v1p2/users', (req: Request, res: Response) => {
    if (!rosterAuth(req, res)) return;
    res.json({ users: paginate(tenantOrUsers(tenantOf(req)), req) });
  });

  app.get('/ims/oneroster/v1p2/users/:sourcedId', (req: Request, res: Response) => {
    if (!rosterAuth(req, res)) return;
    const u = tenantOrUsers(tenantOf(req)).find(x => x.sourcedId === req.params.sourcedId);
    if (!u) { res.status(404).json({ error: 'user not found' }); return; }
    res.json({ user: u });
  });

  app.get('/ims/oneroster/v1p2/orgs', (req: Request, res: Response) => {
    if (!rosterAuth(req, res)) return;
    const admin = safeAdmin();
    const base: OrOrg[] = admin ? [{
      sourcedId: ORG_SOURCED_ID,
      status: 'active',
      dateLastModified: new Date().toISOString(),
      name: admin.meta.tenant,
      type: 'national',
      identifier: admin.meta.tenant_id,
      parent: null,
      children: [],
    }] : [];
    res.json({ orgs: paginate(mergeById(base, importedFor(tenantOf(req)).orgs, o => o.sourcedId), req) });
  });

  app.get('/ims/oneroster/v1p2/courses', (req: Request, res: Response) => {
    if (!rosterAuth(req, res)) return;
    const admin = safeAdmin();
    const base = admin ? adminCourses(admin) : [];
    res.json({ courses: paginate(mergeById(base, importedFor(tenantOf(req)).courses, c => c.sourcedId), req) });
  });

  app.get('/ims/oneroster/v1p2/courses/:sourcedId', (req: Request, res: Response) => {
    if (!rosterAuth(req, res)) return;
    const admin = safeAdmin();
    const base = admin ? adminCourses(admin) : [];
    const all = mergeById(base, importedFor(tenantOf(req)).courses, c => c.sourcedId);
    const course = all.find(c => c.sourcedId === req.params.sourcedId);
    if (!course) { res.status(404).json({ error: 'course not found' }); return; }
    res.json({ course });
  });

  app.get('/ims/oneroster/v1p2/classes', (req: Request, res: Response) => {
    if (!rosterAuth(req, res)) return;
    const admin = safeAdmin();
    const base = admin ? admin.groups.map(g => toOrClass(g, ORG_SOURCED_ID)) : [];
    res.json({ classes: paginate(mergeById(base, importedFor(tenantOf(req)).classes, c => c.sourcedId), req) });
  });

  app.get('/ims/oneroster/v1p2/enrollments', (req: Request, res: Response) => {
    if (!rosterAuth(req, res)) return;
    const admin = safeAdmin();
    const base: OrEnrollment[] = [];
    if (admin) {
      const userIds = new Set(admin.users.map(u => u.user_id));
      let i = 0;
      for (const p of admin.policies.filter(p => p.enabled)) {
        const group = admin.groups.find(g => g.group_id === p.audience_group_id);
        if (!group) continue;
        for (const memberId of group.member_ids) {
          if (!userIds.has(memberId)) continue;
          base.push(toOrEnrollment(p, memberId, group.group_id, i++));
        }
      }
    }
    res.json({ enrollments: paginate(mergeById(base, importedFor(tenantOf(req)).enrollments, e => e.sourcedId), req) });
  });

  // CSV bundle ingest — accept the OneRoster CSV file set as JSON
  // (one key per filename) and APPLY it into the tenant's imported
  // overlay, which every GET above then reflects. The upstream caller
  // (a Foxxi affordance) unzips the OneRoster bundle for the user.
  app.post('/ims/oneroster/v1p2/import', (req: Request, res: Response) => {
    // WRITE endpoint — require a verified operator. Previously anonymous:
    // any caller could overwrite any tenant's roster (and imported records
    // win on sourcedId, leaking into LTI 1.3 NRPS member lists).
    if (!callerIsOperator(req, config)) {
      res.status(401).json({ error: 'OneRoster import requires an authenticated operator (admin or learning-engineer) session token' });
      return;
    }
    const body = req.body as Record<string, string> | undefined;
    if (!body || typeof body !== 'object' || Array.isArray(body)) {
      res.status(400).json({ error: 'expected JSON: { "users.csv": "...", "classes.csv": "...", ... }' });
      return;
    }
    const tenant = tenantOf(req);
    const result = applyCsvBundle(tenant, body);
    const totalApplied = Object.values(result.applied).reduce((a, b) => a + b, 0);
    if (totalApplied === 0 && result.ignored.length === Object.keys(body).length) {
      res.status(400).json({
        error: 'no recognised OneRoster CSV files in the bundle',
        recognised: ['users.csv', 'orgs.csv', 'courses.csv', 'classes.csv', 'enrollments.csv'],
        ignored: result.ignored,
      });
      return;
    }
    const overlay = importedFor(tenant);
    res.json({
      ok: true,
      applied: result.applied,
      skipped: result.skipped,
      ignored: result.ignored,
      rosterNow: {
        users: overlay.users.size,
        orgs: overlay.orgs.size,
        courses: overlay.courses.size,
        classes: overlay.classes.size,
        enrollments: overlay.enrollments.size,
      },
      note: 'Applied into the imported roster overlay — the GET /users, /orgs, /courses, /classes, /enrollments endpoints now reflect it (imported records win on sourcedId collision with Foxxi\'s own directory).',
    });
  });
}

function safeAdmin(): FoxxiAdmin | null {
  try { return loadAdminPayload(); } catch { return null; }
}
