#!/usr/bin/env node
/**
 * Turn the pod evidence table into KEEP / CANDIDATE, by rules that are all facts.
 *
 * ── EVERY RULE HERE EXISTS BECAUSE AN ADVERSARIAL REVIEW REFUTED A DELETION WITHOUT IT ───────
 *
 * A previous pass classified 607 of 680 pods as disposable and a refutation round overturned five
 * of its six classes. Not because the judgements were careless — because "looks like a test pod"
 * is not a fact about anything. So nothing here is a similarity judgement: each rule names a
 * concrete thing that would break, and a pod is KEPT the moment any one of them fires.
 *
 *   ns          the pod BACKS a live /ns IRI. `resolveNsGraph` resolves /ns/:owner/:slug by
 *               calling discover() on <CSS>/<owner>/, so deleting the pod 404s that IRI forever.
 *   inbox       something was SENT here — a workspace invitation, a third-party delegation. The
 *               first pass read only what pods PUBLISHED and was blind to this; 4 of 50 sampled
 *               pods held real inbound messages.
 *   credential  a signed credential lives here. Not reproducible, and not ours to destroy.
 *   twin        the SAME wallet is addressable as both `eth-<hex>` and `u-eth-<hex>`
 *               (own-pod.ts vs the identity service). If either spelling is kept, both are:
 *               deleting the "unused" one deletes half of one identity.
 *   repo        the name appears in checked-in code — a fixture, a default, a hard-coded target.
 *   seed        a configured mesh seed or other live-registry reference.
 *   protected   infrastructure roots and published-namespace owners.
 *   recent      touched within RECENT_DAYS. Live things are recent; a cleanup that races an
 *               active session is the one mistake with no undo.
 *   unread      its manifest was too large to read, or a probe failed. An unread pod is not an
 *               empty one, and absence of evidence is not evidence of absence.
 *
 * Everything a rule did not catch becomes a CANDIDATE — proposed, not approved. The output is
 * meant to be argued with before anything is deleted.
 *
 * Usage:
 *   node tools/css-pod-triage.mjs <evidence.json> <repo-referenced.txt> <candidates-out.json> [<report-out.json>]
 */

import { readFileSync, writeFileSync, existsSync } from 'node:fs';

const RECENT_DAYS = Number(process.env.POD_RECENT_DAYS ?? 10);
/** Frozen at collection time — Date.now() would make the same table triage differently tomorrow. */
const NOW = Date.parse(process.env.POD_TRIAGE_NOW ?? new Date().toISOString());

const [evFile, repoFile, outFile, reportFile] = process.argv.slice(2);
if (!evFile || !repoFile || !outFile) {
  console.error('usage: node tools/css-pod-triage.mjs <evidence.json> <repo-referenced.txt> <candidates-out.json> [<report.json>]');
  process.exit(2);
}

const ev = JSON.parse(readFileSync(evFile, 'utf8'));
const repoNames = new Set(
  (existsSync(repoFile) ? readFileSync(repoFile, 'utf8') : '')
    .split('\n').map(s => s.trim().toLowerCase()).filter(Boolean),
);

/** Infrastructure roots and published-namespace owners. Never candidates, whatever else is true. */
const PROTECTED = new Set([
  'maintainer', 'agent', 'foxxi', 'markj', 'default', 'course-root', 'svc-relay-dcr',
]);
/** Live-registry references: configured mesh seeds. */
const SEEDS = new Set(['eth-8f3b8e939600', 'u-eth-03f52e15b9df', 'u-pk-00181cd5dbee', 'u-pk-b03a054d6915']);

const byPod = new Map(ev.map(e => [e.pod, e]));
const twinOf = (pod) =>
  pod.startsWith('u-eth-') ? pod.slice(2)
    : /^eth-[0-9a-f]{12}$/.test(pod) ? `u-${pod}`
      : null;

/** Facts that, on their own, keep a pod. Returns [] when none fire. */
function keepReasons(e) {
  const r = [];
  const pod = e.pod;
  if (PROTECTED.has(pod)) r.push('protected');
  if (SEEDS.has(pod)) r.push('seed');
  if (repoNames.has(pod.toLowerCase())) r.push('repo');
  if ((e.nsPublished ?? []).length > 0) r.push(`ns(${e.nsPublished.length})`);
  if ((e.notes ?? []).some(n => /ontologies\//.test(n))) r.push('ns-fallback');
  if ((e.inboxCount ?? 0) > 0) r.push(`inbox(${e.inboxCount})`);
  if ((e.credentialCount ?? 0) > 0) r.push(`credential(${e.credentialCount})`);
  if (e.rootStatus !== 200) r.push(`unread(root ${e.rootStatus})`);
  if (e.manifestStatus === 200 && e.manifestEntries === -1) r.push('unread(manifest too large)');
  if ((e.notes ?? []).some(n => /manifest GET ->|collector error/.test(n))) r.push('unread(probe failed)');
  // ★ BOTH CLOCKS. `newestActivity` is the newest iep:validFrom the pod PUBLISHED; `rootModified`
  // is when CSS last wrote the container at all. A pod written to nine days ago that published
  // nothing has no validFrom and would sail through a ten-day gate on the first clock alone —
  // six did. Whichever is newer decides.
  for (const [label, stamp] of [['recent', e.newestActivity], ['recent-write', e.rootModified]]) {
    if (!stamp) continue;
    const age = (NOW - Date.parse(stamp)) / 86400000;
    if (Number.isFinite(age) && age < RECENT_DAYS) r.push(`${label}(${age.toFixed(1)}d)`);
  }
  return r;
}

const direct = new Map();
for (const e of ev) direct.set(e.pod, keepReasons(e));

// ── twin closure: if either spelling of one wallet is kept, keep both ────────────────────────
// Applied AFTER the direct pass and over the direct results only, so it cannot cascade: a twin
// keeps its partner, but a twin-kept pod does not go on to keep anything else.
const finalKeep = new Map();
for (const e of ev) {
  const reasons = [...(direct.get(e.pod) ?? [])];
  const t = twinOf(e.pod);
  if (t && byPod.has(t) && (direct.get(t) ?? []).length > 0) reasons.push(`twin(${t}: ${direct.get(t).join(',')})`);
  finalKeep.set(e.pod, reasons);
}

const keep = [];
const candidates = [];
for (const e of ev) {
  const reasons = finalKeep.get(e.pod) ?? [];
  if (reasons.length > 0) keep.push({ pod: e.pod, reasons });
  else candidates.push(e);
}

// Tally why things were kept, so the shape of the decision is visible rather than buried.
const why = {};
for (const k of keep) for (const r of k.reasons) {
  const key = r.replace(/\(.*\)$/, '');
  why[key] = (why[key] || 0) + 1;
}

candidates.sort((a, b) => a.pod.localeCompare(b.pod));
writeFileSync(outFile, JSON.stringify(candidates.map(c => c.pod), null, 0), 'utf8');
if (reportFile) {
  writeFileSync(reportFile, JSON.stringify({
    now: new Date(NOW).toISOString(), recentDays: RECENT_DAYS,
    total: ev.length, kept: keep.length, candidateCount: candidates.length,
    keptBecause: why,
    keep: keep.sort((a, b) => a.pod.localeCompare(b.pod)),
    candidates: candidates.map(c => ({
      pod: c.pod, children: c.children, descriptorCount: c.descriptorCount,
      manifestEntries: c.manifestEntries, manifestBytes: c.manifestBytes,
      newestActivity: c.newestActivity, agentClients: c.agentClients,
    })),
  }, null, 2), 'utf8');
}

console.log(`${ev.length} pod(s): ${keep.length} KEEP, ${candidates.length} CANDIDATE`);
console.log('kept because:');
for (const [k, v] of Object.entries(why).sort((a, b) => b[1] - a[1])) console.log(`  ${k.padEnd(14)} ${v}`);
console.log(`\ncandidates -> ${outFile}`);
if (reportFile) console.log(`full report -> ${reportFile}`);
