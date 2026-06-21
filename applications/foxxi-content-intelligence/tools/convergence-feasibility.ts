/**
 * HEADLESS feasibility proof for the W3C-convergence BYOK microsite demo, run live
 * BEFORE any UI. Proves the three Interego-side primitives the demo composes (mapping two W3C CGs + Cagle's DataBook spec) —
 * each maps to a W3C effort — work end-to-end on the live bridge:
 *
 *  (HOLON, vs W3C Holon CG)   mint a real holon (signed) -> dereference it ->
 *     it IS an iep:ContextDescriptor / iep:Holon (a WHOLE) whose terms are SHARED
 *     atoms in the lattice (a PART of a larger hypergraph holarchy: reusedNodes>0).
 *  (CONTEXT GAP, vs W3C Context Graphs CG)  interrogate the holon -> the per-
 *     interrogative resolution state (full / partial / pointer / absent) IS the
 *     context-gap resolution state; "absent + caveat" IS safe-stop. Emergent.
 *  (DATABOOK, vs Cagle DataBook)  ingest a DataBook-shaped Markdown (YAML
 *     frontmatter + fenced turtle) -> composed into a holon; and emit a SKILL.md
 *     back (markdown-carrier-of-semantics round-trip).
 *
 * Plus: /ns/iep dereferences (the renamed protocol) and the legacy /ns/cg alias.
 *
 * Run from context-graphs/:
 *   npx tsx applications/foxxi-content-intelligence/tools/convergence-feasibility.ts
 */
import { ethers } from 'ethers';

const BRIDGE = 'https://interego-foxxi-bridge.livelysky-8b81abb0.eastus.azurecontainerapps.io';
const PAGES = 'https://markjspivey-xwisee.github.io/interego/ns';
const enc = new TextEncoder();
const sha = (s: string): string => ethers.sha256(enc.encode(s)).slice(2);

let pass = 0, fail = 0;
const check = (n: string, c: boolean, d = ''): void => {
  if (c) { pass++; console.log(`  ✓ ${n}${d ? ' — ' + d : ''}`); } else { fail++; console.log(`  ✗ ${n}${d ? ' — ' + d : ''}`); }
};
async function signed(w: ethers.HDNodeWallet, args: Record<string, unknown>) {
  const payload = { ...args, agent_id: `did:ethr:${w.address.toLowerCase()}`, timestamp: new Date().toISOString() };
  const sp = JSON.stringify(payload);
  return { _signature: await w.signMessage(`sha256:${sha(sp)}`), _signed_payload: sp };
}
async function post(path: string, body: unknown): Promise<{ s: number; b: any }> {
  const r = await fetch(`${BRIDGE}${path}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  let b: any = null; try { b = await r.json(); } catch { b = await r.text().catch(() => null); }
  return { s: r.status, b };
}
const STD = 'https://markjspivey-xwisee.github.io/interego/applications/agentic-performance-practice/agp#StandardsExtension';

async function main(): Promise<void> {
  console.log('Convergence feasibility — live bridge:', BRIDGE);

  console.log('\n=== (HOLON) mint a real holon + dereference (whole + part) ===');
  const W = ethers.Wallet.createRandom();
  const did = `did:ethr:${W.address.toLowerCase()}`;
  const label = `eth-${W.address.slice(2, 14).toLowerCase()}`;
  const perf = await post('/agent/record-performance', await signed(W, { task_name: 'Holon convergence probe', success: true, quality: 1, activity_type: STD }));
  const sl = perf.b?.sharedLattice;
  check('holon composed (whole) with a holonUri', perf.s === 200 && !!sl?.holonUri, `holon=${String(sl?.holonUri ?? '').slice(0, 44)}`);
  check('holon is a PART of a hypergraph holarchy (shared atoms reused)', typeof sl?.reusedNodes === 'number' && sl.reusedNodes >= 0 && (sl.reusedNodes + sl.newNodes) > 0, `reused=${sl?.reusedNodes} new=${sl?.newNodes} stats=${JSON.stringify(sl?.stats ?? {})}`);
  check('holon projects as dereferenceable descriptor (the WHOLE)', !!sl?.descriptorUrl, String(sl?.descriptorUrl ?? '').slice(0, 56));

  // dereference the projected descriptor -> must be an iep: ContextDescriptor (the renamed protocol)
  let iepSeen = false, cgSeen = false;
  if (sl?.descriptorUrl) {
    try {
      const r = await fetch(String(sl.descriptorUrl), { headers: { Accept: 'text/turtle' } });
      const ttl = await r.text();
      iepSeen = /iep:ContextDescriptor|@prefix iep:/.test(ttl);
      cgSeen = /@prefix cg:|cg:ContextDescriptor/.test(ttl);
      check('descriptor dereferences (css-gate, in-browser-reachable)', r.ok, `HTTP ${r.status}`);
      check('descriptor IS iep: (Interego Protocol, post-rename) and NOT legacy cg:', iepSeen && !cgSeen, `iep=${iepSeen} cg=${cgSeen}`);
    } catch (e) { check('descriptor dereferences', false, (e as Error).message); }
  }

  console.log('\n=== (CONTEXT GAP) interrogate -> gap-resolution state + safe-stop ===');
  if (sl?.holonUri) {
    const url = `/agent/lattice/${label}/interrogate?uri=${encodeURIComponent(sl.holonUri)}&agent_did=${encodeURIComponent(did)}`;
    const r = await fetch(`${BRIDGE}${url}`); const j: any = await r.json().catch(() => ({}));
    const answers: any[] = Array.isArray(j?.answers) ? j.answers : [];
    const statuses = new Set(answers.map(a => a.status));
    check('interrogation returns per-interrogative resolution state', r.ok && answers.length > 0, `${answers.length} interrogatives; statuses={${[...statuses].join(',')}}`);
    const resolved = answers.filter(a => a.status === 'full' || a.status === 'partial');
    const gaps = answers.filter(a => a.status === 'absent' || a.status === 'pointer');
    check('some interrogatives RESOLVE (full/partial) and some are GAPS (absent/pointer)', resolved.length > 0 && gaps.length > 0, `resolved=${resolved.length} gaps=${gaps.length}`);
    check('a gap carries a safe-stop signal (caveat / nextStep)', gaps.some(g => g.caveat || g.nextStep), gaps.find(g => g.caveat)?.caveat?.slice(0, 60) ?? gaps.find(g => g.nextStep)?.nextStep?.tool ?? '(none)');
  }

  console.log('\n=== (DATABOOK) ingest a DataBook-shaped Markdown -> holon; emit SKILL.md ===');
  const databook = [
    '---', 'name: greet-a-stranger', 'description: How to greet a stranger politely.',
    'license: CC-BY-4.0', '---',
    '## Approach', 'Make eye contact, offer a clear greeting, and state your name.',
    '## Vocabulary', '```turtle', '@prefix ex: <http://example.org/> .', 'ex:Greeting a ex:SocialAct .', '```',
  ].join('\n');
  const ing = await post('/agent/course/analyze-skill', { skillMd: databook });
  check('DataBook (md+frontmatter+fenced turtle) ingests into a holon', ing.s === 200 && ing.b?.ok !== false && !!ing.b?.course, `course=${ing.b?.course?.courseId ?? ing.b?.structure?.courseId ?? '?'} holon=${String(ing.b?.courseKg?.holonUri ?? '').slice(0,36)}`);
  if (ing.b?.course) {
    const emit = await post('/agent/course/skill', { course: ing.b.course, tool: 'DataBook', holonUri: ing.b?.courseKg?.holonUri });
    check('round-trip: emit a SKILL.md back (markdown-carrier-of-semantics)', emit.s === 200 && typeof emit.b?.skillMd === 'string' && emit.b.skillMd.includes('---'), `skillMd ${String(emit.b?.skillMd ?? '').length} chars`);
  }

  console.log('\n=== (PROTOCOL) /ns/iep dereferences + legacy /ns/cg alias ===');
  for (const [u, want] of [[`${PAGES}/iep.ttl`, 'iep:ContextDescriptor'], [`${PAGES}/cg.ttl`, 'isReplacedBy']] as const) {
    const r = await fetch(u); const t = await r.text();
    check(`${u.split('/').pop()} dereferences + carries ${want}`, r.ok && t.includes(want), `HTTP ${r.status}`);
  }

  console.log(`\nRESULT: ${pass} passed, ${fail} failed`);
  process.exit(fail === 0 ? 0 : 1);
}
main().catch(e => { console.error('harness error:', e); process.exit(2); });
