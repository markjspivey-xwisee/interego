/**
 * A declared capability that is not implemented must say so in its result.
 *
 * ★ WHY. Five handlers returned a success-shaped body for work they never did:
 *
 *     foxxi.explore_concept_map         -> { concepts: [], edges: [], note: 'stub: …' }
 *     foxxi.consume_lesson              -> { consumed: false, note: 'stub: …' }
 *     foxxi.connect_lms                 -> { note: 'stub: …' }
 *     foxxi.publish_concept_map         -> { note: 'stub: …' }
 *     foxxi.publish_compliance_evidence -> { note: 'stub: …' }
 *
 * All HTTP 200, none carrying an `error`, so a caller checking for failure the normal
 * way saw success. explore_concept_map was probed live in four configurations —
 * unauthenticated, signed, against a real ingested course, and by course_id — and
 * returned the identical empty graph every time. A consumer reads that as "this course
 * has no concepts", which is a different and wrong answer.
 *
 * The two `publish_*` names are the sharp end. A caller has every reason to believe a
 * write happened, and for publish_compliance_evidence that belief is the kind an audit
 * later rests on.
 *
 * Keeping them declared is fine — the affordance is real planned work and a manifest
 * that says what is coming is useful. Answering as though the work happened is not.
 * Same rule as the refused-statement fix: never report success for something that did
 * not occur.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { foxxiAffordances, foxxiAdminAffordances } from '../affordances.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const server = readFileSync(join(ROOT, 'bridge', 'server.ts'), 'utf8');
const ALL = [...foxxiAffordances, ...foxxiAdminAffordances];

describe('a declared-but-unimplemented capability answers honestly', () => {
  it('no handler returns a success-shaped stub body', () => {
    // The exact marker the five stubs shared. Its absence is the invariant.
    expect(server).not.toMatch(/note: 'stub: bridge handler not yet wired/);
  });

  it('unimplemented handlers route through one honest helper', () => {
    const calls = server.match(/return notImplemented\(/g) ?? [];
    expect(calls.length, 'expected the five known stubs to use it').toBeGreaterThanOrEqual(5);
  });

  it('the helper produces an error a caller can branch on', () => {
    const fn = server.slice(server.indexOf('function notImplemented'), server.indexOf('function notImplemented') + 700);
    expect(fn).toMatch(/error:/);
    expect(fn).toMatch(/implemented: false/);
    expect(fn, 'the message must say nothing happened, not merely that it is a stub')
      .toMatch(/nothing was read, written or emitted/i);
  });

  it('the write-shaped stubs say plainly that nothing was written', () => {
    for (const tool of ['foxxi.publish_concept_map', 'foxxi.publish_compliance_evidence']) {
      const idx = server.indexOf(`'${tool}'`);
      expect(idx, `${tool} handler not found`).toBeGreaterThan(-1);
      const body = server.slice(idx, idx + 900);
      expect(body, `${tool} must not let a caller believe a write happened`)
        .toMatch(/NOTHING WAS PUBLISHED|NO COMPLIANCE EVIDENCE WAS RECORDED/);
    }
  });

  // ── Descriptions must not promise behaviour that is not wired ────────────
  //
  // Two were tested directly rather than read: derive_adaptive_policy claimed
  // policies "downstream learners can be gated on" — the only per-learner gate tool
  // returns the same decision with and without one. register_tutor_agent claimed to
  // publish a descriptor "on the agent's own pod" — the pod is untouched.
  it('derive_adaptive_policy does not claim to gate anything', () => {
    const a = ALL.find(x => x.toolName === 'foxxi.derive_adaptive_policy');
    expect(a).toBeTruthy();
    expect(a!.description).not.toMatch(/can be gated on/);
    expect(a!.description, 'a reader must learn it is advisory before calling it').toMatch(/NOT ENFORCED/);
  });

  it('register_tutor_agent does not claim a pod write it does not perform', () => {
    const a = ALL.find(x => x.toolName === 'foxxi.register_tutor_agent');
    expect(a).toBeTruthy();
    expect(a!.description).not.toMatch(/^Publishes a fxa:TutorAgentProfile descriptor on/);
    expect(a!.description).toMatch(/WRITES NOTHING/);
    expect(a!.description, 'the identity caveat is the load-bearing part')
      .toMatch(/not bound to any signer/i);
  });
});
