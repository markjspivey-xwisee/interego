/** Two-process proof of a saved cloud-client pairing; the outbound tunnel is simulated. */
import { createHash, randomBytes } from 'node:crypto';
import type { BridgeStatus, StableBridgeView } from './bridge-types.js';
import type { BridgeSmokeOptions } from './bridge-smoke.js';

export interface SavedSmokeClient {
  readonly clientId: string;
  readonly accessToken: string;
  readonly refreshToken: string;
  readonly resource: string;
  readonly connectionId: string;
  readonly noteId: string;
}
export interface StableBridgeSmokeOptions extends BridgeSmokeOptions {
  readonly expectPrevious: boolean;
  saveClient(client: SavedSmokeClient): Promise<void>;
  loadClient(): Promise<SavedSmokeClient>;
}
function insist(value: unknown, message: string): asserts value { if (!value) throw new Error(`Saved web pairing verification failed: ${message}`); }
function row(value: unknown): Record<string, unknown> {
  insist(value && typeof value === 'object' && !Array.isArray(value), 'invalid response'); return value as Record<string, unknown>;
}
async function json(base: string, path: string, value: unknown) {
  return fetch(`${base}${path}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(value), signal: AbortSignal.timeout(30_000) });
}
async function tokens(base: string, values: Record<string, string>) {
  const response = await fetch(`${base}/token`, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(values), signal: AbortSignal.timeout(30_000) });
  insist(response.status === 200, 'OAuth token continuity'); return row(await response.json());
}
let sequence = 1000;
async function mcp(base: string, access: string, method: string, params: Record<string, unknown>) {
  const response = await fetch(`${base}/mcp`, { method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream',
    authorization: `Bearer ${access}`, 'mcp-protocol-version': '2025-11-25' },
    body: JSON.stringify({ jsonrpc: '2.0', id: sequence++, method, params }), signal: AbortSignal.timeout(90_000) });
  return { status: response.status, body: row(await response.json()) };
}
async function pair(options: StableBridgeSmokeOptions, base: string, resource: string): Promise<Omit<SavedSmokeClient, 'noteId'>> {
  const registered = await json(base, '/register', { client_name: 'Persistent packaged cloud client', redirect_uris: ['https://client.example/callback'], token_endpoint_auth_method: 'none' });
  insist(registered.status === 201, 'registration'); const client = row(await registered.json());
  const verifier = randomBytes(32).toString('base64url');
  const query = new URLSearchParams({ client_id: String(client['client_id']), redirect_uri: 'https://client.example/callback', resource,
    response_type: 'code', code_challenge_method: 'S256', code_challenge: createHash('sha256').update(verifier).digest('base64url'), scope: 'notes:read notes:create', state: 'saved-cloud-pairing' });
  const response = await fetch(`${base}/authorize?${query}`, { signal: AbortSignal.timeout(30_000) });
  insist(response.status === 200, 'authorization page'); const html = await response.text();
  const match = /const request=(\{[^;]+\});async function check/.exec(html); insist(match?.[1], 'browser proof');
  const proof = row(JSON.parse(match[1])); const status = await options.invoke<BridgeStatus>('bridgeStatus');
  const approval = status.pendingApprovals.find(item => item.id === proof['id']);
  insist(approval && html.includes(approval.verificationCode), 'native code match'); await options.invoke('approveBridge', approval.id);
  const result = row(await (await json(base, '/approval-status', proof)).json()); const callback = new URL(String(result['redirect']));
  insist(callback.searchParams.get('state') === 'saved-cloud-pairing', 'OAuth state');
  const issued = await tokens(base, { grant_type: 'authorization_code', client_id: String(client['client_id']), redirect_uri: 'https://client.example/callback',
    resource, code: callback.searchParams.get('code')!, code_verifier: verifier });
  const granted = await options.invoke<BridgeStatus>('bridgeStatus'); insist(granted.connections.length === 1, 'one durable grant');
  return { resource, clientId: String(client['client_id']), accessToken: String(issued['access_token']), refreshToken: String(issued['refresh_token']), connectionId: granted.connections[0]!.id };
}

export async function verifyStableBridge(options: StableBridgeSmokeOptions): Promise<void> {
  const origin = 'https://packaged-stable.example'; const resource = `${origin}/mcp`;
  const before = await options.invoke<BridgeStatus>('bridgeStatus'); insist(before.state === 'off', 'off on app launch');
  let previous: SavedSmokeClient | undefined;
  if (options.expectPrevious) {
    previous = await options.loadClient();
    const saved = await options.invoke<StableBridgeView | null>('stableBridgeSettings');
    insist(saved && saved.origin === origin && before.url === previous.resource && before.remembered && !options.loopback(), 'same address retained without a listener');
  } else {
    insist(!before.url && !before.remembered, 'new installation');
    await options.invoke('saveStableBridge', { provider: 'external', origin,
      policy: { client: 'other-web', name: 'Persistent packaged web connection', permissions: ['notes:read', 'notes:create'], expiresInDays: 7 } });
    insist((await options.invoke<BridgeStatus>('bridgeStatus')).state === 'off' && !options.loopback(), 'saving does not enable access');
  }
  const active = await options.invoke<BridgeStatus>('resumeBridge'); const base = options.loopback();
  insist(active.state === 'ready' && active.url === resource && base, 'explicit resume');
  const settings = await options.invoke<StableBridgeView>('stableBridgeSettings'); insist(new URL(base).port === String(settings.port), 'fixed local port');
  const client = previous ?? await pair(options, base, resource);
  const issued = previous ? await tokens(base, { grant_type: 'refresh_token', client_id: previous.clientId, refresh_token: previous.refreshToken, resource }) : undefined;
  const access = issued ? String(issued['access_token']) : client.accessToken;
  const initialized = await mcp(base, access, 'initialize', { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'persistent-packaged-check', version: '1.0.0' } });
  insist(initialized.status === 200 && initialized.body['result'], 'MCP after resume');
  if (previous) {
    const read = row((await mcp(base, access, 'tools/call', { name: 'interego_read_note', arguments: { id: previous.noteId } })).body['result']);
    insist(!read['isError'] && row(row(read['structuredContent'])['note'])['id'] === previous.noteId, 'same grant reads retained note after process restart');
    const status = await options.invoke<BridgeStatus>('bridgeStatus');
    insist(status.connections.length === 1 && status.connections[0]!.id === previous.connectionId && !status.pendingApprovals.length, 'no new pairing or consent required');
    await options.invoke('revokeConnection', previous.connectionId);
    insist((await mcp(base, access, 'tools/list', {})).status === 401, 'durable disconnect');
    const forgotten = await options.invoke<BridgeStatus>('forgetStableBridge');
    insist(forgotten.state === 'off' && !forgotten.url && !forgotten.remembered && !await options.invoke('stableBridgeSettings'), 'forget clears address and authorization');
  } else {
    const saved = row((await mcp(base, access, 'tools/call', { name: 'interego_save_note', arguments: { title: 'Persistent cloud pairing note', body: 'This note and this authorized cloud client survive a complete app process restart.' } })).body['result']);
    insist(!saved['isError'], 'save using permanent pairing'); const note = row(row(saved['structuredContent'])['note']);
    insist(row(note['author'])['connectionId'] === client.connectionId, 'durable connection authorship');
    await options.saveClient({ ...client, noteId: String(note['id']) });
    const paused = await options.invoke<BridgeStatus>('stopBridge');
    insist(paused.state === 'off' && paused.url === resource && paused.remembered && paused.connections.some(item => item.id === client.connectionId && item.state !== 'revoked'), 'pause keeps pairing');
  }
}
