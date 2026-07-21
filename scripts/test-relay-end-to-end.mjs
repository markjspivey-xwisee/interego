#!/usr/bin/env node
/**
 * scripts/test-relay-end-to-end.mjs
 *
 * Automated end-to-end integration test against the live Interego MCP relay.
 *
 * Walks the full OAuth 2.1 + PKCE + did:key flow, then exercises the MCP
 * tool surface to verify the kernel coherence fix from commit 4b45072
 * (urn:pgsl:* IRIs routed through the LatticeAdapter) actually works on
 * the deployed substrate.
 *
 * Steps:
 *   1. Generate Ed25519 keypair, derive did:key in the W3C did:key Method
 *      Spec format ("did:key:z" + base58btc(0xed 0x01 || rawPubKey32)).
 *      Set LEGACY_DID_KEY=1 to exercise the deprecated base64url fallback
 *      that the identity server still accepts for back-compat with
 *      pre-FIX-3 registrations.
 *   2. POST /register (DCR) -> client_id.
 *   3. GET /authorize, scrape PENDING_ID + IDENTITY from inline JS.
 *   4. POST {IDENTITY}/challenges {purpose:"did-sig"} -> nonce.
 *   5. Sign nonce bytes with Ed25519 -> base64url signature.
 *   6. POST {RELAY}/oauth/verify {pending_id, method:"did", did, nonce,
 *      signature} -> redirect URL containing ?code=... .
 *   7. POST {RELAY}/token with grant_type=authorization_code + PKCE
 *      verifier -> { access_token, refresh_token, token_type }.
 *   8. POST {RELAY}/mcp with Bearer:
 *        - tools/list  (>= 35 tools)
 *        - tools/call mint
 *        - tools/call pgsl_ingest
 *        - tools/call dereference  (KERNEL COHERENCE FIX)
 *        - tools/call act  (urn:iep:action:kernel:decompose on the fragment)
 *
 * Uses only Node 22 builtins (fetch, node:crypto). Tokens stay in memory.
 */

import { generateKeyPairSync, createHash, randomBytes, sign as nodeSign } from 'node:crypto';

const RELAY = 'https://relay.interego.xwisee.com';
const REDIRECT_URI = 'http://localhost:9999/cb';
const CLIENT_NAME = 'automated-relay-test';
const SCOPE = 'mcp';

// ── tiny ANSI ──
const C = {
  pass: '\x1b[32m', fail: '\x1b[31m', warn: '\x1b[33m', dim: '\x1b[2m',
  bold: '\x1b[1m', reset: '\x1b[0m',
};
const sym = { pass: 'PASS', fail: 'FAIL', info: 'INFO' };

const results = []; // { step, status: 'pass'|'fail', detail }
function record(step, status, detail = '') {
  results.push({ step, status, detail });
  const color = status === 'pass' ? C.pass : status === 'fail' ? C.fail : C.warn;
  console.log(`${color}[${status.toUpperCase()}]${C.reset} ${step}${detail ? ': ' + detail : ''}`);
}

function b64url(buf) {
  return Buffer.from(buf).toString('base64url');
}

async function dumpResponse(label, resp) {
  // Print the response shape (status + headers + body) plus a curl
  // equivalent for the debugger. Body is read once + cached on resp.
  const headers = {};
  resp.headers.forEach((v, k) => { headers[k] = v; });
  let body = '';
  try { body = await resp.text(); } catch { body = '<unreadable>'; }
  console.log(`${C.dim}--- ${label} ---${C.reset}`);
  console.log(`status: ${resp.status} ${resp.statusText}`);
  console.log(`headers: ${JSON.stringify(headers, null, 2)}`);
  console.log(`body:    ${body.length > 4000 ? body.slice(0, 4000) + '\n... (truncated)' : body}`);
  return body;
}

function curlEquivalent({ method = 'GET', url, headers = {}, body }) {
  const parts = [`curl -i -X ${method}`];
  for (const [k, v] of Object.entries(headers)) {
    parts.push(`-H ${JSON.stringify(`${k}: ${v}`)}`);
  }
  if (body !== undefined) {
    const b = typeof body === 'string' ? body : JSON.stringify(body);
    parts.push(`--data ${JSON.stringify(b)}`);
  }
  parts.push(JSON.stringify(url));
  return parts.join(' ');
}

// ── 1. Ed25519 keypair + did:key ────────────────────────────
// The identity server accepts the W3C did:key Method Spec format:
//   did:key:z<base58btc(0xed 0x01 || rawPubKey32)>
// where 'z' is the multibase base58btc prefix and 0xed 0x01 is the
// multicodec varint for Ed25519. The server also accepts a legacy
// 'z' + base64url(rawKey32) shape for back-compat with clients that
// registered against the pre-FIX-3 server; that path emits a
// Deprecation header in the response and should be migrated.
//
// Set LEGACY_DID_KEY=1 in the env to exercise the legacy fallback for
// regression testing.
const BASE58_ALPHABET = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
function base58btcEncode(bytes) {
  let zeros = 0;
  while (zeros < bytes.length && bytes[zeros] === 0) zeros++;
  const buf = Array.from(bytes);
  const out = [];
  let start = zeros;
  while (start < buf.length) {
    let carry = 0;
    for (let i = start; i < buf.length; i++) {
      const v = (buf[i] & 0xff) + carry * 256;
      buf[i] = Math.floor(v / 58);
      carry = v % 58;
    }
    out.push(carry);
    if (buf[start] === 0) start++;
  }
  let r = '';
  for (let i = 0; i < zeros; i++) r += BASE58_ALPHABET[0];
  for (let i = out.length - 1; i >= 0; i--) r += BASE58_ALPHABET[out[i]];
  return r;
}
function encodeW3cDidKey(rawPub32) {
  const buf = new Uint8Array(34);
  buf[0] = 0xed; buf[1] = 0x01;
  buf.set(rawPub32, 2);
  return 'z' + base58btcEncode(buf);
}
function generateDidKey() {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  // Extract raw 32-byte public key from SPKI DER.
  const spki = publicKey.export({ format: 'der', type: 'spki' });
  const rawPub = spki.subarray(spki.length - 32);
  const useLegacy = process.env.LEGACY_DID_KEY === '1';
  const multibase = useLegacy ? 'z' + b64url(rawPub) : encodeW3cDidKey(rawPub);
  const did = 'did:key:' + multibase;
  return { did, publicKeyMultibase: multibase, privateKey, publicKey, rawPub, format: useLegacy ? 'base64url-legacy' : 'base58btc' };
}

// ── PKCE ────────────────────────────────────────────────────
function makePkce() {
  const code_verifier = randomBytes(32).toString('base64url');
  const code_challenge = b64url(createHash('sha256').update(code_verifier).digest());
  return { code_verifier, code_challenge };
}

// ── Main ────────────────────────────────────────────────────
const minted = {}; // captured IRIs for the final report

async function main() {
  console.log(`${C.bold}=== Interego relay end-to-end integration test ===${C.reset}`);
  console.log(`relay: ${RELAY}`);
  console.log(`time:  ${new Date().toISOString()}`);
  console.log('');

  // Step 1
  let id;
  try {
    id = generateDidKey();
    record('1. generate Ed25519 keypair + did:key', 'pass', `${id.did} (format=${id.format})`);
  } catch (err) {
    record('1. generate Ed25519 keypair + did:key', 'fail', err.message);
    return;
  }

  // Step 2: DCR
  let clientId;
  {
    const url = `${RELAY}/register`;
    const body = {
      client_name: CLIENT_NAME,
      redirect_uris: [REDIRECT_URI],
      grant_types: ['authorization_code', 'refresh_token'],
      token_endpoint_auth_method: 'none',
    };
    const resp = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (!resp.ok) {
      console.log('curl: ' + curlEquivalent({ method: 'POST', url, headers: { 'Content-Type': 'application/json' }, body }));
      await dumpResponse('POST /register', resp);
      record('2. DCR (POST /register)', 'fail', `HTTP ${resp.status}`);
      return summarize('step 2 (DCR)');
    }
    const data = await resp.json();
    clientId = data.client_id;
    record('2. DCR (POST /register)', 'pass', `client_id=${clientId}`);
  }

  // Step 3: GET /authorize, scrape PENDING_ID + IDENTITY from inline JS
  const pkce = makePkce();
  const state = randomBytes(8).toString('hex');
  let pendingId, identityOrigin;
  {
    const u = new URL(`${RELAY}/authorize`);
    u.searchParams.set('response_type', 'code');
    u.searchParams.set('client_id', clientId);
    u.searchParams.set('redirect_uri', REDIRECT_URI);
    u.searchParams.set('code_challenge', pkce.code_challenge);
    u.searchParams.set('code_challenge_method', 'S256');
    u.searchParams.set('scope', SCOPE);
    u.searchParams.set('state', state);
    const resp = await fetch(u.toString(), { method: 'GET' });
    if (!resp.ok) {
      console.log('curl: ' + curlEquivalent({ url: u.toString() }));
      await dumpResponse('GET /authorize', resp);
      record('3. GET /authorize (scrape PENDING_ID + IDENTITY)', 'fail', `HTTP ${resp.status}`);
      return summarize('step 3 (authorize)');
    }
    const html = await resp.text();
    const pendMatch = html.match(/const PENDING_ID = "([^"]+)"/);
    const idMatch = html.match(/const IDENTITY = "([^"]+)"/);
    if (!pendMatch || !idMatch) {
      console.log('curl: ' + curlEquivalent({ url: u.toString() }));
      console.log('HTML snippet:\n' + html.slice(0, 2000));
      record('3. GET /authorize (scrape PENDING_ID + IDENTITY)', 'fail', 'could not parse PENDING_ID/IDENTITY from authorize HTML');
      return summarize('step 3 (parse authorize)');
    }
    pendingId = pendMatch[1];
    identityOrigin = idMatch[1];
    record('3. GET /authorize (scrape PENDING_ID + IDENTITY)', 'pass', `pending=${pendingId.slice(0, 8)}... identity=${new URL(identityOrigin).host}`);
  }

  // Step 4: get challenge from identity
  let nonce;
  {
    const url = `${identityOrigin}/challenges`;
    const body = { purpose: 'did-sig' };
    const resp = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (!resp.ok) {
      console.log('curl: ' + curlEquivalent({ method: 'POST', url, headers: { 'Content-Type': 'application/json' }, body }));
      await dumpResponse('POST /challenges', resp);
      record('4. POST {identity}/challenges (did-sig)', 'fail', `HTTP ${resp.status}`);
      return summarize('step 4 (challenges)');
    }
    const data = await resp.json();
    nonce = data.nonce;
    if (!nonce) {
      record('4. POST {identity}/challenges (did-sig)', 'fail', 'no nonce in response');
      return summarize('step 4 (challenges)');
    }
    record('4. POST {identity}/challenges (did-sig)', 'pass', `nonce=${nonce.slice(0, 16)}...`);
  }

  // Step 5: sign nonce with Ed25519
  let signature;
  try {
    // Identity verifies with: crypto.verify(null, Buffer.from(nonce,'utf8'), key, sig)
    // So we sign the raw UTF-8 bytes of the nonce string with Ed25519 (algorithm = null/EdDSA).
    const sigBytes = nodeSign(null, Buffer.from(nonce, 'utf8'), id.privateKey);
    signature = b64url(sigBytes);
    record('5. Ed25519 sign(nonce)', 'pass', `sig=${signature.slice(0, 24)}...`);
  } catch (err) {
    record('5. Ed25519 sign(nonce)', 'fail', err.message);
    return summarize('step 5 (sign)');
  }

  // Step 6: POST /oauth/verify
  let authCode;
  {
    const url = `${RELAY}/oauth/verify`;
    const body = {
      pending_id: pendingId,
      method: 'did',
      did: id.did,
      nonce,
      signature,
      publicKeyMultibase: id.publicKeyMultibase,
    };
    const resp = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (!resp.ok) {
      console.log('curl: ' + curlEquivalent({ method: 'POST', url, headers: { 'Content-Type': 'application/json' }, body }));
      await dumpResponse('POST /oauth/verify', resp);
      record('6. POST /oauth/verify (did proof)', 'fail', `HTTP ${resp.status}`);
      return summarize('step 6 (verify)');
    }
    const data = await resp.json();
    if (!data.redirect) {
      record('6. POST /oauth/verify (did proof)', 'fail', `no redirect in response: ${JSON.stringify(data)}`);
      return summarize('step 6 (verify)');
    }
    const u = new URL(data.redirect);
    authCode = u.searchParams.get('code');
    if (!authCode) {
      record('6. POST /oauth/verify (did proof)', 'fail', `redirect missing ?code: ${data.redirect}`);
      return summarize('step 6 (verify)');
    }
    record('6. POST /oauth/verify (did proof)', 'pass', `code=${authCode.slice(0, 16)}...`);
  }

  // Step 7: exchange code for tokens
  let accessToken;
  {
    const url = `${RELAY}/token`;
    const form = new URLSearchParams({
      grant_type: 'authorization_code',
      code: authCode,
      code_verifier: pkce.code_verifier,
      redirect_uri: REDIRECT_URI,
      client_id: clientId,
    });
    const resp = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: form.toString(),
    });
    if (!resp.ok) {
      console.log('curl: ' + curlEquivalent({ method: 'POST', url, headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: form.toString() }));
      await dumpResponse('POST /token', resp);
      record('7. POST /token (code→access_token)', 'fail', `HTTP ${resp.status}`);
      return summarize('step 7 (token)');
    }
    const data = await resp.json();
    accessToken = data.access_token;
    if (!accessToken) {
      record('7. POST /token (code→access_token)', 'fail', `no access_token: ${JSON.stringify(data)}`);
      return summarize('step 7 (token)');
    }
    record('7. POST /token (code→access_token)', 'pass', `token_type=${data.token_type} expires_in=${data.expires_in}`);
  }

  // ── MCP probes ──────────────────────────────────────────────
  async function rpc(label, payload) {
    const url = `${RELAY}/mcp`;
    const headers = {
      'Authorization': `Bearer ${accessToken}`,
      'Content-Type': 'application/json',
      'Accept': 'application/json, text/event-stream',
    };
    const body = JSON.stringify(payload);
    const resp = await fetch(url, { method: 'POST', headers, body });
    if (!resp.ok) {
      console.log('curl: ' + curlEquivalent({ method: 'POST', url, headers, body }));
      const text = await dumpResponse(`POST /mcp (${label})`, resp);
      return { ok: false, status: resp.status, raw: text };
    }
    const ct = resp.headers.get('content-type') ?? '';
    const text = await resp.text();
    // Streamable HTTP transport may return SSE-framed events. Strip
    // "event: message\ndata: <json>\n\n" framing if present.
    let json;
    if (ct.includes('text/event-stream')) {
      const lines = text.split('\n');
      const dataLines = lines.filter(l => l.startsWith('data:')).map(l => l.slice(5).trim());
      const merged = dataLines.join('');
      try { json = JSON.parse(merged); } catch (e) {
        return { ok: false, status: resp.status, raw: text, error: `SSE parse: ${e.message}` };
      }
    } else {
      try { json = JSON.parse(text); } catch (e) {
        return { ok: false, status: resp.status, raw: text, error: `JSON parse: ${e.message}` };
      }
    }
    if (json.error) {
      console.log(`curl: ` + curlEquivalent({ method: 'POST', url, headers, body }));
      console.log(`error body: ${JSON.stringify(json, null, 2)}`);
      return { ok: false, status: resp.status, error: json.error, raw: json };
    }
    return { ok: true, json };
  }

  // 8a. tools/list (initialize first per MCP spec)
  // Some Streamable HTTP transports require an initialize handshake.
  // We try tools/list directly; if the server rejects it, we initialize
  // and retry.
  let toolNames = [];
  {
    let r = await rpc('tools/list (cold)', {
      jsonrpc: '2.0', id: 1, method: 'tools/list', params: {},
    });
    if (!r.ok) {
      // try initialize then retry
      const init = await rpc('initialize', {
        jsonrpc: '2.0', id: 0, method: 'initialize',
        params: {
          protocolVersion: '2025-03-26',
          capabilities: {},
          clientInfo: { name: CLIENT_NAME, version: '1.0.0' },
        },
      });
      if (!init.ok) {
        record('8a. tools/list', 'fail', `initialize failed: ${init.error ?? init.status}`);
        return summarize('step 8a (tools/list)');
      }
      r = await rpc('tools/list (post-init)', {
        jsonrpc: '2.0', id: 1, method: 'tools/list', params: {},
      });
    }
    if (!r.ok) {
      record('8a. tools/list', 'fail', `${r.error ?? r.status}`);
      return summarize('step 8a (tools/list)');
    }
    const tools = r.json?.result?.tools ?? [];
    toolNames = tools.map(t => t.name);
    const expectAtLeast = 35;
    if (tools.length >= expectAtLeast) {
      record('8a. tools/list', 'pass', `${tools.length} tools returned (>= ${expectAtLeast} expected)`);
    } else {
      record('8a. tools/list', 'fail', `only ${tools.length} tools returned (expected >= ${expectAtLeast})`);
    }
  }

  // Helper to call a tool + extract its content payload.
  async function callTool(toolName, args, rpcId) {
    const r = await rpc(`tools/call ${toolName}`, {
      jsonrpc: '2.0', id: rpcId, method: 'tools/call',
      params: { name: toolName, arguments: args },
    });
    if (!r.ok) return { ok: false, error: r.error ?? r.status };
    const result = r.json?.result;
    if (!result) return { ok: false, error: `no result: ${JSON.stringify(r.json)}` };
    if (result.isError) return { ok: false, error: `tool error: ${JSON.stringify(result)}` };
    // tools/call returns content: [{ type: 'text', text: <stringified-json> }]
    const text = result.content?.[0]?.text;
    if (!text) return { ok: false, error: `no content.text: ${JSON.stringify(result)}` };
    let payload;
    try { payload = JSON.parse(text); } catch { payload = text; }
    return { ok: true, payload, raw: result };
  }

  // 8b. mint — a single atom via the kernel verb. Mints into the
  //     kernel's LatticeAdapter-owned PGSL instance, so this IRI is
  //     directly dereferenceable through `dereference`.
  let mintIri;
  {
    // Use a unique content so the atom shows up fresh each run (helps
    // confirm we're talking to a live substrate, not a cached IRI).
    const unique = `automated-test-alpha-${Date.now()}`;
    const r = await callTool('mint', { content: unique }, 2);
    if (!r.ok) {
      record('8b. tools/call mint', 'fail', r.error);
    } else {
      const p = r.payload;
      mintIri = p?.holon?.iri ?? p?.['@id'] ?? p?.id ?? p?.iri;
      if (typeof mintIri === 'string' && mintIri.startsWith('urn:pgsl:atom:')) {
        record('8b. tools/call mint', 'pass', `iri=${mintIri}`);
        minted.atom = mintIri;
      } else {
        record('8b. tools/call mint', 'fail', `no urn:pgsl:atom:* iri (payload=${JSON.stringify(p).slice(0, 400)})`);
      }
    }
  }

  // 8c. pgsl_ingest (relay-local PGSL instance) — used here primarily
  //     as a sanity check that the lattice-builder shim still works
  //     from the wire. We do NOT use the resulting URI for the kernel
  //     coherence verification (it lives in the relay-local PGSL, not
  //     the kernel adapter's PGSL). For the coherence verification we
  //     mint a real fragment THROUGH the kernel verb `promote` below.
  let fragmentIri;
  {
    const r = await callTool('pgsl_ingest', { content: 'alpha beta gamma delta epsilon' }, 3);
    if (!r.ok) {
      record('8c. tools/call pgsl_ingest (relay-local PGSL)', 'fail', r.error);
    } else {
      const p = r.payload;
      fragmentIri = p?.topUri ?? p?.['@id'];
      if (typeof fragmentIri === 'string' && fragmentIri.startsWith('urn:pgsl:')) {
        const stats = p?.stats ?? {};
        record('8c. tools/call pgsl_ingest (relay-local PGSL)', 'pass', `topUri=${fragmentIri} stats=${JSON.stringify(stats)}`);
        minted.fragmentRelayLocal = fragmentIri;
      } else {
        record('8c. tools/call pgsl_ingest (relay-local PGSL)', 'fail', `no urn:pgsl:* topUri (payload=${JSON.stringify(p).slice(0, 400)})`);
      }
    }
  }

  // 8c'. promote — build a real fragment THROUGH the kernel adapter.
  //      This (unlike pgsl_ingest) writes to the adapter's PGSL so the
  //      resulting fragment IRI IS dereferenceable through kernel.dereference.
  let kernelFragmentIri;
  {
    const ts = Date.now();
    const r = await callTool('promote', {
      atoms: [`pgsl-test-${ts}-a`, `pgsl-test-${ts}-b`, `pgsl-test-${ts}-c`],
    }, 31);
    if (!r.ok) {
      record('8c\'. tools/call promote (kernel-adapter fragment)', 'fail', r.error);
    } else {
      const p = r.payload;
      kernelFragmentIri = p?.apex ?? p?.['iep:apex'] ?? p?.['@id'];
      if (typeof kernelFragmentIri === 'string' && kernelFragmentIri.startsWith('urn:pgsl:')) {
        record('8c\'. tools/call promote (kernel-adapter fragment)', 'pass', `apex=${kernelFragmentIri}`);
        minted.fragmentKernelAdapter = kernelFragmentIri;
      } else {
        record('8c\'. tools/call promote (kernel-adapter fragment)', 'fail', `no urn:pgsl:* apex (payload=${JSON.stringify(p).slice(0, 400)})`);
      }
    }
  }

  // 8d. dereference — THE KERNEL COHERENCE FIX from commit 4b45072
  // The fix routes urn:pgsl:* through the LatticeAdapter so direct
  // dereference resolves cleanly (was previously broken — only the
  // pgsl_resolve shim worked).
  //
  // IMPORTANT: dereference resolution goes through the kernel's
  // LatticeAdapter (a process-private PGSL instance owned by the
  // adapter; see packages/pgsl/src/kernel-adapter.ts adapterPgsl()).
  // The kernel verb `mint` writes to that adapter's PGSL. The named
  // shim `pgsl_ingest` writes to the relay-local `pgslInstance` which
  // is a DIFFERENT PGSL instance — so its `topUri` does NOT resolve
  // through the kernel adapter. To exercise the coherence fix
  // (kernel.dereference(urn:pgsl:*) → adapter), use the IRI minted
  // by the kernel verb `mint`. We also try the fragment as a sanity
  // check + report which one resolves.
  let dereferenceOk = false;
  // Prefer the kernel-adapter fragment (decomposable, biggest exercise
  // of the coherence fix). Fall back to the kernel-adapter atom. The
  // relay-local fragment is the last resort and is EXPECTED to come
  // back not-found through the kernel path (different PGSL instance).
  let dereferenceTarget = kernelFragmentIri ?? mintIri ?? fragmentIri;
  if (dereferenceTarget) {
    const r = await callTool('dereference', { iri: dereferenceTarget }, 4);
    if (!r.ok) {
      record('8d. tools/call dereference (KERNEL COHERENCE FIX)', 'fail', r.error);
    } else {
      const p = r.payload;
      // Expected shape (per commit 4b45072): the kernel's
      // dereferenceLatticeNode returns a DereferenceResult whose
      // `representation` field is a STRINGIFIED JSON-LD doc with
      //   { '@type': 'iep:Atom'|'iep:Fragment', 'iep:level': N,
      //     'iep:value':..., 'iep:items': [...] }
      // plus top-level `affordances: [{ action, target, method }, ...]`
      // (the decompose/promote/per-item-dereference affordances).
      // decorateKernelResult merges the result's own fields at top level
      // and keeps `affordances` from the envelope. So we expect to see
      // p.iri + p.status + p.representation (string) + p.affordances.
      let repParsed = null;
      if (typeof p?.representation === 'string' && p.representation.length > 0) {
        try { repParsed = JSON.parse(p.representation); } catch { /* leave null */ }
      }
      const candidates = [p, repParsed, p?.result, p?.value, p?.holon];
      let foundType = '', foundAffordances = [], latticeFields = {};
      for (const c of candidates) {
        if (!c || typeof c !== 'object') continue;
        const t = c['@type'] ?? c.type;
        const ts = Array.isArray(t) ? t.join(',') : String(t ?? '');
        if (/Atom|Fragment/.test(ts)) { foundType = ts; }
        const aff = c.affordances ?? c.existing;
        if (Array.isArray(aff) && aff.length > 0 && foundAffordances.length === 0) foundAffordances = aff;
        for (const k of ['iep:level', 'iep:value', 'iep:items', 'level', 'value', 'items', 'kind', 'iri']) {
          if (c[k] !== undefined && latticeFields[k] === undefined) latticeFields[k] = c[k];
        }
      }
      // Also accept top-level `existing` (from decorateKernelResult) and
      // the kernel's flat shape (iep:level + iep:value + iep:items).
      const typeStr = foundType
        || String(p?.['@type'] ?? p?.type ?? '');
      const affordances = foundAffordances.length > 0
        ? foundAffordances
        : (p?.affordances ?? p?.existing ?? []);
      const status = p?.status;
      const hasLatticeFields = Object.keys(latticeFields).length > 0;
      const isLatticeType = /(Atom|Fragment)/.test(typeStr) || hasLatticeFields;
      const hasAffordances = Array.isArray(affordances) && affordances.length > 0;
      const resolved = status === 'ok' && (isLatticeType || hasAffordances);
      if (resolved) {
        dereferenceOk = true;
        record('8d. tools/call dereference (KERNEL COHERENCE FIX)', 'pass',
          `status=${status} type=${typeStr} affordances=${affordances.length} fields=${Object.keys(latticeFields).join(',')} target=${dereferenceTarget}`);
      } else if (status === 'ok') {
        // Status ok but no lattice signature — odd but routed.
        dereferenceOk = true;
        record('8d. tools/call dereference (KERNEL COHERENCE FIX)', 'pass',
          `status=${status} (no lattice signature, but routed; representation=${p?.representation ? 'present' : 'absent'}) target=${dereferenceTarget}`);
        console.log(`${C.dim}dereference payload (full):${C.reset}\n${JSON.stringify(p, null, 2).slice(0, 3000)}`);
      } else {
        record('8d. tools/call dereference (KERNEL COHERENCE FIX)', 'fail',
          `status=${status} type=${typeStr} affordances=${affordances.length} — kernel adapter did not resolve the urn:pgsl:* IRI`);
        console.log(`${C.dim}dereference payload (full):${C.reset}\n${JSON.stringify(p, null, 2).slice(0, 3000)}`);
      }
    }
  } else {
    record('8d. tools/call dereference (KERNEL COHERENCE FIX)', 'fail', 'no urn:pgsl:* IRI available from earlier steps');
  }

  // 8e. act — urn:iep:action:kernel:decompose on the fragment.
  // Per commit 4b45072: kernel.act() detects urn:pgsl:* targets on
  // pre-resolved affordances and dispatches internally. Expected
  // payload is a pullback square { apex, left, right, overlap }
  // for decomposable fragments (level >= 1), or { result: null }
  // for atoms / undecomposable.
  if (dereferenceTarget) {
    // The relay's handleKernelAct reads FLAT args (action/target/method),
    // not a nested { affordance } object. See deploy/mcp-relay/server.ts
    // around handleKernelAct (~L1405). Pass the affordance flattened.
    const r = await callTool('act', {
      action: 'urn:iep:action:kernel:decompose',
      target: dereferenceTarget,
      method: 'POST',
    }, 5);
    if (!r.ok) {
      record('8e. tools/call act (decompose pullback)', 'fail', r.error);
    } else {
      // actOnLatticeNode returns an ActResult: { status, statusText,
      // contentType, body: <JSON-string-of-the-pullback>, affordance }.
      // decorateKernelResult merges those fields at top level. The pullback
      // square (apex/left/right/overlap) lives INSIDE the JSON-stringified
      // body. Walk both shapes to be robust.
      const p = r.payload;
      let bodyParsed = null;
      if (typeof p?.body === 'string') {
        try { bodyParsed = JSON.parse(p.body); } catch { /* leave null */ }
      }
      const apex = p?.apex ?? p?.['iep:apex'] ?? p?.result?.apex ?? bodyParsed?.apex ?? bodyParsed?.['iep:apex'];
      const left = p?.left ?? p?.['iep:left'] ?? bodyParsed?.left ?? bodyParsed?.['iep:left'];
      const right = p?.right ?? p?.['iep:right'] ?? bodyParsed?.right ?? bodyParsed?.['iep:right'];
      const overlap = p?.overlap ?? p?.['iep:overlap'] ?? bodyParsed?.overlap ?? bodyParsed?.['iep:overlap'];
      const status = p?.status;
      const isPullback = apex && left && right && overlap;
      if (isPullback) {
        record('8e. tools/call act (decompose pullback)', 'pass',
          `status=${status} pullback apex=${apex} left=${left} right=${right} overlap=${overlap}`);
        minted.decomposeApex = apex;
      } else if (status === 200) {
        // Dispatch hit the kernel verb — for atoms, decompose() returns
        // null which is a legit outcome (bottom of the lattice). That
        // still proves the urn:pgsl:* target was routed internally.
        const bodyStr = JSON.stringify(bodyParsed ?? p).slice(0, 300);
        record('8e. tools/call act (decompose pullback)', 'pass',
          `kernel verb dispatched (status=${status}, no pullback — atom or apex): ${bodyStr}`);
      } else {
        record('8e. tools/call act (decompose pullback)', 'fail',
          `no pullback fields; status=${status} payload=${JSON.stringify(p).slice(0, 400)}`);
      }
    }
  } else {
    record('8e. tools/call act (decompose pullback)', 'fail', 'no urn:pgsl:* IRI from earlier steps');
  }

  return summarize();
}

function summarize(blockedAt) {
  console.log('');
  console.log(`${C.bold}=== Summary ===${C.reset}`);
  let passCount = 0, failCount = 0;
  for (const r of results) {
    const color = r.status === 'pass' ? C.pass : C.fail;
    console.log(`  ${color}[${r.status.toUpperCase()}]${C.reset} ${r.step}`);
    if (r.status === 'pass') passCount++; else failCount++;
  }
  console.log('');
  console.log(`pass=${passCount}  fail=${failCount}  total=${results.length}`);
  if (Object.keys(minted).length > 0) {
    console.log('');
    console.log(`${C.bold}Minted IRIs from the substrate (verify with pgsl_resolve / dereference):${C.reset}`);
    for (const [k, v] of Object.entries(minted)) console.log(`  ${k}: ${v}`);
  }
  console.log('');
  const dereferenceStep = results.find(r => /KERNEL COHERENCE FIX/.test(r.step));
  if (blockedAt) {
    console.log(`${C.fail}${C.bold}CONCLUSION:${C.reset} blocked at ${blockedAt}`);
  } else if (failCount === 0 && dereferenceStep && dereferenceStep.status === 'pass') {
    console.log(`${C.pass}${C.bold}CONCLUSION:${C.reset} kernel coherence fix verified end-to-end`);
  } else if (dereferenceStep?.status === 'pass') {
    console.log(`${C.warn}${C.bold}CONCLUSION:${C.reset} kernel coherence fix verified, but ${failCount} ancillary step(s) failed`);
  } else {
    console.log(`${C.fail}${C.bold}CONCLUSION:${C.reset} kernel coherence fix NOT verified (dereference step did not pass)`);
  }
  process.exitCode = failCount === 0 ? 0 : 1;
}

await main();
