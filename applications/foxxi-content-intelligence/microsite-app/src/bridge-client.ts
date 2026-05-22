/**
 * Microsite bridge client — talks to the live Foxxi bridge for every
 * demo card. Each call optionally carries a bearer token; the
 * microsite auto-mints tokens for the demo identities (Joshua / Jordan)
 * the visitor picks.
 *
 * Reuses the shared auth.ts from the foxxi vertical (same wallet
 * derivation as the bridge verifies against) so the signatures we mint
 * here verify against the same address-map.
 */

import { mintSessionToken } from '../../src/auth.js';

export const BRIDGE_URL = (import.meta.env.VITE_FOXXI_BRIDGE_URL as string | undefined)
  ?? 'http://localhost:6080';

// Demo identities — mirror the dashboard's roster. The tenant has
// published these wallet addresses on the directory descriptor, so
// signatures from them verify against the bridge's address-map.
// Demo identities are rooted at a real Azure-hosted identity server
// (interego-acme-id) that publishes the tenant DID document at
// /.well-known/did.json and per-user WebID profile cards at
// /users/<slug>/profile/card . No synthetic .example domains — every
// WebID below is a real, fetchable Turtle profile.
const ID_BASE = 'https://interego-acme-id.livelysky-8b81abb0.eastus.azurecontainerapps.io';
const webIdFor = (slug: string) => `${ID_BASE}/users/${slug}/profile/card#me`;

export const DEMO_IDENTITIES = {
  joshua: {
    userId: 'u-joshua',
    webId: webIdFor('jliu'),
    name: 'Joshua Liu',
    role: 'Engineer · Engineering · new-hire',
    audienceTags: ['engineering', 'all-employees', 'new-hires'],
  },
  jordan: {
    userId: 'u-admin',
    webId: webIdFor('admin'),
    name: 'Jordan Doe',
    role: 'L&D Administrator · People Ops',
    audienceTags: ['all-employees', 'managers'],
  },
  ngozi: {
    userId: 'u-le',
    webId: webIdFor('le'),
    name: 'Ngozi Kowalski',
    role: 'Learning Engineer · Learning Engineering team · learning sciences × HCD × engineering methods × data',
    audienceTags: ['learning-engineering', 'all-employees', 'managers', 'engineering'],
  },
} as const;

export type Identity = keyof typeof DEMO_IDENTITIES;

export interface BridgeCall {
  /** What the visitor asked the bridge to do. */
  tool: string;
  args: Record<string, unknown>;
  /** ISO timestamp of when the call started. */
  startedAt: string;
  /** ISO timestamp of when the response came back (or `null` if still running). */
  completedAt: string | null;
  /** Result body or error. */
  result: unknown;
  /** Raw JSON-RPC the bridge sent back (handy for the explainer panels). */
  rawResponse?: unknown;
  /** True if this call required auth + presented a bearer token. */
  authed: boolean;
  /** Caller WebID extracted from the token (if authed). */
  callerWebId?: string;
  /** Network duration in ms. */
  durationMs?: number;
}

const tokenCache = new Map<Identity, string>();

/**
 * Call a REST route on the bridge — the content / performance surfaces
 * (`/content/ask`, `/content/deliver`, `/performance/plan`, …), as
 * opposed to the JSON-RPC `/mcp` tool surface `callBridge` uses.
 * Optionally carries a demo identity's wallet-signed bearer token.
 */
export async function bridgeRest(
  path: string, body: unknown, identity?: Identity,
): Promise<{ status: number; json: Record<string, unknown> }> {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (identity) headers['Authorization'] = `Bearer ${await getToken(identity)}`;
  try {
    const r = await fetch(`${BRIDGE_URL}${path}`, {
      method: 'POST', headers, body: JSON.stringify(body),
    });
    return { status: r.status, json: await r.json().catch(() => ({})) as Record<string, unknown> };
  } catch (err) {
    return { status: 0, json: { error: (err as Error).message } };
  }
}

async function getToken(identity: Identity): Promise<string> {
  const cached = tokenCache.get(identity);
  if (cached) return cached;
  const id = DEMO_IDENTITIES[identity];
  const token = await mintSessionToken({
    userId: id.userId,
    webId: id.webId,
    ttlMs: 30 * 60 * 1000,
  });
  tokenCache.set(identity, token);
  return token;
}

/**
 * Call a bridge tool. Returns the structured response + metadata used by
 * the demo cards to render call traces.
 */
export async function callBridge(args: {
  tool: string;
  args: Record<string, unknown>;
  identity?: Identity;
}): Promise<BridgeCall> {
  const startedAt = new Date().toISOString();
  const t0 = Date.now();
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (args.identity) {
    headers['Authorization'] = `Bearer ${await getToken(args.identity)}`;
  }
  let rawResponse: unknown;
  let result: unknown;
  try {
    const resp = await fetch(`${BRIDGE_URL}/mcp`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: Date.now(),
        method: 'tools/call',
        params: { name: args.tool, arguments: args.args },
      }),
    });
    rawResponse = await resp.json();
    const text = (rawResponse as { result?: { content?: Array<{ text?: string }> }; error?: unknown }).result?.content?.[0]?.text;
    if (text) {
      try { result = JSON.parse(text); }
      catch { result = { raw: text }; }
    } else {
      result = { error: (rawResponse as { error?: unknown }).error ?? 'no result body' };
    }
  } catch (err) {
    result = { error: (err as Error).message };
  }
  const completedAt = new Date().toISOString();
  return {
    tool: args.tool,
    args: args.args,
    startedAt,
    completedAt,
    result,
    rawResponse,
    authed: !!args.identity,
    callerWebId: args.identity ? DEMO_IDENTITIES[args.identity].webId : undefined,
    durationMs: Date.now() - t0,
  };
}
