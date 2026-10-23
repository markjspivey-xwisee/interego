/**
 * The web UI and the browser-facing protection of a practice-evidence bridge.
 *
 * `attachUi` serves a static HTML shell at /ui, the client at /ui/app.js and its styles at
 * /ui/app.css. The client is a Path-A client: it reads this bridge's affordance manifest and
 * invokes every act at the target the manifest names. It holds no key (demo role keys stay in the
 * bridge; wallet keys stay in the wallet) and computes nothing the record does not already say.
 *
 * Interego sign-in (`attachUi(app, { interego })`, on when the operator sets PEV_RELAY_URL and
 * trusts a relay): a person with no key of their own signs in with their Interego account on the
 * relay's own sign-in page (their passkey), and the page then has the relay sign each act for the
 * agent of that session. These routes are the only ones the UI adds, and every relay call goes
 * through them, so the page's policy keeps `connect-src 'self'`:
 *
 *   GET  /ui/oauth/client.json  this client's Client ID Metadata Document; its client_id is that
 *                               URL on the deployment URL, its client_name "Practice Evidence", so
 *                               the relay names the session's agent practice-evidence-<userId>
 *   GET  /ui/oauth/start        what the page needs to send the person to the relay: the relay's
 *                               authorization endpoint (discovered from its metadata), the client
 *                               id (the CIMD URL, or one registered by DCR when the relay offers no
 *                               CIMD or the deployment URL is not https), the redirect URI, scope
 *                               and resource. The page makes the PKCE verifier and the state itself.
 *   GET  /ui/oauth/callback     the page the relay sends the person back to: the shell again, with
 *                               its asset URLs one level up. The code is in the query; the page
 *                               takes it out of the address bar before doing anything else.
 *   POST /ui/oauth/exchange     {code, code_verifier, state}: the code for an access token at the
 *                               relay's token endpoint, then that access token for the account
 *                               token the relay's REST tools take (GET <relay>/identity-token).
 *                               Only the account token is returned; the access and refresh tokens
 *                               are dropped here.
 *   POST /ui/relay/sign         {payload} with that account token as `Authorization: Bearer`: the
 *                               relay's sign_request, answered with only {_signature, _signed_payload}.
 *
 * The account token is a credential for the person's Interego account, not only for this bridge:
 * it passes through this bridge on every sign request, so the operator is trusted with it for the
 * session. This module never logs, stores or echoes a bearer or a code, never puts either in a URL
 * it serves, and drops both from any relay text it passes on. Every relay call has a deadline and a
 * size cap and follows no redirect; at most MAX_RELAY_CALLS_IN_FLIGHT run at once.
 *
 * Every UI response carries a Content-Security-Policy that allows only this origin's own script,
 * style and fetches, and no inline script or style; the shells have neither, and the client
 * renders every piece of untrusted text through textContent.
 *
 * `hostAllowlistGuard` refuses (421) any request whose Host header is not one of the names this
 * bridge is served under. A loopback bridge that holds a signing key — and, in demo mode, role
 * keys — would otherwise answer a page on another site that rebinds its own DNS name to
 * 127.0.0.1. Cross-site POSTs are already blocked by the JSON-only body parser and the absence of
 * CORS headers; this closes the rebinding path.
 */
import { readFileSync } from 'node:fs';
import type { Express, NextFunction, Request, Response } from 'express';
import { guardedFetchFn } from '@interego/core';
import { refuse } from '../../_shared/vertical-bridge/refusal.js';
import { cappedFetch } from './pod-helpers.js';

export const UI_CSP = "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self' data:; form-action 'self'; base-uri 'none'; frame-ancestors 'none'";

const readUiFile = (name: string): string => readFileSync(new URL(`./ui/${name}`, import.meta.url), 'utf8');
const APP_JS = readUiFile('app.js');
const APP_CSS = readUiFile('app.css');

/**
 * A shell: a constant, with no interpolation and no inline script or style. Relative URLs, so a
 * bridge deployed under a path prefix still loads its own client. `up` is the path from the page
 * to the directory /ui sits in: '' for /ui itself, '../../' for /ui/oauth/callback.
 */
const shell = (up: string): string => [
  '<!doctype html>',
  '<html lang="en">',
  '<head>',
  '<meta charset="utf-8">',
  '<meta name="viewport" content="width=device-width, initial-scale=1">',
  '<meta name="referrer" content="no-referrer">',
  '<title>Practice evidence</title>',
  `<link rel="stylesheet" href="${up}ui/app.css">`,
  `<script type="module" src="${up}ui/app.js"></script>`,
  '</head>',
  '<body>',
  '<header id="bar"><p class="muted">Practice evidence: loading…</p></header>',
  '<nav id="tabs" aria-label="Views"></nav>',
  '<section id="signing" aria-live="polite"></section>',
  '<main id="view"></main>',
  `<noscript><p>This page needs JavaScript. Everything it offers is also an affordance: see the manifest at <a href="${up}affordances">affordances</a>.</p></noscript>`,
  '</body>',
  '</html>',
  '',
].join('\n');
const SHELL = shell('');
/** The page the relay sends a person back to after sign-in. It never shows the query it is given. */
const CALLBACK_SHELL = shell('../../');

function secure(res: Response): void {
  res.setHeader('Content-Security-Policy', UI_CSP);
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('Cache-Control', 'no-store');
}

// ═════════════════════════════════════════════════════════════════════════════════════════════
//  Interego sign-in
// ═════════════════════════════════════════════════════════════════════════════════════════════

/** The OAuth client name the relay turns into the agent slug (`practice-evidence-<userId>`). */
export const PEV_UI_CLIENT_NAME = 'Practice Evidence';
/** The relay's scope that reaches its REST tools (and so sign_request): read and write. */
export const INTEREGO_SCOPE = 'mcp';
/** One relay call, from the first byte sent to the last read, DNS look-up included. */
export const RELAY_CALL_TIMEOUT_MS = 10_000;
/** The most one relay answer may be. */
export const RELAY_MAX_BYTES = 256 * 1024;
/** The most a payload to sign may be: the verifier refuses a signed payload over 64 KiB, and the relay adds its own fields. */
export const SIGN_PAYLOAD_MAX_BYTES = 60 * 1024;
/** The most a code exchange request may be. */
export const EXCHANGE_BODY_MAX_BYTES = 8 * 1024;
/** Relay calls running at once, across every person this bridge serves. */
export const MAX_RELAY_CALLS_IN_FLIGHT = 32;
/** How long the relay's authorization server metadata is kept. */
const METADATA_TTL_MS = 10 * 60_000;

export interface InteregoUiOptions {
  /** The relay a person signs in through (PEV_RELAY_URL), e.g. https://relay.interego.xwisee.com. */
  readonly relayUrl: string;
  /** This bridge's public base URL (BRIDGE_DEPLOYMENT_URL): the client id and the redirect URI are on it. */
  readonly deploymentUrl: string;
  /**
   * The fetch every relay call goes through. server.ts passes `relayCallFetch(fetch)`: SSRF-guarded
   * (unless the operator's relay is on loopback), size-capped, refusing every redirect. Tests pass
   * a relay of their own.
   */
  readonly relayFetch: typeof fetch;
  readonly timeoutMs?: number;
}

/** What the page needs to send a person to the relay's sign-in page. */
interface StartConfig {
  readonly authorizationEndpoint: string;
  readonly clientId: string;
  readonly redirectUri: string;
  readonly scope: string;
  readonly resource: string;
  readonly registration: 'client-id-metadata-document' | 'dynamic-registration';
  readonly relay: string;
}

interface RelayMetadata {
  readonly authorizationEndpoint: string;
  readonly tokenEndpoint: string;
  readonly registrationEndpoint: string | null;
  readonly cimd: boolean;
}

/** A refusal to send as it is: the status, the shared refusal shape, and any extra fields. */
class Declined extends Error {
  constructor(readonly status: number, message: string, readonly code: string, readonly extra: Readonly<Record<string, unknown>> = {}) {
    super(message);
  }
}

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
/** An OAuth authorization code: visible ASCII (RFC 6749 VSCHAR, no space). */
const CODE = /^[\x21-\x7e]{8,512}$/;
/** A PKCE code verifier (RFC 7636 §4.1). */
const VERIFIER = /^[A-Za-z0-9._~-]{43,128}$/;
/** The state the page makes: base64url, 16 to 128 characters. */
const STATE = /^[A-Za-z0-9_-]{16,128}$/;
/** A bearer token (RFC 6750 b64token), bounded. */
const BEARER = /^[A-Za-z0-9._~+/-]+=*$/;
const BEARER_MAX = 8192;
const SIGNATURE = /^0x[0-9a-fA-F]{130}$/;
/** An OAuth error code as RFC 6749 spells them; anything else from the relay is not passed on as a code. */
const OAUTH_ERROR = /^[a-z_]{1,64}$/;

/** The bearer of an `Authorization: Bearer <token>` header, or null. */
function bearerOf(header: string | undefined): string | null {
  if (typeof header !== 'string') return null;
  const m = /^Bearer ([^\s]+)$/.exec(header.trim());
  if (!m || !m[1] || m[1].length > BEARER_MAX || !BEARER.test(m[1])) return null;
  return m[1];
}

/** Text from the relay, with every secret of this call taken out and the rest cut short. */
function scrub(text: unknown, secrets: readonly string[]): string {
  let t = typeof text === 'string' ? text : '';
  for (const s of secrets) if (s.length >= 4) t = t.split(s).join('[withheld]');
  return t.slice(0, 200);
}

/** The body is over `max` bytes, by what it declares or by what was parsed. */
function tooLarge(req: Request, max: number): boolean {
  const declared = Number(req.headers['content-length'] ?? Number.NaN);
  if (Number.isFinite(declared) && declared > max) return true;
  try { return Buffer.byteLength(JSON.stringify(req.body ?? {}), 'utf8') > max; } catch { return true; }
}

/**
 * The fetch for relay calls that server.ts composes: no redirect is followed (a credential must
 * not follow one anywhere), every answer is read up to `RELAY_MAX_BYTES`, and every target goes
 * through the substrate's SSRF guard unless `privateRelay` (the operator's relay is on loopback,
 * which the guard refuses by design; the origin is the operator's, never a caller's).
 */
export function relayCallFetch(baseFetch: typeof fetch, o: { readonly privateRelay?: boolean; readonly maxBytes?: number } = {}): typeof fetch {
  const noRedirect = (async (input: RequestInfo | URL, init?: RequestInit): Promise<globalThis.Response> => {
    const res = await baseFetch(input, { ...init, redirect: 'manual' });
    if (res.status >= 300 && res.status < 400) {
      await res.body?.cancel().catch(() => undefined);
      throw new Error(`the relay answered with a redirect (HTTP ${res.status}), which this bridge does not follow`);
    }
    return res;
  }) as typeof fetch;
  const capped = cappedFetch(noRedirect, o.maxBytes ?? RELAY_MAX_BYTES);
  return o.privateRelay === true ? capped : guardedFetchFn(capped);
}

/** Mount Interego sign-in, or (with no options) routes that say it is off. */
function attachInteregoSignIn(app: Express, o: InteregoUiOptions | undefined): void {
  const paths = ['/ui/oauth/client.json', '/ui/oauth/start', '/ui/oauth/callback', '/ui/oauth/exchange', '/ui/relay/sign'];
  if (o === undefined) {
    const off = (_req: Request, res: Response): void => {
      secure(res);
      res.status(404).json(refuse(404, 'Interego sign-in is not on for this bridge\'s web UI: the operator sets PEV_RELAY_URL and trusts a relay (PEV_TRUSTED_RELAY_ADDRESSES).', 'interego-sign-in-off', { env: 'PEV_RELAY_URL' }));
    };
    for (const p of paths) app.all(p, off);
    return;
  }
  const relayFetch = o.relayFetch;
  const base = o.deploymentUrl.replace(/\/+$/, '');
  const relay = new URL(o.relayUrl);
  const relayBase = relay.href.replace(/\/+$/, '');
  const resource = relay.href;
  const clientIdUrl = `${base}/ui/oauth/client.json`;
  const redirectUri = `${base}/ui/oauth/callback`;
  /** CIMD identifies a client by an https URL with no fragment; a loopback or http deployment registers by DCR. */
  const cimdUsable = ((): boolean => { try { const u = new URL(clientIdUrl); return u.protocol === 'https:' && u.hash === ''; } catch { return false; } })();
  const timeoutMs = o.timeoutMs ?? RELAY_CALL_TIMEOUT_MS;
  let inFlight = 0;

  /** One relay call: within the deadline, capped, its JSON parsed (null when it is not JSON). */
  async function relayJson(url: string, init: RequestInit, secrets: readonly string[]): Promise<{ readonly status: number; readonly json: unknown; readonly retryAfter: string | null }> {
    if (inFlight >= MAX_RELAY_CALLS_IN_FLIGHT) {
      throw new Declined(503, 'This bridge is waiting on the Interego relay for many people at once; try again in a moment.', 'relay-busy', { retryAfterSeconds: 5 });
    }
    inFlight++;
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const call = (async () => {
        const res = await relayFetch(url, { ...init, signal: AbortSignal.timeout(timeoutMs) });
        const text = await res.text();
        let json: unknown = null;
        try { json = JSON.parse(text) as unknown; } catch { json = null; }
        return { status: res.status, json, retryAfter: res.headers.get('retry-after') };
      })();
      // The call that loses the race to the deadline still settles (its signal aborts it); handled here, so it is not an unhandled rejection.
      call.catch(() => undefined);
      const deadline = new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error(`no answer within ${timeoutMs} ms`)), timeoutMs);
      });
      return await Promise.race([call, deadline]);
    } catch (e) {
      if (e instanceof Declined) throw e;
      throw new Declined(502, `The Interego relay could not be reached: ${scrub(e instanceof Error ? e.message : String(e), secrets)}.`, 'relay-unreachable');
    } finally {
      if (timer !== undefined) clearTimeout(timer);
      inFlight--;
    }
  }

  /** An endpoint the relay's metadata names, held to the relay's own origin. */
  const onRelay = (v: unknown): string | null => {
    if (typeof v !== 'string') return null;
    try { const u = new URL(v); return u.origin === relay.origin && u.hash === '' ? u.href : null; } catch { return null; }
  };

  let metadataKept: { readonly at: number; readonly value: RelayMetadata } | null = null;
  /** The relay's authorization server metadata (RFC 8414), kept 10 minutes; a failure is not kept. */
  async function metadata(): Promise<RelayMetadata> {
    if (metadataKept && Date.now() - metadataKept.at < METADATA_TTL_MS) return metadataKept.value;
    const r = await relayJson(`${relayBase}/.well-known/oauth-authorization-server`, { method: 'GET', headers: { accept: 'application/json' } }, []);
    const m = r.json;
    const unusable = (why: string): Declined => new Declined(502, `The Interego relay's sign-in metadata cannot be used: ${why}.`, 'relay-metadata-unusable');
    if (r.status !== 200 || !isRecord(m)) throw unusable(`it answered HTTP ${r.status}`);
    const authorizationEndpoint = onRelay(m['authorization_endpoint']);
    const tokenEndpoint = onRelay(m['token_endpoint']);
    if (authorizationEndpoint === null || tokenEndpoint === null) throw unusable(`its authorization and token endpoints must be on ${relay.origin}`);
    const methods = m['code_challenge_methods_supported'];
    if (!Array.isArray(methods) || !methods.includes('S256')) throw unusable('it does not offer PKCE with S256');
    const types = m['response_types_supported'];
    if (Array.isArray(types) && !types.includes('code')) throw unusable('it does not offer the authorization code flow');
    const value: RelayMetadata = {
      authorizationEndpoint, tokenEndpoint,
      registrationEndpoint: onRelay(m['registration_endpoint']),
      cimd: m['client_id_metadata_document_supported'] === true,
    };
    metadataKept = { at: Date.now(), value };
    return value;
  }

  let registered: Promise<string> | null = null;
  /**
   * This client's id at the relay: the CIMD URL when the relay takes Client ID Metadata Documents
   * and the deployment URL is https; otherwise one registered by DCR, once per process (a failed
   * registration is tried again on the next sign-in).
   */
  async function clientIdFor(meta: RelayMetadata): Promise<{ readonly clientId: string; readonly registration: StartConfig['registration'] }> {
    if (meta.cimd && cimdUsable) return { clientId: clientIdUrl, registration: 'client-id-metadata-document' };
    if (meta.registrationEndpoint === null) {
      throw new Declined(502, cimdUsable
        ? 'The Interego relay takes neither a Client ID Metadata Document nor a dynamic registration, so this page cannot sign anyone in.'
        : `This bridge's deployment URL (${base}) is not https, so the relay cannot read its Client ID Metadata Document, and the relay offers no dynamic registration.`,
      'relay-registration-unavailable');
    }
    const endpoint = meta.registrationEndpoint;
    registered ??= (async (): Promise<string> => {
      const r = await relayJson(endpoint, {
        method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json' },
        body: JSON.stringify(clientMetadata(false)),
      }, []);
      const id = isRecord(r.json) ? r.json['client_id'] : undefined;
      if ((r.status !== 200 && r.status !== 201) || typeof id !== 'string' || id.length === 0 || id.length > 256) {
        throw new Declined(502, `The Interego relay did not register this page as a client (HTTP ${r.status}).`, 'relay-registration-refused');
      }
      return id;
    })();
    const pending = registered;
    try {
      return { clientId: await pending, registration: 'dynamic-registration' };
    } catch (e) {
      if (registered === pending) registered = null;
      throw e;
    }
  }

  /**
   * The client's metadata: in the CIMD with its client_id, in a DCR request without one. Only the
   * authorization code grant: the page keeps the account token the relay gives it for as long as it
   * lasts and then signs in again, rather than keep a refresh token (a 14-day credential) in the
   * browser.
   */
  const clientMetadata = (withId: boolean): Record<string, unknown> => ({
    ...(withId ? { client_id: clientIdUrl } : {}),
    client_name: PEV_UI_CLIENT_NAME,
    client_uri: `${base}/ui`,
    redirect_uris: [redirectUri],
    grant_types: ['authorization_code'],
    response_types: ['code'],
    token_endpoint_auth_method: 'none',
    scope: INTEREGO_SCOPE,
  });

  const send = (res: Response, e: unknown): void => {
    const d = e instanceof Declined ? e : new Declined(500, 'Interego sign-in failed inside this bridge.', 'interego-sign-in-failed');
    res.status(d.status).json({ ...refuse(d.status, d.message, d.code), ...d.extra });
  };

  app.get('/ui/oauth/client.json', (_req: Request, res: Response) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Cache-Control', 'public, max-age=300');
    res.type('application/json').send(JSON.stringify(clientMetadata(true), null, 2));
  });

  app.get('/ui/oauth/start', async (_req: Request, res: Response) => {
    secure(res);
    try {
      const meta = await metadata();
      const { clientId, registration } = await clientIdFor(meta);
      const out: StartConfig = {
        authorizationEndpoint: meta.authorizationEndpoint, clientId, redirectUri, scope: INTEREGO_SCOPE, resource, registration, relay: relay.origin,
      };
      res.json(out);
    } catch (e) { send(res, e); }
  });

  app.get('/ui/oauth/callback', (_req: Request, res: Response) => {
    secure(res);
    res.type('text/html; charset=utf-8').send(CALLBACK_SHELL);
  });

  app.post('/ui/oauth/exchange', async (req: Request, res: Response) => {
    secure(res);
    try {
      if (tooLarge(req, EXCHANGE_BODY_MAX_BYTES)) throw new Declined(413, `A code exchange is at most ${EXCHANGE_BODY_MAX_BYTES} bytes.`, 'payload-too-large');
      const b = isRecord(req.body) ? req.body : {};
      const code = b['code'];
      const verifier = b['code_verifier'];
      const state = b['state'];
      if (typeof code !== 'string' || !CODE.test(code)) throw new Declined(400, 'code must be the authorization code the relay sent back (8 to 512 visible characters).', 'oauth-code-shape');
      if (typeof verifier !== 'string' || !VERIFIER.test(verifier)) throw new Declined(400, 'code_verifier must be a PKCE verifier: 43 to 128 letters, digits, ".", "_", "~" or "-".', 'pkce-verifier-shape');
      // The page checks the state against the one it sent; the bridge holds none and checks its form.
      if (typeof state !== 'string' || !STATE.test(state)) throw new Declined(400, 'state must be the state the page sent: 16 to 128 base64url characters.', 'oauth-state-shape');
      const meta = await metadata();
      const { clientId } = await clientIdFor(meta);
      const form = new URLSearchParams({ grant_type: 'authorization_code', code, code_verifier: verifier, redirect_uri: redirectUri, client_id: clientId, resource });
      const t = await relayJson(meta.tokenEndpoint, {
        method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' }, body: form.toString(),
      }, [code, verifier]);
      const tj = isRecord(t.json) ? t.json : {};
      if (t.status !== 200) {
        const err = typeof tj['error'] === 'string' && OAUTH_ERROR.test(tj['error']) ? tj['error'] : null;
        throw new Declined(t.status === 429 ? 429 : 400, `The Interego relay did not take this sign-in's code${err ? ` (${err})` : ''}: ${scrub(tj['error_description'], [code, verifier]) || `HTTP ${t.status}`}. Sign in again.`,
          t.status === 429 ? 'relay-busy' : 'oauth-code-refused', { ...(err ? { relayError: err } : {}), ...(t.status === 429 ? { retryAfterSeconds: Number(t.retryAfter) || 60 } : {}) });
      }
      const access = tj['access_token'];
      const tokenType = tj['token_type'];
      if (typeof access !== 'string' || bearerOf(`Bearer ${access}`) === null) throw new Declined(502, 'The Interego relay answered the code with no usable access token.', 'relay-token-unusable');
      if (typeof tokenType === 'string' && tokenType.toLowerCase() !== 'bearer') {
        throw new Declined(502, `The Interego relay issued a ${scrub(tokenType, [access])} token, which this page cannot present.`, 'relay-token-unusable');
      }
      // The relay's REST tools take the account token behind this access token, not the access token itself.
      const id = await relayJson(`${relayBase}/identity-token`, { method: 'GET', headers: { authorization: `Bearer ${access}`, accept: 'application/json' } }, [access, code, verifier]);
      const ij = isRecord(id.json) ? id.json : {};
      const bearer = ij['identityToken'];
      if (id.status !== 200 || typeof bearer !== 'string' || bearerOf(`Bearer ${bearer}`) === null) {
        throw new Declined(502, id.status === 403
          ? `The Interego relay gave this sign-in no write scope, so it cannot sign acts (it asked for "${INTEREGO_SCOPE}").`
          : `The Interego relay did not give this sign-in its account token (HTTP ${id.status}).`, 'relay-token-unusable');
      }
      res.json({
        signedIn: true, bearer, relay: relay.origin,
        note: 'Keep this token in this tab only and send it only to this bridge\'s ui/relay/sign. It is a credential for your Interego account, and it passes through this bridge on every act it signs.',
      });
    } catch (e) { send(res, e); }
  });

  app.post('/ui/relay/sign', async (req: Request, res: Response) => {
    secure(res);
    try {
      const bearer = bearerOf(req.headers.authorization);
      if (bearer === null) {
        throw new Declined(401, 'Sign in with your Interego account first: this route takes the account token the sign-in gave this page, as Authorization: Bearer.', 'interego-bearer-missing');
      }
      if (tooLarge(req, SIGN_PAYLOAD_MAX_BYTES)) throw new Declined(413, `A payload to sign is at most ${SIGN_PAYLOAD_MAX_BYTES} bytes.`, 'payload-too-large');
      const payload = isRecord(req.body) ? req.body['payload'] : undefined;
      if (!isRecord(payload) || payload['v'] !== 1 || typeof payload['action'] !== 'string' || !payload['action'].startsWith('urn:iep:action:pev:')) {
        throw new Declined(400, 'payload must be an unsigned practice-evidence act: {v: 1, action: urn:iep:action:pev:…, nonce, podUrl, …}. This route signs nothing else.', 'payload-shape');
      }
      if (typeof payload['nonce'] !== 'string') throw new Declined(400, 'payload.nonce must be a fresh nonce.', 'payload-shape');
      const r = await relayJson(`${relayBase}/tool/sign_request`, {
        method: 'POST',
        headers: { authorization: `Bearer ${bearer}`, 'content-type': 'application/json', accept: 'application/json' },
        body: JSON.stringify({ payload }),
      }, [bearer]);
      if (r.status === 401 || r.status === 403) {
        throw new Declined(401, 'The Interego relay did not accept your sign-in (it may have expired). Sign in again.', 'interego-sign-in-expired');
      }
      if (r.status === 429) {
        throw new Declined(429, 'The Interego relay is limiting how often this bridge asks it to sign; try again in a minute.', 'relay-busy', { retryAfterSeconds: Number(r.retryAfter) || 60 });
      }
      const j = isRecord(r.json) ? r.json : {};
      if (r.status !== 200 || typeof j['error'] === 'string') {
        throw new Declined(502, `The Interego relay did not sign this act${typeof j['error'] === 'string' ? `: ${scrub(j['error'], [bearer])}` : ` (HTTP ${r.status})`}.`, 'relay-refused-signing');
      }
      const signedPayload = j['_signed_payload'];
      const signature = j['_signature'];
      if (typeof signedPayload !== 'string' || signedPayload.length === 0 || signedPayload.length > 64 * 1024 || typeof signature !== 'string' || !SIGNATURE.test(signature)) {
        throw new Declined(502, 'The Interego relay answered without a signed request.', 'relay-refused-signing');
      }
      // The relay signs the caller's own fields; what it returns must be this act, not another.
      let signed: unknown;
      try { signed = JSON.parse(signedPayload) as unknown; } catch { signed = null; }
      if (!isRecord(signed) || signed['action'] !== payload['action'] || signed['nonce'] !== payload['nonce']) {
        throw new Declined(502, 'The Interego relay signed something other than this act.', 'relay-signed-something-else');
      }
      res.json({ _signature: signature, _signed_payload: signedPayload });
    } catch (e) { send(res, e); }
  });
}

/**
 * A body these routes cannot read (not JSON, or over the parser's limit) answered as a refusal,
 * not as the framework's HTML error page. Registered after the body parser, so its errors reach it.
 */
function uiBodyErrors(err: unknown, _req: Request, res: Response, next: NextFunction): void {
  if (res.headersSent) { next(err); return; }
  const status = isRecord(err) && err['status'] === 413 ? 413 : 400;
  secure(res);
  res.status(status).json(refuse(status, status === 413 ? 'The request body is over this bridge\'s limit.' : 'The request body is not JSON this route can read.', status === 413 ? 'payload-too-large' : 'body-unreadable'));
}

/** Mount GET /ui, /ui/app.js and /ui/app.css, and the Interego sign-in routes (or their refusals). */
export function attachUi(app: Express, o: { readonly interego?: InteregoUiOptions } = {}): void {
  app.get('/ui', (req: Request, res: Response) => {
    // The shell's URLs are relative to /ui; at /ui/ they would resolve one level too deep.
    if (req.path.endsWith('/')) { res.redirect(301, '../ui'); return; }
    secure(res);
    res.type('text/html; charset=utf-8').send(SHELL);
  });
  app.get('/ui/app.js', (_req: Request, res: Response) => { secure(res); res.type('text/javascript; charset=utf-8').send(APP_JS); });
  app.get('/ui/app.css', (_req: Request, res: Response) => { secure(res); res.type('text/css; charset=utf-8').send(APP_CSS); });
  attachInteregoSignIn(app, o.interego);
  app.use('/ui', uiBodyErrors);
}

/** Refuse any request whose Host header (lowercased) is not in `allowed`. */
export function hostAllowlistGuard(allowed: readonly string[]): (req: Request, res: Response, next: NextFunction) => void {
  const names = new Set(allowed.map((h) => h.toLowerCase()));
  return (req: Request, res: Response, next: NextFunction): void => {
    const host = (req.headers.host ?? '').toLowerCase();
    if (names.has(host)) { next(); return; }
    res.status(421).json(refuse(421, 'This bridge does not answer for that host name.', 'host-not-served'));
  };
}
