/**
 * A workspace member that is a PROCESS, holding its own credentials.
 *
 * ── WHY THIS FILE EXISTS AT ALL ──────────────────────────────────────────────
 *
 * Every other caller of `stream.ts` in this repository is a person's session: a bearer
 * token minted by a human logging in, handed to a script. That is enough to demonstrate
 * the read and write halves, and it is NOT enough to demonstrate a member who is an agent,
 * because a script driven by a human is the human's writing under another name.
 *
 * The difference this file makes is narrow and it is the whole point: the identity below
 * is a WALLET THIS PROCESS HOLDS, not a delegation somebody granted it on somebody else's
 * pod. It signs its own SIWE challenge, it is issued its own bearer, the relay resolves it
 * to its OWN pod, and everything it writes lands there. Nobody else can write its log and
 * it cannot write anybody else's — the substrate refuses that with `scope_violation`, which
 * is the design working rather than an obstacle to route around.
 *
 * ★ WHAT THIS IS NOT. It is not a way to act as another party. There is no `pod_name`
 * override here and there must never be one: an agent that can be pointed at a pod is an
 * agent whose attribution is the caller's choice, and `entry.principal` was exactly that
 * label-not-a-fact once already (#243). The pod is whatever the relay says this wallet's
 * pod is, read back from `get_pod_status` and never composed from a name.
 *
 * ★ THE KEY NEVER LEAVES THE PROCESS. It is read from the environment once. It is not
 * accepted from a request, it is not logged, and it is not returned in any response — a
 * responder that took its key from its caller would be a signing oracle, and the caller
 * would be the author.
 */

import { Wallet } from 'ethers';
import { createHash, randomBytes } from 'node:crypto';
import type { StreamDeps } from './stream.js';

/** Everything the relay told us about who this process is. Read back, never composed. */
export interface AgentIdentity {
  /** The wallet address the SIWE challenge was signed with. */
  readonly address: string;
  /** The pod URL the relay resolved this identity to. */
  readonly podUrl: string;
  /**
   * The pod's terminal segment — the `pod_name` the relay's `/ns/<pod>/…` IRIs are built
   * from. Derived from `podUrl` rather than from the address, because the relay owns that
   * naming and a locally-derived name that disagrees reads back as an empty pod rather
   * than as an error.
   */
  readonly podName: string;
  /** The WebID the pod's registry names as its owner. This is the member principal. */
  readonly webId: string;
  /** The session agent's DID, when the relay reported one. A resolution hint, not authority. */
  readonly agentDid: string | null;
  /**
   * The delegation scope the pod's own registry grants this agent — `ReadWrite`,
   * `PublishOnly`, `ReadOnly`, `DiscoverOnly`, or null when the relay did not say.
   *
   * ★ THIS IS THE CEILING'S OTHER HALF and it is read, not assumed. A role permits
   * capabilities; the delegation is what the substrate will actually honour, and the member
   * may do the intersection of the two. An UNRECOGNISED scope must grant nothing.
   */
  readonly scope: string | null;
}

export interface RelayCall {
  (name: string, args: Record<string, unknown>): Promise<Record<string, unknown>>;
}

export interface AgentSession {
  readonly identity: AgentIdentity;
  readonly call: RelayCall;
  readonly deps: StreamDeps;
}

const b64u = (b: Buffer): string => b.toString('base64url');

/** Parse a relay MCP response that may arrive as JSON or as an SSE `data:` stream. */
function parseWire(raw: string): Record<string, unknown> {
  try {
    return JSON.parse(raw) as Record<string, unknown>;
  } catch {
    const merged = raw
      .split('\n')
      .filter(l => l.startsWith('data:'))
      .map(l => l.slice(5).trim())
      .join('');
    if (merged === '') {
      throw new Error(`relay answered with neither JSON nor an SSE data frame: ${raw.slice(0, 200)}`);
    }
    return JSON.parse(merged) as Record<string, unknown>;
  }
}

/**
 * Mint a bearer for this wallet against the relay's own authorization server.
 *
 * The flow is the ordinary public-client one — dynamic registration, PKCE, SIWE at the
 * verify step — i.e. exactly what a browser does, with the signature produced here instead
 * of by a wallet extension. Nothing about it is privileged.
 */
async function mintBearer(wallet: Wallet, relay: string, identityHost: string): Promise<string> {
  const redirect = 'http://localhost:9999/callback';
  const verifier = b64u(randomBytes(32));
  const challenge = b64u(createHash('sha256').update(verifier).digest());

  const reg = await fetch(`${relay}/register`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      client_name: 'wsp-agent-member',
      redirect_uris: [redirect],
      grant_types: ['authorization_code'],
      response_types: ['code'],
      token_endpoint_auth_method: 'none',
    }),
  });
  if (!reg.ok) throw new Error(`relay /register answered ${reg.status}`);
  const client = await reg.json() as { client_id?: string };
  if (!client.client_id) throw new Error('relay /register returned no client_id');

  const authorizeUrl = `${relay}/authorize?response_type=code`
    + `&client_id=${encodeURIComponent(client.client_id)}`
    + `&redirect_uri=${encodeURIComponent(redirect)}`
    + `&code_challenge=${challenge}&code_challenge_method=S256`
    + `&scope=mcp&state=s&resource=${encodeURIComponent(`${relay}/`)}`;
  const html = await (await fetch(authorizeUrl)).text();
  const pendingId = /const PENDING_ID\s*=\s*['"]([^'"]+)/.exec(html)?.[1];
  if (!pendingId) throw new Error('relay /authorize did not carry a pending id');

  const ch = await fetch(`${identityHost}/challenges`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ purpose: 'siwe' }),
  });
  const { nonce } = await ch.json() as { nonce?: string };
  if (!nonce) throw new Error('identity server issued no nonce');

  const host = new URL(relay).host;
  const message = `${host} wants you to sign in with your Ethereum account:\n`
    + `${wallet.address}\n\nSign in to Interego\n\nURI: ${relay}\nVersion: 1\nChain ID: 1\n`
    + `Nonce: ${nonce}\nIssued At: ${new Date().toISOString()}`;
  const signature = await wallet.signMessage(message);

  const vj = await (await fetch(`${relay}/oauth/verify`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ pending_id: pendingId, method: 'siwe', message, signature, nonce }),
  })).json() as { redirect?: string };
  const code = /[?&]code=([^&]+)/.exec(vj.redirect ?? '')?.[1];
  if (!code) throw new Error('SIWE verify returned no authorization code');

  const tj = await (await fetch(`${relay}/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'authorization_code',
      code,
      redirect_uri: redirect,
      client_id: client.client_id,
      code_verifier: verifier,
      resource: `${relay}/`,
    }),
  })).json() as { access_token?: string };
  if (!tj.access_token) throw new Error('token endpoint issued no access_token');
  return tj.access_token;
}

/**
 * A relay caller that re-mints its bearer when the old one lapses.
 *
 * ★ ONE RETRY, ON 401 ONLY, AND IT IS NOT A GENERAL RETRY LOOP. Relay tokens expire on the
 * hour and this process outlives them, so a lapsed token is an expected condition rather
 * than a failure. Anything else — a refusal, a shape violation, an outage — is returned as
 * it came: re-issuing a write because it was refused is how a single append becomes two.
 */
function makeCall(getToken: () => Promise<string>, refresh: () => Promise<string>, relay: string): RelayCall {
  let seq = 1;
  return async function call(name, args) {
    const send = async (token: string): Promise<Response> => fetch(`${relay}/mcp`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
        Accept: 'application/json, text/event-stream',
      },
      body: JSON.stringify({
        jsonrpc: '2.0', id: seq++, method: 'tools/call', params: { name, arguments: args },
      }),
    });

    let res = await send(await getToken());
    if (res.status === 401) res = await send(await refresh());
    const raw = await res.text();
    if (!res.ok && raw.trim() === '') {
      throw new Error(`relay ${name} answered ${res.status} with an empty body`);
    }
    const wire = parseWire(raw);
    const err = wire['error'] as { message?: string } | undefined;
    if (err && !wire['result']) throw new Error(`relay ${name}: ${err.message ?? JSON.stringify(err)}`);
    const result = wire['result'] as { content?: Array<{ text?: string }>; isError?: boolean } | undefined;
    const text = result?.content?.[0]?.text;
    if (typeof text !== 'string') return (result ?? {}) as Record<string, unknown>;
    try {
      return JSON.parse(text) as Record<string, unknown>;
    } catch {
      // A tool that answers prose rather than JSON is not a failure of this transport, and
      // pretending it returned {} would erase what it said.
      return { text } as Record<string, unknown>;
    }
  };
}

export interface OpenSessionOptions {
  readonly privateKey: string;
  readonly relay: string;
  readonly identityHost: string;
  /** Injected for tests. Defaults to the real network fetch. */
  readonly fetchDocument?: StreamDeps['fetchDocument'];
}

/**
 * Open the agent's own session: sign in as its wallet, then ask the relay who that is.
 *
 * ★ THE IDENTITY IS THE RELAY'S ANSWER, NOT OUR CONSTRUCTION. Deriving `u-eth-<first 12 hex
 * of the address>` locally would be right today and would silently address a pod that does
 * not exist the day the relay changes how it names them — and a wrong pod name reads back
 * as an empty log rather than as an error, which is the confident falsehood this whole
 * vertical is written against.
 */
export async function openAgentSession(opts: OpenSessionOptions): Promise<AgentSession> {
  const wallet = new Wallet(opts.privateKey);
  let token: string | null = null;

  const getToken = async (): Promise<string> => {
    token ??= await mintBearer(wallet, opts.relay, opts.identityHost);
    return token;
  };
  const refresh = async (): Promise<string> => {
    token = await mintBearer(wallet, opts.relay, opts.identityHost);
    return token;
  };

  const call = makeCall(getToken, refresh, opts.relay);
  const status = await call('get_pod_status', {});
  if (status['error'] !== undefined) {
    throw new Error(`get_pod_status refused: ${String(status['message'] ?? status['error'])}`);
  }
  const podUrl = String(status['pod'] ?? '');
  const podName = podUrl.replace(/\/$/, '').split('/').pop() ?? '';
  if (podName === '') {
    throw new Error('get_pod_status answered without a pod URL this reader could turn into a pod name');
  }
  const registry = status['registry'] as { owner?: string } | undefined;
  const delegation = status['delegationRegistry'] as { owner?: string } | undefined;
  const webId = registry?.owner ?? delegation?.owner ?? '';
  if (webId === '') {
    throw new Error('the pod registry named no owner, so this agent has no principal to be a member as');
  }
  const sessionAgent = status['sessionAgent'] as { did?: string; scope?: string } | undefined;

  const identity: AgentIdentity = {
    address: wallet.address,
    podUrl,
    podName,
    webId,
    agentDid: sessionAgent?.did ?? null,
    scope: sessionAgent?.scope ?? null,
  };

  const deps: StreamDeps = {
    publish: async args => call('publish_context', args),
    discover: async args => call('discover_context', args),
    getDescriptor: async args => call('get_descriptor', args),
    currentHead: async args => call('get_current_head', args),
    fetchDocument: opts.fetchDocument ?? (async (url: string) => {
      const r = await fetch(url, { headers: { Accept: 'text/turtle, text/html;q=0.8' } });
      return {
        status: r.status,
        url: r.url,
        contentType: r.headers.get('content-type'),
        body: await r.text(),
      };
    }),
  };

  return { identity, call, deps };
}
