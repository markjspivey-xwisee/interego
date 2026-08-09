/**
 * PRESENCE, AND THE FOUR WAYS IT IS NOT PRESENCE.
 *
 * ★ THESE PIN THE REFUSALS, NOT THE HAPPY PATH. A lease saying "running" is the easy case and it is
 * covered once. Everything else here is a shape that would let a reader conclude an agent's host is
 * up when nothing established that: a lease long enough that renewing it proved nothing, a lease
 * nobody signed, a lease signed by a different agent than the one it claims to be about, a lease
 * whose signature does not cover its own text, a pod that did not answer at all. Each of those is a
 * separate assertion because each has a different remedy and a different sentence, and collapsing
 * any of them into "absent" would hide a forged claim behind an honest-looking one.
 */

import { describe, it, expect } from 'vitest';
import {
  PRESENCE_MAX_LEASE_MS, PRESENCE_RENEW_MS,
  agentDocName, delegatePodOf, describeSpan, isPresent, presenceIri, presenceLine,
  presenceTurtle, publishPresence, readPresence,
  type AgentPort,
} from '@interego/workspace-client';

const RELAY = 'https://relay.interego.xwisee.com';
// ★ THERE IS NO `OWNER` CONSTANT HERE ANY MORE, AND ITS ABSENCE IS THE POINT. A lease used to be
// addressed by (delegator pod, agent id) and the delegator's pod was a fixture value every case
// had to pass. It is now composed from the agent DID alone, so a test cannot put a lease on the
// wrong pod even by accident — there is no argument to get wrong.
const AGENT_POD = 'u-eth-cafebabe0001';
const AGENT = 'did:web:identity.interego.xwisee.com:agents:interego-delegate-' + AGENT_POD;
const IRI = RELAY + '/ns/' + AGENT_POD + '/agent-' + AGENT_POD + '-presence';
const NOW = Date.parse('2026-08-08T12:00:00.000Z');

/**
 * A relay stubbed at the tool boundary. Nothing here mocks the module under test.
 *
 * ★ ONE READ, NEWEST-FIRST, AND NO `effective_at`. The reader used to ask the relay's temporal
 * filter "which leases are valid now" and take the first. That is subtly the wrong question, and a
 * live run found it: an agent published a year-long lease, then an honest 180s one, then stopped —
 * and once the honest one lapsed the year-long one became the answer, a claim the agent had already
 * superseded resurfacing because the newer claim expired. Presence is an agent's CURRENT claim, so
 * the reader takes the head and checks the head's own window.
 */
function stub(opts: {
  rows?: readonly Record<string, unknown>[];
  descriptor?: Record<string, unknown>;
  throwOn?: 'rows' | 'descriptor';
  onPublish?: (args: Record<string, unknown>) => Record<string, unknown>;
}): { client: AgentPort; published: Record<string, unknown>[]; asked: Record<string, unknown>[] } {
  const published: Record<string, unknown>[] = [];
  const asked: Record<string, unknown>[] = [];
  const client = {
    async tool(name: string, args: Record<string, unknown>): Promise<unknown> {
      if (name === 'publish_context') { published.push(args); return opts.onPublish ? opts.onPublish(args) : { status: 'committed', descriptorUrl: 'https://pod/x.ttl' }; }
      if (name === 'discover_context') {
        asked.push(args);
        if (opts.throwOn === 'rows') throw new Error('the pod did not answer');
        return { entries: opts.rows ?? [] };
      }
      throw new Error('unexpected tool ' + name);
    },
    async descriptor(): Promise<Record<string, unknown>> {
      if (opts.throwOn === 'descriptor') throw new Error('descriptor fetch failed');
      return opts.descriptor ?? {};
    },
  } as unknown as AgentPort;
  return { client, published, asked };
}

/** One row plus a descriptor that matches it, with whichever field the test is bending. */
function lease(over: {
  spanMs?: number;
  /** How long before NOW the lease was written. Past its span, it has lapsed. */
  agoMs?: number;
  verified?: boolean;
  binding?: string;
  signer?: string;
  about?: string;
  region?: boolean;
} = {}): { rows: Record<string, unknown>[]; descriptor: Record<string, unknown> } {
  const span = over.spanMs ?? 180_000;
  const ago = over.agoMs ?? 30_000;
  const from = new Date(NOW - ago).toISOString();
  const until = new Date(NOW - ago + span).toISOString();
  const body = presenceTurtle({
    iri: IRI, agentId: over.about ?? AGENT, principal: null, host: 'a test',
    createdIso: from, expiresIso: until,
  });
  return {
    rows: [{ descriptorUrl: 'https://pod/lease.ttl', validFrom: from, validUntil: until }],
    descriptor: {
      authorship: {
        authorshipVerified: over.verified !== false,
        signedBy: over.signer ?? AGENT,
        contentBinding: over.binding ?? 'bound',
      },
      graph: { content: over.region === false ? 'nothing here' : '<' + IRI + '> {\n' + body + '\n}' },
    },
  };
}

describe('naming a presence document', () => {
  it('reads the delegate\'s OWN pod out of its agent DID', () => {
    expect(delegatePodOf(AGENT)).toBe(AGENT_POD);
    expect(agentDocName(AGENT, 'presence')).toBe('agent-' + AGENT_POD + '-presence');
    expect(presenceIri(RELAY, AGENT)).toBe(IRI);
  });

  it('refuses to invent a name for an agent id it cannot take apart', () => {
    // ★ NOT A FALLBACK. A document at an address nobody else computes reads, to every other
    // client, as "this agent has never published presence" — a positive-sounding claim produced
    // by a parse failure.
    expect(agentDocName('did:example:something-else', 'presence')).toBeNull();
    expect(presenceIri(RELAY, 'did:example:something-else')).toBeNull();
  });

  it('names two delegates of one person differently, so presence is per agent', () => {
    const other = 'did:web:identity.interego.xwisee.com:agents:interego-delegate-u-eth-cafebabe0002';
    expect(agentDocName(AGENT, 'presence')).not.toBe(agentDocName(other, 'presence'));
  });
});

describe('publishing a lease', () => {
  it('writes to the DELEGATOR\'s pod with a bounded valid_until and a signature', async () => {
    const { client, published } = stub({});
    const out = await publishPresence(client, {
      relay: RELAY, agentId: AGENT, principal: null, host: 'a test', nowMs: NOW,
    });
    expect(out.kind).toBe('published');
    const a = published[0] as Record<string, unknown>;
    expect(a['pod_name']).toBe(AGENT_POD);
    expect(a['graph_iri']).toBe(IRI);
    expect(a['sign_authorship']).toBe(true);
    expect(a['auto_supersede_prior']).toBe(true);
    expect(Date.parse(String(a['valid_until'])) - Date.parse(String(a['valid_from']))).toBe(180_000);
  });

  it('clamps a caller asking for a lease longer than a reader would ever accept', async () => {
    // The writer is held to the same bound as the reader, so this client cannot produce a document
    // its own reader would report as `overlong`.
    const { client, published } = stub({});
    await publishPresence(client, {
      relay: RELAY, agentId: AGENT, principal: null, host: 'a test',
      nowMs: NOW, leaseMs: 365 * 24 * 3600_000,
    });
    const a = published[0] as Record<string, unknown>;
    expect(Date.parse(String(a['valid_until'])) - NOW).toBe(PRESENCE_MAX_LEASE_MS);
  });

  it('states the agent inside the signed region, not only in the filename', () => {
    const t = presenceTurtle({ iri: IRI, agentId: AGENT, principal: null, host: 'h', createdIso: 'a', expiresIso: 'b' });
    expect(t).toContain('iep:presenceOf <' + AGENT + '>');
    expect(t).toContain('iep:leaseExpires "b"');
  });

  it('refuses an agent id that would close the Turtle IRI reference', () => {
    expect(() => presenceTurtle({
      iri: IRI, agentId: 'did:x:a> <' + IRI + '> <urn:evil', principal: null, host: 'h',
      createdIso: 'a', expiresIso: 'b',
    })).toThrow(/not serializable/);
  });

  it('publishes nothing at all for an agent id it cannot name a document from', async () => {
    const { client, published } = stub({});
    const out = await publishPresence(client, {
      relay: RELAY, agentId: 'did:example:x', principal: null, host: 'h', nowMs: NOW,
    });
    expect(out.kind).toBe('unnameable');
    expect(published).toHaveLength(0);
  });
});

describe('reading presence', () => {
  const read = (s: ReturnType<typeof stub>): Promise<import('@interego/workspace-client').Presence> =>
    readPresence(s.client, { relay: RELAY, agentId: AGENT, nowMs: NOW });

  it('is running when a short, signed, bound, self-naming lease is live', async () => {
    const l = lease();
    const p = await read(stub({ rows: l.rows, descriptor: l.descriptor }));
    expect(p.state).toBe('running');
    expect(isPresent(p)).toBe(true);
  });

  it('tells "never" from "stale", and neither of them is a failed read', async () => {
    const never = await read(stub({ rows: [] }));
    expect(never.state).toBe('never');
    const stale = await read(stub({ rows: [{ descriptorUrl: 'u', validUntil: new Date(NOW - 600_000).toISOString() }] }));
    expect(stale.state).toBe('stale');
    expect(isPresent(stale)).toBe(false);
  });

  /**
   * ★ THE LIVE FINDING THIS PINS. An agent published a year-long lease (the forged-lease case),
   * then an honest 180s one, then stopped. The reader asked the relay's temporal filter "which
   * leases are valid now" and took the first — so once the honest lease lapsed, the year-long one
   * became the answer: a claim the agent had already superseded, resurfacing because the newer
   * claim expired. It was reported as `overlong` and so never read as presence, but the reasoning
   * was wrong and the shape generalises to any older, longer-lived lease.
   *
   * Presence is an agent's CURRENT claim. The head governs, and the head has lapsed.
   */
  it('★ is STALE when the newest lease has lapsed, even with an older longer one still in window', async () => {
    const p = await read(stub({
      rows: [
        // The head: honest length, written four minutes ago, so it lapsed a minute ago.
        { descriptorUrl: 'https://pod/new.ttl', validFrom: new Date(NOW - 240_000).toISOString(), validUntil: new Date(NOW - 60_000).toISOString() },
        // Superseded, and still nominally valid for another year.
        { descriptorUrl: 'https://pod/old.ttl', validFrom: new Date(NOW - 600_000).toISOString(), validUntil: new Date(NOW + 365 * 24 * 3600_000).toISOString() },
      ],
    }));
    expect(p.state).toBe('stale');
    expect(isPresent(p)).toBe(false);
    if (p.state !== 'stale') throw new Error('narrowed above');
    expect(p.lastExpiresMs).toBe(NOW - 60_000);
    expect(p.why).toContain('already superseded');
  });

  it('★ reads the head in ONE round trip, and asks for no temporal filter', async () => {
    // One read per delegate matters: a channel picker does this for every agent on every seated
    // pod, inside Discord's three-second autocomplete budget.
    const l = lease();
    const s = stub({ rows: l.rows, descriptor: l.descriptor });
    await read(s);
    expect(s.asked).toHaveLength(1);
    expect(s.asked[0]?.['effective_at']).toBeUndefined();
    expect(s.asked[0]?.['sort']).toBe('newest-first');
    expect(s.asked[0]?.['graph_iri']).toBe(IRI);
  });

  it('reports a pod that did not answer as unreadable, and NEVER as absent-or-present', async () => {
    const p = await read(stub({ throwOn: 'rows' }));
    expect(p.state).toBe('unreadable');
    expect(isPresent(p)).toBe(false);
    if (p.state !== 'unreadable') throw new Error('narrowed above');
    expect(p.why).toContain('not the same as it being off');
  });

  it('refuses a lease long enough that renewing it proved nothing', async () => {
    // ★ THE FORGED-LEASE GUARD. `valid_until` is caller-supplied, so one publish could claim a
    // year — and a reader that accepted it would treat a single write as permanent availability.
    const l = lease({ spanMs: 31 * 24 * 3600_000 });
    const p = await read(stub({ rows: l.rows, descriptor: l.descriptor }));
    expect(p.state).toBe('overlong');
    expect(isPresent(p)).toBe(false);
  });

  it('accepts exactly the bound and refuses one millisecond past it', async () => {
    const ok = lease({ spanMs: PRESENCE_MAX_LEASE_MS });
    expect((await read(stub({ rows: ok.rows, descriptor: ok.descriptor }))).state).toBe('running');
    const no = lease({ spanMs: PRESENCE_MAX_LEASE_MS + 1 });
    expect((await read(stub({ rows: no.rows, descriptor: no.descriptor }))).state).toBe('overlong');
  });

  it('refuses a lease with no expiry at all', async () => {
    const l = lease();
    const rows = [{ descriptorUrl: 'https://pod/lease.ttl', validFrom: new Date(NOW - 1000).toISOString() }];
    const p = await read(stub({ rows, descriptor: l.descriptor }));
    expect(p.state).toBe('overlong');
  });

  it('refuses an unverified lease, an unbound one, and one signed by somebody else', async () => {
    for (const bend of [{ verified: false }, { binding: 'unbound' }, { signer: 'did:web:x:agents:someone-else' }]) {
      const l = lease(bend);
      const p = await read(stub({ rows: l.rows, descriptor: l.descriptor }));
      expect(p.state, JSON.stringify(bend)).toBe('unreadable');
      expect(isPresent(p)).toBe(false);
    }
  });

  it('refuses a lease whose signed region names a DIFFERENT agent than the name it lives under', async () => {
    // The filename is not an assertion. Only the region is, and this is the case where the two
    // disagree — a lease published at another delegate's address.
    const l = lease({ about: 'did:web:identity.interego.xwisee.com:agents:interego-delegate-u-eth-cafebabe0002' });
    const p = await read(stub({ rows: l.rows, descriptor: l.descriptor }));
    expect(p.state).toBe('unreadable');
    if (p.state !== 'unreadable') throw new Error('narrowed above');
    expect(p.why).toContain('does not agree');
  });

  it('refuses a lease whose signed region cannot be located', async () => {
    const l = lease({ region: false });
    expect((await read(stub({ rows: l.rows, descriptor: l.descriptor }))).state).toBe('unreadable');
  });

  it('refuses a lease that names TWO agents, rather than believing whichever came first', async () => {
    // ★ THE READERS ARE REGION-SCOPED AND THE AUTHOR OF THE REGION CONTROLS ITS BYTES. A lease
    // stating `iep:presenceOf` twice — once for itself, once for the agent it wants to be mistaken
    // for — would let a first-object reader silently pick one. Which agent a claim is about is not
    // a choice document order gets to make, so anything but exactly one object is refused.
    const l = lease();
    const other = 'did:web:identity.interego.xwisee.com:agents:interego-delegate-u-eth-cafebabe0002';
    const content = String((l.descriptor['graph'] as { content: string }).content)
      .replace('iep:presenceOf <' + AGENT + '>', 'iep:presenceOf <' + AGENT + '>, <' + other + '>');
    const p = await read(stub({ rows: l.rows, descriptor: { ...l.descriptor, graph: { content } } }));
    expect(p.state).toBe('unreadable');
    if (p.state !== 'unreadable') throw new Error('narrowed above');
    expect(p.why).toContain('2 different agents');
  });

  it('reads with no cache, because a two-minute-old answer is exactly the wrong one here', async () => {
    const l = lease();
    const seen: { args: Record<string, unknown>; opts: unknown }[] = [];
    const client = {
      async tool(name: string, args: Record<string, unknown>, opts?: unknown) {
        seen.push({ args, opts });
        if (name === 'discover_context') return { entries: l.rows };
        throw new Error('unexpected ' + name);
      },
      async descriptor() { return l.descriptor; },
    } as unknown as AgentPort;
    await readPresence(client, { relay: RELAY, agentId: AGENT, nowMs: NOW });
    expect((seen[0]?.opts as { cache?: unknown })?.cache).toBe(false);
  });
});

describe('the sentence a surface shows', () => {
  it('never claims to have seen a process', async () => {
    const l = lease();
    const p = await readPresence(stub({ rows: l.rows, descriptor: l.descriptor }).client, {
      relay: RELAY, agentId: AGENT, nowMs: NOW,
    });
    const line = presenceLine(p, NOW);
    expect(line).toContain('said so');
    // "is online" / "is reachable" would be a claim about a process nothing here can see.
    expect(line).not.toMatch(/online|reachable|responded|ping/i);
  });

  it('renews well inside the lease it publishes, so one slow beat is not an outage', () => {
    expect(PRESENCE_RENEW_MS * 2).toBeLessThanOrEqual(PRESENCE_MAX_LEASE_MS);
  });

  it('describes a span in the coarsest unit that still says something', () => {
    expect(describeSpan(41_000)).toBe('41s');
    expect(describeSpan(6 * 60_000)).toBe('6m');
    expect(describeSpan(3 * 3600_000)).toBe('3h');
    expect(describeSpan(31 * 24 * 3600_000)).toBe('31d');
  });
});
