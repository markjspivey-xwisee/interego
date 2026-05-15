/**
 * @module @interego/compliance-overlay/overlay
 * @description Substrate-pure agent-action → compliance-descriptor
 *              translator. No runtime imports.
 *
 * Architectural framing: every agent action — a tool call the runtime
 * emits — is structurally a `prov:Activity` performed by an agent on
 * behalf of an owner, producing a typed result, optionally citing a
 * regulatory control. Interego already encodes this via the Provenance
 * facet + a compliance flag + framework-citation predicates
 * (dct:conformsTo). This module is the translator from the runtime's
 * `(toolName, args, result, outcome)` shape to a typed descriptor +
 * graph block ready for `publish_context(compliance: true, ...)`.
 *
 * Three regulatory surfaces are supported via the existing
 * FRAMEWORK_CONTROLS table:
 *   - 'eu-ai-act' — Article 9, 10, 12, 13, 14, 15
 *   - 'nist-rmf'  — Govern / Map / Measure / Manage
 *   - 'soc2'      — CC4.1, CC8.1, CC9.2, etc.
 *
 * The overlay does not invent new event types. It uses
 * prov:Activity + cg:AgentToolCall (a minor cgh: subclass already
 * carried in the ontology) plus dct:conformsTo to cite the controls.
 * If the runtime's tool happens to map onto an existing operator
 * event type (DeployEvent, AccessChangeEvent, …), the runtime can
 * call those builders directly and skip this overlay; this module is
 * for the long tail of generic agent actions.
 */

import {
  ContextDescriptor,
  publish,
  sha256,
  FRAMEWORK_CONTROLS,
  screenForSensitiveContent,
  shouldBlockOnSensitivity,
  formatSensitivityWarning,
  type IRI,
  type ComplianceFramework,
} from '../../../src/index.js';

// ── Public types ─────────────────────────────────────────────────────

export type ActionOutcome = 'success' | 'failure' | 'partial';

export interface AgentActionEvent {
  /** Tool/affordance the runtime invoked (e.g. 'web_browser.fetch'). */
  readonly toolName: string;
  /** Arguments the runtime passed; serialized into the descriptor body. */
  readonly args: Record<string, unknown>;
  /** Optional result summary — prefer a short string over raw bytes. */
  readonly resultSummary?: string;
  /** Did it succeed, partially complete, or fail? */
  readonly outcome: ActionOutcome;
  /** Optional error message when outcome === 'failure' or 'partial'. */
  readonly errorMessage?: string;
  /** Timing in ms — useful for SLA / audit checks. */
  readonly durationMs?: number;
  /** Activity start timestamp (ISO 8601). */
  readonly startedAt?: string;
  /** Activity end timestamp (ISO 8601). */
  readonly endedAt?: string;
  /** Agent identity (DID). */
  readonly agentDid: IRI;
  /** Human/org owner the agent is acting on behalf of (PROV-O). */
  readonly onBehalfOf?: IRI;
  /** Free-form session identifier the runtime tracks. */
  readonly sessionId?: string;
}

export interface ComplianceCitation {
  readonly framework: ComplianceFramework;
  /**
   * Specific control IRIs cited by this action. Pass an empty list to
   * cite every default control for the framework (see FRAMEWORK_CONTROLS).
   */
  readonly controls?: readonly IRI[];
}

export interface BuildEventResult {
  readonly descriptor: import('../../../src/index.js').ContextDescriptorData;
  readonly graphIri: IRI;
  readonly graphContent: string;
  readonly eventIri: IRI;
  readonly contentHash: string;
  /** Resolved control IRIs (after defaulting). */
  readonly cited: readonly IRI[];
  /**
   * Sensitivity flags surfaced by the pre-construction privacy
   * preflight. Empty array means no secrets / PII detected. The
   * preflight ALWAYS runs on compliance descriptors — compliance
   * evidence is the highest-stakes surface, so there is no opt-out.
   * With `onSensitiveArgs: 'block'` (the default), construction
   * throws on HIGH flags rather than returning them here.
   */
  readonly sensitivityFlags?: readonly import('../../../src/index.js').SensitivityFlag[];
}

export interface OverlayConfig {
  readonly podUrl: string;
  /** Default citation when the per-event call doesn't override. */
  readonly defaultCitation: ComplianceCitation;
  /** Optional default delegates for E2EE share. */
  readonly defaultShareWith?: readonly IRI[];
  /**
   * Default true: include the full args object in the descriptor's
   * body. Set false for runtimes that may pass sensitive content as
   * args; the privacy preflight in src/privacy/ runs at publish time
   * AND at construction time (see `onSensitiveArgs` below).
   */
  readonly recordArgs?: boolean;
  /**
   * Policy for handling sensitive content detected in args / result /
   * error fields. Default `'block'` — refuse to construct the descriptor
   * if HIGH-severity flags are present (API keys, JWTs, private keys).
   * `'warn'` allows construction but exposes flags on the result so the
   * caller can decide. There is deliberately NO `'allow'` mode: a
   * compliance descriptor that bypasses sensitivity screening defeats
   * the purpose of compliance evidence. Pre-screening pipelines should
   * sanitize args BEFORE calling `buildAgentActionDescriptor` — the
   * overlay runs the preflight unconditionally.
   */
  readonly onSensitiveArgs?: 'block' | 'warn';
}

// ── Substrate construction ──────────────────────────────────────────

const CG_NS = 'https://markjspivey-xwisee.github.io/interego/ns/cg#';
const CGH_NS = 'https://markjspivey-xwisee.github.io/interego/ns/harness#';
const PROV_NS = 'http://www.w3.org/ns/prov#';
const DCT_NS = 'http://purl.org/dc/terms/';
const RDFS_NS = 'http://www.w3.org/2000/01/rdf-schema#';
const XSD_NS = 'http://www.w3.org/2001/XMLSchema#';

// We compose with W3C vocab where it fits (prov:Activity, dct:type,
// dct:description, dct:conformsTo, prov:startedAtTime,
// prov:endedAtTime, prov:wasAttributedTo, prov:wasAssociatedWith) and
// add a small harness (cgh:) ontology layer for the substrate-pattern
// terms that have no W3C analog (auditable agent-action filtering,
// JSON-encoded args, machine-readable outcome / duration / session-id).
const ACTION_TYPE = `${CGH_NS}AgentAction` as IRI;

function escapeLit(s: string): string { return s.replace(/\\/g, '\\\\').replace(/"/g, '\\"'); }
function escapeMulti(s: string): string {
  // Escape every double-quote (not just `"""` substrings) so a value
  // ending in 1 or 2 quotes can't collide with the closing `"""` of
  // the Turtle triple-quoted literal. Over-escapes a bit; always
  // round-trips. See tests/skills.test.ts adversarial section.
  return s.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}
function nowIso(): string { return new Date().toISOString(); }

function resolveControls(citation: ComplianceCitation): readonly IRI[] {
  if (citation.controls && citation.controls.length > 0) return citation.controls;
  return FRAMEWORK_CONTROLS[citation.framework].map(c => c.iri);
}

/**
 * Substrate-pure construction: takes an agent action event + citation
 * and produces a typed descriptor + named-graph TriG block. Pure
 * synchronous; testable without a pod. Caller publishes the result.
 *
 * Privacy preflight: the overlay ALWAYS screens the canonical JSON of
 * args, the result summary, and the error message via the substrate's
 * `screenForSensitiveContent`. `onSensitiveArgs: 'block'` (default)
 * refuses to construct on HIGH severity (API keys, JWTs, private keys);
 * `'warn'` returns the flags on the result so the caller can decide.
 * There is no `'allow'` mode — compliance evidence is the highest-stakes
 * surface, so screening is non-negotiable. Stops the most common leak
 * shape: a runtime forwarding its tool args to compliance recording
 * with secrets inside.
 */
export function buildAgentActionDescriptor(
  event: AgentActionEvent,
  citation: ComplianceCitation,
  options?: { recordArgs?: boolean; onSensitiveArgs?: 'block' | 'warn' },
): BuildEventResult {
  const recordArgs = options?.recordArgs ?? true;
  const onSensitive = options?.onSensitiveArgs ?? 'block';

  // Stable content hash combines tool name + args + outcome + agent.
  // Same action by same agent → same IRI (de-duplicated audit entry).
  const argsCanonical = recordArgs
    ? canonicalJson(event.args)
    : '<args:redacted>';

  // ── Privacy preflight ──────────────────────────────────────────
  // Screen everything that lands in the descriptor body. The runtime
  // may forward user-controlled strings (transcripts, tool args, error
  // messages) — these are the most common shapes for a secrets-in-
  // audit-log leak.
  // Screening is unconditional — compliance evidence cannot opt out.
  let sensitivityFlags: readonly import('../../../src/index.js').SensitivityFlag[] = [];
  const screenInput = [
    recordArgs ? argsCanonical : '',
    event.resultSummary ?? '',
    event.errorMessage ?? '',
  ].filter(s => s.length > 0).join('\n');
  if (screenInput.length > 0) {
    sensitivityFlags = screenForSensitiveContent(screenInput);
    if (onSensitive === 'block' && shouldBlockOnSensitivity(sensitivityFlags)) {
      const warning = formatSensitivityWarning(sensitivityFlags);
      throw new Error(`compliance-overlay refused to construct descriptor: detected high-severity sensitive content. ${warning}. Pass onSensitiveArgs: 'warn' to surface flags without blocking, or sanitize the args before calling buildAgentActionDescriptor.`);
    }
  }
  const fingerprint = [
    event.toolName,
    argsCanonical,
    event.outcome,
    event.errorMessage ?? '',
    event.agentDid,
    event.onBehalfOf ?? '',
    event.startedAt ?? '',
    event.endedAt ?? '',
  ].join('|');
  const contentHash = sha256(fingerprint);
  const id = contentHash.slice(0, 16);

  const eventIri = `urn:cg:agent-action:${slug(event.toolName)}:${id}` as IRI;
  const graphIri = `urn:graph:cg:agent-action:${id}` as IRI;
  const owner = event.onBehalfOf ?? event.agentDid;
  const startedAt = event.startedAt ?? nowIso();
  const endedAt = event.endedAt ?? startedAt;

  const cited = resolveControls(citation);

  // Modal-status mapping: success → Asserted, failure → Counterfactual
  // (the action did NOT achieve its intended effect; auditing wants
  // that distinction surfaced via groundTruth=false). Partial is
  // Hypothetical (uncertain success).
  const builder = ContextDescriptor.create(eventIri)
    .describes(graphIri)
    .agent(event.agentDid)
    .selfAsserted(event.agentDid)
    .generatedBy(event.agentDid, { onBehalfOf: owner, endedAt, startedAt })
    .temporal({ validFrom: startedAt });

  switch (event.outcome) {
    case 'success': builder.asserted(0.95); break;
    case 'partial': builder.hypothetical(0.6); break;
    case 'failure': builder.semiotic({ modalStatus: 'Counterfactual', groundTruth: false, epistemicConfidence: 0.95 }); break;
  }

  const descriptor = builder.build();

  // Build the typed RDF graph. Compliance citation goes through
  // dct:conformsTo (one triple per cited control IRI). The framework
  // itself becomes a typed property so SPARQL queries can filter.
  const conformsToTriples = cited.map(c => `    <${DCT_NS}conformsTo> <${c}>`).join(' ;\n');
  const conformsTail = cited.length > 0 ? conformsToTriples + ' ;\n' : '';

  // dct:description carries the result summary on success / partial,
  // and the error message on failure — unified field, modal-status
  // tells the auditor which case applies.
  const descriptionText = event.outcome === 'failure'
    ? (event.errorMessage ?? event.resultSummary ?? '')
    : (event.resultSummary ?? '');
  const descriptionTriple = descriptionText.length > 0
    ? `    <${DCT_NS}description> """${escapeMulti(descriptionText)}""" ;\n`
    : '';
  const durationTriple = event.durationMs !== undefined
    ? `    <${CGH_NS}durationMs> "${event.durationMs}"^^<${XSD_NS}integer> ;\n`
    : '';
  const sessionTriple = event.sessionId
    ? `    <${CGH_NS}sessionId> "${escapeLit(event.sessionId)}" ;\n`
    : '';
  const argsBlock = recordArgs
    ? `    <${CGH_NS}toolArgs> """${escapeMulti(canonicalJson(event.args))}""" ;\n`
    : '';

  const graphContent = `<${eventIri}> a <${ACTION_TYPE}> , <${PROV_NS}Activity> ;
    <${RDFS_NS}label> "${escapeLit(event.toolName)}" ;
    <${CGH_NS}outcome> "${escapeLit(event.outcome)}" ;
${argsBlock}${descriptionTriple}${durationTriple}${sessionTriple}${conformsTail}    <${CG_NS}contentHash> "${contentHash}" ;
    <${PROV_NS}startedAtTime> "${startedAt}"^^<${XSD_NS}dateTime> ;
    <${PROV_NS}endedAtTime> "${endedAt}"^^<${XSD_NS}dateTime> ;
    <${PROV_NS}wasAttributedTo> <${owner}> ;
    <${PROV_NS}wasAssociatedWith> <${event.agentDid}> .
`;

  return {
    descriptor,
    graphIri,
    graphContent,
    eventIri,
    contentHash,
    cited,
    ...(sensitivityFlags.length > 0 ? { sensitivityFlags } : {}),
  };
}

// ── Async write through the substrate ───────────────────────────────

export interface RecordAgentActionResult {
  readonly eventIri: IRI;
  readonly descriptorUrl: string;
  readonly graphUrl: string;
  readonly cited: readonly IRI[];
}

/**
 * Persist an agent action through the substrate as a compliance-grade
 * descriptor. The default-citation supplied at config time is used
 * unless the per-call citation overrides.
 *
 * What composes by default: signed Trust facet (self-asserted at
 * publish; the pod's wallet-rooted signing happens server-side when
 * called via the MCP `publish_context(compliance: true, ...)` path).
 * For deeper anchoring (IPFS CID, sigchain), use the MCP server's
 * compliance route — this overlay produces the descriptor + graph;
 * it doesn't replicate signing.
 */
export async function recordAgentAction(
  event: AgentActionEvent,
  config: OverlayConfig,
  citation?: ComplianceCitation,
): Promise<RecordAgentActionResult> {
  const cite = citation ?? config.defaultCitation;
  const built = buildAgentActionDescriptor(event, cite, {
    recordArgs: config.recordArgs,
    onSensitiveArgs: config.onSensitiveArgs,
  });
  const publishOpts = config.defaultShareWith && config.defaultShareWith.length > 0
    ? { shareWith: config.defaultShareWith }
    : undefined;
  const r = await publish(built.descriptor, built.graphContent, config.podUrl, publishOpts);
  return {
    eventIri: built.eventIri,
    descriptorUrl: r.descriptorUrl,
    graphUrl: r.graphUrl,
    cited: built.cited,
  };
}

// ── Helpers ──────────────────────────────────────────────────────────

function slug(s: string): string {
  return s.replace(/[^a-zA-Z0-9-]/g, '-').slice(0, 64);
}

function canonicalJson(value: unknown): string {
  // Stable JSON for hashing: keys sorted, no whitespace.
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return '[' + value.map(canonicalJson).join(',') + ']';
  const keys = Object.keys(value).sort();
  const obj = value as Record<string, unknown>;
  return '{' + keys.map(k => JSON.stringify(k) + ':' + canonicalJson(obj[k])).join(',') + '}';
}
