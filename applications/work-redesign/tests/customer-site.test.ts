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
import { listenLoopback, type TestListener } from '../../_shared/vertical-bridge/listen-loopback.js';
import { wrdAffordances, wrdDemoAffordances } from '../affordances.js';
import { createWrdHandlers } from '../bridge/handlers.js';
import { attachUi, hostAllowlistGuard, parseEveryQueryPair, servedHostNames, UI_CSP, type UiReads } from '../bridge/ui.js';
import { SIBLING, INTEREGO_DEFAULTS, type LandingOptions } from '../bridge/landing.js';
import { demoClock, memoryPod, DEMO_POD, DEMO_RECORD_KEY } from '../demo/run.js';

const APP_JS = readFileSync(new URL('../bridge/ui/app.js', import.meta.url), 'utf8');
const must = <T>(v: T | null | undefined, what: string): T => { if (v === null || v === undefined) throw new Error(`missing ${what}`); return v; };
const BROWSER = 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8';
const listeners: TestListener[] = [];
afterAll(async () => { for (const l of listeners) await l.close(); });

/** A production composition, as bridge/server.ts composes it (its entry point names the pod it serves): no demo signer, no sign-in. */
async function production(o: { readonly landing?: LandingOptions; readonly reads?: UiReads } = {}): Promise<TestListener> {
  const l = await listenLoopback(createVerticalBridge({
    verticalName: 'work-redesign', affordances: wrdAffordances, deploymentUrl: 'http://127.0.0.1', defaultPodUrl: DEMO_POD,
    handlers: createWrdHandlers({ defaultPodUrl: DEMO_POD }),
    middleware: (a) => { attachUi(a, { base: 'http://127.0.0.1', ...o }); parseEveryQueryPair(a); },
  }));
  listeners.push(l);
  return l;
}

/** The demo composition of the UI's DOM test: Ana a process lead and team member named on one unsorted task, Zed in no role, and the admin. */
async function minimalDemo(): Promise<TestListener> {
  const pod = memoryPod();
  const clock = demoClock();
  const seed = (id: string) => importWallet(`0x${sha256Hex(`wrd-customer-site:${id}`)}`, 'human', id);
  const admin = seed('admin');
  const ana = seed('ana');
  const zed = seed('zed');
  const handlers = createWrdHandlers({
    fetchFn: pod.fetchFn, defaultPodUrl: DEMO_POD, now: () => clock.now(), platform: { wallet: seed('platform'), keyKind: 'demo' }, adminAddresses: [admin.address],
    recordKey: DEMO_RECORD_KEY,
    demoPersonas: new Map([['ana', { id: 'ana', label: 'Ana (demo)', wallet: ana }], ['zed', { id: 'zed', label: 'Zed (demo)', wallet: zed }], ['admin', { id: 'admin', label: 'Admin (demo)', wallet: admin }]]),
  });
  const registry = {
    intent: 'wrd:update-registry', podUrl: DEMO_POD, issuedAt: clock.now().toISOString(), nonce: 'customer-site-registry-1',
    entries: [{ address: ana.address, roles: ['operator', 'worker'], label: 'Ana', softwareAgent: false, personRef: 'p-ana' }],
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

/** What a person can see: closed details' contents, hidden elements, pre blocks and text areas left out. */
const visibleText = (d: Document): string => {
  const root = d.getElementById('app')!.cloneNode(true) as HTMLElement;
  for (const det of [...root.querySelectorAll('details')]) if (!det.hasAttribute('open')) for (const c of [...det.children]) if (c.tagName !== 'SUMMARY') c.remove();
  for (const n of [...root.querySelectorAll('[hidden], pre, textarea')]) n.remove();
  return root.textContent ?? '';
};

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

/** Words of the protocol and the plumbing that a person should never have to read on screen. */
const JARGON = /\b(pod|affordance|envelope|payload|ratif\w*|regime|Hypothetical|Asserted|Counterfactual|P(10|50|90)|Brier|IRI|descriptor|sha256|relay|bridge|countersign\w*|Refused)\b|HTTP \d{3}|WRD_[A-Z_]+|EIP-191|personal_sign|did:web:|urn:wrd:/i;
/** Matches the guard allows, each with why. Empty: nothing on screen needs one. */
const ALLOWED: ReadonlyArray<readonly [RegExp, string]> = [];
const jargonIn = (text: string): string[] => {
  let rest = text;
  for (const [re] of ALLOWED) rest = rest.replace(new RegExp(re.source, `${re.flags.replace('g', '')}g`), ' ');
  const hits: string[] = [];
  const g = new RegExp(JARGON.source, 'gi');
  for (const m of rest.matchAll(g)) {
    const at = m.index ?? 0;
    hits.push(`"${m[0]}" in …${rest.slice(Math.max(0, at - 60), at + 60).replace(/\s+/g, ' ')}…`);
  }
  return hits;
};

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
    const pages: Array<readonly [string, number]> = [['/', 0], ['/ui', 1], ['/ui/oauth/callback', 1], ['/ui/help', 0]];
    for (const [path, scripts] of pages) {
      const html = await (await fetch(`${l.base}${path}`, { headers: { accept: BROWSER } })).text();
      expect([path, /<style/i.test(html)]).toEqual([path, false]);
      expect([path, /\sstyle=/i.test(html)]).toEqual([path, false]);
      expect([path, /\son[a-z]+=/i.test(html)]).toEqual([path, false]);
      expect([path, /javascript:/i.test(html)]).toEqual([path, false]);
      const tags = html.match(/<script[^>]*>[\s\S]*?<\/script>/gi) ?? [];
      expect([path, html.match(/<script/gi)?.length ?? 0]).toEqual([path, scripts]);
      for (const t of tags) expect([path, t]).toEqual([path, '<script type="module" src="/ui/app.js"></script>']);
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
