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
 *
 * The Host-guard tests check that a loopback bridge answers only its own names — a page that
 * rebinds its DNS name to 127.0.0.1 is refused (421) before any route — and that bridge/server.ts
 * and the demo both install that guard first.
 */
import { describe, it, expect, afterAll } from 'vitest';
import { readFileSync } from 'node:fs';
import { request } from 'node:http';
import type { NextFunction, Request, Response } from 'express';
import { createVerticalBridge } from '../../_shared/vertical-bridge/index.js';
import { listenLoopback, type TestListener } from '../../_shared/vertical-bridge/listen-loopback.js';
import { wrdAffordances, wrdDemoAffordances } from '../affordances.js';
import { createWrdHandlers } from '../bridge/handlers.js';
import { attachUi, hostAllowlistGuard, isLoopbackBind, servedHostNames, UI_CSP } from '../bridge/ui.js';
import { runDemo, DEMO_REFUSALS, DEMO_POD } from '../demo/run.js';

const read = (rel: string): string => readFileSync(new URL(rel, import.meta.url), 'utf8').split('\r\n').join('\n');
const APP_JS = readFileSync(new URL('../bridge/ui/app.js', import.meta.url), 'utf8');
const listeners: TestListener[] = [];
afterAll(async () => { for (const l of listeners) await l.close(); });

/** One request to 127.0.0.1:`port` with the Host header set to `host` (fetch() cannot set Host). */
function hostRequest(port: number, method: 'GET' | 'POST', path: string, host: string): Promise<{ status: number; body: Record<string, unknown> }> {
  return new Promise((resolve, reject) => {
    const headers: Record<string, string> = { host, accept: 'application/json', ...(method === 'POST' ? { 'content-type': 'application/json' } : {}) };
    const req = request({ host: '127.0.0.1', port, method, path, agent: false, headers }, (res) => {
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
    req.end(method === 'POST' ? '{}' : undefined);
  });
}

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
    // The demo's own app — the one --serve keeps up with the personas' keys — refused a rebound
    // Host on the manifest, the records, the demo signer and the UI, and answered its own names.
    const guard = report.steps.filter((s) => s.tool === 'Host guard');
    expect(guard.map((s) => [s.ok, s.note.split(', ').map((x) => x.replace(/^\S+:\d+ /, '')).join(', ')])).toEqual([
      [true, '421 refusal, 421 refusal, 421 refusal, 421 refusal'],
      [true, '200, 200, 200'],
    ]);
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

  it('a loopback bridge refuses (421, typed) a Host naming another site before any route, and answers its loopback names and its public host', async () => {
    const PUBLIC = 'https://bridge.example.org';
    const allowed: string[] = [];
    const app = createVerticalBridge({
      verticalName: 'work-redesign', affordances: wrdAffordances, deploymentUrl: 'http://127.0.0.1',
      handlers: createWrdHandlers({ defaultPodUrl: DEMO_POD }),
      middleware: (a) => {
        // The port is known only after listening, so the allowed names are read per request.
        a.use((req: Request, res: Response, next: NextFunction) => hostAllowlistGuard(allowed)(req, res, next));
        attachUi(a, { base: PUBLIC });
      },
    });
    const l = await listenLoopback(app);
    listeners.push(l);
    allowed.push(...servedHostNames(l.port, PUBLIC));
    const p = l.port;

    // A rebound name — with the bridge's own port or without one — gets nothing: not the manifest,
    // the records, a signing endpoint, the UI, MCP or the entry point. So does a loopback name on another port.
    const refusedHosts = [`rebind.attacker.example:${p}`, 'rebind.attacker.example', `127.0.0.1.attacker.example:${p}`, `localhost:${p + 1}`, '127.0.0.1'];
    const routes: Array<['GET' | 'POST', string]> = [
      ['GET', '/affordances?format=jsonld'], ['GET', '/wrd/list_records'], ['POST', '/wrd/demo_envelope'], ['POST', '/wrd/update_registry'],
      ['GET', '/ui'], ['GET', '/ui/app.js'], ['POST', '/mcp'], ['GET', '/'],
    ];
    for (const host of refusedHosts) {
      for (const [method, path] of routes) {
        const r = await hostRequest(p, method, path, host);
        expect([host, method, path, r.status], JSON.stringify(r.body)).toEqual([host, method, path, 421]);
        expect(r.body['kind']).toBe('refusal');
        expect(r.body['iep:refusalStatus']).toBe(421);
        expect(String(r.body['iep:refusalReason'])).toMatch(/Host header is not a name this bridge is served under/);
        expect(typeof r.body['error']).toBe('string');
      }
    }

    // Its own names answer, in any case, and so does the public host a reverse proxy on this machine forwards.
    for (const host of [`127.0.0.1:${p}`, `localhost:${p}`, `[::1]:${p}`, `LOCALHOST:${p}`, 'bridge.example.org']) {
      const manifest = await hostRequest(p, 'GET', '/affordances?format=jsonld', host);
      expect([host, manifest.status]).toEqual([host, 200]);
      expect(manifest.body['kind']).not.toBe('refusal');
      expect([host, (await hostRequest(p, 'GET', '/ui', host)).status]).toEqual([host, 200]);
    }
    // The factory mounts its build-identity /health before any vertical hook; it answers status and build only.
    const health = await hostRequest(p, 'GET', '/health', 'rebind.attacker.example');
    expect([health.status, Object.keys(health.body).sort()]).toEqual([200, ['build', 'status']]);
  });

  it('names the loopback binds and the Host names a bridge on a port answers', () => {
    for (const h of ['127.0.0.1', 'localhost', 'LOCALHOST', '::1', '[::1]', ' 127.0.0.1 ']) expect([h, isLoopbackBind(h)]).toEqual([h, true]);
    for (const h of ['0.0.0.0', '::', '', '192.168.1.10', 'bridge.example.org', '127.0.0.2']) expect([h, isLoopbackBind(h)]).toEqual([h, false]);
    expect(servedHostNames(6100)).toEqual(['127.0.0.1:6100', 'localhost:6100', '[::1]:6100']);
    // The default deployment URL adds nothing new; a public one adds its host (with a port only when it is not the scheme's default).
    expect(servedHostNames(6100, 'http://127.0.0.1:6100')).toEqual(['127.0.0.1:6100', 'localhost:6100', '[::1]:6100']);
    expect(servedHostNames(6100, 'https://Bridge.Example.org/')).toEqual(['127.0.0.1:6100', 'localhost:6100', '[::1]:6100', 'bridge.example.org']);
    expect(servedHostNames(6100, 'https://bridge.example.org:8443/wrd')).toContain('bridge.example.org:8443');
    expect(servedHostNames(6100, 'not a url')).toEqual(['127.0.0.1:6100', 'localhost:6100', '[::1]:6100']);
    // On port 80 a browser sends the bare name.
    expect(servedHostNames(80)).toEqual(['127.0.0.1:80', 'localhost:80', '[::1]:80', '127.0.0.1', 'localhost', '[::1]']);
  });

  it('bridge/server.ts and the demo install the Host guard first in their middleware hook; the server whenever it binds loopback, the demo always', () => {
    const server = read('../bridge/server.ts');
    const demo = read('../demo/run.ts');
    expect(server).toMatch(/^const HOST = process\.env\['HOST'\] \?\? '127\.0\.0\.1';$/m);
    expect(server).toMatch(/^const loopback = isLoopbackBind\(HOST\);$/m);
    expect(server).toMatch(/^app\.listen\(PORT, HOST, /m);
    // The first statement of the hook, so the guard stands in front of the ontology, the UI and every route the factory mounts after it.
    expect(server).toMatch(/middleware: \(a\) => \{\n(?:\s*\/\/[^\n]*\n)*\s*if \(loopback\) a\.use\(hostAllowlistGuard\(servedHostNames\(PORT, base\)\)\);\n/);
    expect(demo).toMatch(/middleware: \(a\) => \{\n(?:\s*\/\/[^\n]*\n)*\s*a\.use\(hostAllowlistGuard\(servedHostNames\(port, base\)\)\);\n\s*attachUi\(a, \{ base \}\);/);
    // One composition each, so there is no second app without the guard.
    for (const src of [server, demo]) {
      expect(src.match(/createVerticalBridge\(/g)).toHaveLength(1);
      expect(src.match(/middleware:/g)).toHaveLength(1);
    }
    // The demo binds 127.0.0.1 in both modes; the guard's port is the one it bound.
    expect(demo).toMatch(/s\.listen\(port, '127\.0\.0\.1', /);
    expect(demo).toMatch(/port = l\.port;/);
  });
});
