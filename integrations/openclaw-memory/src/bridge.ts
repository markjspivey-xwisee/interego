/**
 * @module @interego/openclaw-memory/bridge
 * @description Substrate-side memory bridge — pure functions over
 *              Interego primitives. No OpenClaw imports.
 *
 * Architectural framing: a memory write is a typed cg:ContextDescriptor
 * with a Semiotic facet (modal status + epistemic confidence) and a
 * Provenance facet (signed authorship). A memory recall is
 * cross-pod discovery filtered to memory-shaped subjects. A memory
 * "forget" is a supersession by a Counterfactual descriptor — the
 * record is never deleted, only marked as no-longer-active for audit.
 *
 * This module exposes three substrate-pure functions:
 *
 *   storeMemory({ text, kind, ... })        → { descriptorUrl, graphUrl, iri }
 *   recallMemories({ query, kind?, ... })   → MemoryHit[]
 *   forgetMemory({ iri, ... })              → { descriptorUrl, graphUrl }
 *
 * The OpenClaw-specific glue file (./plugin.ts) imports these and wires
 * them into the runtime's tool handlers. Swap the runtime, keep these
 * functions; they're the substrate contract.
 */

import {
  ContextDescriptor,
  publish,
  discover,
  parseTrig,
  findSubjectsOfType,
  readStringValue,
  readStringValues,
  readIriValue,
  sha256,
  type IRI,
} from '../../../src/index.js';

// ── Types ────────────────────────────────────────────────────────────

export interface BridgeConfig {
  /** Pod URL where memories are stored (e.g. https://your-pod.example/agent/). */
  readonly podUrl: string;
  /** DID of the agent doing the writing — sets PROV provenance + signs. */
  readonly authoringAgentDid: IRI;
  /**
   * The DID of the human / org owner the agent is acting on behalf of.
   * If unset, defaults to authoringAgentDid (self-attributed memory).
   * Set this when the agent is delegated by a human owner.
   */
  readonly onBehalfOf?: IRI;
  /**
   * Optional cross-pod recipients. Every memory write is also wrapped
   * with E2EE envelopes for these DIDs (existing share_with semantics).
   */
  readonly defaultShareWith?: readonly IRI[];
}

/**
 * Memory categories — borrowed from OpenClaw's LanceDB integration
 * (facts, preferences, decisions, entities) plus a free-form
 * "observation" for everything else. The substrate doesn't enforce
 * this taxonomy; it's a convention the runtime uses to drive auto-recall
 * and to support `memory_forget` by category. Any string is allowed.
 */
export type MemoryKind =
  | 'fact'
  | 'preference'
  | 'decision'
  | 'entity'
  | 'observation'
  | (string & { __brand?: 'memory-kind' });

export interface StoreMemoryArgs {
  /** The memory body — what the agent is committing to remember. */
  readonly text: string;
  /** Categorization for ergonomic recall. */
  readonly kind?: MemoryKind;
  /** Free-form tags the runtime may use as filters; opaque to substrate. */
  readonly tags?: readonly string[];
  /**
   * Initial modal status. Default: 'Asserted' — the agent is committing
   * to remember this as ground-truth-on-the-record. Use 'Hypothetical'
   * for inferred-but-unconfirmed observations.
   */
  readonly modalStatus?: 'Hypothetical' | 'Asserted';
  /** Initial confidence; default 0.85 for Asserted, 0.5 for Hypothetical. */
  readonly confidence?: number;
  /** Override per-call recipients. */
  readonly shareWith?: readonly IRI[];
  /** If this write supersedes one or more previous memory IRIs. */
  readonly supersedes?: readonly IRI[];
}

export interface StoreMemoryResult {
  readonly memoryIri: IRI;
  readonly descriptorUrl: string;
  readonly graphUrl: string;
  readonly contentHash: string;
}

export interface RecallMemoriesArgs {
  /**
   * Free-text query. Substrate-side recall does keyword/structural
   * match by default; the runtime can layer vector recall on top by
   * passing keywords extracted from a vector hit list as `kind` /
   * `tags` filters. (Adopted runtimes already have vector indexes;
   * the bridge is structural.)
   */
  readonly query?: string;
  /** Optional category filter. */
  readonly kind?: MemoryKind;
  /** Maximum results to return; default 8. */
  readonly limit?: number;
  /** When true, also include Hypothetical entries; default false (Asserted-only). */
  readonly includeHypothetical?: boolean;
  /** When true, also walk subscribed cross-pod sources; default false (own pod only). */
  readonly includeFederated?: boolean;
}

export interface MemoryHit {
  readonly memoryIri: IRI;
  readonly descriptorUrl: string;
  readonly graphUrl: string;
  readonly text: string;
  readonly kind: MemoryKind;
  readonly tags: readonly string[];
  readonly modalStatus: 'Hypothetical' | 'Asserted';
  readonly confidence: number;
  readonly recordedAt: string;
  readonly attributedTo: IRI;
}

export interface ForgetMemoryArgs {
  /** IRI of the memory to mark Counterfactual. */
  readonly iri: IRI;
  /** Optional reason — written into the superseding descriptor's body. */
  readonly reason?: string;
}

// ── Substrate calls ─────────────────────────────────────────────────

const CG_NS = 'https://markjspivey-xwisee.github.io/interego/ns/cg#';
const CGH_NS = 'https://markjspivey-xwisee.github.io/interego/ns/harness#';
const PROV_NS = 'http://www.w3.org/ns/prov#';
const DCT_NS = 'http://purl.org/dc/terms/';

// We compose with W3C / DCMI vocab where it fits and the harness
// (cgh:) namespace for the one substrate-pattern type that doesn't
// have a clean W3C analog (an "agent memory" entry — auditor's
// filter handle for SPARQL queries over the descriptor pool).
const MEMORY_TYPE = `${CGH_NS}AgentMemory` as IRI;
const MEMORY_KIND_PREDICATE = `${DCT_NS}type` as IRI;
const MEMORY_TAG_PREDICATE = `${DCT_NS}subject` as IRI;

function escapeLit(s: string): string {
  // Escape all Turtle-active characters in a single-line string literal.
  // Without newline / carriage-return / tab escapes, a user-supplied
  // tag containing `\n` would break out of the single-line literal
  // and yield a parse error downstream (or, depending on consumer
  // tooling, an injection surface). Bring this in line with the OWM
  // pod-publisher's escapeLit which already handles \n.
  return s
    .replace(/\\/g, '\\\\')
    .replace(/"/g, '\\"')
    .replace(/\n/g, '\\n')
    .replace(/\r/g, '\\r')
    .replace(/\t/g, '\\t');
}

function escapeMulti(s: string): string {
  // See skills/agentskills-bridge.ts for rationale: escape every `"`,
  // not just the substring `"""`. A memory text ending in one or two
  // quotes (e.g. an LLM transcription that wraps quoted speech) would
  // otherwise prematurely close the Turtle triple-quoted literal.
  return s.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}

function nowIso(): string { return new Date().toISOString(); }

/**
 * Build the descriptor + graph for a memory write. Pure synchronous;
 * separated from {@link storeMemory} so it can be unit-tested without a
 * pod.
 */
export function buildMemoryDescriptor(args: StoreMemoryArgs, config: BridgeConfig) {
  const text = args.text.trim();
  if (text.length === 0) throw new Error('cannot store an empty memory');
  const kind: MemoryKind = args.kind ?? 'observation';
  const tags = args.tags ?? [];
  const modal = args.modalStatus ?? 'Asserted';
  const confidence = args.confidence ?? (modal === 'Asserted' ? 0.85 : 0.5);

  const contentHash = sha256(text);
  const memoryId = contentHash.slice(0, 16);
  const memoryIri = `urn:cg:memory:${kind}:${memoryId}` as IRI;
  const graphIri = `urn:graph:cg:memory:${memoryId}` as IRI;

  const owner = config.onBehalfOf ?? config.authoringAgentDid;

  const builder = ContextDescriptor.create(memoryIri)
    .describes(graphIri)
    .agent(config.authoringAgentDid)
    .selfAsserted(config.authoringAgentDid)
    .generatedBy(config.authoringAgentDid, { onBehalfOf: owner, endedAt: nowIso() })
    .temporal({ validFrom: nowIso() });

  if (modal === 'Asserted') builder.asserted(confidence);
  else builder.hypothetical(confidence);

  if (args.supersedes && args.supersedes.length > 0) {
    builder.supersedes(...args.supersedes);
  }

  const descriptor = builder.build();

  const tagTriples = tags.length > 0
    ? `    <${MEMORY_TAG_PREDICATE}> ${tags.map(t => `"${escapeLit(t)}"`).join(' , ')} ;\n`
    : '';

  const graphContent = `<${memoryIri}> a <${MEMORY_TYPE}> , <${PROV_NS}Entity> ;
    <${MEMORY_KIND_PREDICATE}> "${escapeLit(kind)}" ;
${tagTriples}    <${DCT_NS}description> """${escapeMulti(text)}""" ;
    <${CG_NS}contentHash> "${contentHash}" ;
    <${PROV_NS}wasAttributedTo> <${owner}> ;
    <${PROV_NS}wasGeneratedBy> <${config.authoringAgentDid}> .
`;

  return { descriptor, graphContent, memoryIri, graphIri, contentHash };
}

/**
 * Persist a memory write through the substrate. The descriptor is
 * signed (Trust facet self-asserted; the pod's identity layer further
 * adds wallet-rooted signature on save), provenance-attributed,
 * temporally bounded, and (optionally) E2EE-shared with delegates.
 */
export async function storeMemory(args: StoreMemoryArgs, config: BridgeConfig): Promise<StoreMemoryResult> {
  const built = buildMemoryDescriptor(args, config);
  const recipients = args.shareWith ?? config.defaultShareWith;
  const publishOpts = recipients && recipients.length > 0
    ? { shareWith: recipients }
    : undefined;
  const r = await publish(built.descriptor, built.graphContent, config.podUrl, publishOpts);
  return {
    memoryIri: built.memoryIri,
    descriptorUrl: r.descriptorUrl,
    graphUrl: r.graphUrl,
    contentHash: built.contentHash,
  };
}

/**
 * Recall memories from the configured pod. Substrate-side filtering
 * uses descriptor metadata only — modal status, kind label, recency.
 * The runtime layers semantic / vector ranking on top by passing the
 * top-K candidates through its embedding model after this returns.
 *
 * The default behavior is to return only Asserted memories — the
 * agent's "ground truth" — and skip Hypothetical inferences. Callers
 * that want the speculative pool (e.g. for active investigation) pass
 * `includeHypothetical: true`.
 */
export async function recallMemories(args: RecallMemoriesArgs, config: BridgeConfig): Promise<MemoryHit[]> {
  const limit = args.limit ?? 8;
  const entries = await discover(config.podUrl);

  const hits: MemoryHit[] = [];
  for (const entry of entries) {
    if (!isMemoryDescriptor(entry)) continue;
    if (!args.includeHypothetical && entry.modalStatus !== 'Asserted') continue;

    const graphUrl = entry.descriptorUrl.replace(/\.ttl$/, '-graph.trig');
    let trig: string;
    try {
      const r = await fetch(graphUrl, { headers: { Accept: 'application/trig, text/turtle' } });
      if (!r.ok) continue;
      trig = await r.text();
    } catch {
      continue;
    }

    const parsed = parseMemoryGraph(trig);
    if (!parsed) continue;
    if (args.kind && parsed.kind !== args.kind) continue;

    if (args.query && args.query.trim().length > 0) {
      // Substrate-side keyword match (case-insensitive). The runtime is
      // expected to layer vector ranking on top of this candidate pool.
      const q = args.query.toLowerCase();
      if (!parsed.text.toLowerCase().includes(q) && !parsed.tags.some(t => t.toLowerCase().includes(q))) {
        continue;
      }
    }

    hits.push({
      memoryIri: (entry.describes[0] ?? entry.descriptorUrl) as IRI,
      descriptorUrl: entry.descriptorUrl,
      graphUrl,
      text: parsed.text,
      kind: parsed.kind,
      tags: parsed.tags,
      modalStatus: entry.modalStatus as 'Hypothetical' | 'Asserted',
      confidence: entry.confidence ?? 0.5,
      recordedAt: entry.validFrom ?? '',
      attributedTo: parsed.attributedTo ?? config.authoringAgentDid,
    });
    if (hits.length >= limit) break;
  }
  return hits;
}

/**
 * Mark a memory as no-longer-active by publishing a Counterfactual
 * descriptor that supersedes it. The original memory remains queryable
 * (audit-walkable) but is excluded from default recall.
 *
 * Important: this is a substrate-level retraction, not a delete. The
 * pod still holds the original descriptor + graph; an auditor walking
 * cg:supersedes can reach them. If the operator needs to delete bytes
 * (data-subject GDPR erasure), that's a separate operation through
 * the pod's storage layer.
 */
export async function forgetMemory(args: ForgetMemoryArgs, config: BridgeConfig): Promise<StoreMemoryResult> {
  const reason = args.reason ?? 'agent-initiated forget';
  return storeMemory(
    {
      text: `[FORGET] ${args.iri}: ${reason}`,
      kind: 'observation',
      modalStatus: 'Hypothetical',
      confidence: 0.5,
      supersedes: [args.iri],
    },
    config,
  );
}

// ── Helpers ──────────────────────────────────────────────────────────

interface DiscoverEntry {
  readonly descriptorUrl: string;
  readonly modalStatus?: string;
  readonly confidence?: number;
  readonly validFrom?: string;
  readonly describes: readonly string[];
}

function isMemoryDescriptor(entry: DiscoverEntry): boolean {
  // describes[0] follows urn:cg:memory:<kind>:<id> when written via
  // buildMemoryDescriptor. Pure pattern match — no string list to
  // maintain.
  return entry.describes.some(d => d.startsWith('urn:cg:memory:'));
}

interface ParsedMemoryGraph {
  readonly text: string;
  readonly kind: MemoryKind;
  readonly tags: readonly string[];
  readonly attributedTo?: IRI;
}

function parseMemoryGraph(trig: string): ParsedMemoryGraph | null {
  // Use the project's Turtle parser — never regex.
  let doc;
  try { doc = parseTrig(trig); }
  catch { return null; }
  const memSubjects = findSubjectsOfType(doc, MEMORY_TYPE);
  if (memSubjects.length === 0) return null;
  const subj = memSubjects[0]!;
  const text = readStringValue(subj, `${DCT_NS}description` as IRI);
  const kind = readStringValue(subj, MEMORY_KIND_PREDICATE) as MemoryKind | undefined;
  const tags = readStringValues(subj, MEMORY_TAG_PREDICATE);
  const attributedTo = readIriValue(subj, `${PROV_NS}wasAttributedTo` as IRI);
  if (!text || !kind) return null;
  return { text, kind, tags, attributedTo };
}
