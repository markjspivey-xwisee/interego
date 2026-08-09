/**
 * BINDING THIS VERTICAL'S CLIENT TO THE SUBSTRATE'S AGENT SURFACE. Nothing is decided here.
 *
 * ★ PRESENCE IS NOT A WORKSPACE CONCEPT AND NO LONGER LIVES IN THIS PACKAGE. "Is this agent's host
 * running" is a fact about an AGENT — true with no workspace anywhere, and needed by a Codex agent
 * testing a build, a Foxxi tutor and a bare delegate exactly as much as by a channel. It was here
 * only because this vertical needed it first, which is the same call this project has already had
 * to reverse for delegates, for the relay transport and for the Turtle readers. It is
 * `@interego/core/agent` now, beside the capability document and the request verifier, where every
 * vertical reaches it from the layer BELOW rather than sideways out of a peer's client package.
 *
 * What is left here is one adapter — {@link agentPort} — and the re-exports that let this package's
 * consumers, and the generated artifact bundle, pull the SUBSTRATE implementation into themselves
 * rather than a copy.
 */

import type { AgentPort } from '@interego/core/agent';
import { delegatePort } from './delegates.js';
import type { WorkspaceClient } from './substrate.js';

/**
 * Bind this package's transport and error copy to the substrate's agent affordance.
 *
 * ★ COMPOSED OVER `delegatePort` RATHER THAN WRITTEN OUT AGAIN. That already binds `tool` and
 * `describeError`; all an `AgentPort` adds is `descriptor`. Restating the first two here would be a
 * second answer to "how does this vertical describe a transport error", which is the copy a person
 * sees when a consent dialog refuses.
 */
export const agentPort = (client: WorkspaceClient): AgentPort => ({
  ...delegatePort(client),
  descriptor: (url) => client.descriptor(url),
});

export {
  PRESENCE_RENEW_MS, PRESENCE_LEASE_MS, PRESENCE_MAX_LEASE_MS,
  agentPodOf, agentPodOf as delegatePodOf, agentNsIri, agentDocName, agentDocIri, agentIdHash,
  presenceIri, capabilitiesIri,
  presenceTurtle, publishPresence, readPresence, isPresent, presenceLine, describeSpan,
  capabilityProblem, capabilityTurtle, publishCapability, readCapabilities,
  type AgentPort, type Presence, type PresencePublish,
  type CapabilityDraft, type CapabilityRoute, type CapabilityPublish, type CapabilityRead,
} from '@interego/core/agent';
