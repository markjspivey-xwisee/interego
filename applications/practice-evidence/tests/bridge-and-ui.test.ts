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
import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { request } from 'node:http';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { JSDOM, VirtualConsole } from 'jsdom';
import { Parser } from 'n3';
import { canonicalJson, importWallet, parseHypermediaMarkdown, sha256, sha256Hex, signMessageRaw, type Wallet } from '@interego/core';
import type { Express, NextFunction, Request as ExpressRequest, Response as ExpressResponse } from 'express';
import { chatAgentJs } from '../../_shared/chat-agent/index.js';
import { createVerticalBridge } from '../../_shared/vertical-bridge/index.js';
import { listenLoopback, type TestListener } from '../../_shared/vertical-bridge/listen-loopback.js';
import { pevAffordances } from '../affordances.js';
import { createPevHandlers, DEMO_ROLE_NAMES, type DemoRoleName, type PevDeps } from '../bridge/handlers.js';
import { attachUi, connectorPages, contactPages, contactUrlOf, DEFAULT_CONNECTOR_ADDRESS, hostAllowlistGuard, UI_CSP } from '../bridge/ui.js';
import {
  DEMO_LINES, DEMO_POD, DEMO_ROLE_LABELS, FABRICATED_QUOTE, demoDraft, demoScenarioInput, demoSignerOf, demoWallet, inMemoryPod, scriptedPracticeModel,
} from '../demo/run.js';
import { inAuditSample } from '../src/calibration.js';
import { PEV_ACTION, PEV_NS } from '../src/ontology.js';
import * as practice from '../src/practice.js';
import { signEnvelope, signedRequestEnvelope, RECORD_CLASS } from '../src/records.js';

type Out = Record<string, unknown>;
type Handlers = Record<string, (args: Record<string, unknown>) => Promise<unknown>>;

const SLOW = 240_000;
const HERE = fileURLToPath(new URL('.', import.meta.url));
const VERTICAL = join(HERE, '..');
const REPO = join(VERTICAL, '..', '..');
const read = (p: string): string => readFileSync(join(VERTICAL, p), 'utf8');
/**
 * The stylesheet as a screen `px` wide applies it, for jsdom, which lays nothing out and applies an `@media screen` rule but
 * no width query: each min-width or max-width query (every one this stylesheet has is in em, alone) is kept, as `screen`,
 * where that width meets it, and set aside, as `print`, where it does not. Real Chromium from 300 px up is the QA's check.
 */
const atWidth = (css: string, px: number): string =>
  css.replace(/@media \((min|max)-width: ([\d.]+)em\)/g, (_m, k: string, em: string) => `@media ${(k === 'min' ? px >= Number(em) * 16 : px <= Number(em) * 16) ? 'screen' : 'print'}`);

// ═════════════════════════════════════════════════════════════════════════════════════════════
//  The world: one pod, demo role wallets, three bridges
// ═════════════════════════════════════════════════════════════════════════════════════════════

const pod = inMemoryPod();
const W = Object.fromEntries(DEMO_ROLE_NAMES.map((r) => [r, demoWallet(r)])) as Record<DemoRoleName, Wallet>;
/** The identity host Interego sign-in names people on; the route itself is off on these three bridges. */
const IDH = 'identity.demo.test';
const base: PevDeps = {
  platformWallet: demoWallet('platform'), platformKeyKind: 'demo-fixture', adminAddresses: [W.admin.address],
  fetchFn: pod.fetchFn, holderFetchFn: pod.fetchFn, defaultPodUrl: DEMO_POD, servedPods: [DEMO_POD], deploymentUrl: 'http://127.0.0.1:6110',
  relayDelegation: { relayAddresses: [], identityHost: IDH, fetchDidDocument: async () => { throw new Error('no identity host in this test'); } },
};
/** Scripted model + demo role keys: the UI's demo mode. */
const demoHandlers = createPevHandlers({ ...base, model: scriptedPracticeModel(), demoSigner: demoSignerOf(W) }) as Handlers;
/** Scripted model, no demo keys: the UI's wallet and paste modes. */
const plainHandlers = createPevHandlers({ ...base, model: scriptedPracticeModel() }) as Handlers;
/** No model at all. */
const noModelHandlers = createPevHandlers(base) as Handlers;

/** The app as server.ts composes it, minus the ontology module (which no test may import). */
function bridgeApp(handlers: Handlers, allowed: string[], ui: Parameters<typeof attachUi>[1] = {}): Express {
  return createVerticalBridge({
    verticalName: 'practice-evidence', affordances: pevAffordances, handlers, deploymentUrl: 'http://127.0.0.1:6110', defaultPodUrl: DEMO_POD,
    hypermediaLinks: [{ label: 'Web UI', href: 'http://127.0.0.1:6110/ui', rel: 'alternate', type: 'text/html' }],
    middleware: (a) => {
      // The port is known only after listening, so the allowed names are read per request.
      a.use((req: ExpressRequest, res: ExpressResponse, next: NextFunction) => hostAllowlistGuard(allowed)(req, res, next));
      attachUi(a, ui);
    },
  });
}

const listeners: TestListener[] = [];
async function serve(handlers: Handlers, ui: Parameters<typeof attachUi>[1] = {}): Promise<TestListener> {
  const allowed: string[] = [];
  const l = await listenLoopback(bridgeApp(handlers, allowed, ui));
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

  it('every signed affordance declares the relay\'s {_signed_payload, _signature} beside envelope, so act … sign_payload:true reaches it', () => {
    // The scenario list is plain or signed (a signed read that is not a chat assistant's carries the stakes), so it declares them too.
    const unsigned = new Set(['pev.calibration', 'pev.draft_scenario_packet', 'pev.sign_as_demo_role']);
    const signed = pevAffordances.filter((a) => !unsigned.has(a.toolName));
    expect(signed).toHaveLength(pevAffordances.length - unsigned.size);
    for (const a of signed) {
      const names = (a.inputs ?? []).map((i) => i.name);
      expect(['envelope', '_signed_payload', '_signature'].filter((n) => !names.includes(n)), a.toolName).toEqual([]);
      expect((a.inputs ?? []).filter((i) => i.name.startsWith('_') || i.name === 'envelope').every((i) => i.required === false), a.toolName).toBe(true);
    }
  });

  it('a body the Interego relay signed reaches the handler at the top level over HTTP, and as MCP arguments', async () => {
    const relayW = importWallet(`0x${sha256('pev-ui-test:relay')}`, 'agent', 'relay');
    const person = `did:web:${IDH}:users:u-pk-00000000ff01`;
    const agent = `did:web:${IDH}:agents:claude-u-pk-00000000ff01`;
    const reads: string[] = [];
    const h = createPevHandlers({
      ...base, model: scriptedPracticeModel(),
      relayDelegation: { relayAddresses: [relayW.address], identityHost: IDH, fetchDidDocument: async (url) => { reads.push(url); return { id: agent, controller: person }; } },
    }) as Handlers;
    const l = await serve(h);
    const signedBody = async (): Promise<Out> => {
      const sp = JSON.stringify({ v: 1, action: PEV_ACTION.getAttempt, nonce: nonce(), pod_url: DEMO_POD, agent_id: agent, subject_pod_url: 'https://pods.demo.test/self/', timestamp: new Date().toISOString() });
      return { _signed_payload: sp, _signature: await signMessageRaw(relayW, `sha256:${sha256Hex(sp)}`) };
    };
    const r = await post(l, '/pev/get_attempt', await signedBody());
    expect([r.status, r.json['attempts']]).toEqual([200, []]);
    expect(reads).toEqual([`https://${IDH}/agents/claude-u-pk-00000000ff01/did.json`]);
    const mcp = await post(l, '/mcp', { jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'pev.get_attempt', arguments: await signedBody() } });
    expect((mcp.json['result'] as Out)['isError']).not.toBe(true);
    // Signed by any other key, the same body is a key-held envelope that names someone else.
    const sp = JSON.stringify({ v: 1, action: PEV_ACTION.getAttempt, nonce: nonce(), pod_url: DEMO_POD, agent_id: agent, timestamp: new Date().toISOString() });
    const forged = await post(l, '/pev/get_attempt', { _signed_payload: sp, _signature: await signMessageRaw(W.learner, `sha256:${sha256Hex(sp)}`) });
    expect([forged.status, forged.json['iep:refusalReason']]).toEqual([401, 'signer-is-not-the-named-agent']);
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
    // The shared chat-agent helpers, then this product's client: one script, so the shell keeps one <script>.
    expect(await js.text()).toBe(`${chatAgentJs()}\n${read('bridge/ui/app.js')}`);
  });

  it('serves a client that is valid as the module a browser loads: no top-level name of the app collides with the shared helpers', async () => {
    const served = await (await fetch(`${demo.base}/ui/app.js`)).text();
    const dir = mkdtempSync(join(tmpdir(), 'pev-app-'));
    try {
      const file = join(dir, 'app.mjs');
      writeFileSync(file, served);
      // `node --check` parses a .mjs file as a module: a duplicate top-level declaration is an early error there.
      const r = spawnSync(process.execPath, ['--check', file], { encoding: 'utf8', timeout: 60_000 });
      expect([r.status, r.stderr]).toEqual([0, '']);
      writeFileSync(file, `${served}\nfunction InteregoChatAgent() {}\n`);
      expect(spawnSync(process.execPath, ['--check', file], { encoding: 'utf8', timeout: 60_000 }).stderr).toContain("Identifier 'InteregoChatAgent' has already been declared");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
    // The client names the shared helpers and never redefines one of them.
    expect(read('bridge/ui/app.js')).not.toMatch(/^(?:const|let|var|function|class)\s+InteregoChatAgent\b/m);
  });

  /** What a browser sends for a page: text/html first, with `*\/*` at a lower weight. */
  const BROWSER = 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8';
  const NO_INLINE_SCRIPT = /<script(?![^>]*\ssrc=)[^>]*>/i;
  const NO_INLINE_STYLE = /\sstyle=|<style/i;
  /**
   * The connector address of relay.example.test as the pages write it: the same text, with a break
   * point after `//` and before each other `/` and each `.`, so on a phone it wraps between its
   * parts and `/mcp` stays whole (it once broke as `…/mc` and `p`).
   */
  const EXAMPLE_CONNECTOR_HTML = 'https://<wbr>relay<wbr>.example<wbr>.test<wbr>/mcp';
  const ASSET_ELSEWHERE = /(?:src|<link[^>]+href)="(?:https?:)?\/\//i;
  /** OpenAI's own setup guide, which the ChatGPT steps follow and link to. */
  const OPENAI_GUIDE = 'https://developers.openai.com/api/docs/guides/custom-mcp-server';
  /** A claim about which plans offer custom connectors: each company's to say, and it changes, so no page makes one. */
  const PLAN_CLAIM = /plans? (?:that|which) allows?|needs a plan|plan must|plans? (?:can't|don't|without)|Some \w+ plans|\b(?:Plus|Pro|Business|Enterprise|Team) plan/i;

  it('serves the landing page to a browser at / as a constant, under the UI policy, in customer words', async () => {
    const r = await fetch(`${demo.base}/`, { headers: { accept: BROWSER } });
    expect(r.status).toBe(200);
    expect(r.headers.get('content-type')).toMatch(/^text\/html/);
    expect(r.headers.get('content-security-policy')).toBe(UI_CSP);
    expect([r.headers.get('x-content-type-options'), r.headers.get('referrer-policy'), r.headers.get('cache-control')]).toEqual(['nosniff', 'no-referrer', 'no-store']);
    expect(r.headers.get('vary')).toMatch(/accept/i);
    const html = await r.text();
    // This bridge offers no Interego sign-in, so its page is the file with only the copy-and-paste words.
    expect(html).toBe(connectorPages(contactPages(), null).landing);
    // Where a chat assistant can connect, the connector's steps instead, with this workspace's relay.
    const connected = connectorPages(contactPages(), { relayUrl: 'https://relay.example.test' }).landing;
    for (const page of [html, connected]) {
      expect(page).not.toMatch(/<script/i);
      expect(page).not.toMatch(NO_INLINE_STYLE);
      expect(page).not.toMatch(/<!--\/?(no-)?connector-->/);
      for (const s of [
        '<link rel="stylesheet" href="ui/app.css">', 'href="ui#/signin"', 'href="https://wrd-bridge-production.up.railway.app/"',
        'Conversation practice <em>your reviewers can stand behind.</em>', 'AI role-play is easy to buy. Its scores are hard to trust.',
        'From first sign-in to a result you can stand behind', 'Built for trust, not just for scoring', 'Use it from Claude or ChatGPT',
        'When Practice Evidence isn\'t the right fit (yet)', 'Practice Evidence records practice, not a credential.',
        // No AI of its own and no key: the person's own assistant, and an honest limit for teams without one.
        'No API key, ever.', 'Your people don\'t use an AI assistant.', 'with their own AI assistant playing the other person',
        'the company behind your assistant processes it under your own account\'s terms',
      ]) expect(page).toContain(s);
      expect(page).not.toMatch(/built-in AI|AI provider key|AI role-player/);
      // No protocol words, codes or statuses reach a visitor.
      const visible = page.replace(/<[^>]+>/g, ' ');
      expect(visible).not.toMatch(/\b(affordance|bridge|envelope|nonce|EIP-191|Hypothetical|DID)\b/);
      expect(visible).not.toMatch(/HTTP \d{3}/);
    }
    // Without sign-in: copy and paste, said plainly, and no connector to set up in vain.
    for (const s of ['On this workspace: copy and paste', 'This workspace doesn\'t offer Interego sign-in, so a chat assistant can\'t connect to it.',
      'Sign in with a crypto wallet, or sign each step with your own key.']) expect(html).toContain(s);
    for (const s of ['/mcp', 'Set it up in four steps', 'Connect your AI', 'with a passkey', 'No connector?']) expect(html).not.toContain(s);
    // Its security answer and its limits name no sign-in service and no connector it does not offer.
    for (const s of ['Interego sign-in service', 'holds your sign-in for up to an hour', 'the Interego connector passes', 'Claude or ChatGPT with the Interego connector, or any chat app']) expect(html).not.toContain(s);
    for (const s of ['When you copy a step into Claude, ChatGPT or another chat app, it sees what you paste', 'Claude, ChatGPT or any chat app, with copy and paste.']) expect(html).toContain(s);
    for (const s of ['Interego sign-in service', 'the Interego connector passes', 'Claude or ChatGPT with the Interego connector, or any chat app']) expect(connected).toContain(s);
    // With it: the four steps, the relay this workspace signs in through, and nothing about not offering it.
    for (const s of ['Set it up in four steps', `<code>${EXAMPLE_CONNECTOR_HTML}</code>`, 'Connect your AI', 'with a passkey', 'No connector? Copy and paste.',
      // ChatGPT's steps in the order its dialog asks, as the Connect dialog's ChatGPT tab gives them: the server, then its URL and OAuth,
      // then the risk warning (a step of its own in OpenAI's guide), creating the plugin and installing it.
      '<li class="step"><p class="step__text">In Claude, open Settings, then Connectors, then Add custom connector. In ChatGPT on the web, open Plugins → + → Add custom MCP server (<a', `<a href="${OPENAI_GUIDE}" rel="noopener">OpenAI's guide to custom MCP servers</a>`,
      // Signing in is every app's step, so the step that holds it says so rather than reading as ChatGPT's alone.
      '<li class="step"><p class="step__text">In ChatGPT, accept the warning, create it as a plugin and install it. In either app, sign in with your Interego account when asked.</p></li>',
      'Whether you can add a connector depends on your plan or workspace settings.', 'A judge your admin appoints, a different person with their own Interego account, assesses it',
      // The bridge refuses a judgment from the principal that started the session, so each claim names the account or wallet it was started with.
      'You can\'t assess a session with the account or wallet you started it with, and neither can your assistant on a session you started with your Interego account, even in a new chat.']) expect(connected).toContain(s);
    expect(connected.indexOf('as its Server URL, with OAuth')).toBeLessThan(connected.indexOf('accept the warning'));
    expect(connected.indexOf('accept the warning')).toBeLessThan(connected.indexOf('sign in with your Interego account when asked'));
    expect(connected).not.toMatch(/Add custom MCP server, accept the warning/);
    expect(connected).not.toContain('Then sign in with your Interego account');
    expect(html).toContain('You can\'t assess a session with the wallet you started it with, and neither can your assistant. A judge your admin appoints assesses it with their own AI assistant.');
    for (const page of [html, connected]) expect(page).not.toContain('You can\'t assess your own session');
    expect(html).not.toContain('developers.openai.com');
    for (const page of [html, connected]) expect(page).not.toMatch(PLAN_CLAIM);
    for (const s of [DEFAULT_CONNECTOR_ADDRESS, 'doesn\'t offer Interego sign-in', 'On this workspace: copy and paste']) expect(connected).not.toContain(s);
  });

  it('says what is enforced: the weights and the pass mark are left out of what is sent a chat assistant, which a scenario list read by nobody in particular bears out, and a judge still assesses in a new chat', async () => {
    // What list-scenarios gives an assistant a person asks to list them: a scored scenario's criteria and levels in words,
    // and none of its weights, level values or pass rule (an answer to a chat is the same; see chat-stakes.test.ts).
    const listed = (await demoHandlers['pev.list_scenarios']!({})) as { scenarios: Out[]; stakesWithheld?: string };
    const md = listed.scenarios.find((s) => s['scenarioIri'] === S['md']);
    const rubric = md?.['rubric'] as { criteria: Out[] } & Out;
    expect([md?.['assessmentUse'], 'passRule' in rubric, rubric.criteria.every((c) => !('weight' in c) && (c['levels'] as Out[]).every((l) => !('value' in l))), typeof listed.stakesWithheld])
      .toEqual(['pass-gate', false, true, 'string']);
    const off = connectorPages(contactPages(), null);
    const on = connectorPages(contactPages(), { relayUrl: 'https://relay.example.test' });
    const faq = (page: string): string => /<summary class="faq__q">How is AI used\?<\/summary><div class="faq__a"><p>(.*?)<\/p>/.exec(page)?.[1] ?? '';
    const feature = (page: string): string => /<h3 class="feature__title">AI declared and checked<\/h3><p class="feature__text">(.*?)<\/p>/.exec(page)?.[1] ?? '';
    const section = (page: string, id: string): string => page.slice(page.indexOf(`<section id="${id}"`), page.indexOf('</section>', page.indexOf(`<section id="${id}"`)));
    // The three AI steps never hand an assistant the stakes, and no answer to a chat does: where an assistant can connect,
    // the page says the answers leave them out; either way the web app shows them to people. It claims no more than is
    // enforced: a key the person gives an AI tool reads what the person reads (chat-stakes.test.ts).
    const steps = 'AI never decides how a scenario is used, never calculates a score and never has the final say. None of those three steps gives an assistant the weights or the pass mark';
    const keyHeld = ' with an address an admin registered. An AI tool you give your own signing key to reads what you read.';
    expect(faq(on.landing).endsWith(`${steps}, nor does anything Practice Evidence sends a chat assistant through the Interego connector. The web app shows them to people signed in with Interego, or${keyHeld}`)).toBe(true);
    expect(faq(off.landing).endsWith(`${steps}. The web app shows them to people signed in${keyHeld}`)).toBe(true);
    for (const page of [on.landing, off.landing]) {
      expect(feature(page)).toBe('Every AI reply and every AI assessment shows which model produced it and who chose that model. The AI must quote the learner, and a quote that '
        + 'doesn\'t match, word for word, doesn\'t count. Practice Evidence leaves the weights and the pass mark out of what it sends a chat assistant, and no AI calculates the score.');
      expect(page).not.toMatch(/No AI assistant ever receives/);
      // A record a person downloads or copies holds everything: the page says so rather than claim more than the answers do.
      expect(page).toContain('A record you download or copy to your own storage holds everything, the weights and the pass mark included');
    }
    // Drafting saves feedback only, so it never gives the assistant a pass mark: the author sets one in the web app.
    expect(section(on.help, 'authors')).toContain('The AI never chooses how the scenario is used or scored, and drafting never gives it a pass mark: you set any pass mark in the web app.');
    // A claim about what an assistant sees would be one about what people paste: the pages speak of what Practice Evidence sends.
    for (const page of [on.landing, off.landing, on.help, off.help, read('bridge/ui/landing.html'), read('bridge/ui/help.html')]) {
      expect(page).not.toMatch(/never sees? (?:the weights|a pass mark|the pass mark)/);
      expect(page).not.toContain('does read them');
    }
    // A judge still pastes the message into a new chat, not one where they reviewed sessions: that chat has read other
    // assessments' levels, which neither step of the message shows. The guide no longer says the weights are there.
    expect(section(on.help, 'judges')).toContain('<li class="step"><p class="step__text">Paste the message a learner sends you into a new chat with the Interego connector on, '
      + 'not one where you reviewed sessions: your assistant saw other assessments\' levels there. Practice Evidence leaves the weights and the pass mark out of what it sends your assistant. Your assistant fetches the session,');
    expect(section(on.help, 'claude-chatgpt')).toContain('<li>Paste the message a learner sent you into a new chat. Your assistant shows you the levels and quotes and waits for your go-ahead.</li>');
    // A judge is registered by their own account's Member ID, never their assistant's; a learner's own assistant hands the
    // session on rather than assess it; and a learner whose workspace has no judge yet is told whom to ask.
    expect(section(on.help, 'judges')).toContain('To be appointed, send your admin your Member ID: sign in here with Interego and copy it from the account menu. '
      + 'It names your own account (it has :users: in it), not the assistant that acts for you.');
    expect(section(on.help, 'admins')).toContain("The Member ID is the ID of the judge's own account (it has :users: in it), never the ID of an assistant that acts for them");
    expect(section(on.help, 'learners')).toContain("Your own assistant doesn't assess your session: when the conversation ends, it tells you to send it to your judge.");
    for (const page of [on.help, off.help]) expect(section(page, 'learners')).toContain('If the session page says your workspace has no judge yet, ask your admin to add one.');
    expect(section(on.help, 'claude-chatgpt')).toContain('It doesn\'t get the weights, the points for each level, the pass mark, or any score or pass result: Practice Evidence leaves them out of what it sends a chat assistant through the connector, and the web app shows them to you. An AI tool you give your own signing key to reads what you read.');
    // An author's assistant edits a scored scenario's words and keeps its stakes; the stakes are changed in the web app.
    // Only the words: a chat that changes which criteria or levels there are, or their order, is refused (chat-stakes.test.ts).
    expect(section(on.help, 'authors')).toContain('Your AI assistant can edit the words of a scored scenario and of its criteria and levels (not which criteria and levels there are, or their order), and the new version keeps the weights, points and pass mark as they were: it doesn\'t get them, so change those here.');
    expect(section(off.help, 'authors')).not.toContain('Your AI assistant can edit a scored scenario');
    // A scored session's signed record and statement carry the score, so a chat is not sent to fetch them.
    expect(section(on.help, 'claude-chatgpt')).not.toContain('Download my signed record');
    // Nor does the landing page suggest asking a chat for it: from a chat, a scored session's download holds no content.
    expect(on.landing).not.toContain('Download my signed record');
    expect(section(on.help, 'claude-chatgpt')).toContain('To download your signed record, copy it to your own storage or create a learning record from a scored session, use the web app,');
    // A wallet that holds no role cannot do those for a scored session, and the guide says so rather than send it to the web app it is in.
    expect(section(on.help, 'claude-chatgpt')).toContain('use the web app, signed in with Interego or with an address your admin registered. A crypto wallet that holds no role in the workspace can\'t do these for a scored session, and its download holds the signatures without the session\'s content, so ask your admin to register its address.');
    expect(on.help).not.toContain('into that chat');
  });

  it('keeps the agent view at / for agents, for ?format= and for every Accept that is not a browser asking for a page', async () => {
    const agentView = (body: string, what: string): void => {
      const j = JSON.parse(body) as Out;
      expect(['pod' in j, Array.isArray(j['affordances'])], what).toEqual([true, true]);
    };
    // No Accept header at all, as a bare HTTP client sends.
    const bare = await rawGet(demo.port, '/', `127.0.0.1:${demo.port}`);
    expect(bare.status).toBe(200);
    agentView(bare.body, 'no accept');
    for (const [path, accept] of [['/', '*/*'], ['/', 'application/ld+json'], ['/', 'application/json'], ['/?format=jsonld', BROWSER]] as const) {
      const r = await fetch(`${demo.base}${path}`, { headers: { accept } });
      expect(r.headers.get('content-type'), `${path} ${accept}`).not.toMatch(/^text\/html/);
      agentView(await r.text(), `${path} ${accept}`);
    }
    // Node fetch's own default Accept, as the demos' readiness probe sends it.
    agentView(await (await fetch(`${demo.base}/`)).text(), 'fetch default');
    expect((await fetch(`${demo.base}/`, { headers: { accept: 'text/markdown' } })).headers.get('content-type')).toMatch(/^text\/markdown/);
    expect((await fetch(`${demo.base}/?format=markdown`, { headers: { accept: BROWSER } })).headers.get('content-type')).toMatch(/^text\/markdown/);
    expect(await (await fetch(`${demo.base}/`, { headers: { accept: BROWSER } })).text()).not.toContain('"affordances"');
  });

  it('serves the guide and its script under the same policy', async () => {
    const r = await fetch(`${demo.base}/ui/help`);
    expect(r.status).toBe(200);
    expect(r.headers.get('content-type')).toMatch(/^text\/html/);
    expect(r.headers.get('content-security-policy')).toBe(UI_CSP);
    const html = await r.text();
    // As the landing page: this bridge offers no Interego sign-in, so the guide's chat section is copy and paste.
    expect(html).toBe(connectorPages(contactPages(), null).help);
    const connected = connectorPages(contactPages(), { relayUrl: 'https://relay.example.test/' }).help;
    // The address in the files is a placeholder: every one is the workspace's own relay once filled in.
    // (A workspace that trusts a relay without naming it signs no one in, so it gets the null pages.)
    expect(connected.split(`<code>${EXAMPLE_CONNECTOR_HTML}</code>`).length).toBe(read('bridge/ui/help.html').split(`<code>${DEFAULT_CONNECTOR_ADDRESS}</code>`).length);
    expect(connected.split(`<code>${EXAMPLE_CONNECTOR_HTML}</code>`).length).toBeGreaterThan(1);
    // The break points are the only tags in it: what a person reads, selects and copies is the address.
    expect(EXAMPLE_CONNECTOR_HTML.replace(/<wbr>/g, '')).toBe('https://relay.example.test/mcp');
    const section = (page: string, id: string): string => page.slice(page.indexOf(`<section id="${id}"`), page.indexOf('</section>', page.indexOf(`<section id="${id}"`)));
    for (const page of [html, connected]) {
      expect(page).not.toMatch(NO_INLINE_SCRIPT);
      expect(page).not.toMatch(NO_INLINE_STYLE);
      expect(page).not.toMatch(/<!--\/?(no-)?connector-->/);
      for (const s of ['How to use Practice Evidence', 'id="claude-chatgpt"', 'href="../affordances"', '<script type="module" src="help.js"></script>',
        '<dt>This step needs your AI assistant</dt>', '<dt>Waiting for a judge</dt>', 'The company behind', 'Copy message for my judge']) {
        expect(page).toContain(s);
      }
      expect(page).not.toMatch(/built-in AI|AI provider key|AI role-player/);
      // The judges' section is plain steps: no action names, no protocol words.
      const judges = section(page, 'judges');
      expect(judges).toMatch(/message a learner sends you|a learner's message/);
      expect(judges.replace(/<[^>]+>/g, ' ')).not.toMatch(/urn:|\b(affordance|bridge|envelope|nonce|payload|relay)\b/i);
      // The learner's feedback step names the button they press, as the session page labels it.
      expect(section(page, 'learners')).toContain('<strong>Copy message for my judge</strong>');
    }
    // Without sign-in, the chat section promises no connector: copy and paste, and why.
    const chat = section(html, 'claude-chatgpt');
    expect(chat).toContain('This workspace doesn\'t offer Interego sign-in, so Claude or ChatGPT can\'t connect to it.');
    for (const s of ['/mcp', 'Add custom connector', 'Connect your AI', 'id="workspace-address"']) expect(chat).not.toContain(s);
    for (const s of ['Get the hand-off', 'by their wallet address']) expect(html).toContain(s);
    for (const s of ['Appoint at least one judge, by their Interego Member ID', 'with a passkey', 'Add custom MCP server', 'developers.openai.com']) expect(html).not.toContain(s);
    // A judge here assesses with any chat app, and the guide says plainly that this web app can't save the
    // assessment: it takes a tool of the judge's own, never an ordinary step on a page.
    expect(section(html, 'judges')).toContain('This web app can\'t save an assessment yet: saving one takes a tool of your own (your own agent or script) that signs it with your key.');
    expect(section(html, 'admins')).toContain('This web app can\'t save an assessment yet, so each judge needs a tool of their own that signs it with their key.');
    expect(chat).toContain('Saving the assessment takes a tool of your own that signs it with your key: this web app can\'t save it yet');
    expect(html).not.toMatch(/save (?:each|the) assessment with (?:your|their) own key/);
    // Nothing else on the page directs a person to Interego sign-in, a Member ID or the connector.
    for (const s of ['Send your admin your Member ID (account menu → Your Member ID → Copy) or, signed in with a wallet, your wallet address (Getting started → Copy my wallet address).', 'Sign in with Interego (or another way', 'What the Interego sign-in service sees', '<dt>Interego connector</dt>',
      '<dt>Your sign-in has ended</dt>', '<dt>Please do this in the web app</dt>', 'add and remove people by Member ID', 'Use <strong>Connect your AI</strong>']) expect(html).not.toContain(s);
    for (const s of ['Send your wallet address to your admin (Getting started → Copy my wallet address).', 'Sign in with your crypto wallet (or sign manually, from the sign-in menu)',
      'add and remove people by wallet address']) expect(html).toContain(s);
    // No one here has a Member ID: the glossary explains the wallet address the page asks for instead.
    expect(html).not.toContain('Member ID');
    expect(section(html, 'glossary')).toContain('<dt>Wallet address</dt><dd>The address your crypto wallet signs with: 0x followed by 40 letters and digits. Send it to your admin so they can give you a role.</dd>');
    expect(section(connected, 'glossary')).toContain('<dt>Member ID</dt><dd>Your unique ID in Interego. Send it to your admin so they can give you a role.</dd>');
    expect(section(connected, 'glossary')).not.toContain('<dt>Wallet address</dt>');
    // With it, the connector's steps and this workspace's relay, as its Connect dialog shows it.
    for (const s of [`<code>${EXAMPLE_CONNECTOR_HTML}</code>`, 'In each new chat, turn on Interego from the chat\'s tools menu (+).', 'id="workspace-address"',
      'Appoint at least one judge, by their Interego Member ID', 'under <strong>Send to your judge</strong>',
      // ChatGPT's steps as OpenAI's guide gives them, and the guide one link away; what decides whether a connector can be added, naming no plan.
      'In ChatGPT on the web, open Plugins → + → Add custom MCP server (see <a',
      `<a href="${OPENAI_GUIDE}" rel="noopener">OpenAI's guide to custom MCP servers</a>`, '(in ChatGPT, as its Server URL, with OAuth)',
      'In ChatGPT, accept the warning, create it as a plugin and install it. In either app, sign in with your Interego account when asked.',
      'In ChatGPT, type @ in a chat and choose Interego; it asks before each write unless you let it remember your choice for that tool in that chat.',
      'Judging needs Claude or ChatGPT with the Interego connector; whether you can add one depends on your plan or workspace settings.',
      // Who judges: a different person with their own account, appointed by Member ID; never the learner or the learner's assistant.
      'A judge is a different person from the learner, with their own Interego account, whom an admin appoints by Member ID.',
      // The bridge refuses a judgment by account: a session started with a wallet belongs to the wallet, so each claim names the account.
      'You can\'t assess a session you started with your Interego account. Nor can a learner\'s own assistant assess a session the learner started with their Interego account, even in a new chat or told to act as a judge: it acts as that account.',
      'Your assistant acts as your Interego account, so it can\'t assess a session you started with that account, in a new chat or in any role.',
      // Whether a save was kept is asked of the workspace, never judged from what the chat saw, and the fetch of the session
      // answers it, so the message pasted again, in the same chat or a new one, stops at an assessment already saved; and when
      // the assistant can't tell, the judge is told how to find out.
      'An assessment is tied to the exact session, conversation and rubric your assistant fetched. When your assistant fetches the session, the workspace also tells it whether an assessment of yours is already saved, '
        + 'and if one is, your assistant tells you so and stops: the same message pasted again, in this chat or a new one, never saves a second one, '
        + 'unless the learner contested the review or it was withdrawn, which asks for a new assessment. '
        + 'If the session changed since it was fetched, saving is refused: your assistant fetches it again, and assesses it again only if none of yours is saved. '
        + 'If a save goes wrong another way (an error, no answer, or it loses track), it fetches the session again to check instead of saving twice, and tells you whether your assessment is saved. '
        + 'If it can\'t tell, ask the learner whether their session page shows your assessment.',
      'Send your admin your Member ID (account menu → Your Member ID → Copy) or, signed in with a wallet, your wallet address (Getting started → Copy my wallet address).', 'Sign in with Interego (or another way', 'What the Interego sign-in service sees', '<dt>Interego connector</dt>',
      '<dt>Your sign-in has ended</dt>', 'add and remove people by Member ID',
      'Signed in with a wallet, send your wallet address instead (Getting started → Copy my wallet address); a judge needs a Member ID to assess from Claude or ChatGPT.']) expect(connected).toContain(s);
    for (const s of ['can\'t save an assessment yet', 'Send your wallet address to your admin', 'Sign in with your crypto wallet']) expect(connected).not.toContain(s);
    // ChatGPT's steps in the order its dialog asks, as the Connect dialog gives them: the URL and OAuth before the warning.
    const chatSection = section(connected, 'claude-chatgpt');
    expect(chatSection.indexOf('as its Server URL, with OAuth')).toBeLessThan(chatSection.indexOf('accept the warning'));
    expect(connected).not.toMatch(/Add custom MCP server, accept the warning/);
    expect(connected).not.toContain('Then sign in with your Interego account');
    // No page claims the bridge refuses more than it does: it refuses an assessment from the account or key that started the session.
    for (const page of [html, connected]) expect(section(page, 'judges')).not.toContain('You can\'t assess your own practice');
    expect(section(html, 'judges')).toContain('You can\'t assess a session you started with the key you sign with.');
    for (const page of [html, connected]) expect(page).not.toMatch(PLAN_CLAIM);
    for (const s of [DEFAULT_CONNECTOR_ADDRESS, 'doesn\'t offer Interego sign-in']) expect(connected).not.toContain(s);
    // The pages and the code that fills them change together: a page without its blocks, an unclosed
    // block or a connector address left outside a block stops the bridge, and so does a relay that is no web address.
    const fine = contactPages();
    expect(() => connectorPages({ ...fine, help: '<p>no blocks</p>' }, null)).toThrow(/guide has no connector blocks/);
    expect(() => connectorPages({ ...fine, landing: `${fine.landing}<!--connector-->` }, null)).toThrow(/landing page has no connector blocks, or one that is not closed/);
    expect(() => connectorPages({ ...fine, help: `${fine.help}<p>${DEFAULT_CONNECTOR_ADDRESS}</p>` }, null)).toThrow(/connector address outside a connector block/);
    expect(() => connectorPages(fine, { relayUrl: 'javascript:alert(1)' })).toThrow(/http\(s\) address/);
    // The address is written into the page as text: markup in it stays text, and only the break points are tags.
    expect(connectorPages(fine, { relayUrl: 'https://relay.example.test/a"b<c>' }).help)
      .toContain('<code>https://<wbr>relay<wbr>.example<wbr>.test<wbr>/a&quot;b&lt;c&gt;<wbr>/mcp</code>');
    const slash = await fetch(`${demo.base}/ui/help/`, { redirect: 'manual' });
    expect([slash.status, slash.headers.get('location')]).toEqual([301, '../help']);
    const js = await fetch(`${demo.base}/ui/help.js`);
    expect([js.status, js.headers.get('content-security-policy')]).toEqual([200, UI_CSP]);
    expect(js.headers.get('content-type')).toMatch(/^text\/javascript/);
    const src = await js.text();
    expect(src).toBe(read('bridge/ui/help.js'));
    expect(src).not.toMatch(/innerHTML|outerHTML|insertAdjacentHTML|document\.write|\beval\(|new Function|setAttribute\(\s*['"]on/);
    expect(src).not.toMatch(/fetch\(\s*['"`]https?:|import\(|<script/);
  });

  it('sends the Contact links to the operator\'s contact page or one mailto: address when it sets one, refuses anything else, and no file or visible text carries an email address', async () => {
    // Unset, the pages are the files: the Contact links go to the guide's contact section.
    expect(contactPages()).toEqual({ landing: read('bridge/ui/landing.html'), help: read('bridge/ui/help.html') });
    const url = 'https://interego.example/contact?from=practice-evidence';
    const pages = contactPages(url);
    expect(pages.landing).not.toContain('ui/help#contact');
    expect(pages.landing.split(`href="${url}"`).length - 1).toBe(2);
    expect(pages.help).toContain(`<a href="${url}">Contact us</a>`);
    expect(pages.help).toContain(`<a href="${url}">contact Interego</a>`);
    // The guide's own table of contents still goes to its contact section.
    expect(pages.help).toContain('<a href="#contact">Contact</a>');
    expect(contactUrlOf('https://interego.example/a"b<c>')).toBe('https://interego.example/a%22b%3Cc%3E');
    // An operator-set mailto: link to one address is taken, the domain lower-cased.
    const mailto = 'mailto:operator@example.org';
    expect(contactUrlOf(mailto)).toBe(mailto);
    expect(contactUrlOf('MAILTO:Operator@Example.ORG')).toBe('mailto:Operator@example.org');
    // Everything else is refused, and the pages keep their default links: an @ in an https page, any
    // other scheme, and a mailto: with headers, a second address, an escape, a space or no address.
    for (const bad of ['https://sales@interego.example/', 'https://interego.example/?to=sales@interego.example',
      'http://interego.example/contact', 'javascript:alert(1)', 'not a url', 'data:text/html,x',
      'mailto:a@example.org?subject=x', 'mailto:a@example.org,b@example.org', 'mailto:', 'mailto: a@example.org',
      'mailto:a@example.org%0Abcc:c@example.org', 'mailto:a@@example.org']) {
      expect(contactUrlOf(bad), bad).toBeNull();
      expect(() => contactPages(bad), bad).toThrow(/an https page or a mailto: link with one address/);
    }
    // A mailto: goes on the same three links; the address is in their href only, never in the text a person reads.
    const mail = contactPages(mailto);
    expect(mail.landing).not.toContain('ui/help#contact');
    expect(mail.landing.split(`href="${mailto}"`).length - 1).toBe(2);
    expect(mail.help).toContain(`<a href="${mailto}">Contact us</a>`);
    expect(mail.help).toContain(`<a href="${mailto}">contact Interego</a>`);
    expect(mail.help).toContain('<a href="#contact">Contact</a>');
    const EMAIL = /[\w.+-]+@[\w-]+\.[\w.-]+/;
    const textOf = (html: string): string => html.replace(/<[^>]*>/g, ' ');
    for (const html of [mail.landing, mail.help]) expect(textOf(html)).not.toMatch(EMAIL);
    // Served: the pages are exactly those, for an https page and for a mailto (as this workspace offers no connector).
    for (const [contactUrl, expected] of [[url, pages], [mailto, mail]] as const) {
      const l = await serve(demoHandlers, { contactUrl });
      expect(await (await fetch(`${l.base}/`, { headers: { accept: BROWSER } })).text()).toBe(connectorPages(expected, null).landing);
      expect(await (await fetch(`${l.base}/ui/help`)).text()).toBe(connectorPages(expected, null).help);
    }
    // No file the pages are built from carries an email address: one reaches a page only from PEV_CONTACT_URL.
    for (const html of [pages.landing, pages.help, read('bridge/ui/landing.html'), read('bridge/ui/help.html'), read('bridge/ui/app.js'), chatAgentJs()]) expect(html).not.toMatch(EMAIL);
    // The MCP endpoint is shown to copy, not linked: a browser that opens it waits on a stream.
    expect(read('bridge/ui/help.html')).not.toContain('href="../mcp"');
    expect(read('bridge/ui/help.html')).toContain('<code id="mcp-address">');
    expect(read('bridge/ui/help.js')).toContain("showAddress('mcp-address', 'copy-mcp-address', '../mcp');");
  });

  it('serves the mark as the favicon under the same policy', async () => {
    const r = await fetch(`${demo.base}/ui/favicon.svg`);
    expect([r.status, r.headers.get('content-security-policy')]).toEqual([200, UI_CSP]);
    expect(r.headers.get('content-type')).toMatch(/^image\/svg\+xml/);
    expect((await r.text()).startsWith('<svg')).toBe(true);
  });

  it('no page it serves has inline script or style, or loads an asset from another origin', async () => {
    for (const path of ['/', '/ui', '/ui/help']) {
      const html = await (await fetch(`${demo.base}${path}`, { headers: { accept: BROWSER } })).text();
      expect(html, path).not.toMatch(NO_INLINE_SCRIPT);
      expect(html, path).not.toMatch(NO_INLINE_STYLE);
      expect(html, path).not.toMatch(ASSET_ELSEWHERE);
    }
  });

  it('serves one shared stylesheet: the design system, then this product\'s own rules, with nothing from another origin', async () => {
    const css = await (await fetch(`${demo.base}/ui/app.css`)).text();
    expect(css.startsWith(readFileSync(join(REPO, 'applications/_shared/design-system/design-system.css'), 'utf8'))).toBe(true);
    expect(css.endsWith(read('bridge/ui/app.css'))).toBe(true);
    // Rules only: the design system's own header comment says, in words, that it has no @import.
    expect(css.replace(/\/\*[\s\S]*?\*\//g, '')).not.toMatch(/@import|url\(\s*['"]?https?:|@font-face/i);
    expect(await (await fetch(`${demo.base}/ui`)).text()).toContain('<body class="product-pev">');
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
    for (const src of [js, chatAgentJs()]) {
      expect(src).not.toMatch(/innerHTML|outerHTML|insertAdjacentHTML|document\.write|\beval\(|new Function|setAttribute\(\s*['"]on/);
      expect(src).not.toMatch(/fetch\(\s*['"`]https?:|import\(|<script/);
    }
    // No timer re-reads a session: new lines from a chat are read when the person comes back, or asks.
    expect(js).not.toMatch(/setInterval\(/);
    // Every action the copied prompts name is one this bridge declares, so a prompt cannot drift from the manifest.
    const named = new Set(js.match(/urn:iep:action:[a-z0-9-]+:[a-z0-9-]+/g) ?? []);
    expect(named.size).toBeGreaterThan(20);
    expect([...named].filter((a) => !(Object.values(PEV_ACTION) as string[]).includes(a))).toEqual([]);
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

/**
 * The text a person sees: closed disclosures, menus, dialogs, hidden text and options left out, and
 * so is what authors, learners and the AI wrote (bubbles, scenario fields, quotes, rationales, the
 * rubric, card titles), which this product cannot word.
 */
function visibleText(root: Element | null): string {
  if (!root) return '';
  const c = root.cloneNode(true) as Element;
  for (const sel of ['details:not([open]) > :not(summary)', 'dialog:not([open])', '[popover]', '.visually-hidden', '[hidden]', 'option',
    '.chat__bubble', '.kv dd', 'q', '.rationale p:not(.rationale__label)', '.rubric-view', '.card__title']) {
    for (const el of [...c.querySelectorAll(sel)]) el.remove();
  }
  return c.textContent ?? '';
}

async function asRole(p: Page, role: DemoRoleName): Promise<void> {
  const sel = await p.until(() => p.q('#role'), 'the role picker');
  p.set(sel, role);
  await p.until(() => p.text('#acting-as').includes(DEMO_ROLE_LABELS[role]), `acting as ${role}`);
}

const button = (action: string, extra = ''): string => `button[data-action="${action}"]${extra}`;

describe('the web UI works, driven in a DOM against the real handlers', () => {
  it('a learner practises with the disclosed scripted model, is judged, a reviewer reviews, and only then can the learner project', async () => {
    const asked: string[] = [];
    const p = await openUi(demo, (w) => {
      const f = w['fetch'] as (input: unknown, init?: RequestInit) => Promise<Response>;
      w['fetch'] = (input: unknown, init?: RequestInit): Promise<Response> => { asked.push(String(input)); return f(input, init); };
    });
    await p.until(() => p.text('#bar').includes('DEMO MODE'), 'the demo banner');
    expect(p.text('#bar')).toContain('SCRIPTED: offline fixture, no model ran');
    await asRole(p, 'learner');
    const card = await p.until(() => p.all('article.scenario').find((c) => (c.textContent ?? '').includes('missed deadline')), 'the scenario card');
    expect(card.textContent).toContain('Rubric approved by a reviewer');
    card.querySelector<HTMLInputElement>('input[type=radio][value=no]')!.checked = true;
    card.querySelector<HTMLElement>(button(PEV_ACTION.startAttempt))!.click();
    await p.until(() => p.q('#line'), 'the conversation');
    const askedBefore = asked.length;
    for (const line of DEMO_LINES.ana) {
      const before = p.all('.bubble').length;
      p.set(p.q('#line'), line);
      p.click('#send');
      await p.until(() => p.all('.bubble').length === before + 2, `the reply to "${line.slice(0, 24)}…"`);
    }
    // Each line is shown from the act's own answer: the attempt is not read again after it.
    const during = asked.slice(askedBefore).map((u) => new URL(u, 'http://x/').pathname);
    expect([during.filter((u) => u.endsWith('/pev/say')).length, during.filter((u) => u.endsWith('/pev/get_attempt'))]).toEqual([DEMO_LINES.ana.length, []]);
    const replies = p.all('.bubble.them').slice(1);
    expect(replies.map((b) => b.querySelector('.text')?.textContent)).toEqual(DEMO_LINES.sam.map((x) => x.replace(' (end of conversation)', '')));
    expect(replies.every((b) => (b.textContent ?? '').includes('scripted fixture: no model ran'))).toBe(true);
    await p.until(() => p.q('#end-proposed'), 'the end proposal');
    expect(p.text('#state')).toBe('In conversation');
    p.click('#end-proposed .btn--primary');
    await p.until(() => p.text('#state') === 'Finished: not assessed yet', 'the ended state');
    p.click(button(PEV_ACTION.judgeAttempt));
    await p.until(() => p.q('#assessment'), 'the assessment');
    const assessment = p.text('#assessment');
    for (const s of ['Calculated by Practice Evidence', 'Provisional: not yet reviewed', '400 of 600 points · 66.7%', 'Would not meet the pass mark (provisional)', 'agrees-next-step needs at least partial']) expect(assessment).toContain(s);
    const fabricated = p.all('.quote.bad').find((x) => (x.textContent ?? '').includes(FABRICATED_QUOTE));
    expect(fabricated?.textContent).toContain('not found verbatim in any learner turn');
    expect(p.all('mark').map((m) => m.textContent)).toEqual(['The quarterly report was due Thursday at noon', 'what got in the way this time from your side?', 'send me a status note by Tuesday at 10am']);
    expect(p.text('.judgments')).toContain('The AI\'s explanation (not part of the score)');
    const projections = p.all(button(PEV_ACTION.projectAttempt)) as HTMLButtonElement[];
    expect(projections.map((b) => b.disabled)).toEqual([true, true]);
    expect(projections[0]!.title).toContain('a qualified reviewer has not countersigned');
    const attemptIri = decodeURIComponent(p.w.location.hash.slice('#/attempt/'.length));
    S['attempt'] = attemptIri;

    // The reviewer: the queue, then the review form (blind first when the attempt is in the audit sample).
    await asRole(p, 'reviewer');
    p.w.location.hash = '#/review';
    const entry = await p.until(() => p.all('article.queue-entry').find((x) => x.dataset['attempt'] === attemptIri), 'the queue entry');
    expect(entry.textContent).toContain('Why this is near the top');
    expect(entry.textContent).toContain('A quote didn\'t match');
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
    expect(p.text('#review-form')).toContain('The AI\'s quote didn\'t match here');
    p.set(p.q('#review-form textarea[data-why="agrees-next-step"]'), 'Ana agreed a status note by Tuesday at 10am with Sam as its owner; the second quote is not in the transcript.');
    expect(p.text('#submit-review')).toBe('Sign off my levels');
    p.click('#submit-review');
    await p.until(() => p.q('#review-form p.recorded') ?? p.q('#review-form .refusal'), 'the review outcome');
    expect(p.text('#review-form .outcome')).toContain('Review saved. Final result: 100.0%, meets the pass mark.');

    // The learner again: reviewed, ratified, so the statement can be built.
    await asRole(p, 'learner');
    p.w.location.hash = `#/attempt/${encodeURIComponent(attemptIri)}`;
    await p.until(() => p.text('#state') === 'Levels set by a reviewer', 'the reviewed state');
    expect(p.text('#assessment')).toContain('Final: a qualified reviewer signed off every level.');
    const xapi = p.q(button(PEV_ACTION.projectAttempt, '[data-format="xapi"]')) as HTMLButtonElement;
    expect(xapi.disabled).toBe(false);
    xapi.click();
    await p.until(() => p.q('#projection pre.statement') ?? p.q('#projection .refusal'), 'the statement');
    const statement = JSON.parse(p.text('#projection pre.statement')) as Out;
    expect((statement['verb'] as Out)['id']).toBe('http://adlnet.gov/expapi/verbs/completed');
    expect(((statement['context'] as Out)['extensions'] as Out)[`${PEV_NS}practiceEvidence`]).toBe(true);
    expect(p.text('#projection')).toContain('Nothing was sent anywhere.');
    // What it leaves out, in plain words; the server's own list stays under Technical details.
    const shownProjection = visibleText(p.q('#projection'));
    expect(shownProjection).toContain('It leaves out your quotes, the conversation text and the reviewer\'s reasons.');
    expect(shownProjection).not.toMatch(/transcript hash|descriptor URL|attemptNumber|declaredBy/);
    expect(p.text('#projection .disclosure__body--tech')).toContain('carries the transcript hash, not the transcript');
    expect(p.errors).toEqual([]);
  }, SLOW);

  it('a wallet that holds no role, on its own reviewed scored session: why its learning record cannot be made here, and a download that says what it left out', async () => {
    const attemptIri = S['attempt'];
    expect(attemptIri, 'the first driven test leaves a judged and reviewed attempt').toBeTruthy();
    // The same learner's key, on a bridge that holds no demo keys: a wallet nobody registered, as open enrolment leaves it.
    const ana = W.learner;
    const saved: string[] = [];
    const p = await openUi(plain, (w) => {
      w['TextEncoder'] = TextEncoder;
      // A browser that saves files: the download's link is clicked, and jsdom, which navigates nowhere, is not asked to follow it.
      Object.assign(w.URL, { createObjectURL: (): string => 'blob:pev-test', revokeObjectURL: (): void => undefined });
      w.HTMLAnchorElement.prototype.click = function click(this: HTMLAnchorElement): void { saved.push(this.download); };
      w['ethereum'] = {
        request: async ({ method, params }: { method: string; params?: string[] }): Promise<unknown> => {
          if (method === 'eth_requestAccounts') return [ana.address];
          if (method === 'personal_sign') return signMessageRaw(ana, Buffer.from(String(params?.[0]).slice(2), 'hex').toString('utf8'));
          throw new Error(`unsupported ${method}`);
        },
      };
    });
    await p.until(() => p.q('article.scenario'), 'the scenarios');
    p.q('#connect-wallet')!.click();
    await p.until(() => p.text('#acting-as').startsWith('Signed in with wallet'), 'the connected wallet');
    p.w.location.hash = `#/attempt/${encodeURIComponent(attemptIri!)}`;
    const panel = await p.until(() => p.q('section.projections'), 'the learning-record panel');
    // The levels, and on this, the person's own session, only the way that works for it: register the address.
    expect(p.text('#assessment')).toContain("aren't shown to an address that holds no role in this workspace. Ask your admin to register this address to see them.");
    expect(p.text('#assessment')).not.toContain('Sign in with Interego');
    // The panel says why its buttons are off, and on the buttons too.
    const needsRole = "Its learning record carries the score and whether it met the pass mark, which aren't shown to an address that holds no role in this workspace, so you can't create one here, copy this session to your own storage, or download its content. Ask your admin to register this address.";
    expect(panel.querySelector('.record-needs-role')?.textContent).toBe(needsRole);
    expect(panel.textContent).not.toContain('so this can be shared as practice evidence');
    const made = p.all(button(PEV_ACTION.projectAttempt)) as HTMLButtonElement[];
    expect(made.map((b) => [b.disabled, b.title])).toEqual([[true, needsRole], [true, needsRole]]);
    expect(p.q(button(PEV_ACTION.holderCopy))).toBeNull();
    // The download is not called the record: it says it holds the signatures, and why its content was left out.
    p.click(button(PEV_ACTION.exportRecord));
    const got = await p.until(() => p.all('#view .callout').find((c) => (c.textContent ?? '').includes('Downloaded')) ?? p.q('#view .actions .refusal'), 'the download');
    expect(got.querySelector('.callout__title')?.textContent ?? got.textContent).toMatch(/^Downloaded the signatures of \d+ saved versions, without their content\.$/);
    expect(got.textContent).toContain("A scored session's content holds the score and the pass mark, which aren't shown to an address that holds no role in this workspace, so the download leaves it out. Ask your admin to register this address, then download it again for the whole record.");
    expect(saved).toHaveLength(1);
    expect(p.errors).toEqual([]);
  }, SLOW);

  it('the main screens speak to customers: no protocol words, codes or statuses outside Technical details', async () => {
    const attemptIri = S['attempt'];
    expect(attemptIri, 'the first driven test leaves a judged and reviewed attempt').toBeTruthy();
    const p = await openUi(demo);
    await p.until(() => p.text('#bar').includes('DEMO MODE'), 'the demo banner');
    const JARGON = /\b(pod|bridge|affordance|envelope|nonce|hypothetical|ratif\w*|countersign\w*)\b/i;
    // Case-sensitive, kept apart: a case-insensitive DID would match "didn't".
    const CODES = /\b(EIP-191|IRI|DID)\b|HTTP \d{3}/;
    const clean = (where: string): void => {
      const text = `${visibleText(p.q('#bar'))} ${visibleText(p.q('#view'))}`;
      expect([text.match(JARGON)?.[0] ?? null, text.match(CODES)?.[0] ?? null], where).toEqual([null, null]);
    };
    await asRole(p, 'learner');
    p.w.location.hash = '#/practice';
    await p.until(() => p.text('#view h1') === 'Practice scenarios' && p.q('article.scenario'), 'the scenarios');
    clean('practice');
    p.w.location.hash = `#/attempt/${encodeURIComponent(attemptIri ?? '')}`;
    await p.until(() => p.q('#assessment') && p.q('.judgments'), 'the session');
    clean('the session');
    p.w.location.hash = '#/mine';
    await p.until(() => p.q('#view table.mine'), 'my practice');
    clean('my practice');
    p.w.location.hash = '#/calibration';
    await p.until(() => p.text('#view h1') === 'AI judge quality' && (p.q('#view table.calibration') ?? p.q('#view .empty')), 'AI judge quality');
    clean('AI judge quality');
    await asRole(p, 'second-reviewer');
    p.w.location.hash = '#/review';
    await p.until(() => p.text('#view h1') === 'To review' && (p.q('#view article.queue-entry') ?? p.q('#view .empty')), 'the review list');
    clean('to review');
    // A learner opening To review gets a plain access message, never the bridge's refusal.
    await asRole(p, 'learner');
    await p.until(() => p.q('#view .refusal'), 'the access message');
    clean('the access message');
    const refusal = visibleText(p.q('#view .refusal'));
    expect(refusal).toContain('Reviewing is for reviewers.');
    // No Interego sign-in here: what the person sends their admin is a wallet address, never a Member ID.
    expect(refusal).toContain('Ask your admin to add you, and share your wallet address with them.');
    expect(refusal).not.toContain('Member ID');
    expect(refusal).not.toContain('Refused');
    expect(p.errors).toEqual([]);
  }, SLOW);

  it('an answer that is not the whole pod says so first, and no view then says the pod holds nothing', async () => {
    // A pod of its own, where two heads (a scenario and an attempt) answer 503: every listing over it is incomplete.
    const GAPPY = 'https://gappy-pod.demo.test/practice/';
    const gp = inMemoryPod();
    const unreadable = new Set<string>();
    const gappy = (async (input: RequestInfo | URL, init?: RequestInit) => ((init?.method ?? 'GET') === 'GET' && unreadable.has(String(input))
      ? new Response('busy', { status: 503, statusText: 'Service Unavailable' }) : gp.fetchFn(input, init))) as typeof fetch;
    const handlers = createPevHandlers({
      ...base, fetchFn: gappy, holderFetchFn: gappy, defaultPodUrl: GAPPY, servedPods: [GAPPY], model: scriptedPracticeModel(), demoSigner: demoSignerOf(W),
    }) as Handlers;
    const registered = (await handlers['pev.register_role']!({
      envelope: await signEnvelope(W.admin, { v: 1, action: PEV_ACTION.registerRole, issuedAt: new Date().toISOString(), nonce: nonce(), podUrl: GAPPY, address: W.reviewer.address, role: 'reviewer', change: 'add' }),
    })) as Out;
    expect(registered['changed']).toBe(true);
    const MANIFEST = `${GAPPY}.well-known/context-graphs`;
    const planted = [
      [`${GAPPY}pev/records/scenario-planted.ttl`, 'urn:pev:scenario:00000000000000aa', RECORD_CLASS.scenario],
      [`${GAPPY}pev/records/attempt-planted.ttl`, 'urn:pev:attempt:00000000000000aa-1', RECORD_CLASS.attempt],
    ] as const;
    let manifest = gp.store.get(MANIFEST)!;
    for (const [d, iri, cls] of planted) {
      unreadable.add(d);
      manifest += `\n<${d}> a iep:ManifestEntry ;\n    iep:describes <${iri}> ;\n    dct:conformsTo <${cls}> ;\n    iep:modalStatus iep:Hypothetical .\n`;
    }
    gp.store.set(MANIFEST, manifest);
    const l = await serve(handlers);
    const p = await openUi(l);
    const view = (): string => p.text('#view');
    const shows = async (heading: string, empty: string): Promise<void> => {
      await p.until(() => p.text('#view h1') === heading && p.q('#view .incomplete'), `${heading}, marked incomplete`);
      expect(view(), heading).toContain('Some records couldn\'t be opened, so this list may be incomplete.');
      expect(view(), heading).toContain('were skipped because their signature couldn\'t be verified');
      expect(view().includes(empty), heading).toBe(false);
    };
    await shows('Practice scenarios', 'No practice scenarios yet');
    p.w.location.hash = '#/calibration';
    await shows('AI judge quality', 'No data yet');
    await asRole(p, 'learner');
    p.w.location.hash = '#/mine';
    await shows('My practice', 'You haven\'t practiced yet');
    await asRole(p, 'reviewer');
    p.w.location.hash = '#/review';
    await shows('To review', 'You\'re all caught up');
    expect(view()).toContain('At least 0 sessions waiting for review.');
    // Once the pod answers for them (they are not there: the manifest names nothing it holds), the
    // answers are whole again, and the empty prompts come back.
    unreadable.clear();
    p.w.location.hash = '#/practice';
    await p.until(() => p.text('#view h1') === 'Practice scenarios' && view().includes('No practice scenarios yet'), 'the whole, empty list');
    expect(p.q('#view .incomplete')).toBeNull();
    expect(p.errors).toEqual([]);
  }, SLOW);

  it('an author drafts with the bridge model and publishes after classifying; an admin changes a role; markup in a line stays text', async () => {
    const p = await openUi(demo);
    await p.until(() => p.q('article.scenario'), 'the scenarios');
    await asRole(p, 'author');
    p.w.location.hash = '#/author';
    await p.until(() => p.q(button(PEV_ACTION.draftScenario)), 'the author form');
    p.set(p.q('#draft-brief'), 'A project manager tells a client sponsor that two defects block the payment flow.');
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
    expect(p.text('#view')).toContain('A pass mark assumes a clear-cut good answer');
    expect(p.q('[data-field="passGateWhy"]')).not.toBeNull();
    choose('assessmentUse', 'feedback-only');
    expect(p.q('[data-field="passGateWhy"]')).toBeNull();
    p.click(button(PEV_ACTION.authorScenario, '[data-status="published"]'));
    await p.until(() => p.text('#author-result').includes('version 1') || p.q('#author-result .refusal'), 'the saved scenario');
    expect(p.text('#author-result')).toContain('Published version 1.');
    const listed = (await demoHandlers['pev.list_scenarios']!({})) as { scenarios: Out[] };
    const rs = listed.scenarios.find((s) => s['scenarioKey'] === 'renegotiate-scope');
    expect([(rs?.['draftAssistance'] as Out)['measured'], (rs?.['draftAssistance'] as Out)['editedAfterDraft'], rs?.['assessmentUse']]).toEqual([true, false, 'feedback-only']);

    await asRole(p, 'admin');
    p.w.location.hash = '#/roles';
    await p.until(() => p.q(button(PEV_ACTION.registerRole)), 'the roles form');
    p.set(p.q('#member-id'), W['judge-agent'].address);
    p.set(p.q('#member-role'), 'agent');
    p.click(button(PEV_ACTION.registerRole));
    await p.until(() => p.q('#view .outcome table') ?? p.q('#view .refusal'), 'the registry');
    expect(p.all('#view .outcome tr').some((tr) => (tr.textContent ?? '').includes(W['judge-agent'].address) && (tr.textContent ?? '').includes('agent'))).toBe(true);
    // A member can be a person's Interego DID, for someone who signs in with their Interego account.
    // This workspace offers no Interego sign-in, so its form asks for a wallet address (and a DID typed in still works).
    const person = `did:web:${IDH}:users:u-pk-00000000aa01`;
    p.set(p.q('#member-id'), person);
    p.set(p.q('#member-role'), 'reviewer');
    p.click(button(PEV_ACTION.registerRole));
    await p.until(() => p.all('#view .outcome tr').some((tr) => (tr.textContent ?? '').includes(person)) || p.q('#view .refusal'), 'the registry with the DID');
    expect(p.all('#view .outcome tr').some((tr) => (tr.textContent ?? '').includes(person) && (tr.textContent ?? '').includes('Reviewer'))).toBe(true);
    expect((p.q('#member-id') as HTMLInputElement).placeholder).toBe('0x…');

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
    await p.until(() => p.text('#view h1') === 'AI judge quality', 'the calibration view');
    await p.until(() => p.text('#view').includes('This is not accuracy against a known answer.'), 'the metric note');
    // Calibration's fingerprints are its own, and every table of them says so, so nobody looks for a scenario's there.
    const note = "The rubric fingerprints in this table are calibration's own: they don't match the fingerprints shown with a scenario or a session.";
    expect((p.w.eval('calibrationNote()') as HTMLElement).textContent).toBe(note);
    for (const table of p.all('#view .calibration-all')) expect(table.closest('details')?.querySelector('.calibration-note')?.textContent).toBe(note);
    // A results page's table of people who judged says so only when its answer left the stakes out: a reader of the stakes
    // is shown the plain fingerprint, the same one a scenario shows.
    const cell = {
      judgeId: 'did:example:judge', judgeKind: 'person', promptTemplateHash: 'own-prompt', grouping: 'rubric-version', rubricHash: 'ab'.repeat(32),
      criterionId: 'asks-their-view', criterionTitle: 'Asks for their view', criterionContentHash: 'cd'.repeat(32), kind: 'pev/abababababababab/asks-their-view',
      samples: 1, humanSamples: 1, distinctHumanConfirmers: 1, demoOutcomes: 0, agreementRate: null, meanBrier: null, meanLevelDistance: null, normalisedLevelDistance: null,
      unverifiedRate: null, blindSamples: 0, blindAgreementRate: null, repeatSamples: 0, repeatAgreement: null, auditSampleSamples: 0, auditSampleAgreementRate: null,
      auditSampleCoverage: null, auditSamplePartial: false, status: 'Hypothetical', standing: { evaluated: false, clears: false, why: 'a person', effect: 'None.' },
    };
    const judgeCard = (r: Out): HTMLElement => p.w.eval(`personJudgeCard(${JSON.stringify(r)})`) as HTMLElement;
    expect(judgeCard({ personJudgeCells: [cell] }).querySelector('.calibration-note')).toBeNull();
    expect(judgeCard({ personJudgeCells: [cell], stakesWithheld: 'left out' }).querySelector('.calibration-note')?.textContent).toBe(note);
    expect(p.errors).toEqual([]);
  }, SLOW);

  it('a wallet author opens a feedback-only scenario to edit without signing, and signs once to edit a scored one', async () => {
    let listed = (await demoHandlers['pev.list_scenarios']!({})) as { scenarios: Out[] };
    if (!listed.scenarios.some((s) => s['scenarioKey'] === 'renegotiate-scope')) {
      const pub = await direct(demoHandlers, 'pev.author_scenario', W.author, PEV_ACTION.authorScenario,
        { scenario: demoScenarioInput('renegotiate-scope'), status: 'published', draftAssistance: { used: false } });
      expect(pub['kind']).toBeUndefined();
      listed = (await demoHandlers['pev.list_scenarios']!({})) as { scenarios: Out[] };
    }
    const feedbackOnly = listed.scenarios.find((s) => s['scenarioKey'] === 'renegotiate-scope')!;
    expect(feedbackOnly['assessmentUse']).toBe('feedback-only');
    const signs: string[] = [];
    const p = await openUi(plain, (w) => {
      w['TextEncoder'] = TextEncoder;
      w['ethereum'] = {
        request: async ({ method, params }: { method: string; params?: string[] }): Promise<unknown> => {
          if (method === 'eth_requestAccounts') return [W.author.address];
          if (method === 'personal_sign') {
            const text = Buffer.from(String(params?.[0]).slice(2), 'hex').toString('utf8');
            signs.push(text);
            return signMessageRaw(W.author, text);
          }
          throw new Error(`unsupported ${method}`);
        },
      };
    });
    await p.until(() => p.q('article.scenario'), 'the scenarios');
    p.q('#connect-wallet')!.click();
    await p.until(() => p.text('#acting-as').startsWith('Signed in with wallet'), 'the connected wallet');
    const title = (): string => (p.q('[data-field="title"] input') as HTMLInputElement | null)?.value ?? '';
    // A feedback-only scenario has no weights, points or pass mark to read, so the wallet is not asked.
    const before = signs.length;
    p.w.location.hash = `#/author/${encodeURIComponent(String(feedbackOnly['scenarioIri']))}`;
    await p.until(() => title() === 'Renegotiating a deadline with a client', 'the feedback-only scenario in the editor');
    expect(signs.length).toBe(before);
    // A scored one needs them: one signed read, which this registered author's address gets them in.
    p.w.location.hash = `#/author/${encodeURIComponent(S['md'] ?? '')}`;
    await p.until(() => title() === 'Following up on a missed deadline', 'the scored scenario in the editor');
    expect(signs.slice(before).map((t) => (JSON.parse(t) as Out)['action'])).toEqual([PEV_ACTION.listScenarios]);
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
    expect(wallet.text('#acting-as')).toBe('Not signed in');
    wallet.q('#connect-wallet')!.click();
    await wallet.until(() => wallet.text('#acting-as').startsWith('Signed in with wallet'), 'the connected wallet');
    const card = await wallet.until(() => wallet.q('article.scenario'), 'the scenarios, again');
    card.querySelector<HTMLInputElement>('input[type=radio][value=no]')!.checked = true;
    const help = 'Read the café guide — naïvely, “twice”';
    wallet.set(card.querySelector('input[name="assistance"]'), help);
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

  it('signing manually as the only way keeps its header on one line down to 360 px, saying what it said, and below takes a second line under the brand', async () => {
    // No Interego sign-in and no wallet: Connect your AI, the "Signing manually" badge and Other ways to sign in. At 300 px they
    // ran 87 px past the screen (13 at 375); from 360 px the brand and the badge give way instead, and nothing else changes.
    const p = await openUi(plain);
    await p.until(() => p.q('.app-header #acting-as.badge') && p.q('article.scenario'), 'the header, signing manually');
    expect(p.all('.app-header__actions > :not(.menu)').map((el) => el.id || el.className)).toEqual(['product-switch', 'connect-ai-button', 'acting-as', 'signin-other']);
    const css = await (await fetch(`${plain.base}/ui/app.css`)).text();
    const sheet = p.d.createElement('style');
    p.d.head.append(sheet);
    const cs = (sel: string): CSSStyleDeclaration => p.w.getComputedStyle(p.q(sel) ?? p.d.querySelector(sel)!);
    for (const px of [1280, 768, 600, 360, 344, 300]) {
      sheet.textContent = atWidth(css, px);
      const two = px < 360;
      // Below 360 px the second line keeps room for a label on two lines, so --header-h is the same whichever it is.
      expect([px, cs('.app-header__inner').flexWrap, cs('.app-header__actions').flexBasis, cs('html').getPropertyValue('--header-h')]).toEqual([px, two ? 'wrap' : '', two ? '100%' : '', two ? '7.3125rem' : '4rem']);
      // Connect your AI says so from 30em, as it always did: shortening it is only for a header holding another way to sign in too.
      expect([px, cs('#connect-ai-button > .hide-below-sm').display === 'none', cs('#acting-as').flexShrink, cs('.app-header .brand').flexShrink]).toEqual([px, px < 480, '10000', '10000']);
    }
    sheet.remove();
    expect(p.errors).toEqual([]);
  }, SLOW);

  it('a workspace with no AI of its own and no Interego sign-in: copy and paste in plain words, no chat hand-off, no connector address, and no key outside Advanced', async () => {
    const ana = W.learner;
    const asked: string[] = [];
    const copied: string[] = [];
    const signs: string[] = [];
    const p = await openUi(noModel, (w) => {
      w['TextEncoder'] = TextEncoder;
      const f = w['fetch'] as (input: unknown, init?: RequestInit) => Promise<Response>;
      w['fetch'] = (input: unknown, init?: RequestInit): Promise<Response> => { asked.push(`${init?.method ?? 'GET'} ${new URL(String(input), 'http://x/').pathname}`); return f(input, init); };
      Object.defineProperty(w.navigator, 'clipboard', { configurable: true, value: { writeText: async (t: string): Promise<void> => { copied.push(t); } } });
      w['ethereum'] = {
        request: async ({ method, params }: { method: string; params?: string[] }): Promise<unknown> => {
          if (method === 'eth_requestAccounts') return [ana.address];
          if (method === 'personal_sign') {
            const text = Buffer.from(String(params?.[0]).slice(2), 'hex').toString('utf8');
            signs.push(text);
            return signMessageRaw(ana, text);
          }
          throw new Error(`unsupported ${method}`);
        },
      };
    });
    await p.until(() => p.q('article.scenario'), 'the scenarios');
    // list_scenarios already said this bridge holds no demo keys, so the page never asks for them.
    expect(asked.filter((x) => x.endsWith('/pev/sign_as_demo_role'))).toEqual([]);
    // Workspace settings: no key there any more, and the AI is the person's own.
    expect([p.q('#workspace-settings #byok'), p.text('#workspace-settings').includes('AI provider key')]).toEqual([null, false]);
    expect(p.text('#workspace-settings')).toContain('Your own AI assistant (Claude, ChatGPT…)');
    expect(p.text('#workspace-settings')).toContain('An appointed judge, with their own AI assistant');
    expect(p.text('#view .own-ai')).toContain('Practice with your own AI assistant');
    expect(p.text('#view')).not.toMatch(/built-in AI/);
    // The header's wallet button keeps its whole name, and drops "crypto" below the md breakpoint (as
    // "Sign in" stands for "Sign in with Interego"), so it and the menu button fit a 390-pixel header.
    expect([p.text('.app-header #connect-wallet'), p.q('.app-header #connect-wallet .hide-below-md')?.textContent]).toEqual(['Use a crypto wallet', 'crypto ']);
    p.q('#connect-wallet')!.click();
    await p.until(() => p.text('#acting-as').startsWith('Signed in with wallet'), 'the connected wallet');
    // A scored scenario's weights and pass mark come only to a signed read. The wallet is asked for one when the person
    // chooses to see them, not when the list loads, and that one signature (over the act and the storage alone) serves
    // every list read while it is kept.
    const scored = await p.until(() => p.all('article.scenario').find((a) => (a.textContent ?? '').includes('Scored · pass mark')), 'a scored scenario');
    const signedBefore = signs.length;
    expect([(scored.textContent ?? '').includes('Weight '), signs.some((t) => t.includes(PEV_ACTION.listScenarios))]).toEqual([false, false]);
    const show = scored.querySelector<HTMLElement>('.stakes-note button')!;
    expect(show.textContent).toBe('Show the weights and pass mark');
    show.click();
    // This wallet holds no role here (enrolment is open, and anything can make a key, an AI assistant too), so the signed
    // read still leaves the stakes out, and the page says how to see them instead of offering the same button again.
    const noRole = await p.until(() => p.all('article.scenario .stakes-note').find((n) => (n.textContent ?? '').includes('no role')), 'the no-role note');
    // This workspace offers no Interego sign-in, so the note does not suggest one: registering the address is the way.
    expect(noRole.textContent).toBe("How much each criterion counts, the points for each level and the pass mark aren't shown to an address that holds no role in this workspace. Ask your admin to register this address to see them.");
    expect([noRole.querySelector('button'), p.all('article.scenario').some((a) => /Weight \d|Pass mark: at least/.test(a.textContent ?? ''))]).toEqual([null, false]);
    expect(signs.slice(signedBefore).map((t) => (JSON.parse(t) as Out)['action'])).toEqual([PEV_ACTION.listScenarios]);
    expect(Object.keys(JSON.parse(signs[signs.length - 1]!) as Out).sort()).toEqual(['action', 'issuedAt', 'nonce', 'podUrl', 'v']);
    // Getting started words the learner's steps as this workspace offers them: copy and paste, and the judge hand-off.
    (await p.until(() => p.all('.checklist button').find((b) => (b.textContent ?? '').startsWith('Show all')), 'Getting started')).click();
    await p.until(() => p.all('.checklist__item').length === 8, 'every learner step');
    const steps = p.all('.checklist__text').map((x) => x.textContent).join('\n');
    expect(steps).toContain('On the session page, copy each line into your own AI assistant and paste its reply back.');
    expect(steps).toContain('Choose Get the hand-off, then Copy message for my judge, and send it to your appointed judge.');
    expect(steps).not.toMatch(/start-up message|Send to your judge/);
    // A wallet is a sign-in, but not an Interego one, and none is offered here: the first step says only that.
    const first = p.q('.checklist__item');
    expect([first?.querySelector('.checklist__title-item')?.textContent, first?.querySelector('.checklist__text')?.textContent]).toEqual(['Done: Sign in', 'You\'re signed in with your wallet.']);

    // Connect your AI, on a workspace without Interego sign-in: copy and paste only, and no connector address to set up in vain.
    p.click('#connect-ai-button');
    const dialog = await p.until(() => p.q('#connect-ai[open]'), 'the Connect dialog');
    expect([dialog.querySelector('#connector-address'), dialog.querySelector('#copy-workspace-details'), dialog.querySelector('.connect-tabs')]).toEqual([null, null, null]);
    expect(dialog.textContent).toContain('This workspace doesn\'t offer Interego sign-in');
    // Copy and paste is the way here, said once in its own section, not as the fallback for a connector that cannot be.
    const paste = dialog.querySelector('#connect-paste');
    expect([paste?.tagName, paste?.querySelector('h3')?.textContent]).toEqual(['SECTION', 'Copy and paste']);
    expect(paste?.textContent).toContain('Each AI step here has a Copy for my AI button.');
    expect(dialog.querySelectorAll('.callout')).toHaveLength(0);
    expect(dialog.textContent).not.toMatch(/No connector\?|needs no key\b.*above|above needs no key|supports connectors/);
    expect(dialog.querySelector('#connect-desc')?.textContent).toContain('Your own Claude, ChatGPT or any chat app does the AI work');
    expect(dialog.textContent).not.toContain('relay.interego');
    // The key of your own is there, closed, as Advanced, and Anthropic's.
    const byok = dialog.querySelector('#byok-section') as HTMLDetailsElement;
    expect([byok.open, byok.querySelector('summary')?.textContent]).toEqual([false, 'Advanced: use your own Anthropic API key (drafts only)']);
    // Nothing can connect here, so the sentence under it says copy and paste, not "connected".
    expect(byok.textContent).toContain('Claude or ChatGPT needs no key here: copy and paste works with any plan.');
    expect(byok.textContent).not.toMatch(/\bconnected\b/);
    const JARGON = /\b(pod|bridge|affordance|envelope|nonce|hypothetical|ratif\w*|countersign\w*|relay)\b/i;
    const CODES = /\b(EIP-191|IRI|DID)\b|HTTP \d{3}|urn:/;
    expect([visibleText(dialog).match(JARGON)?.[0] ?? null, visibleText(dialog).match(CODES)?.[0] ?? null]).toEqual([null, null]);
    p.click('#connect-ai .modal__footer .btn--primary');

    const card = await p.until(() => p.q('article.scenario'), 'the scenarios, again');
    card.querySelector<HTMLInputElement>('input[type=radio][value=no]')!.checked = true;
    card.querySelector<HTMLElement>(button(PEV_ACTION.startAttempt))!.click();
    await p.until(() => p.q('#line') ?? p.q('#view .refusal'), 'the conversation');
    expect([p.q('#send'), p.q('.chat-handoff'), p.q('#check-lines')]).toEqual([null, null, null]);
    // The only route here is copy and paste, so it is open, and the line is typed inside it.
    const packet = p.q('#view details.packet') as HTMLDetailsElement;
    expect([packet.open, packet.contains(p.q('#line')), packet.querySelector('summary')?.textContent]).toEqual([true, true, 'Copy and paste one line at a time']);
    const line = 'Thanks for making time. The report was due Thursday at noon.';
    p.set(p.q('#line'), line);
    p.click(button(PEV_ACTION.counterpartPacket));
    const ready = await p.until(() => p.all('#view .packet .callout').find((c) => (c.textContent ?? '').includes('Message ready')) ?? p.q('#view .packet .refusal'), 'the message for my AI');
    const shown = visibleText(ready);
    expect(shown).toContain('Copy it into Claude, ChatGPT or any chat app.');
    expect(shown).not.toMatch(/pev\.|\bbridge\b|sampled|signed by the learner/);
    // The server's own instructions, for an agent with the connector, are kept under Technical details.
    expect(ready.querySelector('.disclosure__body--tech')?.textContent).toContain('pev.record_turns');
    p.click('#copy-for-ai');
    await p.until(() => copied.length === 1, 'the copied message');
    const msg = copied[0]!;
    // Plain text a chat app can take, not JSON: the scenario, the conversation and the line, then how to answer.
    expect(msg.startsWith('{')).toBe(false);
    for (const says of [line, 'Reply with only Sam Okafor\'s next line, nothing else.', '(Stage direction: The practice conversation starts. Say your first line.)', 'Me: Thanks for making time.', 'Sam Okafor: You wanted to see me?']) expect(msg).toContain(says);
    expect(msg).not.toMatch(/llm_api_key|"messages"|"system"/);
    // The reply comes back with who wrote it, in a person's words.
    p.set(p.q('#their-line'), 'Fine. What do you need from me?');
    p.set(p.q('#their-provider'), 'OpenAI');
    p.set(p.q('#their-model'), 'not shown');
    expect(p.text('#view .packet')).toContain("The name in its model picker. Write 'not shown' if your app doesn't say.");
    const before = p.all('.bubble').length;
    p.click(button(PEV_ACTION.recordTurns));
    await p.until(() => p.all('.bubble').length === before + 2 || p.q('#view .conversation .refusal'), 'both lines saved');
    expect(p.all('.bubble.them').at(-1)?.textContent).toContain('Written by your own AI (OpenAI, model not shown), as declared');
    const attemptIri = decodeURIComponent(p.w.location.hash.slice('#/attempt/'.length));
    const v = await direct(noModelHandlers, 'pev.get_attempt', ana, PEV_ACTION.getAttempt, { attemptIri });
    const them = (v['turns'] as Out[]).at(-1)!;
    expect([them['source'], (them['disclosure'] as Out)['provider'], (them['disclosure'] as Out)['model'], (them['disclosure'] as Out)['route']]).toEqual(['client-packet', 'OpenAI', 'not shown', 'client-packet']);
    // One saved version reads as one.
    await p.until(() => p.all('#view .versions summary').find((x) => (x.textContent ?? '').startsWith('History')), 'the history');
    expect(p.all('#view .versions summary').map((x) => x.textContent)).toContain(`History (${(v['versions'] as unknown[]).length} saved versions)`);

    // Finished, with no judge yet: the Feedback card says nothing is assessed, not that something is provisional.
    p.click(button(PEV_ACTION.endConversation));
    await p.until(() => p.text('#state') === 'Finished: not assessed yet' || p.q('#view .refusal'), 'the finished session');
    expect([p.text('#view .judgments .card__header .status'), p.text('#view .judgments')]).toEqual(['Not assessed yet', expect.stringContaining('Waiting for a judge.')]);
    // The judge's hand-off, with no connector here: a plain-text message to send, the packet itself under a closed Technical details.
    p.click(button(PEV_ACTION.judgePacket));
    const handoff = await p.until(() => p.q('#copy-judge-handoff')?.closest('.callout') ?? p.q('#view .actions .refusal'), 'the hand-off');
    expect(visibleText(handoff)).not.toMatch(/JSON|@context|\{/);
    // It says plainly that this web app can't save the judge's assessment: a tool of the judge's own does.
    expect(visibleText(handoff)).toContain('This web app can\'t save an assessment yet: saving it takes a tool of their own that signs with their key.');
    expect(visibleText(handoff)).not.toContain('save the assessment with their own key');
    const tech = [...handoff.querySelectorAll('details')].find((x) => x.querySelector('summary')?.textContent === 'Technical details') as HTMLDetailsElement;
    expect([tech.open, tech.querySelector('pre.json')?.textContent?.includes('"@context"')]).toEqual([false, true]);
    p.click('#copy-judge-handoff');
    await p.until(() => copied.length === 2, 'the message for the judge');
    const judge = copied[1]!;
    const ended = await direct(noModelHandlers, 'pev.get_attempt', ana, PEV_ACTION.getAttempt, { attemptIri });
    expect(typeof ended['transcriptHash']).toBe('string');
    expect(judge.startsWith('Hi, could you assess my practice session in Practice Evidence?')).toBe(true);
    for (const says of [attemptIri, 'Paste everything between the lines into Claude, ChatGPT or any chat app.', line, 'Reply with only the JSON object the instructions describe',
      PEV_ACTION.recordJudgment, `- transcriptHash: ${String(ended['transcriptHash'])}`, '- judgment: the JSON object your AI wrote', 'usedPacketPrompt true',
      "The Practice Evidence web app can't save an assessment yet. Saving it takes a tool of your own (your own agent or script) that signs these fields with your key, as an appointed judge, and sends them to the workspace above:"]) expect(judge, says).toContain(says);
    // Never as an ordinary step "here": the action is named once, as a field the judge's tool signs.
    expect(judge).not.toMatch(/save the assessment here|the step urn:/);
    expect(judge.split(PEV_ACTION.recordJudgment).length - 1).toBe(1);
    // Plain text: no JSON-LD wrapper, no escaped line breaks or quotes.
    expect(judge).not.toMatch(/"@context"|"@type"|\\n|\\"|"messages"|"recordWith"/);
    copied.splice(1);

    // Writing a scenario here: no "Draft with AI" (no AI of its own and no key), and the paste route open.
    p.w.location.hash = '#/author';
    await p.until(() => p.q('#draft-brief'), 'the author form');
    expect([p.q(button(PEV_ACTION.draftScenario)), p.q('.draft-chat')]).toEqual([null, null]);
    expect((p.q('.draft-paste') as HTMLDetailsElement).open).toBe(true);
    expect(p.q('.draft-paste summary')?.textContent).toBe('Copy and paste a draft');
    p.set(p.q('#draft-brief'), 'A project manager tells a client sponsor that two defects block the payment flow.');
    p.click(button(PEV_ACTION.draftScenarioPacket));
    await p.until(() => p.q('#copy-draft-paste') ?? p.q('#view .draft-paste .refusal'), 'the drafting message');
    // The message is under its button, above the answer box it says to paste into.
    const draftReady = p.q('#copy-draft-paste')!.closest('.callout')!;
    expect(draftReady.textContent).toContain('Paste its whole answer into Your AI\'s answer below');
    expect(draftReady.compareDocumentPosition(p.q('#draft-json')!) & p.w.Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(p.q(button(PEV_ACTION.draftScenarioPacket))!.compareDocumentPosition(draftReady) & p.w.Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    p.click('#copy-draft-paste');
    await p.until(() => copied.length === 2, 'the copied drafting message');
    expect(copied[1]!.startsWith('{')).toBe(false);
    expect(copied[1]).toContain('Reply with only the JSON object the instructions describe');
    expect(copied[1]).toContain('two defects block the payment flow');
    // The schema is in the request's own instructions, once: never appended a second time.
    expect(copied[1]!.split(JSON.stringify(practice.draftPacket('x').outputSchema)).length - 1).toBe(1);
    expect(copied[1]).not.toContain('The JSON object\'s shape');
    // A pasted answer with prose around it loads; prose alone says what to paste.
    p.set(p.q('#draft-json'), 'Here you go!');
    p.click('#load-draft');
    await p.until(() => p.q('#view .draft-paste .error-text'), 'the paste error');
    expect(p.text('#view .draft-paste .error-text')).toContain('We couldn\'t find a draft in that answer. Paste the whole answer, including the part from { to }.');
    p.set(p.q('#draft-json'), `Sure.\n\`\`\`json\n${JSON.stringify(demoDraft())}\n\`\`\`\nHope this helps`);
    p.click('#load-draft');
    await p.until(() => (p.q('[data-field="title"] input') as HTMLInputElement | null)?.value, 'the loaded draft');
    expect((p.q('[data-field="title"] input') as HTMLInputElement).value).toBe(String(demoDraft()['title']));
    expect(p.text('#view')).toContain('You pasted a draft from an AI: choose My AI assistant and name it.');
    expect((p.all('[data-field="choice"] input[type=radio]') as HTMLInputElement[]).some((r) => r.checked)).toBe(false);
    // Turning on a key of your own (Advanced) offers drafting with it, and what the author typed for the
    // draft survives the form being drawn again: the brief, the material and the pasted answer.
    const typed = { '#draft-brief': 'A sponsor hears that two defects block the payment flow.', '#draft-source': 'Defect log, week 12.', '#draft-json': 'Their whole answer' };
    for (const [sel, v] of Object.entries(typed)) p.set(p.q(sel), v);
    const values = (): string[] => Object.keys(typed).map((sel) => (p.q(sel) as HTMLTextAreaElement | null)?.value ?? '(gone)');
    p.click('#connect-ai-button');
    await p.until(() => p.q('#connect-ai[open]'), 'the Connect dialog');
    const toggle = p.q('#connect-ai #byok') as HTMLInputElement;
    toggle.checked = true;
    p.fire(toggle, 'change');
    await p.until(() => p.q(button(PEV_ACTION.draftScenario)), 'drafting with your own key');
    expect(p.text(button(PEV_ACTION.draftScenario))).toBe('Draft with my Anthropic key');
    expect(values()).toEqual(Object.values(typed));
    // The draft card and the paste box stay open to show what is in them, even with a draft loaded.
    expect((p.q('.draft-card') as HTMLDetailsElement).open && (p.q('.draft-paste') as HTMLDetailsElement).open).toBe(true);
    toggle.checked = false;
    p.fire(toggle, 'change');
    await p.until(() => !p.q(button(PEV_ACTION.draftScenario)), 'drafting by copy and paste again');
    expect(values()).toEqual(Object.values(typed));
    // Starting a new scenario starts with an empty brief.
    p.click('#connect-ai .modal__footer .btn--primary');
    const fresh = p.all('#view button').find((b) => b.textContent === 'Start a new scenario');
    fresh!.click();
    await p.until(() => (p.q('#draft-brief') as HTMLTextAreaElement | null)?.value === '', 'a new, empty scenario');
    expect(p.errors).toEqual([]);
  }, SLOW);

  it('Team says what is wrong with a mistyped or empty wallet address under the field, and sends nothing for an empty one', async () => {
    const asked: string[] = [];
    const p = await openUi(demo, (w) => {
      const f = w['fetch'] as (input: unknown, init?: RequestInit) => Promise<Response>;
      w['fetch'] = (input: unknown, init?: RequestInit): Promise<Response> => { asked.push(new URL(String(input), 'http://x/').pathname); return f(input, init); };
    });
    await p.until(() => p.text('#bar').includes('DEMO MODE'), 'the demo banner');
    await asRole(p, 'admin');
    p.w.location.hash = '#/roles';
    await p.until(() => p.q(button(PEV_ACTION.registerRole)), 'the roles form');
    // This workspace offers no Interego sign-in, so no one here has a Member ID: Team asks for the
    // wallet address Getting started copies, as the guide and the admin's steps say.
    expect(p.text('#view .page-header')).toContain('Add people by their wallet address and choose their role.');
    expect([p.text('label[for="member-id"]'), (p.q('#member-id') as HTMLInputElement).placeholder]).toEqual(['Wallet address', '0x…']);
    expect(p.text('#view .card')).toContain('Ask the person to copy it from Getting started (Copy my wallet address).');
    const sent = (): number => asked.filter((x) => x.endsWith('/pev/register_role')).length;
    const before = sent();
    p.set(p.q('#member-id'), '   ');
    p.click(button(PEV_ACTION.registerRole));
    await p.until(() => p.q('#member-id-error'), 'the empty-field message');
    expect([p.text('#member-id-error'), p.q('#member-id')!.getAttribute('aria-invalid'), sent()]).toEqual(['Enter their wallet address.', 'true', before]);
    p.set(p.q('#member-id'), 'bob@example');
    expect(p.q('#member-id-error')).toBeNull();
    p.click(button(PEV_ACTION.registerRole));
    await p.until(() => p.q('#member-id-error') ?? p.q('#view .refusal'), 'the format message');
    expect(p.text('#member-id-error')).toBe('That isn\'t a wallet address. It should be 0x followed by 40 letters and digits.');
    expect(p.text('#view')).not.toContain('Member ID');
    expect([p.q('#view .refusal'), sent()]).toEqual([null, before + 1]);
    expect(p.q('#member-id')!.getAttribute('aria-describedby')).toContain('member-id-error');
    expect(p.errors).toEqual([]);
  }, SLOW);

  it('a view says it is loading while its signed read is on its way, under its header', async () => {
    let slow = false;
    const p = await openUi(demo, (w) => {
      const f = w['fetch'] as (input: unknown, init?: RequestInit) => Promise<Response>;
      w['fetch'] = async (input: unknown, init?: RequestInit): Promise<Response> => {
        if (slow && String(input).endsWith('/pev/get_attempt')) await new Promise((r) => setTimeout(r, 600));
        return f(input, init);
      };
    });
    await p.until(() => p.q('article.scenario'), 'the scenarios');
    await asRole(p, 'learner');
    slow = true;
    p.w.location.hash = '#/mine';
    await p.until(() => p.text('#view h1') === 'My practice' && p.q('#view .view-loading'), 'the loading line under the header');
    expect(p.text('#view .view-loading')).toContain('Loading…');
    expect(p.q('#view .page-header')!.compareDocumentPosition(p.q('#view .view-loading')!) & p.w.Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    await p.until(() => p.q('#view table.mine') ?? p.q('#view .empty'), 'my practice');
    expect(p.q('#view .view-loading')).toBeNull();
    expect(p.errors).toEqual([]);
  }, SLOW);

  it('a reviewed session whose text was deleted reads the same everywhere: its kept result, never "provisional"', async () => {
    const attemptIri = S['attempt'];
    expect(attemptIri, 'the first driven test leaves a reviewed attempt').toBeTruthy();
    const v = await direct(demoHandlers, 'pev.get_attempt', W.learner, PEV_ACTION.getAttempt, { attemptIri });
    const red = await direct(demoHandlers, 'pev.redact_attempt', W.learner, PEV_ACTION.redactAttempt, { attemptIri, target: v['currentTarget'], why: 'Ana deleted the words of her practice.' });
    expect(red['state']).toBe('redacted');
    const p = await openUi(demo);
    await p.until(() => p.text('#bar').includes('DEMO MODE'), 'the demo banner');
    await asRole(p, 'learner');
    p.w.location.hash = '#/mine';
    const row = await p.until(() => p.all('#view table.mine tbody tr').find((tr) => tr.querySelector(`a[href="#/attempt/${encodeURIComponent(attemptIri ?? '')}"]`)), 'the session in my practice');
    const result = row.querySelector('td[data-label="Result"]')?.textContent ?? '';
    expect(result).toBe('100.0% · meets the pass mark');
    p.w.location.hash = `#/attempt/${encodeURIComponent(attemptIri ?? '')}`;
    await p.until(() => p.text('#state') === 'Conversation text deleted' && p.q('#assessment'), 'the session');
    const meta = p.text('#view .page-header__meta');
    expect([meta.includes('Final: reviewed'), meta.includes('Provisional')]).toEqual([true, false]);
    expect(p.text('#assessment')).toContain('Final: a qualified reviewer signed off every level.');
    // What reviewers changed, as a reviewer reads it: level names, and a level kept is not called a change.
    await asRole(p, 'reviewer');
    p.w.location.hash = `#/results/${encodeURIComponent(S['md'] ?? '')}`;
    const changes = await p.until(() => p.all('#view section.card').find((c) => c.querySelector('.card__title')?.textContent === 'What reviewers changed'), 'what reviewers changed');
    const items = [...changes.querySelectorAll('li')].map((li) => li.textContent ?? '').filter((x) => !/reviewed sessions$/.test(x));
    expect(items.length).toBeGreaterThan(0);
    for (const x of items) {
      expect(x).toMatch(/: (kept the AI's level, |changed )/);
      expect(x).not.toMatch(/→|owner-and-date|asks-their-view/);
    }
    expect(p.errors).toEqual([]);
  }, SLOW);

  it('a quote found in more than one line says which line is highlighted: the one it was saved in, which need not be the first; with the text deleted, nothing is called highlighted', async () => {
    // A world of its own: one pod, the roles a judging needs, and an ended session whose first and second lines share words.
    const own = inMemoryPod();
    const h = createPevHandlers({ ...base, fetchFn: own.fetchFn, holderFetchFn: own.fetchFn, model: scriptedPracticeModel(), demoSigner: demoSignerOf(W) }) as Handlers;
    for (const [who, role] of [['author', 'author'], ['reviewer', 'reviewer'], ['judge-agent', 'judge']] as const) {
      expect((await direct(h, 'pev.register_role', W.admin, PEV_ACTION.registerRole, { address: W[who].address, role, change: 'add' }))['changed']).toBe(true);
    }
    const pub = await direct(h, 'pev.author_scenario', W.author, PEV_ACTION.authorScenario, { scenario: demoScenarioInput('missed-deadline', 2), status: 'published', draftAssistance: { used: false } });
    expect((await direct(h, 'pev.ratify_scenario', W.reviewer, PEV_ACTION.ratifyScenario, { scenarioIri: pub['scenarioIri'], version: 1, scenarioHash: pub['scenarioHash'] }))['status']).toBe('ratified');
    const started = await direct(h, 'pev.start_attempt', W.learner, PEV_ACTION.startAttempt, { scenarioIri: pub['scenarioIri'], scenarioVersion: 1, coached: false });
    const attemptIri = String(started['attemptIri']);
    const mine = [
      'Thanks for coming in. I would like us to agree a new date today, once I hear what got in the way.',
      'I see. So I would like us to agree a new date today, once I hear what got in the way from your side.',
      'Let us write it down before Friday so we both remember it.',
    ];
    for (let i = 0; i < mine.length; i += 1) {
      const r = await direct(h, 'pev.record_turns', W.learner, PEV_ACTION.recordTurns, {
        attemptIri, turnIndex: 2 * i + 1, learnerText: mine[i], counterpartText: DEMO_LINES.sam[i], endAfter: i === mine.length - 1,
        counterpartDisclosure: { provider: 'scripted', model: 'demo-learner-agent' },
      });
      expect(r['kind']).toBeUndefined();
    }
    const packet = await direct(h, 'pev.judge_packet', W['judge-agent'], PEV_ACTION.judgePacket, { attemptIri });
    const binding = packet['binding'] as Out;
    // The judge names the second line for one quote, a line that does not hold the other, and the third line for a quote said once.
    const quotes: Record<string, { text: string; turnIndex: number }> = {
      'specific-observation': { text: 'agree a new date today', turnIndex: 3 },
      'asks-their-view': { text: 'hear what got in the way', turnIndex: 5 },
      'agrees-next-step': { text: 'write it down before Friday', turnIndex: 5 },
    };
    const rubric = (demoScenarioInput('missed-deadline', 2)['rubric'] as { criteria: { id: string; levels: { id: string }[] }[] }).criteria;
    const saved = await direct(h, 'pev.record_judgment', W['judge-agent'], PEV_ACTION.recordJudgment, {
      attemptIri, attemptHeadUrl: binding['attemptHeadUrl'], transcriptHash: binding['transcriptHash'], rubricHash: binding['rubricHash'],
      judgeDisclosure: { provider: 'Example', model: 'example-judge', usedPacketPrompt: true },
      judgment: { criteria: rubric.map((c) => ({ criterionId: c.id, level: c.levels[c.levels.length - 1]!.id, quotes: [quotes[c.id]!], rationale: 'The quoted words show it.' })) },
    });
    expect(saved['kind']).toBeUndefined();
    const l = await serve(h);
    const p = await openUi(l);
    await p.until(() => p.text('#bar').includes('DEMO MODE'), 'the demo banner');
    await asRole(p, 'learner');
    p.w.location.hash = `#/attempt/${encodeURIComponent(attemptIri)}`;
    await p.until(() => p.all('.judgments .quote.ok').length === 3, 'the three quotes that checked out');
    // Each line as the page draws it, by its turn: the learner's lines are turns 1, 3 and 5.
    expect(p.all('.bubble.me').map((b) => b.dataset['turn'])).toEqual(['1', '3', '5']);
    const note = (criterion: string): string | null => p.q(`.criterion-feedback[data-criterion="${criterion}"] .quote.ok .text-tertiary`)?.textContent ?? null;
    // Found in lines 1 and 3, saved in line 3 where the AI named it: the note names line 3, not the first.
    expect(note('specific-observation')).toBe('Found 2 times in the lines as the AI was shown them; the one highlighted is in line 3.');
    // Found in lines 1 and 3, the AI named line 5: saved in the first place it was found, and the note says so.
    expect(note('asks-their-view')).toBe('Found 2 times in the lines as the AI was shown them; the one highlighted is in line 1. The AI named line 5; it was found in line 1.');
    // Found once, where the AI named it: no note.
    expect(note('agrees-next-step')).toBeNull();
    // The highlights are where the notes say: each quote marked in the line it was saved in, and nowhere else.
    expect(p.all('.transcript mark').map((m) => [m.closest<HTMLElement>('[data-turn]')?.dataset['turn'], m.title, m.textContent])).toEqual([
      ['1', 'asks-their-view', 'hear what got in the way'],
      ['3', 'specific-observation', 'agree a new date today'],
      ['5', 'agrees-next-step', 'write it down before Friday'],
    ]);
    // Once the learner deletes the conversation text, the page draws no highlight: the note names the line the quote was saved from, and calls nothing highlighted.
    const v = await direct(h, 'pev.get_attempt', W.learner, PEV_ACTION.getAttempt, { attemptIri });
    const red = await direct(h, 'pev.redact_attempt', W.learner, PEV_ACTION.redactAttempt, { attemptIri, target: v['currentTarget'], why: 'The learner deleted the words of their practice.' });
    expect(red['state']).toBe('redacted');
    p.w.location.hash = '#/mine';
    await p.until(() => p.text('#view h1') === 'My practice', 'my practice');
    p.w.location.hash = `#/attempt/${encodeURIComponent(attemptIri)}`;
    await p.until(() => p.text('#state') === 'Conversation text deleted' && p.all('.judgments .quote.ok').length === 3, 'the session, its text deleted');
    expect(p.all('.transcript mark')).toEqual([]);
    expect(p.all('.judgments .quote.ok q').map((x) => x.textContent)).toEqual(Array(3).fill('(deleted with the conversation text)'));
    expect(note('specific-observation')).toBe('Found 2 times in the lines as the AI was shown them; it was saved from line 3.');
    expect(note('asks-their-view')).toBe('Found 2 times in the lines as the AI was shown them; it was saved from line 1. The AI named line 5; it was found in line 1.');
    expect(note('agrees-next-step')).toBeNull();
    expect(p.text('.judgments')).not.toContain('highlighted');
    expect(p.errors).toEqual([]);
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
    // The UI, with Interego sign-in when there is a relay to sign in through and the route trusts it.
    expect(server).toContain('attachUi(a, uiSignIn && relayUrl !== undefined');
    // The landing page and the guide follow that sign-in and nothing else, as the web app's Connect dialog does:
    // no separate connector option, so a relay trusted without PEV_RELAY_URL gets copy and paste on all three.
    expect(server).not.toMatch(/chatConnector|connector:/);
    // The sign-in carries the web app's own client ids, which the handlers read a relay-signed client_id against.
    expect(server).toMatch(/\.\.\.\(relayDelegation !== undefined \? \{ relayDelegation \} : \{\}\), webAppClients: webApp \}, \.\.\.contact \}\n\s*: contact\);/);
    expect(server).toContain("but the web app, the landing page and the guide offer no Interego sign-in and no connector, only copy and paste. Set PEV_RELAY_URL");
    expect(server).toContain("const uiSignIn = relayUrl !== undefined && relayAddresses.length > 0 && identityHost !== undefined;");
    expect(server).toContain('relayFetch: relayCallFetch(baseFetch, { privateRelay: relayIsLoopback })');
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

  it('PEV_REQUIRE_RECORD_KEY=1 stops a bridge whose record key is missing or blank before it listens, the image sets it, and a blank guard stops it too', () => {
    expect(server).toMatch(/const requireRecordKey = requireRaw === '1';/);
    // The guard is read as set, never through env(), which reads a blank value as unset.
    expect(server).toContain("const requireSet = process.env['PEV_REQUIRE_RECORD_KEY'];");
    expect(server).not.toMatch(/env\('PEV_REQUIRE_RECORD_KEY'\)/);
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
    // Set but blank (an unresolved service reference, or an empty override of the image's 1) is not
    // "no guard": empty or only spaces, it stops the bridge with the key blank too (where it would
    // write plaintext) and with a valid key. Each run would otherwise reach the next check (demo
    // keys on a public host) and stop there, saying so, rather than listen.
    const blankGuards = ['', '  '].flatMap((g) => ['', KEY].map((k) => ({ PEV_REQUIRE_RECORD_KEY: g, PEV_RECORD_KEY: k })));
    expect(blankGuards).toHaveLength(4);
    for (const extra of blankGuards) {
      const r = run({ ...extra, PEV_DEMO_ROLES: '1', HOST: '0.0.0.0' });
      expect([r.status, r.out.includes('listening on'), r.err.includes('PEV_DEMO_ROLES'), r.err], JSON.stringify(extra))
        .toEqual([1, false, false, expect.stringContaining('PEV_REQUIRE_RECORD_KEY is set but blank')]);
    }
    // A valid key passes the guard: this run goes on to the next check (demo keys on a public host) and stops there.
    const passes = run({ PEV_REQUIRE_RECORD_KEY: '1', PEV_RECORD_KEY: `0x${KEY}`, PEV_DEMO_ROLES: '1', HOST: '0.0.0.0' });
    expect([passes.status, passes.err.includes('PEV_RECORD_KEY'), passes.err]).toEqual([1, false, expect.stringContaining('PEV_DEMO_ROLES=1 needs a loopback HOST')]);
  }, 300_000);

  it('reads the Interego sign-in settings only in server.ts and stops on a malformed one; the image trusts the live relay and bakes no admin DID', () => {
    expect(server).toContain("const relayAddresses = list(env('PEV_TRUSTED_RELAY_ADDRESSES'));");
    expect(server).toContain("const identityHost = env('PEV_IDENTITY_HOST');");
    expect(server).toContain("const adminDids = list(env('PEV_ADMIN_DIDS'));");
    expect(server).toContain("const relayUrl = env('PEV_RELAY_URL');");
    expect(server).toContain("const decideRaw = env('PEV_CHAT_AGENTS_DECIDE');");
    // The DID document is read through the guarded, capped fetch, behind the cache.
    expect(server).toContain('fetchDidDocument: cachedDidDocuments(didDocumentFetch(globalThis.fetch.bind(globalThis))),');
    const reads = /env\(\s*'PEV_(TRUSTED_RELAY_ADDRESSES|IDENTITY_HOST|ADMIN_DIDS|RELAY_URL|CHAT_AGENTS_DECIDE)'/;
    expect(others.filter((f) => reads.test(readFileSync(f, 'utf8'))).map((f) => relative(VERTICAL, f))).toEqual([]);
    const image = readFileSync(join(REPO, 'deploy/Dockerfile.pev-bridge'), 'utf8');
    expect(image).toMatch(/^ENV PEV_TRUSTED_RELAY_ADDRESSES=0x276e11d2229d3a96dc96356c15c03c7f83201ebc$/m);
    expect(image).toMatch(/^ENV PEV_IDENTITY_HOST=identity\.interego\.xwisee\.com$/m);
    expect(image).toMatch(/^ENV PEV_RELAY_URL=https:\/\/relay\.interego\.xwisee\.com$/m);
    expect(image).not.toMatch(/^ENV PEV_ADMIN_DIDS=/m);
    expect(image).not.toMatch(/^ENV PEV_CHAT_AGENTS_DECIDE=/m);
    expect(image).toContain('RELAY-ATTESTED, NOT USER-HELD');
    const run = (extra: Record<string, string>): { status: number | null; out: string; err: string } => {
      const r = spawnSync(process.execPath, ['--import', 'tsx', join(VERTICAL, 'bridge/server.ts')], {
        cwd: REPO, encoding: 'utf8', timeout: 120_000, env: { NODE_NO_WARNINGS: '1', PORT: '0', ...extra },
      });
      return { status: r.status, out: r.stdout, err: r.stderr };
    };
    const LIVE = '0x276e11d2229d3a96dc96356c15c03c7f83201ebc';
    const HOSTNAME = 'identity.interego.xwisee.com';
    const malformed: readonly (readonly [Record<string, string>, string])[] = [
      [{ PEV_TRUSTED_RELAY_ADDRESSES: `${LIVE},0x123`, PEV_IDENTITY_HOST: HOSTNAME }, 'PEV_TRUSTED_RELAY_ADDRESSES: 1 value(s) are not 0x addresses'],
      [{ PEV_TRUSTED_RELAY_ADDRESSES: LIVE }, 'PEV_TRUSTED_RELAY_ADDRESSES is set and PEV_IDENTITY_HOST is not'],
      [{ PEV_IDENTITY_HOST: `https://${HOSTNAME}/` }, 'PEV_IDENTITY_HOST is "https://identity.interego.xwisee.com/"'],
      [{ PEV_ADMIN_DIDS: `did:web:${HOSTNAME}:users:u-pk-f2a9c751075a` }, 'PEV_ADMIN_DIDS is set and PEV_IDENTITY_HOST is not'],
      [{ PEV_IDENTITY_HOST: HOSTNAME, PEV_ADMIN_DIDS: `did:web:${HOSTNAME}:agents:claude-u-pk-f2a9c751075a` }, 'PEV_ADMIN_DIDS: 1 value(s) are not'],
      [{ PEV_RELAY_URL: 'ftp://relay.interego.xwisee.com' }, 'PEV_RELAY_URL is "ftp://relay.interego.xwisee.com"'],
      [{ PEV_CHAT_AGENTS_DECIDE: 'yes' }, 'PEV_CHAT_AGENTS_DECIDE is "yes"; it takes 1'],
    ];
    for (const [extra, says] of malformed) {
      const r = run(extra);
      expect([r.status, r.out.includes('listening on'), r.err], JSON.stringify(extra)).toEqual([1, false, expect.stringContaining(says)]);
    }
    // The image's values, with an admin DID, pass these guards: the run goes on to the next check
    // (demo keys on a public host) and stops there.
    const passes = run({
      PEV_TRUSTED_RELAY_ADDRESSES: LIVE, PEV_IDENTITY_HOST: HOSTNAME, PEV_RELAY_URL: 'https://relay.interego.xwisee.com',
      PEV_ADMIN_DIDS: `did:web:${HOSTNAME}:users:u-pk-f2a9c751075a`, PEV_CHAT_AGENTS_DECIDE: '0', PEV_DEMO_ROLES: '1', HOST: '0.0.0.0',
    });
    expect([passes.status, passes.err]).toEqual([1, expect.stringContaining('PEV_DEMO_ROLES=1 needs a loopback HOST')]);
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

// ═════════════════════════════════════════════════════════════════════════════════════════════
//  What a judge packet weighs on the wire
// ═════════════════════════════════════════════════════════════════════════════════════════════

describe('a judge packet over HTTP is its JSON and the bridge\'s envelope, not copies of it', () => {
  it('answers the packet with no Markdown copy (it offers no next-step control), keeps the full snapshot for a Markdown reader, and a refusal stays small', async () => {
    // A world of its own: one pod, the roles a judging needs, an attempt of three exchanges that has ended.
    const own = inMemoryPod();
    const h = createPevHandlers({ ...base, fetchFn: own.fetchFn, holderFetchFn: own.fetchFn, model: scriptedPracticeModel() }) as Handlers;
    for (const [who, role] of [['author', 'author'], ['reviewer', 'reviewer'], ['judge-agent', 'judge']] as const) {
      expect((await direct(h, 'pev.register_role', W.admin, PEV_ACTION.registerRole, { address: W[who].address, role, change: 'add' }))['changed']).toBe(true);
    }
    const pub = await direct(h, 'pev.author_scenario', W.author, PEV_ACTION.authorScenario, { scenario: demoScenarioInput('missed-deadline', 2), status: 'published', draftAssistance: { used: false } });
    expect((await direct(h, 'pev.ratify_scenario', W.reviewer, PEV_ACTION.ratifyScenario, { scenarioIri: pub['scenarioIri'], version: 1, scenarioHash: pub['scenarioHash'] }))['status']).toBe('ratified');
    const started = await direct(h, 'pev.start_attempt', W.learner, PEV_ACTION.startAttempt, { scenarioIri: pub['scenarioIri'], scenarioVersion: 1, coached: false });
    for (let i = 0; i < 3; i += 1) {
      const r = await direct(h, 'pev.record_turns', W.learner, PEV_ACTION.recordTurns, {
        attemptIri: started['attemptIri'], turnIndex: 2 * i + 1, learnerText: DEMO_LINES.ana[i], counterpartText: DEMO_LINES.sam[i], endAfter: i === 2,
        counterpartDisclosure: { provider: 'scripted', model: 'demo-learner-agent' },
      });
      expect(r['kind']).toBeUndefined();
    }
    const l = await serve(h);
    const ask = async (w: Wallet, accept: string): Promise<{ status: number; type: string; text: string }> => {
      const r = await fetch(`${l.base}/pev/judge_packet`, { method: 'POST', headers: { 'content-type': 'application/json', accept },
        body: JSON.stringify({ envelope: await envelope(w, PEV_ACTION.judgePacket, { attemptIri: started['attemptIri'] }) }) });
      return { status: r.status, type: r.headers.get('content-type') ?? '', text: await r.text() };
    };
    const got = await ask(W['judge-agent'], 'application/json');
    expect(got.status).toBe(200);
    const packet = JSON.parse(got.text) as Out;
    expect(packet['https://schema.org/encoding']).toBeUndefined();
    expect(packet['execution']).toBe('client-required');
    // The transcript travels once. What the bridge adds is its JSON-LD envelope: the context, the types and two affordances.
    const { '@context': _ctx, '@type': _type, conformsToShape: _shape, affordances: _aff, ...payload } = packet;
    expect(Buffer.byteLength(got.text) - Buffer.byteLength(JSON.stringify(payload))).toBeLessThan(3_500);
    expect(got.text.split(DEMO_LINES.ana[1]!).length - 1).toBe(1);
    // Escaped once more inside a relay's act result, it stays far below a chat client's tool-result limit.
    expect(JSON.stringify(got.text).length).toBeLessThan(20_000);
    // Asked for as Markdown, the one document still carries the whole packet, losslessly.
    const md = await ask(W['judge-agent'], 'text/markdown');
    expect([md.status, md.type]).toEqual([200, expect.stringContaining('text/markdown')]);
    const snapshot = JSON.parse(String(parseHypermediaMarkdown(md.text).fields?.['schema:text'])) as Out;
    expect([snapshot['request'], snapshot['binding'], snapshot['recordWith']]).toEqual([packet['request'], packet['binding'], packet['recordWith']]);
    expect(md.text).toContain('```json\n');
    // A one-sentence refusal arrives as that sentence in the envelope.
    const stranger = await ask(W['second-learner'], 'application/json');
    expect(stranger.status).toBe(403);
    expect((JSON.parse(stranger.text) as Out)['https://schema.org/encoding']).toBeUndefined();
    expect(Buffer.byteLength(stranger.text)).toBeLessThan(4_000);
    // The action manifest says which pod the bridge writes to, as its entry point does.
    const manifest = await (await fetch(`${l.base}/affordances`, { headers: { accept: 'text/turtle' } })).text();
    expect(manifest).toContain(`rdfs:comment "Capabilities exposed by the practice-evidence vertical bridge. It is configured to write to the pod ${DEMO_POD}.`);
  }, SLOW);
});
