/**
 * Publishing to a pod through the Interego relay's MCP surface (Streamable HTTP JSON-RPC):
 * publish_context for a judgment's payload graph, record_trajectory_step for the harness's
 * own loop. The relay is the authority for facets, signing, encryption and supersession, so
 * only the payload triples travel; the local descriptor TriG is for offline use.
 *
 * The agent machinery — the Ed25519 key and the did:key it names, the relay OAuth flow that
 * mints tokens from it, the MCP client that renews them — lives in
 * applications/_shared/relay-agent since 2026-09-21, because the fleet's own operations publish
 * the same way (tools/fleet-event.ts). It is re-exported here so the bridge, the CLI and the
 * tests keep one import path.
 *
 * Two ways in:
 *   - INTEREGO_AGENT_KEY_JSON: an Ed25519 OKP JWK (x and d). The bridge is then its own
 *     agent with a did:key, and it mints relay tokens itself through the relay's OAuth 2.1
 *     flow (dynamic client registration, PKCE, a did-sig challenge from the identity server,
 *     /oauth/verify with method "did", then /token). Tokens live an hour; the minter re-mints
 *     before they lapse and after a 401. INTEREGO_POD_NAME names the pod the judgments land
 *     on when it is not the agent's own, which is the delegate case: the pod owner registers
 *     the agent there with a publishing scope, and every descriptor is attributed to the agent
 *     on behalf of the owner.
 *   - INTEREGO_BEARER: a relay session token pasted in by hand; it lasts an hour.
 *
 * Without either, the bridge still writes every artifact locally and reports publish: 'skipped'.
 */

import { DEFAULT_RELAY_URL, DidTokenMinter, RelayClient, agentKeyFromJwk, type ToolCallResult } from '../../_shared/relay-agent/index.js';
import type { Published } from './descriptor.js';
import { modalStatus } from './descriptor.js';

export {
  DEFAULT_RELAY_URL, DidTokenMinter, RelayClient, agentKeyFromJwk, base58btc, generateAgentKeyJwk, lastJsonRpcMessage, signNonce,
} from '../../_shared/relay-agent/index.js';
export type { AgentKey, MinterConfig, RelayConfig, TokenSource, ToolCallResult } from '../../_shared/relay-agent/index.js';

/**
 * The relay client the environment describes, or null when nothing is configured.
 * INTEREGO_AGENT_KEY_JSON wins over INTEREGO_BEARER: a key renews itself, a pasted token lapses.
 */
export function relayFromEnv(): RelayClient | null {
  const url = process.env['INTEREGO_RELAY_URL'] ?? DEFAULT_RELAY_URL;
  const podName = process.env['INTEREGO_POD_NAME'];
  const keyJson = process.env['INTEREGO_AGENT_KEY_JSON'];
  if (keyJson) {
    const minter = new DidTokenMinter({
      relayOrigin: new URL(url).origin,
      key: agentKeyFromJwk(keyJson),
      clientName: process.env['INTEREGO_CLIENT_NAME'] ?? 'jev-harness-bridge',
    });
    return new RelayClient({ url, bearer: minter, clientName: 'jev-harness', ...(podName ? { podName } : {}) });
  }
  const bearer = process.env['INTEREGO_BEARER'];
  if (!bearer) return null;
  return new RelayClient({ url, bearer, clientName: 'jev-harness', ...(podName ? { podName } : {}) });
}

export interface PublishOptions {
  readonly visibility?: 'public' | 'shared' | 'private';
  /** Descriptor URL or CID of the chain head this publish supersedes (CAS). */
  readonly ifMatch?: string;
  readonly signAuthorship?: boolean;
  /**
   * Publish under another graph IRI. An Outcome is published as the NEXT VERSION of the
   * judgment's own graph (Asserted, superseding the Hypothetical head) so the relay's
   * iep:supersedes chain, get_current_head and reduce_chain all see the flip; locally the
   * outcome keeps its own graph IRI and carries iep:supersedes on its descriptor.
   */
  readonly graphIri?: string;
}

export interface PublishReceipt {
  readonly descriptorUrl?: string;
  readonly graphUrl?: string;
  readonly previousHeadCid?: string;
  readonly raw: unknown;
}

export interface GraphPublish {
  readonly graphIri: string;
  readonly content: string;
  readonly modalStatus: 'Asserted' | 'Hypothetical';
  readonly confidence?: number;
  readonly visibility?: 'public' | 'shared' | 'private';
  readonly ifMatch?: string;
  readonly signAuthorship?: boolean;
}

/** publish_context with the judgment's payload as graph_content; the relay adds the facets. */
export function publishJudgment(relay: RelayClient, j: Published, payloadTurtle: string, opts: PublishOptions = {}): Promise<PublishReceipt> {
  return publishGraph(relay, {
    graphIri: opts.graphIri ?? j.graphIri,
    content: payloadTurtle,
    modalStatus: modalStatus(j),
    confidence: j.confidence,
    ...(opts.visibility ? { visibility: opts.visibility } : {}),
    ...(opts.ifMatch ? { ifMatch: opts.ifMatch } : {}),
    ...(opts.signAuthorship !== undefined ? { signAuthorship: opts.signAuthorship } : {}),
  });
}

/**
 * publish_context for any payload graph the harness authors — a judgment, its outcome, the
 * calibration view, the attestation — as the delegate on the owner's pod, superseding the
 * graph's previous head.
 */
export async function publishGraph(relay: RelayClient, g: GraphPublish): Promise<PublishReceipt> {
  const args: Record<string, unknown> = {
    graph_iri: g.graphIri,
    graph_content: g.content,
    modal_status: g.modalStatus,
    ...(g.confidence !== undefined ? { confidence: g.confidence } : {}),
    visibility: g.visibility ?? 'shared',
    auto_supersede_prior: true,
    sign_authorship: g.signAuthorship ?? true,
  };
  if (g.ifMatch) args['if_match'] = g.ifMatch;
  if (relay.podName) args['pod_name'] = relay.podName;
  if (relay.agentDid) args['agent_did'] = relay.agentDid;
  const r = await relay.callTool('publish_context', args);
  if (r.isError) throw new Error(`publish_context returned an error: ${r.text ?? JSON.stringify(r.raw)}`);
  const s = r.structured ?? {};
  return {
    ...(typeof s['descriptorUrl'] === 'string' ? { descriptorUrl: s['descriptorUrl'] } : {}),
    ...(typeof s['graphUrl'] === 'string' ? { graphUrl: s['graphUrl'] } : {}),
    ...(typeof s['previousHeadCid'] === 'string' ? { previousHeadCid: s['previousHeadCid'] } : {}),
    raw: r.raw,
  };
}

export interface TrajectoryStep {
  readonly verb: string;
  readonly objectName: string;
  readonly modalStatus?: 'Asserted' | 'Hypothetical' | 'Counterfactual';
  readonly resultSuccess?: boolean;
  readonly resultQuality?: number;
  readonly resultNote?: string;
  readonly wasDerivedFrom?: readonly string[];
  readonly sessionId?: string;
}

export async function recordTrajectoryStep(relay: RelayClient, step: TrajectoryStep): Promise<ToolCallResult> {
  return relay.callTool('record_trajectory_step', {
    verb: step.verb,
    object_name: step.objectName,
    granularity: 'tool-call',
    modal_status: step.modalStatus ?? 'Asserted',
    ...(step.resultSuccess !== undefined ? { result_success: step.resultSuccess } : {}),
    ...(step.resultQuality !== undefined ? { result_quality: step.resultQuality } : {}),
    ...(step.resultNote ? { result_note: step.resultNote } : {}),
    ...(step.wasDerivedFrom ? { was_derived_from: [...step.wasDerivedFrom] } : {}),
    ...(step.sessionId ? { session_id: step.sessionId } : {}),
  });
}
