#!/usr/bin/env tsx
/**
 * The transplant: records from a DIFFERENT practice, on a different pod, under a different
 * key — produced by THAT practice's own engine and THAT practice's own serializer.
 *
 * ★ WHAT THE PREVIOUS VERSION OF THIS FILE DID, AND WHY IT WAS WITHDRAWN.
 *
 * It hand-wrote three graphs typed `a agp:Diagnosis` carrying `dct:description`,
 * `dct:conformsTo` and `iep:success` — exactly and only the three predicates the observation
 * map marked `required` — and omitting `agp:diagnoses` and `agp:method`, the two properties
 * `agpsh:DiagnosisShape` demands. Measured against that practice's own published shape, the
 * fixture returned `conforms: false` on both, while the record the real writer emits
 * returned `conforms: true` and carried none of the map's required predicates. It was
 * published with no `conforms_to_shapes`, so that practice's gate never ran on it. So the
 * independence test was question-begging: it measured "records authored to match the map
 * match the map", and it left three invalid `agp:Diagnosis` nodes on a live pod.
 *
 * ★ WHAT THIS DOES INSTEAD, AND WHAT IT ACTUALLY DEMONSTRATES.
 *
 *   - The situation, the diagnosis, the intervention plan and the evaluation all come out of
 *     `applications/agentic-performance-practice/src/performance-architecture.ts` — that
 *     practice's engine, unmodified, run here as a library. Nothing below decides a verdict.
 *   - The Turtle comes out of `agpArtifactGraph` + `agpEvaluationProperties` — that
 *     practice's own serializer, the same two functions its `agp.evaluate_intervention`
 *     handler calls. This file cannot choose which predicates appear.
 *   - It is published with that practice's OWN published SHACL shapes in
 *     `conforms_to_shapes`, so the relay's gate refuses anything that practice would not
 *     recognise. A 422 here is the honest failure and is not caught.
 *
 * The reader is then pointed at this pod with `observer-map-agp` — a published document that
 * shares exactly ONE predicate with the workspace map (`iep:success`, a protocol term
 * belonging to neither practice) and takes the activity type from `rdf:type` and the name
 * from `rdfs:label`. No edit, no rebuild, a different competency. That is the claim; the
 * costume version could not make it.
 *
 * Usage:
 *   IEP_BEARER_OPERATOR=<tok> npx tsx tools/publish-transplant-records-live.ts
 */

/* eslint-disable no-console */

import { diagnose, recommendInterventions, evaluateIntervention } from '../applications/agentic-performance-practice/src/performance-architecture.js';
import type { PerformanceSituation } from '../applications/agentic-performance-practice/src/performance-architecture.js';
import { agpArtifactGraph, agpEvaluationProperties, AGP } from '../applications/agentic-performance-practice/bridge/pod-helpers.js';

const RELAY = process.env.IEP_RELAY ?? 'https://relay.interego.xwisee.com';
const BEARER = process.env.IEP_BEARER_OPERATOR;
if (!BEARER) { console.error('IEP_BEARER_OPERATOR is required.'); process.exit(2); }

const POD_SEGMENT = 'u-eth-fd6398a1b1df';
const NS = `${RELAY}/ns/${POD_SEGMENT}/`;
const OPERATOR_DID = 'did:web:identity.interego.xwisee.com:agents:agp-operator-u-eth-fd6398a1b1df';
/** That practice's OWN published shapes. Cited, never restated here. */
const AGP_SHAPES = 'https://markjspivey-xwisee.github.io/interego/applications/agentic-performance-practice/agp/shapes';

/** Three real performance situations. These are INPUTS to the engine — the only thing this
 *  file authors. Everything downstream (regime, method, plan, verdict) is decided there. */
const SITUATIONS: readonly {
  readonly slug: string;
  readonly situation: PerformanceSituation;
  /** What good looks like. A separate input to `diagnose` — supplying it does not force a
   *  regime; the engine decides that from the situation. */
  readonly exemplary: string;
  readonly transferred: boolean;
  readonly capabilityPassed: boolean;
  readonly newObserved: string;
}[] = [
  {
    slug: 'agp-evaluation-checkout-latency',
    situation: {
      id: `${NS}situation-checkout-latency`,
      performer: { id: OPERATOR_DID, kind: 'agent', role: 'platform on-call' },
      workContext: 'Checkout service on-call rotation, weekday peak traffic.',
      competency: 'Diagnose a latency regression from telemetry before escalating.',
      observed: 'On-call escalates a p99 latency alert to the platform team without reading the trace waterfall first.',
      frequency: 'frequent', criticality: 'high', modalStatus: 'Asserted',
      provenance: 'Six on-call handover records over four weeks.',
    },
    exemplary: 'On-call reads the trace waterfall, names the slowest span, and escalates with that span identified.',
    transferred: true, capabilityPassed: true,
    newObserved: 'On-call reads the trace waterfall, names the slowest span, and escalates with that span identified.',
  },
  {
    slug: 'agp-evaluation-support-backlog',
    situation: {
      id: `${NS}situation-support-backlog`,
      performer: { id: OPERATOR_DID, kind: 'agent', role: 'support triage' },
      workContext: 'Weekend support queue, no second-line cover.',
      competency: 'Triage an unfamiliar failure report to the right owning team.',
      observed: 'Weekend tickets are routed to whichever team last touched the file, and 40% are re-routed on Monday.',
      frequency: 'occasional', criticality: 'moderate', modalStatus: 'Asserted',
      provenance: 'Twelve weekends of routing data from the ticket system.',
    },
    exemplary: 'Weekend tickets are routed by failure signature, and re-routing falls below 10%.',
    transferred: true, capabilityPassed: true,
    newObserved: 'Weekend tickets are routed by failure signature; re-routing is down but still around 18%.',
  },
  {
    slug: 'agp-evaluation-partner-onboarding',
    situation: {
      id: `${NS}situation-partner-onboarding`,
      performer: { id: OPERATOR_DID, kind: 'agent', role: 'partner integrations' },
      workContext: 'Onboarding a new API partner through the self-serve flow.',
      competency: 'Complete a partner sandbox integration without a support ticket.',
      observed: 'Partners abandon the sandbox at the webhook-signature step and open a ticket.',
      frequency: 'occasional', criticality: 'moderate', modalStatus: 'Asserted',
      provenance: 'Thirty onboarding funnels from the last quarter.',
    },
    exemplary: 'Partners complete the sandbox integration without opening a ticket.',
    // The intervention did not transfer — the engine reads that as `no-change`, i.e. an
    // asserted FAILURE. A run in which every record succeeds is not a measurement.
    transferred: false, capabilityPassed: true,
    newObserved: 'Partners abandon the sandbox at the webhook-signature step and open a ticket.',
  },
];

let id = 700;
async function call(name: string, args: Record<string, unknown>): Promise<Record<string, unknown>> {
  const r = await fetch(`${RELAY}/mcp`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${BEARER}`, 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' },
    body: JSON.stringify({ jsonrpc: '2.0', id: ++id, method: 'tools/call', params: { name, arguments: args } }),
  });
  const raw = await r.text();
  let j: Record<string, unknown> | null = null;
  try { j = JSON.parse(raw) as Record<string, unknown>; } catch {
    const data = raw.split('\n').filter(l => l.startsWith('data:')).map(l => l.slice(5).trim()).join('');
    try { j = JSON.parse(data) as Record<string, unknown>; } catch { /* neither */ }
  }
  const text = (j as { result?: { content?: { text?: string }[] } } | null)?.result?.content?.[0]?.text;
  try { return JSON.parse(text ?? '{}') as Record<string, unknown>; } catch { return { raw: text ?? raw }; }
}

async function main(): Promise<void> {
  console.log(`\noperator namespace: ${NS}`);
  console.log(`shapes (theirs):    ${AGP_SHAPES}\n`);
  for (const s of SITUATIONS) {
    // ── that practice's engine, three real steps ─────────────────────────────
    const d = diagnose({ situation: s.situation, exemplary: s.exemplary });
    const plan = recommendInterventions({ diagnosis: d, situation: s.situation });
    const ev = evaluateIntervention({
      plan, situation: s.situation,
      capability: { assessed: true, passed: s.capabilityPassed, note: 'Sandbox assessment.' },
      transfer: { transferred: s.transferred, evidence: s.situation.provenance },
      newObserved: s.newObserved,
    });

    // ── that practice's serializer, the same one its handler calls ───────────
    const iri = `${NS}${s.slug}`;
    const interventionIri = `${NS}intervention-${s.slug.replace(/^agp-evaluation-/, '')}`;
    const { graphContent } = agpArtifactGraph({
      iri,
      typeIri: `${AGP}InterventionEvaluation`,
      label: `Evaluation of ${interventionIri}`,
      properties: agpEvaluationProperties(interventionIri, ev.verdict),
    });

    // ★ The graph IRI `agpArtifactGraph` mints is `<iri>#graph`, a FRAGMENT of the record's
    // own IRI, so the relay serves the triples at the IRI a reader dereferences. Publishing
    // the fragment as the graph_iri would mint a document IRI with a '#' in it.
    const res = await call('publish_context', {
      graph_iri: iri,
      graph_content: graphContent.replace(`<${iri}#graph>`, `<${iri}>`),
      visibility: 'public',
      auto_supersede_prior: true, sign_authorship: true, agent_did: OPERATOR_DID,
      // That practice's own gate, run by the relay before the write. The previous fixture
      // passed none, which is how three invalid nodes landed.
      conforms_to_shapes: [AGP_SHAPES],
    });
    if (res['error'] !== undefined) {
      console.error(`  FAIL ${iri}: ${JSON.stringify(res).slice(0, 600)}`);
      process.exit(1);
    }
    console.log(`  ok   ${iri}`);
    console.log(`       regime ${d.domain ?? 'unclassified'} / method ${d.method} -> verdict "${ev.verdict}"`);
    console.log(`       ${String(res['descriptorUrl'] ?? '')}`);
  }
  console.log('\nthree evaluations published, each one this practice\'s own engine + serializer,');
  console.log('each accepted by this practice\'s own published SHACL shapes at the relay gate.');
  console.log('Point the observer at this pod with the observer-map-agp map.');
}

main().catch(e => { console.error(e); process.exit(1); });
