/**
 * The practice studio: discover the affordances, play the seeded scenario's best
 * path, and check every statement against phone-roleplay profile v3.
 */
import { once } from 'node:events';
import type { AddressInfo } from 'node:net';
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { answerSuppliedProfileRequest } from '../../foxxi-content-intelligence/src/xapi-profile-patterns.js';
import { whyNotAProfile } from '../../foxxi-content-intelligence/src/xapi-profile-supplied.js';
import { phoneRoleplayProfile } from '../src/profile.js';
import { bestChoices } from '../src/score.js';
import { createStudioApp } from '../src/server.js';
import { Studio } from '../src/studio.js';

const PLAYER = new URL('../../../docs/applications/practice-evidence/roleplay-player/index.html', import.meta.url);

async function listen(): Promise<{ base: string; close: () => Promise<void> }> {
  const app = createStudioApp(new Studio(), 'http://studio.test');
  const server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const { port } = server.address() as AddressInfo;
  return {
    base: `http://127.0.0.1:${port}`,
    close: () => new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve())),
  };
}

describe('practice studio', () => {
  it('publishes the five product affordances', async () => {
    const studio = await listen();
    try {
      const entry = await fetch(studio.base).then((r) => r.json()) as { affordances: Array<{ toolName: string; target: string; expects: { properties?: Record<string, unknown> } }> };
      const names = entry.affordances.map((a) => a.toolName).sort();
      expect(names).toEqual([
        'studio.create_scenario',
        'studio.list_progress',
        'studio.list_scenarios',
        'studio.score_attempt',
        'studio.start_session',
      ]);
      const start = entry.affordances.find((a) => a.toolName === 'studio.start_session');
      expect(start?.target).toBe('http://studio.test/studio/sessions');
      expect(start?.expects.properties).toHaveProperty('scenarioKey');
    } finally {
      await studio.close();
    }
  });

  it('scores the seeded pass-gate on the best path and the statements follow profile v3', async () => {
    const profile = phoneRoleplayProfile();
    expect(whyNotAProfile(profile)).toBeNull();
    const templates = profile['templates'] as Array<{ id: string }>;
    expect(templates.map((t) => t.id)).toContain('https://relay.interego.xwisee.com/ns/u-pk-0d4144c0c851/phone-roleplay-xapi/templates/turn');

    const held = new Studio();
    const doc = held.scenario('double-charged-subscription')!;
    const choices = bestChoices(doc, 'dana');
    const studio = await listen();
    try {
      const started = await fetch(`${studio.base}/studio/sessions`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ scenarioKey: 'double-charged-subscription', learner: 'Learner 12', personaId: 'dana' }),
      }).then((r) => r.json()) as { session: { sessionId: string }; playerUrl: string };
      expect(started.playerUrl).toContain('/player/index.html');
      expect(started.playerUrl).toContain('persona=dana');

      const scored = await fetch(`${studio.base}/studio/attempts/score`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ sessionId: started.session.sessionId, choices }),
      });
      const body = await scored.json() as {
        kind?: string; error?: string;
        score: { pass: boolean; provisional: boolean; percent: number; criteria: Array<{ id: string; raw: number; max: number }> };
        coaching: { notes: unknown[] };
        statements: Array<{ verb: { id: string }; result?: { extensions?: Record<string, string> }; object: { definition?: { type?: string; extensions?: Record<string, string> } } }>;
        profileCheck: { conforms: boolean };
      };
      expect(scored.status, JSON.stringify(body).slice(0, 800)).toBe(200);
      expect(body.profileCheck.conforms).toBe(true);
      expect(body.score.provisional).toBe(true);
      expect(body.score.pass).toBe(true);
      expect(body.coaching.notes).toEqual([]);
      const verbs = body.statements.map((s) => s.verb.id.split('/').pop());
      expect(verbs).toEqual([
        'initialized', 'consented',
        'took-turn', 'took-turn', 'took-turn', 'took-turn', 'took-turn',
        'scored', 'scored', 'scored', 'scored', 'scored',
        'terminated',
      ]);
      expect(verbs).not.toContain('completed');
      const turn = body.statements.find((s) => s.verb.id.endsWith('/took-turn'))!;
      expect(turn.object.definition?.type).toBe('https://relay.interego.xwisee.com/ns/u-pk-0d4144c0c851/phone-roleplay-xapi/activity-types/roleplay-turn');
      expect(turn.object.definition?.extensions?.['https://relay.interego.xwisee.com/ns/u-pk-0d4144c0c851/phone-roleplay-xapi/extensions/step-id']).toBeTruthy();
      expect(turn.result?.extensions?.['https://relay.interego.xwisee.com/ns/u-pk-0d4144c0c851/phone-roleplay-xapi/extensions/confirmed-choice']).toBe('tapped');

      const patterns = answerSuppliedProfileRequest({ profile, statements: body.statements });
      expect(patterns.body['conforms']).toBe(true);

      const progress = await fetch(`${studio.base}/studio/progress?learner=${encodeURIComponent('Learner 12')}`).then((r) => r.json()) as {
        attempts: number; passRate: number; averagePercent: number; learnerPseudonym: string; criteria: Array<{ id: string }>;
      };
      expect(progress.attempts).toBe(1);
      expect(progress.passRate).toBe(100);
      expect(progress.averagePercent).toBe(body.score.percent);
      expect(progress.learnerPseudonym.startsWith('anon-')).toBe(true);
      expect(JSON.stringify(progress)).not.toContain('Learner 12');
      expect(progress.criteria.map((c) => c.id).sort()).toEqual(doc.rubric.criteria.map((c) => c.id).sort());
    } finally {
      await studio.close();
    }
  });

  it('authors a feedback-only scenario and closes it with completed, still on v3', async () => {
    const studio = await listen();
    try {
      const created = await fetch(`${studio.base}/studio/scenarios`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          scenarioKey: 'short-hello',
          title: 'Hello',
          learnerGoal: 'Greet the customer',
          situation: 'A customer says hello.',
          assessmentUse: 'feedback-only',
          resultAfterReview: false,
          language: 'en-US',
          rubric: {
            criteria: [{
              id: 'greeting', title: 'Greeting', description: 'Says hello', weight: 1,
              levels: [{ id: '0', value: 0 }, { id: '1', value: 1 }],
            }],
            passRule: { minPercent: 50 },
          },
          personas: [{
            id: 'pat', name: 'Pat', firstLine: 'Hello?',
            stages: [{
              id: 'open',
              choices: [
                { id: 'a', text: 'Hi, how can I help?', effects: { greeting: 1 }, best: true },
                { id: 'b', text: 'What.', effects: { greeting: 0 }, note: 'Start with a greeting.' },
              ],
            }],
          }],
        }),
      });
      expect(created.status).toBe(200);
      const started = await fetch(`${studio.base}/studio/sessions`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ scenarioKey: 'short-hello', learner: 'Ada', personaId: 'pat' }),
      }).then((r) => r.json()) as { session: { sessionId: string } };
      const scored = await fetch(`${studio.base}/studio/attempts/score`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ sessionId: started.session.sessionId, choices: [{ index: 1, said: 'what do you want' }] }),
      }).then((r) => r.json()) as { score: { pass: boolean; provisional: boolean }; coaching: { notes: Array<{ note: string }> }; statements: Array<{ verb: { id: string } }>; profileCheck: { conforms: boolean } };
      expect(scored.profileCheck.conforms).toBe(true);
      expect(scored.score.provisional).toBe(false);
      expect(scored.score.pass).toBe(false);
      expect(scored.coaching.notes[0]?.note).toContain('greeting');
      const verbs = scored.statements.map((s) => s.verb.id.split('/').pop());
      expect(verbs).toEqual(['initialized', 'consented', 'took-turn', 'scored', 'completed', 'terminated']);
    } finally {
      await studio.close();
    }
  });

  it('refuses a session that is not finished, and the player tells a parent page when one is', () => {
    const page = readFileSync(PLAYER, 'utf8');
    expect(page).toContain('source: "interego-roleplay-player"');
    expect(page).toContain('confirmedChoice');
    const held = new Studio();
    expect(held.scoreAttempt({ sessionId: 'missing', choices: [] })['kind']).toBe('refusal');
    const started = held.startSession({ scenarioKey: 'double-charged-subscription', learner: 'Pat', personaId: 'dana' });
    const sessionId = (started['session'] as { sessionId: string }).sessionId;
    const short = held.scoreAttempt({ sessionId, choices: [{ index: 0 }] });
    expect(short['kind']).toBe('refusal');
    expect(String(short['error'])).toContain('one reply per step');
  });
});
