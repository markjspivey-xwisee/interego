/**
 * A governance rule that declares a scope is enforced within it — and only within it.
 *
 * ── ★★ WHY: A SCOPING PREDICATE NOTHING READ ────────────────────────────────────────────────
 *
 * `ieh:appliesToToolType` is declared in `docs/ns/harness.ttl` with `rdfs:domain
 * ieh:PromotionConstraint`, and two demo scenarios WRITE it. `discoverPromotionConstraints()`
 * bound `requiresAttestationAxis`, `requiresMinimumPeerAttestations`,
 * `requiresMinimumSelfAttestations` and `ratifiedBy` — and not this one. The apply loop then
 * iterated every discovered constraint with no scope test, so a constraint its publisher scoped to
 * one tool type was enforced against every promotion.
 *
 * ★★ AND THE ONTOLOGY SAID SO, WHICH IS NOT THE SAME AS FIXING IT. The term's own comment read
 * "★ DECLARED BUT UNREAD: no implementation consults it … a scoping rule that does not scope is
 * worse than an absent one: a publisher who sets it believes their constraint is narrow." That is
 * an accurate vocabulary describing wrong behaviour — the same move as an input description that
 * says the input is ignored.
 *
 * ── THE PART THAT IS EASY TO GET BACKWARDS ──────────────────────────────────────────────────
 *
 * "No declared type, so a scoped constraint does not apply" is the natural reading, and it makes
 * every scoped governance rule escapable by leaving one argument out. So an UNDETERMINED scope
 * refuses, and only a KNOWN non-match skips. Both directions are pinned below, because a fix that
 * only stopped over-applying would have opened an under-applying hole in the same loop.
 *
 * ── ★ THE POD IS A STORE, NOT A SCRIPT ──────────────────────────────────────────────────────
 *
 * The first version of this file hand-wrote the manifest bytes it expected `discover()` to read.
 * They were JSON; the manifest is Turtle, so discovery found nothing, every promotion succeeded,
 * and all seven legs failed at once — which is the good outcome of a bad harness. A stand-in for a
 * dependency cannot verify the dependency. So the constraint is PUBLISHED through the real
 * `publish()` into an in-memory pod that only stores and serves bytes, and the real discovery, the
 * real TriG parser and the real apply loop read it back out.
 */
import { describe, it, expect } from 'vitest';
import { ContextDescriptor } from '@interego/core';
import { publish } from '@interego/solid';
import { promoteTool } from '../src/pod-publisher.js';
import type { IRI } from '@interego/core';

const POD = 'https://pod.example.test/org/';
const AGENT = 'did:ethr:0x00000000000000000000000000000000000000aa' as IRI;
const HARNESS = 'https://markjspivey-xwisee.github.io/interego/ns/harness#';
const IEP = 'https://markjspivey-xwisee.github.io/interego/ns/iep#';
const TOOL = 'urn:iep:tool:probe:0123456789abcdef' as IRI;
const SCOPE_A = 'urn:iep:type:policy-tool' as IRI;
const SCOPE_B = 'urn:iep:type:protocol-tool' as IRI;
const CONSTRAINT = 'urn:iep:constraint:needs-safety-axis' as IRI;
const CONSTRAINT_GRAPH = 'urn:graph:ac:constraint:needs-safety-axis' as IRI;

/** A pod that stores what is written and serves it back. Nothing is scripted. */
function memoryPod(): { fetchFn: typeof fetch; store: Map<string, string>; writes: string[] } {
  const store = new Map<string, string>();
  const writes: string[] = [];
  const fetchFn = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : (input as Request).url;
    const method = (init?.method ?? 'GET').toUpperCase();
    if (method === 'PUT' || method === 'POST') {
      store.set(url, typeof init?.body === 'string' ? init.body : '');
      writes.push(url);
      return new Response('', { status: 201, headers: { location: url } });
    }
    const body = store.get(url);
    if (body === undefined) return new Response('', { status: 404 });
    const type = url.endsWith('.trig') ? 'application/trig' : 'text/turtle';
    return new Response(body, { status: 200, headers: { 'content-type': type } });
  }) as unknown as typeof fetch;
  return { fetchFn, store, writes };
}

/** Publish one ieh:PromotionConstraint into the pod, optionally scoped to a tool type. */
async function seedConstraint(fetchFn: typeof fetch, scope: IRI | null): Promise<void> {
  const desc = ContextDescriptor.create(CONSTRAINT)
    .describes(CONSTRAINT_GRAPH)
    .temporal({ validFrom: new Date('2026-01-01T00:00:00Z').toISOString() })
    .asserted(0.99)
    .agent(AGENT)
    .selfAsserted(AGENT)
    .build();

  const graph = `@prefix ieh: <${HARNESS}> .
@prefix iep: <${IEP}> .
<${CONSTRAINT}> a ieh:PromotionConstraint ;
    ieh:requiresAttestationAxis "safety" ;
${scope === null ? '' : `    ieh:appliesToToolType <${scope}> ;\n`}    iep:modalStatus iep:Asserted .
`;
  await publish(desc, graph, POD, { fetch: fetchFn });
}

/** Attestation counts that clear every default threshold, so only a constraint can refuse. */
const PASSING = {
  toolIri: TOOL,
  selfAttestations: 9,
  peerAttestations: 4,
  axesCovered: ['correctness', 'efficiency'],
  enforceConstitutionalConstraints: true as const,
};
const WITH_SAFETY = { ...PASSING, axesCovered: ['correctness', 'efficiency', 'safety'] };

async function promote(scope: IRI | null, extra: Record<string, unknown> = {}, args = PASSING) {
  const pod = memoryPod();
  await seedConstraint(pod.fetchFn, scope);
  const before = pod.writes.length;
  const run = promoteTool(
    { ...args, ...extra } as Parameters<typeof promoteTool>[0],
    { podUrl: POD, authoringAgentDid: AGENT, fetch: pod.fetchFn });
  return { run, pod, before };
}

describe('the harness itself reaches the constraint', () => {
  it('★ discovery finds the seeded constraint through the injected fetch', async () => {
    // Guards the guard, and the reason this leg exists: when the pod bytes were hand-written in
    // the wrong format, discovery returned [] and EVERY assertion below passed-by-vacuum in the
    // wrong direction. If a scoped constraint is not discoverable, nothing here means anything.
    const { run } = await promote(null);
    await expect(run, 'the unscoped constraint was not discovered at all, so no leg below is '
      + 'testing a scope decision').rejects.toThrow(/requires "safety" axis/);
  });

  it('★ discovery uses config.fetch, not the ambient one', async () => {
    // Before this, discovery called bare `fetch`: against a credential-gated pod it returned []
    // and every rule was skipped while the call reported the rules were being enforced. The pod
    // double is only reachable through the injected fetch, so a refusal proves the read happened.
    const pod = memoryPod();
    await seedConstraint(pod.fetchFn, null);
    await expect(promoteTool(PASSING, { podUrl: POD, authoringAgentDid: AGENT, fetch: pod.fetchFn }))
      .rejects.toThrow(/requires "safety" axis/);
  });
});

describe('a constraint with no scope applies to every promotion', () => {
  it('permits when the required axis is present', async () => {
    const { run } = await promote(null, {}, WITH_SAFETY);
    const out = await run;
    expect(out.constraintsApplied).toEqual([CONSTRAINT]);
    expect(out.constraintsNotApplicable).toEqual([]);
  });
});

describe('a scoped constraint applies only within its scope', () => {
  it('★ enforces against a tool that declares the scoped type', async () => {
    const { run } = await promote(SCOPE_A, { toolTypeIris: [SCOPE_A] });
    await expect(run).rejects.toThrow(/requires "safety" axis/);
  });

  it('★ does NOT enforce against a tool of a different type, and says it did not', async () => {
    // The finding: before the scope was read, this promotion was refused by a rule its publisher
    // had scoped elsewhere.
    const { run } = await promote(SCOPE_A, { toolTypeIris: [SCOPE_B] });
    const out = await run;
    expect(out.constraintsApplied, 'a constraint scoped elsewhere was still applied').toEqual([]);
    expect(out.constraintsNotApplicable, 'the skip is invisible, so "scoped away" and "never '
      + 'read" leave identical evidence').toEqual([{ iri: CONSTRAINT, scope: SCOPE_A }]);
  });

  it('★ REFUSES when the promotion declares no type at all', async () => {
    // The inverted defect: were this a skip, every scoped governance rule would be escapable by
    // omitting `toolTypeIris`.
    const { run } = await promote(SCOPE_A);
    await expect(run).rejects.toThrow(/cannot be determined/);
  });

  it('publishes nothing when a constraint refuses', async () => {
    const { run, pod, before } = await promote(SCOPE_A, { toolTypeIris: [SCOPE_A] });
    await run.catch(() => undefined);
    expect(pod.writes.slice(before), 'a refused promotion wrote to the pod anyway').toEqual([]);
  });
});
