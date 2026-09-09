import { inputRequired, PROTOCOL_VERSION_META_KEY, CLIENT_CAPABILITIES_META_KEY, type Server, type ServerContext, type ClientCapabilities } from '@modelcontextprotocol/server';
import { resourceActionResponse } from './resource-compositions.js';

const watchers = new WeakMap<Server, Map<string, ReturnType<typeof setTimeout>>>();

async function waitForCompletion(context: ServerContext, status: () => Promise<Record<string, unknown>>) {
  const deadline = Date.now() + 55_000;
  let current = await status();
  while (['pending', 'reviewing', 'submitting'].includes(String(current['status']))
    && Date.now() < deadline && !context.mcpReq.signal.aborted) {
    await new Promise<void>(resolve => {
      const timer = setTimeout(done, 1000);
      function done() { clearTimeout(timer); context.mcpReq.signal.removeEventListener('abort', done); resolve(); }
      context.mcpReq.signal.addEventListener('abort', done, { once: true });
    });
    current = await status();
  }
  return current;
}

function notifyWhenComplete(server: Server, id: string, expiresAt: string, status: () => Promise<Record<string, unknown>>) {
  let active = watchers.get(server);
  if (!active) {
    active = new Map(); watchers.set(server, active);
    const prior = server.onclose;
    server.onclose = () => { for (const timer of active!.values()) clearTimeout(timer); active!.clear(); prior?.(); };
  }
  if (active.has(id)) return;
  const deadline = Math.min(Date.parse(expiresAt), Date.now() + 30 * 60_000);
  const poll = async () => {
    if (!active!.has(id)) return;
    if (Date.now() > deadline) { active!.delete(id); return; }
    try {
      const current = await status();
      if (!active!.has(id)) return; // The session may have closed during the read.
      if (!['pending', 'reviewing', 'submitting'].includes(String(current['status']))) {
        // This Server belongs to one authenticated legacy session. Never use the
        // shared subscription bus, which would disclose IDs to other clients.
        await server.notification({ method: 'notifications/elicitation/complete', params: { elicitationId: id } });
        active!.delete(id);
        return;
      }
    } catch { /* A transient storage failure does not lose the durable handoff. */ }
    if (active!.has(id)) schedule();
  };
  const schedule = () => { const timer = setTimeout(() => { void poll(); }, 2000); timer.unref(); active!.set(id, timer); };
  schedule();
}

/** URL acceptance is permission to open a page, never a signature or an approval. */
export async function clientInteractionMcpResult(
  initial: Record<string, unknown>, server: Server, context: ServerContext,
  lifecycle: { status: () => Promise<Record<string, unknown>>; cancel: () => Promise<Record<string, unknown>> },
  invocation?: { reference: string; action: string },
) {
  const id = String(initial['id']);
  const pending = (value: Record<string, unknown>) => ['pending', 'reviewing', 'submitting'].includes(String(value['status']));
  const textResult = (value: Record<string, unknown>) => {
    // The compatibility shim promises an HTTP response. Keep lifecycle state in
    // its JSON body on EVERY return path, including reconnect and cancellation.
    const response = invocation ? { ...resourceActionResponse(invocation.reference, invocation.action, value, 'write'),
      ...(pending(value) ? { status: 202, statusText: 'Accepted' } : {}) } : value;
    return { content: [{ type: 'text' as const, text: JSON.stringify(response) }], structuredContent: response,
      ...(value['status'] === 'failed' ? { isError: true } : {}) };
  };
  if (!pending(initial)) return textResult(initial);
  const envelope = context.mcpReq.envelope as Record<string, unknown> | undefined;
  const modern = typeof envelope?.[PROTOCOL_VERSION_META_KEY] === 'string';
  const capabilities = modern ? envelope?.[CLIENT_CAPABILITIES_META_KEY] as ClientCapabilities | undefined : server.getClientCapabilities();
  const urlSupported = capabilities?.elicitation && Object.prototype.hasOwnProperty.call(capabilities.elicitation, 'url');
  if (!urlSupported) return textResult({ ...initial,
    interactionDelivery: { urlElicitation: 'not-advertised', viewerTool: 'render_hmd', viewerArguments: { descriptor_url: initial['descriptorUrl'] } },
    message: 'The signing panel opens in hosts supporting MCP Apps. If it did not open, call render_hmd with descriptor_url equal to descriptorUrl. The panel provides the signing button and checks completion automatically. URL elicitation was not advertised on this request. If this host cannot show either interface, report that limitation and provide a clickable signingUrl, never a code block or copy-paste instructions. A pending request is not an approval.' });
  const message = 'Review and sign this action with your registered key. The signed action will be verified and submitted automatically.';
  if (modern) {
    const response = context.mcpReq.inputResponses?.['sign'] as { action?: string } | undefined;
    if (response?.action === 'cancel' || response?.action === 'decline') return textResult(await lifecycle.cancel());
    // The response is untrusted. Only the durable result of signature verification
    // can complete this tool. Modern clients resume after the URL ceremony.
    const current = await lifecycle.status();
    if (!pending(current)) return textResult(current);
    if (response?.action === 'accept') {
      // A host may acknowledge opening the URL before signing finishes. Wait for
      // the actual result instead of repeatedly asking it to open the same page.
      const completed = await waitForCompletion(context, lifecycle.status);
      return textResult(pending(completed) ? { ...completed,
        message: 'Signing remains pending. Submission is automatic; follow the authenticated status control to retrieve its result.' } : completed);
    }
    return inputRequired({ requestState: id,
      inputRequests: { sign: inputRequired.elicitUrl({ message, url: String(initial['signingUrl']) }) } });
  }
  const consent = await context.mcpReq.elicitInput({ mode: 'url', elicitationId: id, message, url: String(initial['signingUrl']) },
    { relatedRequestId: context.mcpReq.id, signal: context.mcpReq.signal, timeout: 600_000 });
  if (consent.action !== 'accept') return textResult(await lifecycle.cancel());
  // Keep this initiating request alive for a bounded human ceremony; polling is
  // durable across replicas, and the status affordance survives disconnect/restart.
  const current = await waitForCompletion(context, lifecycle.status);
  if (!pending(current)) {
    await context.mcpReq.notify({ method: 'notifications/elicitation/complete', params: { elicitationId: id } });
    return textResult(current);
  }
  notifyWhenComplete(server, id, String(initial['expiresAt']), lifecycle.status);
  return textResult({ ...await lifecycle.status(), message: 'Signing is still pending. Completion will be reported to this MCP session; the authenticated status affordance returns its automatically submitted result.' });
}
