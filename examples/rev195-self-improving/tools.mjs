// Substrate-client wrappers for the rev-195 self-improving demo.
//
// All calls hit the live Interego relay at CG_RELAY_URL (default:
// production Azure FQDN). The agent's identity is an ECDSA wallet held
// locally; descriptors are published via the relay's /tool/<name> HTTP
// surface (which honors the same auth+signature contract the Foxxi
// bridge uses for /performance/outcome and /agent/teach).
//
// No Anthropic API key is used here — the LLM-driving layer
// (controller.mjs / one.mjs / collective.mjs) uses the local Claude
// Code OAuth session via @anthropic-ai/claude-agent-sdk.

import { createHash } from 'node:crypto';

const RELAY = (process.env.CG_RELAY_URL ?? 'https://interego-relay.livelysky-8b81abb0.eastus.azurecontainerapps.io').replace(/\/$/, '');
const FOXXI = (process.env.FOXXI_BRIDGE_URL ?? 'https://interego-foxxi-bridge.livelysky-8b81abb0.eastus.azurecontainerapps.io').replace(/\/$/, '');

/**
 * Record one trajectory step for the calling agent.
 *
 * Uses the rev-196 ECDSA signed-request auth path. The agent's wallet
 * signs the canonical `sha256:<hex>` of the JSON body; the relay
 * recovers the address, confirms it matches the claimed agent_id
 * (did:ethr:<addr>), and binds the descriptor's authorship to the
 * recovered DID. No OAuth bearer needed.
 *
 * `wallet` is required for the signed-request path. Pass the same
 * ethers Wallet that owns the agent's DID.
 */
export async function recordTrajectoryStep({
  agentId, wallet, verb, objectName,
  modalStatus = 'Asserted',
  granularity = 'tool-call',
  sessionId,
  parentStepId, supersedesStepId,
  resultSuccess, resultQuality, resultNote,
  wasDerivedFrom,
}) {
  if (!wallet || typeof wallet.signMessage !== 'function') {
    // Without a wallet we can't sign — record a local-only stepId so
    // the controller's supersedes-linking still works. This is the
    // graceful-degradation path for callers that don't pass a wallet.
    const localStepId = `urn:iep:trajectory-step-local:${agentSlug(agentId)}:${Date.now()}`;
    return { ok: false, stepId: localStepId, descriptorUrl: null, raw: { error: 'no wallet supplied' } };
  }
  const innerArgs = {
    verb, object_name: objectName,
    modal_status: modalStatus,
    granularity,
    ...(sessionId ? { session_id: sessionId } : {}),
    ...(parentStepId ? { parent_step_id: parentStepId } : {}),
    ...(supersedesStepId ? { supersedes_step_id: supersedesStepId } : {}),
    ...(resultSuccess !== undefined ? { result_success: resultSuccess } : {}),
    ...(resultQuality !== undefined ? { result_quality: resultQuality } : {}),
    ...(resultNote ? { result_note: resultNote } : {}),
    ...(Array.isArray(wasDerivedFrom) && wasDerivedFrom.length ? { was_derived_from: wasDerivedFrom } : {}),
    sign_authorship: false, // signer authority comes from the request signature
  };
  const signed = await signedBody({
    wallet, agentId,
    args: innerArgs,
  });
  const resp = await fetch(`${RELAY}/tool/record_trajectory_step`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(signed),
  });
  let j;
  try { j = await resp.json(); } catch { j = { error: 'non-json response', status: resp.status }; }
  return {
    ok: !j.error,
    stepId: j.stepId,
    trajectoryGraphIri: j.trajectoryGraphIri,
    descriptorUrl: j.publish?.descriptorUrl,
    raw: j,
  };
}

/**
 * Build a signed-request envelope: `{ _signature, _signed_payload }`.
 *
 * The signed payload is canonical JSON of `{ ...args, agent_id, timestamp }`.
 * The signer signs `sha256:<hex>` of that payload — same scheme Foxxi's
 * verifySignature uses for /agent/teach + /performance/outcome.
 *
 * `args` MUST NOT include `agent_id` or `timestamp` — they're added here
 * so the relay sees a uniform shape.
 */
async function signedBody({ wallet, agentId, args }) {
  const payload = {
    ...args,
    agent_id: agentId,
    timestamp: new Date().toISOString(),
  };
  const signedPayload = JSON.stringify(payload);
  const hash = createHash('sha256').update(signedPayload, 'utf8').digest('hex');
  const signature = await wallet.signMessage(`sha256:${hash}`);
  return { _signature: signature, _signed_payload: signedPayload };
}

/**
 * Run the OODA decision functor (Tier-2.A — pgsl_decide).
 *
 * Returns the substrate's strategy recommendation for this agent's
 * current observations. The controller treats this as the
 * substrate-honest "what should I do next" prompt — instead of free-form
 * reasoning, the agent asks the lattice.
 */
export async function pgslDecide({ agentId, certificates = [] }) {
  const resp = await fetch(`${RELAY}/tool/pgsl_decide`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ agent_id: agentId, certificates }),
  });
  return resp.json();
}

/**
 * Read this agent's own recent trajectory steps.
 *
 * Uses the rev-192 `graph_iri` filter so we get only the agent's
 * trajectory graph, not the whole pod manifest. The relay's
 * default `sort=newest-first` + caller-supplied `limit` gives us
 * "latest N" without truncation.
 */
export async function readMyTrajectory({ agentId, limit = 8 }) {
  const graphIri = `urn:graph:trajectory:${agentSlug(agentId)}`;
  const podUrl = podUrlForAgent(agentId);
  const resp = await fetch(`${RELAY}/tool/discover_context`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      pod_url: podUrl,
      graph_iri: graphIri,
      sort: 'newest-first',
      limit,
    }),
  });
  const j = await resp.json();
  return Array.isArray(j.entries) ? j.entries : [];
}

/**
 * Read a peer's trajectory — same primitive as readMyTrajectory but
 * scoped to another agent's pod. Multi-agent observation: agents
 * can see each other's recent moves without any per-pair RPC, because
 * the substrate IS the shared memory.
 */
export async function readPeerTrajectory({ peerAgentId, limit = 8 }) {
  return readMyTrajectory({ agentId: peerAgentId, limit });
}

// ── helpers ─────────────────────────────────────────────────────────

export function agentSlug(agentId) {
  // For demo agents the agentId looks like `did:ethr:0x...`. Slug =
  // last 12 hex chars of the address, lowercased.
  const m = agentId.match(/0x([0-9a-fA-F]+)/);
  if (m && m[1]) return m[1].slice(-12).toLowerCase();
  // Fallback: hash the whole agentId.
  return createHash('sha256').update(agentId).digest('hex').slice(0, 12);
}

export function podUrlForAgent(agentId) {
  // Each demo agent gets its own demo pod under the gate.
  const gate = process.env.CG_GATE_URL ?? 'https://interego-css-gate.livelysky-8b81abb0.eastus.azurecontainerapps.io';
  return `${gate.replace(/\/$/, '')}/rev195-${agentSlug(agentId)}/`;
}

export function relayUrl() { return RELAY; }
export function foxxiUrl() { return FOXXI; }

/**
 * Read the live Foxxi calibration profile.
 *
 * The replan logic checks this BEFORE planning the next prompt —
 * if a sibling intervention has out-performed by ≥15pts in an
 * Asserted cell, calibrationDrivenReplan rewrites the agent's
 * next move (Tier-3 of the rev-195 work).
 */
export async function readCalibrationProfile() {
  const resp = await fetch(`${FOXXI}/performance/calibration`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({}),
  });
  return resp.json();
}

/**
 * Subscribe to a pod's SSE notification channel (Tier-2.B —
 * SSE-driven wake). Returns an async iterator over events.
 *
 * The controller uses this to drive ticks event-driven instead of
 * polling — the agent wakes the instant a peer publishes anything.
 */
export async function* subscribePodEvents({ podUrl, signal }) {
  const slug = createHash('sha256').update(podUrl).digest('hex').slice(0, 16);
  const url = `${RELAY}/notifications/${slug}`;
  let backoff = 1_000;
  while (!signal?.aborted) {
    try {
      const resp = await fetch(url, { headers: { 'Accept': 'text/event-stream' }, signal });
      if (!resp.ok) {
        await new Promise(r => setTimeout(r, backoff));
        backoff = Math.min(backoff * 2, 30_000);
        continue;
      }
      backoff = 1_000;
      const reader = resp.body.getReader();
      const decoder = new TextDecoder();
      let buf = '';
      while (!signal?.aborted) {
        const { value, done } = await reader.read();
        if (done) break;
        buf += decoder.decode(value, { stream: true });
        let idx;
        while ((idx = buf.indexOf('\n\n')) >= 0) {
          const event = buf.slice(0, idx);
          buf = buf.slice(idx + 2);
          if (/^data:/m.test(event)) yield { kind: 'descriptor-landed', podUrl, at: Date.now() };
        }
      }
    } catch (err) {
      if (signal?.aborted) break;
      await new Promise(r => setTimeout(r, backoff));
      backoff = Math.min(backoff * 2, 30_000);
    }
  }
}
