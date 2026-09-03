/**
 * The mutation table's own rule, as a check instead of a sentence.
 *
 * ── WHAT WAS ONLY PROSE ─────────────────────────────────────────────────────
 *
 * `tools/mutation-gate.data.mjs` opens with "Adding a gate means adding a mutant here. That is
 * the point: a gate arrives with the defect it claims to catch, and the harness proves the claim
 * rather than taking it." Nothing enforced it, and an adversarial pass observed the predictable
 * result: a new census leg was already in the tree with no mutant behind it.
 *
 * ── WHAT THIS CAN AND CANNOT DO, STATED ─────────────────────────────────────
 *
 * It CANNOT require a mutant per `it()`. Most of this suite's ~350 modules assert ordinary
 * behaviour and a mutant for each would be noise, not coverage — the harness is for gates whose
 * failure mode is silently passing, and deciding which those are is a judgement.
 *
 * What it CAN do, and what actually failed here, is ratchet: the number of distinct gate files
 * the table drives may not FALL, and every gate file it names must exist. Both are the ways the
 * rule decays in practice — a gate deleted while its mutant is left behind (the table then fails
 * loudly, which is fine), or mutants quietly dropped so the table covers less than it did (which
 * is silent, and is what this catches).
 *
 * The floor is written down and is meant to RISE. Raising it is the act of adding a gate with
 * its mutant; nothing else should touch it.
 */
import { describe, it, expect } from 'vitest';
import { existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { MUTANTS } from '../tools/mutation-gate.data.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

/**
 * Distinct gate files the table drives.
 *
 * ★ 23 measured 2026-09-03. This is a FLOOR: it rises when a gate arrives with its mutant, and
 * a fall means mutants were dropped and the harness now proves less than it did. It is not a
 * coverage log — do not lower it to make a run green.
 *
 * It sits ON the measured number rather than below it, deliberately. A floor with slack lets one
 * gate's mutants be dropped in silence, which is the exact failure this leg exists to catch; the
 * cost of no slack is that adding a gate means editing this line, and that edit is the point.
 */
const MIN_GATE_FILES = 23;

describe('a gate arrives with a mutant', () => {
  const gateFiles = [...new Set(MUTANTS.flatMap((m) => m.mustFail as string[]))];

  it('the table parses and names gates at all', () => {
    // Guards the guard: an empty table satisfies every assertion below.
    expect(MUTANTS.length, 'the mutation table is empty').toBeGreaterThan(30);
    expect(gateFiles.length, 'no gate files named by any mutant').toBeGreaterThan(5);
  });

  it('★ every gate the table names exists on disk', () => {
    // A mutant pointing at a deleted gate is a mutant that can never be caught for the right
    // reason — the harness would report it INCONCLUSIVE and the cause would read as a
    // compilation problem rather than a missing file.
    const missing = gateFiles.filter((f) => !existsSync(join(ROOT, f)));
    expect(
      missing,
      'these gate files are named by a mutant and are not in the tree:\n  ' + missing.join('\n  '),
    ).toEqual([]);
  });

  it('★ the number of gate files the table drives does not fall', () => {
    expect(
      gateFiles.length,
      `the mutation table drives ${gateFiles.length} gate file(s), below the floor of `
        + `${MIN_GATE_FILES}. Mutants have been dropped, so the harness now proves less than it `
        + 'did — which is silent, unlike a stale anchor. Raise the floor only when a gate arrives '
        + `WITH its mutant.\n  currently: ${gateFiles.sort().join('\n  ')}`,
    ).toBeGreaterThanOrEqual(MIN_GATE_FILES);
  });

  it('★ every mutant names a gate, a file, and a defect it claims to catch', () => {
    const malformed = MUTANTS
      .filter((m) => !m.name || !m.file || !m.find || m.replace === undefined
        || !Array.isArray(m.mustFail) || m.mustFail.length === 0 || !m.why)
      .map((m) => String(m.name ?? '(unnamed)'));
    expect(
      malformed,
      'a mutant with no `why` is a defect nobody can evaluate, and one with no `mustFail` is '
        + 'applied against nothing:\n  ' + malformed.join('\n  '),
    ).toEqual([]);
  });
});
