/**
 * MCP `outputSchema` / `structuredContent` projection — ONE implementation.
 *
 * ★ WHAT THE SPEC ACTUALLY REQUIRES. Since MCP 2025-06-18, `outputSchema` describes
 * the structured RESULT PAYLOAD — the object a tool returns as `structuredContent` —
 * and a tool that declares one MUST return `structuredContent` conforming to it. It
 * does NOT describe the wire envelope (`{ content: [...], isError }`).
 *
 * ★ WHY THIS FILE EXISTS. That rule was implemented correctly in ONE place
 * (deploy/mcp-relay) and inverted in two others: both
 * `applications/_shared/affordance-mcp` and `mcp-server` declared an outputSchema
 * describing the ENVELOPE, with the real payload tucked into a non-standard
 * `x-payload-schema` extension that no validator reads — while their handlers returned
 * only `content`. So the machine-enforced part described the wrong thing and the part
 * that described the right thing was invisible.
 *
 * That stayed invisible because enforcement depends on which server class you use:
 * `McpServer.registerTool` validates the output, the low-level `Server` validates
 * nothing, and both of the broken copies used the low-level path. But MCP v2 CLIENTS
 * validate regardless, and the server-side failure is an `isError` result at HTTP 200 —
 * so a smoke test that checks status codes stays green while every tool is broken.
 *
 * Three copies of a rule, two of them wrong, is what a fourth copy would join. Hence
 * one implementation here, consumed by the relay, the stdio server, and every vertical
 * bridge.
 *
 * The two robustness rules below are load-bearing, not stylistic. Both exist because a
 * strict client (the Anthropic Messages API `mcp_servers` integration) validates
 * `structuredContent` against the declared schema and rejects a mismatch outright.
 */

/** A JSON Schema fragment. Deliberately loose: these are data, not typed models. */
export type JsonSchemaNode = Record<string, unknown>;

/**
 * Recursively make a JSON Schema null-tolerant: drop `required` at EVERY level and
 * widen every declared `type` to also accept `null`.
 *
 * WHY: handlers legitimately emit `null` for an absent optional field (a previous head
 * CID on a first publish, authorship when unsigned, a precondition on a non-CAS write).
 * A strict client rejects a `null` where the schema said `"string"`. Rather than chase
 * every field per dogfood cycle, the declared schema accepts what handlers actually
 * produce. Belt to {@link omitNullish}'s suspenders.
 *
 * WHY `required` GOES AT EVERY LEVEL: handlers return success OR a soft-error payload
 * (`{ error, code }`) from the same tool. Requiring the success fields would trade a
 * "missing structuredContent" error for a "schema mismatch" error — no better. Property
 * *descriptions* are kept; only the hard presence constraint is dropped.
 *
 * `isRoot` MUST stay true for the top-level call. MCP types a tool's outputSchema as an
 * object whose root `type` is the LITERAL `"object"`, and a strict client can reject the
 * tool definition on `tools/list` if the root is a union like `["object","null"]`. So at
 * the root we drop `required` and recurse, but do NOT widen the root type.
 */
export function makeSchemaNullTolerant(node: unknown, isRoot = false): unknown {
  if (Array.isArray(node)) return node.map(n => makeSchemaNullTolerant(n, false));
  if (node && typeof node === 'object') {
    const o: Record<string, unknown> = { ...(node as Record<string, unknown>) };
    delete o.required; // drop `required` at every nesting level
    if (!isRoot) {
      if (typeof o.type === 'string' && o.type !== 'null') {
        o.type = [o.type, 'null'];
      } else if (Array.isArray(o.type) && !o.type.includes('null')) {
        o.type = [...o.type, 'null'];
      }
    }
    if (o.properties && typeof o.properties === 'object') {
      const props: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(o.properties as Record<string, unknown>)) {
        props[k] = makeSchemaNullTolerant(v, false);
      }
      o.properties = props;
    }
    if (o.items) o.items = makeSchemaNullTolerant(o.items, false);
    return o;
  }
  return node;
}

/**
 * Build a tool's `outputSchema` from a description of its RESULT PAYLOAD.
 *
 * Pass the payload schema — the shape of the object the handler returns. Omit it to get
 * a permissive object, which is the right answer for a tool whose payload shape is not
 * declared: it satisfies clients that complain about a missing output schema while
 * imposing no obligation any real return can fail.
 *
 * Never pass the wire envelope. That inversion is the bug this module exists to end.
 */
export function mcpOutputSchema(payloadSchema?: JsonSchemaNode): JsonSchemaNode {
  if (!payloadSchema) {
    return { type: 'object', additionalProperties: true };
  }
  const schema = makeSchemaNullTolerant({ ...payloadSchema, type: 'object' }, true) as JsonSchemaNode;
  if (!('additionalProperties' in schema)) schema.additionalProperties = true;
  return schema;
}

/**
 * Recursively drop null/undefined-valued KEYS from objects.
 *
 * Cleaner payloads, and nothing for a strict validator to reject. Array ELEMENTS are
 * preserved as-is — removing them would shift indices and change meaning; the
 * null-tolerant schema covers any null that survives inside an array.
 */
export function omitNullish(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(omitNullish);
  if (v && typeof v === 'object') {
    const o: Record<string, unknown> = {};
    for (const [k, val] of Object.entries(v as Record<string, unknown>)) {
      if (val === null || val === undefined) continue;
      o[k] = omitNullish(val);
    }
    return o;
  }
  return v;
}

/**
 * Project a handler's result into the `structuredContent` object accompanying a tool
 * result.
 *
 * Always yields an OBJECT, so it conforms to the permissive payload schema above: a JSON
 * object is returned as-is (minus nullish keys); any non-object value — a number,
 * boolean, string, array, or a human-readable text blob that is not JSON at all — is
 * wrapped as `{ result: <value> }`.
 *
 * That wrapping matters for real tools: several handlers return multi-line human-readable
 * text rather than JSON, and without the wrap they would swap a "missing structuredContent"
 * error for a "not an object" one.
 */
export function toStructuredContent(value: unknown): Record<string, unknown> {
  // A handler that already returns a parsed object needs no JSON round-trip.
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    return omitNullish(value) as Record<string, unknown>;
  }
  if (typeof value === 'string') {
    try {
      const parsed: unknown = JSON.parse(value);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        return omitNullish(parsed) as Record<string, unknown>;
      }
      return { result: parsed };
    } catch {
      return { result: value };
    }
  }
  return { result: value ?? null };
}
