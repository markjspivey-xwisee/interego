/**
 * The cmi5 LMS-side launch contract (cmi5 / IEEE 9274.2.1 §7–§8).
 *
 * Foxxi already emits every cmi5 Statement type and evaluates the
 * moveOn criterion (see cmi5.ts). What it could NOT do is be a cmi5
 * LMS *launcher* — hand an Assignable Unit (AU) a conformant launch URL
 * and mint the one-time fetch token the AU exchanges for LRS auth. That
 * is the contract that makes Foxxi-as-LMS an LMS: it can launch content.
 *
 * The cmi5 launch handshake this implements:
 *
 *   1. The LMS builds a launch URL for a learner + an AU:
 *        <auUrl>?endpoint=<lrs>&fetch=<fetchUrl>&actor=<agentJSON>
 *               &activityId=<auId>&registration=<uuid>
 *   2. The LMS stages the `LMS.LaunchData` State document (launchMode,
 *      moveOn, masteryScore, contextTemplate, returnURL) so the AU can
 *      GET it from the LRS State resource (§10).
 *   3. The AU loads, and POSTs once to the `fetch` URL. The LMS returns
 *      `{ "auth-token": "<token>" }` (§8) — single-use.
 *   4. The AU sends its cmi5 Statements to `<lrs>` authenticated with
 *      that token. Foxxi-as-LRS accepts it as a Bearer credential, and
 *      the token carries the launch's tenant, so the statements land in
 *      the right tenant partition.
 *
 * Multi-tenant: fetch tokens are minted per tenant and resolve their
 * tenant for the LRS auth gate. Single-tenant deployments use
 * DEFAULT_TENANT throughout.
 *
 * Layer: L3 vertical. No new ontology term — cmi5 is an external IEEE
 * standard; this is a conformant implementation of its LMS surface.
 */

import { randomUUID } from 'node:crypto';
import type { Express, Request, Response } from 'express';
import { DEFAULT_TENANT, tenantIdOf, type TenantId } from './tenant-context.js';

const CMI5_CATEGORY = 'https://w3id.org/xapi/cmi5/context/categories/cmi5';

export type Cmi5LaunchMode = 'Normal' | 'Browse' | 'Review';
export type Cmi5MoveOn = 'Passed' | 'Completed' | 'CompletedAndPassed' | 'CompletedOrPassed' | 'NotApplicable';

/** An Assignable Unit — the launchable content unit of a cmi5 course. */
export interface Cmi5Au {
  /** The AU's activity id (an IRI). */
  id: string;
  /** The AU's launchable URL (the content endpoint). */
  url: string;
  /** moveOn criterion the LMS will gate satisfaction on. */
  moveOn?: Cmi5MoveOn;
  /** Mastery score 0..1 — the AU passes at or above this. */
  masteryScore?: number;
  /** cmi5 launch method. */
  launchMethod?: 'OwnWindow' | 'AnyWindow';
  title?: string;
}

export interface Cmi5LaunchRequest {
  au: Cmi5Au;
  /** The learner — DID becomes the xAPI Agent account name. */
  learner: { id: string; name?: string };
  /** The LRS endpoint the AU sends its Statements to. */
  lrsEndpoint: string;
  /** The bridge's cmi5 fetch base — `<bridge>/cmi5/fetch`. */
  fetchBaseUrl: string;
  /** The authoritative source — the xAPI Agent account homePage. */
  authoritativeSource: string;
  tenant?: TenantId;
  launchMode?: Cmi5LaunchMode;
  /** Where the AU returns the learner after termination. */
  returnUrl?: string;
}

export interface Cmi5Launch {
  registration: string;
  /** The conformant cmi5 launch URL to navigate the learner to. */
  launchUrl: string;
  /** The xAPI Agent for the learner. */
  actor: Record<string, unknown>;
  /** The `LMS.LaunchData` State document the AU reads from the LRS (§10). */
  launchData: Record<string, unknown>;
  /** The one-time fetch token (already registered; for staging/inspection). */
  fetchToken: string;
}

interface FetchTokenRecord {
  /** The auth-token the AU receives and uses against the LRS. */
  authToken: string;
  tenant: TenantId;
  registration: string;
  auId: string;
  expiresAt: number;
  redeemed: boolean;
}

/** Fetch tokens minted by launches, keyed by the token the AU presents. */
const fetchTokens = new Map<string, FetchTokenRecord>();
/** Auth-tokens the LRS accepts as Bearer → their tenant. */
const authTokenTenants = new Map<string, TenantId>();
const FETCH_TOKEN_TTL_MS = 30 * 60_000; // a launch must be fetched within 30 min

function sweepExpired(): void {
  const now = Date.now();
  for (const [k, v] of fetchTokens) if (v.expiresAt < now) fetchTokens.delete(k);
}

/**
 * Build a conformant cmi5 launch for a learner + an AU. Registers the
 * one-time fetch token; the caller navigates the learner to `launchUrl`
 * and stages `launchData` into the LRS State resource as `LMS.LaunchData`.
 */
export function buildCmi5Launch(req: Cmi5LaunchRequest): Cmi5Launch {
  sweepExpired();
  const tenant = req.tenant ?? DEFAULT_TENANT;
  const registration = randomUUID();
  const actor = {
    objectType: 'Agent',
    ...(req.learner.name ? { name: req.learner.name } : {}),
    account: { homePage: req.authoritativeSource, name: req.learner.id },
  };

  // The one-time fetch token + the auth-token the AU will end up with.
  const fetchToken = `ft-${randomUUID()}`;
  const authToken = `cmi5-${tenant === DEFAULT_TENANT ? 'd' : '0'}-${randomUUID()}`;
  fetchTokens.set(fetchToken, {
    authToken, tenant, registration, auId: req.au.id,
    expiresAt: Date.now() + FETCH_TOKEN_TTL_MS, redeemed: false,
  });

  const fetchUrl = `${req.fetchBaseUrl.replace(/\/+$/, '')}/${fetchToken}`;
  const params = new URLSearchParams({
    endpoint: req.lrsEndpoint,
    fetch: fetchUrl,
    actor: JSON.stringify(actor),
    activityId: req.au.id,
    registration,
  });
  const sep = req.au.url.includes('?') ? '&' : '?';
  const launchUrl = `${req.au.url}${sep}${params.toString()}`;

  // The LMS.LaunchData State document (cmi5 §10.1).
  const launchData: Record<string, unknown> = {
    contextTemplate: {
      registration,
      contextActivities: { category: [{ id: CMI5_CATEGORY }] },
      extensions: {
        'https://w3id.org/xapi/cmi5/context/extensions/sessionid': randomUUID(),
      },
    },
    launchMode: req.launchMode ?? 'Normal',
    moveOn: req.au.moveOn ?? 'CompletedOrPassed',
    ...(typeof req.au.masteryScore === 'number' ? { masteryScore: req.au.masteryScore } : {}),
    ...(req.returnUrl ? { returnURL: req.returnUrl } : {}),
    entitlementKey: { courseStructure: registration },
  };

  return { registration, launchUrl, actor, launchData, fetchToken };
}

/**
 * Redeem a fetch token (cmi5 §8). One-time: a second redemption fails.
 * Returns the cmi5 fetch response body, or an error.
 */
export function redeemFetchToken(token: string):
  | { ok: true; body: { 'auth-token': string } }
  | { ok: false; status: number; body: { 'error-code': string; 'error-text': string } } {
  sweepExpired();
  const rec = fetchTokens.get(token);
  if (!rec) {
    return { ok: false, status: 404, body: { 'error-code': '1', 'error-text': 'fetch token not found or expired' } };
  }
  if (rec.redeemed) {
    return { ok: false, status: 401, body: { 'error-code': '4', 'error-text': 'fetch token already used (single-use, cmi5 §8)' } };
  }
  rec.redeemed = true;
  authTokenTenants.set(rec.authToken, rec.tenant);
  return { ok: true, body: { 'auth-token': rec.authToken } };
}

/**
 * Resolve the tenant of a cmi5-issued auth-token — wired into the LRS
 * auth gate so an AU's Statements land in the launch's tenant partition.
 * Returns null for tokens this module did not mint.
 */
export function cmi5BearerTenant(token: string): TenantId | null {
  return authTokenTenants.get(token) ?? null;
}

/** Attach the cmi5 LMS launch + fetch routes. */
export function attachCmi5LmsRoutes(app: Express, config: {
  selfBaseUrl: string;
  authoritativeSource: string;
  defaultLrsEndpoint?: string;
}): void {
  // ── The fetch endpoint (cmi5 §8) — the AU exchanges its one-time
  //    fetch token for an LRS auth-token. ─────────────────────────────
  app.post('/cmi5/fetch/:token', (req: Request, res: Response) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    const result = redeemFetchToken(String(req.params.token ?? ''));
    if (result.ok) { res.status(200).json(result.body); return; }
    res.status(result.status).json(result.body);
  });

  // ── The launch endpoint — given an AU + a learner, return a
  //    conformant cmi5 launch (URL + LaunchData + actor). ─────────────
  app.get('/cmi5/launch', (req: Request, res: Response) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    const auId = req.query.au_id as string | undefined;
    const auUrl = req.query.au_url as string | undefined;
    const learnerId = req.query.learner as string | undefined;
    if (!auId || !auUrl || !learnerId) {
      res.status(400).json({ error: 'au_id, au_url and learner are required query parameters' });
      return;
    }
    const lrsEndpoint = (req.query.endpoint as string | undefined)
      ?? config.defaultLrsEndpoint
      ?? `${config.selfBaseUrl}/xapi`;
    const launch = buildCmi5Launch({
      au: {
        id: auId,
        url: auUrl,
        moveOn: req.query.move_on as Cmi5MoveOn | undefined,
        masteryScore: req.query.mastery_score !== undefined ? Number(req.query.mastery_score) : undefined,
        title: req.query.title as string | undefined,
      },
      learner: { id: learnerId, name: req.query.learner_name as string | undefined },
      lrsEndpoint,
      fetchBaseUrl: `${config.selfBaseUrl}/cmi5/fetch`,
      authoritativeSource: config.authoritativeSource,
      tenant: tenantIdOf(req.query.tenant_pod_url as string | undefined),
      launchMode: req.query.launch_mode as Cmi5LaunchMode | undefined,
      returnUrl: req.query.return_url as string | undefined,
    });
    res.status(200).json({
      ...launch,
      note: 'Navigate the learner to launchUrl. Stage launchData into the LRS State resource as stateId=LMS.LaunchData for this activityId+agent+registration. The AU will POST the fetch URL once for its auth-token.',
    });
  });
}
