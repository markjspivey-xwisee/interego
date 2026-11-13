/**
 * A route's own JSON parser that is safe behind another one.
 *
 * ★ WHY. The bridge parses JSON globally with the shared bridge package's Express 5. This
 * application's `express.json` is Express 4's (body-parser 1), which skips a request that is
 * already parsed only when `req._body` is set. The newer parser does not set it, so a route that
 * adds its own `express.json(...)` reads the consumed stream again and fails with
 * `stream.not.readable`, which the bridge's terminal handler answers as a bare
 * `500 internal error`. Measured on the live bridge on 2026-11-12: every
 * `POST /i2idlx/learning/guest/*` answered 500 until it stopped parsing twice.
 *
 * A body that is already parsed is left as it is; only an unparsed request is read, with the
 * route's own limits. Where the bridge's parser ran first, ITS limit applied to that request.
 */
import express, { type NextFunction, type Request, type RequestHandler, type Response } from 'express';

export function routeJson(options: Parameters<typeof express.json>[0] = {}): RequestHandler {
  const parse = express.json(options);
  return (req: Request, res: Response, next: NextFunction) => { if (req.body !== undefined) next(); else parse(req, res, next); };
}
