/**
 * A reusable personal cmi5 launch link.
 *
 * `POST /agent/cmi5/launch` hands back one launch URL. Its fetch token is single-use and expires
 * after 30 minutes (cmi5 §8), so a trainee who closes the tab cannot get back in. This mints a
 * durable link instead — `GET /cmi5/go/<token>` — for one learner and one course. Each open builds
 * a fresh launch (a new fetch token, and a new registration once the previous session has ended)
 * and redirects to the AU. While that session is still open, the same registration and session id
 * are continued, which is what keeps suspend data and the xAPI registration together (cmi5 §9.3).
 *
 * The token is unguessable and is the whole of the URL: the learner's identifier is not in it.
 * Nothing here names a course or a person. The course is whatever published course the signed
 * request names, and the actor is whoever the signature is. Which activity opens, and its moveOn,
 * mastery and entitlement, are that course's own structure. The launch itself is the bridge's
 * cmi5 launch. The link is kept and withdrawn the same way a dispatch is.
 * The signer who minted it, and only that actor, can withdraw it.
 *
 * Layer: L3 vertical. No new ontology term.
 */
import { randomBytes } from 'node:crypto';
import type { Express, Request, Response } from 'express';
import { rateLimit } from 'express-rate-limit';
import { buildCmi5Launch, chooseAu, findResumableLaunch, serializeKeyed, whenCmi5Ready, type Cmi5Launch } from './cmi5-lms.js';
import type { Cmi5Course } from './cmi5-course.js';
import type { TenantId } from './tenant-context.js';
import { htmlEscape } from './lti-player.js';
import { earlierMark, laterMark, perAddressLimiter, requestAddress, tighterExpiry, withdrawalState } from './revocable-registry.js';
export { readDurableRegistry } from './revocable-registry.js';

export const PERSONAL_LAUNCH_TOKEN = /^pl-[A-Za-z0-9_-]{43}$/;
export const DEFAULT_LINK_DAYS = 90;
export const MAX_LINK_DAYS = 3650;
const DAY_MS = 24 * 60 * 60 * 1000;

export interface PersonalLaunchLink {
  readonly id: string;
  readonly actorDid: string;
  readonly courseId: string;
  readonly auId?: string;
  readonly returnUrl?: string;
  readonly learnerPod: string;
  readonly createdAt: string;
  readonly expiresAt?: string;
  revokedAt?: string;
  readonly mintedBy: string;
  opens: number;
  lastOpenAt?: string;
}

export type PersonalLinkState = 'live' | 'revoked' | 'expired';

export function personalLinkState(link: PersonalLaunchLink, now: number): PersonalLinkState {
  return withdrawalState(link, now);
}

/** Two copies of one link: the earlier withdrawal, the earlier expiry, the larger open count. */
export function mergePersonalLink(a: PersonalLaunchLink, b: PersonalLaunchLink): PersonalLaunchLink {
  const revokedAt = earlierMark(a.revokedAt, b.revokedAt);
  const lastOpenAt = laterMark(a.lastOpenAt, b.lastOpenAt);
  const expiresAt = tighterExpiry(a.expiresAt, b.expiresAt);
  return {
    ...a,
    opens: Math.max(a.opens, b.opens),
    ...(expiresAt ? { expiresAt } : {}),
    ...(revokedAt ? { revokedAt } : {}),
    ...(lastOpenAt ? { lastOpenAt: lastOpenAt } : {}),
  };
}

function validLink(v: unknown): v is PersonalLaunchLink {
  if (!v || typeof v !== 'object') return false;
  const d = v as Record<string, unknown>;
  return typeof d.id === 'string' && PERSONAL_LAUNCH_TOKEN.test(d.id)
    && typeof d.actorDid === 'string' && d.actorDid.length > 0 && d.actorDid.length <= 500
    && typeof d.courseId === 'string' && d.courseId.length > 0 && d.courseId.length <= 2000
    && typeof d.learnerPod === 'string' && d.learnerPod.length > 0 && d.learnerPod.length <= 2000
    && typeof d.createdAt === 'string' && typeof d.mintedBy === 'string'
    && typeof d.opens === 'number' && Number.isFinite(d.opens) && d.opens >= 0
    && (d.auId === undefined || (typeof d.auId === 'string' && d.auId.length <= 2000))
    && (d.returnUrl === undefined || (typeof d.returnUrl === 'string' && d.returnUrl.length <= 2000))
    && (d.expiresAt === undefined || typeof d.expiresAt === 'string')
    && (d.revokedAt === undefined || typeof d.revokedAt === 'string')
    && (d.lastOpenAt === undefined || typeof d.lastOpenAt === 'string');
}

/**
 * Every personal launch link this bridge has minted. Bounded, and never by dropping a live link.
 * A learner's quota counts links that still launch. Withdrawn and expired links stay, so a later
 * merge keeps the withdrawal, and they do not count toward that quota. The registry as a whole
 * stops growing once it holds `max` records, withdrawn ones included.
 */
export class PersonalLaunchRegistry {
  private readonly byId = new Map<string, PersonalLaunchLink>();
  /** Set when something changed that the durable copy does not hold yet. */
  dirty = false;
  constructor(private readonly max = 50_000, private readonly perActor = 100) {}

  create(input: {
    actorDid: string; courseId: string; learnerPod: string; mintedBy: string;
    auId?: string; returnUrl?: string; expiresAt?: string;
  }, now: number): PersonalLaunchLink | { refused: string } {
    if (this.byId.size >= this.max) return { refused: 'this bridge holds as many personal launch links as it can' };
    const live = this.forActor(input.actorDid).filter(l => personalLinkState(l, now) === 'live').length;
    if (live >= this.perActor) return { refused: `a learner may hold ${this.perActor} personal launch links; withdraw one you no longer need` };
    const link: PersonalLaunchLink = {
      id: `pl-${randomBytes(32).toString('base64url')}`,
      actorDid: input.actorDid, courseId: input.courseId, learnerPod: input.learnerPod, mintedBy: input.mintedBy,
      createdAt: new Date(now).toISOString(),
      ...(input.auId ? { auId: input.auId } : {}),
      ...(input.returnUrl ? { returnUrl: input.returnUrl } : {}),
      ...(input.expiresAt ? { expiresAt: input.expiresAt } : {}),
      opens: 0,
    };
    this.byId.set(link.id, link);
    this.dirty = true;
    return link;
  }
  get(id: string): PersonalLaunchLink | undefined { return this.byId.get(id); }
  forActor(actorDid: string): PersonalLaunchLink[] { return [...this.byId.values()].filter(l => l.actorDid === actorDid); }
  revoke(id: string, now: number): void {
    const link = this.byId.get(id);
    if (link && !link.revokedAt) { link.revokedAt = new Date(now).toISOString(); this.dirty = true; }
  }
  noteOpen(id: string, now: number): void {
    const link = this.byId.get(id);
    if (!link) return;
    link.opens++;
    link.lastOpenAt = new Date(now).toISOString();
    this.dirty = true;
  }
  toJSON(): Record<string, PersonalLaunchLink> { return Object.fromEntries(this.byId); }
  /** Take in a durable copy, merging with what this process holds. Malformed entries are skipped. */
  load(json: unknown): number {
    if (!json || typeof json !== 'object') return 0;
    let n = 0;
    for (const v of Object.values(json as Record<string, unknown>)) {
      if (!validLink(v)) continue;
      const held = this.byId.get(v.id);
      this.byId.set(v.id, held ? mergePersonalLink(held, v) : { ...v });
      n++;
    }
    return n;
  }
  get size(): number { return this.byId.size; }
}

/** What the signer sees of a link. The URL carries the token and nothing about the actor. */
export function personalLinkView(link: PersonalLaunchLink, baseUrl: string, now: number): Record<string, unknown> {
  const base = baseUrl.replace(/\/$/, '');
  return {
    token: link.id,
    url: `${base}/cmi5/go/${link.id}`,
    courseId: link.courseId,
    ...(link.auId ? { auId: link.auId } : {}),
    ...(link.returnUrl ? { returnUrl: link.returnUrl } : {}),
    learner: link.actorDid,
    ...(link.mintedBy !== link.actorDid ? { via: link.mintedBy } : {}),
    createdAt: link.createdAt,
    ...(link.expiresAt ? { expiresAt: link.expiresAt } : {}),
    ...(link.revokedAt ? { revokedAt: link.revokedAt } : {}),
    state: personalLinkState(link, now),
    opens: link.opens,
    ...(link.lastOpenAt ? { lastOpenAt: link.lastOpenAt } : {}),
  };
}

export interface SignedCaller {
  ok: true;
  callerDid: string;
  payload: Record<string, unknown>;
}
export interface PersonalLaunchRouteDeps {
  readonly baseUrl: string;
  readonly registry: PersonalLaunchRegistry;
  /** The LRS the AU posts to. Defaults to `<base>/xapi`. */
  readonly lrsEndpoint?: string;
  /** The xAPI account homePage stamped on the actor. */
  readonly authoritativeSource: string;
  verifyCaller(body: unknown): Promise<SignedCaller | { ok: false; status: number; error: string }>;
  /** Who the signature is learning as. A named learner in the payload is not consulted. */
  learnerOf(auth: { callerDid: string }): Promise<{ did: string; podUrl: string; via?: string }>;
  tenantFor(learner: { did: string; podUrl: string }): TenantId;
  resolveCourse(courseId: string): Promise<Cmi5Course | null>;
  satisfiedAus(tenant: TenantId, learnerId: string): readonly string[];
  stageLaunch(tenant: TenantId, launch: Cmi5Launch, auId: string): Promise<void>;
  /** The limit on the signer's mint and revoke calls (the bridge's agentic limit). */
  rateLimit(ip: string): { ok: true } | { ok: false; retryAfterSeconds: number };
  /** Opens a minute, per address and per token. Defaults: 60 and 12. */
  opensPerMinute?: number;
  opensPerTokenPerMinute?: number;
  /** Read the durable registry again when a token is not in this process. */
  reload?(): Promise<void>;
  persist(): void;
  now?: () => number;
  serverError?: (res: Response, err: unknown, where: string) => void;
}

const openings = new Map<string, Promise<unknown>>();

function wantsJson(req: Request): boolean {
  return req.accepts(['html', 'json']) === 'json';
}

function htmlPage(message: string): string {
  return `<!DOCTYPE html><html lang="en"><head><meta charset="utf-8"><meta name="referrer" content="no-referrer"><title>Launch link</title></head><body><p>${htmlEscape(message)}</p></body></html>`;
}

function isPrefetch(req: Request): boolean {
  const purpose = `${req.get('sec-purpose') ?? ''} ${req.get('purpose') ?? ''}`.toLowerCase();
  return purpose.includes('prefetch') || purpose.includes('preview');
}

const STATE_WORDS: Record<Exclude<PersonalLinkState, 'live'>, string> = {
  revoked: 'This launch link has been withdrawn. Ask for a new one.',
  expired: 'This launch link has expired. Ask for a new one.',
};

function tokenFrom(value: unknown): string {
  if (typeof value !== 'string') return '';
  const trimmed = value.trim();
  if (PERSONAL_LAUNCH_TOKEN.test(trimmed)) return trimmed;
  try {
    const part = new URL(trimmed).pathname.split('/').filter(Boolean).at(-1) ?? '';
    if (PERSONAL_LAUNCH_TOKEN.test(part)) return part;
  } catch { /* not a URL */ }
  return '';
}

function expiryFrom(value: unknown, now: number): { ok: true; expiresAt?: string } | { ok: false; error: string } {
  if (value === undefined) return { ok: true, expiresAt: new Date(now + DEFAULT_LINK_DAYS * DAY_MS).toISOString() };
  if (value === null) return { ok: true };
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 1 || value > MAX_LINK_DAYS) {
    return { ok: false, error: `expires_in_days must be a whole number from 1 to ${MAX_LINK_DAYS}, or null for a link that does not expire` };
  }
  return { ok: true, expiresAt: new Date(now + value * DAY_MS).toISOString() };
}

/**
 * The personal-link surface:
 *   POST /agent/cmi5/go          signed: mint a link for the signer and one course
 *   POST /agent/cmi5/go/revoke   signed: that learner withdraws it
 *   GET  /cmi5/go/:token         each open launches, or resumes, and redirects to the AU
 */
export function attachPersonalLaunchRoutes(app: Express, deps: PersonalLaunchRouteDeps): void {
  const now = deps.now ?? Date.now;
  const base = deps.baseUrl.replace(/\/$/, '');
  const lrsEndpoint = deps.lrsEndpoint ?? `${base}/xapi`;
  const failed = deps.serverError ?? ((res: Response) => { if (!res.headersSent) res.status(500).json({ error: 'internal error' }); });
  const byAddress = perAddressLimiter(deps.opensPerMinute ?? 60, 60_000, now);
  const byToken = perAddressLimiter(deps.opensPerTokenPerMinute ?? 12, 60_000, now);

  const limited = (req: Request, res: Response): boolean => {
    const rl = deps.rateLimit(requestAddress(req));
    if (rl.ok) return false;
    res.set('Retry-After', String(rl.retryAfterSeconds));
    res.status(429).json({ error: `rate limit — retry in ${rl.retryAfterSeconds}s` });
    return true;
  };

  const known = async (id: string): Promise<PersonalLaunchLink | undefined> => {
    let link = deps.registry.get(id);
    if (!link && deps.reload && PERSONAL_LAUNCH_TOKEN.test(id)) { await deps.reload(); link = deps.registry.get(id); }
    return link;
  };

  // Ahead of the signature check, on the route itself. The handler's own limit is the shared
  // agentic budget; this one refuses a burst before that check runs.
  const signedRouteLimit = rateLimit({
    windowMs: 5 * 60 * 1000, limit: 120, ipv6Subnet: 56, identifier: 'cmi5-personal-launch',
    standardHeaders: 'draft-8', legacyHeaders: false, message: { error: 'too_many_requests' },
  });

  app.post('/agent/cmi5/go', signedRouteLimit, async (req, res) => {
    try {
      if (limited(req, res)) return;
      const auth = await deps.verifyCaller(req.body);
      if (!auth.ok) { res.status(auth.status).json({ error: auth.error }); return; }
      const courseId = typeof auth.payload.course_id === 'string' ? auth.payload.course_id.trim() : '';
      if (!courseId || courseId.length > 2000) { res.status(400).json({ error: 'course_id is required: a cmi5 course published on this bridge' }); return; }
      const course = await deps.resolveCourse(courseId);
      if (!course) { res.status(404).json({ error: `no cmi5 course ${courseId} is published on this bridge` }); return; }
      const auId = typeof auth.payload.au_id === 'string' ? auth.payload.au_id.trim() : '';
      if (auId) {
        if (auId.length > 2000) { res.status(400).json({ error: 'au_id is not an activity in that course' }); return; }
        const choice = chooseAu(course, new Set(), auId);
        // A later AU may be minted before its predecessor is satisfied; opening it is what gates.
        if (!choice.ok && choice.status === 404) { res.status(404).json({ error: choice.error }); return; }
      }
      let returnUrl: string | undefined;
      if (auth.payload.return_url !== undefined) {
        if (typeof auth.payload.return_url !== 'string' || !/^https?:\/\//.test(auth.payload.return_url) || auth.payload.return_url.length > 2000) {
          res.status(400).json({ error: 'return_url must be an http(s) URL' }); return;
        }
        returnUrl = auth.payload.return_url;
      }
      const expiry = expiryFrom(auth.payload.expires_in_days, now());
      if (!expiry.ok) { res.status(400).json({ error: expiry.error }); return; }
      const learner = await deps.learnerOf(auth);
      const link = deps.registry.create({
        actorDid: learner.did, courseId: course.id, learnerPod: learner.podUrl, mintedBy: auth.callerDid,
        ...(auId ? { auId } : {}), ...(returnUrl ? { returnUrl } : {}), ...(expiry.expiresAt ? { expiresAt: expiry.expiresAt } : {}),
      }, now());
      if ('refused' in link) { res.status(503).json({ error: link.refused }); return; }
      deps.persist();
      res.status(201).json({
        kind: 'cmi5-personal-launch',
        ...personalLinkView(link, base, now()),
        ...(learner.via ? { via: learner.via } : {}),
        note: 'Give the learner url. It carries no name and no identifier of theirs. Each open starts a cmi5 launch, or continues the one still open, and redirects to the activity. Withdraw it with POST /agent/cmi5/go/revoke.',
      });
    } catch (err) { failed(res, err, 'cmi5-personal-launch'); }
  });

  app.post('/agent/cmi5/go/revoke', signedRouteLimit, async (req, res) => {
    try {
      if (limited(req, res)) return;
      const auth = await deps.verifyCaller(req.body);
      if (!auth.ok) { res.status(auth.status).json({ error: auth.error }); return; }
      const token = tokenFrom(auth.payload.token);
      if (!token) { res.status(400).json({ error: 'token is required: the personal launch link\'s token, or its URL' }); return; }
      const learner = await deps.learnerOf(auth);
      const link = await known(token);
      // Someone else's link answers exactly as an absent one does.
      if (!link || link.actorDid !== learner.did) { res.status(404).json({ error: 'no such launch link of yours' }); return; }
      deps.registry.revoke(token, now());
      deps.persist();
      res.json({
        kind: 'cmi5-personal-launch',
        ...personalLinkView(link, base, now()),
        note: 'Withdrawn: the link no longer launches. A session already open may finish.',
      });
    } catch (err) { failed(res, err, 'cmi5-personal-launch-revoke'); }
  });

  const sendGone = (req: Request, res: Response, status: number, message: string, state?: PersonalLinkState): void => {
    res.set('Cache-Control', 'no-store').set('Referrer-Policy', 'no-referrer');
    if (wantsJson(req)) res.status(status).json({ error: message, ...(state && state !== 'live' ? { state } : {}) });
    else res.status(status).type('html').set('Content-Security-Policy', "default-src 'none'").send(htmlPage(message));
  };

  app.get('/cmi5/go/:token', async (req, res) => {
    try {
      res.set('Cache-Control', 'no-store').set('Referrer-Policy', 'no-referrer').set('X-Robots-Tag', 'noindex, nofollow');
      const token = String(req.params.token ?? '');
      const address = byAddress(requestAddress(req));
      if (!address.ok) {
        res.set('Retry-After', String(address.retryAfterSeconds));
        sendGone(req, res, 429, `Too many opens from this address. Try again in ${address.retryAfterSeconds}s.`);
        return;
      }
      if (!PERSONAL_LAUNCH_TOKEN.test(token)) { sendGone(req, res, 404, 'This launch link is not recognized.'); return; }
      const link = await known(token);
      if (!link) { sendGone(req, res, 404, 'This launch link is not recognized.'); return; }
      const state = personalLinkState(link, now());
      if (state !== 'live') { sendGone(req, res, 410, STATE_WORDS[state], state); return; }
      // A preview or a HEAD must not mint a fetch token the learner then finds already spent,
      // and must not spend the link's own open budget.
      if (req.method === 'HEAD' || isPrefetch(req)) { res.status(req.method === 'HEAD' ? 200 : 204).end(); return; }
      const tokenBudget = byToken(token);
      if (!tokenBudget.ok) {
        res.set('Retry-After', String(tokenBudget.retryAfterSeconds));
        sendGone(req, res, 429, `Too many opens of this link. Try again in ${tokenBudget.retryAfterSeconds}s.`);
        return;
      }

      await whenCmi5Ready();
      const course = await deps.resolveCourse(link.courseId);
      if (!course) { sendGone(req, res, 404, 'This course is not available.'); return; }
      const tenant = deps.tenantFor({ did: link.actorDid, podUrl: link.learnerPod });
      const satisfied = new Set(deps.satisfiedAus(tenant, link.actorDid));
      const choice = chooseAu(course, satisfied, link.auId);
      if (!choice.ok) { sendGone(req, res, choice.status, choice.error); return; }
      const au = choice.au;
      let auUrl: string;
      try { auUrl = new URL(au.url, `${base}/`).toString(); }
      catch { sendGone(req, res, 404, 'This course has no launchable address.'); return; }
      if (!/^https?:\/\//i.test(auUrl)) { sendGone(req, res, 404, 'This course has no launchable address.'); return; }

      const opened = await serializeKeyed(openings, `${link.actorDid}\n${course.id}\n${au.id}`, async () => {
        const prior = findResumableLaunch({ tenant, learnerId: link.actorDid, courseId: course.id, auId: au.id });
        const launch = buildCmi5Launch({
          au: {
            id: au.id, url: auUrl, moveOn: au.moveOn, title: au.title,
            ...(typeof au.masteryScore === 'number' ? { masteryScore: au.masteryScore } : {}),
            ...(au.entitlementKey ? { entitlementKey: au.entitlementKey } : {}),
          },
          learner: { id: link.actorDid },
          lrsEndpoint,
          fetchBaseUrl: `${base}/cmi5/fetch`,
          authoritativeSource: deps.authoritativeSource,
          tenant,
          courseId: course.id,
          learnerPod: link.learnerPod,
          ...(prior ? { resume: prior } : { launchMode: satisfied.has(au.id) ? 'Review' as const : 'Normal' as const }),
          ...(link.returnUrl ? { returnUrl: link.returnUrl } : {}),
        });
        await deps.stageLaunch(tenant, launch, au.id);
        return { launch, resumed: !!prior && launch.registration === prior.registration, au };
      });
      deps.registry.noteOpen(link.id, now());
      deps.persist();
      if (wantsJson(req)) {
        res.json({
          kind: 'cmi5-personal-launch-open',
          resumed: opened.resumed,
          registration: opened.launch.registration,
          launchUrl: opened.launch.launchUrl,
          auId: opened.au.id,
          ...(opened.au.title ? { auTitle: opened.au.title } : {}),
          moveOn: opened.au.moveOn,
          launchDataStaged: true,
        });
        return;
      }
      res.redirect(302, opened.launch.launchUrl);
    } catch (err) {
      if (res.headersSent) return;
      try {
        // eslint-disable-next-line no-console
        console.error('[foxxi][cmi5-personal-launch] open failed:', err instanceof Error ? err.message : err);
      } catch { /* logging must not replace the response */ }
      res.status(503).json({ error: 'the launch could not be opened just now; try again' });
    }
  });
}
