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
 * The page is also run in a jsdom window against a demo-composed bridge: it signs one read per
 * signer and reuses it, sends it for a filled template only in a POST body (no request URL ever
 * carries it), and without a signer it meets the 401 of the unsigned read model.
 *
 * The Host-guard tests check that a loopback bridge answers only its own names — a page that
 * rebinds its DNS name to 127.0.0.1 is refused (421) before any route — and that bridge/server.ts
 * and the demo both install that guard first.
 *
 * On the pod the walk leaves behind (sealed, reads closed): an unsigned wrd.envelope_template
 * holds nothing beyond its allowlist for any intent that reads a record, valued and probe
 * decisions alike, while the same arguments with a signed read, POSTed to
 * wrd.read_envelope_template, are filled (and the GET refuses the forms of a signed read it
 * detects, nested or not, in a key or a value); no tuple behind an entity IRI (who is assigned
 * which task, which agent works which kind of task, which decision is a probe) can be recovered
 * from the pod's public bytes by recomputing an unkeyed hash; every keyed IRI names the key's fingerprint, and no keyed segment is shared between two kinds or
 * positions; the only instant two kinds share is a workflow version's with its tasks, the link
 * README and readExposure name. The production server refuses to start without a record key, or
 * without a platform key, when the image requires one. In the UI, a signer whose read is refused is
 * still offered their copy, and a line cut by a platform key no longer trusted is named in the header.
 */
import { describe, it, expect, afterAll } from 'vitest';
import { spawn } from 'node:child_process';
import { readFileSync, readdirSync } from 'node:fs';
import { request } from 'node:http';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { NextFunction, Request, Response } from 'express';
import { JSDOM, VirtualConsole } from 'jsdom';
import { importWallet, sha256Hex, signMessageRaw, canonicalJson } from '@interego/core';
import { createVerticalBridge } from '../../_shared/vertical-bridge/index.js';
import { listenLoopback, type TestListener } from '../../_shared/vertical-bridge/listen-loopback.js';
import { wrdAffordances, wrdDemoAffordances } from '../affordances.js';
import { createWrdHandlers } from '../bridge/handlers.js';
import { attachUi, hostAllowlistGuard, isLoopbackBind, parseEveryQueryPair, servedHostNames, UI_CSP } from '../bridge/ui.js';
import { runDemo, memoryPod, demoClock, DEMO_REFUSALS, DEMO_POD, DEMO_HOLDER_POD, DEMO_RECORD_KEY, type MemoryPod, type DemoReport } from '../demo/run.js';
import { h16, entityIriKey, iriKeyFingerprint } from '../src/records.js';
import { walkManifest } from '../bridge/pod-helpers.js';

const read = (rel: string): string => readFileSync(new URL(rel, import.meta.url), 'utf8').split('\r\n').join('\n');
const APP_JS = readFileSync(new URL('../bridge/ui/app.js', import.meta.url), 'utf8');
const listeners: TestListener[] = [];
afterAll(async () => { for (const l of listeners) await l.close(); });

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v);
const objOf = (v: unknown): Obj => (isObj(v) ? v : {});
const rows = (v: unknown): Obj[] => (Array.isArray(v) ? v.filter(isObj) : []);
const must = <T>(v: T | undefined | null, what: string): T => {
  if (v === undefined || v === null) throw new Error(`expected ${what}`);
  return v;
};

/** The demo walk, run once for every test that needs it, on a pod this module holds. */
let walk: Promise<{ readonly report: DemoReport; readonly pod: MemoryPod }> | null = null;
const walked = (): Promise<{ readonly report: DemoReport; readonly pod: MemoryPod }> => {
  walk ??= (async () => {
    const pod = memoryPod();
    return { report: await runDemo({ quiet: true, writeReport: false, pod }), pod };
  })();
  return walk;
};
/** A demo persona's key, from the seed the demo publishes. */
const demoWallet = (id: string, type: 'human' | 'agent' = 'human') => importWallet(`0x${sha256Hex(`wrd-demo:${id}`)}`, type, id);
/** Every leaf of a JSON value with its path; empty arrays and objects have none. */
const leaves = (v: unknown, path = ''): Array<readonly [string, unknown]> => {
  if (Array.isArray(v)) return v.flatMap((x, i) => leaves(x, `${path}[${i}]`));
  if (isObj(v)) return Object.entries(v).flatMap(([k, x]) => leaves(x, path === '' ? k : `${path}.${k}`));
  return [[path, v]];
};

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

interface UiPage {
  readonly log: Array<{ method: string; path: string; query: string; status: number; body: Record<string, unknown> }>;
  readonly errors: string[];
  /** The files the page handed the browser to save (URL.createObjectURL), in order. */
  readonly saved: Blob[];
  /** The text of one of them (jsdom's Blob has no text()). */
  readSaved(i: number): Promise<string>;
  text(): string;
  q(sel: string): Element | null;
  all(sel: string): Element[];
  click(buttonText: string): void;
  select(sel: string, value: string): void;
  until<T>(fn: () => T | null | undefined | false, what: string, ms?: number): Promise<T>;
}

/** The shipped /ui shell and /ui/app.js in a jsdom window whose fetch reaches the loopback bridge, every call logged. */
async function openUi(base: string): Promise<UiPage> {
  const errors: string[] = [];
  const vc = new VirtualConsole();
  vc.on('jsdomError', (e: Error) => errors.push(`jsdomError: ${e.message}`));
  vc.on('error', (...a: unknown[]) => errors.push(`console.error: ${a.map(String).join(' ')}`));
  const dom = new JSDOM(await (await fetch(`${base}/ui`)).text(), { url: `${base}/ui`, runScripts: 'outside-only', pretendToBeVisual: true, virtualConsole: vc });
  const w = dom.window;
  const log: UiPage['log'] = [];
  // `Response` in this module is express's; the page's fetch answers the global one.
  w['fetch'] = async (input: unknown, init?: RequestInit): Promise<globalThis.Response> => {
    const url = new URL(String(input), w.location.href);
    const r = await fetch(url, init);
    let body: Record<string, unknown> = {};
    try { body = typeof init?.body === 'string' ? JSON.parse(init.body) as Record<string, unknown> : {}; } catch { body = {}; }
    log.push({ method: init?.method ?? 'GET', path: url.pathname, query: url.search, status: r.status, body });
    return r;
  };
  // jsdom does not scroll: opening a panel scrolls to the top, which is a no-op here, not an error.
  (w as unknown as { scrollTo: () => void }).scrollTo = () => undefined;
  // Nor print: the summary is rendered into #print, and window.print() only opens the dialog.
  (w as unknown as { print: () => void }).print = () => undefined;
  // Nor save a file: the blob the page saves is kept, and the link it clicks to save it goes nowhere.
  const saved: Blob[] = [];
  (w.URL as unknown as { createObjectURL: (b: Blob) => string }).createObjectURL = (b: Blob) => { saved.push(b); return '#saved'; };
  (w.URL as unknown as { revokeObjectURL: () => void }).revokeObjectURL = () => undefined;
  w.eval(APP_JS);
  const d = w.document;
  return {
    log, errors, saved,
    readSaved: (i) => new Promise<string>((resolve, reject) => {
      const blob = saved[i];
      if (!blob) { reject(new Error(`no saved file ${i}`)); return; }
      const reader = new w.FileReader();
      reader.onload = () => resolve(String(reader.result));
      reader.onerror = () => reject(new Error('the saved file could not be read'));
      reader.readAsText(blob);
    }),
    text: () => d.getElementById('app')?.textContent ?? '',
    q: (sel) => d.querySelector(sel),
    all: (sel) => [...d.querySelectorAll(sel)],
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

/**
 * Start the production server (bridge/server.ts) with the environment this process has minus every
 * WRD_ variable, plus `extra`; once it says it is listening it is stopped. `started` says whether it
 * got that far.
 */
function startServer(extra: NodeJS.ProcessEnv): Promise<{ status: number | null; started: boolean; stderr: string; stdout: string }> {
  const root = fileURLToPath(new URL('../../../', import.meta.url));
  const server = fileURLToPath(new URL('../bridge/server.ts', import.meta.url));
  const base: NodeJS.ProcessEnv = Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith('WRD_')));
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['--import', 'tsx', server], {
      cwd: root, env: { ...base, PORT: '0', HOST: '127.0.0.1', WRD_DEFAULT_POD_URL: DEMO_POD, ...extra }, stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    let started = false;
    const timer = setTimeout(() => child.kill('SIGKILL'), 120_000);
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => {
      stdout += chunk;
      if (!started && /listening on 127\.0\.0\.1:0\)/.test(stdout)) { started = true; child.kill('SIGTERM'); }
    });
    child.stderr.on('data', (chunk: string) => { stderr += chunk; });
    child.on('error', reject);
    child.on('close', (code) => { clearTimeout(timer); resolve({ status: code, started, stderr, stdout }); });
  });
}
/** Run `cases` through `startServer`, three at a time (each start compiles and loads the whole bridge), in order. */
async function startEach(cases: readonly NodeJS.ProcessEnv[]): Promise<Array<Awaited<ReturnType<typeof startServer>>>> {
  const runs: Array<Awaited<ReturnType<typeof startServer>>> = [];
  const queue = [...cases.entries()];
  await Promise.all([0, 1, 2].map(async () => {
    for (let next = queue.shift(); next !== undefined; next = queue.shift()) runs[next[0]] = await startServer(next[1]);
  }));
  return runs;
}

describe('work-redesign offline demo and web UI', () => {
  it('runs the offline demo end to end, observes every asserted refusal with its status, and every record and cell it wrote says it is scripted', async () => {
    const { report } = await walked();
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
      'R-AU': 401, 'R-AV': 403, 'R-A': 403, 'R-B': 422, 'R-C': 400, 'R-D': 409, 'R-E': 403, 'R-F': 400, 'R-G': 409, 'R-H': 400, 'R-I': 409, 'R-J': 400,
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

  it('on the sealed pod the walk leaves, an unsigned wrd.envelope_template holds only its allowlist for every intent that reads a record, valued and probe decisions alike; sent a signed read it is filled; a bad signed read is refused', async () => {
    const { pod } = await walked();
    const admin = demoWallet('admin');
    const NOW = new Date('2027-06-01T00:00:00.000Z');
    const h = createWrdHandlers({
      fetchFn: pod.fetchFn, defaultPodUrl: DEMO_POD, now: () => NOW, platform: { wallet: demoWallet('platform', 'agent'), keyKind: 'demo' },
      adminAddresses: [admin.address], recordKey: DEMO_RECORD_KEY,
    });
    let n = 0;
    const signedRead = async (who = admin, issuedAt = NOW.toISOString()): Promise<{ payload: Obj; signature: string }> => {
      n += 1;
      const payload = { intent: 'wrd:read-records', podUrl: DEMO_POD, issuedAt, nonce: `allowlist-read-${String(n).padStart(6, '0')}` };
      return { payload, signature: await signMessageRaw(who, canonicalJson(payload)) };
    };
    const all = objOf(await h['wrd.read_records']!({ envelope: await signedRead() }));
    expect(all['status']).toBe('listed');
    const tasks = rows(all['tasks']);
    const workflows = rows(all['workflows']);
    const plans = rows(all['plans']);
    const decisions = rows(all['decisions']);
    const grants = rows(all['grants']);
    expect([tasks.length > 3, workflows.length > 0, grants.length > 0]).toEqual([true, true, true]);
    expect(new Set(plans.map((p) => p['planKind']))).toEqual(new Set(['valued', 'probe']));
    expect(new Set(decisions.map((d) => d['decisionKind']))).toEqual(new Set(['valued', 'probe']));

    // What the descriptors make public anyway: every descriptor URL, graph digest and record id the pod holds.
    const publicFacts = new Set(leaves(all).map(([, v]) => v).filter((v): v is string => typeof v === 'string'
      && (/^https:\/\/192\.0\.2\.10\/ap-team\/wrd\/records\/[^/]+\.ttl$/.test(v) || /^graph-nquads-sha256:[0-9a-f]{64}$/.test(v) || /^urn:wrd:record:/.test(v))));
    // What only the graphs say, and an unsigned template must never carry.
    const secrets = [
      ...tasks.flatMap((t) => [String(t['textSha256']), String(t['name']), String(t['description']), String(t['taskKind'])]),
      ...rows(all['valuations']).flatMap((v) => [String(v['valuationIri']), String(v['valuationHash'])]),
      ...decisions.flatMap((d) => [String(objOf(d['countersign'])['at'] ?? 'no countersign time'), String(d['valuationHash'] ?? 'no valuation hash')]),
    ];

    const cases: Array<{ intent: string; args: Obj }> = [
      ...workflows.flatMap((w) => [
        { intent: 'wrd:revise-task', args: { workflow_iri: w['workflowIri'] } },
        { intent: 'wrd:propose-allocation', args: { workflow_iri: w['workflowIri'] } },
      ]),
      ...tasks.flatMap((t) => [
        { intent: 'wrd:revise-task', args: { task_iri: t['taskIri'] } },
        { intent: 'wrd:ratify-task', args: { subject: 'description', task_iri: t['taskIri'] } },
        { intent: 'wrd:ratify-task', args: { subject: 'classification', task_iri: t['taskIri'] } },
        { intent: 'wrd:classify-task', args: { task_iri: t['taskIri'] } },
        { intent: 'wrd:agent-run', args: { task_iri: t['taskIri'] } },
      ]),
      ...plans.flatMap((p) => [
        { intent: 'wrd:value-plan', args: { plan_iri: p['planIri'] } },
        { intent: 'wrd:submit-decision', args: { plan_iri: p['planIri'] } },
        ...rows(p['assignments']).map((a) => ({ intent: 'wrd:ratify-task', args: { subject: 'assignment', task_iri: a['taskIri'], plan_iri: p['planIri'] } })),
      ]),
      ...decisions.flatMap((d) => [
        { intent: 'wrd:countersign-decision', args: { decision_iri: d['decisionIri'] } },
        { intent: 'wrd:record-outcome', args: { decision_iri: d['decisionIri'] } },
      ]),
      ...grants.map((g) => ({ intent: 'wrd:revoke-grant', args: { grant_iri: g['grantIri'] } })),
    ];
    const shapes = new Map<string, Set<string>>();
    let answered = 0;
    for (const c of cases) {
      const r = objOf(await h['wrd.envelope_template']!({ intent: c.intent, ...c.args }));
      const label = `${c.intent} ${JSON.stringify(c.args)}`;
      if (r['kind'] === 'refusal') {
        // Only the record the walk tampered with at the end (a sealed classification that no longer opens) is refused.
        expect([label, r['iep:refusalStatus']]).toEqual([label, 409]);
        expect(String(r['iep:refusalReason'])).toMatch(/WRD_RECORD_KEY/);
        continue;
      }
      answered += 1;
      expect([label, r['context'], typeof r['contextWithheld']]).toEqual([label, {}, 'string']);
      const tpl = objOf(r['template']);
      const allowed = new Set<unknown>([c.intent, DEMO_POD, tpl['issuedAt'], tpl['nonce'], ...Object.values(c.args), ...publicFacts]);
      if (c.intent === 'wrd:revise-task' && c.args['workflow_iri'] !== undefined) allowed.add('add');
      for (const [path, v] of leaves(tpl)) {
        if (v === null) continue;
        expect([label, path, allowed.has(v)], `${label}: ${path} = ${JSON.stringify(v)}`).toEqual([label, path, true]);
      }
      expect(tpl['issuedAt']).toBe(NOW.toISOString());
      const shown = JSON.stringify([r['template'], r['fill'], r['context']]);
      for (const secret of secrets) expect(shown.includes(secret), `${label} carries ${secret}`).toBe(false);
      expect(JSON.stringify(r['fill'])).not.toMatch(/urn:wrd:/);
      // The shape never depends on what a graph says: one shape per intent and named argument, valued or probe.
      // (Whether a head binding is filled depends only on whether the record exists, which the manifest shows.)
      const key = `${c.intent}|${Object.keys(c.args).sort().join(',')}|${String(c.args['subject'] ?? '')}`;
      const shape = JSON.stringify([Object.keys(tpl).sort(), (r['fill'] as string[]).filter((f) => !['descriptorUrl', 'graphDigest', 'recordId'].includes(f))]);
      shapes.set(key, (shapes.get(key) ?? new Set()).add(shape));
    }
    expect(answered).toBeGreaterThan(cases.length - 4);
    for (const [key, s] of shapes) expect([key, s.size]).toEqual([key, 1]);
    expect(shapes.has('wrd:record-outcome|decision_iri|')).toBe(true);
    // The intents that read no record carry only their fixed shape.
    for (const intent of ['wrd:update-registry', 'wrd:capture-workflow', 'wrd:record-task-map', 'wrd:review-agent-run', 'wrd:grant-autonomy', 'wrd:holder-copy', 'wrd:read-records']) {
      const r = objOf(await h['wrd.envelope_template']!({ intent }));
      expect([intent, r['context']]).toEqual([intent, {}]);
      for (const [path, v] of leaves(r['template'])) if (v !== null) expect([intent, path, [intent, DEMO_POD, objOf(r['template'])['issuedAt'], objOf(r['template'])['nonce'], false].includes(v as string)]).toEqual([intent, path, true]);
    }

    // The same calls with a signed read, through wrd.read_envelope_template, are filled from the records: the read as an object, or as its JSON text.
    const read = await signedRead();
    const filled = async (intent: string, args: Obj, asText = false): Promise<Obj> => {
      const r = objOf(await h['wrd.read_envelope_template']!({ intent, ...args, read_envelope: asText ? JSON.stringify(read) : read }));
      expect([intent, r['kind'], r['contextWithheld']]).toEqual([intent, undefined, undefined]);
      return r;
    };
    // The GET form never takes one: it is refused (400) before anything is read, and nothing is filled.
    const inUrl = objOf(await h['wrd.envelope_template']!({ intent: 'wrd:classify-task', task_iri: tasks[0]?.['taskIri'], read_envelope: JSON.stringify(read) }));
    expect([inUrl['iep:refusalStatus'], inUrl['error'], inUrl['template']]).toEqual([400, 'A signed read is never sent in a URL.', undefined]);
    // Nor nested, in a key or a value, at any depth (an MCP client sends objects): every form it detects is refused, and the refusal repeats no signature.
    for (const args of [
      { filter: { [read.signature]: '' } }, { filter: [{ by: { [JSON.stringify(read)]: true } }] }, { [JSON.stringify(read)]: '' }, { [read.signature]: '' },
      { filter: { deep: [[[[[[[[[[[read.signature]]]]]]]]]]] } }, { filter: { by: { signature: 'anything' } } }, { filter: { 'read-envelope': {} } },
    ]) {
      const r = objOf(await h['wrd.envelope_template']!({ intent: 'wrd:read-records', ...args }));
      expect([Object.keys(args)[0], r['iep:refusalStatus'], r['error'], r['template'], JSON.stringify(r).includes(read.signature.slice(2, 40))])
        .toEqual([Object.keys(args)[0], 400, 'A signed read is never sent in a URL.', undefined, false]);
    }
    // A form it does not detect (the signature without its 0x) is not refused, and still is not read: the template holds only its fixed shape.
    const undetected = objOf(await h['wrd.envelope_template']!({ intent: 'wrd:read-records', filter: { [read.signature.slice(2)]: read.signature.slice(2) } }));
    expect([undetected['kind'], undetected['context'], Object.keys(objOf(undetected['template'])).sort()]).toEqual([undefined, {}, ['intent', 'issuedAt', 'nonce', 'podUrl']]);
    const valuedPlan = plans.find((p) => p['planKind'] === 'valued' && rows(p['tasks']).some((x) => x['changed'] === true));
    const changed = rows(objOf(valuedPlan)['tasks']).filter((x) => x['changed'] === true).map((x) => String(x['taskIri'])).sort();
    const valueT = await filled('wrd:value-plan', { plan_iri: objOf(valuedPlan)['planIri'] }, true);
    expect(Object.keys(objOf(objOf(objOf(valueT['template'])['inputs'])['tasks'])).sort()).toEqual(changed);
    expect(objOf(valueT['context'])['planKind']).toBe('valued');
    const probeDecision = must(decisions.find((d) => d['decisionKind'] === 'probe'), 'probe decision');
    const outcomeT = objOf((await filled('wrd:record-outcome', { decision_iri: probeDecision['decisionIri'] }))['template']);
    expect(rows(outcomeT['probeResults']).map((x) => x['windowStart'])).toEqual(rows(probeDecision['probes']).map(() => objOf(probeDecision['countersign'])['at']));
    const valuedDecision = must(decisions.find((d) => d['decisionKind'] === 'valued' && isObj(d['countersign'])), 'countersigned valued decision');
    expect(objOf(objOf((await filled('wrd:record-outcome', { decision_iri: valuedDecision['decisionIri'] }))['template'])['measured'])['windowStart']).toBe(objOf(valuedDecision['countersign'])['at']);
    const someTask = must(tasks.find((t) => t['status'] !== 'retired'), 'a current task');
    expect(objOf((await filled('wrd:classify-task', { task_iri: someTask['taskIri'] }))['template'])['taskTextSha256']).toBe(someTask['textSha256']);
    expect(objOf((await filled('wrd:agent-run', { task_iri: someTask['taskIri'] }))['template'])['taskKind']).toBe(someTask['taskKind']);
    expect(['revise', 'retire']).toContain(objOf((await filled('wrd:revise-task', { task_iri: someTask['taskIri'] }))['template'])['op']);

    // A signed read the bridge would refuse as a read is refused here too.
    const refusedWith = async (envelope: unknown): Promise<unknown> => objOf(await h['wrd.read_envelope_template']!({ intent: 'wrd:value-plan', plan_iri: objOf(valuedPlan)['planIri'], read_envelope: envelope }))['iep:refusalStatus'];
    expect(await refusedWith(await signedRead(demoWallet('zed')))).toBe(403);
    expect(await refusedWith(await signedRead(admin, new Date(NOW.getTime() - 3_600_000).toISOString()))).toBe(401);
    expect(await refusedWith('{not json')).toBe(400);
  }, 120_000);

  it('with a record key, no tuple behind an entity IRI can be recovered from the IRI\'s hashes on the pod\'s public bytes: not who is assigned which task, which agent works which kind of task, or which decision is a probe; the one link times give (a task\'s workflow) is the one README names', async () => {
    const { pod } = await walked();
    const admin = demoWallet('admin');
    const NOW = new Date('2027-06-01T00:00:00.000Z');
    const h = createWrdHandlers({
      fetchFn: pod.fetchFn, defaultPodUrl: DEMO_POD, now: () => NOW, platform: { wallet: demoWallet('platform', 'agent'), keyKind: 'demo' },
      adminAddresses: [admin.address], recordKey: DEMO_RECORD_KEY,
    });
    const payload = { intent: 'wrd:read-records', podUrl: DEMO_POD, issuedAt: NOW.toISOString(), nonce: 'keyed-iri-read-000001' };
    const all = objOf(await h['wrd.read_records']!({ envelope: { payload, signature: await signMessageRaw(admin, canonicalJson(payload)) } }));
    const members = rows(objOf(all['registry'])['members']);
    const addresses = members.map((m) => String(m['address']));
    const agents = members.filter((m) => m['softwareAgent'] === true).map((m) => String(m['address']));
    const kinds = rows(objOf(all['registry'])['taskKinds']).map((k) => String(k['slug']));
    const taskIris = rows(all['tasks']).map((t) => String(t['taskIri']));
    const planIris = rows(all['plans']).map((p) => String(p['planIri']));
    const valuations = rows(all['valuations']);
    const entities = [
      ...taskIris, ...planIris, ...rows(all['workflows']).map((w) => String(w['workflowIri'])), ...valuations.map((v) => String(v['valuationIri'])),
      ...rows(all['decisions']).map((d) => String(d['decisionIri'])), ...rows(all['grants']).map((g) => String(g['grantIri'])),
    ];
    expect([addresses.length > 5, agents.length > 0, kinds.length > 2, taskIris.length > 3, planIris.length > 2]).toEqual([true, true, true, true, true]);
    // Every tuple the bridge derives an entity IRI from, as an unkeyed hash would carry it.
    const tuples = new Map<string, string>();
    const add = (seed: string): void => { tuples.set(h16(seed), seed); };
    for (const x of [DEMO_POD, ...addresses, ...entities]) add(x);
    for (const t of taskIris) for (const a of addresses) add(`${t}|${a}`);
    for (const a of agents) for (const k of kinds) add(`${a}|${k}`);
    for (const k of kinds) add(`${DEMO_POD}|${k}`);
    for (const p of planIris) {
      add(`${p}|probe`);
      for (const v of valuations) add(`${p}|${String(v['valuationHash'])}`);
    }
    // Every byte of the operator pod a reader without the record key sees: descriptors and the manifest, not the sealed graphs.
    const open = [...pod.bodies.entries()].filter(([u]) => u.startsWith(DEMO_POD) && !u.startsWith(DEMO_HOLDER_POD) && !u.endsWith('.envelope.jose.json'));
    expect(open.length).toBeGreaterThan(50);
    expect(open.some(([u]) => u.endsWith('-graph.trig'))).toBe(false);
    const parsed = new Map<string, { kind: string; key: string | null; scope: string; id: string }>();
    for (const [, body] of open) {
      for (const m of body.matchAll(/urn:wrd:([a-z-]+):(?:k([0-9a-f]{8}):)?([0-9a-f]{16}):([0-9a-f]{16})/g)) {
        parsed.set(m[0], { kind: m[1] ?? '', key: m[2] ?? null, scope: m[3] ?? '', id: m[4] ?? '' });
      }
    }
    expect(parsed.size).toBeGreaterThan(40);
    const recovered: string[] = [];
    for (const [iri, { kind, scope, id }] of parsed) {
      // The registry's IRI is derived from the pod URL alone, which is public: it is never keyed (every bridge on the pod must find it).
      if (kind === 'registry') continue;
      for (const seg of [scope, id]) if (tuples.has(seg)) recovered.push(`${iri} ← ${tuples.get(seg) ?? ''}`);
    }
    expect(recovered).toEqual([]);
    // Every keyed IRI names the key it was derived under (its public fingerprint), and only the registry is unkeyed.
    const fingerprint = iriKeyFingerprint(entityIriKey(DEMO_RECORD_KEY));
    expect([...new Set([...parsed.values()].map((x) => `${x.kind === 'registry' ? 'registry' : 'entity'}:${x.key ?? 'unkeyed'}`))].sort()).toEqual([`entity:${fingerprint}`, 'registry:unkeyed']);
    // Segments are keyed with their kind and position: no segment value appears under two (kind, position) pairs. Within one pair, equal
    // segments are the scope a lookup selects by (records of one kind about one workflow, plan, agent or holder), as README and readExposure say.
    const INTENTIONALLY_SHARED: string[] = [];
    const uses = new Map<string, Set<string>>();
    for (const x of parsed.values()) {
      if (x.key === null) continue;
      for (const [position, seg] of [['scope', x.scope], ['id', x.id]] as const) uses.set(seg, (uses.get(seg) ?? new Set()).add(`${x.kind}.${position}`));
    }
    expect(uses.size).toBeGreaterThan(40);
    expect([...uses.entries()].filter(([, at]) => at.size > 1).map(([seg, at]) => `${seg}: ${[...at].sort().join(' = ')}`)).toEqual(INTENTIONALLY_SHARED);
    // The kinds whose scope the bridge selects by are there, each scope shared within its kind only.
    const kindsSeen = new Set([...parsed.values()].map((x) => x.kind));
    for (const k of ['workflow', 'task', 'classification', 'plan', 'valuation', 'decision', 'acknowledgement', 'run', 'grant', 'holder-copy']) expect([k, kindsSeen.has(k)]).toEqual([k, true]);
    // What the IRIs hide, times can show: records one call writes share its instant. Only a workflow version and the tasks
    // captured, added or retired with it share one across kinds, which makes a task's workflow public (README, "Times link
    // what one call writes"; readExposure). Every other instant on the pod belongs to records of one kind.
    const kindsAt = new Map<string, Set<string>>();
    for (const [, body] of open) {
      const at = /prov:generatedAtTime\s+"([^"]+)"/.exec(body)?.[1];
      const kind = /iep:describes\s+<urn:wrd:([a-z-]+):/.exec(body)?.[1];
      if (at !== undefined && kind !== undefined) kindsAt.set(at, (kindsAt.get(at) ?? new Set()).add(kind));
    }
    expect(kindsAt.size).toBeGreaterThan(20);
    const crossKind = [...new Set([...kindsAt.values()].filter((k) => k.size > 1).map((k) => [...k].sort().join('+')))];
    expect(crossKind).toEqual(['task+workflow']);
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

  it('bridge/server.ts sends the operator pod credential only through operatorPodFetch, holder copies through plain fetch, and reads WRD_POD_WRITE_SECRET, WRD_RECORD_KEY and WRD_PUBLIC_READS nowhere else', () => {
    const server = read('../bridge/server.ts');
    expect(server).toMatch(/^const writeSecret = env\('WRD_POD_WRITE_SECRET'\);$/m);
    expect(server).toMatch(/fetchFn: operatorPodFetch\(defaultPodUrl, writeSecret, baseFetch\) as unknown as FetchFn,/);
    expect(server).toMatch(/holderFetchFn: baseFetch as unknown as FetchFn,/);
    expect(server).toMatch(/^const servedPods = list\(env\('WRD_SERVED_PODS'\) \?\? defaultPodUrl\);$/m);
    expect(server).toMatch(/recordKey = deriveEncryptionKeyPair\(recordKeyHex, 'wrd-records'\);/);
    expect(server).toMatch(/^const publicReads = env\('WRD_PUBLIC_READS'\) === '1';$/m);
    // The startup says whether a credential is configured and never prints it; without a record key it warns that records are plaintext.
    expect(server).toContain("pod credential: ${writeSecret ? 'configured");
    expect(server).not.toMatch(/\$\{writeSecret\}|\$\{recordKeyHex\}|\$\{recordKey\.secretKey\}/);
    expect(server).toMatch(/WARNING: no WRD_RECORD_KEY — records are written in PLAINTEXT/);
    // WRD_REQUIRE_RECORD_KEY is read as it is, never through env(): a blank value must not read as unset, which turns the guard off.
    expect(server).toMatch(/^const requireRecordKeyValue = process\.env\['WRD_REQUIRE_RECORD_KEY'\];$/m);
    expect(server).not.toMatch(/env\('WRD_REQUIRE_RECORD_KEY'\)/);
    expect(server).toMatch(/if \(requireRecordKeyValue !== undefined && requireRecordKeyValue !== '0' && requireRecordKeyValue !== '1'\) \{\n[^\n]*did not start: WRD_REQUIRE_RECORD_KEY is [^\n]*\n\s*process\.exit\(1\);/);
    expect(server).toMatch(/^const requireRecordKey = requireRecordKeyValue === '1';$/m);
    expect(server).toMatch(/if \(requireRecordKey && recordKeyHex === undefined\) \{\n[^\n]*WRD_REQUIRE_RECORD_KEY=1 and WRD_RECORD_KEY is not set[^\n]*\n\s*process\.exit\(1\);/);
    // WRD_REQUIRE_PLATFORM_KEY is read the same way, and the image requires a platform key as it requires a record key.
    expect(server).toMatch(/^const requirePlatformKeyValue = process\.env\['WRD_REQUIRE_PLATFORM_KEY'\];$/m);
    expect(server).not.toMatch(/env\('WRD_REQUIRE_PLATFORM_KEY'\)/);
    expect(server).toMatch(/if \(requirePlatformKeyValue !== undefined && requirePlatformKeyValue !== '0' && requirePlatformKeyValue !== '1'\) \{\n[^\n]*did not start: WRD_REQUIRE_PLATFORM_KEY is [^\n]*\n\s*process\.exit\(1\);/);
    expect(server).toMatch(/if \(requirePlatformKey && key === undefined\) \{\n[^\n]*WRD_REQUIRE_PLATFORM_KEY=1 and WRD_PLATFORM_KEY is not set[^\n]*\n\s*process\.exit\(1\);/);
    // The image requires a record key, declares it unset, and says to back it up.
    const dockerfile = readFileSync(new URL('../../../deploy/Dockerfile.wrd-bridge', import.meta.url), 'utf8');
    expect(dockerfile).toMatch(/^ENV WRD_REQUIRE_RECORD_KEY=1$/m);
    expect(dockerfile).toMatch(/^ENV WRD_REQUIRE_PLATFORM_KEY=1$/m);
    expect(dockerfile).toMatch(/^ENV WRD_PLATFORM_KEY=$/m);
    expect(dockerfile).toMatch(/^ENV WRD_RECORD_KEY=$/m);
    expect(dockerfile).toMatch(/#\s+WRD_RECORD_KEY\s[\s\S]*?BACK IT UP/);
    const vertical = fileURLToPath(new URL('..', import.meta.url));
    const files = (dir: string): string[] => readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? files(join(dir, e.name)) : e.name.endsWith('.ts') ? [join(dir, e.name)] : []));
    const others = files(vertical).filter((f) => f !== join(vertical, 'bridge', 'server.ts') && !f.startsWith(join(vertical, 'tests')));
    expect(others.length).toBeGreaterThan(8);
    const reads = /process\.env|env\(\s*'WRD_/;
    expect(others.filter((f) => reads.test(readFileSync(f, 'utf8'))).map((f) => relative(vertical, f))).toEqual([]);
  });

  it('the production server reads WRD_REQUIRE_RECORD_KEY as it is: unset or 0 starts with or without a record key, 1 starts only with a valid one (a blank key counts as missing), and any other value, blank or whitespace included, never starts: exit 1, saying why', async () => {
    const KEY = 'ab'.repeat(32);
    const cases: Array<readonly [string | undefined, string | undefined]> = [];
    for (const guard of [undefined, '0', '1', '', '  ', 'yes', ' 1']) for (const key of [undefined, KEY]) cases.push([guard, key]);
    // A blank or whitespace record key counts as missing where one is required; a malformed one stops the bridge whether or not one is.
    cases.push(['1', ''], ['1', '   '], ['1', 'abc'], [undefined, 'abc']);
    const runs = await startEach(cases.map(([guard, key]) => ({ ...(guard === undefined ? {} : { WRD_REQUIRE_RECORD_KEY: guard }), ...(key === undefined ? {} : { WRD_RECORD_KEY: key }) })));
    for (const [i, [guard, key]] of cases.entries()) {
      const r = must(runs[i], 'run');
      const label = `WRD_REQUIRE_RECORD_KEY=${JSON.stringify(guard)} WRD_RECORD_KEY=${JSON.stringify(key)}`;
      if (key === 'abc') {
        expect([label, r.started, r.status, /WRD_RECORD_KEY must be 64 hex characters/.test(r.stderr)]).toEqual([label, false, 1, true]);
      } else if (guard === undefined || guard === '0') {
        // No guard: it starts, sealed with a key and warning that records are plaintext without one.
        expect([label, r.started, /did not start/.test(r.stderr)]).toEqual([label, true, false]);
        expect([label, key === undefined ? /WARNING: no WRD_RECORD_KEY — records are written in PLAINTEXT/.test(r.stdout) : /records written from now on are sealed to the record key/.test(r.stdout)]).toEqual([label, true]);
      } else if (guard === '1') {
        if (key === KEY) {
          expect([label, r.started, /did not start/.test(r.stderr)]).toEqual([label, true, false]);
          expect([label, /records written from now on are sealed to the record key/.test(r.stdout)]).toEqual([label, true]);
        } else {
          expect([label, r.started, r.status, /did not start: WRD_REQUIRE_RECORD_KEY=1 and WRD_RECORD_KEY is not set/.test(r.stderr)]).toEqual([label, false, 1, true]);
        }
      } else {
        // Blank, whitespace or any other value: never read as unset, never as on; the bridge stops and says which.
        const said = guard.trim() === '' ? /did not start: WRD_REQUIRE_RECORD_KEY is blank; set it to 1 to require a record key, or to 0 \(or unset it\) to allow plaintext records/
          : /did not start: WRD_REQUIRE_RECORD_KEY is neither 1 nor 0; set it to 1 to require a record key, or to 0 \(or unset it\) to allow plaintext records/;
        expect([label, r.started, r.status, said.test(r.stderr)]).toEqual([label, false, 1, true]);
        expect([label, /listening on/.test(r.stdout)]).toEqual([label, false]);
      }
    }
  }, 300_000);

  it('the production server reads WRD_REQUIRE_PLATFORM_KEY as it is: unset or 0 starts with or without a platform key (an ephemeral one, said so, without), 1 starts only with a valid one (a blank key counts as missing), any other value, blank or whitespace included, never starts (exit 1, saying why), and a malformed platform key never starts', async () => {
    const KEY = `0x${'cd'.repeat(32)}`;
    const cases: Array<readonly [string | undefined, string | undefined]> = [];
    for (const guard of [undefined, '0', '1', '', '  ', 'yes']) for (const key of [undefined, KEY]) cases.push([guard, key]);
    cases.push(['1', ''], ['1', '   '], ['1', 'abc'], [undefined, 'abc']);
    const runs = await startEach(cases.map(([guard, key]) => ({ ...(guard === undefined ? {} : { WRD_REQUIRE_PLATFORM_KEY: guard }), ...(key === undefined ? {} : { WRD_PLATFORM_KEY: key }) })));
    const ADDRESS = importWallet(KEY, 'agent', 'p').address;
    for (const [i, [guard, key]] of cases.entries()) {
      const r = must(runs[i], 'run');
      const label = `WRD_REQUIRE_PLATFORM_KEY=${JSON.stringify(guard)} WRD_PLATFORM_KEY=${JSON.stringify(key)}`;
      if (key === 'abc') {
        expect([label, r.started, r.status, /did not start: WRD_PLATFORM_KEY must be 64 hex characters/.test(r.stderr)]).toEqual([label, false, 1, true]);
      } else if (guard === undefined || guard === '0') {
        expect([label, r.started, /did not start/.test(r.stderr)]).toEqual([label, true, false]);
        expect([label, key === undefined ? /using an EPHEMERAL platform key/.test(r.stdout) : r.stdout.includes(`(platform ${ADDRESS}, configured;`)]).toEqual([label, true]);
      } else if (guard === '1') {
        if (key === KEY) {
          expect([label, r.started, /did not start/.test(r.stderr), r.stdout.includes(`(platform ${ADDRESS}, configured;`)]).toEqual([label, true, false, true]);
        } else {
          expect([label, r.started, r.status, /did not start: WRD_REQUIRE_PLATFORM_KEY=1 and WRD_PLATFORM_KEY is not set/.test(r.stderr)]).toEqual([label, false, 1, true]);
          expect([label, /EPHEMERAL/.test(r.stdout)]).toEqual([label, false]);
        }
      } else {
        const said = guard.trim() === '' ? /did not start: WRD_REQUIRE_PLATFORM_KEY is blank; set it to 1 to require a platform key, or to 0 \(or unset it\) to allow an ephemeral one/
          : /did not start: WRD_REQUIRE_PLATFORM_KEY is neither 1 nor 0; set it to 1 to require a platform key, or to 0 \(or unset it\) to allow an ephemeral one/;
        expect([label, r.started, r.status, said.test(r.stderr)]).toEqual([label, false, 1, true]);
        expect([label, /listening on/.test(r.stdout)]).toEqual([label, false]);
      }
    }
  }, 300_000);

  it('the web UI, run in a DOM against a demo-composed bridge, signs one read per signer and reuses it, sending it only in a POST body, never in a URL; a signer with no role is refused and can switch back; with nothing to sign it meets the 401', async () => {
    const pod = memoryPod();
    const clock = demoClock();
    const seed = (id: string) => importWallet(`0x${sha256Hex(`wrd-ui-dom:${id}`)}`, 'human', id);
    const admin = seed('admin');
    const ana = seed('ana');
    const zed = seed('zed');
    const handlers = createWrdHandlers({
      fetchFn: pod.fetchFn, defaultPodUrl: DEMO_POD, now: () => clock.now(), platform: { wallet: seed('platform'), keyKind: 'demo' }, adminAddresses: [admin.address],
      recordKey: DEMO_RECORD_KEY,
      demoPersonas: new Map([['ana', { id: 'ana', label: 'Ana (demo)', wallet: ana }], ['zed', { id: 'zed', label: 'Zed (demo)', wallet: zed }]]),
    });
    const payload = {
      intent: 'wrd:update-registry', podUrl: DEMO_POD, issuedAt: clock.now().toISOString(), nonce: 'ui-dom-registry-0001',
      entries: [{ address: ana.address, roles: ['operator', 'worker'], label: 'Ana', softwareAgent: false, personRef: 'p-ana' }],
      taskKinds: [{ slug: 'invoice-matching', label: 'Invoice matching', definition: 'Match an invoice to its purchase order.' }],
    };
    const registered = await handlers['wrd.update_registry']!({ envelope: { payload, signature: await signMessageRaw(admin, canonicalJson(payload)) } }) as Record<string, unknown>;
    expect(registered['status']).toBe('registered');
    // One task to classify, so the page offers "What this signs".
    const capture = {
      intent: 'wrd:capture-workflow', podUrl: DEMO_POD, issuedAt: clock.now().toISOString(), nonce: 'ui-dom-capture-00001',
      workflow: { title: 'Accounts payable', unitLabel: 'invoice' },
      tasks: [{ name: 'Match invoices', description: 'Three-way match before approval.', currentLevel: 'person', personAddress: ana.address, taskKind: 'invoice-matching' }],
    };
    const captured = await handlers['wrd.capture_workflow']!({ envelope: { payload: capture, signature: await signMessageRaw(ana, canonicalJson(capture)) } }) as Record<string, unknown>;
    expect(captured['status']).toBe('captured');
    const l = await listenLoopback(createVerticalBridge({
      verticalName: 'work-redesign', affordances: [...wrdAffordances, ...wrdDemoAffordances], handlers, deploymentUrl: 'http://127.0.0.1', middleware: (a) => { attachUi(a, { base: 'http://127.0.0.1' }); parseEveryQueryPair(a); },
    }));
    listeners.push(l);

    const page = await openUi(l.base);
    await page.until(() => page.text().includes('Platform signer'), 'the records');
    const reads = (): Array<{ method: string; path: string; body: Record<string, unknown> }> => page.log.filter((r) => /\/wrd\/(read_records|read_calibration|list_records|calibration|demo_envelope)/.test(r.path));
    // The persona list, then one signed read: template, signature, read. Never the unsigned read model.
    expect(reads().map((r) => `${r.method} ${r.path}`)).toEqual(['POST /wrd/demo_envelope', 'POST /wrd/demo_envelope', 'POST /wrd/read_records']);
    expect(page.log.some((r) => r.path === '/wrd/envelope_template' && r.query.includes('intent=wrd%3Aread-records'))).toBe(true);
    const firstEnvelope = JSON.stringify(reads()[2]?.body['envelope']);
    expect(JSON.parse(firstEnvelope)).toMatchObject({ payload: { intent: 'wrd:read-records', podUrl: DEMO_POD } });
    expect(page.text()).toContain('Reads through this bridge need a signed read');

    // Re-reading, and the calibration view, reuse the same signed read: no new signature.
    const before = reads().length;
    page.click('Re-read the pod');
    await page.until(() => reads().length >= before + 1, 'the re-read');
    page.click('Calibration');
    await page.until(() => reads().length >= before + 3 && page.text().includes('Calibration'), 'the calibration read');
    const again = reads().slice(before);
    expect(again.map((r) => `${r.method} ${r.path}`)).toEqual(['POST /wrd/read_records', 'POST /wrd/read_records', 'POST /wrd/read_calibration']);
    expect(again.every((r) => JSON.stringify(r.body['envelope']) === firstEnvelope)).toBe(true);

    // Zed holds no role: his signed read is refused, and the page still offers the persona picker to switch back.
    page.select('#persona', 'zed');
    await page.until(() => page.text().includes('Only an admin or a key in this pod'), 'the refusal');
    expect(page.q('#persona')).not.toBeNull();
    const zedReads = reads().length;
    page.select('#persona', 'ana');
    await page.until(() => page.text().includes('Platform signer'), 'the records again');
    // Ana's read is still fresh: reused for the records and the calibration view still open, not signed again.
    const back = reads().slice(zedReads);
    expect(back.map((r) => `${r.method} ${r.path}`)).toEqual(['POST /wrd/read_records', 'POST /wrd/read_calibration']);
    expect(back.every((r) => JSON.stringify(r.body['envelope']) === firstEnvelope)).toBe(true);

    // "What this signs" with Ana's fresh read: the read goes in the POST body of wrd.read_envelope_template, and the template comes back filled.
    page.click('Tasks');
    await page.until(() => page.text().includes('Match invoices'), 'the task');
    page.click('Classify');
    await page.until(() => page.text().includes('Sign the answers'), 'the classify panel');
    const beforeTemplate = page.log.length;
    page.click('What this signs');
    await page.until(() => page.text().includes('Template, filled from the pod'), 'the template');
    const templateCalls = page.log.slice(beforeTemplate).filter((r) => /envelope_template/.test(r.path));
    expect(templateCalls.map((r) => `${r.method} ${r.path} ${r.status}`)).toEqual(['POST /wrd/read_envelope_template 200']);
    expect(JSON.stringify(templateCalls[0]?.body['read_envelope'])).toBe(firstEnvelope);
    expect(templateCalls[0]?.body['intent']).toBe('wrd:classify-task');
    expect(page.text()).not.toContain('Withheld:');
    expect(page.text()).toMatch(/"taskTextSha256": "[0-9a-f]{64}"/);
    // No request the page made, of any kind, carried a signed read in its URL.
    expect(page.log.filter((r) => r.query.includes('read_envelope') || r.path.includes('read_envelope=')).map((r) => `${r.method} ${r.path}${r.query}`)).toEqual([]);
    expect(page.log.some((r) => r.method === 'GET' && r.path === '/wrd/envelope_template')).toBe(true);
    expect(page.errors).toEqual([]);

    // A production composition and a browser with no wallet: nothing can sign, and the unsigned read model answers 401.
    const prod = await listenLoopback(createVerticalBridge({
      verticalName: 'work-redesign', affordances: wrdAffordances, deploymentUrl: 'http://127.0.0.1', middleware: (a) => { attachUi(a, { base: 'http://127.0.0.1' }); parseEveryQueryPair(a); },
      handlers: createWrdHandlers({ fetchFn: pod.fetchFn, defaultPodUrl: DEMO_POD, now: () => clock.now(), recordKey: DEMO_RECORD_KEY, adminAddresses: [admin.address] }),
    }));
    listeners.push(prod);
    const bare = await openUi(prod.base);
    await bare.until(() => bare.text().includes('needs a signed read'), 'the 401');
    expect(bare.log.filter((r) => r.path.startsWith('/wrd/')).map((r) => `${r.method} ${r.path} ${r.status}`)).toEqual(['GET /wrd/list_records 401']);
    expect(bare.text()).toContain('No wallet: this browser has no EIP-191 wallet');
    expect(bare.errors).toEqual([]);
  }, 60_000);

  it('the web UI never shows a chain cut short as whole: with a decision\'s and a grant\'s first versions gone, the decision card and its printed summary head the chain as incomplete with why in a badbox beside the heading, the grant\'s row says why, and the header counts both cuts; a whole chain is headed as every version', async () => {
    // The walked pod, copied, so the versions removed here are removed from this test's pod alone.
    const pod = memoryPod();
    for (const [url, body] of (await walked()).pod.bodies) await pod.fetchFn(url, { method: 'PUT', body });
    const NOW = new Date('2027-06-01T00:00:00.000Z');
    const ana = demoWallet('ana');
    const handlers = createWrdHandlers({
      fetchFn: pod.fetchFn, defaultPodUrl: DEMO_POD, now: () => NOW, platform: { wallet: demoWallet('platform', 'agent'), keyKind: 'demo' },
      adminAddresses: [demoWallet('admin').address], recordKey: DEMO_RECORD_KEY, demoPersonas: new Map([['ana', { id: 'ana', label: 'Ana (demo)', wallet: ana }]]),
    });
    let n = 0;
    const readModel = async (): Promise<Obj> => {
      n += 1;
      const payload = { intent: 'wrd:read-records', podUrl: DEMO_POD, issuedAt: NOW.toISOString(), nonce: `chain-cut-read-${String(n).padStart(6, '0')}` };
      const all = objOf(await handlers['wrd.read_records']!({ envelope: { payload, signature: await signMessageRaw(ana, canonicalJson(payload)) } }));
      expect(all['status']).toBe('listed');
      return all;
    };
    const before = await readModel();
    expect([...rows(before['decisions']), ...rows(before['grants'])].filter((x) => x['chainUnreadable'] !== undefined)).toEqual([]);
    const decisions = rows(before['decisions']);
    const cutAt = decisions.findIndex((d) => rows(d['chain']).length >= 2);
    const wholeAt = decisions.findIndex((d, i) => i !== cutAt);
    expect([cutAt >= 0, wholeAt >= 0]).toEqual([true, true]);
    const cutDecision = must(decisions[cutAt], 'a decision with an earlier version');
    const firstOf = (chain: Obj[]): string => String(must([...chain].sort((a, b) => Number(a['version']) - Number(b['version']))[0], 'its first version')['descriptorUrl']);
    const revoked = must(rows(before['grants']).find((g) => g['status'] === 'revoked'), 'the revoked grant');
    const grantHead = String(objOf(revoked['head'])['descriptorUrl']);
    const grantFirst = must(must((await walkManifest(DEMO_POD, pod.fetchFn)).entries.find((e) => e.descriptorUrl === grantHead), 'the grant head\'s entry').supersedes?.[0], 'the grant\'s first version');
    // A party with write access to the pod deletes the first version of each: the walk back from the current version stops short.
    for (const url of [firstOf(rows(cutDecision['chain'])), grantFirst]) {
      expect((await pod.fetchFn(url, { method: 'DELETE' })).status).toBe(204);
    }
    const after = await readModel();
    const cutRow = must(rows(after['decisions']).find((d) => d['decisionIri'] === cutDecision['decisionIri']), 'the cut decision');
    const grantRow = must(rows(after['grants']).find((g) => g['grantIri'] === revoked['grantIri']), 'the cut grant');
    const decisionWhy = String(cutRow['chainUnreadable']);
    const grantWhy = String(grantRow['chainUnreadable']);
    expect([decisionWhy, grantWhy]).toEqual([expect.stringMatching(/^the chain below is incomplete: /), expect.stringMatching(/^grantedAt may be missing: /)]);
    const cuts = [...rows(after['decisions']), ...rows(after['grants'])].filter((x) => x['chainUnreadable'] !== undefined);
    expect(cuts.length).toBe(2);
    expect(rows(after['decisions'])[wholeAt]?.['chainUnreadable']).toBeUndefined();

    const l = await listenLoopback(createVerticalBridge({
      verticalName: 'work-redesign', affordances: [...wrdAffordances, ...wrdDemoAffordances], handlers, deploymentUrl: 'http://127.0.0.1', middleware: (a) => { attachUi(a, { base: 'http://127.0.0.1' }); parseEveryQueryPair(a); },
    }));
    listeners.push(l);
    const page = await openUi(l.base);
    await page.until(() => page.text().includes('Platform signer'), 'the records');
    // The header counts every chain cut short, in a badbox.
    const CUTS = '2 record chain(s) do not read back to their first version: an earlier version is missing, or is not trusted. Their history is shown as incomplete, never as whole.';
    expect(page.all('header.strip p.badbox').map((p) => p.textContent)).toContain(CUTS);

    // The cut decision's card: the heading says the chain is incomplete, and why sits beside it in a badbox.
    const CUT_HEADING = 'Versions of this decision read so far: not every version (the chain is incomplete)';
    const WHOLE_HEADING = 'Every version of this decision';
    page.click('Decisions');
    await page.until(() => page.all('main table button').filter((b) => b.textContent === 'Open').length === decisions.length, 'the decisions');
    // The versions' table, as the UI's table() wraps it.
    const versionsTable = (el: Element | null | undefined): boolean => el?.className === 'scroll' && el.firstElementChild?.tagName === 'TABLE';
    const openAt = (i: number): void => { (must(page.all('main table button').filter((b) => b.textContent === 'Open' || b.textContent === 'Hide')[i], `decision ${i}`) as HTMLButtonElement).click(); };
    openAt(cutAt);
    const heading = await page.until(() => page.all('main .card h3').find((x) => x.textContent === CUT_HEADING), 'the cut chain\'s heading');
    expect(page.all('main .card h3').map((x) => x.textContent)).not.toContain(WHOLE_HEADING);
    const beside = must(heading.nextElementSibling, 'the element after the heading');
    expect([beside.tagName, beside.className, beside.textContent]).toEqual(['P', 'badbox small', decisionWhy]);
    expect(versionsTable(beside.nextElementSibling)).toBe(true);
    // Its printed summary says the same, before the versions it lists.
    page.click('Print summary');
    const printed = await page.until(() => page.all('#print h2').find((x) => x.textContent === CUT_HEADING), 'the printed heading');
    expect(page.all('#print h2').map((x) => x.textContent)).not.toContain(WHOLE_HEADING);
    const printedWhy = must(printed.nextElementSibling, 'the element after the printed heading');
    expect([printedWhy.tagName, printedWhy.className, printedWhy.textContent]).toEqual(['P', 'badbox', `Not every version: the chain is incomplete. ${decisionWhy}`]);
    expect(versionsTable(printedWhy.nextElementSibling)).toBe(true);

    // A whole chain keeps its heading, with no badbox, on the card and in print.
    openAt(cutAt);
    openAt(wholeAt);
    const whole = await page.until(() => page.all('main .card h3').find((x) => x.textContent === WHOLE_HEADING), 'the whole chain\'s heading');
    expect(page.all('main .card h3').map((x) => x.textContent)).not.toContain(CUT_HEADING);
    expect(versionsTable(whole.nextElementSibling)).toBe(true);
    page.click('Print summary');
    await page.until(() => page.all('#print h2').some((x) => x.textContent === WHOLE_HEADING), 'the whole chain printed');
    expect(page.all('#print .badbox')).toEqual([]);

    // The grant's row says why its grantedAt may be missing.
    page.click('Agents & grants');
    await page.until(() => page.text().includes('Evaluate and grant'), 'the grants');
    expect(page.all('main table td .badbox').map((x) => x.textContent)).toEqual([grantWhy]);
    expect(page.errors).toEqual([]);
  }, 180_000);

  it('the web UI still offers a signer whose read is refused their copy: someone removed from the registry downloads every record about their work from the no-data screen; and a line cut by a platform key the bridge no longer trusts is named in the header', async () => {
    const pod = memoryPod();
    const clock = demoClock();
    const seed = (id: string, type: 'human' | 'agent' = 'human') => importWallet(`0x${sha256Hex(`wrd-ui-holder:${id}`)}`, type, id);
    const admin = seed('admin');
    const ana = seed('ana');
    const cy = seed('cy');
    const oldKey = seed('platform-old', 'agent');
    const newKey = seed('platform-new', 'agent');
    const personas = new Map([['ana', { id: 'ana', label: 'Ana (demo)', wallet: ana }], ['cy', { id: 'cy', label: 'Cy (demo)', wallet: cy }]]);
    const compose = (platform: typeof oldKey, trusted: readonly string[]) => createWrdHandlers({
      fetchFn: pod.fetchFn, defaultPodUrl: DEMO_POD, now: () => clock.now(), platform: { wallet: platform, keyKind: 'demo' }, adminAddresses: [admin.address],
      recordKey: DEMO_RECORD_KEY, demoPersonas: personas, trustedPlatformAddresses: trusted,
    });
    let n = 0;
    const signed = async (who: typeof ana, intent: string, fields: Obj): Promise<Obj> => {
      n += 1;
      const payload = { intent, podUrl: DEMO_POD, issuedAt: clock.now().toISOString(), nonce: `ui-holder-${String(n).padStart(8, '0')}`, ...fields };
      return { payload, signature: await signMessageRaw(who, canonicalJson(payload)) };
    };
    const person = (w: typeof ana, label: string, roles: string[]) => ({ address: w.address, roles, label, softwareAgent: false, personRef: `p-${label.toLowerCase()}` });
    // Under the old platform key: the registry, and a workflow Cy captures.
    const before = compose(oldKey, []);
    expect(objOf(await before['wrd.update_registry']!({ envelope: await signed(admin, 'wrd:update-registry', {
      entries: [person(ana, 'Ana', ['operator', 'worker']), person(cy, 'Cy', ['operator', 'worker'])],
      taskKinds: [{ slug: 'invoice-matching', label: 'Invoice matching', definition: 'Match an invoice to its purchase order.' }],
    }) }))['status']).toBe('registered');
    expect(objOf(await before['wrd.capture_workflow']!({ envelope: await signed(cy, 'wrd:capture-workflow', {
      workflow: { title: 'Accounts payable', unitLabel: 'invoice' },
      tasks: [{ name: 'Match invoices', description: 'Three-way match before approval.', currentLevel: 'person', personAddress: cy.address, taskKind: 'invoice-matching' }],
    }) }))['status']).toBe('captured');
    // The key is rotated (the old one still trusted), and Cy leaves: the new key writes the registry version that removes her.
    const rotated = compose(newKey, [oldKey.address]);
    expect(objOf(await rotated['wrd.update_registry']!({ envelope: await signed(admin, 'wrd:update-registry', { entries: [{ address: cy.address, roles: [] }] }) }))['status']).toBe('registered');

    const serve = async (handlers: ReturnType<typeof compose>): Promise<string> => {
      const l = await listenLoopback(createVerticalBridge({
        verticalName: 'work-redesign', affordances: [...wrdAffordances, ...wrdDemoAffordances], handlers, deploymentUrl: 'http://127.0.0.1', middleware: (a) => { attachUi(a, { base: 'http://127.0.0.1' }); parseEveryQueryPair(a); },
      }));
      listeners.push(l);
      return l.base;
    };
    const page = await openUi(await serve(rotated));
    await page.until(() => page.text().includes('Platform signer'), 'the records');
    expect(page.all('header.strip p.badbox').map((p) => p.textContent).join(' ')).not.toMatch(/no longer trusts/);
    // Cy: her read is refused, and the no-data screen still offers her copy.
    page.select('#persona', 'cy');
    await page.until(() => page.text().includes('Only an admin or a key in this pod'), 'the refusal');
    const HOLDER = 'Your read was refused, but anyone named in a record, or who signed one, can still take a copy of every record about their work, registered here or not.';
    expect(page.text()).toContain(HOLDER);
    expect(page.all('h2').map((x) => x.textContent)).toContain('My record');
    const beforeCopy = page.log.length;
    page.click('Download my record');
    await page.until(() => page.saved.length === 1, 'the download');
    const copyCalls = page.log.slice(beforeCopy).filter((r) => r.path === '/wrd/holder_copy');
    expect(copyCalls.map((r) => `${r.method} ${r.path} ${r.status}`)).toEqual(['POST /wrd/holder_copy 200']);
    expect(objOf(copyCalls[0]?.body['envelope'])['payload']).toMatchObject({ intent: 'wrd:holder-copy', podUrl: DEMO_POD });
    const file = JSON.parse(await page.readSaved(0)) as Obj;
    expect(rows(file['bundle']).length).toBeGreaterThan(0);
    await page.until(() => page.text().includes('record version(s) in the download'), 'the answer');
    expect(page.text()).toContain(`This bridge signs as ${newKey.address.toLowerCase()}`);
    // The answer stays on screen: the re-read after it, refused again, does not replace it.
    expect(page.text()).not.toContain('Only an admin or a key in this pod');
    expect(page.errors).toEqual([]);

    // The old address dropped: the registry's line is cut there, and the header says so, naming the address.
    const alone = await openUi(await serve(compose(newKey, [])));
    const TRUST = new RegExp(`^1 of them reach a version signed by a platform key this bridge no longer trusts \\(${oldKey.address.toLowerCase()}\\)\\. Every change to them is refused \\(409\\) until the operator lists that address in WRD_TRUSTED_PLATFORM_ADDRESSES again`);
    await alone.until(() => alone.text().includes('Platform signer'), 'the records');
    const banners = alone.all('header.strip p.badbox').map((p) => p.textContent ?? '');
    expect(banners).toContain('1 record chain(s) do not read back to their first version: an earlier version is missing, or is not trusted. Their history is shown as incomplete, never as whole.');
    expect(banners.some((b) => TRUST.test(b))).toBe(true);
    expect(alone.errors).toEqual([]);
  }, 120_000);

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
    expect(server).toMatch(/^const HOST = env\('HOST'\) \?\? '127\.0\.0\.1';$/m);
    expect(server).toMatch(/^const loopback = isLoopbackBind\(HOST\);$/m);
    // It binds the HOST the guard decision was made from. The only other bind is 0.0.0.0, after `::`
    // failed on a host without IPv6, and neither of those is a loopback name.
    expect(server).toMatch(/^listen\(HOST\);$/m);
    expect(server.match(/app\.listen\(/g)).toHaveLength(1);
    expect(server).toMatch(/app\.listen\(PORT, host, /);
    expect(server).toMatch(/if \(host === '::' && \(err as NodeJS\.ErrnoException\)\.code === 'EAFNOSUPPORT'\) \{ listen\('0\.0\.0\.0'\); return; \}/);
    // The first statement of the hook, so the guard stands in front of the ontology, the UI and every route the factory mounts after it.
    expect(server).toMatch(/middleware: \(a\) => \{\n(?:\s*\/\/[^\n]*\n)*\s*if \(loopback\) a\.use\(hostAllowlistGuard\(servedHostNames\(PORT, base\)\)\);\n/);
    expect(demo).toMatch(/middleware: \(a\) => \{\n(?:\s*\/\/[^\n]*\n)*\s*a\.use\(hostAllowlistGuard\(servedHostNames\(port, base\)\)\);\n\s*attachUi\(a, \{ base \}\);/);
    // Both parse every query parameter, so the GET template's signed-read check sees past the default parser's first 1000 pairs.
    for (const src of [server, demo]) expect(/middleware: \(a\) => \{\n([\s\S]*?)\n\s*\},\n/.exec(src)?.[1]).toMatch(/^\s*parseEveryQueryPair\(a\);$/m);
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
