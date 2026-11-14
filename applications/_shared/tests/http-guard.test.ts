/**
 * The shared HTTP guard: the public-origin check, who a request is counted against, the request
 * limit, the table ceiling and the /health body. These tests moved here with the code, from the
 * coached world, where the pieces were first written. Nothing here starts a server.
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  DEFAULT_MAX_RATE_CLIENTS, PublicUrlError, RateLimiter, bound, clientKey, foldAddress, healthBody, publicOrigin,
} from '../http-guard/index.js';

const here = dirname(fileURLToPath(import.meta.url));

describe('the public URL', () => {
  it('is an https origin, returned without a trailing slash', () => {
    expect(publicOrigin('https://world.example')).toBe('https://world.example');
    expect(publicOrigin('https://world.example/')).toBe('https://world.example');
    expect(publicOrigin('  https://world.example:8443  ')).toBe('https://world.example:8443');
  });

  it('may be http only on this machine', () => {
    expect(publicOrigin('http://localhost:6199')).toBe('http://localhost:6199');
    expect(publicOrigin('http://127.0.0.1:6199/')).toBe('http://127.0.0.1:6199');
    expect(() => publicOrigin('http://world.example')).toThrow(PublicUrlError);
    expect(() => publicOrigin('http://localhost.world.example')).toThrow(/https/);
  });

  it('is refused with a path, a query, a fragment, credentials, another scheme, or no URL at all', () => {
    for (const bad of [
      'https://world.example/play', 'https://world.example/?a=1', 'https://world.example/#top',
      'https://someone:made-up@world.example', 'ftp://world.example', 'world.example', '',
    ]) expect(() => publicOrigin(bad), bad).toThrow(PublicUrlError);
  });
});

describe('who a request is counted against', () => {
  it('counts an IPv4 address whole and an IPv6 address by its /56', () => {
    expect(foldAddress('203.0.113.7')).toBe('203.0.113.7');
    expect(foldAddress('203.0.113.7:51234')).toBe('203.0.113.7');
    expect(foldAddress('2001:db8:aa:bb01::1')).toBe('2001:db8:aa:bb00::/56');
    // Two addresses one subscriber holds are one client; the next /56 along is another.
    expect(foldAddress('2001:db8:aa:bbff:1:2:3:4')).toBe(foldAddress('2001:db8:aa:bb01::1'));
    expect(foldAddress('2001:db8:aa:bc00::1')).not.toBe(foldAddress('2001:db8:aa:bb01::1'));
    expect(foldAddress('[2001:db8:aa:bb01::1]:443')).toBe('2001:db8:aa:bb00::/56');
    expect(foldAddress('fe80::1%eth0')).toBe('fe80:0:0:0::/56');
    expect(foldAddress('::1')).toBe('0:0:0:0::/56');
  });

  it('reads an IPv4 address carried in IPv6 as that IPv4 address', () => {
    expect(foldAddress('::ffff:203.0.113.7')).toBe('203.0.113.7');
    expect(foldAddress('::ffff:cb00:7107')).toBe('203.0.113.7');
  });

  it('never uses text it cannot read as an address', () => {
    for (const bad of [undefined, '', 'not-an-address', '999.1.1.1', '1.2.3', '2001:db8::1::2', '1:2:3:4:5:6:7:8:9', 'x'.repeat(500), '<script>']) {
      expect(foldAddress(bad), String(bad)).toBe('unknown');
    }
  });

  it('behind a proxy takes the last X-Forwarded-For entry, which the caller did not write', () => {
    expect(clientKey('198.51.100.9', '10.0.0.2', true)).toBe('198.51.100.9');
    // The caller put the first entry there. The proxy appended the second.
    expect(clientKey('192.0.2.1, 198.51.100.9', '10.0.0.2', true)).toBe('198.51.100.9');
    expect(clientKey(['192.0.2.1', '192.0.2.2, 198.51.100.9'], '10.0.0.2', true)).toBe('198.51.100.9');
    expect(clientKey(undefined, '10.0.0.2', true)).toBe('10.0.0.2');
    expect(clientKey('garbage', '10.0.0.2', true)).toBe('unknown');
  });

  it('with no proxy ignores the header, so a caller cannot name a new address each time', () => {
    expect(clientKey('198.51.100.9', '127.0.0.1', false)).toBe('127.0.0.1');
    expect(clientKey('198.51.100.10', '::ffff:127.0.0.1', false)).toBe('127.0.0.1');
  });
});

describe('the request limit', () => {
  it('allows the limit in one window, refuses the next, and says how long to wait', () => {
    let at = 1_000_000;
    const limiter = new RateLimiter(() => at);
    const rule = { limit: 3, windowMs: 60_000 };
    for (let i = 0; i < 3; i++) expect(limiter.take('door', '203.0.113.7', rule)).toEqual({ ok: true });
    expect(limiter.take('door', '203.0.113.7', rule)).toEqual({ ok: false, retryAfterSeconds: 60 });
    at += 45_500;
    expect(limiter.take('door', '203.0.113.7', rule)).toEqual({ ok: false, retryAfterSeconds: 15 });
    at += 14_499;
    expect(limiter.take('door', '203.0.113.7', rule)).toEqual({ ok: false, retryAfterSeconds: 1 });
    at += 1;
    expect(limiter.take('door', '203.0.113.7', rule)).toEqual({ ok: true });
  });

  it('counts each client and each limit apart', () => {
    const limiter = new RateLimiter(() => 0);
    const rule = { limit: 1, windowMs: 60_000 };
    expect(limiter.take('door', '203.0.113.7', rule).ok).toBe(true);
    expect(limiter.take('door', '203.0.113.7', rule).ok).toBe(false);
    expect(limiter.take('door', '203.0.113.8', rule).ok).toBe(true);
    expect(limiter.take('read', '203.0.113.7', rule).ok).toBe(true);
  });

  it('a refused request does not extend the wait', () => {
    let at = 0;
    const limiter = new RateLimiter(() => at);
    const rule = { limit: 1, windowMs: 10_000 };
    limiter.take('door', 'a', rule);
    for (let i = 0; i < 50; i++) { at += 100; expect(limiter.take('door', 'a', rule).ok).toBe(false); }
    at = 10_000;
    expect(limiter.take('door', 'a', rule).ok).toBe(true);
  });

  it('keeps a table no larger than its ceiling, dropping the client longest idle', () => {
    let at = 0;
    const limiter = new RateLimiter(() => at, 4);
    const rule = { limit: 1, windowMs: 60_000 };
    for (const client of ['a', 'b', 'c', 'd']) { at += 1; limiter.take('door', client, rule); }
    expect(limiter.size).toBe(4);
    for (let i = 0; i < 100; i++) { at += 1; limiter.take('door', `made-up-${i}`, rule); }
    expect(limiter.size).toBe(4);
    // `a` was dropped, so it starts a new window; the newest client is still being counted.
    expect(limiter.take('door', 'a', rule).ok).toBe(true);
    expect(limiter.take('door', 'made-up-99', rule).ok).toBe(false);
    expect(limiter.size).toBe(4);
    expect(DEFAULT_MAX_RATE_CLIENTS).toBeGreaterThan(1_000);
  });
});

describe('a table callers can fill', () => {
  it('drops its oldest entries down to the ceiling and leaves a smaller table alone', () => {
    const table = new Map<string, number>([['a', 1], ['b', 2], ['c', 3], ['d', 4]]);
    bound(table, 9);
    expect([...table.keys()]).toEqual(['a', 'b', 'c', 'd']);
    bound(table, 2);
    expect([...table.keys()]).toEqual(['c', 'd']);
    bound(table, 0);
    expect(table.size).toBe(0);
  });
});

describe('the /health body', () => {
  it('always carries status, service and the build the deploy verifier compares', () => {
    expect(healthBody({ service: 'made-up-bridge', build: 'abc123' })).toEqual({ status: 'ok', build: 'abc123', service: 'made-up-bridge' });
    expect(healthBody({ service: 'made-up-bridge', build: undefined }).build).toBe('unset');
    expect(healthBody({ service: 'made-up-bridge', build: '  ' }).build).toBe('unset');
    expect(healthBody({ service: 'made-up-bridge', build: 'abc123', status: 'starting' }).status).toBe('starting');
    // The verifier reads exactly this field.
    const verifier = readFileSync(join(here, '../../../tools/railway-redeploy.mjs'), 'utf8');
    expect(verifier).toContain('seen = j.build ??');
  });

  it('lets a bridge add facts of its own, none of which can replace those three', () => {
    const body = healthBody({ service: 'made-up-bridge', build: 'abc123', extra: { startedAt: 'then', build: 'forged', status: 'forged', service: 'forged' } });
    expect(body).toEqual({ status: 'ok', build: 'abc123', service: 'made-up-bridge', startedAt: 'then' });
  });

  it('imports no web framework and reads no environment', () => {
    for (const file of ['bounded.ts', 'health.ts', 'index.ts', 'public-origin.ts', 'rate-limit.ts']) {
      const source = readFileSync(join(here, '../http-guard', file), 'utf8');
      expect(source, file).not.toMatch(/from 'express|process\.env/);
    }
  });
});
