/** Human-only administration and browser-only enrolled learning context. */
import type { Express, Request, Response } from 'express';
import rateLimit from 'express-rate-limit';
import { LearningAccountAuth, LearningAuthError, attachLearningAccountRoutes, type LearningAccountAuthConfig } from './i2idlx-learning-auth.js';
import { LearningConnectionsStore, LearningConnectionsError, type LearningRepository } from './i2idlx-learning-connections.js';
import { LearningRepositoryError, unavailableLearningRepository } from './i2idlx-learning-repository.js';
import { LearningProviderError } from './i2idlx-learning-provider.js';
import { LearningContextService, LearningContextError } from './i2idlx-learning-context.js';
import { LearningLtiManager, LearningLtiError } from './i2idlx-learning-lti.js';
import { LearningLaunchService, LearningLaunchError } from './i2idlx-learning-launch.js';
import { LearningMapError } from './i2idlx-learning-map.js';
import { LearningJourneyService } from './i2idlx-learning-journey.js';
import { LearningProgressNotifications, LearningNotificationsError } from './i2idlx-learning-notifications.js';
import type { AgentSessionStore } from './i2idlx-agent-sessions.js';
import type { ClientTaskConfig } from './i2idlx-client-tasks.js';

type Row = Record<string, unknown>;
export interface LearningRoutesConfig extends LearningAccountAuthConfig {
  repository?: LearningRepository;
  sessions: AgentSessionStore;
  taskConfig: ClientTaskConfig;
  /** Program-only fixture override; never read from environment or HTTP. */
  launchRequestsPerMinute?: number;
}
const object = (v: unknown): v is Row => !!v && typeof v === 'object' && !Array.isArray(v);
/**
 * Everything a provisional guest may ask of `/i2idlx/api/learning`: joining a connection as a
 * learner, its own links, and reading its own courses, progress, readiness and released review.
 * A guest also has `/i2idlx/api/learning/launch`. It has nothing an owner has (connectors, policies,
 * course maps, approving links, LTI), no progress notifications (a subscription would outlive the
 * guest) and no AI learning context (which needs a paired agent a guest cannot register).
 */
export const GUEST_LEARNING_OPERATIONS: ReadonlySet<string> = new Set(['request-link', 'my-links', 'discover', 'confirm-link', 'revoke-link',
  'courses', 'progress', 'course-readiness', 'quiz-review']);
function fail(res: Response, cause: unknown): void {
  const known = cause instanceof LearningAuthError || cause instanceof LearningConnectionsError || cause instanceof LearningRepositoryError
    || cause instanceof LearningProviderError || cause instanceof LearningContextError || cause instanceof LearningLtiError || cause instanceof LearningLaunchError || cause instanceof LearningMapError || cause instanceof LearningNotificationsError;
  const code = known ? cause.code : 'learning_operation_unavailable';
  res.status(known ? cause.status : 503).set('Cache-Control', 'no-store').set('X-Content-Type-Options', 'nosniff').json({ error: code, code });
}
function argumentsOf(req: Request): Row {
  if (Object.keys(req.query).length || !object(req.body)) throw new LearningConnectionsError(400, 'learning_request_invalid');
  // Generic Foxxi transport decorations carry no identity authority here.
  const body = { ...req.body }; delete body.__client_ip; delete body.__caller_token;
  return body;
}
export function attachLearningRoutes(app: Express, config: LearningRoutesConfig): { context: LearningContextService; auth: LearningAccountAuth; connections: LearningConnectionsStore; launch: LearningLaunchService } {
  const auth = new LearningAccountAuth(config);
  const connections = new LearningConnectionsStore({ repository: config.repository ?? unavailableLearningRepository, fetch: config.fetch, now: config.now });
  const launch = new LearningLaunchService({ baseUrl: config.baseUrl, auth, connections, fetch: config.fetch, now: config.now });
  const context = new LearningContextService({ auth, connections, sessions: config.sessions, taskConfig: config.taskConfig, fetch: config.fetch, now: config.now, navigation: launch });
  const lti = new LearningLtiManager({ baseUrl: config.baseUrl, store: connections, auth, fetch: config.fetch, now: config.now });
  const journey = new LearningJourneyService({ auth, connections, navigation: launch, fetch: config.fetch, now: config.now });
  const notifications = new LearningProgressNotifications({ baseUrl: config.baseUrl, auth, connections, fetch: config.fetch, now: config.now });
  attachLearningAccountRoutes(app, auth); lti.attachRoutes(app);
  notifications.attachRoutes(app);
  let active = 0;
  const enter = () => { if (active >= 16) throw new LearningConnectionsError(429, 'learning_busy'); active++; };
  const reply = (res: Response, value: unknown) => res.set('Cache-Control', 'no-store').set('X-Content-Type-Options', 'nosniff').json(value);
  app.post('/i2idlx/api/learning', async (req, res) => {
    let admitted = false;
    try {
      enter(); admitted = true;
      const principal = await auth.resolve(req, { allowGuest: true }); auth.assertMutation(req, principal);
      const body = argumentsOf(req), operation = body.operation;
      if (principal.guest && (typeof operation !== 'string' || !GUEST_LEARNING_OPERATIONS.has(operation))) throw new LearningAuthError(403, 'learning_guest_refused');
      if (operation === 'course-readiness' || operation === 'quiz-review') { reply(res, await journey.request(principal, body)); return; }
      if (['enable-progress-notifications', 'disable-progress-notifications', 'progress-notification-status'].includes(String(operation))) {
        const result = await notifications.request(principal, body);
        if (operation !== 'progress-notification-status' && typeof body.link_id === 'string') { context.invalidateLink(body.link_id); launch.invalidateLink(body.link_id); }
        reply(res, result); return;
      }
      if (operation === 'revoke-link' && typeof body.link_id === 'string') {
        if (Object.keys(body).some(key => !['operation', 'link_id'].includes(key))) throw new LearningConnectionsError(400, 'learning_request_invalid');
        if ((await connections.readLink(body.link_id))?.notifications) await notifications.cleanupLink(principal, body.link_id);
      }
      if ((operation === 'revoke-connector' || operation === 'set-notification-policy' && body.allowProgressNotifications === false) && typeof body.connector_id === 'string') {
        const allowed = operation === 'revoke-connector' ? ['operation', 'connector_id'] : ['operation', 'connector_id', 'allowProgressNotifications', 'confirmed'];
        if (Object.keys(body).some(key => !allowed.includes(key)) || operation === 'set-notification-policy' && body.confirmed !== true) throw new LearningConnectionsError(400, 'learning_request_invalid');
        if ((await connections.readConnectorLinks(body.connector_id)).some(link => link.notifications)) await notifications.cleanupConnector(principal, body.connector_id);
      }
      if (['prepare-lti', 'install-lti', 'remove-lti'].includes(String(operation))) {
        if (Object.keys(body).some(k => !['operation', 'connector_id'].includes(k)) || typeof body.connector_id !== 'string') throw new LearningConnectionsError(400, 'learning_request_invalid');
        const value = operation === 'prepare-lti' ? await lti.prepare(principal, body.connector_id)
          : operation === 'install-lti' ? await lti.install(principal, body.connector_id) : await lti.remove(principal, body.connector_id);
        context.invalidateConnector(body.connector_id); launch.invalidateConnector(body.connector_id); reply(res, { lti: value }); return;
      }
      if (operation === 'revoke-connector' && typeof body.connector_id === 'string') {
        // Keep credentials available for an explicit retry if remote removal fails.
        if (Object.keys(body).some(k => !['operation', 'connector_id'].includes(k))) throw new LearningConnectionsError(400, 'learning_request_invalid');
        const removed = await lti.remove(principal, body.connector_id);
        if (removed.state !== 'removed') throw new LearningLtiError(409, 'learning_lti_cleanup_required');
      }
      const result = await connections.request(principal, body);
      if (operation === 'revoke-link' && typeof body.link_id === 'string') { context.invalidateLink(body.link_id); launch.invalidateLink(body.link_id); notifications.invalidateLink(body.link_id); }
      if (['revoke-connector', 'set-targeted-launch-policy', 'set-review-policy', 'set-notification-policy', 'save-course-map', 'delete-course-map'].includes(String(operation)) && typeof body.connector_id === 'string') { context.invalidateConnector(body.connector_id); launch.invalidateConnector(body.connector_id); notifications.invalidateConnector(body.connector_id); }
      if (operation === 'owned-connectors' && object(result) && Array.isArray(result.connectors)) {
        for (const connector of result.connectors) if (object(connector) && typeof connector.id === 'string') {
          connector.lti = connector.status === 'active' ? await lti.status(principal, connector.id) : null;
        }
      }
      reply(res, result);
    } catch (cause) { fail(res, cause); }
    finally { if (admitted) active--; }
  });
  const launchAdmission = rateLimit({ windowMs: 60_000, limit: Math.max(1, Math.min(240, config.launchRequestsPerMinute ?? 120)),
    keyGenerator: () => 'learning-launch-process', standardHeaders: 'draft-7', legacyHeaders: false,
    handler: (_req, res) => res.status(429).set('Cache-Control', 'no-store').json({ error: 'learning_launch_busy', code: 'learning_launch_busy' }) });
  app.post('/i2idlx/api/learning/launch', launchAdmission, async (req, res) => {
    let admitted = false; const cancelled = new AbortController();
    const close = () => { if (!res.writableEnded) cancelled.abort(); }; res.on('close', close);
    try {
      enter(); admitted = true;
      const principal = await auth.resolve(req, { allowGuest: true }); auth.assertMutation(req, principal);
      const result = await launch.launch(principal, argumentsOf(req), cancelled.signal);
      if (!cancelled.signal.aborted) { res.set('Referrer-Policy', 'no-referrer').set('Pragma', 'no-cache'); reply(res, result); }
    } catch (cause) { if (!cancelled.signal.aborted) fail(res, cause); }
    finally { res.off('close', close); if (admitted) active--; }
  });
  app.post('/i2idlx/api/learning/context', async (req, res) => {
    let admitted = false; const cancelled = new AbortController();
    const close = () => { if (!res.writableEnded) cancelled.abort(); };
    res.on('close', close);
    try {
      enter(); admitted = true;
      const principal = await auth.resolve(req); auth.assertMutation(req, principal);
      const bearer = req.get('Authorization');
      const result = await context.source(principal, argumentsOf(req), bearer?.startsWith('Bearer ') ? bearer.slice(7) : null, cancelled.signal);
      if (!cancelled.signal.aborted) reply(res, result);
    } catch (cause) { if (!cancelled.signal.aborted) fail(res, cause); }
    finally { res.off('close', close); if (admitted) active--; }
  });
  return { context, auth, connections, launch };
}
