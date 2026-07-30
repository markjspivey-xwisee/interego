/**
 * Shared per-vertical bridge framework.
 *
 * Per-vertical bridges are the OPTIONAL "Option 1" reification: a
 * small standalone server that exposes a vertical's affordances as
 * named MCP tools (for opinionated clients) AND as direct HTTP
 * endpoints (per the affordance hydra:target).
 *
 * Generic agents don't need this — they discover + invoke via the
 * protocol-level iep:Affordance descriptors. The bridge is just an
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
import {
  decorateShim,
  KERNEL_JSONLD_CONTEXT,
  KERNEL_RESULT_SHAPES,
  toStructuredContent,
  protocolMembersOnly,
  acceptForSdkTransport,
} from '@interego/core';
import {
  createMcpHandler,
  isLegacyRequest,
  ProtocolError,
  Server,
  WebStandardStreamableHTTPServerTransport,
} from '@modelcontextprotocol/server';
import type { Tool } from '@modelcontextprotocol/server';

/**
 * ONE JSON-LD projection of an Affordance, shared by the entry point and the
 * `/affordances` manifest.
 *
 * ★ AN AFFORDANCE A CLIENT CANNOT INVOKE IS NOT AN AFFORDANCE.
 *
 * This projection used to emit only action / toolName / method / target, so a peer
 * discovering 89 capabilities learned the URL and the verb and NOTHING about what to
 * send — no field names, no types, no idea which were required. The only way to call
 * one was to already know, which is exactly the out-of-band knowledge hypermedia
 * exists to remove.
 *
 * Nothing here is invented. Every `Affordance` already declares `title`,
 * `description`, `inputs` and `outputs`; the projection simply dropped them on the
 * way to the wire. `expects` reuses `affordanceToMcpToolSchema` — the SAME derivation
 * the MCP tool listing uses — so the JSON-RPC caller and the hypermedia caller are
 * told the same thing by construction.
 *
 * It lives here rather than inline because two routes now serve it. Two copies of a
 * projection is how the entry point and the manifest start disagreeing about what a
 * capability accepts, and a caller has no way to tell which one lied.
 */
function affordanceJsonLd(a: Affordance, deploymentUrl: string): Record<string, unknown> {
  return {
    '@type': ['iep:Affordance', 'ieh:Affordance', 'hydra:Operation'],
    action: a.action,
    toolName: a.toolName,
    ...(a.title ? { title: a.title } : {}),
    ...(a.description ? { description: a.description } : {}),
    method: a.method,
    target: a.targetTemplate.replace('{base}', deploymentUrl),
    expects: affordanceToMcpToolSchema(a).inputSchema,
    ...(a.mediaType ? { mediaType: a.mediaType } : {}),
    ...(a.returns ? { returns: a.returns } : {}),
    ...(a.outputs?.description ? { returnsDescription: a.outputs.description } : {}),
  };
}

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

  // Validate that every NON-externally-routed affordance has a handler — fail
  // fast on misconfig. externallyRouted affordances are declared for discovery
  // only; their capability is served by a pre-existing hand-coded route, so they
  // need no handler here.
  const missing = opts.affordances
    .filter(a => !a.externallyRouted)
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
    // externallyRouted affordances are served by a pre-existing hand-coded route
    // at their target path — do NOT auto-register (would double-bind the path).
    if (affordance.externallyRouted) continue;
    const path = affordance.targetTemplate.replace('{base}', '');
    const method = affordance.method.toLowerCase() as 'get' | 'post' | 'put' | 'delete' | 'patch';
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (app as any)[method](path, async (req: Request, res: Response) => {
      try {
        const args = req.method === 'GET'
          ? (req.query as Record<string, unknown>)
          : (req.body as Record<string, unknown>);
        const result = await opts.handlers[affordance.toolName]!(args);
        // Hypermedia decoration: wrap the handler's payload in the
        // shared JSON-LD envelope so generic clients see @context /
        // @type / iep:conformsToShape / affordances. The next-step
        // affordance points back at /affordances so callers can
        // discover sibling capabilities from this response alone.
        const payload = (result && typeof result === 'object' && !Array.isArray(result))
          ? result as Record<string, unknown>
          : { result };
        const decorated = decorateShim(payload, {
          tool: affordance.toolName,
          shape: KERNEL_RESULT_SHAPES['result']!,
          types: [affordance.returns ?? `urn:iep:type:${affordance.toolName}-result`],
          nextSteps: [
            {
              action: 'urn:iep:action:discover-affordances',
              target: `${deploymentUrl}/affordances`,
              method: 'GET',
            },
            // Echo the just-invoked affordance back so callers can
            // re-invoke or compare prior/next results.
            {
              action: affordance.action,
              target: affordance.targetTemplate.replace('{base}', deploymentUrl),
              method: affordance.method,
              ...(affordance.mediaType ? { mediaType: affordance.mediaType } : {}),
            },
          ],
        });
        res.type('application/ld+json').json(decorated);
      } catch (err) {
        res.status(400).type('application/ld+json').json({
          '@context': KERNEL_JSONLD_CONTEXT,
          '@type': ['hydra:Status', 'urn:iep:error:AffordanceFailure'],
          error: (err as Error).message,
        });
      }
    });
  }

  // ── MCP endpoint (named tools per affordance) ────────────────────
  //
  // Opinionated clients (Claude Desktop, Code, Cursor) can connect here to get the
  // named MCP-tool surface. Tool schemas are DERIVED from affordances — never
  // hand-written.
  //
  // ★ THIS WAS HAND-ROLLED JSON-RPC ADVERTISING A HARD-CODED `2024-11-05`.
  //
  // It ignored what the client asked for entirely — verified against both live
  // bridges: a client requesting 2026-07-28 was answered 2024-11-05 — implemented
  // exactly four methods, and had no version negotiation of any kind. It now runs on
  // MCP SDK v2, which means one definition serves BOTH protocol eras: the 2025
  // `initialize` handshake and the 2026-07-28 revision, which has no handshake and
  // answers `server/discover` instead.
  //
  // ── Why the LOW-LEVEL Server, not McpServer.registerTool ───────────────────
  //
  // registerTool would add input validation, which this mount has never had. It
  // would also change three behaviours that clients depend on:
  //   1. a throwing handler becomes an isError RESULT instead of a JSON-RPC error,
  //      and the foxxi dashboard reads `j.error.message`
  //   2. an externallyRouted affordance loses the -32601 signpost below, which names
  //      the HTTP method and resolved URL to use instead — a dead end replacing a
  //      direction
  //   3. calls that previously succeeded with missing arguments start being refused,
  //      across seven verticals and ten demo scenarios
  //
  // So this increment moves the PROTOCOL and keeps the SEMANTICS, exactly as the
  // relay does. Input validation is a real improvement and a separate, deliberate
  // behaviour change that needs its client updates alongside it.
  //
  // ── Why the Accept normalisation ───────────────────────────────────────────
  //
  // MEASURED: the SDK's legacy leg answers a POST whose Accept header does not
  // include `text/event-stream` with HTTP 406. Every browser client we ship sends
  // exactly that — no Accept header at all — as do the demo scenarios. So without
  // this the foxxi dashboard, both microsites, LmsContentPanel and ten scenarios all
  // break at once, and silently, since a 406 body is not the shape they parse.
  //
  // `enableJsonResponse` then keeps the reply plain JSON instead of an SSE frame, so
  // those same clients need NO change. It is honoured by the v2 runtime but absent
  // from the published .d.ts, hence the narrow cast at its call site.
  const buildMcpServer = (): Server => {
    const server = new Server(
      { name: `interego-${opts.verticalName}-bridge`, version: '0.1.0' },
      {
        capabilities: { tools: {} },
        instructions: `Bridge for the ${opts.verticalName} vertical. ${opts.affordances.length} affordances exposed as named MCP tools — each derived from a iep:Affordance declaration. Generic agents can also discover + invoke via the protocol's standard affordance-walk; the manifest turtle is at GET /affordances.`,
      },
    );

    server.setRequestHandler('tools/list', async () => ({
      // Every affordance is listed, including the externallyRouted ones that answer
      // with a signpost rather than a result. That is a deliberate hypermedia stance —
      // discoverability over callability — and mcp-wire-contract.test.ts pins it.
      tools: opts.affordances.map(a => affordanceToMcpToolSchema(a)) as unknown as Tool[],
    }));

    server.setRequestHandler('tools/call', async (req) => {
      const toolName = req.params.name;
      const args = (req.params.arguments ?? {}) as Record<string, unknown>;
      const handler = toolName ? opts.handlers[toolName] : undefined;
      if (!handler) {
        const ext = toolName ? opts.affordances.find(a => a.toolName === toolName && a.externallyRouted) : undefined;
        const message = ext
          ? `Tool "${toolName}" is externally-routed: invoke it via HTTP ${ext.method} ${ext.targetTemplate.replace('{base}', deploymentUrl)} (it carries bespoke auth and is not exposed as a named-MCP shim).`
          : `Unknown tool: ${toolName ?? '<undefined>'}`;
        // -32601 (method not found) is kept over the SDK's own "tool not found", and
        // so is the message: for an externallyRouted affordance this response IS the
        // affordance — it tells the caller where to go instead.
        throw new ProtocolError(-32601, message);
      }
      const result = await handler(args);
      // ★ structuredContent is REQUIRED, not a nicety, and it is ADDITIVE.
      //
      // Every derived tool declares an `outputSchema` (see affordance-mcp), and since
      // MCP 2025-06-18 declaring one obliges the tool to return `structuredContent`
      // conforming to it.
      //
      // `content[0].text` KEEPS its stringified payload. The foxxi dashboard SPA and
      // the interego microsite both read and JSON.parse it, so this is strictly an
      // addition — removing or reshaping the text block would break them silently.
      return {
        content: [{ type: 'text' as const, text: JSON.stringify(result) }],
        structuredContent: toStructuredContent(result),
      };
    });

    return server;
  };

  // The MODERN (2026-07-28) leg. `legacy: 'reject'` because the legacy leg is served
  // below with `enableJsonResponse`, which `createMcpHandler` gives no way to set on
  // its own built-in fallback.
  const modernHandler = createMcpHandler(buildMcpServer, {
    legacy: 'reject',
    responseMode: 'json',
    onerror: () => { /* per-request failures surface in the JSON-RPC response */ },
  });

  /**
   * The LEGACY (2025-era) leg, answering plain JSON.
   *
   * `enableJsonResponse` is honoured by the v2 runtime but is not in the published
   * type definitions, hence the cast. Without it the streamable transport SSE-frames
   * every reply, and every browser client we ship calls `res.json()`.
   */
  const serveLegacy = async (request: globalThis.Request): Promise<globalThis.Response> => {
    const server = buildMcpServer();
    const transport = new WebStandardStreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
      enableJsonResponse: true,
    } as unknown as ConstructorParameters<typeof WebStandardStreamableHTTPServerTransport>[0]);
    await server.connect(transport);
    return transport.handleRequest(request);
  };

  const handleMcp = async (req: Request, res: Response): Promise<void> => {
    try {
      const headers = new Headers();
      for (const [k, v] of Object.entries(req.headers)) {
        if (typeof v === 'string') headers.set(k, v);
        else if (Array.isArray(v)) headers.set(k, v.join(', '));
      }
      // ★ Accept normalisation. MEASURED: the streamable transport answers 406 unless
      // the client accepts BOTH application/json and text/event-stream. Every browser
      // client we ship, and every demo scenario, sends no Accept header at all. The
      // reply stays plain JSON either way (see enableJsonResponse / responseMode),
      // so this widens what we accept without changing what we return.
      headers.set('accept', acceptForSdkTransport(headers.get('accept') ?? undefined));
      const hasBody = req.method === 'POST' && req.body !== undefined;
      const request = new globalThis.Request(`http://localhost${req.originalUrl}`, {
        method: req.method,
        headers,
        ...(hasBody ? { body: JSON.stringify(protocolMembersOnly(req.body)) } : {}),
      });

      // `isLegacyRequest` is the entry's OWN classifier, exported — so this routing can
      // never disagree with what createMcpHandler would have decided. A request with no
      // per-request `_meta` envelope claim (which is every 2025-era client, and every
      // bare POST our own clients send) is legacy.
      const out = await isLegacyRequest(request.clone())
        ? await serveLegacy(request)
        : await modernHandler.fetch(request);

      res.status(out.status);
      out.headers.forEach((value, key) => res.setHeader(key, value));
      // Both legs are configured never to stream, so buffering the body is safe. The
      // one always-SSE case is `subscriptions/listen`, and this mount declares no
      // subscription capability.
      res.send(await out.text());
    } catch (err) {
      if (!res.headersSent) {
        res.status(500).json({
          jsonrpc: '2.0',
          id: null,
          error: { code: -32603, message: `MCP transport error: ${(err as Error).message}` },
        });
      }
    }
  };

  app.post('/mcp', handleMcp);
  // 2026-07-28 has no session operations, and the stateless legacy leg answers GET and
  // DELETE with 405. Mounted so that answer comes from the protocol layer rather than
  // Express's own 404.
  app.get('/mcp', handleMcp);
  app.delete('/mcp', handleMcp);

  // ── GET /affordances — protocol-native discovery surface ─────────
  //
  // Returns the iep:Affordance manifest as Turtle. Any agent doing
  // generic affordance discovery can fetch this and walk the entries
  // to find what this vertical exposes — no per-vertical knowledge
  // required at the agent.
  app.get('/affordances', (req, res) => {
    const manifestIri = `${deploymentUrl}/affordances`;
    // ★ CONTENT NEGOTIATION. This route used to answer Turtle unconditionally —
    // `Accept: application/ld+json` and `?format=jsonld` were both ignored, so a
    // JSON-LD client asking correctly got Turtle labelled `text/turtle` and could
    // only cope by disregarding the Content-Type it had asked about. The relay's own
    // /ns projection negotiates properly; the discovery surface every vertical
    // inherits did not.
    //
    // No RDF parser is needed for this: the manifest is GENERATED from the same
    // `Affordance` objects the entry point already projects to JSON-LD, so this is a
    // second serializer over one source, not a format conversion. Both projections
    // call affordanceToMcpToolSchema for `expects`, which is what keeps the
    // hypermedia caller and the JSON-RPC caller from being told different things.
    const wants = String(req.query.format ?? '').toLowerCase()
      || (/application\/ld\+json|application\/json/i.test(String(req.headers.accept ?? '')) ? 'jsonld' : '');
    res.setHeader('Vary', 'Accept');
    if (wants === 'jsonld' || wants === 'json') {
      res.type('application/ld+json').json({
        '@context': KERNEL_JSONLD_CONTEXT,
        '@id': manifestIri,
        '@type': ['hydra:ApiDocumentation', 'iep:AffordanceManifest'],
        label: `${opts.verticalName} affordance manifest`,
        vertical: opts.verticalName,
        affordanceCount: opts.affordances.length,
        affordances: opts.affordances.map(a => affordanceJsonLd(a, deploymentUrl)),
      });
      return;
    }
    const turtle = affordancesManifestTurtle(manifestIri, opts.affordances, deploymentUrl, {
      verticalLabel: `${opts.verticalName} affordance manifest`,
      rdfsComment: `Capabilities exposed by the ${opts.verticalName} vertical bridge. Generic Interego agents discover via this manifest; ergonomic clients use the MCP tool surface at /mcp.`,
    });
    res.type('text/turtle').send(turtle);
  });

  // ── Health + meta ─────────────────────────────────────────────────
  app.get('/', (_req, res) => {
    // Bridge entry point — Hydra-typed so generic clients see this as
    // a `hydra:EntryPoint` document with every affordance reachable
    // by following the embedded operation list. The original keys
    // (vertical, affordanceCount, affordances, mcpEndpoint, ...) are
    // preserved verbatim for backward compat with the readiness probe.
    res.type('application/ld+json').json({
      '@context': KERNEL_JSONLD_CONTEXT,
      '@id': deploymentUrl,
      '@type': ['hydra:EntryPoint', `urn:iep:vertical:${opts.verticalName}`],
      conformsToShape: 'urn:iep:shape:VerticalBridgeEntryPoint',
      vertical: opts.verticalName,
      affordanceCount: opts.affordances.length,
      // ★ AN AFFORDANCE A CLIENT CANNOT INVOKE IS NOT AN AFFORDANCE.
      //
      // This projection used to emit only action / toolName / method / target. So a
      // peer discovering 89 capabilities learned the URL and the verb and NOTHING
      // about what to send — no field names, no types, no idea which were required.
      // The only way to call one was to already know, which is exactly the
      // out-of-band knowledge hypermedia exists to remove. "Capabilities are
      // followable affordances" was true of the link and false of the contract.
      //
      // Nothing here is invented. Every `Affordance` in the source already declares
      // `title`, `description`, `inputs` (name/type/required/description) and
      // `outputs`; the projection simply dropped them on the way to the wire.
      // `expects` reuses `affordanceToMcpToolSchema`, the SAME derivation the MCP
      // tool listing uses — so the JSON-RPC caller and the hypermedia caller are
      // told the same thing by construction, and cannot drift apart.
      affordances: opts.affordances.map(a => affordanceJsonLd(a, deploymentUrl)),
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
