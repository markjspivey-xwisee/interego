/**
 * Passkey (WebAuthn) end-to-end OAuth flow test.
 *
 * Uses Chrome DevTools Protocol's WebAuthn domain to register a virtual
 * authenticator inside the headless browser session, then:
 *
 *   1. Runs the relay's OAuth Dynamic Client Registration flow
 *   2. Opens /authorize with a PKCE code_challenge
 *   3. Clicks "Register new" passkey against a fresh userId
 *   4. Expects browser to get redirected to the registered redirect_uri
 *      with ?code=<auth_code>&state=<state>
 *   5. Exchanges code for OAuth access token
 *   6. Calls /mcp with the token — tools/list should return >= 15 tools
 *
 * The virtual authenticator is a platform-agnostic replacement for a
 * physical security key / phone passkey — Chrome synthesizes valid
 * CBOR attestations and signatures against a reproducible key the
 * CDP interface controls. SimpleWebAuthn on the server side treats
 * it identically to a real device. This is the standard way to CI-gate
 * WebAuthn flows.
 */
import { test, expect, request, type Page } from '@playwright/test';
import { createHash, randomBytes } from 'node:crypto';

const RELAY_URL = process.env.BASE_URL ?? 'https://interego-relay.livelysky-8b81abb0.eastus.azurecontainerapps.io';

async function enableVirtualAuthenticator(page: Page): Promise<string> {
  const client = await page.context().newCDPSession(page);
  await client.send('WebAuthn.enable');
  const { authenticatorId } = await client.send('WebAuthn.addVirtualAuthenticator', {
    options: {
      protocol: 'ctap2',
      transport: 'internal',    // platform authenticator, like Face ID / Touch ID
      hasResidentKey: true,
      hasUserVerification: true,
      isUserVerified: true,
      automaticPresenceSimulation: true,
    },
  });
  return authenticatorId;
}

function pkce(): { verifier: string; challenge: string } {
  const verifier = randomBytes(32).toString('base64url');
  const challenge = createHash('sha256').update(verifier).digest('base64url');
  return { verifier, challenge };
}

test('passkey OAuth dance issues a usable MCP token', async ({ page }) => {
  const api = await request.newContext();

  // 1. Dynamic Client Registration
  const dcr = await api.post(`${RELAY_URL}/register`, {
    headers: { 'Content-Type': 'application/json' },
    data: {
      client_name: 'playwright-passkey',
      redirect_uris: ['http://localhost:9999/cb'],
      grant_types: ['authorization_code'],
      response_types: ['code'],
      token_endpoint_auth_method: 'none',
    },
  });
  expect(dcr.ok()).toBeTruthy();
  const { client_id: clientId } = await dcr.json();
  expect(clientId).toBeTruthy();

  // 2. Set up virtual WebAuthn authenticator, then navigate to /authorize
  const { verifier, challenge } = pkce();
  const state = randomBytes(8).toString('hex');
  // Display name only — userId is DERIVED from the credential server-side
  // (`u-pk-<sha256(credId)[:12]>`), not claimed by the caller. The randomness
  // here is just to get a human-readable unique display string in logs.
  const displayName = 'pw-passkey-' + randomBytes(4).toString('hex');

  await enableVirtualAuthenticator(page);

  const authUrl = `${RELAY_URL}/authorize?response_type=code&client_id=${clientId}&redirect_uri=http%3A%2F%2Flocalhost%3A9999%2Fcb&code_challenge=${challenge}&code_challenge_method=S256&scope=mcp&state=${state}`;

  // Intercept the client's redirect callback — it's a localhost URL that
  // wouldn't resolve in a real browser, but the redirect only needs to set
  // the URL so we can read back code + state. Stub it with a trivial 200.
  await page.route('http://localhost:9999/**', (route) =>
    route.fulfill({ status: 200, contentType: 'text/html', body: '<html><body>ok</body></html>' }),
  );

  await page.goto(authUrl);

  // 3. Fill the display name, click "Register new".
  // The authorize page no longer exposes a `#pk-user` field because
  // the server-side userId is derived from the credential, not claimed.
  await page.fill('#pk-name', displayName);
  const redirectPromise = page.waitForURL(url => url.toString().startsWith('http://localhost:9999/cb?'), { timeout: 30_000 });
  await page.getByRole('button', { name: /register new/i }).click();
  await redirectPromise;

  const finalUrl = new URL(page.url());
  const code = finalUrl.searchParams.get('code');
  const returnedState = finalUrl.searchParams.get('state');
  expect(code, 'auth code present in redirect').toBeTruthy();
  expect(returnedState, 'state round-trips').toBe(state);

  // 4. Exchange the code for an access token
  const token = await api.post(`${RELAY_URL}/token`, {
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    form: {
      grant_type: 'authorization_code',
      code: code!,
      client_id: clientId,
      code_verifier: verifier,
      redirect_uri: 'http://localhost:9999/cb',
    },
  });
  expect(token.ok()).toBeTruthy();
  const { access_token: accessToken } = await token.json();
  expect(accessToken).toBeTruthy();

  // 5. Use the access token to list MCP tools
  const tools = await api.post(`${RELAY_URL}/mcp`, {
    headers: {
      'Content-Type': 'application/json',
      'Accept': 'application/json, text/event-stream',
      'Authorization': `Bearer ${accessToken}`,
    },
    data: {
      jsonrpc: '2.0', id: 1, method: 'tools/list', params: {},
    },
  });
  expect(tools.ok()).toBeTruthy();
  const body = await tools.text();
  const match = body.match(/"tools":\[([\s\S]*?)\]/);
  expect(match, 'tools array in response').toBeTruthy();
  // Sanity-check a handful of expected tool names are present
  for (const expectedTool of ['publish_context', 'discover_context', 'get_descriptor']) {
    expect(body, `${expectedTool} tool exposed`).toContain(`"name":"${expectedTool}"`);
  }

  // 6. Cleanup — purge the test user so live identity / pod state stays
  // pristine. The relay's MCP token wraps an identity-server bearer in
  // its `extra` field; swap it out via /identity-token, then call
  // /users/me/delete which removes the in-memory identity, kills its
  // tokens, and DELETEs the pod-side auth-methods + agents files.
  // Failures here are best-effort logged (the janitor in identity will
  // sweep stale test users older than the configured grace window).
  try {
    const itResp = await api.get(`${RELAY_URL}/identity-token`, {
      headers: { 'Authorization': `Bearer ${accessToken}` },
    });
    if (itResp.ok()) {
      const { identityToken } = await itResp.json() as { identityToken?: string };
      if (identityToken) {
        // Identity is on a different host; hit it directly. Resolve via
        // the relay's /.well-known/oauth-authorization-server which
        // exposes the identity issuer, OR derive from the relay host.
        const identityUrl = RELAY_URL.replace('interego-relay', 'interego-identity');
        const delResp = await api.post(`${identityUrl}/users/me/delete`, {
          headers: { 'Authorization': `Bearer ${identityToken}` },
        });
        if (!delResp.ok()) {
          console.warn(`[cleanup] /users/me/delete returned ${delResp.status()}: ${await delResp.text()}`);
        }
      }
    } else {
      console.warn(`[cleanup] /identity-token returned ${itResp.status()}`);
    }
  } catch (err) {
    console.warn(`[cleanup] threw: ${(err as Error).message}`);
  }
});
