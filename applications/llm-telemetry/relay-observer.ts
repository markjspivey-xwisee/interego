import { randomUUID } from 'node:crypto';
import type { RequestObserver, RequestObservationContext } from '../../deploy/mcp-relay/request-observers.js';

const authority = 'https://foxxi-bridge.interego.xwisee.com/affordances';
const actionBase = 'https://relay.interego.xwisee.com/ns/iep/action/llm-telemetry/';
interface Policy { revision: number; server_enabled: boolean }
function body(text: string): Record<string, unknown> {
  const transport = JSON.parse(text) as { status?: number; body?: unknown };
  if (transport.status !== 200) throw new Error('observation action refused');
  const value: unknown = typeof transport.body === 'string' ? JSON.parse(transport.body) : transport.body;
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('invalid observation response');
  return value as Record<string, unknown>;
}
export function createRelayObserver(): RequestObserver {
  const cache = new Map<string, { expires: number; policy: Policy }>();
  const policy = async (context: RequestObservationContext): Promise<Policy> => {
    const cached = cache.get(context.principal);
    if (cached && cached.expires > Date.now()) return cached.policy;
    const value = body(await context.follow(authority, `${actionBase}capture-read`, {})).preferences as Policy | undefined;
    if (!value || !Number.isSafeInteger(value.revision) || typeof value.server_enabled !== 'boolean') throw new Error('invalid capture preferences');
    if (cache.size >= 2000) cache.delete(cache.keys().next().value!);
    cache.set(context.principal, { expires: Date.now() + 30_000, policy: value });
    return value;
  };
  return {
    id: 'interego-relay-telemetry',
    async begin(context) {
      const selector = context.selector;
      // Management, reporting and delivery are never recursively observed.
      // A setting change invalidates this process's policy immediately. Every
      // ingest also rechecks durable consent, including other relay processes.
      if (selector && (selector.action?.startsWith(actionBase)
        || selector.action?.startsWith('urn:iep:action:llm-telemetry:')
        || selector.reference.startsWith('https://foxxi-bridge.interego.xwisee.com/llm-telemetry')
        || selector.reference.startsWith('https://foxxi-bridge.interego.xwisee.com/agent/llm-telemetry'))) {
        cache.delete(context.principal); return undefined;
      }
      const preferences = await policy(context);
      if (!preferences.server_enabled) return undefined;
      const startedAt = context.now(); const id = randomUUID();
      const common = { source: 'interego-relay', session_id: `relay-day-${startedAt.slice(0,10)}`,
        session_scope: 'relay-day', tool_use_id: id, agent_id: context.principal, tool_name: context.tool,
        capture_mode: 'live', coverage: 'server-observation', initiator_kind: 'unknown' };
      return {
        async finish(failed, finishedAt) {
          // Ship a matched pair after the actual call returns. No result body is
          // read and no domain success is inferred from a transport return.
          const events = [
            { ...common, kind: 'tool-started', source_event_id: `${id}:start`, observed_at: startedAt },
            { ...common, kind: failed ? 'tool-failed' : 'tool-completed', source_event_id: `${id}:end`, observed_at: finishedAt, status: failed ? 'error' : 'unknown' },
          ];
          const receipt = body(await context.follow(authority, `${actionBase}ingest`, { events, capture_revision: preferences.revision }));
          if (receipt.durable !== true || !Array.isArray(receipt.statementIds) || receipt.statementIds.length !== 2) throw new Error('durable telemetry delivery unconfirmed');
          return { status: 'durable', source: 'interego-relay', statementIds: receipt.statementIds };
        },
      };
    },
  };
}
export default createRelayObserver();
