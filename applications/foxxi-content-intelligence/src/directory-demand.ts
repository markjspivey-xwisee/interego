/** Request-driven directory preparation; authorization stays in the existing route gates. */
import type { RequestHandler } from 'express';
import { decodeToken, trustedAddressMap, verifySessionToken } from './auth.js';

export interface DirectoryUser {
  user_id: string;
  web_id: string;
  wallet_address?: string;
}

/** Only REST surfaces whose existing gates consume the published directory. */
export function directoryConsumerPath(path: string): boolean {
  const normalized = path.toLowerCase(); // Express routes are case-insensitive by default.
  return ['/xapi/', '/cmi5/', '/lti/ags/', '/lti/nrps/',
    '/ims/oneroster/v1p2/', '/content/', '/api/foxxi/v1/'].some(prefix => normalized.startsWith(prefix));
}

/**
 * This checks key possession only, never directory membership or an operator role.
 * Basic, OAuth and cmi5 credentials bypass preparation and reach their unchanged gates.
 */
function sessionProof(encoded: string): boolean {
  const token = decodeToken(encoded);
  if (!token) return false;
  return verifySessionToken(encoded, new Map([
    [token.address.toLowerCase(), { webId: token.sub, userId: '' }],
  ])).ok;
}

export function createDirectoryDemand(loadUsers: (signal: AbortSignal) => Promise<ReadonlyArray<DirectoryUser>>,
  ttlMs = 60_000, now: () => number = Date.now, timeoutMs = 10_000) {
  let users: ReadonlyArray<DirectoryUser> = [];
  let updatedAt = Number.NEGATIVE_INFINITY;
  let attemptedAt = Number.NEGATIVE_INFINITY;
  let active: Promise<void> | undefined;
  let runningLoad: Promise<ReadonlyArray<DirectoryUser>> | undefined;
  let generation = 0;
  const observe = (snapshot: ReadonlyArray<DirectoryUser>): void => {
    generation++;
    users = snapshot.map(user => ({ ...user }));
    updatedAt = attemptedAt = now();
  };
  const refresh = (): Promise<void> => {
    if (active) return active;
    // A loader still unwinding after abort cannot overlap another refresh.
    if (runningLoad) return Promise.resolve();
    if (now() - attemptedAt < ttlMs) return Promise.resolve();
    attemptedAt = now();
    const startedGeneration = generation;
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const deadline = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => {
        controller.abort();
        reject(new Error('directory refresh deadline exceeded'));
      }, timeoutMs);
    });
    // Race the whole loader, including non-cancellable DNS checks; abort all HTTP hops.
    // Only the winning operation may publish, and an explicit newer snapshot wins.
    const work = Promise.resolve().then(() => loadUsers(controller.signal));
    runningLoad = work;
    void work.then(() => { runningLoad = undefined; }, () => { runningLoad = undefined; });
    active = Promise.race([work, deadline])
      .then(snapshot => {
        if (generation === startedGeneration) observe(snapshot);
      }, () => {
        if (generation === startedGeneration) {
          // An unavailable directory must not preserve revoked access indefinitely.
          users = [];
          updatedAt = Number.NEGATIVE_INFINITY;
        }
      }).finally(() => {
        if (timer) clearTimeout(timer);
        active = undefined;
      });
    return active;
  };
  const read = (): ReadonlyArray<DirectoryUser> => now() - updatedAt < ttlMs ? users : [];
  const verifySession = async (encoded: string) => {
    if (sessionProof(encoded)) await refresh();
    return verifySessionToken(encoded, trustedAddressMap(read()));
  };
  const middleware: RequestHandler = (req, _res, next) => {
    const encoded = /^Bearer\s+(.+)$/i.exec(req.headers.authorization ?? '')?.[1]?.trim();
    if (!directoryConsumerPath(req.path) || !encoded || !sessionProof(encoded)) {
      next();
      return;
    }
    // The awaited snapshot is ready before every existing synchronous gate runs.
    void refresh().then(() => next(), next);
  };
  return { read, observe, verifySession, middleware };
}
