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
import { test, expect, request, type Page, type CDPSession } from '@playwright/test';
import { createHash, randomBytes } from 'node:crypto';
import { signedJsonGraph, type Json } from '../../../integrations/application-runtime/application-lab-runtime.js';
import { clientKeyId, clientSigningMessage, verifyClientAuthorization } from '../../../integrations/application-runtime/client-authorization.js';

const RELAY_URL = process.env.BASE_URL ?? 'https://relay.interego.xwisee.com';
/** Browser lexical state used only to inspect this synthetic test's key. */
declare const pendingGrant: { keyPair: CryptoKeyPair };
const IDENTITY_URL = process.env.IDENTITY_URL ?? 'https://identity.interego.xwisee.com';

async function enableVirtualAuthenticator(page: Page): Promise<{ client: CDPSession; authenticatorId: string }> {
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
  return { client, authenticatorId };
}

function pkce(): { verifier: string; challenge: string } {
  const verifier = randomBytes(32).toString('base64url');
  const challenge = createHash('sha256').update(verifier).digest('base64url');
  return { verifier, challenge };
}

test('passkey OAuth dance issues a usable MCP token', async ({ page, browser }) => {
  // Includes an additional live action through a fresh request-only browser.
  test.setTimeout(420_000);
  const api = await request.newContext();

  // 1. Dynamic Client Registration
  const dcr = await api.post(`${RELAY_URL}/register`, {
    headers: { 'Content-Type': 'application/json' },
    data: {
      client_name: 'playwright-passkey',
      redirect_uris: ['http://localhost:9999/cb'],
      grant_types: ['authorization_code', 'refresh_token'],
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

  const registeredAuthenticator = await enableVirtualAuthenticator(page);

  const authUrl = `${RELAY_URL}/authorize?response_type=code&client_id=${clientId}&redirect_uri=http%3A%2F%2Flocalhost%3A9999%2Fcb&code_challenge=${challenge}&code_challenge_method=S256&scope=mcp&state=${state}`;

  // Intercept the client's redirect callback — it's a localhost URL that
  // wouldn't resolve in a real browser, but the redirect only needs to set
  // the URL so we can read back code + state. Stub it with a trivial 200.
  await page.route('http://localhost:9999/**', (route) =>
    route.fulfill({ status: 200, contentType: 'text/html', body: '<html><body>ok</body></html>' }),
  );

  // Surface in-browser console output and page errors in CI logs so the
  // next failure shows the live status text ("Creating passkey..." vs
  // "err: …") and any /oauth/verify HTTP error, instead of leaving us
  // guessing from a static page snapshot.
  page.on('console', m => console.log('[page]', m.type(), m.text()));
  page.on('pageerror', e => console.log('[pageerror]', e.message));

  await page.goto(authUrl);

  // 3. Fill the display name, click "Register new".
  // The authorize page no longer exposes a `#pk-user` field because
  // the server-side userId is derived from the credential, not claimed.
  await page.fill('#pk-name', displayName);
  // 120s budget: a first-touch pod-bootstrap on a cold Azure Container
  // Apps instance has to walk readAgentRegistry -> putRelayProfileCard
  // -> ensurePodAcls -> writeAgentRegistry -> publishPodBootstrapDescriptor
  // -> verify-read through the css-gate synchronously inside /oauth/verify
  // (deploy/mcp-relay/server.ts:4614-4634). 30s is not enough headroom
  // for that worst case + retries; 120s is. Follow-up server-side fix
  // moves bootstrapPod off the response path so this can shrink again.
  const redirectPromise = page.waitForURL(url => url.toString().startsWith('http://localhost:9999/cb?'), { timeout: 120_000 });
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
  const { access_token: accessToken, refresh_token: refreshToken } = await token.json();
  expect(accessToken).toBeTruthy();

  try {
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

  // Exercise the deployed identity renewal, then the deployed signing page with
  // this test's own virtual passkey. These signatures are never real approvals.
  const oldIdentity = await api.get(`${RELAY_URL}/identity-token`, { headers: { Authorization: `Bearer ${accessToken}` } });
  expect(oldIdentity.ok()).toBeTruthy();
  const oldIdentityBody = await oldIdentity.json();
  const refreshed = await api.post(`${RELAY_URL}/token`, { form: { grant_type: 'refresh_token', client_id: clientId, refresh_token: refreshToken } });
  expect(refreshed.ok()).toBeTruthy();
  const freshTokens = await refreshed.json();
  const freshIdentity = await api.get(`${RELAY_URL}/identity-token`, { headers: { Authorization: `Bearer ${freshTokens.access_token}` } });
  expect(freshIdentity.ok()).toBeTruthy();
  const freshIdentityBody = await freshIdentity.json();
  expect(freshIdentityBody.identityToken).toBeTruthy();
  expect(freshIdentityBody.identityToken).not.toBe(oldIdentityBody.identityToken);
  const methods = await api.get(`${IDENTITY_URL}/auth-methods/me?purpose=client-signature`, {
    headers: { Authorization: `Bearer ${freshIdentityBody.identityToken}` },
  });
  expect(methods.ok()).toBeTruthy();
  const credential = (await methods.json()).webAuthnCredentials[0];
  expect(credential.rpIds).toEqual([new URL(RELAY_URL).hostname]);
  const key = { scheme: 'webauthn' as const, credentialId: credential.id, publicKey: credential.publicKey,
    rpIds: credential.rpIds, origins: credential.origins };
  const message = JSON.stringify({ actor: 'did:example:isolated-browser-test', actionIri: 'urn:test:passkey-signature',
    authority: { purpose: 'synthetic browser verification only' }, expectedHead: 'synthetic-head', contractDigest: 'synthetic-contract', at: new Date().toISOString() });
  await page.goto(`${RELAY_URL}/sign-action`);
  await page.fill('#request', JSON.stringify({ schema: 'interego.client-signing-request/v1', message,
    keys: [{ keyId: clientKeyId(key), key }], expiresAt: new Date(Date.now() + 600_000).toISOString() }));
  await page.locator('#load').click();
  await page.locator('#sign').click();
  await expect(page.locator('#proof')).not.toHaveValue('');
  const proof = JSON.parse(await page.locator('#proof').inputValue());
  const verifiedProof = await verifyClientAuthorization(proof, message, [key]);
  expect(verifiedProof.keyId).toBe(clientKeyId(key));
  expect((await verifyClientAuthorization(verifiedProof.proof, message)).keyId).toBe(verifiedProof.keyId);
  // A second isolated scenario exercises the deployed scoped companion end to
  // end. The passkey and subordinate signing key are owned by Chromium here.
  let callSequence = 100;
  const call = async (name: string, args: Record<string, unknown> = {}, includePrivateMetadata = false) => {
    const response = await api.post(`${RELAY_URL}/mcp`, { headers: { Authorization: `Bearer ${freshTokens.access_token}`,
      'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' },
      data: { jsonrpc: '2.0', id: callSequence++, method: 'tools/call', params: { name, arguments: args } } });
    expect(response.ok()).toBeTruthy();
    const raw = await response.text();
    const json = raw.trim().startsWith('{') ? JSON.parse(raw) : JSON.parse(raw.split('\n').filter(l => l.startsWith('data:')).map(l => l.slice(5).trim()).join(''));
    expect(json.error).toBeUndefined();
    const result = json.result.structuredContent ?? JSON.parse(json.result.content[0].text);
    const value = typeof result.status === 'number' && typeof result.body === 'string' ? JSON.parse(result.body) : result;
    expect(value.error, JSON.stringify(value).slice(0, 2000)).toBeUndefined();
    return includePrivateMetadata ? { value, metadata: json.result._meta, content: json.result.content } : value;
  };
  const appId = 'urn:graph:interego:application:browser-grant-ci-' + Date.now() + '-' + randomBytes(4).toString('hex');
  const graphs = Object.fromEntries(['state', 'contract', 'definition', 'catalog'].map(k => [k, appId + ':' + k]));
  const publish = async (kind: string, document: Record<string, Json>) => {
    const graph = signedJsonGraph(graphs[kind]!, 'application-' + kind, document);
    const result = await call('publish_context', { graph_iri: graphs[kind], graph_content: graph.graphContent, sign_authorship: true, visibility: 'public' });
    expect(result.published).toBe(true);
    if (result.status === 'pending') {
      await expect.poll(async () => (await (await api.get(`${RELAY_URL}/publish/status`, { params: { descriptorUrl: result.descriptorUrl } })).json()).kind,
        { timeout: 90_000 }).toBe('committed');
    }
    const head = await call('get_current_head', { urn: graphs[kind] });
    expect(head.forked).toBe(false);
    expect(head.head.descriptorUrl).toBe(result.descriptorUrl);
    return { descriptorUrl: result.descriptorUrl, cid: head.head.cid, documentDigest: graph.digest, graphIri: graphs[kind]! };
  };
  const genesis = await publish('state', { schema: 'interego.application.state/v1', applicationId: appId, version: 0, data: { events: [] } });
  const genesisDescriptor = await call('get_descriptor', { url: genesis.descriptorUrl });
  expect(genesisDescriptor.authorship.authorshipVerified).toBe(true);
  const verifier = genesisDescriptor.authorship.verificationMethod.toLowerCase();
  expect(verifier).toMatch(/^did:ethr:0x[0-9a-f]{40}$/);
  const target = 'urn:interego:runtime:signed-domain:v1';
  const contract = await publish('contract', { schema: 'interego.application.contract/v1', applicationId: appId, version: '1.2.0', runtimeIri: target,
    clientSigningGrants: { schema: 'interego.application.client-grants/v1', audience: RELAY_URL, registrationVerifier: verifier },
    actions: [{ actionIri: appId + ':record', label: 'Record synthetic observation', method: 'POST', target, clientSignature: true, allowClientDelegation: true,
      inputs: [{ name: 'observation', type: 'string', required: true }], guard: { op: 'eq', left: '$authorization.verified', right: true },
      effects: [{ op: 'appendUnique', path: '$state.events', by: 'observation', value: { observation: '$payload.observation', keyId: '$authorization.keyId' } }] },
    ...['enroll', 'revoke'].map(op => ({ actionIri: appId + ':grant:' + op, label: op === 'enroll' ? 'Enroll signing grant' : 'Revoke signing grant',
      method: 'POST', target, clientSignature: true, clientGrantOperation: op, effects: [],
      inputs: (op === 'enroll' ? ['grant', 'possession'] : ['grantId']).map(name => ({ name, type: 'string', required: true })) }))] });
  const definition = await publish('definition', { schema: 'interego.application.definition/v1', id: appId,
    title: 'SYNTHETIC browser scoped-signing test', stateGraphIri: graphs['state']!, contractGraphIri: graphs['contract']! });
  const catalog = await publish('catalog', { schema: 'interego.application.catalog/v1', id: graphs['catalog']!, version: 1,
    applications: [{ applicationId: appId, contractGraphIri: graphs['contract']!, definitionGraphIri: graphs['definition']!, definitionDescriptorUrl: definition.descriptorUrl,
      stateGraphIri: graphs['state']!, manifestCids: { contract, definition, genesisState: genesis } }] });
  const createRequest = async (observation: string) => {
    const view = await call('render_hmd', { descriptor_url: catalog.descriptorUrl });
    expect(view.snapshot.replay.complete).toBe(true);
    const control = view.controls.find((c: { label: string }) => c.label === 'Submit: Record synthetic observation');
    const pending = await call('act', { descriptor_url: control.descriptorUrl, action_iri: control.action, payload: { observation } });
    expect(pending.status).toBe('pending'); return pending;
  };
  const first = await createRequest('one');
  await page.goto(first.signingUrl);
  // This token belongs solely to the synthetic account created by this test.
  await page.evaluate(token => sessionStorage.setItem('cg.token', token), freshIdentityBody.identityToken);
  await page.reload();
  await page.locator('#enable-scoped:not([hidden])').waitFor();
  // Grant preparation revalidates the original action, derives its enrollment
  // and prepares another current receipt over the live pod. Await that actual
  // operation and the page's subsequent review, rather than racing them with
  // the default ten-second text assertion.
  const enrollmentStarted = Date.now();
  const [enrollmentResponse] = await Promise.all([
    page.waitForResponse(response => response.request().method() === 'POST'
      && /^\/client-interactions\/[a-zA-Z0-9_-]{43}\/grant$/.test(new URL(response.url()).pathname), { timeout: 90_000 }),
    page.locator('#enable-scoped').click(),
  ]);
  const enrollmentResult = await enrollmentResponse.json();
  expect(enrollmentResponse.ok(), enrollmentResult.error ?? 'Grant preparation refused').toBe(true);
  await expect(page.locator('#enable-scoped')).toBeEnabled({ timeout: 90_000 });
  const enrollmentStatus = await page.locator('#status').textContent() ?? 'Enrollment review failed';
  expect(await page.locator('#sign').textContent(), enrollmentStatus).toBe('Authorize this scoped signing grant');
  expect(await page.locator('#sign').isEnabled(), enrollmentStatus).toBe(true);
  console.log('Scoped enrollment review ready after ' + (Date.now() - enrollmentStarted) + 'ms.');
  expect(await page.evaluate(async () => {
    const heldKey = pendingGrant.keyPair.privateKey;
    if (!(heldKey instanceof CryptoKey) || heldKey.type !== 'private') throw new Error('browser key missing');
    try { await crypto.subtle.exportKey('pkcs8', heldKey); return true; } catch { return false; }
  })).toBe(false);
  await page.locator('#sign').click();
  await expect(page.locator('#scope-status')).toContainText('Signed and verified an action', { timeout: 90_000 });
  const second = await createRequest('two');
  await expect.poll(async () => (await call('invoke_affordance', { descriptor_url: second.descriptorUrl, action_iri: second.action, payload: {} })).status,
    { timeout: 90_000 }).toBe('completed');
  const after = await call('render_hmd', { descriptor_url: catalog.descriptorUrl });
  expect(after.snapshot.head.version).toBe(3);
  expect(after.snapshot.replay.complete).toBe(true);
  expect(after.snapshot.replay.links.filter((link: { authorizationBasis: string }) => link.authorizationBasis === 'delegated-client-signature')).toHaveLength(2);
  expect(after.snapshot.head.state.events.map((event: { keyId: string }) => event.keyId)).toEqual([clientKeyId(key), clientKeyId(key)]);
  await page.locator('#stop-scoped').click();
  await expect(page.locator('#scope-status')).toContainText('private key was discarded');
  console.log('PASS: live passkey-authorized grant enrollment, nonexportable Chromium key, two automatic MCP actions, registered-holder accounting and complete retained-proof replay.');
  console.log('PASS: live OAuth identity renewal, registered passkey RP, deployed signing page and retained-proof verification.');
  // Only this synthetic credential enters the clean context. No login token,
  // cookies, storage, real account or demo action is reused by the signing page.
  const cleanContext = await browser.newContext();
  try {
    const signingPage = await cleanContext.newPage();
    const cleanAuthenticator = await enableVirtualAuthenticator(signingPage);
    const { credentials } = await registeredAuthenticator.client.send('WebAuthn.getCredentials', {
      authenticatorId: registeredAuthenticator.authenticatorId,
    });
    expect(credentials.length).toBe(1);
    await cleanAuthenticator.client.send('WebAuthn.addCredential', {
      authenticatorId: cleanAuthenticator.authenticatorId, credential: credentials[0]!,
    });
    type SigningStats = { gets: string[]; storageAttempts: string[]; initialStorage: { local: number; session: number } };
    await signingPage.addInitScript(() => {
      const stats: SigningStats = { gets: [], storageAttempts: [],
        initialStorage: { local: localStorage.length, session: sessionStorage.length } };
      (window as unknown as { signingStats: SigningStats }).signingStats = stats;
      const nativeGet = CredentialsContainer.prototype.get;
      CredentialsContainer.prototype.get = function (options) {
        if (options?.publicKey) stats.gets.push(btoa(String.fromCharCode(...new Uint8Array(options.publicKey.challenge as ArrayBuffer)))
          .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, ''));
        return nativeGet.call(this, options);
      };
      for (const name of ['localStorage', 'sessionStorage']) Object.defineProperty(window, name, {
        get() { stats.storageAttempts.push(name); throw Error('Request-only signing must not access browser storage'); },
      });
    });
    const browserRequests: Array<Promise<{ path: string; method: string; bearer: boolean; cookie: boolean; origin?: string }>> = [];
    signingPage.on('request', request => browserRequests.push(request.allHeaders().then(headers => ({
      path: new URL(request.url()).pathname, method: request.method(), bearer: !!headers['authorization'],
      cookie: !!headers['cookie'], origin: headers['origin'],
    }))));
    const direct = await createRequest('three-direct-handoff');
    expect(direct.openAction).toBe('urn:interego:client-interaction:open-signing-page');
    const opened = await call('act', { descriptor_url: direct.descriptorUrl, action_iri: direct.openAction, payload: {} }, true);
    const launch = opened.metadata?.['interego/browser-signing'];
    expect(launch?.id).toBe(direct.id);
    const launchUrl = new URL(launch.signingUrl);
    expect(launchUrl.origin).toBe(new URL(RELAY_URL).origin);
    expect(launchUrl.pathname).toBe('/sign-action');
    expect(launchUrl.search).toBe('?request=' + direct.id);
    expect(/^#launch=[a-zA-Z0-9_-]{43}$/.test(launchUrl.hash)).toBe(true);
    const launchSecret = launchUrl.hash.slice('#launch='.length);
    expect(JSON.stringify(opened.value).includes(launchSecret)).toBe(false);
    expect(JSON.stringify(opened.content).includes(launchSecret)).toBe(false);
    const [reviewResponse] = await Promise.all([
      signingPage.waitForResponse(response => response.request().method() === 'POST'
        && new URL(response.url()).pathname === `/client-interactions/${direct.id}/review`, { timeout: 90_000 }),
      signingPage.goto(launchUrl.href),
    ]);
    expect(reviewResponse.ok()).toBe(true);
    const review = await reviewResponse.json();
    expect(JSON.parse(review.signingRequest.message)).toMatchObject({ actor: direct.actor, actionIri: appId + ':record',
      contractDigest: contract.documentDigest, expectedHead: after.snapshot.head.cid, payload: { observation: 'three-direct-handoff' } });
    expect(await signingPage.evaluate(() => location.hash)).toBe('');
    await expect(signingPage.locator('#sign')).toBeEnabled({ timeout: 90_000 });
    expect(await signingPage.evaluate(() => (window as unknown as { signingStats: SigningStats }).signingStats)).toEqual({
      gets: [], storageAttempts: [], initialStorage: { local: 0, session: 0 },
    });
    for (const selector of ['#passkey-login', '#wallet-login', '#cancel', '#scoped-signing'])
      await expect(signingPage.locator(selector)).toBeHidden();
    await signingPage.locator('#sign').click();
    await expect(signingPage.locator('#status')).toContainText('Signed, verified and submitted', { timeout: 90_000 });
    const stats = await signingPage.evaluate(() => (window as unknown as { signingStats: SigningStats }).signingStats);
    expect(stats.gets).toEqual([createHash('sha256').update(clientSigningMessage(review.signingRequest.message, key)).digest('base64url')]);
    expect(stats.storageAttempts).toEqual([]);
    const requests = await Promise.all(browserRequests);
    expect(requests.every(r => !r.bearer && !r.cookie)).toBe(true);
    expect(requests.filter(r => /\/(?:auth|challenges|authorize|token)(?:\/|$)/.test(r.path))).toEqual([]);
    const operations = requests.filter(r => r.path.startsWith('/client-interactions/'));
    expect(operations.map(r => r.path.split('/').at(-1))).toEqual(['exchange', 'status', 'review', 'submit']);
    expect(operations.every(r => r.method === 'POST' && r.origin === launchUrl.origin)).toBe(true);
    const completed = await call('act', { descriptor_url: direct.descriptorUrl, action_iri: direct.action, payload: {} });
    expect(completed.status).toBe('completed'); expect(completed.result.committed).toBe(true);
    const directProof = await verifyClientAuthorization(completed.result.receipt.clientAuthorization, review.signingRequest.message, [key]);
    expect(directProof.keyId).toBe(clientKeyId(key));
    const final = await call('render_hmd', { descriptor_url: catalog.descriptorUrl });
    expect(final.snapshot.head.version).toBe(4); expect(final.snapshot.head.forked).toBe(false);
    expect(final.snapshot.head.state.events.map((event: { observation: string }) => event.observation)).toEqual(['one', 'two', 'three-direct-handoff']);
    expect(final.snapshot.replay.complete).toBe(true); expect(final.snapshot.replay.errors).toEqual([]);
    expect(final.snapshot.replay.links.at(-1)).toMatchObject({ verified: true, authorizationBasis: 'client-signature', clientKeyId: clientKeyId(key) });
    console.log('PASS: deployed private MCP launch, clean browser with no login/storage, exactly one native receipt assertion, direct commit and complete replay.');
  } finally { await cleanContext.close(); }
  } finally {
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
        const delResp = await api.post(`${IDENTITY_URL}/users/me/delete`, {
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
  await api.dispose();
  }
});
