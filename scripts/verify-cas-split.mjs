#!/usr/bin/env node
/**
 * scripts/verify-cas-split.mjs
 *
 * Live verification of the CAS-split (Phase A precondition + Phase B
 * background publish) deployed in rev 184.
 *
 *   1. preconditionFailSync   — stale if_match → 412 synchronous, fast
 *   2. preconditionPassFast   — fresh if_match → 202 in <1s with
 *                                precondition.{passed, observedCid, expectedCid}
 *   3. phaseBCompletes        — poll /publish/status until kind:'committed'
 *                                + dereference returns authorshipVerified:true
 *   4. connectorTimeoutSafe   — 3s AbortSignal at 6KB and 10KB signed+CAS
 *   5. e2ePasses              — tools/list = 37
 *
 * Uses only Node 22 builtins.
 */

import { generateKeyPairSync, createHash, randomBytes, sign as nodeSign } from 'node:crypto';

const RELAY = 'https://interego-relay.livelysky-8b81abb0.eastus.azurecontainerapps.io';
const REDIRECT_URI = 'http://localhost:9999/cb';
const CLIENT_NAME = 'verify-cas-split';

const BASE58 = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
function base58btcEncode(bytes) {
  let zeros = 0;
  while (zeros < bytes.length && bytes[zeros] === 0) zeros++;
  let num = 0n;
  for (const b of bytes) num = num * 256n + BigInt(b);
  let out = '';
  while (num > 0n) {
    const r = Number(num % 58n); num = num / 58n;
    out = BASE58[r] + out;
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
    try { json = JSON.parse(data); } catch { json = { error: { raw: text.slice(0, 400) } }; }
  } else {
    try { json = JSON.parse(text); } catch { json = { error: { raw: text.slice(0, 400) } }; }
  }
  return { json, status: resp.status, raw: text };
}

async function callTool(token, name, args, id, opts = {}) {
  const r = await rpcCall(token, 'tools/call', { name, arguments: args }, id, opts);
  if (r.json.error) return { ok: false, error: r.json.error, status: r.status };
  const text = r.json.result?.content?.[0]?.text;
  if (!text) return { ok: false, error: 'no content.text', status: r.status };
  try {
    return { ok: true, payload: JSON.parse(text), isError: !!r.json.result?.isError, status: r.status };
  } catch {
    return { ok: true, payload: text, isError: !!r.json.result?.isError, status: r.status };
  }
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
  if (!pendingId || !identityOrigin) throw new Error('authorize scrape failed');
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
  return tokenResp.access_token;
}

function buildGraphContent(targetBytes) {
  const prefix = '<urn:s> <urn:p> "';
  const suffix = '" .';
  const filler = 'A'.repeat(Math.max(0, targetBytes - prefix.length - suffix.length));
  return prefix + filler + suffix;
}

const RUN_ID = Date.now();
const results = {};

async function pollStatus(token, descriptorUrl, maxMs = 15_000) {
  const started = Date.now();
  let last = null;
  while (Date.now() - started < maxMs) {
    const r = await fetch(`${RELAY}/publish/status?descriptorUrl=${encodeURIComponent(descriptorUrl)}`, {
      headers: { 'Authorization': `Bearer ${token}` },
    });
    if (r.ok) {
      const body = await r.json();
      last = body;
      if (body.kind === 'committed' || body.kind === 'failed') {
        return { final: body, elapsedMs: Date.now() - started };
      }
    }
    await new Promise(res => setTimeout(res, 800));
  }
  return { final: last, elapsedMs: Date.now() - started, timedOut: true };
}

// Wait until v1 is observable on the pod (manifest has it) by polling
// get_current_head. The default async publish returns 202 before the
// background write lands.
async function waitForHead(token, urn, maxMs = 20_000) {
  const started = Date.now();
  while (Date.now() - started < maxMs) {
    const head = await callTool(token, 'get_current_head', { urn }, Math.floor(Math.random() * 100000));
    if (head.payload?.head?.cid) return head.payload.head;
    await new Promise(r => setTimeout(r, 1000));
  }
  return null;
}

async function main() {
  console.log('=== verify-cas-split ===');
  console.log(`relay: ${RELAY}`);
  console.log(`time:  ${new Date().toISOString()}`);
  console.log('');

  console.log('[INFO] bootstrapping OAuth bearer (scope=mcp)...');
  const token = await oauthBootstrap();
  console.log('[PASS] token acquired');

  // --- Scenario 1: preconditionFailSync (stale if_match → 412 sync) ---
  console.log('');
  console.log('==== Scenario 1: preconditionFailSync ====');
  {
    const tag = `pf-${RUN_ID}`;
    const graphIri = `urn:graph:verify:cas-split:fail:${tag}`;
    const v1Body = buildGraphContent(400);
    const v1 = await callTool(token, 'publish_context', {
      graph_iri: graphIri, graph_content: v1Body, visibility: 'public',
    }, 101);
    if (!v1.ok || !v1.payload?.descriptorUrl || v1.isError) {
      console.log('[FAIL] v1 publish failed:', JSON.stringify(v1.payload ?? v1.error).slice(0, 300));
      results.preconditionFailSync = { ok: false, error: 'v1 publish failed' };
    } else {
      console.log(`[INFO] v1 published -> ${v1.payload.descriptorUrl}`);
      // Wait until manifest has v1 so the relay's priorVersions probe
      // populates descriptor.supersedes — without that, Phase A returns
      // 412/empty before it even gets to compare CIDs.
      const headObj = await waitForHead(token, graphIri, 25_000);
      if (!headObj?.cid) {
        console.log('[FAIL] v1 manifest never settled');
        results.preconditionFailSync = { ok: false, error: 'v1 manifest never settled' };
        // jump out of this scenario
      }
      const v2Body = buildGraphContent(400) + ' # mutated';
      const STALE_CID = 'bafkreiSTALECIDxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx';
      const start = Date.now();
      const v2 = await callTool(token, 'publish_context', {
        graph_iri: graphIri, graph_content: v2Body, visibility: 'public',
        sign_authorship: true, if_match: STALE_CID, auto_supersede_prior: true,
      }, 102);
      const elapsed = Date.now() - start;
      const env = v2.payload ?? {};
      const is412 = env.code === 412 || env.error === 'precondition_failed';
      const hasCurrentHead = env.currentHead && typeof env.currentHead === 'object';
      const fast = elapsed < 2500;
      const pass = v2.ok && is412 && hasCurrentHead && fast;
      console.log(`[${pass ? 'PASS' : 'FAIL'}] stale if_match → ${elapsed}ms (code=${env.code} error=${env.error})`);
      console.log(`         currentHead.descriptorUrl=${env.currentHead?.descriptorUrl}`);
      console.log(`         currentHead.cid=${env.currentHead?.cid}`);
      results.preconditionFailSync = { ok: pass, elapsedMs: elapsed, code: env.code, error: env.error, currentHead: env.currentHead };
    }
  }

  // --- Scenario 2: preconditionPassFast (fresh if_match → 202 fast) ---
  console.log('');
  console.log('==== Scenario 2: preconditionPassFast ====');
  let scenario2DescriptorUrl = null;
  {
    const tag = `pp-${RUN_ID}`;
    const graphIri = `urn:graph:verify:cas-split:pass:${tag}`;
    const v1Body = buildGraphContent(400);
    const v1 = await callTool(token, 'publish_context', {
      graph_iri: graphIri, graph_content: v1Body, visibility: 'public',
    }, 201);
    if (!v1.ok || !v1.payload?.descriptorUrl || v1.isError) {
      console.log('[FAIL] v1 publish failed:', JSON.stringify(v1.payload ?? v1.error).slice(0, 300));
      results.preconditionPassFast = { ok: false, error: 'v1 publish failed' };
    } else {
      const v1Url = v1.payload.descriptorUrl;
      console.log(`[INFO] v1 published -> ${v1Url}`);
      const headObj = await waitForHead(token, graphIri, 25_000);
      const headCid = headObj?.cid;
      if (!headCid) {
        console.log('[FAIL] no head CID for', graphIri);
        results.preconditionPassFast = { ok: false, error: 'no head CID' };
      } else {
        console.log(`[INFO] head CID = ${headCid}`);
        await new Promise(r => setTimeout(r, 1500));
        const v2Body = v1Body.slice(0, -3) + 'B" .';
        const start = Date.now();
        const v2 = await callTool(token, 'publish_context', {
          graph_iri: graphIri, graph_content: v2Body, visibility: 'public',
          sign_authorship: true, if_match: headCid, auto_supersede_prior: true,
        }, 203);
        const elapsed = Date.now() - start;
        const env = v2.payload ?? {};
        const status202 = env.status === 'pending' || env.published === false;
        const hasPredictedUrls = !!env.descriptorUrl && !!env.graphUrl && !!env.manifestUrl;
        const preconditionPassed = env.precondition?.passed === true
          && typeof env.precondition?.observedCid === 'string'
          && typeof env.precondition?.expectedCid === 'string'
          && env.precondition?.observedCid === headCid
          && env.precondition?.expectedCid === headCid;
        const fast = elapsed < 1500;
        const pass = v2.ok && !v2.isError && status202 && hasPredictedUrls && preconditionPassed && fast;
        scenario2DescriptorUrl = env.descriptorUrl ?? null;
        console.log(`[${pass ? 'PASS' : 'FAIL'}] fresh if_match → ${elapsed}ms`);
        console.log(`         status=${env.status} published=${env.published}`);
        console.log(`         descriptorUrl=${env.descriptorUrl}`);
        console.log(`         precondition=${JSON.stringify(env.precondition)}`);
        results.preconditionPassFast = {
          ok: pass, elapsedMs: elapsed,
          status: env.status, descriptorUrl: env.descriptorUrl,
          precondition: env.precondition, headCid,
        };
      }
    }
  }

  // --- Scenario 3: phaseBCompletes (poll /publish/status) ---
  console.log('');
  console.log('==== Scenario 3: phaseBCompletes ====');
  if (!scenario2DescriptorUrl) {
    console.log('[SKIP] no descriptor URL from scenario 2');
    results.phaseBCompletes = { ok: false, error: 'no descriptor URL from scenario 2' };
  } else {
    console.log(`[INFO] polling /publish/status for ${scenario2DescriptorUrl}`);
    const start = Date.now();
    const { final, elapsedMs, timedOut } = await pollStatus(token, scenario2DescriptorUrl, 20_000);
    console.log(`[INFO] status poll resolved in ${elapsedMs}ms (kind=${final?.kind})`);
    if (timedOut || final?.kind !== 'committed') {
      console.log('[FAIL] phase B did not commit:', JSON.stringify(final ?? {}).slice(0, 400));
      results.phaseBCompletes = { ok: false, elapsedMs, timedOut, final };
    } else {
      await new Promise(r => setTimeout(r, 1000));
      const deref = await callTool(token, 'get_descriptor', { url: scenario2DescriptorUrl }, 301);
      const authorshipVerified = deref.payload?.authorship?.authorshipVerified === true;
      const pass = authorshipVerified && elapsedMs < 15_000;
      console.log(`[${pass ? 'PASS' : 'FAIL'}] phase B committed in ${elapsedMs}ms`);
      console.log(`         authorshipVerified=${authorshipVerified}`);
      results.phaseBCompletes = {
        ok: pass, elapsedMs, kind: final.kind, authorshipVerified,
      };
    }
  }

  // --- Scenario 4: connectorTimeoutSafe (3s AbortSignal at 6KB + 10KB) ---
  console.log('');
  console.log('==== Scenario 4: connectorTimeoutSafe ====');
  const sizes = [
    { label: '6KB', bytes: 6 * 1024 },
    { label: '10KB', bytes: 10 * 1024 },
  ];
  const sizeResults = [];
  for (const sz of sizes) {
    const tag = `ct-${sz.label}-${RUN_ID}`;
    const graphIri = `urn:graph:verify:cas-split:cnct:${tag}`;
    const v1Body = buildGraphContent(sz.bytes);
    const v1 = await callTool(token, 'publish_context', {
      graph_iri: graphIri, graph_content: v1Body, visibility: 'public',
    }, 401);
    if (!v1.ok || !v1.payload?.descriptorUrl) {
      console.log(`[FAIL] ${sz.label} v1 publish failed`);
      sizeResults.push({ size: sz.label, ok: false, error: 'v1 failed' });
      continue;
    }
    const headObj = await waitForHead(token, graphIri, 25_000);
    const headCid = headObj?.cid;
    if (!headCid) {
      console.log(`[FAIL] ${sz.label} no head CID`);
      sizeResults.push({ size: sz.label, ok: false, error: 'no head' });
      continue;
    }
    const v2Body = v1Body.slice(0, -3) + 'B" .';
    let elapsed = 0;
    let v2, aborted = false, env = {};
    for (let attempt = 1; attempt <= 3; attempt++) {
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), 3000);
      const start = Date.now();
      try {
        v2 = await callTool(token, 'publish_context', {
          graph_iri: graphIri, graph_content: v2Body, visibility: 'public',
          sign_authorship: true, if_match: headCid, auto_supersede_prior: true,
        }, 403 + attempt, { signal: ctrl.signal });
      } catch (err) {
        aborted = true;
        v2 = { ok: false, error: err.message };
      } finally {
        clearTimeout(timer);
      }
      elapsed = Date.now() - start;
      env = v2?.payload ?? {};
      // 503 precondition_unavailable is transient — the read side
      // failed (NOT the assertion). Retry per the relay's contract.
      if (env.error === 'precondition_unavailable' || env.code === 503) {
        console.log(`         attempt ${attempt}: 503 transient, retrying...`);
        await new Promise(r => setTimeout(r, 2500));
        continue;
      }
      break;
    }
    const success = !aborted && v2.ok && !v2.isError
      && (env.published === false || env.status === 'pending' || env.published === true)
      && elapsed < 3000;
    console.log(`[${success ? 'PASS' : 'FAIL'}] ${sz.label} signed+if_match → ${elapsed}ms aborted=${aborted}`);
    if (!success && env.error) console.log(`         env.error=${env.error}`);
    sizeResults.push({ size: sz.label, ok: success, elapsedMs: elapsed, aborted, status: env.status });
  }
  results.connectorTimeoutSafe = {
    ok: sizeResults.every(r => r.ok),
    sizes: sizeResults,
  };

  // --- Scenario 5: e2ePasses (tools/list = 37) ---
  console.log('');
  console.log('==== Scenario 5: e2ePasses ====');
  const tools = await rpcCall(token, 'tools/list', {}, 500);
  const toolCount = tools.json.result?.tools?.length ?? 0;
  console.log(`[INFO] tools/list count = ${toolCount}`);
  const allPriorOk = results.preconditionFailSync?.ok
    && results.preconditionPassFast?.ok
    && results.phaseBCompletes?.ok
    && results.connectorTimeoutSafe?.ok;
  results.e2ePasses = { ok: allPriorOk && toolCount >= 37, toolCount };

  console.log('');
  console.log('============= SUMMARY =============');
  console.log(JSON.stringify(results, null, 2));

  const allPass = results.preconditionFailSync?.ok
    && results.preconditionPassFast?.ok
    && results.phaseBCompletes?.ok
    && results.connectorTimeoutSafe?.ok
    && results.e2ePasses?.ok;
  process.exit(allPass ? 0 : 1);
}

main().catch(err => {
  console.error('FATAL:', err);
  process.exit(2);
});
