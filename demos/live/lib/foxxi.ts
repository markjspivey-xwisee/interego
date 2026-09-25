/**
 * The Foxxi bridge, as the demo's actors reach it: named MCP tools over the bridge's own
 * `POST /mcp`, and the SCORM engine's signed routes. A signer turns arguments into the rev-196
 * envelope the bridge authenticates — `_signed_payload` (the arguments with `agent_id` and a
 * timestamp) and `_signature` (EIP-191 over `sha256:<hex of the payload>`) — so every call is
 * made as someone, and the bridge recovers who.
 */
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { Wallet } from 'ethers';

export const BRIDGE = (process.env['FOXXI_BRIDGE'] ?? 'https://foxxi-bridge.interego.xwisee.com').replace(/\/$/, '');

export interface Signer {
  /** The identity the envelope names as `agent_id`, and the bridge recovers. */
  readonly did: string;
  /** The `_signed_payload` and `_signature` for these arguments. */
  envelope(args: Record<string, unknown>): Promise<{ _signed_payload: string; _signature: string }>;
}

const sha256Hex = (s: string): string => createHash('sha256').update(s).digest('hex');

/** A signer over a wallet key file ({ address, privateKey }), read here and never passed on. */
export function walletSigner(keyFile: string): Signer & { readonly address: string } {
  const saved = JSON.parse(readFileSync(keyFile, 'utf8')) as { privateKey?: string };
  if (!saved.privateKey) throw new Error(`${keyFile} holds no wallet key`);
  const wallet = new Wallet(saved.privateKey);
  const did = `did:ethr:${wallet.address.toLowerCase()}`;
  return {
    did,
    address: wallet.address,
    async envelope(args) {
      const sp = JSON.stringify({ ...args, agent_id: did, timestamp: new Date().toISOString() });
      return { _signed_payload: sp, _signature: await wallet.signMessage(`sha256:${sha256Hex(sp)}`) };
    },
  };
}

/** A signer for a throwaway wallet, as a first-time visitor to the hosted player gets. */
export function ephemeralSigner(): Signer & { readonly address: string } {
  const wallet = Wallet.createRandom();
  const did = `did:ethr:${wallet.address.toLowerCase()}`;
  return {
    did,
    address: wallet.address,
    async envelope(args) {
      const sp = JSON.stringify({ ...args, agent_id: did, timestamp: new Date().toISOString() });
      return { _signed_payload: sp, _signature: await wallet.signMessage(`sha256:${sha256Hex(sp)}`) };
    },
  };
}

export interface Refusal {
  readonly status: number;
  readonly reason: string;
  readonly error: string;
}

export interface ToolAnswer {
  readonly answer: Record<string, unknown>;
  readonly refused?: Refusal;
  readonly httpStatus: number;
}

/** The refusal an answer carries, when it is one. */
export function refusalOf(a: Record<string, unknown>): Refusal | undefined {
  if (a['kind'] !== 'refusal') return undefined;
  return { status: Number(a['iep:refusalStatus'] ?? 400), reason: String(a['iep:refusalReason'] ?? ''), error: String(a['error'] ?? a['iep:refusalReason'] ?? '') };
}

/** A JSON-RPC body that may arrive as plain JSON or as one server-sent event. */
function parseRpc(text: string): { result?: { content?: { text?: string }[]; structuredContent?: unknown }; error?: { message?: string } } {
  const trimmed = text.trim();
  if (trimmed.startsWith('{')) return JSON.parse(trimmed);
  const data = trimmed.split('\n').filter((l) => l.startsWith('data:')).map((l) => l.slice(5).trim()).join('');
  return JSON.parse(data || '{}');
}

/** Call a named tool on the bridge's MCP endpoint, signed when a signer is given. */
export async function callTool(tool: string, args: Record<string, unknown>, signer?: Signer, timeoutMs = 120_000): Promise<ToolAnswer> {
  const signed = signer ? { ...args, ...(await signer.envelope(args)) } : args;
  const res = await fetch(`${BRIDGE}/mcp`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
    body: JSON.stringify({ jsonrpc: '2.0', id: Date.now(), method: 'tools/call', params: { name: tool, arguments: signed } }),
    signal: AbortSignal.timeout(timeoutMs),
  });
  const body = parseRpc(await res.text());
  if (body.error) throw new Error(`${tool}: ${body.error.message ?? JSON.stringify(body.error).slice(0, 300)}`);
  const text = (body.result?.content ?? []).map((c) => c.text ?? '').join('');
  let answer: Record<string, unknown>;
  try { answer = JSON.parse(text) as Record<string, unknown>; } catch { answer = { kind: 'text', text }; }
  const refused = refusalOf(answer);
  return { answer, httpStatus: refused?.status ?? res.status, ...(refused ? { refused } : {}) };
}

/** POST a signed envelope to one of the bridge's own routes, as the hosted player does. */
export async function signedRoute(path: string, args: Record<string, unknown>, signer: Signer, timeoutMs = 60_000): Promise<{ status: number; json: Record<string, unknown> }> {
  const res = await fetch(`${BRIDGE}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json' },
    body: JSON.stringify(await signer.envelope(args)),
    signal: AbortSignal.timeout(timeoutMs),
  });
  const json = await res.json().catch(() => ({})) as Record<string, unknown>;
  return { status: res.status, json };
}

/** GET a bridge resource as JSON. */
export async function getJson(path: string, timeoutMs = 30_000): Promise<{ status: number; json: Record<string, unknown> }> {
  const res = await fetch(path.startsWith('http') ? path : `${BRIDGE}${path}`, { headers: { accept: 'application/json' }, signal: AbortSignal.timeout(timeoutMs) });
  const json = await res.json().catch(() => ({})) as Record<string, unknown>;
  return { status: res.status, json };
}
