/**
 * WHAT THE SUBJECT IS GETS DECIDED IN EXACTLY ONE PLACE.
 *
 * `subjectKind` chooses whether a record is public (agent capability records are infrastructure)
 * or private (human learner records), and downstream routing reads it — the regime router
 * gap-analyses humans, so a misfiled agent gets the human treatment.
 *
 * ★ THREE SURFACES ASKED THE QUESTION AND THEY DID NOT AGREE. `foxxi.assemble_learner_record`
 * derived it properly; `POST /agent/review-record` and the verify route hard-coded
 * `isSelf ? 'human'`, so a delegate reviewing ITSELF was reported as human regardless of its own
 * signed evidence and regardless of the `actor_kind` it passed. A live delegate caught it and named
 * it precisely: "subjectKind and kind still say human for a delegate agent … advisory options
 * really are advisory."
 *
 * That is the same shape as the supersession bug earlier in this codebase: one rule, several
 * implementations, and the fix applied to only some of them is a no-op in production. So what is
 * pinned here is not the classification logic (one function, easy to read) but the SINGLE-DECIDER
 * property, which is the thing a future edit can silently break.
 *
 * Source-level, because `bridge/server.ts` starts an HTTP listener at import and cannot be loaded
 * into a test process. Stated rather than papered over.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const SERVER = join(
  dirname(fileURLToPath(import.meta.url)),
  '..', 'applications', 'foxxi-content-intelligence', 'bridge', 'server.ts',
);
const src = readFileSync(SERVER, 'utf8');
const codeLines = src.split('\n').filter(l => !/^\s*(\/\/|\*|\/\*)/.test(l));

describe('subjectKind has exactly one decider', () => {
  it('no surface hard-codes a self-review as human', () => {
    // The exact regression the delegate found. A comment may DESCRIBE it; no code may DO it.
    const offenders = codeLines.filter(l => /isSelf\s*\?\s*'human'/.test(l));
    expect(offenders).toEqual([]);
  });

  it('every subjectKind assignment goes through classifySubjectKind', () => {
    const assignments = codeLines.filter(l => /const subjectKind\s*=/.test(l));
    expect(assignments.length).toBeGreaterThanOrEqual(3);
    for (const line of assignments) expect(line).toMatch(/classifySubjectKind\(/);
  });

  it('★ and for ANOTHER subject the caller hint is not consulted at all', () => {
    // The security property. `actor_kind` is a caller-supplied field, and agent records are public
    // while human records are private — so trusting it about SOMEONE ELSE let any signed wallet
    // declare a human to be an agent and read them. Non-self must return the evidence verdict
    // before the hint is ever reached.
    const body = src.slice(src.indexOf('function classifySubjectKind'));
    const fn = body.slice(0, body.indexOf('\n}\n') + 3);
    const guard = fn.indexOf('if (!opts.isSelf) return fromEvidence;');
    const hint = fn.indexOf('actorKindHint');
    expect(guard).toBeGreaterThan(-1);
    // The early return must come BEFORE any use of the hint in the function body.
    expect(guard).toBeLessThan(fn.indexOf('opts.actorKindHint'));
    expect(hint).toBeGreaterThan(-1);
  });

  it('and own evidence still wins over the hint, even for self', () => {
    const body = src.slice(src.indexOf('function classifySubjectKind'));
    const fn = body.slice(0, body.indexOf('\n}\n') + 3);
    // A subject whose own signed statements say `agent` is an agent whatever the request claimed —
    // the hint is only a tiebreak for a self-review with no evidence either way.
    expect(fn).toMatch(/if \(fromEvidence === 'agent'\) return 'agent';/);
  });
});
