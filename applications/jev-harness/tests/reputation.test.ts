/**
 * Reputation from attestations: the attestation the bridge publishes comes back off the pod as
 * the registry's input, the policy weighs it as a grounded self-attestation, a peer's word
 * weighs more, and the service serves the snapshot through a relay faked at the fetch level.
 */
import { describe, expect, it } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { attestationAxes, attestationPayload, peerAttestationPayload } from '../src/calibration-publish.js';
import { contextFromEnv } from '../src/descriptor.js';
import type { OutcomeRecord } from '../src/judgments/outcome.js';
import { RelayClient } from '../src/publish.js';
import { attestationFromContent, attestationHeads, fetchPodAttestations, reputationOf, REPUTATION_POLICY, toAttestationInput } from '../src/reputation.js';
import { Harness } from '../src/service.js';
import { HarnessStore, computeCalibration } from '../src/store.js';
import { fixtureRepo, preferringJev } from './helpers.js';

const ctx = contextFromEnv('http://localhost:6090');
const POD = 'http://css.railway.internal:3456/u-pk-x/';
const url = (n: number): string => `${POD}context-graphs/${n}.ttl`;

/** Enough navigation outcomes for an Asserted cell, so an attestation is issued. */
function attestedView() {
  const base = { kind: 'outcome' as const, createdAt: '2026-09-21T04:00:00.000Z', model: 'jev-fake', confidence: 1, repository: { name: 'fixture', root: '', commit: null }, usage: { requests: 0, input_tokens: 0, output_tokens: 0, latencyMs: 0 }, missed: [], summary: '', agreement: null };
  const rows: OutcomeRecord[] = Array.from({ length: 5 }, (_, i) => ({ ...base, id: `n${i}`, graphIri: `urn:graph:jev-harness:outcome:n${i}`, judgmentIri: `urn:graph:jev-harness:navigation:j${i}`, judgmentKind: 'navigation', priorConfidence: 0.5, source: 'live', hitAt1: i < 2, hitAt3: i < 4, brier: 0.2, observed: { judgmentIri: `urn:graph:jev-harness:navigation:j${i}` } }));
  return computeCalibration(rows);
}

/** What get_descriptor hands back: descriptor triples, then the attestation payload in its graph block. */
function podContent(payloadTurtle: string, graphIri: string, descriptorUrl: string): string {
  const body = payloadTurtle.split('\n').filter((l) => !l.startsWith('@prefix')).join('\n');
  const prefixes = payloadTurtle.split('\n').filter((l) => l.startsWith('@prefix')).join('\n');
  return `${prefixes}\n<${descriptorUrl}> a <https://markjspivey-xwisee.github.io/interego/ns/iep#ContextDescriptor> .\n<${graphIri}> {\n${body}\n}\n`;
}

describe('an attestation off the pod', () => {
  const payload = attestationPayload(attestedView(), ctx, 'fixture', { calibrationDescriptorUrl: url(77), attestedAt: '2026-09-21T05:00:00.000Z' })!;
  const content = podContent(payload, 'urn:graph:jev-harness:attestation:fixture', url(78));

  it('is read back with its axes, its grounding and its direction, and becomes the registry\'s input', () => {
    const a = attestationFromContent(content, { descriptorUrl: url(78) })!;
    expect(a).toMatchObject({ attestor: ctx.agentId, subject: ctx.agentId, direction: 'Self', attestedAt: '2026-09-21T05:00:00.000Z', fromExecution: url(77), samples: 5 });
    expect(a.axes).toEqual({ competence: 0.8, honesty: 0.8, recency: 1 });
    expect(toAttestationInput(a)).toMatchObject({ id: url(78), issuer: ctx.agentId, subject: ctx.agentId, issuerTrustLevel: 'SelfAsserted', issuedAt: '2026-09-21T05:00:00.000Z' });
  });

  it('is refused when it names nothing that grounds it, or holds no attestation at all', () => {
    expect(attestationFromContent(content.replace(/amta:fromExecution <[^>]+> \.\n/, ''), { descriptorUrl: url(78) })).toBeUndefined();
    expect(attestationFromContent('@prefix x: <http://x/> .\n<http://x/a> x:b "c" .', { descriptorUrl: url(1) })).toBeUndefined();
    expect(attestationFromContent('not turtle {{', { descriptorUrl: url(1) })).toBeUndefined();
  });

  it('keeps only the newest Asserted entry per attestation graph', () => {
    const heads = attestationHeads([
      { descriptorUrl: url(3), describes: ['urn:graph:jev-harness:attestation:fixture'], modalStatus: 'Asserted' },
      { descriptorUrl: url(2), describes: ['urn:graph:jev-harness:attestation:fixture'], modalStatus: 'Asserted' },
      { descriptorUrl: url(4), describes: ['urn:graph:jev-harness:attestation:fixture:peer'], modalStatus: 'Hypothetical' },
      { descriptorUrl: url(5), describes: ['urn:graph:jev-harness:calibration:fixture'], modalStatus: 'Asserted' },
    ]);
    expect(heads.map((h) => h.descriptorUrl)).toEqual([url(3)]);
  });
});

describe('the policy', () => {
  const self = { descriptorUrl: url(78), attestor: 'did:web:x:agents:harness', subject: 'did:web:x:agents:harness', direction: 'Self', axes: { accuracy: 0.9, competence: 0.8 }, attestedAt: '2026-09-21T05:00:00.000Z', fromExecution: url(77) };
  const peer = { ...self, descriptorUrl: url(79), attestor: 'did:web:x:agents:reviewer', direction: 'Peer', axes: { accuracy: 0.5 } };

  it('counts a grounded self-attestation at a quarter, a peer at a half, and weighs the mix', () => {
    const now = '2026-09-21T06:00:00.000Z';
    expect(reputationOf(self.subject, [self], REPUTATION_POLICY, now)?.axes).toEqual({ accuracy: 0.9, competence: 0.8 });
    const mixed = reputationOf(self.subject, [self, peer], REPUTATION_POLICY, now)!;
    // accuracy: (0.9 × 0.25 + 0.5 × 0.5) / 0.75, both an hour old
    expect(mixed.axes['accuracy']).toBeCloseTo((0.9 * 0.25 + 0.5 * 0.5) / 0.75, 6);
    expect(mixed.contributingAttestations).toEqual([url(78), url(79)]);
    expect(mixed.policyHash).toBe('urn:jev-harness:policy:reputation-v1');
  });

  it('is null when nothing attests to the agent', () => {
    expect(reputationOf('did:web:x:agents:other', [self])).toBeNull();
  });
});

describe('the service', () => {
  /** A relay at the fetch level: initialize, discover_context with one attestation head, get_descriptor with its content. */
  function fakeRelay(content: string): RelayClient {
    const fetchImpl: typeof fetch = async (_url, init) => {
      const body = JSON.parse(String(init?.body ?? '{}')) as { id?: number; method?: string; params?: { name?: string; arguments?: Record<string, unknown> } };
      const reply = (result: unknown): Response => new Response(JSON.stringify({ jsonrpc: '2.0', id: body.id, result }), { status: 200, headers: { 'Content-Type': 'application/json', 'Mcp-Session-Id': 's1' } });
      if (body.method === 'initialize') return reply({ protocolVersion: '2025-06-18' });
      if (body.method === 'notifications/initialized') return new Response('', { status: 202 });
      if (body.params?.name === 'discover_context') return reply({ content: [{ type: 'text', text: JSON.stringify({ entries: [{ descriptorUrl: url(78), describes: ['urn:graph:jev-harness:attestation:fixture'], modalStatus: 'Asserted' }, { descriptorUrl: url(70), describes: ['urn:graph:jev-harness:navigation:j1'], modalStatus: 'Hypothetical' }] }) }] });
      if (body.params?.name === 'get_descriptor') return reply({ content: [{ type: 'text', text: JSON.stringify({ graph: { content } }) }] });
      return reply({ content: [{ type: 'text', text: '{}' }] });
    };
    return new RelayClient({ url: 'http://relay.test/mcp', bearer: 'test-token', podName: 'u-pk-x', fetchImpl });
  }

  it('reads the attestations through the relay and serves the snapshot under the policy', async () => {
    const payload = attestationPayload(attestedView(), ctx, 'fixture', { calibrationDescriptorUrl: url(77), attestedAt: '2026-09-21T05:00:00.000Z' })!;
    const relay = fakeRelay(podContent(payload, 'urn:graph:jev-harness:attestation:fixture', url(78)));
    const fetched = await fetchPodAttestations(relay, 'u-pk-x');
    expect(fetched.scanned).toBe(2);
    expect(fetched.attestations).toHaveLength(1);
    expect(fetched.errors).toEqual([]);

    const harness = new Harness({ jev: preferringJev(() => undefined), repoRoot: fixtureRepo(), base: 'http://localhost:6090', store: new HarnessStore(mkdtempSync(join(tmpdir(), 'jev-reputation-'))), relay, context: ctx });
    const view = await harness.reputation();
    expect(view.status).toBe('ok');
    expect(view.subject).toBe(ctx.agentId);
    expect(view.attestations).toHaveLength(1);
    expect(view.snapshot?.axes).toEqual({ competence: 0.8, honesty: 0.8, recency: 1 });
    expect(view.snapshot?.contributingAttestations).toEqual([url(78)]);
    expect(view.policy.policyId).toBe(REPUTATION_POLICY.policyId);
  });

  it('is off without a relay', async () => {
    const harness = new Harness({ jev: preferringJev(() => undefined), repoRoot: fixtureRepo(), base: 'http://localhost:6090', store: new HarnessStore(mkdtempSync(join(tmpdir(), 'jev-reputation-'))), relay: null, context: ctx });
    expect((await harness.reputation()).status).toBe('off');
  });
});

describe('a peer\'s word, drafted by the harness for someone else to publish', () => {
  const view = attestedView();
  it('is Peer, names the attestor and the agent, takes the calibration where the attestor gives nothing, and reads back as PeerAttested', () => {
    const d = peerAttestationPayload(view, ctx, 'fixture', { attestor: 'did:key:z6MkpeerPerson', note: 'The navigation found my files.' }, { calibrationDescriptorUrl: url(77), attestedAt: '2026-09-21T06:00:00.000Z' });
    expect(d.graphIri).toBe('urn:graph:jev-harness:attestation:fixture:peer:did-key-z6mkpeerperson');
    const a = attestationFromContent(podContent(d.content, d.graphIri, url(90)), { descriptorUrl: url(90) })!;
    expect(a.direction).toBe('Peer');
    expect(a.attestor).toBe('did:key:z6MkpeerPerson');
    expect(a.subject).toBe(ctx.agentId);
    expect(a.fromExecution).toBe(url(77));
    expect(a.axes['competence']).toBe(attestationAxes(view)!.competence);
    expect(toAttestationInput(a).issuerTrustLevel).toBe('PeerAttested');
    expect(d.content).toContain('The navigation found my files.');
    expect(d.content).toContain('jvh:draftedBy <' + ctx.agentId + '>');
  });
  it('the attestor\'s own rating wins over the calibration\'s, is bounded, and grounds in what they name', () => {
    const d = peerAttestationPayload(view, ctx, 'fixture', { attestor: 'https://id.example/me#me', about: url(55), axes: { accuracy: 0.9 } }, { attestedAt: '2026-09-21T06:00:00.000Z' });
    expect(d.axes.accuracy).toBe(0.9);
    expect(d.groundedIn).toBe(url(55));
    expect(d.content).toContain('amta:accuracy "0.9"^^xsd:double');
    expect(() => peerAttestationPayload(view, ctx, 'fixture', { attestor: 'did:key:z6Mkx', axes: { accuracy: 1.5 } })).toThrow(/from 0 to 1/);
    expect(() => peerAttestationPayload(view, ctx, 'fixture', { attestor: 'not an iri' })).toThrow(/absolute IRI/);
  });
  it('refuses to draft when neither the attestor nor the calibration rates anything', () => {
    expect(() => peerAttestationPayload(computeCalibration([]), ctx, 'fixture', { attestor: 'did:key:z6Mkx' })).toThrow(/nothing to attest/);
  });
  it('★ moves the snapshot toward the peer: a half beside the self-attestation\'s quarter', () => {
    const self = attestationFromContent(podContent(attestationPayload(view, ctx, 'fixture', { calibrationDescriptorUrl: url(77), attestedAt: '2026-09-21T05:00:00.000Z' })!, 'urn:graph:jev-harness:attestation:fixture', url(78)), { descriptorUrl: url(78) })!;
    const alone = reputationOf(ctx.agentId, [self], REPUTATION_POLICY, '2026-09-21T07:00:00.000Z')!;
    const own = alone.axes['competence']!;
    const rating = own > 0.5 ? 0 : 1;
    const draft = peerAttestationPayload(view, ctx, 'fixture', { attestor: 'did:key:z6Mkpeer', axes: { competence: rating } }, { attestedAt: '2026-09-21T06:00:00.000Z' });
    const peer = attestationFromContent(podContent(draft.content, draft.graphIri, url(91)), { descriptorUrl: url(91) })!;
    const both = reputationOf(ctx.agentId, [self, peer], REPUTATION_POLICY, '2026-09-21T07:00:00.000Z')!;
    expect(both.contributingAttestations).toHaveLength(2);
    expect(both.axes['competence']).not.toBe(own);
    expect(Math.abs(both.axes['competence']! - rating)).toBeLessThan(Math.abs(own - rating));
  });
  it('the service returns the draft with the publish_context call for the attestor\'s own session', () => {
    const harness = new Harness({ jev: preferringJev(() => undefined), repoRoot: fixtureRepo(), base: 'http://localhost:6090', store: new HarnessStore(mkdtempSync(join(tmpdir(), 'jev-peer-'))), relay: null, context: ctx });
    expect(() => harness.draftAttestation({ attestor: 'did:key:z6Mkpeer' })).toThrow(/nothing to attest/);
    const d = harness.draftAttestation({ attestor: 'did:key:z6Mkpeer', axes: { accuracy: 0.8 } });
    expect(d.publish.tool).toBe('publish_context');
    expect(d.publish.arguments['graph_iri']).toBe(d.graphIri);
    expect(d.publish.arguments['graph_content']).toBe(d.content);
    expect(d.publish.arguments['modal_status']).toBe('Asserted');
    expect(d.reputationUrl).toBe('http://localhost:6090/jev-harness/reputation');
  });
});
