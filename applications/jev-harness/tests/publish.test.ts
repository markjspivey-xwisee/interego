import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { createHash, createPublicKey, randomBytes, verify as edVerify } from 'node:crypto';
import { DidTokenMinter, RelayClient, agentKeyFromJwk, base58btc, generateAgentKeyJwk, lastJsonRpcMessage, publishJudgment, recordTrajectoryStep, signNonce } from '../src/publish.js';
import type { NavigationJudgment } from '../src/judgments/navigate.js';

let server: Server;
let origin: string;
let url: string;
const seen: Array<{ path: string; headers: Record<string, string | string[] | undefined>; body: Record<string, unknown> }> = [];

/** What the fake relay knows: registered clients, pending authorizations, nonces, codes, tokens. */
const relayState = {
  clients: new Set<string>(),
  pending: new Map<string, { clientId: string; challenge: string }>(),
  nonces: new Set<string>(),
  codes: new Map<string, { verifier: string; did: string }>(),
  tokens: new Set<string>(['test-token']),
  revoked: new Set<string>(),
  ttlSec: 3600,
  registrations: 0,
  sessions: new Set<string>(),
  sessionsIssued: 0,
  /** Set to make the fake forget every session it issued, as a restarted or expiring relay does. */
  forgetSessions: false,
};

const B58 = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
function base58decode(s: string): Uint8Array {
  const bytes: number[] = [];
  for (const ch of s) {
    let carry = B58.indexOf(ch);
    if (carry < 0) throw new Error(`not base58: ${ch}`);
    for (let i = 0; i < bytes.length; i += 1) { carry += bytes[i]! * 58; bytes[i] = carry & 0xff; carry >>= 8; }
    while (carry > 0) { bytes.push(carry & 0xff); carry >>= 8; }
  }
  let zeros = 0;
  while (zeros < s.length && s[zeros] === '1') zeros += 1;
  return Uint8Array.from([...new Array<number>(zeros).fill(0), ...bytes.reverse()]);
}

/** The identity server's check, reproduced: Ed25519 over the UTF-8 nonce, key from the multibase. */
function didSignatureValid(did: string, publicKeyMultibase: string, nonce: string, signature: string): boolean {
  if (did !== `did:key:${publicKeyMultibase}` || !publicKeyMultibase.startsWith('z')) return false;
  const decoded = base58decode(publicKeyMultibase.slice(1));
  if (decoded.length !== 34 || decoded[0] !== 0xed || decoded[1] !== 0x01) return false;
  const key = createPublicKey({ key: { kty: 'OKP', crv: 'Ed25519', x: Buffer.from(decoded.subarray(2)).toString('base64url') }, format: 'jwk' });
  return edVerify(null, Buffer.from(nonce, 'utf8'), key, Buffer.from(signature, 'base64url'));
}

beforeAll(async () => {
  server = createServer((req, res) => {
    let raw = '';
    req.on('data', (c: Buffer) => { raw += c.toString(); });
    req.on('end', () => {
      const path = new URL(req.url ?? '/', 'http://x').pathname;
      const isForm = (req.headers['content-type'] ?? '').includes('x-www-form-urlencoded');
      const body: Record<string, unknown> = raw ? (isForm ? Object.fromEntries(new URLSearchParams(raw)) : JSON.parse(raw) as Record<string, unknown>) : {};
      seen.push({ path, headers: req.headers as Record<string, string>, body });
      const reply = (status: number, payload: unknown, headers: Record<string, string> = {}) => {
        res.writeHead(status, { 'Content-Type': 'application/json', ...headers });
        res.end(typeof payload === 'string' ? payload : JSON.stringify(payload));
      };

      // ── the relay's OAuth surface and the identity server's challenge, on one fake ──
      if (path === '/register') {
        const id = `client-${++relayState.registrations}`;
        relayState.clients.add(id);
        reply(201, { client_id: id, client_name: body['client_name'] });
        return;
      }
      if (path === '/authorize') {
        const q = new URL(req.url ?? '/', 'http://x').searchParams;
        const clientId = q.get('client_id') ?? '';
        if (!relayState.clients.has(clientId)) { reply(400, { error: 'invalid_client' }); return; }
        const pendingId = `pend-${randomBytes(4).toString('hex')}`;
        relayState.pending.set(pendingId, { clientId, challenge: q.get('code_challenge') ?? '' });
        res.writeHead(200, { 'Content-Type': 'text/html' });
        res.end(`<html><script>const PENDING_ID = "${pendingId}"; const IDENTITY = "${origin}";</script></html>`);
        return;
      }
      if (path === '/challenges') {
        if (body['purpose'] !== 'did-sig') { reply(400, { error: 'purpose' }); return; }
        const nonce = `nonce-${randomBytes(8).toString('hex')}`;
        relayState.nonces.add(nonce);
        reply(200, { nonce });
        return;
      }
      if (path === '/oauth/verify') {
        const pending = relayState.pending.get(body['pending_id'] as string);
        const nonce = body['nonce'] as string;
        if (!pending || body['method'] !== 'did' || !relayState.nonces.delete(nonce)) { reply(401, { error: 'invalid pending or nonce' }); return; }
        if (!didSignatureValid(body['did'] as string, body['publicKeyMultibase'] as string, nonce, body['signature'] as string)) { reply(401, { error: 'bad signature' }); return; }
        const code = `code-${randomBytes(6).toString('hex')}`;
        relayState.codes.set(code, { verifier: pending.challenge, did: body['did'] as string });
        reply(200, { redirect: `http://localhost:9999/cb?code=${code}&state=s` });
        return;
      }
      if (path === '/token') {
        const c = relayState.codes.get(body['code'] as string);
        if (!c || body['grant_type'] !== 'authorization_code') { reply(400, { error: 'invalid_grant' }); return; }
        const expected = createHash('sha256').update(body['code_verifier'] as string).digest('base64url');
        if (expected !== c.verifier) { reply(400, { error: 'pkce mismatch' }); return; }
        relayState.codes.delete(body['code'] as string);
        const token = `minted-${randomBytes(6).toString('hex')}`;
        relayState.tokens.add(token);
        reply(200, { access_token: token, token_type: 'Bearer', expires_in: relayState.ttlSec });
        return;
      }

      // ── the MCP surface ──
      const auth = req.headers.authorization ?? '';
      const presented = auth.startsWith('Bearer ') ? auth.slice(7) : '';
      if (!relayState.tokens.has(presented) || relayState.revoked.has(presented)) { reply(401, { error: 'invalid_token' }); return; }
      if (body['method'] === 'initialize') {
        const session = `sess-${presented.slice(-4)}-${++relayState.sessionsIssued}`;
        relayState.sessions.add(session);
        reply(200, { jsonrpc: '2.0', id: body['id'], result: { protocolVersion: '2025-06-18', capabilities: {}, serverInfo: { name: 'fake-relay' } } }, { 'Mcp-Session-Id': session });
        return;
      }
      if (relayState.forgetSessions) { relayState.sessions.clear(); relayState.forgetSessions = false; }
      const sessionHeader = String(req.headers['mcp-session-id'] ?? '');
      if (sessionHeader && !relayState.sessions.has(sessionHeader)) { reply(404, { error: 'MCP session not found; initialize a new session' }); return; }
      if (body['method'] === 'notifications/initialized') { res.writeHead(202); res.end(); return; }
      if (body['method'] === 'tools/call') {
        const params = body['params'] as { name: string; arguments: Record<string, unknown> };
        const result = params.name === 'publish_context'
          ? { descriptorUrl: 'https://pod.example/u/context-graphs/1.ttl', graphUrl: 'https://pod.example/u/context-graphs/1-graph.trig', previousHeadCid: 'bafy1' }
          : { ok: true, stepId: 'urn:iep:trajectory-step:x:1' };
        res.writeHead(200, { 'Content-Type': 'text/event-stream' });
        res.end(`event: message\ndata: ${JSON.stringify({ jsonrpc: '2.0', id: body['id'], result: { content: [{ type: 'text', text: JSON.stringify(result) }] } })}\n\n`);
        return;
      }
      res.writeHead(400); res.end();
    });
  });
  await new Promise<void>((resolve) => { server.listen(0, '127.0.0.1', () => resolve()); });
  origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  url = `${origin}/mcp`;
});

afterAll(() => { server.close(); });

const judgment: NavigationJudgment = {
  kind: 'navigation', id: 'p1', graphIri: 'urn:graph:jev-harness:navigation:p1', createdAt: '2026-09-19T00:00:00.000Z', model: 'jev-1.13.0', confidence: 0.77,
  repository: { name: 'r', root: '/r', commit: null }, usage: { requests: 1, input_tokens: 1, output_tokens: 0, latencyMs: 1 },
  task: 't', files: [], tests: [], docs: [], covered: 0, noTestProbability: 1, advice: 'widen-search', passes: [], filesConsidered: 0,
};

const toolCalls = (from: number, name?: string) => seen.slice(from).filter((s) => s.body['method'] === 'tools/call' && (!name || (s.body['params'] as { name: string }).name === name));

describe('relay publishing over MCP streamable HTTP', () => {
  it('initializes, keeps the session id, and publishes the payload graph with the judgment\'s modal status and confidence', async () => {
    const relay = new RelayClient({ url, bearer: 'test-token' });
    const receipt = await publishJudgment(relay, judgment, '<urn:jev-harness:navigation:p1> <urn:p> "x" .\n');
    expect(receipt.descriptorUrl).toBe('https://pod.example/u/context-graphs/1.ttl');
    expect(receipt.previousHeadCid).toBe('bafy1');
    const call = seen.find((s) => (s.body['method'] === 'tools/call'))!;
    expect(String(call.headers['mcp-session-id'])).toMatch(/^sess-oken-\d+$/);
    const args = (call.body['params'] as { arguments: Record<string, unknown> }).arguments;
    expect(args['graph_iri']).toBe(judgment.graphIri);
    expect(args['modal_status']).toBe('Hypothetical');
    expect(args['confidence']).toBe(0.77);
    expect(args['visibility']).toBe('shared');
    expect(args['pod_name']).toBeUndefined();
    const step = await recordTrajectoryStep(relay, { verb: 'navigated', objectName: 't', resultQuality: 0.77 });
    expect(step.structured).toMatchObject({ ok: true });
  });

  it('publishes an outcome as the next version of the judgment\'s own graph with a CAS precondition', async () => {
    const relay = new RelayClient({ url, bearer: 'test-token' });
    const before = seen.length;
    await publishJudgment(relay, { ...judgment, kind: 'outcome', id: 'o1', graphIri: 'urn:graph:jev-harness:outcome:o1', confidence: 1 } as unknown as typeof judgment, '', {
      graphIri: judgment.graphIri, ifMatch: 'https://pod.example/u/context-graphs/1.ttl',
    });
    const args = (toolCalls(before)[0]!.body['params'] as { arguments: Record<string, unknown> }).arguments;
    expect(args['graph_iri']).toBe(judgment.graphIri);
    expect(args['modal_status']).toBe('Asserted');
    expect(args['if_match']).toBe('https://pod.example/u/context-graphs/1.ttl');
  });

  it('names the pod a delegate publishes to', async () => {
    const relay = new RelayClient({ url, bearer: 'test-token', podName: 'u-pk-owner' });
    const before = seen.length;
    await publishJudgment(relay, judgment, '');
    const args = (toolCalls(before)[0]!.body['params'] as { arguments: Record<string, unknown> }).arguments;
    expect(args['pod_name']).toBe('u-pk-owner');
  });

  it('rejects a bad token loudly', async () => {
    const relay = new RelayClient({ url, bearer: 'wrong' });
    await expect(publishJudgment(relay, judgment, '')).rejects.toThrow(/401/);
  });

  it('extracts the matching JSON-RPC response from an SSE body', () => {
    const sse = 'event: message\ndata: {"jsonrpc":"2.0","id":1,"result":{"a":1}}\n\nevent: message\ndata: {"jsonrpc":"2.0","id":2,"result":{"b":2}}\n\n';
    expect(lastJsonRpcMessage(sse, 2)).toMatchObject({ id: 2 });
    expect(() => lastJsonRpcMessage(sse, 3)).toThrow();
  });
});

describe('the agent key and its did:key', () => {
  it('encodes base58btc as the did:key method does', () => {
    expect(base58btc(Buffer.from('hello', 'utf8'))).toBe('Cn8eVZg');
    expect(base58btc(Uint8Array.from([0, 0, 1]))).toBe('112');
    expect(base58btc(Uint8Array.from([]))).toBe('');
    const bytes = randomBytes(34);
    expect(Buffer.from(base58decode(base58btc(bytes)))).toEqual(bytes);
  });

  it('derives a did:key that starts with the Ed25519 multicodec prefix and signs a nonce the identity check accepts', () => {
    const jwk = generateAgentKeyJwk();
    const key = agentKeyFromJwk(JSON.stringify(jwk));
    expect(key.did.startsWith('did:key:z6Mk')).toBe(true);
    expect(key.publicKeyRaw).toHaveLength(32);
    const nonce = 'nonce-abc';
    expect(didSignatureValid(key.did, key.publicKeyMultibase, nonce, signNonce(key, nonce))).toBe(true);
    expect(didSignatureValid(key.did, key.publicKeyMultibase, 'other', signNonce(key, nonce))).toBe(false);
  });

  it('refuses a key that is not an Ed25519 OKP JWK with both halves', () => {
    expect(() => agentKeyFromJwk({ kty: 'OKP', crv: 'Ed25519', x: 'abc' })).toThrow(/x and d/);
    expect(() => agentKeyFromJwk('{"kty":"EC"}')).toThrow(/Ed25519/);
  });
});

describe('minting relay tokens from the agent key', () => {
  it('walks registration, PKCE, the did-sig challenge and the code exchange, then reuses the token until it nears expiry', async () => {
    let now = 1_000_000;
    const key = agentKeyFromJwk(generateAgentKeyJwk());
    const minter = new DidTokenMinter({ relayOrigin: origin, key, clientName: 'jev-harness-test', now: () => now });
    const relay = new RelayClient({ url, bearer: minter, podName: 'u-pk-owner' });
    const before = seen.length;
    await publishJudgment(relay, judgment, '');
    await recordTrajectoryStep(relay, { verb: 'x', objectName: 'y' });
    expect(minter.mints).toHaveLength(1);
    const paths = seen.slice(before).map((s) => s.path);
    expect(paths.slice(0, 5)).toEqual(['/register', '/authorize', '/challenges', '/oauth/verify', '/token']);
    const first = toolCalls(before, 'publish_context')[0]!;
    expect(String(first.headers['authorization'])).toMatch(/^Bearer minted-/);
    expect((first.body['params'] as { arguments: Record<string, unknown> }).arguments['agent_did']).toBe(key.did);
    // Two calls, one token: the minter cached it.
    expect(toolCalls(before).every((c) => c.headers['authorization'] === first.headers['authorization'])).toBe(true);

    // Within five minutes of expiry it mints again, without registering the client again.
    now += (3600 - 200) * 1000;
    const later = seen.length;
    await recordTrajectoryStep(relay, { verb: 'x', objectName: 'z' });
    expect(minter.mints).toHaveLength(2);
    expect(seen.slice(later).map((s) => s.path)).not.toContain('/register');
    expect(toolCalls(later)[0]!.headers['authorization']).not.toBe(first.headers['authorization']);
  });

  it('mints again and retries once when the relay answers 401 mid-session', async () => {
    const key = agentKeyFromJwk(generateAgentKeyJwk());
    const minter = new DidTokenMinter({ relayOrigin: origin, key });
    const relay = new RelayClient({ url, bearer: minter });
    await recordTrajectoryStep(relay, { verb: 'a', objectName: 'b' });
    const firstToken = await minter.token();
    relayState.revoked.add(firstToken);
    const before = seen.length;
    const r = await recordTrajectoryStep(relay, { verb: 'c', objectName: 'd' });
    expect(r.structured).toMatchObject({ ok: true });
    expect(minter.mints).toHaveLength(2);
    const calls = toolCalls(before);
    expect(calls[calls.length - 1]!.headers['authorization']).not.toBe(`Bearer ${firstToken}`);
  });

  it('opens a new session and retries once when the relay has forgotten the session', async () => {
    const relay = new RelayClient({ url, bearer: 'test-token' });
    await recordTrajectoryStep(relay, { verb: 'a', objectName: 'b' });
    relayState.forgetSessions = true;
    const before = seen.length;
    const r = await recordTrajectoryStep(relay, { verb: 'c', objectName: 'd' });
    expect(r.structured).toMatchObject({ ok: true });
    const methods = seen.slice(before).map((s) => s.body['method']);
    expect(methods).toEqual(['tools/call', 'initialize', 'notifications/initialized', 'tools/call']);
    relayState.forgetSessions = false;
  });

  it('reports a failed step of the flow by name', async () => {
    const key = agentKeyFromJwk(generateAgentKeyJwk());
    const minter = new DidTokenMinter({ relayOrigin: `${origin}/nowhere`, key });
    await expect(minter.token()).rejects.toThrow(/relay \/register responded 4\d\d/);
  });
});
