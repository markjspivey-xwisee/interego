export const meta = {
  name: 'convergence-demo-adversarial-review',
  description: 'Adversarially review the W3C-convergence BYOK demo for honesty/overclaim, correctness, security, and principle-alignment',
  phases: [{ title: 'Review' }, { title: 'Verify' }, { title: 'Synthesize' }],
};

const ROOT = 'd:/devstuff/harness/context-graphs';
const FILES = [
  `${ROOT}/applications/foxxi-content-intelligence/microsite-app/src/demo/convergence.ts`,
  `${ROOT}/applications/foxxi-content-intelligence/microsite-app/src/pages/Convergence.tsx`,
  `${ROOT}/applications/foxxi-content-intelligence/tools/convergence-feasibility.ts`,
  `${ROOT}/docs/NAME-PROVENANCE.md`,
];

const BRIEF = [
  'Adversarially review a NEW BYOK microsite demo, "Convergence", that maps three W3C efforts to live Interego primitives:',
  '  (1) W3C Holon CG  -> Interego holons: a descriptor is an iep:ContextDescriptor (a WHOLE) whose terms are shared PGSL atoms (a PART of a hypergraph holarchy). UI mints a holon (record-performance), shows lattice levels, dereferences the iep: descriptor.',
  '  (2) Cagle DataBook -> SKILL.md <-> iep:Affordance: ingest a Markdown DataBook into a holon (/agent/course/analyze-skill) + emit a SKILL.md back (/agent/course/skill). BYOK: an LLM authors a DataBook from a description.',
  '  (3) W3C Context Graphs CG (Itelman) -> usage-based semiotic gap resolution: interrogate a holon (/agent/lattice/:label/interrogate); per-interrogative status full/partial/pointer/absent IS the gap-resolution-state; absent+caveat IS safe-stop.',
  'The protocol was just renamed cg: -> iep: ("Interego Protocol"). The demo composes EXISTING bridge endpoints (no new substrate).',
  'OWNER PRINCIPLES to hold it to: HONEST (no overclaim — every crosswalk/delta/claim must be literally true and defensible); COMPOSE-DONT-REINVENT; SUBSTANTIAL not toy; and accurate about the W3C efforts (do not misstate their scope/status). Be skeptical: if a claim could mislead a sophisticated semantic-web reviewer, flag it.',
  'Specific things to scrutinize: Is "every descriptor is a holon" / the whole-and-part framing accurate to what record-performance actually returns (sharedLattice.stats.levels)? Is mapping interrogative "absent" to the W3C CG safe-stop honest, or an overreach? Is the DataBook<->course/analyze-skill mapping honest (it is a COURSE bridge, not the core @interego/skills SKILL.md<->iep:Affordance — is that conflation overclaimed)? Is the holon:Holon <-> iep:ContextDescriptor crosswalk fair? Does the demo misrepresent the W3C groups (chair/scope/status)? Is the BYOK Anthropic call safe (key handling, CORS header) and does it degrade honestly without a key? Any correctness bugs in the gap classification or the dereference retry?',
].join('\n');

const F_SCHEMA = { type: 'object', additionalProperties: false, properties: { findings: { type: 'array', items: { type: 'object', additionalProperties: false, properties: {
  title: { type: 'string' }, file: { type: 'string' }, locator: { type: 'string' },
  severity: { type: 'string', enum: ['critical', 'high', 'medium', 'low'] },
  dimension: { type: 'string', enum: ['honesty-overclaim', 'correctness', 'security', 'principle-alignment', 'w3c-accuracy', 'ux-clarity'] },
  problem: { type: 'string' }, fix: { type: 'string' },
}, required: ['title', 'file', 'severity', 'dimension', 'problem', 'fix'] } } }, required: ['findings'] };

const V_SCHEMA = { type: 'object', additionalProperties: false, properties: {
  isReal: { type: 'boolean' }, confidence: { type: 'string', enum: ['high', 'medium', 'low'] }, reasoning: { type: 'string' }, revisedFix: { type: 'string' },
}, required: ['isReal', 'confidence', 'reasoning', 'revisedFix'] };

const DIMS = [
  { key: 'honesty', prompt: 'HONESTY / OVERCLAIM: scrutinize every crosswalk row and every "Honest delta" + the intro copy. Flag any claim that overstates what the live call returns or what Interego actually is, or that conflates distinct things (esp. the DataBook<->/agent/course/analyze-skill COURSE bridge being presented as the SKILL.md<->iep:Affordance core bridge; and "absent interrogative == W3C safe-stop"). Read convergence.ts + Convergence.tsx.' },
  { key: 'w3c-accuracy', prompt: 'W3C ACCURACY: check the demo states the three W3C efforts accurately (Holon CG = Cagle/Koestler holons; DataBook = Cagle; Context Graphs CG = Itelman/contextual misalignment, chair status was contradictory across sources). Flag any misattribution, scope inflation, or implication that Interego derives from / predates them. Cross-check against docs/NAME-PROVENANCE.md for consistency. Read Convergence.tsx + NAME-PROVENANCE.md.' },
  { key: 'correctness', prompt: 'CORRECTNESS: the gap classification (full/partial/pointer/absent buckets), the dereference retry logic, the DataBook author markdown-extraction/strip, the holon levels viz math, error/empty handling. Will any panel throw or mislead on an empty/odd bridge response? Read convergence.ts + Convergence.tsx.' },
  { key: 'security', prompt: 'SECURITY: the BYOK Anthropic call (key only to api.anthropic.com, dangerous-direct-browser header, no leakage to our servers/logs), the in-browser fetches, and that nothing signs/sends the key anywhere else. Also: does the LLM-authored DataBook get ingested without sanitization in a way that could matter? Read convergence.ts.' },
];

phase('Review');
const reviews = await parallel(DIMS.map(d => () =>
  agent(`${BRIEF}\n\nYOUR DIMENSION: ${d.prompt}\n\nFiles: ${FILES.join(', ')}`, { label: `review:${d.key}`, phase: 'Review', schema: F_SCHEMA })));
const all = reviews.filter(Boolean).flatMap(r => r.findings || []);
log(`collected ${all.length} candidate findings`);

phase('Verify');
const verified = await parallel(all.map(f => () =>
  agent(`Adversarially verify this finding against the actual code/docs. Real problem worth fixing, or false positive? If the fix would reduce honesty or break the demo, isReal=false. Be skeptical both ways.\n\n${JSON.stringify(f, null, 2)}\n\nFile: ${f.file}`, { label: `verify:${(f.file||'').split('/').pop()}`, phase: 'Verify', schema: V_SCHEMA })
    .then(v => ({ finding: f, verdict: v }))));
const confirmed = verified.filter(Boolean).filter(x => x.verdict && x.verdict.isReal);
log(`${confirmed.length}/${all.length} confirmed`);

phase('Synthesize');
const synthesis = await agent(
  `Synthesize the confirmed findings into a prioritized, de-duplicated fix-list (grouped by severity; file + precise problem + exact fix). End with a one-paragraph honest verdict on whether this W3C-convergence demo is ready to ship.\n\nCONFIRMED:\n${JSON.stringify(confirmed.map(c => ({ ...c.finding, verdict: c.verdict })), null, 2)}`,
  { label: 'synthesize', phase: 'Synthesize', effort: 'high' });

return { candidates: all.length, confirmed: confirmed.length, bySeverity: confirmed.reduce((m, c) => { const s = c.finding.severity; m[s] = (m[s] || 0) + 1; return m; }, {}), synthesis, confirmedFindings: confirmed.map(c => ({ ...c.finding, verdict: c.verdict })) };
