// Rev-196 signed-request client — used by the per-agent MCP shim.
//
// Every call signs the canonical payload with the agent's wallet,
// wraps it in the {_signature, _signed_payload} envelope, and posts
// to the production Interego relay's /tool/<name> endpoint. The
// relay recovers the signer address, verifies it matches the
// did:ethr in agent_id, and binds descriptor authorship to the
// recovered DID. No OAuth. Same auth path johnny/boozer would use
// for headless writes.
//
// Per-pod write queue + minimum gap so CSS doesn't drop concurrent
// writes (the same throttling the federation client used).

import { createHash } from 'node:crypto';

export function relayUrl() {
  return (process.env.CG_RELAY_URL
    ?? 'https://interego-relay.livelysky-8b81abb0.eastus.azurecontainerapps.io').replace(/\/$/, '');
}
export function gateUrl() {
  return (process.env.CG_GATE_URL
    ?? 'https://interego-css-gate.livelysky-8b81abb0.eastus.azurecontainerapps.io').replace(/\/$/, '');
}

function agentSlug(did) {
  const m = did.match(/0x([0-9a-fA-F]+)/);
  if (m && m[1]) return m[1].slice(-12).toLowerCase();
  return createHash('sha256').update(did).digest('hex').slice(0, 12);
}

export function podUrlForDid(did) {
  return `${gateUrl()}/eth-${agentSlug(did)}/`;
}

// ── Per-pod write queue ─────────────────────────────────────────

const _queues = new Map();
const _lastWriteAt = new Map();
const MIN_INTER_WRITE_MS = 1500;

function _enqueueWrite(podSlug, fn) {
  const prev = _queues.get(podSlug) ?? Promise.resolve();
  const next = prev.catch(() => {}).then(async () => {
    const last = _lastWriteAt.get(podSlug) ?? 0;
    const wait = MIN_INTER_WRITE_MS - (Date.now() - last);
    if (wait > 0) await new Promise(r => setTimeout(r, wait));
    const out = await fn();
    _lastWriteAt.set(podSlug, Date.now());
    return out;
  });
  _queues.set(podSlug, next);
  next.then(() => { if (_queues.get(podSlug) === next) _queues.delete(podSlug); }, () => {});
  return next;
}

// ── Sign a body for a relay tool call ───────────────────────────

async function signedBody({ wallet, did, args }) {
  const payload = { ...args, agent_id: did, timestamp: new Date().toISOString() };
  const json = JSON.stringify(payload);
  const hash = createHash('sha256').update(json, 'utf8').digest('hex');
  const signature = await wallet.signMessage(`sha256:${hash}`);
  return { _signature: signature, _signed_payload: json };
}

// ── Tool call (signed) ──────────────────────────────────────────

export async function signedToolCall({ wallet, did, toolName, args }) {
  const podSlug = agentSlug(did);
  return _enqueueWrite(podSlug, async () => {
    const body = await signedBody({ wallet, did, args: { ...args, pod_name: `eth-${podSlug}` } });
    const resp = await fetch(`${relayUrl()}/tool/${toolName}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    let j; try { j = await resp.json(); } catch { j = { error: `non-json status ${resp.status}` }; }
    return j;
  });
}

// ── Unsigned read (discover_context, get_descriptor, etc.) ──────

export async function unsignedToolCall({ toolName, args }) {
  const resp = await fetch(`${relayUrl()}/tool/${toolName}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(args),
  });
  let j; try { j = await resp.json(); } catch { j = { error: `non-json status ${resp.status}` }; }
  return j;
}

// ── Fetch graph payload (for descriptors that wrap JSON in turtle) ──

export async function fetchGraphPayload(descriptorUrl, { payloadPredicate = 'fed:payloadJson' } = {}) {
  if (!descriptorUrl) return null;
  const externalUrl = descriptorUrl.replace(/\binterego-css\.internal\./, 'interego-css-gate.');
  const graphUrl = externalUrl.replace(/\.ttl$/, '-graph.trig');
  const resp = await fetch(graphUrl, { headers: { Accept: 'application/trig, text/turtle' } });
  if (!resp.ok) return null;
  const turtle = await resp.text();
  const re = new RegExp(`${payloadPredicate}\\s+\"((?:[^\"\\\\]|\\\\.)*)\"`);
  const m = turtle.match(re);
  if (!m) return null;
  const raw = m[1].replace(/\\"/g, '"').replace(/\\\\/g, '\\');
  try { return JSON.parse(raw); } catch { return null; }
}
