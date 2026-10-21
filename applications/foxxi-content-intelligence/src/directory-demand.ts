/** Request-driven directory preparation; authorization stays in the existing route gates. */
import type { RequestHandler } from 'express';
import { decodeToken, verifySessionToken } from './auth.js';

export interface DirectoryUser {
  user_id: string;
  web_id: string;
  wallet_address?: string;
}

/** Only REST surfaces whose existing gates consume the published directory. */
export function directoryConsumerPath(path: string): boolean {
  return ['/xapi/', '/cmi5/', '/lti/ags/', '/lti/nrps/',
    '/ims/oneroster/v1p2/', '/content/', '/api/foxxi/v1/'].some(prefix => path.startsWith(prefix));
}

/**
 * This checks key possession only, never directory membership or an operator role.
 * Basic, OAuth and cmi5 credentials bypass preparation and reach their unchanged gates.
 */
function sessionProof(authorization: string | undefined): boolean {
  const encoded = /^Bearer\s+(.+)$/i.exec(authorization ?? '')?.[1]?.trim();
  if (!encoded) return false;
  const token = decodeToken(encoded);
  if (!token) return false;
  return verifySessionToken(encoded, new Map([
    [token.address.toLowerCase(), { webId: token.sub, userId: '' }],
  ])).ok;
}

export function createDirectoryDemand(loadUsers: () => Promise<ReadonlyArray<DirectoryUser>>,
  ttlMs = 60_000, now: () => number = Date.now) {
  let users: ReadonlyArray<DirectoryUser> = [];
  let updatedAt = Number.NEGATIVE_INFINITY;
  let attemptedAt = Number.NEGATIVE_INFINITY;
  let active: Promise<void> | undefined;
  const observe = (snapshot: ReadonlyArray<DirectoryUser>): void => {
    users = snapshot.map(user => ({ ...user }));
    updatedAt = attemptedAt = now();
  };
  const refresh = (): Promise<void> => {
    if (active) return active;
    if (now() - attemptedAt < ttlMs) return Promise.resolve();
    attemptedAt = now();
    active = Promise.resolve().then(loadUsers).then(observe, () => {
      // An unavailable directory must not preserve revoked access indefinitely.
      users = [];
      updatedAt = Number.NEGATIVE_INFINITY;
    }).finally(() => { active = undefined; });
    return active;
  };
  const read = (): ReadonlyArray<DirectoryUser> => now() - updatedAt < ttlMs ? users : [];
  const middleware: RequestHandler = (req, _res, next) => {
    const authorization = req.headers.authorization;
    if (!directoryConsumerPath(req.path) || typeof authorization !== 'string' || !sessionProof(authorization)) {
      next();
      return;
    }
    // The awaited snapshot is ready before every existing synchronous gate runs.
    void refresh().then(() => next(), next);
  };
  return { read, observe, middleware };
}
