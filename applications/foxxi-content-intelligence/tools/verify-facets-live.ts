/**
 * LIVE proof that the deployed foxxi-bridge now publishes interrogative-answerable
 * descriptors. A fresh ECDSA wallet records a real performance (DIRECT signed branch);
 * we fetch the PUBLISHED descriptor and route the ie: grammar over its actual bytes.
 *
 *   npx tsx applications/foxxi-content-intelligence/tools/verify-facets-live.ts
 */
import { ethers } from 'ethers';
import { routeInterrogatives, type InterrogativeType } from '@interego/pgsl';

const BRIDGE = process.env.FOXXI_BRIDGE_URL
  ?? 'https://interego-foxxi-bridge.livelysky-8b81abb0.eastus.azurecontainerapps.io';
const STD_EXT_IRI = 'https://markjspivey-xwisee.github.io/interego/applications/agentic-performance-practice/agp#StandardsExtension';
const enc = new TextEncoder();
const sha = (s: string): string => ethers.sha256(enc.encode(s)).slice(2);

async function signed(w: ethers.HDNodeWallet, args: Record<string, unknown>) {
  const payload = { ...args, agent_id: `did:ethr:${w.address.toLowerCase()}`, timestamp: new Date().toISOString() };
  const sp = JSON.stringify(payload);
  return { _signature: await w.signMessage(`sha256:${sha(sp)}`), _signed_payload: sp };
}

async function main(): Promise<void> {
  let pass = 0, fail = 0;
  const ok = (n: string, c: boolean, d = '') => { if (c) { pass++; console.log(`  ✓ ${n}${d ? ' — ' + d : ''}`); } else { fail++; console.log(`  ✗ ${n}${d ? ' — ' + d : ''}`); } };

  const W = ethers.Wallet.createRandom();
  console.log(`bridge=${BRIDGE}\nagent=did:ethr:${W.address.toLowerCase()}\n`);

  // 1) Record a real performance — composeIntoSharedLattice publishes the descriptor.
  const env = await signed(W, { task_name: 'Author a standards extension (facet-enrichment live proof)', success: true, quality: 0.92, activity_type: STD_EXT_IRI });
  const r = await fetch(`${BRIDGE}/agent/record-performance`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(env) });
  const body = await r.json() as any;
  ok('record-performance ok', r.status === 200 && body?.ok === true, `HTTP ${r.status}`);
  const descriptorUrl: string | undefined = body?.sharedLattice?.descriptorUrl;
  ok('response carries the published descriptorUrl', !!descriptorUrl, descriptorUrl ?? '(none)');
  if (!descriptorUrl) { console.log(`\nRESULT: ${pass} passed, ${fail} failed`); process.exit(1); }

  // 2) Fetch the PUBLISHED descriptor bytes.
  const dr = await fetch(descriptorUrl, { headers: { accept: 'text/turtle' } });
  const turtle = await dr.text();
  ok('descriptor fetched', dr.ok, `HTTP ${dr.status} · ${turtle.length} bytes`);
  ok('descriptor carries typed cg: facets', /cg:hasFacet \[ a cg:AgentFacet/.test(turtle) && /a cg:TemporalFacet/.test(turtle), '');
  ok('back-compat cg:Projection marker retained', /cg:hasFacetType cg:Projection/.test(turtle), '');

  // 3) Route the ie: grammar over the REAL published bytes.
  const route = (t: InterrogativeType) => {
    const res = routeInterrogatives({ turtle, interrogatives: [t], target: descriptorUrl });
    if (!res.ok) throw new Error(res.error);
    return res.answers[0]!;
  };
  const who = route('Who');
  const whoId = String((who.values as any)?.assertingAgent?.identity ?? '').toLowerCase();
  ok('Who = full + agent identity', who.status === 'full' && whoId.includes(W.address.toLowerCase()), `${who.status} · ${whoId}`);
  ok('When = full', route('When').status === 'full', `validFrom ${(route('When').values as any)?.validFrom}`);
  ok('WhatKind = full (xapi:Statement frame)', route('WhatKind').status === 'full', `${(route('WhatKind').values as any)?.interpretationFrame}`);
  ok('Why = partial', route('Why').status === 'partial', '');
  ok('Whether = partial + SelfAsserted (unsigned holon)', route('Whether').status === 'partial' && String((route('Whether').values as any)?.trustLevel ?? '').endsWith('SelfAsserted'), '');
  ok('What = pointer to pgsl_resolve', route('What').status === 'pointer' && route('What').nextStep?.tool === 'pgsl_resolve', '');

  console.log(`\nRESULT: ${pass} passed, ${fail} failed`);
  process.exit(fail === 0 ? 0 : 1);
}
main().catch(e => { console.error('verify-facets-live error:', e); process.exit(2); });
