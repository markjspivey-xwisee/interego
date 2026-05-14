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

/**
 * Delegation scope — gates which affordances are offered on a
 * discovered descriptor. Mirrors the substrate's DelegationScope
 * (src/model/types.ts) and the affordance engine's SCOPE_PERMISSIONS
 * (src/affordance/compute.ts).
 */
export type DelegationScope = 'ReadWrite' | 'ReadOnly' | 'PublishOnly' | 'DiscoverOnly';

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
  /**
   * The agent's delegation scope — gates which affordances are offered
   * on discovered descriptors / recalled memories. Default 'ReadWrite'.
   * The agent is only ever handed actions its scope actually permits.
   */
  readonly scope?: DelegationScope;
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
   * for inferred-but-unconfirmed observations, 'Counterfactual' for a
   * known-false / retracted / rejected claim.
   */
  readonly modalStatus?: 'Hypothetical' | 'Asserted' | 'Counterfactual';
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
  readonly modalStatus: 'Hypothetical' | 'Asserted' | 'Counterfactual';
  readonly confidence: number;
  readonly recordedAt: string;
  readonly attributedTo: IRI;
  /**
   * HATEOAS: the actions available on this memory, gated by the
   * agent's delegation scope. The agent follows one via
   * {@link followAffordance} rather than reaching for a flat tool list.
   */
  readonly affordances: readonly BridgeAffordance[];
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
  else if (modal === 'Counterfactual') {
    // Semiotic modal Counterfactual — a known-false / retracted claim.
    // (Distinct from the builder's causal-counterfactual method; see
    // the descriptor builder's hypothetical() docstring.)
    builder.semiotic({ modalStatus: 'Counterfactual', groundTruth: false, epistemicConfidence: confidence });
  } else builder.hypothetical(confidence);

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
 * adds wallet-rooted signature on save), provenance-attributed, and
 * temporally bounded.
 *
 * Cross-pod E2EE share — `args.shareWith` / `config.defaultShareWith` —
 * is intentionally NOT applied here: `publish()`'s encryption path needs
 * a sender X25519 keypair, which this substrate-pure bridge does not
 * hold. Runtimes that need encrypted share route it through the relay's
 * `publish_context` `share_with` argument (the relay holds the keypair).
 * The `shareWith` fields stay in the bridge's API for that relay path
 * and forward-compatibility; this direct publish writes plaintext to the
 * pod, where the pod's own ACLs still apply.
 * (Previously this passed an unsupported `{ shareWith }` option that
 * `publish()` silently ignored — a no-op that looked like a feature.)
 */
export async function storeMemory(args: StoreMemoryArgs, config: BridgeConfig): Promise<StoreMemoryResult> {
  const built = buildMemoryDescriptor(args, config);
  const r = await publish(built.descriptor, built.graphContent, config.podUrl);
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

    const memoryIri = (entry.describes[0] ?? entry.descriptorUrl) as IRI;
    hits.push({
      memoryIri,
      descriptorUrl: entry.descriptorUrl,
      graphUrl,
      text: parsed.text,
      kind: parsed.kind,
      tags: parsed.tags,
      modalStatus: entry.modalStatus as 'Hypothetical' | 'Asserted' | 'Counterfactual',
      // Manifest entries don't carry epistemic confidence — that lives in
      // the descriptor's Semiotic facet, not the discovery manifest.
      // Recall surfaces the structural default; a caller that needs the
      // exact value reads it from the descriptor itself.
      confidence: 0.5,
      recordedAt: entry.validFrom ?? '',
      attributedTo: parsed.attributedTo ?? config.authoringAgentDid,
      // HATEOAS: hand the agent the actions it can take on this memory.
      affordances: affordancesFor(memoryIri, entry.descriptorUrl, config.scope),
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
      // A forget is a retraction, not a tentative claim — the modal
      // status is Counterfactual (known-no-longer-valid), matching this
      // module's header contract. Recall excludes it by default; an
      // auditor walking cg:supersedes still reaches it.
      modalStatus: 'Counterfactual',
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

// ── HATEOAS: distributed affordances ─────────────────────────────────
//
// The OpenClaw plugin gives the agent a small, FIXED tool surface — the
// three memory-slot tools plus interego_discover / interego_act for
// navigation. The substrate's capability surface is unbounded, and it
// travels as DATA: every memory or descriptor the agent receives is
// decorated with `affordances` — self-describing records naming what it
// can do with that item. To act, it follows one through
// followAffordance. New substrate capability = a new affordance verb in
// a result, never a new tool schema, never extra context cost. This is
// HATEOAS — the substrate hands the client its next moves.
//
// Mirrors src/affordance/: the verbs are a subset of the canonical
// AffordanceAction set; SCOPE_VERBS narrows by delegation scope exactly
// as src/affordance/compute.ts SCOPE_PERMISSIONS does.

/**
 * Affordance verbs this bridge can follow — the subset of the
 * substrate's AffordanceAction set that composes cleanly with the
 * bridge's publish / discover / forget primitives in one shot.
 * (`subscribe` is intentionally absent — it is a long-lived operation,
 * driven through OpenClaw's own hook mechanism, not a one-shot act.)
 */
export type AffordanceVerb =
  | 'read'      // fetch + perceive the target's graph
  | 'derive'    // publish a successor that supersedes the target
  | 'retract'   // mark the target no-longer-valid (Counterfactual + supersedes)
  | 'challenge' // publish an independent Counterfactual counter-descriptor
  | 'annotate'  // attach a Hypothetical note referencing the target
  | 'forward';  // re-publish, E2EE-shared to additional recipients

/**
 * Delegation scope → permitted verbs. Mirrors SCOPE_PERMISSIONS in
 * src/affordance/compute.ts, narrowed to AffordanceVerb.
 */
const SCOPE_VERBS: Record<DelegationScope, readonly AffordanceVerb[]> = {
  ReadWrite: ['read', 'derive', 'retract', 'challenge', 'annotate', 'forward'],
  ReadOnly: ['read'],
  PublishOnly: ['read', 'derive', 'annotate'],
  DiscoverOnly: ['read'],
};

const VERB_HINTS: Record<AffordanceVerb, string> = {
  read: "fetch this item's graph",
  derive: 'publish a successor (supersedes this) — pass `content`',
  retract: 'mark this no-longer-valid — pass `content` as the reason',
  challenge: 'publish an independent counter-claim — pass `content`',
  annotate: 'attach a Hypothetical note to this — pass `content`',
  forward: 're-share this to others — pass `params.recipients`',
};

/** A self-describing affordance handed to the agent on a result. */
export interface BridgeAffordance {
  readonly action: AffordanceVerb;
  /** The descriptor / memory IRI this affordance acts on. */
  readonly target: IRI;
  /** Where to fetch the target — followAffordance('read') needs this. */
  readonly descriptorUrl: string;
  /** One-line hint: what the verb does + what input it needs. */
  readonly hint: string;
}

/**
 * Decorate a target with the affordances the agent may follow on it,
 * gated by delegation scope. Pure — no pod access. This is the
 * "distributed" in distributed affordances: the action surface is
 * computed at the edge, per item, and travels with the data.
 */
export function affordancesFor(
  target: IRI,
  descriptorUrl: string,
  scope: DelegationScope = 'ReadWrite',
): readonly BridgeAffordance[] {
  return (SCOPE_VERBS[scope] ?? SCOPE_VERBS.ReadWrite).map(action => ({
    action,
    target,
    descriptorUrl,
    hint: VERB_HINTS[action],
  }));
}

// ── interego_discover — navigate the substrate ───────────────────────

export interface DiscoverContextsArgs {
  /** Optional keyword filter over descriptor IRI / describes. */
  readonly query?: string;
  /** Max results; default 12. */
  readonly limit?: number;
}

export interface DiscoveredDescriptor {
  readonly descriptorUrl: string;
  readonly describes: readonly string[];
  readonly modalStatus: string;
  readonly recordedAt: string;
  /** HATEOAS: the actions available on this descriptor. */
  readonly affordances: readonly BridgeAffordance[];
}

/**
 * Discover context descriptors on the configured pod, each decorated
 * with its affordances. The agent's navigation entry point — it does
 * not need to know substrate tool names; it follows what it is handed.
 */
export async function discoverContexts(
  args: DiscoverContextsArgs,
  config: BridgeConfig,
): Promise<DiscoveredDescriptor[]> {
  const limit = args.limit ?? 12;
  const entries = await discover(config.podUrl);
  const q = (args.query ?? '').trim().toLowerCase();
  const out: DiscoveredDescriptor[] = [];
  for (const entry of entries) {
    if (q && !entry.descriptorUrl.toLowerCase().includes(q)
        && !entry.describes.some(d => d.toLowerCase().includes(q))) {
      continue;
    }
    const subject = (entry.describes[0] ?? entry.descriptorUrl) as IRI;
    out.push({
      descriptorUrl: entry.descriptorUrl,
      describes: entry.describes,
      modalStatus: entry.modalStatus ?? '',
      recordedAt: entry.validFrom ?? '',
      affordances: affordancesFor(subject, entry.descriptorUrl, config.scope),
    });
    if (out.length >= limit) break;
  }
  return out;
}

// ── interego_act — follow an affordance (the HATEOAS engine) ──────────

export interface FollowAffordanceArgs {
  /** An affordance handed to the agent by recall / discover. */
  readonly affordance: BridgeAffordance;
  /** New memory text — required for derive / retract / challenge / annotate. */
  readonly content?: string;
  /** Extra params — e.g. { recipients } for forward. */
  readonly params?: { readonly recipients?: readonly IRI[] };
}

export interface FollowAffordanceResult {
  readonly action: AffordanceVerb;
  readonly target: IRI;
  /** For 'read': the fetched graph text. */
  readonly content?: string;
  /** For write verbs: the IRI of the descriptor just published. */
  readonly resultIri?: IRI;
}

/**
 * Follow an affordance — the single substrate-acting path. The
 * affordance names its own verb + target; this dispatches to the
 * matching substrate primitive. The agent never hardcodes a tool name:
 * the result told it what it could do, this does it.
 */
export async function followAffordance(
  args: FollowAffordanceArgs,
  config: BridgeConfig,
): Promise<FollowAffordanceResult> {
  const { affordance, content, params } = args;
  const { action, target, descriptorUrl } = affordance;

  // Scope guard — never follow a verb the agent's scope forbids.
  const scope = config.scope ?? 'ReadWrite';
  if (!(SCOPE_VERBS[scope] ?? SCOPE_VERBS.ReadWrite).includes(action)) {
    throw new Error(`affordance '${action}' not permitted for scope '${scope}'`);
  }

  if (action === 'read') {
    const graphUrl = descriptorUrl.replace(/\.ttl$/, '-graph.trig');
    const r = await fetch(graphUrl, { headers: { Accept: 'application/trig, text/turtle' } });
    if (!r.ok) throw new Error(`read: ${r.status} fetching ${graphUrl}`);
    return { action, target, content: await r.text() };
  }

  if ((action === 'derive' || action === 'retract' || action === 'challenge'
       || action === 'annotate') && !content?.trim()) {
    throw new Error(`affordance '${action}' requires \`content\``);
  }

  if (action === 'retract') {
    const r = await forgetMemory({ iri: target, reason: content }, config);
    return { action, target, resultIri: r.memoryIri };
  }
  if (action === 'derive') {
    const r = await storeMemory({ text: content!, supersedes: [target] }, config);
    return { action, target, resultIri: r.memoryIri };
  }
  if (action === 'challenge') {
    const r = await storeMemory({ text: content!, modalStatus: 'Counterfactual' }, config);
    return { action, target, resultIri: r.memoryIri };
  }
  if (action === 'annotate') {
    const r = await storeMemory(
      { text: content!, modalStatus: 'Hypothetical', tags: [`annotates:${target}`] },
      config,
    );
    return { action, target, resultIri: r.memoryIri };
  }
  // forward — re-publish, E2EE-shared to additional recipients.
  const r = await storeMemory(
    {
      text: content?.trim() || `[FORWARD] ${target}`,
      tags: [`forwards:${target}`],
      ...(params?.recipients ? { shareWith: params.recipients } : {}),
    },
    config,
  );
  return { action, target, resultIri: r.memoryIri };
}
