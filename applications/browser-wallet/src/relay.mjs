/** Small, bounded HTTP client following the relay's live tool affordances. */
const ALLOWED = new Set(['get_pod_status', 'discover_context', 'get_descriptor', 'remember']);
const MAX_RESPONSE_BYTES = 2 * 1024 * 1024;
const TIMEOUT_MS = 15_000;
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);

export function normalizeRelay(input) {
  let url;
  try { url = new URL(input); } catch { throw new Error('Enter a valid HTTPS relay address.'); }
  if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash
    || !['/', '/mcp', '/mcp/'].includes(url.pathname)) {
    throw new Error('Use an HTTPS relay origin or its /mcp address, without credentials or query parameters.');
  }
  return url.origin;
}

/** All network requests omit cookies and reject redirects, including authenticated ones. */
export async function requestJson(url, init = {}, { fetchImpl = globalThis.fetch, maxBytes = MAX_RESPONSE_BYTES, timeoutMs = TIMEOUT_MS } = {}) {
  const controller = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => { timedOut = true; controller.abort(); }, timeoutMs);
  try {
    const response = await fetchImpl(url, { ...init, credentials: 'omit', redirect: 'error', cache: 'no-store', signal: controller.signal });
    if (response.redirected) throw new Error('A relay redirect was refused.');
    if (!response.ok) throw new Error(`The relay refused the request (HTTP ${response.status}).`);
    if (Number(response.headers.get('content-length')) > maxBytes) throw new Error('The relay response exceeded the size limit.');
    const kind = response.headers.get('content-type');
    if (kind && !/\b(?:application\/(?:[\w.-]+\+)?json)\b/i.test(kind)) throw new Error('The relay did not return JSON.');
    let body = '';
    if (response.body?.getReader) {
      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let bytes = 0;
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        bytes += value.byteLength;
        if (bytes > maxBytes) {
          controller.abort();
          void reader.cancel().catch(() => {});
          throw new Error('The relay response exceeded the size limit.');
        }
        body += decoder.decode(value, { stream: true });
      }
      body += decoder.decode();
    } else {
      body = await response.text();
      if (new TextEncoder().encode(body).byteLength > maxBytes) throw new Error('The relay response exceeded the size limit.');
    }
    try { return JSON.parse(body); } catch { throw new Error('The relay returned malformed JSON.'); }
  } catch (error) {
    if (timedOut) throw new Error('The relay request timed out.');
    throw error;
  } finally {
    clearTimeout(timer);
    // Also terminate an unconsumed response rejected from its headers. Leaving it
    // downloading after an oversized Content-Length would defeat the byte limit.
    controller.abort();
  }
}

/** Peel the relay's REST, MCP and HTTP-envelope forms without hiding a refusal. */
export function unpack(raw) {
  let value = raw;
  for (let depth = 0; depth < 5; depth += 1) {
    if (typeof value === 'string') {
      try { value = JSON.parse(value); } catch { throw new Error('The relay tool returned malformed JSON.'); }
      continue;
    }
    if (!object(value)) throw new Error('The relay tool returned an invalid result.');
    if (value.isError || value.error || (typeof value.status === 'number' && value.status >= 400)
      || value['iep:refusalReason']) throw new Error('Interego refused this operation.');
    if (object(value.result)) { value = value.result; continue; }
    if (value.structuredContent !== undefined) { value = value.structuredContent; continue; }
    if (Array.isArray(value.content)) {
      const text = value.content.find(item => item?.type === 'text' && typeof item.text === 'string');
      if (!text) throw new Error('The relay tool returned no readable result.');
      value = text.text; continue;
    }
    if (typeof value.body === 'string' && typeof value.status === 'number') { value = value.body; continue; }
    return value;
  }
  throw new Error('The relay tool returned too many nested envelopes.');
}

function safeTarget(raw, relay) {
  let url;
  try { url = new URL(raw); } catch { throw new Error('The catalog advertised an invalid tool target.'); }
  if (url.origin !== relay || url.username || url.password || url.search || url.hash) throw new Error('The catalog advertised an unsafe tool target.');
  return url.href;
}

export async function discoverCatalog(relay, { fetchImpl } = {}) {
  relay = normalizeRelay(relay);
  const document = await requestJson(`${relay}/tools`, { headers: { Accept: 'application/ld+json, application/json' } }, { fetchImpl });
  if (!object(document) || !Array.isArray(document['hydra:member'])) throw new Error('The relay did not publish a tool catalog.');
  const tools = Object.create(null);
  for (const item of document['hydra:member']) {
    if (!object(item) || !ALLOWED.has(item.name)) continue;
    if (Object.hasOwn(tools, item.name)) throw new Error('The relay catalog contains duplicate tool names.');
    if (!object(item.inputSchema) || item.inputSchema.type !== 'object') throw new Error(`The ${item.name} input schema is unavailable.`);
    const action = `urn:iep:action:invoke:${item.name}`;
    const matches = Array.isArray(item.affordances) ? item.affordances.filter(a => a?.action === action && a.method === 'POST') : [];
    if (matches.length !== 1) throw new Error(`The ${item.name} invocation affordance is unavailable.`);
    tools[item.name] = { name: item.name, inputSchema: item.inputSchema, target: safeTarget(matches[0].target, relay), action, method: 'POST' };
  }
  return { relay, tools };
}

// The four admitted tools currently publish simple object schemas. Validate those
// live constraints; an unfamiliar validation vocabulary fails closed for a new contract.
export function validate(value, schema, path = 'arguments', depth = 0) {
  if (depth > 12 || !object(schema)) throw new Error('The tool schema cannot be validated.');
  const supported = new Set(['type', 'properties', 'required', 'additionalProperties', 'description', 'title', 'default', 'examples', 'enum', 'const', 'items', 'minItems', 'maxItems', 'minLength', 'maxLength', 'pattern', 'minimum', 'maximum', 'format', '$schema', '$id', 'deprecated']);
  for (const key of Object.keys(schema)) if (!supported.has(key)) throw new Error(`The tool schema uses an unsupported constraint: ${key}.`);
  if (schema.enum && !schema.enum.some(item => JSON.stringify(item) === JSON.stringify(value))) throw new Error(`${path} is outside the tool's allowed values.`);
  if (Object.hasOwn(schema, 'const') && JSON.stringify(schema.const) !== JSON.stringify(value)) throw new Error(`${path} does not match the tool schema.`);
  const types = Array.isArray(schema.type) ? schema.type : schema.type ? [schema.type] : [];
  const hasType = type => type === 'object' ? object(value) : type === 'array' ? Array.isArray(value) : type === 'null' ? value === null : type === 'integer' ? Number.isInteger(value) : type === 'number' ? typeof value === 'number' && Number.isFinite(value) : typeof value === type;
  if (types.length && !types.some(hasType)) throw new Error(`${path} has the wrong type for this tool.`);
  if (object(value)) {
    for (const key of schema.required ?? []) if (!Object.hasOwn(value, key)) throw new Error(`${path}.${key} is required.`);
    for (const [key, item] of Object.entries(value)) {
      if (key.startsWith('_') || ['__proto__', 'constructor', 'prototype'].includes(key)) throw new Error('Reserved tool arguments are refused.');
      if (Object.hasOwn(schema.properties ?? {}, key)) validate(item, schema.properties[key], `${path}.${key}`, depth + 1);
      else if (object(schema.additionalProperties)) validate(item, schema.additionalProperties, `${path}.${key}`, depth + 1);
      else throw new Error(`${path}.${key} is not advertised by this tool.`);
    }
  }
  if (typeof value === 'string') {
    if ((schema.minLength !== undefined && value.length < schema.minLength) || (schema.maxLength !== undefined && value.length > schema.maxLength)) throw new Error(`${path} has an invalid length.`);
    if (schema.pattern && !new RegExp(schema.pattern, 'u').test(value)) throw new Error(`${path} does not match the tool schema.`);
  }
  if (typeof value === 'number' && ((schema.minimum !== undefined && value < schema.minimum) || (schema.maximum !== undefined && value > schema.maximum))) throw new Error(`${path} is outside the tool's allowed range.`);
  if (Array.isArray(value)) {
    if ((schema.minItems !== undefined && value.length < schema.minItems) || (schema.maxItems !== undefined && value.length > schema.maxItems)) throw new Error(`${path} has an invalid item count.`);
    if (schema.items) value.forEach((item, index) => validate(item, schema.items, `${path}[${index}]`, depth + 1));
  }
}

export async function callTool(relay, token, catalog, name, args = {}, { fetchImpl } = {}) {
  relay = normalizeRelay(relay);
  if (!ALLOWED.has(name)) throw new Error('This wallet does not admit that tool.');
  if (catalog?.relay !== relay || !Object.hasOwn(catalog.tools ?? {}, name)) throw new Error('Refresh the relay catalog before using this tool.');
  const tool = catalog.tools[name];
  if (tool.name !== name || tool.method !== 'POST' || tool.action !== `urn:iep:action:invoke:${name}`) throw new Error('The tool does not match its catalog affordance.');
  const target = safeTarget(tool.target, relay);
  if (typeof token !== 'string' || !token || /[\r\n]/.test(token)) throw new Error('Sign in to Interego first.');
  if (!object(args)) throw new Error('Tool arguments must be an object.');
  if (name === 'remember' && args.visibility !== 'private') throw new Error('This wallet saves private memories only.');
  validate(args, tool.inputSchema);
  const body = JSON.stringify(args);
  if (new TextEncoder().encode(body).byteLength > 64 * 1024) throw new Error('The tool request exceeded the size limit.');
  return unpack(await requestJson(target, { method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', Accept: 'application/ld+json, application/json' }, body }, { fetchImpl }));
}

/** The exact user-reviewed fields are sent; page content is never interpreted as authority. */
export function buildCapture({ title, url, text, purpose }) {
  if (typeof text !== 'string' || !text.trim() || text.length > 16_000) throw new Error('Choose between 1 and 16,000 characters to save.');
  if (typeof title !== 'string' || title.length > 200) throw new Error('Keep the memory title within 200 characters.');
  if (typeof purpose !== 'string' || !purpose.trim() || purpose.length > 500) throw new Error('Enter a purpose within 500 characters.');
  let source;
  if (url) {
    try { source = new URL(url); } catch { throw new Error('The source page needs a valid HTTP or HTTPS address.'); }
    if (!['https:', 'http:'].includes(source.protocol) || source.username || source.password) throw new Error('The source page needs an HTTP or HTTPS address without credentials.');
    // Query strings and fragments frequently contain session or document secrets.
    source.search = ''; source.hash = '';
  }
  return { title: title.trim() || 'Saved from browser', body: `${source ? `Source: ${source.href}\n` : ''}Purpose: ${purpose.trim()}\n\n${text.trim()}`, visibility: 'private' };
}
