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
  agentIdHash, capabilitiesIri, capabilityProblem, capabilityTurtle, readCapabilities,
  type AgentPort,
} from '@interego/workspace-client';
import { legacyWorkspaceCapabilityIri } from '../applications/shared-workspace/src/advertise.js';
import { RESPOND_AS_MEMBER, wspAffordances } from '../applications/shared-workspace/affordances.js';

const RELAY = 'https://relay.interego.xwisee.com';
const POD = 'u-eth-4a1f00000001';
const AGENT = 'did:web:identity.interego.xwisee.com:agents:interego-delegate-' + POD;
// ★ THE POD AND A HASH OF THE WHOLE DID. The pod alone was not injective: `register_agent` issues
// several distinct DIDs embedding one pod, and they composed one address — so the second publisher
// silently superseded the first and the first then read back unreadable.
const IRI = RELAY + '/ns/' + POD + '/agent-' + POD + '-' + agentIdHash(AGENT) + '-capabilities';
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
    expect(capabilitiesIri(RELAY, codex))
      .toBe(RELAY + '/ns/u-eth-99990000abcd/agent-u-eth-99990000abcd-' + agentIdHash(codex) + '-capabilities');
    // ★ AND A CO-LOCATED AGENT DOES NOT LAND ON THE SAME DOCUMENT. Two DIDs, one pod, two addresses.
    const sibling = 'did:web:identity.interego.xwisee.com:agents:claude-u-eth-99990000abcd';
    expect(capabilitiesIri(RELAY, sibling)).not.toBe(capabilitiesIri(RELAY, codex));
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

/**
 * WHAT AN AFFORDANCE EXPECTS — THE DIFFERENCE BETWEEN NAMING *WHO* AND NAMING *WHAT*.
 *
 * Without a declared input shape an affordance is a verb with no arguments: a caller learns that
 * an agent can be invoked and learns nothing about what to send it. Every cross-vertical
 * composition then degrades into prose in a channel with a human reading it, because the contract
 * lives out of band. `hydra:expects` puts it in the document, so a Foxxi skill and a workspace
 * agent are reached the same way — resolve the shape, build a conforming body, invoke.
 *
 * Hydra's own term, not a minted one: an operation declaring input under an Interego predicate
 * would make every non-Interego client learn a synonym for a word it already has.
 */
describe('an affordance can say what it expects', () => {
  const SHAPE = 'https://relay.interego.xwisee.com/ns/' + POD + '/teach-shape';

  it('publishes hydra:expects when a shape is declared', () => {
    const t = capabilityTurtle({ ...base, route: { kind: 'hosted', target: TARGET }, expects: SHAPE });
    expect(t).toContain('hydra:expects <' + SHAPE + '>');
  });

  it('★ says nothing at all when none is declared, rather than an empty contract', () => {
    // Absence is a real answer and a different one from "takes nothing". A document that emitted
    // an empty shape would be asserting the agent's terms on its behalf.
    const t = capabilityTurtle({ ...base, route: { kind: 'hosted', target: TARGET } });
    expect(t).not.toContain('hydra:expects');
  });

  it('★ refuses a shape a caller could not fetch, for the same reason iep:action must be one', () => {
    // A contract that is advertised and unreadable is worse than no contract: the caller believes
    // terms exist and cannot read them.
    expect(capabilityProblem({ action: RESPOND_AS_MEMBER, route: { kind: 'hosted', target: TARGET }, expects: 'urn:shape:teach' }))
      .toMatch(/dereferenceable http\(s\) URL/);
    expect(capabilityProblem({ action: RESPOND_AS_MEMBER, route: { kind: 'hosted', target: TARGET }, expects: '' }))
      .toMatch(/not a string|is not named/);
    // Absent is fine — it means the document says nothing about input.
    expect(capabilityProblem({ action: RESPOND_AS_MEMBER, route: { kind: 'hosted', target: TARGET } })).toBeNull();
    expect(capabilityProblem({ action: RESPOND_AS_MEMBER, route: { kind: 'hosted', target: TARGET }, expects: SHAPE })).toBeNull();
  });

  it('carries it on an ask-routed affordance too, which is where composition needs it most', () => {
    // An agent with no endpoint is reached by putting a record on the channel. Knowing the shape
    // of that record is exactly what a caller from another vertical does not otherwise have.
    const t = capabilityTurtle({ ...base, route: { kind: 'ask', askVia: RELAY + '/ns/' + POD + '/inbox' }, expects: SHAPE });
    expect(t).toContain('hydra:expects <' + SHAPE + '>');
    expect(t).toContain('iep:askVia');
  });

  it('guards the shape IRI the same way every other interpolated IRI is guarded', () => {
    expect(() => capabilityTurtle({ ...base, route: { kind: 'hosted', target: TARGET }, expects: 'https://x.example/a> ; iep:capabilityOf <http://evil' }))
      .toThrow();
  });
});

/**
 * AN AGENT THAT CAN DO MORE THAN ONE THING.
 *
 * The unit used to be the DOCUMENT: one `iep:action` on the document IRI, and `capabilitiesIri`
 * composes exactly one address per agent — so an agent with three skills could not publish them.
 * One agent, one verb, permanently.
 *
 * The substrate never required that. The kernel's affordance extractor already finds EVERY subject
 * typed `iep:Affordance` and matches by action, and the relay already emits several that way
 * (`<#canDecrypt>`, `<#renderView>`). Only this writer and its reader insisted on one.
 */
describe('an agent can offer several skills', () => {
  const SHAPE = 'https://relay.interego.xwisee.com/ns/' + POD + '/teach-shape';
  const TEACH = 'https://relay.interego.xwisee.com/ns/' + POD + '/teach';
  const REVIEW = 'https://relay.interego.xwisee.com/ns/' + POD + '/review';
  const ASK_VIA = RELAY + '/ns/' + POD + '/inbox';
  const two = [
    { action: TEACH, route: { kind: 'hosted', target: TARGET } as const, title: 'Teach', description: 'a', expects: SHAPE },
    { action: REVIEW, route: { kind: 'ask', askVia: ASK_VIA } as const, title: 'Review', description: 'b' },
  ];

  const portFor = (turtle: string): AgentPort => ({
    async tool(name: string): Promise<unknown> {
      if (name === 'discover_context') return { entries: [{ descriptorUrl: 'https://pod/c.ttl' }] };
      throw new Error('unexpected ' + name);
    },
    async descriptor(): Promise<Record<string, unknown>> {
      return {
        authorship: { authorshipVerified: true, signedBy: AGENT, contentBinding: 'bound' },
        graph: { content: '<' + IRI + '> {\n' + turtle + '\n}' },
      };
    },
  });

  it('★ a SINGLE offer still emits byte-for-byte what it always did', () => {
    // Every document already published puts the affordance on the document IRI, which is the shape
    // `invoke_affordance` is handed. Changing that for an unchanged agent would be a diff in
    // signed bytes with no change in meaning.
    const legacy = capabilityTurtle({ ...base, route: { kind: 'hosted', target: TARGET } });
    expect(legacy).toContain('<' + IRI + '>\n  a iep:Affordance, hydra:Operation ;');
    expect(legacy).not.toContain('iep:offers');
    expect(legacy).not.toContain('iep:AffordanceManifest');
  });

  it('names each offer at its own fragment, and lists them on the document', () => {
    const t = capabilityTurtle({ ...base, offers: two });
    // ★ NO MINTED TERM. `iep:AffordanceManifest` already means this, and `iep:offers` already
    // exists with `rdfs:domain iep:Agent` — so it hangs off the AGENT, which is also the truer
    // statement. The owned-namespace gate caught the synonym before it shipped.
    expect(t).toContain('a iep:AffordanceManifest');
    expect(t).not.toContain('iep:CapabilityDocument');
    expect(t).toContain('<' + AGENT + '> iep:offers <' + IRI + '#teach>, <' + IRI + '#review>');
    expect(t).toContain('<' + IRI + '#teach>\n  a iep:Affordance, hydra:Operation ;');
    expect(t).toContain('<' + IRI + '#review>\n  a iep:Affordance, hydra:Operation ;');
  });

  it('★ the fragment is derived from the action, so removing one does not move the others', () => {
    // `#a0`/`#a1` would renumber when an offer is dropped from the middle, and a caller holding
    // `<doc#a1>` would silently hold a different action than the one it resolved — and those IRIs
    // are exactly what `invoke_affordance` is handed.
    const second = two[1];
    if (!second) throw new Error('fixture');
    const dropped = capabilityTurtle({ ...base, offers: [second] });
    expect(dropped).toContain('<' + IRI + '#review>');
    expect(dropped).not.toContain('#a0');
  });

  it('keeps two actions whose last segment matches distinct', () => {
    const t = capabilityTurtle({ ...base, offers: [
      { action: 'https://a.example/ns/x/teach', route: { kind: 'hosted', target: TARGET } as const, title: 'A', description: 'a' },
      { action: 'https://b.example/ns/y/teach', route: { kind: 'hosted', target: TARGET } as const, title: 'B', description: 'b' },
    ] });
    // Colliding onto one subject would let the second silently overwrite the first's triples.
    expect(t).toContain('<' + IRI + '#teach>');
    expect(t).toContain('<' + IRI + '#teach-2>');
  });

  it('★ every offer carries its OWN route, shape and title', () => {
    const t = capabilityTurtle({ ...base, offers: two });
    expect(t).toContain('hydra:expects <' + SHAPE + '>');
    expect(t).toContain('iep:askVia <' + ASK_VIA + '>');
    expect(t).toContain('hydra:title "Teach"');
    expect(t).toContain('hydra:title "Review"');
  });

  it('★ reads them all back out of the SIGNED region, in order', async () => {
    const read = await readCapabilities(portFor(capabilityTurtle({ ...base, offers: two })), { relay: RELAY, agentId: AGENT });
    expect(read.kind).toBe('advertised');
    if (read.kind !== 'advertised') throw new Error('narrowed above');
    expect(read.offers).toHaveLength(2);
    expect(read.offers.map((o) => o.action)).toEqual([TEACH, REVIEW]);
    expect(read.offers[0]?.expects).toBe(SHAPE);
    expect(read.offers[0]?.route).toEqual({ kind: 'hosted', target: TARGET });
    expect(read.offers[1]?.route.kind).toBe('ask');
    // The flat fields are the FIRST offer, so every existing caller keeps working unchanged.
    expect(read.action).toBe(TEACH);
    expect(read.route).toEqual({ kind: 'hosted', target: TARGET });
  });

  it('★ a one-offer document reads as one offer, not as none', async () => {
    // The legacy shape has no `iep:offers` and its affordance IS the document. A reader that only
    // understood the new form would report an agent advertising nothing.
    const read = await readCapabilities(portFor(capabilityTurtle({ ...base, route: { kind: 'hosted', target: TARGET } })), { relay: RELAY, agentId: AGENT });
    expect(read.kind).toBe('advertised');
    if (read.kind !== 'advertised') throw new Error('narrowed above');
    expect(read.offers).toHaveLength(1);
    expect(read.offers[0]?.action).toBe(read.action);
  });

  it('★ the agent is named once per subject and that is still ONE agent', () => {
    // `iep:capabilityOf` now appears on the document AND on every offer, so a three-skill agent
    // puts four in the region. The check is "how many DISTINCT agents", and an earlier version
    // counted occurrences — which would have rejected every multi-offer document as naming four.
    const t = capabilityTurtle({ ...base, offers: two });
    expect((t.match(/iep:capabilityOf/g) ?? []).length).toBeGreaterThan(1);
  });

  it('★ refuses when ONE offer among several is unroutable', async () => {
    // Picking the readable ones would be this reader deciding which half of a signed document to
    // believe. A document a caller cannot act on safely is unreadable, not partly available.
    const broken = capabilityTurtle({ ...base, offers: two })
      .replace('  iep:askVia <' + ASK_VIA + '> ;\n', '');
    const read = await readCapabilities(portFor(broken), { relay: RELAY, agentId: AGENT });
    expect(read.kind).toBe('unreadable');
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

  it('★ round-trips hydra:expects out of the SIGNED region, so a caller learns the contract', async () => {
    // Writing it proves nothing on its own. What a caller acts on is what the READER returns, out
    // of bytes the agent's own key signed — so the shape has to survive that path or the whole
    // point of publishing it is lost.
    const SHAPE = 'https://relay.interego.xwisee.com/ns/' + POD + '/teach-shape';
    const t = capabilityTurtle({ ...base, route: { kind: 'hosted', target: TARGET }, expects: SHAPE });
    const port: AgentPort = {
      async tool(name: string): Promise<unknown> {
        if (name === 'discover_context') return { entries: [{ descriptorUrl: 'https://pod/c.ttl' }] };
        throw new Error('unexpected ' + name);
      },
      async descriptor(): Promise<Record<string, unknown>> {
        return {
          authorship: { authorshipVerified: true, signedBy: AGENT, contentBinding: 'bound' },
          graph: { content: '<' + IRI + '> {\n' + t + '\n}' },
        };
      },
    };
    const read = await readCapabilities(port, { relay: RELAY, agentId: AGENT });
    expect(read.kind).toBe('advertised');
    if (read.kind !== 'advertised') throw new Error('narrowed above');
    expect(read.expects).toBe(SHAPE);
  });

  it('reports NO expects rather than an empty one when the document declared none', async () => {
    const t = capabilityTurtle({ ...base, route: { kind: 'hosted', target: TARGET } });
    const port: AgentPort = {
      async tool(name: string): Promise<unknown> {
        if (name === 'discover_context') return { entries: [{ descriptorUrl: 'https://pod/c.ttl' }] };
        throw new Error('unexpected ' + name);
      },
      async descriptor(): Promise<Record<string, unknown>> {
        return {
          authorship: { authorshipVerified: true, signedBy: AGENT, contentBinding: 'bound' },
          graph: { content: '<' + IRI + '> {\n' + t + '\n}' },
        };
      },
    };
    const read = await readCapabilities(port, { relay: RELAY, agentId: AGENT });
    expect(read.kind).toBe('advertised');
    if (read.kind !== 'advertised') throw new Error('narrowed above');
    // Undefined, not ''. A caller must be able to tell "said nothing" from "declared an empty
    // contract", because only the second means the agent takes no arguments.
    expect(read.expects).toBeUndefined();
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
