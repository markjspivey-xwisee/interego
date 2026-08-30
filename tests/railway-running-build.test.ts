/**
 * THE AUDIT REPORTED THE PIN AND CALLED IT THE RUNNING BUILD.
 *
 * ── ★★ THE FALSE GREEN ───────────────────────────────────────────────────────
 *
 * OBSERVED during the 2026-08-29 rollout. `tools/railway-fleet-audit.ts` printed "Every
 * service is running the image master would build for it." and exited 0 while `bridge` was
 * serving the PREVIOUS commit. `tools/railway-pins.mjs` showed exactly why and could not
 * have warned anyone: bridge was DEPLOYING with FRESH=current, and `current` means RAILWAY
 * IS POINTED AT THE RIGHT IMAGE. Every axis the audit had — repository, freshness, bundle
 * scope, deploy dates, caps, replicas — describes the pointer. Nothing asked a service what
 * it was running.
 *
 * The two shas below are the live ones, read off the fleet on 2026-08-29 — master's tip and
 * the commit eleven services still run — and the statuses are the ones Railway reports, so
 * the first case IS the defect rather than a paraphrase of it.
 *
 * ── WHAT THESE CASES PIN ─────────────────────────────────────────────────────
 *
 *  · three live states are distinguished, not two: running / ROLLING / NOT-RUNNING;
 *  · a service that cannot be asked is `unaskable` — named, excluded from the green
 *    sentence, and NOT a disagreement, because four permanently red rows is the failure
 *    mode the scheduled workflow was split out of the deploy path to escape;
 *  · a service that COULD have been asked and did not answer IS a disagreement, because a
 *    check that cannot tell must not report fine;
 *  · the headline sentence is DERIVED from the reports, so it cannot claim more than was
 *    checked;
 *  · the URL asked of each service is the one derived for THAT service — asserted on the
 *    raw URLs the probe requested, not on the verdict it returned.
 */
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  askRunningBuilds, classifyRunning, isRunningDisagreement, readRunningBuild, runningHeadline,
  runningTargetFor,
} from '../tools/railway-running-build.js';
import type { RunningReport } from '../tools/railway-running-build.js';
import { annotate } from '../tools/railway-pins.mjs';
import type { PinRow } from '../tools/railway-pins.mjs';

const PREFIX = 'ghcr.io/markjspivey-xwisee';
/** The live shas on 2026-08-29: master's tip, and the commit eleven services still ran. */
const MASTER = '43cbe0cba6483f6f46d65a7126d60830b237cde9';
const PREVIOUS = '0f78e56ad13835057e424df0f1c2c57ddd5f5a82';

/** A row as collectPins builds one: annotate() fills repo/tag/tagKind/agreement/builtHere. */
function row(service: string, tag: string, status: string, repo?: string): PinRow {
  return annotate({
    service,
    serviceId: `id-${service}`,
    image: `${PREFIX}/${repo ?? `interego-${service}`}:${tag}`,
    status,
  });
}

describe('what is the service actually running?', () => {
  it('★ the bridge case: pinned to master, DEPLOYING, still serving the previous commit', () => {
    const r = classifyRunning(row('bridge', MASTER, 'DEPLOYING'), {
      kind: 'answered', url: 'https://bridge.interego.xwisee.com/health', build: PREVIOUS,
    });
    expect(r.verdict).toBe('ROLLING');
    expect(isRunningDisagreement(r)).toBe(true);
    // The operator has to be able to see BOTH shas, or the finding is unactionable.
    expect(r.reason).toContain(MASTER.slice(0, 12));
    expect(r.reason).toContain(PREVIOUS.slice(0, 12));
    expect(r.build).toBe(PREVIOUS);
  });

  it('a settled deployment serving something other than its pin is NOT-RUNNING, not ROLLING', () => {
    const r = classifyRunning(row('bridge', MASTER, 'SUCCESS'), {
      kind: 'answered', url: 'https://bridge.interego.xwisee.com/health', build: PREVIOUS,
    });
    // The distinction is the whole diagnosis: SUCCESS means Railway bound a port, and a
    // pull that failed leaves the OLD container serving and answering 200.
    expect(r.verdict).toBe('NOT-RUNNING');
    expect(isRunningDisagreement(r)).toBe(true);
  });

  it('an unknown deployment status is reported as settled, and names the status it saw', () => {
    const r = classifyRunning(row('bridge', MASTER, 'SOMETHING_NEW'), {
      kind: 'answered', url: 'https://bridge.interego.xwisee.com/health', build: PREVIOUS,
    });
    expect(r.verdict).toBe('NOT-RUNNING');
    expect(r.reason).toContain('SOMETHING_NEW');
  });

  it('a service answering with the build its pin names is running, and is no disagreement', () => {
    const r = classifyRunning(row('relay', MASTER, 'SUCCESS'), {
      kind: 'answered', url: 'https://relay.interego.xwisee.com/health', build: MASTER,
    });
    expect(r.verdict).toBe('running');
    expect(r.asked).toBe(true);
    expect(isRunningDisagreement(r)).toBe(false);
  });

  it('a legitimately-behind service running its own pin is still running', () => {
    // Eleven services sit on PREVIOUS because none of their shipped files changed —
    // `equivalent` on the freshness axis. This axis compares against the PIN, so that
    // verdict stays green here instead of being re-decided, differently, in two places.
    const r = classifyRunning(row('microsite', PREVIOUS, 'SUCCESS'), {
      kind: 'answered', url: 'https://microsite.interego.xwisee.com/health', build: PREVIOUS,
    });
    expect(r.verdict).toBe('running');
  });

  it('a health body with no build field is a can-not-tell, and can-not-tell is not fine', () => {
    const r = classifyRunning(row('relay', MASTER, 'SUCCESS'), {
      kind: 'answered', url: 'https://relay.interego.xwisee.com/health', build: null,
    });
    expect(r.verdict).toBe('NO-BUILD-FIELD');
    expect(isRunningDisagreement(r)).toBe(true);
  });

  it('a service that could have been asked and did not answer is a disagreement', () => {
    const r = classifyRunning(row('relay', MASTER, 'SUCCESS'), {
      kind: 'unreachable', url: 'https://relay.interego.xwisee.com/health', reason: 'no response within 15000 ms',
    });
    expect(r.verdict).toBe('UNREACHABLE');
    expect(r.asked).toBe(false);
    expect(isRunningDisagreement(r)).toBe(true);
  });

  it('a service Railway reports no domain for is NO-HOST, which is a misconfiguration', () => {
    const target = runningTargetFor(row('relay', MASTER, 'SUCCESS'), []);
    expect(target.ok).toBe(false);
    if (target.ok) return;
    // NOT structural: relay declares a health path, so having nowhere to send the request
    // is a fault rather than a fact about the fleet.
    expect(target.structural).toBe(false);
    const r = classifyRunning(row('relay', MASTER, 'SUCCESS'), { kind: 'no-host', reason: target.reason });
    expect(r.verdict).toBe('NO-HOST');
    expect(isRunningDisagreement(r)).toBe(true);
  });
});

describe('the four services that cannot be asked', () => {
  // ★ Their names are the ones in tools/railway-services.mjs, and the reasons are two
  // different reasons: no reachable health path, and not built by this repository.
  it.each([
    ['css', PREVIOUS, 'interego-css-pgsl'],
    ['discord', MASTER, 'interego-discord'],
  ])('%s is portless: unaskable, named, and not a disagreement', (name, tag, repo) => {
    const target = runningTargetFor(row(name, tag, 'SUCCESS', repo), ['whatever.example']);
    expect(target.ok).toBe(false);
    if (target.ok) return;
    expect(target.structural).toBe(true);
    const r = classifyRunning(row(name, tag, 'SUCCESS', repo), { kind: 'unaskable', reason: target.reason });
    expect(r.verdict).toBe('unaskable');
    expect(r.asked).toBe(false);
    expect(isRunningDisagreement(r)).toBe(false);
  });

  it.each([['postgres', '16'], ['redis', '7-alpine']])(
    '%s runs an upstream image: unaskable rather than a mutable-tag alarm repeated here',
    (name, tag) => {
      const r0 = annotate({ service: name, serviceId: `id-${name}`, image: `${name}:${tag}`, status: 'SUCCESS' });
      expect(r0.builtHere).toBe(false);
      const target = runningTargetFor(r0, []);
      expect(target.ok).toBe(false);
      if (target.ok) return;
      expect(target.structural).toBe(true);
      const r = classifyRunning(r0, { kind: 'unaskable', reason: target.reason });
      expect(r.verdict).toBe('unaskable');
      expect(isRunningDisagreement(r)).toBe(false);
    });

  it('a service Railway does not have at all is left to the agreement axis, not double-reported', () => {
    const r = classifyRunning(
      annotate({ service: 'relay', missingFromRailway: true }),
      { kind: 'unaskable', reason: 'never asked' });
    expect(r.verdict).toBe('n/a');
    expect(isRunningDisagreement(r)).toBe(false);
  });
});

describe('the headline sentence is true of what was checked', () => {
  const reports = (): RunningReport[] => [
    classifyRunning(row('relay', MASTER, 'SUCCESS'),
      { kind: 'answered', url: 'https://relay.interego.xwisee.com/health', build: MASTER }),
    classifyRunning(row('microsite', PREVIOUS, 'SUCCESS'),
      { kind: 'answered', url: 'https://microsite.interego.xwisee.com/health', build: PREVIOUS }),
    classifyRunning(row('css', PREVIOUS, 'SUCCESS', 'interego-css-pgsl'),
      { kind: 'unaskable', reason: 'binds no externally reachable health path' }),
    classifyRunning(row('discord', MASTER, 'SUCCESS', 'interego-discord'),
      { kind: 'unaskable', reason: 'binds no externally reachable health path' }),
  ];

  it('counts only the services it actually asked', () => {
    // The old sentence said "Every service". This one cannot: the number comes from the
    // reports, so a service that was never contacted cannot be inside the claim.
    expect(runningHeadline(reports())).toContain('Asked 2 of 4 service(s)');
    expect(runningHeadline(reports())).toContain('all 2 answered with the build their pin names');
  });

  it('NAMES the services it could not ask, in the same breath as the green claim', () => {
    const text = runningHeadline(reports());
    expect(text).toContain('2 service(s) were NOT asked');
    expect(text).toContain('css');
    expect(text).toContain('discord');
  });

  it('does not count an unasked service as an answering one', () => {
    // The mutant this kills: `asked` set from "we had a target" rather than "it answered".
    const withDead = [...reports(), classifyRunning(row('bridge', MASTER, 'SUCCESS'),
      { kind: 'unreachable', url: 'https://bridge.interego.xwisee.com/health', reason: 'ECONNREFUSED' })];
    expect(runningHeadline(withDead)).toContain('Asked 2 of 5 service(s)');
  });

  it('★ cannot claim everything matched when something did not, whoever calls it', () => {
    /**
     * FOUND BY DRIVING IT, not by reading it. The first version asserted "all N answered
     * with the build their pin names" on every call, because the audit only calls it after
     * `bad.length === 0`. Printed unconditionally against the live fleet with one pin
     * doctored, it reported all fourteen fine directly above a NOT-RUNNING row — the same
     * defect class as the headline it replaced, one layer further in.
     */
    const withDrift = [...reports(), classifyRunning(row('bridge', MASTER, 'SUCCESS'),
      { kind: 'answered', url: 'https://bridge.interego.xwisee.com/health', build: PREVIOUS })];
    const text = runningHeadline(withDrift);
    expect(text).toContain('Asked 3 of 5 service(s)');
    expect(text).not.toContain('all 3');
    expect(text).toContain('2 answered with the build their pin names');
    expect(text).toContain('1 answered with something else: bridge');
  });
});

describe('every service is asked at ITS OWN derived URL', () => {
  it('derives one URL per service from that service own hosts, and asks exactly those', async () => {
    /**
     * ★ THE DOUBLES ANSWER DIFFERENTLY PER SERVICE, both of them. The defect this guards
     * is the one tools/railway-services.mjs was created to kill: a deploy of `identity`
     * that polled RELAY, matched, and printed "verified" without contacting identity. A
     * double that returns one host list, or one build, for every call cannot tell that
     * implementation from a correct one.
     */
    const hosts: Record<string, string[]> = {
      relay: ['relay.interego.xwisee.com', 'relay-production-53b7.up.railway.app'],
      identity: ['identity.interego.xwisee.com'],
      // No custom domain in the live fleet — only the generated host. If the derivation
      // preferred custom domains and gave up without one, this service would go NO-HOST.
      'wsp-bridge': ['wsp-bridge-production.up.railway.app'],
      // The gate answers on /healthz, not /health: /health there proxies to CSS and would
      // report the upstream's health as the gate's own.
      'css-gate': ['gate.interego.xwisee.com'],
    };
    const builds: Record<string, string> = {
      'https://relay.interego.xwisee.com/health': MASTER,
      'https://identity.interego.xwisee.com/health': PREVIOUS,
      'https://wsp-bridge-production.up.railway.app/health': MASTER,
      'https://gate.interego.xwisee.com/healthz': PREVIOUS,
    };
    const asked: string[] = [];
    const fetchImpl = (async (input: RequestInfo | URL) => {
      const url = String(input);
      asked.push(url);
      const build = builds[url];
      if (build === undefined) throw new Error(`no fixture for ${url}`);
      return new Response(JSON.stringify({ ok: true, build }), { status: 200 });
    }) as typeof fetch;

    const rows = [
      row('relay', MASTER, 'SUCCESS'),
      row('identity', PREVIOUS, 'SUCCESS'),
      row('wsp-bridge', MASTER, 'SUCCESS'),
      row('css-gate', PREVIOUS, 'SUCCESS', 'interego-css-gate'),
      row('css', PREVIOUS, 'SUCCESS', 'interego-css-pgsl'),
    ];
    const out = await askRunningBuilds(
      rows,
      async (r) => hosts[r.service] ?? [],
      { fetchImpl, attempts: 1 });

    // ★ ASSERTED ON THE URLS REQUESTED, not on the verdicts. A verdict can be right for
    // the wrong reason; the request list cannot.
    expect(asked.sort()).toEqual([
      'https://gate.interego.xwisee.com/healthz',
      'https://identity.interego.xwisee.com/health',
      'https://relay.interego.xwisee.com/health',
      'https://wsp-bridge-production.up.railway.app/health',
    ]);
    // css has no reachable health path, so it must not have been asked at all.
    expect(asked.some((u) => u.includes('css.'))).toBe(false);
    expect(out.map((r) => `${r.service}=${r.verdict}`)).toEqual([
      'relay=running', 'identity=running', 'wsp-bridge=running', 'css-gate=running', 'css=unaskable',
    ]);
  });

  it('a domains query that FAILS is unreachable, never an empty host list', async () => {
    // Collapsing the two would downgrade an unreadable service to NO-HOST and print a
    // confident wrong reason — "Railway reports no domain" about a query that errored.
    const out = await askRunningBuilds(
      [row('relay', MASTER, 'SUCCESS')],
      async () => { throw new Error('Project Token not found'); },
      { attempts: 1 });
    expect(out[0]?.verdict).toBe('UNREACHABLE');
    expect(out[0]?.reason).toContain('Project Token not found');
  });
});

/**
 * ── DRIVEN AGAINST A REAL SERVER ─────────────────────────────────────────────
 *
 * Everything above is a fold over an Observation. This boots a real HTTP server, makes
 * real requests with the real default `fetch`, and asserts on the RAW paths the server
 * recorded — because three defects in this repository this week passed every unit check
 * and were only caught over the wire.
 */
describe('reading a build over the wire', () => {
  let server: Server;
  let base = '';
  const seen: { raw: string; decoded: string }[] = [];
  /** Per-path scripted responses, so one server covers every case without a flag. */
  const script: Record<string, { status: number; body: string; type?: string }> = {};

  beforeAll(async () => {
    server = createServer((req, res) => {
      const raw = req.url ?? '';
      seen.push({ raw, decoded: decodeURIComponent(raw) });
      const s = script[raw] ?? { status: 404, body: '{}' };
      res.writeHead(s.status, { 'content-type': s.type ?? 'application/json' });
      res.end(s.body);
  /**
   * ★★ AN EXPLICIT BUDGET, BECAUSE THE DEFAULT IS SHORTER THAN THE CODE UNDER TEST IS ALLOWED
   * TO TAKE. `readRunningBuild` gives each attempt `timeoutMs ?? 15_000`, and vitest.config.ts
   * sets no `testTimeout`, so every case here inherited vitest's 5,000 ms default. On a loaded
   * machine that kills a round trip the tool considers perfectly healthy — observed in a full
   * `npx vitest run`, where three cases failed with an empty request log and `ok: false` while
   * the same file passed 24/24 in isolation.
   *
   * ★ A TEST CANNOT HAVE A SHORTER DEADLINE THAN THE OPERATION IT ASSERTS ON, or it stops
   * measuring the operation and starts measuring the machine. Nothing here is weakened: the
   * server, the request and every assertion on the RAW recorded path are unchanged.
   */
    });
    await new Promise<void>((r) => { server.listen(0, '127.0.0.1', r); });
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });
  afterAll(async () => { await new Promise<void>((r) => { server.close(() => r()); }); });

  it('reads the build sha out of a real response body', async () => {
    script['/health'] = { status: 200, body: JSON.stringify({ ok: true, build: MASTER }) };
    seen.length = 0;
    const out = await readRunningBuild(`${base}/health`, { attempts: 1 });
    expect(out).toEqual({ ok: true, build: MASTER });
    // The path is asserted raw AND decoded: an encoding bug that turns /health into
    // /%68ealth still reaches the same handler and would pass an assertion on the receipt.
    expect(seen).toEqual([{ raw: '/health', decoded: '/health' }]);
  }, 30_000);

  it('a 200 with no build field reads as no build, not as an error', async () => {
    script['/nobuild'] = { status: 200, body: JSON.stringify({ ok: true }) };
    const out = await readRunningBuild(`${base}/nobuild`, { attempts: 1 });
    expect(out).toEqual({ ok: true, build: null });
  }, 30_000);

  it('a 200 whose body is not JSON is reported once and NOT retried', async () => {
    // Asking an HTML page four more times produces four more pages of HTML.
    script['/html'] = { status: 200, body: '<!doctype html>', type: 'text/html' };
    seen.length = 0;
    const out = await readRunningBuild(`${base}/html`, { attempts: 3, sleep: async () => {} });
    expect(out.ok).toBe(false);
    expect(seen.filter((s) => s.raw === '/html')).toHaveLength(1);
  }, 30_000);

  it('a failing service is retried the declared number of times, then reported', async () => {
    script['/down'] = { status: 503, body: 'unavailable' };
    seen.length = 0;
    const out = await readRunningBuild(`${base}/down`, { attempts: 3, sleep: async () => {} });
    expect(out.ok).toBe(false);
    if (out.ok) return;
    expect(out.reason).toContain('HTTP 503');
    // ★ COUNTED AT THE SERVER. "It retried" asserted from the return value is a claim
    // about the message; this is a claim about the requests.
    expect(seen.filter((s) => s.raw === '/down')).toHaveLength(3);
  }, 30_000);

  it('a service that answers on the first try is asked exactly once', async () => {
    script['/once'] = { status: 200, body: JSON.stringify({ build: MASTER }) };
    seen.length = 0;
    await readRunningBuild(`${base}/once`, { attempts: 3, sleep: async () => {} });
    expect(seen.filter((s) => s.raw === '/once')).toHaveLength(1);
  }, 30_000);
});
