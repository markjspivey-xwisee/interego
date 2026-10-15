/**
 * Advertised directory operations must have implementations and answer through their authenticated
 * production adapter. Behavioral tests in directory-actions.test.ts exercise ECDSA proof, source
 * hydration, encryption, actual Solid transport/readback and honest reported-event semantics.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { foxxiAffordances, foxxiAdminAffordances } from '../affordances.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const server = readFileSync(join(ROOT, 'bridge', 'server.ts'), 'utf8');
const ALL = [...foxxiAffordances, ...foxxiAdminAffordances];

describe('declared directory capabilities are implemented honestly', () => {
  it('does not retain any named notImplemented stubs or success-shaped stub bodies', () => {
    expect(server).not.toMatch(/return notImplemented\(/);
    expect(server).not.toMatch(/note: 'stub: bridge handler not yet wired/);
  });
  it.each(['consume_lesson', 'connect_lms', 'publish_concept_map', 'publish_compliance_evidence'])('%s reaches the authenticated production implementation', tool => {
    const idx = server.indexOf("'foxxi." + tool + "': async");
    expect(idx).toBeGreaterThan(-1);
    const after = server.indexOf("\n  'foxxi.", idx + 1);
    expect(after).toBeGreaterThan(idx);
    const body = server.slice(idx, after);
    expect(body).toContain("directoryActions.run('" + tool + "'");
    expect(body).not.toMatch(/notImplemented\(/);
  });
  it('explore_concept_map continues to read the actual pod package', () => {
    const idx = server.indexOf("'foxxi.explore_concept_map': async");
    expect(idx).toBeGreaterThan(-1);
    const after = server.indexOf("\n  'foxxi.", idx + 1);
    const body = server.slice(idx, after);
    expect(body).toMatch(/autoFetchCourse\(/);
    expect(body).toMatch(/buildConceptNavGraph\(/);
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

describe('a signed lesson can reach a whole rota', () => {
  it('the teaching replay key includes the learner', () => {
    // The teacher signs { teachingPackage, targetBehaviour } — the lesson, with nothing
    // about who receives it. Keying the replay guard on the signature alone meant a
    // signed lesson could be delivered exactly once, ever: teaching the same thing to a
    // second agent returned { recorded: false, duplicate: true }, which is the normal
    // case on a team and not an attack.
    const routes = readFileSync(join(ROOT, '..', 'agentic-performance-practice', 'compatibility', 'foxxi-performance-routes.ts'), 'utf8');
    expect(routes).toMatch(/noteOutcomeSig\(`\$\{teacherSignature\}\|\$\{learner\.id\}`\)/);
    // …and the guard is still there: same lesson, same learner, still once.
    expect(routes).toMatch(/duplicate: true/);
  });
});
