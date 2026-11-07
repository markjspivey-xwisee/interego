/** Scoped notes projection over the installed pod's authenticated MCP bridge.
 * This grants note access; it does not establish a website login or human identity.
 */
import { normalizeRelay, requestJson, unpack, validate } from './relay.mjs';

const VERSION = '2025-11-25';
const TOOL_NAMES = new Set(['interego_status', 'interego_search_notes', 'interego_read_note', 'interego_save_note']);
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const PREFIX = 'urn:graph:pod-note:';
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);

export function localScope(scope) {
  if (scope === 'mcp:read') return 'notes:read';
  if (scope === 'mcp:write') return 'notes:read notes:create';
  throw new Error('Choose read access or read and save access.');
}

async function rpc(relay, token, method, params, { fetchImpl } = {}) {
  relay = normalizeRelay(relay);
  if (typeof token !== 'string' || !token || /[\r\n]/.test(token)) throw new Error('Connect to your local pod first.');
  const id = globalThis.crypto.randomUUID();
  const raw = await requestJson(`${relay}/mcp`, { method: 'POST', headers: { Authorization: `Bearer ${token}`,
    'Content-Type': 'application/json', Accept: 'application/json, text/event-stream', 'MCP-Protocol-Version': VERSION },
    body: JSON.stringify({ jsonrpc: '2.0', id, method, params }) }, { fetchImpl });
  if (!object(raw) || raw.jsonrpc !== '2.0' || raw.id !== id || raw.error || !object(raw.result)) throw new Error('The local pod returned an invalid MCP response.');
  return raw.result;
}

export async function discoverLocalCatalog(relay, token, options = {}) {
  relay = normalizeRelay(relay);
  const init = await rpc(relay, token, 'initialize', { protocolVersion: VERSION, capabilities: {}, clientInfo: { name: 'interego-browser-wallet', version: '0.2.0' } }, options);
  if (init.protocolVersion !== VERSION || !object(init.capabilities?.tools) || init.serverInfo?.name !== 'interego-local-pod-bridge') throw new Error('This address did not identify the Interego local notes bridge.');
  const listing = await rpc(relay, token, 'tools/list', {}, options);
  if (!Array.isArray(listing.tools) || listing.tools.length > 64 || listing.nextCursor) throw new Error('The local pod returned an unsupported tool catalog.');
  const tools = Object.create(null);
  for (const row of listing.tools) {
    if (!object(row) || !TOOL_NAMES.has(row.name)) continue;
    if (Object.hasOwn(tools, row.name) || !object(row.inputSchema) || row.inputSchema.type !== 'object') throw new Error('The local tool contract is invalid.');
    tools[row.name] = { name: row.name, inputSchema: row.inputSchema };
  }
  if (!tools.interego_status || !tools.interego_search_notes || !tools.interego_read_note) throw new Error('This connection needs permission to read local notes.');
  return { relay, mode: 'local', tools };
}

function note(raw, full = false) {
  if (!object(raw) || typeof raw.id !== 'string' || !UUID.test(raw.id) || typeof raw.title !== 'string' || raw.title.length > 160
    || typeof raw.createdAt !== 'string' || !Number.isFinite(Date.parse(raw.createdAt))
    || typeof raw.updatedAt !== 'string' || !Number.isFinite(Date.parse(raw.updatedAt))
    || (full && (typeof raw.body !== 'string' || raw.body.length > 50_000))) throw new Error('The local pod returned an unfamiliar note.');
  return raw;
}

export function localProfile(status, relay) {
  const grant = status?.connection;
  if (status?.storageLocal !== true || status?.remoteBridge !== true || typeof status?.running !== 'boolean'
    || !object(grant) || typeof grant.id !== 'string' || !UUID.test(grant.id)
    || typeof grant.name !== 'string' || grant.name.length > 80 || !['waiting', 'active'].includes(grant.state)
    || !Array.isArray(grant.permissions) || !grant.permissions.includes('notes:read')
    || grant.permissions.some(item => !['notes:read', 'notes:create'].includes(item))) throw new Error('The local pod connection could not be confirmed.');
  // Grant identity is explicitly a connection, never a DID or verified human identity.
  return { id: `${relay}|local:${grant.id}`, relay, mode: 'local', principal: `Local connection: ${grant.name} (${grant.id})`, podUrl: `${relay}/mcp` };
}

/** Translate only the wallet's four admitted operations. No raw URL fetch or generic act. */
export async function callLocalTool(relay, token, catalog, name, args = {}, options = {}) {
  relay = normalizeRelay(relay);
  if (catalog?.mode !== 'local' || catalog.relay !== relay || !object(args)) throw new Error('Reconnect to refresh your local pod contract.');
  async function invoke(toolName, input) {
    const tool = catalog.tools?.[toolName];
    if (!TOOL_NAMES.has(toolName) || tool?.name !== toolName) throw new Error('This local connection does not permit that operation.');
    validate(input, tool.inputSchema);
    return unpack(await rpc(relay, token, 'tools/call', { name: toolName, arguments: input }, options));
  }
  if (name === 'get_pod_status') return invoke('interego_status', {});
  if (name === 'discover_context') {
    if (args.pod_url !== `${relay}/mcp` || !Number.isInteger(args.limit) || args.limit < 1 || args.limit > 50) throw new Error('The requested local destination is invalid.');
    const result = await invoke('interego_search_notes', { query: '', limit: args.limit });
    if (!Array.isArray(result.notes) || result.notes.length > args.limit) throw new Error('The local pod returned an invalid note list.');
    return { pod: `${relay}/mcp`, entries: result.notes.map(raw => { const row = note(raw); return { descriptorUrl: PREFIX + row.id, describes: [PREFIX + row.id], title: row.title, validFrom: row.createdAt, kind: 'local-note' }; }) };
  }
  if (name === 'get_descriptor') {
    if (typeof args.url !== 'string' || !args.url.startsWith(PREFIX) || !UUID.test(args.url.slice(PREFIX.length))) throw new Error('Choose a note from the local list.');
    const row = note((await invoke('interego_read_note', { id: args.url.slice(PREFIX.length) })).note, true);
    if (PREFIX + row.id !== args.url) throw new Error('The local pod returned a different note.');
    return { url: args.url, graph: { content: row.body, mediaType: 'text/plain', encrypted: true }, title: row.title, kind: 'local-note' };
  }
  if (name === 'remember') {
    if (args.visibility !== 'private' || Object.keys(args).some(key => !['title', 'body', 'visibility'].includes(key))) throw new Error('Only reviewed private local notes can be saved.');
    const row = note((await invoke('interego_save_note', { title: args.title, body: args.body })).note, true);
    if (row.title !== args.title || row.body !== args.body) throw new Error('The local pod did not confirm the reviewed note. Inspect it before saving again.');
    return { remembered: true, visibility: 'private', descriptorUrl: PREFIX + row.id };
  }
  throw new Error('This wallet does not admit that local operation.');
}

/** Refresh authority remains in browser-session storage and rotates once per request. */
export async function refreshLocalSession(session, { fetchImpl, now = Date.now } = {}) {
  const relay = normalizeRelay(session.relay);
  let endpoint;
  try { endpoint = new URL(session.tokenEndpoint); } catch { throw new Error('Reconnect your local pod.'); }
  if (endpoint.origin !== relay || endpoint.username || endpoint.password || endpoint.search || endpoint.hash
    || !/^[A-Za-z0-9_-]{43}$/.test(session.refreshToken ?? '') || typeof session.clientId !== 'string'
    || !['notes:read', 'notes:read notes:create'].includes(session.scope)) throw new Error('Reconnect your local pod.');
  const tokens = await requestJson(endpoint.href, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
    body: new URLSearchParams({ grant_type: 'refresh_token', refresh_token: session.refreshToken, client_id: session.clientId, resource: `${relay}/mcp`, scope: session.scope }).toString() }, { fetchImpl });
  if (typeof tokens?.access_token !== 'string' || !tokens.access_token || /[\r\n]/.test(tokens.access_token)
    || tokens.token_type?.toLowerCase() !== 'bearer' || tokens.scope !== session.scope
    || !/^[A-Za-z0-9_-]{43}$/.test(tokens.refresh_token ?? '') || tokens.refresh_token === session.refreshToken
    || !Number.isFinite(tokens.expires_in) || tokens.expires_in <= 0 || tokens.expires_in > 86_400) throw new Error('Reconnect your local pod.');
  return { ...session, accessToken: tokens.access_token, refreshToken: tokens.refresh_token, expiresAt: now() + tokens.expires_in * 1000 };
}

/** Forget locally even when offline; this single bounded request revokes the
 * current OAuth family when the local bridge is reachable. It never retries.
 */
export async function revokeLocalSession(session, { fetchImpl } = {}) {
  const relay = normalizeRelay(session.relay);
  if (!/^[A-Za-z0-9_-]{43}$/.test(session.refreshToken ?? '') || typeof session.clientId !== 'string' || !session.clientId) throw new Error('The local session cannot be revoked here.');
  await requestJson(`${relay}/revoke`, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
    body: new URLSearchParams({ token: session.refreshToken, token_type_hint: 'refresh_token', client_id: session.clientId }).toString() }, { fetchImpl, timeoutMs: 4000 });
}
