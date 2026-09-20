/**
 * Publishing to a pod through the Interego relay's MCP surface (Streamable HTTP JSON-RPC):
 * publish_context for a judgment's payload graph, record_trajectory_step for the harness's
 * own loop. The relay is the authority for facets, signing, encryption and supersession, so
 * only the payload triples travel; the local descriptor TriG is for offline use.
 *
 * Needs INTEREGO_BEARER (a relay session token). Without it the bridge still writes every
 * artifact locally and reports publish: 'skipped'.
 */

import type { Published } from './descriptor.js';
import { modalStatus } from './descriptor.js';

export interface RelayConfig {
  readonly url: string;
  readonly bearer: string;
  readonly fetchImpl?: typeof fetch;
}

export interface ToolCallResult {
  readonly raw: unknown;
  readonly structured: Record<string, unknown> | undefined;
  readonly text: string | undefined;
  readonly isError: boolean;
}

export class RelayClient {
  private sessionId: string | undefined;
  private nextId = 1;
  private readonly fetchImpl: typeof fetch;
  constructor(private readonly cfg: RelayConfig) {
    this.fetchImpl = cfg.fetchImpl ?? fetch;
  }

  async initialize(): Promise<void> {
    const res = await this.rpc('initialize', {
      protocolVersion: '2025-06-18',
      capabilities: {},
      clientInfo: { name: 'jev-harness', version: '0.1.0' },
    });
    if (res.sessionId) this.sessionId = res.sessionId;
    await this.notify('notifications/initialized');
  }

  async callTool(name: string, args: Record<string, unknown>): Promise<ToolCallResult> {
    if (this.sessionId === undefined) await this.initialize();
    const res = await this.rpc('tools/call', { name, arguments: args });
    const result = (res.body as { result?: Record<string, unknown>; error?: { message?: string } });
    if (result.error) throw new Error(`relay tools/call ${name} failed: ${result.error.message ?? JSON.stringify(result.error)}`);
    const r = result.result ?? {};
    const content = (r['content'] as Array<{ type: string; text?: string }> | undefined) ?? [];
    const text = content.find((c) => c.type === 'text')?.text;
    let structured = r['structuredContent'] as Record<string, unknown> | undefined;
    if (!structured && text) {
      try { structured = JSON.parse(text) as Record<string, unknown>; } catch { /* plain text result */ }
    }
    return { raw: r, structured, text, isError: Boolean(r['isError']) };
  }

  private async notify(method: string): Promise<void> {
    await this.fetchImpl(this.cfg.url, {
      method: 'POST',
      headers: this.headers(),
      body: JSON.stringify({ jsonrpc: '2.0', method }),
    }).catch(() => undefined);
  }

  private headers(): Record<string, string> {
    return {
      Authorization: `Bearer ${this.cfg.bearer}`,
      'Content-Type': 'application/json',
      Accept: 'application/json, text/event-stream',
      'MCP-Protocol-Version': '2025-06-18',
      ...(this.sessionId ? { 'Mcp-Session-Id': this.sessionId } : {}),
    };
  }

  private async rpc(method: string, params: Record<string, unknown>): Promise<{ body: unknown; sessionId?: string }> {
    const id = this.nextId++;
    const res = await this.fetchImpl(this.cfg.url, {
      method: 'POST',
      headers: this.headers(),
      body: JSON.stringify({ jsonrpc: '2.0', id, method, params }),
    });
    const sessionId = res.headers.get('mcp-session-id') ?? undefined;
    const text = await res.text();
    if (!res.ok) throw new Error(`relay ${method} responded ${res.status}: ${text.slice(0, 300)}`);
    const contentType = res.headers.get('content-type') ?? '';
    const body = contentType.includes('text/event-stream') ? lastJsonRpcMessage(text, id) : JSON.parse(text);
    return sessionId ? { body, sessionId } : { body };
  }
}

/** The JSON-RPC response for `id` out of an SSE stream. */
export function lastJsonRpcMessage(sse: string, id: number): unknown {
  let match: unknown;
  for (const chunk of sse.split(/\n\n+/)) {
    const data = chunk.split('\n').filter((l) => l.startsWith('data:')).map((l) => l.slice(5).trim()).join('\n');
    if (!data) continue;
    try {
      const msg = JSON.parse(data) as { id?: number };
      if (msg.id === id) match = msg;
    } catch { /* keep-alive or partial */ }
  }
  if (match === undefined) throw new Error('relay returned an event stream without a matching JSON-RPC response');
  return match;
}

export function relayFromEnv(): RelayClient | null {
  const bearer = process.env['INTEREGO_BEARER'];
  if (!bearer) return null;
  return new RelayClient({ url: process.env['INTEREGO_RELAY_URL'] ?? 'https://relay.interego.xwisee.com/mcp', bearer });
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

/** publish_context with the judgment's payload as graph_content; the relay adds the facets. */
export async function publishJudgment(relay: RelayClient, j: Published, payloadTurtle: string, opts: PublishOptions = {}): Promise<PublishReceipt> {
  const args: Record<string, unknown> = {
    graph_iri: opts.graphIri ?? j.graphIri,
    graph_content: payloadTurtle,
    modal_status: modalStatus(j),
    confidence: j.confidence,
    visibility: opts.visibility ?? 'shared',
    auto_supersede_prior: true,
    sign_authorship: opts.signAuthorship ?? true,
  };
  if (opts.ifMatch) args['if_match'] = opts.ifMatch;
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
