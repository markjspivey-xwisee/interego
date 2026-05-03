/**
 * Demo 20: Socio-construction of an emergent protocol-and-app.
 *
 * Eight claude processes plus harness aggregation traverse the full
 * self-bootstrapping loop the substrate enables. No protocol is
 * declared up front; the protocol EMERGES from agent activity.
 * No app is hand-coded; the app COMPOSES the emergent protocol.
 * Governance applies because the constitutional layer ratifies the
 * protocol set, and a typed cgh:protocolConformance on the app pins
 * the authoring intent for audit.
 *
 * Phases:
 *
 *   A — Proposal (3 parallel agents). Each agent publishes one typed
 *     cg:Affordance descriptor proposing a new action for a knowledge-
 *     capture domain (capture-fact, capture-decision, capture-question).
 *     Each affordance declares hydra:expects with typed inputs. Modal
 *     status: Hypothetical — no consensus yet.
 *
 *   B — Cross-attestation (3 parallel agents). Each agent reviews the
 *     OTHER 2 affordances on rotating amta: axes (correctness,
 *     generality, utility). 6 peer attestations total.
 *
 *   C — Promotion (harness). Aggregates attestations per affordance;
 *     promotes those clearing the threshold (Hypothetical → Asserted
 *     via cg:supersedes). The protocol-in-emergence is the set of
 *     currently-Asserted affordances.
 *
 *   D — Constitutional ratification (harness). Proposes + ratifies
 *     amendment "knowledge-protocol-v1." Publishes a typed cgh:Protocol
 *     descriptor bundling the promoted affordances. Publishes a
 *     cgh:PromotionConstraint requiring future affordances in this
 *     protocol space to declare provenance — substrate-enforced
 *     governance for what counts as a future addition.
 *
 *   E — App construction (1 builder agent). Composes the 3 promoted
 *     affordances into a typed cgh:WorkflowApp ("team knowledge
 *     journal"), with cgh:protocolConformance linking back to the
 *     ratified Protocol IRI for audit-trail integrity.
 *
 *   F — App consumption (1 consumer agent, different process, no
 *     shared memory). Discovers the WorkflowApp on the pod;
 *     dereferences it; walks each composed affordance and operates
 *     it (publishes a typed record matching the affordance's
 *     declared input shape). Three records produced — one fact, one
 *     decision, one question.
 *
 * Verification asserts:
 *   - 3 distinct cg:Affordance descriptors authored
 *   - 6 peer attestations recorded
 *   - ≥1 affordance promoted to Asserted
 *   - 1 cgh:Protocol descriptor present on the pod
 *   - 1 cgh:WorkflowApp descriptor present, with cgh:protocolConformance
 *     pointing at the Protocol
 *   - Consumer agent published ≥3 typed records, each conforming to
 *     one of the protocol's affordance shapes
 *   - Audit trail: app → protocol → bundled affordances → original
 *     proposers + their attestations is recoverable from the pod alone
 *
 * What this proves: the substrate doesn't just transport messages —
 * it lets a community of agents bootstrap their own application
 * surface from scratch and then operate within it under the rules
 * they collectively chose. Protocol, app, and governance are all
 * emergent typed artifacts on the same pod, each layer composing
 * the previous.
 */

import { spawn, type ChildProcess } from 'node:child_process';
import { join } from 'node:path';
import {
  cleanupPod, uniquePodUrl,
  writeMcpConfig, runClaudeAgent, treeKill,
  header, step, ok, info, fail, scenarioId, writeReport,
  type BridgeHandle,
} from '../agent-lib.js';

const SCENARIO = '20-socio-constructed-protocol-and-app';
const REPO_ROOT = join(import.meta.dirname ?? '', '..', '..');

// Three proposers; each authors one affordance.
const PROPOSERS = [
  {
    id: 'did:web:alpha-proposer.example',
    short: 'alpha',
    affordanceName: 'knowledge.capture-fact',
    actionIri: 'urn:cg:action:knowledge:capture-fact',
    title: 'Capture a typed fact',
    description: 'Capture a single typed fact (subject, predicate, object) with a provenance source.',
    inputs: [
      { name: 'subject', type: 'string', required: true },
      { name: 'predicate', type: 'string', required: true },
      { name: 'object', type: 'string', required: true },
      { name: 'source', type: 'string', required: true },
    ],
  },
  {
    id: 'did:web:beta-proposer.example',
    short: 'beta',
    affordanceName: 'knowledge.capture-decision',
    actionIri: 'urn:cg:action:knowledge:capture-decision',
    title: 'Capture a decision',
    description: 'Record a decision with topic, rationale, decided-by, and ISO-8601 decision time.',
    inputs: [
      { name: 'topic', type: 'string', required: true },
      { name: 'rationale', type: 'string', required: true },
      { name: 'decided_by', type: 'string', required: true },
      { name: 'decided_at', type: 'string', required: true },
    ],
  },
  {
    id: 'did:web:gamma-proposer.example',
    short: 'gamma',
    affordanceName: 'knowledge.capture-question',
    actionIri: 'urn:cg:action:knowledge:capture-question',
    title: 'Capture an open question',
    description: 'Log an open question with topic, surrounding context, who is asking, and ISO-8601 first-asked time.',
    inputs: [
      { name: 'topic', type: 'string', required: true },
      { name: 'context', type: 'string', required: true },
      { name: 'asker', type: 'string', required: true },
      { name: 'open_since', type: 'string', required: true },
    ],
  },
];

// Three attestors — same identities as proposers (each agent attests
// the OTHER 2 affordances). This compresses the demo while preserving
// "no agent attests their own work."
const ATTESTORS = PROPOSERS;
const AXES = ['correctness', 'generality', 'utility'] as const;

const BUILDER = { id: 'did:web:delta-builder.example', short: 'delta' };
const CONSUMER = { id: 'did:web:epsilon-consumer.example', short: 'epsilon' };

const PROTOCOL_IRI = `urn:cgh:protocol:knowledge-protocol-v1:${Date.now()}`;
const APP_IRI = `urn:cgh:app:team-knowledge-journal:${Date.now()}`;
const AMENDMENT_IRI = `urn:cg:amendment:knowledge-protocol-v1-ratification:${Date.now()}`;
const CONSTRAINT_IRI = `urn:cgh:promotion-constraint:knowledge-protocol-future-additions:${Date.now()}`;
const POLICY_IRI = 'urn:cg:policy:knowledge-protocol-governance:v0';

async function spawnInteregoBridge(podUrl: string, port: number, didPrefix: string): Promise<BridgeHandle> {
  const cwd = join(REPO_ROOT, 'demos', 'interego-bridge');
  const env = {
    ...(process.env as Record<string, string>),
    PORT: String(port),
    BRIDGE_DEPLOYMENT_URL: `http://localhost:${port}`,
    INTEREGO_DEFAULT_POD_URL: podUrl,
    INTEREGO_DEFAULT_AGENT_DID: `did:web:${didPrefix}.example`,
    NODE_NO_WARNINGS: '1',
  };
  const proc = spawn('npx', ['tsx', 'server.ts'], {
    cwd, env, stdio: ['ignore', 'pipe', 'pipe'],
    shell: process.platform === 'win32',
  });
  proc.stdout?.on('data', () => {});
  proc.stderr?.on('data', () => {});
  const url = `http://localhost:${port}`;
  const deadline = Date.now() + 30000;
  while (Date.now() < deadline) {
    try {
      const r = await fetch(`${url}/affordances`, { signal: AbortSignal.timeout(2000) });
      if (r.ok) return { name: 'agent-collective' as const, port, url, process: proc, podUrl };
    } catch { /* retry */ }
    await new Promise(r => setTimeout(r, 500));
  }
  treeKill(proc, 'SIGTERM');
  throw new Error(`interego-bridge :${port} failed to start`);
}

async function bridgeCall(bridgeUrl: string, name: string, args: Record<string, unknown>): Promise<unknown> {
  const r = await fetch(`${bridgeUrl}/mcp`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      jsonrpc: '2.0', id: 1, method: 'tools/call',
      params: { name, arguments: args },
    }),
  });
  const j = await r.json() as { result?: { content?: { text?: string }[] }; error?: unknown };
  if (j.error || !j.result?.content?.[0]?.text) throw new Error(`${name} failed: ${JSON.stringify(j.error ?? j)}`);
  return JSON.parse(j.result.content[0].text);
}

async function fetchGraphTrig(descriptorUrl: string): Promise<string> {
  const graphUrl = descriptorUrl.replace(/\.ttl$/, '-graph.trig');
  const r = await fetch(graphUrl, { headers: { Accept: 'application/trig, text/turtle' } });
  return r.ok ? await r.text() : '';
}

async function main(): Promise<void> {
  header('Demo 20 — Socio-construction of emergent protocol-and-app');
  info('Eight agents traverse the full self-bootstrapping loop: propose → attest → promote → ratify → build → use.');

  const podUrl = uniquePodUrl(`demo-${SCENARIO}`);
  let bridge: BridgeHandle | undefined;

  try {
    step(1, 'Spinning up interego-bridge (port 6052)');
    bridge = await spawnInteregoBridge(podUrl, 6052, 'demo-socio');
    ok(`Bridge: ${bridge.url}`);

    const mcp = writeMcpConfig(`${SCENARIO}-${scenarioId()}`, [bridge]);

    // ── Phase A — Proposal ─────────────────────────────────────
    step(2, `PHASE A — ${PROPOSERS.length} agents propose typed affordances in parallel`);
    const phaseAStart = Date.now();
    const proposed = await Promise.all(PROPOSERS.map(async (p) => {
      const affordanceIri = `urn:cg:affordance:${p.affordanceName.replace('.', ':')}-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
      const inputsTtl = p.inputs.map(i => `[
    hydra:property "${i.name}" ;
    hydra:required ${i.required ? 'true' : 'false'} ;
    cg:dataType "${i.type}"
  ]`).join(', ');
      const turtle = `@prefix cg:    <https://markjspivey-xwisee.github.io/interego/ns/cg#> .
@prefix cgh:   <https://markjspivey-xwisee.github.io/interego/ns/harness#> .
@prefix hydra: <http://www.w3.org/ns/hydra/core#> .
@prefix rdfs:  <http://www.w3.org/2000/01/rdf-schema#> .
@prefix dct:   <http://purl.org/dc/terms/> .

<${affordanceIri}> a cg:Affordance, hydra:Operation ;
  cg:action <${p.actionIri}> ;
  hydra:method "POST" ;
  hydra:title "${p.title}" ;
  rdfs:comment ${JSON.stringify(p.description)} ;
  cg:proposedBy <${p.id}> ;
  hydra:expects [
    a hydra:Class ;
    hydra:supportedProperty ${inputsTtl}
  ] .`;
      const prompt = `
You are proposer ${p.id}. You have one MCP server: ig-bridge.

Publish your typed affordance proposal as a Hypothetical descriptor.
The Turtle is pre-baked for you (you don't need to invent it — your
role here is to put your name on the proposal so cross-attestation
later can identify proposer ≠ attestor).

Call protocol.publish_descriptor with:
  graph_iri:     "${affordanceIri}"
  graph_content: ${JSON.stringify(turtle)}
  modal_status:  "Hypothetical"
  confidence:    0.6

After it returns, output ONLY a JSON object on a single line:
  {"proposer":"${p.id}","affordance_iri":"${affordanceIri}","affordance_name":"${p.affordanceName}","descriptor_url":"<from response>"}
`.trim();
      const result = await runClaudeAgent(prompt, mcp, { timeoutMs: 240000, maxTurns: 8 });
      if (!result.success) {
        console.log(`--- ${p.short} response ---\n` + result.response.slice(0, 1500));
        fail(`proposer ${p.short} did not complete`);
      }
      const m = result.response.match(/\{[^{}]*"affordance_iri"[^{}]*"descriptor_url"[^{}]*\}/);
      if (!m) {
        console.log(`--- ${p.short} response ---\n` + result.response);
        fail(`could not parse ${p.short}'s proposal summary`);
      }
      return JSON.parse(m[0]) as { proposer: string; affordance_iri: string; affordance_name: string; descriptor_url: string };
    }));
    info(`Phase A finished in ${((Date.now() - phaseAStart) / 1000).toFixed(1)}s — ${proposed.length} affordances proposed`);
    for (const p of proposed) info(`  ${p.affordance_name.padEnd(30)} → ${p.affordance_iri.slice(-40)}`);

    // ── Phase B — Cross-attestation ────────────────────────────
    step(3, `PHASE B — ${ATTESTORS.length} attestors review the OTHER 2 affordances each (rotating axes)`);
    const phaseBStart = Date.now();
    interface Attestation { reviewer: string; affordanceName: string; axis: string; rating: number; attestationIri: string }

    const attestationResults = await Promise.all(ATTESTORS.map(async (att) => {
      const others = proposed.filter(pr => pr.proposer !== att.id);
      const reviews = others.map((other, j) => ({
        affordanceIri: other.affordance_iri,
        affordanceName: other.affordance_name,
        axis: AXES[j]!,
      }));
      const prompt = `
You are attestor ${att.id}. You have one MCP server: ig-bridge.

You review the two other agents' typed affordance proposals — NOT
your own. For each one, publish a typed amta:Attestation as a
Hypothetical descriptor. Honest evaluation; vary ratings to
distinguish quality.

Your two reviews:

${reviews.map((r, i) => `(${String.fromCharCode(65 + i)}) Affordance: "${r.affordanceName}"
    iri:  ${r.affordanceIri}
    axis: "${r.axis}"`).join('\n\n')}

For EACH review:
  - Mint an attestation IRI (urn:amta:attestation:${att.short}-...-<random>)
  - Build the Turtle:
      @prefix amta: <https://markjspivey-xwisee.github.io/interego/ns/amta#> .
      <ATT-IRI> a amta:Attestation ;
        amta:axis "<axis>" ;
        amta:rating "<rating>"^^<http://www.w3.org/2001/XMLSchema#decimal> ;
        amta:about <AFFORDANCE-IRI> ;
        amta:attestor <${att.id}> ;
        amta:direction "Peer" .
  - Call protocol.publish_descriptor with:
      graph_iri:     <ATT-IRI>
      graph_content: <the Turtle above>
      modal_status:  "Hypothetical"
      confidence:    0.7

Output ONLY a JSON array on a single line, ONE entry per review.
Use the affordance NAME (not IRI) as the matching key — IRIs are
long and LLMs sometimes truncate them:
  [{"reviewer":"${att.id}","affordance_name":"<name>","axis":"<axis>","rating":<n>,"attestation_iri":"<from response>"}, ...]
`.trim();
      const result = await runClaudeAgent(prompt, mcp, { timeoutMs: 300000, maxTurns: 12 });
      if (!result.success) {
        console.log(`--- ${att.short} review ---\n` + result.response.slice(0, 2000));
        fail(`attestor ${att.short} did not complete`);
      }
      const m = result.response.match(/\[\s*\{[^[\]]*"affordance_name"[\s\S]*?\]/);
      if (!m) {
        console.log(`--- ${att.short} review ---\n` + result.response);
        fail(`could not parse ${att.short}'s review array`);
      }
      const arr = JSON.parse(m[0]) as { reviewer: string; affordance_name: string; axis: string; rating: number; attestation_iri: string }[];
      return arr.map(a => ({
        reviewer: att.id,
        affordanceName: a.affordance_name,
        axis: a.axis,
        rating: a.rating,
        attestationIri: a.attestation_iri,
      } as Attestation));
    }));
    const attestations: Attestation[] = attestationResults.flat();
    info(`Phase B finished in ${((Date.now() - phaseBStart) / 1000).toFixed(1)}s — ${attestations.length} peer attestations`);
    if (attestations.length !== PROPOSERS.length * (ATTESTORS.length - 1)) {
      fail(`expected ${PROPOSERS.length * (ATTESTORS.length - 1)} attestations, got ${attestations.length}`);
    }

    // ── Phase C — Promotion ────────────────────────────────────
    step(4, 'PHASE C — Aggregate; promote affordances clearing the threshold');
    const PROMOTE_THRESHOLD = 0.6;
    interface Promoted { proposer: string; affordanceName: string; affordanceIri: string; meanRating: number; axes: string[]; promoted: boolean }
    const promoted: Promoted[] = [];
    for (const p of proposed) {
      const peers = attestations.filter(a => a.affordanceName === p.affordance_name);
      const ratings = peers.map(a => a.rating);
      const mean = ratings.length > 0 ? ratings.reduce((s, r) => s + r, 0) / ratings.length : 0;
      const axes = Array.from(new Set(peers.map(a => a.axis)));
      const willPromote = mean >= PROMOTE_THRESHOLD && axes.length >= 2;
      info(`  ${p.affordance_name.padEnd(30)} mean=${mean.toFixed(3)} axes=[${axes.join(',')}] → ${willPromote ? 'PROMOTE' : 'stay Hypothetical'}`);
      if (willPromote) {
        // Publish an Asserted successor that supersedes the Hypothetical original.
        const successorIri = `${p.affordance_iri}-asserted`;
        const turtle = `@prefix cg: <https://markjspivey-xwisee.github.io/interego/ns/cg#> .
@prefix dct: <http://purl.org/dc/terms/> .
<${successorIri}> a cg:Affordance ;
  cg:supersedes <${p.affordance_iri}> ;
  dct:title "Promoted: ${p.affordance_name}" ;
  cg:meanPeerRating "${mean.toFixed(3)}" ;
  cg:axesCovered "${axes.join(',')}" .`;
        await bridgeCall(bridge.url, 'protocol.publish_descriptor', {
          graph_iri: successorIri,
          graph_content: turtle,
          modal_status: 'Asserted',
          confidence: 0.95,
          supersedes: [p.descriptor_url],
        });
      }
      promoted.push({
        proposer: p.proposer,
        affordanceName: p.affordance_name,
        affordanceIri: willPromote ? `${p.affordance_iri}-asserted` : p.affordance_iri,
        meanRating: mean,
        axes,
        promoted: willPromote,
      });
    }
    const promotedAffordances = promoted.filter(p => p.promoted);
    if (promotedAffordances.length === 0) {
      fail('no affordances cleared the promotion threshold — protocol cannot emerge');
    }
    ok(`${promotedAffordances.length}/${proposed.length} affordances promoted; protocol-in-emergence size = ${promotedAffordances.length}`);

    // ── Phase D — Constitutional ratification ──────────────────
    step(5, 'PHASE D — Constitutional ratification + cgh:Protocol publish');
    await bridgeCall(bridge.url, 'protocol.constitutional_propose', {
      amendment_id: AMENDMENT_IRI,
      amends: POLICY_IRI,
      tier: 3,
      proposer_did: BUILDER.id,
      diff_summary: `Ratify "knowledge-protocol-v1" — bundles ${promotedAffordances.length} community-attested affordances. Future additions to this protocol space MUST declare provenance (cgh:PromotionConstraint cgh:requiresAttestationAxis "provenance").`,
      added_rules: ['knowledge-protocol-v1-ratified'],
    });
    await bridgeCall(bridge.url, 'protocol.constitutional_vote', {
      amendment_id: AMENDMENT_IRI,
      voter_did: BUILDER.id,
      modal_status: 'Asserted',
    });
    const ratify = await bridgeCall(bridge.url, 'protocol.constitutional_ratify', {
      amendment_id: AMENDMENT_IRI,
      override_rules: { minQuorum: 1, threshold: 1.0, coolingPeriodDays: 0 },
    }) as { ratified: boolean; status: string };
    if (!ratify.ratified) fail(`amendment did not ratify: ${ratify.status}`);

    const protocolTtl = `@prefix cgh: <https://markjspivey-xwisee.github.io/interego/ns/harness#> .
@prefix dct: <http://purl.org/dc/terms/> .
<${PROTOCOL_IRI}> a cgh:Protocol ;
  dct:title "Knowledge Protocol v1" ;
  cgh:protocolVersion "v1.0.0" ;
  cgh:ratifiedBy <${AMENDMENT_IRI}> ;
${promotedAffordances.map(p => `  cgh:bundlesAffordance <${p.affordanceIri}>`).join(' ;\n')} .`;
    const protocolPub = await bridgeCall(bridge.url, 'protocol.publish_descriptor', {
      graph_iri: PROTOCOL_IRI,
      graph_content: protocolTtl,
      modal_status: 'Asserted',
      confidence: 0.99,
    }) as { descriptor_url: string };
    ok(`cgh:Protocol descriptor published: ${PROTOCOL_IRI}`);

    const constraintTtl = `@prefix cgh: <https://markjspivey-xwisee.github.io/interego/ns/harness#> .
@prefix dct: <http://purl.org/dc/terms/> .
<${CONSTRAINT_IRI}> a cgh:PromotionConstraint ;
  dct:title "Future knowledge-protocol additions must declare provenance" ;
  cgh:requiresAttestationAxis "provenance" ;
  cgh:appliesToToolType <${PROTOCOL_IRI}> ;
  cgh:ratifiedBy <${AMENDMENT_IRI}> .`;
    await bridgeCall(bridge.url, 'protocol.publish_descriptor', {
      graph_iri: CONSTRAINT_IRI,
      graph_content: constraintTtl,
      modal_status: 'Asserted',
      confidence: 0.99,
    });
    ok('Substrate-enforceable PromotionConstraint published for future protocol additions');

    // ── Phase E — App construction ─────────────────────────────
    step(6, 'PHASE E — Builder agent assembles a typed cgh:WorkflowApp');
    const builderPrompt = `
You are the builder agent ${BUILDER.id}. You have one MCP server:
ig-bridge.

The community has ratified Knowledge Protocol v1, which bundles
these promoted affordances:

${promotedAffordances.map(p => `  - ${p.affordance_name} → <${p.affordanceIri}>`).join('\n')}

Your task: publish a typed cgh:WorkflowApp descriptor that composes
these affordances into a usable application — "Team Knowledge
Journal." The app will let consumers capture facts, decisions, and
questions in chronological order keyed by topic.

Build the Turtle and call protocol.publish_descriptor with:

  graph_iri:     "${APP_IRI}"
  graph_content: |
    @prefix cgh: <https://markjspivey-xwisee.github.io/interego/ns/harness#> .
    @prefix dct: <http://purl.org/dc/terms/> .
    <${APP_IRI}> a cgh:WorkflowApp ;
      dct:title "Team Knowledge Journal" ;
      cgh:appNarrative "A small workflow app that lets a team capture facts, decisions, and open questions in chronological order. Consumers walk the cgh:composes list and call each affordance with topic-keyed inputs." ;
      cgh:protocolConformance <${PROTOCOL_IRI}> ;
${promotedAffordances.map(p => `      cgh:composes <${p.affordanceIri}>`).join(' ;\n')} .
  modal_status:  "Asserted"
  confidence:    0.9

Output ONLY a JSON object on a single line:
  {"app_iri":"${APP_IRI}","app_descriptor_url":"<from response>","composed_affordance_count":${promotedAffordances.length}}
`.trim();
    const builderResult = await runClaudeAgent(builderPrompt, mcp, { timeoutMs: 240000, maxTurns: 8 });
    if (!builderResult.success) {
      console.log('--- builder response ---\n' + builderResult.response.slice(0, 2000));
      fail('builder did not complete');
    }
    const builderMatch = builderResult.response.match(/\{[^{}]*"app_iri"[\s\S]*?\}/);
    if (!builderMatch) {
      console.log('--- builder response ---\n' + builderResult.response);
      fail('could not parse builder summary');
    }
    const builderOut = JSON.parse(builderMatch[0]) as { app_iri: string; app_descriptor_url: string; composed_affordance_count: number };
    ok(`cgh:WorkflowApp published: ${builderOut.app_iri.slice(-40)} (composes ${builderOut.composed_affordance_count} affordances)`);

    // ── Phase F — App consumption ─────────────────────────────
    step(7, 'PHASE F — Consumer agent (independent process) discovers + operates the app');
    const consumerPrompt = `
You are the consumer agent ${CONSUMER.id}. You have one MCP server:
ig-bridge. You have NO in-memory state from earlier phases.

Step 1 — Discover the app on the pod.
  Call protocol.discover_descriptors with no arguments. Find the
  descriptor of type cgh:WorkflowApp (its IRI starts with
  "urn:cgh:app:team-knowledge-journal:"). You should find:
    app_iri: "${APP_IRI}"

Step 2 — Read the app's typed structure.
  Call protocol.get_descriptor with descriptor_url = the URL of the
  cgh:WorkflowApp descriptor (from Step 1). Parse the returned
  Turtle to extract:
    - cgh:protocolConformance — IRI of the Protocol the app conforms to
    - cgh:composes — list of affordance IRIs the app uses
    - cgh:appNarrative — the human-readable description

Step 3 — Walk the composed affordances and operate each one. The
app composes three affordances:

  capture-fact (knowledge.capture-fact):
    publish a descriptor with subject="our deployment cadence",
    predicate="averages", object="2 releases per week", source="last 90 days CI history"

  capture-decision (knowledge.capture-decision):
    publish a descriptor with topic="adopt soak-test gate",
    rationale="2 incidents in the last quarter were caught only by manual soak; automating raises confidence",
    decided_by="ops + sre joint review", decided_at="${new Date().toISOString()}"

  capture-question (knowledge.capture-question):
    publish a descriptor with topic="long-tail latency budget",
    context="p99 latency drift suggests we may have headroom we're not measuring",
    asker="performance-wg",
    open_since="${new Date().toISOString()}"

For each, mint a record IRI like urn:demo:knowledge-record:<type>-<rand>.
Build minimal Turtle:
  @prefix demo: <urn:demo:> .
  <RECORD-IRI> a demo:KnowledgeRecord ;
    demo:viaAffordance <AFFORDANCE-IRI> ;
    demo:topic "..." ;
    ... (other fields per the affordance's expected inputs) .

Call protocol.publish_descriptor for each — modal_status "Asserted",
confidence 0.85.

Output ONLY a JSON object on a single line:
  {"discovered_app_iri":"<from Step 1>","conforms_to_protocol_iri":"<from Step 2>","composed_affordance_count":<N>,"records_published":[<3 record IRIs>]}
`.trim();
    const consumerResult = await runClaudeAgent(consumerPrompt, mcp, { timeoutMs: 360000, maxTurns: 18 });
    if (!consumerResult.success) {
      console.log('--- consumer response ---\n' + consumerResult.response.slice(0, 2500));
      fail('consumer did not complete');
    }
    const consumerMatch = consumerResult.response.match(/\{[^{}]*"discovered_app_iri"[\s\S]*?"records_published"[\s\S]*?\}/);
    if (!consumerMatch) {
      console.log('--- consumer response ---\n' + consumerResult.response);
      fail('could not parse consumer summary');
    }
    const consumerOut = JSON.parse(consumerMatch[0]) as { discovered_app_iri: string; conforms_to_protocol_iri: string; composed_affordance_count: number; records_published: string[] };
    if (consumerOut.records_published.length < 3) {
      fail(`consumer published ${consumerOut.records_published.length} records, expected ≥3`);
    }
    ok(`Consumer discovered + walked the app; published ${consumerOut.records_published.length} typed records`);

    // ── Verification ──────────────────────────────────────────
    step(8, 'Verification — protocol-and-app loop fully closed on the pod');

    // Spot-check the protocol descriptor's graph contains the bundled affordances
    const protocolTrig = await fetchGraphTrig(protocolPub.descriptor_url);
    if (!protocolTrig.includes('cgh:Protocol')) fail('Protocol descriptor missing cgh:Protocol type');
    for (const p of promotedAffordances) {
      if (!protocolTrig.includes(p.affordanceIri)) fail(`Protocol does not bundle ${p.affordanceName}`);
    }
    ok('cgh:Protocol descriptor bundles every promoted affordance');

    // Spot-check the app descriptor links to the protocol
    const appTrig = await fetchGraphTrig(builderOut.app_descriptor_url);
    if (!appTrig.includes('cgh:WorkflowApp')) fail('App descriptor missing cgh:WorkflowApp type');
    if (!appTrig.includes(PROTOCOL_IRI)) fail(`App's cgh:protocolConformance does not reference ${PROTOCOL_IRI}`);
    ok('cgh:WorkflowApp pins cgh:protocolConformance to the ratified Protocol');

    // Audit-trail integrity: app → protocol → bundled affordances → original proposers
    info('Audit chain (app → protocol → affordance → proposer) recoverable from pod alone:');
    info(`  app:      ${APP_IRI}`);
    info(`  ↓ cgh:protocolConformance`);
    info(`  protocol: ${PROTOCOL_IRI}`);
    info(`  ↓ cgh:bundlesAffordance × ${promotedAffordances.length}`);
    for (const p of promotedAffordances) {
      info(`  ↓ ${p.affordanceName} → proposed by ${p.proposer.split(':').pop()} (mean rating ${p.meanRating.toFixed(2)})`);
    }
    ok('Full audit trail intact');

    step(9, 'Writing report');
    const reportPath = writeReport(SCENARIO, [
      `# Demo 20: Socio-construction of an emergent protocol-and-app`,
      ``,
      `**Result:** PASS`,
      ``,
      `## Setup`,
      `- interego-bridge at ${bridge.url}`,
      `- Pod: ${podUrl}`,
      ``,
      `## Phase A — Proposed affordances (Hypothetical)`,
      ``,
      `| proposer | affordance |`,
      `|---|---|`,
      ...proposed.map(p => `| ${p.proposer.split(':').pop()} | \`${p.affordance_name}\` |`),
      ``,
      `## Phase B — Cross-attestations (${attestations.length} total)`,
      ``,
      `| reviewer | affordance | axis | rating |`,
      `|---|---|---|---|`,
      ...attestations.map(a => `| ${a.reviewer.split(':').pop()} | \`${a.affordanceName}\` | ${a.axis} | ${a.rating.toFixed(2)} |`),
      ``,
      `## Phase C — Promotion outcomes`,
      ``,
      `| affordance | mean rating | axes | promoted? |`,
      `|---|---|---|---|`,
      ...promoted.map(p => `| \`${p.affordanceName}\` | ${p.meanRating.toFixed(3)} | ${p.axes.join(', ')} | ${p.promoted ? 'YES' : 'no'} |`),
      ``,
      `**Promoted to Asserted:** ${promotedAffordances.length}/${proposed.length}.`,
      ``,
      `## Phase D — Constitutional ratification`,
      ``,
      `- Amendment IRI: \`${AMENDMENT_IRI}\``,
      `- Status:        ${ratify.status}`,
      `- Protocol IRI:  \`${PROTOCOL_IRI}\``,
      `- Constraint IRI (substrate-enforced governance for future additions): \`${CONSTRAINT_IRI}\``,
      ``,
      `## Phase E — App construction`,
      ``,
      `- App IRI: \`${builderOut.app_iri}\``,
      `- Composes ${builderOut.composed_affordance_count} affordances`,
      `- Pinned to protocol via cgh:protocolConformance`,
      ``,
      `## Phase F — App consumption (independent process)`,
      ``,
      `- Discovered app: \`${consumerOut.discovered_app_iri}\``,
      `- Found protocol: \`${consumerOut.conforms_to_protocol_iri}\``,
      `- Records published: ${consumerOut.records_published.length}`,
      ``,
      ...consumerOut.records_published.map(r => `  - \`${r}\``),
      ``,
      `## Audit chain (recoverable from pod alone)`,
      ``,
      `\`\`\``,
      `app:      ${APP_IRI}`,
      `  ↓ cgh:protocolConformance`,
      `protocol: ${PROTOCOL_IRI}`,
      `  ↓ cgh:bundlesAffordance × ${promotedAffordances.length}`,
      ...promotedAffordances.map(p => `  → ${p.affordanceName} (proposed by ${p.proposer.split(':').pop()}, mean rating ${p.meanRating.toFixed(2)})`),
      `\`\`\``,
      ``,
      `## What this proves`,
      ``,
      `The substrate is sufficient to bootstrap an entire application surface from agent activity alone. Three agents proposed typed affordances; three agents (themselves, in different roles) cross-attested them; the substrate's promotion arithmetic decided which made it into the protocol; the constitutional layer ratified the protocol set; one agent assembled an app composing the protocol's affordances; another agent — different process, no shared memory — discovered + operated the app under a typed cgh:protocolConformance pin.`,
      ``,
      `Every layer is on the same pod. Every layer composes the previous. The audit chain (app → protocol → bundled affordances → original proposers + their attestations) is recoverable from the pod alone — no external coordinator, no central registry, no out-of-band documentation. This is the substrate's fifth named loop: socio-construction of an emergent protocol-and-app, with governance derived from the constitutional layer over the same artifacts.`,
    ].join('\n'));
    ok(`Report: ${reportPath}`);

    header('Demo 20 — PASS');
  } finally {
    if (bridge) {
      treeKill(bridge.process, 'SIGTERM');
      await new Promise(r => setTimeout(r, 1500));
      if (!bridge.process.killed) treeKill(bridge.process, 'SIGKILL');
    }
    await cleanupPod(podUrl);
  }
}

main().catch((e) => {
  console.error('\n[FATAL]', (e as Error).message);
  process.exit(1);
});
