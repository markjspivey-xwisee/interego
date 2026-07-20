/**
 * Hypermedia resource endpoints — Foxxi as a real REST + HATEOAS service.
 *
 * Endpoints below expose each substrate-backed resource as a canonical
 * REST URI returning either a single resource representation or a
 * paginated collection. Every response carries embedded hypermedia
 * controls in two formats simultaneously, picked by Accept header:
 *
 *   application/json (default)   — JSON with `_links` block (HAL-ish)
 *   application/ld+json          — JSON-LD with Hydra `operation` /
 *                                  `view` blocks per the bridge's
 *                                  affordance manifest
 *
 * The L1 affordance manifest at GET /affordances is the single source
 * of truth for what transitions are possible. The resource endpoints
 * here filter that manifest to the affordances applicable to a given
 * resource and embed them in the response. The dashboard client
 * navigates by following these links rather than knowing URL patterns
 * — Richardson Level 3.
 *
 * Identifier opacity: every URL identifier is a UUID v5 derived from
 * the substrate IRI (e.g. the course descriptor IRI on the pod, the
 * user WebID, the audit descriptor IRI). Slugs never leak into URLs.
 */

import type { Express, Request, Response, NextFunction } from 'express';
import { createHash, randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { affordancesFor, type Affordance } from '../../_shared/affordance-mcp/index.js';
import { actionKey } from '@interego/core';
import { deriveUserWallet } from './auth.js';
import { FOXXI_NS } from './foxxi-vocab.js';

interface HypermediaConfig {
  selfBaseUrl: string;
  affordances: ReadonlyArray<Affordance>;
  /** SCORM player base URL — emitted as templated `launch` link on
   * playable enrollments + courses so the dashboard never hardcodes it. */
  scormPlayerBaseUrl?: string;
}

/** Courses whose payloads ship with a playable SCORM package. */
const PLAYABLE_COURSE_IDS = new Set<string>(['golf-explained']);

/**
 * One variable of a templated hypermedia link. Modelled on Hydra's
 * `hydra:IriTemplateMapping` — a `hydra:variable` + `hydra:required` —
 * plus a contract telling the client *how to source* the value:
 *   - `fromSession`  — copy a field of the caller's own session.
 *   - `fromExchange` — the value is secret; do NOT put the session
 *                      bearer in the URL. Instead POST the bearer to
 *                      `mintUrl` and substitute the returned one-time
 *                      code (out-of-band auth handoff — see
 *                      docs/patterns/out-of-band-auth-exchange.md).
 * The client iterates this `mapping` and substitutes by name; it never
 * string-scans the href for `{…}` braces.
 */
interface TemplateVariable {
  /** The `{name}` placeholder in the href (Hydra `hydra:variable`). */
  variable: string;
  /** Hydra `hydra:required`. */
  required: boolean;
  /** Human description (for affordance-walkers + docs). */
  description: string;
  /** Which field of the caller's session supplies this variable. */
  fromSession?: 'bearerToken' | 'actorDid' | 'actorName';
  /** Out-of-band exchange: mint a one-time code at this URL rather than
   *  placing a long-lived secret in the URL. */
  fromExchange?: { mintUrl: string; method: 'POST' };
}

/** A HAL link that is an RFC 6570 / Hydra IriTemplate. `templated: true`
 *  signals expansion is required; `mapping` declares every variable so
 *  the client substitutes structurally. */
interface TemplatedLink {
  href: string;
  templated: true;
  title?: string;
  /** Hydra `hydra:variableRepresentation` — basic (raw) string values. */
  variableRepresentation: 'hydra:BasicRepresentation';
  mapping: TemplateVariable[];
}

/** Build a Hydra-IriTemplate `launch` link for a playable course. The
 *  href carries `{code}`/`{learner_did}`/`{learner_name}` placeholders.
 *  `{code}` is sourced via out-of-band exchange — the dashboard mints a
 *  short-lived one-time code at `<base>/launch-codes` so the long-lived
 *  session bearer never enters a URL. `learner_did`/`learner_name` are
 *  non-secret and copied straight from the session. */
function launchLink(playerBase: string, bridgeBase: string, courseId: string): TemplatedLink {
  const u = new URL(playerBase);
  u.searchParams.set('bridge', bridgeBase);
  u.searchParams.set('course_id', courseId);
  const mintUrl = `${bridgeBase}/api/foxxi/v1/launch-codes`;
  return {
    href: `${u.toString()}&code={code}&learner_did={learner_did}&learner_name={learner_name}`,
    templated: true,
    title: 'Launch the SCORM player for this course (xAPI 2.0 emitting)',
    variableRepresentation: 'hydra:BasicRepresentation',
    mapping: [
      { variable: 'code', required: true, fromExchange: { mintUrl, method: 'POST' }, description: 'One-time launch code — exchanged by the player for a session bearer; keeps the long-lived bearer out of the URL' },
      { variable: 'learner_did', required: true, fromSession: 'actorDid', description: 'Learner DID / WebID — the xAPI actor' },
      { variable: 'learner_name', required: false, fromSession: 'actorName', description: 'Learner display name — xAPI actor.name' },
    ],
  };
}

// ── Opaque ID derivation (matches dashboard's identifiers.ts) ──────

function sha256Hex(s: string): string {
  return createHash('sha256').update(s, 'utf8').digest('hex');
}
function hexToUuidV5(h: string): string {
  const variantNibble = ((parseInt(h[16]!, 16) & 0x3) | 0x8).toString(16);
  return (
    h.slice(0, 8) + '-' +
    h.slice(8, 12) + '-' +
    '5' + h.slice(13, 16) + '-' +
    variantNibble + h.slice(17, 20) + '-' +
    h.slice(20, 32)
  );
}
function opaqueId(kind: string, slug: string): string {
  return hexToUuidV5(sha256Hex(`foxxi:${kind}:${slug}`));
}
function userIdToUuid(userId: string): string {
  // Match the dashboard's wallet-derived UUID — both sides use the
  // wallet address (the substrate's crypto-rooted identity) as the
  // hashed input, ensuring opaque ids round-trip between client and
  // server bit-for-bit.
  const addr = deriveUserWallet(userId).address.toLowerCase();
  return hexToUuidV5(sha256Hex(`foxxi:user-uuid:${addr}`));
}

// ── Admin payload (resource source data) ───────────────────────────

interface FoxxiUser {
  user_id: string; web_id: string; name: string; email: string;
  department: string; job_title: string;
  audience_tags: readonly string[]; status: string;
  hire_date: string; employee_id?: string;
}
interface FoxxiPolicy {
  policy_id: string; course_id: string; course_title?: string;
  audience_group_id: string; requirement_type: string; enabled: boolean;
  created_at: string; due_relative_days?: number; trigger?: string;
}
interface FoxxiGroup {
  group_id: string; name: string; kind: string;
  member_count?: number; member_ids: readonly string[];
}
interface FoxxiCatalog {
  course_id: string; title: string; category: string;
  audience_tags: readonly string[]; standard?: string;
  concept_count?: number; slide_count?: number; is_real?: boolean;
}
interface FoxxiAuditEntry {
  audit_id: string; timestamp: string; actor_user_id: string;
  action: string; target_type: string; target_id: string;
  result: string; reason?: string | null;
}
interface FoxxiConnection {
  id: string; kind: string; product: string; instance: string;
  status: string; auth_method: string; last_sync: string;
}
interface FoxxiAdminPayload {
  meta: { tenant: string; tenant_pod: string; tenant_did?: string; tenant_id: string };
  users: readonly FoxxiUser[];
  catalog: readonly FoxxiCatalog[];
  policies: readonly FoxxiPolicy[];
  groups: readonly FoxxiGroup[];
  audit: readonly FoxxiAuditEntry[];
  connections: readonly FoxxiConnection[];
  events?: readonly Record<string, unknown>[];
  coverage?: readonly Record<string, unknown>[];
}

let _adminCache: FoxxiAdminPayload | null = null;
function loadAdminPayload(): FoxxiAdminPayload {
  if (_adminCache) return _adminCache;
  const here = dirname(fileURLToPath(import.meta.url));
  const candidates = [
    resolve(here, '../imported/admin_payload.json'),
    resolve(here, '../../imported/admin_payload.json'),
    resolve(process.cwd(), 'applications/foxxi-content-intelligence/imported/admin_payload.json'),
  ];
  for (const p of candidates) {
    try { _adminCache = JSON.parse(readFileSync(p, 'utf8')) as FoxxiAdminPayload; return _adminCache; } catch { /* try next */ }
  }
  throw new Error('admin_payload.json not findable for hypermedia resources');
}

// ── Per-resource opaque ↔ slug lookup ──────────────────────────────

function buildLookup(): {
  user: { toOpaque: (s: string) => string; toSlug: (o: string) => string | null };
  course: { toOpaque: (s: string) => string; toSlug: (o: string) => string | null };
  policy: { toOpaque: (s: string) => string; toSlug: (o: string) => string | null };
  group: { toOpaque: (s: string) => string; toSlug: (o: string) => string | null };
  audit: { toOpaque: (s: string) => string; toSlug: (o: string) => string | null };
  integration: { toOpaque: (s: string) => string; toSlug: (o: string) => string | null };
} {
  const admin = loadAdminPayload();
  const make = <T>(kind: string, items: ReadonlyArray<T>, slugOf: (t: T) => string) => {
    const toOp = new Map<string, string>();
    const toSl = new Map<string, string>();
    for (const item of items) {
      const slug = slugOf(item);
      const op = opaqueId(kind, slug);
      toOp.set(slug, op);
      toSl.set(op, slug);
    }
    return {
      toOpaque: (s: string) => toOp.get(s) ?? opaqueId(kind, s),
      toSlug: (o: string) => toSl.get(o) ?? null,
    };
  };
  return {
    // Users are special: the opaque id is the wallet-derived UUID, not
    // a generic kind+slug hash. Override `make` for this collection.
    user: (() => {
      const toOp = new Map<string, string>();
      const toSl = new Map<string, string>();
      for (const u of admin.users) {
        const op = userIdToUuid(u.user_id);
        toOp.set(u.user_id, op);
        toSl.set(op, u.user_id);
      }
      return {
        toOpaque: (s: string) => toOp.get(s) ?? userIdToUuid(s),
        toSlug: (o: string) => toSl.get(o) ?? null,
      };
    })(),
    course: make('course', admin.catalog, c => c.course_id),
    policy: make('policy', admin.policies, p => p.policy_id),
    group: make('group', admin.groups, g => g.group_id),
    audit: make('audit-record', admin.audit, r => r.audit_id),
    integration: make('integration', admin.connections, i => i.id),
  };
}

// ── Hypermedia envelope helpers ─────────────────────────────────────

// Resource-scoped affordances — see docs/patterns/resource-scoped-affordances.md.
// Each resource advertises only the affordances applicable to it; the
// shared `affordancesFor` filter reads each affordance's `appliesTo`
// scope. The entry point is exempt — it is the one resource that SHOULD
// carry the whole catalogue (clients cache it once and look affordances
// up by tool name from there).

function bridgeAffordanceToLink(a: Affordance, baseUrl: string): Record<string, unknown> {
  return {
    rel: actionKey(a.action).split('/').pop(),   // the short verb, from either urn or URL form
    href: a.targetTemplate.replace('{base}', baseUrl),
    method: a.method,
    title: a.title,
    description: a.description,
    expects: a.inputs.map(i => ({ name: i.name, type: i.type, required: i.required, description: i.description })),
    mcpTool: a.toolName,
  };
}

function collectionEnvelope(args: {
  selfUrl: string;
  collectionName: string;
  items: unknown[];
  itemMapper: (item: unknown) => unknown;
  affordances: ReadonlyArray<Affordance>;
  baseUrl: string;
  total?: number;
  offset?: number;
  limit?: number;
}): Record<string, unknown> {
  const links: Record<string, unknown> = {
    self: { href: args.selfUrl },
    item: { href: `${args.selfUrl}/{id}`, templated: true },
  };
  if (args.offset !== undefined && args.limit !== undefined && args.total !== undefined) {
    if (args.offset + args.limit < args.total) {
      links.next = { href: `${args.selfUrl}?offset=${args.offset + args.limit}&limit=${args.limit}` };
    }
    if (args.offset > 0) {
      links.prev = { href: `${args.selfUrl}?offset=${Math.max(0, args.offset - args.limit)}&limit=${args.limit}` };
    }
  }
  return {
    '@context': {
      hydra: 'http://www.w3.org/ns/hydra/core#',
      foxxi: FOXXI_NS,
    },
    '@type': 'hydra:Collection',
    '@id': args.selfUrl,
    'hydra:totalItems': args.total ?? args.items.length,
    'hydra:member': args.items.map(args.itemMapper),
    _links: links,
    _affordances: affordancesFor({ collection: args.collectionName }, args.affordances)
      .map(a => bridgeAffordanceToLink(a, args.baseUrl)),
  };
}

function itemEnvelope(args: {
  selfUrl: string;
  collectionUrl: string;
  /** Collection this item belongs to ('courses', 'profiles', …) — drives
   *  resource-scoped affordance filtering. */
  collection: string;
  resource: Record<string, unknown>;
  affordances: ReadonlyArray<Affordance>;
  baseUrl: string;
  embedded?: Record<string, unknown>;
  /** The item's iep:modalStatus, when it carries one. */
  modalStatus?: string;
}): Record<string, unknown> {
  // Merge any resource-supplied _links (e.g. a course's templated
  // `launch` link) with the envelope's self/collection links — the
  // resource's links must survive, not be clobbered by the spread order.
  const { _links: resourceLinks, ...resourceRest } = args.resource as
    { _links?: Record<string, unknown> } & Record<string, unknown>;
  return {
    '@context': {
      hydra: 'http://www.w3.org/ns/hydra/core#',
      foxxi: FOXXI_NS,
    },
    '@id': args.selfUrl,
    ...resourceRest,
    _links: {
      self: { href: args.selfUrl },
      collection: { href: args.collectionUrl },
      ...(resourceLinks ?? {}),
    },
    _embedded: args.embedded,
    _affordances: affordancesFor({ collection: args.collection, modalStatus: args.modalStatus }, args.affordances)
      .map(a => bridgeAffordanceToLink(a, args.baseUrl)),
  };
}

function pagination(req: Request): { offset: number; limit: number } {
  const limit = Math.min(Number(req.query.limit) || 50, 500);
  const offset = Number(req.query.offset) || 0;
  return { offset, limit };
}

// ── Routes ──────────────────────────────────────────────────────────

export function attachHypermediaRoutes(app: Express, config: HypermediaConfig): void {
  const base = `${config.selfBaseUrl}/api/foxxi/v1`;
  const lookup = buildLookup();

  // ── Root entry point ─────────────────────────────────────────────
  // Bootstrap URI — single request returns the navigable map of all
  // top-level collections + the full affordance set (every bridge tool,
  // with its REST URL + expected inputs). SPA clients hit this on
  // launch and never hardcode URLs again — for either reads OR writes.
  app.get('/api/foxxi/v1', (_req, res) => {
    res.json({
      '@context': { hydra: 'http://www.w3.org/ns/hydra/core#' },
      '@id': base,
      '@type': 'hydra:EntryPoint',
      _links: {
        self: { href: base },
        profiles: { href: `${base}/profiles` },
        courses: { href: `${base}/courses` },
        policies: { href: `${base}/policies` },
        groups: { href: `${base}/groups` },
        'audit-records': { href: `${base}/audit-records` },
        integrations: { href: `${base}/integrations` },
        statements: { href: `${config.selfBaseUrl}/xapi/statements` },
        'statements-admin': { href: `${config.selfBaseUrl}/xapi/admin/statements`, templated: false, title: 'Admin statement browser (paginated, filterable)' },
        'statements-aggregates': { href: `${config.selfBaseUrl}/xapi/admin/aggregates` },
        'statements-conformance': { href: `${config.selfBaseUrl}/xapi/admin/conformance` },
        'lrs-config': { href: `${config.selfBaseUrl}/xapi/admin/config` },
        'launch-codes': { href: `${base}/launch-codes`, title: 'Mint a one-time out-of-band launch code (POST, bearer-authenticated)' },
        affordances: { href: `${config.selfBaseUrl}/affordances` },
        openapi: { href: `${config.selfBaseUrl}/openapi.json` },
        'foxxi-vocabulary': { href: `${config.selfBaseUrl}/ns/foxxi`, title: 'The Foxxi vocabulary — every foxxi term IRI dereferences here (JSON-LD / Turtle)' },
      },
      _affordances: config.affordances.map(a => bridgeAffordanceToLink(a, config.selfBaseUrl)),
    });
  });

  // ── Out-of-band launch-code exchange ─────────────────────────────
  // Keeps the long-lived session bearer out of player URLs (browser
  // history, Referer headers, proxy logs). The dashboard POSTs its
  // bearer here and receives a short-lived single-use code; the code
  // travels in the launch URL; the player exchanges code → bearer.
  // See docs/patterns/out-of-band-auth-exchange.md.
  interface LaunchCodeRec { bearer: string; expiresAt: number }
  const launchCodes = new Map<string, LaunchCodeRec>();
  const LAUNCH_CODE_TTL_MS = 120_000; // 2 minutes — long enough to open a tab
  const LAUNCH_CODE_MAX = 10_000;     // unbounded-growth / DoS cap
  const sweepLaunchCodes = (): void => {
    const now = Date.now();
    for (const [c, rec] of launchCodes) if (rec.expiresAt <= now) launchCodes.delete(c);
  };

  // Mint — bearer-authenticated. The bearer is stored opaquely; its
  // validity is enforced downstream when the player actually calls xAPI.
  app.post('/api/foxxi/v1/launch-codes', (req, res) => {
    const m = /^Bearer\s+(.+)$/i.exec(req.headers.authorization ?? '');
    if (!m) {
      res.status(401).json({ error: 'launch-code mint requires Authorization: Bearer <session>' });
      return;
    }
    sweepLaunchCodes();
    if (launchCodes.size >= LAUNCH_CODE_MAX) {
      res.status(503).json({ error: 'launch-code store at capacity — retry shortly' });
      return;
    }
    const code = randomBytes(24).toString('base64url');
    launchCodes.set(code, { bearer: m[1]!, expiresAt: Date.now() + LAUNCH_CODE_TTL_MS });
    res.json({
      code,
      exchangeUrl: `${base}/launch-codes/${code}`,
      method: 'POST',
      expiresIn: LAUNCH_CODE_TTL_MS / 1000,
    });
  });

  // Exchange — the code IS the credential; no Authorization header. The
  // code is single-use: deleted on first read whether or not it had
  // expired, so a leaked code is spent the instant it is replayed.
  app.post('/api/foxxi/v1/launch-codes/:code', (req, res) => {
    sweepLaunchCodes();
    const rec = launchCodes.get(req.params.code);
    launchCodes.delete(req.params.code); // single-use — consume unconditionally
    if (!rec) {
      res.status(404).json({ error: 'launch code not found, already used, or expired' });
      return;
    }
    if (rec.expiresAt <= Date.now()) {
      res.status(410).json({ error: 'launch code expired' });
      return;
    }
    res.json({ bearer: rec.bearer });
  });

  // ── Profiles ─────────────────────────────────────────────────────
  app.get('/api/foxxi/v1/profiles', (req, res) => {
    const admin = loadAdminPayload();
    const { offset, limit } = pagination(req);
    const items = admin.users.slice(offset, offset + limit);
    res.json(collectionEnvelope({
      selfUrl: `${base}/profiles`,
      collectionName: 'profiles',
      items,
      itemMapper: (u) => {
        const user = u as FoxxiUser;
        const id = lookup.user.toOpaque(user.user_id);
        return {
          '@id': `${base}/profiles/${id}`,
          ...user,
          id, // opaque uuid (wallet-derived)
          _links: { self: { href: `${base}/profiles/${id}` } },
        };
      },
      affordances: config.affordances,
      baseUrl: config.selfBaseUrl,
      total: admin.users.length, offset, limit,
    }));
  });
  app.get('/api/foxxi/v1/profiles/:opaqueId', (req, res) => {
    const admin = loadAdminPayload();
    const slug = lookup.user.toSlug(req.params.opaqueId);
    if (!slug) { res.status(404).json({ error: 'profile not found' }); return; }
    const user = admin.users.find(u => u.user_id === slug);
    if (!user) { res.status(404).json({ error: 'profile not found' }); return; }
    // Resolve which enabled policies' audience groups this learner belongs to.
    const enrollments = admin.policies
      .filter(p => p.enabled && admin.groups.find(g => g.group_id === p.audience_group_id && g.member_ids.includes(slug)))
      .map(p => {
        const catEntry = admin.catalog.find(c => c.course_id === p.course_id);
        const ev = (admin.events ?? []).find(
          e => (e as { user_id?: string; course_id?: string }).user_id === slug
            && (e as { user_id?: string; course_id?: string }).course_id === p.course_id,
        ) as undefined | { assigned_at?: string; due_at?: string; status?: string; completed_at?: string | null };
        // Modal status (iep:modalStatus) of the enrollment record itself:
        //   Asserted     — backed by a real lifecycle event in admin.events
        //                  (the learner was actually assigned / progressed /
        //                  completed; this is observed fact).
        //   Hypothetical — no event exists; the enrollment is *inferred*
        //                  purely from policy-audience-group membership.
        //                  It predicts "this learner should see this course"
        //                  but nothing has been recorded yet.
        // Surfacing this lets the UI distinguish observed assignments from
        // predicted ones rather than presenting both as equally certain.
        const modalStatus: 'Asserted' | 'Hypothetical' = ev ? 'Asserted' : 'Hypothetical';
        // Same shape the dashboard's EnrolledCourse expects, plus _links.
        return {
          '@id': `${base}/policies/${lookup.policy.toOpaque(p.policy_id)}`,
          policyId: p.policy_id,
          courseId: p.course_id,
          courseTitle: p.course_title ?? catEntry?.title ?? p.course_id,
          category: catEntry?.category ?? '—',
          requirementType: p.requirement_type,
          assignedAt: ev?.assigned_at ?? p.created_at,
          dueAt: ev?.due_at ?? '',
          status: (ev?.status as 'pending' | 'completed' | 'overdue' | undefined) ?? 'pending',
          completedAt: ev?.completed_at ?? undefined,
          modalStatus,
          _links: {
            self: { href: `${base}/policies/${lookup.policy.toOpaque(p.policy_id)}` },
            course: { href: `${base}/courses/${lookup.course.toOpaque(p.course_id)}` },
            group: { href: `${base}/groups/${lookup.group.toOpaque(p.audience_group_id)}` },
            ...(config.scormPlayerBaseUrl && PLAYABLE_COURSE_IDS.has(p.course_id) ? {
              launch: launchLink(config.scormPlayerBaseUrl, config.selfBaseUrl, p.course_id),
            } : {}),
          },
        };
      });
    res.json(itemEnvelope({
      selfUrl: `${base}/profiles/${req.params.opaqueId}`,
      collectionUrl: `${base}/profiles`,
      collection: 'profiles',
      resource: {
        id: req.params.opaqueId,
        ...user,
      },
      // Embedded count + a self-link to enrollments help the client know
      // what's available without re-walking the policy index.
      embedded: {
        enrollments,
        enrollmentsCount: enrollments.length,
        audienceTags: user.audience_tags,
      },
      affordances: config.affordances,
      baseUrl: config.selfBaseUrl,
    }));
  });

  // ── Courses ──────────────────────────────────────────────────────
  app.get('/api/foxxi/v1/courses', (req, res) => {
    const admin = loadAdminPayload();
    const { offset, limit } = pagination(req);
    const items = admin.catalog.slice(offset, offset + limit);
    res.json(collectionEnvelope({
      selfUrl: `${base}/courses`,
      collectionName: 'courses',
      items,
      itemMapper: (c) => {
        const course = c as FoxxiCatalog;
        const id = lookup.course.toOpaque(course.course_id);
        return {
          '@id': `${base}/courses/${id}`,
          ...course, // includes course_id (the slug, useful for legacy data lookups)
          id,        // opaque uuid — the canonical URL identifier
          _links: { self: { href: `${base}/courses/${id}` } },
        };
      },
      affordances: config.affordances,
      baseUrl: config.selfBaseUrl,
      total: admin.catalog.length, offset, limit,
    }));
  });
  app.get('/api/foxxi/v1/courses/:opaqueId', (req, res) => {
    const admin = loadAdminPayload();
    const slug = lookup.course.toSlug(req.params.opaqueId);
    if (!slug) { res.status(404).json({ error: 'course not found' }); return; }
    const course = admin.catalog.find(c => c.course_id === slug);
    if (!course) { res.status(404).json({ error: 'course not found' }); return; }
    const policies = admin.policies
      .filter(p => p.course_id === slug)
      .map(p => ({
        '@id': `${base}/policies/${lookup.policy.toOpaque(p.policy_id)}`,
        requirement_type: p.requirement_type,
        audience_group_id: p.audience_group_id,
        _links: { self: { href: `${base}/policies/${lookup.policy.toOpaque(p.policy_id)}` } },
      }));
    const courseLinks: Record<string, TemplatedLink | { href: string }> = {};
    if (config.scormPlayerBaseUrl && PLAYABLE_COURSE_IDS.has(slug)) {
      courseLinks.launch = launchLink(config.scormPlayerBaseUrl, config.selfBaseUrl, slug);
    }
    res.json(itemEnvelope({
      selfUrl: `${base}/courses/${req.params.opaqueId}`,
      collectionUrl: `${base}/courses`,
      collection: 'courses',
      resource: { id: req.params.opaqueId, ...course, ...(Object.keys(courseLinks).length ? { _links: courseLinks } : {}) },
      embedded: { policies },
      affordances: config.affordances,
      baseUrl: config.selfBaseUrl,
    }));
  });

  // ── Policies ────────────────────────────────────────────────────
  app.get('/api/foxxi/v1/policies', (req, res) => {
    const admin = loadAdminPayload();
    const { offset, limit } = pagination(req);
    const items = admin.policies.slice(offset, offset + limit);
    res.json(collectionEnvelope({
      selfUrl: `${base}/policies`,
      collectionName: 'policies',
      items,
      itemMapper: (p) => {
        const policy = p as FoxxiPolicy;
        const id = lookup.policy.toOpaque(policy.policy_id);
        return {
          '@id': `${base}/policies/${id}`,
          ...policy,
          id, // opaque uuid
          _links: {
            self: { href: `${base}/policies/${id}` },
            course: { href: `${base}/courses/${lookup.course.toOpaque(policy.course_id)}` },
            group: { href: `${base}/groups/${lookup.group.toOpaque(policy.audience_group_id)}` },
          },
        };
      },
      affordances: config.affordances,
      baseUrl: config.selfBaseUrl,
      total: admin.policies.length, offset, limit,
    }));
  });
  app.get('/api/foxxi/v1/policies/:opaqueId', (req, res) => {
    const admin = loadAdminPayload();
    const slug = lookup.policy.toSlug(req.params.opaqueId);
    if (!slug) { res.status(404).json({ error: 'policy not found' }); return; }
    const policy = admin.policies.find(p => p.policy_id === slug);
    if (!policy) { res.status(404).json({ error: 'policy not found' }); return; }
    res.json(itemEnvelope({
      selfUrl: `${base}/policies/${req.params.opaqueId}`,
      collectionUrl: `${base}/policies`,
      collection: 'policies',
      resource: { id: req.params.opaqueId, ...policy },
      affordances: config.affordances,
      baseUrl: config.selfBaseUrl,
    }));
  });

  // ── Groups ──────────────────────────────────────────────────────
  app.get('/api/foxxi/v1/groups', (req, res) => {
    const admin = loadAdminPayload();
    const { offset, limit } = pagination(req);
    const items = admin.groups.slice(offset, offset + limit);
    res.json(collectionEnvelope({
      selfUrl: `${base}/groups`,
      collectionName: 'groups',
      items,
      itemMapper: (g) => {
        const group = g as FoxxiGroup;
        const id = lookup.group.toOpaque(group.group_id);
        return {
          '@id': `${base}/groups/${id}`,
          ...group,
          member_count: group.member_count ?? group.member_ids.length,
          id, // opaque uuid
          _links: { self: { href: `${base}/groups/${id}` } },
        };
      },
      affordances: config.affordances,
      baseUrl: config.selfBaseUrl,
      total: admin.groups.length, offset, limit,
    }));
  });
  app.get('/api/foxxi/v1/groups/:opaqueId', (req, res) => {
    const admin = loadAdminPayload();
    const slug = lookup.group.toSlug(req.params.opaqueId);
    if (!slug) { res.status(404).json({ error: 'group not found' }); return; }
    const group = admin.groups.find(g => g.group_id === slug);
    if (!group) { res.status(404).json({ error: 'group not found' }); return; }
    const members = group.member_ids.map(mid => ({
      '@id': `${base}/profiles/${lookup.user.toOpaque(mid)}`,
      _links: { self: { href: `${base}/profiles/${lookup.user.toOpaque(mid)}` } },
    }));
    res.json(itemEnvelope({
      selfUrl: `${base}/groups/${req.params.opaqueId}`,
      collectionUrl: `${base}/groups`,
      collection: 'groups',
      resource: { id: req.params.opaqueId, ...group, member_ids: undefined },
      embedded: { members },
      affordances: config.affordances,
      baseUrl: config.selfBaseUrl,
    }));
  });

  // ── Audit records ───────────────────────────────────────────────
  app.get('/api/foxxi/v1/audit-records', (req, res) => {
    const admin = loadAdminPayload();
    const { offset, limit } = pagination(req);
    const items = admin.audit.slice(offset, offset + limit);
    res.json(collectionEnvelope({
      selfUrl: `${base}/audit-records`,
      collectionName: 'audit-records',
      items,
      itemMapper: (r) => {
        const rec = r as FoxxiAuditEntry;
        const id = lookup.audit.toOpaque(rec.audit_id);
        return {
          '@id': `${base}/audit-records/${id}`,
          ...rec,
          id, // opaque uuid
          actor: { user_id: rec.actor_user_id, '@id': `${base}/profiles/${lookup.user.toOpaque(rec.actor_user_id)}` },
          _links: {
            self: { href: `${base}/audit-records/${id}` },
            actor: { href: `${base}/profiles/${lookup.user.toOpaque(rec.actor_user_id)}` },
          },
        };
      },
      affordances: config.affordances,
      baseUrl: config.selfBaseUrl,
      total: admin.audit.length, offset, limit,
    }));
  });
  app.get('/api/foxxi/v1/audit-records/:opaqueId', (req, res) => {
    const admin = loadAdminPayload();
    const slug = lookup.audit.toSlug(req.params.opaqueId);
    if (!slug) { res.status(404).json({ error: 'audit record not found' }); return; }
    const rec = admin.audit.find(r => r.audit_id === slug);
    if (!rec) { res.status(404).json({ error: 'audit record not found' }); return; }
    res.json(itemEnvelope({
      selfUrl: `${base}/audit-records/${req.params.opaqueId}`,
      collectionUrl: `${base}/audit-records`,
      collection: 'audit-records',
      resource: { id: req.params.opaqueId, ...rec },
      affordances: config.affordances,
      baseUrl: config.selfBaseUrl,
    }));
  });

  // ── Integrations ─────────────────────────────────────────────────
  app.get('/api/foxxi/v1/integrations', (req, res) => {
    const admin = loadAdminPayload();
    const { offset, limit } = pagination(req);
    const items = admin.connections.slice(offset, offset + limit);
    res.json(collectionEnvelope({
      selfUrl: `${base}/integrations`,
      collectionName: 'integrations',
      items,
      itemMapper: (c) => {
        const conn = c as FoxxiConnection;
        const id = lookup.integration.toOpaque(conn.id);
        return {
          '@id': `${base}/integrations/${id}`,
          ...conn,
          id, // opaque uuid (overwrites the internal id with the opaque form)
          _links: { self: { href: `${base}/integrations/${id}` } },
        };
      },
      affordances: config.affordances,
      baseUrl: config.selfBaseUrl,
      total: admin.connections.length, offset, limit,
    }));
  });
  app.get('/api/foxxi/v1/integrations/:opaqueId', (req, res) => {
    const admin = loadAdminPayload();
    const slug = lookup.integration.toSlug(req.params.opaqueId);
    if (!slug) { res.status(404).json({ error: 'integration not found' }); return; }
    const conn = admin.connections.find(c => c.id === slug);
    if (!conn) { res.status(404).json({ error: 'integration not found' }); return; }
    res.json(itemEnvelope({
      selfUrl: `${base}/integrations/${req.params.opaqueId}`,
      collectionUrl: `${base}/integrations`,
      collection: 'integrations',
      resource: { ...conn, id: req.params.opaqueId },
      affordances: config.affordances,
      baseUrl: config.selfBaseUrl,
    }));
  });
}
