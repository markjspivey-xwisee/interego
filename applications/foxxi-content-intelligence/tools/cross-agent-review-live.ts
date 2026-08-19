#!/usr/bin/env tsx
/**
 * One agent reviewing ANOTHER agent's record, live — the branch `classifySubjectKind` has that
 * nothing had ever exercised.
 *
 * ── WHY THIS EXISTS ──────────────────────────────────────────────────────────────────────────
 *
 * `POST /agent/review-record` classifies its subject to decide whether the record is public (agent
 * capability records are infrastructure) or private (human learner records). That classification
 * has two branches and only one had ever been run against the deployed bridge:
 *
 *   SELF      — a delegate reading its own record. Exercised daily. It is also the branch that was
 *               WRONG until an hour ago: it hard-coded `human`, so a delegate reviewing itself was
 *               misfiled regardless of its own signed evidence.
 *   NON-SELF  — one agent reading another's. This is the security-relevant one: get it wrong in one
 *               direction and a human's private record leaks to any signed wallet; wrong in the
 *               other and a legitimate agent-to-agent read is refused. It shipped untested.
 *
 * A second real agent is the only way to run it. Not a fixture and not a second wallet pretending —
 * a principal with its own key, its own pod, its own published presence and capability documents,
 * authorised by the subject's delegator. `provision-claude-code-agent.ts` makes that agent.
 *
 * ★ WHAT A PASS LOOKS LIKE, AND WHY BOTH HALVES MATTER. The subject must come back classified
 * `agent` FROM ITS OWN EVIDENCE (`PERF_EXT.actorKind` in its signed statements) — not from anything
 * this caller asserts. So the run makes the same call twice, once claiming `actor_kind: 'agent'` and
 * once claiming `'human'`, and the two answers must be IDENTICAL. If the caller's claim moves the
 * outcome, the classification is caller-controlled and the fix did not hold.
 *
 * Usage:
 *   npx tsx applications/foxxi-content-intelligence/tools/cross-agent-review-live.ts <subject-pod>
 */

import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Wallet } from 'ethers';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const BRIDGE = (process.env['FOXXI_BRIDGE'] ?? 'https://foxxi-bridge.interego.xwisee.com').replace(/\/$/, '');
const GATE = process.env['CSS_GATE_URL'] ?? 'https://gate.interego.xwisee.com';
const KEYFILE = join(REPO, '.interego', 'claude-code-agent.json');

const subjectPod = process.argv[2] ?? 'u-eth-03f52e15b9df';
const log = (...a: unknown[]): void => { process.stdout.write(a.map(String).join(' ') + '\n'); };
const head = (s: string): void => { log('\n== ' + s + ' ' + '='.repeat(Math.max(0, 64 - s.length))); };

const saved = JSON.parse(readFileSync(KEYFILE, 'utf8')) as { privateKey: string; address: string };
const wallet = new Wallet(saved.privateKey);
const sha = (s: string): string => createHash('sha256').update(s).digest('hex');

/** rev-196: the signature is over the `sha256:<hex>` STRING, not the payload bytes. */
async function envelope(args: Record<string, unknown>): Promise<Record<string, string>> {
  const payload = { ...args, agent_id: `did:ethr:${wallet.address.toLowerCase()}`, timestamp: new Date().toISOString() };
  const sp = JSON.stringify(payload);
  return { _signature: await wallet.signMessage(`sha256:${sha(sp)}`), _signed_payload: sp };
}

async function review(actorKind: string): Promise<Record<string, unknown>> {
  const body = await envelope({
    subject_pod_url: `${GATE}/${subjectPod}/`,
    include_clr: false,
    actor_kind: actorKind,
  });
  const r = await fetch(`${BRIDGE}/agent/review-record`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const text = await r.text();
  let json: Record<string, unknown>;
  try { json = JSON.parse(text) as Record<string, unknown>; }
  catch { json = { _unparseable: text.slice(0, 400) }; }
  return { _status: r.status, _bytes: Buffer.byteLength(text, 'utf8'), ...json };
}

/** The same call, but naming the subject BY DID as well — the honest non-self shape. */
async function reviewByDid(did: string): Promise<Record<string, unknown>> {
  const body = await envelope({
    subject_did: did,
    subject_pod_url: `${GATE}/${subjectPod}/`,
    include_clr: false,
  });
  const r = await fetch(`${BRIDGE}/agent/review-record`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  });
  const text = await r.text();
  let json: Record<string, unknown>;
  try { json = JSON.parse(text) as Record<string, unknown>; } catch { json = { _unparseable: text.slice(0, 300) }; }
  return { _status: r.status, ...json };
}

/** No pod named at all — whatever the bridge considers to be MY OWN record. The control. */
async function reviewOwn(): Promise<Record<string, unknown>> {
  const body = await envelope({ include_clr: false });
  const r = await fetch(`${BRIDGE}/agent/review-record`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  });
  const text = await r.text();
  let json: Record<string, unknown>;
  try { json = JSON.parse(text) as Record<string, unknown>; } catch { json = { _unparseable: text.slice(0, 300) }; }
  return { _status: r.status, ...json };
}

head('who is asking');
log('caller  :', `did:ethr:${wallet.address.toLowerCase()}`);
log('subject :', subjectPod, '(NOT the caller — this is the non-self branch)');

/**
 * ★★ THE CONTROL, AND IT IS THE WHOLE POINT OF RUNNING THIS TWICE.
 *
 * `isSelf` is computed as `subjectDid === callerDid`, and `subjectDid` DEFAULTS TO THE CALLER when
 * `subject_did` is omitted — while the DATA is read from `subject_pod_url`, a separate
 * caller-supplied field that is only checked for being a safe URL. So omitting one field and naming
 * somebody else's pod can produce a read of THEIR record that the handler believes is a self-read.
 *
 * That matters because the privacy gate is `subjectKind === 'human' && !isSelf`. A read that thinks
 * it is self never reaches the gate at all.
 *
 * Comparing statement counts is what tells the two apart: a brand-new agent's own record is nearly
 * empty, so if "my own record" and "the record I get when I name their pod" differ, the second one
 * is not mine — whatever the response says about `self`.
 */
head('CONTROL — my own record, naming no pod');
const own = await reviewOwn();
const subjO = own['subject'] as Record<string, unknown> | undefined;
log('status      :', own['_status']);
log('self        :', own['self']);
log('subject.pod :', subjO?.['podUrl']);
log('statements  :', subjO?.['statementCount']);

head("claiming actor_kind: 'agent'");
const asAgent = await review('agent');
const subjA = asAgent['subject'] as Record<string, unknown> | undefined;
log('status      :', asAgent['_status'], '·', asAgent['_bytes'], 'bytes');
log('self        :', asAgent['self']);
log('authMode    :', asAgent['authMode']);
log('projection  :', asAgent['projection'], '  <- links is the default now');
log('subject.kind:', subjA?.['kind']);
log('statements  :', subjA?.['statementCount']);
if (asAgent['error']) log('ERROR       :', asAgent['error']);

head("claiming actor_kind: 'human' — the answer must not move");
const asHuman = await review('human');
const subjH = asHuman['subject'] as Record<string, unknown> | undefined;
log('status      :', asHuman['_status']);
log('subject.kind:', subjH?.['kind']);
if (asHuman['error']) log('ERROR       :', asHuman['error']);

head('verdict');
const kindA = subjA?.['kind'];
const kindH = subjH?.['kind'];
const sameStatus = asAgent['_status'] === asHuman['_status'];
const sameKind = kindA === kindH;

if (!sameStatus || !sameKind) {
  log('✗ CALLER-CONTROLLED. The caller\'s claim changed the outcome:');
  log(`    actor_kind 'agent' -> ${asAgent['_status']} / kind=${String(kindA)}`);
  log(`    actor_kind 'human' -> ${asHuman['_status']} / kind=${String(kindH)}`);
  log('  Classification must come from the SUBJECT\'s own signed statements. This is the');
  log('  credential-forgery class: a caller-supplied field deciding an authority outcome.');
  process.exit(1);
}

log(`✓ the caller's claim did not move the outcome (both ${asAgent['_status']}, kind=${String(kindA)})`);

head('★ DID THIS ACTUALLY REACH THE NON-SELF BRANCH?');
const ownCount = subjO?.['statementCount'];
const podCount = subjA?.['statementCount'];
log('my own record        :', ownCount, 'statement(s)');
log('naming THEIR pod     :', podCount, 'statement(s), reported self =', asAgent['self']);
if (asAgent['self'] === true && ownCount !== podCount) {
  log('');
  log('✗✗ NO — AND THIS IS A PRIVACY BYPASS, NOT A TEST-HARNESS MISTAKE.');
  log('   The handler read a DIFFERENT pod\'s record and still reported `self: true`, because');
  log('   `isSelf` is `subject_did === callerDid` while the data comes from `subject_pod_url`.');
  log('   Omit `subject_did`, name somebody else\'s pod, and the gate `subjectKind === "human"');
  log('   && !isSelf` is never reached. Any signed wallet could read any pod, including a');
  log('   human\'s private record. Same class as the credential-forgery fix: a caller-supplied');
  log('   field deciding an authority outcome.');
  const honest = await reviewByDid(`did:ethr:0x${'0'.repeat(40)}`);
  log('');
  log('   naming a subject_did that is NOT me ->', honest['_status'],
    honest['error'] ? String(honest['error']).slice(0, 120) : '(allowed)');
  process.exit(1);
}
if (asAgent['self'] === true && ownCount === podCount) {
  log('  inconclusive: both reads returned the same count, so this cannot tell them apart.');
  log('  Re-run against a subject whose record differs in size from the caller\'s.');
}
if (asAgent['_status'] === 200 && kindA === 'agent') {
  log('✓ the subject was classified AGENT from its own evidence, and the read was allowed —');
  log('  agent capability records are public, which is what makes agent-to-agent audit possible.');
} else if (asAgent['_status'] === 403) {
  log('  the subject is classified HUMAN, so a non-self read is refused. Correct IF the subject');
  log('  really is a person; a MISFILED agent would look exactly like this, so check the subject\'s');
  log('  own statements declare PERF_EXT.actorKind before concluding the gate is right.');
}
