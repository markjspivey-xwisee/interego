/**
 * Round-47: close the round-46 confirmed-open findings.
 *
 *  F1 [MAJOR] xAPI LRS accepted ANY non-empty Bearer as DEFAULT_TENANT (junk bearer could
 *      read every learner's PII + POST forged statements). The gate now requires a VERIFIED
 *      identity: a recognized cmi5 token, a wallet-signed Foxxi session token (verified
 *      against the directory), or a real ES256-signed OAuth bearer — else 401.
 *      These tests prove the two verifiers behind that gate:
 *        - a session token minted for a directory user (as the xAPI conformance runner does)
 *          verifies → conformance stays green;
 *        - a junk bearer does NOT;
 *        - an ES256 OAuth bearer verifies, while a tampered one, an alg=none one, and any
 *          bearer when no key is configured are all rejected.
 *  F3 [MINOR] sendServerError returns a generic body and never echoes the raw error text.
 */

import { describe, it, expect } from 'vitest';
import { sign as cryptoSign, generateKeyPairSync, type KeyObject } from 'node:crypto';
import { mintSessionToken, verifySessionToken, buildAddressMap, attachDeterministicAddresses } from '../src/auth.js';
import { verifyOauthBearer, oauthPublicKeyFrom } from '../src/xapi-oauth.js';
import { sendServerError } from '../src/http-errors.js';

const b64url = (b: Buffer | string): string =>
  (typeof b === 'string' ? Buffer.from(b) : b).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

describe('round-47 F1 — LRS Bearer requires a verified identity', () => {
  it('a session token minted for a directory user verifies (the conformance-runner path)', async () => {
    // The published directory shape (admin_payload.json): user_id + web_id, no wallet.
    // The gate injects deterministic wallets (same derivation mintSessionToken uses).
    const directory = [{ user_id: 'u-joshua', web_id: 'https://id.acme-training.example/jliu/profile#me' }];
    const addressMap = buildAddressMap(attachDeterministicAddresses(directory));

    // Exactly what /compliance/xapi/run mints.
    const token = await mintSessionToken({ userId: 'u-joshua', webId: 'https://id.acme-training.example/jliu/profile#me' });
    const verified = verifySessionToken(token, addressMap);
    expect(verified.ok).toBe(true);
    if (verified.ok) expect(verified.callerDid).toBe('https://id.acme-training.example/jliu/profile#me');
  });

  it('a junk / non-directory bearer does NOT verify (the hole is closed)', async () => {
    const directory = [{ user_id: 'u-joshua', web_id: 'https://id.acme-training.example/jliu/profile#me' }];
    const addressMap = buildAddressMap(attachDeterministicAddresses(directory));
    expect(verifySessionToken('junk-bearer-token', addressMap).ok).toBe(false);
    // A session token for a user NOT in the directory also fails (address not known).
    const outsider = await mintSessionToken({ userId: 'u-attacker', webId: 'https://evil.example/me' });
    expect(verifySessionToken(outsider, addressMap).ok).toBe(false);
  });

  it('a real ES256 OAuth bearer verifies; tampered / alg=none / no-key are rejected', () => {
    const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' });
    const pub: KeyObject = publicKey; // generateKeyPairSync returns KeyObjects (no encoding)
    const claims = { iss: 'https://foxxi', sub: 'client-1', exp: Math.floor(Date.now() / 1000) + 3600, scope: 'xapi.read' };
    const h = b64url(JSON.stringify({ alg: 'ES256', typ: 'JWT' }));
    const p = b64url(JSON.stringify(claims));
    // ieee-p1363 => raw r||s (the JOSE signature format the minter/verifier use).
    const sig = b64url(cryptoSign('sha256', Buffer.from(`${h}.${p}`), { key: privateKey, dsaEncoding: 'ieee-p1363' }));
    const jwt = `${h}.${p}.${sig}`;

    expect(verifyOauthBearer(jwt, pub)).toBeTruthy();

    // Tampered payload (claims a longer expiry / different sub) with the original signature.
    const forgedPayload = b64url(JSON.stringify({ ...claims, sub: 'attacker' }));
    expect(verifyOauthBearer(`${h}.${forgedPayload}.${sig}`, pub)).toBeNull();

    // alg=none unsigned token must never authenticate.
    const noneTok = `${b64url(JSON.stringify({ alg: 'none', typ: 'JWT' }))}.${p}.`;
    expect(verifyOauthBearer(noneTok, pub)).toBeNull();

    // No key configured → fail-closed (a valid signature can't be checked, so reject).
    expect(verifyOauthBearer(jwt, null)).toBeNull();
    expect(oauthPublicKeyFrom(undefined)).toBeNull();
  });
});

describe('round-47 F3 — sendServerError never echoes raw error text', () => {
  it('returns a generic body regardless of the error contents', () => {
    let status = 0; let body: unknown = null;
    const res = { status(code: number) { status = code; return { json(b: unknown) { body = b; } }; } };
    sendServerError(res, new Error('internal CSS host https://css.internal:3000 exploded — secret=abc'), 'unit');
    expect(status).toBe(500);
    expect(body).toEqual({ ok: false, error: 'internal error' });
    expect(JSON.stringify(body)).not.toContain('css.internal');
    expect(JSON.stringify(body)).not.toContain('secret');
  });
});
