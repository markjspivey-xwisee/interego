/**
 * The account owner's side of linking a guest (provisional-guest-link.ts), on identity's own origin.
 * Mounted only while the general guest door is on: a deployment without it has none of these paths.
 *
 *   GET  /guest/link/guests    the guests this account has linked
 *   POST /guest/link/prepare   start a fresh proof by a passkey or wallet ALREADY on the account
 *   POST /guest/link/code      finish that proof: a link code, to enter at the door in the guest's browser
 *   POST /guest/link/unlink    finish that proof: unlink one guest
 *
 * A bearer alone does neither. Each code and each unlink needs a fresh assertion by a credential
 * the account already holds, verified by the same function the local-key link uses
 * (server.ts verifyLinkStepUp): no sign-in path is added, no credential is added, and no token is
 * issued here. The proof is bound to what it authorises: a step prepared for a code does not unlink,
 * and one prepared to unlink a guest unlinks that guest only. Requests are answered for identity's
 * own origin, as the local-key link's are: these are the dashboard's requests.
 *
 * A passkey must be one registered on identity's own origin. One registered on another relying
 * party (the relay's sign-in window) is not offered here; an account that holds only such passkeys
 * uses a wallet, or links nothing in this version.
 */
import { randomBytes, timingSafeEqual } from 'node:crypto';
import type { Express, Request, RequestHandler, Response } from 'express';
import { PlayError, type ProvisionalPlay } from './provisional-play.js';
import { LocalIdentityLinkError, type LinkAccount, type LinkHumanCredential, type LinkSession, type LinkStepUp } from './local-identity-link.js';

export interface GuestLinkRouteDeps {
  identityOrigin: string;
  /** A registered owner's bearer: a guest's token is refused (server.ts authenticateLinkSession). */
  authenticate(token: string): Promise<LinkSession>;
  account(session: LinkSession): Promise<LinkAccount>;
  walletAddress(value: string): Promise<string>;
  verifyStepUp(step: LinkStepUp, body: Record<string, unknown>): Promise<LinkHumanCredential>;
  limiter: RequestHandler;
  now?: () => number;
}

const TTL = 120_000;
const GUEST_ID = /^u-try-guest-[a-f0-9]{32}$/;
const token = () => randomBytes(32).toString('base64url');
const same = (a: string, b: string) => a.length === b.length && timingSafeEqual(Buffer.from(a), Buffer.from(b));
const bad = () => new LocalIdentityLinkError(400, 'invalid_link_request', 'This guest-link request could not be read.');
const ended = () => new LocalIdentityLinkError(401, 'link_expired', 'This approval expired or was already used. Start again from your account dashboard.');
type Action = { kind: 'code' } | { kind: 'unlink'; guest: string };
interface Step { value: LinkStepUp; action: Action }

/** Mount the owner's routes. Adds none unless the door is on. */
export function mountGuestLink(app: Express, play: ProvisionalPlay, deps: GuestLinkRouteDeps, log: (message: string) => void): boolean {
  const general = play.general;
  if (!general?.enabled) return false;
  const link = general.link;
  const now = deps.now ?? Date.now;
  const origin = new URL(deps.identityOrigin).origin;
  const steps = new Map<string, Step>();
  const capacity = (ownerId: string) => {
    for (const [id, step] of steps) if (step.value.expiresAt <= now()) steps.delete(id);
    const owned = [...steps.values()].filter(step => step.value.session.userId === ownerId).length;
    if (steps.size >= 1024 || owned >= 8) throw new LocalIdentityLinkError(429, 'link_busy', 'Finish an existing request before starting another.');
  };
  const session = async (req: Request, readOnly = false): Promise<LinkSession> => {
    if ((req.headers.origin !== origin && !(readOnly && req.headers.origin === undefined)) || !req.headers.authorization?.startsWith('Bearer ')) {
      throw new LocalIdentityLinkError(403, 'dashboard_required', 'Link a guest from your signed-in identity dashboard.');
    }
    return deps.authenticate(req.headers.authorization.slice(7));
  };
  const answer = (handler: (req: Request, res: Response) => Promise<void>): RequestHandler => (req, res) => {
    res.setHeader('Cache-Control', 'no-store'); res.setHeader('X-Content-Type-Options', 'nosniff');
    void handler(req, res).catch(error => {
      if (res.headersSent) return;
      if (error instanceof LocalIdentityLinkError) { res.status(error.status).json({ error: error.code, message: error.message }); return; }
      if (error instanceof PlayError) { res.status(error.status).json({ error: error.code }); return; }
      log(`Guest link dependency unavailable: ${(error as Error).name}`);
      res.status(503).json({ error: 'guest_link_unavailable' });
    });
  };
  const record = (value: unknown): Record<string, unknown> => {
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw bad();
    return value as Record<string, unknown>;
  };
  const only = (body: Record<string, unknown>, keys: readonly string[]) => { if (Object.keys(body).some(key => !keys.includes(key))) throw bad(); };
  /** The step a request finishes, taken out of the table: each proves one thing once. */
  const finish = async (req: Request, kind: Action['kind']): Promise<{ session: LinkSession; action: Action }> => {
    const owner = await session(req);
    const body = record(req.body);
    const id = body['stepUpId'];
    const step = typeof id === 'string' ? steps.get(id) : undefined;
    if (!step || step.action.kind !== kind || step.value.expiresAt <= now() || step.value.session.userId !== owner.userId
      || step.value.session.epoch !== owner.epoch || !same(step.value.session.sessionHash, owner.sessionHash)) throw ended();
    steps.delete(step.value.id);
    only(body, step.value.method === 'wallet' ? ['stepUpId', 'signature'] : ['stepUpId', 'response']);
    await deps.verifyStepUp(step.value, body);
    if (step.value.expiresAt <= now()) throw ended();
    return { session: owner, action: step.action };
  };

  app.get('/guest/link/guests', deps.limiter, answer(async (req, res) => {
    const owner = await session(req, true);
    res.json({ guests: await link.list(owner.userId) });
  }));
  app.post('/guest/link/prepare', deps.limiter, answer(async (req, res) => {
    const owner = await session(req);
    capacity(owner.userId);
    const body = record(req.body);
    const action: Action | undefined = body['action'] === 'code' ? { kind: 'code' }
      : body['action'] === 'unlink' && typeof body['guest'] === 'string' && GUEST_ID.test(body['guest']) ? { kind: 'unlink', guest: body['guest'] } : undefined;
    if (!action) throw bad();
    const account = await deps.account(owner);
    const step: LinkStepUp = { id: token(), session: owner, owner: account.owner, method: body['method'] as 'passkey' | 'wallet', nonce: token(), expiresAt: now() + TTL };
    const expiresAt = new Date(step.expiresAt).toISOString();
    if (body['method'] === 'passkey') {
      only(body, ['action', 'guest', 'method']);
      const keys = account.passkeys.filter(key => key.rpOrigin === origin);
      if (!keys.length || keys.length > 128) throw new LocalIdentityLinkError(409, 'no_link_passkey', 'This account has no passkey registered on this site. Use a wallet already on the account.');
      step.rpOrigin = origin; step.rpId = keys[0]!.rpId; step.passkeys = keys.filter(key => key.rpId === step.rpId);
      capacity(owner.userId); steps.set(step.id, { value: step, action });
      res.json({ version: 1, method: 'passkey', stepUpId: step.id, expiresAt, options: { challenge: step.nonce, rpId: step.rpId,
        allowCredentials: step.passkeys.map(key => ({ id: key.id, type: 'public-key', ...(key.transports?.length ? { transports: key.transports } : {}) })),
        userVerification: 'required', timeout: TTL } });
      return;
    }
    if (body['method'] !== 'wallet') throw bad();
    only(body, ['action', 'guest', 'method', 'address', 'chainId']);
    let address: string;
    try { address = await deps.walletAddress(String(body['address'] ?? '').slice(0, 42)); } catch { throw bad(); }
    const chainId = body['chainId'];
    if (!account.walletAddresses.some(known => known.toLowerCase() === address.toLowerCase()) || !Number.isSafeInteger(chainId) || (chainId as number) <= 0) throw bad();
    // What the wallet shows is what the signature authorises: the account, and the guest for an unlink.
    const statement = action.kind === 'code'
      ? `Authorize a code that links one guest to ${account.owner.did}. That guest will then act as this account in applications that offer guest access.`
      : `Authorize unlinking the guest ${action.guest} from ${account.owner.did}.`;
    step.nonce = randomBytes(32).toString('hex'); step.address = address;
    step.message = `${new URL(origin).host} wants you to sign in with your Ethereum account:\n${address}\n\n${statement}\n\nURI: ${origin}/dashboard\nVersion: 1\nChain ID: ${chainId}\nNonce: ${step.nonce}\nIssued At: ${new Date(now()).toISOString()}\nExpiration Time: ${expiresAt}\nRequest ID: ${step.id}`;
    capacity(owner.userId); steps.set(step.id, { value: step, action });
    res.json({ version: 1, method: 'wallet', stepUpId: step.id, expiresAt, message: step.message, address });
  }));
  app.post('/guest/link/code', deps.limiter, answer(async (req, res) => {
    const proven = await finish(req, 'code');
    const issued = await link.issueCode(proven.session.userId);
    res.json({ code: issued.code, expiresAt: issued.expiresAt, account: issued.account,
      doorUrl: `${general.doorOrigin}/guest/door#link` });
  }));
  app.post('/guest/link/unlink', deps.limiter, answer(async (req, res) => {
    const proven = await finish(req, 'unlink');
    res.json(await link.unlink(proven.session.userId, (proven.action as { guest: string }).guest));
  }));
  return true;
}
