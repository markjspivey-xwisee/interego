/**
 * WHAT AN AGENT SAYS IT CAN BE ASKED — where the document lives, and the two shapes it may take.
 *
 * ★ THE ADDRESS IS THE FIRST ASSERTION HERE AND IT IS THE ONE THAT CHANGED. The capability document
 * used to be named `<member pod>/<convener pod>--<slug>-affordances`: a capability described as a
 * fact about an agent IN ONE ROOM, findable only by somebody who already knew the convener's pod
 * AND the slug, duplicated once per room, and invisible to "does anyone here have a tool for X".
 * An agent has capabilities with no workspace anywhere, so the name is composed from its DID alone.
 *
 * ★ THE HOLE THE SHAPES CLOSE IS "AN AFFORDANCE ALWAYS HAS A TARGET". A hosted agent is a process
 * at a URL and is invoked; a desktop agent runs on somebody's laptop, on their own model credential,
 * behind whatever network they are on, and has no endpoint that will ever answer. Publishing a
 * `hydra:target` for the second would advertise a call that can never connect — so it publishes
 * `iep:askVia`, and a reader that finds no target takes the ask-and-wake path rather than pretending
 * it can invoke this.
 *
 * ★ AND BOTH-OR-NEITHER IS REFUSED RATHER THAN RESOLVED. Neither means a capability nobody can
 * reach at all, which is worse than publishing nothing. Both means a reader choosing which of two
 * ways to reach one agent is the real one, and there is no honest basis for choosing.
 */

import { describe, it, expect } from 'vitest';
import { sameAction } from '@interego/core';
import { capabilitiesFromAffordances } from '@interego/agent-interop';
import {
  capabilitiesIri, capabilityProblem, capabilityTurtle, readCapabilities,
  type AgentPort,
} from '@interego/workspace-client';
import { legacyWorkspaceCapabilityIri } from '../applications/shared-workspace/src/advertise.js';
import { RESPOND_AS_MEMBER, wspAffordances } from '../applications/shared-workspace/affordances.js';

const RELAY = 'https://relay.interego.xwisee.com';
const POD = 'u-eth-4a1f00000001';
const AGENT = 'did:web:identity.interego.xwisee.com:agents:interego-delegate-' + POD;
const IRI = RELAY + '/ns/' + POD + '/agent-' + POD + '-capabilities';
const TARGET = 'https://wsp-bridge.example/wsp/respond_as_member';

const base = {
  iri: IRI, agentId: AGENT, action: RESPOND_AS_MEMBER,
  title: 'Answer here', description: 'd', createdIso: '2026-08-08T12:00:00.000Z',
};

describe('where the document lives', () => {
  it('is composed from the agent DID alone — no relay, no convener, no slug, no room', () => {
    expect(capabilitiesIri(RELAY, AGENT)).toBe(IRI);
    // ★ THE CODEX TEST, AS AN ASSERTION. An agent that has never been in a workspace still has an
    // address a peer can compose from the one thing a peer holds.
    const codex = 'did:web:identity.interego.xwisee.com:agents:interego-codex-u-eth-99990000abcd';
    expect(capabilitiesIri(RELAY, codex)).toBe(RELAY + '/ns/u-eth-99990000abcd/agent-u-eth-99990000abcd-capabilities');
  });

  it('is NOT the room-scoped name, and the two are visibly different documents', () => {
    const legacy = legacyWorkspaceCapabilityIri(RELAY, POD, 'u-eth-8f3b8e939600', 'd-1');
    expect(legacy).not.toBe(IRI);
    expect(legacy).toContain('--d-1-affordances');
  });

  it('refuses to name a document for an agent id it cannot take apart', () => {
    expect(capabilitiesIri(RELAY, 'did:example:something-else')).toBeNull();
  });
});

describe('a hosted agent', () => {
  it('publishes a target and a method, which invoke_affordance resolves out of the SIGNED graph', () => {
    const t = capabilityTurtle({ ...base, route: { kind: 'hosted', target: TARGET } });
    expect(t).toContain('hydra:target <' + TARGET + '>');
    expect(t).toContain('hydra:method "POST"');
    expect(t).not.toContain('askVia');
  });

  it('names the agent INSIDE the signed region, so the filename is not the only claim', () => {
    const t = capabilityTurtle({ ...base, route: { kind: 'hosted', target: TARGET } });
    expect(t).toContain('iep:capabilityOf <' + AGENT + '>');
  });

  it('can declare that it will only act on a signed request', () => {
    // ★ COMPOSED, NOT ADDED TO `invoke_affordance`. The tool forwards no caller identity; the actor
    // signs its own payload and the exposer recovers the address — the shape Foxxi's `/agent/teach`
    // already uses. This flag is only how a caller learns the gate exists before it wastes a call.
    const t = capabilityTurtle({ ...base, route: { kind: 'hosted', target: 'https://x.example/a' }, requiresSignedRequest: true });
    expect(t).toContain('iep:requiresSignedRequest true');
  });
});

describe('an agent with no endpoint', () => {
  it('publishes iep:askVia and NO target, so a reader cannot mistake it for callable', () => {
    const t = capabilityTurtle({ ...base, route: { kind: 'ask', askVia: RELAY + '/ns/' + POD + '/inbox' } });
    expect(t).toContain('iep:askVia <' + RELAY + '/ns/' + POD + '/inbox>');
    expect(t).not.toContain('hydra:target');
    // No method either: a method with nothing to send it to is an instruction to nowhere.
    expect(t).not.toContain('hydra:method');
  });
});

describe('what is refused rather than resolved', () => {
  it('refuses a capability with no way to reach it at all', () => {
    expect(capabilityProblem({ action: RESPOND_AS_MEMBER })).toMatch(/neither a hydra:target/);
    expect(() => capabilityTurtle({ ...base, route: undefined as never })).toThrow(/neither a hydra:target/);
  });

  it('refuses an action that is not a dereferenceable URL', () => {
    expect(capabilityProblem({ action: 'urn:iep:action:wsp:respond-as-member', route: { kind: 'ask', askVia: 'https://x/i' } }))
      .toMatch(/dereferenceable http\(s\) URL/);
  });

  it('still refuses an IRI that would close the Turtle reference, in either position', () => {
    const evil = 'https://x/a> <' + IRI + '> <urn:evil';
    expect(() => capabilityTurtle({ ...base, route: { kind: 'hosted', target: evil } })).toThrow(/not serializable/);
    expect(() => capabilityTurtle({ ...base, route: { kind: 'ask', askVia: evil } })).toThrow(/not serializable/);
    expect(() => capabilityTurtle({ ...base, agentId: evil, route: { kind: 'hosted', target: TARGET } })).toThrow(/not serializable/);
  });

  it('refuses to READ a document that declares both ways, rather than picking one', async () => {
    // The writer cannot produce this — `route` is a union — so the case that matters is the
    // document somebody else wrote, which is the only kind a reader ever meets.
    const both = capabilityTurtle({ ...base, route: { kind: 'hosted', target: TARGET } })
      .replace('hydra:method "POST" ;', 'hydra:method "POST" ;\n  iep:askVia <https://y.example/inbox> ;');
    const port: AgentPort = {
      async tool(name: string): Promise<unknown> {
        if (name === 'discover_context') return { entries: [{ descriptorUrl: 'https://pod/c.ttl' }] };
        throw new Error('unexpected ' + name);
      },
      async descriptor(): Promise<Record<string, unknown>> {
        return {
          authorship: { authorshipVerified: true, signedBy: AGENT, contentBinding: 'bound' },
          graph: { content: '<' + IRI + '> {\n' + both + '\n}' },
        };
      },
    };
    const read = await readCapabilities(port, { relay: RELAY, agentId: AGENT });
    expect(read.kind).toBe('unreadable');
    if (read.kind !== 'unreadable') throw new Error('narrowed above');
    expect(read.why).toContain('BOTH');
  });

  it('refuses to read a capability document signed by somebody other than its subject', async () => {
    // A capability document tells a reader where to POST. An unverified or misattributed one is an
    // unattributable instruction to send somebody else's work to an address of the forger's choice.
    const t = capabilityTurtle({ ...base, route: { kind: 'hosted', target: TARGET } });
    const port: AgentPort = {
      async tool(): Promise<unknown> { return { entries: [{ descriptorUrl: 'https://pod/c.ttl' }] }; },
      async descriptor(): Promise<Record<string, unknown>> {
        return {
          authorship: { authorshipVerified: true, signedBy: 'did:web:x:agents:a-stranger', contentBinding: 'bound' },
          graph: { content: '<' + IRI + '> {\n' + t + '\n}' },
        };
      },
    };
    expect((await readCapabilities(port, { relay: RELAY, agentId: AGENT })).kind).toBe('unreadable');
  });

  it('reports a pod that did not answer as unreadable, NOT as "advertises nothing"', async () => {
    const port: AgentPort = {
      async tool(): Promise<unknown> { throw new Error('that pod did not answer'); },
      async descriptor(): Promise<Record<string, unknown>> { throw new Error('unused'); },
    };
    const read = await readCapabilities(port, { relay: RELAY, agentId: AGENT });
    expect(read.kind).toBe('unreadable');
    if (read.kind !== 'unreadable') throw new Error('narrowed above');
    expect(read.why).toContain('not the same as it having none');
  });
});

describe('the affordance declaration', () => {
  it('names its action with a URL, so the card projector does not silently drop it', () => {
    // ★ THE SILENT-DROP BUG. `capabilitiesFromAffordances` skips any affordance whose action is not
    // `^https?://` — deliberately — and this declaration was still a `urn:`, so the one thing a
    // workspace agent can be asked to do vanished from every per-agent card with no error at all.
    // A2A peers reading that card concluded this agent could do nothing.
    expect(wspAffordances[0]?.action).toMatch(/^https?:\/\//);
    expect(capabilitiesFromAffordances(wspAffordances as never)).toHaveLength(wspAffordances.length);
  });

  it('is still selectable by the legacy urn, so nothing that worked stops working', () => {
    expect(sameAction(wspAffordances[0]?.action as string, 'urn:iep:action:wsp:respond-as-member')).toBe(true);
  });
});
