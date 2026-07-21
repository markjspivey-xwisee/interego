#!/usr/bin/env node
/**
 * scripts/verify-signed-cas-fix.mjs
 *
 * Targeted verification of the FIX 1 / FIX 2 pair (drop no-cache header
 * + raise CAS retry budget) on the live relay. Covers the EXACT three
 * scenarios johnny asked for:
 *
 *   1. signed + if_match at 200 B   (regression — johnny's tiny baseline)
 *   2. signed + if_match at ~6 KB   (the original failing size)
 *   3. signed + if_match at ~10 KB  (verification-report-class payload)
 *
 * For each tier:
 *   - publish v1 (plain)
 *   - get_current_head -> CID
 *   - publish v2 with sign_authorship:true + if_match:<CID> +
 *                       auto_supersede_prior:true
 *   - assert: 200, supersedesPriorVersions=[v1], previousHeadCid==<CID>,
 *             authorship.authorshipVerified==true
 *
 * Uses only Node 22 builtins.
 */

import { generateKeyPairSync, createHash, randomBytes, sign as nodeSign } from 'node:crypto';

const RELAY = 'https://relay.interego.xwisee.com';
const REDIRECT_URI = 'http://localhost:9999/cb';
const CLIENT_NAME = 'verify-signed-cas-fix';

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

async function rpcCall(token, method, params, id) {
  const resp = await fetch(`${RELAY}/mcp`, {
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
    const data = text.split('\n').filter(l => l.startsWith('data:'))
      .map(l => l.slice(5).trim()).join('');
    try { json = JSON.parse(data); } catch { json = { error: { raw: text.slice(0, 400) } }; }
  } else {
    try { json = JSON.parse(text); } catch { json = { error: { raw: text.slice(0, 400) } }; }
  }
  return { json, status: resp.status, raw: text };
}

async function callTool(token, name, args, id) {
  const r = await rpcCall(token, 'tools/call', { name, arguments: args }, id);
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

// Build a Turtle body of approximately targetBytes bytes (single triple,
// long string literal). Valid Turtle, no quote/backslash hazards.
function buildGraphContent(targetBytes) {
  const prefix = '<urn:s> <urn:p> "';
  const suffix = '" .';
  const filler = 'A'.repeat(Math.max(0, targetBytes - prefix.length - suffix.length));
  return prefix + filler + suffix;
}

const RUN_ID = Date.now();
const TIERS = [
  { label: '200 B (regression — johnny baseline)', target: 200 },
  { label: '6 KB (original failing size)',           target: 6 * 1024 },
  { label: '10 KB (verification-report scale)',      target: 10 * 1024 },
];

const results = [];

async function runTier(token, tier) {
  console.log('');
  console.log(`==== tier: ${tier.label} (target=${tier.target} B) ====`);
  const tag = `verify-fix-${tier.target}-${RUN_ID}`;
  const graphIri = `urn:graph:verify:signed-cas-fix:${tag}`;
  const v1Body = buildGraphContent(tier.target);
  const v1ActualBytes = Buffer.byteLength(v1Body, 'utf8');
  console.log(`graphIri=${graphIri} v1Bytes=${v1ActualBytes}`);

  // 1. publish v1
  const v1Start = Date.now();
  let v1, v1Ms;
  for (let attempt = 1; attempt <= 4; attempt++) {
    v1 = await callTool(token, 'publish_context', {
      graph_iri: graphIri,
      graph_content: v1Body,
      visibility: 'public',
    }, 1000 + attempt);
    if (v1.ok && v1.payload?.descriptorUrl && !v1.isError) break;
    await new Promise(r => setTimeout(r, 1500 * attempt));
  }
  v1Ms = Date.now() - v1Start;
  if (!v1.ok || !v1.payload?.descriptorUrl || v1.isError) {
    const err = JSON.stringify(v1.payload ?? v1.error).slice(0, 300);
    console.log(`[FAIL] v1 publish (${v1Ms}ms): ${err}`);
    results.push({ tier: tier.label, v1Ok: false, v2Ok: false, error: err });
    return;
  }
  const v1Url = v1.payload.descriptorUrl;
  console.log(`[INFO] v1 published in ${v1Ms}ms -> ${v1Url}`);

  // 2. resolve head CID
  await new Promise(r => setTimeout(r, 1500));
  const head = await callTool(token, 'get_current_head', { urn: graphIri }, 1200);
  const headCid = head.payload?.head?.cid;
  if (!headCid) {
    console.log(`[FAIL] no head CID: ${JSON.stringify(head.payload ?? head.error).slice(0, 300)}`);
    results.push({ tier: tier.label, v1Ok: true, v2Ok: false, error: 'no head CID' });
    return;
  }
  console.log(`[INFO] head CID = ${headCid}`);

  // 3. publish v2 signed + if_match
  await new Promise(r => setTimeout(r, 2000));
  // mutate one byte so v2 differs from v1 at same size
  const v2Body = v1Body.slice(0, -3) + 'B' + v1Body.slice(-2);
  const v2Start = Date.now();
  const v2 = await callTool(token, 'publish_context', {
    graph_iri: graphIri,
    graph_content: v2Body,
    visibility: 'public',
    sign_authorship: true,
    if_match: headCid,
    auto_supersede_prior: true,
  }, 2000);
  const v2Ms = Date.now() - v2Start;
  const env = v2.payload;
  const supersedes = env?.supersedesPriorVersions ?? env?.supersedes ?? [];
  const supersedesIncludesV1 = Array.isArray(supersedes) && supersedes.includes(v1Url);
  const previousHeadCidMatch = env?.previousHeadCid === headCid;
  // publish envelope shape: { authorship: { signed: true, signer, ... } }
  const authorshipSigned = env?.authorship?.signed === true;
  const publishOk = v2.ok && !v2.isError && env?.published === true && env?.descriptorUrl
    && supersedesIncludesV1 && previousHeadCidMatch && authorshipSigned;

  // 4. dereference v2 to confirm authorshipVerified=true (the verifier
  //    runs on the descriptor turtle alone — substrate-honest verification)
  let authorshipVerified = false;
  let derefMs = null;
  let derefErr = null;
  if (publishOk) {
    await new Promise(r => setTimeout(r, 1500));
    const derefStart = Date.now();
    const deref = await callTool(token, 'get_descriptor', {
      url: env.descriptorUrl,
    }, 2200);
    derefMs = Date.now() - derefStart;
    const derefPayload = deref.payload;
    authorshipVerified = derefPayload?.authorship?.authorshipVerified === true;
    if (!authorshipVerified) {
      derefErr = JSON.stringify(derefPayload?.authorship ?? derefPayload ?? deref.error).slice(0, 400);
    }
  }
  const ok = publishOk && authorshipVerified;

  if (ok) {
    console.log(`[PASS] v2 signed+if_match ${v2Ms}ms + deref ${derefMs}ms`);
    console.log(`         descriptorUrl           = ${env.descriptorUrl}`);
    console.log(`         previousHeadCid         = ${env.previousHeadCid}`);
    console.log(`         supersedesPriorVersions = [${supersedes.join(', ')}]`);
    console.log(`         publish.authorship      = signed:${env.authorship?.signed} signer:${env.authorship?.signer}`);
    console.log(`         deref.authorshipVerified = true`);
  } else {
    console.log(`[FAIL] v2 signed+if_match ${v2Ms}ms`);
    console.log(`         status=${v2.status} isError=${v2.isError}`);
    console.log(`         env.error=${env?.error} env.code=${env?.code} env.message=${(env?.message || '').slice(0, 200)}`);
    console.log(`         supersedesIncludesV1=${supersedesIncludesV1}`);
    console.log(`         previousHeadCidMatch=${previousHeadCidMatch}`);
    console.log(`         authorshipSigned=${authorshipSigned}`);
    console.log(`         authorshipVerified=${authorshipVerified} derefErr=${derefErr}`);
    console.log(`         envStr=${JSON.stringify(env).slice(0, 600)}`);
  }
  results.push({
    tier: tier.label, target: tier.target,
    v1Bytes: v1ActualBytes,
    v1Ok: true, v1Ms,
    v2Ok: ok, v2Ms, derefMs,
    headCid, previousHeadCid: env?.previousHeadCid,
    supersedesPriorVersions: supersedes,
    authorshipSigned, authorshipVerified,
    descriptorUrl: env?.descriptorUrl,
    error: ok ? null : (env?.error || env?.message || derefErr || JSON.stringify(env ?? v2.error).slice(0, 400)),
  });
}

async function main() {
  console.log('=== verify-signed-cas-fix ===');
  console.log(`relay: ${RELAY}`);
  console.log(`time:  ${new Date().toISOString()}`);
  console.log(`tiers: ${TIERS.map(t => t.target + 'B').join(', ')}`);
  console.log('');
  console.log('[INFO] bootstrapping OAuth bearer (scope=mcp)...');
  const token = await oauthBootstrap();
  console.log('[PASS] token acquired');
  for (const tier of TIERS) {
    await runTier(token, tier);
  }
  console.log('');
  console.log('============= SUMMARY =============');
  console.log('tier                                             v1_ms  v2_ms  v2_ok');
  for (const r of results) {
    console.log(`${r.tier.padEnd(48)} ${String(r.v1Ms ?? '-').padStart(5)}  ${String(r.v2Ms ?? '-').padStart(5)}  ${String(r.v2Ok).padStart(5)}`);
  }
  console.log('');
  console.log('RUN_ID=' + RUN_ID);
  const allOk = results.length === TIERS.length && results.every(r => r.v2Ok);
  process.exit(allOk ? 0 : 1);
}

main().catch(err => {
  console.error('FATAL:', err);
  process.exit(2);
});
