import type express from 'express';
import { PlayError, type ProvisionalPlay } from './provisional-play.js';

export function mountProvisionalPlay(app: express.Express, play: ProvisionalPlay,
  bootstrapLimiter: express.RequestHandler, verifyLimiter: express.RequestHandler,
  log: (message: string) => void): void {
  app.get('/.well-known/play-provisional', (_req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    res.json(play.metadata());
  });
  const route = (fn: (body: unknown) => Promise<unknown>): express.RequestHandler => async (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    try { res.json(await fn(req.body)); }
    catch (error) {
      if (error instanceof PlayError) { res.status(error.status).json({ valid: false, error: error.code }); return; }
      log(`Provisional Play dependency unavailable: ${(error as Error).name}`);
      res.status(503).json({ valid: false, error: 'provisional_play_unavailable' });
    }
  };
  app.post('/play/provisional', bootstrapLimiter, route(body => play.bootstrap(body)));
  app.post('/play/provisional/verify', verifyLimiter, route(body => play.verify(body)));
}
