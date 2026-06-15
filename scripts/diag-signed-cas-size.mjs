#!/usr/bin/env node
/**
 * scripts/diag-signed-cas-size.mjs
 *
 * Binary-search the body size at which the combined
 * sign_authorship:true + if_match path transitions from success to
 * failure. Per johnny's earlier probe:
 *
 *   - ~150 byte payload → 200 OK (signed + if_match)
 *   - ~6 KB payload     → "fetch failed" (signed + if_match)
 *   - sign_authorship alone (no if_match) at any size → works
 *   - if_match alone (no sign_authorship) at any size → works
 *
 * For each target size we publish a v1 then a v2 (same target size)
 * with sign_authorship:true + if_match:<v1 CID>, time the call,
 * capture status + error.
 */

import { generateKeyPairSync, createHash, randomBytes, sign as nodeSign } from 'node:crypto';

const RELAY = 'https://interego-relay.livelysky-8b81abb0.eastus.azurecontainerapps.io';
const REDIRECT_URI = 'http://localhost:9999/cb';
const CLIENT_NAME = 'diag-signed-cas-size';

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

async function rpcCall(relay, token, method, params, id) {
  const resp = await fetch(`${relay}/mcp`, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${token}`,
      'Content-Type': 'application/json',
      'Accept': 'application/json, text/event-stream',
    },
    body: JSON.stringify({ jsonrpc: '2.0', id, method, params }),
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

async function callTool(relay, token, name, args, id) {
  const r = await rpcCall(relay, token, 'tools/call', { name, arguments: args }, id);
  if (r.json.error) return { ok: false, error: r.json.error, raw: r.raw, status: r.status };
  const text = r.json.result?.content?.[0]?.text;
  if (!text) return { ok: false, error: 'no content.text', raw: r.raw, status: r.status };
  try { return { ok: true, payload: JSON.parse(text), isError: !!r.json.result?.isError, status: r.status }; }
  catch { return { ok: true, payload: text, isError: !!r.json.result?.isError, status: r.status }; }
}

async function oauthBootstrap({ scope = 'mcp' } = {}) {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  const rawPub = publicKey.export({ format: 'der', type: 'spki' }).slice(-32);
  const did = `did:key:${base58btcEncode(Buffer.concat([Buffer.from([0xed, 0x01]), rawPub]))}`;
  const publicKeyMultibase = base58btcEncode(rawPub);
  const code_verifier = b64url(randomBytes(32));
  const code_challenge = b64url(createHash('sha256').update(code_verifier).digest());
  const dcr = await fetch(`${RELAY}/register`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      client_name: `${CLIENT_NAME}-${scope.replace(/[^a-z0-9]/gi, '')}`,
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
    `&code_challenge=${code_challenge}&code_challenge_method=S256&scope=${encodeURIComponent(scope)}`;
  const authzHtml = await fetch(authzUrl).then(r => r.text());
  const pendingId = authzHtml.match(/PENDING_ID\s*=\s*['"]([^'"]+)['"]/)?.[1];
  const identityOrigin = authzHtml.match(/IDENTITY\s*=\s*['"]([^'"]+)['"]/)?.[1];
  if (!pendingId || !identityOrigin) {
    throw new Error(`authorize scrape failed; html head: ${authzHtml.slice(0, 600)}`);
  }
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
  await rpcCall(RELAY, tokenResp.access_token, 'initialize', {
    protocolVersion: '2025-03-26', capabilities: {},
    clientInfo: { name: CLIENT_NAME, version: '1.0.0' },
  }, 0);
  return { token: tokenResp.access_token, scope: tokenResp.scope, did };
}

// Build a graph_content of approximately `targetBytes` bytes.
// Use a single triple with a repeated string literal payload, valid Turtle.
function buildGraphContent(targetBytes) {
  const prefix = '<urn:s> <urn:p> "';
  const suffix = '" .';
  const overhead = prefix.length + suffix.length;
  const fillerLen = Math.max(0, targetBytes - overhead);
  // No internal quote/backslash chars to keep Turtle valid.
  const filler = 'A'.repeat(fillerLen);
  return prefix + filler + suffix;
}

const RUN_ID = Date.now();
const SIZE_TIERS = [16384, 32768, 65536, 131072, 262144, 524288, 1048576, 2097152];

const summary = [];

async function publishV1(token, graphIri, content, idBase) {
  for (let attempt = 1; attempt <= 4; attempt++) {
    const v1 = await callTool(RELAY, token, 'publish_context', {
      graph_iri: graphIri,
      graph_content: content,
      visibility: 'public',
    }, idBase + attempt);
    if (v1.ok && v1.payload?.descriptorUrl && !v1.isError && !v1.payload?.error) return v1;
    await new Promise(r => setTimeout(r, 2000 * attempt));
  }
  return null;
}

async function probeSize(token, sizeBytes) {
  const tag = `size${sizeBytes}-${RUN_ID}`;
  const graphIri = `urn:graph:diag:signed-cas-size:${tag}`;
  const content = buildGraphContent(sizeBytes);
  const actualBytes = Buffer.byteLength(content, 'utf8');

  console.log('');
  console.log(`─── tier: target=${sizeBytes}B actual=${actualBytes}B graphIri=${graphIri} ───`);

  // 1. publish v1 (plain)
  const v1Start = Date.now();
  const v1 = await publishV1(token, graphIri, content, 1000);
  const v1Ms = Date.now() - v1Start;
  if (!v1) {
    console.log(`[FAIL] v1 publish (cold-start retries exhausted) ${v1Ms}ms`);
    summary.push({
      size: sizeBytes, actualBytes,
      v1Ms, v1Ok: false,
      v2Ms: null, v2Ok: false, v2Error: 'v1 never published',
    });
    return;
  }
  const v1DescriptorUrl = v1.payload.descriptorUrl;
  console.log(`[INFO] v1 ok ${v1Ms}ms descriptorUrl=${v1DescriptorUrl}`);

  // 2. resolve current head CID
  const head = await callTool(RELAY, token, 'get_current_head', { urn: graphIri }, 1100);
  const headCid = head.payload?.head?.cid;
  if (!headCid) {
    console.log(`[FAIL] could not resolve head CID: ${JSON.stringify(head.payload ?? head.error).slice(0, 300)}`);
    summary.push({
      size: sizeBytes, actualBytes,
      v1Ms, v1Ok: true,
      v2Ms: null, v2Ok: false, v2Error: 'no head CID',
    });
    return;
  }
  console.log(`[INFO] head CID = ${headCid}`);

  // brief settle delay so the v1 descriptor is readable by the substrate
  // CAS gate without colliding with Azure-Files post-write cache window.
  await new Promise(r => setTimeout(r, 2500));

  // 3. publish v2 with sign_authorship:true + if_match:<headCid>, same size.
  // Mutate one character so the body differs from v1 (same byte size).
  const v2Content = content.slice(0, -3) + 'B' + content.slice(-2);
  const v2ActualBytes = Buffer.byteLength(v2Content, 'utf8');
  const v2Start = Date.now();
  const v2 = await callTool(RELAY, token, 'publish_context', {
    graph_iri: graphIri,
    graph_content: v2Content,
    visibility: 'public',
    sign_authorship: true,
    if_match: headCid,
    auto_supersede_prior: true,
  }, 2000);
  const v2Ms = Date.now() - v2Start;

  const env = v2.payload;
  const envStr = JSON.stringify(env ?? '');
  const supersedes = env?.supersedesPriorVersions ?? env?.supersedes ?? [];
  const supersedesOk = Array.isArray(supersedes) && supersedes.includes(v1DescriptorUrl);
  const v2Ok = v2.ok && !v2.isError && !env?.error && env?.descriptorUrl && supersedesOk;

  if (v2Ok) {
    console.log(`[PASS] v2 signed+if_match ${v2Ms}ms supersedes=[${supersedes.join(',')}] descriptorUrl=${env.descriptorUrl}`);
  } else {
    const errSummary = env?.error
      ? `error=${env.error} code=${env.code} message=${(env.message || '').slice(0, 200)}`
      : v2.error
        ? `rpcError=${JSON.stringify(v2.error).slice(0, 300)}`
        : `isError=${v2.isError} envStr=${envStr.slice(0, 400)}`;
    console.log(`[FAIL] v2 signed+if_match ${v2Ms}ms ${errSummary}`);
  }

  summary.push({
    size: sizeBytes,
    actualBytes,
    v2BodyBytes: v2ActualBytes,
    v1Ms, v1Ok: true,
    v2Ms, v2Ok,
    v2DescriptorUrl: env?.descriptorUrl,
    v2Error: v2Ok ? null : (env?.error || env?.message || v2.error?.message || envStr.slice(0, 400)),
    headCid,
  });
}

async function main() {
  console.log('=== diag-signed-cas-size ===');
  console.log(`relay: ${RELAY}`);
  console.log(`time:  ${new Date().toISOString()}`);
  console.log(`sizes: ${SIZE_TIERS.join(', ')}`);
  console.log('');

  console.log('[INFO] bootstrapping OAuth bearer (scope=mcp)...');
  const full = await oauthBootstrap({ scope: 'mcp' });
  console.log(`[PASS] token acquired`);

  for (const size of SIZE_TIERS) {
    await probeSize(full.token, size);
  }

  console.log('');
  console.log('============= SUMMARY =============');
  console.log('size_target  v1_ms  v2_ms  v2_ok  notes');
  for (const r of summary) {
    const notes = r.v2Ok ? 'ok' : (r.v2Error || 'fail').toString().replace(/\s+/g, ' ').slice(0, 80);
    console.log(`${String(r.size).padStart(11)}  ${String(r.v1Ms ?? '-').padStart(5)}  ${String(r.v2Ms ?? '-').padStart(5)}  ${String(r.v2Ok).padStart(5)}  ${notes}`);
  }

  // Determine threshold
  const passes = summary.filter(r => r.v2Ok).map(r => r.size);
  const fails = summary.filter(r => !r.v2Ok && r.v1Ok).map(r => r.size);
  console.log('');
  console.log(`passes: [${passes.join(', ')}]`);
  console.log(`fails:  [${fails.join(', ')}]`);
  if (passes.length && fails.length) {
    const maxPass = Math.max(...passes);
    const minFail = Math.min(...fails);
    console.log(`threshold: between ${maxPass}B (last pass) and ${minFail}B (first fail)`);
  } else if (!fails.length) {
    console.log(`no fails across [${SIZE_TIERS.join(', ')}]`);
  } else {
    console.log(`no passes across [${SIZE_TIERS.join(', ')}]`);
  }

  console.log('');
  console.log('RUN_ID=' + RUN_ID);
}

main().catch(err => {
  console.error('FATAL:', err);
  process.exit(2);
});
