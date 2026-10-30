/** Offline packaged exercise: real local HTTP and OAuth, simulated tunnel only. */
import { createHash, randomBytes } from 'node:crypto';
import type { BridgeStatus } from './bridge-types.js';
import type { LocalNote } from './types.js';

export interface BridgeSmokeOptions {
  invoke<T>(method: string, argument?: unknown): Promise<T>;
  loopback(): string | undefined;
}
function insist(value: unknown, message: string): asserts value {
  if (!value) throw new Error(`Packaged web connection verification failed: ${message}`);
}
function object(value: unknown): Record<string, unknown> {
  insist(value && typeof value === 'object' && !Array.isArray(value), 'invalid response');
  return value as Record<string, unknown>;
}

export async function verifyWebBridge(options: BridgeSmokeOptions): Promise<void> {
  const status = await options.invoke<BridgeStatus>('startBridge', {
    client: 'other-web', name: 'Packaged web connection verification', permissions: ['notes:read', 'notes:create'], expiresInDays: 7,
  });
  insist(status.state === 'ready' && status.url, 'explicit startup');
  const base = options.loopback(); insist(base?.startsWith('http://127.0.0.1:'), 'isolated listener');
  const resource = status.url;
  try {
    const json = async (path: string, value: unknown) => fetch(`${base}${path}`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(value), signal: AbortSignal.timeout(30_000),
    });
    const unauthenticated = await json('/mcp', { jsonrpc: '2.0', id: 1, method: 'tools/list' });
    insist(unauthenticated.status === 401 && unauthenticated.headers.has('www-authenticate'), 'OAuth required');
    const registration = await json('/register', { client_name: 'Packaged remote MCP client', redirect_uris: ['https://client.example/callback'], token_endpoint_auth_method: 'none' });
    insist(registration.status === 201, 'client registration');
    const client = object(await registration.json());
    const verifier = randomBytes(32).toString('base64url');
    const authorize = new URLSearchParams({ response_type: 'code', client_id: String(client['client_id']), redirect_uri: 'https://client.example/callback',
      resource, scope: 'notes:read notes:create', state: 'packaged-verification', code_challenge_method: 'S256', code_challenge: createHash('sha256').update(verifier).digest('base64url') });
    const browser = await fetch(`${base}/authorize?${authorize}`, { signal: AbortSignal.timeout(30_000) });
    insist(browser.status === 200, 'browser consent page');
    const html = await browser.text();
    const request = /const request=(\{[^;]+\});async function check/.exec(html);
    insist(request?.[1], 'browser polling proof');
    const proof = object(JSON.parse(request[1]));
    const pending = await options.invoke<BridgeStatus>('bridgeStatus');
    const approval = pending.pendingApprovals.find(row => row.id === proof['id']);
    insist(approval && html.includes(approval.verificationCode), 'matching native verification code');
    await options.invoke('approveBridge', approval.id);
    const poll = await json('/approval-status', proof); const redirect = object(await poll.json());
    const callback = new URL(String(redirect['redirect']));
    insist(callback.searchParams.get('state') === 'packaged-verification' && callback.searchParams.get('code'), 'approved callback');
    const tokenReply = await fetch(`${base}/token`, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ grant_type: 'authorization_code', client_id: String(client['client_id']), redirect_uri: 'https://client.example/callback',
        code: callback.searchParams.get('code')!, code_verifier: verifier, resource }), signal: AbortSignal.timeout(30_000) });
    insist(tokenReply.status === 200, 'PKCE token exchange');
    const token = object(await tokenReply.json()); let id = 10;
    const mcp = async (method: string, params: Record<string, unknown>) => {
      const response = await fetch(`${base}/mcp`, { method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream',
        authorization: `Bearer ${String(token['access_token'])}`, 'mcp-protocol-version': '2025-11-25' },
        body: JSON.stringify({ jsonrpc: '2.0', id: id++, method, params }), signal: AbortSignal.timeout(90_000) });
      insist(!response.headers.get('content-type')?.includes('text/event-stream'), 'JSON-only transport');
      return { response, body: object(await response.json()) };
    };
    const initialized = await mcp('initialize', { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'packaged-web-check', version: '1.0.0' } });
    insist(initialized.response.ok && initialized.body['result'], 'MCP initialize');
    const tools = object((await mcp('tools/list', {})).body['result']);
    insist(Array.isArray(tools['tools']) && tools['tools'].length === 4, 'scoped tools');
    const result = object((await mcp('tools/call', { name: 'interego_save_note', arguments: { title: 'Packaged web bridge note', body: 'Saved through OAuth and the packaged HTTP MCP adapter.' } })).body['result']);
    insist(!result['isError'], 'web save');
    const saved = object(object(result['structuredContent'])['note']);
    const granted = await options.invoke<BridgeStatus>('bridgeStatus');
    const grant = granted.connections[0];
    insist(grant && object(saved['author'])['connectionId'] === grant.id, 'authenticated authorship');
    const notes = await options.invoke<readonly LocalNote[]>('notes');
    insist(notes.some(note => note.id === saved['id'] && note.author?.connectionId === grant.id), 'real encrypted local storage');
    await options.invoke('revokeConnection', grant.id);
    insist((await mcp('tools/list', {})).response.status === 401, 'revocation');
    const stopped = await options.invoke<BridgeStatus>('stopBridge');
    insist(stopped.state === 'off' && !stopped.url && !stopped.pendingApprovals.length, 'disabled after stop');
  } finally { await options.invoke('stopBridge'); }
}
