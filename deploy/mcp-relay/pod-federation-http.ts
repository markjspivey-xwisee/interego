/** Optional L3 hosted peer sharing. Assistant MCP grants confer no management authority. */
import { Router, type Request, type Response } from 'express';
import type { FederationResource, FederationService } from '@interego/pod-federation';
import { hostedFederationPage } from './pod-federation-page.js';

export const FEDERATION_MANAGE_SCOPE = 'federation:manage';
export interface HostedFederationOwner {
  readonly userId: string;
  readonly principal: string;
  readonly podUrl: string;
  readonly agentId?: string;
  readonly identityToken?: string;
}
export interface HostedShareResource { readonly id: string; readonly title: string }
export interface HostedFederationOptions {
  readonly publicUrl: string;
  /** Must verify a CURRENT OAuth grant with federation:manage, its owner and own pod. */
  readonly authorize: (authorization: string | undefined) => Promise<HostedFederationOwner>;
  /** Public traffic must not instantiate a service: only the owner can activate it. */
  readonly service: (userId: string, ownerOperation: boolean) => Promise<FederationService | undefined>;
  readonly listResources: (owner: HostedFederationOwner) => Promise<readonly HostedShareResource[]>;
  /** Resolve selection again at execution time, restricted to owner-pod manifest entries. */
  readonly resources: (owner: HostedFederationOwner, ids: readonly string[]) => Promise<readonly FederationResource[]>;
}
export class FederationHttpError extends Error {
  constructor(readonly status: number, message: string) { super(message); }
}
const validOwner = (value: unknown): value is string => typeof value === 'string' && /^[A-Za-z0-9_-]{1,96}$/.test(value);

/** `auth` must come from the OAuth provider, never from JSON or a decoded unverified JWT. */
export function federationOwnerFromOAuth(auth: { scopes: readonly string[]; extra?: Record<string, unknown> }, cssUrl: string,
  normalize: (url: string) => string = url => url): HostedFederationOwner {
  if (!auth.scopes.includes(FEDERATION_MANAGE_SCOPE)) throw new FederationHttpError(403, 'Explicit federation:manage consent is required. Existing assistant permissions do not manage pod connections.');
  const extra = auth.extra;
  if (!extra || !validOwner(extra['userId']) || typeof extra['ownerWebId'] !== 'string' || !extra['ownerWebId']
    || typeof extra['agentId'] !== 'string' || !extra['agentId'] || typeof extra['identityToken'] !== 'string'
    || !extra['identityToken'] || typeof extra['podUrl'] !== 'string' || extra['provisionalPlay']) {
    throw new FederationHttpError(403, 'A permanent signed-in hosted account is required.');
  }
  const podUrl = cssUrl + extra['userId'] + '/';
  if (normalize(extra['podUrl']) !== podUrl) throw new FederationHttpError(403, 'This account is bound to a different pod.');
  return { userId: extra['userId'], principal: extra['ownerWebId'], podUrl,
    agentId: extra['agentId'], identityToken: extra['identityToken'] };
}
const object = (value: unknown): Record<string, unknown> => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new FederationHttpError(400, 'Choose the requested sharing action.');
  return value as Record<string, unknown>;
};
const text = (value: unknown, max = 8192): string => {
  if (typeof value !== 'string' || !value.trim() || value.length > max || /[\u0000-\u001f\u007f]/.test(value)) {
    throw new FederationHttpError(400, 'The sharing request is incomplete.');
  }
  return value;
};
const field = (body: Record<string, unknown>, names: readonly string[]) => {
  if (Object.keys(body).some(key => !names.includes(key))) throw new FederationHttpError(400, 'This sharing action contains unsupported options.');
};

export function hostedFederationHttp(options: HostedFederationOptions): Router {
  const origin = new URL(options.publicUrl).origin;
  const router = Router();
  router.use((_req, res, next) => { res.set('Cache-Control', 'no-store'); res.set('Referrer-Policy', 'no-referrer'); next(); });
  router.get('/', (_req, res) => {
    const { html, nonce } = hostedFederationPage();
    res.set('Content-Security-Policy', `default-src 'none'; script-src 'nonce-${nonce}'; style-src 'nonce-${nonce}'; connect-src 'self'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'`);
    res.type('text/html').send(html);
  });
  router.get('/profile', (_req, res) => res.json({
    '@context': { hydra: 'http://www.w3.org/ns/hydra/core#' }, '@type': 'hydra:EntryPoint',
    profile: 'interego-pod-federation/v1', managementScope: FEDERATION_MANAGE_SCOPE, defaultEnabled: false,
    links: { manage: origin + '/pod-federation', owner: origin + '/pod-federation/owner/status' },
    description: 'An owner explicitly enables invitations and selected encrypted snapshot sharing. Existing MCP scopes cannot manage peers.',
    affordances: [{ action: 'urn:interego:pod-federation:status', method: 'GET', target: origin + '/pod-federation/owner/status',
      requiresScope: FEDERATION_MANAGE_SCOPE }],
  }));

  const owner = (perform: (req: Request, res: Response, actor: HostedFederationOwner, service: FederationService) => Promise<unknown>) =>
    async (req: Request, res: Response) => {
      try {
        const requestOrigin = req.get('origin');
        if (requestOrigin && requestOrigin !== origin) throw new FederationHttpError(403, 'Open the pod connections page to manage sharing.');
        const actor = await options.authorize(req.headers.authorization);
        if (!validOwner(actor.userId) || !actor.principal || !actor.podUrl) throw new FederationHttpError(403, 'Your signed-in account has no hosted pod binding.');
        const service = await options.service(actor.userId, true);
        if (!service) throw new FederationHttpError(503, 'Pod sharing is at capacity. Try again later.');
        const value = await perform(req, res, actor, service);
        if (!res.headersSent) res.json(value);
      } catch (error) {
        if (res.headersSent) return;
        if (error instanceof FederationHttpError) { res.status(error.status).json({ error: error.message }); return; }
        res.status(400).json({ error: 'This sharing action could not finish. Refresh the page, check access and try again. Your notes were kept.' });
      }
    };

  router.get('/owner/status', owner(async (_req, _res, actor, service) => ({
    owner: { userId: actor.userId, principal: actor.principal }, status: await service.status(),
    endpoint: origin + '/pod-federation/peers/' + actor.userId,
    affordances: ['configure', 'enable', 'invite', 'accept', 'approve', 'deny', 'refresh', 'share', 'received', 'remove-received', 'clear-sent-history', 'revoke', 'forget'].map(action => ({
      action: 'urn:interego:pod-federation:' + action, method: 'POST', target: origin + '/pod-federation/owner/' + action,
      requiresScope: FEDERATION_MANAGE_SCOPE,
    })),
  })));
  router.get('/owner/resources', owner(async (_req, _res, actor) => ({ resources: await options.listResources(actor) })));
  const actions = ['configure', 'enable', 'invite', 'accept', 'approve', 'deny', 'refresh', 'share', 'received', 'remove-received', 'clear-sent-history', 'revoke', 'forget'];
  router.post('/owner/:action', owner(async (req, _res, actor, service) => {
    const action = String(req.params['action']);
    if (!actions.includes(action)) throw new FederationHttpError(404, 'Sharing action not found.');
    if (!req.is('application/json')) throw new FederationHttpError(415, 'Send this action as JSON.');
    const body = object(req.body);
    switch (action) {
      case 'configure':
        field(body, ['name']);
        return service.configure({ name: text(body['name'], 80), kind: 'hosted', endpoint: origin + '/pod-federation/peers/' + actor.userId });
      case 'enable':
        field(body, ['enabled']);
        if (typeof body['enabled'] !== 'boolean') throw new FederationHttpError(400, 'Choose whether to enable sharing.');
        return service.setEnabled(body['enabled']);
      case 'invite': field(body, []); return service.createInvite();
      case 'accept': field(body, ['code']); return service.acceptInvite(text(body['code'], 16_384));
      case 'approve': field(body, ['id', 'verificationCode']); return service.approve(text(body['id']), text(body['verificationCode'], 80));
      case 'deny': field(body, ['id']); return service.deny(text(body['id']));
      case 'refresh': field(body, []); return service.refresh();
      case 'share': {
        field(body, ['peerId', 'ids']);
        const ids = body['ids'];
        if (!Array.isArray(ids) || ids.length < 1 || ids.length > 16 || new Set(ids).size !== ids.length) throw new FederationHttpError(400, 'Choose between one and sixteen resources to share.');
        const selected = ids.map(id => text(id, 2048));
        const resources = await options.resources(actor, selected);
        if (!resources.length || resources.length > 16) throw new FederationHttpError(400, 'Those resources could not be opened for sharing.');
        return service.share(text(body['peerId']), resources);
      }
      case 'received': field(body, ['id']); return service.received(text(body['id']));
      case 'remove-received': field(body, ['id']); return service.removeReceived(text(body['id']));
      case 'clear-sent-history': field(body, []); return service.clearSentHistory();
      case 'revoke': field(body, ['peerId']); return service.revoke(text(body['peerId']));
      case 'forget': field(body, []); return service.forget();
      default: throw new FederationHttpError(404, 'Sharing action not found.');
    }
  }));
  router.all('/peers/:userId/*', async (req, res) => {
    try {
      const userId = req.params['userId'];
      if (!validOwner(userId)) { res.status(404).end(); return; }
      if (Buffer.byteLength(JSON.stringify(req.body ?? null)) > 512 * 1024) { res.status(413).end(); return; }
      const service = await options.service(userId, false);
      if (!service) { res.status(503).json({ error: 'Pod sharing is off. The owner must enable it first.' }); return; }
      const url = origin + req.originalUrl;
      const method = req.method;
      const reply = await service.handle(new Request(url, {
        method, headers: { 'Content-Type': 'application/json' },
        ...(['GET', 'HEAD'].includes(method) ? {} : { body: JSON.stringify(req.body ?? null) }),
      }));
      res.status(reply.status);
      reply.headers.forEach((value, name) => { if (['content-type', 'cache-control'].includes(name.toLowerCase())) res.set(name, value); });
      res.send(await reply.text());
    } catch { res.status(503).json({ error: 'Pod sharing is unavailable. Try again after the owner enables it.' }); }
  });
  router.use((_req, res) => res.status(404).json({ error: 'Sharing route not found.' }));
  return router;
}
