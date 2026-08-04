/**
 * Docs-vs-reality gate for the DKG / trusted-dealer disposition.
 *
 * WHY THIS FILE EXISTS — the concrete failure it prevents:
 * docs/AGGREGATE-PRIVACY-MODES.md simultaneously said, 36 lines apart, "Full multi-party
 * threshold reveal with no trusted dealer (DONE in v5)" and "DKG is not yet shipped" —
 * while packages/core/src/crypto/dkg.ts had been on disk with 13 passing contract tests.
 * STATUS.md contradicted itself in adjacent rows of one table: one called DKG-wiring "a
 * fresh protocol research effort, not a wiring step", the next called it "the next v4
 * step". Both documents grow by APPENDING a row per increment, and their global closing
 * summaries were written when v4-partial was the top of the ladder and never re-derived.
 * A reader deciding whether to wait for DKG got the wrong answer from three of four sites.
 *
 * Prose has no compiler. This is the compiler: shipped-ness is read off the filesystem and
 * the module's real exports, and the prose is then required not to contradict it.
 */
import { describe, expect, it } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { dkgRound1, dkgRound2, dkgRound3, simulateDKG } from '@interego/core';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const DKG_SOURCE = 'packages/core/src/crypto/dkg.ts';

/** The two documents that carry a claim about DKG's availability. */
const CLAIMING_DOCS = ['docs/AGGREGATE-PRIVACY-MODES.md', 'STATUS.md'] as const;

/**
 * Phrasings that assert DKG has NOT shipped. Enumerated rather than a loose /DKG.*not/ so
 * the gate names exactly what it forbids and a failure tells the author which sentence to
 * rewrite. This is a drift-catcher for the wordings that actually rotted, not a proof that
 * no unshipped-claim can ever be phrased — see the module comment.
 */
const STALE_UNSHIPPED_CLAIMS = [
  /DKG[^.]{0,400}not yet shipped/i,
  /DKG\s+(is\s+)?still\s+future/i,
] as const;

/** The disposition both documents must state, in the words the gate checks. */
const DISPOSITION = 'decided against, not deferred';

const read = (rel: string): string => readFileSync(resolve(REPO_ROOT, rel), 'utf8');

describe('docs: the DKG / trusted-dealer disposition matches the shipped code', () => {
  it('the DKG primitive is on disk and every round the docs name is exported', () => {
    // Anchors the gate to the CODE. If dkg.ts is deleted or a round is renamed, the docs'
    // "the primitive is on disk" claim becomes false and this fails first — the assertion
    // is not a tautology over two markdown files agreeing with each other.
    expect(existsSync(resolve(REPO_ROOT, DKG_SOURCE))).toBe(true);
    for (const fn of [dkgRound1, dkgRound2, dkgRound3, simulateDKG]) {
      expect(typeof fn).toBe('function');
    }
  });

  it('no document claims DKG is unshipped while the module is on disk', () => {
    const offenders: string[] = [];
    for (const rel of CLAIMING_DOCS) {
      const text = read(rel);
      for (const pattern of STALE_UNSHIPPED_CLAIMS) {
        const hit = pattern.exec(text);
        if (hit !== null) offenders.push(`${rel}: ${hit[0]}`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it('both documents state the disposition explicitly', () => {
    // "Deferred" and "decided against" are different answers for a reader planning around
    // the caveat. The docs must pick one and say which; this pins that they said it.
    for (const rel of CLAIMING_DOCS) {
      expect(read(rel).toLowerCase()).toContain(DISPOSITION);
    }
  });
});
