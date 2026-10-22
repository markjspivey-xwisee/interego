/**
 * The offline demo and the web UI, as a user meets them.
 *
 * The demo test runs the whole walk once — registry, document capture with a fabricated quote,
 * disputes and revisions, classification, allocation, valuation, the decision lifecycle with a
 * nine-week measurement window, probes, an earned and revoked grant, holder copies and a
 * tampered record — and holds it to two things: every refusal it asserts was observed with its
 * status, and every record, row and calibration cell it produced says it is scripted. The marking
 * is read back from the bridge's own answers and from a graph fetched off the pod, not from the
 * demo's bookkeeping.
 *
 * The UI tests check what the browser is served (headers, an inert shell, a client that never
 * writes HTML or style attributes) and that the client calls only what the manifest declares.
 */
import { describe, it, expect, afterAll } from 'vitest';
import { readFileSync } from 'node:fs';
import { createVerticalBridge } from '../../_shared/vertical-bridge/index.js';
import { listenLoopback, type TestListener } from '../../_shared/vertical-bridge/listen-loopback.js';
import { wrdAffordances, wrdDemoAffordances } from '../affordances.js';
import { createWrdHandlers } from '../bridge/handlers.js';
import { attachUi, UI_CSP } from '../bridge/ui.js';
import { runDemo, DEMO_REFUSALS, DEMO_POD } from '../demo/run.js';

const APP_JS = readFileSync(new URL('../bridge/ui/app.js', import.meta.url), 'utf8');
const listeners: TestListener[] = [];
afterAll(async () => { for (const l of listeners) await l.close(); });

describe('work-redesign offline demo and web UI', () => {
  it('runs the offline demo end to end, observes every asserted refusal with its status, and every record and cell it wrote says it is scripted', async () => {
    const report = await runDemo({ quiet: true, writeReport: false });
    const failed = report.steps.filter((s) => !s.ok).map((s) => `${s.step}: ${s.note}`);
    expect(failed).toEqual([]);
    expect(report.ok).toBe(true);
    expect(report.steps.length).toBeGreaterThan(80);
    // Independent of the demo's own verdicts: every step got the HTTP status it expected.
    expect(report.steps.filter((s) => s.got !== s.expect).map((s) => `${s.step}: ${s.expect} vs ${s.got}`)).toEqual([]);
    // Every refusal id, each exactly once, with the status the bridge actually returned — the spec's refusal catalogue (§13.3).
    const observed = new Map(report.refusalsObserved.map((r) => [r.split(' ')[0] ?? '', Number(r.split(' ')[1])]));
    expect([...observed.keys()]).toEqual([...DEMO_REFUSALS]);
    expect(Object.fromEntries(observed)).toEqual({
      'R-A': 403, 'R-B': 422, 'R-C': 400, 'R-D': 409, 'R-E': 403, 'R-F': 400, 'R-G': 409, 'R-H': 400, 'R-I': 409, 'R-J': 400,
      'R-K': 409, 'R-L': 409, 'R-M': 409, 'R-N': 409, 'R-O': 409, 'R-P': 403, 'R-Q': 403, 'R-R': 403, 'R-S': 403, 'R-T': 409,
      'R-U': 409, 'R-V': 403, 'R-W': 409, 'R-X': 409, 'R-Y': 409, 'R-Z': 409, 'R-AA': 409, 'R-AB': 403, 'R-AC': 403, 'R-AD': 409,
      'R-AE': 409, 'R-AF': 409, 'R-AG': 409, 'R-AH': 409, 'R-AI': 403, 'R-AJ': 401, 'R-AK': 403, 'R-AL': 400, 'R-AM': 409,
      'R-AN': 409, 'R-AO': 409, 'R-AP': 403, 'R-AQ': 403, 'R-AR': 409, 'R-AS': 403, 'R-AT': 409,
    });
    expect(report.demoMarking.records).toBeGreaterThan(0);
    expect(report.demoMarking.demoRecords).toBe(report.demoMarking.records);
    expect(report.demoMarking.unlabelledRows).toBe(0);
    expect(report.demoMarking.unlabelledCells).toBe(0);
    expect(report.demoMarking.sampledGraphHasDemoTriple).toBe(true);
    expect(report.reportPath).toBeNull();
    expect(report.base).toBeNull();
  }, 120_000);

  it('serves /ui, /ui/app.js and /ui/app.css with the CSP, nosniff, no-referrer and no-store headers; the shell has no style attribute and app.js no setAttribute(\'style\' and no innerHTML', async () => {
    const app = createVerticalBridge({
      verticalName: 'work-redesign', affordances: wrdAffordances, deploymentUrl: 'http://127.0.0.1',
      handlers: createWrdHandlers({ defaultPodUrl: DEMO_POD }),
      middleware: (a) => attachUi(a, { base: 'http://127.0.0.1' }),
    });
    const l = await listenLoopback(app);
    listeners.push(l);
    const bodies: Record<string, string> = {};
    for (const [path, type] of [['/ui', 'text/html'], ['/ui/app.js', 'text/javascript'], ['/ui/app.css', 'text/css']] as const) {
      const r = await fetch(`${l.base}${path}`);
      expect(r.status, path).toBe(200);
      expect(r.headers.get('content-type'), path).toContain(type);
      expect(r.headers.get('content-security-policy'), path).toBe(UI_CSP);
      expect(r.headers.get('x-content-type-options'), path).toBe('nosniff');
      expect(r.headers.get('referrer-policy'), path).toBe('no-referrer');
      expect(r.headers.get('cache-control'), path).toBe('no-store');
      bodies[path] = await r.text();
    }
    expect(UI_CSP).toContain("script-src 'self'");
    expect(UI_CSP).toContain("style-src 'self'");
    expect(UI_CSP).not.toContain('unsafe-inline');
    expect(UI_CSP).toContain("frame-ancestors 'none'");

    const shell = bodies['/ui'] ?? '';
    expect(shell).toContain('<script type="module" src="/ui/app.js"></script>');
    expect(shell).toContain('<link rel="stylesheet" href="/ui/app.css">');
    expect(shell).toContain('<noscript>');
    expect(shell).not.toMatch(/\sstyle=/i);
    expect(shell).not.toMatch(/<style/i);
    expect(shell.match(/<script/g)).toHaveLength(1);   // the one external module, nothing inline

    expect(bodies['/ui/app.js']).toBe(APP_JS);
    for (const banned of ["setAttribute('style'", 'setAttribute("style"', '.innerHTML', '.outerHTML', 'insertAdjacentHTML', 'document.write', 'eval(', 'new Function']) {
      expect(APP_JS.includes(banned), banned).toBe(false);
    }
    // Untrusted text reaches the page as text nodes; widths go through the CSSOM, which the CSP allows.
    expect(APP_JS).toContain('document.createTextNode');
    expect(APP_JS).toContain('.style.width =');
    expect(bodies['/ui/app.css']).toContain('@media print');

    // A production composition: the UI is served, the demo signer is neither advertised nor routed.
    const demoRoute = await fetch(`${l.base}/wrd/demo_envelope`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
    expect(demoRoute.status).toBe(404);
  });

  it('the UI calls only tool names the manifest declares, and reaches every one of them', () => {
    const declared = new Set([...wrdAffordances, ...wrdDemoAffordances].map((a) => a.toolName));
    const named = new Set([...APP_JS.matchAll(/'(wrd\.[a-z_]+)'/g)].map((m) => m[1] ?? ''));
    expect([...named].filter((t) => !declared.has(t))).toEqual([]);
    // Reached = passed to one of the client's three calling functions, not merely named in a lookup table.
    const called = new Set([...APP_JS.matchAll(/\b(?:call|act|send)\('(wrd\.[a-z_]+)'/g)].map((m) => m[1] ?? ''));
    expect([...declared].filter((t) => !called.has(t))).toEqual([]);
    // The client reads its targets from the manifest; it never builds a /wrd/<tool> path itself.
    expect(APP_JS).toContain("fetch('/affordances?format=jsonld'");
    expect(APP_JS).not.toMatch(/['`]\/wrd\//);
  });
});
