/**
 * Affordance → MCP-tool-schema derivation.
 *
 * First-principles position: a vertical's capabilities are declared as
 * iep:Affordance descriptors (the spec-level artifact). MCP/JSON-RPC
 * tool schemas, REST endpoints, OpenAPI specs — all of those are
 * derivations of the same affordance description.
 *
 * This module:
 *   1. Defines a typed shape for affordances that's easy to author in TS
 *   2. Derives MCP tool schemas (JSON Schema) from that shape
 *   3. Derives Turtle serialization (iep:Affordance / hydra:Operation /
 *      dcat:Distribution) so generic agents can discover affordances
 *      via the protocol's existing discover_context flow
 *
 * Verticals declare capabilities ONCE in TS; bridges and discovery
 * surfaces derive from there. Single source of truth.
 */

import type {
  IRI,
} from '@interego/core';
import { actionUrl, mcpOutputSchema } from '@interego/core';
// The one Turtle-literal escaper. See packages/core/src/rdf/escape.ts — its header names the
// scattered-subsets drift that this import ends.
import { escapeTurtleLiteral } from '@interego/core';

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
   *  iep:modalStatus values ('Asserted', 'Hypothetical', …). Omit to
   *  apply regardless of modal status. */
  readonly modalStatus?: readonly string[];
}

/**
 * Optional description of an affordance handler's RESULT PAYLOAD.
 *
 * The tool-schema derivation turns this into the MCP `outputSchema` directly —
 * the schema describes the payload, which the mount returns as
 * `structuredContent`. Omit `outputs` for a permissive object schema.
 *
 * It used to be wrapped into a wire-envelope schema with the payload hidden in a
 * non-standard `x-payload-schema` extension, which inverted the spec: since
 * 2025-06-18 `outputSchema` describes the payload and declaring one obliges the
 * tool to return conforming `structuredContent`.
 *
 * `required` is accepted for documentation but deliberately NOT enforced in the
 * derived schema — handlers return a success payload or a soft-error payload from
 * the same tool, so a hard presence constraint would fail one of them.
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

/**
 * MCP `annotations` object on a tool definition (MCP spec 2025-06-18).
 * Conveys behavioural hints to clients like ChatGPT / Claude so they can
 * surface accurate read/write + reversibility + idempotency + external-
 * world chips on the tool card. When absent, clients default to worst-
 * case (WRITE + DESTRUCTIVE + OPEN WORLD).
 *
 * All fields optional per spec; per Foxxi convention all four hints
 * SHOULD be set explicitly so the worst-case fallback never fires.
 */
export interface McpToolAnnotations {
  /** Short human-readable name (1-5 words) for the tool card. */
  readonly title?: string;
  /** True when the tool performs no observable state change. */
  readonly readOnlyHint?: boolean;
  /** True when (the non-read-only) tool performs an irreversible change. */
  readonly destructiveHint?: boolean;
  /** True when repeating the call with the same args produces the same
   *  end-state. */
  readonly idempotentHint?: boolean;
  /** True when the tool interacts with external entities (other pods,
   *  blockchain, web). False when it's purely local computation/config. */
  readonly openWorldHint?: boolean;
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
/**
 * One store an affordance reads, and the four things a caller needs to know about it.
 *
 * ★ EACH FIELD ANSWERS A QUESTION AN AGENT ACTUALLY ASKED. Which store did you read (`store`);
 * what puts data in it (`populatedBy`); what will it accept (`admits`); and where is the set of
 * subjects it will admit published (`enrolmentRegister`) — that last one being the fact that lived
 * in an env var and cost a night to find.
 */
export interface AffordanceEvidenceSource {
  /** Dereferenceable identifier of the store actually read. */
  readonly store: string;
  /** Human-readable name, for a caller reading a tool list rather than Turtle. */
  readonly label: string;
  /** What fills it, dereferenceable where one exists — an affordance IRI, a projector, a route. */
  readonly populatedBy: string;
  /** What it will accept, in one sentence a caller can act on. */
  readonly admits?: string;
  /** Where the set of subjects this store admits is PUBLISHED, when membership is a precondition. */
  readonly enrolmentRegister?: string;
}

export interface Affordance {
  /** Canonical action IRI (urn:iep:action:<vertical>:<verb>). */
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
  /**
   * The stores this affordance READS to compose its answer.
   *
   * ── ★★ THE OTHER HALF OF THE CONTRACT, WHICH WAS NEVER WRITTEN ──────────────
   *
   * `inputs` says what a caller must SEND. Until this existed, nothing anywhere said what an
   * affordance must FIND — and `affordanceToTurtle` proved it: it emitted `iep:action`,
   * `hydra:method`, `hydra:target`, `hydra:returns` and a fully expanded `hydra:expects`, and
   * stopped.
   *
   * MEASURED, live, over four turns and about $3 of model spend: a delegate signed a valid
   * envelope, dereferenced an affordance whose input side was documented exhaustively, invoked it
   * correctly, and got an empty answer. It could not distinguish "you have done nothing" from
   * "your evidence is not in the store I read". Nothing it could dereference named the store, what
   * fills it, or whether it was enrolled — the answer was an environment variable, and a HUMAN had
   * to read deployment config to find it.
   *
   * ★ WHEN AN ANSWER IS ASSEMBLED FROM DATA THE CALLER NEITHER SENT NOR CAN SEE, AN EMPTY ANSWER
   * AND A CORRECT ANSWER ARE THE SAME BYTES. A descriptor that cannot distinguish them is
   * unfalsifiable, and an agent reasoning against it is guessing however well it reasons.
   *
   * ★ OPTIONAL, AND ITS ABSENCE STATES NOTHING — the rule everywhere in this vocabulary. An
   * affordance that declares no source has not declared that it reads none.
   */
  readonly reads?: ReadonlyArray<AffordanceEvidenceSource>;
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
  /** Optional MCP-spec-2025-06-18 `annotations` object passed through to
   *  the derived MCP tool schema. When absent, MCP clients (ChatGPT,
   *  Claude) default to worst-case hints (WRITE + DESTRUCTIVE + OPEN
   *  WORLD). Verticals SHOULD set all four hints + title explicitly. */
  readonly annotations?: McpToolAnnotations;
  /** When true, the affordance is DECLARED for discovery (it appears in the
   *  /affordances manifest, tools/list, and the entry point) but the bridge
   *  does NOT auto-register an HTTP route or require a handler for it — the
   *  capability is served by a pre-existing hand-coded route at its
   *  targetTemplate path (e.g. a route with bespoke signed-delegation auth).
   *  This makes every capability discoverable via the single manifest without
   *  relocating route bodies. Agents discover→act it via its HTTP target;
   *  the named-MCP tools/call shim is unavailable for it (no handler). */
  readonly externallyRouted?: boolean;
}

/** The state of the resource a bridge is currently rendering, used to
 *  decide which affordances it should advertise. */
export interface ResourceContext {
  /** Collection name being rendered ('courses', 'policies', 'profiles',
   *  …) or 'entry' for the entry point. */
  readonly collection: string;
  /** The resource's iep:modalStatus, if it carries one. */
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
  /** JSON Schema for the structured RESULT PAYLOAD — the object the mount
   *  returns as `structuredContent`. Always present so clients stop reporting
   *  "output schema missing"; permissive when the affordance declares no
   *  `outputs`. NOT the wire envelope: declaring an outputSchema obliges the
   *  tool to return conforming `structuredContent` (MCP 2025-06-18), so the two
   *  are one contract and change together. */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  readonly outputSchema: Record<string, any>;
  /** MCP-spec-2025-06-18 `annotations` object. Always present when the
   *  source affordance declared one, so MCP clients (ChatGPT, Claude)
   *  stop falling back to worst-case WRITE/DESTRUCTIVE/OPEN-WORLD chips
   *  on every vertical-bridge tool. */
  readonly annotations?: McpToolAnnotations;
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
 * Derive an MCP `outputSchema` from an affordance's declared `outputs`.
 *
 * ★ THIS USED TO DESCRIBE THE WRONG THING. It emitted the wire envelope
 * (`{ content: [{ type, text }], isError }`) as the outputSchema and tucked the
 * real payload shape into a non-standard `x-payload-schema` extension on the
 * `text` field.
 *
 * Since MCP 2025-06-18 the rule is the other way round: `outputSchema` describes
 * the structured RESULT PAYLOAD, and declaring one OBLIGES the tool to return
 * `structuredContent` conforming to it. So the machine-enforced part described
 * the envelope, while the part that described the payload was invisible to every
 * validator — and the mount returned no `structuredContent` at all.
 *
 * Nothing caught it because the mount advertised `2024-11-05`, a revision with no
 * outputSchema concept, and no client validated. Under MCP SDK v2,
 * `McpServer.registerTool` refuses such a result outright and v2 CLIENTS validate
 * regardless of which server class serves them.
 *
 * The projection now delegates to `mcpOutputSchema` from `@interego/core` — the
 * same implementation the relay uses — so the rule lives in one place. The
 * companion half is in the vertical-bridge mount, which attaches
 * `structuredContent`; the two MUST stay together (see that call site).
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function buildMcpOutputSchema(outputs?: AffordanceOutput): Record<string, any> {
  // No declared outputs → a permissive object. It satisfies clients that report a
  // missing output schema, and imposes no constraint any real return can fail.
  if (!outputs || !(outputs.properties || outputs.required || outputs.description)) {
    return mcpOutputSchema({
      type: 'object',
      additionalProperties: true,
      description: "The affordance handler's JSON result payload. See the handler's source for the exact shape.",
    });
  }
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const payload: Record<string, any> = { type: 'object' };
  if (outputs.description) payload['description'] = outputs.description;
  if (outputs.properties) payload['properties'] = outputs.properties;
  else payload['additionalProperties'] = true;
  // `outputs.required` is deliberately NOT forwarded. Handlers return a success
  // payload OR a soft-error one (`{ error, code }`) from the same tool, so a
  // top-level `required` would trade the "missing structuredContent" failure for a
  // "schema mismatch" failure. mcpOutputSchema drops `required` at every level for
  // exactly this reason; the property descriptions survive as documentation.
  return mcpOutputSchema(payload);
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

  const schema: McpToolSchema = {
    name: affordance.toolName,
    description: affordance.description,
    inputSchema: { type: 'object', properties, required },
    outputSchema: buildMcpOutputSchema(affordance.outputs),
    ...(affordance.annotations ? { annotations: affordance.annotations } : {}),
  };
  return schema;
}

// ── Derive: Turtle (iep:Affordance / hydra:Operation) ────────────────

/**
 * Derive a `iep:Affordance / ieh:Affordance / hydra:Operation /
 * dcat:Distribution` Turtle block from an Affordance. The vertical's
 * bridge publishes this on startup so generic Interego agents can
 * discover the capability via the protocol's existing affordance-walk.
 *
 * The {base} placeholder in targetTemplate is substituted with the
 * caller-supplied deploymentUrl.
 */
/**
 * The `iep:reads` blocks, or nothing at all.
 *
 * ★ EMITTED HERE RATHER THAN AT ONE CALL SITE, so an affordance in ANY vertical that declares its
 * read side gets it on the wire. The failure this closes was not specific to one endpoint: the
 * serializer described every affordance's input exhaustively and none of their read sides, so the
 * gap was uniform across the fleet.
 */
function readsBlock(affordance: Affordance): string {
  const sources = affordance.reads ?? [];
  if (!sources.length) return '';
  /**
   * ★★ MULTI-TYPED AND DOUBLE-STATED, SO A DCAT CLIENT NEEDS NO REASONER.
   *
   * `alignment.ttl` says an iep:EvidenceSource IS a dcat:Dataset and an iep:store IS a
   * dcat:accessURL. Both are true, and neither helps a reader that does not run RDFS entailment —
   * MEASURED: a shape targeting `dcat:Dataset` found the source (class entailment worked) and then
   * failed on the missing `dcat:accessURL`, because property entailment was not expanded.
   *
   * Requiring inference to read a self-description is the same defect as not publishing one, in a
   * politer form. So the standard terms are stated OUTRIGHT — exactly as the affordance subject
   * above types itself `iep:Affordance, ieh:Affordance, hydra:Operation, dcat:Distribution` rather
   * than leaving three of the four to be derived. The alignment stays for semantics; these triples
   * are what make the descriptor usable by a client that only speaks DCAT.
   *
   * ── ★★ AND NO dcat:accessService HERE, DELIBERATELY ─────────────────────────────────────
   *
   * It was emitted as `dcat:accessService <populatedBy>` and that inverted the ONE DCAT term that
   * encodes the zero-copy distinction. `dcat:accessService` means "a DataService you QUERY";
   * `populatedBy` is the store's WRITE port. On the live review-record descriptor it therefore
   * pointed a DCAT-literate agent at a POST-only endpoint that answers 404 to a GET — so the caller
   * followed the zero-copy handle, found nothing, and fell back to the only other read available:
   * the 1.2 MB bulk copy. An advertisement for a service that does not exist is worse than silence,
   * because it is the one a conforming client trusts first.
   *
   * ★ IT COMES BACK WHEN THERE IS SOMETHING TRUE TO POINT AT — a queryable, self-scoped read of the
   * store. Until then this stays absent, and the absence is honest: no query service is offered
   * because none is implemented.
   */
  const blocks = sources.map((s) => `        [
            a iep:EvidenceSource, dcat:Dataset ;
            rdfs:label "${escapeLit(s.label)}" ;
            iep:store <${s.store}> ;
            dcat:accessURL <${s.store}> ;
            iep:populatedBy <${s.populatedBy}>${s.admits ? ` ;
            iep:admits "${escapeLit(s.admits)}" ;
            dct:description "${escapeLit(s.admits)}"` : ''}${s.enrolmentRegister ? ` ;
            iep:enrolmentRegister <${s.enrolmentRegister}>` : ''}
        ]`).join(' ,\n');
  return `    iep:reads\n${blocks} ;\n`;
}

const NEWLINE = String.fromCharCode(10);

/**
 * The value constraints an input declares, as published SHACL + RDFS.
 *
 * ★★ THE SERIALIZER USED TO STOP AT label + required + comment. Every input already carried a
 * JSON-Schema `type`, and 19 carried an `enum`, 26 an `itemType`, 6 a `minItems` and 5 numeric
 * bounds — 613 inputs' worth of machine-readable shape that reached the MCP tool schema and the
 * JSON-LD, and was DROPPED on the way to Turtle. An agent dereferencing the action authority got
 * prose where a type belonged, so "which values does this accept" was answerable only by reading
 * an English sentence.
 *
 * ★ IT INVENTS NO VOCABULARY. `rdfs:range` says what a property ranges over, which is exactly the
 * datatype question; SHACL says the rest, and this repository already publishes SHACL shapes
 * (iep:VisibilityShape, iep:EvidenceSourceShape) and runs a SHACL engine, so `sh:` is a vocabulary
 * this fleet already speaks rather than a new one to declare and gate.
 */
function valueConstraints(spec: {
  readonly type?: string;
  readonly itemType?: string;
  readonly enum?: readonly string[];
  readonly minimum?: number;
  readonly maximum?: number;
  readonly minItems?: number;
}, indent: string): string {
  const xsd = (t: string): string => {
    if (t === 'string') return 'xsd:string';
    if (t === 'number') return 'xsd:decimal';
    if (t === 'integer') return 'xsd:integer';
    if (t === 'boolean') return 'xsd:boolean';
    return '';
  };
  const lines: string[] = [];
  // ★ An array's ITEM type is the useful one; `xsd:` has no list datatype, so an array says what
  // its members are rather than mis-stating itself as a scalar.
  const scalar = spec.type === 'array' ? xsd(String(spec.itemType ?? '')) : xsd(String(spec.type ?? ''));
  if (scalar) lines.push(`${indent}sh:datatype ${scalar}`);
  if (spec.enum && spec.enum.length > 0) {
    lines.push(`${indent}sh:in ( ${spec.enum.map((v) => `"${escapeLit(String(v))}"`).join(' ')} )`);
  }
  if (typeof spec.minimum === 'number') lines.push(`${indent}sh:minInclusive ${spec.minimum}`);
  if (typeof spec.maximum === 'number') lines.push(`${indent}sh:maxInclusive ${spec.maximum}`);
  if (typeof spec.minItems === 'number') lines.push(`${indent}sh:minCount ${spec.minItems}`);
  return lines.length > 0 ? ` ;${NEWLINE}${lines.join(` ;${NEWLINE}`)}` : '';
}

/**
 * The RETURN payload, as a hydra:Class mirroring how hydra:expects already describes the input.
 *
 * ★★ 448 OUTPUT PROPERTIES — 33.7 KB of declared result shape across the fleet — reached the MCP
 * outputSchema and never the wire. A caller could learn exactly what to SEND and nothing about what
 * it would GET, which is half a contract. `hydra:returns` is where a Hydra reader already looks.
 *
 * ★ The IRI form of `hydra:returns` is preserved for an affordance that sets `returns` explicitly:
 * that field is declared in the type and used by nothing today, so this must not quietly take its
 * place if it is ever used.
 */
function returnsBlock(affordance: Affordance): string {
  const out = affordance.outputs;
  if (!out) return '';
  const props = Object.entries(out.properties ?? {});
  const required = new Set(out.required ?? []);
  const rows = props.map(([name, spec]) => {
    const comment = typeof spec.description === 'string' && spec.description.length > 0
      ? ` ;${NEWLINE}            rdfs:comment "${escapeLit(spec.description)}"`
      : '';
    return `        [
            a hydra:SupportedProperty ;
            hydra:property [ a rdf:Property ; rdfs:label "${escapeLit(name)}" ] ;
            hydra:required ${required.has(name) ? 'true' : 'false'}${comment}${valueConstraints(spec, '            ')}
        ]`;
  }).join(` ,${NEWLINE}`);
  const label = `${escapeLit(affordance.toolName)}-output`;
  const desc = typeof out.description === 'string' && out.description.length > 0
    ? ` ;${NEWLINE}        rdfs:comment "${escapeLit(out.description)}"`
    : '';
  const supported = rows
    ? ` ;${NEWLINE}        hydra:supportedProperty${NEWLINE}${rows}`
    : '';
  return `    hydra:returns [
        a hydra:Class ;
        rdfs:label "${label}"${desc}${supported}
    ] ;
`;
}

/**
 * The MCP annotation hints, published.
 *
 * ★★ 143 AFFORDANCES x 5 HINTS REACHED THE MCP TOOL SCHEMA AND NOTHING ELSE. An agent that talks
 * MCP got them; an agent that dereferenced the action authority and read Turtle got none, so the
 * two surfaces described the same operation with different amounts of truth.
 *
 * ★ THE HTTP METHOD CANNOT CARRY THIS, which is why it needs saying. 142 of the 143 are POST, so
 * `review-record` — which assembles and returns a record and writes nothing — is indistinguishable
 * on method alone from one that mutates. Whether a step may be retried, reordered or dropped is
 * exactly what a planning agent needs and exactly what POST refuses to tell it.
 *
 * ★ FOUR NEW iep: TERMS, DECLARED RATHER THAN IMPROVISED, because no standard vocabulary carries
 * operation safety: Hydra Core has no safe/idempotent property, and the W3C HTTP vocabulary
 * describes messages, not operation semantics. They are in docs/ns/iep.ttl with domain
 * iep:Affordance and range xsd:boolean, projected into iep.html, and the term count moved with
 * them — all three gated.
 *
 * ★ THE SHORT CARD NAME GOES TO rdfs:label, NOT A NEW TERM. `annotations.title` is a 1-5 word name
 * distinct from the full `hydra:title` already emitted, and the affordance subject carried no
 * rdfs:label, so the standard term was free and fits.
 *
 * ★ ABSENCE STATES NOTHING, as everywhere in this vocabulary: an affordance declaring no hint has
 * not declared itself safe. MCP clients that receive no annotations default to the worst case
 * (write + destructive + open-world), so silence is already read pessimistically by the caller.
 */
function annotationsBlock(affordance: Affordance): string {
  const a = affordance.annotations;
  if (!a) return '';
  const lines: string[] = [];
  if (typeof a.title === 'string' && a.title.length > 0) {
    lines.push(`    rdfs:label "${escapeLit(a.title)}"`);
  }
  const hint = (name: string, v: boolean | undefined): void => {
    if (typeof v === 'boolean') lines.push(`    iep:${name} ${v ? 'true' : 'false'}`);
  };
  hint('readOnlyHint', a.readOnlyHint);
  hint('destructiveHint', a.destructiveHint);
  hint('idempotentHint', a.idempotentHint);
  hint('openWorldHint', a.openWorldHint);
  return lines.length > 0 ? `${lines.join(` ;${NEWLINE}`)} ;${NEWLINE}` : '';
}

/**
 * Every prefix `affordanceToTurtle` can emit, in one place.
 *
 * ★★ EXPORTED BECAUSE A SECOND COPY DRIFTED THE MOMENT THIS GREW. `affordanceToTurtle` emits a
 * BODY, not a document, so a caller serializing one affordance on its own has to supply prefixes —
 * and tests/affordance-declares-its-read-side.test.ts kept its own hand-written list. Adding
 * `sh:` and `xsd:` to the serializer made everything it produced UNPARSEABLE against that list,
 * and the failure read as "Data graph is not parseable as Turtle/TriG" rather than as "your
 * prefix list is stale", which is a long way from the cause.
 *
 * A prefix the serializer emits and the document does not declare is not a style problem: this
 * manifest is served to strangers, and an undeclared prefix makes the whole document unreadable.
 * One list, exported, so a caller cannot hold a different one.
 */
export const AFFORDANCE_TURTLE_PREFIXES = `@prefix iep:    <https://markjspivey-xwisee.github.io/interego/ns/iep#> .
@prefix ieh:   <https://markjspivey-xwisee.github.io/interego/ns/harness#> .
@prefix hydra: <http://www.w3.org/ns/hydra/core#> .
@prefix dcat:  <http://www.w3.org/ns/dcat#> .
@prefix rdf:   <http://www.w3.org/1999/02/22-rdf-syntax-ns#> .
@prefix rdfs:  <http://www.w3.org/2000/01/rdf-schema#> .
# SHACL and XSD, for the value constraints every input already declared and this manifest used to
# drop. Neither is new to this fleet: SHACL shapes are published under docs/ns and a SHACL engine
# runs against them; a document emitting a prefix it does not declare is unparseable, and this one
# is served to strangers.
@prefix sh:    <http://www.w3.org/ns/shacl#> .
@prefix xsd:   <http://www.w3.org/2001/XMLSchema#> .
# Dublin Core, for the DCAT-native reading of an evidence source's description. Added with the
# read-side terms: a document that emits dct: without declaring it is unparseable, and this
# manifest is served to strangers.
@prefix dct:   <http://purl.org/dc/terms/> .`;

/**
 * Where an affordance is advertised, and whether the MCP shim can call it.
 *
 * ★★ BOTH WERE CONSUMED AT REQUEST TIME AND PUBLISHED NOWHERE. `affordancesFor()` filters by
 * `appliesTo` per resource, so the manifest lists every affordance a vertical has while a reader
 * of that document alone cannot tell which will never appear on the resource in front of it. And
 * `externallyRouted` decides whether a handler exists at all: such an affordance IS actable over
 * HTTP at its hydra:target, but the named MCP tools/call shim is unavailable for it. An MCP client
 * that reads the manifest and plans a call would otherwise learn that only by failing.
 *
 * ★ ABSENCE STATES NOTHING, as everywhere here. No collection means UNSCOPED — advertised
 * everywhere — which is why the property is emitted only when the affordance actually narrows
 * itself, rather than emitting a wildcard that a reader would have to know to ignore.
 *
 * ★ THE `modalStatus` HALF OF AffordanceScope IS DECLARED IN TYPESCRIPT AND USED BY NOTHING — 47
 * uses across the fleet, every one of them `collections` only — so nothing is emitted for it.
 * Publishing an empty dimension would assert a distinction no affordance draws.
 */
function advertisementBlock(affordance: Affordance): string {
  const lines: string[] = [];
  for (const c of affordance.appliesTo?.collections ?? []) {
    lines.push(`    iep:appliesToCollection "${escapeLit(c)}"`);
  }
  if (typeof affordance.externallyRouted === 'boolean') {
    lines.push(`    iep:externallyRouted ${affordance.externallyRouted ? 'true' : 'false'}`);
  }
  return lines.length > 0 ? `${lines.join(` ;${NEWLINE}`)} ;${NEWLINE}` : '';
}

export function affordanceToTurtle(affordance: Affordance, deploymentUrl: string): string {
  const target = affordance.targetTemplate.replace('{base}', deploymentUrl);
  // The action's canonical identity is a dereferenceable URL now. Emit the URL form as the
  // affordance subject + iep:action; the affordance-follow resolver dual-reads (sameAction),
  // so a caller selecting by the legacy urn still matches — no Turtle alias needed.
  const actionIri = actionUrl(affordance.action);

  // hydra:property is an INLINE blank-node rdf:Property carrying the field's name —
  // NOT a minted <action>-prop-<name> IRI under the action authority that nothing
  // serves (those were 100% non-resolvable). A blank node has no IRI to 404, and the
  // property definition (name + comment) travels with the SupportedProperty.
  const inputProps = affordance.inputs.map((input) => {
    return `        [
            a hydra:SupportedProperty ;
            hydra:property [ a rdf:Property ; rdfs:label "${escapeLit(input.name)}" ] ;
            hydra:required ${input.required ? 'true' : 'false'} ;
            rdfs:comment "${escapeLit(input.description)}"${valueConstraints(input, '            ')}
        ]`;
  }).join(' ,\n');

  return `<${actionIri}> a iep:Affordance, ieh:Affordance, hydra:Operation, dcat:Distribution ;
    iep:action <${actionIri}> ;
    hydra:method "${affordance.method}" ;
    hydra:title "${escapeLit(affordance.title)}" ;
    rdfs:comment "${escapeLit(affordance.description)}" ;
    hydra:target <${target}> ;
    dcat:accessURL <${target}> ;
    ${affordance.mediaType ? `dcat:mediaType "${affordance.mediaType}" ;` : ''}
    ${affordance.returns ? `hydra:returns <${affordance.returns}> ;` : ''}
${affordance.returns ? '' : returnsBlock(affordance)}
    hydra:expects [
        a hydra:Class ;
        rdfs:label "${escapeLit(affordance.toolName)}-input"${inputProps.trim()
      ? ` ;
        hydra:supportedProperty
${inputProps}`
      : ''}
    ] ;
${annotationsBlock(affordance)}${advertisementBlock(affordance)}${readsBlock(affordance)}    iep:encrypted false .`;
}

/** Multi-affordance turtle document with prefixes and a common manifest IRI. */
export function affordancesManifestTurtle(
  manifestIri: string,
  affordances: readonly Affordance[],
  deploymentUrl: string,
  options?: { verticalLabel?: string; rdfsComment?: string },
): string {
  const prefixes = AFFORDANCE_TURTLE_PREFIXES;

  const manifestBlock = `<${manifestIri}> a hydra:Collection ;
    rdfs:label "${escapeLit(options?.verticalLabel ?? 'Vertical capability manifest')}" ;
    ${options?.rdfsComment ? `rdfs:comment "${escapeLit(options.rdfsComment)}" ;` : ''}
${affordances.map(a => `    iep:affordance <${actionUrl(a.action)}>`).join(' ;\n')} .`;

  const blocks = affordances.map(a => affordanceToTurtle(a, deploymentUrl)).join('\n\n');

  return `${prefixes}\n\n${manifestBlock}\n\n${blocks}\n`;
}

// ── Internals ────────────────────────────────────────────────────────

function escapeLit(s: string): string {
  /**
   * ★ DELEGATES TO THE SINGLE SOURCE OF TRUTH, because this local subset produced INVALID Turtle.
   *
   * Measured by embedding the output in `<s> <p> "…" .` and parsing: a value containing a newline
   * or a carriage return failed to parse at all. Escaping `\` and `"` is enough to stop injection
   * — and it was correct here, in the right order — but Turtle's STRING_LITERAL_QUOTE also forbids
   * raw LF, CR and TAB, so any multi-line description made the whole document unparseable and the
   * publish fail. `packages/core/src/rdf/escape.ts` has covered all five since it was written, and
   * its own header names this exact drift as the reason it exists.
   */
  return escapeTurtleLiteral(s);
}
