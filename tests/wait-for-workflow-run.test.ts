/**
 * The whole-suite wait before the gated auto-merge: what a listing means, when to ask again,
 * and that the judge workflow runs it with the names the tool expects.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { SUITE_WORKFLOW, keepWaiting, suiteState } from '../tools/wait-for-workflow-run.mjs';

const SELF = 'jev-harness (System One judgments)';
const self = { name: SELF, status: 'in_progress', conclusion: null };
const run = (status: string, conclusion: string | null, url = 'https://github.com/o/r/actions/runs/1') => ({ name: SUITE_WORKFLOW, status, conclusion, url });

describe('what a listing says about the suite on this head', () => {
  it('success when the suite concluded success, with its page', () => {
    expect(suiteState([self, run('completed', 'success')], { self: SELF })).toEqual({ state: 'success', detail: 'Bridge Typecheck concluded success', url: 'https://github.com/o/r/actions/runs/1' });
  });
  it('the conclusion itself when it was anything else — failure, cancelled, timed_out are all refusals', () => {
    expect(suiteState([self, run('completed', 'failure')], { self: SELF }).state).toBe('failure');
    expect(suiteState([self, run('completed', 'cancelled')], { self: SELF }).state).toBe('cancelled');
    expect(suiteState([self, run('completed', null)], { self: SELF }).state).toBe('unknown');
  });
  it('pending while the suite runs, even when an older run of it already concluded', () => {
    const s = suiteState([self, run('in_progress', null, 'https://github.com/o/r/actions/runs/2'), run('completed', 'failure')], { self: SELF });
    expect(s).toMatchObject({ state: 'pending', url: 'https://github.com/o/r/actions/runs/2' });
  });
  it('★ absent only when the listing holds this job\'s own run; a listing without it is untrusted, not green', () => {
    // 2026-09-21, 0f40814b: GitHub answered a run listing with an empty list mid-run. Read as
    // "no suite for this head", that would merge without the suite; the job's own run is the one
    // run that certainly exists, so its absence means the listing is short, not the suite.
    expect(suiteState([self, { name: 'ESLint', status: 'completed', conclusion: 'success' }], { self: SELF }).state).toBe('absent');
    expect(suiteState([{ name: 'ESLint', status: 'completed', conclusion: 'success' }], { self: SELF }).state).toBe('untrusted');
    expect(suiteState([], { self: SELF }).state).toBe('untrusted');
  });
  it('reads the newest run first, as GitHub lists them', () => {
    expect(suiteState([self, run('completed', 'success', 'new'), run('completed', 'failure', 'old')], { self: SELF })).toMatchObject({ state: 'success', url: 'new' });
  });
});

describe('when the loop asks again', () => {
  it('pending and untrusted wait while time remains; nothing waits past the deadline; a conclusion never waits', () => {
    expect(keepWaiting('pending', false)).toBe(true);
    expect(keepWaiting('untrusted', false)).toBe(true);
    expect(keepWaiting('pending', true)).toBe(false);
    expect(keepWaiting('untrusted', true)).toBe(false);
    for (const s of ['success', 'failure', 'absent', 'cancelled']) expect(keepWaiting(s, false)).toBe(false);
  });
});

describe('the judge workflow runs the wait with the names the tool expects', () => {
  const read = (rel: string) => readFileSync(fileURLToPath(new URL(`../${rel}`, import.meta.url)), 'utf8');
  it('names the suite workflow as bridge-typecheck.yml names itself, and its own name as SELF_WORKFLOW', () => {
    const suite = /^name:\s*(.+?)\s*$/m.exec(read('.github/workflows/bridge-typecheck.yml'))?.[1];
    expect(suite).toBe(SUITE_WORKFLOW);
    const judge = read('.github/workflows/jev-harness.yml');
    const judgeName = /^name:\s*(.+?)\s*$/m.exec(judge)?.[1];
    expect(judgeName).toBeDefined();
    expect(judge).toContain('node tools/wait-for-workflow-run.mjs');
    expect(judge).toContain(`SELF_WORKFLOW: ${judgeName}`);
    expect(judge, 'the decision must read the word the wait wrote').toContain('--suite-result');
  });
});
