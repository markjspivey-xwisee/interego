/**
 * The customer-facing site: what a person meets before and after signing in.
 *
 * A browser asking for the bridge's root gets the landing page, with the UI's headers; an agent,
 * curl or fetch() still gets the JSON-LD entry point, and Markdown asks still get HMD. The guide
 * (/ui/help) and the favicon are served the same way, behind the Host guard. No page the bridge
 * serves carries an inline script, an inline style or an event-handler attribute, and every
 * script and stylesheet is this bridge's own.
 *
 * In the app, a signed-out visitor sees a welcome, not an error; a person not yet added sees "One
 * more step"; a refusal reads as a plain sentence with the raw answer tucked into Technical
 * details; and no populated view shows the protocol's words (pod, envelope, regime, Brier...) on
 * screen. The navigation's labels are exactly the product's, and a count never changes a
 * button's text, so a click by label always reaches the intended control.
 */
import { describe, it, expect, afterAll } from 'vitest';
import { readFileSync } from 'node:fs';
import { request } from 'node:http';
import type { NextFunction, Request, Response } from 'express';
import { JSDOM, VirtualConsole } from 'jsdom';
import { importWallet, sha256Hex, signMessageRaw, canonicalJson } from '@interego/core';
import { createVerticalBridge } from '../../_shared/vertical-bridge/index.js';
import { chatAgentJs } from '../../_shared/chat-agent/index.js';
import { listenLoopback, type TestListener } from '../../_shared/vertical-bridge/listen-loopback.js';
import { wrdAffordances, wrdDemoAffordances } from '../affordances.js';
import { createWrdHandlers } from '../bridge/handlers.js';
import { attachUi, hostAllowlistGuard, parseEveryQueryPair, servedHostNames, UI_CSP, type UiReads, type UiSignIn } from '../bridge/ui.js';
import { designSystemCss } from '../../_shared/design-system/index.js';
import { SIBLING, INTEREGO_DEFAULTS, connectorUrlOf, renderSitePage, siteValues, type LandingOptions } from '../bridge/landing.js';
import { demoClock, memoryPod, DEMO_POD, DEMO_RECORD_KEY } from '../demo/run.js';
// The plain-words guard (JARGON, ALLOWED = [], visibleText), shared with every other DOM test of the UI.
import { ALLOWED, jargonIn, urnsRunningIntoPunctuation, visibleText } from './plain-words.js';

/** /ui/app.js as the bridge serves it: the shared chat-agent helpers, then the app (bridge/ui.ts). */
const APP_JS = `${chatAgentJs()}\n${readFileSync(new URL('../bridge/ui/app.js', import.meta.url), 'utf8')}`;
/** A claim about which Claude or ChatGPT plans allow a connector: no page, and not the README, names a plan. */
const PLAN_CLAIM = /(Claude|ChatGPT) plans?\b|plans? that allows?|on a plan that|on your plan\?|plan must allow|plans can(?:'|’)?t/i;
const must = <T>(v: T | null | undefined, what: string): T => { if (v === null || v === undefined) throw new Error(`missing ${what}`); return v; };
const BROWSER = 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8';
const listeners: TestListener[] = [];
afterAll(async () => { for (const l of listeners) await l.close(); });

/**
 * A production composition, as bridge/server.ts composes it (its entry point names the pod it serves): no demo signer,
 * and no sign-in unless `signIn` is given. `base`: the public address the pages name (default http://127.0.0.1).
 */
async function production(o: { readonly landing?: LandingOptions; readonly reads?: UiReads; readonly signIn?: UiSignIn; readonly base?: string } = {}): Promise<TestListener> {
  const { base = 'http://127.0.0.1', ...rest } = o;
  const l = await listenLoopback(createVerticalBridge({
    verticalName: 'work-redesign', affordances: wrdAffordances, deploymentUrl: base, defaultPodUrl: DEMO_POD,
    handlers: createWrdHandlers({ defaultPodUrl: DEMO_POD }),
    middleware: (a) => { attachUi(a, { base, ...rest }); parseEveryQueryPair(a); },
  }));
  listeners.push(l);
  return l;
}

/** Every call a sign-in below would make to its relay or the identity host: none is made, since only pages are read. */
const relayCalls: string[] = [];
/**
 * A sign-in whose relay this bridge trusts, as bridge/server.ts builds it from WRD_RELAY_URL and WRD_TRUSTED_RELAY_ADDRESSES:
 * the pages then name the Interego connector. Example hosts only, and never reached: each would-be call is recorded and refused.
 */
const trusted = (policy: 'trusted' | 'none' = 'trusted'): UiSignIn => ({
  relayUrl: 'https://relay.example.org',
  policy: policy === 'none' ? null : {
    relayAddresses: [`0x${'1'.repeat(40)}`], identityHost: 'identity.example.org',
    fetchDidDocument: async (url) => { relayCalls.push(url); throw new Error('not reached in this test'); },
  },
  fetchFn: async (url) => { relayCalls.push(url); throw new Error('not reached in this test'); },
});
/** The deployed bridge's address is 44 characters (https://wrd-bridge-production.up. and its host's 12): this has the same length, on a reserved example domain. */
const PRODUCTION_LENGTH_BASE = 'https://wrd-bridge-production.up.example.org';

/**
 * The demo composition of the UI's DOM test: Ana a process lead and team member named on one unsorted task, Zed in no role, and
 * the admin. `withBo`: Bo, a team member, too, after Ana, so People & roles has two rows whose buttons read the same.
 */
async function minimalDemo(o: { readonly withBo?: boolean } = {}): Promise<TestListener> {
  const pod = memoryPod();
  const clock = demoClock();
  const seed = (id: string) => importWallet(`0x${sha256Hex(`wrd-customer-site:${id}`)}`, 'human', id);
  const admin = seed('admin');
  const ana = seed('ana');
  const zed = seed('zed');
  const bo = seed('bo');
  const handlers = createWrdHandlers({
    fetchFn: pod.fetchFn, defaultPodUrl: DEMO_POD, now: () => clock.now(), platform: { wallet: seed('platform'), keyKind: 'demo' }, adminAddresses: [admin.address],
    recordKey: DEMO_RECORD_KEY,
    demoPersonas: new Map([['ana', { id: 'ana', label: 'Ana (demo)', wallet: ana }], ['zed', { id: 'zed', label: 'Zed (demo)', wallet: zed }], ['admin', { id: 'admin', label: 'Admin (demo)', wallet: admin }]]),
  });
  const registry = {
    intent: 'wrd:update-registry', podUrl: DEMO_POD, issuedAt: clock.now().toISOString(), nonce: 'customer-site-registry-1',
    entries: [{ address: ana.address, roles: ['operator', 'worker'], label: 'Ana', softwareAgent: false, personRef: 'p-ana' },
      ...(o.withBo ? [{ address: bo.address, roles: ['worker'], label: 'Bo', softwareAgent: false, personRef: 'p-bo' }] : [])],
    taskKinds: [{ slug: 'invoice-matching', label: 'Invoice matching', definition: 'Match an invoice to its purchase order.' }],
  };
  const registered = await handlers['wrd.update_registry']!({ envelope: { payload: registry, signature: await signMessageRaw(admin, canonicalJson(registry)) } }) as Record<string, unknown>;
  expect(registered['status']).toBe('registered');
  const capture = {
    intent: 'wrd:capture-workflow', podUrl: DEMO_POD, issuedAt: clock.now().toISOString(), nonce: 'customer-site-capture-1',
    workflow: { title: 'Accounts payable', unitLabel: 'invoice' },
    tasks: [{ name: 'Match invoices', description: 'Three-way match before approval.', currentLevel: 'person', personAddress: ana.address, taskKind: 'invoice-matching' }],
  };
  const captured = await handlers['wrd.capture_workflow']!({ envelope: { payload: capture, signature: await signMessageRaw(ana, canonicalJson(capture)) } }) as Record<string, unknown>;
  expect(captured['status']).toBe('captured');
  const l = await listenLoopback(createVerticalBridge({
    verticalName: 'work-redesign', affordances: [...wrdAffordances, ...wrdDemoAffordances], handlers, deploymentUrl: 'http://127.0.0.1',
    middleware: (a) => { attachUi(a, { base: 'http://127.0.0.1' }); parseEveryQueryPair(a); },
  }));
  listeners.push(l);
  return l;
}

/** One request to 127.0.0.1:`port` with the Host header set to `host` (fetch() cannot set Host). */
function hostRequest(port: number, path: string, host: string): Promise<{ status: number; body: Record<string, unknown> }> {
  return new Promise((resolve, reject) => {
    const req = request({ host: '127.0.0.1', port, method: 'GET', path, agent: false, headers: { host, accept: BROWSER } }, (res) => {
      let text = '';
      res.setEncoding('utf8');
      res.on('data', (chunk: string) => { text += chunk; });
      res.on('end', () => {
        let body: Record<string, unknown>;
        try { body = JSON.parse(text) as Record<string, unknown>; } catch { body = { text }; }
        resolve({ status: res.statusCode ?? 0, body });
      });
    });
    req.on('error', reject);
    req.end();
  });
}

interface Page {
  readonly window: JSDOM['window'];
  readonly doc: Document;
  readonly log: Array<{ method: string; path: string; status: number }>;
  readonly errors: string[];
  text(): string;
  visible(): string;
  click(buttonText: string): void;
  fill(sel: string, value: string): void;
  select(sel: string, value: string): void;
  until<T>(fn: () => T | null | undefined | false, what: string, ms?: number): Promise<T>;
}

/** The shipped /ui shell and /ui/app.js in a jsdom window whose fetch reaches the loopback bridge (the harness of demo-and-ui.test.ts). */
async function openUi(base: string, hash = ''): Promise<Page> {
  const errors: string[] = [];
  const vc = new VirtualConsole();
  vc.on('jsdomError', (e: Error) => errors.push(`jsdomError: ${e.message}`));
  vc.on('error', (...a: unknown[]) => errors.push(`console.error: ${a.map(String).join(' ')}`));
  const dom = new JSDOM(await (await fetch(`${base}/ui`)).text(), { url: `${base}/ui${hash}`, runScripts: 'outside-only', pretendToBeVisual: true, virtualConsole: vc });
  const w = dom.window;
  const log: Page['log'] = [];
  w['fetch'] = async (input: unknown, init?: RequestInit): Promise<globalThis.Response> => {
    const url = new URL(String(input), w.location.href);
    const r = await fetch(url, init);
    log.push({ method: init?.method ?? 'GET', path: url.pathname, status: r.status });
    return r;
  };
  (w as unknown as { scrollTo: () => void }).scrollTo = () => undefined;
  (w as unknown as { print: () => void }).print = () => undefined;
  (w.URL as unknown as { createObjectURL: () => string }).createObjectURL = () => '#saved';
  (w.URL as unknown as { revokeObjectURL: () => void }).revokeObjectURL = () => undefined;
  w.eval(APP_JS);
  const d = w.document;
  return {
    window: w, doc: d, log, errors,
    text: () => d.getElementById('app')?.textContent ?? '',
    visible: () => visibleText(d),
    click: (buttonText) => {
      const b = [...d.querySelectorAll('button')].find((x) => x.textContent === buttonText);
      if (!b) throw new Error(`no button "${buttonText}"`);
      b.click();
    },
    fill: (sel, value) => {
      const el = d.querySelector(sel) as HTMLInputElement | null;
      if (!el) throw new Error(`no ${sel}`);
      el.value = value;
      el.dispatchEvent(new w.Event('input', { bubbles: true }));
    },
    select: (sel, value) => {
      const el = d.querySelector(sel) as HTMLSelectElement | null;
      if (!el) throw new Error(`no ${sel}`);
      el.value = value;
      el.dispatchEvent(new w.Event('change', { bubbles: true }));
    },
    async until<T>(fn: () => T | null | undefined | false, what: string, ms = 30_000): Promise<T> {
      const t0 = Date.now();
      for (;;) {
        const v = fn();
        if (v) return v;
        if (Date.now() - t0 > ms) throw new Error(`the page never showed ${what}; it shows: ${(d.getElementById('app')?.textContent ?? '').slice(0, 600)}`);
        await new Promise((r) => setTimeout(r, 25));
      }
    },
  };
}

describe('work-redesign customer site', () => {
  it('answers a browser at / with the landing page and the UI headers, varying on Accept', async () => {
    const l = await production();
    const r = await fetch(`${l.base}/`, { headers: { accept: BROWSER } });
    expect(r.status).toBe(200);
    expect(r.headers.get('content-type')).toContain('text/html');
    expect(r.headers.get('content-security-policy')).toBe(UI_CSP);
    expect(r.headers.get('x-content-type-options')).toBe('nosniff');
    expect(r.headers.get('referrer-policy')).toBe('no-referrer');
    expect(r.headers.get('cache-control')).toBe('no-store');
    expect(r.headers.get('vary')).toContain('Accept');
    const body = await r.text();
    for (const s of ['Hand work to AI', 'with proof, not promises.', 'href="/ui"', 'href="#how-it-works"', 'id="how-it-works"', 'id="faq"', 'Built so anyone can check the work', 'When Work Redesign isn', `href="${SIBLING.url}"`, 'href="/ui/help"']) {
      expect(body, s).toContain(s);
    }
    expect(body).not.toContain('{{');
  });

  it('keeps the entry point for agents: JSON-LD for no Accept, */*, JSON-LD, JSON ranked at or above HTML and a weighted HTML ask; HMD for any list naming Markdown; ?format= always wins', async () => {
    const l = await production();
    for (const accept of [null, '*/*', 'application/ld+json', 'application/json', 'text/html;q=0.5, application/ld+json',
      'application/json, text/html;q=0.9', 'text/html, application/json', 'application/ld+json, text/html', 'text/html;q=0, */*', 'text/*']) {
      const r = await fetch(`${l.base}/`, accept === null ? {} : { headers: { accept } });
      expect([accept, r.status]).toEqual([accept, 200]);
      expect([accept, r.headers.get('content-type')]).toEqual([accept, expect.stringContaining('application/ld+json')]);
      const doc = await r.json() as Record<string, unknown>;
      expect([accept, JSON.stringify(doc['@type'])]).toEqual([accept, expect.stringContaining('hydra:EntryPoint')]);
      expect(doc).toHaveProperty('pod');
      expect(doc).toHaveProperty('affordances');
    }
    const md = await fetch(`${l.base}/`, { headers: { accept: 'text/markdown' } });
    expect(md.headers.get('content-type')).toContain('text/markdown');
    expect(md.headers.get('link')).toContain('hmd');
    expect(md.headers.get('vary')).toContain('Accept');
    // A program that lists Markdown beside HTML, in either order, keeps the HMD it got before the landing page existed.
    for (const accept of ['text/html, text/markdown', 'text/markdown;q=0.5, text/html', 'text/html;q=0.9, text/markdown;q=0.8, */*;q=0.1']) {
      const r = await fetch(`${l.base}/`, { headers: { accept } });
      expect([accept, r.headers.get('content-type')]).toEqual([accept, expect.stringContaining('text/markdown')]);
    }
    // Every major browser's own Accept gets the landing page.
    for (const accept of [BROWSER, 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8', 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8,application/signed-exchange;v=b3;q=0.7']) {
      const r = await fetch(`${l.base}/`, { headers: { accept } });
      expect([accept, r.headers.get('content-type')]).toEqual([accept, expect.stringContaining('text/html')]);
    }
    const forcedMd = await fetch(`${l.base}/?format=markdown`, { headers: { accept: BROWSER } });
    expect(forcedMd.headers.get('content-type')).toContain('text/markdown');
    const forcedLd = await fetch(`${l.base}/?format=jsonld`, { headers: { accept: BROWSER } });
    expect(forcedLd.headers.get('content-type')).toContain('application/ld+json');
  });

  it('promises no walkthrough when no contact is set, and says what this server does with record contents', async () => {
    const page = async (o: { readonly landing?: LandingOptions } = {}): Promise<{ landing: string; help: string }> => {
      const l = await production(o);
      return { landing: await (await fetch(`${l.base}/`, { headers: { accept: BROWSER } })).text(), help: await (await fetch(`${l.base}/ui/help`)).text() };
    };
    // No contact named: no walkthrough is promised, the closing band offers the guide, and the guide's contact section links to making an account.
    const plain = await page();
    expect(plain.landing).not.toMatch(/walk you through|talk to us/i);
    expect(plain.landing).toContain('<a class="btn btn--secondary btn--lg" href="/ui/help">Read the guide</a>');
    expect(plain.landing).toContain('Ask the person who sent you this link, or your Interego contact, for a quote.');
    expect(plain.help).toContain(`create your Interego account</a> now`);
    expect(plain.help).toContain(`href="${INTEREGO_DEFAULTS.identityUrl}"`);
    // A contact named: the walkthrough and the Contact us button come back, pointing at it.
    const named = await page({ landing: { contactHref: 'https://example.org/book' } });
    expect(named.landing).toContain('<a class="btn btn--secondary btn--lg" href="https://example.org/book">Contact us</a>');
    expect(named.landing).toContain('we’ll walk you through it');
    expect(named.help).toContain('<a href="https://example.org/book">Contact us</a>');
    // An operator's mailto: (bridge/server.ts takes one only through the shared contactHrefOf) goes on the
    // same links; the address is inside their href only, never in the text a person reads.
    const mailto = 'mailto:operator@example.org';
    const mailed = await page({ landing: { contactHref: mailto } });
    expect(mailed.landing).toContain(`<a class="btn btn--secondary btn--lg" href="${mailto}">Contact us</a>`);
    expect(mailed.landing).toContain('we’ll walk you through it');
    expect(mailed.help).toContain(`<a href="${mailto}">Contact us</a>`);
    for (const html of [mailed.landing, mailed.help]) {
      expect(html.split(`href="${mailto}"`).length - 1).toBeGreaterThan(0);
      expect(html.replace(/<[^>]*>/g, ' ')).not.toMatch(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[a-z]{2,}/);
    }
    // Encryption: untold, only what a workspace with a record key gets; told, what this server does. Never "every record".
    for (const html of [plain.landing, plain.help]) expect(html).toContain('Record contents are encrypted in storage when your workspace has a record key (our hosted service always does).');
    expect((await page({ landing: { recordsSealed: true } })).landing).toContain('Record contents are encrypted in storage on this workspace.');
    expect((await page({ landing: { recordsSealed: false } })).landing).toContain('This server has no record key, so the records it writes are stored unencrypted.');
    for (const html of [plain.landing, plain.help, named.landing]) {
      expect(html).not.toContain('The content of every record is encrypted');
      expect(html).toContain('who signed it and in what role, when, and how records link to each other');
      expect(html).not.toMatch(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[a-z]{2,}/);
    }
  });

  it('tells a visitor how to use Claude or ChatGPT: the workspace address in the set-up, the app\'s panel, what the assistant\'s provider sees, the honest limit, the one chat document limit the app enforces, and that /mcp is not the connector', async () => {
    const l = await production({ signIn: trusted() });
    const landing = await (await fetch(`${l.base}/`, { headers: { accept: BROWSER } })).text();
    const help = await (await fetch(`${l.base}/ui/help`)).text();
    // The limit the app enforces (app.js CHAT_DOC_MAX) is the one every page and the README state.
    const max = Number(/^const CHAT_DOC_MAX = (\d+);$/m.exec(APP_JS)?.[1]);
    expect(max).toBe(20_000);
    const limit = `${max.toLocaleString('en-US')} characters`;
    for (const [page, html] of [['landing', landing], ['help', help]] as const) {
      for (const s of [
        'this workspace’s address: <code class="connector-url">http://127.0.0.1</code>', '<strong>Use your AI assistant</strong> copies it',
        'In Claude, turn on Interego in each new chat from the chat’s tools menu (+). In ChatGPT, type @ in a chat and choose Interego.', 'the company behind your assistant sees it too', limit,
        // ChatGPT's set-up in the order OpenAI's guide to custom MCP servers gives it, and no plan named: the first step only
        // opens Add custom MCP server; the second names it, gives the address as its Server URL with OAuth, and only then
        // has the warning accepted and the plugin created and installed. Claude's half of each step is as it was.
        '<p class="step__text">In Claude, open <strong>Settings → Connectors → Add custom connector</strong>. In ChatGPT on the web, open <strong>Plugins → + → Add custom MCP server</strong>.</p>',
        '<p class="step__text">Name it <strong>Interego</strong> and paste the connector address (in ChatGPT, as its Server URL, with OAuth): <code class="connector-url">https://relay.example.org/mcp</code> In ChatGPT, accept the warning, select <strong>Create as a plugin</strong>, then install it.</p>',
        'Whether you can add a connector depends on your plan or workspace settings.',
        '<span class="mono">http://127.0.0.1/mcp</span>&nbsp;(for developers’ tools that sign their own requests; Claude and ChatGPT use the Interego connector)',
        // One sentence for signing in to the connector, the same as the app's panel says it.
        'Connect, and when it asks, sign in with the same Interego account you use for Work Redesign.',
        // Drafting a map from a chat starts from the message Map a process copies (it carries the document and its limit), not a bare ask.
        'Here’s the message from Map a process in Work Redesign. Draft the map, and record it once I’ve checked it.',
      ]) expect([page, html], s).toEqual([page, expect.stringContaining(s)]);
      // Nowhere does creating the plugin come before the address it needs.
      expect([page, html.includes('create it as a plugin')]).toEqual([page, false]);
      expect([page, html.includes('(MCP endpoint)'), html.includes('{{'), html.includes('passkey when asked'), html.includes('Draft a process map from this procedure document')]).toEqual([page, false, false, false, false]);
      expect([page, html.includes('isn’t set up for connecting Claude or ChatGPT')]).toEqual([page, false]);
      expect([page, html.match(PLAN_CLAIM)?.[0] ?? null, html.includes('Settings → Connectors → Add</strong>')]).toEqual([page, null, false]);
      // Where the connector works, the pages say what to add, what to ask and what stays in the app.
      for (const s of ['Add the Interego connector', 'Things you can ask it', 'What stays in the Work Redesign app', 'Use it from Claude or ChatGPT</a>']) {
        expect([page, s, html.includes(s)]).toEqual([page, s, true]);
      }
    }
    expect(landing).toContain('<div class="container grid-2 assistants">');
    expect(landing).toContain('Work where you already work: in Claude or ChatGPT');
    expect(help).toContain('Optional: connect Claude or ChatGPT');
    expect(help).toContain('<strong>In Claude or ChatGPT</strong>, with the Interego connector: press <strong>Copy the message for my assistant</strong>');
    expect(APP_JS).toContain('\'Connect, and when it asks, sign in with the same Interego account you use for Work Redesign.\'');
    // The guide's note after the steps is spaced from them as the landing page's is.
    expect(help).toContain('</ol>\n        <p class="assistants__note">In Claude, turn on Interego');
    // The guide says what ChatGPT asks before a write and how to pick up new tools, and links OpenAI's guide as its other outside links open.
    expect(help).toContain('ChatGPT asks before each write unless you let it remember your choice for that chat. If Interego’s tools look out of date, refresh it from its page in your app settings. More in <a href="https://developers.openai.com/api/docs/guides/custom-mcp-server" target="_blank" rel="noopener">OpenAI’s guide to custom MCP servers</a>.');
    const readmeText = readFileSync(new URL('../README.md', import.meta.url), 'utf8');
    expect(readmeText).toContain('Plugins, +, Add custom MCP server');
    expect(readmeText.match(PLAN_CLAIM)?.[0] ?? null).toBeNull();
    expect(relayCalls).toEqual([]);
    expect(landing).toContain('<h3 class="feature__title">Teams without an AI assistant</h3>');
    expect(landing).toContain('Three things to know.');
    // Where the connector works, the navigation names the apps, and the FAQ, the data section and the footers say what it passes.
    for (const s of ['<a href="#assistants">Claude &amp; ChatGPT</a>', '<a class="menu__item" href="#assistants">Claude &amp; ChatGPT</a>', 'The same account connects Claude or ChatGPT.',
      'Third, if you connect Claude or ChatGPT, the Interego connector passes everything your assistant reads and writes here']) expect(landing, s).toContain(s);
    for (const s of ['<li><a href="#assistants">Claude or ChatGPT</a></li>', '<h2 id="assistants-title">Using Claude or ChatGPT</h2>',
      'If you connect Claude or ChatGPT, the Interego connector passes everything your assistant reads and writes here']) expect(help, s).toContain(s);
    expect(help).toContain('<dt>Message for your AI</dt>');
    expect(help).toContain('Someone added only by wallet address can’t work from Claude or ChatGPT');
    // Recording a map from a chat, and its limit, where a connector is named.
    expect(landing).toContain('Your document’s text is stored with the record only if you choose to store it, or if you record the map from a chat assistant. Recording a map from a chat works for documents up to 20,000 characters; a longer one goes by copy and paste.</p>');
    expect(help).toContain('<li>Recording a process map from a chat works for documents up to 20,000 characters; a longer one goes by copy and paste.</li>');
    expect(help).not.toContain('Get instructions for your AI');
    const readme = readFileSync(new URL('../README.md', import.meta.url), 'utf8');
    expect(readme).toContain('`CHAT_DOC_MAX`');
    expect(readme).toContain(limit);
  });

  it('walks no one through adding a connector that could never act here: with no sign-in, or no relay trusted, the pages say the workspace is not set up and offer copy and paste, as the app\'s panel does', async () => {
    for (const [what, o] of [['no sign-in', {}], ['no relay trusted', { signIn: trusted('none') }]] as const) {
      const l = await production(o);
      expect([what, (await (await fetch(`${l.base}/ui`)).text()).includes('wrd-connector')]).toEqual([what, false]);
      for (const path of ['/', '/ui/help']) {
        const html = await (await fetch(`${l.base}${path}`, { headers: { accept: BROWSER } })).text();
        const at = [what, path];
        for (const s of ['This workspace isn’t set up for connecting Claude or ChatGPT yet. Ask your workspace provider.', 'You can still draft a process map with copy and paste, in any chat app:',
          'the company behind your assistant sees it too',
          // What the app's panel says where the chat route is not offered (CHAT_LEDE_OFF), and what pasting a document shares.
          'Work Redesign runs no AI of its own and never asks for an API key. Your own AI assistant does any drafting, on your own subscription, and Work Redesign checks everything it records.',
          'When you paste a document into your AI assistant, the company behind your assistant sees it too']) expect([...at, html], s).toEqual([...at, expect.stringContaining(s)]);
        // No set-up steps, no connector address (the relay's, or the default one), and no promise of the app's set-up panel.
        for (const s of ['class="steps steps--compact"', 'connector-url', '/mcp</code>', `${INTEREGO_DEFAULTS.relayUrl}/mcp`, 'https://relay.example.org/mcp', 'copies it, with everything else', 'It shows the connector address']) {
          expect([...at, s, html.includes(s)]).toEqual([...at, s, false]);
        }
        // Nor anything that assumes the connector is there: adding it, asking it, what it may do, the chat route under Map a
        // process, or a heading that repeats the sentence saying it isn't set up.
        for (const s of ['Add the Interego connector', 'Things you can ask it', 'What stays in the Work Redesign app', 'Here’s the message from Map a process',
          'Optional: connect Claude or ChatGPT', 'Copy the message for my assistant', 'Work where you already work', 'Use it from Claude or ChatGPT',
          'Claude or ChatGPT with the Interego connector', 'Not set up on this workspace yet', 'Set up in two minutes',
          // Nor in the navigation, the FAQ, the data section or the footers (the nav and the guide's heading named the apps as if
          // they worked here; the FAQ, data and footer sentences assumed the connector).
          'Claude &amp; ChatGPT', 'Claude or ChatGPT</a>', 'Using Claude or ChatGPT', 'connects Claude or ChatGPT', 'connect Claude or ChatGPT,',
          'Claude and ChatGPT use the Interego connector', 'can’t work from Claude or ChatGPT',
          // Nor recording a map from a chat, or the length a chat can record (the FAQ and the guide's limits said both, next to
          // the sentence saying the connector isn't set up).
          'from a chat', 'from chat', '20,000 characters']) {
          expect([...at, s, html.includes(s)]).toEqual([...at, s, false]);
        }
        expect([...at, html.includes('{{')]).toEqual([...at, false]);
        // What they say instead: the section's own name in the navigation, and the developers' endpoint with no connector clause.
        for (const s of ['<a href="#assistants">Your own AI assistant</a>', '<span class="mono">http://127.0.0.1/mcp</span>&nbsp;(for developers’ tools that sign their own requests)</li>']) {
          expect([...at, s, html.includes(s)]).toEqual([...at, s, true]);
        }
        // Claude and ChatGPT are named once, in the sentence that says the workspace isn't set up for them.
        const words = html.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ');
        expect([...at, words.split('This workspace isn’t set up for connecting Claude or ChatGPT yet.').length - 1]).toEqual([...at, 1]);
        const rest = words.replace('This workspace isn’t set up for connecting Claude or ChatGPT yet.', ' ');
        expect([...at, [...rest.matchAll(/Claude|ChatGPT/g)].map((m) => rest.slice(Math.max(0, (m.index ?? 0) - 60), (m.index ?? 0) + 40))]).toEqual([...at, []]);
      }
      const notReady = { landing: await (await fetch(`${l.base}/`, { headers: { accept: BROWSER } })).text(), help: await (await fetch(`${l.base}/ui/help`)).text() };
      for (const s of ['<a class="menu__item" href="#assistants">Your own AI assistant</a>', 'Three things to know.',
        'If you want help drafting a process map, it gives you instructions to pass to your own AI assistant, which then works under your own agreement with that provider. Work Redesign checks every quote the draft relies on against your document. Your document’s text is stored with the record only if you choose to store it.</p>',
        'Third, when you paste a document into your AI assistant, the company behind your assistant sees it too.</p>']) expect([what, notReady.landing], s).toEqual([what, expect.stringContaining(s)]);
      for (const s of ['<h2 id="assistants-title">Using your own AI assistant</h2>',
        'Use separate workspaces for teams that must not see each other’s records. When you paste a document into your AI assistant, the company behind your assistant sees it too.</p>']) expect([what, notReady.help], s).toEqual([what, expect.stringContaining(s)]);
      // The guide's limits go straight from the plain-text one to the next, with no chat limit between them.
      expect([what, notReady.help.replace(/\s+/g, ' ')]).toEqual([what, expect.stringContaining('<li>Procedure documents are read as plain text or Markdown only.</li> <li>Results are entered by people, not measured automatically.</li>')]);
      // One column: the examples card is gone, so the text does not sit in half of a two-column grid.
      const landing = await (await fetch(`${l.base}/`, { headers: { accept: BROWSER } })).text();
      expect([what, landing.includes('<div class="container assistants">'), landing.includes('<div class="prose-wide">')]).toEqual([what, true, true]);
    }
    expect(relayCalls).toEqual([]);
  });

  it('writes no action straight before a punctuation mark in the app\'s own text, where it would read as part of the action\'s name', () => {
    // The texts a person copies are built from these strings (the DOM tests check each copied text as copied, too). A string's
    // quote ends a URN here, as a space or a line's end does in the copied text. The app's own file: the shared chat helpers
    // served before it hold code about URNs (/^urn:/), not text naming one.
    const own = readFileSync(new URL('../bridge/ui/app.js', import.meta.url), 'utf8');
    expect(APP_JS.endsWith(own)).toBe(true);
    expect(own).toContain('urn:iep:action:wrd:');
    expect(urnsRunningIntoPunctuation(own)).toEqual([]);
    // The check itself: the wordings this replaced are caught.
    expect(urnsRunningIntoPunctuation('Leave out urn:iep:action:wrd:envelope-template, urn:iep:action:wrd:list-records and urn:iep:action:wrd:calibration: act passes them no arguments.'))
      .toEqual(['urn:iep:action:wrd:envelope-template,', 'urn:iep:action:wrd:calibration:']);
    expect(urnsRunningIntoPunctuation('fields from urn:iep:action:wrd:read-envelope-template.')).toEqual(['urn:iep:action:wrd:read-envelope-template.']);
    expect(urnsRunningIntoPunctuation('action_iri: "urn:iep:action:wrd:read-records"\n  - instead of urn:a:b use urn:a:c\nurn:a:d')).toEqual([]);
  });

  it('fills a page\'s sections from one flag: {{#name}} where it is set, {{^name}} where it is not; an unknown, nested or unclosed section fails the boot', () => {
    const page = '<p>{{#chat_ready}}set up: {{connector_url}}{{/chat_ready}}{{^chat_ready}}not set up{{/chat_ready}}</p>';
    expect(renderSitePage(page, { chat_ready: 'yes', connector_url: 'https://relay.example.org/mcp' })).toBe('<p>set up: https://relay.example.org/mcp</p>');
    expect(renderSitePage(page, { chat_ready: '', connector_url: '' })).toBe('<p>not set up</p>');
    expect(() => renderSitePage('{{#nothing}}x{{/nothing}}', {})).toThrow(/unknown section/);
    expect(() => renderSitePage('{{#a}}{{^a}}x{{/a}}{{/a}}', { a: 'yes' })).toThrow();
    expect(() => renderSitePage('{{#a}}x', { a: 'yes' })).toThrow();
    // The flag is set exactly where the shell names a connector.
    for (const [signIn, ready] of [[undefined, ''], [trusted('none'), ''], [trusted(), 'yes'], [{ ...trusted(), relayUrl: '' }, '']] as const) {
      const v = siteValues({ base: 'http://127.0.0.1', ...(signIn ? { signIn } : {}) });
      expect([v['chat_ready'], v['connector_url']]).toEqual([ready, connectorUrlOf(signIn) ?? '']);
    }
  });

  it('keeps the landing page and the guide inside a phone\'s screen with the production address in the set-up: each address sits in a step that may shrink, and wraps instead of widening the list', async () => {
    expect(PRODUCTION_LENGTH_BASE).toHaveLength(44);
    const l = await production({ base: PRODUCTION_LENGTH_BASE, signIn: trusted() });
    const css = await (await fetch(`${l.base}/ui/app.css`)).text();
    expect(css.startsWith(designSystemCss())).toBe(true);
    for (const path of ['/', '/ui/help']) {
      const html = await (await fetch(`${l.base}${path}`, { headers: { accept: BROWSER } })).text();
      // jsdom lays nothing out, so the rules that keep it inside the screen are checked as the page would apply them:
      // the page with its own stylesheet, and each address's computed style. Real Chromium at 390 px is the check the QA runs.
      const dom = new JSDOM(html, { url: `${PRODUCTION_LENGTH_BASE}${path}` });
      const d = dom.window.document;
      expect([path, d.querySelectorAll('link[rel="stylesheet"][href="/ui/app.css"]').length]).toEqual([path, 1]);
      const style = d.createElement('style');
      style.textContent = css;
      d.head.append(style);
      const codes = [...d.querySelectorAll('#assistants code.connector-url')] as HTMLElement[];
      expect([path, codes.map((c) => c.textContent)]).toEqual([path, ['https://relay.example.org/mcp', PRODUCTION_LENGTH_BASE]]);
      for (const code of codes) {
        const li = code.closest('li');
        // Inside a step of the compact list, in its text: the step is a grid item whose automatic minimum would be the address's width.
        expect([path, li?.className, li?.parentElement?.className, code.parentElement?.className]).toEqual([path, 'step', 'steps steps--compact', 'step__text']);
        expect([path, dom.window.getComputedStyle(li!.parentElement!).display]).toEqual([path, 'grid']);
        expect([path, dom.window.getComputedStyle(li!).minWidth]).toEqual([path, '0']);
        const cs = dom.window.getComputedStyle(code);
        expect([path, code.textContent, cs.maxWidth, cs.whiteSpace, cs.overflowWrap]).toEqual([path, code.textContent, '100%', 'normal', 'anywhere']);
        // On a line of its own, filling it before going on to the next (so a break never lands at a hyphen by preference,
        // to read as a word split for the line), with no full stop or word of the sentence hanging off it.
        expect([path, code.textContent, cs.display, cs.wordBreak]).toEqual([path, code.textContent, 'block', 'break-all']);
        const after = code.nextSibling?.textContent ?? '';
        expect([path, code.textContent, /^\s*[.,;:]/.test(after)]).toEqual([path, code.textContent, false]);
      }
      expect([path, html.includes('</code>. In the app')]).toEqual([path, false]);
      expect([path, codes[1]?.nextSibling?.textContent?.trim().startsWith('In the app,')]).toEqual([path, true]);
      dom.window.close();
    }
    expect(relayCalls).toEqual([]);
  });

  it('offers only copy and paste where a chat assistant cannot act: the demo names no connector, its panel says why, and a map from a document shows no chat route, all in plain words', async () => {
    const l = await minimalDemo();
    expect(await (await fetch(`${l.base}/ui`)).text()).not.toContain('wrd-connector');
    const page = await openUi(l.base);
    await page.until(() => page.text().includes('Match invoices'), 'the demo');
    // A process lead's Home offers no "Connect Claude or ChatGPT" step where it cannot work.
    expect(page.text()).not.toContain('Connect Claude or ChatGPT');
    page.click('Use your AI assistant');
    // The panel is named as every way into it is.
    await page.until(() => page.doc.getElementById('panel-title')?.textContent === 'Use your AI assistant', 'the panel');
    const seen = page.visible();
    for (const s of ['Work Redesign runs no AI of its own and never asks for an API key', 'The demo has no Interego sign-in, so Claude and ChatGPT can\'t work in it.',
      'You can still draft a process map with copy and paste, in any chat app: choose From a procedure document, then Copy and paste.']) expect(seen, s).toContain(s);
    // It doesn't ask to connect once just above "can't work here", and gives no reason (a plan's) that isn't the reason here.
    for (const s of ['Set it up once', 'Connect Claude or ChatGPT once', 'Some Claude and ChatGPT plans can\'t add connectors.']) expect(seen, s).not.toContain(s);
    expect(page.doc.querySelector('.chat-panel input, .chat-panel textarea')).toBeNull();
    expect(jargonIn(seen)).toEqual([]);
    const route = must([...page.doc.querySelectorAll('.chat-panel button')].find((b) => b.textContent === 'Draft a map with copy and paste'), 'the copy-and-paste route') as HTMLButtonElement;
    route.focus();
    route.click();
    await page.until(() => page.text().includes('Have your AI draft the map'), 'the document route');
    // The button pressed went with the panel: focus is on Map a process's heading, not left on the page's body.
    const at = page.doc.activeElement;
    expect([at?.tagName, at?.className, at?.textContent, page.doc.getElementById('panel-title')]).toEqual(['H1', 'page-title', 'Map a process', null]);
    expect(page.doc.querySelector('.route-card--chat')).toBeNull();
    expect(page.text()).toContain('Copy the message for my AI');
    expect(jargonIn(page.visible())).toEqual([]);
    expect(ALLOWED).toEqual([]);
    expect(page.errors).toEqual([]);
  }, 60_000);

  it('serves the guide and the favicon with the UI headers', async () => {
    const l = await production();
    const help = await fetch(`${l.base}/ui/help`);
    expect(help.status).toBe(200);
    expect(help.headers.get('content-type')).toContain('text/html');
    expect(help.headers.get('content-security-policy')).toBe(UI_CSP);
    const body = await help.text();
    expect(body).toContain('How to use Work Redesign');
    expect(body).toContain('id="glossary"');
    expect(body).not.toContain('{{');
    const icon = await fetch(`${l.base}/ui/favicon.svg`);
    expect(icon.status).toBe(200);
    expect(icon.headers.get('content-type')).toContain('image/svg+xml');
    expect(icon.headers.get('content-security-policy')).toBe(UI_CSP);
    expect((await icon.text()).startsWith('<svg')).toBe(true);
  });

  it('serves no page with an inline script, an inline style or an event handler; every script and stylesheet is its own, and every link leaving it goes somewhere named', async () => {
    const l = await production();
    const external = new Set([SIBLING.url, INTEREGO_DEFAULTS.identityUrl, `${new URL(INTEREGO_DEFAULTS.relayUrl).origin}/.well-known/security.txt`]);
    // The app's pages load the app; the landing page and the guide load only site.js (their menu closes once a link is chosen).
    const pages: Array<readonly [string, string]> = [['/', '/ui/site.js'], ['/ui', '/ui/app.js'], ['/ui/oauth/callback', '/ui/app.js'], ['/ui/help', '/ui/site.js']];
    for (const [path, script] of pages) {
      const html = await (await fetch(`${l.base}${path}`, { headers: { accept: BROWSER } })).text();
      expect([path, /<style/i.test(html)]).toEqual([path, false]);
      expect([path, /\sstyle=/i.test(html)]).toEqual([path, false]);
      expect([path, /\son[a-z]+=/i.test(html)]).toEqual([path, false]);
      expect([path, /javascript:/i.test(html)]).toEqual([path, false]);
      const tags = html.match(/<script[^>]*>[\s\S]*?<\/script>/gi) ?? [];
      expect([path, html.match(/<script/gi)?.length ?? 0]).toEqual([path, 1]);
      for (const t of tags) expect([path, t]).toEqual([path, `<script type="module" src="${script}"></script>`]);
      for (const link of html.match(/<link rel="stylesheet"[^>]*>/gi) ?? []) expect([path, link]).toEqual([path, expect.stringContaining('href="/ui/app.css"')]);
      // Everything the page loads comes from this bridge.
      const loads = [...html.matchAll(/\ssrc="([^"]*)"/gi), ...html.matchAll(/<link[^>]*\shref="([^"]*)"/gi)].map((m) => m[1] ?? '');
      for (const u of loads) expect([path, u.startsWith('/') || u.startsWith('http://127.0.0.1/') || u.startsWith('http://127.0.0.1:')]).toEqual([path, true]);
      // Every link to another site is the sibling product, the identity server or the security contact.
      const outbound = [...html.matchAll(/<a[^>]*\shref="([^"]*)"/gi)].map((m) => (m[1] ?? '').replace(/&amp;/g, '&')).filter((u) => /^[a-z][a-z0-9+.-]*:/i.test(u) && !u.startsWith('http://127.0.0.1'));
      for (const u of outbound) expect([path, u, external.has(u) || u.startsWith('mailto:')]).toEqual([path, u, true]);
    }
  });

  it('refuses (421) a rebound Host on the landing page, the guide and the favicon', async () => {
    const allowed: string[] = [];
    const l = await listenLoopback(createVerticalBridge({
      verticalName: 'work-redesign', affordances: wrdAffordances, deploymentUrl: 'http://127.0.0.1',
      handlers: createWrdHandlers({ defaultPodUrl: DEMO_POD }),
      middleware: (a) => {
        a.use((req: Request, res: Response, next: NextFunction) => hostAllowlistGuard(allowed)(req, res, next));
        attachUi(a, { base: 'http://127.0.0.1' });
      },
    }));
    listeners.push(l);
    allowed.push(...servedHostNames(l.port, 'http://127.0.0.1'));
    for (const path of ['/', '/ui/help', '/ui/favicon.svg']) {
      const r = await hostRequest(l.port, path, `rebind.attacker.example:${l.port}`);
      expect([path, r.status]).toEqual([path, 421]);
      expect(r.body['kind']).toBe('refusal');
      expect((await hostRequest(l.port, path, `127.0.0.1:${l.port}`)).status).toBe(200);
    }
  });

  it('ships one stylesheet: the design system and this product\'s rules, with print and dark mode, and nothing it would fetch', async () => {
    const l = await production();
    const css = await (await fetch(`${l.base}/ui/app.css`)).text();
    for (const s of ['.product-wrd', '@media print', 'prefers-color-scheme: dark', '.health__item--danger', '.side-nav__link[data-count]::after']) expect(css, s).toContain(s);
    // The rules, not the comments (which say there is no @import and no url()).
    const rules = css.replace(/\/\*[\s\S]*?\*\//g, '');
    expect(rules).not.toContain('@import');
    expect(rules).not.toContain('url(');
  });

  it('keeps the site pages\' header inside the screen below a wide one: the section links sit in the header from 64em, and below it in the menu, which holds every one of them', async () => {
    // From 48em the header's section links, the product switch and Sign in ran past the screen's edge up to 910 px (930 where
    // the connector isn't named, its link reading "Your own AI assistant"). jsdom applies no media query, so the rules are
    // read as written; real Chromium from 300 to 1400 px is the QA's check.
    for (const [what, o] of [['connector named', { signIn: trusted() }], ['not set up', {}]] as const) {
      const l = await production(o);
      const rules = (await (await fetch(`${l.base}/ui/app.css`)).text()).replace(/\/\*[\s\S]*?\*\//g, '');
      for (const s of ['@media (max-width: 63.99em) { .top-nav { display: none; } }', '@media (min-width: 64em) { .site-menu-button { display: none; } }']) expect([what, rules], s).toEqual([what, expect.stringContaining(s)]);
      expect([what, rules.includes('@media (min-width: 48em) { .site-menu-button { display: none; } }')]).toEqual([what, false]);
      for (const path of ['/', '/ui/help']) {
        const d = new JSDOM(await (await fetch(`${l.base}${path}`, { headers: { accept: BROWSER } })).text()).window.document;
        const links = (sel: string): string[] => [...d.querySelectorAll(`${sel} a`)].map((a) => `${a.getAttribute('href')} ${a.textContent}`);
        const nav = links('.top-nav');
        expect([what, path, nav.length]).toEqual([what, path, 4]);
        expect([what, path, nav.filter((x) => !links('#site-menu').includes(x))]).toEqual([what, path, []]);
        expect([what, path, d.querySelector('.site-menu-button')?.getAttribute('popovertarget')]).toEqual([what, path, 'site-menu']);
      }
    }
  });

  it('closes the site pages\' menu once one of its links is chosen, so it does not cover the section it went to; a link opened elsewhere, or one outside it, leaves it as it is', async () => {
    const l = await production({ signIn: trusted() });
    const served = await fetch(`${l.base}/ui/site.js`);
    expect([served.status, served.headers.get('content-type'), served.headers.get('content-security-policy')]).toEqual([200, 'text/javascript; charset=utf-8', UI_CSP]);
    const siteJs = await served.text();
    for (const [path, section] of [['/', '#faq'], ['/ui/help', '#glossary']] as const) {
      const html = await (await fetch(`${l.base}${path}`, { headers: { accept: BROWSER } })).text();
      expect([path, html.includes('<script type="module" src="/ui/site.js"></script>')]).toEqual([path, true]);
      const errors: string[] = [];
      const vc = new VirtualConsole();
      vc.on('jsdomError', (e: Error) => errors.push(`jsdomError: ${e.message}`));
      const w = new JSDOM(html, { url: `${l.base}${path}`, runScripts: 'outside-only', virtualConsole: vc }).window;
      // jsdom has no popovers: the menu's hidePopover is noted instead.
      const hidden: string[] = [];
      (w.HTMLElement.prototype as unknown as { hidePopover: (this: HTMLElement) => void }).hidePopover = function (this: HTMLElement) { hidden.push(this.id); };
      w.eval(siteJs);
      const d = w.document;
      const inMenu = must(d.querySelector(`#site-menu a[href="${section}"]`), `the menu's ${section}`) as HTMLAnchorElement;
      const inHeader = must(d.querySelector(`.top-nav a[href="${section}"]`), `the header's ${section}`) as HTMLAnchorElement;
      const click = (a: Element, o: MouseEventInit = {}): void => { a.dispatchEvent(new w.MouseEvent('click', { bubbles: true, cancelable: true, button: 0, ...o })); };
      click(inMenu, { ctrlKey: true });
      click(inMenu, { button: 1 });
      click(inHeader);
      expect([path, hidden]).toEqual([path, []]);
      // A click, a tap, or Enter on the link (each a click with the main button).
      click(inMenu);
      expect([path, hidden, errors]).toEqual([path, ['site-menu'], []]);
    }
  });

  it('welcomes a signed-out visitor instead of showing an error, with the raw answer kept in Technical details', async () => {
    const l = await production();
    const page = await openUi(l.base);
    await page.until(() => page.text().includes('Welcome to Work Redesign'), 'the welcome');
    const seen = page.visible();
    for (const s of ['Welcome to Work Redesign', 'Here you can:', 'Signing in isn\'t set up on this workspace yet']) expect(seen, s).toContain(s);
    expect(seen).not.toMatch(/Refused|HTTP 40\d|WRD_|affordance|envelope|\bpod\b|EIP-191/);
    expect(page.text()).toContain('needs a signed read');
    expect(page.text()).toContain('No wallet: this browser has no EIP-191 wallet');
    expect(page.log.filter((r) => r.path.startsWith('/wrd/')).map((r) => `${r.method} ${r.path} ${r.status}`)).toEqual(['GET /wrd/list_records 401']);
    expect([...page.doc.querySelectorAll('#app h1')].map((x) => x.textContent)).toEqual(['Welcome to Work Redesign']);
    expect(page.errors).toEqual([]);
  });

  it('asks for no unsigned read a bridge that signs its reads would refuse, so a first visit logs no error', async () => {
    const l = await production({ reads: 'signed' });
    const shell = await (await fetch(`${l.base}/ui`)).text();
    expect(shell).toContain('<meta name="wrd-reads" content="signed">');
    const page = await openUi(l.base);
    await page.until(() => page.text().includes('Welcome to Work Redesign'), 'the welcome');
    expect(page.log.filter((r) => r.path.startsWith('/wrd/'))).toEqual([]);
    expect(page.text()).toContain('This bridge answers signed reads only');
    expect(page.visible()).not.toMatch(/Refused|HTTP 40\d|WRD_/);
    expect(page.errors).toEqual([]);
    // A bridge that opened its reads still answers the unsigned read.
    const open = await openUi((await production({ reads: 'public' })).base);
    await open.until(() => open.log.some((r) => r.path === '/wrd/list_records'), 'the unsigned read');
  });

  it('tells a signed-out visitor who followed a task link that the task opens after sign-in', async () => {
    const l = await production();
    const page = await openUi(l.base, '#task=urn%3Awrd%3Atask%3Ax');
    await page.until(() => page.text().includes('Welcome to Work Redesign'), 'the welcome');
    expect(page.visible()).toContain('You were sent a link to a task');
    expect(page.errors).toEqual([]);
  });

  it('shows none of the protocol\'s words on any populated view or the task page, and maps refusals to plain titles', async () => {
    const l = await minimalDemo();
    const page = await openUi(l.base);
    await page.until(() => page.doc.querySelector('nav.side-nav') && page.text().includes('Match invoices'), 'the demo');
    const views = ['Home', 'Processes', 'Map a process', 'Plans', 'Business case', 'Decisions', 'Track record', 'AI agents', 'People & roles', 'My record'];
    const nav = (label: string): HTMLButtonElement => {
      const b = [...page.doc.querySelectorAll('nav.side-nav button.side-nav__link')].find((x) => x.textContent === label);
      if (!b) throw new Error(`no nav button ${label}`);
      return b as HTMLButtonElement;
    };
    for (const label of views) {
      nav(label).click();
      await page.until(() => page.doc.querySelector(`nav.side-nav button.side-nav__link[aria-current="page"]`)?.textContent === label, `the ${label} view`);
      if (label === 'Track record') await page.until(() => !page.doc.querySelector('[aria-busy="true"]'), 'the track record');
      expect([label, jargonIn(page.visible())]).toEqual([label, []]);
    }
    nav('Processes').click();
    await page.until(() => page.text().includes('Match invoices'), 'the task row');
    page.click('Open');
    await page.until(() => page.doc.querySelector('#app h1')?.textContent === 'Match invoices', 'the task page');
    expect(['task page', jargonIn(page.visible())]).toEqual(['task page', []]);

    // The refusal mapping, on synthetic answers.
    const friendly = page.window.eval('friendly') as (r: unknown) => { title: string; body: string };
    const cases: Array<readonly [Record<string, unknown>, string]> = [
      [{ tool: 'wrd.list_records', status: 401, body: { error: 'Reading records through this bridge needs a signed read.' } }, 'Please sign in'],
      [{ tool: 'wrd.read_records', status: 403, body: { error: 'Only an admin or a key in this pod\'s registry can read its records.' } }, 'You haven\'t been added to this workspace yet'],
      [{ tool: 'Interego sign-in', status: 401, body: { error: 'x', code: 'interego-sign-in-expired' } }, 'Your sign-in has ended'],
      [{ tool: 'wrd.countersign_decision', status: 403, body: { error: 'A person whose work this decision changes cannot countersign it.' } }, 'Someone else needs to do this'],
      [{ tool: 'wrd.propose_allocation', status: 409, body: { error: 'Classify every task before proposing an allocation.' } }, 'Sort every task first'],
      [{ tool: 'wrd.record_task_map', status: 422, body: { error: 'None of the quoted spans appear in the document.' } }, 'We couldn\'t find the AI\'s quotes in your document'],
      [{ tool: 'wrd.classify_task', status: 400, body: { error: 'No evidence places this task in a regime.' } }, 'These answers don\'t fit a category yet'],
      [{ tool: 'wrd.ratify_task', status: 409, body: { error: 'This envelope was already used.' } }, 'Already done'],
      [{ tool: 'wrd.grant_autonomy', status: 409, body: { error: 'This agent has not earned a grant on this kind of task yet.' } }, 'Not earned yet'],
      [{ tool: 'wrd.holder_copy', status: 429, body: { error: 'Too many copies are being taken from this bridge right now; nothing was copied.', retryAfterSeconds: 30 } }, 'Busy right now'],
    ];
    for (const [r, title] of cases) expect([r['tool'], friendly(r).title]).toEqual([r['tool'], title]);
    expect(friendly(cases[9]![0]).body).toContain('30 seconds');
    const fallback = friendly({ tool: 'wrd.x', status: 418, body: { error: '?' } }).title;
    expect(typeof fallback === 'string' && fallback.length > 0).toBe(true);
    expect(page.errors).toEqual([]);
  }, 120_000);

  it('shows a refusal as a plain sentence, with the raw answer in Technical details', async () => {
    const l = await minimalDemo();
    const page = await openUi(l.base);
    await page.until(() => page.text().includes('Match invoices'), 'the demo');
    page.click('Processes');
    await page.until(() => page.text().includes('Sort by predictability'), 'the task row');
    page.click('Sort by predictability');
    await page.until(() => page.text().includes('Sign the answers'), 'the sort panel');
    // Every answer left at "Unknown": no rule places the task, so the bridge refuses (400).
    page.click('Sign the answers');
    const seen = await page.until(() => page.visible().includes('These answers don\'t fit a category yet') && page.visible(), 'the refusal');
    expect(seen).not.toContain('Refused');
    expect(seen).not.toContain('HTTP 400');
    expect(page.text()).toContain('No evidence places this task in a regime.');
    expect([...page.doc.querySelectorAll('.result')].find((x) => x.textContent?.includes('These answers don\'t fit a category yet'))?.getAttribute('role')).toBe('alert');
    expect(page.errors).toEqual([]);
  }, 60_000);

  it('shows a person not yet added "One more step", keeps the raw refusal in Technical details, and still offers their record', async () => {
    const l = await minimalDemo();
    const page = await openUi(l.base);
    await page.until(() => page.text().includes('Match invoices'), 'the demo');
    page.select('#persona', 'zed');
    await page.until(() => page.visible().includes('You\'re signed in. One more step.'), 'the not-added screen');
    expect(page.visible()).not.toContain('HTTP 403');
    expect(page.text()).toContain('Only an admin or a key in this pod');
    expect(page.doc.querySelector('#persona')).not.toBeNull();
    expect([...page.doc.querySelectorAll('button')].some((b) => b.textContent === 'Download my record')).toBe(true);
    expect(page.errors).toEqual([]);
  }, 60_000);

  it('offers People & roles\' changes only to an admin, and removes someone only once the admin confirms', async () => {
    const l = await minimalDemo();
    const page = await openUi(l.base);
    await page.until(() => page.text().includes('Match invoices'), 'the demo');
    const buttons = (label: string): HTMLButtonElement[] => [...page.doc.querySelectorAll('main button')].filter((b) => b.textContent === label) as HTMLButtonElement[];
    page.click('People & roles');
    await page.until(() => page.text().includes('Types of task'), 'the roles view');
    // Ana leads the process but is no admin: no "Add a person", and every change is disabled with the reason.
    expect(buttons('Add a person')).toEqual([]);
    expect(buttons('Remove').length).toBeGreaterThan(0);
    for (const b of [...buttons('Remove'), ...buttons('Edit'), ...buttons('Retire'), ...buttons('Add type of task')]) expect([b.textContent, b.disabled]).toEqual([b.textContent, true]);
    expect(page.visible()).toContain('Only an admin can change people and roles.');
    // The admin: the changes are offered, and Remove asks first. Nothing is signed or sent until the danger button.
    page.select('#persona', 'admin');
    await page.until(() => buttons('Add a person').length === 1, 'the admin\'s roles view');
    const before = page.log.length;
    must(buttons('Remove')[0], 'a Remove button').click();
    await page.until(() => page.doc.getElementById('panel-title')?.textContent === 'Remove Ana?', 'the confirmation');
    expect(page.visible()).toContain('Ana loses their roles in this workspace. They keep the right to download their record');
    page.click('Cancel');
    await page.until(() => !page.doc.getElementById('panel-title'), 'the panel closed');
    expect(page.log.slice(before).filter((r) => r.method === 'POST')).toEqual([]);
    expect(page.errors).toEqual([]);
  }, 60_000);

  it('gives focus back to the very button that opened a panel, row by row; keeps a form open on Escape so nothing typed is lost; and closes "Exactly what you\'re signing" back to the form it was opened from, as it was', async () => {
    const l = await minimalDemo({ withBo: true });
    const page = await openUi(l.base);
    const d = page.doc;
    const w = page.window;
    await page.until(() => page.text().includes('Match invoices'), 'the demo');
    const panelTitle = (): string | null => d.getElementById('panel-title')?.textContent ?? null;
    const escape = (el: Element | null, what: string): boolean => {
      const e = new w.KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true });
      must(el, what).dispatchEvent(e);
      return e.defaultPrevented;
    };
    const type = (el: Element | null, value: string, what: string): void => {
      const f = must(el, what) as HTMLInputElement;
      f.value = value;
      f.dispatchEvent(new w.Event('input', { bubbles: true }));
    };
    // As a keyboard user opens a panel: the button has focus, then is pressed.
    const open = async (b: HTMLButtonElement, title: string): Promise<void> => { b.focus(); b.click(); await page.until(() => panelTitle() === title, title); };
    const closeByButton = async (): Promise<void> => { (must(d.querySelector('.panel button[aria-label="Close"]'), 'Close') as HTMLButtonElement).click(); };
    const rowOf = (el: Element | null): string | null => el?.closest('tr')?.querySelector('.table__primary')?.textContent ?? null;
    const rowButton = (row: string, label: string): HTMLButtonElement => {
      const tr = [...d.querySelectorAll('main tr')].find((x) => x.querySelector('.table__primary')?.textContent === row);
      return must([...(tr?.querySelectorAll('button') ?? [])].find((b) => b.textContent === label), `${row}'s ${label}`) as HTMLButtonElement;
    };
    const focused = (): [string | null | undefined, string | null] => [d.activeElement?.textContent, rowOf(d.activeElement)];

    page.select('#persona', 'admin');
    page.click('People & roles');
    await page.until(() => [...d.querySelectorAll('main button')].filter((b) => b.textContent === 'Edit' && !(b as HTMLButtonElement).disabled).length === 2, 'two people the admin can change');
    // Ana's row comes first, and Bo's buttons read the same as hers; each carries its own key (what it acts on, and how).
    expect([...d.querySelectorAll('main tr .table__primary')].slice(0, 2).map((x) => x.textContent)).toEqual(['Ana', 'Bo']);
    const keys = [...d.querySelectorAll('main [data-return]')].map((x) => x.getAttribute('data-return'));
    expect(keys.length).toBeGreaterThanOrEqual(4);
    expect(new Set(keys).size).toBe(keys.length);

    // A form (Bo's Edit): Escape in it does nothing, so what was typed stays; Close gives focus back to Bo's Edit, not Ana's.
    await open(rowButton('Bo', 'Edit'), 'Change Bo');
    const name = d.querySelector('.panel input.input');
    type(name, 'Bo Typed', 'the name field');
    expect(escape(name, 'the name field')).toBe(false);
    expect([panelTitle(), (d.querySelector('.panel input.input') as HTMLInputElement).value]).toEqual(['Change Bo', 'Bo Typed']);
    await closeByButton();
    await page.until(() => panelTitle() === null, 'the form closed');
    expect(focused()).toEqual(['Edit', 'Bo']);
    // A confirmation (Bo's Remove) holds nothing to type in: Escape closes it, as Cancel does, each back to Bo's Remove.
    await open(rowButton('Bo', 'Remove'), 'Remove Bo?');
    expect(escape(d.getElementById('panel-title'), 'the title')).toBe(true);
    await page.until(() => panelTitle() === null, 'the confirmation closed by Escape');
    expect(focused()).toEqual(['Remove', 'Bo']);
    await open(rowButton('Bo', 'Remove'), 'Remove Bo?');
    page.click('Cancel');
    await page.until(() => panelTitle() === null, 'the confirmation cancelled');
    expect(focused()).toEqual(['Remove', 'Bo']);
    // Where what opened a panel is gone, focus goes to the view's heading.
    (w.eval('refocus') as (to: unknown) => void)({ key: 'no such button', text: 'Edit', nth: -1 });
    expect([d.activeElement?.tagName, d.activeElement?.textContent]).toEqual(['H1', 'People & roles']);

    // A process lead sorts a task: Escape in the form keeps the answers; "Exactly what you're signing", opened from it, closes
    // back to it with the answers and the note as they were and focus on its button; the form closes back to the row's button.
    page.select('#persona', 'ana');
    page.click('Processes');
    await page.until(() => [...d.querySelectorAll('main button')].some((b) => b.textContent === 'Sort by predictability'), 'the task to sort');
    const sortTitle = 'Sort "Match invoices" by predictability';
    await open(must([...d.querySelectorAll('main button')].find((b) => b.textContent === 'Sort by predictability'), 'Sort by predictability') as HTMLButtonElement, sortTitle);
    const first = must(d.querySelector('.panel select'), 'the first question') as HTMLSelectElement;
    const answer = must([...first.options].map((o) => o.value).find((v) => v !== first.value), 'another answer');
    first.value = answer;
    first.dispatchEvent(new w.Event('change', { bubbles: true }));
    type(d.querySelector('.panel textarea'), 'Checked with the clerks.', 'the note');
    expect(escape(d.querySelector('.panel textarea'), 'the note')).toBe(false);
    expect(panelTitle()).toBe(sortTitle);
    // A redraw while the form is open (a refresh landing, say) leaves focus where it was, in the note.
    const noteBox = must(d.querySelector('.panel textarea'), 'the note') as HTMLTextAreaElement;
    noteBox.focus();
    (w.eval('render') as () => void)();
    expect([d.activeElement, noteBox.value]).toEqual([noteBox, 'Checked with the clerks.']);
    await open(must([...d.querySelectorAll('.panel button')].find((b) => b.textContent === 'See exactly what you\'re signing'), 'the signing preview button') as HTMLButtonElement, 'Exactly what you\'re signing');
    expect(escape(d.getElementById('panel-title'), 'the title')).toBe(true);
    await page.until(() => panelTitle() === sortTitle, 'the form again');
    expect([(d.querySelector('.panel select') as HTMLSelectElement).value, (d.querySelector('.panel textarea') as HTMLTextAreaElement).value]).toEqual([answer, 'Checked with the clerks.']);
    expect(d.activeElement?.textContent).toBe('See exactly what you\'re signing');
    await closeByButton();
    await page.until(() => panelTitle() === null, 'the form closed');
    expect([d.activeElement?.textContent, d.activeElement?.getAttribute('data-return')?.endsWith(' sort')]).toEqual(['Sort by predictability', true]);
    expect(page.errors).toEqual([]);
  }, 60_000);

  it('checks a process map before signing: nothing is sent, each missing field is named as the form labels it, and the bridge\'s own field refusals read the same way', async () => {
    const l = await minimalDemo();
    const page = await openUi(l.base);
    await page.until(() => page.text().includes('Match invoices'), 'the demo');
    page.click('Map a process');
    await page.until(() => page.doc.querySelector('[data-path="workflow.title"]'), 'the capture form');
    page.fill('[data-path="workflow.title"]', 'Supplier invoices');
    const before = page.log.length;
    page.click('Sign and record the process');
    await page.until(() => page.visible().includes('Please check the form'), 'the form check');
    expect(page.log.slice(before).filter((r) => r.path.startsWith('/wrd/'))).toEqual([]);
    const listed = [...page.doc.querySelectorAll('.result .field-errors button')].map((b) => b.textContent);
    expect(listed).toEqual(['Unit of work is required', 'Task 1: Task name is required', 'Task 1: Description is required', 'Task 1: choose the person who does it', 'Task 1: choose its type of task']);
    expect(page.doc.querySelector('[data-path="workflow.unitLabel"]')?.getAttribute('aria-invalid')).toBe('true');
    expect(page.doc.querySelector('[data-path="workflow.title"]')?.getAttribute('aria-invalid')).toBeNull();
    expect((page.doc.querySelector('[data-path="workflow.title"]') as HTMLInputElement).value).toBe('Supplier invoices');
    // The answer is the element in focus, so a person at the bottom of the form is taken to it.
    expect(page.doc.activeElement?.classList.contains('result')).toBe(true);
    // The bridge's refusal of a field reads as the form labels it, never as its payload path.
    const refusalField = page.window.eval('refusalField') as (b: unknown) => { path: string; message: string } | null;
    expect(refusalField({ 'iep:refusalReason': 'workflow.unitLabel is required text' })).toEqual({ path: 'workflow.unitLabel', message: 'Unit of work is required' });
    expect(refusalField({ 'iep:refusalReason': 'tasks[2].taskKind must be a registered task kind slug' })).toEqual({ path: 'tasks[2].taskKind', message: 'Task 3: Type of task isn\'t valid' });
    expect(refusalField({ 'iep:refusalReason': 'the plan is stale' })).toBeNull();
    const friendly = page.window.eval('friendly') as (r: unknown) => { title: string; body: string };
    expect(friendly({ tool: 'wrd.capture_workflow', status: 400, body: { error: 'The envelope payload is malformed.', 'iep:refusalReason': 'workflow.unitLabel is required text' } }).body).toMatch(/^Unit of work is required\./);
    // The fields still to fill before signing are named in words, never as paths or task IRIs.
    const fillSummary = page.window.eval('fillSummary') as (f: string[]) => string[];
    const summary = fillSummary(['inputs.currency', 'inputs.unitsPerWeek.current.low', 'inputs.tasks.urn:wrd:task:k1:a:b.runsPerUnit.low', 'note', 'answers.q1']);
    expect(summary).toEqual(['Your business case inputs: 3 values you enter on this page', 'Your note', 'Your answers']);
    expect(summary.join(' ')).not.toMatch(/urn:|inputs\./);
    expect(page.errors).toEqual([]);
  }, 60_000);

  it('says where an AI permission stands from the bridge\'s own reason first: withdrawn, a changed model, then the bar', async () => {
    const l = await minimalDemo();
    const page = await openUi(l.base);
    await page.until(() => page.text().includes('Match invoices'), 'the demo');
    const state = page.window.eval('grantStateText') as (agent: string, kind: string, g: unknown, cell: unknown) => string;
    const met = { samples: 25, acceptedShare: 0.92, distinctConfirmers: 5, readyClaims: 24, readyClaimPrecision: 0.958, currentModel: true };
    expect(state('0xa', 'k', { active: true, why: null }, met)).toBe('');
    expect(state('0xa', 'k', { active: false, why: 'revoked at 2027-01-28T09:07:00.000Z' }, met)).toBe('Withdrawn on 28 Jan 2027. Re-earning counts only work reviewed after that.');
    expect(state('0xa', 'k', { active: false, why: "the agent's declared model changed since the grant (was a, now b)" }, met)).toMatch(/^Its AI model changed/);
    expect(state('0xa', 'k', { active: false, why: 'no grant' }, met)).toMatch(/meets the bar/);
    expect(state('0xa', 'k', { active: false, why: 'no grant' }, { ...met, readyClaims: 12, readyClaimPrecision: 0.5 })).toBe('Not earned yet: 12 of 20 pieces it called "ready"; people agreed with 50.0% of its "ready" claims, below 90.0%.');
    expect(state('0xa', 'k', { active: null, why: 'sealed' }, met)).toMatch(/^Can't be checked/);
    expect(page.errors).toEqual([]);
  }, 60_000);

  it('labels the navigation exactly, keeps counts out of button text, and every label a test clicks reaches the intended control first', async () => {
    const l = await minimalDemo();
    const page = await openUi(l.base);
    await page.until(() => page.text().includes('Match invoices'), 'the demo');
    const links = [...page.doc.querySelectorAll('nav.side-nav button.side-nav__link')];
    expect(links.map((b) => b.textContent)).toEqual(['Home', 'Processes', 'Map a process', 'Plans', 'Business case', 'Decisions', 'Track record', 'AI agents', 'People & roles', 'My record']);
    for (const b of links) {
      const n = b.getAttribute('data-count');
      if (n !== null) expect([b.textContent, /^[1-9][0-9]*$/.test(n)]).toEqual([b.textContent, true]);
    }
    const firstButton = (label: string): Element | undefined => [...page.doc.querySelectorAll('button')].find((x) => x.textContent === label);
    for (const label of ['Processes', 'Track record', 'Decisions', 'AI agents', 'People & roles']) expect(firstButton(label)?.closest('nav.side-nav') ?? null, label).not.toBeNull();
    expect(firstButton('Refresh')?.closest('.app-header') ?? null).not.toBeNull();
    expect(page.errors).toEqual([]);
  }, 60_000);

  it('lets a change stopped early or reversed be recorded before its planned measurement period ends, and holds only a kept change to the whole period', async () => {
    const l = await minimalDemo();
    const page = await openUi(l.base);
    await page.until(() => page.text().includes('Match invoices'), 'the demo');
    // The page's clock is the real one until someone moves the demo clock.
    const now = Date.now();
    // Approved a week into a six-week measurement period, by someone other than Ana (the demo's first persona, a process lead).
    const decision = {
      decisionIri: 'urn:wrd:decision:early-stop', status: 'countersigned', decisionKind: 'valued', preparedBy: [{ personRef: 'p-other' }],
      countersign: { at: new Date(now - 7 * 86400000).toISOString(), personRef: 'p-approver' }, measurementPlan: { windowWeeks: 6, comparisonBasis: 'staggered' },
    };
    const recordWhy = page.window.eval('recordWhy') as (d: unknown, disposition?: string) => string;
    expect(recordWhy(decision, 'kept')).toMatch(/^The measurement period ends /);
    expect(recordWhy(decision, 'stopped-early')).toBe('');
    expect(recordWhy(decision, 'reverted')).toBe('');
    // Home's "Results due" list still waits for the planned end, which is when a kept change's results fall due.
    expect((page.window.eval('canRecordResults') as (d: unknown) => boolean)(decision)).toBe(false);
    expect((page.window.eval('canRecordResults') as (d: unknown) => boolean)({ ...decision, countersign: { ...decision.countersign, at: new Date(now - 7 * 7 * 86400000).toISOString() } })).toBe(true);

    // The form itself: "Kept" holds the button back and says until when; choosing "Stopped early" or "Reversed" releases it.
    const outcomeForm = page.window.eval('outcomeForm') as (d: unknown, binding: unknown) => HTMLElement;
    const sign = (el: HTMLElement): HTMLButtonElement => must([...el.querySelectorAll('button')].find((b) => b.textContent === 'Sign and record results'), 'the sign button') as HTMLButtonElement;
    let form = outcomeForm(decision, {});
    expect(sign(form).disabled).toBe(true);
    expect(form.querySelector('.why-not')?.textContent).toMatch(/^Why can't I\? The measurement period ends /);
    for (const [disposition, label] of [['stopped-early', 'Stopped early'], ['reverted', 'Reversed']] as const) {
      const what = must(form.querySelector('select'), 'the disposition select') as HTMLSelectElement;
      expect([...what.options].find((o) => o.value === disposition)?.textContent).toBe(label);
      what.value = disposition;
      what.dispatchEvent(new page.window.Event('change', { bubbles: true }));
      form = outcomeForm(decision, {});
      expect(sign(form).disabled, disposition).toBe(false);
      expect(form.querySelector('.why-not'), disposition).toBeNull();
    }
    expect(page.errors).toEqual([]);
  }, 60_000);
});
