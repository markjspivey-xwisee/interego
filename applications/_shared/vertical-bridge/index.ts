/**
 * Shared per-vertical bridge framework.
 *
 * Per-vertical bridges are the OPTIONAL "Option 1" reification: a
 * small standalone server that exposes a vertical's affordances as
 * named MCP tools (for opinionated clients) AND as direct HTTP
 * endpoints (per the affordance hydra:target).
 *
 * Generic agents don't need this — they discover + invoke via the
 * protocol-level cg:Affordance descriptors. The bridge is just an
 * ergonomic accelerant for clients that prefer named tools.
 *
 * Each vertical wires its own bridge in ~40 lines using this framework:
 *
 *   import { createVerticalBridge } from 'applications/_shared/vertical-bridge';
 *   import { lpcAffordances } from '../affordances';
 *   import { ingestTrainingContent, ... } from '../src/pod-publisher';
 *
 *   const handlers = {
 *     'lpc.ingest_training_content': async (args) => {
 *       const result = await ingestTrainingContent(...);
 *       return result;
 *     },
 *     // ...
 *   };
 *
 *   const app = createVerticalBridge({
 *     verticalName: 'learner-performer-companion',
 *     affordances: lpcAffordances,
 *     handlers,
 *   });
 *   app.listen(parseInt(process.env.PORT ?? '6010'));
 */

import express, { type Request, type Response, type Express } from 'express';
import {
  affordanceToMcpToolSchema,
  affordancesManifestTurtle,
  type Affordance,
} from '../affordance-mcp/index.js';

export type AffordanceHandler = (args: Record<string, unknown>) => Promise<unknown>;

export interface VerticalBridgeOptions {
  /** Display name (e.g., "learner-performer-companion"). */
  readonly verticalName: string;
  /** This vertical's affordance declarations. */
  readonly affordances: ReadonlyArray<Affordance>;
  /** Map from affordance.toolName → handler function. */
  readonly handlers: Record<string, AffordanceHandler>;
  /** Optional: deployment URL the bridge is reachable at; used to substitute
   *  `{base}` in affordance targetTemplates when serving the manifest.
   *  Defaults to env BRIDGE_DEPLOYMENT_URL or http://localhost:<PORT>. */
  readonly deploymentUrl?: string;
  /** Optional: the pod this bridge is configured to write to, surfaced
   *  in `GET /` so a readiness probe can verify it's talking to the
   *  bridge it just spawned (rather than a stale bridge from a prior
   *  run that happens to be holding the same port). */
  readonly defaultPodUrl?: string;
  /** Optional: additional Express middleware to install (e.g., auth). */
  readonly middleware?: (app: Express) => void;
}

export function createVerticalBridge(opts: VerticalBridgeOptions): Express {
  const app = express();
  app.use(express.json({ limit: '50mb' }));

  if (opts.middleware) opts.middleware(app);

  const deploymentUrl = opts.deploymentUrl
    ?? process.env['BRIDGE_DEPLOYMENT_URL']
    ?? `http://localhost:${process.env['PORT'] ?? '6010'}`;

  // Validate that every affordance has a handler — fail fast on misconfig
  const missing = opts.affordances
    .map(a => a.toolName)
    .filter(name => !opts.handlers[name]);
  if (missing.length > 0) {
    throw new Error(`vertical-bridge: affordances missing handlers: ${missing.join(', ')}`);
  }

  // ── Direct HTTP endpoints (per affordance hydra:target) ──────────
  //
  // Generic protocol-level invocation goes through these. Any agent
  // that walked the affordance manifest can POST directly here without
  // needing MCP at all.
  for (const affordance of opts.affordances) {
    const path = affordance.targetTemplate.replace('{base}', '');
    const method = affordance.method.toLowerCase() as 'get' | 'post' | 'put' | 'delete' | 'patch';
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (app as any)[method](path, async (req: Request, res: Response) => {
      try {
        const args = req.method === 'GET'
          ? (req.query as Record<string, unknown>)
          : (req.body as Record<string, unknown>);
        const result = await opts.handlers[affordance.toolName]!(args);
        res.json(result);
      } catch (err) {
        res.status(400).json({ error: (err as Error).message });
      }
    });
  }

  // ── MCP endpoint (named tools per affordance) ────────────────────
  //
  // Opinionated clients (Claude Desktop, Code, Cursor) can connect
  // here to get the named MCP-tool surface. Tool schemas are DERIVED
  // from affordances — never hand-written.
  app.post('/mcp', async (req: Request, res: Response) => {
    const body = req.body as { jsonrpc?: string; id?: number | string | null; method?: string; params?: Record<string, unknown> };
    const { id = null, method, params } = body;

    if (method === 'initialize') {
      res.json({
        jsonrpc: '2.0', id,
        result: {
          protocolVersion: '2024-11-05',
          capabilities: { tools: {} },
          serverInfo: { name: `interego-${opts.verticalName}-bridge`, version: '0.1.0' },
          instructions: `Bridge for the ${opts.verticalName} vertical. ${opts.affordances.length} affordances exposed as named MCP tools — each derived from a cg:Affordance declaration. Generic agents can also discover + invoke via the protocol's standard affordance-walk; the manifest turtle is at GET /affordances.`,
        },
      });
      return;
    }

    if (method === 'tools/list') {
      const tools = opts.affordances.map(a => affordanceToMcpToolSchema(a));
      res.json({ jsonrpc: '2.0', id, result: { tools } });
      return;
    }

    if (method === 'tools/call') {
      const toolName = params?.['name'] as string | undefined;
      const args = (params?.['arguments'] as Record<string, unknown> | undefined) ?? {};
      const handler = toolName ? opts.handlers[toolName] : undefined;
      if (!handler) {
        res.json({ jsonrpc: '2.0', id, error: { code: -32601, message: `Unknown tool: ${toolName ?? '<undefined>'}` } });
        return;
      }
      try {
        const result = await handler(args);
        res.json({ jsonrpc: '2.0', id, result: { content: [{ type: 'text', text: JSON.stringify(result) }] } });
      } catch (err) {
        res.json({ jsonrpc: '2.0', id, error: { code: -32000, message: (err as Error).message } });
      }
      return;
    }

    if (method === 'notifications/initialized') {
      res.status(204).end();
      return;
    }

    res.json({ jsonrpc: '2.0', id, error: { code: -32601, message: `Unknown method: ${method ?? '<undefined>'}` } });
  });

  // ── GET /affordances — protocol-native discovery surface ─────────
  //
  // Returns the cg:Affordance manifest as Turtle. Any agent doing
  // generic affordance discovery can fetch this and walk the entries
  // to find what this vertical exposes — no per-vertical knowledge
  // required at the agent.
  app.get('/affordances', (_req, res) => {
    const manifestIri = `${deploymentUrl}/affordances`;
    const turtle = affordancesManifestTurtle(manifestIri, opts.affordances, deploymentUrl, {
      verticalLabel: `${opts.verticalName} affordance manifest`,
      rdfsComment: `Capabilities exposed by the ${opts.verticalName} vertical bridge. Generic Interego agents discover via this manifest; ergonomic clients use the MCP tool surface at /mcp.`,
    });
    res.type('text/turtle').send(turtle);
  });

  // ── Health + meta ─────────────────────────────────────────────────
  app.get('/', (_req, res) => {
    res.json({
      vertical: opts.verticalName,
      affordanceCount: opts.affordances.length,
      affordances: opts.affordances.map(a => ({
        action: a.action,
        toolName: a.toolName,
        method: a.method,
        target: a.targetTemplate.replace('{base}', deploymentUrl),
      })),
      mcpEndpoint: `${deploymentUrl}/mcp`,
      manifestEndpoint: `${deploymentUrl}/affordances`,
      // `pod` is what the readiness probe (demos/agent-lib.ts) checks
      // against the URL it spawned the bridge with — guards against
      // succeeding-against-a-stale-bridge.
      pod: opts.defaultPodUrl,
    });
  });

  return app;
}
