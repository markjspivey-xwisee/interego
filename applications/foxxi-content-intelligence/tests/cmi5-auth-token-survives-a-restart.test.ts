/**
 * A cmi5 launch's auth-token is still good after the bridge restarts.
 *
 * The token used to be a random string, and what it stood for was a row in a table in the process.
 * A deploy emptied the table and every assignable unit in progress was answered 401 on its next
 * statement. The token now carries its tenant, registration, session and expiry under the bridge's
 * HMAC, so nothing is stored for it and a process with the same secret reads it.
 */
import { describe, expect, it } from 'vitest';
import { createHash, createHmac } from 'node:crypto';
import { CMI5_AUTH_TOKEN_TTL_MS, mintCmi5AuthToken, readCmi5AuthToken } from '../src/cmi5-auth-token.js';
import {
  buildCmi5Launch, cmi5BearerActor, cmi5BearerRegistration, cmi5BearerSession, cmi5BearerTenant, configureCmi5AuthTokenSecret, forgetCmi5Learner, redeemFetchToken,
} from '../src/cmi5-lms.js';
import type { TenantId } from '../src/tenant-context.js';

const KEY = createHash('sha256').update('one bridge secret').digest();
const OTHER_KEY = createHash('sha256').update('another bridge secret').digest();
const BINDING = { tenant: 'lens:restart', registration: '0b0e1c5e-0000-4000-8000-000000000001', sessionId: '0b0e1c5e-0000-4000-8000-000000000002' };
const NOW = Date.parse('2026-11-15T18:32:00.000Z');

describe('the token itself', () => {
  const token = mintCmi5AuthToken(BINDING, KEY, NOW + CMI5_AUTH_TOKEN_TTL_MS);

  it('is read by anything holding the same key, with nothing stored between the two', () => {
    expect(readCmi5AuthToken(token, Buffer.from(KEY), NOW + 1)).toEqual(BINDING);
  });

  it('is one header value: no space, and nothing a Basic or Bearer header would split', () => {
    expect(token).toMatch(/^cmi5v1\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/);
  });

  it('is not read under another key', () => {
    expect(readCmi5AuthToken(token, OTHER_KEY, NOW + 1)).toBeNull();
  });

  it('is not read past its time, and is read up to it', () => {
    expect(readCmi5AuthToken(token, KEY, NOW + CMI5_AUTH_TOKEN_TTL_MS - 1)).toEqual(BINDING);
    expect(readCmi5AuthToken(token, KEY, NOW + CMI5_AUTH_TOKEN_TTL_MS)).toBeNull();
  });

  it('is not read once any part of what it says is changed', () => {
    const [, body, sig] = token.split('.') as [string, string, string];
    const said = JSON.parse(Buffer.from(body, 'base64url').toString('utf8')) as Record<string, unknown>;
    for (const change of [{ r: '0b0e1c5e-0000-4000-8000-00000000ffff' }, { t: 'lens:someone-else' }, { s: 'another-session' }, { x: NOW + 10 * CMI5_AUTH_TOKEN_TTL_MS }]) {
      const forged = Buffer.from(JSON.stringify({ ...said, ...change }), 'utf8').toString('base64url');
      expect(readCmi5AuthToken(`cmi5v1.${forged}.${sig}`, KEY, NOW + 1)).toBeNull();
    }
  });

  it('is not read when the signature is over the body without this purpose', () => {
    const [, body] = token.split('.') as [string, string];
    const bare = createHmac('sha256', KEY).update(body).digest('base64url');
    expect(readCmi5AuthToken(`cmi5v1.${body}.${bare}`, KEY, NOW + 1)).toBeNull();
  });

  it('reads nothing from a string that is not one of these', () => {
    for (const not of ['', 'cmi5-0-00000000-0000-4000-8000-000000000000', 'cmi5v1.', 'cmi5v1.a', 'cmi5v1.a.b.c', `cmi5v1.${'a'.repeat(4000)}.b`, 'cmi5v1.!!.??', token.slice(0, -2)]) {
      expect(readCmi5AuthToken(not, KEY, NOW + 1)).toBeNull();
    }
    const [, , sig] = token.split('.') as [string, string, string];
    const notJson = Buffer.from('not json', 'utf8').toString('base64url');
    expect(readCmi5AuthToken(`cmi5v1.${notJson}.${sig}`, KEY, NOW + 1)).toBeNull();
    const wrongShape = Buffer.from(JSON.stringify({ t: 'a', r: 'b', s: '', x: NOW + 10 }), 'utf8').toString('base64url');
    const signed = createHmac('sha256', KEY).update(`foxxi-cmi5-auth-token\n${wrongShape}`).digest('base64url');
    expect(readCmi5AuthToken(`cmi5v1.${wrongShape}.${signed}`, KEY, NOW + 1)).toBeNull();
  });
});

describe('the token against the launches the LMS holds', () => {
  configureCmi5AuthTokenSecret('the secret this bridge was started with');
  const tenant = 'lens:auth-token-restart' as TenantId;
  const learner = { id: 'did:ethr:0x3333333333cc00000000000000000000000beef3' };
  const launch = buildCmi5Launch({
    au: { id: 'https://bridge.example/au/restart', url: 'https://bridge.example/content/au/restart', moveOn: 'Completed', title: 'Restart' },
    learner, lrsEndpoint: 'https://bridge.example/xapi', fetchBaseUrl: 'https://bridge.example/cmi5/fetch',
    authoritativeSource: 'did:web:bridge.example', tenant,
  });
  const redeemed = redeemFetchToken(launch.fetchToken);
  if (!redeemed.ok) throw new Error('fetch token did not redeem');
  const token = redeemed.body['auth-token'];

  it('names its launch from the token and the launch record alone', () => {
    expect(cmi5BearerTenant(token)).toBe(tenant);
    expect(cmi5BearerRegistration(token)).toBe(launch.registration);
    expect(cmi5BearerActor(token)).toEqual({ homePage: 'did:web:bridge.example', name: learner.id });
    expect(cmi5BearerSession(token)).toMatchObject({ registration: launch.registration, closed: false, superseded: false });
  });

  it('is the token a process with the same secret would mint and read: the key comes from the secret alone', () => {
    const key = createHash('sha256').update('foxxi-cmi5-auth-token-key:the secret this bridge was started with').digest();
    expect(readCmi5AuthToken(token, key, Date.now())).toMatchObject({ tenant: String(tenant), registration: launch.registration });
  });

  it('takes no token signed under another secret, even for a launch it holds', () => {
    const elsewhere = createHash('sha256').update('foxxi-cmi5-auth-token-key:some other secret').digest();
    const forged = mintCmi5AuthToken({ tenant: String(tenant), registration: launch.registration, sessionId: 'any' }, elsewhere, Date.now() + 60_000);
    expect(cmi5BearerTenant(forged)).toBeNull();
    expect(cmi5BearerRegistration(forged)).toBeNull();
    expect(cmi5BearerActor(forged)).toBeNull();
  });

  it('takes no token of its own for a launch it does not hold, or holds in another tenant', () => {
    const key = createHash('sha256').update('foxxi-cmi5-auth-token-key:the secret this bridge was started with').digest();
    const unknown = mintCmi5AuthToken({ tenant: String(tenant), registration: '0b0e1c5e-0000-4000-8000-0000000000aa', sessionId: 's' }, key, Date.now() + 60_000);
    expect(cmi5BearerTenant(unknown)).toBeNull();
    const otherTenant = mintCmi5AuthToken({ tenant: 'lens:someone-else', registration: launch.registration, sessionId: 's' }, key, Date.now() + 60_000);
    expect(cmi5BearerTenant(otherTenant)).toBeNull();
    expect(cmi5BearerRegistration(otherTenant)).toBeNull();
  });

  it('is good for nothing once the learner is forgotten', () => {
    forgetCmi5Learner(tenant, learner.id);
    expect(cmi5BearerTenant(token)).toBeNull();
    expect(cmi5BearerRegistration(token)).toBeNull();
    expect(cmi5BearerActor(token)).toBeNull();
    expect(cmi5BearerSession(token)).toBeNull();
  });
});
