/**
 * agp bridge — pod round-trip helpers for the REAL diagnose/plan handlers.
 *
 * Boundary discipline (audit finding): the engine lives canonically in
 * agp/src/performance-architecture.ts; this module composes it + @interego/solid
 * for persistence. It does NOT import from foxxi-content-intelligence — the
 * dependency arrow is foxxi → agp only (Foxxi re-exports the agp engine via its
 * shim). The coercers below are agp-native (minimal), not borrowed from Foxxi.
 *
 * Honesty contract: a handler returns a real engine result. It persists a
 * descriptor to a pod when a pod_url is configured (best-effort), and reports
 * persisted:false (descriptorUrl:null) when it cannot — never a fabricated URL.
 */
import { createHash } from 'node:crypto';
import {
  type IRI, type ContextDescriptorData, type ContextFacetData,
  // ★ THE CALLER CHOOSES THE POD, SO THE CALLER CHOOSES THE FETCH TARGET. Every handler
  // here takes `pod_url` from the request body and this bridge authenticates nobody, so an
  // unauthenticated request decided where the process connected. Driven against the deployed
  // service: `pod_url: http://169.254.169.254/latest/meta-data/` and `http://10.0.0.5/pod/`
  // were both ATTEMPTED (they hung until timeout); `http://127.0.0.1:3456/` connected and
  // came back `persisted: false`. Blind, and carrying no credential — this bridge writes with
  // a plain fetch, so there is no authority to lend — but it is still a caller-directed
  // outbound connection, which is exactly what the substrate's own rule forbids.
  //
  // Composed, not re-invented: `guardedFetchFn` re-guards the target AND every redirect hop,
  // which is the part a one-off pre-check misses. Foxxi already uses it.
  guardedFetchFn, assertSafeFetchTarget,
} from '@interego/core';
import { publish, PublishShapeViolationError } from '@interego/solid';
import { readShapesTurtle, AGP_SHAPES_NS } from '../src/ontology.js';
import type { PerformanceSituation, Diagnosis, InterventionPlan } from '../src/performance-architecture.js';

const AGP = 'https://markjspivey-xwisee.github.io/interego/applications/agentic-performance-practice/agp#';

/** Deterministic, idempotent IRI (same inputs → same IRI), so repeat calls
 *  don't mint a new node each time. */
export function deterministicIri(prefix: string, seed: string): IRI {
  return `urn:agp:${prefix}:${createHash('sha256').update(seed).digest('hex').slice(0, 16)}` as IRI;
}

/** Minimal coercion of an inline JSON object into a PerformanceSituation.
 *  Returns null if the required fields are absent (the handler then degrades). */
export function coerceSituation(raw: unknown): PerformanceSituation | null {
  if (!raw || typeof raw !== 'object') return null;
  const s = raw as Record<string, unknown>;
  if (!s.id || !s.workContext || !s.competency || !s.observed) return null;
  const perf = (s.performer ?? {}) as Record<string, unknown>;
  const freq = ['continuous', 'frequent', 'occasional', 'rare'];
  const crit = ['low', 'moderate', 'high', 'safety-critical'];
  return {
    id: String(s.id),
    performer: { id: String(perf.id ?? 'urn:agp:performer:anon'), kind: perf.kind === 'human' ? 'human' : 'agent', role: perf.role ? String(perf.role) : undefined },
    workContext: String(s.workContext),
    competency: String(s.competency),
    observed: String(s.observed),
    frequency: (freq.includes(String(s.frequency)) ? s.frequency : 'occasional') as PerformanceSituation['frequency'],
    criticality: (crit.includes(String(s.criticality)) ? s.criticality : 'moderate') as PerformanceSituation['criticality'],
    modalStatus: (s.modalStatus === 'Asserted' || s.modalStatus === 'Counterfactual' ? s.modalStatus : 'Hypothetical') as PerformanceSituation['modalStatus'],
    provenance: String(s.provenance ?? 'inline'),
    ...(s.domain ? { domain: s.domain as PerformanceSituation['domain'] } : {}),
  };
}

/** Minimal coercion of an inline JSON object into a Diagnosis. */
export function coerceDiagnosis(raw: unknown): Diagnosis | null {
  if (!raw || typeof raw !== 'object') return null;
  const d = raw as Record<string, unknown>;
  if (!d.situationId || !d.method || !d.regimeSource) return null;
  /**
   * ★ REFUSE A `factors` THE ENGINE WILL CRASH ON, RATHER THAN LET IT CRASH.
   *
   * `recommendInterventions` reads `factors.instrumentation.adequate` and its five siblings on
   * the Knowable branch. This function used to cast straight through, so a caller passing the
   * natural-looking `factors: ['no shared model of the topology']` — an array of strings — got
   * `Cannot read properties of undefined (reading 'adequate')` back over HTTP: an internal
   * TypeError as an API response, from a bridge whose every other handler declines honestly.
   *
   * Absent and PARTIAL `factors` are legal — but only because the engine was made to mean it.
   * This comment previously asserted "the engine treats an unsupplied factor as adequate" while
   * `recommendInterventions` still ran `diagnosis.factors!` and dereferenced `.information` on
   * it, so a diagnosis with no factors, or with three of the six, returned the same internal
   * TypeError this guard exists to prevent. The engine now reads every factor through an
   * absence-tolerant helper, which is what the rest of that branch already assumed by testing
   * `=== false`. What is refused here is a PRESENT `factors` of the wrong SHAPE (an array, a
   * string, entries without `adequate`) — a caller error worth declining rather than guessing.
   */
  if (d.factors !== undefined) {
    const f = d.factors;
    const wrongShape = typeof f !== 'object' || f === null || Array.isArray(f)
      || !Object.values(f as Record<string, unknown>).every(
        v => typeof v === 'object' && v !== null && 'adequate' in (v as Record<string, unknown>));
    if (wrongShape) return null;
  }
  return d as unknown as Diagnosis;
}

/** Minimal coercion of an inline JSON object into an InterventionPlan, for the
 *  evaluate-intervention path. Returns null when the two fields evaluateIntervention
 *  actually dereferences (`diagnosis`, `selected`) are absent — the handler then
 *  degrades honestly rather than crashing inside the engine. */
export function coercePlan(raw: unknown): InterventionPlan | null {
  if (!raw || typeof raw !== 'object') return null;
  const p = raw as Record<string, unknown>;
  if (!p.diagnosis || !Array.isArray(p.selected)) return null;
  return p as unknown as InterventionPlan;
}

/** Best-effort GET of an IRI as JSON from a pod (for the situation_iri/diagnosis_iri
 *  path). Returns null on any failure — the handler degrades to inline-only. */
export async function fetchJson(iri: string, podUrl?: string, fetchFn: typeof fetch = globalThis.fetch): Promise<unknown | null> {
  try {
    const url = iri.startsWith('http') ? iri : (podUrl ? new URL(iri.replace(/^urn:[^:]+:/, ''), podUrl).toString() : null);
    if (!url) return null;
    /**
     * ★★ THE REDIRECT CHAIN IS PART OF THE TARGET, AND A PRE-CHECK DOES NOT COVER IT.
     *
     * This screened `url` and then handed it to a RAW fetch, whose default is
     * `redirect: 'follow'`. So a public host that 302s to `http://169.254.169.254/` or
     * `http://10.0.0.5/` was followed and its body returned into the handler — the exact
     * gap the sibling sites in this same commit close by composing `guardedFetchFn`, whose
     * `safeFetch` sets `redirect: 'manual'` and re-runs the screen on every `Location`.
     * Reached from `agp.diagnose` (`situation_iri`) and `agp.plan_intervention`
     * (`diagnosis_iri`) on a bridge that authenticates nobody.
     *
     * The pre-check is KEPT as well as the wrapper: it refuses the first hop before a socket
     * opens, which is what makes a private target fail fast rather than hang.
     */
    try { await assertSafeFetchTarget(url); } catch { return null; }
    const guarded = guardedFetchFn(fetchFn);
    const r = await guarded(url, { headers: { accept: 'application/json, application/ld+json' } });
    if (!r.ok) return null;
    return await r.json();
  } catch { return null; }
}

/** A domain triple the artifact MUST carry. agp-shapes.ttl makes these
 *  mandatory for six of the seven publishable classes; a publisher that
 *  cannot emit them can only emit invalid nodes. */
export interface AgpProperty {
  readonly predicate: string;
  /** A literal may declare a datatype: `iep:success` has `rdfs:range xsd:boolean`, and a
   *  plain-string "true" is not an xsd:boolean — a shape checking the datatype would refuse
   *  it, and a reader expecting a boolean would read a string. The lexical form still goes
   *  through `JSON.stringify` and the datatype through `iriTerm`, so neither can inject. */
  readonly object: { readonly iri: string } | { readonly literal: string; readonly datatype?: string };
}

/**
 * ★ TURTLE INJECTION POSITION. situation_iri / capability_iri / affordance_iri /
 * requires_capability_iri are CALLER-SUPPLIED and land inside `<...>`. A value
 * containing `>` closes the term and everything after it parses as further
 * triples — a caller could add agp:composedOf to a capability it does not own.
 *
 * This is the RFC3987 IRIREF exclusion set: U+0000..U+0020 plus < > " { } | ^ `
 * and backslash. Anything outside it is REFUSED, never escaped — an
 * escaped-but-nonsense IRI is a silent wrong answer, and this repo has already
 * been bitten by Turtle injection in three separate positions.
 */
// eslint-disable-next-line no-control-regex
const UNSAFE_IRI_CHAR = /[\x00-\x20<>"{}|^`\\]/;

function iriTerm(iri: string): string {
  if (iri.length === 0 || UNSAFE_IRI_CHAR.test(iri)) {
    throw new Error(`publishAgpArtifact: refusing to serialize an unsafe IRI (Turtle injection position): ${JSON.stringify(iri).slice(0, 120)}`);
  }
  return `<${iri}>`;
}

/** The graph IRI an artifact's triples live at — a fragment of the artifact's own IRI. */
export function agpArtifactGraphIri(iri: string): string {
  return `${iri}#graph`;
}

/** The Interego Protocol namespace. `iep:success` is a PROTOCOL term with
 *  `rdfs:range xsd:boolean`, belonging to no vertical. */
const IEP_NS = 'https://markjspivey-xwisee.github.io/interego/ns/iep#';
const XSD_NS = 'http://www.w3.org/2001/XMLSchema#';

/**
 * The domain triples an `agp:InterventionEvaluation` carries — the ONE place this vertical
 * decides what an evaluation says on a pod.
 *
 * ★ Extracted for the same reason `agpArtifactGraph` is: a demo tool that hand-writes the
 * predicates it wants a reader to find is not evidence that a reader can read this
 * vertical's records. Both the `agp.evaluate_intervention` handler and any program that
 * wants a record this vertical would recognise call this.
 */
export function agpEvaluationProperties(
  interventionIri: string,
  verdict: 'closed' | 'improved' | 'no-change' | 'worsened' | 'too-early',
): readonly AgpProperty[] {
  return [
    { predicate: `${AGP}evaluates`, object: { iri: interventionIri } },
    { predicate: `${AGP}verdict`, object: { literal: verdict } },
    // `too-early` asserts NO outcome, so none is serialized. An outcome nobody asserted must
    // not become one a serializer invented — the same rule the reader on the other side
    // follows when it skips a record rather than defaulting its `success`.
    ...(verdict === 'too-early' ? [] : [{
      predicate: `${IEP_NS}success`,
      object: { literal: (verdict === 'closed' || verdict === 'improved') ? 'true' : 'false', datatype: `${XSD_NS}boolean` },
    } as AgpProperty]),
  ];
}

/**
 * The observed outcome of an `agp:Actualization`, as triples.
 *
 * ── ★★ WHY THIS EXISTS: TWO INPUTS THAT WERE ACCEPTED AND SILENTLY DROPPED ───────────────────
 *
 * `agp.actualize` declared `success` and `score_scaled`, and its own affordance description said
 * so out loud — "ACCEPTED BUT NOT YET RECORDED … nothing reads this field today". Driven for real
 * with `success: true, score_scaled: 0.9`, neither value appeared in the result or in the
 * published triples, and the call answered 200. A caller that sends an outcome and is told the
 * request succeeded has been told the outcome was recorded.
 *
 * That is the same defect as publishing an affordance with no service behind it, moved one level
 * down: documenting it made the record honest and left the caller's data on the floor. So it is
 * recorded, and the handler REFUSES a score outside the range it advertises rather than rounding
 * or dropping it.
 *
 * ★ `iep:success` IS REUSED, NOT REMINTED. It is a protocol term with `rdfs:range xsd:boolean`
 * and this vertical already writes it for interventions, three functions up. `agp:scoreScaled` is
 * new because nothing in reach carried a scaled score; it mirrors xAPI's `result.score.scaled`,
 * which is the shape a later LRS projection would read.
 *
 * ★ xsd:double, NOT xsd:decimal, and the reason is lexical. `String(1e-7)` is `"1e-7"`, which is
 * not a valid `xsd:decimal` — forcing one would mean rounding to a fixed number of places, and
 * publishing a number nobody sent is the failure this function exists to stop. Exponential
 * notation is a valid `xsd:double`, so the value round-trips as given.
 *
 * An outcome nobody asserted must not become one a serializer invented, which is the rule
 * `agpEvaluationProperties` already follows for `too-early`: `undefined` emits nothing.
 */
export function agpOutcomeProperties(
  success: boolean | undefined,
  scoreScaled: number | undefined,
): readonly AgpProperty[] {
  const out: AgpProperty[] = [];
  if (success !== undefined) {
    out.push({
      predicate: `${IEP_NS}success`,
      object: { literal: success ? 'true' : 'false', datatype: `${XSD_NS}boolean` },
    });
  }
  if (scoreScaled !== undefined) {
    out.push({
      predicate: `${AGP}scoreScaled`,
      object: { literal: String(scoreScaled), datatype: `${XSD_NS}double` },
    });
  }
  return out;
}

/**
 * The Turtle body of one agp artifact — the ONLY place this vertical serializes one.
 *
 * ★ EXTRACTED SO NOTHING CAN HAND-WRITE AN AGP RECORD AND CALL IT ONE. A demo tool
 * previously published three graphs typed `a agp:Diagnosis` that it composed itself, and
 * they carried exactly the predicates an observation map happened to require and NEITHER of
 * the two `agpsh:DiagnosisShape` demands — so they were invalid agp:Diagnosis nodes on a
 * live pod, and the "a third vertical joins with no edit" claim they supported was measuring
 * records authored to match the map. Any caller that wants a record this vertical would
 * recognise calls this; a caller that composes its own is visibly not doing that.
 */
export function agpArtifactGraph(args: {
  iri: string; typeIri: string; label: string;
  properties?: ReadonlyArray<AgpProperty>;
}): { graphIri: string; graphContent: string } {
  const graphIri = agpArtifactGraphIri(args.iri);
  const triples = [
    `a ${iriTerm(args.typeIri)}`,
    `<http://www.w3.org/2000/01/rdf-schema#label> ${JSON.stringify(args.label)}`,
    ...(args.properties ?? []).map(p => `${iriTerm(p.predicate)} ${'iri' in p.object
      ? iriTerm(p.object.iri)
      : `${JSON.stringify(p.object.literal)}${p.object.datatype !== undefined ? `^^${iriTerm(p.object.datatype)}` : ''}`}`),
  ];
  return { graphIri, graphContent: `${iriTerm(graphIri)} ${triples.join(' ;\n  ')} .\n` };
}

/**
 * The identity-bearing facets of an agp artifact. PURE and exported, so what this bridge
 * CLAIMS about who asserted a descriptor is testable without a pod, a network, or the egress
 * screen.
 *
 * ★ IT TAKES NO AUTHOR ARGUMENT, AND THAT IS THE POINT. A caller's `operator_did` reached
 * `prov:wasAttributedTo`, the `assertingAgent` identity and the Trust issuer — with
 * `trustLevel: SelfAsserted`, which asserts the subject said this about itself. This bridge
 * authenticates nobody, so an anonymous request could publish a claim attributed to any DID it
 * named. That is the #168 shape (project_credential_issuer_binding): a caller-supplied
 * identity deciding what the substrate then states as fact.
 *
 * The bridge is what asserted the artifact, so the bridge is what these name — which also makes
 * `iep:SelfAsserted` honest rather than borrowed. The caller's claim is not discarded: it is
 * published as `agp:claimedOperator`, a string and explicitly unverified, in the graph.
 *
 * ★ EXTRACTED BECAUSE THE TEST FOR IT COULD NOT REACH IT. The first test asserted on
 * `agpArtifactGraph`, a helper BESIDE this decision, so the whole fix could be reverted with
 * the suite green; and driving `publishAgpArtifact` directly now stops at
 * `assertSafeFetchTarget`, which does a DNS lookup no offline test can satisfy. The security
 * fix and the testability of the thing it guards were in tension — this resolves it by making
 * the ATTRIBUTION a pure function rather than a side effect of publishing.
 */
export function agpAttributionFacets(now: string): ContextFacetData[] {
  const BRIDGE_AGENT = 'urn:agp:bridge:agent' as IRI;
  return [
    { type: 'Temporal', validFrom: now },
    { type: 'Provenance', wasAttributedTo: BRIDGE_AGENT, generatedAtTime: now },
    { type: 'Agent', assertingAgent: { id: BRIDGE_AGENT, identity: BRIDGE_AGENT, isSoftwareAgent: true } },
    { type: 'AccessControl', authorizations: [{ agentClass: 'http://xmlns.com/foaf/0.1/Agent' as IRI, mode: ['Read'] }] },
    { type: 'Semiotic', modalStatus: 'Asserted', groundTruth: true },
    { type: 'Trust', trustLevel: 'SelfAsserted', issuer: BRIDGE_AGENT },
  ] as ContextFacetData[];
}

/** Best-effort REAL publish of an agp artifact as a signed-authorship-free
 *  ContextDescriptor + a graph carrying the domain triples its class's SHACL
 *  shape requires. Returns the descriptor URL on success, null on a TRANSPORT
 *  failure (caller reports persisted:false). A shape violation is RE-THROWN. */
export async function publishAgpArtifact(args: {
  iri: IRI; typeIri: string; label: string; podUrl: string;
  author?: { id: string; kind: 'human' | 'agent'; role?: string };
  containerPath?: string; slug: string; fetchFn?: typeof fetch;
  /** Domain triples the class's SHACL shape requires. Omitting them is a
   *  defect, not a degradation — the gate below refuses the write. */
  properties?: ReadonlyArray<AgpProperty>;
}): Promise<string | null> {
  // Built OUTSIDE the try: an unsafe IRI is a caller defect and must throw,
  // not be reported as a pod outage.
  /**
   * The caller's unverified `operator_did`, carried as a CLAIM in the graph rather than as an
   * identity in the provenance. Appended here, not in `agpArtifactGraph`, so the graph builder
   * stays a pure projection of what it was given.
   */
  const claimed = args.author?.id;
  const built = agpArtifactGraph(claimed
    ? { ...args, properties: [...(args.properties ?? []), {
        predicate: `${AGP}claimedOperator`,
        object: { literal: String(claimed) },
      }] }
    : args);
  const graphIri = built.graphIri as IRI;
  const graphContent = built.graphContent;
  try {
    const now = new Date().toISOString();
    /**
     * ★★ THE BRIDGE IS WHAT ASSERTED THIS. THE CALLER'S `operator_did` IS A CLAIM.
     *
     * This read `args.author?.id ?? 'urn:agp:bridge:agent'`, and `args.author.id` is the
     * `operator_did` a caller put in the request body. This bridge authenticates NOBODY, so an
     * anonymous request chose the published `prov:wasAttributedTo`, the `assertingAgent`
     * identity, AND the Trust facet's issuer — with `trustLevel: SelfAsserted`, which means
     * "the subject asserted this about itself". Nobody had. A reader dereferencing the
     * descriptor saw an identity that had done nothing.
     *
     * That is the shape recorded as #168: a caller-supplied `issuer_did` deciding what the
     * substrate then states as fact. It cost a signing key there; here it costs attribution,
     * which is the thing descriptors exist to carry.
     *
     * So the three identity-bearing facets name the BRIDGE — true, and it makes
     * `iep:SelfAsserted` honest, since the bridge really is asserting about itself. The
     * caller's claim is kept, as `agp:claimedOperator`: a STRING, explicitly unverified,
     * where a reader can see it is a claim rather than an identity.
     */
    const facets = agpAttributionFacets(now);
    const descriptor: ContextDescriptorData = { id: args.iri, describes: [graphIri], facets, conformsTo: [args.typeIri as IRI], version: 1 };
    // ★ THE GATE THAT WAS NEVER ARMED. publish() has taken a conformsToShapes list
    // since the shape-gate work; this call never passed one, and this bridge writes
    // to the pod DIRECTLY rather than through the relay — so agp's own published
    // SHACL shapes were applied to agp's own writes zero times. MEASURED against
    // ontology/agp-shapes.ttl: the label-only graph this function used to emit fails
    // Diagnosis, PerformanceSituation, Capability, PerformanceAffordance,
    // Actualization and InterventionEvaluation, and agp.diagnose has been publishing
    // invalid agp:Diagnosis nodes for real.
    // Refuse a private / link-local / loopback target BEFORE connecting, then hand the
    // walker a fetch that re-guards every hop it makes.
    await assertSafeFetchTarget(args.podUrl);
    const r = await publish(descriptor, graphContent, args.podUrl, {
      fetch: guardedFetchFn(args.fetchFn ?? globalThis.fetch.bind(globalThis)),
      containerPath: args.containerPath ?? 'agp/work-products/',
      descriptorSlug: args.slug,
      graphSlug: `${args.slug}-graph`,
      conformsToShapes: [{ shapeIri: AGP_SHAPES_NS, shapeTurtle: readShapesTurtle() }],
    } as Parameters<typeof publish>[3]);
    return (r as { descriptorUrl?: string })?.descriptorUrl ?? null;
  } catch (err) {
    // A shape violation is a defect IN THIS BRIDGE, not a pod outage. Degrading it
    // to persisted:false is exactly how the invalid Diagnosis nodes stayed
    // invisible: a programming error and a network blip reported identically.
    // Only transport failures degrade.
    if (err instanceof PublishShapeViolationError) throw err;
    return null;
  }
}

export { AGP };
