#!/usr/bin/env node
/**
 * scripts/verify-publish-defer.mjs
 *
 * Live verification for the publish_context accept-then-publish defer.
 *
 * After the deploy lands, measures:
 *
 *   1. responseTimeAfter — full publish_context round-trip at 200B / 6KB / 50KB.
 *      Expected: < 3s each (was 7-10s).
 *
 *   2. pinStillCompletes — wait 10s after the deferred response, then HEAD
 *      the predicted descriptorUrl (or GET /publish/status). The CSS chain
 *      should have completed and the descriptor should be readable.
 *      (We can't always reach gateway.pinata.cloud directly; we use the
 *      descriptor existence as the proof that the background chain landed.)
 *
 *   3. connectorSignedCasWorks — publish_context with sign_authorship:true
 *      AND if_match:<headCid> under a tight 5s AbortSignal. The sync path
 *      forces the synchronous publish (compliance/if_match/sync gate),
 *      so this is the round-trip the MCP connector previously timed out on.
 *      Should now succeed in < 5s.
 *
 *   4. e2ePasses — the relay's tools/list count is the cheapest e2e signal
 *      we can read here. The detailed 13/13 check comes from
 *      test-relay-end-to-end.mjs + verify-rev3-fixes.mjs which are run by
 *      the parent agent if needed.
 */

import { generateKeyPairSync, createHash, randomBytes, sign as nodeSign } from 'node:crypto';

const RELAY = 'https://interego-relay.livelysky-8b81abb0.eastus.azurecontainerapps.io';
const REDIRECT_URI = 'http://localhost:9999/cb';
const CLIENT_NAME = 'verify-publish-defer';

const BASE58_ALPHABET = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
function base58btcEncode(bytes) {
  let zeros = 0;
  while (zeros < bytes.length && bytes[zeros] === 0) zeros++;
  let num = 0n;
  for (const b of bytes) num = num * 256n + BigInt(b);
  let out = '';
  while (num > 0n) {
    const r = Number(num % 58n);
    num = num / 58n;
    out = BASE58_ALPHABET[r] + out;
  }
  for (let i = 0; i < zeros; i++) out = '1' + out;
  return 'z' + out;
}
function b64url(buf) { return Buffer.from(buf).toString('base64url'); }

async function rpcCall(token, method, params, id, { signal } = {}) {
  const resp = await fetch(`${RELAY}/mcp`, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${token}`,
      'Content-Type': 'application/json',
      'Accept': 'application/json, text/event-stream',
    },
    body: JSON.stringify({ jsonrpc: '2.0', id, method, params }),
    signal,
  });
  const ct = resp.headers.get('content-type') ?? '';
  const text = await resp.text();
  let json;
  if (ct.includes('text/event-stream')) {
    const data = text.split('\n').filter(l => l.startsWith('data:')).map(l => l.slice(5).trim()).join('');
    try { json = JSON.parse(data); } catch { json = { error: { message: 'sse-parse-failed', raw: text.slice(0, 400) } }; }
  } else {
    try { json = JSON.parse(text); } catch { json = { error: { message: 'json-parse-failed', raw: text.slice(0, 400) } }; }
  }
  return { json, raw: text, status: resp.status };
}

async function callTool(token, name, args, id, opts = {}) {
  const r = await rpcCall(token, 'tools/call', { name, arguments: args }, id, opts);
  if (r.json.error) return { ok: false, error: r.json.error, raw: r.raw, status: r.status };
  const text = r.json.result?.content?.[0]?.text;
  if (!text) return { ok: false, error: 'no content.text', raw: r.raw, status: r.status };
  try { return { ok: true, payload: JSON.parse(text), isError: !!r.json.result?.isError, status: r.status }; }
  catch { return { ok: true, payload: text, isError: !!r.json.result?.isError, status: r.status }; }
}

async function oauthBootstrap() {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  const rawPub = publicKey.export({ format: 'der', type: 'spki' }).slice(-32);
  const did = `did:key:${base58btcEncode(Buffer.concat([Buffer.from([0xed, 0x01]), rawPub]))}`;
  const publicKeyMultibase = base58btcEncode(rawPub);
  const code_verifier = b64url(randomBytes(32));
  const code_challenge = b64url(createHash('sha256').update(code_verifier).digest());
  const dcr = await fetch(`${RELAY}/register`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      client_name: CLIENT_NAME,
      redirect_uris: [REDIRECT_URI],
      token_endpoint_auth_method: 'none',
      grant_types: ['authorization_code'],
      response_types: ['code'],
    }),
  }).then(r => r.json());
  const clientId = dcr.client_id;
  const state = b64url(randomBytes(8));
  const authzUrl = `${RELAY}/authorize?response_type=code&client_id=${clientId}` +
    `&redirect_uri=${encodeURIComponent(REDIRECT_URI)}&state=${state}` +
    `&code_challenge=${code_challenge}&code_challenge_method=S256&scope=mcp`;
  const authzHtml = await fetch(authzUrl).then(r => r.text());
  const pendingId = authzHtml.match(/PENDING_ID\s*=\s*['"]([^'"]+)['"]/)?.[1];
  const identityOrigin = authzHtml.match(/IDENTITY\s*=\s*['"]([^'"]+)['"]/)?.[1];
  if (!pendingId || !identityOrigin) throw new Error(`authorize scrape failed; head: ${authzHtml.slice(0, 600)}`);
  const ch = await fetch(`${identityOrigin}/challenges`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ purpose: 'did-sig' }),
  }).then(r => r.json());
  const nonce = ch.nonce;
  const signature = b64url(nodeSign(null, Buffer.from(nonce, 'utf8'), privateKey));
  const verify = await fetch(`${RELAY}/oauth/verify`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ pending_id: pendingId, method: 'did', did, nonce, signature, publicKeyMultibase }),
  }).then(r => r.json());
  if (!verify.redirect) throw new Error(`verify failed: ${JSON.stringify(verify)}`);
  const authCode = new URL(verify.redirect).searchParams.get('code');
  const tokenResp = await fetch(`${RELAY}/token`, {
    method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'authorization_code', code: authCode, code_verifier,
      redirect_uri: REDIRECT_URI, client_id: clientId,
    }).toString(),
  }).then(r => r.json());
  if (!tokenResp.access_token) throw new Error(`token exchange failed: ${JSON.stringify(tokenResp)}`);
  await rpcCall(tokenResp.access_token, 'initialize', {
    protocolVersion: '2025-03-26', capabilities: {},
    clientInfo: { name: CLIENT_NAME, version: '1.0.0' },
  }, 0);
  return { token: tokenResp.access_token, did };
}

function buildGraphContent(targetBytes) {
  const prefix = '<urn:s> <urn:p> "';
  const suffix = '" .';
  const overhead = prefix.length + suffix.length;
  const fillerLen = Math.max(0, targetBytes - overhead);
  return prefix + 'A'.repeat(fillerLen) + suffix;
}

const RUN_ID = Date.now();
const sizes = [
  { label: '200B',  bytes: 200 },
  { label: '6KB',   bytes: 6 * 1024 },
  { label: '50KB',  bytes: 50 * 1024 },
];

async function measure(fn) {
  const start = process.hrtime.bigint();
  let result, err;
  try { result = await fn(); } catch (e) { err = e; }
  const end = process.hrtime.bigint();
  const ms = Number(end - start) / 1_000_000;
  return { result, err, ms };
}

async function probeResponseTime(token, sz, iteration = 0) {
  const graphIri = `urn:graph:verify:defer:${sz.label}:${RUN_ID}:${iteration}`;
  const content = buildGraphContent(sz.bytes);
  const { result, ms, err } = await measure(() =>
    callTool(token, 'publish_context', {
      graph_iri: graphIri,
      graph_content: content,
      visibility: 'public',
    }, 100 + iteration),
  );
  if (err) {
    return { sz, ms, ok: false, error: err.message };
  }
  const env = result?.payload;
  const ok = result?.ok && !result.isError && !env?.error && (env?.published === true || !!env?.descriptorUrl);
  // dump raw payload so we can see status/pollUrl shape
  console.log(`    raw payload keys: ${env && typeof env === 'object' ? Object.keys(env).join(',') : 'n/a'}`);
  if (env && typeof env === 'object') {
    console.log(`    payload.published=${env.published} status=${env.status} pollUrl=${env.pollUrl ?? '-'} pendingCid=${env.pendingCid ?? env.cid ?? '-'} descriptorUrl=${env.descriptorUrl ?? '-'}`);
  } else {
    console.log(`    payload(non-object): ${String(env).slice(0, 200)}`);
  }
  return {
    sz, ms, ok,
    descriptorUrl: env?.descriptorUrl,
    status: env?.status,
    pollUrl: env?.pollUrl,
    error: ok ? null : (env?.error || env?.message || 'unknown'),
  };
}

async function probePinStillCompletes(token, descriptorUrl) {
  // Poll /publish/status up to ~30s for the background CSS chain to land.
  // The CSS chain (graph PUT + descriptor PUT + manifest CAS, each retried
  // up to 8x with backoff) plus the IPFS pin upload can take up to 15-20s
  // on a cold lazy-init worker, so a hard 10s wait is too tight.
  let status = null;
  const deadline = Date.now() + 30000;
  while (Date.now() < deadline) {
    await new Promise(r => setTimeout(r, 2000));
    const resp = await fetch(`${RELAY}/publish/status?descriptorUrl=${encodeURIComponent(descriptorUrl)}`);
    const ct = resp.headers.get('content-type') ?? '';
    const text = await resp.text();
    if (ct.includes('application/json')) {
      try { status = JSON.parse(text); } catch { status = { parseError: text.slice(0, 200) }; }
    } else {
      status = { nonJsonResponse: text.slice(0, 200), httpStatus: resp.status, contentType: ct };
    }
    if (status?.kind === 'committed' || status?.kind === 'failed') break;
  }
  return { descriptorUrl, status };
}

async function probeConnectorSignedCas(token) {
  // Build v1 (plain publish) so we have a head CID to assert if_match against.
  const graphIri = `urn:graph:verify:defer:signed-cas:${RUN_ID}`;
  const content = buildGraphContent(6 * 1024);

  // v1 is published with sync:true so the head is observable
  // synchronously (otherwise we'd race the get_current_head call against
  // the still-running deferred CSS chain). sync:true is the explicit
  // back-compat opt-in to the synchronous publish contract.
  const v1 = await callTool(token, 'publish_context', {
    graph_iri: graphIri,
    graph_content: content,
    visibility: 'public',
    sync: true,
  }, 200);
  if (!v1.ok || v1.isError || v1.payload?.error) {
    return { ok: false, stage: 'v1', error: v1.payload?.error || v1.error };
  }
  // Poll for the head with retries — Azure Files post-write cache can
  // hide the freshly-written manifest entry for a few seconds.
  let headCid = null;
  for (let attempt = 0; attempt < 6 && !headCid; attempt++) {
    if (attempt > 0) await new Promise(r => setTimeout(r, 2500));
    const head = await callTool(token, 'get_current_head', { urn: graphIri }, 201 + attempt);
    headCid = head.payload?.head?.cid;
  }
  if (!headCid) return { ok: false, stage: 'head', error: 'no head CID after 6 attempts' };

  // brief settle to avoid Azure-Files post-write cache window
  await new Promise(r => setTimeout(r, 2500));

  // Now the actual measurement — sign_authorship + if_match under a 5s AbortSignal.
  // (Mutate one byte so the body differs from v1 but stays the same size.)
  const v2Content = content.slice(0, -3) + 'B' + content.slice(-2);
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 5000);

  const { result, ms, err } = await measure(() =>
    callTool(token, 'publish_context', {
      graph_iri: graphIri,
      graph_content: v2Content,
      visibility: 'public',
      sign_authorship: true,
      if_match: headCid,
      auto_supersede_prior: true,
    }, 202, { signal: controller.signal }),
  );
  clearTimeout(timeout);

  if (err) {
    const aborted = err.name === 'AbortError' || /aborted/i.test(err.message);
    return { ok: false, stage: 'v2', error: err.message, aborted, ms };
  }
  const env = result?.payload;
  const supersedes = env?.supersedesPriorVersions ?? env?.supersedes ?? [];
  const supersedesOk = Array.isArray(supersedes) && supersedes.length > 0;
  const ok = result.ok && !result.isError && !env?.error && env?.descriptorUrl && supersedesOk;
  return { ok, ms, env, headCid, supersedes };
}

async function probeToolsList(token) {
  const r = await rpcCall(token, 'tools/list', {}, 300);
  const tools = r.json?.result?.tools ?? [];
  return { count: tools.length, sample: tools.slice(0, 5).map(t => t.name) };
}

async function main() {
  console.log('=== verify-publish-defer ===');
  console.log(`relay: ${RELAY}`);
  console.log(`time:  ${new Date().toISOString()}`);
  console.log('');

  console.log('[INFO] bootstrapping OAuth bearer (scope=mcp)...');
  const { token } = await oauthBootstrap();
  console.log('[PASS] token acquired');
  console.log('');

  // Warm-up: lazy pod-init + manifest cache populate on first call to
  // a fresh user can take 30-60s — that's not what we're measuring.
  // Burn one publish to warm the pod + manifestCache before the real probe.
  console.log('--- (0) warmup publish (pod lazy-init + manifest cache) ---');
  const warm = await probeResponseTime(token, { label: 'warmup', bytes: 200 }, 99);
  console.log(`  warmup: ms=${warm.ms.toFixed(1)} ok=${warm.ok} status=${warm.status} descriptorUrl=${warm.descriptorUrl ?? '-'}`);
  console.log('');

  // (1) response-time probe at three sizes (sequential — each gives the
  // relay a clean substrate window so timing isn't masked by queue depth).
  console.log('--- (1) responseTimeAfter ---');
  const responseTimings = [];
  let firstDescriptorUrl = null;
  let i = 0;
  for (const sz of sizes) {
    const r = await probeResponseTime(token, sz, i++);
    responseTimings.push(r);
    console.log(`  ${sz.label}: ms=${r.ms.toFixed(1)} ok=${r.ok} status=${r.status} descriptorUrl=${r.descriptorUrl ?? '-'} err=${r.error ?? ''}`);
    if (!firstDescriptorUrl && r.descriptorUrl) firstDescriptorUrl = r.descriptorUrl;
  }
  const all3sec = responseTimings.every(r => r.ok && r.ms < 3000);
  console.log(`  all <3s: ${all3sec}`);
  console.log('');

  // (2) pin still completes — wait 10s then poll /publish/status.
  console.log('--- (2) pinStillCompletes ---');
  let pinStatus = null;
  if (firstDescriptorUrl) {
    pinStatus = await probePinStillCompletes(token, firstDescriptorUrl);
    console.log(`  status: ${JSON.stringify(pinStatus.status)}`);
  } else {
    console.log('  (no descriptorUrl from the response-time probe; skipped)');
  }
  console.log('');

  // (3) connector signed+CAS under 5s AbortSignal.
  console.log('--- (3) connectorSignedCasWorks (5s AbortSignal) ---');
  const signedCas = await probeConnectorSignedCas(token);
  console.log(`  ok=${signedCas.ok} ms=${signedCas.ms?.toFixed?.(1) ?? '-'} aborted=${signedCas.aborted ?? false} stage=${signedCas.stage ?? '-'} err=${signedCas.error ?? ''}`);
  if (signedCas.env?.descriptorUrl) {
    console.log(`  descriptorUrl=${signedCas.env.descriptorUrl}`);
    console.log(`  supersedes=${JSON.stringify(signedCas.supersedes)}`);
  }
  console.log('');

  // (4) tools/list smoke
  console.log('--- (4) tools/list smoke ---');
  const tools = await probeToolsList(token);
  console.log(`  tools=${tools.count} sample=${tools.sample.join(',')}`);
  console.log('');

  // ── final report ───────────────────────────────────────────
  console.log('============= FINAL =============');
  console.log(`responseTimeAfter:`);
  for (const r of responseTimings) {
    console.log(`  ${r.sz.label}: ${r.ms.toFixed(1)}ms status=${r.status ?? '-'}`);
  }
  console.log(`pinStillCompletes: ${JSON.stringify(pinStatus?.status)}`);
  console.log(`connectorSignedCasWorks: ok=${signedCas.ok} ms=${signedCas.ms?.toFixed?.(1) ?? '-'}`);
  console.log(`toolsCount: ${tools.count}`);
}

main().catch(err => {
  console.error('FATAL:', err);
  process.exit(2);
});
