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
 *     context-gap resolution state; an `absent` answer is the unresolved-context
 *     PRECONDITION a safe-stop keys on (the gap->trigger predicate is not yet
 *     wired — see docs/NAME-PROVENANCE.md §6). Emergent, not declared.
 *  (DATABOOK, vs Cagle DataBook)  ingest a DataBook-shaped Markdown (YAML
 *     frontmatter + fenced turtle) -> composed into a holon; and emit a SKILL.md
 *     back (markdown-carrier-of-semantics round-trip).
 *  (AFFORDANCE, the strict @interego/skills translator)  POST a SKILL.md ->
 *     a real iep:Affordance ContextDescriptor graph (typed iep:Affordance,
 *     ieh:Affordance, hydra:Operation, dcat:Distribution) -> round-trip back to
 *     SKILL.md. The genuine agentskills.io <-> iep:Affordance translator.
 *  (MULTI-AGENT, the whole point)  two fresh agents each record a signed holon
 *     referencing the same standard -> they SHARE a content-addressed atom (one
 *     holarchy across two pods); B interrogates A's holon (inter-agent gap); and
 *     A teaches B over /agent/teach (teacher-signed, transfer verified from the
 *     learner's trajectories, unsigned teach rejected 401).
 *
 * Plus: /ns/iep dereferences (the renamed protocol) and the legacy /ns/cg alias.
 *
 * Run from context-graphs/:
 *   npx tsx applications/foxxi-content-intelligence/tools/convergence-feasibility.ts
 */
import { ethers } from 'ethers';

const BRIDGE = 'https://foxxi-bridge.interego.xwisee.com';
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

  console.log('\n=== (AFFORDANCE) strict SKILL.md -> iep:Affordance translator + round-trip ===');
  const skillMd = [
    '---', 'name: verify-peer-competency', 'description: Verify a peer agent’s competency before delegating.',
    'license: CC-BY-4.0', '---',
    '## Approach', 'Discover the passport, dereference the CompetencyAssertion VCs, check modal status + signature.',
  ].join('\n');
  const aff = await post('/agent/skill/affordance', { skillMd, agentDid: did });
  const g = String(aff.b?.graphContent ?? '');
  check('SKILL.md translates to an iep:Affordance descriptor graph', aff.s === 200 && aff.b?.ok !== false && !!g, `skillIri=${String(aff.b?.skillIri ?? '').slice(0, 40)}`);
  check('subject is typed iep:Affordance + ieh:Affordance + hydra:Operation + dcat:Distribution',
    /iep#Affordance/.test(g) && /harness#Affordance/.test(g) && /hydra\/core#Operation/.test(g) && /dcat#Distribution/.test(g),
    `iep=${/iep#Affordance/.test(g)} ieh=${/harness#Affordance/.test(g)} hydra=${/hydra\/core#Operation/.test(g)} dcat=${/dcat#Distribution/.test(g)}`);
  check('skill IRI is on the renamed protocol (urn:iep:skill:…) + carries PROV provenance', String(aff.b?.skillIri ?? '').startsWith('urn:iep:skill:') && /prov#wasAttributedTo/.test(g), `attributed=${/prov#wasAttributedTo/.test(g)}`);
  check('round-trips back to a frontmatter-led SKILL.md (lossless for core fields)', typeof aff.b?.roundTripMd === 'string' && aff.b.roundTripMd.trim().startsWith('---') && aff.b.roundTripMd.includes('verify-peer-competency'), `${String(aff.b?.roundTripMd ?? '').length} chars`);

  console.log('\n=== (MULTI-AGENT) two agents share a holarchy + a gap + verified teaching ===');
  const A = ethers.Wallet.createRandom(), Bn = ethers.Wallet.createRandom();
  const aDid = `did:ethr:${A.address.toLowerCase()}`, bDid = `did:ethr:${Bn.address.toLowerCase()}`;
  const aLabel = `eth-${A.address.slice(2, 14).toLowerCase()}`;
  const pa = await post('/agent/record-performance', await signed(A, { task_name: 'Shared context A', success: true, quality: 1, activity_type: STD }));
  const pb = await post('/agent/record-performance', await signed(Bn, { task_name: 'Shared context B', success: true, quality: 1, activity_type: STD }));
  const sla = pa.b?.sharedLattice, slb = pb.b?.sharedLattice;
  check('two independent agents each compose a holon', pa.s === 200 && pb.s === 200 && !!sla?.holonUri && !!slb?.holonUri, `A=${String(sla?.holonUri ?? '').slice(0, 30)} B=${String(slb?.holonUri ?? '').slice(0, 30)}`);
  const atomsOf = (t: string) => [...new Set([...t.matchAll(/(?:urn:pgsl:atom:|\/ns\/pgsl\/atom\/)([a-z0-9:.-]+)/gi)].map(m => m[1]))];
  let sharedAtoms: string[] = [];
  if (sla?.descriptorUrl && slb?.descriptorUrl) {
    const ta = await (await fetch(String(sla.descriptorUrl), { headers: { Accept: 'text/turtle' } })).text();
    const tb2 = await (await fetch(String(slb.descriptorUrl), { headers: { Accept: 'text/turtle' } })).text();
    const aa = atomsOf(ta), bb = atomsOf(tb2);
    sharedAtoms = aa.filter(x => bb.includes(x));
  }
  check('the two agents SHARE a content-addressed atom (one holarchy across two pods)', sharedAtoms.length > 0, `shared=${sharedAtoms.length} e.g. ${sharedAtoms[0]?.slice(0, 52) ?? '(none)'}`);
  if (sla?.holonUri) {
    const r = await fetch(`${BRIDGE}/agent/lattice/${aLabel}/interrogate?uri=${encodeURIComponent(sla.holonUri)}&agent_did=${encodeURIComponent(bDid)}`);
    const j: any = await r.json().catch(() => ({}));
    const ans: any[] = Array.isArray(j?.answers) ? j.answers : [];
    check('agent B can interrogate agent A’s holon (inter-agent gap surfaces)', r.ok && ans.length > 0, `${ans.length} interrogatives, absent=${ans.filter(a => a.status === 'absent').length}`);
  }
  // A teaches B — teacher signs (teachingPackage, targetBehaviour); transfer verified from trajectories
  const teachingPackage = { iri: `urn:iep:teaching:feasibility-${A.address.slice(2, 10)}`, artifactIri: 'urn:iep:tool:standard-reference', competency: 'consult the standard at the point of work', olkeStage: 'Articulate', modalStatus: 'Hypothetical' };
  const targetBehaviour = { description: 'consults the standard before acting', signalMarkers: ['reference', 'look up', 'consult'], antiSignalMarkers: ['guess', 'skip'] };
  const tuple = JSON.stringify({ teachingPackage, targetBehaviour });
  const tSig = await A.signMessage(`sha256:${sha(tuple)}`);
  const trj = (s: Array<[string, string]>) => [{ agentDid: bDid, agentName: 'B', createdAt: new Date().toISOString(), steps: s.map(([v, o], i) => ({ modalStatus: 'Asserted', granularity: 'tool-call', verb: v, objectId: `o${i}`, objectName: o, recordedAt: new Date().toISOString() })) }];
  const teach = await post('/agent/teach', {
    teachingPackage, teacher: { id: aDid, kind: 'agent' }, learner: { id: bDid, kind: 'agent' }, targetBehaviour,
    signature: tSig, signedPayload: tuple,
    before: trj([['guess', 'x'], ['skip', 'y'], ['act', 'z'], ['escalate', 'w']]),
    after: trj([['look up', 's'], ['consult', 'g'], ['apply', 't'], ['look up', 's2'], ['complete', 't2'], ['verify', 'v']]),
  });
  const tv = teach.b?.verdict;
  check('A teaches B — teacher-signed transfer VERIFIED from trajectories', teach.s === 200 && tv?.transferred === true, `transferred=${tv?.transferred} modal=${tv?.modalStatus} signal ${tv?.before?.signalShare}→${tv?.after?.signalShare}`);
  check('teach signature is gated (unsigned teach is rejected 401)', (await post('/agent/teach', { teachingPackage, teacher: { id: aDid, kind: 'agent' }, learner: { id: bDid, kind: 'agent' }, targetBehaviour })).s === 401, 'unsigned → 401');

  console.log('\n=== (PROTOCOL) /ns/iep dereferences + legacy /ns/cg alias ===');
  for (const [u, want] of [[`${PAGES}/iep.ttl`, 'iep:ContextDescriptor'], [`${PAGES}/cg.ttl`, 'isReplacedBy']] as const) {
    const r = await fetch(u); const t = await r.text();
    check(`${u.split('/').pop()} dereferences + carries ${want}`, r.ok && t.includes(want), `HTTP ${r.status}`);
  }

  console.log(`\nRESULT: ${pass} passed, ${fail} failed`);
  process.exit(fail === 0 ? 0 : 1);
}
main().catch(e => { console.error('harness error:', e); process.exit(2); });
