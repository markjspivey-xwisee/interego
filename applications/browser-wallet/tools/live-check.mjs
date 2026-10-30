/** Optional read-only compatibility probe. Never registers a client or calls a tool. */
import assert from 'node:assert/strict';
import { discoverCatalog, normalizeRelay, requestJson } from '../src/relay.mjs';
const relay = normalizeRelay(process.argv[2] ?? 'https://relay.interego.xwisee.com');
const catalog = await discoverCatalog(relay);
for (const name of ['get_pod_status', 'discover_context', 'get_descriptor', 'remember']) assert.ok(catalog.tools[name], `${name} is not advertised`);
const metadata = await requestJson(`${relay}/.well-known/oauth-authorization-server`);
assert.equal(normalizeRelay(metadata.issuer), relay);
for (const field of ['authorization_endpoint', 'token_endpoint', 'registration_endpoint']) assert.equal(new URL(metadata[field]).origin, relay);
assert.ok(metadata.code_challenge_methods_supported.includes('S256'));
assert.ok(metadata.token_endpoint_auth_methods_supported.includes('none'));
for (const scope of ['mcp:read', 'mcp:write']) assert.ok(metadata.scopes_supported.includes(scope));
console.log(JSON.stringify({ relay, checkedAt: new Date().toISOString(), result: 'Public catalog and OAuth metadata compatible', admittedTools: Object.keys(catalog.tools), liveSignInTested: false, liveSaveTested: false }, null, 2));
