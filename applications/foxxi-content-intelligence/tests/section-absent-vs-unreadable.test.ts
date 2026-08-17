/**
 * "The section is not there" vs "I could not read the section".
 *
 * ── ★★ WHY THIS FILE EXISTS ────────────────────────────────────────────────────────────────
 *
 * `fetchSection` THROWS for a section that has never been published, which makes absent and
 * unreadable look identical to a caller that only catches. Collapsing them is a real defect in BOTH
 * directions, and both shipped here within one deploy of each other:
 *
 *   - Treating every rejection as EMPTY: the mesh enrolment register is a whole-array publish, so
 *     one transient 502 on the read turned the next enrolment into a full replacement that silently
 *     un-enrolled every other agent, durably, while telling that caller `durable: true`.
 *   - Treating every rejection as a FAILURE: the first-ever enrolment then refused to write "because
 *     the register could not be read", so the section was never created and every enrolment fell
 *     back to session scope. A bootstrap deadlock that reads exactly like a permissions problem.
 *
 * The predicate is deliberately conservative: only the explicit not-found shape is absent, because a
 * caller that WRITES must treat anything unknown as a refusal.
 */

import { describe, it, expect } from 'vitest';
import { isSectionAbsentError, SECTION_ABSENT_PREFIX } from '../src/tenant-fetcher.js';

describe('a never-published section is ABSENT', () => {
  it('recognizes the exact message fetchSection throws', () => {
    const thrown = new Error(`${SECTION_ABSENT_PREFIX}https://example.test/ns/foxxi#MeshEnrolmentRegister found in pod https://gate.example.test/foxxi/. Tenant publish required first.`);
    expect(isSectionAbsentError(thrown)).toBe(true);
  });

  it('works on a bare string rejection as well as an Error', () => {
    expect(isSectionAbsentError(`${SECTION_ABSENT_PREFIX}x found in pod y.`)).toBe(true);
  });
});

describe('★ everything else is UNREADABLE, and a writer must refuse', () => {
  it('a transport or upstream failure is NOT absent', () => {
    for (const e of [
      new Error('502 Bad Gateway'),
      new Error('fetch failed'),
      new Error('The operation was aborted due to timeout'),
      new Error('ECONNREFUSED 10.0.0.5:443'),
      new Error('Unexpected token < in JSON at position 0'),
    ]) expect(isSectionAbsentError(e)).toBe(false);
  });

  it('an encrypted section with no key is NOT absent — it exists and we simply cannot read it', () => {
    expect(isSectionAbsentError(new Error('admin-only section is encrypted and no adminKeyPair was supplied'))).toBe(false);
  });

  it('undefined / null / empty rejections are NOT absent', () => {
    expect(isSectionAbsentError(undefined)).toBe(false);
    expect(isSectionAbsentError(null)).toBe(false);
    expect(isSectionAbsentError(new Error(''))).toBe(false);
  });

  it('★ the phrase appearing LATER in an unrelated message does not count as absent', () => {
    // Anchored at the start on purpose: an upstream error that happens to quote our own wording back
    // at us (a proxy echoing a body, a wrapped cause) must not be read as "safe to overwrite".
    expect(isSectionAbsentError(new Error(`upstream 500 while handling: ${SECTION_ABSENT_PREFIX}x found in pod y.`))).toBe(false);
  });
});
