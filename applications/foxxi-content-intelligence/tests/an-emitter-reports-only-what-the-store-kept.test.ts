/**
 * What the bridge records on its own behalf, it reports only once the store holds it.
 *
 * ★ WHY. The doors that take a caller's statements wait for the store (a-door-reports-only-what-
 * the-store-kept). The bridge's own emitters did not: each wrote with the unawaited
 * `storeStatementInternal` and reported at once.
 * - an author's `authored` and an issuer's `credentialed` statement ids, cited in the response;
 * - the learner's `credentialed` statement, cited beside the credential it records;
 * - a SCORM attempt's outcome: "recorded to your ELR", with a count of statements, and on the LTI
 *   outcome page "The attempt is in your learner record";
 * - a content delivery's and a Context Companion ask's `instrumented: true`, and "recorded in the
 *   LRS".
 * A store that did not keep the write left each of those claims false.
 *
 * Now each emitter waits (`storeStatementDurably`, or `keepStatementsWhole` for an attempt's
 * outcome), reports only an id the store holds, and composes or forwards nothing it does not. An
 * attempt whose outcome the record does not hold is not lost: it keeps the statements it was built
 * with, and a submit to it keeps them again (a store holds an id once). The LTI page says what
 * the record holds and offers to record it again; a platform that has the grade is not sent it twice.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import express from 'express';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { readFileSync } from 'node:fs';
import { attachContentDeliveryRoutes } from '../src/content-delivery.js';
import { attachContextChatRoutes } from '../src/context-chat.js';

const server = readFileSync(new URL('../bridge/server.ts', import.meta.url), 'utf8');
/** A top-level function's text, from its signature to its closing brace. */
const fn = (signature: string): string => {
  const at = server.indexOf(signature);
  if (at < 0) throw new Error(`${signature} is not in the bridge`);
  return server.slice(at, server.indexOf('\n}\n', at));
};
/** A route's text, from its registration to the next top-level line that is not a closing one. */
const route = (registration: string): string => {
  const at = server.indexOf(registration);
  if (at < 0) throw new Error(`${registration} is not in the bridge`);
  const rest = server.slice(at + registration.length);
  const end = rest.search(/\n(?!\}|\s)/);
  return registration + (end < 0 ? rest : rest.slice(0, end));
};

const HOOK = 'https://hooks.example/chat';
const LEARNER = 'did:web:tester.example';
const servers: Server[] = [];
const serve = async (app: express.Express): Promise<string> => {
  const s = app.listen(0, '127.0.0.1');
  servers.push(s);
  await new Promise<void>((r) => s.once('listening', () => r()));
  return `http://127.0.0.1:${(s.address() as AddressInfo).port}`;
};
const realFetch = globalThis.fetch;
beforeAll(() => {
  // The delivery channel's webhook answers 200; everything else is a real request to the test's own server.
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
    if (url === HOOK) return new Response('ok', { status: 200 });
    return realFetch(input, init);
  });
});
afterEach(async () => { await Promise.all(servers.splice(0).map((s) => new Promise<void>((r) => s.close(() => r())))); });
afterAll(() => { vi.restoreAllMocks(); });

describe('a delivery is reported instrumented only when the store holds its statement', () => {
  it.each([
    { store: 'holds it', id: 'stmt-kept', instrumented: true, note: 'recorded in the LRS' },
    { store: 'does not', id: null, instrumented: false, note: 'No LRS statement was recorded' },
  ])('when the store $store', async ({ id, instrumented, note }) => {
    const emitted: unknown[] = [];
    const app = express(); app.use(express.json());
    attachContentDeliveryRoutes(app, {
      selfBaseUrl: 'https://foxxi.example', authoritativeSource: 'https://owner.example',
      transport: { webhooks: { chat: { url: HOOK } } }, authorizeInstrumentation: () => true,
      emitStatement: async (s) => { emitted.push(s); return id; },
    });
    const r = await fetch(`${await serve(app)}/content/deliver`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ channel: 'chat', learner: LEARNER, unit: { title: 'A reference', kind: 'reference', blocks: [{ text: 'Read this.' }] } }),
    });
    expect(r.status).toBe(200);
    const result = await r.json() as { delivered: boolean; instrumented: boolean; note: string };
    expect(result.delivered).toBe(true);
    expect(emitted).toHaveLength(1);
    expect(result.instrumented).toBe(instrumented);
    expect(result.note).toContain(note);
  });
});

describe('a Context Companion ask is reported instrumented only when the store holds its statement', () => {
  it.each([
    { store: 'holds it', id: 'stmt-kept', instrumented: true },
    { store: 'does not', id: null, instrumented: false },
  ])('when the store $store', async ({ id, instrumented }) => {
    const emitted: unknown[] = [];
    const app = express(); app.use(express.json());
    attachContextChatRoutes(app, {
      selfBaseUrl: 'https://foxxi.example', authoritativeSource: 'https://owner.example',
      authorizeInstrumentation: () => true,
      emitStatement: async (s) => { emitted.push(s); return id; },
    });
    const r = await fetch(`${await serve(app)}/content/ask`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ question: 'What is on my plate this week?', learner: LEARNER }),
    });
    expect(r.status).toBe(200);
    expect(emitted).toHaveLength(1);
    expect(((await r.json()) as { instrumented: boolean }).instrumented).toBe(instrumented);
  });
});

describe("the bridge's own emitters wait for the store", () => {
  it('reports an author\'s or issuer\'s activity only once the store holds it, and composes and forwards nothing else', () => {
    const act = fn('async function emitAgentActivity(');
    expect(act).toContain('const id = await storeStatementDurably(statement, lens);\n    if (!id) return null;');
    expect(act.indexOf('if (!id) return null;')).toBeLessThan(act.indexOf('composeIntoSharedLattice('));
    expect(act.indexOf('if (!id) return null;')).toBeLessThan(act.indexOf('forwardToTargets('));
  });

  it("cites a learner's credentialed statement only once the store holds it", () => {
    const cred = fn('async function recordCredentialed(');
    expect(cred).toContain('const id = await storeStatementDurably(statement, lens);\n    if (!id) return null;');
    expect(cred.indexOf('if (!id) return null;')).toBeLessThan(cred.indexOf('forwardToTargets('));
  });

  it('is waited for wherever it is called: a promise reports nothing', () => {
    for (const name of ['emitAgentActivity', 'recordCredentialed', 'advanceScormPlay']) {
      const calls = [...server.matchAll(new RegExp(`(\\w+ )?${name}\\(`, 'g'))].map((m) => m[1] ?? '');
      expect(calls.filter((c) => c === 'function ')).toHaveLength(1);
      expect(calls.filter((c) => c !== 'function ').length).toBeGreaterThan(0);
      expect(calls.filter((c) => c !== 'function ' && c !== 'await ')).toEqual([]);
    }
  });

  it('writes unawaited only where nothing is reported: a re-projected view, and the LMS\'s own statements it keeps on the pod', () => {
    const sites = server.split('\n').filter((l) => l.includes('storeStatementInternal(')).map((l) => l.trim());
    expect(sites).toEqual([
      'storeStatementInternal(ev.statement, lensTenantFor(ev.agent));',
      'emit: (s) => { const id = storeStatementInternal(s, tenant); if (id && own) keepCmi5OnLearnerPod({ ...s, id }, own); },',
    ]);
    expect(server.match(/emitStatement: \(stmt, tenant\) => storeStatementDurably\(stmt, tenant\),/g)).toHaveLength(2);
  });
});

describe("an attempt's outcome is in the learner's record, or it says so and keeps it for another try", () => {
  it('keeps all of its statements or calls it unrecorded, and composes them only once all are kept', () => {
    const rec = fn('async function recordScormCompletion(');
    expect(rec).toContain('const kept = await keepStatementsWhole(ended.statements, play.lens);');
    expect(rec).toContain("ended.recorded = kept.status === 'whole';");
    expect(rec).toContain("ended.statementIds = kept.status === 'refused' ? [] : kept.keptIds;");
    // Refused or partial, it goes no further: each branch returns before anything is composed.
    for (const status of ['refused', 'partial']) {
      expect(rec).toMatch(new RegExp(`if \\(kept\\.status === '${status}'\\) \\{ ended\\.unrecorded = [^\\n]*; return; \\}\\n`));
      expect(rec.indexOf(`if (kept.status === '${status}')`)).toBeLessThan(rec.indexOf('composeIntoSharedLattice('));
    }
  });

  it('builds the statements once, when the attempt ends, and keeps those same ones on every later step', () => {
    const adv = fn('async function advanceScormPlay(');
    expect(adv).toMatch(/if \(play\.ended\) \{\n\s+if \(!play\.ended\.recorded\) await recordScormCompletion\(play, play\.ended\);\n\s+return endedStep\(play\.ended\);\n\s+\}/);
    expect(adv.indexOf('if (play.ended) {')).toBeLessThan(adv.indexOf('const cur = play.seq.current;'));
    expect(adv).toMatch(/play\.ended = \{ statements: scormCompletionStatements\(play, course, passed, score\), [^\n]*\};\n\s+await recordScormCompletion\(play, play\.ended\);\n\s+return endedStep\(play\.ended\);/);
    expect(server.match(/scormCompletionStatements\(/g)).toHaveLength(2);
  });

  it('answers an unrecorded outcome 503, and keeps the session so a submit records it', () => {
    const submit = route("app.post('/agent/scorm/submit'");
    const unrecorded = submit.indexOf('if (!step.recorded) {');
    expect(unrecorded).toBeGreaterThan(-1);
    expect(unrecorded).toBeLessThan(submit.indexOf('agentScormPlays.delete(sessionId);'));
    expect(submit.slice(unrecorded, submit.indexOf('agentScormPlays.delete(sessionId);'))).toMatch(/res\.status\(503\)\.json\(\{ error: [^\n]*Submit to this session again to record it\.[^\n]*\n\s+return;/);
    expect(submit).toContain('const step = await advanceScormPlay(play, p.answers);');
  });
});
