/**
 * Substrate client — talks to the generic interego-bridge over its /mcp surface.
 * Capabilities are DISCOVERED (tools/list) then INVOKED (tools/call) — the emergent
 * discover→act loop. There are NO hardcoded capability paths here: callTool refuses
 * to invoke anything not present in the bridge's published manifest.
 */
export const BRIDGE_URL =
  (import.meta.env.VITE_INTEREGO_BRIDGE_URL as string | undefined) ?? 'http://localhost:6058';

let _manifest: string[] | null = null;

/** Discover the bridge's published capability manifest (tools/list). */
export async function discoverTools(): Promise<string[]> {
  if (_manifest) return _manifest;
  const r = await fetch(`${BRIDGE_URL}/mcp`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
  });
  const j = await r.json();
  _manifest = (j.result?.tools ?? []).map((t: { name: string }) => t.name);
  return _manifest!;
}

/** Invoke a discovered capability (tools/call). Throws if it isn't in the manifest
 *  — you cannot POST a path you "just know"; you follow a published affordance. */
export async function callTool(name: string, args: Record<string, unknown>): Promise<any> {
  const manifest = await discoverTools();
  if (!manifest.includes(name)) throw new Error(`capability "${name}" is not in the bridge's published manifest — cannot invoke`);
  const r = await fetch(`${BRIDGE_URL}/mcp`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: Date.now(), method: 'tools/call', params: { name, arguments: args } }),
  });
  const j = await r.json();
  if (j.error) throw new Error(j.error.message);
  const text = j.result?.content?.[0]?.text;
  return text ? JSON.parse(text) : j.result;
}
