/**
 * The gated auto-merge decision: every condition on its own, all of them together, and the
 * two modes — a person required, or not.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { AUTO_MERGE_POLICY, AUTO_MERGED_LABEL, autoMergeDecision, reviewVerdictEvidence, waitWordsFromArgv } from '../src/auto-merge.js';

const earned = { cells: [{ kind: 'navigation', liveSamples: 3 }, { kind: 'review-verdict', liveSamples: 25, liveAgreement: { agree: 23, conservative: 1, disagree: 1 } }] };
const all = { verdict: 'auto-ok', selectionResult: 'success', armed: true, tokenPresent: true, calibration: earned, mergeable: 'MERGEABLE', base: { tested: 'aaaaaaaa1', current: 'aaaaaaaa1' }, suite: { result: 'success', gates: true }, checks: { result: 'success', gates: true } };
const withPerson = { ...all, requireHumanReview: true, reputation: { axes: { accuracy: 0.92, competence: 0.7 }, contributing: 1 } };

describe('the evidence', () => {
  it('reads live agreement from the review-verdict cell, null before any person decided', () => {
    expect(reviewVerdictEvidence(earned)).toEqual({ liveSamples: 25, agreeRate: 0.92, disagreeRate: 0.04 });
    expect(reviewVerdictEvidence({ cells: [{ kind: 'review-verdict', liveSamples: 4 }] })).toEqual({ liveSamples: 4, agreeRate: null, disagreeRate: null });
    expect(reviewVerdictEvidence(undefined)).toEqual({ liveSamples: 0, agreeRate: null, disagreeRate: null });
  });
});

describe('without a person required (the default)', () => {
  it('merges on armed, token, green tests, any verdict but block, a mergeable branch, a fresh base, a green suite and every other check green — eight conditions, no calibration bar', () => {
    const d = autoMergeDecision(all);
    expect(d.merge).toBe(true);
    expect(d.reasons).toHaveLength(8);
    expect(d.reasons[3]).toContain('needs-human-review is advisory');
    const advisory = autoMergeDecision({ ...all, verdict: 'needs-human-review', calibration: undefined });
    expect(advisory.merge).toBe(true);
    expect(advisory.reasons[3]).toContain('verdict needs-human-review');
  });
  it('never merges on a secret in the diff, or with no verdict to read', () => {
    expect(autoMergeDecision({ ...all, verdict: 'block' })).toMatchObject({ merge: false });
    expect(autoMergeDecision({ ...all, verdict: 'block' }).reasons[3]).toContain('found a secret in the diff (block)');
    const { verdict: _v, ...noVerdict } = all;
    expect(autoMergeDecision(noVerdict).reasons[3]).toContain('no verdict to read');
    expect(autoMergeDecision(noVerdict).merge).toBe(false);
  });
  it('refuses when unarmed, without a token, or on a red selection — naming the condition', () => {
    expect(autoMergeDecision({ ...all, armed: false }).merge).toBe(false);
    expect(autoMergeDecision({ ...all, armed: false }).reasons[0]).toContain('not armed');
    expect(autoMergeDecision({ ...all, tokenPresent: false }).reasons[1]).toContain('ship nothing');
    expect(autoMergeDecision({ ...all, selectionResult: 'failure' }).reasons[2]).toContain('did not pass (job result: failure)');
  });
  it('an unarmed candidate still reports every failed review and suite condition', () => {
    const d = autoMergeDecision({
      ...all, armed: false, selectionResult: 'failure', verdict: 'block',
      base: { tested: 'aaaaaaaa1', current: 'bbbbbbbb2' },
      suite: { result: 'failure', gates: true },
      checks: { result: 'timeout', gates: true, detail: 'still running: Mutation Gate / Every refusal gate fails on its own defect' },
    });
    expect(d.merge).toBe(false);
    expect(d.reasons).toHaveLength(8);
    expect(d.reasons[0]).toContain('not armed');
    expect(d.reasons[2]).toContain('did not pass');
    expect(d.reasons[3]).toContain('found a secret');
    expect(d.reasons[5]).toContain('master moved');
    expect(d.reasons[6]).toContain('the whole suite on this head did not pass');
    expect(d.reasons[7]).toContain('was still running when the wait ran out');
  });
  it('names the label an automatic merge carries', () => {
    expect(AUTO_MERGED_LABEL).toBe('jev-harness:auto-merged');
  });
});

describe('with a person required', () => {
  it('merges only when every condition holds, and says so ten times', () => {
    const d = autoMergeDecision(withPerson);
    expect(d.merge).toBe(true);
    expect(d.reasons).toHaveLength(10);
    expect(d.reasons.every((r) => r.startsWith('holds: '))).toBe(true);
    expect(d.reasons[4]).toContain('25 live review-verdict outcome(s): agreement 0.92 (floor 0.9), disagreement 0.04 (ceiling 0.05)');
    expect(d.reasons[5]).toContain('the reputation from 1 attestation(s) rates accuracy 0.92 (floor 0.9)');
  });

  it('refuses when no published attestation vouches for the verdict', () => {
    const { reputation: _r, ...unread } = withPerson;
    const d = autoMergeDecision({ ...unread, reputationError: 'the bridge holds no reputation snapshot yet' });
    expect(d.merge).toBe(false);
    expect(d.reasons[5]).toContain('no attestation-based reputation could be read (the bridge holds no reputation snapshot yet)');
    expect(autoMergeDecision({ ...withPerson, reputation: { axes: { accuracy: 0.6 }, contributing: 2 } }).reasons[5]).toContain('fails: the reputation from 2 attestation(s) rates accuracy 0.6');
    expect(autoMergeDecision({ ...withPerson, reputation: { axes: { competence: 0.9 }, contributing: 1 } }).reasons[5]).toContain('rate no accuracy axis');
  });

  it('refuses any verdict but auto-ok', () => {
    const d = autoMergeDecision({ ...withPerson, verdict: 'needs-human-review' });
    expect(d.merge).toBe(false);
    expect(d.reasons[3]).toContain('a person is required');
  });

  it('refuses until the verdict has earned it: floor, agreement, disagreement, or no calibration at all', () => {
    expect(autoMergeDecision({ ...withPerson, calibration: { cells: [{ kind: 'review-verdict', liveSamples: 19, liveAgreement: { agree: 19 } }] } }).reasons[4]).toContain('19 live outcome(s), below the floor of 20');
    expect(autoMergeDecision({ ...withPerson, calibration: { cells: [{ kind: 'review-verdict', liveSamples: 30, liveAgreement: { agree: 24, conservative: 6 } }] } }).reasons[4]).toContain('fails: 30 live review-verdict outcome(s): agreement 0.8');
    expect(autoMergeDecision({ ...withPerson, calibration: { cells: [{ kind: 'review-verdict', liveSamples: 40, liveAgreement: { agree: 37, disagree: 3 } }] } }).reasons[4]).toContain('disagreement 0.075 (ceiling 0.05)');
    expect(autoMergeDecision({ ...withPerson, calibration: { cells: [{ kind: 'review-verdict', liveSamples: 20 }] } }).reasons[4]).toContain('no live review-verdict outcome carries a human decision');
    const { calibration: _c, ...noCalibration } = withPerson;
    const d = autoMergeDecision({ ...noCalibration, calibrationError: 'connect ECONNREFUSED' });
    expect(d.merge).toBe(false);
    expect(d.reasons[4]).toContain('could not be read (connect ECONNREFUSED)');
  });

  it('applies the policy it is given', () => {
    expect(autoMergeDecision({ ...withPerson, calibration: { cells: [{ kind: 'review-verdict', liveSamples: 5, liveAgreement: { agree: 5 } }] } }, { ...AUTO_MERGE_POLICY, minLiveSamples: 5 }).merge).toBe(true);
  });
});

describe('★ a branch that conflicts with master merges for nobody', () => {
  // #436, 2026-09-21: the job decided MERGE, labelled the pull request, and the merge command
  // failed on a changelog conflict the Foxxi merge had just created — leaving the label on a
  // pull request whose next merge could have been a person's.
  it('refuses a conflicting branch, and says what to do', () => {
    const d = autoMergeDecision({ ...all, mergeable: 'CONFLICTING' });
    expect(d.merge).toBe(false);
    expect(d.reasons[4]).toContain('fails: the pull request conflicts with master (merge master in and push');
  });
  it('refuses while GitHub has not settled mergeability, and when nothing was read', () => {
    expect(autoMergeDecision({ ...all, mergeable: 'UNKNOWN' }).reasons[4]).toContain('has not settled whether the pull request is mergeable (mergeable: UNKNOWN)');
    const { mergeable: _m, ...unread } = all;
    expect(autoMergeDecision(unread).merge).toBe(false);
  });
  it('is the last condition in the person-required mode too', () => {
    const d = autoMergeDecision({ ...withPerson, mergeable: 'CONFLICTING' });
    expect(d.merge).toBe(false);
    expect(d.reasons[6]).toContain('conflicts with master');
  });
});

describe('★ a branch master moved under is not what was tested', () => {
  it('refuses when master moved since the run\'s merge ref, naming both heads, so the branch is updated instead', () => {
    const d = autoMergeDecision({ ...all, base: { tested: 'aaaaaaaa1', current: 'bbbbbbbb2' } });
    expect(d.merge).toBe(false);
    expect(d.reasons[5]).toContain('fails: master moved from aaaaaaaa to bbbbbbbb since this run');
  });
  it('refuses when the tested base is unknown, and holds when master has not moved', () => {
    const { base: _b, ...unknown } = all;
    expect(autoMergeDecision(unknown).reasons[5]).toContain('was not given (--base-sha)');
    expect(autoMergeDecision(unknown).merge).toBe(false);
    expect(autoMergeDecision(all).reasons[5]).toContain('holds: the run tested the branch against master\'s current head (aaaaaaaa)');
  });
  it('is the last condition in the person-required mode too', () => {
    expect(autoMergeDecision({ ...withPerson, base: { tested: 'a', current: 'b' } }).reasons[7]).toContain('master moved');
  });
});

describe('★ the whole suite on the head: a red suite merged seven times before anything waited for it', () => {
  // 2026-09-22, 02:24Z to 16:31Z: bridge-typecheck.yml was red on every pull request and the
  // decision, taken on the selected tests alone, merged #446 to #452 over it.
  it('refuses a red, cancelled or timed-out suite, naming the run', () => {
    const d = autoMergeDecision({ ...all, suite: { result: 'failure', gates: true, url: 'https://github.com/o/r/actions/runs/9' } });
    expect(d.merge).toBe(false);
    expect(d.reasons[6]).toBe('fails: the whole suite on this head did not pass (failure, https://github.com/o/r/actions/runs/9); nothing merges over a red suite');
    expect(autoMergeDecision({ ...all, suite: { result: 'timeout', gates: true } }).merge).toBe(false);
    expect(autoMergeDecision({ ...all, suite: { result: 'untrusted', gates: true } }).merge).toBe(false);
  });
  it('holds on success, and on absent — no run for a head whose paths did not match, in a listing that holds this run', () => {
    expect(autoMergeDecision(all).reasons[6]).toBe('holds: the whole suite on this head passed (Bridge Typecheck)');
    expect(autoMergeDecision({ ...all, suite: { result: 'absent', gates: true } }).merge).toBe(true);
  });
  it('refuses when no result was given at all, and only prints it when the operator made the suite advisory', () => {
    const { suite: _s, ...none } = all;
    expect(autoMergeDecision(none).merge).toBe(false);
    expect(autoMergeDecision(none).reasons[6]).toContain('was not given (--suite-result)');
    const advisory = autoMergeDecision({ ...all, suite: { result: 'failure', gates: false } });
    expect(advisory.merge).toBe(true);
    expect(advisory.reasons[6]).toContain('advisory (JEV_MERGE_WAITS_FOR_SUITE is false): failure');
  });
  it('comes ninth in the person-required mode', () => {
    expect(autoMergeDecision({ ...withPerson, suite: { result: 'failure', gates: true } }).reasons[8]).toContain('nothing merges over a red suite');
  });
});

describe('★ every other check on the head is the last condition: #707 and #716 merged with Mutation Gate still running', () => {
  // 2026-10-27: the decision merged both the moment Bridge Typecheck passed, while Mutation Gate
  // and Base without verticals still ran on the same heads. They came back green; a red one would
  // have landed on master with nothing reading it. The words are the ones
  // tools/wait-for-workflow-run.mjs writes (wait-for-workflow-run.test.ts beside this file covers how it
  // reaches each one from GitHub's listings).
  it('holds only when every other check concluded success, neutral or skipped, and says what was read', () => {
    const d = autoMergeDecision({ ...all, checks: { result: 'success', gates: true, detail: '14 check run(s) from 8 other workflow run(s) and any other app concluded success, neutral or skipped' } });
    expect(d.merge).toBe(true);
    expect(d.reasons[7]).toBe('holds: every other check on this head concluded success, neutral or skipped (14 check run(s) from 8 other workflow run(s) and any other app concluded success, neutral or skipped)');
  });
  it('refuses a red check, whatever its conclusion, naming each one', () => {
    for (const conclusion of ['failure', 'cancelled', 'timed_out', 'action_required', 'startup_failure', 'stale']) {
      const d = autoMergeDecision({ ...all, checks: { result: 'failure', gates: true, detail: `did not pass: Mutation Gate / Every refusal gate fails on its own defect: ${conclusion}` } });
      expect(d.merge, conclusion).toBe(false);
      expect(d.reasons[7]).toBe(`fails: a check on this head did not pass (did not pass: Mutation Gate / Every refusal gate fails on its own defect: ${conclusion}); nothing merges over a red check`);
    }
  });
  it('refuses a check still running when the wait ran out: no merge, and the next push decides again', () => {
    const d = autoMergeDecision({ ...all, checks: { result: 'timeout', gates: true, detail: 'still running: Mutation Gate / Every refusal gate fails on its own defect' } });
    expect(d.merge).toBe(false);
    expect(d.reasons[7]).toContain('fails: a check on this head was still running when the wait ran out (still running: Mutation Gate');
    expect(d.reasons[7]).toContain('the next push decides again');
  });
  it('fails closed: a listing without this run\'s own job, GitHub unreadable, a word it does not know, or no word at all', () => {
    expect(autoMergeDecision({ ...all, checks: { result: 'untrusted', gates: true } }).reasons[7]).toContain('fails: GitHub\'s listing for this head never held this run\'s own job');
    const error = autoMergeDecision({ ...all, checks: { result: 'error', gates: true, detail: 'the check runs for this head could not be listed: GitHub answered 403' } });
    expect(error.merge).toBe(false);
    expect(error.reasons[7]).toBe('fails: the checks on this head could not be read (the check runs for this head could not be listed: GitHub answered 403); what cannot be read is not merged over');
    expect(autoMergeDecision({ ...all, checks: { result: 'pending', gates: true } }).reasons[7]).toBe('fails: the other checks on this head have not all concluded (pending)');
    const { checks: _c, ...none } = all;
    expect(autoMergeDecision(none).merge).toBe(false);
    expect(autoMergeDecision(none).reasons[7]).toContain('were not given (--checks-result)');
  });
  it('only prints the word when the operator made the checks advisory (JEV_MERGE_WAITS_FOR_CHECKS=false)', () => {
    const d = autoMergeDecision({ ...all, checks: { result: 'pending', gates: false, detail: 'still running: Mutation Gate / Every refusal gate fails on its own defect' } });
    expect(d.merge).toBe(true);
    expect(d.reasons[7]).toBe('holds: the other checks on this head are advisory (JEV_MERGE_WAITS_FOR_CHECKS is false): pending (still running: Mutation Gate / Every refusal gate fails on its own defect)');
  });
  it('★ an advisory suite merges red when the checks gate: the wait leaves the suite out of their word (SUITE_GATE=false)', () => {
    // JEV_MERGE_WAITS_FOR_SUITE=false with JEV_MERGE_WAITS_FOR_CHECKS unset. Had the checks word
    // counted Bridge Typecheck, the second reason would refuse what the first lets through.
    const d = autoMergeDecision({
      ...all, suite: { result: 'failure', gates: false },
      checks: { result: 'success', gates: true, detail: '12 check run(s) from 7 other workflow run(s) and any other app concluded success, neutral or skipped; 3 run(s) and job(s) of this workflow left out; Bridge Typecheck left out (9 run(s) and job(s)), as its word is advisory' },
    });
    expect(d.merge).toBe(true);
    expect(d.reasons[6]).toBe('holds: the whole suite on this head is advisory (JEV_MERGE_WAITS_FOR_SUITE is false): failure');
    expect(d.reasons[7]).toContain('Bridge Typecheck left out (9 run(s) and job(s)), as its word is advisory');
    const counted = autoMergeDecision({ ...all, suite: { result: 'failure', gates: false }, checks: { result: 'failure', gates: true, detail: 'did not pass: Bridge Typecheck / The whole root test suite: failure' } });
    expect(counted.merge).toBe(false);
  });
  it('a red check alone fails the merge, beside a green suite', () => {
    const d = autoMergeDecision({ ...all, checks: { result: 'failure', gates: true, detail: 'did not pass: Base without verticals / Emergence with the verticals; the base without them: failure' } });
    expect(d.reasons.filter((r) => r.startsWith('fails:'))).toEqual(['fails: a check on this head did not pass (did not pass: Base without verticals / Emergence with the verticals; the base without them: failure); nothing merges over a red check']);
  });
  it('is the last condition in the person-required mode too', () => {
    const d = autoMergeDecision({ ...withPerson, checks: { result: 'failure', gates: true } });
    expect(d.reasons).toHaveLength(10);
    expect(d.reasons[9]).toBe('fails: a check on this head did not pass; nothing merges over a red check');
  });
});

describe('★ the driver\'s arguments become the two words: a switch gates unless it is exactly false', () => {
  // bin/auto-merge.ts hands process.argv to waitWordsFromArgv; this is the one place the
  // workflow's SUITE_GATES / CHECKS_GATES strings become `gates`. Turned around, the default
  // (switch unset, so the workflow passes `true`) would merge over a red or running check.
  const node = ['node', 'bin/auto-merge.ts', '--pr', '1', '--repo', 'o/r'];
  const argv = (over: Record<string, string | undefined>) => {
    const words: Record<string, string | undefined> = {
      '--suite-result': 'success', '--suite-gates': 'true', '--suite-url': 'https://github.com/o/r/actions/runs/1',
      '--checks-result': 'success', '--checks-gates': 'true', '--checks-detail': 'every check concluded',
      ...over,
    };
    // As the workflow's run line passes them: each flag with its value, an unset variable as "".
    return [...node, ...Object.entries(words).flatMap(([k, v]) => (v === undefined ? [] : [k, v]))];
  };

  it('gates when the switch is true or absent; only exactly false makes a word advisory', () => {
    expect(waitWordsFromArgv(argv({}))).toEqual({
      suite: { result: 'success', gates: true, url: 'https://github.com/o/r/actions/runs/1' },
      checks: { result: 'success', gates: true, detail: 'every check concluded' },
    });
    const absent = waitWordsFromArgv(argv({ '--suite-gates': undefined, '--checks-gates': undefined }));
    expect(absent.suite?.gates).toBe(true);
    expect(absent.checks?.gates).toBe(true);
    const off = waitWordsFromArgv(argv({ '--suite-gates': 'false', '--checks-gates': 'false' }));
    expect(off.suite?.gates).toBe(false);
    expect(off.checks?.gates).toBe(false);
    // Each switch is its own: the checks advisory leaves the suite gating, and the other way round.
    expect(waitWordsFromArgv(argv({ '--checks-gates': 'false' }))).toMatchObject({ suite: { gates: true }, checks: { gates: false } });
    expect(waitWordsFromArgv(argv({ '--suite-gates': 'false' }))).toMatchObject({ suite: { gates: false }, checks: { gates: true } });
    // Anything but exactly false gates: an empty or mistyped switch is not an operator's choice.
    for (const v of ['', 'TRUE', 'no', '0']) expect(waitWordsFromArgv(argv({ '--checks-gates': v })).checks?.gates, v).toBe(true);
  });

  it('a red or running check refuses through the parsed default, and only an explicit false lets it through', () => {
    const decide = (over: Record<string, string | undefined>) => autoMergeDecision({ ...all, ...waitWordsFromArgv(argv(over)) });
    expect(decide({ '--checks-result': 'failure', '--checks-gates': undefined }).merge).toBe(false);
    expect(decide({ '--checks-result': 'timeout' }).merge).toBe(false);
    expect(decide({ '--checks-result': 'failure', '--checks-gates': 'false' }).merge).toBe(true);
    expect(decide({ '--suite-result': 'failure', '--suite-gates': undefined }).merge).toBe(false);
    expect(decide({ '--suite-result': 'failure', '--suite-gates': 'false' }).merge).toBe(true);
  });

  it('an empty or absent word is left out, so its condition fails as unknown; an empty url or detail is left out too', () => {
    // The wait failed before writing (exit 2): its outputs are empty strings in the run line.
    const empty = waitWordsFromArgv(argv({ '--suite-result': '', '--suite-url': '', '--checks-result': '', '--checks-detail': '' }));
    expect(empty).toEqual({});
    const { suite: _s, checks: _c, ...rest } = all;
    const d = autoMergeDecision({ ...rest, ...empty });
    expect(d.merge).toBe(false);
    expect(d.reasons[6]).toContain('was not given (--suite-result)');
    expect(d.reasons[7]).toContain('were not given (--checks-result)');
    expect(waitWordsFromArgv(node)).toEqual({});
    // A word with no url or detail keeps the word and drops only the empty field.
    expect(waitWordsFromArgv(argv({ '--suite-url': '', '--checks-detail': '' }))).toEqual({ suite: { result: 'success', gates: true }, checks: { result: 'success', gates: true } });
  });

  it('passes the detail and the url through as given, check names and all', () => {
    const detail = 'did not pass: Base without verticals / Emergence with the verticals; the base without them: failure; still running: ESLint (queued)';
    const words = waitWordsFromArgv(argv({ '--checks-result': 'failure', '--checks-detail': detail }));
    expect(words.checks).toEqual({ result: 'failure', gates: true, detail });
    expect(autoMergeDecision({ ...all, ...words }).reasons[7]).toBe(`fails: a check on this head did not pass (${detail}); nothing merges over a red check`);
  });

  it('the driver reads both words through it, and parses neither itself', () => {
    const bin = readFileSync(fileURLToPath(new URL('../bin/auto-merge.ts', import.meta.url)), 'utf8');
    expect(bin).toContain('...waitWordsFromArgv(process.argv),');
    for (const name of ['--suite-result', '--suite-gates', '--suite-url', '--checks-result', '--checks-gates', '--checks-detail']) {
      expect(bin, name).not.toContain(`flag('${name}')`);
    }
  });
});
