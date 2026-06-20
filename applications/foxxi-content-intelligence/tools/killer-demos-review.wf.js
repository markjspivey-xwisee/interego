export const meta = {
  name: 'killer-demos-adversarial-review',
  description: 'Adversarially review the 5 killer-app demos for honesty/overclaim, correctness, security, and principle-alignment, then synthesize a fix-list',
  phases: [
    { title: 'Review' },
    { title: 'Verify' },
    { title: 'Synthesize' },
  ],
};

const ROOT = 'd:/devstuff/harness/context-graphs/applications/foxxi-content-intelligence';
const FILES = [
  `${ROOT}/microsite-app/src/demo/ceremonies.ts`,
  `${ROOT}/microsite-app/src/demo/evidence.ts`,
  `${ROOT}/microsite-app/src/demo/agent-signing.ts`,
  `${ROOT}/microsite-app/src/demo/demo-runtime.ts`,
  `${ROOT}/microsite-app/src/pages/Portfolio.tsx`,
  `${ROOT}/microsite-app/src/pages/EvidenceLedger.tsx`,
  `${ROOT}/microsite-app/src/pages/FederatedCalibration.tsx`,
  `${ROOT}/microsite-app/src/pages/CourseIntel.tsx`,
  `${ROOT}/microsite-app/src/pages/AgenticDemo.tsx`,
  `${ROOT}/microsite-app/src/components/proof.tsx`,
  `${ROOT}/src/spec/compliance.model.ts`,
  `${ROOT}/src/spec/index.ts`,
  `${ROOT}/bridge/server.ts`,
];

const BRIEF = [
  'You are adversarially reviewing newly-built "killer-app" demos for the Interego/Foxxi platform.',
  'CONTEXT: Interego = composable, verifiable, federated context infrastructure (PGSL substrate; self-sovereign did:ethr agents; dereferenceable HATEOAS linked-data ontologies; BBS+ selective disclosure; work-regime engine).',
  'The 5 demos: (1) protocol-trace on the agent demo (raw rev-196 envelope + client-side signer recovery + curl); (2) Portfolio/Hire (fresh employer re-verifies a candidate, BBS+ proof, deterministic ACCEPT/REJECT); (3) Living Curriculum (course runs each concept through the regime engine, refuses the universal content-gap frame, emits a cg:supersedes successor holon); (4) Evidence Ledger (signed action -> verifiable pack: client-side signer recovery + live SHACL shape dereference + SOC2/EU-AI-Act/NIST control citation, re-verify from a clean seat); (5) Federated Calibration (two orgs sign aggregate cells, k-anonymity floor, pooling promotes Hypothetical->Asserted, dereferenceable merged holon).',
  'The owner PRINCIPLES you must hold the work to: (a) HONEST — no overclaiming; every wow must be literally true; flag any copy that claims more than the code does (e.g. "zero-knowledge" when BBS+ only hides fields; "anonymous" when contributions are signed/recoverable; "60 seconds" framing). (b) COMPOSE-DONT-REINVENT — must reuse existing primitives, not hand-roll. (c) SUBSTANTIAL not toy. (d) EMERGENT/dogfooding — uses the substrate to do the thing + record itself.',
  'Read the files you are assigned. Report concrete, file:line findings. Prefer fewer high-signal findings over many nits. Default to skepticism: if a claim COULD mislead a sophisticated viewer, flag it.',
].join('\n');

const FINDING_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    findings: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        properties: {
          title: { type: 'string' },
          file: { type: 'string' },
          locator: { type: 'string', description: 'function/symbol or line hint' },
          severity: { type: 'string', enum: ['critical', 'high', 'medium', 'low'] },
          dimension: { type: 'string', enum: ['honesty-overclaim', 'correctness', 'security', 'principle-alignment', 'ux-clarity'] },
          problem: { type: 'string' },
          fix: { type: 'string' },
        },
        required: ['title', 'file', 'severity', 'dimension', 'problem', 'fix'],
      },
    },
  },
  required: ['findings'],
};

const VERDICT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    isReal: { type: 'boolean', description: 'true if the finding is a genuine problem worth fixing' },
    confidence: { type: 'string', enum: ['high', 'medium', 'low'] },
    reasoning: { type: 'string' },
    revisedFix: { type: 'string' },
  },
  required: ['isReal', 'confidence', 'reasoning', 'revisedFix'],
};

const DIMENSIONS = [
  { key: 'honesty-overclaim', prompt: 'Hunt for OVERCLAIM and dishonesty: copy/labels/notes that assert more than the code delivers. Especially: BBS+ framed as "zero-knowledge proof" (it hides fields, does not range-prove); "anonymous"/"de-identified" claims where contributions are signed + the signer is recovered (Federated Calibration); any "verify without trusting the issuer" (BBS+ does NOT remove issuer trust); the Evidence Ledger SOC2 projection (is it honest that the instance is DERIVED from the action, not the raw xAPI statement?); the Living Curriculum performance signal honesty (illustrative vs real). Check ceremonies.ts, evidence.ts, FederatedCalibration.tsx, EvidenceLedger.tsx, CourseIntel.tsx, the bridge endpoint `note` fields in server.ts.' },
  { key: 'correctness', prompt: 'Hunt for CORRECTNESS bugs: the decide() hiring logic (does it ever ACCEPT unqualified, or REJECT qualified? proficiency parse robustness), the regime mapping in /agent/course/propose-successor (does it ever default to "revise instruction"?), the calibration merge (k-anon applied at the right point? Hypothetical->Asserted threshold), the client-side signer recovery + tamper check in evidence.ts, the subclass-aware validateInstanceWith in spec/index.ts. Read ceremonies.ts, evidence.ts, spec/index.ts, and the two new endpoints in server.ts.' },
  { key: 'security', prompt: 'Hunt for SECURITY/abuse issues: the new bridge endpoints (/agent/course/propose-successor, /agent/calibration/merge) — input validation, signature verification on calibration contributions (is each contribution really verified? can an unsigned/forged contribution poison the merge?), rate limiting, resource bounds (array sizes), any injection into composed lattice content, CORS. Read server.ts new endpoints + spec/index.ts validateInstanceWith.' },
  { key: 'principle-alignment', prompt: 'Check COMPOSE-DONT-REINVENT + EMERGENT/dogfooding + SUBSTANTIAL-not-toy: do the demos reuse existing primitives (calibration engine, regime engine, BBS+, lattice) rather than hand-rolling? Are the compliance ontologies genuinely emergent (composed into PGSL + projected) or just hosted? Is anything a toy one-liner? Read compliance.model.ts, server.ts (compose wiring), ceremonies.ts, evidence.ts.' },
];

phase('Review');
const reviews = await parallel(DIMENSIONS.map(d => () =>
  agent(`${BRIEF}\n\nYOUR DIMENSION: ${d.prompt}\n\nFiles you may read (read what is relevant): ${FILES.join(', ')}`,
    { label: `review:${d.key}`, phase: 'Review', schema: FINDING_SCHEMA })
));

const allFindings = reviews.filter(Boolean).flatMap(r => (r && r.findings) ? r.findings : []);
log(`collected ${allFindings.length} candidate findings across ${DIMENSIONS.length} dimensions`);

phase('Verify');
const verified = await parallel(allFindings.map(f => () =>
  agent(`Adversarially verify this review finding against the actual code. Read the file and decide if it is a REAL problem worth fixing, or a false positive / nit. Be skeptical of BOTH directions: do not rubber-stamp, but do not invent problems. If the fix would make the demo LESS honest or LESS functional, say isReal=false.\n\nFINDING:\n${JSON.stringify(f, null, 2)}\n\nFile: ${f.file}`,
    { label: `verify:${(f.file || '').split('/').pop()}`, phase: 'Verify', schema: VERDICT_SCHEMA })
    .then(v => ({ finding: f, verdict: v }))
));

const confirmed = verified.filter(Boolean).filter(x => x.verdict && x.verdict.isReal);
log(`${confirmed.length}/${allFindings.length} findings confirmed real`);

phase('Synthesize');
const synthesis = await agent(
  `Synthesize the confirmed adversarial-review findings into a prioritized, de-duplicated fix-list for the engineer. Group by severity. For each: the file, the precise problem, and the exact fix. Be concise and actionable. End with a one-paragraph honest verdict on whether these 5 demos are ready to ship.\n\nCONFIRMED FINDINGS:\n${JSON.stringify(confirmed.map(c => ({ ...c.finding, verdict: c.verdict })), null, 2)}`,
  { label: 'synthesize', phase: 'Synthesize' }
);

return { candidates: allFindings.length, confirmed: confirmed.length, bySeverity: confirmed.reduce((m, c) => { const s = c.finding.severity; m[s] = (m[s] || 0) + 1; return m; }, {}), synthesis, confirmedFindings: confirmed.map(c => ({ ...c.finding, verdict: c.verdict })) };
