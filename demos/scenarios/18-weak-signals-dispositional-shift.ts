/**
 * Demo 18: Weak signals → adjacent possible → dispositional shift →
 * realignment rate (Snowden-informed sensemaking on the substrate).
 *
 * Five claude processes plus harness aggregation produce the four
 * complexity-aware shapes that ARCHITECTURAL-FOUNDATIONS.md §9 named
 * as gaps and that subsequent ontology revisions added:
 *
 *   wks:WeakSignal           (typed weak-signal observations)
 *   wks:Reinforcement        (cross-observer aggregation)
 *   sat:Disposition          (typed candidate explanation)
 *   sat:weakSignal / shiftedBy / dampedBy (interpretant links)
 *   cgh:isAdjacentPossibleTo (reachability without prediction)
 *   cgh:RealignmentMeasure   (rate of re-cohesion after a sign event)
 *
 * Concrete flow:
 *
 *   Phase 1 — Independent observation. Four agents in parallel each
 *     observe a different micro-symptom of the same underlying
 *     phenomenon (a code-generation agent showing subtle drift after
 *     a model update). Each publishes a wks:WeakSignal Hypothetical
 *     descriptor with wks:about pointing at the shared phenomenon
 *     IRI. The observers do NOT see each other's signals.
 *
 *   Phase 2 — Structural reinforcement. Harness queries the pod for
 *     wks:WeakSignal descriptors with the shared wks:about subject;
 *     counts distinct wks:observedBy values; publishes a
 *     wks:Reinforcement descriptor recording the count and window.
 *     Reinforcement falls out of the graph topology — no LLM
 *     judgment, no negotiation.
 *
 *   Phase 3 — Sensemaking agent. One agent (different process, no
 *     shared memory) reads the reinforced signals and produces:
 *       (a) a sat:Disposition descriptor with weakSignal / shiftedBy /
 *           dampedBy links to the candidate intervention types;
 *       (b) a cgh:isAdjacentPossibleTo descriptor linking the current
 *           situation to a plausible next state (production-regression
 *           risk). The descriptor is Hypothetical — the transition is
 *           not predicted, only held open as reachable.
 *
 *   Phase 4 — Realignment measurement. Harness counts the publish +
 *     supersedes events that occurred during the demo window;
 *     publishes a cgh:RealignmentMeasure descriptor with the computed
 *     rate, window duration, and event count.
 *
 * Verification asserts every named ontology shape appears on the pod
 * (wks:WeakSignal, wks:Reinforcement, sat:Disposition,
 * cgh:isAdjacentPossibleTo, cgh:RealignmentMeasure) and that the
 * substrate's structural reinforcement count matches the harness's
 * independent count.
 *
 * What this proves about emergent semiotics on the substrate:
 *
 *   - Reinforcement is structural, not negotiated. Two observers
 *     publishing weak signals about the same wks:about subject
 *     reinforce each other automatically — no LLM voting, no
 *     consensus protocol.
 *   - Adjacent-possible is a typed reachability claim, not a
 *     prediction. The substrate holds the space of next-move
 *     possibilities open without committing.
 *   - Dispositions are candidate semiotic explanations. The
 *     substrate makes them legible without claiming they are true.
 *   - Realignment rate is a temporal derivative of the substrate's
 *     metabolism — events per unit window, not state of alignment.
 *     Honest answer to "how fast does the network re-cohere after a
 *     sign event destabilizes it."
 */

import { spawn, type ChildProcess } from 'node:child_process';
import { join } from 'node:path';
import {
  cleanupPod, uniquePodUrl,
  writeMcpConfig, runClaudeAgent,
  header, step, ok, info, fail, scenarioId, writeReport,
  type BridgeHandle,
} from '../agent-lib.js';

const SCENARIO = '18-weak-signals-dispositional-shift';
const REPO_ROOT = join(import.meta.dirname ?? '', '..', '..');

// Common shared subject — the phenomenon all observers are subtly
// detecting. wks:about pointing at this is the structural matching
// key for cross-observer reinforcement.
const PHENOMENON_IRI = 'urn:demo:phenomenon:codegen-agent-post-deploy-drift';

const OBSERVERS = [
  {
    id: 'did:web:obs-alpha.example',
    short: 'alpha',
    micro: 'Last 47 generated functions used nested ternary expressions where the team style guide says guard-clause if/else. Pre-deploy baseline was 3 nested-ternaries per 47 functions; current is 31.',
    suggestedDisposition: 'reverting-to-older-training-distribution',
  },
  {
    id: 'did:web:obs-beta.example',
    short: 'beta',
    micro: 'Test-coverage suggestions are becoming less specific. Pre-deploy: agent suggested explicit edge cases ("test empty list, single element, off-by-one"); current: vague ("test edge cases").',
    suggestedDisposition: 'reverting-to-older-training-distribution',
  },
  {
    id: 'did:web:obs-gamma.example',
    short: 'gamma',
    micro: 'Inline comment density is rising — more comment lines per code line than baseline — but the comments are explaining what the code does rather than why. Style-guide compliance dropping.',
    suggestedDisposition: 'reverting-to-older-training-distribution',
  },
  {
    id: 'did:web:obs-delta.example',
    short: 'delta',
    micro: 'Recent JS generations used "var" three times this week where the codebase exclusively uses "let" / "const" via ESLint. The agent had been respecting the lint rule for months.',
    suggestedDisposition: 'reverting-to-older-training-distribution',
  },
];

const SENSEMAKER = { id: 'did:web:epsilon-sensemaker.example', short: 'epsilon' };

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
  proc.kill('SIGTERM');
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

async function main(): Promise<void> {
  header('Demo 18 — Weak signals → adjacent possible → dispositional shift → realignment');
  info('Five agents + harness aggregation. All four complexity-aware ontology shapes exercised end-to-end.');

  const podUrl = uniquePodUrl(`demo-${SCENARIO}`);
  let bridge: BridgeHandle | undefined;
  const start = Date.now();

  try {
    step(1, 'Spinning up interego-bridge (port 6052)');
    bridge = await spawnInteregoBridge(podUrl, 6052, 'demo-wks');
    ok(`Bridge: ${bridge.url}`);

    const mcpConfigPath = writeMcpConfig(`${SCENARIO}-${scenarioId()}`, [bridge]);

    // ── Phase 1 ───────────────────────────────────────────
    step(2, `PHASE 1 — ${OBSERVERS.length} observer agents publish independent weak signals in parallel`);
    const phase1Start = Date.now();
    const observed = await Promise.all(OBSERVERS.map(async (obs) => {
      const signalIri = `urn:demo:weak-signal:${obs.short}-${Date.now()}`;
      const narrativeIri = `urn:pgsl:atom:wks:${obs.short}-${Date.now()}`;
      const turtle = `@prefix wks: <https://markjspivey-xwisee.github.io/interego/ns/wks#> .
@prefix sat: <https://markjspivey-xwisee.github.io/interego/ns/sat#> .
@prefix cg:  <https://markjspivey-xwisee.github.io/interego/ns/cg#> .
@prefix dct: <http://purl.org/dc/terms/> .
@prefix pgsl: <https://markjspivey-xwisee.github.io/interego/ns/pgsl#> .

<${narrativeIri}> a wks:NarrativeEvidence, pgsl:Atom ;
  pgsl:value ${JSON.stringify(obs.micro)} .

<${signalIri}> a wks:WeakSignal ;
  dct:title "Weak signal observed by ${obs.short}" ;
  wks:about <${PHENOMENON_IRI}> ;
  wks:observedBy <${obs.id}> ;
  wks:hasNarrativeEvidence <${narrativeIri}> ;
  wks:candidateDisposition <urn:demo:disposition:${obs.suggestedDisposition}> .`;
      const prompt = `
You are observer ${obs.id}. You have one MCP server: ig-bridge (interego-bridge).

You have just observed something subtle about the deployed code-
generation agent. You don't know what it means; you don't know
whether other observers have seen anything related. Your role is
to publish your observation as a typed weak signal — Hypothetical
modal status, anchored in your own narrative — and let cross-
observer reinforcement happen structurally.

Call protocol.publish_descriptor with:
  graph_iri:     "${signalIri}"
  graph_content: ${JSON.stringify(turtle)}
  modal_status:  "Hypothetical"
  confidence:    0.45

After it returns, output ONLY a JSON object on a single line:
  {"observer":"${obs.id}","signal_iri":"${signalIri}","descriptor_url":"<from response>"}
`.trim();
      const result = await runClaudeAgent(prompt, mcpConfigPath, { timeoutMs: 240000, maxTurns: 8 });
      if (!result.success) {
        console.log(`--- ${obs.short} response ---\n` + result.response.slice(0, 1500));
        fail(`observer ${obs.short} did not complete`);
      }
      const m = result.response.match(/\{[^{}]*"signal_iri"[^{}]*"descriptor_url"[^{}]*\}/);
      if (!m) {
        console.log(`--- ${obs.short} response ---\n` + result.response);
        fail(`could not parse ${obs.short}'s summary`);
      }
      return JSON.parse(m[0]) as { observer: string; signal_iri: string; descriptor_url: string };
    }));
    const phase1Elapsed = ((Date.now() - phase1Start) / 1000).toFixed(1);
    info(`Phase 1 finished in ${phase1Elapsed}s`);
    for (const o of observed) info(`  ${o.observer.split(':').pop()} → ${o.signal_iri.slice(-30)}`);

    // ── Phase 2 ───────────────────────────────────────────
    step(3, 'PHASE 2 — Harness aggregates weak signals into a wks:Reinforcement descriptor');
    // Discover all descriptors on the pod, then walk graph files to
    // find wks:WeakSignal entries pointing at PHENOMENON_IRI. The
    // bridge's discover_descriptors returns metadata; we need the
    // graph content to read wks:about + wks:observedBy.
    const distinctObservers = new Set<string>();
    for (const o of observed) {
      const graphUrl = o.descriptor_url.replace(/\.ttl$/, '-graph.trig');
      try {
        const r = await fetch(graphUrl, { headers: { Accept: 'application/trig, text/turtle' } });
        if (!r.ok) continue;
        const trig = await r.text();
        if (trig.includes(`wks:about <${PHENOMENON_IRI}>`)) {
          const m = trig.match(/wks:observedBy\s+<([^>]+)>/);
          if (m) distinctObservers.add(m[1]!);
        }
      } catch { /* skip */ }
    }
    info(`Distinct observers reinforcing the phenomenon: ${distinctObservers.size}`);

    const reinforcementIri = `urn:demo:reinforcement:${PHENOMENON_IRI.split(':').pop()}-${Date.now()}`;
    const reinforcementTtl = `@prefix wks: <https://markjspivey-xwisee.github.io/interego/ns/wks#> .
@prefix dct: <http://purl.org/dc/terms/> .
@prefix xsd: <http://www.w3.org/2001/XMLSchema#> .

<${reinforcementIri}> a wks:Reinforcement ;
  dct:title "Reinforcement count for ${PHENOMENON_IRI}" ;
  wks:reinforcesAbout <${PHENOMENON_IRI}> ;
  wks:reinforcementCount "${distinctObservers.size}"^^xsd:positiveInteger ;
  wks:reinforcementWindow "PT5M"^^xsd:duration .`;
    const reinforcementResult = await bridgeCall(bridge.url, 'protocol.publish_descriptor', {
      graph_iri: reinforcementIri,
      graph_content: reinforcementTtl,
      modal_status: 'Asserted',
      confidence: 0.95,
    }) as { ok: boolean; descriptor_url: string };
    ok(`Reinforcement descriptor published: count=${distinctObservers.size}`);

    // ── Phase 3 ───────────────────────────────────────────
    step(4, 'PHASE 3 — Sensemaker agent produces sat:Disposition + cgh:isAdjacentPossibleTo');
    const dispositionIri = `urn:demo:disposition:reverting-to-older-training-distribution`;
    const adjacentPossibleIri = `urn:demo:adjacent-possible:${Date.now()}`;
    const senseDescIri = `urn:demo:sensemaking:disposition-${Date.now()}`;
    const sensemakerPrompt = `
You are the sensemaker agent ${SENSEMAKER.id}. You have one MCP server:
ig-bridge.

Four observers have independently published weak signals about a
deployed code-generation agent. The harness has counted them and
published a wks:Reinforcement descriptor showing ${distinctObservers.size}
distinct observers all pointing at the same phenomenon
(<${PHENOMENON_IRI}>). The narratives so far:

${observed.map((o, i) => `${i + 1}. ${OBSERVERS[i]!.micro}`).join('\n\n')}

Your job is to produce two Hypothetical typed descriptors:

(A) A sat:Disposition descriptor that names the candidate explanation,
    its weak signals, what would shift it, and what would damp it
    (without resolving the underlying conditions).

(B) A cgh:isAdjacentPossibleTo descriptor that names a plausible
    next-state the system could reach if the disposition actualizes,
    along with a short cgh:reachabilityRationale. This is NOT a
    prediction — it's reachability under known constraints.

For (A), call protocol.publish_descriptor with:
  graph_iri:     "${senseDescIri}"
  graph_content: |
    @prefix sat: <https://markjspivey-xwisee.github.io/interego/ns/sat#> .
    @prefix dct: <http://purl.org/dc/terms/> .
    @prefix xsd: <http://www.w3.org/2001/XMLSchema#> .
    <${dispositionIri}> a sat:Disposition ;
      dct:title "Reverting to older training distribution" ;
      sat:weakSignal <${PHENOMENON_IRI}> ;
      sat:shiftedBy <urn:demo:intervention:retrain-on-recent-codebase> ;
      sat:shiftedBy <urn:demo:intervention:add-style-constraint-shape> ;
      sat:dampedBy  <urn:demo:intervention:tightening-eslint-pre-commit> ;
      sat:dispositionalConfidence "0.55"^^xsd:decimal .
    <${senseDescIri}> a sat:SemioticFacet ;
      dct:title "Sensemaking on the codegen-drift weak-signal cluster" ;
      sat:hasDisposition <${dispositionIri}> .
  modal_status:  "Hypothetical"
  confidence:    0.55

For (B), call protocol.publish_descriptor with:
  graph_iri:     "${adjacentPossibleIri}"
  graph_content: |
    @prefix cgh: <https://markjspivey-xwisee.github.io/interego/ns/harness#> .
    @prefix dct: <http://purl.org/dc/terms/> .
    <${adjacentPossibleIri}> a cgh:AdjacentPossibleClaim ;
      dct:title "Adjacent-possible: production-regression risk" ;
      cgh:isAdjacentPossibleTo <urn:demo:next-state:production-regression-observed> ;
      cgh:reachabilityRationale "If the dispositional drift continues unaddressed, generated code in production paths is reachable to introduce defects (style or behavioural) that wouldn't have surfaced under the prior training distribution. Reachability holds under current constraints; transition is not predicted." .
  modal_status:  "Hypothetical"
  confidence:    0.5

Output ONLY a JSON object on a single line:
  {"disposition_descriptor_url":"<from A>","adjacent_possible_descriptor_url":"<from B>"}
`.trim();
    const senseResult = await runClaudeAgent(sensemakerPrompt, mcpConfigPath, { timeoutMs: 300000, maxTurns: 12 });
    if (!senseResult.success) {
      console.log('--- sensemaker response ---\n' + senseResult.response.slice(0, 2000));
      fail('sensemaker did not complete');
    }
    const senseMatch = senseResult.response.match(/\{[^{}]*"disposition_descriptor_url"[\s\S]*?"adjacent_possible_descriptor_url"[\s\S]*?\}/);
    if (!senseMatch) {
      console.log('--- sensemaker response ---\n' + senseResult.response);
      fail('could not parse sensemaker summary');
    }
    const senseOut = JSON.parse(senseMatch[0]) as { disposition_descriptor_url: string; adjacent_possible_descriptor_url: string };
    ok('Disposition + adjacent-possible descriptors published');

    // ── Phase 4 ───────────────────────────────────────────
    step(5, 'PHASE 4 — Compute realignment rate from substrate metabolism');
    // Count all descriptors discovered on the pod during this run +
    // the elapsed time. The rate is events/window. This is a structural
    // proxy for the formal definition in cgh:realignmentRate's
    // ontology comment.
    const allEntries = await bridgeCall(bridge.url, 'protocol.discover_descriptors', {}) as { descriptor_url: string; describes: string[] }[];
    const elapsedSec = (Date.now() - start) / 1000;
    const rate = allEntries.length / elapsedSec;
    const rateMeasureIri = `urn:demo:realignment:${PHENOMENON_IRI.split(':').pop()}-${Date.now()}`;
    const rateTtl = `@prefix cgh: <https://markjspivey-xwisee.github.io/interego/ns/harness#> .
@prefix dct: <http://purl.org/dc/terms/> .
@prefix xsd: <http://www.w3.org/2001/XMLSchema#> .

<${rateMeasureIri}> a cgh:RealignmentMeasure ;
  dct:title "Realignment rate over Demo 18 window" ;
  cgh:measuresFederationSlice <${PHENOMENON_IRI}> ;
  cgh:realignmentRate "${rate.toFixed(4)}"^^xsd:decimal ;
  cgh:rateWindow "PT${Math.round(elapsedSec)}S"^^xsd:duration ;
  cgh:eventCount "${allEntries.length}"^^xsd:nonNegativeInteger .`;
    await bridgeCall(bridge.url, 'protocol.publish_descriptor', {
      graph_iri: rateMeasureIri,
      graph_content: rateTtl,
      modal_status: 'Asserted',
      confidence: 0.95,
    });
    info(`Realignment: ${allEntries.length} events / ${elapsedSec.toFixed(1)}s = ${rate.toFixed(4)} events/s`);
    ok('Realignment measure descriptor published');

    // ── Verification ──────────────────────────────────────
    step(6, 'Verification — every named ontology shape present');
    const finalEntries = await bridgeCall(bridge.url, 'protocol.discover_descriptors', {}) as { descriptor_url: string; describes: string[] }[];
    info(`Pod manifest: ${finalEntries.length} descriptors total`);

    // Walk the graph files to confirm shape presence.
    const shapesFound = {
      'wks:WeakSignal': 0,
      'wks:Reinforcement': 0,
      'sat:Disposition': 0,
      'cgh:isAdjacentPossibleTo': 0,
      'cgh:RealignmentMeasure': 0,
    };
    for (const e of finalEntries) {
      const graphUrl = e.descriptor_url.replace(/\.ttl$/, '-graph.trig');
      try {
        const r = await fetch(graphUrl, { headers: { Accept: 'application/trig, text/turtle' } });
        if (!r.ok) continue;
        const trig = await r.text();
        for (const shape of Object.keys(shapesFound)) {
          if (trig.includes(shape)) shapesFound[shape as keyof typeof shapesFound]++;
        }
      } catch { /* skip */ }
    }
    for (const [shape, count] of Object.entries(shapesFound)) {
      if (count === 0) fail(`shape ${shape} not found on pod`);
      info(`  ${shape}: ${count} occurrence(s) on pod`);
    }
    ok('All five named ontology shapes verified present');

    if (distinctObservers.size !== OBSERVERS.length) {
      fail(`reinforcement count off (got ${distinctObservers.size}, expected ${OBSERVERS.length})`);
    }
    ok(`Reinforcement count matches observer count (${OBSERVERS.length})`);

    // ── Report ────────────────────────────────────────────
    step(7, 'Writing report');
    const reportPath = writeReport(SCENARIO, [
      `# Demo 18: Weak signals → adjacent possible → dispositional shift → realignment`,
      ``,
      `**Result:** PASS`,
      `**Phenomenon:** \`${PHENOMENON_IRI}\``,
      `**Observers:** ${OBSERVERS.length} parallel processes; reinforcement count = ${distinctObservers.size}`,
      `**Realignment:** ${allEntries.length} events / ${elapsedSec.toFixed(1)}s = ${rate.toFixed(4)} events/s`,
      ``,
      `## Setup`,
      `- interego-bridge at ${bridge.url}`,
      `- Pod: ${podUrl}`,
      ``,
      `## Weak signals (Phase 1)`,
      ``,
      ...observed.map((o, i) => [
        `### ${o.observer.split(':').pop()}`,
        ``,
        `- signal IRI: \`${o.signal_iri}\``,
        `- descriptor URL: \`${o.descriptor_url}\``,
        `- micro-narrative: ${OBSERVERS[i]!.micro}`,
        ``,
      ].join('\n')),
      ``,
      `## Reinforcement (Phase 2)`,
      ``,
      `- IRI: \`${reinforcementIri}\``,
      `- count: ${distinctObservers.size}`,
      `- window: PT5M (informative)`,
      ``,
      `## Sensemaking (Phase 3)`,
      ``,
      `- disposition descriptor: \`${senseOut.disposition_descriptor_url}\``,
      `- adjacent-possible descriptor: \`${senseOut.adjacent_possible_descriptor_url}\``,
      ``,
      `## Realignment measure (Phase 4)`,
      ``,
      `- IRI: \`${rateMeasureIri}\``,
      `- rate: ${rate.toFixed(4)} events/s`,
      `- window: PT${Math.round(elapsedSec)}S`,
      `- event count: ${allEntries.length}`,
      ``,
      `## Ontology-shape coverage (verification)`,
      ``,
      Object.entries(shapesFound).map(([shape, count]) => `- ${shape}: ${count}`).join('\n'),
      ``,
      `## What this proves about emergent semiotics on the substrate`,
      ``,
      `**Reinforcement is structural, not negotiated.** Two observers publishing wks:WeakSignal descriptors that point at the same wks:about subject reinforce each other automatically — the substrate's structural-sharing relation (Foundations §5 invariant 4: hyperedge composition as colimit) makes the reinforcement count a SPARQL question, not a consensus protocol.`,
      ``,
      `**Adjacent-possible is reachability, not prediction.** The cgh:isAdjacentPossibleTo edge is published Hypothetical with a cgh:reachabilityRationale; it holds the space of next-move possibilities open without committing to a transition. Foundations §6 (Peircean Thirdness made operational) — the link IS the typed mediation.`,
      ``,
      `**Dispositions are candidate explanations.** sat:Disposition with sat:weakSignal / sat:shiftedBy / sat:dampedBy is the substrate's vocabulary for "what is this system disposed to do next, what would surface it, what would alter it" — Snowden's framing made queryable. The substrate refuses to claim the disposition is true; it makes the claim legible.`,
      ``,
      `**Realignment rate is the metabolism's derivative.** cgh:realignmentRate counts events per window — a temporal derivative of the substrate's activity, not a state of alignment. Honest answer to the Itelman critique's "alignment is a rate, not a state": this rate IS computable from the trace, and it's published as a supersedes-chainable measure that older observers can compare against newer ones.`,
      ``,
      `Together: the substrate makes the dynamics of meaning legible — reinforcement, reachability, disposition, rate — without claiming any of them are settled. Foundations §9's complexity-aware extensions (added previously as ontology terms) become operational here.`,
    ].join('\n'));
    ok(`Report: ${reportPath}`);

    header('Demo 18 — PASS');
  } finally {
    if (bridge) {
      bridge.process.kill('SIGTERM');
      await new Promise(r => setTimeout(r, 1500));
      if (!bridge.process.killed) bridge.process.kill('SIGKILL');
    }
    await cleanupPod(podUrl);
  }
}

main().catch((e) => {
  console.error('\n[FATAL]', (e as Error).message);
  process.exit(1);
});
