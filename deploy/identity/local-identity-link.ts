/** One-use, action-bound enrollment. Session tokens alone cannot create a link. */
import { createHash, randomBytes, timingSafeEqual, verify } from 'node:crypto';
import type { Express, Request, RequestHandler, Response } from 'express';
import { getOrCreateEd25519VerifyKey, isSmallOrderEd25519Key } from './did-parse.js';

export interface LinkOwner { userId: string; did: string; webId: string; podUrl: string; displayName: string }
export interface LinkSession { userId: string; sessionHash: string; epoch: number }
export interface LinkPasskey { id: string; publicKey: string; rpId: string; rpOrigin: string; transports?: string[] }
export type LinkHumanCredential = { method: 'wallet'; address: string } | { method: 'passkey'; id: string; publicKey: string; rpId: string; rpOrigin: string };
export interface LinkAccount { owner: LinkOwner; walletAddresses: string[]; passkeys: LinkPasskey[] }
export interface LinkStepUp {
  id: string; session: LinkSession; owner: LinkOwner; method: 'passkey' | 'wallet'; nonce: string; expiresAt: number;
  passkeys?: LinkPasskey[]; rpId?: string; rpOrigin?: string; address?: string; message?: string;
}
export interface LocalIdentityLinkDeps {
  identityOrigin: string;
  trustedPasskeyOrigins: ReadonlySet<string>;
  authenticate(token: string): Promise<LinkSession>;
  account(session: LinkSession): Promise<LinkAccount>;
  walletAddress(value: string): Promise<string>;
  verifyStepUp(step: LinkStepUp, body: Record<string, unknown>): Promise<LinkHumanCredential>;
  check(session: LinkSession, credential: LinkHumanCredential): Promise<void>;
  available(did: string, ownerId: string): Promise<void>;
  commit(session: LinkSession, credential: LinkHumanCredential, did: string, active: () => boolean): Promise<void>;
  limiter: RequestHandler;
  pollLimiter?: RequestHandler;
  now?: () => number;
}
export class LocalIdentityLinkError extends Error {
  constructor(readonly status: number, readonly code: string, message: string) { super(message); }
}
const TTL = 120_000;
const TOKEN = /^[A-Za-z0-9_-]{43}$/;
const FAILED = () => new LocalIdentityLinkError(401, 'link_expired', 'This linking request expired or was already used. Start again from your account dashboard.');
const BAD = () => new LocalIdentityLinkError(400, 'invalid_link_request', 'This account-link request could not be verified.');
const token = () => randomBytes(32).toString('base64url');
const hash = (value: string) => createHash('sha256').update(value).digest('base64url');
const same = (a: string, b: string) => a.length === b.length && timingSafeEqual(Buffer.from(a), Buffer.from(b));
function object(value: unknown, expected?: readonly string[]): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw BAD();
  const result = value as Record<string, unknown>;
  if (expected && Object.keys(result).sort().join(',') !== [...expected].sort().join(',')) throw BAD();
  return result;
}
function text(value: unknown, maximum = 2048): string {
  if (typeof value !== 'string' || !value || value.length > maximum || /[\u0000-\u001f\u007f]/.test(value)) throw BAD();
  return value;
}
export function localLinkPublicKey(did: string): Buffer {
  if (!/^did:key:z[1-9A-HJ-NP-Za-km-z]{45,55}$/.test(did)) throw BAD();
  const alphabet = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz'; let number = 0n;
  for (const character of did.slice(9)) number = number * 58n + BigInt(alphabet.indexOf(character));
  const hex = number.toString(16); const bytes = Buffer.from(hex.length % 2 ? '0' + hex : hex, 'hex');
  if (bytes.length !== 34 || bytes[0] !== 0xed || bytes[1] !== 1 || isSmallOrderEd25519Key(bytes.subarray(2))) throw BAD();
  return bytes.subarray(2);
}
export function localLinkMessage(identityOrigin: string, pendingId: string, owner: LinkOwner, did: string, nonce: string, expiresAt: string): string {
  return `Interego local identity link v1\nHost: ${new URL(identityOrigin).host}\nAccount: ${owner.did}\nPod: ${owner.podUrl}\nCredential: ${did}\nRequest: ${pendingId}\nNonce: ${nonce}\nExpires: ${expiresAt}`;
}
type Step = { value: LinkStepUp; phase: 'prepared' | 'claimed' | 'verifying' | 'verified' | 'delivered' | 'failed'; secretHash?: string; resultHash?: string; ready?: Record<string, unknown> };
type Pending = { id: string; session: LinkSession; owner: LinkOwner; credential: LinkHumanCredential; expiresAt: number; handoffHash: string;
  phase: 'waiting' | 'claimed' | 'completing' | 'linked' | 'failed'; resultHash?: string; context?: Record<string, unknown> };

export function mountLocalIdentityLink(app: Express, deps: LocalIdentityLinkDeps): void {
  const now = deps.now ?? Date.now; const origin = new URL(deps.identityOrigin).origin;
  const steps = new Map<string, Step>(); const pending = new Map<string, Pending>();
  const prune = () => { for (const [id, step] of steps) if (step.value.expiresAt <= now()) steps.delete(id); for (const [id, entry] of pending) if (entry.expiresAt <= now()) pending.delete(id); };
  const capacity = (ownerId?: string) => {
    prune(); const owned = ownerId === undefined ? 0 : [...steps.values()].filter(entry => entry.value.session.userId === ownerId).length
      + [...pending.values()].filter(entry => entry.session.userId === ownerId).length;
    if (steps.size >= 1024 || pending.size >= 1024 || owned >= 8) throw new LocalIdentityLinkError(429, 'link_busy', 'Finish an existing linking request before starting another.');
  };
  const sessionSame = (a: LinkSession, b: LinkSession) => a.userId === b.userId && a.epoch === b.epoch && same(a.sessionHash, b.sessionHash);
  const ownerSession = async (req: Request, readOnly = false): Promise<LinkSession> => {
    if (req.headers.origin !== origin && !(readOnly && req.headers.origin === undefined) || !req.headers.authorization?.startsWith('Bearer ')) throw new LocalIdentityLinkError(403, 'dashboard_required', 'Start account linking from your signed-in identity dashboard.');
    return deps.authenticate(req.headers.authorization.slice(7));
  };
  const route = (path: string, handler: (req: Request, res: Response) => Promise<void>, polling = false) => app.post(path, polling ? deps.pollLimiter ?? deps.limiter : deps.limiter, (req, res) => {
    res.setHeader('Cache-Control', 'no-store'); res.setHeader('X-Content-Type-Options', 'nosniff');
    void handler(req, res).catch(error => {
      if (res.headersSent) return;
      const known = error instanceof LocalIdentityLinkError;
      res.status(known ? error.status : 503).json({ error: known ? error.code : 'link_unavailable', message: known ? error.message : 'Account linking could not be confirmed. Review your account credentials before starting a new request.' });
    });
  });
  const capability = (value: unknown, prefix: string): { id: string; secret: string } => {
    const input = text(value, 256); const match = new RegExp('^' + prefix + ':([A-Za-z0-9_-]{43})\\.([A-Za-z0-9_-]{43})$').exec(input);
    if (!match) throw FAILED(); return { id: match[1]!, secret: match[2]! };
  };
  const options = (step: LinkStepUp) => ({ challenge: step.nonce, rpId: step.rpId, allowCredentials: step.passkeys!.map(key => ({ id: key.id, type: 'public-key', ...(key.transports?.length ? { transports: key.transports } : {}) })), userVerification: 'required', timeout: TTL });
  const begin = (step: LinkStepUp, credential: LinkHumanCredential): Record<string, unknown> => {
    capacity(); if (step.expiresAt <= now()) throw FAILED();
    const id = token(); const secret = token(); const expiresAt = now() + TTL;
    pending.set(id, { id, session: step.session, owner: step.owner, credential, expiresAt, handoffHash: hash(secret), phase: 'waiting' });
    return { handoffCode: `interego-link:v1:${id}.${secret}`, expiresAt: new Date(expiresAt).toISOString(), pendingId: id };
  };
  const finishStep = async (entry: Step, body: Record<string, unknown>): Promise<Record<string, unknown>> => {
    if (entry.value.expiresAt <= now()) throw FAILED(); entry.phase = 'verifying';
    try { const credential = await deps.verifyStepUp(entry.value, body); if (entry.phase !== 'verifying' || entry.value.expiresAt <= now()) throw FAILED(); return begin(entry.value, credential); }
    catch (error) { entry.phase = 'failed'; throw error; }
  };
  app.get('/local-identity/link/methods', deps.pollLimiter ?? deps.limiter, (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    void ownerSession(req, true).then(session => deps.account(session)).then(account => res.json({
      passkeyOrigins: [...new Set(account.passkeys.filter(key => deps.trustedPasskeyOrigins.has(key.rpOrigin)).map(key => key.rpOrigin))], walletAddresses: account.walletAddresses,
    })).catch(() => res.status(403).json({ error: 'dashboard_required' }));
  });
  route('/local-identity/link/prepare', async (req, res) => {
    const session = await ownerSession(req); capacity(session.userId); const body = object(req.body); const account = await deps.account(session);
    const method = body['method']; const step: LinkStepUp = { id: token(), session, owner: account.owner, method: method as 'passkey' | 'wallet', nonce: token(), expiresAt: now() + TTL };
    if (method === 'passkey') {
      if (Object.keys(body).some(key => !['method', 'rpOrigin'].includes(key))) throw BAD();
      const groups = [...new Set(account.passkeys.filter(key => deps.trustedPasskeyOrigins.has(key.rpOrigin)).map(key => key.rpOrigin))];
      const selected = body['rpOrigin'] === undefined ? (groups.includes(origin) ? origin : groups[0]) : text(body['rpOrigin']);
      if (!selected || !groups.includes(selected)) throw new LocalIdentityLinkError(409, 'no_link_passkey', 'Use an existing passkey on its original sign-in site, or an existing wallet.');
      const keys = account.passkeys.filter(key => key.rpOrigin === selected); if (keys.length > 128) throw BAD(); const rpId = keys[0]!.rpId;
      step.rpOrigin = selected; step.rpId = rpId; step.passkeys = keys.filter(key => key.rpId === rpId); const entry: Step = { value: step, phase: 'prepared' }; capacity(session.userId); steps.set(step.id, entry);
      if (selected !== origin) {
        const secret = token(); entry.secretHash = hash(secret);
        res.json({ version: 1, method, stepUpId: step.id, expiresAt: new Date(step.expiresAt).toISOString(), stepUpUrl: `${selected}/local-identity/link-step-up#interego-link-step-up:v1:${step.id}.${secret}` });
      } else res.json({ version: 1, method, stepUpId: step.id, expiresAt: new Date(step.expiresAt).toISOString(), options: options(step) });
      return;
    }
    object(body, ['method', 'address', 'chainId']); if (method !== 'wallet') throw BAD();
    let address: string; try { address = await deps.walletAddress(text(body['address'], 42)); } catch { throw BAD(); } const chainId = body['chainId'];
    if (!account.walletAddresses.some(known => known.toLowerCase() === address.toLowerCase()) || !Number.isSafeInteger(chainId) || (chainId as number) <= 0) throw BAD();
    step.nonce = randomBytes(32).toString('hex'); step.address = address;
    step.message = `${new URL(origin).host} wants you to sign in with your Ethereum account:\n${address}\n\nAuthorize adding a local sign-in key to ${account.owner.did}. Your account and progress stay on the same pod.\n\nURI: ${origin}/dashboard\nVersion: 1\nChain ID: ${chainId}\nNonce: ${step.nonce}\nIssued At: ${new Date(now()).toISOString()}\nExpiration Time: ${new Date(step.expiresAt).toISOString()}\nRequest ID: ${step.id}`;
    capacity(session.userId); steps.set(step.id, { value: step, phase: 'prepared' }); res.json({ version: 1, method, stepUpId: step.id, expiresAt: new Date(step.expiresAt).toISOString(), message: step.message, address });
  });
  route('/local-identity/link/start', async (req, res) => {
    const session = await ownerSession(req); const body = object(req.body); const id = text(body['stepUpId'], 43); const entry = steps.get(id);
    if (!entry || entry.phase !== 'prepared' || !sessionSame(entry.value.session, session) || entry.value.rpOrigin && entry.value.rpOrigin !== origin) throw FAILED();
    object(body, entry.value.method === 'wallet' ? ['stepUpId', 'signature'] : ['stepUpId', 'response']);
    const ready = await finishStep(entry, body); steps.delete(id); res.json(ready);
  });
  route('/local-identity/link/step-up/context', async (req, res) => {
    const body = object(req.body, ['stepUpCode']); const cap = capability(body['stepUpCode'], 'interego-link-step-up:v1'); const entry = steps.get(cap.id);
    if (!entry || entry.phase !== 'prepared' || !entry.secretHash || !same(entry.secretHash, hash(cap.secret)) || entry.value.expiresAt <= now()
      || req.headers.authorization || req.headers.origin !== entry.value.rpOrigin) throw FAILED();
    entry.phase = 'claimed'; entry.secretHash = undefined; const secret = token(); entry.resultHash = hash(secret);
    await deps.account(entry.value.session);
    res.json({ version: 1, purpose: 'link-step-up', identityOrigin: origin, stepUpId: entry.value.id, owner: entry.value.owner, expiresAt: new Date(entry.value.expiresAt).toISOString(), options: options(entry.value),
      completionCode: `interego-link-step-up-result:v1:${entry.value.id}.${secret}` });
  });
  route('/local-identity/link/step-up/complete', async (req, res) => {
    const body = object(req.body, ['completionCode', 'response']); const cap = capability(body['completionCode'], 'interego-link-step-up-result:v1'); const entry = steps.get(cap.id);
    if (!entry || entry.phase !== 'claimed' || !entry.resultHash || !same(entry.resultHash, hash(cap.secret)) || req.headers.authorization || req.headers.origin !== entry.value.rpOrigin) throw FAILED();
    entry.resultHash = undefined; entry.ready = await finishStep(entry, body); entry.phase = 'verified'; res.json({ verified: true });
  });
  route('/local-identity/link/step-up/result', async (req, res) => {
    const session = await ownerSession(req); const body = object(req.body, ['stepUpId']); const id = text(body['stepUpId'], 43); const entry = steps.get(id);
    if (!entry || entry.value.expiresAt <= now()) { steps.delete(id); res.json({ state: 'expired' }); return; }
    if (!sessionSame(entry.value.session, session)) throw FAILED(); await deps.account(session);
    if (steps.get(id) !== entry || entry.value.expiresAt <= now()) { res.json({ state: 'expired' }); return; }
    if (entry.phase === 'verified' && entry.ready) {
      const ready = entry.ready; entry.phase = 'delivered'; entry.ready = undefined; steps.delete(id); res.json({ state: 'ready', ...ready });
    }
    else res.json({ state: entry.phase === 'failed' ? 'failed' : 'waiting' });
  }, true);
  route('/local-identity/link/cancel', async (req, res) => {
    const session = await ownerSession(req); const body = object(req.body);
    if (body['stepUpId'] !== undefined) {
      object(body, ['stepUpId']); const id = text(body['stepUpId'], 43); const entry = steps.get(id);
      if (entry && !sessionSame(entry.value.session, session)) throw FAILED(); if (entry) { entry.phase = 'failed'; steps.delete(id); }
    } else {
      object(body, ['pendingId']); const id = text(body['pendingId'], 43); const entry = pending.get(id);
      if (entry && !sessionSame(entry.session, session)) throw FAILED(); if (entry) { entry.phase = 'failed'; pending.delete(id); }
    }
    res.json({ cancelled: true });
  });
  route('/local-identity/link/context', async (req, res) => {
    if (req.headers.origin !== undefined || req.headers.authorization) throw BAD();
    const body = object(req.body, ['handoffCode', 'did']); const cap = capability(body['handoffCode'], 'interego-link:v1'); const entry = pending.get(cap.id);
    if (!entry || entry.phase !== 'waiting' || entry.expiresAt <= now() || !same(entry.handoffHash, hash(cap.secret))) throw FAILED();
    entry.phase = 'claimed'; const did = text(body['did'], 128); localLinkPublicKey(did);
    await deps.check(entry.session, entry.credential); await deps.available(did, entry.owner.userId);
    const secret = token(); const nonce = token(); const expiresAt = new Date(entry.expiresAt).toISOString(); entry.resultHash = hash(secret);
    const context = { version: 1, purpose: 'link', issuer: origin, identityOrigin: origin, pendingId: entry.id, owner: entry.owner, credentialDid: did, nonce,
      message: localLinkMessage(origin, entry.id, entry.owner, did, nonce, expiresAt), expiresAt, challengeExpiresAt: expiresAt, completionCode: `interego-link-result:v1:${entry.id}.${secret}` };
    entry.context = context; res.json(context);
  });
  route('/local-identity/link/complete', async (req, res) => {
    if (req.headers.origin !== undefined || req.headers.authorization) throw BAD();
    const body = object(req.body, ['completionCode', 'did', 'nonce', 'signature']); const cap = capability(body['completionCode'], 'interego-link-result:v1'); const entry = pending.get(cap.id);
    if (!entry || entry.phase !== 'claimed' || !entry.resultHash || !same(entry.resultHash, hash(cap.secret)) || entry.expiresAt <= now() || !entry.context) throw FAILED();
    entry.phase = 'completing'; entry.resultHash = undefined;
    const active = () => pending.get(entry.id) === entry && entry.phase === 'completing' && entry.expiresAt > now();
    try {
      const did = text(body['did'], 128); const nonce = text(body['nonce'], 43); const signature = text(body['signature'], 86);
      if (did !== entry.context['credentialDid'] || nonce !== entry.context['nonce'] || !TOKEN.test(nonce) || !/^[A-Za-z0-9_-]{86}$/.test(signature)
        || !verify(null, Buffer.from(String(entry.context['message']), 'utf8'), getOrCreateEd25519VerifyKey(localLinkPublicKey(did)), Buffer.from(signature, 'base64url'))) throw FAILED();
      await deps.commit(entry.session, entry.credential, did, active); entry.phase = 'linked';
      res.json({ linked: true, identityOrigin: origin, owner: entry.owner, credentialDid: did });
    } catch (error) { entry.phase = 'failed'; throw error; }
    finally { pending.delete(entry.id); }
  });
}
