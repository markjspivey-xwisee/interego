/**
 * Live verification of the deployed standards-extension capability + the engine
 * re-integration. Run AFTER deploying the new Foxxi revision.
 *
 * Run from context-graphs/: npx tsx applications/foxxi-content-intelligence/tools/verify-extend-live.ts
 */
const BRIDGE = 'https://interego-foxxi-bridge.livelysky-8b81abb0.eastus.azurecontainerapps.io';

let pass = 0, fail = 0;
const check = (n: string, c: boolean, d = ''): void => {
  if (c) { pass++; console.log(`  ✓ ${n}${d ? ' — ' + d : ''}`); }
  else { fail++; console.log(`  ✗ ${n}${d ? ' — ' + d : ''}`); }
};
const post = (path: string, body: unknown) =>
  fetch(`${BRIDGE}${path}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });

async function waitForNewRevision(): Promise<boolean> {
  // The new revision is live once /agent/extend-standards exists (old image 404s it).
  for (let i = 0; i < 45; i++) {
    try {
      const r = await post('/agent/extend-standards', { kind: 'XapiContextExtension', name: 'probe', definition: 'probe' });
      if (r.status !== 404) return true;
    } catch { /* retry */ }
    await new Promise(r => setTimeout(r, 4000));
  }
  return false;
}

async function main(): Promise<void> {
  console.log('[deploy] waiting for the new revision (POST /agent/extend-standards to exist)...');
  if (!(await waitForNewRevision())) { console.log('  ! new revision did not come up in time'); process.exit(2); }

  console.log('\n[extend-standards] live');
  const xc = await post('/agent/extend-standards', { kind: 'XapiContextExtension', name: 'collaborationDepth', definition: 'How many distinct peers contributed.' }).then(r => r.json()) as Record<string, unknown>;
  check('xAPI extension: ok + Profile artifact', xc.ok === true && (xc.artifact as Record<string, unknown>)?.type === 'Profile');
  check('self-descriptive iep:StandardsExtension descriptor', JSON.stringify(xc.descriptor).includes('StandardsExtension'));
  check('in-flow guidance attached (teaches + howToLearn)', !!(xc._guidance as Record<string, unknown>)?.teaches && !!(xc._guidance as Record<string, unknown>)?.howToLearn);

  const ler = await post('/agent/extend-standards', { kind: 'LerTerm', name: 'AgentMastery', definition: 'A mastery record for an agent.' }).then(r => r.json()) as Record<string, unknown>;
  const art = ler.artifact as { mediaType?: string; turtle?: string };
  check('IEEE-LER term: Turtle artifact subclassing the LER layer', art?.mediaType === 'text/turtle' && !!art.turtle && art.turtle.includes('ieee-ler'));

  const bad = await post('/agent/extend-standards', { kind: 'XapiContextExtension' });
  check('missing inputs rejected (400)', bad.status === 400);

  console.log('\n[guidance] in-flow performance support served');
  const cat = await fetch(`${BRIDGE}/guidance`).then(r => r.json()) as Record<string, unknown>;
  check('GET /guidance returns a capability catalog', Array.isArray(cat.capabilities) && (cat.capabilities as Array<Record<string, unknown>>).some(c => c.tool === 'foxxi.extend_standards'));
  const one = await fetch(`${BRIDGE}/guidance/foxxi.extend_standards`).then(r => r.json()) as Record<string, unknown>;
  check('GET /guidance/:tool returns per-tool guidance', !!(one.guidance as Record<string, unknown>)?.summary);

  console.log('\n[discovery] affordance manifest');
  const aff = await fetch(`${BRIDGE}/affordances`).then(r => r.text());
  check('manifest advertises extend-standards', aff.includes('extend-standards'));

  console.log('\n[regression] relocated engine still serves Foxxi /performance');
  const perf = await fetch(`${BRIDGE}/performance`);
  check('GET /performance still 200 (engine via shims)', perf.ok, `HTTP ${perf.status}`);

  console.log(`\nRESULT: ${pass} passed, ${fail} failed`);
  process.exit(fail === 0 ? 0 : 1);
}
main().catch(e => { console.error('harness error:', e); process.exit(2); });
