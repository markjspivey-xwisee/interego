import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import express from 'express';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { MemoryStore } from 'express-rate-limit';
import { LtiPlatform, attachLtiPlatformRoutes } from '../src/lti-platform.js';

const servers: Server[] = [], stores: MemoryStore[] = [];
const originalInit = MemoryStore.prototype.init;
beforeEach(() => {
  vi.spyOn(MemoryStore.prototype, 'init').mockImplementation(function (this: MemoryStore, options) {
    stores.push(this); originalInit.call(this, options);
  });
});
afterEach(async () => {
  for (const store of stores.splice(0)) store.shutdown();
  vi.useRealTimers(); vi.restoreAllMocks();
  await Promise.all(servers.splice(0).map(server => new Promise<void>(resolve => {
    server.closeAllConnections(); server.close(() => resolve());
  })));
});

async function fixture(options: { ready?: () => Promise<boolean>; trustedProxy?: boolean } = {}) {
  const app = express();
  // This explicit fixture proxy permits simulated client IPs. Production's
  // framework trust policy is not changed by attachLtiPlatformRoutes.
  if (options.trustedProxy) app.set('trust proxy', 'loopback');
  const ready = vi.fn(options.ready ?? (() => Promise.resolve(true)));
  const platform = new LtiPlatform({ selfBaseUrl: 'https://lms.example', ensureReady: ready });
  const authorize = vi.spyOn(platform, 'authorize');
  attachLtiPlatformRoutes(app, platform);
  const server = createServer(app); servers.push(server);
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return { app, platform, ready, authorize, origin, auth: origin + '/lti/platform/auth' };
}

function requestForm(params: Record<string, string>): RequestInit {
  return { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
    body: new URLSearchParams(params).toString() };
}
function grant(platform: LtiPlatform): Record<string, string> {
  const start = platform.beginLaunch({ sub: 'https://identity.example/users/synthetic/profile#me',
    podUrl: 'https://pod.example/synthetic/' }, { id: 'synthetic-course', title: 'Rate-limit fixture' });
  if (!start.ok) throw new Error('synthetic launch fixture refused');
  const hints = new URL(start.initiationUrl).searchParams;
  return { scope: 'openid', response_type: 'id_token', response_mode: 'form_post', client_id: 'foxxi-tool',
    redirect_uri: 'https://lms.example/lti/launch', nonce: 'synthetic-nonce', state: 'synthetic-state',
    login_hint: hints.get('login_hint')!, lti_message_hint: hints.get('lti_message_hint')! };
}
function bucketCount(store: MemoryStore): number {
  const maps = store as unknown as { current: Map<string, unknown>; previous: Map<string, unknown> };
  return maps.current.size + maps.previous.size;
}

describe('own-LMS authorization rate protection', () => {
  it('shares GET/POST client limits before readiness and parsing, ignores untrusted XFF, and preserves a blocked grant', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    const f = await fixture(), params = grant(f.platform);
    expect(f.app.get('trust proxy')).toBe(false);
    for (let i = 0; i < 30; i++) {
      const init: RequestInit = i % 2 ? requestForm({}) : {};
      // The initial request has no forwarding header, so the library validates
      // the real framework setup; rotating later spoofed values grants no budget.
      if (i > 0) init.headers = { ...init.headers as Record<string, string>, 'X-Forwarded-For': `198.51.100.${i}` };
      const response = await fetch(f.auth, init);
      expect(response.status).toBe(400); await response.arrayBuffer();
    }
    const blocked = await fetch(f.auth, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: 'oversized=' + 'x'.repeat(70_000) });
    expect(blocked.status).toBe(429); expect(await blocked.json()).toEqual({ error: 'too_many_requests' });
    expect(Number(blocked.headers.get('Retry-After'))).toBeGreaterThan(0);
    expect(Number(blocked.headers.get('Retry-After'))).toBeLessThanOrEqual(60);
    expect(blocked.headers.get('RateLimit')).toContain('lti-auth-client');
    expect(f.ready).toHaveBeenCalledTimes(30); expect(f.authorize).toHaveBeenCalledTimes(30);
    const blockedGrant = await fetch(f.auth, requestForm(params));
    expect(blockedGrant.status).toBe(429); await blockedGrant.arrayBuffer();
    expect(f.authorize).toHaveBeenCalledTimes(30);
    vi.setSystemTime(Date.now() + 61_000);
    const recovered = await fetch(f.auth, requestForm(params));
    expect(recovered.status).toBe(200);
    expect(await recovered.json()).toMatchObject({ form_post: { action: params.redirect_uri,
      fields: { state: params.state, id_token: expect.any(String) } } });
    // The ordinary one-use authorization contract still applies after recovery.
    expect((await fetch(f.auth, requestForm(params))).status).toBe(401);
  });

  it('caps total work and IP-store admission before hydration across many clients', async () => {
    const f = await fixture({ trustedProxy: true });
    const statuses: number[] = [];
    for (let batch = 0; batch < 25; batch++) {
      statuses.push(...await Promise.all(Array.from({ length: 20 }, async (_, offset) => {
        const n = batch * 20 + offset;
        const response = await fetch(f.auth, { headers: { 'X-Forwarded-For': `198.18.${Math.floor(n / 250)}.${n % 250 + 1}` } });
        const status = response.status; await response.arrayBuffer(); return status;
      })));
    }
    expect(statuses.filter(status => status === 400)).toHaveLength(300);
    expect(statuses.filter(status => status === 429)).toHaveLength(200);
    expect(f.ready).toHaveBeenCalledTimes(300); expect(f.authorize).toHaveBeenCalledTimes(300);
    expect(stores).toHaveLength(2);
    expect(bucketCount(stores[0]!)).toBe(1); expect(bucketCount(stores[1]!)).toBe(300);
    const blocked = await fetch(f.auth);
    expect(blocked.status).toBe(429); expect(Number(blocked.headers.get('Retry-After'))).toBeGreaterThan(0);
    expect(blocked.headers.get('RateLimit')).toContain('lti-auth-total'); await blocked.arrayBuffer();
    expect(bucketCount(stores[1]!)).toBe(300);
  });

  it('groups rotated IPv6 addresses by /56 while retaining independent subnet budgets', async () => {
    const f = await fixture({ trustedProxy: true });
    for (let i = 0; i < 30; i++) {
      const response = await fetch(f.auth, { headers: { 'X-Forwarded-For': `2001:db8:1234:${i.toString(16)}::1` } });
      expect(response.status).toBe(400); await response.arrayBuffer();
    }
    const sameSubnet = await fetch(f.auth, { headers: { 'X-Forwarded-For': '2001:db8:1234:fe::2' } });
    expect(sameSubnet.status).toBe(429); await sameSubnet.arrayBuffer();
    const otherSubnet = await fetch(f.auth, { headers: { 'X-Forwarded-For': '2001:db8:1234:100::1' } });
    expect(otherSubnet.status).toBe(400); await otherSubnet.arrayBuffer();
    expect(f.ready).toHaveBeenCalledTimes(31); expect(bucketCount(stores[1]!)).toBe(2);
  });

  it('limits unavailable hydration attempts without gating stateless metadata or changing gradebook data', async () => {
    const f = await fixture({ ready: () => Promise.resolve(false) });
    for (let i = 0; i < 30; i++) {
      const response = await fetch(f.auth, i % 2 ? requestForm({}) : {});
      expect(response.status).toBe(503); expect(await response.json()).toEqual({ error: 'lti_gradebook_unavailable' });
    }
    const blocked = await fetch(f.auth);
    expect(blocked.status).toBe(429); await blocked.arrayBuffer();
    expect(f.ready).toHaveBeenCalledTimes(30); expect(f.authorize).not.toHaveBeenCalled();
    const configuration = await fetch(f.origin + '/lti/platform/.well-known/openid-configuration');
    expect(configuration.status).toBe(200); expect(await configuration.json()).toMatchObject({ issuer: f.platform.issuer });
    const jwks = await fetch(f.origin + '/lti/platform/jwks.json');
    expect(jwks.status).toBe(200); expect(await jwks.json()).toMatchObject({ keys: expect.any(Array) });
    expect(f.platform.snapshot()).toEqual({ lineItems: [], results: [], members: [] });
    expect(f.ready).toHaveBeenCalledTimes(30);
  });

  it('expires inactive default-store buckets and releases their timers', async () => {
    vi.useFakeTimers({ toFake: ['Date', 'setInterval', 'clearInterval'] });
    const f = await fixture();
    const response = await fetch(f.auth); expect(response.status).toBe(400); await response.arrayBuffer();
    expect(stores.map(bucketCount)).toEqual([1, 1]);
    await vi.advanceTimersByTimeAsync(120_000);
    expect(stores.map(bucketCount)).toEqual([0, 0]);
    for (const store of stores) store.shutdown();
    expect(vi.getTimerCount()).toBe(0);
  });
});
