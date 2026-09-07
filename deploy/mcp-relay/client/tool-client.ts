/** MCP transport helpers shared by the browser adapter and its boundary tests. */
export type ToolObject = Record<string, any>;
export type CallTool = (name: string, args: ToolObject) => Promise<unknown>;

export function unpackToolResult(raw: unknown): ToolObject {
  const result = raw as ToolObject;
  if (result?.isError) {
    const message = result.content?.find((item: ToolObject) => item.type === 'text')?.text;
    throw new Error(typeof message === 'string' ? message : 'Interego refused the request.');
  }
  let value = result?.structuredContent;
  if (!value && Array.isArray(result?.content)) {
    const text = result.content.find((item: ToolObject) => item.type === 'text')?.text;
    if (typeof text === 'string') value = JSON.parse(text);
  }
  value ??= result;
  if (typeof value?.status === 'number' && value.status >= 400) throw new Error(String(value.error ?? 'Interego refused the request.'));
  if (typeof value?.body === 'string') value = JSON.parse(value.body);
  if (!value || typeof value !== 'object' || value.error) throw new Error(String(value?.message ?? value?.error ?? 'Invalid Interego response.'));
  return value;
}

export async function readEncryptedGraph(callTool: CallTool, relay: string, url: string, checkIdentity: () => void): Promise<ToolObject> {
  // This reader is explicitly read-side: mcp:read must not need act's write scope.
  try {
    checkIdentity();
    return unpackToolResult(await callTool('get_encrypted_graph', { url }));
  } catch (error) {
    const failure = error as { code?: unknown; message?: unknown };
    if (failure?.code !== -32601 && !/Unknown tool:\s*get_encrypted_graph\b/i.test(String(failure?.message))) throw error;
  }
  // Only an explicitly stale tool list takes the older discovery route. A denied
  // scope, failed read or authentication error is never retried through act.
  return readEncryptedGraphViaDiscovery(callTool, relay, url, checkIdentity);
}

/** Explicit compatibility read for hosts whose cached catalog omits the reader.
 * This is also used after an unambiguous method-not-found response. An ambiguous
 * host error never selects it automatically; the user can select it in the UI.
 * Both calls retain the relay's normal authentication and scope enforcement.
 */
export async function readEncryptedGraphViaDiscovery(callTool: CallTool, relay: string, url: string, checkIdentity: () => void): Promise<ToolObject> {
  checkIdentity();
  const surface = unpackToolResult(await callTool('act', { target: `${relay}/tools`, action: 'read', method: 'GET' }));
  const reader = surface['hydra:member']?.find((tool: ToolObject) => tool.name === 'get_encrypted_graph');
  const affordance = reader?.affordances?.find((a: ToolObject) => a.method === 'POST' && a.action === 'urn:iep:action:invoke:get_encrypted_graph');
  if (!affordance || new URL(affordance.target).origin !== relay) throw new Error('Interego did not publish a usable encrypted reader.');
  checkIdentity();
  return unpackToolResult(await callTool('act', { target: affordance.target, action: affordance.action, method: 'POST', payload: { url } }));
}
