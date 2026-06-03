/**
 * Affordance → MCP-tool-schema derivation.
 *
 * First-principles position: a vertical's capabilities are declared as
 * cg:Affordance descriptors (the spec-level artifact). MCP/JSON-RPC
 * tool schemas, REST endpoints, OpenAPI specs — all of those are
 * derivations of the same affordance description.
 *
 * This module:
 *   1. Defines a typed shape for affordances that's easy to author in TS
 *   2. Derives MCP tool schemas (JSON Schema) from that shape
 *   3. Derives Turtle serialization (cg:Affordance / hydra:Operation /
 *      dcat:Distribution) so generic agents can discover affordances
 *      via the protocol's existing discover_context flow
 *
 * Verticals declare capabilities ONCE in TS; bridges and discovery
 * surfaces derive from there. Single source of truth.
 */

import type { IRI } from '@interego/core';

// ── Types ─────────────────────────────────────────────────────────────

export type JsonScalarType = 'string' | 'number' | 'integer' | 'boolean';
export type JsonType = JsonScalarType | 'object' | 'array';

/** A single input parameter on an affordance. */
export interface AffordanceInput {
  /** Property name (used as JSON-RPC key + Hydra hydra:property). */
  readonly name: string;
  /** JSON Schema type. */
  readonly type: JsonType;
  /** Required vs optional. */
  readonly required: boolean;
  /** Free-text description; surfaces to LLM tool selection + Hydra rdfs:comment. */
  readonly description: string;
  /** For arrays — element type. */
  readonly itemType?: JsonScalarType | 'object';
  /** For enums — allowed values. */
  readonly enum?: readonly string[];
  /** For numbers — bounds. */
  readonly minimum?: number;
  readonly maximum?: number;
  /** For arrays — minimum length. */
  readonly minItems?: number;
}

/**
 * Declares the resource states/collections an affordance is applicable
 * to. This is the data behind the "resource-scoped affordances" pattern
 * (see docs/patterns/resource-scoped-affordances.md): a HATEOAS resource
 * SHOULD advertise only the affordances valid for *its* current state,
 * not the bridge's entire capability catalog.
 *
 * An affordance with no `AffordanceScope` is **unscoped** — applicable
 * everywhere (the backward-compatible default).
 */
export interface AffordanceScope {
  /** Resource collections this affordance applies to — matched against
   *  the collection name a bridge is rendering ('courses', 'policies',
   *  'profiles', …) or the sentinel 'entry' for the entry point. Omit or
   *  include '*' to apply to every collection. */
  readonly collections?: readonly string[];
  /** Applicable only when the resource carries one of these
   *  cg:modalStatus values ('Asserted', 'Hypothetical', …). Omit to
   *  apply regardless of modal status. */
  readonly modalStatus?: readonly string[];
}

/**
 * Optional output-payload description for an affordance. When supplied,
 * the bridge's tool-schema derivation wraps it into a wire-shape MCP
 * `outputSchema` (`{ content: [{ type: 'text', text: <stringified payload> }] }`)
 * and attaches the supplied properties as an `x-payload-schema`
 * JSON-Schema extension on the `text` field — so OpenAI Apps / Claude
 * clients see a structured response-shape hint and stop reporting
 * "output schema missing". Mirrors the pattern shipped on the main MCP
 * servers (mcp-server/server.ts + deploy/mcp-relay/server.ts, commit
 * f31f64b). Omit `outputs` to fall back to a permissive generic object
 * schema.
 */
export interface AffordanceOutput {
  /** Free-text description of what the handler returns; surfaces in the
   *  derived outputSchema's `text` field description. */
  readonly description?: string;
  /** JSON-Schema properties describing the result payload (the JSON the
   *  handler returns — NOT the MCP wire envelope). */
  readonly properties?: Record<string, OutputSchemaProperty>;
  /** Names of properties that are always present in the result payload. */
  readonly required?: readonly string[];
}

/** JSON-Schema property fragment used inside AffordanceOutput. Looser
 *  than the affordance input schema so verticals can describe nested
 *  objects + arrays of objects without minting new type machinery here. */
export interface OutputSchemaProperty {
  readonly type: JsonType;
  readonly description?: string;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  readonly items?: any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  readonly properties?: Record<string, any>;
  readonly required?: readonly string[];
  readonly additionalProperties?: boolean;
  readonly enum?: readonly string[];
  readonly minimum?: number;
  readonly maximum?: number;
  readonly format?: string;
}

/** A capability the vertical exposes. */
export interface Affordance {
  /** Canonical action IRI (urn:cg:action:<vertical>:<verb>). */
  readonly action: IRI;
  /** MCP tool name (typically <vertical>.<verb>). */
  readonly toolName: string;
  /** Short title (Hydra hydra:title). */
  readonly title: string;
  /** Description for tool selection + protocol docs. */
  readonly description: string;
  /** HTTP method for hydra:target invocation. */
  readonly method: 'GET' | 'POST' | 'PUT' | 'DELETE' | 'PATCH';
  /** Endpoint URL (hydra:target). Templated with `{base}` placeholder for
   *  the bridge's deployment URL — substituted at affordance-publication
   *  time. */
  readonly targetTemplate: string;
  /** Input parameters. */
  readonly inputs: ReadonlyArray<AffordanceInput>;
  /** Optional description of the handler's return payload — translated
   *  into an MCP `outputSchema` by affordanceToMcpToolSchema. Omit for a
   *  permissive generic object schema. */
  readonly outputs?: AffordanceOutput;
  /** Optional return-type IRI (hydra:returns). */
  readonly returns?: IRI;
  /** Optional MIME type the endpoint emits. */
  readonly mediaType?: string;
  /** Optional resource-scope. When present, the affordance is only
   *  advertised on resources whose context matches (see affordancesFor).
   *  Absent ⇒ unscoped ⇒ advertised everywhere. */
  readonly appliesTo?: AffordanceScope;
}

/** The state of the resource a bridge is currently rendering, used to
 *  decide which affordances it should advertise. */
export interface ResourceContext {
  /** Collection name being rendered ('courses', 'policies', 'profiles',
   *  …) or 'entry' for the entry point. */
  readonly collection: string;
  /** The resource's cg:modalStatus, if it carries one. */
  readonly modalStatus?: string;
}

/**
 * Resource-scoped affordances — the reference filter for the pattern in
 * docs/patterns/resource-scoped-affordances.md.
 *
 * Given the resource a bridge is about to serialize, return only the
 * affordances applicable to it. Unscoped affordances (no `appliesTo`)
 * always pass. Scoped affordances pass only when every declared
 * dimension matches the `ResourceContext`.
 *
 * The entry point is the one resource that SHOULD advertise the full
 * catalog — call this with `{ collection: 'entry' }` and leave
 * `collections` either unset or including 'entry' on catalog-wide
 * affordances, OR simply skip the filter for the entry point.
 */
export function affordancesFor(
  ctx: ResourceContext,
  affordances: readonly Affordance[],
): Affordance[] {
  return affordances.filter((a) => {
    const scope = a.appliesTo;
    if (!scope) return true; // unscoped ⇒ applies everywhere
    if (
      scope.collections &&
      scope.collections.length > 0 &&
      !scope.collections.includes('*') &&
      !scope.collections.includes(ctx.collection)
    ) {
      return false;
    }
    if (
      scope.modalStatus &&
      scope.modalStatus.length > 0 &&
      ctx.modalStatus !== undefined &&
      !scope.modalStatus.includes(ctx.modalStatus)
    ) {
      return false;
    }
    return true;
  });
}

// ── Derive: MCP tool schema ──────────────────────────────────────────

export interface McpToolSchema {
  readonly name: string;
  readonly description: string;
  readonly inputSchema: {
    type: 'object';
    properties: Record<string, JsonSchemaProperty>;
    required: string[];
  };
  /** MCP wire-shape response envelope schema. Always present so OpenAI
   *  Apps / Claude clients stop reporting "output schema missing" on
   *  vertical-bridge tools. When the affordance carries `outputs`, the
   *  inner `text` field gets an `x-payload-schema` JSON-Schema extension
   *  describing the JSON payload the handler returns; otherwise the
   *  field is a permissive generic object. */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  readonly outputSchema: Record<string, any>;
}

interface JsonSchemaProperty {
  type: JsonType;
  description: string;
  items?: { type: JsonScalarType | 'object' };
  enum?: readonly string[];
  minimum?: number;
  maximum?: number;
  minItems?: number;
}

/**
 * Derive an MCP `outputSchema` describing the wire envelope MCP tools
 * actually return: `{ content: [{ type: 'text', text: <string> }] }`.
 * When `payload` is supplied, it's attached to the `text` field as an
 * `x-payload-schema` JSON-Schema extension so downstream tools that
 * introspect tool catalogues can see what's IN the stringified text.
 *
 * This is the per-bridge equivalent of the helper used in the main MCP
 * servers (mcp-server/server.ts + deploy/mcp-relay/server.ts, commit
 * f31f64b — `mcpOutputSchema`).
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function buildMcpOutputSchema(outputs?: AffordanceOutput): Record<string, any> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const textProp: Record<string, any> = {
    type: 'string',
    description: outputs?.description
      ?? 'JSON-encoded result payload returned by the affordance handler.',
  };
  if (outputs && (outputs.properties || outputs.required || outputs.description)) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const payload: Record<string, any> = { type: 'object' };
    if (outputs.description) payload['description'] = outputs.description;
    if (outputs.properties) {
      payload['properties'] = outputs.properties;
    } else {
      // Description-only outputs stay permissive on the property bag so a
      // richer schema can be added later without breaking callers.
      payload['additionalProperties'] = true;
    }
    if (outputs.required && outputs.required.length > 0) payload['required'] = outputs.required;
    textProp['x-payload-schema'] = payload;
  } else {
    // Generic permissive payload — used when the affordance didn't
    // declare an `outputs` shape at all. Matches GENERIC_OUTPUT_SCHEMA
    // from the main MCP servers.
    textProp['x-payload-schema'] = {
      type: 'object',
      additionalProperties: true,
      description: "Tool returned a JSON object (or human-readable text) embedded in the MCP content[0].text field. See the affordance handler's source for the exact shape.",
    };
  }
  return {
    type: 'object',
    properties: {
      content: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            type: { type: 'string', const: 'text' },
            text: textProp,
          },
          required: ['type', 'text'],
        },
      },
      isError: { type: 'boolean' },
    },
    required: ['content'],
  };
}

/**
 * Derive an MCP tool schema (JSON Schema-compliant inputSchema + a wire
 * `outputSchema` envelope) from an Affordance. The MCP server /
 * per-vertical bridge calls this for every affordance to get its tool
 * schema; never hand-writes one.
 */
export function affordanceToMcpToolSchema(affordance: Affordance): McpToolSchema {
  const properties: Record<string, JsonSchemaProperty> = {};
  const required: string[] = [];

  for (const input of affordance.inputs) {
    const prop: JsonSchemaProperty = {
      type: input.type,
      description: input.description,
    };
    if (input.type === 'array' && input.itemType) {
      prop.items = { type: input.itemType };
    }
    if (input.enum) prop.enum = input.enum;
    if (input.minimum !== undefined) prop.minimum = input.minimum;
    if (input.maximum !== undefined) prop.maximum = input.maximum;
    if (input.minItems !== undefined) prop.minItems = input.minItems;

    properties[input.name] = prop;
    if (input.required) required.push(input.name);
  }

  return {
    name: affordance.toolName,
    description: affordance.description,
    inputSchema: { type: 'object', properties, required },
    outputSchema: buildMcpOutputSchema(affordance.outputs),
  };
}

// ── Derive: Turtle (cg:Affordance / hydra:Operation) ────────────────

/**
 * Derive a `cg:Affordance / cgh:Affordance / hydra:Operation /
 * dcat:Distribution` Turtle block from an Affordance. The vertical's
 * bridge publishes this on startup so generic Interego agents can
 * discover the capability via the protocol's existing affordance-walk.
 *
 * The {base} placeholder in targetTemplate is substituted with the
 * caller-supplied deploymentUrl.
 */
export function affordanceToTurtle(affordance: Affordance, deploymentUrl: string): string {
  const target = affordance.targetTemplate.replace('{base}', deploymentUrl);

  const inputClassIri = `${affordance.action}-input`;
  const inputProps = affordance.inputs.map((input, i) => {
    const propIri = `<${affordance.action}-prop-${input.name}>`;
    return `        [
            a hydra:SupportedProperty ;
            hydra:property ${propIri} ;
            hydra:required ${input.required ? 'true' : 'false'} ;
            rdfs:comment "${escapeLit(input.description)}"
        ]${i < affordance.inputs.length - 1 ? '' : ''}`;
  }).join(' ,\n');

  return `<${affordance.action}> a cg:Affordance, cgh:Affordance, hydra:Operation, dcat:Distribution ;
    cg:action <${affordance.action}> ;
    hydra:method "${affordance.method}" ;
    hydra:title "${escapeLit(affordance.title)}" ;
    rdfs:comment "${escapeLit(affordance.description)}" ;
    hydra:target <${target}> ;
    dcat:accessURL <${target}> ;
    ${affordance.mediaType ? `dcat:mediaType "${affordance.mediaType}" ;` : ''}
    ${affordance.returns ? `hydra:returns <${affordance.returns}> ;` : ''}
    hydra:expects [
        a hydra:Class ;
        rdfs:label "${escapeLit(affordance.toolName)}-input" ;
        hydra:supportedProperty
${inputProps}
    ] ;
    cg:encrypted false .`;
}

/** Multi-affordance turtle document with prefixes and a common manifest IRI. */
export function affordancesManifestTurtle(
  manifestIri: string,
  affordances: readonly Affordance[],
  deploymentUrl: string,
  options?: { verticalLabel?: string; rdfsComment?: string },
): string {
  const prefixes = `@prefix cg:    <https://markjspivey-xwisee.github.io/interego/ns/cg#> .
@prefix cgh:   <https://markjspivey-xwisee.github.io/interego/ns/cgh#> .
@prefix hydra: <http://www.w3.org/ns/hydra/core#> .
@prefix dcat:  <http://www.w3.org/ns/dcat#> .
@prefix rdfs:  <http://www.w3.org/2000/01/rdf-schema#> .`;

  const manifestBlock = `<${manifestIri}> a hydra:Collection ;
    rdfs:label "${escapeLit(options?.verticalLabel ?? 'Vertical capability manifest')}" ;
    ${options?.rdfsComment ? `rdfs:comment "${escapeLit(options.rdfsComment)}" ;` : ''}
${affordances.map(a => `    cg:affordance <${a.action}>`).join(' ;\n')} .`;

  const blocks = affordances.map(a => affordanceToTurtle(a, deploymentUrl)).join('\n\n');

  return `${prefixes}\n\n${manifestBlock}\n\n${blocks}\n`;
}

// ── Internals ────────────────────────────────────────────────────────

function escapeLit(s: string): string {
  return s.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}
