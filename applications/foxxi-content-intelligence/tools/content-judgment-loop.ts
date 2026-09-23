/**
 * Close the content-judgment loop as yourself: judge → confirm-next → confirm → calibration →
 * attest → reputation, against a live Foxxi bridge, signed with the wallet this process reads.
 *
 *   FOXXI_AGENT_KEY_FILE=<wallet json: {address, privateKey}> npx tsx \
 *     applications/foxxi-content-intelligence/tools/content-judgment-loop.ts \
 *     --bridge https://foxxi-bridge.interego.xwisee.com \
 *     --pod https://gate.interego.xwisee.com/<your pod>/ [--enroll] \
 *     --claims <claims.json> [--confirm-as agent|human] [--report <out.json>] [--dry-run]
 *
 * ── WHY ────────────────────────────────────────────────────────────────────────────────────
 *
 * The loop (2026-09-22) earned Foxxi's judgments a reputation, and the only callers who could
 * run it were the configured tenant's learning engineers. Nothing an agent could do on its own
 * exercised it end to end: the identity that runs this repository's live proofs (the Claude Code
 * agent wallet) is a valid signer and no member of that tenant, and enrolling it there is the
 * tenant admin's act. The bridge's own refusal names the way out — self-sovereign enrolment on
 * the caller's OWN pod — and since 2026-09-23 the six loop affordances take `tenant_pod_url`, so
 * a pod's owner, human or agent, runs the whole loop there: judgments, outcomes, calibration,
 * attestation and reputation on their pod, about the same judging agent.
 *
 * ── WHAT IS TRUE ABOUT AN AGENT'S CONFIRMATION ─────────────────────────────────────────────
 *
 * A person's confirmation says what they hold to be true. An agent's is a second model's
 * reading, and this tool never dresses it as the former: `--confirm-as agent` (the default)
 * records every outcome with `confirmedByKind: 'agent'`, the calibration counts human and agent
 * samples apart, and the attestation carries `confirmers: {human, agent}`, so whoever weighs the
 * reputation can see exactly what grounds it. The answers themselves come from the claims file,
 * decided by whoever wrote it — this tool decides nothing about the content.
 *
 * ── HOW IT TALKS TO THE BRIDGE ─────────────────────────────────────────────────────────────
 *
 * JSON-RPC `tools/call` on POST /mcp (the shared mount every vertical serves), with the rev-196
 * proof-of-possession envelope the bridge verifies: `_signed_payload` is the arguments plus
 * `agent_id: did:ethr:<address>` and a timestamp, `_signature` the wallet's signature over the
 * string `sha256:<hex of the payload>` — the same envelope tools/cross-agent-review-live.ts sends.
 * The key file is read by this process and used to sign; it is never printed.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { Wallet } from 'ethers';

interface Claim {
  readonly judgment_kind: 'evidence-level' | 'work-regime';
  readonly claim_text: string;
  readonly context?: string;
  readonly evidence?: readonly { type: string; id: string; narrative?: string }[];
  readonly slide_id?: string;
  readonly course_iri?: string;
  /** The answer the confirmer holds to be true, one of the judgment's alternatives. */
  readonly confirmed_answer: string;
  readonly note?: string;
}

const out = (line: string): void => { process.stdout.write(`${line}\n`); };

function flag(name: string, fallback?: string): string | undefined {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : fallback;
}
const has = (name: string): boolean => process.argv.includes(name);

const bridge = (flag('--bridge', process.env['FOXXI_BRIDGE'] ?? 'https://foxxi-bridge.interego.xwisee.com') as string).replace(/\/$/, '');
const pod = flag('--pod');
const claimsPath = flag('--claims');
const confirmAs = flag('--confirm-as', 'agent') === 'human' ? 'human' : 'agent';
const reportPath = flag('--report');
const dryRun = has('--dry-run');
const keyFile = process.env['FOXXI_AGENT_KEY_FILE'];

if (!claimsPath || !keyFile) {
  out('usage: FOXXI_AGENT_KEY_FILE=<wallet json> npx tsx content-judgment-loop.ts --claims <file> [--bridge <url>] [--pod <pod url>] [--enroll] [--confirm-as agent|human] [--report <file>] [--dry-run]');
  process.exit(64);
}

const saved = JSON.parse(readFileSync(keyFile, 'utf8')) as { privateKey: string; address: string };
const wallet = new Wallet(saved.privateKey);
const agentId = `did:ethr:${wallet.address.toLowerCase()}`;
const sha = (s: string): string => createHash('sha256').update(s).digest('hex');

async function envelope(args: Record<string, unknown>): Promise<Record<string, unknown>> {
  const payload = { ...args, agent_id: agentId, timestamp: new Date().toISOString() };
  const sp = JSON.stringify(payload);
  return { ...args, _signature: await wallet.signMessage(`sha256:${sha(sp)}`), _signed_payload: sp };
}

type Answer = Record<string, unknown>;

async function call(tool: string, args: Record<string, unknown>): Promise<Answer> {
  const scoped = pod ? { ...args, tenant_pod_url: pod } : args;
  if (dryRun) {
    out(`  (dry run) ${tool} ${JSON.stringify(scoped).slice(0, 160)}`);
    // Enough shape for the loop to walk every step without dereferencing anything.
    return { kind: 'dry-run', judgment: { answer: '(dry run)', confidence: 0 }, published: { status: 'published', graphIri: `urn:foxxi:judgment:dry-run-${Math.random().toString(36).slice(2, 8)}` }, queue: [], pending: 0, outcome: { hit: false, brier: 0 }, cells: [], attestation: {}, snapshot: null };
  }
  const res = await fetch(`${bridge}/mcp`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: tool, arguments: await envelope(scoped) } }),
    signal: AbortSignal.timeout(120_000),
  });
  const body = await res.json() as { result?: { content?: { text?: string }[] }; error?: unknown };
  if (body.error) throw new Error(`${tool}: ${JSON.stringify(body.error).slice(0, 300)}`);
  const text = (body.result?.content ?? []).map((c) => c.text ?? '').join('');
  try { return JSON.parse(text) as Answer; } catch { return { kind: 'text', text }; }
}

const refused = (a: Answer): string | undefined => (a['kind'] === 'refusal' ? `${a['iep:refusalStatus'] ?? ''} ${a['iep:refusalReason'] ?? a['error'] ?? ''}`.trim() : undefined);

async function main(): Promise<void> {
  const claims = JSON.parse(readFileSync(claimsPath as string, 'utf8')) as Claim[];
  const report: Record<string, unknown> = { agent: agentId, bridge, pod: pod ?? '(configured tenant)', confirmAs, startedAt: new Date().toISOString(), steps: [] as unknown[] };
  const steps = report['steps'] as unknown[];
  out(`content-judgment loop as ${agentId} on ${pod ?? 'the configured tenant'} via ${bridge}`);

  if (has('--enroll')) {
    if (!pod) throw new Error('--enroll needs --pod: the self-sovereign pod to enrol on');
    const r = await call('foxxi.register_self_sovereign_learner', { tenant_pod_url: pod, audience_tags: ['content-judgment-loop'] });
    steps.push({ step: 'enroll', answer: r });
    const why = refused(r);
    out(why ? `▸ enroll: refused — ${why}` : `▸ enroll: ${String(r['kind'] ?? 'ok')} ${String(r['learner_id'] ?? r['web_id'] ?? '')}`);
    if (why && !/already/i.test(why)) return finish(report, 1);
  }

  const judged: { claim: Claim; judgmentIri: string; answer: string; confidence: number }[] = [];
  for (const claim of claims) {
    const { confirmed_answer: _c, note: _n, ...input } = claim;
    const r = await call('foxxi.judge_content_claim', input as unknown as Record<string, unknown>);
    steps.push({ step: 'judge', claim: claim.claim_text.slice(0, 80), answer: r });
    const why = refused(r);
    if (why) { out(`▸ judge: refused — ${why}`); return finish(report, 1); }
    const j = r['judgment'] as { answer?: string; confidence?: number } | undefined;
    const published = r['published'] as { status?: string; graphIri?: string } | undefined;
    if (published?.status !== 'published' || !published.graphIri) { out(`▸ judge: not published (${String(JSON.stringify(published ?? null)).slice(0, 160)})`); return finish(report, 1); }
    judged.push({ claim, judgmentIri: published.graphIri, answer: String(j?.answer), confidence: Number(j?.confidence) });
    out(`▸ judged ${claim.judgment_kind}: "${claim.claim_text.slice(0, 60)}…" → ${String(j?.answer)} (confidence ${Number(j?.confidence).toFixed(2)}) ${published.graphIri}`);
  }

  const queue = await call('foxxi.confirm_next', {});
  steps.push({ step: 'confirm_next', answer: queue });
  const q = queue['queue'] as { judgmentIri: string; priority: number; why?: Record<string, unknown> }[] | undefined;
  out(`▸ confirm_next: ${refused(queue) ?? `${(q ?? []).length} in the queue of ${String(queue['pending'])} pending; first ${q?.[0]?.judgmentIri ?? '-'} at priority ${q?.[0]?.priority ?? '-'}`}`);

  const order = q && q.length > 0 ? judged.slice().sort((a, b) => (q.findIndex((e) => e.judgmentIri === a.judgmentIri) + 1 || 999) - (q.findIndex((e) => e.judgmentIri === b.judgmentIri) + 1 || 999)) : judged;
  let hits = 0;
  for (const j of order) {
    const r = await call('foxxi.confirm_content_judgment', { judgment_iri: j.judgmentIri, confirmed_answer: j.claim.confirmed_answer, confirmed_by_kind: confirmAs, ...(j.claim.note ? { note: j.claim.note } : {}) });
    steps.push({ step: 'confirm', judgmentIri: j.judgmentIri, answer: r });
    const why = refused(r);
    if (why) { out(`▸ confirm: refused — ${why}`); return finish(report, 1); }
    const o = r['outcome'] as { hit?: boolean; brier?: number } | undefined;
    if (o?.hit) hits += 1;
    out(`▸ confirmed ${j.judgmentIri}: model ${j.answer}, ${confirmAs} says ${j.claim.confirmed_answer} → ${o?.hit ? 'hit' : 'miss'} (brier ${Number(o?.brier).toFixed(3)})`);
  }
  out(`  ${hits} of ${order.length} judgments had the confirmed answer`);

  const calibration = await call('foxxi.content_judgment_calibration', {});
  steps.push({ step: 'calibration', answer: calibration });
  const cells = calibration['cells'] as { judgmentKind: string; samples: number; hitRate: number | null; meanBrier: number | null; status: string; humanSamples?: number; agentSamples?: number }[] | undefined;
  out(`▸ calibration: ${refused(calibration) ?? (cells ?? []).map((c) => `${c.judgmentKind} ${c.status} samples ${c.samples} (human ${c.humanSamples ?? '?'}, agent ${c.agentSamples ?? '?'}) hit ${c.hitRate ?? '-'} brier ${c.meanBrier ?? '-'}`).join('; ')}`);

  const attest = await call('foxxi.attest_content_judgments', {});
  steps.push({ step: 'attest', answer: attest });
  const att = attest['attestation'] as { axes?: Record<string, number>; samples?: number; confirmers?: Record<string, number> } | undefined;
  out(`▸ attest: ${refused(attest) ?? `axes ${JSON.stringify(att?.axes)} from ${att?.samples} samples, confirmers ${JSON.stringify(att?.confirmers)}`}`);

  const reputation = await call('foxxi.content_judgment_reputation', {});
  steps.push({ step: 'reputation', answer: reputation });
  const snap = reputation['snapshot'] as { axes?: Record<string, number>; overallScore?: number; contributingAttestations?: unknown[] } | null | undefined;
  out(`▸ reputation: ${refused(reputation) ?? (snap ? `axes ${JSON.stringify(snap.axes)} from ${(snap.contributingAttestations ?? []).length} attestation(s)` : 'no snapshot yet')}`);

  return finish(report, 0);
}

function finish(report: Record<string, unknown>, code: number): void {
  report['finishedAt'] = new Date().toISOString();
  report['exitCode'] = code;
  if (reportPath) { writeFileSync(reportPath, JSON.stringify(report, null, 2)); out(`report written to ${reportPath}`); }
  process.exitCode = code;
}

main().catch((err: Error) => { out(`content-judgment loop failed: ${err.message}`); process.exit(2); });
