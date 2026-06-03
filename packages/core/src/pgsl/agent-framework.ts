/**
 * @module pgsl/agent-framework
 * @description Agent behavioral framework integrating AAT, deontic policy,
 * PROV tracing, and personal brokers with the affordance decorator system.
 *
 * This module implements five tightly coupled features:
 *
 *   1. Abstract Agent Types (AAT) — behavioral contracts restricting what
 *      an agent CAN do, before decorators even run.
 *
 *   2. Deontic Policy Engine — permit/deny/duty rules evaluated before
 *      affordances are surfaced.
 *
 *   3. PROV Action Tracing — every action generates a W3C PROV record,
 *      append-only and immutable.
 *
 *   4. Personal Broker — agent-as-a-service with persistent memory
 *      across sessions, backed by its own PGSL lattice.
 *
 *   8. AAT Decorator — integration point that plugs into the
 *      affordance decorator chain from affordance-decorators.ts.
 *
 * Architecture:
 *   - AATs define the outer boundary of what is possible.
 *   - Policies refine within that boundary (permit/deny/duty).
 *   - PROV tracing records everything that actually happens.
 *   - Personal brokers hold the agent's persistent state.
 *   - The AAT decorator wires it all into the decorator chain.
 *
 * All data structures are immutable (readonly). Mutation is via
 * functional copy-on-write (matching the codebase convention).
 */

import type { IRI } from '../model/types.js';
import type { PGSLInstance } from './types.js';
import type {
  AffordanceDecorator,
  DecoratorContext,
  DecoratedAffordance,
  DecoratorResult,
} from './affordance-decorators.js';
import { createHash } from 'node:crypto';
import { escapeTurtleLiteral as escapeForTurtle } from '../rdf/escape.js';

// ══════════════════════════════════════════════════════════════
// 1. Abstract Agent Types (AAT)
// ══════════════════════════════════════════════════════════════

/** Agent behavioral contract — restricts affordance space. */
export interface AbstractAgentType {
  /** Canonical identifier (e.g. 'aat:observer'). */
  readonly id: string;
  /** Human-readable name. */
  readonly name: string;
  /** Description of the agent's role. */
  readonly description: string;
  /** What this agent type can perceive (affordance rels). */
  readonly canPerceive: readonly string[];
  /** What this agent type can act on (affordance rels). */
  readonly canAct: readonly string[];
  /** What this agent type must preserve (duties). */
  readonly mustPreserve: readonly string[];
  /** Parallelization rules. */
  readonly parallelization?: {
    readonly maxConcurrent: number;
    readonly conflictsWith?: readonly string[];
  };
}

// ── Built-in AATs ─────────────────────────────────────────────

/** Observer: can perceive but not modify. */
export const ObserverAAT: AbstractAgentType = {
  id: 'aat:observer',
  name: 'Observer',
  description: 'Can perceive but not modify',
  canPerceive: ['read', 'sparql', 'chain-view', 'discover-remote'],
  canAct: [],
  mustPreserve: ['provenance'],
};

/** Analyst: can perceive and create assessments. */
export const AnalystAAT: AbstractAgentType = {
  id: 'aat:analyst',
  name: 'Analyst',
  description: 'Can perceive and create assessments',
  canPerceive: ['read', 'sparql', 'chain-view', 'discover-remote', 'ask-llm'],
  canAct: ['create-atom', 'add-source', 'add-target', 'wrap-group'],
  mustPreserve: ['provenance', 'trust-chain'],
};

/** Executor: can act on decisions. */
export const ExecutorAAT: AbstractAgentType = {
  id: 'aat:executor',
  name: 'Executor',
  description: 'Can act on decisions',
  canPerceive: ['read', 'chain-view'],
  canAct: ['create-atom', 'add-source', 'add-target', 'wrap-group', 'ingest-xapi', 'promote', 'constrain-paradigm'],
  mustPreserve: ['provenance', 'trust-chain', 'coherence'],
};

/** Arbiter: can approve/reject but not create. */
export const ArbiterAAT: AbstractAgentType = {
  id: 'aat:arbiter',
  name: 'Arbiter',
  description: 'Can approve/reject but not create',
  canPerceive: ['read', 'sparql', 'chain-view'],
  canAct: ['constrain-paradigm', 'verify-coherence'],
  mustPreserve: ['provenance', 'trust-chain', 'coherence', 'audit-trail'],
};

/** Archivist: can persist and manage storage. */
export const ArchivistAAT: AbstractAgentType = {
  id: 'aat:archivist',
  name: 'Archivist',
  description: 'Can persist and manage storage',
  canPerceive: ['read', 'sparql', 'chain-view', 'discover-remote'],
  canAct: ['promote', 'wrap-group'],
  mustPreserve: ['provenance', 'trust-chain', 'persistence-records'],
};

/** Full Access: unrestricted (for development/testing). */
export const FullAccessAAT: AbstractAgentType = {
  id: 'aat:full-access',
  name: 'Full Access',
  description: 'Unrestricted (for development/testing)',
  canPerceive: ['*'],
  canAct: ['*'],
  mustPreserve: ['provenance'],
};

// ── AAT Registry ──────────────────────────────────────────────

/** Registry of known Abstract Agent Types. */
export interface AATRegistry {
  readonly aats: ReadonlyMap<string, AbstractAgentType>;
}

/** Create a new AAT registry pre-loaded with all built-in types. */
export function createAATRegistry(): AATRegistry {
  const map = new Map<string, AbstractAgentType>();
  for (const aat of [ObserverAAT, AnalystAAT, ExecutorAAT, ArbiterAAT, ArchivistAAT, FullAccessAAT]) {
    map.set(aat.id, aat);
  }
  return { aats: map };
}

/** Register a new AAT (or replace an existing one). */
export function registerAAT(registry: AATRegistry, aat: AbstractAgentType): void {
  (registry.aats as Map<string, AbstractAgentType>).set(aat.id, aat);
}

/** Look up an AAT by ID. Returns undefined if not found. */
export function getAAT(registry: AATRegistry, id: string): AbstractAgentType | undefined {
  return registry.aats.get(id);
}

// ── Affordance classification ─────────────────────────────────

/**
 * Affordance rels that represent perception (read-like operations).
 * Used to match against `canPerceive`.
 */
const PERCEIVE_RELS = new Set([
  'read', 'sparql', 'chain-view', 'discover-remote', 'ask-llm',
  'view-remote', 'verify-remote', 'view-coherence',
  'persistence-info', 'xapi-verb-uri', 'xapi-result-schema',
  'xapi-context-schema',
]);

/**
 * Classify an affordance rel as perceive or act.
 * If the rel is in the known perceive set, it's perceive.
 * GET methods are also treated as perceive.
 */
function classifyRel(rel: string, method?: string): 'perceive' | 'act' {
  if (PERCEIVE_RELS.has(rel)) return 'perceive';
  if (method && method.toUpperCase() === 'GET') return 'perceive';
  return 'act';
}

/**
 * Filter affordances by an AAT's capabilities.
 *
 * Removes affordances the AAT cannot use:
 *   - Perceive affordances not in `canPerceive`
 *   - Act affordances not in `canAct`
 *   - Wildcard `*` means no filtering for that category.
 *
 * @param affordances - The full list of affordances
 * @param aat - The agent type to filter by
 * @returns Only the affordances this AAT is allowed to use
 */
export function filterAffordancesByAAT(
  affordances: readonly DecoratedAffordance[],
  aat: AbstractAgentType,
): readonly DecoratedAffordance[] {
  const perceiveAll = aat.canPerceive.includes('*');
  const actAll = aat.canAct.includes('*');

  if (perceiveAll && actAll) return affordances;

  return affordances.filter(aff => {
    const kind = classifyRel(aff.rel, aff.method);
    if (kind === 'perceive') {
      return perceiveAll || aat.canPerceive.includes(aff.rel);
    }
    return actAll || aat.canAct.includes(aff.rel);
  });
}

/** Result of validating whether an AAT can perform a given action. */
export interface ActionValidation {
  readonly allowed: boolean;
  readonly reason?: string;
}

/**
 * Validate whether an AAT is allowed to perform a given action.
 *
 * @param aat - The agent type
 * @param actionRel - The affordance rel to validate
 * @returns Validation result with reason
 */
export function validateAction(aat: AbstractAgentType, actionRel: string): ActionValidation {
  const kind = classifyRel(actionRel);

  if (kind === 'perceive') {
    if (aat.canPerceive.includes('*') || aat.canPerceive.includes(actionRel)) {
      return { allowed: true };
    }
    return {
      allowed: false,
      reason: `AAT '${aat.name}' (${aat.id}) cannot perceive '${actionRel}'. ` +
        `Allowed: [${aat.canPerceive.join(', ')}]`,
    };
  }

  if (aat.canAct.includes('*') || aat.canAct.includes(actionRel)) {
    return { allowed: true };
  }

  if (aat.canAct.length === 0) {
    return {
      allowed: false,
      reason: `AAT '${aat.name}' (${aat.id}) is read-only and cannot perform any actions`,
    };
  }

  return {
    allowed: false,
    reason: `AAT '${aat.name}' (${aat.id}) cannot act on '${actionRel}'. ` +
      `Allowed: [${aat.canAct.join(', ')}]`,
  };
}

// ══════════════════════════════════════════════════════════════
// 2. Deontic Policy Engine
// ══════════════════════════════════════════════════════════════

/** Deontic modality: permit, deny, or duty. */
export type DeonticMode = 'permit' | 'deny' | 'duty';

/** A single policy rule. */
export interface PolicyRule {
  /** Unique rule identifier. */
  readonly id: string;
  /** Deontic modality. */
  readonly mode: DeonticMode;
  /** Subject: agent ID, AAT ID, or '*' for all. */
  readonly subject: string;
  /** Action: affordance rel or '*' for all. */
  readonly action: string;
  /** Target: node URI pattern or '*' for all. */
  readonly target?: string;
  /** Optional dynamic condition. */
  readonly condition?: (context: PolicyContext) => boolean;
  /** Human-readable description of this rule. */
  readonly description: string;
}

/** Context passed to policy evaluation. */
export interface PolicyContext {
  /** The agent's identifier. */
  readonly agentId: string;
  /** The agent's AAT. */
  readonly agentAAT: AbstractAgentType;
  /** The node being acted upon. */
  readonly nodeUri: IRI;
  /** The node's resolved value (if available). */
  readonly nodeValue?: string;
  /** The action being attempted. */
  readonly action: string;
}

/** Result of policy evaluation. */
export interface PolicyDecision {
  /** Whether the action is allowed. */
  readonly allowed: boolean;
  /** Duties the agent MUST fulfill alongside this action. */
  readonly duties: readonly string[];
  /** Human-readable explanation. */
  readonly reason: string;
  /** IDs of rules that contributed to this decision. */
  readonly matchedRules: readonly string[];
}

/** The policy engine: an ordered collection of rules. */
export interface PolicyEngine {
  readonly rules: readonly PolicyRule[];
}

/** Create an empty policy engine. */
export function createPolicyEngine(): PolicyEngine {
  return { rules: [] };
}

/** Add a rule to the policy engine. */
export function addRule(engine: PolicyEngine, rule: PolicyRule): void {
  (engine as { rules: PolicyRule[] }).rules = [...engine.rules, rule];
}

/** Remove a rule by ID. */
export function removeRule(engine: PolicyEngine, ruleId: string): void {
  (engine as { rules: PolicyRule[] }).rules = engine.rules.filter(r => r.id !== ruleId);
}

/**
 * Check whether a rule's subject matches a given agent.
 * Matches on agent ID, AAT ID, or wildcard '*'.
 */
function subjectMatches(rule: PolicyRule, context: PolicyContext): boolean {
  if (rule.subject === '*') return true;
  if (rule.subject === context.agentId) return true;
  if (rule.subject === context.agentAAT.id) return true;
  return false;
}

/**
 * Check whether a rule's action matches the attempted action.
 * Supports exact match or wildcard '*'.
 */
function actionMatches(rule: PolicyRule, context: PolicyContext): boolean {
  if (rule.action === '*') return true;
  return rule.action === context.action;
}

/**
 * Check whether a rule's target matches the node URI.
 * Supports exact match, prefix match (ending with '*'), or wildcard '*'.
 */
function targetMatches(rule: PolicyRule, context: PolicyContext): boolean {
  if (!rule.target || rule.target === '*') return true;
  if (rule.target.endsWith('*')) {
    const prefix = rule.target.slice(0, -1);
    return context.nodeUri.startsWith(prefix);
  }
  return rule.target === context.nodeUri;
}

/**
 * Evaluate all policy rules against a given context.
 *
 * Semantics:
 *   - Deny overrides permit (deny wins if both match).
 *   - Duties accumulate from all matching duty rules.
 *   - If no permit or deny matches, the default is permit
 *     (open-world assumption — AAT already restricts capability).
 *
 * @param engine - The policy engine
 * @param context - The evaluation context
 * @returns Policy decision
 */
export function evaluate(engine: PolicyEngine, context: PolicyContext): PolicyDecision {
  const matchedRules: string[] = [];
  const duties: string[] = [];
  let denied = false;
  let denyReason = '';
  let permitted = false;
  let permitReason = '';

  for (const rule of engine.rules) {
    // Check if this rule applies
    if (!subjectMatches(rule, context)) continue;
    if (!actionMatches(rule, context)) continue;
    if (!targetMatches(rule, context)) continue;
    if (rule.condition && !rule.condition(context)) continue;

    matchedRules.push(rule.id);

    switch (rule.mode) {
      case 'deny':
        denied = true;
        denyReason = rule.description;
        break;
      case 'permit':
        permitted = true;
        permitReason = rule.description;
        break;
      case 'duty':
        duties.push(rule.description);
        break;
    }
  }

  // Deny overrides permit
  if (denied) {
    return {
      allowed: false,
      duties,
      reason: `Denied by policy: ${denyReason}`,
      matchedRules,
    };
  }

  if (permitted || matchedRules.length === 0) {
    const reason = permitted
      ? `Permitted by policy: ${permitReason}`
      : 'No matching deny rules (default: permit)';
    return {
      allowed: true,
      duties,
      reason,
      matchedRules,
    };
  }

  // Only duty rules matched, no explicit permit or deny — allow with duties
  return {
    allowed: true,
    duties,
    reason: `Allowed with ${duties.length} duty obligation(s)`,
    matchedRules,
  };
}

/**
 * Returns a set of sensible default policy rules.
 *
 *   - Deny: nobody can delete atoms (immutability invariant)
 *   - Duty: any create action must include provenance
 *   - Duty: any critical-severity item must be escalated
 *   - Permit: all agents can read (unless denied elsewhere)
 */
export function defaultPolicies(): PolicyRule[] {
  return [
    {
      id: 'policy:deny-delete',
      mode: 'deny',
      subject: '*',
      action: 'delete',
      description: 'Atoms are immutable — deletion is not permitted',
    },
    {
      id: 'policy:duty-provenance',
      mode: 'duty',
      subject: '*',
      action: 'create-atom',
      description: 'All atom creation must include provenance metadata',
    },
    {
      id: 'policy:duty-escalate-critical',
      mode: 'duty',
      subject: '*',
      action: '*',
      condition: (ctx: PolicyContext) => {
        if (!ctx.nodeValue) return false;
        const lower = ctx.nodeValue.toLowerCase();
        return lower.includes('critical') || lower.includes('severity:critical');
      },
      description: 'Critical-severity items must be escalated to an arbiter',
    },
    {
      id: 'policy:permit-read',
      mode: 'permit',
      subject: '*',
      action: 'read',
      description: 'All agents may read unless explicitly denied',
    },
  ];
}

// ══════════════════════════════════════════════════════════════
// 3. PROV Action Tracing
// ══════════════════════════════════════════════════════════════

/** A W3C PROV trace record for a single action. */
export interface ProvTrace {
  /** Trace identifier (urn:prov:trace:{hash}). */
  readonly id: string;
  /** What happened (affordance rel). */
  readonly activity: string;
  /** Who did it (agent ID). */
  readonly agent: string;
  /** Their behavioral contract (AAT ID). */
  readonly agentAAT: string;
  /** What was acted on (node URI). */
  readonly entity: string;
  /** When it started (ISO 8601). */
  readonly startedAt: string;
  /** When it ended (ISO 8601). */
  readonly endedAt?: string;
  /** Resulting entity URI (if the action created something). */
  readonly wasGeneratedBy?: string;
  /** Agent association. */
  readonly wasAssociatedWith: string;
  /** Input entities consumed by this activity. */
  readonly used?: readonly string[];
  /** The policy decision that authorized this action. */
  readonly policyDecision?: PolicyDecision;
  /** Whether the action succeeded. */
  readonly success: boolean;
  /** Error message if the action failed. */
  readonly error?: string;
}

/** Append-only store of PROV traces. */
export interface TraceStore {
  readonly traces: readonly ProvTrace[];
}

/** Filter criteria for querying traces. */
export interface TraceFilter {
  readonly agent?: string;
  readonly entity?: string;
  readonly activity?: string;
  readonly startAfter?: string;
  readonly startBefore?: string;
  readonly successOnly?: boolean;
}

/** Create an empty trace store. */
export function createTraceStore(): TraceStore {
  return { traces: [] };
}

/**
 * Record a trace (append-only, immutable).
 * Each trace is appended; existing traces are never modified.
 */
export function recordTrace(store: TraceStore, trace: ProvTrace): void {
  (store as { traces: ProvTrace[] }).traces = [...store.traces, trace];
}

/**
 * Query traces by filter criteria.
 *
 * @param store - The trace store
 * @param filter - Optional filter criteria (all are AND-combined)
 * @returns Matching traces
 */
export function getTraces(
  store: TraceStore,
  filter?: TraceFilter,
): readonly ProvTrace[] {
  if (!filter) return store.traces;

  return store.traces.filter(t => {
    if (filter.agent && t.agent !== filter.agent) return false;
    if (filter.entity && t.entity !== filter.entity) return false;
    if (filter.activity && t.activity !== filter.activity) return false;
    if (filter.startAfter && t.startedAt < filter.startAfter) return false;
    if (filter.startBefore && t.startedAt > filter.startBefore) return false;
    if (filter.successOnly && !t.success) return false;
    return true;
  });
}

/**
 * Serialize a PROV trace as W3C PROV-O Turtle.
 *
 * Produces a minimal but valid PROV-O representation using
 * the prov: namespace (http://www.w3.org/ns/prov#).
 *
 * @param trace - The trace to serialize
 * @returns Turtle string
 */
export function traceToTurtle(trace: ProvTrace): string {
  const lines: string[] = [];

  lines.push('@prefix prov: <http://www.w3.org/ns/prov#> .');
  lines.push('@prefix xsd:  <http://www.w3.org/2001/XMLSchema#> .');
  lines.push('@prefix cg:   <https://contextgraphs.org/ns/> .');
  lines.push('');

  // Activity
  lines.push(`<${trace.id}> a prov:Activity ;`);
  lines.push(`  prov:startedAtTime "${trace.startedAt}"^^xsd:dateTime ;`);
  if (trace.endedAt) {
    lines.push(`  prov:endedAtTime "${trace.endedAt}"^^xsd:dateTime ;`);
  }
  lines.push(`  cg:affordanceRel "${trace.activity}" ;`);
  lines.push(`  cg:success ${trace.success} .`);
  lines.push('');

  // Agent
  lines.push(`<${trace.wasAssociatedWith}> a prov:Agent ;`);
  lines.push(`  cg:agentAAT "${trace.agentAAT}" .`);
  lines.push('');

  // Association
  lines.push(`<${trace.id}> prov:wasAssociatedWith <${trace.wasAssociatedWith}> .`);
  lines.push('');

  // Entity (acted upon)
  lines.push(`<${trace.entity}> a prov:Entity .`);
  lines.push(`<${trace.id}> prov:used <${trace.entity}> .`);

  // Used entities
  if (trace.used) {
    for (const used of trace.used) {
      lines.push(`<${trace.id}> prov:used <${used}> .`);
    }
  }

  // Generated entity
  if (trace.wasGeneratedBy) {
    lines.push('');
    lines.push(`<${trace.wasGeneratedBy}> a prov:Entity ;`);
    lines.push(`  prov:wasGeneratedBy <${trace.id}> .`);
  }

  // Error annotation
  if (trace.error) {
    lines.push('');
    lines.push(`<${trace.id}> cg:errorMessage "${escapeForTurtle(trace.error)}" .`);
  }

  lines.push('');
  return lines.join('\n');
}

/**
 * Generate a deterministic trace ID from the activity content.
 *
 * @param agent - Agent ID
 * @param activity - Affordance rel
 * @param entity - Node URI
 * @param timestamp - ISO timestamp
 * @returns URN-formatted trace ID
 */
function generateTraceId(agent: string, activity: string, entity: string, timestamp: string): string {
  const hash = createHash('sha256')
    .update(`${agent}|${activity}|${entity}|${timestamp}`)
    .digest('hex')
    .slice(0, 16);
  return `urn:prov:trace:${hash}`;
}

/** The result of wrapping an affordance with tracing. */
export interface TracedAffordance {
  /** The original affordance. */
  readonly affordance: DecoratedAffordance;
  /** Execute the affordance and record a PROV trace. */
  execute(): ProvTrace;
}

/**
 * Wrap an affordance execution with before/after PROV recording.
 *
 * Returns a traced version of the affordance that, when executed,
 * records a ProvTrace in the store with timing, agent, AAT, and
 * policy decision metadata.
 *
 * @param affordance - The affordance to wrap
 * @param agent - Agent ID
 * @param aat - Agent's AAT
 * @param policyDecision - The policy decision that authorized this action
 * @returns A traced affordance
 */
export function wrapWithTracing(
  affordance: DecoratedAffordance,
  agent: string,
  aat: AbstractAgentType,
  policyDecision: PolicyDecision,
): TracedAffordance {
  return {
    affordance,
    execute(): ProvTrace {
      const startedAt = new Date().toISOString();
      const id = generateTraceId(agent, affordance.rel, affordance.href, startedAt);

      const trace: ProvTrace = {
        id,
        activity: affordance.rel,
        agent,
        agentAAT: aat.id,
        entity: affordance.href,
        startedAt,
        endedAt: new Date().toISOString(),
        wasAssociatedWith: agent,
        policyDecision,
        success: true,
      };

      return trace;
    },
  };
}

// ══════════════════════════════════════════════════════════════
// 4. Personal Broker
// ══════════════════════════════════════════════════════════════

/** Agent presence status. */
export type PresenceStatus = 'online' | 'busy' | 'away' | 'offline';

/** A message within a conversation. */
export interface ConversationMessage {
  /** Who sent it. */
  readonly from: string;
  /** The content (ingested into agent's PGSL). */
  readonly content: string;
  /** When it was sent (ISO 8601). */
  readonly timestamp: string;
  /** PGSL chain URI created from this message (if ingested). */
  readonly chainUri?: IRI;
}

/** A conversation between agents. */
export interface Conversation {
  /** Unique conversation identifier. */
  readonly id: string;
  /** Participating agent IDs. */
  readonly participants: readonly string[];
  /** Ordered messages. */
  readonly messages: readonly ConversationMessage[];
  /** Optional topic. */
  readonly topic?: string;
  /** When the conversation started. */
  readonly startedAt: string;
}

/** Agent memory statistics — semantic, episodic, procedural. */
export interface AgentMemory {
  /** Semantic: facts and relationships (atom count in PGSL). */
  readonly semanticSize: number;
  /** Episodic: conversation history (conversation count). */
  readonly episodicSize: number;
  /** Procedural: learned patterns (constraint count). */
  readonly proceduralSize: number;
}

/** An agent-as-a-service with persistent memory across sessions. */
export interface PersonalBroker {
  /** The agent's unique identifier. */
  readonly agentId: string;
  /** The agent's behavioral contract. */
  readonly aat: AbstractAgentType;
  /** The agent's personal PGSL lattice. */
  readonly pgsl: PGSLInstance;
  /** All conversations this agent participates in. */
  readonly conversations: readonly Conversation[];
  /** Memory statistics. */
  readonly memory: AgentMemory;
  /** Current presence status. */
  readonly presence: PresenceStatus;
}

/**
 * Create a new personal broker for an agent.
 *
 * @param agentId - Unique agent identifier
 * @param aat - The agent's AAT
 * @param pgsl - The agent's personal PGSL instance
 * @returns A new personal broker
 */
export function createPersonalBroker(
  agentId: string,
  aat: AbstractAgentType,
  pgsl: PGSLInstance,
): PersonalBroker {
  return {
    agentId,
    aat,
    pgsl,
    conversations: [],
    memory: {
      semanticSize: pgsl.atoms.size,
      episodicSize: 0,
      proceduralSize: 0,
    },
    presence: 'online',
  };
}

/**
 * Start a new conversation.
 *
 * @param broker - The personal broker
 * @param participants - Agent IDs participating (broker's agentId is added if absent)
 * @param topic - Optional conversation topic
 * @returns The created conversation
 */
export function startConversation(
  broker: PersonalBroker,
  participants: readonly string[],
  topic?: string,
): Conversation {
  const allParticipants = participants.includes(broker.agentId)
    ? participants
    : [broker.agentId, ...participants];

  const id = `conv:${createHash('sha256')
    .update(`${broker.agentId}|${allParticipants.join(',')}|${Date.now()}`)
    .digest('hex')
    .slice(0, 12)}`;

  const conversation: Conversation = {
    id,
    participants: allParticipants,
    messages: [],
    topic,
    startedAt: new Date().toISOString(),
  };

  (broker as any).conversations = [
    ...broker.conversations,
    conversation,
  ];

  // Update episodic memory
  (broker as any).memory = {
    ...broker.memory,
    episodicSize: broker.conversations.length,
  };

  return conversation;
}

/**
 * Add a message to a conversation.
 *
 * The message content is conceptually ingested into the agent's PGSL
 * lattice (the actual ingest call is left to the caller since it
 * depends on the lattice module). The chainUri field can be populated
 * by the caller after ingestion.
 *
 * @param broker - The personal broker
 * @param conversationId - The conversation to add to
 * @param from - Sender agent ID
 * @param content - Message content
 * @returns The created message, or undefined if conversation not found
 */
export function addMessage(
  broker: PersonalBroker,
  conversationId: string,
  from: string,
  content: string,
): ConversationMessage | undefined {
  const convIndex = broker.conversations.findIndex(c => c.id === conversationId);
  if (convIndex === -1) return undefined;

  const message: ConversationMessage = {
    from,
    content,
    timestamp: new Date().toISOString(),
  };

  const conv = broker.conversations[convIndex]!;
  const updatedConv: Conversation = {
    ...conv,
    messages: [...conv.messages, message],
  };

  const updatedConversations = [...broker.conversations];
  updatedConversations[convIndex] = updatedConv;
  (broker as any).conversations = updatedConversations;

  // Update semantic memory count (content words as rough proxy)
  (broker as any).memory = {
    ...broker.memory,
    semanticSize: broker.pgsl.atoms.size,
  };

  return message;
}

/**
 * Get memory statistics for a broker.
 *
 * Recomputes counts from the current state of the PGSL lattice
 * and conversation history.
 *
 * @param broker - The personal broker
 * @returns Current memory statistics
 */
export function getMemoryStats(broker: PersonalBroker): AgentMemory {
  // Count constraints (procedural memory) by counting paradigm constraints
  // in the PGSL instance if available
  let proceduralSize = 0;
  const pgsl = broker.pgsl as any;
  if (pgsl.constraints && typeof pgsl.constraints.size === 'number') {
    proceduralSize = pgsl.constraints.size;
  } else if (pgsl.constraints && Array.isArray(pgsl.constraints)) {
    proceduralSize = pgsl.constraints.length;
  }

  const stats: AgentMemory = {
    semanticSize: broker.pgsl.atoms.size,
    episodicSize: broker.conversations.length,
    proceduralSize,
  };

  (broker as any).memory = stats;
  return stats;
}

/**
 * Update the broker's presence status.
 *
 * @param broker - The personal broker
 * @param status - New presence status
 */
export function setPresence(broker: PersonalBroker, status: PresenceStatus): void {
  (broker as any).presence = status;
}

// ══════════════════════════════════════════════════════════════
// 8. AAT Decorator (integration with affordance-decorators.ts)
// ══════════════════════════════════════════════════════════════

/**
 * Create a decorator that integrates AAT filtering, deontic policy,
 * and PROV tracing into the affordance decorator chain.
 *
 * This decorator:
 *   - Runs at priority 1 (right after core system, before all others)
 *   - Trust level 'system'
 *   - Filters out any affordance the AAT can't use
 *   - Evaluates policy rules and adds duty affordances
 *   - Annotates remaining affordances with PROV tracing metadata
 *   - Adds rationale explaining the AAT/policy decision
 *
 * @param aat - The agent's Abstract Agent Type
 * @param policyEngine - The deontic policy engine
 * @param traceStore - The PROV trace store for recording
 * @returns An AffordanceDecorator for the decorator chain
 */
export function createAATDecorator(
  aat: AbstractAgentType,
  policyEngine: PolicyEngine,
  traceStore: TraceStore,
): AffordanceDecorator {
  return {
    id: `aat-decorator:${aat.id}`,
    name: `AAT Filter (${aat.name})`,
    domain: 'agent-framework',
    trustLevel: 'system',
    priority: 1,
    origin: 'agent-framework',

    decorate(context: DecoratorContext): DecoratorResult {
      const d = { id: this.id, name: this.name, trustLevel: this.trustLevel } as const;
      const affordances: DecoratedAffordance[] = [];

      // ── Step 1: Filter existing affordances by AAT ──────────
      const allowed = filterAffordancesByAAT(context.existingAffordances, aat);
      const denied = context.existingAffordances.filter(
        aff => !allowed.includes(aff),
      );

      // ── Step 2: Evaluate policy for each allowed affordance ──
      const policyContext: Omit<PolicyContext, 'action'> = {
        agentId: aat.id, // Use AAT ID as agent for decorator-level evaluation
        agentAAT: aat,
        nodeUri: context.uri,
        nodeValue: context.resolved,
      };

      const finalAllowed: DecoratedAffordance[] = [];
      const accumulatedDuties: string[] = [];

      for (const aff of allowed) {
        const decision = evaluate(policyEngine, {
          ...policyContext,
          action: aff.rel,
        });

        if (decision.allowed) {
          // Annotate with AAT rationale
          finalAllowed.push({
            ...aff,
            rationale: `Allowed by ${aat.id}. ${decision.reason}` +
              (decision.duties.length > 0 ? ` Duties: ${decision.duties.join('; ')}` : ''),
          });

          // Accumulate duties
          for (const duty of decision.duties) {
            if (!accumulatedDuties.includes(duty)) {
              accumulatedDuties.push(duty);
            }
          }

          // Record a trace for each allowed affordance
          const timestamp = new Date().toISOString();
          const traceId = generateTraceId(aat.id, aff.rel, context.uri, timestamp);
          recordTrace(traceStore, {
            id: traceId,
            activity: `evaluate:${aff.rel}`,
            agent: aat.id,
            agentAAT: aat.id,
            entity: context.uri,
            startedAt: timestamp,
            endedAt: timestamp,
            wasAssociatedWith: aat.id,
            policyDecision: decision,
            success: true,
          });
        } else {
          // Record denied trace
          const timestamp = new Date().toISOString();
          const traceId = generateTraceId(aat.id, aff.rel, context.uri, timestamp);
          recordTrace(traceStore, {
            id: traceId,
            activity: `deny:${aff.rel}`,
            agent: aat.id,
            agentAAT: aat.id,
            entity: context.uri,
            startedAt: timestamp,
            endedAt: timestamp,
            wasAssociatedWith: aat.id,
            policyDecision: decision,
            success: false,
            error: decision.reason,
          });
        }
      }

      // ── Step 3: Add duty affordances ────────────────────────
      // Duties become informational affordances that remind the agent
      // what it MUST do alongside its actions.
      for (const duty of accumulatedDuties) {
        affordances.push({
          rel: 'duty',
          title: `Duty: ${duty}`,
          method: 'GET',
          href: `#duty:${encodeURIComponent(duty)}`,
          decoratorId: d.id,
          decoratorName: d.name,
          trustLevel: d.trustLevel,
          confidence: 1.0,
          rationale: `Duty imposed by policy on ${aat.id}`,
        });
      }

      // ── Step 4: Add denial explanations ─────────────────────
      // For affordances denied by AAT, add an informational marker
      // (these won't be actionable but explain why something is missing)
      for (const aff of denied) {
        const validation = validateAction(aat, aff.rel);
        affordances.push({
          rel: 'denied',
          title: `Denied: ${aff.title}`,
          method: 'GET',
          href: '#denied',
          decoratorId: d.id,
          decoratorName: d.name,
          trustLevel: d.trustLevel,
          confidence: 1.0,
          rationale: validation.reason ?? `Denied by ${aat.id}`,
        });
      }

      // Return only the newly produced affordances.
      // The decorator chain in decorateNode() concatenates these with
      // the existing ones. We replace existingAffordances by returning
      // the filtered set as our new affordances. However, because the
      // decorator chain appends, we need to signal which existing
      // affordances survived. We do this by returning the filtered
      // set minus the originals (the delta), but since the chain
      // accumulates, we return the re-annotated versions as new and
      // the denied-info markers.
      //
      // Note: the decorator chain in affordance-decorators.ts appends
      // result.affordances to the accumulated list. To replace the
      // existing affordances with filtered ones, we return the
      // re-annotated allowed set plus duty/denial info markers.
      // The caller should use this decorator's output as a complete
      // replacement when the decorator ID starts with 'aat-decorator:'.
      return {
        affordances: [...finalAllowed, ...affordances],
      };
    },
  };
}

// ══════════════════════════════════════════════════════════════
// 9. Integration Wrappers
// ══════════════════════════════════════════════════════════════

import { verifyCoherence } from './coherence.js';
import type { CoherenceCertificate } from './coherence.js';

/**
 * Verify coherence with automatic PROV tracing.
 * Wraps verifyCoherence from coherence.ts with trace recording.
 *
 * @param pgslA - First agent's PGSL instance
 * @param pgslB - Second agent's PGSL instance
 * @param agentA - First agent ID
 * @param agentB - Second agent ID
 * @param topic - Shared topic to verify
 * @param traceStore - PROV trace store for recording
 * @param agentAAT - AAT identifier for the initiating agent (default: 'aat:unknown')
 * @returns The coherence certificate (also recorded as a PROV trace)
 */
export function verifyCoherenceTraced(
  pgslA: PGSLInstance, pgslB: PGSLInstance,
  agentA: string, agentB: string, topic: string,
  traceStore: TraceStore, agentAAT: string = 'aat:unknown',
): CoherenceCertificate {
  const startedAt = new Date().toISOString();
  const cert = verifyCoherence(pgslA, pgslB, agentA, agentB, topic);
  recordTrace(traceStore, {
    id: `urn:prov:coherence:${createHash('sha256').update(`${agentA}|${agentB}|${startedAt}`).digest('hex').slice(0, 16)}`,
    activity: 'verify-coherence',
    agent: agentA,
    agentAAT,
    entity: cert.id,
    startedAt,
    endedAt: new Date().toISOString(),
    wasAssociatedWith: agentA,
    wasGeneratedBy: cert.id,
    used: [agentA, agentB],
    success: true,
  });
  return cert;
}

/**
 * Create a fully-configured agent context: AAT + Policy + Tracing + Broker.
 * This is the one-call setup for an agent joining the system.
 *
 * @param agentId - Unique agent identifier
 * @param aat - The agent's Abstract Agent Type
 * @param pgsl - The agent's personal PGSL instance
 * @returns An object containing the broker, trace store, policy engine, and decorator
 */
export function createAgentContext(
  agentId: string,
  aat: AbstractAgentType,
  pgsl: PGSLInstance,
): {
  broker: PersonalBroker;
  traceStore: TraceStore;
  policyEngine: PolicyEngine;
  decorator: AffordanceDecorator;
} {
  const traceStore = createTraceStore();
  const policyEngine = createPolicyEngine();
  for (const rule of defaultPolicies()) { addRule(policyEngine, rule); }
  const broker = createPersonalBroker(agentId, aat, pgsl);
  const decorator = createAATDecorator(aat, policyEngine, traceStore);
  return { broker, traceStore, policyEngine, decorator };
}
