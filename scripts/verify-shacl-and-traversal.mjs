#!/usr/bin/env node
/**
 * scripts/verify-shacl-and-traversal.mjs
 *
 * Two-part live verification against the deployed relay:
 *   (1) shaclMcpSurfaceWorks — fresh OAuth → publish_context with
 *       conforms_to_shapes pointing at a public SHACL shape that the
 *       inbound graph_content violates. Expect a 422-shaped
 *       shape_violation envelope. Then call with a compliant payload
 *       and expect a normal 200/publish-succeeded payload.
 *   (2) reduceTraversalWorks — publish 3 versions of a shared
 *       graph_iri with auto_supersede_prior:true, then call
 *       reduce_chain with traversal:'shortest' and traversal:'full'.
 *       'shortest' chainLength comes back >= 2, 'full' should be >=
 *       'shortest' length (full lineage). headStateCid in 'full'
 *       re-runs deterministically.
 *
 * Reuses the OAuth bootstrap from scripts/test-relay-reduce.mjs.
 */

import { generateKeyPairSync, createHash, randomBytes, sign as nodeSign } from 'node:crypto';

const RELAY = 'https://relay.interego.xwisee.com';
const REDIRECT_URI = 'http://localhost:9999/cb';
const CLIENT_NAME = 'shacl-traversal-verification';

// Public shape we'll reference by IRI. The relay's runConformanceGate
// fetches text/turtle from the IRI, so we host the body on a public
// gist-like surface — simplest path: serve the shape from the relay
// itself by minting a public descriptor that contains the shape, OR
// reference any well-known shape IRI the relay can fetch. We'll mint
// the shape as a published public graph_iri first and use its
// descriptor URL as the shape IRI.
// A minimal SHACL shape we publish into the test pod's context-graphs
// container; the relay then fetches it via the internal service-mesh
// URL when conforms_to_shapes references it. Uses fully-qualified IRIs
// throughout (no @prefix), so when publish_context wraps the content
// inside <graph-iri> { ... } the relay's parseTrig still parses it —
// inline @prefix inside a named-graph block currently breaks the
// parser, so we sidestep it.
const SHAPE_TTL = `
<https://example.org/shapes#NoteShape> a <http://www.w3.org/ns/shacl#NodeShape> ;
    <http://www.w3.org/ns/shacl#targetClass> <https://example.org/shapes#Note> ;
    <http://www.w3.org/ns/shacl#property> [
        <http://www.w3.org/ns/shacl#path> <http://purl.org/dc/terms/title> ;
        <http://www.w3.org/ns/shacl#minCount> 1 ;
        <http://www.w3.org/ns/shacl#datatype> <http://www.w3.org/2001/XMLSchema#string> ;
        <http://www.w3.org/ns/shacl#message> "ex:Note requires at least one dct:title literal."
    ] .
`.trim();

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
    json = JSON.parse(data);
  } else {
    json = JSON.parse(text);
  }
  return { json, raw: text, status: resp.status };
}
async function callTool(relay, token, name, args, id) {
  const r = await rpcCall(relay, token, 'tools/call', { name, arguments: args }, id);
  if (r.json.error) return { ok: false, error: r.json.error, raw: r.raw };
  const text = r.json.result?.content?.[0]?.text;
  if (!text) return { ok: false, error: 'no content.text', raw: r.raw };
  try { return { ok: true, payload: JSON.parse(text) }; }
  catch { return { ok: true, payload: text }; }
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
  const authCode = new URL(verify.redirect).searchParams.get('code');
  const tokenResp = await fetch(`${RELAY}/token`, {
    method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'authorization_code', code: authCode, code_verifier,
      redirect_uri: REDIRECT_URI, client_id: clientId,
    }).toString(),
  }).then(r => r.json());
  await rpcCall(RELAY, tokenResp.access_token, 'initialize', {
    protocolVersion: '2025-03-26', capabilities: {},
    clientInfo: { name: CLIENT_NAME, version: '1.0.0' },
  }, 0);
  return tokenResp.access_token;
}

async function main() {
  console.log('=== SHACL MCP surface + reduce traversal verification ===');
  const token = await oauthBootstrap();
  console.log('[PASS] OAuth token acquired');

  let pass = true;
  const result = { shaclMcpSurfaceWorks: false, reduceTraversalWorks: false };

  const ts = Date.now();

  // ── (0) Publish a clean, parser-safe shape body and reference its
  //         graph URL as a caller-supplied shape IRI. ──
  const shapeGraphIri = `urn:graph:shape:ex:NoteShape:${ts}`;
  const pubShape = await callTool(RELAY, token, 'publish_context', {
    graph_iri: shapeGraphIri,
    graph_content: SHAPE_TTL,
    visibility: 'public',
  }, 100);
  if (!pubShape.ok || pubShape.payload?.error) {
    console.log(`[FAIL] publish shape body: ${JSON.stringify(pubShape.payload ?? pubShape.error)}`);
    process.exit(1);
  }
  const shapeIri = pubShape.payload?.graphUrl ?? pubShape.payload?.payloadUrl;
  if (!shapeIri) {
    console.log(`[FAIL] no shape graph URL: ${JSON.stringify(pubShape.payload).slice(0, 500)}`);
    process.exit(1);
  }
  console.log(`[INFO] shape: ${shapeIri}`);

  // Debug: dereference the shape URL to see what body the relay would
  // hand to validateAgainstShape.
  const deref = await callTool(RELAY, token, 'dereference', { iri: shapeIri }, 99);
  if (deref.ok) {
    const rep = deref.payload?.representation ?? deref.payload;
    const body = typeof rep === 'string' ? rep : JSON.stringify(rep);
    console.log(`[DEBUG] shape body (FULL ${body.length} chars):\n${body}\n[/DEBUG]`);
  }

  // ── (1) Violating payload via caller-supplied shape ──
  // ex:NoteShape (published above) targets ex:Note and requires a
  // dct:title literal. Our violating payload has the rdf:type but no
  // dct:title.
  const violatingGraphIri = `urn:graph:test:note:violating:${ts}`;
  const violatingPayload = `
@prefix ex: <https://example.org/shapes#> .
<urn:note:1> a ex:Note .
`.trim();
  const violatingRes = await callTool(RELAY, token, 'publish_context', {
    graph_iri: violatingGraphIri,
    graph_content: violatingPayload,
    visibility: 'public',
    conforms_to_shapes: [shapeIri],
  }, 101);
  if (!violatingRes.ok) {
    console.log(`[FAIL] violating publish RPC failed: ${JSON.stringify(violatingRes.error)}`);
    pass = false;
  } else {
    const env = violatingRes.payload;
    const is422 = env && (env.error === 'shape_violation' || env.code === 422);
    if (is422) {
      console.log(`[PASS] violating payload returned shape_violation envelope: code=${env.code} shape=${env.shape ?? env.violations?.[0]?.sourceShape ?? '(n/a)'}`);
      console.log(`[INFO] violations[0]: ${JSON.stringify(env.violations?.[0] ?? env).slice(0, 300)}`);
      result.shaclMcpSurfaceWorks = true;
    } else {
      console.log(`[FAIL] violating payload did NOT return 422 shape_violation envelope. Got: ${JSON.stringify(env).slice(0, 500)}`);
      pass = false;
    }
  }

  // ── (1b) Compliant payload via caller-supplied shape ──
  // dct:title present; engine validates clean.
  const compliantGraphIri = `urn:graph:test:note:compliant:${ts}`;
  const compliantPayload = `
@prefix ex: <https://example.org/shapes#> .
@prefix dct: <http://purl.org/dc/terms/> .
<urn:note:1> a ex:Note ; dct:title "Hello world" .
`.trim();
  const compliantRes = await callTool(RELAY, token, 'publish_context', {
    graph_iri: compliantGraphIri,
    graph_content: compliantPayload,
    visibility: 'public',
    conforms_to_shapes: [shapeIri],
  }, 102);
  if (!compliantRes.ok) {
    console.log(`[FAIL] compliant publish RPC failed: ${JSON.stringify(compliantRes.error)}`);
    pass = false;
  } else {
    const env = compliantRes.payload;
    const accepted = env && !env.error && (env.descriptorUrl || env.payloadUrl || env.graphUrl);
    if (accepted) {
      console.log(`[PASS] compliant payload accepted: descriptorUrl=${env.descriptorUrl ?? '(n/a)'}`);
    } else {
      console.log(`[FAIL] compliant payload rejected: ${JSON.stringify(env).slice(0, 500)}`);
      pass = false;
      result.shaclMcpSurfaceWorks = false;
    }
  }

  // ── (2) Publish 3-version chain ──
  const sharedUrn = `urn:graph:traversal-test-${ts}:shared`;
  const v1 = `
@prefix ex: <https://example.org/traversal-test#> .
ex:v ex:value "v1-alpha-${ts}" .
`.trim();
  const v2 = `
@prefix ex: <https://example.org/traversal-test#> .
ex:v ex:value "v2-beta-${ts}" .
`.trim();
  const v3 = `
@prefix ex: <https://example.org/traversal-test#> .
ex:v ex:value "v3-gamma-${ts}" .
`.trim();
  let p1, p2, p3;
  for (const [v, body, id] of [[1, v1, 110], [2, v2, 111], [3, v3, 112]]) {
    const r = await callTool(RELAY, token, 'publish_context', {
      graph_iri: sharedUrn, graph_content: body, visibility: 'public', auto_supersede_prior: true,
    }, id);
    if (!r.ok || r.payload?.error) {
      console.log(`[FAIL] publish v${v}: ${JSON.stringify(r.payload ?? r.error)}`);
      process.exit(1);
    }
    const url = r.payload?.descriptorUrl;
    console.log(`[PASS] publish v${v}: ${url}`);
    if (v === 1) p1 = url;
    if (v === 2) p2 = url;
    if (v === 3) p3 = url;
  }
  const head = p3 ?? p2 ?? p1;

  // ── (2a) traversal: 'shortest' ──
  const reducerTemplate = `# {?prior}\n{?current}`;
  const shortRes = await callTool(RELAY, token, 'reduce_chain', {
    chain_iri: head,
    reducer_spec: { kind: 'turtle-template', template: reducerTemplate },
    traversal: 'shortest',
    max_chain: 16,
    checkpoint_every: 2,
  }, 120);
  if (!shortRes.ok || shortRes.payload?.error) {
    console.log(`[FAIL] reduce_chain shortest: ${JSON.stringify(shortRes.payload ?? shortRes.error)}`);
    pass = false;
  } else {
    const sp = shortRes.payload;
    console.log(`[INFO] shortest: chainLength=${sp.chainLength} headStateCid=${sp.replayProof?.headStateCid}`);
    if (sp.chainLength >= 2 && sp.replayProof?.chainCids?.length === sp.chainLength) {
      console.log(`[PASS] shortest mode: chainLength=${sp.chainLength}`);
    } else {
      console.log(`[FAIL] shortest mode chainLength invariant: chainLength=${sp.chainLength}, chainCids=${sp.replayProof?.chainCids?.length}`);
      pass = false;
    }

    // ── (2b) traversal: 'full' ──
    const fullRes = await callTool(RELAY, token, 'reduce_chain', {
      chain_iri: head,
      reducer_spec: { kind: 'turtle-template', template: reducerTemplate },
      traversal: 'full',
      max_chain: 16,
      checkpoint_every: 2,
    }, 121);
    if (!fullRes.ok || fullRes.payload?.error) {
      console.log(`[FAIL] reduce_chain full: ${JSON.stringify(fullRes.payload ?? fullRes.error)}`);
      pass = false;
    } else {
      const fp = fullRes.payload;
      console.log(`[INFO] full: chainLength=${fp.chainLength} headStateCid=${fp.replayProof?.headStateCid}`);
      // Full mode should yield >= shortest chain length. With
      // auto_supersede_prior writing ALL priors per version, full
      // should equal 3.
      if (fp.chainLength >= sp.chainLength && fp.replayProof?.chainCids?.length === fp.chainLength) {
        console.log(`[PASS] full mode: chainLength=${fp.chainLength} (>= shortest's ${sp.chainLength})`);
        result.reduceTraversalWorks = true;
      } else {
        console.log(`[FAIL] full mode invariant: full chainLength=${fp.chainLength} < shortest=${sp.chainLength}`);
        pass = false;
      }

      // Determinism: re-run full and confirm byte-equal head + CIDs.
      const fullAgainRes = await callTool(RELAY, token, 'reduce_chain', {
        chain_iri: head,
        reducer_spec: { kind: 'turtle-template', template: reducerTemplate },
        traversal: 'full',
        max_chain: 16,
        checkpoint_every: 2,
      }, 122);
      if (fullAgainRes.ok && !fullAgainRes.payload?.error) {
        const fa = fullAgainRes.payload;
        const sameHead = fa.replayProof?.headStateCid === fp.replayProof?.headStateCid;
        const sameCids = JSON.stringify(fa.replayProof?.chainCids) === JSON.stringify(fp.replayProof?.chainCids);
        if (sameHead && sameCids) {
          console.log(`[PASS] full mode re-run: byte-equal headStateCid + chainCids`);
        } else {
          console.log(`[FAIL] full mode re-run not byte-equal: sameHead=${sameHead} sameCids=${sameCids}`);
          pass = false;
          result.reduceTraversalWorks = false;
        }
      }
    }
  }

  console.log('');
  console.log(`shaclMcpSurfaceWorks: ${result.shaclMcpSurfaceWorks}`);
  console.log(`reduceTraversalWorks: ${result.reduceTraversalWorks}`);
  console.log(pass ? '=== VERIFIED ===' : '=== FAILED ===');
  process.exit(pass ? 0 : 1);
}

await main();
