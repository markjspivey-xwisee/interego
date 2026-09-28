#!/usr/bin/env tsx
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  buildToolSurface,
  declaredToolResolver,
  MCP_RELAY_VERSION,
  mcpServerVersion,
} from '../tool-surface.js';
import { stripComments } from './strip-comments.js';

const relayPackage = JSON.parse(
  readFileSync(fileURLToPath(new URL('../package.json', import.meta.url)), 'utf8'),
) as { version?: string };
assert.equal(relayPackage.version, MCP_RELAY_VERSION, 'MCP server and package versions stay aligned');

const registry = {
  act: { description: 'Follow a declared affordance.' },
  execute: { description: 'Execute a verified action.' },
};
const schemas = [
  {
    name: 'execute',
    description: 'Execute a verified action.',
    inputSchema: {
      properties: {
        catalog_graph_iri: { description: 'Graph selector.', type: 'string' },
        payload: { additionalProperties: true, type: 'object' },
      },
      required: ['payload'],
      type: 'object',
    },
  },
  {
    name: 'act',
    description: 'Follow a declared affordance.',
    inputSchema: {
      properties: { target: { type: 'string' } },
      required: ['target'],
      type: 'object',
    },
  },
] as const;

const surface = buildToolSurface(registry, schemas);
assert.deepEqual(surface.tools.map(tool => tool.name), ['act', 'execute']);
assert.ok('catalog_graph_iri' in (surface.tools[1]!.inputSchema['properties'] as Record<string, unknown>));
assert.match(surface.digest, /^[a-f0-9]{64}$/);
assert.equal(mcpServerVersion(surface.digest), `${MCP_RELAY_VERSION}+schema.${surface.digest.slice(0, 12)}`);

const reorderedKeys = buildToolSurface(registry, [
  {
    inputSchema: {
      type: 'object',
      required: ['payload'],
      properties: {
        payload: { type: 'object', additionalProperties: true },
        catalog_graph_iri: { type: 'string', description: 'Graph selector.' },
      },
    },
    description: 'Execute a verified action.',
    name: 'execute',
  },
  schemas[1],
]);
assert.equal(reorderedKeys.digest, surface.digest, 'object-key order is not a schema revision');

const changed = buildToolSurface(registry, [
  {
    ...schemas[0],
    inputSchema: {
      ...schemas[0].inputSchema,
      required: ['catalog_graph_iri', 'payload'],
    },
  },
  schemas[1],
]);
assert.notEqual(changed.digest, surface.digest, 'a public schema change changes the cache identity');
assert.notEqual(mcpServerVersion(changed.digest), mcpServerVersion(surface.digest));

assert.throws(
  () => buildToolSurface(registry, [schemas[1]]),
  /missing schemas: execute/,
);
assert.throws(
  () => buildToolSurface({ act: registry.act }, schemas),
  /schemas without handlers: execute/,
);
assert.throws(
  () => buildToolSurface(registry, [...schemas, schemas[0]]),
  /duplicate published tool schema: execute/,
);

// server.ts self-starts, so the transport wiring is pinned over comment-stripped
// source while the catalog/digest behavior above exercises the real importable code.
const server = stripComments(
  readFileSync(fileURLToPath(new URL('../server.ts', import.meta.url)), 'utf8'),
  'server.ts',
);
assert.match(server, /version:\s*MCP_SERVER_VERSION/);
assert.match(server, /tools:\s*TOOL_SURFACE\.tools\.map/g);
const primaryListStart = server.indexOf("server.setRequestHandler('tools/list'");
const resourcesListStart = server.indexOf("server.setRequestHandler('resources/list'", primaryListStart);
assert.ok(primaryListStart >= 0 && resourcesListStart > primaryListStart);
const primaryList = server.slice(primaryListStart, resourcesListStart);
assert.match(primaryList, /_meta:\s*\{\s*\[TOOL_SURFACE_META_KEY\]:\s*TOOL_SURFACE_DIGEST\s*\}/);
assert.doesNotMatch(primaryList, /dct:identifier/);
const legacyListStart = server.indexOf("if (method === 'tools/list')");
const legacyCallStart = server.indexOf("if (method === 'tools/call')", legacyListStart);
assert.ok(legacyListStart >= 0 && legacyCallStart > legacyListStart);
const legacyList = server.slice(legacyListStart, legacyCallStart);
assert.match(legacyList, /TOOL_SURFACE\.tools\.map/);
assert.doesNotMatch(legacyList, /Object\.entries\(TOOLS\)/);
assert.doesNotMatch(legacyList, /properties:\s*\{\s*\}/);
assert.match(legacyList, /_meta:\s*\{\s*\[TOOL_SURFACE_META_KEY\]:\s*TOOL_SURFACE_DIGEST\s*\}/);
const httpToolsStart = server.indexOf("app.get('/tools'");
const httpToolInvokeStart = server.indexOf("app.post('/tool/:name'", httpToolsStart);
assert.ok(httpToolsStart >= 0 && httpToolInvokeStart > httpToolsStart);
const httpTools = server.slice(httpToolsStart, httpToolInvokeStart);
assert.match(httpTools, /'dct:identifier':\s*`sha256:\$\{TOOL_SURFACE_DIGEST\}`/);
assert.doesNotMatch(httpTools, /_meta:\s*\{\s*\[TOOL_SURFACE_META_KEY\]/);
assert.match(server, /toolSurfaceDigest:\s*TOOL_SURFACE_DIGEST/);
assert.match(server, /mcpServerVersion:\s*MCP_SERVER_VERSION/);
assert.match(server, /Cache-Control', 'no-cache'/);
assert.doesNotMatch(server, /ETag[^\n]*TOOL_SURFACE_DIGEST/);

// ── #367: what can be CALLED is exactly what is PUBLISHED ────────────────────────
// The resolver answers own members only: a declared name, and nothing a plain object's
// prototype holds. `constructor` and `toString` used to resolve on every transport.
const resolve = declaredToolResolver(registry);
assert.equal(resolve('act'), registry.act);
for (const name of ['constructor', 'toString', '__proto__', 'hasOwnProperty', 'valueOf', 'dynamic:anything', '']) {
  assert.equal(resolve(name), undefined, `${JSON.stringify(name)} is not a declared tool`);
}

// Every transport dispatches through that one resolver over the declared table, and no second
// registry sits beside it. An alias registry was callable on four transports while listed on none.
const DISPATCH_SITES = [
  ['/mcp tools/call', 'async function callWithSession(', 'const tool = declaredTool(name);'],
  ['/mcp request observer', "server.setRequestHandler('tools/call'", 'declaredTool(req.params.name)'],
  ['interop invokeCapability', 'const verb = capability.split', 'const tool = declaredTool(verb);'],
  ['POST /tool/:name', "app.post('/tool/:name'", 'const tool = declaredTool(toolName);'],
  ['/messages tools/call', "if (method === 'tools/call')", 'const tool = declaredTool(toolName);'],
] as const;
for (const [site, start, call] of DISPATCH_SITES) {
  const at = server.indexOf(start);
  assert.ok(at >= 0, `${site}: its region is still where this pin looks`);
  assert.ok(server.indexOf(call, at) >= 0 && server.indexOf(call, at) - at < 6000, `${site} resolves through declaredTool`);
}
assert.equal((server.match(/declaredTool\(/g) ?? []).length, DISPATCH_SITES.length + 1,
  'every resolution is one of the five dispatch sites or the per-operation schema route');
assert.match(server, /const declaredTool = declaredToolResolver\(TOOLS\);/);
assert.doesNotMatch(server, /\bTOOLS\[/, 'a bare index into TOOLS resolves prototype members too');
assert.doesNotMatch(server, /Object\.keys\(TOOLS\)/, 'every published name list comes from TOOL_SURFACE');
for (const gone of ['dynamicTools', 'loadDynamicTools', 'RELAY_DYNAMIC_TOOLS_POD', 'reload-dynamic-tools', 'dynamic-tools-status']) {
  assert.ok(!server.includes(gone), `the alias registry is gone: ${gone}`);
}

// Every projection reads the one surface: the MCP and legacy lists and GET /tools (pinned above),
// the operations catalog and its per-operation schemas, health, the interop card and the SSE frame.
const operationsStart = server.indexOf("app.get('/.well-known/operations'");
assert.ok(operationsStart >= 0);
assert.match(server.slice(operationsStart, operationsStart + 4000), /TOOL_SURFACE\.tools\.map/);
const operationSchemaStart = server.indexOf("app.get('/.well-known/operations/:name/:kind'");
assert.ok(operationSchemaStart >= 0);
const operationSchema = server.slice(operationSchemaStart, operationSchemaStart + 2000);
assert.match(operationSchema, /if \(!declaredTool\(name\)\)/);
assert.match(operationSchema, /TOOL_SURFACE\.tools\.find/);
assert.match(server, /tools:\s*TOOL_SURFACE\.tools\.length,/, 'health counts the published surface');
assert.match(server, /type: 'connection', tools: TOOL_SURFACE\.tools\.map\(t => t\.name\)/, 'the SSE frame names the published surface');
assert.match(server, /return TOOL_SURFACE\.tools\.map\(t => \(\{/, 'the interop card lists the published surface');

// The surface never changes during a process, and says so: no list_changed is ever sent.
assert.match(server, /capabilities:\s*\{\s*tools:\s*\{\s*listChanged:\s*false\s*\}/);

console.log('tool-surface: one fail-closed declared schema projection, content identity, and transport parity verified');
