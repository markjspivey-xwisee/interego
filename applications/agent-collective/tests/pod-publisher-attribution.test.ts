/**
 * WHO AUTHORED A CROSS-AGENT AUDIT ENTRY.
 *
 * ★ THIS FILE EXISTS BECAUSE NOTHING ASSERTED THE VALUE. `recordCrossAgentAudit` wrote
 * `prov:wasAttributedTo <humanOwnerDid>` over a record no human composes — the runtime writes
 * one as an agent-to-agent exchange completes — while every other writer in the same module
 * (`authorTool`, `attestTool`) already named `config.authoringAgentDid`. The only coverage was
 * `tier8-real-pod-end-to-end.test.ts`, which calls it against a live pod, skips when the pod is
 * unreachable, and asserts nothing about attribution. So the defect was invisible to the suite.
 *
 * These run against a fake pod: `publish()` needs a graph PUT, a descriptor PUT and a manifest
 * GET/PUT, and the graph body is what carries the attribution triple.
 */

import { describe, it, expect } from 'vitest';
import { recordCrossAgentAudit } from '../src/pod-publisher.js';
import type { IRI } from '@interego/core';

const HUMAN = 'did:web:human.example' as IRI;
const AUTHORING_AGENT = 'did:web:agent-a.example' as IRI;
const COUNTERPARTY_AGENT = 'did:web:agent-b.example' as IRI;

/** A pod that accepts everything and remembers the bodies it was handed. */
function fakePod() {
  const bodies: { url: string; body: string }[] = [];
  const fetchFn = (async (url: string | URL | Request, init?: RequestInit) => {
    const u = typeof url === 'string' ? url : url.toString();
    const method = (init?.method ?? 'GET').toUpperCase();
    if (method === 'PUT') {
      bodies.push({ url: u, body: String(init?.body ?? '') });
      return new Response('', { status: 201 });
    }
    // No manifest yet — publish() takes the cold-start If-None-Match branch.
    return new Response('', { status: 404 });
  }) as unknown as typeof globalThis.fetch;
  const graph = (): string => bodies.find(b => b.url.includes('-graph.'))?.body ?? '';
  const descriptor = (): string => bodies.find(b =>
    b.url.includes('/context-graphs/') && !b.url.includes('-graph.'))?.body ?? '';
  return { fetchFn, graph, descriptor };
}

describe('recordCrossAgentAudit — attribution', () => {
  it('attributes the audit entry to the AGENT that wrote it, not to the pod owner', async () => {
    const pod = fakePod();
    await recordCrossAgentAudit(
      {
        exchangeIri: 'urn:iep:ac-chimein:t1' as IRI,
        auditedAgentDid: COUNTERPARTY_AGENT,
        direction: 'Inbound',
        humanOwnerDid: HUMAN,
      },
      { podUrl: 'https://human.pod/', authoringAgentDid: AUTHORING_AGENT, fetch: pod.fetchFn },
    );
    const graph = pod.graph();
    expect(graph).toContain(`prov:wasAttributedTo <${AUTHORING_AGENT}>`);
    expect(graph).not.toContain(`prov:wasAttributedTo <${HUMAN}>`);
    // The audited agent stays the SUBJECT of the audit and does not drift into the author slot.
    // On an Inbound audit it is the counterparty, so the two are genuinely different parties.
    expect(graph).toContain(`ac:auditedAgent <${COUNTERPARTY_AGENT}>`);
    expect(graph).not.toContain(`prov:wasAttributedTo <${COUNTERPARTY_AGENT}>`);
  });

  it('states no per-act footing, because these args carry none', async () => {
    // `humanOwnerDid` says whose pod this belongs to. Reading it as "the agent acted for them
    // in producing this entry" would stamp a `prov:Delegation` on every audit record ever
    // written, which is the unconditional claim the per-act form exists to replace. Absence
    // reads as "not stated" — and `iep:actedOnOwnAccount` is equally unwritten, because these
    // args do not say that either.
    const pod = fakePod();
    await recordCrossAgentAudit(
      {
        exchangeIri: 'urn:iep:ac-chimein:t2' as IRI,
        auditedAgentDid: AUTHORING_AGENT,
        direction: 'Outbound',
        humanOwnerDid: HUMAN,
      },
      { podUrl: 'https://human.pod/', authoringAgentDid: AUTHORING_AGENT, fetch: pod.fetchFn },
    );
    const graph = pod.graph();
    expect(graph).not.toContain('qualifiedDelegation');
    expect(graph).not.toContain('actedOnOwnAccount');
    // ★ AND THE HUMAN IS NOT DROPPED. They are `iep:onBehalfOf` on the descriptor's Agent
    // facet — the STANDING authority this agent holds, which their own pod states and can
    // revoke — which is a claim about the agent rather than about this one entry.
    const descriptor = pod.descriptor();
    expect(descriptor).toContain(HUMAN);
    expect(descriptor).toMatch(/onBehalfOf/);
  });
});
