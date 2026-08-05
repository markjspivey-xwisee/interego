#!/usr/bin/env tsx
/**
 * The transplant fixture: records from a DIFFERENT practice, on a different pod, under a
 * different key, in a different shape — carrying the same two protocol triples.
 *
 * ★ WHY THIS EXISTS. The one sentence a reviewer will reach for is "your observer is the
 * integration you claim doesn't exist, renamed". The answer that is not an argument is this:
 * point the same binary, with the same published observation map, at these records — which
 * are not workspace entries, were not produced by the workspace's writer, and name a term
 * from the agentic-performance practice — and a second, differently-named performance record
 * appears with no edit and no rebuild. An observer holding an integration cannot do that.
 *
 * These are deliberately NOT the other program's record shape. They carry no wsp:seq, no
 * chain, no membership — nothing but a description, a term, and an outcome. If the observer
 * needed any of the rest, it would be reading a vertical.
 *
 * Usage:
 *   IEP_BEARER_OPERATOR=<tok> npx tsx tools/publish-transplant-records-live.ts
 */

/* eslint-disable no-console */

const RELAY = process.env.IEP_RELAY ?? 'https://relay.interego.xwisee.com';
const BEARER = process.env.IEP_BEARER_OPERATOR;
if (!BEARER) { console.error('IEP_BEARER_OPERATOR is required.'); process.exit(2); }

const POD_SEGMENT = 'u-eth-fd6398a1b1df';
const NS = `${RELAY}/ns/${POD_SEGMENT}/`;
const OPERATOR_DID = 'did:web:identity.interego.xwisee.com:agents:agp-operator-u-eth-fd6398a1b1df';

const AGP = 'https://markjspivey-xwisee.github.io/interego/applications/agentic-performance-practice/agp#';
const IEP = 'https://markjspivey-xwisee.github.io/interego/ns/iep#';
/** A real, published class of that practice — not a term minted for this run. */
const TERM = `${AGP}Diagnosis`;

const RECORDS: readonly { readonly slug: string; readonly body: string; readonly success: boolean }[] = [
  {
    slug: 'agp-diagnosis-checkout-latency',
    body: 'Read the checkout-latency situation as Knowable and ran a six-factor cause model: the cause was instrumentation, not knowledge, so no instruction was warranted and none was proposed.',
    success: true,
  },
  {
    slug: 'agp-diagnosis-support-backlog',
    body: 'Read the weekend support backlog as Emergent and ran a dispositional read with three probes rather than a gap analysis; two probes were dampened, one amplified.',
    success: true,
  },
  {
    slug: 'agp-diagnosis-partner-onboarding',
    body: 'Read partner onboarding as Knowable and proposed instruction; the follow-up evaluation showed the constraint was an incentive one, so the regime call was wrong.',
    success: false,
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
  console.log(`term:               ${TERM}\n`);
  for (const rec of RECORDS) {
    const iri = `${NS}${rec.slug}`;
    const content = `@prefix agp: <${AGP}> .
@prefix iep: <${IEP}> .
@prefix dct: <http://purl.org/dc/terms/> .
@prefix xsd: <http://www.w3.org/2001/XMLSchema#> .

<${iri}>
    a agp:Diagnosis ;
    dct:creator <${OPERATOR_DID}> ;
    dct:description "${rec.body.replace(/"/g, '\\"')}" ;
    dct:conformsTo <${TERM}> ;
    iep:success "${rec.success ? 'true' : 'false'}"^^xsd:boolean .
`;
    const res = await call('publish_context', {
      graph_iri: iri, graph_content: content, visibility: 'public',
      auto_supersede_prior: true, sign_authorship: true, agent_did: OPERATOR_DID,
    });
    if (res['error'] !== undefined) {
      console.error(`  FAIL ${iri}: ${JSON.stringify(res).slice(0, 400)}`);
      process.exit(1);
    }
    console.log(`  ok   ${iri} (${rec.success ? 'succeeded' : 'FAILED'})`);
    console.log(`       ${String(res['descriptorUrl'] ?? '')}`);
  }
  console.log('\nthree records published. Point the observer at this pod with the SAME map.');
}

main().catch(e => { console.error(e); process.exit(1); });
