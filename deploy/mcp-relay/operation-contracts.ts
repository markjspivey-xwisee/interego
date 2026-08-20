/**
 * @module operation-contracts
 * @description The contract URLs `/.well-known/operations` advertises for each operation.
 *
 * ★★ THE CATALOG ADVERTISED 51 CONTRACTS THAT FETCH NOTHING, ON THE ONE SURFACE THAT EXISTS TO
 * TELL A STRANGER WHAT THIS RELAY ACCEPTS.
 *
 * Measured against production before this module existed:
 *
 *   GET /.well-known/operations        -> 51 operations, 51 of them with
 *                                         expects: "urn:iep:shape:input:<name>"
 *                                         returns: "urn:iep:shape:output:<name>"
 *                                         sh:nodeShape: ".../shacl-shapes#urn:iep:shape:input:<name>"
 *   GET /.well-known/shacl-shapes      -> 20 named subjects, ZERO of them `urn:`-prefixed
 *
 * So the `urn:` values are non-dereferenceable by construction, and the `#urn:…` fragment
 * identifies nothing in the document it points at.
 *
 * ★ AND THE SUBSTRATE REFUSES EXACTLY THIS FROM EVERYONE ELSE. `packages/core/src/model/agent.ts`
 * rejects a capability whose `hydra:expects` is not an http(s) URL: "A SHAPE NOBODY CAN FETCH IS
 * NOT A CONTRACT … Absent is fine and means 'this document says nothing about input'; present and
 * unfetchable is refused." The relay was violating, on its own discovery surface, the rule it
 * enforces on every capability anyone else publishes.
 *
 * ── WHY A JSON SCHEMA URL AND NOT A MINTED SHACL SHAPE ──────────────────────────────────────
 *
 * The obvious repair is to publish a SHACL NodeShape per operation. It was rejected on measurement:
 * an operation's inputs are JSON OBJECT KEYS (`content`, `kind`, `iri`), not RDF predicates, so
 * projecting them into SHACL means inventing a predicate IRI for every parameter of every tool —
 * a vocabulary nobody asked for, minted by the engine, which is the same class of thing this whole
 * effort is removing. MCP already defines this contract, as the `inputSchema` / `outputSchema` the
 * relay ALREADY publishes on `tools/list`. Making that document fetchable states the contract that
 * genuinely governs the call, and invents nothing.
 *
 * `sh:nodeShape` is therefore DROPPED rather than repaired. There is no SHACL shape for a given
 * operation, and a pointer to a fragment that identifies nothing is worse than no pointer: it tells
 * a client a shapes graph will answer, so the client goes and looks.
 */

/** A tool's published JSON Schemas, as `TOOL_SCHEMAS` carries them. */
export interface OperationSchemas {
  readonly inputSchema?: unknown;
  readonly outputSchema?: unknown;
}

export interface OperationContract {
  /** Dereferenceable JSON Schema for the request body. Absent when the operation publishes none. */
  readonly expects?: string;
  /** Dereferenceable JSON Schema for the response. Absent when the operation publishes none. */
  readonly returns?: string;
}

const trimBase = (base: string): string => base.replace(/\/$/, '');

/**
 * Where an operation's request/response contract is served.
 *
 * ABSENT, NEVER FABRICATED. An operation with no published schema gets no `expects` — which is the
 * honest reading and the one `agent.ts` names: absent means "this document says nothing about
 * input". Emitting a URL for a schema that does not exist would recreate the defect with a
 * different scheme.
 */
export function operationContract(
  base: string,
  name: string,
  schemas: OperationSchemas | undefined,
): OperationContract {
  const root = `${trimBase(base)}/.well-known/operations/${encodeURIComponent(name)}`;
  const out: { expects?: string; returns?: string } = {};
  if (schemas?.inputSchema !== undefined) out.expects = `${root}/input`;
  if (schemas?.outputSchema !== undefined) out.returns = `${root}/output`;
  return out;
}

/**
 * The action identifier for an operation — the relay's own naming authority, not a urn.
 *
 * The catalog emitted `urn:iep:action:<name>` while the A2A agent card publishes the URL form of
 * the same action (`/ns/iep/action/relay/<verb>`, which 302s to this catalog). A peer that resolved
 * a skill id from the card and tried to match it against the catalog's `action` values found urns
 * and matched nothing — two of the relay's own surfaces naming one action two ways.
 */
export function operationActionUrl(base: string, name: string): string {
  return `${trimBase(base)}/ns/iep/action/relay/${encodeURIComponent(name)}`;
}

/**
 * The document served at an `expects` / `returns` URL: the operation's JSON Schema, carrying its
 * own `$id` so a client that saves it keeps the address it came from.
 */
export function contractDocument(
  base: string,
  name: string,
  kind: 'input' | 'output',
  schemas: OperationSchemas | undefined,
): Record<string, unknown> | undefined {
  const schema = kind === 'input' ? schemas?.inputSchema : schemas?.outputSchema;
  if (schema === undefined || schema === null || typeof schema !== 'object') return undefined;
  const root = `${trimBase(base)}/.well-known/operations/${encodeURIComponent(name)}`;
  return {
    $schema: 'https://json-schema.org/draft/2020-12/schema',
    $id: `${root}/${kind}`,
    title: `${name} — ${kind === 'input' ? 'request body' : 'response'}`,
    ...(schema as Record<string, unknown>),
  };
}
