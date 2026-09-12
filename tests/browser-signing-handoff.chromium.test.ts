import { createHash, generateKeyPairSync, randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import express from 'express';
import { isoCBOR } from '@simplewebauthn/server/helpers';
import { describe, expect, it, vi } from 'vitest';
import { clientInteractionHttpHandler } from '../deploy/mcp-relay/client-interaction-http.js';
import { corsMiddleware } from '../deploy/mcp-relay/cors-allowlist.js';
import { listenLoopback } from '../deploy/mcp-relay/tests/listen-loopback.js';
import { clientKeyId, clientSigningMessage, type ClientSigningKey } from '../integrations/application-runtime/client-authorization.js';
import { signingFixture } from './fixtures/client-interaction-fixture.js';

// Optional local browser gate, without adding a workspace dependency:
// INTEREGO_TEST_CHROMIUM=1 npx vitest run tests/browser-signing-handoff.chromium.test.ts
// Requires an existing @playwright/test install and its Chromium binary.
// All credentials and commits belong to the in-memory fixture. The CDP virtual
// authenticator exercises native WebAuthn, not a person's physical passkey UI.
interface BrowserRequest {
  url(): string;
  method(): string;
  allHeaders(): Promise<Record<string, string>>;
  postData(): string | null;
}
interface BrowserRoute {
  request(): BrowserRequest;
  fulfill(response: { status?: number; headers?: Record<string, string>; contentType?: string; body?: string }): Promise<void>;
}
interface BrowserPage {
  route(pattern: string, handler: (route: BrowserRoute) => Promise<void>): Promise<void>;
  goto(url: string): Promise<unknown>;
  addInitScript(script: () => void): Promise<void>;
  evaluate<T>(script: () => T | Promise<T>): Promise<T>;
  locator(selector: string): { waitFor(options?: { timeout?: number }): Promise<void>; click(): Promise<void>; textContent(): Promise<string | null> };
  waitForFunction(script: () => boolean): Promise<unknown>;
}
interface BrowserContext {
  newPage(): Promise<BrowserPage>;
  newCDPSession(page: BrowserPage): Promise<{ send(method: string, params?: Record<string, unknown>): Promise<Record<string, unknown>> }>;
  cookies(): Promise<unknown[]>;
  close(): Promise<void>;
}
interface ChromiumBrowser {
  newContext(): Promise<BrowserContext>;
  close(): Promise<void>;
}
interface BrowserStats {
  gets: Array<{ challenge: string; rpId?: string; userVerification?: string }>;
  storageAttempts: string[];
  initialStorage: { local: number; session: number };
}

describe.skipIf(process.env['INTEREGO_TEST_CHROMIUM'] !== '1')('native Chromium request-only signing', () => {
  it.each(['https://identity.example', 'https://relay.example'])('commits through one native WebAuthn assertion from %s', async origin => {
    // Dynamic optional import deliberately avoids requiring Playwright in CI's
    // normal dependency graph or typecheck when this browser gate is skipped.
    const optionalPackage = '@playwright/test';
    const { chromium } = await import(optionalPackage) as {
      chromium: { launch(options: { headless: boolean }): Promise<ChromiumBrowser> };
    };
    const browser = await chromium.launch({ headless: true });
    let context: BrowserContext | undefined;
    let http: Awaited<ReturnType<typeof listenLoopback>> | undefined;
    try {
      const relayOrigin = 'https://relay.example';
      const rpId = new URL(origin).hostname;
      const pair = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
      const jwk = pair.publicKey.export({ format: 'jwk' });
      const cose = new Map<number, number | Uint8Array>([[1, 2], [3, -7], [-1, 1],
        [-2, Buffer.from(jwk.x!, 'base64url')], [-3, Buffer.from(jwk.y!, 'base64url')]]);
      const credentialId = randomBytes(32);
      const key: ClientSigningKey = { scheme: 'webauthn', publicKey: Buffer.from(isoCBOR.encode(cose)).toString('base64url'),
        credentialId: credentialId.toString('base64url'), origins: [origin], rpIds: [rpId] };
      const f = await signingFixture({ signingKeys: { alice: [key] } });
      f.deps.publicUrl = origin;
      const pending = (await f.create())!;
      const id = String(pending['id']);
      const launch = await f.broker.openSigning(id, f.owners['alice']!);
      const launchUrl = String(launch['signingUrl']);
      const launchCode = new URL(launchUrl).hash.slice('#launch='.length);
      const verifyHolder = vi.fn(async () => undefined);
      const app = express();
      app.use(corsMiddleware({ ownOrigin: relayOrigin, extra: [origin] }));
      app.options(/.*/, (_req, res) => res.sendStatus(204));
      app.use(express.json());
      app.use('/client-interactions', clientInteractionHttpHandler({ interactions: f.broker, verifyHolder }));
      http = await listenLoopback(app);
      const base = http.base;
      const calls: Array<{ path: string; method: string; origin?: string; credential?: string; authorization?: string; cookie?: string }> = [];
      let reviewedMessage = '';
      let submittedMessage = '';
      context = await browser.newContext();
      expect(await context.cookies()).toEqual([]);
      const page = await context.newPage();
      const cdp = await context.newCDPSession(page);
      await cdp.send('WebAuthn.enable');
      const added = await cdp.send('WebAuthn.addVirtualAuthenticator', { options: {
        protocol: 'ctap2', transport: 'internal', hasResidentKey: true, hasUserVerification: true,
        isUserVerified: true, automaticPresenceSimulation: true,
      } });
      expect(typeof added['authenticatorId']).toBe('string');
      await cdp.send('WebAuthn.addCredential', { authenticatorId: added['authenticatorId'], credential: {
        credentialId: credentialId.toString('base64'), rpId, isResidentCredential: false, signCount: 0,
        privateKey: pair.privateKey.export({ type: 'pkcs8', format: 'der' }).toString('base64'),
      } });
      await page.addInitScript(() => {
        const stats: BrowserStats = { gets: [], storageAttempts: [],
          initialStorage: { local: localStorage.length, session: sessionStorage.length } };
        (window as unknown as { signingBrowserStats: BrowserStats }).signingBrowserStats = stats;
        // Observe, then delegate unchanged to Chromium's native WebAuthn API.
        const nativeGet = CredentialsContainer.prototype.get;
        CredentialsContainer.prototype.get = function (options) {
          if (options?.publicKey) {
            const bytes = new Uint8Array(options.publicKey.challenge as ArrayBuffer);
            stats.gets.push({ challenge: btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, ''),
              rpId: options.publicKey.rpId, userVerification: options.publicKey.userVerification });
          }
          return nativeGet.call(this, options);
        };
        for (const name of ['localStorage', 'sessionStorage']) Object.defineProperty(window, name, {
          get() { stats.storageAttempts.push(name); throw new Error('Request-only signing must not access browser storage.'); },
        });
      });
      const html = readFileSync(new URL('../docs/client-sign.html', import.meta.url), 'utf8')
        .replace('__INTEREGO_SIGNING_CONFIG__', JSON.stringify({ identityUrl: 'https://identity.example', relayUrl: relayOrigin,
          signingOrigins: ['https://identity.example', relayOrigin] }));
      await page.route('https://**/*', async route => {
        const request = route.request();
        const url = new URL(request.url());
        if (url.origin === origin && url.pathname === '/sign-action') {
          await route.fulfill({ contentType: 'text/html', body: html }); return;
        }
        if (url.pathname === '/favicon.ico') { await route.fulfill({ status: 204 }); return; }
        const headers = await request.allHeaders();
        calls.push({ path: url.pathname, method: request.method(), origin: headers['origin'],
          credential: headers['x-interego-browser-signing'], authorization: headers['authorization'], cookie: headers['cookie'] });
        if (url.origin !== relayOrigin || !url.pathname.startsWith('/client-interactions/' + id + '/')) {
          await route.fulfill({ status: 404, body: 'Unexpected fixture request' }); return;
        }
        expect(await page.evaluate(() => location.hash)).toBe('');
        expect(headers['origin']).toBe(origin); // Forward the actual browser header; never manufacture it.
        if (request.method() === 'POST') expect(headers['referer']).toBe(origin + '/'); // No request ID or launch code in referrers.
        expect(headers['authorization']).toBeUndefined(); expect(headers['cookie']).toBeUndefined();
        const operation = url.pathname.split('/').at(-1)!;
        expect(['exchange', 'status', 'review', 'submit']).toContain(operation);
        const body = request.postData();
        if (request.method() === 'POST' && operation === 'submit') submittedMessage = JSON.parse(body!).proof.message;
        const response = await fetch(base + url.pathname, { method: request.method(),
          headers: Object.fromEntries(Object.entries(headers).filter(([name]) => !['host', 'content-length', 'connection', 'accept-encoding'].includes(name))),
          ...(body === null ? {} : { body }) });
        const text = await response.text();
        if (request.method() === 'POST' && operation === 'review' && response.ok) reviewedMessage = JSON.parse(text).signingRequest.message;
        expect(response.headers.get('access-control-allow-origin')).toBe(origin);
        expect(response.headers.get('access-control-allow-credentials')).toBeNull();
        await route.fulfill({ status: response.status, body: text,
          headers: Object.fromEntries([...response.headers].filter(([name]) => !['content-length', 'content-encoding', 'connection', 'transfer-encoding'].includes(name))) });
      });
      await page.goto(launchUrl);
      await page.locator('#sign:not([disabled])').waitFor({ timeout: 15_000 });
      expect(f.publish).not.toHaveBeenCalled();
      const before = await page.evaluate(() => (window as unknown as { signingBrowserStats: BrowserStats }).signingBrowserStats);
      expect(before).toEqual({ gets: [], storageAttempts: [], initialStorage: { local: 0, session: 0 } });
      const hidden = await page.evaluate(() => ['passkey-login', 'wallet-login', 'cancel', 'origin-recovery', 'scoped-signing']
        .every(id => (document.getElementById(id) as HTMLElement).hidden));
      expect(hidden).toBe(true);
      await page.locator('#sign').click();
      await page.waitForFunction(() => document.getElementById('status')!.textContent!.includes('Signed, verified and submitted'));
      const after = await page.evaluate(() => (window as unknown as { signingBrowserStats: BrowserStats }).signingBrowserStats);
      expect(after.gets).toEqual([{ challenge: createHash('sha256').update(clientSigningMessage(reviewedMessage, key)).digest('base64url'),
        rpId, userVerification: 'required' }]);
      expect(after.storageAttempts).toEqual([]);
      expect(submittedMessage).toBe(reviewedMessage);
      expect(JSON.parse(reviewedMessage)).toMatchObject({ actor: f.owners['alice']!.principal,
        contractDigest: f.initial.activeContractEnvelope.declaredDigest, expectedHead: f.initial.stateDescriptor.cid });
      expect(f.publish).toHaveBeenCalledTimes(1);
      expect(verifyHolder).not.toHaveBeenCalled();
      expect(calls.filter(call => call.method !== 'OPTIONS').map(call => call.path.split('/').at(-1)))
        .toEqual(['exchange', 'status', 'review', 'submit']);
      const current = await f.store.resolve();
      expect(current.replay.complete).toBe(true);
      expect(current.state.data['approvals']).toEqual([expect.objectContaining({ approver: f.owners['alice']!.principal,
        keyId: clientKeyId(key), verified: true })]);
      const documentMarkup = await page.evaluate(() => document.documentElement.outerHTML);
      expect(documentMarkup).not.toContain(launchCode);
      const browserCredential = calls.find(call => call.credential)?.credential;
      expect(browserCredential).toMatch(/^[a-zA-Z0-9_-]{43}$/);
      expect(documentMarkup).not.toContain(browserCredential);
      expect(await context.cookies()).toEqual([]);
    } finally { await context?.close(); await browser.close(); await http?.close(); }
  }, 60_000);
});
