/**
 * AN AGENT ENROLLED A POD THAT DOES NOT EXIST, THREE TIMES, AND WAS TOLD IT WORKED THREE TIMES.
 *
 * ── ★★ THE MEASUREMENT ──────────────────────────────────────────────────────────────────────
 *
 * An agent enrolled `https://gate.interego.xwisee.com/eth-42c2ffd7e4c0/` with no pod_url, with the
 * internal spelling, and with the public one. All three returned 200. It appeared in the public
 * register as `durable`, and reported that to a colleague on the record as evidence a twin-spelling
 * fix had landed. `curl` on the pod root: 404. It had never been created. The agent's real pod is
 * the `u-eth-` twin; a bare `did:ethr:` signature derives the `eth-` spelling, and the identity
 * service creates the other one.
 *
 * Fifty minutes later the prune retired the row for 404ing, which was CORRECT — and because a
 * retirement was published as the row's ABSENCE, the sequence read as the register losing a row.
 * Two hours went into the wrong explanation, and the colleague's audit was conducted against a pod
 * that was never there.
 *
 * ★ THREE SEPARATE THINGS HAD TO BE TRUE AT ONCE, and every one of them is a "correct answer to the
 * wrong question" of the kind this codebase keeps producing:
 *
 *   1. selfBoundPod compared LABELS, so a caller naming its own real pod was refused and handed a
 *      derived one that does not exist. Fifth site of the eth-/u-eth- class.
 *   2. Enrolment never asked whether the pod was there. One GET, at the only moment anybody is
 *      listening, and the whole thing ends in a sentence.
 *   3. The prune probed the MANIFEST, not the pod root, so its predicate was "no descriptors" while
 *      its documentation said "no pod" — which retires a brand-new agent by definition.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const src = readFileSync(join(
  dirname(fileURLToPath(import.meta.url)),
  '..', 'applications', 'foxxi-content-intelligence', 'bridge', 'server.ts',
), 'utf8');
const code = src.split('\n').filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l));

/** A named function's body, signature to closing brace. */
function body(name: string): string {
  const at = src.indexOf(name);
  expect(at, `${name} not found`).toBeGreaterThan(-1);
  const rest = src.slice(at);
  const end = rest.indexOf('\n}\n');
  return end < 0 ? rest : rest.slice(0, end + 3);
}

describe('1. a caller may name either spelling of its OWN pod', () => {
  it('selfBoundPod compares principals, not the label the actor table produces', () => {
    const fn = body('function selfBoundPod');
    expect(fn, 'must fold the twin spellings').toMatch(/samePodPrincipal\(override, derived\)/);
    // The label comparison, in the exact shape that refused a caller its own real pod.
    expect(fn, 'must not decide this on actorForPod')
      .not.toMatch(/actorForPod\(override[\s\S]{0,80}===[\s\S]{0,40}actorForPod\(derived/);
  });

  it('and the origin bound is untouched, so the fold reaches no further than the twin', () => {
    const fn = body('function selfBoundPod');
    // podPrincipalKey strips a leading `u-` and nothing else, so it can only ever equate one
    // caller's two spellings of itself — and sameStore still pins the override to this store.
    expect(fn).toMatch(/sameStore\(override, derived\)/);
  });
});

describe('2. ★ enrolment refuses a pod that is not there, and names the one that is', () => {
  it('presence is probed before the register is written', () => {
    expect(code.some((l) => /const presence = await podPresence\(pod\)/.test(l))).toBe(true);
    expect(code.some((l) => /if \(presence === 'absent'\)/.test(l))).toBe(true);
  });

  it('the refusal carries the spelling that DOES exist, because that is the whole fix', () => {
    // Without this the caller learns only that its pod is missing, which is the state it was
    // already in and cannot act on — the sibling is the sentence that ends the investigation.
    expect(code.some((l) => /siblingPodSpelling\(pod\)/.test(l))).toBe(true);
    expect(src).toMatch(/podThatDoesExist/);
  });

  it('★ and only a hard 404/410 counts as absent — everything else fails OPEN', () => {
    const fn = body('async function podPresence');
    expect(fn).toMatch(/status === 404 \|\| r\.status === 410/);
    // A 5xx, a timeout or a DNS blip must never stop a real agent enrolling. Same discipline as
    // the prune, in the opposite direction.
    expect(fn).toMatch(/catch \{ return 'unknown'; \}/);
    // 401/403 mean there IS a pod here that we may not read the root of.
    expect(fn).toMatch(/return 'present'/);
  });
});

describe('3. the prune asks whether the POD is gone, not whether it is empty', () => {
  it('absence is probed at the pod root', () => {
    expect(code.some((l) => /await podPresence\(pod\)\) === 'absent'\) absentThisCycle\.add\(pod\)/.test(l))).toBe(true);
  });

  it('★ and no longer at the manifest, which 404s for every agent that has not written yet', () => {
    // The predicate said "no manifest" while the comment above it said "no pod". A new agent is in
    // that state by definition, so the retirement fired hardest on whoever had done least.
    expect(code.some((l) => /well-known\/context-graphs.*probe|probe.*well-known\/context-graphs/.test(l)),
      'the manifest probe must be gone from the prune path').toBe(false);
  });
});

describe('and the published contract says all of it, because a comment nobody can GET is not one', () => {
  it('the enrol control describes the rule it actually applies', () => {
    const at = src.indexOf('Enrol the pod you can prove is yours');
    expect(at).toBeGreaterThan(-1);
    const published = src.slice(at, at + 2000);
    // It described the trap that had been removed: "the same actor and origin".
    expect(published, 'the stale actor/origin sentence must be gone').not.toMatch(/the same actor and origin/);
    expect(published, 'the principal fold must be published').toMatch(/SAME PRINCIPAL/);
    expect(published, 'and so must the refusal for a pod that is not there').toMatch(/does not exist is REFUSED/);
    expect(published, 'and that empty is never a reason to retire').toMatch(/never for being empty/);
  });

  it('★ and "durable" travels with the condition that ends it', () => {
    // An agent read `durable: true` as "permanent", said so on the record, and was retired four
    // hours later. Durability describes surviving a RESTART; nothing said how else a row ends.
    expect(src).toMatch(/retirementRule/);
    expect(src).toMatch(/nextCheckWithinMs/);
  });
});
