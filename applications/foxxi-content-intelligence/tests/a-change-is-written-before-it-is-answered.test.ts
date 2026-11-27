/**
 * A change is written before the call that made it is answered.
 *
 * ★ WHY. Three stores were marked changed and written two seconds later by a timer nothing waited
 * for: the SCORM sequencing sessions, what the cmi5 rollup has said, and the queue of statements a
 * forwarding target did not take. A process that stopped inside those two seconds lost the change
 * after answering for it, and a write the pod refused was told to nobody.
 *
 * The real `publish()` runs here against a stand-in pod.
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { deriveEncryptionKeyPair, type IRI } from '@interego/core';
import { FOXXI_SNAPSHOT_TYPES, dirty, keepSnapshot, loadLatestSnapshot, registerSnapshot } from '../src/pod-snapshot-publisher.js';
import { addForwardingTarget, forwardStatement, markForwardingHydrated, onForwardingQueueChange, retryDeadLetter } from '../src/lrs-forwarding.js';
import type { TenantId } from '../src/tenant-context.js';

const POD = 'https://pod.example/tenant/';
const SOURCE = 'did:web:tenant.example' as IRI;
const KEY = deriveEncryptionKeyPair('11'.repeat(32), `urn:foxxi:tenant-snapshot:v1:${POD}`);

class Pod {
  readonly files = new Map<string, string>();
  graphPuts = 0; inFlight = 0; mostAtOnce = 0; failGraph = false; delayMs = 0;
  readonly fetch: typeof globalThis.fetch = async (input, init) => {
    const url = String(input);
    const method = (init?.method ?? 'GET').toUpperCase();
    if (method === 'GET' || method === 'HEAD') {
      const body = this.files.get(url);
      return body === undefined ? new Response('', { status: 404 }) : new Response(method === 'HEAD' ? null : body, { headers: { etag: `"${body.length}"` } });
    }
    if (method !== 'PUT') return new Response('', { status: 405 });
    const graph = url.endsWith('-snapshot-graph.envelope.jose.json');
    if (graph) {
      this.graphPuts++; this.inFlight++; this.mostAtOnce = Math.max(this.mostAtOnce, this.inFlight);
      if (this.delayMs) await new Promise(r => setTimeout(r, this.delayMs));
      this.inFlight--;
      if (this.failGraph) return new Response('', { status: 500 });
    }
    const held = this.files.has(url);
    if (new Headers(init?.headers).get('if-none-match') === '*' && held) return new Response('', { status: 412 });
    this.files.set(url, String(init?.body ?? ''));
    return new Response('', { status: held ? 200 : 201 });
  };
}

let n = 0;
function surfaceOn(pod: Pod, sealKey: typeof KEY | null = KEY, debounceMs = 60_000) {
  const surface = `written-first-${++n}`;
  const state = { steps: [] as string[] };
  const config = { podUrl: POD, authoritativeSource: SOURCE, fetch: pod.fetch, ...(sealKey ? { sealKey } : {}) };
  registerSnapshot({ surface, typeIri: FOXXI_SNAPSHOT_TYPES.ScormSessions, collect: () => ({ steps: [...state.steps] }), config, debounceMs });
  return { surface, state, load: () => loadLatestSnapshot<typeof state>(surface, config) };
}

describe('keepSnapshot', () => {
  it('has written the change when it returns, with no timer', async () => {
    const pod = new Pod();
    const s = surfaceOn(pod);
    s.state.steps.push('one');
    expect(await keepSnapshot(s.surface)).toBe('kept');
    expect((await s.load())?.steps).toEqual(['one']);
  });

  it('says so when the pod does not take the write, and tries again later', async () => {
    const pod = new Pod();
    const s = surfaceOn(pod, KEY, 5);
    s.state.steps.push('one');
    pod.failGraph = true;
    expect(await keepSnapshot(s.surface)).toBe('not-kept');
    expect(await s.load()).toBeNull();
    pod.failGraph = false;
    await new Promise(r => setTimeout(r, 400));
    expect((await s.load())?.steps).toEqual(['one']);
  });

  it('tells a bridge that keeps nothing apart from a write that failed', async () => {
    const s = surfaceOn(new Pod(), null);
    expect(await keepSnapshot(s.surface)).toBe('unconfigured');
    expect(await keepSnapshot('no-such-surface')).toBe('unconfigured');
  });

  it('writes one surface one write at a time, and callers that arrive together share a write', async () => {
    const pod = new Pod();
    pod.delayMs = 30;
    const s = surfaceOn(pod);
    s.state.steps.push('one');
    const first = keepSnapshot(s.surface);            // collects ['one'] now
    await new Promise(r => setTimeout(r, 5));
    s.state.steps.push('two');
    const second = keepSnapshot(s.surface);           // waits its turn
    s.state.steps.push('three');
    const third = keepSnapshot(s.surface);            // shares the waiting write
    expect(await Promise.all([first, second, third])).toEqual(['kept', 'kept', 'kept']);
    expect(pod.mostAtOnce).toBe(1);
    expect(pod.graphPuts).toBe(2);
    // The last write is the one that landed, and it carries every change made before its turn.
    expect((await s.load())?.steps).toEqual(['one', 'two', 'three']);
  });

  it('does not overlap the debounce timer either', async () => {
    const pod = new Pod();
    pod.delayMs = 30;
    const s = surfaceOn(pod, KEY, 1);
    s.state.steps.push('one');
    dirty(s.surface);
    await new Promise(r => setTimeout(r, 10));        // the timer's write is in flight
    s.state.steps.push('two');
    expect(await keepSnapshot(s.surface)).toBe('kept');
    expect(pod.mostAtOnce).toBe(1);
    expect((await s.load())?.steps).toEqual(['one', 'two']);
  });
});

describe('the forwarding queue', () => {
  const STMT = { id: '22222222-2222-4222-8222-222222222222', verb: { id: 'http://adlnet.gov/expapi/verbs/completed' } };
  it('is kept before the delivery that queued a statement returns, and before a retry does', async () => {
    const a = 'lens:written-first' as TenantId;
    markForwardingHydrated(a);
    addForwardingTarget(a, { endpoint: 'http://127.0.0.1:9/xapi', credentials: 'k:s' });
    let kept = 0;
    onForwardingQueueChange(async () => { await new Promise(r => setTimeout(r, 25)); kept++; });
    await forwardStatement(a, STMT);
    expect(kept).toBe(1);
    await retryDeadLetter(a);
    expect(kept).toBe(2);
    onForwardingQueueChange(() => undefined);
  });
  it('a listener that throws does not fail the delivery', async () => {
    const a = 'lens:written-first-throws' as TenantId;
    markForwardingHydrated(a);
    addForwardingTarget(a, { endpoint: 'http://127.0.0.1:9/xapi', credentials: 'k:s' });
    onForwardingQueueChange(async () => { throw new Error('the pod is away'); });
    await expect(forwardStatement(a, STMT)).resolves.toBeUndefined();
    onForwardingQueueChange(() => undefined);
  });
});

// ★ MEASURED ON THE DEPLOYED BRIDGE, 2026-11-27. These two waited for `keepSnapshot` for a few
// hours. That write is a publish of the whole surface, and it took about sixteen seconds: every
// SCORM navigation step took sixteen seconds, and a cmi5 completion up to three times that. They
// now start the write at once and do not wait. What this holds: no timer before the write, no
// wait for it, and no claim in the answer about a write whose end is not known.
describe('the SCORM sequencing routes and the cmi5 rollup', () => {
  const seq = readFileSync(new URL('../src/scorm-sequencing.ts', import.meta.url), 'utf8');
  const lms = readFileSync(new URL('../src/cmi5-lms.ts', import.meta.url), 'utf8');
  it('start a session\'s write when the step is processed, and do not hold the answer for it', () => {
    expect(seq).not.toContain('scormPodDirty');
    expect(seq).toContain("const keepScormSessions = (): void => { void keepSnapshot('scorm'); };");
    expect(seq.match(/\n    keepScormSessions\(\);\n/g)).toHaveLength(3);
    expect(seq).not.toContain('await keepScormSessions');
    // No answer carries it (the comment that says why still names it).
    expect(seq).not.toMatch(/sessionKept\s*[,}=]/);
    expect(seq).not.toContain('const sessionKept');
  });
  it('do not answer "no session" while the kept sessions are still being read', () => {
    // Four: the three routes that look a session up, and the one that makes one. Review of #1009:
    // a session made before the kept ones were read was written alone, over them.
    expect(seq.match(/await scormReady;/g)).toHaveLength(4);
    const create = seq.slice(seq.indexOf("app.post('/scorm/sequencing/session'"), seq.indexOf("app.post('/scorm/sequencing/:session/navigate'"));
    expect(create.indexOf('await scormReady;')).toBeGreaterThan(-1);
    expect(create.indexOf('await scormReady;')).toBeLessThan(create.indexOf('createSession(tenant, tree)'));
    expect(seq).toContain('const scormReady: Promise<void> = hydrateScormFromPod().catch(() => undefined);');
  });
  it('start the write of what the rollup says as it says it, without waiting', () => {
    const rollup = lms.slice(lms.indexOf('async function rollupCourseUnlocked'), lms.indexOf('function sweepExpired'));
    expect(rollup).not.toContain('cmi5PodDirty');
    expect(rollup.match(/void keepSnapshot\('cmi5'\);/g)).toHaveLength(3);
    expect(rollup).not.toContain("await keepSnapshot('cmi5')");
  });
});
