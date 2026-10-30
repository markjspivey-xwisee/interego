/** Public OAuth client: PKCE + state; no shared secret, key custody, or durable token. */
import { normalizeRelay, requestJson } from './relay.mjs';

const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
function base64url(bytes) {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
function endpoint(raw, relay) {
  let url;
  try { url = new URL(raw); } catch { throw new Error('The relay OAuth metadata has an invalid endpoint.'); }
  if (url.origin !== relay || url.protocol !== 'https:' || url.username || url.password || url.search || url.hash) throw new Error('OAuth endpoints must belong to the selected relay.');
  return url.href;
}
function callbackUri(raw) {
  let url;
  try { url = new URL(raw); } catch { throw new Error('The browser callback address is invalid.'); }
  if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash) throw new Error('The browser callback must be a clean HTTPS address.');
  return url;
}

export async function signIn({ relay, redirectUri, scope = 'mcp:read', launch, fetchImpl = globalThis.fetch, cryptoImpl = globalThis.crypto }) {
  relay = normalizeRelay(relay);
  const redirect = callbackUri(redirectUri);
  if (!['mcp:read', 'mcp', 'mcp:write'].includes(scope)) throw new Error('Choose an Interego read or write scope.');
  if (typeof launch !== 'function' || !cryptoImpl?.subtle || !cryptoImpl?.getRandomValues) throw new Error('Browser sign-in is unavailable.');
  const metadata = await requestJson(`${relay}/.well-known/oauth-authorization-server`, { headers: { Accept: 'application/json' } }, { fetchImpl });
  if (!object(metadata) || normalizeRelay(metadata.issuer) !== relay) throw new Error('The OAuth issuer does not match this relay.');
  if (!Array.isArray(metadata.code_challenge_methods_supported) || !metadata.code_challenge_methods_supported.includes('S256')
    || !Array.isArray(metadata.scopes_supported) || !metadata.scopes_supported.includes(scope)
    || (metadata.token_endpoint_auth_methods_supported && (!Array.isArray(metadata.token_endpoint_auth_methods_supported)
      || !metadata.token_endpoint_auth_methods_supported.includes('none')))) throw new Error('The relay does not advertise the required public-client sign-in contract.');
  const authorization = endpoint(metadata.authorization_endpoint, relay);
  const tokenEndpoint = endpoint(metadata.token_endpoint, relay);
  const registration = endpoint(metadata.registration_endpoint, relay);
  const client = await requestJson(registration, { method: 'POST', headers: { 'Content-Type': 'application/json', Accept: 'application/json' }, body: JSON.stringify({ client_name: 'Interego Browser Wallet', redirect_uris: [redirect.href], grant_types: ['authorization_code'], response_types: ['code'], token_endpoint_auth_method: 'none', scope }) }, { fetchImpl });
  if (!object(client) || typeof client.client_id !== 'string' || !client.client_id || client.client_id.length > 2048
    || client.client_secret || (client.token_endpoint_auth_method && client.token_endpoint_auth_method !== 'none')) throw new Error('The relay did not register a public OAuth client.');
  const verifier = base64url(cryptoImpl.getRandomValues(new Uint8Array(32)));
  const state = base64url(cryptoImpl.getRandomValues(new Uint8Array(32)));
  const challenge = base64url(new Uint8Array(await cryptoImpl.subtle.digest('SHA-256', new TextEncoder().encode(verifier))));
  const authorizeUrl = new URL(authorization);
  authorizeUrl.search = new URLSearchParams({ response_type: 'code', client_id: client.client_id, redirect_uri: redirect.href, scope, state, code_challenge: challenge, code_challenge_method: 'S256', resource: `${relay}/mcp` }).toString();
  const returned = await launch(authorizeUrl.href);
  let callback;
  try { callback = new URL(returned); } catch { throw new Error('Browser sign-in did not return a valid callback.'); }
  if (callback.origin !== redirect.origin || callback.pathname !== redirect.pathname || callback.username || callback.password || callback.hash
    || callback.searchParams.getAll('state').length !== 1 || callback.searchParams.get('state') !== state) throw new Error('The sign-in callback or state did not match this request.');
  if (callback.searchParams.has('error')) throw new Error('Interego sign-in was declined or could not complete.');
  if (callback.searchParams.has('access_token') || callback.searchParams.has('refresh_token') || callback.searchParams.has('id_token')) throw new Error('Tokens in a browser callback are refused.');
  const codes = callback.searchParams.getAll('code');
  if (codes.length !== 1 || !codes[0] || codes[0].length > 4096) throw new Error('The sign-in callback had no valid authorization code.');
  if (callback.searchParams.has('iss') && callback.searchParams.get('iss') !== metadata.issuer) throw new Error('The callback issuer did not match this relay.');
  const tokens = await requestJson(tokenEndpoint, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' }, body: new URLSearchParams({ grant_type: 'authorization_code', client_id: client.client_id, code: codes[0], code_verifier: verifier, redirect_uri: redirect.href, resource: `${relay}/mcp` }).toString() }, { fetchImpl });
  const granted = typeof tokens?.scope === 'string' ? tokens.scope : scope;
  if (!object(tokens) || typeof tokens.access_token !== 'string' || !tokens.access_token || /[\r\n]/.test(tokens.access_token)
    || tokens.token_type?.toLowerCase() !== 'bearer' || !Number.isFinite(tokens.expires_in) || tokens.expires_in <= 0 || tokens.expires_in > 86_400
    || granted !== scope) throw new Error('The relay returned an invalid or unexpected token grant.');
  return { accessToken: tokens.access_token, expiresAt: Date.now() + tokens.expires_in * 1000, scope: granted, relay };
}
