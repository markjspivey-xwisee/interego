/**
 * AN AGENT'S OWN RECORD OF ITS WORK, AS A GRAPH ON ITS OWN POD.
 *
 * ── ★★ WHY THIS IS A PUBLISHED GRAPH AND NOT A LOG FILE ─────────────────────
 *
 * The desktop already wrote turns to `agent-turns.jsonl`. That file answered "what did this cost"
 * for one person on one machine, and nothing else: it is not addressable, not joinable to the
 * channel it describes, not readable by the agent it is about, and it dies with the laptop.
 *
 * Published as `ieh:AgentTurn` graphs it becomes ordinary substrate — discoverable through
 * `discover_context`, dereferenceable, shape-validated at write time, and readable by the agent
 * ITSELF. That last one is the point. An agent reflecting on its own history is not a new
 * capability anybody had to build; it is an agent reading a graph, which it could already do. The
 * affordance is EMERGENT: nothing was added to the relay, no telemetry endpoint exists, and no
 * privileged reader is involved.
 *
 * ── ★ WHAT IT DELIBERATELY DOES NOT CARRY ───────────────────────────────────
 *
 * Not the prompt, and not the reply. A turn record says a model ran, what it cost, which tools the
 * gate was asked about and what became of the output — never the content. The content already has
 * a home: it is the ENTRY, published under its own authorship rules with its own footing. Copying
 * it here would republish somebody's words a second time, under different rules, in a document
 * they never reviewed. `outcomeReason` is the one string that crosses, and it is the HOST's own
 * sentence about a refusal, not anything the model wrote.
 */

import { turtleIri } from './documents.js';
import { escapeTurtleLiteral, IEP, PROV } from './turtle.js';
import type { WorkspaceClient } from './substrate.js';

/** The harness namespace. Turn vocabulary is `ieh:` because a turn IS a harness operation. */
export const IEH = 'https://markjspivey-xwisee.github.io/interego/ns/harness#';

/** What became of what the model produced. Mirrors the `ieh:TurnOutcome` SKOS scheme exactly. */
export type TurnOutcome = 'Posted' | 'Abstained' | 'Refused' | 'Failed';

/** One turn, as a host observed it. Every field optional except the ones the shape requires. */
export interface AgentTurnFacts {
  /** Stable id for this turn, used to build its IRI. */
  readonly turnId: string;
  /** The agent that ran — a DID or WebID. Required: a turn attributed to nobody is evidence about nobody. */
  readonly agentId: string;
  readonly atIso: string;
  readonly outcome: TurnOutcome;
  /** The host's own sentence, for a refusal. Never the model's text. */
  readonly outcomeReason?: string | null;
  /** Whose behalf it was run on, as an IRI. */
  readonly answeredFor?: string | null;
  /** The channel or workspace IRI. */
  readonly inChannel?: string | null;
  readonly inputTokens?: number | null;
  readonly outputTokens?: number | null;
  readonly cacheReadTokens?: number | null;
  readonly cacheCreationTokens?: number | null;
  readonly costUsd?: number | null;
  readonly elapsedMs?: number | null;
  readonly providerTurns?: number | null;
  readonly toolCallCount?: number | null;
  /** Every model the provider reported for this turn. One turn routinely spans more than one. */
  readonly models?: readonly string[];
}

/** Where an agent's turns accumulate on its pod. One graph, many descriptors — like an entry log. */
export function turnsGraphIri(relay: string, podName: string): string {
  return relay.replace(/\/$/, '') + '/ns/' + podName + '/agent-turns';
}

/** This turn's own IRI, under that graph. */
export function turnIri(relay: string, podName: string, turnId: string): string {
  return turnsGraphIri(relay, podName) + '/t/' + encodeURIComponent(turnId);
}

/**
 * The Turtle for one turn.
 *
 * ★ EVERY IRI GUARDED AND EVERY LITERAL ESCAPED, through the same helpers the workspace writers
 * use. A turn record carries an agent id this process did not mint and a refusal reason that is
 * host prose — an unchecked IRI closes its own reference and writes triples nobody authorised, and
 * this document is published under the pod owner's signature like any other.
 *
 * ★ A NUMBER THAT WAS NOT REPORTED IS OMITTED, NEVER ZEROED. `costUsd: 0` and "the provider told
 * us nothing" are different claims, and a total summed over the first is wrong in a direction
 * nobody would notice.
 */
export function turnTurtle(relay: string, podName: string, f: AgentTurnFacts): string {
  const self = turtleIri(turnIri(relay, podName, f.turnId), 'the turn IRI');
  const agent = turtleIri(f.agentId, 'the agent id this turn is attributed to');

  const num = (p: string, v: number | null | undefined, kind: 'integer' | 'decimal'): string =>
    (typeof v === 'number' && Number.isFinite(v) && v >= 0)
      ? '  ieh:' + p + ' "' + (kind === 'integer' ? Math.round(v) : v) + '"^^xsd:' + kind + ' ;\n'
      : '';

  const iri = (p: string, v: string | null | undefined, what: string): string =>
    v ? '  ' + p + ' ' + turtleIri(v, what) + ' ;\n' : '';

  return '@prefix ieh: <' + IEH + '> .\n'
    + '@prefix iep: <' + IEP + '> .\n'
    + '@prefix prov: <' + PROV + '> .\n'
    + '@prefix xsd: <http://www.w3.org/2001/XMLSchema#> .\n\n'
    + self + '\n'
    + '  a ieh:AgentTurn ;\n'
    + '  prov:wasAssociatedWith ' + agent + ' ;\n'
    + '  prov:startedAtTime "' + escapeTurtleLiteral(f.atIso) + '"^^xsd:dateTime ;\n'
    + '  ieh:turnOutcome ieh:' + f.outcome + ' ;\n'
    + (f.outcomeReason ? '  ieh:outcomeReason "' + escapeTurtleLiteral(f.outcomeReason) + '" ;\n' : '')
    + iri('ieh:answeredFor', f.answeredFor, 'the WebID this turn was run for')
    + iri('ieh:inChannel', f.inChannel, 'the channel IRI this turn ran in')
    + num('inputTokens', f.inputTokens, 'integer')
    + num('outputTokens', f.outputTokens, 'integer')
    + num('cacheReadTokens', f.cacheReadTokens, 'integer')
    + num('cacheCreationTokens', f.cacheCreationTokens, 'integer')
    + num('costUsd', f.costUsd, 'decimal')
    + num('elapsedMs', f.elapsedMs, 'integer')
    + num('providerTurns', f.providerTurns, 'integer')
    + num('toolCallCount', f.toolCallCount, 'integer')
    + (f.models ?? []).map((m) => '  ieh:turnModel "' + escapeTurtleLiteral(m) + '" ;\n').join('')
    // The trailing statement, so the block closes whichever optionals were present.
    + '  iep:modalStatus "Asserted" .\n';
}

/** What happened when a turn was published. */
export type TurnPublish =
  | { readonly ok: true; readonly descriptorUrl: string | null }
  | { readonly ok: false; readonly why: string };

/**
 * Publish one turn to the agent's own pod.
 *
 * ★★ SHAPE-GATED AT THE RELAY, LIKE EVERY OTHER WRITE. `conforms_to_shapes` names the published
 * harness shapes, so a turn missing its outcome is refused before it lands rather than discovered
 * later by whoever tries to read the series. That refusal is the whole reason the shape says the
 * outcome is required.
 *
 * ★ AND IT NEVER THROWS INTO THE TURN IT DESCRIBES. Telemetry that can break the thing it measures
 * is worse than none — the host has already done the work by the time this runs, and a failed
 * record must cost the person nothing.
 */
export async function publishTurn(
  client: WorkspaceClient,
  args: { readonly relay: string; readonly podName: string; readonly facts: AgentTurnFacts },
): Promise<TurnPublish> {
  try {
    const res = await client.tool('publish_context', {
      pod_name: args.podName,
      graph_iri: turnsGraphIri(args.relay, args.podName),
      graph_content: turnTurtle(args.relay, args.podName, args.facts),
      visibility: 'public',
      conforms_to_shapes: [IEH.replace(/#$/, '')],
      // ★ APPEND, NEVER SUPERSEDE. A turn is a thing that happened; a later one does not correct
      // it. Superseding would make the series a single current value, which answers nothing.
      auto_supersede_prior: false,
      sign_authorship: true,
      context_summary: 'agent turn · ' + args.facts.outcome,
    }) as { descriptorUrl?: string; error?: string; message?: string };
    if (res?.error) return { ok: false, why: String(res.message ?? res.error) };
    return { ok: true, descriptorUrl: res?.descriptorUrl ?? null };
  } catch (e) {
    return { ok: false, why: (e as Error)?.message ?? String(e) };
  }
}
