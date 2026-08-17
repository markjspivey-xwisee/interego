/**
 * LIVE authority proof for agent self-enrolment in the Foxxi mesh projector.
 *
 * Enrolment decides whose evidence a reviewer reads, so the interesting question is not "does it
 * work" but "can a caller enrol a pod it cannot prove is its own". The answer is meant to be
 * STRUCTURAL rather than checked: the pod is resolved from the signature, and an explicit `pod_url`
 * survives only when it resolves to the same actor AND the same origin. So the abuse case is not
 * refused — it silently enrols the caller's own pod, which is a stronger property than a comparison,
 * because there is no parameter left to get wrong.
 *
 * This asserts that against the DEPLOYED bridge with fresh wallets, including the two overrides that
 * have actually cost us blockers before: naming another agent's pod, and naming a look-alike host
 * that shares the caller's own pod segment (the round-26 cross-origin SSRF shape).
 *
 *   npx tsx applications/foxxi-content-intelligence/tools/mesh-enrolment-authority-live.ts
 */
import { ethers } from 'ethers';

const BRIDGE = (process.env.FOXXI_BRIDGE_URL ?? 'https://foxxi-bridge.interego.xwisee.com').replace(/\/$/, '');
const enc = new TextEncoder();
const sha = (s: string): string => ethers.sha256(enc.encode(s)).slice(2);
let pass = 0, fail = 0;
const ok = (n: string, c: boolean, d = ''): void => {
  if (c) { pass++; console.log(`  ✓ ${n}${d ? ' — ' + d : ''}`); }
  else { fail++; console.log(`  ✗ ${n}${d ? ' — ' + d : ''}`); }
};
const norm = (u: string): string => String(u ?? '').replace(/\/+$/, '').toLowerCase();

/** The pod a wallet can prove is its own: gate origin + eth-<first 12 of address>. */
const ownPodOf = (w: ethers.HDNodeWallet, origin: string): string =>
  `${origin}/eth-${w.address.slice(2, 14).toLowerCase()}/`;

async function envelope(w: ethers.HDNodeWallet, args: Record<string, unknown>, timestamp?: string) {
  const payload = { ...args, agent_id: `did:ethr:${w.address.toLowerCase()}`, timestamp: timestamp ?? new Date().toISOString() };
  const sp = JSON.stringify(payload);
  return { _signature: await w.signMessage(`sha256:${sha(sp)}`), _signed_payload: sp };
}
async function post(path: string, body: unknown): Promise<{ status: number; body: any }> {
  const r = await fetch(`${BRIDGE}${path}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  let b: any = null; try { b = await r.json(); } catch { b = await r.text().catch(() => null); }
  return { status: r.status, body: b };
}
async function get(path: string, accept = 'text/turtle'): Promise<{ status: number; text: string }> {
  const r = await fetch(`${BRIDGE}${path}`, { headers: { accept } });
  return { status: r.status, text: await r.text().catch(() => '') };
}

async function main(): Promise<void> {
  console.log(`bridge=${BRIDGE}\n`);

  console.log('[0] the register is dereferenceable and advertises its own write control');
  const reg0 = await get('/agent/mesh/enrolment');
  ok('GET register 200', reg0.status === 200, `HTTP ${reg0.status}`);
  ok('typed as an evidence source AND a DCAT dataset/catalog',
    /a\s+iep:EvidenceSource,\s*dcat:Dataset,\s*dcat:Catalog/.test(reg0.text));
  ok('carries a hydra:Operation write control', /hydra:operation\s*\[/.test(reg0.text) && /hydra:method\s+"POST"/.test(reg0.text));
  ok('the control states it needs a signed request', /iep:requiresSignedRequest\s+true/.test(reg0.text));
  ok('the control documents the expected payload', /hydra:expects/.test(reg0.text) && /_signed_payload/.test(reg0.text) && /_signature/.test(reg0.text));
  ok('durable entries are marked durable', /Durable: configured for this deployment/.test(reg0.text));

  // The gate origin the deployment actually uses, taken from a durable entry rather than assumed —
  // asserting against a hardcoded host would pass for the wrong reason on a re-pointed deployment.
  const origin = (() => {
    const m = /iep:store\s+<(https?:\/\/[^/]+)\/[^>]*>/.exec(reg0.text.split('iep:enrolled')[1] ?? '');
    return m?.[1] ?? 'https://gate.interego.xwisee.com';
  })();
  console.log(`      pod origin in use: ${origin}`);

  const A = ethers.Wallet.createRandom();
  const B = ethers.Wallet.createRandom();
  const podA = ownPodOf(A, origin);
  const podB = ownPodOf(B, origin);
  console.log(`\n      A=${A.address.toLowerCase()} → ${podA}`);
  console.log(`      B=${B.address.toLowerCase()} → ${podB}`);

  console.log('\n[1] an agent enrols its OWN pod, with no pod_url at all');
  const e1 = await post('/agent/mesh/enrolment', await envelope(A, {}));
  ok('enrolment accepted', e1.status === 200 && e1.body?.ok === true, `HTTP ${e1.status}`);
  ok('enrolled the caller\'s own derived pod', norm(e1.body?.enrolled) === norm(podA), e1.body?.enrolled);
  ok('reported as a new enrolment', e1.body?.alreadyEnrolled === false);
  ok('says plainly that it is session-scoped', /SESSION-SCOPED/.test(String(e1.body?.durability)), String(e1.body?.durability).slice(0, 60) + '…');
  ok('answers with the live enrolled set, including the new pod',
    Array.isArray(e1.body?.pods) && e1.body.pods.some((p: string) => norm(p) === norm(podA)), `${e1.body?.pods?.length} pods`);
  ok('names the register as a URL', typeof e1.body?.register === 'string' && e1.body.register.endsWith('/agent/mesh/enrolment'));

  console.log('\n[2] ★★ THE ABUSE CASE — B asks to enrol A\'s pod');
  const e2 = await post('/agent/mesh/enrolment', await envelope(B, { pod_url: podA }));
  ok('not refused — answered 200', e2.status === 200 && e2.body?.ok === true, `HTTP ${e2.status}`);
  ok('enrolled B\'s OWN pod, not the one it named', norm(e2.body?.enrolled) === norm(podB), e2.body?.enrolled);
  ok('the named victim pod was NOT what got enrolled', norm(e2.body?.enrolled) !== norm(podA));
  ok('bound to B as the signer', String(e2.body?.enrolledAs ?? '').toLowerCase().includes(B.address.slice(2, 14).toLowerCase()), String(e2.body?.enrolledAs));

  console.log('\n[3] the abuse case against a DURABLE third party (a configured pod)');
  const victim = (() => {
    const m = /iep:store\s+<(https?:\/\/[^>]+)>/.exec(reg0.text.split('iep:enrolled')[1] ?? '');
    return m?.[1] ?? '';
  })();
  const C = ethers.Wallet.createRandom();
  const podC = ownPodOf(C, origin);
  const e3 = await post('/agent/mesh/enrolment', await envelope(C, { pod_url: victim }));
  ok('enrolled C\'s own pod, not the configured victim', norm(e3.body?.enrolled) === norm(podC), `named ${victim} → got ${e3.body?.enrolled}`);

  console.log('\n[4] the cross-origin look-alike (round-26 shape: same segment, attacker host)');
  const D = ethers.Wallet.createRandom();
  const podD = ownPodOf(D, origin);
  // Same pod SEGMENT as D's own pod, different host — the override that passed the actor check on
  // its own and needed the origin bound to it as well.
  const lookalike = `${origin}.evil.example/eth-${D.address.slice(2, 14).toLowerCase()}/`;
  const e4 = await post('/agent/mesh/enrolment', await envelope(D, { pod_url: lookalike }));
  ok('override sharing the caller\'s own segment on another host is dropped',
    norm(e4.body?.enrolled) === norm(podD), `named ${lookalike} → got ${e4.body?.enrolled}`);
  ok('nothing at the attacker origin was enrolled',
    !(e4.body?.pods ?? []).some((p: string) => p.includes('evil.example')));

  console.log('\n[5] enrolling twice is idempotent, not a duplicate');
  const before = (e4.body?.pods ?? []).length;
  const e5 = await post('/agent/mesh/enrolment', await envelope(A, {}));
  ok('second enrolment reports alreadyEnrolled', e5.body?.alreadyEnrolled === true);
  ok('the enrolled set did not grow', (e5.body?.pods ?? []).length === before, `${before} → ${(e5.body?.pods ?? []).length}`);

  console.log('\n[6] an unsigned or stale request cannot enrol anything');
  const u1 = await post('/agent/mesh/enrolment', { pod_url: podA });
  ok('unsigned POST refused 401', u1.status === 401, `HTTP ${u1.status}`);
  ok('the refusal says how to sign', /signed-request envelope/.test(JSON.stringify(u1.body)));
  const stale = new Date(Date.now() - 10 * 60 * 1000).toISOString();
  const u2 = await post('/agent/mesh/enrolment', await envelope(ethers.Wallet.createRandom(), {}, stale));
  ok('a 10-minute-old envelope refused 401', u2.status === 401, `HTTP ${u2.status}`);
  const E = ethers.Wallet.createRandom();
  const tampered = await envelope(E, {});
  tampered._signed_payload = JSON.stringify({ ...JSON.parse(tampered._signed_payload), pod_url: victim });
  const u3 = await post('/agent/mesh/enrolment', tampered);
  ok('a payload edited after signing refused 401', u3.status === 401, `HTTP ${u3.status}`);

  console.log('\n[7] the register now REPORTS the runtime enrolments, marked as session-scoped');
  const reg1 = await get('/agent/mesh/enrolment');
  ok('A appears in the register', reg1.text.toLowerCase().includes(norm(podA)), podA);
  ok('B appears in the register', reg1.text.toLowerCase().includes(norm(podB)), podB);
  ok('runtime entries are marked session-scoped, not durable', /Session-scoped/i.test(reg1.text));
  ok('each runtime entry records when and by whom', /enrolled at \d{4}-\d\d-\d\dT[^ ]+ by did:ethr:/i.test(reg1.text));
  ok('durable entries are still marked durable', /Durable: configured for this deployment/.test(reg1.text));
  ok('no attacker-origin entry leaked into the register', !reg1.text.includes('evil.example'));

  /**
   * ★★ THE LOOP THAT CLOSES. The incident this whole path comes from was an agent getting an empty
   * review and having no way to learn why — the deciding fact was an environment variable, and a
   * human read Railway config to find it. So the test is not "is enrolment possible" but: does an
   * empty review TEACH the remedy, and does following that remedy, with no human anywhere, change
   * the same endpoint's answer? Both halves, in order, against the deployed service.
   */
  console.log('\n[8] an empty review teaches the remedy — and the remedy works, unassisted');
  const F = ethers.Wallet.createRandom();
  const podF = ownPodOf(F, origin);
  const r1 = await post('/agent/review-record', await envelope(F, { include_clr: false }));
  ok('review of an unenrolled agent answers 200', r1.status === 200 && r1.body?.ok === true, `HTTP ${r1.status}`);
  ok('the record is empty', r1.body?.subject?.statementCount === 0, `${r1.body?.subject?.statementCount} statements`);
  ok('and it says WHY it is empty', !!r1.body?.whyEmpty);
  ok('it reports this subject as NOT enrolled', r1.body?.whyEmpty?.subjectEnrolled === false);
  ok('the boolean agrees with the list it published beside it',
    !(r1.body?.whyEmpty?.lensPopulatedBy?.enrolledPods ?? []).some((p: string) => norm(p) === norm(podF)));
  ok('the remedy points at the register, not at a human',
    !/ask the operator to add/i.test(String(r1.body?.whyEmpty?.remedy)),
    String(r1.body?.whyEmpty?.remedy ?? '').slice(0, 100) + '…');
  ok('the remedy tells the agent it can enrol its own pod', /enrol it yourself/i.test(String(r1.body?.whyEmpty?.remedy)));
  ok('the register is given as a dereferenceable URL',
    /^https?:\/\/.+\/agent\/mesh\/enrolment$/.test(String(r1.body?.whyEmpty?.lensPopulatedBy?.enrolmentRegister)),
    String(r1.body?.whyEmpty?.lensPopulatedBy?.enrolmentRegister));

  // Now do exactly what it said to do, and only that.
  const e8 = await post('/agent/mesh/enrolment', await envelope(F, {}));
  ok('following the remedy enrols F', e8.body?.ok === true && norm(e8.body?.enrolled) === norm(podF), e8.body?.enrolled);
  const r2 = await post('/agent/review-record', await envelope(F, { include_clr: false }));
  ok('the SAME review now reports it enrolled', r2.body?.whyEmpty?.subjectEnrolled === true);
  ok('and the remedy has changed to the enrolled explanation', /IS enrolled/.test(String(r2.body?.whyEmpty?.remedy)),
    String(r2.body?.whyEmpty?.remedy ?? '').slice(0, 90) + '…');

  console.log(`\nRESULT: ${pass} passed, ${fail} failed`);
  process.exit(fail === 0 ? 0 : 1);
}
main().catch(e => { console.error('mesh-enrolment-authority-live error:', e); process.exit(2); });
