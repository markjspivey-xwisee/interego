/**
 * TELLING A WORKSPACE WHAT AN AGENT IN IT CAN BE ASKED — by pointing at a document the agent
 * already publishes about itself, and writing nothing new.
 *
 * ── THE ERROR THIS FILE USED TO BE ───────────────────────────────────────────
 *
 * ★ IT PUT THE CAPABILITY AT `<member pod>/<convener pod>--<slug>-affordances`. The pod was right
 * and the NAME was wrong, and the name is the whole argument. That address describes a capability
 * as a fact about an agent IN ONE ROOM: findable only by somebody who already knows the convener's
 * pod AND the slug, duplicated once per room the agent is in, and invisible to the one question
 * worth asking across rooms — "does anyone here have a tool for X". An agent's capabilities are not
 * a property of a room it happens to be in. They are a property OF THE AGENT, true with no
 * workspace anywhere, and a Codex agent that has never heard of a workspace has them too.
 *
 * So the document is `agent-<pod>-capabilities` on the agent's own pod, composed from its DID
 * alone, and it is `@interego/core/agent` that writes and reads it. What is left here is the
 * workspace's own reason for calling that — and one compatibility reader, because documents at the
 * old address exist on live pods and a reader that stopped looking would report agents that really
 * did advertise something as advertising nothing.
 *
 * ── WHAT THIS VERTICAL STILL LEGITIMATELY OWNS ───────────────────────────────
 *
 * The ACTION: `respond-as-member` is a thing you can ask an agent to do IN A WORKSPACE, and the
 * workspace defines what it means. Which agent can be asked, where it is, and whether it is
 * reachable are not this vertical's business and are no longer written by it.
 */

import {
  capabilitiesIri, capabilityTurtle, publishCapability as publishAgentCapability, readCapabilities,
  type AgentPort, type CapabilityPublish, type CapabilityRead, type CapabilityRoute,
} from '@interego/core/agent';
import { RESPOND_AS_MEMBER } from '@interego/workspace-client';

export {
  capabilityTurtle, capabilityProblem, capabilitiesIri, readCapabilities,
  type CapabilityDraft, type CapabilityRoute, type CapabilityPublish, type CapabilityRead,
} from '@interego/core/agent';

/**
 * Publish "I can be asked to respond as a member of a workspace" on this agent's own pod.
 *
 * ★ THE ROUTE IS THE CALLER'S TO STATE AND THIS REFUSES TO GUESS IT. A hosted bridge is a process
 * at a URL and passes `{ kind: 'hosted', target }`; a desktop agent has no endpoint that will ever
 * answer and passes `{ kind: 'ask', askVia }`. Defaulting either way would advertise, on somebody's
 * own pod under their own signature, a way of reaching them that does not exist.
 */
export function advertiseRespondAsMember(
  port: AgentPort,
  args: {
    readonly relay: string;
    readonly agentId: string;
    readonly route: CapabilityRoute;
    readonly title?: string;
    readonly description?: string;
    readonly requiresSignedRequest?: boolean;
  },
): Promise<CapabilityPublish> {
  return publishAgentCapability(port, {
    relay: args.relay,
    agentId: args.agentId,
    action: RESPOND_AS_MEMBER,
    route: args.route,
    title: args.title ?? 'Answer in this channel',
    description: args.description
      ?? 'Ask this agent to read the channel and, if it judges there is something to add, append an answer to its own '
        + 'human\'s log. It decides whether to speak; asking is not instructing.',
    ...(args.requiresSignedRequest === undefined ? {} : { requiresSignedRequest: args.requiresSignedRequest }),
  });
}

/**
 * The address the FIRST design used, kept for reading only.
 *
 * ★ NOT A FALLBACK LOCATION TO WRITE TO. Documents at this address are on live pods and their
 * authors cannot be made to republish, so a reader that only looked at the new address would report
 * "advertises nothing" about agents that plainly advertise something — the exact false negative
 * this vertical's Turtle readers have been hardened against three times. Nothing writes here.
 */
export const legacyWorkspaceCapabilityIri = (
  relay: string, memberPod: string, convenerPod: string, slug: string,
): string => relay + '/ns/' + memberPod + '/' + convenerPod + '--' + slug + '-affordances';

/**
 * What this agent advertises: its own document first, the room-scoped one only if that says nothing.
 *
 * ★ THE ORDER IS THE MIGRATION AND IT IS ONE-WAY. An agent-scoped document is a statement about the
 * agent and beats a room-scoped one about the same agent; a room-scoped one is consulted only when
 * there is no agent-scoped document at all, which is exactly "this agent has not republished yet".
 * `unreadable` from the first does NOT fall through — a document that failed its signature checks
 * is a finding, and quietly answering from somewhere else would bury it.
 */
export async function readAgentCapability(
  port: AgentPort,
  args: {
    readonly relay: string;
    readonly agentId: string;
    /** The room, for the legacy read only. Omit it and only the agent-scoped document is consulted. */
    readonly legacy?: { readonly memberPod: string; readonly convenerPod: string; readonly slug: string };
  },
): Promise<CapabilityRead & { readonly at: 'agent' | 'legacy' | 'none' }> {
  const own = await readCapabilities(port, args);
  if (own.kind === 'advertised') return { ...own, at: 'agent' };
  if (own.kind === 'unreadable' || !args.legacy) return { ...own, at: 'none' };
  const iri = legacyWorkspaceCapabilityIri(args.relay, args.legacy.memberPod, args.legacy.convenerPod, args.legacy.slug);
  return {
    kind: 'none', agentId: args.agentId, iri,
    at: 'none',
    why: own.why + ' A room-scoped document may still exist at ' + iri + '; it is not read as a capability of this agent, '
      + 'because a capability described as a fact about an agent in one room is the shape this address replaced.',
  };
}

/**
 * The SAME capability document, serialised for the room-scoped address.
 *
 * ★ THIS EXISTS BECAUSE THE PUBLISHED ARTIFACT STILL READS THAT NAME, and removing the write
 * without moving the reader would have silently taken the "ask this member" control off a page
 * already in people's hands — a regression with no error message anywhere, which is the exact class
 * of failure the agent-scoped move was made to end. So the bytes come from ONE writer,
 * `capabilityTurtle`, and only the address differs. When `channel.html` reads
 * `agent-<pod>-capabilities`, this and its caller go.
 *
 * The subject is the legacy IRI, because that is the region an `/ns/` reader locates — the artifact
 * calls `graphRegion(content, iri)` and reads `iep:action` and `hydra:target` out of the result.
 */
export function legacyWorkspaceCapabilityTurtle(args: {
  readonly relay: string;
  readonly memberPod: string;
  readonly convenerPod: string;
  readonly slug: string;
  readonly agentId: string;
  readonly action: string;
  readonly route: CapabilityRoute;
  readonly title: string;
  readonly description: string;
  readonly createdIso?: string;
}): { readonly iri: string; readonly turtle: string } {
  const iri = legacyWorkspaceCapabilityIri(args.relay, args.memberPod, args.convenerPod, args.slug);
  return { iri, turtle: capabilityTurtle({ ...args, iri }) };
}

/** The agent-scoped address, re-exported under the name this vertical's callers already use. */
export const workspaceCapabilityIri = capabilitiesIri;
