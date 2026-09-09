/** One tool factory, two protocol eras. Legacy URL elicitation needs an initialized session. */
import { createHash, randomUUID } from 'node:crypto';
import { createMcpHandler, isLegacyRequest, type McpServerFactory, type Server } from '@modelcontextprotocol/server';
import { NodeStreamableHTTPServerTransport, toNodeHandler, toWebRequest } from '@modelcontextprotocol/node';
import type { RequestHandler, Request } from 'express';
import type { AuthInfo } from '@modelcontextprotocol/server';

export function createRelayMcpHandler(factory: (context: Parameters<McpServerFactory>[0]) => Server | Promise<Server>, onerror: (error: Error) => void = () => {}) {
  const modern = createMcpHandler(factory, { legacy: 'stateless', onerror });
  const node = toNodeHandler(modern, { onerror });
  const sessions = new Map<string, { transport: NodeStreamableHTTPServerTransport; server: Server; owner: string; touched: number }>();
  const owner = (req: Request) => {
    const auth = (req as Request & { auth?: AuthInfo }).auth;
    return createHash('sha256').update(JSON.stringify(auth
      ? [auth.clientId, auth.extra?.['userId'], auth.extra?.['agentId']]
      : [req.headers.authorization ?? '', req.ip])).digest('hex');
  };
  const prune = setInterval(() => {
    for (const [id, session] of sessions) if (Date.now() - session.touched > 30 * 60_000) {
      sessions.delete(id); void session.server.close().catch(onerror);
    }
  }, 60_000);
  prune.unref();
  const handler: RequestHandler = (req, res) => { void (async () => {
    const sid = req.headers['mcp-session-id'];
    if (typeof sid === 'string') {
      const session = sessions.get(sid);
      if (!session || session.owner !== owner(req)) { res.status(404).json({ error: 'MCP session not found; initialize a new session' }); return; }
      session.touched = Date.now();
      await session.transport.handleRequest(req, res, req.body);
      return;
    }
    // Clients that skip initialize retain their existing stateless fallback, and
    // receive a short authenticated link instead of unsupported server requests.
    if (req.method !== 'POST' || req.body?.method !== 'initialize'
      || !await isLegacyRequest(await toWebRequest(req, req.body), req.body)) {
      await node(req, res, req.body); return;
    }
    if (sessions.size >= 1024) { res.status(503).json({ error: 'MCP session capacity reached; retry later' }); return; }
    let sessionId: string | undefined;
    const auth = (req as Request & { auth?: AuthInfo }).auth;
    const server = await factory({ era: 'legacy', authInfo: auth, requestInfo: await toWebRequest(req, req.body) });
    const transport = new NodeStreamableHTTPServerTransport({ sessionIdGenerator: randomUUID,
      onsessioninitialized: id => { sessionId = id; sessions.set(id, { transport, server, owner: owner(req), touched: Date.now() }); },
    });
    transport.onclose = () => { if (sessionId) sessions.delete(sessionId); };
    await server.connect(transport);
    await transport.handleRequest(req, res, req.body);
    if (!sessionId) await server.close();
  })().catch(error => { onerror(error as Error); if (!res.headersSent) res.status(500).json({ error: 'MCP request failed' }); }); };
  return { handler, async close() { clearInterval(prune); await Promise.all([...sessions.values()].map(session => session.server.close())); sessions.clear(); await modern.close(); } };
}
