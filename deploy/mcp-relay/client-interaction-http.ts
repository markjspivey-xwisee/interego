import { Router } from 'express';
import type { BrowserInteractionCaller, ClientInteractions } from './client-interactions.js';

/** Browser access is scoped to one requested action; it is never an account login. */
export function clientInteractionHttpHandler(deps: {
  interactions: ClientInteractions;
  verifyHolder: (authorization: string | undefined) => Promise<string | undefined>;
}) {
  const router = Router();
  router.all(['/:id', '/:id/:operation'], async (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('Referrer-Policy', 'no-referrer');
    if (JSON.stringify(req.body ?? {}).length > 131072) {
      res.status(413).json({ error: 'Request is too large' }); return;
    }
    const id = String(req.params['id']);
    const operation = req.params['operation'];
    const browserHeader = req.headers['x-interego-browser-signing'];
    const origin = req.headers.origin;
    try {
      if (operation === 'exchange') {
        if (browserHeader !== undefined || req.method !== 'POST' || !req.is('application/json') || typeof origin !== 'string') {
          res.status(403).json({ error: 'Open this signing request from its requesting app.' }); return;
        }
        res.json(await deps.interactions.exchangeBrowser(id, String(req.body?.code ?? ''), origin)); return;
      }
      if (browserHeader !== undefined) {
        // Never fall back to a general bearer when a scoped credential was supplied.
        if (typeof browserHeader !== 'string' || typeof origin !== 'string'
          || req.method !== 'POST' || !req.is('application/json')
          || !['status', 'review', 'submit'].includes(String(operation))) {
          res.status(403).json({ error: 'Browser signing access is limited to this request.' }); return;
        }
        const caller: BrowserInteractionCaller = { kind: 'browser-interaction', credential: browserHeader, origin };
        if (operation === 'status') res.json(await deps.interactions.browserStatus(id, caller));
        else if (operation === 'review') res.json(await deps.interactions.browserReview(id, caller));
        else res.json(await deps.interactions.browserSubmit(id, caller, String(req.body?.reviewId ?? ''), req.body?.proof));
        return;
      }
      const holderUserId = await deps.verifyHolder(req.headers.authorization);
      if (!holderUserId) {
        res.status(401).json({ error: 'Sign in with the key holder’s existing Interego account.' }); return;
      }
      if (req.method === 'GET' && !operation) res.json(await deps.interactions.status(id, { holderUserId }));
      else if (req.method === 'GET' && operation === 'pending') res.json(await deps.interactions.pending(id, holderUserId));
      else if (req.method === 'POST' && operation === 'grant') res.json(await deps.interactions.grant(id, holderUserId, req.body ?? {}));
      else if (req.method === 'POST' && operation === 'review') res.json(await deps.interactions.review(id, holderUserId));
      else if (req.method === 'POST' && operation === 'submit') res.json(await deps.interactions.submit(id, holderUserId, String(req.body?.reviewId ?? ''), req.body?.proof));
      else if (req.method === 'POST' && operation === 'cancel') res.json(await deps.interactions.cancel(id, { holderUserId }));
      else res.status(405).json({ error: 'Unsupported interaction operation' });
    } catch (error) { res.status(409).json({ error: (error as Error).message }); }
  });
  return router;
}
