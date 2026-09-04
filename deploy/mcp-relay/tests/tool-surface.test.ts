#!/usr/bin/env tsx
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  buildToolSurface,
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

console.log('tool-surface: one fail-closed declared schema projection, content identity, and transport parity verified');
