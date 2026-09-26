/**
 * The course an LTI launch opens, and how the bridge wires it: pages that show course text as
 * text, answers read in question order, the AGS Score an ended attempt sends, and a launch from
 * this bridge's own LMS played by the same SCORM engine step as every other attempt.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { agsScore, answersFrom, renderOutcomePage, renderScoPage } from '../src/lti-player.js';

describe('the pages a learner reads', () => {
  it('shows a course\'s text as text, and asks each question with the input its answer needs', () => {
    const html = renderScoPage({
      courseTitle: 'Course <one>',
      sco: { id: 'SCO-1', title: 'Check <b>', body: 'First line\nsecond line\n\n<img src=x onerror=alert(1)>', assessment: [{ index: 0, question: 'Name it?' }, { index: 1, question: 'How many?', input: { type: 'integer', min: 0 } }] },
    });
    expect(html).not.toContain('<img');
    expect(html).toContain('&lt;img src=x onerror=alert(1)&gt;');
    expect(html).toContain('First line<br>second line');
    expect(html).toContain('name="answer_0" type="text"');
    expect(html).toMatch(/name="answer_1" type="number"[^>]*step="1"[^>]*min="0"/);
    expect(html).toContain('<form method="POST">');
  });

  it('says where the grade went, or that it did not get there', () => {
    const posted = renderOutcomePage({ courseTitle: 'C', outcome: { completed: true, passed: true, score: 1, recordedStatements: 2, gradebook: { posted: true, scoreGiven: 100, scoreMaximum: 100 } } });
    expect(posted).toContain('Your LMS has the grade: 100 of 100');
    const refused = renderOutcomePage({ courseTitle: 'C', outcome: { completed: true, passed: false, score: 0.5, recordedStatements: 2, gradebook: { posted: false, why: 'line item URL rejected: <target URL must be https>' } } });
    expect(refused).toContain('The grade did not reach your LMS: line item URL rejected: &lt;target URL must be https&gt;');
  });
});

describe('a submission and the grade it ends in', () => {
  it('reads the answers in question order, from JSON or from the page\'s form', () => {
    expect(answersFrom({ answers: ['a', 'b'] }, 2)).toEqual(['a', 'b']);
    expect(answersFrom({ answer_1: 'b', answer_0: 'a' }, 2)).toEqual(['a', 'b']);
    expect(answersFrom({ answer_0: 'a' }, 2)).toEqual(['a', undefined]);
    expect(answersFrom({}, 0)).toBeUndefined();
  });

  it('is an AGS Score: 0 to 100, completed, fully graded, for the learner the platform named', () => {
    const at = new Date('2026-09-26T12:00:00Z');
    expect(agsScore('did:ethr:0x1', { passed: true, score: 0.8333 }, at)).toEqual({
      userId: 'did:ethr:0x1', scoreGiven: 83.3, scoreMaximum: 100, activityProgress: 'Completed', gradingProgress: 'FullyGraded', timestamp: '2026-09-26T12:00:00.000Z', comment: 'Passed',
    });
    expect(agsScore('u', { passed: false, score: 1.7 }, at)).toMatchObject({ scoreGiven: 100, comment: 'Not passed' });
    expect(agsScore('u', { passed: false, score: -1 }, at)).toMatchObject({ scoreGiven: 0 });
  });
});

describe('the bridge wires its own LMS to its own Tool', () => {
  const src = readFileSync(new URL('../bridge/server.ts', import.meta.url), 'utf8');

  it('launches for the learner the signature names, never one the caller names', () => {
    const route = src.slice(src.indexOf("app.post('/agent/lti/launch'"), src.indexOf("app.post('/agent/lti/gradebook'"));
    expect(route).toMatch(/verifyDelegatedCaller\(req\.body\)/);
    expect(route).toMatch(/const learner = await signedLearner\(auth\)/);
    expect(route).toMatch(/ltiPlatform\.beginLaunch\(\{ sub: learner\.did, podUrl: learner\.podUrl \}/);
    const gradebook = src.slice(src.indexOf("app.post('/agent/lti/gradebook'"));
    expect(gradebook).toMatch(/ltiPlatform\.gradebookFor\(learner\.did\)/);
  });

  it('plays only its own LMS\'s launches, with the same engine step as every attempt, into the learner\'s pod', () => {
    expect(src).toMatch(/extraPlatforms: \[ltiPlatform\.registration\(\)\]/);
    expect(src).toMatch(/onResourceLaunch: \(launch\) => startLtiPlay\(launch\)/);
    expect(src).toMatch(/if \(launch\.issuer !== ltiPlatform\.issuer\) return null;/);
    expect(src.match(/advanceScormPlay\(/g)?.length).toBeGreaterThanOrEqual(3);
    expect(src).toMatch(/const learnerPod = play\.learnerPod \?\? resolveSubjectPodUrl\(play\.learnerDid\)/);
    expect(src).toMatch(/launch\.ags\?\.scope\.includes\(AGS_SCOPE\.score\)/);
  });
});
