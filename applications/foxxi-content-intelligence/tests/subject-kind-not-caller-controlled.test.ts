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

  it('a shared classifier exists and reads the subject own statements', () => {
    const fn = server.slice(
      server.indexOf('function subjectKindFromOwnEvidence'),
      server.indexOf('function subjectKindFromOwnEvidence') + 900,
    );
    expect(fn.length, 'helper not found').toBeGreaterThan(0);
    expect(fn, 'must read the kind the SUBJECT declared, not the caller').toMatch(/PERF_EXT\.actorKind/);
  });

  it('the classifier fails closed', () => {
    const fn = server.slice(
      server.indexOf('function subjectKindFromOwnEvidence'),
      server.indexOf('function subjectKindFromOwnEvidence') + 900,
    );
    // 'agent' requires positive evidence AND no contradicting human evidence.
    expect(fn).toMatch(/declared\.has\('agent'\)\s*&&\s*!declared\.has\('human'\)/);
    // …and the fallback is the private class.
    expect(fn).toMatch(/\?\s*'agent'\s*:\s*'human'/);
  });

  it('every privacy gate uses the shared classifier', () => {
    const uses = server.match(/subjectKindFromOwnEvidence\(/g) ?? [];
    // one definition + three call sites
    expect(uses.length, `found ${uses.length}`).toBeGreaterThanOrEqual(4);
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
