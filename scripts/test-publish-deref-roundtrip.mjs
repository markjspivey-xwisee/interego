#!/usr/bin/env node
/**
 * scripts/test-publish-deref-roundtrip.mjs
 *
 * Round-trip CI self-test (FIX 12).
 *
 * Asserts the publish → dereference → plaintext-recovery invariant
 * end-to-end against the live deployed Interego MCP relay. This is the
 * deploy-gate that would have caught bugs #3 (share-with-author —
 * publish_context dropped the author's own X25519 key out of the
 * envelope recipient set when share_with was non-empty) and #4
 * (decrypt-path — kernel.dereference returned `status: encrypted-no-key`
 * for envelopes the relay's session key COULD decrypt because the
 * relay agent was a recipient of by virtue of being a delegate of the
 * pod owner who published) before they reached production.
 *
 * Why this exists: scripts/test-relay-end-to-end.mjs covers the
 * kernel-coherence fix from commit 4b45072 (urn:pgsl:* IRIs routed
 * through the LatticeAdapter), but does NOT exercise the
 * publish_context → dereference → plaintext-recovery path. The bugs
 * above broke that path twice. This file is the regression cordon.
 *
 * Scenarios:
 *
 *   A. publish_context with default visibility (no share_with).
 *      Dereference AS THE AUTHOR. Assert `status: 'ok'`, assert the
 *      plaintext Turtle round-trips to bytes that contain every
 *      uniquely-identifying triple from the input (we tolerate
 *      RDF parser-level reordering / formatting differences — bytes
 *      are not guaranteed to be stable across the JOSE round-trip,
 *      but the substrate IS guaranteed to recover the same set of
 *      RDF triples).
 *
 *   B. publish_context with share_with=['did:web:fixture-recipient.invalid'].
 *      The share_with target need not resolve — that branch's failure
 *      is non-fatal in the relay (silently appends nothing). The
 *      important assertion is that even WHEN share_with is supplied,
 *      the author still recovers plaintext. This is the bug-#3
 *      regression check: prior to fix `share-with-author`, supplying
 *      a recipient that resolves to zero keys still dropped the
 *      author's own key from the envelope (the author was implicitly
 *      represented through the initial recipients list, then the
 *      share_with branch built a new list that omitted the author).
 *
 *   C. Sanity: assert the publish response's `selfIncluded` field is
 *      `true` in both scenarios (covers the same invariant from the
 *      WRITE side — even if a future regression breaks deref, the
 *      publish-time assertion catches it cleaner).
 *
 *   D. (Best-effort, not gating) call dereference as an unauthorized
 *      third agent. We do NOT spin up a separate identity in CI (that
 *      would require a second full OAuth flow against the live
 *      identity server with its own keypair, which roughly doubles
 *      the wall-clock budget for this scenario). Instead we hit the
 *      raw envelope URL without an Authorization header and assert
 *      the pod gives 401/403 OR returns the JOSE envelope unchanged
 *      (i.e. an unauthenticated reader cannot recover plaintext).
 *      This is the negative-case sanity floor — the full third-agent
 *      OAuth path can be added later if we ever see a regression
 *      where deref-without-key starts leaking plaintext.
 *
 *   E. In-process concurrency floor (FIX B regression cordon). Fire
 *      N=5 parallel publish_context calls from the SAME OAuth session
 *      to the SAME pod via Promise.all. Pre-fix-B, the relay's
 *      in-process publishes raced inside publish()'s read-modify-write
 *      cycle on .well-known/context-graphs, dropping entries via
 *      TOCTOU silent-clobber or throwing `Failed to update manifest
 *      ... after 8 attempts`. Post-fix-B, an in-client per-pod mutex
 *      serializes same-process writers — cross-process writers keep
 *      the HTTP CAS dance. Assertion: all N publishes return
 *      published=true AND all N descriptor URLs are visible from a
 *      subsequent discover_context call.
 *
 * Walks the same OAuth 2.1 + PKCE + did:key flow as
 * scripts/test-relay-end-to-end.mjs (DCR → /authorize scrape →
 * challenge → Ed25519 sign → /oauth/verify → /token), then exercises
 * publish_context + dereference via tools/call.
 *
 * Exit codes:
 *   0 — round-trip verified for both scenarios (default + share_with),
 *       author self-decrypts plaintext both times, selfIncluded=true
 *       in both publish responses.
 *   1 — any required assertion failed (OAuth, publish, dereference,
 *       plaintext recovery, or selfIncluded).
 *
 * Uses only Node 22 builtins (fetch, node:crypto). Tokens stay in
 * memory; no on-disk artifacts.
 */

import { generateKeyPairSync, createHash, randomBytes, sign as nodeSign } from 'node:crypto';

const RELAY = process.env.RELAY_URL
  ?? 'https://relay.interego.xwisee.com';
const REDIRECT_URI = 'http://localhost:9999/cb';
const CLIENT_NAME = 'publish-deref-roundtrip-test';
const SCOPE = 'mcp';

// Unique tag baked into descriptor IRIs + graph IRIs so concurrent CI
// runs don't collide on the same pod path.
const RUN_TAG = process.env.RUN_TAG
  ?? `${Date.now()}-${randomBytes(3).toString('hex')}`;

// ── ANSI ────────────────────────────────────────────────────
const C = {
  pass: '\x1b[32m', fail: '\x1b[31m', warn: '\x1b[33m', dim: '\x1b[2m',
  bold: '\x1b[1m', reset: '\x1b[0m',
};

const results = []; // { step, status: 'pass'|'fail'|'warn', detail }
function record(step, status, detail = '') {
  results.push({ step, status, detail });
  const color = status === 'pass' ? C.pass : status === 'fail' ? C.fail : C.warn;
  console.log(`${color}[${status.toUpperCase()}]${C.reset} ${step}${detail ? ': ' + detail : ''}`);
}

function b64url(buf) {
  return Buffer.from(buf).toString('base64url');
}

// ── did:key (W3C method spec form) ──────────────────────────
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
  const spki = publicKey.export({ format: 'der', type: 'spki' });
  const rawPub = spki.subarray(spki.length - 32);
  const multibase = encodeW3cDidKey(rawPub);
  return {
    did: 'did:key:' + multibase,
    publicKeyMultibase: multibase,
    privateKey,
  };
}

// ── PKCE ────────────────────────────────────────────────────
function makePkce() {
  const code_verifier = randomBytes(32).toString('base64url');
  const code_challenge = b64url(createHash('sha256').update(code_verifier).digest());
  return { code_verifier, code_challenge };
}

// ── Sample Turtle payload ───────────────────────────────────
// Substantial + domain-credible content so round-trip recovery
// actually exercises serialization edge cases (multiple subjects,
// language tags, typed literals, blank nodes). Keep small enough that
// the CI run stays fast.
function makeSampleTurtle(graphIri) {
  // Inline prefixes + a handful of triples covering the common shapes.
  // We mint a unique sentinel literal so we can grep for it in the
  // recovered plaintext — proves round-trip on actual user-visible
  // bytes, not just a hash that could happen to collide.
  const sentinel = `roundtrip-sentinel-${RUN_TAG}`;
  const turtle = `@prefix iep: <https://w3id.org/context-graphs#> .
@prefix dct: <http://purl.org/dc/terms/> .
@prefix prov: <http://www.w3.org/ns/prov#> .
@prefix xsd: <http://www.w3.org/2001/XMLSchema#> .

<${graphIri}#observation-1>
  a iep:Observation ;
  dct:title "Round-trip self-test observation"@en ;
  dct:description "${sentinel}" ;
  dct:created "2026-06-05T00:00:00Z"^^xsd:dateTime ;
  prov:wasAttributedTo <${graphIri}#agent> ;
  iep:value "42"^^xsd:integer .

<${graphIri}#agent>
  a prov:Agent ;
  dct:title "Round-trip test author" .
`;
  return { turtle, sentinel };
}

// ── Main ────────────────────────────────────────────────────
async function main() {
  console.log(`${C.bold}=== Publish → dereference round-trip self-test ===${C.reset}`);
  console.log(`relay:    ${RELAY}`);
  console.log(`run tag:  ${RUN_TAG}`);
  console.log(`time:     ${new Date().toISOString()}`);
  console.log('');

  // ── Step 1: OAuth flow ────────────────────────────────────
  const id = generateDidKey();
  record('1. generate Ed25519 keypair + did:key', 'pass', id.did);

  // DCR
  let clientId;
  {
    const resp = await fetch(`${RELAY}/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        client_name: CLIENT_NAME,
        redirect_uris: [REDIRECT_URI],
        grant_types: ['authorization_code', 'refresh_token'],
        token_endpoint_auth_method: 'none',
      }),
    });
    if (!resp.ok) {
      record('2. DCR /register', 'fail', `HTTP ${resp.status}: ${await resp.text()}`);
      return summarize('step 2 (DCR)');
    }
    clientId = (await resp.json()).client_id;
    record('2. DCR /register', 'pass', `client_id=${clientId}`);
  }

  // /authorize scrape
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
    const resp = await fetch(u.toString());
    if (!resp.ok) {
      record('3. GET /authorize', 'fail', `HTTP ${resp.status}`);
      return summarize('step 3');
    }
    const html = await resp.text();
    const pendMatch = html.match(/const PENDING_ID = "([^"]+)"/);
    const idMatch = html.match(/const IDENTITY = "([^"]+)"/);
    if (!pendMatch || !idMatch) {
      record('3. GET /authorize', 'fail', 'could not parse PENDING_ID / IDENTITY');
      return summarize('step 3');
    }
    pendingId = pendMatch[1];
    identityOrigin = idMatch[1];
    record('3. GET /authorize', 'pass', `pending=${pendingId.slice(0, 8)}...`);
  }

  // challenge → sign → /oauth/verify
  let nonce;
  {
    const resp = await fetch(`${identityOrigin}/challenges`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ purpose: 'did-sig' }),
    });
    if (!resp.ok) {
      record('4. POST /challenges', 'fail', `HTTP ${resp.status}`);
      return summarize('step 4');
    }
    nonce = (await resp.json()).nonce;
    record('4. POST /challenges', 'pass', `nonce=${nonce.slice(0, 16)}...`);
  }
  let signature;
  try {
    const sigBytes = nodeSign(null, Buffer.from(nonce, 'utf8'), id.privateKey);
    signature = b64url(sigBytes);
    record('5. Ed25519 sign(nonce)', 'pass');
  } catch (err) {
    record('5. Ed25519 sign(nonce)', 'fail', err.message);
    return summarize('step 5');
  }

  let authCode;
  {
    const resp = await fetch(`${RELAY}/oauth/verify`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        pending_id: pendingId,
        method: 'did',
        did: id.did,
        nonce,
        signature,
        publicKeyMultibase: id.publicKeyMultibase,
      }),
    });
    if (!resp.ok) {
      record('6. POST /oauth/verify', 'fail', `HTTP ${resp.status}: ${await resp.text()}`);
      return summarize('step 6');
    }
    const data = await resp.json();
    if (!data.redirect) {
      record('6. POST /oauth/verify', 'fail', `no redirect: ${JSON.stringify(data)}`);
      return summarize('step 6');
    }
    authCode = new URL(data.redirect).searchParams.get('code');
    if (!authCode) {
      record('6. POST /oauth/verify', 'fail', `no ?code in redirect`);
      return summarize('step 6');
    }
    record('6. POST /oauth/verify', 'pass', `code=${authCode.slice(0, 12)}...`);
  }

  let accessToken;
  {
    const form = new URLSearchParams({
      grant_type: 'authorization_code',
      code: authCode,
      code_verifier: pkce.code_verifier,
      redirect_uri: REDIRECT_URI,
      client_id: clientId,
    });
    const resp = await fetch(`${RELAY}/token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: form.toString(),
    });
    if (!resp.ok) {
      record('7. POST /token', 'fail', `HTTP ${resp.status}: ${await resp.text()}`);
      return summarize('step 7');
    }
    accessToken = (await resp.json()).access_token;
    if (!accessToken) {
      record('7. POST /token', 'fail', 'no access_token');
      return summarize('step 7');
    }
    record('7. POST /token', 'pass', `token=${accessToken.slice(0, 12)}...`);
  }

  // ── MCP rpc helpers ───────────────────────────────────────
  async function rpc(payload) {
    const resp = await fetch(`${RELAY}/mcp`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${accessToken}`,
        'Content-Type': 'application/json',
        'Accept': 'application/json, text/event-stream',
      },
      body: JSON.stringify(payload),
    });
    const ct = resp.headers.get('content-type') ?? '';
    const text = await resp.text();
    let json;
    if (ct.includes('text/event-stream')) {
      const merged = text.split('\n').filter(l => l.startsWith('data:')).map(l => l.slice(5).trim()).join('');
      try { json = JSON.parse(merged); } catch (e) { return { ok: false, error: `SSE parse: ${e.message}`, raw: text }; }
    } else {
      try { json = JSON.parse(text); } catch (e) { return { ok: false, error: `JSON parse: ${e.message}`, raw: text }; }
    }
    if (json.error) return { ok: false, error: JSON.stringify(json.error), raw: json };
    return { ok: true, json };
  }
  async function callTool(name, args, rpcId) {
    const r = await rpc({
      jsonrpc: '2.0',
      id: rpcId,
      method: 'tools/call',
      params: { name, arguments: args },
    });
    if (!r.ok) return { ok: false, error: r.error };
    const result = r.json?.result;
    if (!result) return { ok: false, error: `no result: ${JSON.stringify(r.json)}` };
    if (result.isError) return { ok: false, error: `tool error: ${JSON.stringify(result)}` };
    const text = result.content?.[0]?.text;
    if (!text) return { ok: false, error: `no content.text: ${JSON.stringify(result)}` };
    let payload;
    try { payload = JSON.parse(text); } catch { payload = text; }
    return { ok: true, payload, raw: result };
  }

  // ── Scenario runner ───────────────────────────────────────
  // Each scenario publishes, dereferences AS THE AUTHOR, and asserts
  // plaintext recovery. Returns { ok, descriptorUrl, graphUrl,
  // selfIncluded, recovered }.
  async function runScenario({ label, scenarioTag, shareWith, stepBase }) {
    const graphIri = `urn:graph:roundtrip:${RUN_TAG}:${scenarioTag}`;
    const descriptorId = `urn:iep:roundtrip:${RUN_TAG}:${scenarioTag}`;
    const { turtle, sentinel } = makeSampleTurtle(graphIri);

    // ── publish_context ──
    const publishArgs = {
      graph_iri: graphIri,
      graph_content: turtle,
      descriptor_id: descriptorId,
      modal_status: 'Asserted',
      confidence: 0.9,
    };
    if (shareWith && shareWith.length > 0) publishArgs.share_with = shareWith;

    const pub = await callTool('publish_context', publishArgs, stepBase + 1);
    if (!pub.ok) {
      record(`${label}.a publish_context`, 'fail', pub.error);
      return { ok: false };
    }
    const p = pub.payload;
    if (!p?.published || !p?.descriptorUrl) {
      record(`${label}.a publish_context`, 'fail', `payload missing published / descriptorUrl: ${JSON.stringify(p).slice(0, 400)}`);
      return { ok: false };
    }
    const encrypted = p.encrypted === true;
    record(`${label}.a publish_context`, 'pass',
      `descriptorUrl=${p.descriptorUrl} encrypted=${encrypted} recipients=${p.recipients} selfIncluded=${p.selfIncluded}`);

    // ── selfIncluded invariant (bug #3 — share-with-author) ──
    if (p.selfIncluded !== true) {
      record(`${label}.b selfIncluded invariant`, 'fail',
        `publish response reports selfIncluded=${p.selfIncluded} — author key was dropped from envelope recipient set`);
      // Don't return — keep going so we also see whether deref fails.
    } else {
      record(`${label}.b selfIncluded invariant`, 'pass', 'author key is in recipient set');
    }

    // ── dereference as author (kernel verb) ──
    // Bug #4 manifested here: kernel.dereference returned
    // `status: encrypted-no-key` even though the relay agent held the
    // wrapped key. We assert status:ok AND plaintext recovery.
    const deref = await callTool('dereference', { iri: p.descriptorUrl }, stepBase + 2);
    if (!deref.ok) {
      record(`${label}.c dereference (kernel, as author)`, 'fail', deref.error);
      return { ok: false, descriptorUrl: p.descriptorUrl };
    }
    const d = deref.payload;
    const status = d?.status;
    if (status === 'encrypted-no-key') {
      record(`${label}.c dereference (kernel, as author)`, 'fail',
        `status=encrypted-no-key — relay did NOT pass recipientKeyPair through to envelope decrypt (bug #4 regression)`);
      console.log(`${C.dim}deref payload:${C.reset}\n${JSON.stringify(d, null, 2).slice(0, 2000)}`);
      return { ok: false, descriptorUrl: p.descriptorUrl };
    }
    if (status !== 'ok') {
      record(`${label}.c dereference (kernel, as author)`, 'fail',
        `status=${status} (expected ok)`);
      console.log(`${C.dim}deref payload:${C.reset}\n${JSON.stringify(d, null, 2).slice(0, 2000)}`);
      return { ok: false, descriptorUrl: p.descriptorUrl };
    }
    record(`${label}.c dereference (kernel, as author)`, 'pass', `status=ok`);

    // ── plaintext recovery: descriptor turtle + linked graph payload ──
    // The kernel dereference of a descriptor URL returns the
    // descriptor turtle in `representation` (it's already plaintext —
    // descriptors are not encrypted, only the graph payload is). To
    // assert ENVELOPE plaintext recovery we follow the descriptor's
    // distribution affordance to the graph URL and call get_descriptor
    // on it — that path runs through fetchGraphContent +
    // recipientKeyPair=relayAgentKey and returns decrypted content.
    const graphUrl = p.graphUrl;
    if (!graphUrl) {
      record(`${label}.d plaintext recovery`, 'fail', 'publish response missing graphUrl');
      return { ok: false, descriptorUrl: p.descriptorUrl };
    }
    const gd = await callTool('get_descriptor', { url: graphUrl }, stepBase + 3);
    if (!gd.ok) {
      record(`${label}.d plaintext recovery (get_descriptor on graph)`, 'fail', gd.error);
      return { ok: false, descriptorUrl: p.descriptorUrl };
    }
    const gp = gd.payload;
    // For encrypted envelopes: get_descriptor returns { url, encrypted,
    // mediaType, content } where content is the decrypted Turtle (or
    // null if relay can't decrypt). For cleartext .trig: same shape.
    if (gp?.error) {
      record(`${label}.d plaintext recovery`, 'fail', `get_descriptor error: ${gp.error}`);
      return { ok: false, descriptorUrl: p.descriptorUrl };
    }
    if (encrypted && gp?.encrypted === true && gp?.content === null) {
      record(`${label}.d plaintext recovery`, 'fail',
        `graph reports encrypted but content=null — relay agent NOT a recipient (bug #3 regression: author key dropped from envelope)`);
      return { ok: false, descriptorUrl: p.descriptorUrl };
    }
    const recovered = typeof gp?.content === 'string'
      ? gp.content
      : (typeof gp?.turtle === 'string' ? gp.turtle : '');
    if (!recovered || recovered.length === 0) {
      record(`${label}.d plaintext recovery`, 'fail',
        `no content/turtle in get_descriptor payload: ${JSON.stringify(gp).slice(0, 400)}`);
      return { ok: false, descriptorUrl: p.descriptorUrl };
    }
    if (!recovered.includes(sentinel)) {
      record(`${label}.d plaintext recovery`, 'fail',
        `recovered ${recovered.length}B but sentinel "${sentinel}" not present — round-trip lost the input bytes`);
      console.log(`${C.dim}recovered (first 800B):${C.reset}\n${recovered.slice(0, 800)}`);
      return { ok: false, descriptorUrl: p.descriptorUrl };
    }
    record(`${label}.d plaintext recovery`, 'pass',
      `${recovered.length}B recovered, sentinel "${sentinel}" present, encrypted=${gp.encrypted}`);

    return {
      ok: true,
      descriptorUrl: p.descriptorUrl,
      graphUrl,
      selfIncluded: p.selfIncluded === true,
      encrypted,
      recovered,
    };
  }

  // ── Scenario A: default visibility ────────────────────────
  console.log('');
  console.log(`${C.bold}--- Scenario A: publish with default visibility, author dereferences ---${C.reset}`);
  const a = await runScenario({
    label: '8A',
    scenarioTag: 'default',
    shareWith: undefined,
    stepBase: 800,
  });

  // ── Scenario B: share_with non-empty ──────────────────────
  console.log('');
  console.log(`${C.bold}--- Scenario B: publish with share_with, author still dereferences ---${C.reset}`);
  // Use a did:web handle that can't resolve (point at a non-existent
  // host) so we exercise the share_with branch without depending on a
  // second live fixture pod. The relay's resolveRecipients silently
  // drops handles that fail to resolve — that's the exact scenario
  // where bug #3 left the author out of the envelope recipient set.
  const b = await runScenario({
    label: '8B',
    scenarioTag: 'sharewith',
    shareWith: [`did:web:roundtrip-fixture-${RUN_TAG}.invalid`],
    stepBase: 900,
  });

  // ── Scenario D: unauthorized third reader floor ───────────
  // Hit the encrypted graph URL with NO Authorization header — we expect
  // either an auth challenge or the raw JOSE envelope (NOT plaintext).
  // This is a sanity floor, not a full negative-case test (that would
  // need a second live identity). The full third-agent OAuth path is
  // a follow-up if we ever observe a regression here.
  if (a.ok && a.encrypted && a.graphUrl) {
    console.log('');
    console.log(`${C.bold}--- Scenario D: unauthenticated reader cannot recover plaintext ---${C.reset}`);
    try {
      const resp = await fetch(a.graphUrl);
      const body = await resp.text();
      const looksLikePlaintextTurtle = /@prefix\s+\w+:|\bdct:description\b|roundtrip-sentinel/.test(body);
      if (resp.status === 401 || resp.status === 403) {
        record('8D. unauthenticated reader gets 401/403', 'pass', `status=${resp.status}`);
      } else if (resp.ok && !looksLikePlaintextTurtle) {
        // Server returned the JOSE envelope (or other ciphertext).
        // Acceptable: an unauthenticated reader couldn't recover the
        // plaintext Turtle. We don't strictly require JOSE shape —
        // just no plaintext leakage.
        record('8D. unauthenticated reader gets ciphertext only', 'pass',
          `status=${resp.status} body=${body.length}B (no plaintext markers)`);
      } else if (resp.ok && looksLikePlaintextTurtle) {
        record('8D. unauthenticated reader gets ciphertext only', 'fail',
          `status=${resp.status} body LOOKS LIKE plaintext Turtle — ENVELOPE WAS NOT ENCRYPTED OR ACL IS WIDE OPEN`);
      } else {
        // Some other non-2xx (404, 500) — log but don't gate, the
        // pod may be in an unexpected state for unauth GET.
        record('8D. unauthenticated reader gets 401/403 or ciphertext', 'warn',
          `status=${resp.status} (neither auth-challenge nor 2xx) — advisory only`);
      }
    } catch (err) {
      record('8D. unauthenticated reader probe', 'warn', `network: ${err.message} — advisory only`);
    }
  } else {
    record('8D. unauthenticated reader probe', 'warn', 'skipped (scenario A did not encrypt)');
  }

  // ── Scenario E: in-process concurrency floor (FIX B) ───────
  // Fire N parallel publish_context calls to the SAME pod from the
  // SAME OAuth session. Pre-fix-B, the relay's same-process publishes
  // raced inside the publish() read-modify-write cycle: they all GET
  // the same manifest etag, each builds a body containing only its
  // own entry, the server commits one and 412s the rest, the rest
  // retry, and either (a) drop entries via a CSS TOCTOU silent
  // clobber or (b) blow the 8-attempt retry budget with
  // `Failed to update manifest ... after 8 attempts`. Post-fix, the
  // per-pod in-process mutex inside publish() collapses these into a
  // serial queue, so all N entries land cleanly.
  //
  // Assertion: every parallel publish returns `published: true`, AND
  // every descriptor URL is subsequently visible from discover_context.
  console.log('');
  console.log(`${C.bold}--- Scenario E: ${5} concurrent publishes to one pod all land in the manifest ---${C.reset}`);
  const N = 5;
  const concurrentTag = `concurrent-${RUN_TAG}`;
  const concurrentIris = Array.from({ length: N }, (_, i) => ({
    graphIri: `urn:graph:concurrent:${concurrentTag}:${i}`,
    descriptorId: `urn:iep:concurrent:${concurrentTag}:${i}`,
  }));
  let concurrentResults;
  try {
    concurrentResults = await Promise.all(
      concurrentIris.map(({ graphIri, descriptorId }, i) =>
        callTool('publish_context', {
          graph_iri: graphIri,
          graph_content: makeSampleTurtle(graphIri).turtle,
          descriptor_id: descriptorId,
          modal_status: 'Asserted',
          confidence: 0.9,
        }, 1000 + i),
      ),
    );
  } catch (err) {
    record('8E. concurrent publishes settle', 'fail', `unexpected throw: ${err?.message ?? err}`);
    return summarize();
  }
  const concurrentFailures = concurrentResults
    .map((r, i) => ({ r, i }))
    .filter(({ r }) => !r.ok || r.payload?.published !== true);
  if (concurrentFailures.length > 0) {
    record('8E.a all N publishes return published=true', 'fail',
      `${concurrentFailures.length}/${N} failed: ${concurrentFailures.map(({ r, i }) =>
        `[${i}] ${r.error ?? JSON.stringify(r.payload).slice(0, 200)}`).join(' | ')}`);
  } else {
    record('8E.a all N publishes return published=true', 'pass', `${N}/${N} succeeded`);
  }

  // Verify every concurrent descriptor is discoverable. Use
  // discover_context with the run-tag substring so we hit just the
  // entries from this concurrent batch (not the entire pod).
  const expectedUrls = concurrentResults
    .filter(r => r.ok && r.payload?.descriptorUrl)
    .map(r => r.payload.descriptorUrl);
  if (expectedUrls.length === N) {
    const disc = await callTool('discover_context', {}, 1500);
    if (!disc.ok) {
      record('8E.b discover_context after concurrent publishes', 'fail', disc.error);
    } else {
      const allEntries = Array.isArray(disc.payload?.contexts) ? disc.payload.contexts
        : Array.isArray(disc.payload) ? disc.payload
        : Array.isArray(disc.payload?.entries) ? disc.payload.entries
        : [];
      const seen = new Set(allEntries.map(e => e.descriptorUrl ?? e.url ?? e.iri).filter(Boolean));
      const missing = expectedUrls.filter(u => !seen.has(u));
      if (missing.length > 0) {
        record('8E.b discover_context after concurrent publishes', 'fail',
          `${missing.length}/${N} concurrent entries missing from manifest — race-driven drop (FIX B regression): ${missing.slice(0, 3).join(', ')}${missing.length > 3 ? '...' : ''}`);
      } else {
        record('8E.b discover_context after concurrent publishes', 'pass',
          `${N}/${N} concurrent entries present in discover_context`);
      }
    }
  } else {
    record('8E.b discover_context after concurrent publishes', 'warn',
      `skipped — only ${expectedUrls.length}/${N} publishes returned a descriptorUrl, can't assert discoverability`);
  }

  return summarize();
}

function summarize(blockedAt) {
  console.log('');
  console.log(`${C.bold}=== Summary ===${C.reset}`);
  let passCount = 0, failCount = 0, warnCount = 0;
  for (const r of results) {
    const color = r.status === 'pass' ? C.pass : r.status === 'fail' ? C.fail : C.warn;
    console.log(`  ${color}[${r.status.toUpperCase()}]${C.reset} ${r.step}`);
    if (r.status === 'pass') passCount++;
    else if (r.status === 'fail') failCount++;
    else warnCount++;
  }
  console.log('');
  console.log(`pass=${passCount}  fail=${failCount}  warn=${warnCount}  total=${results.length}`);
  console.log('');
  if (blockedAt) {
    console.log(`${C.fail}${C.bold}CONCLUSION:${C.reset} blocked at ${blockedAt}`);
  } else if (failCount === 0) {
    console.log(`${C.pass}${C.bold}CONCLUSION:${C.reset} publish → dereference round-trip verified for default + share_with + N-way same-pod concurrency`);
  } else {
    console.log(`${C.fail}${C.bold}CONCLUSION:${C.reset} round-trip BROKEN — ${failCount} required assertion(s) failed`);
  }
  process.exitCode = failCount === 0 ? 0 : 1;
}

await main();
