import { createHash } from 'node:crypto';

/**
 * A transport-neutral projection of the relay's callable registry.
 *
 * The handler registry answers what can run; the published schemas answer how to
 * call it.  A transport must never invent a third answer (for example, an empty
 * schema on a legacy endpoint), because a host can cache that projection long
 * after the relay has changed.  Build the projection once and give the exact same
 * value to MCP, HTTP discovery, operation contracts, and diagnostics. The
 * digest makes stale and current catalogs distinguishable; it does not force an
 * MCP host to refresh an already-cached tools/list response.
 */
export type RuntimeToolRegistry = Readonly<Record<string, { readonly description: string }>>;

export type PublishedToolSchema = Readonly<{
  name: string;
  description: string;
  inputSchema: Readonly<Record<string, unknown>>;
  [key: string]: unknown;
}>;

export type ToolSurface = Readonly<{
  tools: readonly PublishedToolSchema[];
  digest: string;
}>;

export const MCP_RELAY_VERSION = '0.3.0';
export const TOOL_SURFACE_META_KEY = 'com.interego/toolSurfaceDigest';

function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') {
    const encoded = JSON.stringify(value);
    return encoded === undefined ? 'null' : encoded;
  }
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record)
    .filter(key => record[key] !== undefined)
    .sort()
    .map(key => `${JSON.stringify(key)}:${canonicalJson(record[key])}`)
    .join(',')}}`;
}

export function buildToolSurface(
  registry: RuntimeToolRegistry,
  schemas: readonly PublishedToolSchema[],
): ToolSurface {
  const byName = new Map<string, PublishedToolSchema>();
  for (const schema of schemas) {
    if (byName.has(schema.name)) throw new Error(`duplicate published tool schema: ${schema.name}`);
    byName.set(schema.name, schema);
  }

  const runtimeNames = Object.keys(registry);
  const missing = runtimeNames.filter(name => !byName.has(name));
  const orphaned = [...byName.keys()].filter(name => !Object.prototype.hasOwnProperty.call(registry, name));
  if (missing.length || orphaned.length) {
    throw new Error(
      `tool registry/schema drift${missing.length ? `; missing schemas: ${missing.join(', ')}` : ''}`
      + `${orphaned.length ? `; schemas without handlers: ${orphaned.join(', ')}` : ''}`,
    );
  }

  const tools = runtimeNames.map(name => ({ ...byName.get(name)! })) as PublishedToolSchema[];
  const digest = createHash('sha256').update(canonicalJson(tools)).digest('hex');
  return Object.freeze({ tools: Object.freeze(tools), digest });
}

/** A changed public tool contract produces a distinguishable MCP server identity. */
export function mcpServerVersion(toolSurfaceDigest: string): string {
  if (!/^[a-f0-9]{64}$/.test(toolSurfaceDigest)) throw new Error('tool surface digest must be sha256 hex');
  return `${MCP_RELAY_VERSION}+schema.${toolSurfaceDigest.slice(0, 12)}`;
}
