/**
 * A reader may not decide what KIND of subject someone else is.
 *
 * ★ WHY. Agent capability records are public — an agent is infrastructure you must be
 * able to audit. Human learner records are private. Three routes chose between those
 * two regimes from a REQUEST field:
 *
 *     ((p.actor_kind as string) === 'agent' && /^did:(ethr|web|key|pkh):/.test(subjectDid))
 *
 * so the caller picked which rule applied to somebody else. Confirmed against the
 * deployed bridge with two unrelated self-sovereign identities, neither an admin:
 *
 *     actor_kind: 'human'  ->  REFUSED
 *     actor_kind: 'agent'  ->  READ: n=5, task names disclosed
 *
 * The comment defending it said a human learner is a "directory WebId" and therefore
 * cannot be passed off as a wallet DID. That holds for the legacy directory tenant and
 * misses the primary case: a SELF-SOVEREIGN human's identity IS a did:ethr:, which is
 * the identity model everything else in this system uses. The guard protected the rare
 * shape and left the common one open.
 *
 * Same class as the credential-forgery fix (#168): a caller-supplied field deciding an
 * authority outcome about someone else. Both times the fix is the same shape — bind the
 * decision to something the SUBJECT controls.
 *
 * A subject already declares what it is, in its own signed statements
 * (PERF_EXT.actorKind, written from the performer's own authenticated call). That is
 * the only declaration that counts, and it fails closed: no evidence means private.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const server = readFileSync(join(ROOT, 'bridge', 'server.ts'), 'utf8');

describe('subject classification is not caller-controlled', () => {
  it('no route derives subjectKind from actor_kind on the request', () => {
    // The exact expression that shipped, at three separate sites.
    expect(server).not.toMatch(/actor_kind as string\)\s*===\s*'agent'\s*&&\s*\/\^did:/);
  });

  /**
   * ★ THE BODY, NOT A FIXED-SIZE WINDOW. This used to slice 900 characters from the function's
   * start, which silently measures the DOCSTRING as much as the code — so adding an explanation
   * pushed the logic out of view and the assertion began failing for a reason that had nothing to
   * do with the behaviour it guards. Read from the signature to the closing brace instead.
   */
  const classifierBody = (): string => {
    const at = server.indexOf('function subjectKindFromOwnEvidence');
    expect(at, 'helper not found').toBeGreaterThan(-1);
    const rest = server.slice(at);
    const end = rest.indexOf('\n}\n');
    return end < 0 ? rest : rest.slice(0, end + 3);
  };

  it('a shared classifier exists and reads the subject own statements', () => {
    const fn = classifierBody();
    expect(fn.length, 'helper not found').toBeGreaterThan(0);
    expect(fn, 'must read the kind the SUBJECT declared, not the caller').toMatch(/PERF_EXT\.actorKind/);
    // ★ And that the evidence is ABOUT the subject: a pod hosts its delegates' statements too, and
    // counting those made a person's record read as an agent's — which is public.
    expect(fn, 'must check the statement actor IS the subject').toMatch(/actor[\s\S]*account/);
  });

  it('the classifier fails closed', () => {
    const fn = classifierBody();
    // 'agent' requires positive evidence AND no contradicting human evidence.
    expect(fn).toMatch(/declared\.has\('agent'\)\s*&&\s*!declared\.has\('human'\)/);
    // …and the fallback is the private class.
    expect(fn).toMatch(/\?\s*'agent'\s*:\s*'human'/);
  });

  it('every privacy gate uses the shared classifier', () => {
    /**
     * ★ THIS USED TO COUNT `subjectKindFromOwnEvidence(` CALL SITES AND EXPECT FOUR — one
     * definition plus three gates. That was a PROXY for "every gate shares the decision", and the
     * proxy broke the moment the decision genuinely became shared: the three gates now call
     * `classifySubjectKind`, which calls `subjectKindFromOwnEvidence` once, so the count fell to two
     * while the property it stood for got strictly stronger.
     *
     * The count was also never the property. Three call sites can each read the same helper and
     * still disagree about what to do with the answer — which is exactly what happened:
     * `assemble_learner_record` honoured `actor_kind` for a SELF review while the other two
     * hard-coded `isSelf ? 'human'`, so a delegate reviewing itself was filed as a human whatever
     * its own evidence said. A live delegate reported it. Every site called the helper; the counter
     * was green throughout.
     *
     * So assert the property: each gate goes through the ONE classifier, and that classifier is the
     * only thing that consults the raw evidence reader.
     */
    const codeLines = server.split('\n').filter(l => !/^\s*(\/\/|\*|\/\*)/.test(l));

    const assignments = codeLines.filter(l => /const subjectKind\s*=/.test(l));
    expect(assignments.length, `expected the three privacy gates, found ${assignments.length}`)
      .toBeGreaterThanOrEqual(3);
    for (const line of assignments) expect(line).toMatch(/classifySubjectKind\(/);

    // Exactly one reader of the raw evidence helper: the shared classifier itself.
    const rawReads = codeLines.filter(l => /subjectKindFromOwnEvidence\(/.test(l) && !/^function /.test(l.trim()));
    expect(rawReads.length, `raw evidence reader called from ${rawReads.length} place(s); expected only the shared classifier`)
      .toBe(1);
  });

  it('all three routes still refuse a non-self human record', () => {
    const refusals = server.match(/a human learner record is private|only assemble their own human learner record/g) ?? [];
    expect(refusals.length, 'the gates themselves must still be present').toBeGreaterThanOrEqual(3);
  });

  it('the refusal explains that the request field is not what decides', () => {
    const details = server.match(/classification comes from the subject own signed statements/g) ?? [];
    expect(details.length, 'a caller retrying with a different actor_kind should be told why not')
      .toBeGreaterThanOrEqual(3);
  });
});
