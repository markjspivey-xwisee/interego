/**
 * A course player for any cmi5 course this bridge already publishes or hosts.
 *
 * It does not mint a learner. Start uses the sign-in that is already here: a provisional
 * Interego guest (the browser's P-256 key, an owner `u-try-play-` with its own DID) or an
 * existing owner through the learning account's OAuth. The xAPI actor is that owner's DID,
 * the same way a signed launch names its learner. Tracking starts only after the person
 * agrees. Coming back in the same browser continues the same owner (the key is the one the
 * learning guest keeps) and, while the attempt is open, the same cmi5 registration.
 *
 * Claiming the guest as a lasting account is identity's add-device flow (`/connect?claim=`),
 * which keeps the same DID, so the statements already name the right actor. Signing in as a
 * different existing owner records a link instead of rewriting those statements. Reads,
 * satisfaction and the admin actor counts then treat the two actors as one person.
 *
 * Layer: L3 vertical. No new protocol term.
 */
import { readFileSync } from 'node:fs';
import type { Express, Request, Response } from 'express';
import { setActorAliasSource, type ActorLink } from './actor-alias.js';
import {
  buildCmi5Launch, chooseAu, cmi5SessionId, copyLearnerSatisfaction, findResumableLaunch,
  type Cmi5Launch,
} from './cmi5-lms.js';
import { forwardedRateLimit } from './revocable-registry.js';
import type { Cmi5Course } from './cmi5-course.js';
import { DEFAULT_TENANT, type TenantId } from './tenant-context.js';
import type { LearningAccountAuth } from './i2idlx-learning-auth.js';

let boundAuth: LearningAccountAuth | null = null;
/** The learning-account sign-in the workbench attached, which the player uses and does not replace. */
export function bindCoursePlayerAuth(auth: LearningAccountAuth | null): void { boundAuth = auth; }
export function coursePlayerAuth(): LearningAccountAuth | null { return boundAuth; }

/** The signed-in learner, from the learning account's own session and CSRF check. */
export async function learnerFromPlayerAuth(auth: LearningAccountAuth, req: Request): Promise<PlayerLearner> {
  if (!auth.enabled) throw new PlayerError(503, 'player_sign_in_unavailable');
  const principal = await auth.resolve(req, { allowGuest: true });
  auth.assertMutation(req, principal);
  return { did: principal.subject, webId: principal.webId, podUrl: principal.podUrl, userId: principal.userId, guest: principal.guest === true };
}

export class PlayerError extends Error {
  constructor(readonly status: number, readonly code: string) { super(code); }
}

export interface PlayerLearner {
  did: string;
  webId: string;
  podUrl: string;
  userId: string;
  guest: boolean;
}

export interface OpenAttempt {
  learnerDid: string;
  courseId: string;
  auId: string;
  registration: string;
  sessionId: string;
}

export interface RecordedLink {
  guestDid: string;
  ownerDid: string;
  /** The guest's pod, so their lens can be found again without using the owner's. */
  guestPodUrl?: string;
  /** The owner's pod. After the link, this guest's later records are written there. */
  ownerPodUrl?: string;
  ownerWebId?: string;
  at: string;
}

export interface LinkPlace {
  guestPodUrl?: string;
  ownerPodUrl?: string;
  ownerWebId?: string;
}

const ATTEMPT_MAX = 50_000;
const LINK_MAX = 50_000;

function attemptKey(learnerDid: string, courseId: string, auId: string): string {
  return `${learnerDid}\n${courseId}\n${auId}`;
}

/** The open attempts and the actor links this process holds. Bounded. Malformed durable rows are skipped. */
export class PlayerBook {
  private readonly attempts = new Map<string, OpenAttempt>();
  private readonly links = new Map<string, RecordedLink>();
  /** Keys and guest DIDs removed here. A later read of an older copy must not put them back. */
  private readonly removedAttempts = new Set<string>();
  private readonly removedLinks = new Set<string>();
  private readonly consents = new Map<string, { learnerDid: string; courseId: string; at: string }>();
  private readonly removedConsents = new Set<string>();
  dirty = false;
  /** Bumps on every change, so a read that overlaps a change does not clear `dirty`. */
  generation = 0;

  private touch(): void { this.dirty = true; this.generation++; }

  remember(attempt: OpenAttempt): void {
    const key = attemptKey(attempt.learnerDid, attempt.courseId, attempt.auId);
    this.removedAttempts.delete(key);
    if (this.attempts.size >= ATTEMPT_MAX && !this.attempts.has(key)) {
      const oldest = this.attempts.keys().next().value;
      if (oldest !== undefined) this.attempts.delete(oldest);
    }
    this.attempts.set(key, attempt);
    this.touch();
  }
  open(learnerDid: string, courseId: string, auId: string): OpenAttempt | undefined {
    return this.attempts.get(attemptKey(learnerDid, courseId, auId));
  }
  forgetLearner(did: string): void {
    for (const [key, attempt] of this.attempts) if (attempt.learnerDid === did) {
      this.attempts.delete(key);
      this.removedAttempts.add(key);
    }
    for (const [guest, link] of this.links) if (link.guestDid === did || link.ownerDid === did) {
      this.links.delete(guest);
      this.removedLinks.add(guest);
    }
    for (const [key, consent] of this.consents) if (consent.learnerDid === did) {
      this.consents.delete(key);
      this.removedConsents.add(key);
    }
    this.touch();
    this.publish();
  }
  link(guestDid: string, ownerDid: string, at: string, place?: string | LinkPlace): (RecordedLink & { already: boolean }) | { refused: string } {
    if (guestDid === ownerDid) return { refused: 'player_same_actor' };
    if (this.links.size >= LINK_MAX && !this.links.has(guestDid)) return { refused: 'player_link_capacity' };
    const held = this.links.get(guestDid);
    if (held && held.ownerDid !== ownerDid) return { refused: 'player_link_held' };
    const pods = typeof place === 'string' ? { guestPodUrl: place } : place;
    if (held) {
      let filled = false;
      if (pods?.guestPodUrl && !held.guestPodUrl) { held.guestPodUrl = pods.guestPodUrl; filled = true; }
      if (pods?.ownerPodUrl && !held.ownerPodUrl) { held.ownerPodUrl = pods.ownerPodUrl; filled = true; }
      if (pods?.ownerWebId && !held.ownerWebId) { held.ownerWebId = pods.ownerWebId; filled = true; }
      if (filled) { this.touch(); this.publish(); }
      return { ...held, already: true as const };
    }
    this.removedLinks.delete(guestDid);
    const link = { guestDid, ownerDid, at, ...(pods?.guestPodUrl ? { guestPodUrl: pods.guestPodUrl } : {}), ...(pods?.ownerPodUrl ? { ownerPodUrl: pods.ownerPodUrl } : {}), ...(pods?.ownerWebId ? { ownerWebId: pods.ownerWebId } : {}), already: false as const };
    this.links.set(guestDid, link);
    this.touch();
    this.publish();
    return link;
  }
  linksFor(ownerDid: string): RecordedLink[] {
    return [...this.links.values()].filter(link => link.ownerDid === ownerDid);
  }
  /** The link that names this guest, when one was recorded. */
  ownerFor(guestDid: string): RecordedLink | undefined {
    return this.links.get(guestDid);
  }
  hasConsent(learnerDid: string, courseId: string): boolean {
    return this.consents.has(`${learnerDid}\n${courseId}`);
  }
  /** The first agreement to record this learner in this course. A repeat keeps the original time. */
  recordConsent(learnerDid: string, courseId: string, at: string): { fresh: boolean; at: string } {
    const key = `${learnerDid}\n${courseId}`;
    const held = this.consents.get(key);
    if (held) return { fresh: false, at: held.at };
    this.removedConsents.delete(key);
    this.consents.set(key, { learnerDid, courseId, at });
    this.touch();
    return { fresh: true, at };
  }
  toJSON(): { attempts: OpenAttempt[]; links: RecordedLink[]; removedAttempts: string[]; removedLinks: string[]; consents: Array<{ learnerDid: string; courseId: string; at: string }>; removedConsents: string[] } {
    return {
      attempts: [...this.attempts.values()], links: [...this.links.values()],
      removedAttempts: [...this.removedAttempts], removedLinks: [...this.removedLinks],
      consents: [...this.consents.values()], removedConsents: [...this.removedConsents],
    };
  }
  /**
   * Take in another copy. A row this process already holds is left as it is (the pending
   * change wins). A row this process has removed stays removed. A row only the other copy
   * has, and this process has not removed, is added.
   */
  load(json: unknown): void {
    if (!json || typeof json !== 'object') return;
    const body = json as { attempts?: unknown; links?: unknown; removedAttempts?: unknown; removedLinks?: unknown; consents?: unknown; removedConsents?: unknown };
    if (Array.isArray(body.removedAttempts)) for (const key of body.removedAttempts) if (typeof key === 'string' && !this.attempts.has(key)) this.removedAttempts.add(key);
    if (Array.isArray(body.removedLinks)) for (const guest of body.removedLinks) if (typeof guest === 'string' && !this.links.has(guest)) this.removedLinks.add(guest);
    if (Array.isArray(body.attempts)) for (const row of body.attempts) {
      if (!validAttempt(row)) continue;
      const key = attemptKey(row.learnerDid, row.courseId, row.auId);
      if (this.removedAttempts.has(key) || this.attempts.has(key)) continue;
      this.attempts.set(key, row);
    }
    if (Array.isArray(body.removedConsents)) for (const key of body.removedConsents) if (typeof key === 'string' && !this.consents.has(key)) this.removedConsents.add(key);
    if (Array.isArray(body.consents)) for (const row of body.consents) {
      if (!row || typeof row !== 'object') continue;
      const consent = row as { learnerDid?: unknown; courseId?: unknown; at?: unknown };
      if (typeof consent.learnerDid !== 'string' || typeof consent.courseId !== 'string' || typeof consent.at !== 'string') continue;
      const key = `${consent.learnerDid}\n${consent.courseId}`;
      if (this.removedConsents.has(key) || this.consents.has(key)) continue;
      this.consents.set(key, { learnerDid: consent.learnerDid, courseId: consent.courseId, at: consent.at });
    }
    if (Array.isArray(body.links)) for (const row of body.links) {
      if (!validLink(row) || this.removedLinks.has(row.guestDid) || this.links.has(row.guestDid)) continue;
      this.links.set(row.guestDid, row);
    }
    this.publish();
  }
  publish(): void {
    const guestsByOwner = new Map<string, string[]>();
    for (const link of this.links.values()) {
      const guests = guestsByOwner.get(link.ownerDid) ?? [];
      guests.push(link.guestDid);
      guestsByOwner.set(link.ownerDid, guests);
    }
    const byName = new Map<string, ActorLink>();
    for (const [ownerDid, guests] of guestsByOwner) {
      const record: ActorLink = { canonical: ownerDid, also: [ownerDid, ...guests] };
      byName.set(ownerDid, record);
      for (const guest of guests) byName.set(guest, record);
    }
    setActorAliasSource(name => byName.get(name));
  }
}

const VOIDED_VERB = 'http://adlnet.gov/expapi/verbs/voided';

/**
 * Void one actor's statements by storing a voiding statement first and then marking the
 * target with that statement's id. A mark that names the target as its own voider does
 * not count: the native store refuses it, and a query would otherwise return the recording
 * as the statement that voided it.
 */
export async function voidActorStatements(args: {
  homePage: string;
  did: string;
  list: () => Promise<ReadonlyArray<{ id: string; voided: boolean; statement: Record<string, unknown> }>>;
  store: (statement: Record<string, unknown>) => Promise<string | null>;
  mark: (targetId: string, voidingId: string) => Promise<boolean>;
}): Promise<{ forgotten: number; voids: Record<string, unknown>[] }> {
  const rows = await args.list();
  const voids: Record<string, unknown>[] = [];
  let forgotten = 0;
  for (const rec of rows) {
    if (rec.voided) continue;
    const account = (rec.statement.actor as { account?: { name?: string; homePage?: string } } | undefined)?.account;
    if (account?.name !== args.did || account.homePage !== args.homePage) continue;
    const verb = (rec.statement.verb as { id?: string } | undefined)?.id;
    const object = rec.statement.object as { objectType?: string } | undefined;
    if (verb === VOIDED_VERB && object?.objectType === 'StatementRef') continue;
    const statement = {
      actor: { objectType: 'Agent', account: { homePage: args.homePage, name: args.did } },
      verb: { id: VOIDED_VERB, display: { 'en-US': 'voided' } },
      object: { objectType: 'StatementRef', id: rec.id },
    };
    const voidingId = await args.store(statement);
    if (!voidingId || voidingId === rec.id) continue;
    if (await args.mark(rec.id, voidingId)) { forgotten++; voids.push({ ...statement, id: voidingId }); }
  }
  return { forgotten, voids };
}

/**
 * Keep each void on the learner's pod and say so. An empty list is nothing to keep. A copy that
 * does not land is a failure: the caller must not report the deletion as finished.
 */
export async function persistVoidCopies(voids: readonly Record<string, unknown>[], keep: (statement: Record<string, unknown>) => Promise<boolean>): Promise<void> {
  if (voids.length === 0) return;
  const kept = await Promise.all(voids.map(statement => keep(statement)));
  if (kept.some(ok => !ok)) throw new PlayerError(503, 'player_forget_incomplete');
}

/** A claim statement this owner stored for this guest: the verb is claimed and an extension names the guest. */
export function statementNamesGuest(statement: Record<string, unknown>, guestDid: string): boolean {
  const verb = (statement.verb as { id?: unknown } | undefined)?.id;
  if (typeof verb !== 'string' || !verb.endsWith('#claimed')) return false;
  const extensions = (statement.context as { extensions?: unknown } | undefined)?.extensions;
  if (!extensions || typeof extensions !== 'object' || Array.isArray(extensions)) return false;
  return Object.values(extensions as Record<string, unknown>).some(value => value === guestDid || (Array.isArray(value) && value.includes(guestDid)));
}

function validAttempt(row: unknown): row is OpenAttempt {
  if (!row || typeof row !== 'object') return false;
  const d = row as Record<string, unknown>;
  return typeof d.learnerDid === 'string' && d.learnerDid.length > 0 && d.learnerDid.length <= 500
    && typeof d.courseId === 'string' && d.courseId.length > 0 && d.courseId.length <= 2000
    && typeof d.auId === 'string' && d.auId.length > 0 && d.auId.length <= 2000
    && typeof d.registration === 'string' && d.registration.length > 0 && d.registration.length <= 80
    && typeof d.sessionId === 'string' && d.sessionId.length > 0 && d.sessionId.length <= 80;
}
function validLink(row: unknown): row is RecordedLink {
  if (!row || typeof row !== 'object') return false;
  const d = row as Record<string, unknown>;
  return typeof d.guestDid === 'string' && typeof d.ownerDid === 'string' && d.guestDid !== d.ownerDid
    && typeof d.at === 'string' && d.guestDid.length <= 500 && d.ownerDid.length <= 500
    && (d.guestPodUrl === undefined || (typeof d.guestPodUrl === 'string' && d.guestPodUrl.length <= 2000))
    && (d.ownerPodUrl === undefined || (typeof d.ownerPodUrl === 'string' && d.ownerPodUrl.length <= 2000))
    && (d.ownerWebId === undefined || (typeof d.ownerWebId === 'string' && d.ownerWebId.length <= 2000));
}

/** A browser navigation, and not a cmi5 launch (those already carry endpoint, fetch and registration). */
export function browserWantsPlayer(req: { headers: { accept?: string | string[] | undefined }; query: object }): boolean {
  const q = req.query as Record<string, unknown>;
  if (typeof q.endpoint === 'string' && typeof q.fetch === 'string' && typeof q.registration === 'string') return false;
  const header = Array.isArray(req.headers.accept) ? req.headers.accept.join(',') : req.headers.accept;
  if (!header || header.trim() === '*/*') return false;
  return header.includes('text/html') && !header.includes('application/json');
}

/** The player address for a course, and optionally one of its activities. The course id is the caller's. */
export function playerLocation(courseId: string, auId?: string, returned = false): string {
  const params = new URLSearchParams({ course_id: courseId });
  if (auId) params.set('au_id', auId);
  if (returned) params.set('returned', '1');
  return `/learn?${params.toString()}`;
}

export interface CoursePlayerDeps {
  baseUrl: string;
  authoritativeSource: string;
  /**
   * The learner's own LRS lens, the same one a signed launch uses
   * (`lensTenantFor(actorForPod(podUrl))`). Absent only in a fixture that has one tenant.
   */
  tenantFor?(learner: { did: string; podUrl: string }): TenantId;
  book?: PlayerBook;
  /** The signed-in learner, guest or owner. Throws PlayerError (or an error with status and code). */
  requireLearner(req: Request): Promise<PlayerLearner>;
  /** A browser-key proof that identity accepts as a live guest of this application. */
  verifyGuest(req: Request): Promise<PlayerLearner>;
  resolveCourse(courseId: string): Promise<Cmi5Course | null>;
  satisfied(tenant: TenantId, learnerId: string): readonly string[];
  stageLaunch(tenant: TenantId, launch: Cmi5Launch, auId: string): Promise<void>;
  /** Store the LMS's `launched` statement for a new session in the learner's lens. */
  recordLaunched(tenant: TenantId, statement: Record<string, unknown>, learner: { did: string; podUrl: string }): Promise<void>;
  /** Void statements whose actor is this DID, in that learner's lens. Returns how many. `where` is the pod the voids are kept on. */
  forgetActor(did: string, tenant: TenantId, where: { podUrl: string }): Promise<number>;
  /** Remove activities from a learner's satisfied set. Used when a linked guest deletes the copy on the owner's lens. */
  dropSatisfaction?(tenant: TenantId, learnerId: string, auIds: readonly string[]): void;
  /** Void the owner's claim statement that names this guest, in the owner's lens. Returns how many. */
  voidClaims?(ownerDid: string, tenant: TenantId, guestDid: string, where: { podUrl: string }): Promise<number>;
  /** Keep a statement in that learner's lens. Absent in a deployment that is not writing statements. */
  storeStatement?(statement: Record<string, unknown>, tenant: TenantId): Promise<string | null>;
  /** Statements already stored for this actor in their lens, so the claim can name them. */
  statementIds?(did: string, tenant: TenantId): Promise<string[]>;
  onChange?: () => void;
  launchesPerMinute?: number;
  now?: () => number;
}

function htmlEscape(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function playerHtml(course: Cmi5Course, auId: string | undefined, returned: boolean): string {
  const description = course.description ? `<p>${htmlEscape(course.description)}</p>` : '';
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="referrer" content="no-referrer">
<title>${htmlEscape(course.title)}</title>
<style>
  body { font-family: system-ui, sans-serif; max-width: 40rem; margin: 2rem auto; padding: 0 1rem; line-height: 1.5; color: #16161d; }
  button, a.btn { font: inherit; background: #1a3c6e; color: #fff; border: 0; border-radius: 8px; padding: 0.6rem 1.1rem; text-decoration: none; display: inline-block; }
  button[disabled] { opacity: 0.5; }
  .notice { background: #f4f6f8; border-radius: 8px; padding: 0.8rem 1rem; }
  label { display: block; margin: 1rem 0; }
  #status { min-height: 1.4em; }
</style>
</head>
<body data-course-id="${htmlEscape(course.id)}"${auId ? ` data-au-id="${htmlEscape(auId)}"` : ''} data-returned="${returned ? '1' : '0'}">
<h1>${htmlEscape(course.title)}</h1>
${description}
<div class="notice">
  <p>Starting records this course in your learning record. The activity reports what you do, in the xAPI profile the course itself declares. Nothing is recorded until you agree. You can delete that record from this page.</p>
</div>
<label><input id="consent" type="checkbox"> I agree to this recording</label>
<p><button id="start" type="button">Start</button></p>
<p id="status" role="status"></p>
<p id="signin"></p>
<p id="claim"></p>
<script type="module" src="/learn/player.js"></script>
</body>
</html>`;
}

function known(error: unknown): { status: number; code: string } | null {
  if (!error || typeof error !== 'object') return null;
  const status = (error as { status?: unknown }).status;
  const code = (error as { code?: unknown }).code;
  return typeof status === 'number' && typeof code === 'string' ? { status, code } : null;
}

/** The shared per-client limit: keyed on the forwarded hop, an IPv6 client folded to its subnet. */
function limit(name: string, max: number): ReturnType<typeof forwardedRateLimit> {
  return forwardedRateLimit({ windowMs: 60_000, limit: max, identifier: name });
}

const GUEST_JS = new URL('../i2idlx/app/src/learning-guest.js', import.meta.url);
const PLAYER_JS = new URL('./cmi5-player-client.js', import.meta.url);

/**
 * The player:
 *   GET  /learn            the page for whatever course_id names
 *   POST /learn/launch     a tracked cmi5 launch for the signed-in owner or guest
 *   POST /learn/link       an existing owner links a guest they still hold the key for
 *   POST /learn/forget     delete the caller's guest statements
 */
export function attachCoursePlayerRoutes(app: Express, deps: CoursePlayerDeps): void {
  const base = deps.baseUrl.replace(/\/$/, '');
  const book = deps.book ?? new PlayerBook();
  const tenantOf = (learner: { did: string; podUrl: string }): TenantId => deps.tenantFor?.(learner) ?? DEFAULT_TENANT;
  /** After a link, the guest's later records are the owner's: that actor, that lens. Records from before the link stay where they were. */
  const recordedOwner = (learner: PlayerLearner): PlayerLearner => {
    const link = book.ownerFor(learner.did);
    if (!link?.ownerPodUrl || link.ownerDid === learner.did) return learner;
    return { did: link.ownerDid, webId: link.ownerWebId || learner.webId, podUrl: link.ownerPodUrl, userId: learner.userId, guest: false };
  };
  const now = deps.now ?? Date.now;
  const pageLimit = limit('course-player-page', 120);
  const launchLimit = limit('course-player-launch', deps.launchesPerMinute ?? 30);
  const linkLimit = limit('course-player-link', 20);
  const forgetLimit = limit('course-player-forget', 10);
  const scriptLimit = limit('course-player-script', 120);

  const send = (res: Response, error: unknown): void => {
    const parsed = known(error);
    if (parsed) { res.status(parsed.status).json({ error: parsed.code }); return; }
    if (!res.headersSent) res.status(503).json({ error: 'player_unavailable' });
  };

  app.get('/learn/guest.js', scriptLimit, (_req, res) => {
    res.set('Content-Type', 'text/javascript; charset=utf-8').set('X-Content-Type-Options', 'nosniff').set('Cache-Control', 'no-store');
    res.send(readFileSync(GUEST_JS, 'utf8'));
  });
  app.get('/learn/player.js', scriptLimit, (_req, res) => {
    res.set('Content-Type', 'text/javascript; charset=utf-8').set('X-Content-Type-Options', 'nosniff').set('Cache-Control', 'no-store');
    res.send(readFileSync(PLAYER_JS, 'utf8'));
  });

  app.get('/learn', pageLimit, async (req, res) => {
    try {
      const courseId = typeof req.query.course_id === 'string' ? req.query.course_id : '';
      if (!courseId || courseId.length > 2000) { res.status(400).type('html').send('<p>This page needs a course_id.</p>'); return; }
      const course = await deps.resolveCourse(courseId);
      if (!course) { res.status(404).type('html').send('<p>That course is not published here.</p>'); return; }
      const auId = typeof req.query.au_id === 'string' && req.query.au_id.length <= 2000 ? req.query.au_id : undefined;
      res.set('Cache-Control', 'no-store').set('Referrer-Policy', 'no-referrer')
        .set('Content-Security-Policy', "default-src 'none'; style-src 'unsafe-inline'; script-src 'self'; connect-src 'self' https:; base-uri 'none'; form-action 'self'");
      res.type('html').send(playerHtml(course, auId, req.query.returned === '1'));
    } catch (error) { send(res, error); }
  });

  app.post('/learn/launch', launchLimit, async (req, res) => {
    try {
      const session = await deps.requireLearner(req);
      const learner = recordedOwner(session);
      const body = (req.body ?? {}) as Record<string, unknown>;
      if (body.tracking_consent !== true) { res.status(400).json({ error: 'player_consent_required' }); return; }
      const courseId = typeof body.course_id === 'string' ? body.course_id.trim() : '';
      if (!courseId || courseId.length > 2000) { res.status(400).json({ error: 'player_course_required' }); return; }
      const course = await deps.resolveCourse(courseId);
      if (!course) { res.status(404).json({ error: 'player_course_unknown' }); return; }
      if (!book.hasConsent(learner.did, course.id)) {
        const at = new Date(now()).toISOString();
        if (deps.storeStatement) {
          const id = await deps.storeStatement({
            actor: { objectType: 'Agent', account: { homePage: deps.authoritativeSource, name: learner.did } },
            verb: { id: `${base}/learn#consented`, display: { 'en-US': 'consented' } },
            object: { objectType: 'Activity', id: course.id },
            timestamp: at,
          }, tenantOf(learner));
          if (!id) { res.status(503).json({ error: 'player_consent_unavailable' }); return; }
        }
        book.recordConsent(learner.did, course.id, at);
        deps.onChange?.();
      }
      const tenant = tenantOf(learner);
      const requested = typeof body.au_id === 'string' ? body.au_id.trim() : undefined;
      // An activity the guest satisfied before the link, or through a launch that was already open,
      // still sits in the guest's lens. Bring it over before choosing the activity.
      for (const link of book.linksFor(learner.did)) {
        if (!link.guestPodUrl || link.guestDid === learner.did) continue;
        copyLearnerSatisfaction(tenantOf({ did: link.guestDid, podUrl: link.guestPodUrl }), link.guestDid, tenant, learner.did);
      }
      const satisfied = new Set(deps.satisfied(tenant, learner.did));
      const choice = chooseAu(course, satisfied, requested || undefined);
      if (!choice.ok) { res.status(choice.status).json({ error: choice.error, ...(choice.missingPrerequisites ? { missingPrerequisites: choice.missingPrerequisites } : {}) }); return; }
      const au = choice.au;
      let auUrl: string;
      try { auUrl = new URL(au.url, `${base}/`).toString(); } catch { res.status(404).json({ error: 'player_course_unknown' }); return; }
      if (!/^https?:\/\//i.test(auUrl)) { res.status(404).json({ error: 'player_course_unknown' }); return; }
      const returnUrl = `${base}${playerLocation(course.id, undefined, true)}`;
      const launchRequest = {
        au: {
          id: au.id, url: auUrl, moveOn: au.moveOn, title: au.title,
          ...(typeof au.masteryScore === 'number' ? { masteryScore: au.masteryScore } : {}),
          ...(au.entitlementKey ? { entitlementKey: au.entitlementKey } : {}),
        },
        learner: { id: learner.did },
        lrsEndpoint: `${base}/xapi`,
        fetchBaseUrl: `${base}/cmi5/fetch`,
        authoritativeSource: deps.authoritativeSource,
        tenant,
        courseId: course.id,
        learnerPod: learner.podUrl,
        returnUrl,
      };
      // Only the LMS's own record says whether an attempt continues: its open session, or the same
      // registration in a new session when the last one ended before moveOn was met. The book's row
      // is not asked: a row left by a finished attempt would pass for one to resume, the launch would
      // carry no mode, and a satisfied activity would reopen as Normal.
      const prior = findResumableLaunch({ tenant, learnerId: learner.did, courseId: course.id, auId: au.id });
      const launch = buildCmi5Launch({
        ...launchRequest,
        ...(prior ? { resume: prior } : { launchMode: satisfied.has(au.id) ? 'Review' : 'Normal' }),
      });
      const sessionId = cmi5SessionId(launch.launchData);
      if (!sessionId) { res.status(503).json({ error: 'player_launch_unavailable' }); return; }
      // The same session, reopened. A new session of the same registration is not that: it has its own id.
      const continued = !!prior && !prior.newSession && launch.registration === prior.registration && sessionId === prior.sessionId;
      if (!continued) {
        book.remember({ learnerDid: learner.did, courseId: course.id, auId: au.id, registration: launch.registration, sessionId });
        deps.onChange?.();
      }
      await deps.stageLaunch(tenant, launch, au.id);
      // The LMS's own statement that it launched this session, in the learner's lens with the rest.
      if (launch.launched) await deps.recordLaunched(tenant, launch.launched, learner);
      res.set('Cache-Control', 'no-store').set('Referrer-Policy', 'no-referrer').json({
        kind: 'cmi5-player-launch',
        resumed: continued,
        registration: launch.registration,
        launchUrl: launch.launchUrl,
        actor: launch.actor,
        auId: au.id,
        moveOn: au.moveOn,
        learner: learner.did,
        guest: session.guest,
      });
    } catch (error) { send(res, error); }
  });

  app.post('/learn/link', linkLimit, async (req, res) => {
    try {
      const learner = await deps.requireLearner(req);
      if (learner.guest) { res.status(409).json({ error: 'player_use_existing_sign_in' }); return; }
      const guest = await deps.verifyGuest(req);
      if (!guest.userId.startsWith('u-try-play-')) { res.status(400).json({ error: 'player_not_a_guest' }); return; }
      const recorded = book.link(guest.did, learner.did, new Date(now()).toISOString(), { guestPodUrl: guest.podUrl, ownerPodUrl: learner.podUrl, ownerWebId: learner.webId });
      if ('refused' in recorded) { res.status(recorded.refused === 'player_link_capacity' ? 503 : 409).json({ error: recorded.refused }); return; }
      const guestTenant = tenantOf(guest);
      const ownerTenant = tenantOf(learner);
      // A repeat link copies again. The copy adds only what is not already there.
      copyLearnerSatisfaction(guestTenant, guest.did, ownerTenant, learner.did);
      if (recorded.already) {
        deps.onChange?.();
        res.json({ kind: 'cmi5-player-link', guest: guest.did, owner: learner.did, already: true, statementsUnchanged: true });
        return;
      }
      const ids = (await deps.statementIds?.(guest.did, guestTenant)) ?? [];
      let claimStatementId: string | null = null;
      if (deps.storeStatement) {
        claimStatementId = await deps.storeStatement({
          actor: { objectType: 'Agent', account: { homePage: deps.authoritativeSource, name: learner.did } },
          verb: { id: `${base}/learn#claimed`, display: { 'en-US': 'claimed' } },
          object: { objectType: 'Activity', id: guest.webId },
          context: {
            ...(ids[0] ? { statement: { objectType: 'StatementRef', id: ids[0] } } : {}),
            extensions: { [`${base}/learn#guest`]: guest.did, [`${base}/learn#statements`]: ids.slice(0, 100) },
          },
          timestamp: new Date(now()).toISOString(),
        }, ownerTenant);
      }
      deps.onChange?.();
      res.json({
        kind: 'cmi5-player-link',
        guest: guest.did,
        owner: learner.did,
        statementsUnchanged: true,
        ...(claimStatementId ? { claimStatementId } : {}),
      });
    } catch (error) { send(res, error); }
  });

  app.post('/learn/forget', forgetLimit, async (req, res) => {
    try {
      const learner = await deps.requireLearner(req);
      let forgotten = 0;
      const linked = book.ownerFor(learner.did);
      if (linked?.ownerPodUrl && linked.ownerDid !== learner.did) {
        // The guest's own forget. Pre-link records stay in the guest lens and are voided there.
        // Satisfaction copied onto the owner, and the owner's claim that names this guest, go too.
        // The owner's other statements stay.
        const guestTenant = tenantOf(learner);
        const ownerTenant = tenantOf({ did: linked.ownerDid, podUrl: linked.ownerPodUrl });
        const copied = deps.satisfied(guestTenant, learner.did);
        deps.dropSatisfaction?.(ownerTenant, linked.ownerDid, copied);
        if (deps.voidClaims) forgotten += await deps.voidClaims(linked.ownerDid, ownerTenant, learner.did, { podUrl: linked.ownerPodUrl });
        forgotten += await deps.forgetActor(learner.did, guestTenant, { podUrl: learner.podUrl });
        book.forgetLearner(learner.did);
      } else {
        // The caller's own actor, plus any guest they have linked.
        const targets = new Map<string, { tenant: TenantId; podUrl: string }>([[learner.did, { tenant: tenantOf(learner), podUrl: learner.podUrl }]]);
        for (const link of book.linksFor(learner.did)) {
          if (!link.guestPodUrl || targets.has(link.guestDid)) continue;
          targets.set(link.guestDid, { tenant: tenantOf({ did: link.guestDid, podUrl: link.guestPodUrl }), podUrl: link.guestPodUrl });
        }
        for (const [did, where] of targets) {
          forgotten += await deps.forgetActor(did, where.tenant, { podUrl: where.podUrl });
          book.forgetLearner(did);
        }
      }
      deps.onChange?.();
      const identityOrigin = coursePlayerAuth()?.identityOrigin;
      res.json({
        forgotten,
        ...(identityOrigin ? { identityDelete: { method: 'POST', url: `${identityOrigin}/users/me/delete` } } : {}),
      });
    } catch (error) { send(res, error); }
  });
}
