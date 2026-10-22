/**
 * The practice-evidence bridge over HTTP, and its web UI driven for real.
 *
 * The bridge is composed the way server.ts composes it (createVerticalBridge + the handlers + the
 * host guard + attachUi), without the ontology-serving module, and served on a loopback port.
 * The UI is the shipped /ui shell and /ui/app.js, run in a jsdom window whose fetch reaches that
 * loopback bridge: every click below goes through the client's own manifest walk, signing and
 * rendering, against the real handlers and an in-memory pod. Three signing modes are exercised:
 * demo role keys held by the bridge, a wallet (a window.ethereum that signs with a real key, as
 * personal_sign does), and paste (the page shows the exact text; a key signs it outside).
 *
 * No network beyond 127.0.0.1; pods are reserved `.test` hosts served by the double; no
 * environment reads.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { spawnSync } from 'node:child_process';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { request } from 'node:http';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { JSDOM, VirtualConsole } from 'jsdom';
import { Parser } from 'n3';
import { canonicalJson, signMessageRaw, type Wallet } from '@interego/core';
import type { Express, NextFunction, Request as ExpressRequest, Response as ExpressResponse } from 'express';
import { createVerticalBridge } from '../../_shared/vertical-bridge/index.js';
import { listenLoopback, type TestListener } from '../../_shared/vertical-bridge/listen-loopback.js';
import { pevAffordances } from '../affordances.js';
import { createPevHandlers, DEMO_ROLE_NAMES, type DemoRoleName, type PevDeps } from '../bridge/handlers.js';
import { attachUi, hostAllowlistGuard, UI_CSP } from '../bridge/ui.js';
import {
  DEMO_LINES, DEMO_POD, DEMO_ROLE_LABELS, FABRICATED_QUOTE, demoScenarioInput, demoSignerOf, demoWallet, inMemoryPod, scriptedPracticeModel,
} from '../demo/run.js';
import { inAuditSample } from '../src/calibration.js';
import { PEV_ACTION, PEV_NS } from '../src/ontology.js';
import * as practice from '../src/practice.js';
import { signEnvelope, signedRequestEnvelope } from '../src/records.js';

type Out = Record<string, unknown>;
type Handlers = Record<string, (args: Record<string, unknown>) => Promise<unknown>>;

const SLOW = 240_000;
const HERE = fileURLToPath(new URL('.', import.meta.url));
const VERTICAL = join(HERE, '..');
const REPO = join(VERTICAL, '..', '..');
const read = (p: string): string => readFileSync(join(VERTICAL, p), 'utf8');

// ═════════════════════════════════════════════════════════════════════════════════════════════
//  The world: one pod, demo role wallets, three bridges
// ═════════════════════════════════════════════════════════════════════════════════════════════

const pod = inMemoryPod();
const W = Object.fromEntries(DEMO_ROLE_NAMES.map((r) => [r, demoWallet(r)])) as Record<DemoRoleName, Wallet>;
const base: PevDeps = {
  platformWallet: demoWallet('platform'), platformKeyKind: 'demo-fixture', adminAddresses: [W.admin.address],
  fetchFn: pod.fetchFn, holderFetchFn: pod.fetchFn, defaultPodUrl: DEMO_POD, servedPods: [DEMO_POD], deploymentUrl: 'http://127.0.0.1:6110',
};
/** Scripted model + demo role keys: the UI's demo mode. */
const demoHandlers = createPevHandlers({ ...base, model: scriptedPracticeModel(), demoSigner: demoSignerOf(W) }) as Handlers;
/** Scripted model, no demo keys: the UI's wallet and paste modes. */
const plainHandlers = createPevHandlers({ ...base, model: scriptedPracticeModel() }) as Handlers;
/** No model at all. */
const noModelHandlers = createPevHandlers(base) as Handlers;

/** The app as server.ts composes it, minus the ontology module (which no test may import). */
function bridgeApp(handlers: Handlers, allowed: string[]): Express {
  return createVerticalBridge({
    verticalName: 'practice-evidence', affordances: pevAffordances, handlers, deploymentUrl: 'http://127.0.0.1:6110', defaultPodUrl: DEMO_POD,
    hypermediaLinks: [{ label: 'Web UI', href: 'http://127.0.0.1:6110/ui', rel: 'alternate', type: 'text/html' }],
    middleware: (a) => {
      // The port is known only after listening, so the allowed names are read per request.
      a.use((req: ExpressRequest, res: ExpressResponse, next: NextFunction) => hostAllowlistGuard(allowed)(req, res, next));
      attachUi(a);
    },
  });
}

const listeners: TestListener[] = [];
async function serve(handlers: Handlers): Promise<TestListener> {
  const allowed: string[] = [];
  const l = await listenLoopback(bridgeApp(handlers, allowed));
  allowed.push(`127.0.0.1:${l.port}`, `localhost:${l.port}`);
  listeners.push(l);
  return l;
}

let nonceN = 0;
const nonce = (): string => `ui-test-nonce-${String(++nonceN).padStart(8, '0')}`;
async function envelope(w: Wallet, action: string, fields: Out = {}): Promise<{ payload: Out; signature: string }> {
  return signEnvelope(w, { v: 1, action, issuedAt: new Date().toISOString(), nonce: nonce(), podUrl: DEMO_POD, ...fields });
}
async function direct(h: Handlers, tool: string, w: Wallet, action: string, fields: Out = {}): Promise<Out> {
  return (await h[tool]!({ envelope: await envelope(w, action, fields) })) as Out;
}

async function post(l: TestListener, path: string, body: unknown): Promise<{ status: number; json: Out }> {
  const r = await fetch(`${l.base}${path}`, { method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json' }, body: JSON.stringify(body) });
  return { status: r.status, json: (await r.json()) as Out };
}

let demo: TestListener;
let plain: TestListener;
let noModel: TestListener;
const S: Record<string, string> = {};

beforeAll(async () => {
  demo = await serve(demoHandlers);
  plain = await serve(plainHandlers);
  noModel = await serve(noModelHandlers);
  for (const [who, role] of [['author', 'author'], ['reviewer', 'reviewer'], ['second-reviewer', 'reviewer']] as const) {
    const r = await direct(demoHandlers, 'pev.register_role', W.admin, PEV_ACTION.registerRole, { address: W[who].address, role, change: 'add' });
    expect(r['changed']).toBe(true);
  }
  const pub = await direct(demoHandlers, 'pev.author_scenario', W.author, PEV_ACTION.authorScenario, {
    scenario: demoScenarioInput('missed-deadline', 2), status: 'published', draftAssistance: { used: false },
  });
  S['md'] = String(pub['scenarioIri']);
  const rat = await direct(demoHandlers, 'pev.ratify_scenario', W.reviewer, PEV_ACTION.ratifyScenario, { scenarioIri: S['md'], version: 1, scenarioHash: pub['scenarioHash'] });
  expect(rat['status']).toBe('ratified');
}, SLOW);

afterAll(async () => { for (const l of listeners) await l.close(); });

// ═════════════════════════════════════════════════════════════════════════════════════════════
//  HTTP and MCP
// ═════════════════════════════════════════════════════════════════════════════════════════════

describe('the bridge over HTTP: one route and one tool per declared affordance, refusals with their status', () => {
  it('lists every affordance with a pev action, a unique tool name and all four hints; every handler has an affordance', async () => {
    const r = await fetch(`${demo.base}/affordances?format=jsonld`, { headers: { accept: 'application/ld+json' } });
    const m = (await r.json()) as { affordanceCount: number; affordances: { action: string; toolName: string; target: string }[] };
    expect(m.affordanceCount).toBe(pevAffordances.length);
    expect(m.affordances).toHaveLength(Object.keys(PEV_ACTION).length);
    expect(new Set(m.affordances.map((a) => a.toolName)).size).toBe(m.affordances.length);
    expect(new Set(m.affordances.map((a) => a.action))).toEqual(new Set(Object.values(PEV_ACTION)));
    expect(m.affordances.every((a) => a.target.startsWith('http://127.0.0.1:6110/pev/'))).toBe(true);
    for (const a of pevAffordances) {
      const h = a.annotations ?? {};
      expect([typeof h.readOnlyHint, typeof h.destructiveHint, typeof h.idempotentHint, typeof h.openWorldHint], a.toolName).toEqual(['boolean', 'boolean', 'boolean', 'boolean']);
    }
    // A paid model call and a demo signature are not reads: an MCP client must not auto-approve them as read-only.
    const hint = (tool: string): boolean | undefined => pevAffordances.find((a) => a.toolName === tool)?.annotations?.readOnlyHint;
    expect([hint('pev.draft_scenario'), hint('pev.sign_as_demo_role'), hint('pev.say'), hint('pev.judge_attempt')]).toEqual([false, false, false, false]);
    expect(Object.keys(demoHandlers).sort()).toEqual(pevAffordances.map((a) => a.toolName).sort());
  });

  it('answers 401, 403, 409 and 503 as statuses, a read as 200 JSON, and accepts the signed-request envelope as top-level fields', async () => {
    expect((await post(demo, '/pev/say', {})).status).toBe(401);
    const forbidden = await post(demo, '/pev/register_role', { envelope: await envelope(W.learner, PEV_ACTION.registerRole, { address: W.learner.address, role: 'reviewer', change: 'add' }) });
    expect([forbidden.status, forbidden.json['iep:refusalReason']]).toEqual([403, 'not-an-admin']);
    const stale = await post(demo, '/pev/start_attempt', { envelope: await envelope(W['second-learner'], PEV_ACTION.startAttempt, { scenarioIri: S['md'], scenarioVersion: 9, coached: false }) });
    expect([stale.status, stale.json['iep:refusalReason']]).toEqual([409, 'scenario-revised']);
    const started = await direct(demoHandlers, 'pev.start_attempt', W['second-learner'], PEV_ACTION.startAttempt, { scenarioIri: S['md'], scenarioVersion: 1, coached: false });
    const none = await post(noModel, '/pev/say', { envelope: await envelope(W['second-learner'], PEV_ACTION.say, { attemptIri: started['attemptIri'], turnIndex: 1, text: DEMO_LINES.ana[0] }) });
    expect([none.status, none.json['iep:refusalReason']]).toEqual([503, 'no-model-route']);
    expect((none.json['iep:resolvedBy'] as Out)['action']).toBe(PEV_ACTION.counterpartPacket);
    const cal = await fetch(`${demo.base}/pev/calibration`, { headers: { accept: 'application/json' } });
    expect(cal.status).toBe(200);
    expect(Array.isArray(((await cal.json()) as Out)['cells'])).toBe(true);
    const formB = await signedRequestEnvelope(W.admin, { v: 1, action: PEV_ACTION.registerRole, issuedAt: new Date().toISOString(), nonce: nonce(), podUrl: DEMO_POD, address: W['judge-agent'].address, role: 'judge', change: 'add' });
    const b = await post(demo, '/pev/register_role', formB);
    expect([b.status, b.json['recorded']]).toEqual([200, true]);
  }, SLOW);

  it('serves the same affordances as MCP tools; a refusal is an MCP error result', async () => {
    const list = await post(demo, '/mcp', { jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} });
    const tools = ((list.json['result'] as Out)['tools'] as { name: string }[]);
    expect(tools.map((t) => t.name).sort()).toEqual(pevAffordances.map((a) => a.toolName).sort());
    const call = await post(demo, '/mcp', { jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'pev.register_role', arguments: {} } });
    expect((call.json['result'] as Out)['isError']).toBe(true);
  });

  it('signs as a demo role only when the operator gave it demo keys, and only pev actions', async () => {
    const off = await post(plain, '/pev/sign_as_demo_role', {});
    expect([off.status, off.json['iep:refusalReason']]).toEqual([404, 'demo-signing-off']);
    const roles = await post(demo, '/pev/sign_as_demo_role', {});
    expect((roles.json['roles'] as Out[]).map((r) => r['role'])).toEqual([...DEMO_ROLE_NAMES]);
    const other = await post(demo, '/pev/sign_as_demo_role', { role: 'learner', payload: { action: 'urn:iep:action:other:thing' } });
    expect([other.status, other.json['iep:refusalReason']]).toEqual([400, 'not-a-pev-action']);
  });
});

// ═════════════════════════════════════════════════════════════════════════════════════════════
//  What the UI routes serve
// ═════════════════════════════════════════════════════════════════════════════════════════════

function rawGet(port: number, path: string, host: string): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = request({ host: '127.0.0.1', port, path, method: 'GET', headers: { host } }, (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (c: string) => { body += c; });
      res.on('end', () => resolve({ status: res.statusCode ?? 0, body }));
    });
    req.on('error', reject);
    req.end();
  });
}

describe('the web UI is served under a strict content policy', () => {
  it('serves a static shell with no inline script or style, under the policy, uncached and unreferred', async () => {
    const r = await fetch(`${demo.base}/ui`);
    expect(r.status).toBe(200);
    expect(r.headers.get('content-type')).toMatch(/^text\/html/);
    expect(r.headers.get('content-security-policy')).toBe(UI_CSP);
    expect([r.headers.get('x-content-type-options'), r.headers.get('referrer-policy'), r.headers.get('cache-control')]).toEqual(['nosniff', 'no-referrer', 'no-store']);
    const html = await r.text();
    expect(html).not.toMatch(/<script(?![^>]*\ssrc=)[^>]*>/i);
    expect(html).not.toMatch(/\sstyle=|<style/i);
    expect(html).toContain('<script type="module" src="ui/app.js"></script>');
    expect(UI_CSP).toContain("script-src 'self'");
    expect(UI_CSP).not.toContain('unsafe');
    const slash = await fetch(`${demo.base}/ui/`, { redirect: 'manual' });
    expect([slash.status, slash.headers.get('location')]).toEqual([301, '../ui']);
  });

  it('serves the client and its styles with their types and the same policy', async () => {
    const js = await fetch(`${demo.base}/ui/app.js`);
    const css = await fetch(`${demo.base}/ui/app.css`);
    expect([js.status, css.status]).toEqual([200, 200]);
    expect(js.headers.get('content-type')).toMatch(/^text\/javascript/);
    expect(css.headers.get('content-type')).toMatch(/^text\/css/);
    expect([js.headers.get('content-security-policy'), css.headers.get('content-security-policy')]).toEqual([UI_CSP, UI_CSP]);
    expect(await js.text()).toBe(read('bridge/ui/app.js'));
  });

  it('refuses a request whose Host header names another site (DNS rebinding) and answers its own names', async () => {
    const bad = await rawGet(demo.port, '/ui', 'attacker.example');
    expect(bad.status).toBe(421);
    expect(JSON.parse(bad.body)['iep:refusalReason']).toBe('host-not-served');
    expect((await rawGet(demo.port, '/ui', `127.0.0.1:${demo.port}`)).status).toBe(200);
    expect((await rawGet(demo.port, '/health', 'attacker.example')).status).toBe(200);
  });

  it('the client builds every node: no HTML parsing, no eval, no external origin; it signs EIP-191 over the canonical text', () => {
    const js = read('bridge/ui/app.js');
    expect(js).not.toMatch(/innerHTML|outerHTML|insertAdjacentHTML|document\.write|\beval\(|new Function|setAttribute\(\s*['"]on/);
    expect(js).not.toMatch(/fetch\(\s*['"`]https?:|import\(|<script/);
    expect(js).toContain("method: 'personal_sign', params: [hexUtf8(canonicalJson(payload)), S.account]");
    expect(js).toContain("method: 'eth_requestAccounts'");
    expect(js).toContain('DEMO MODE: this bridge holds these role keys and signs as whichever role you pick.');
  });
});

// ═════════════════════════════════════════════════════════════════════════════════════════════
//  The UI, driven
// ═════════════════════════════════════════════════════════════════════════════════════════════

interface Page {
  readonly w: JSDOM['window'];
  readonly d: Document;
  readonly errors: string[];
  until<T>(fn: () => T | null | undefined | false, what: string, ms?: number): Promise<T>;
  q(sel: string): HTMLElement | null;
  all(sel: string): HTMLElement[];
  text(sel: string): string;
  fire(el: Element, type: string): void;
  set(el: Element | null, value: string): void;
  click(sel: string): void;
}

async function openUi(l: TestListener, setup?: (w: JSDOM['window']) => void): Promise<Page> {
  const errors: string[] = [];
  const vc = new VirtualConsole();
  vc.on('jsdomError', (e: Error) => errors.push(`jsdomError: ${e.message}`));
  vc.on('error', (...a: unknown[]) => errors.push(`console.error: ${a.map(String).join(' ')}`));
  const html = await (await fetch(`${l.base}/ui`)).text();
  const dom = new JSDOM(html, { url: `${l.base}/ui`, runScripts: 'outside-only', pretendToBeVisual: true, virtualConsole: vc });
  const w = dom.window;
  // The page's fetch reaches the loopback bridge, relative URLs resolved as a browser would.
  w['fetch'] = (input: unknown, init?: RequestInit): Promise<Response> => fetch(new URL(String(input), w.location.href), init);
  setup?.(w);
  w.eval(await (await fetch(`${l.base}/ui/app.js`)).text());
  const d = w.document;
  const page: Page = {
    w, d, errors,
    async until<T>(fn: () => T | null | undefined | false, what: string, ms = 60_000): Promise<T> {
      const t0 = Date.now();
      for (;;) {
        const v = fn();
        if (v) return v;
        if (Date.now() - t0 > ms) throw new Error(`the page never showed ${what}; it shows: ${(d.querySelector('#view')?.textContent ?? '').slice(0, 600)}`);
        await new Promise((r) => setTimeout(r, 25));
      }
    },
    q: (sel) => d.querySelector<HTMLElement>(sel),
    all: (sel) => [...d.querySelectorAll<HTMLElement>(sel)],
    text: (sel) => d.querySelector(sel)?.textContent ?? '',
    fire: (el, type) => { el.dispatchEvent(new w.Event(type, { bubbles: true })); },
    set: (el, value) => {
      if (!el) throw new Error('no such field');
      (el as HTMLInputElement).value = value;
      el.dispatchEvent(new w.Event('input', { bubbles: true }));
      el.dispatchEvent(new w.Event('change', { bubbles: true }));
    },
    click: (sel) => {
      const el = d.querySelector<HTMLElement>(sel);
      if (!el) throw new Error(`nothing to click at ${sel}`);
      el.click();
    },
  };
  return page;
}

async function asRole(p: Page, role: DemoRoleName): Promise<void> {
  const sel = await p.until(() => p.q('#role'), 'the role picker');
  p.set(sel, role);
  await p.until(() => p.text('#acting-as').includes(DEMO_ROLE_LABELS[role]), `acting as ${role}`);
}

const button = (action: string, extra = ''): string => `button[data-action="${action}"]${extra}`;

describe('the web UI works, driven in a DOM against the real handlers', () => {
  it('a learner practises with the disclosed scripted model, is judged, a reviewer reviews, and only then can the learner project', async () => {
    const p = await openUi(demo);
    await p.until(() => p.text('#bar').includes('DEMO MODE'), 'the demo banner');
    expect(p.text('#bar')).toContain('SCRIPTED: offline fixture, no model ran');
    await asRole(p, 'learner');
    const card = await p.until(() => p.all('article.scenario').find((c) => (c.textContent ?? '').includes('missed deadline')), 'the scenario card');
    expect(card.textContent).toContain('Rubric ratified by a reviewer');
    card.querySelector<HTMLInputElement>('input[type=radio][value=no]')!.checked = true;
    card.querySelector<HTMLElement>(button(PEV_ACTION.startAttempt))!.click();
    await p.until(() => p.q('#line'), 'the conversation');
    for (const line of DEMO_LINES.ana) {
      const before = p.all('.bubble').length;
      p.set(p.q('#line'), line);
      p.click('#send');
      await p.until(() => p.all('.bubble').length === before + 2, `the reply to "${line.slice(0, 24)}…"`);
    }
    const replies = p.all('.bubble.them').slice(1);
    expect(replies.map((b) => b.querySelector('.text')?.textContent)).toEqual(DEMO_LINES.sam.map((x) => x.replace(' (end of conversation)', '')));
    expect(replies.every((b) => (b.textContent ?? '').includes('scripted fixture: no model ran'))).toBe(true);
    await p.until(() => p.q('#end-proposed'), 'the end proposal');
    expect(p.text('#state')).toBe('in conversation');
    p.click('#end-proposed button.primary');
    await p.until(() => p.text('#state') === 'ended: not judged yet', 'the ended state');
    p.click(button(PEV_ACTION.judgeAttempt));
    await p.until(() => p.q('#assessment'), 'the assessment');
    const assessment = p.text('#assessment');
    for (const s of ['Platform-computed', 'provisional, not reviewed', '400 of 600 points · 66.7 %', 'Would not meet the pass rule (provisional, not reviewed)', 'agrees-next-step needs at least partial']) expect(assessment).toContain(s);
    const fabricated = p.all('.quote.bad').find((x) => (x.textContent ?? '').includes(FABRICATED_QUOTE));
    expect(fabricated?.textContent).toContain('not found verbatim in any learner turn');
    expect(p.all('mark').map((m) => m.textContent)).toEqual(['The quarterly report was due Thursday at noon', 'what got in the way this time from your side?', 'send me a status note by Tuesday at 10am']);
    expect(p.text('.judgments')).toContain('The judge\'s words: not part of the score');
    const projections = p.all(button(PEV_ACTION.projectAttempt)) as HTMLButtonElement[];
    expect(projections.map((b) => b.disabled)).toEqual([true, true]);
    expect(projections[0]!.title).toContain('a qualified reviewer has not countersigned');
    const attemptIri = decodeURIComponent(p.w.location.hash.slice('#/attempt/'.length));

    // The reviewer: the queue, then the review form (blind first when the attempt is in the audit sample).
    await asRole(p, 'reviewer');
    p.w.location.hash = '#/review';
    const entry = await p.until(() => p.all('article.queue-entry').find((x) => x.dataset['attempt'] === attemptIri), 'the queue entry');
    expect(entry.textContent).toContain('priority');
    expect(entry.textContent).toContain('a quote did not check out');
    p.w.location.hash = `#/review/${encodeURIComponent(attemptIri)}`;
    await p.until(() => p.q('#review-form select'), 'the review form');
    const blind = inAuditSample(attemptIri);
    expect(p.q('.judgments') === null).toBe(blind);
    expect((p.all('#review-form select') as HTMLSelectElement[]).map((x) => x.value)).toEqual(['', '', '']);
    const picks: Record<string, string> = { 'specific-observation': 'specific', 'asks-their-view': 'first', 'agrees-next-step': 'owner-and-date' };
    for (const [c, level] of Object.entries(picks)) {
      if (blind) expect((p.q('#reveal') as HTMLButtonElement).disabled).toBe(true);
      p.set(p.q(`#review-form select[data-criterion="${c}"]`), level);
    }
    if (blind) {
      p.click('#reveal');
      await p.until(() => p.q('#submit-review'), 'the judge revealed');
      expect(p.q('.judgments')).not.toBeNull();
    }
    expect(p.text('#review-form')).toContain('The judge\'s quote did not check out here');
    p.set(p.q('#review-form textarea[data-why="agrees-next-step"]'), 'Ana agreed a status note by Tuesday at 10am with Sam as its owner; the second quote is not in the transcript.');
    expect(p.text('#submit-review')).toBe('Sign my levels (override)');
    p.click('#submit-review');
    await p.until(() => p.q('#review-form p.recorded') ?? p.q('#review-form .refusal'), 'the review outcome');
    expect(p.text('#review-form .outcome')).toContain('Recorded: levels set by a reviewer. 100.0 %, meets the pass rule.');

    // The learner again: reviewed, ratified, so the statement can be built.
    await asRole(p, 'learner');
    p.w.location.hash = `#/attempt/${encodeURIComponent(attemptIri)}`;
    await p.until(() => p.text('#state') === 'levels set by a reviewer', 'the reviewed state');
    expect(p.text('#assessment')).toContain('Final: a qualified reviewer stated every level.');
    const xapi = p.q(button(PEV_ACTION.projectAttempt, '[data-format="xapi"]')) as HTMLButtonElement;
    expect(xapi.disabled).toBe(false);
    xapi.click();
    await p.until(() => p.q('#projection pre.statement') ?? p.q('#projection .refusal'), 'the statement');
    const statement = JSON.parse(p.text('#projection pre.statement')) as Out;
    expect((statement['verb'] as Out)['id']).toBe('http://adlnet.gov/expapi/verbs/completed');
    expect(((statement['context'] as Out)['extensions'] as Out)[`${PEV_NS}practiceEvidence`]).toBe(true);
    expect(p.text('#projection')).toContain('Nothing was sent anywhere.');
    expect(p.errors).toEqual([]);
  }, SLOW);

  it('an author drafts with the bridge model and publishes after classifying; an admin changes a role; markup in a line stays text', async () => {
    const p = await openUi(demo);
    await p.until(() => p.q('article.scenario'), 'the scenarios');
    await asRole(p, 'author');
    p.w.location.hash = '#/author';
    await p.until(() => p.q(button(PEV_ACTION.draftScenario)), 'the author form');
    p.set(p.q('textarea[aria-label="Brief"]'), 'A project manager tells a client sponsor that two defects block the payment flow.');
    p.click(button(PEV_ACTION.draftScenario));
    await p.until(() => (p.q('[data-field="title"] input') as HTMLInputElement | null)?.value, 'the drafted form');
    expect((p.q('[data-field="title"] input') as HTMLInputElement).value).toBe('Renegotiating a deadline with a client');
    expect(p.text('#view')).toContain('scripted fixture: no model ran');
    expect((p.q('[data-field="choice"] input[value="receipt"]') as HTMLInputElement).checked).toBe(true);
    // Classify first: nothing is sent until the use and the work read are declared.
    p.click(button(PEV_ACTION.authorScenario, '[data-status="published"]'));
    await p.until(() => p.text('#author-result').includes('Decide how this will be used'), 'the classify-first prompt');
    const choose = (field: string, value: string): void => {
      const r = p.q(`[data-field="${field}"] input[value="${value}"]`) as HTMLInputElement;
      r.checked = true;
      p.fire(r, 'change');
    };
    choose('assessmentUse', 'pass-gate');
    choose('workRegime', 'emergent');
    expect(p.text('#view')).toContain('A pass gate assumes a knowable good answer');
    expect(p.q('[data-field="passGateWhy"]')).not.toBeNull();
    choose('assessmentUse', 'feedback-only');
    expect(p.q('[data-field="passGateWhy"]')).toBeNull();
    p.click(button(PEV_ACTION.authorScenario, '[data-status="published"]'));
    await p.until(() => p.text('#author-result').includes('Saved version') || p.q('#author-result .refusal'), 'the saved scenario');
    expect(p.text('#author-result')).toContain('Saved version 1 as published (Hypothetical).');
    const listed = (await demoHandlers['pev.list_scenarios']!({})) as { scenarios: Out[] };
    const rs = listed.scenarios.find((s) => s['scenarioKey'] === 'renegotiate-scope');
    expect([(rs?.['draftAssistance'] as Out)['measured'], (rs?.['draftAssistance'] as Out)['editedAfterDraft'], rs?.['assessmentUse']]).toEqual([true, false, 'feedback-only']);

    await asRole(p, 'admin');
    p.w.location.hash = '#/roles';
    await p.until(() => p.q(button(PEV_ACTION.registerRole)), 'the roles form');
    p.set(p.q('input[aria-label="Address"]'), W['judge-agent'].address);
    p.set(p.q('select[aria-label="Role"]'), 'agent');
    p.click(button(PEV_ACTION.registerRole));
    await p.until(() => p.q('#view .outcome table') ?? p.q('#view .refusal'), 'the registry');
    expect(p.all('#view .outcome tr').some((tr) => (tr.textContent ?? '').includes(W['judge-agent'].address) && (tr.textContent ?? '').includes('agent'))).toBe(true);

    await asRole(p, 'second-learner');
    p.w.location.hash = '#/practice';
    const card = await p.until(() => p.all('article.scenario').find((c) => (c.textContent ?? '').includes('missed deadline')), 'the scenario card');
    card.querySelector<HTMLInputElement>('input[type=radio][value=yes]')!.checked = true;
    card.querySelector<HTMLElement>(button(PEV_ACTION.startAttempt))!.click();
    await p.until(() => p.q('#line'), 'the conversation');
    const markup = '<img src=x onerror="window.__pwned=1"><b>bold</b> & "quotes"';
    p.set(p.q('#line'), markup);
    p.click('#send');
    await p.until(() => p.all('.bubble').length === 3, 'the reply');
    expect(p.all('.bubble.me .text').map((x) => x.textContent)).toEqual([markup]);
    expect([p.all('img').length, p.all('#view b').length, p.w['__pwned']]).toEqual([0, 0, undefined]);
    expect(p.all('.bubble.them')[1]?.querySelector('.text')?.textContent).toBe('Go on.');

    p.w.location.hash = `#/results/${encodeURIComponent(S['md'] ?? '')}`;
    await asRole(p, 'author');
    await p.until(() => p.q('table.distribution') ?? p.q('#view .refusal'), 'the results');
    expect(p.text('#view')).toContain('Practice results: what happened in practice. They do not show what caused it.');
    p.w.location.hash = '#/calibration';
    await p.until(() => p.text('#view h2') === 'Calibration of the judges', 'the calibration view');
    await p.until(() => p.text('#view').includes('This is not accuracy against a known answer.'), 'the metric note');
    expect(p.errors).toEqual([]);
  }, SLOW);

  it('wallet mode signs with personal_sign over the canonical text; paste mode shows that exact text and takes the signature', async () => {
    // A window.ethereum that signs exactly as personal_sign does: the message is the hex of the UTF-8 bytes.
    const ana = W.learner;
    const calls: string[] = [];
    const wallet = await openUi(plain, (w) => {
      w['TextEncoder'] = TextEncoder;
      w['ethereum'] = {
        request: async ({ method, params }: { method: string; params?: string[] }): Promise<unknown> => {
          calls.push(method);
          if (method === 'eth_requestAccounts') return [ana.address];
          if (method === 'personal_sign') return signMessageRaw(ana, Buffer.from(String(params?.[0]).slice(2), 'hex').toString('utf8'));
          throw new Error(`unsupported ${method}`);
        },
      };
    });
    await wallet.until(() => wallet.q('article.scenario'), 'the scenarios');
    expect(wallet.text('#acting-as')).toBe('whoever signs (paste mode)');
    wallet.all('#bar button').find((b) => b.textContent === 'Connect wallet')!.click();
    await wallet.until(() => wallet.text('#acting-as').startsWith('your wallet'), 'the connected wallet');
    const card = await wallet.until(() => wallet.q('article.scenario'), 'the scenarios, again');
    card.querySelector<HTMLInputElement>('input[type=radio][value=no]')!.checked = true;
    const help = 'Read the café guide — naïvely, “twice”';
    wallet.set(card.querySelector('input[aria-label="Assistance"]'), help);
    card.querySelector<HTMLElement>(button(PEV_ACTION.startAttempt))!.click();
    await wallet.until(() => wallet.q('#line') ?? wallet.q('#view .refusal'), 'the conversation');
    expect(wallet.q('#line')).not.toBeNull();
    expect(wallet.text('#view')).toContain(`Help declared at the start: ${help}`);
    expect(calls.filter((c) => c === 'personal_sign').length).toBeGreaterThanOrEqual(2);
    expect(wallet.errors).toEqual([]);

    const ben = W['second-learner'];
    const paste = await openUi(plain);
    await paste.until(() => paste.q('article.scenario'), 'the scenarios');
    const pc = paste.q('article.scenario')!;
    pc.querySelector<HTMLInputElement>('input[type=radio][value=yes]')!.checked = true;
    pc.querySelector<HTMLElement>(button(PEV_ACTION.startAttempt))!.click();
    for (let signed = 0; signed < 2; signed++) {
      const text = await paste.until(() => (paste.q('#signing textarea[readonly]') as HTMLTextAreaElement | null)?.value, 'the text to sign');
      const shown = JSON.parse(paste.text('#signing pre.json')) as Out;
      expect(text).toBe(canonicalJson(shown));
      expect(shown['action']).toBe(signed === 0 ? PEV_ACTION.startAttempt : PEV_ACTION.getAttempt);
      paste.set(paste.q('#signing textarea[aria-label="Signature"]'), await signMessageRaw(ben, text));
      paste.all('#signing button').find((b) => b.textContent === 'Use this signature')!.click();
      await paste.until(() => !paste.q('#signing textarea[readonly]') || (paste.q('#signing textarea[readonly]') as HTMLTextAreaElement).value !== text, 'the next step');
    }
    await paste.until(() => paste.q('#line') ?? paste.q('#view .refusal'), 'the conversation');
    expect(paste.q('#line')).not.toBeNull();
    expect(paste.errors).toEqual([]);
  }, SLOW);
});

// ═════════════════════════════════════════════════════════════════════════════════════════════
//  Sources
// ═════════════════════════════════════════════════════════════════════════════════════════════

function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) { if (name !== 'tests' && name !== 'node_modules') out.push(...sourceFiles(p)); }
    else if (/\.(ts|js)$/.test(name)) out.push(p);
  }
  return out;
}

describe('server.ts composes and listens; every other file keeps to its rules', () => {
  const server = read('bridge/server.ts');
  const others = sourceFiles(VERTICAL).filter((f) => !f.endsWith(join('bridge', 'server.ts')));

  it('only server.ts reads the environment or imports the ontology-serving module; nothing samples a client model', () => {
    const ENV = new RegExp(['process', 'env'].join('\\.'));
    expect(ENV.test(server)).toBe(true);
    expect(server).toContain("from '../../_shared/ontology-serve/index.js'");
    for (const f of others) {
      const src = readFileSync(f, 'utf8');
      expect([relative(VERTICAL, f), ENV.test(src), src.includes('ontology-serve/')]).toEqual([relative(VERTICAL, f), false, false]);
      expect(src).not.toMatch(/createMessage|sampling\/createMessage/);
    }
  });

  it('binds to loopback by default, gates demo keys on a loopback host, guards loopback binds, and serves the UI', () => {
    expect(server).toMatch(/const HOST = env\('HOST'\) \?\? '127\.0\.0\.1';/);
    expect(server).toMatch(/if \(demoOn && !loopback\) \{/);
    // Demo keys never run beside a configured platform key or behind a public deployment URL.
    expect(server).toMatch(/if \(demoOn && !baseIsLoopback\) \{/);
    expect(server).toMatch(/if \(demoOn && keyHex\) \{/);
    // Any public pod is an explicit '*', the bridge's model is for registered addresses unless the operator says anyone, and budgets apply.
    expect(server).toMatch(/const anyPod = servedRaw === '\*';/);
    expect(server).toMatch(/const modelFor = env\('PEV_BRIDGE_MODEL_FOR'\) === 'anyone' \? 'anyone' : 'registered';/);
    expect(server).toMatch(/bridgeModelFor: modelFor, budgets,/);
    expect(server).toMatch(/if \(loopback\) a\.use\(hostAllowlistGuard\(allowedHosts\)\);/);
    expect(server).toContain('attachUi(a);');
    expect(server).toContain("{ label: 'Web UI', href: `${base}/ui`, rel: 'alternate', type: 'text/html' }");
    expect(server).not.toMatch(/scriptedTextModel|scriptedPracticeModel|demo\/run/);
  });

  it('sends the operator pod credential only through operatorPodFetch, and holder copies through a separate fetch', () => {
    expect(server).toMatch(/fetchFn: operatorPodFetch\(defaultPodUrl, writeSecret, baseFetch\)/);
    expect(server).toMatch(/holderFetchFn: baseFetch/);
    expect(server).toMatch(/const writeSecret = env\('PEV_POD_WRITE_SECRET'\);/);
    const reads = /env\(\s*'PEV_POD_WRITE_SECRET'|\[\s*'PEV_POD_WRITE_SECRET'\s*\]/;
    expect(others.filter((f) => reads.test(readFileSync(f, 'utf8'))).map((f) => relative(VERTICAL, f))).toEqual([]);
  });

  it('reads PEV_RECORD_KEY only in server.ts and refuses a malformed one; operator records are sealed, holder copies never', () => {
    expect(server).toMatch(/const recordKeyHex = env\('PEV_RECORD_KEY'\);/);
    expect(server).toContain("const RECORD_KEY_HEX = /^(0x)?[0-9a-fA-F]{64}$/;");
    expect(server).toMatch(/if \(recordKeyHex !== undefined && !RECORD_KEY_HEX\.test\(recordKeyHex\)\) \{\n[^}]*Not listening\.'\);\n\s*process\.exitCode = 1;\n\s*return;/);
    expect(server).toContain("deriveEncryptionKeyPair(recordKeyHex, 'pev-records')");
    expect(server).toMatch(/\.\.\.\(recordKey \? \{ recordKey \} : \{\}\),/);
    expect(server).toContain('Set PEV_RECORD_KEY (64 hex) to encrypt them');
    const reads = /env\(\s*'PEV_RECORD_KEY'|\[\s*'PEV_RECORD_KEY'\s*\]/;
    expect(others.filter((f) => reads.test(readFileSync(f, 'utf8'))).map((f) => relative(VERTICAL, f))).toEqual([]);
    // Exactly two publishes: the operator record write, sealed when there is a key, and the holder copy, which never is.
    const handlers = read('bridge/handlers.ts');
    const publishes = handlers.split('await publishPevRecord({').slice(1).map((x) => x.slice(0, x.indexOf('});')));
    expect(publishes).toHaveLength(2);
    expect(publishes.map((x) => [x.includes('PEV_COPIES_CONTAINER'), x.includes('sealTo')])).toEqual([[false, true], [true, false]]);
    expect(handlers).toContain('...(ctx.trusted.recordKey ? { sealTo: ctx.trusted.recordKey } : {}),');
  });

  it('PEV_REQUIRE_RECORD_KEY=1 stops a bridge whose record key is missing or blank before it listens, and the image sets it', () => {
    expect(server).toMatch(/const requireRecordKey = requireRaw === '1';/);
    expect(server).toMatch(/if \(recordKeyHex === undefined && requireRecordKey\) \{\n[^}]*Not listening\.'\);\n\s*process\.exitCode = 1;\n\s*return;/);
    const image = readFileSync(join(REPO, 'deploy/Dockerfile.pev-bridge'), 'utf8');
    expect(image).toMatch(/^ENV PEV_REQUIRE_RECORD_KEY=1$/m);
    expect(image).toMatch(/^ENV PEV_RECORD_KEY=$/m);
    expect(image).toMatch(/^#\s+PEV_RECORD_KEY\s+64 hex[\s\S]*?BACK IT UP/m);
    // The server itself, run under tsx as the image runs it, with nothing else in its environment.
    const run = (extra: Record<string, string>): { status: number | null; out: string; err: string } => {
      const r = spawnSync(process.execPath, ['--import', 'tsx', join(VERTICAL, 'bridge/server.ts')], {
        cwd: REPO, encoding: 'utf8', timeout: 120_000, env: { NODE_NO_WARNINGS: '1', PORT: '0', ...extra },
      });
      return { status: r.status, out: r.stdout, err: r.stderr };
    };
    const KEY = 'ab'.repeat(32);
    const missing: readonly Record<string, string>[] = [{ PEV_REQUIRE_RECORD_KEY: '1' }, { PEV_REQUIRE_RECORD_KEY: '1', PEV_RECORD_KEY: '  ' }];
    for (const extra of missing) {
      const r = run(extra);
      expect([r.status, r.out.includes('listening on'), r.err], JSON.stringify(extra))
        .toEqual([1, false, expect.stringContaining('PEV_REQUIRE_RECORD_KEY=1 and PEV_RECORD_KEY is not set (or is blank')]);
    }
    const typo = run({ PEV_REQUIRE_RECORD_KEY: 'yes', PEV_RECORD_KEY: KEY });
    expect([typo.status, typo.err]).toEqual([1, expect.stringContaining('PEV_REQUIRE_RECORD_KEY is "yes"; it takes 1')]);
    // A valid key passes the guard: this run goes on to the next check (demo keys on a public host) and stops there.
    const passes = run({ PEV_REQUIRE_RECORD_KEY: '1', PEV_RECORD_KEY: `0x${KEY}`, PEV_DEMO_ROLES: '1', HOST: '0.0.0.0' });
    expect([passes.status, passes.err.includes('PEV_RECORD_KEY'), passes.err]).toEqual([1, false, expect.stringContaining('PEV_DEMO_ROLES=1 needs a loopback HOST')]);
  }, 300_000);

  it('no instruction or label the platform shows says no', () => {
    const DECLINE = /\b(error|reason|refused|denied|forbidden|unauthori[sz]ed|invalid|pending|rejected|conflict|unavailable)\b/i;
    const shown = Object.entries(practice).filter(([k, v]) => typeof v === 'string' && /(INSTRUCTIONS|NOTE|LABEL|RULE)$/.test(k));
    expect(shown.length).toBeGreaterThanOrEqual(10);
    expect(shown.filter(([, v]) => DECLINE.test(String(v))).map(([k]) => k)).toEqual([]);
  });

  it('the published human page names every term the ontology declares', () => {
    const ttl = readFileSync(join(REPO, 'docs/applications/practice-evidence/pev.ttl'), 'utf8');
    const html = readFileSync(join(REPO, 'docs/applications/practice-evidence/pev.html'), 'utf8');
    const terms = new Set<string>();
    for (const q of new Parser().parse(ttl)) if (q.subject.value.startsWith(PEV_NS)) terms.add(q.subject.value.slice(PEV_NS.length));
    expect(terms.size).toBeGreaterThan(100);
    expect([...terms].filter((t) => !html.includes(`id="${t}"`))).toEqual([]);
    expect(html).toContain('<link rel="alternate" type="text/turtle" href="pev.ttl" />');
  });
});
