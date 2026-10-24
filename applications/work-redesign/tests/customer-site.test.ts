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
import { attachUi, hostAllowlistGuard, parseEveryQueryPair, servedHostNames, UI_CSP } from '../bridge/ui.js';
import { SIBLING, INTEREGO_DEFAULTS } from '../bridge/landing.js';
import { demoClock, memoryPod, DEMO_POD, DEMO_RECORD_KEY } from '../demo/run.js';

const APP_JS = readFileSync(new URL('../bridge/ui/app.js', import.meta.url), 'utf8');
const BROWSER = 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8';
const listeners: TestListener[] = [];
afterAll(async () => { for (const l of listeners) await l.close(); });

/** A production composition, as bridge/server.ts composes it (its entry point names the pod it serves): no demo signer, no sign-in. */
async function production(): Promise<TestListener> {
  const l = await listenLoopback(createVerticalBridge({
    verticalName: 'work-redesign', affordances: wrdAffordances, deploymentUrl: 'http://127.0.0.1', defaultPodUrl: DEMO_POD,
    handlers: createWrdHandlers({ defaultPodUrl: DEMO_POD }),
    middleware: (a) => { attachUi(a, { base: 'http://127.0.0.1' }); parseEveryQueryPair(a); },
  }));
  listeners.push(l);
  return l;
}

/** The demo composition of the UI's DOM test: Ana a process lead and team member named on one unsorted task, Zed in no role. */
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
    demoPersonas: new Map([['ana', { id: 'ana', label: 'Ana (demo)', wallet: ana }], ['zed', { id: 'zed', label: 'Zed (demo)', wallet: zed }]]),
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

  it('keeps the entry point for agents: JSON-LD for no Accept, */*, JSON-LD, JSON and a weighted HTML ask; HMD for Markdown; ?format= always wins', async () => {
    const l = await production();
    for (const accept of [null, '*/*', 'application/ld+json', 'application/json', 'text/html;q=0.5, application/ld+json']) {
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
    const forcedMd = await fetch(`${l.base}/?format=markdown`, { headers: { accept: BROWSER } });
    expect(forcedMd.headers.get('content-type')).toContain('text/markdown');
    const forcedLd = await fetch(`${l.base}/?format=jsonld`, { headers: { accept: BROWSER } });
    expect(forcedLd.headers.get('content-type')).toContain('application/ld+json');
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
});
