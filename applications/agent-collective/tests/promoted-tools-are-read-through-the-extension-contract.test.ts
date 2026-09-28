/**
 * A PROMOTED TOOL IS FOUND BY THE VERTICAL'S OWN PROFILE, THROUGH THE SUBSTRATE'S CONTRACT.
 *
 * Until #367 the MCP relay carried this vertical's vocabulary in a loader that matched nothing
 * `promoteTool` writes (see `src/promoted-tools.ts`). These cases publish with the vertical's real
 * `authorTool` and `promoteTool` into an in-memory pod and read the pod back with
 * `discoverPromotedTools`, so the profile is held to the bytes the publisher actually writes — the
 * gap the relay's copy fell into. The bridge leg mounts the real affordance on the shared vertical
 * bridge and checks the status a client sees.
 */

import { describe, it, expect, vi } from 'vitest';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import type { IRI } from '@interego/core';
import { authorTool, promoteTool } from '../src/pod-publisher.js';
import { discoverPromotedTools, promotedToolsAnswer, PROMOTED_TOOL_PROFILE } from '../src/promoted-tools.js';
import { acAffordances } from '../affordances.js';
import { createVerticalBridge } from '../../_shared/vertical-bridge/index.js';

const POD = 'https://pod.example/collective/';
const AGENT = 'did:web:agent.example' as IRI;

function makePod() {
  const store = new Map<string, string>();
  const fail = new Set<string>();
  const respond = (status: number, body: string, type = 'text/turtle') => ({
    ok: status >= 200 && status < 300, status, statusText: '',
    headers: { get: (n: string) => (n.toLowerCase() === 'etag' ? `"e${body.length}"` : type) },
    text: async () => body, json: async () => ({}),
  });
  const fetchFn = vi.fn(async (url: string, init?: { method?: string; body?: string }) => {
    const method = init?.method ?? 'GET';
    if (fail.has(url)) return respond(403, '');
    if (method === 'PUT') { store.set(url, init?.body ?? ''); return respond(205, ''); }
    if (method === 'DELETE') return respond(store.delete(url) ? 205 : 404, '');
    const body = store.get(url);
    return body === undefined ? respond(404, '') : respond(200, body);
  });
  return { store, fail, fetch: fetchFn as unknown as typeof globalThis.fetch };
}

async function authorAndPromote(pod: ReturnType<typeof makePod>, name: string, action: string, description?: string) {
  const config = { podUrl: POD, authoringAgentDid: AGENT, fetch: pod.fetch };
  const authored = await authorTool({ toolName: name, sourceCode: `export const ${name.replace(/\W/g, '_')} = () => 1;`, affordanceAction: action, ...(description ? { affordanceDescription: description } : {}) }, config);
  const promoted = await promoteTool({ toolIri: authored.toolIri, selfAttestations: 5, peerAttestations: 2, axesCovered: ['correctness', 'safety'] }, config);
  return { authored, promoted };
}

describe('the agent-collective reads its promoted tools through the neutral contract', () => {
  it('finds a promoted tool as the action its author declared, defined by the authored descriptor', async () => {
    const pod = makePod();
    const { authored, promoted } = await authorAndPromote(pod, 'csv-splitter', 'https://tools.example/actions/split-csv', 'Split a CSV file into rows.');
    const catalog = await discoverPromotedTools(POD, pod.fetch);
    expect(catalog.profile).toBe(PROMOTED_TOOL_PROFILE);
    expect(catalog.operations).toEqual([expect.objectContaining({
      action: 'https://tools.example/actions/split-csv',
      title: 'csv-splitter',
      description: 'Split a CSV file into rows.',
      descriptorUrl: promoted.descriptorUrl,
      definedBy: authored.descriptorUrl,
    })]);
  });

  it('does not offer a tool that was authored but never promoted', async () => {
    const pod = makePod();
    await authorAndPromote(pod, 'promoted-one', 'https://tools.example/actions/one');
    await authorTool({ toolName: 'still-hypothetical', sourceCode: 'x', affordanceAction: 'https://tools.example/actions/two' }, { podUrl: POD, authoringAgentDid: AGENT, fetch: pod.fetch });
    const catalog = await discoverPromotedTools(POD, pod.fetch);
    expect(catalog.operations.map(o => o.action)).toEqual(['https://tools.example/actions/one']);
    expect(catalog.selected).toBe(1);
  });

  it('reads a title and description back exactly as they were written, escapes and all', async () => {
    const pod = makePod();
    await authorAndPromote(pod, 'quote "tool"', 'https://tools.example/actions/q', 'Line one.\nLine "two".');
    const [op] = (await discoverPromotedTools(POD, pod.fetch)).operations;
    expect(op?.title).toBe('quote "tool"');
    expect(op?.description).toBe('Line one.\nLine "two".');
  });

  it('refuses two promoted tools that declare one action, rather than letting load order choose', async () => {
    const pod = makePod();
    await authorAndPromote(pod, 'first', 'https://tools.example/actions/same');
    await authorAndPromote(pod, 'second', 'https://tools.example/actions/same');
    const answer = await promotedToolsAnswer(POD, pod.fetch);
    expect(answer).toMatchObject({ kind: 'refusal', 'iep:refusalStatus': 422, reason: 'ambiguous' });
  });

  it('refuses, as a failed read, a promotion whose authored tool cannot be read', async () => {
    const pod = makePod();
    const { authored } = await authorAndPromote(pod, 'unreadable', 'https://tools.example/actions/u');
    pod.fail.add(authored.graphUrl);
    const answer = await promotedToolsAnswer(POD, pod.fetch);
    expect(answer).toMatchObject({ kind: 'refusal', 'iep:refusalStatus': 502, reason: 'incomplete' });
  });

  it('refuses a promotion that attests a tool the pod does not list', async () => {
    const pod = makePod();
    const { authored } = await authorAndPromote(pod, 'orphaned', 'https://tools.example/actions/o');
    const manifestUrl = `${POD}.well-known/context-graphs`;
    const manifest = pod.store.get(manifestUrl)!;
    const rows = manifest.split(/\n\n/);
    pod.store.set(manifestUrl, rows.filter(r => !r.includes(`<${authored.descriptorUrl}>`)).join('\n\n'));
    const answer = await promotedToolsAnswer(POD, pod.fetch);
    expect(answer).toMatchObject({ kind: 'refusal', 'iep:refusalStatus': 502, reason: 'incomplete' });
  });
});

describe('the bridge answers the catalog, and a refusal with a refusing status', () => {
  const discover = acAffordances.filter(a => a.toolName === 'ac.discover_promoted_tools');

  async function withBridge<T>(pod: ReturnType<typeof makePod>, fn: (base: string) => Promise<T>): Promise<T> {
    const app = createVerticalBridge({
      verticalName: 'agent-collective',
      affordances: discover,
      handlers: { 'ac.discover_promoted_tools': async (args: Record<string, unknown>) => promotedToolsAnswer(String(args['pod_url']), pod.fetch) },
      deploymentUrl: 'http://127.0.0.1',
    } as never);
    const server: Server = await new Promise(resolve => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
    try { return await fn(`http://127.0.0.1:${(server.address() as AddressInfo).port}`); }
    finally { await new Promise<void>(r => server.close(() => r())); }
  }
  const post = async (base: string, body: unknown) => {
    const r = await fetch(`${base}/ac/discover_promoted_tools`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
    return { status: r.status, body: await r.json() as Record<string, unknown> };
  };

  it('is one published affordance, read-only', () => {
    expect(discover).toHaveLength(1);
    expect(discover[0]!.annotations?.readOnlyHint).toBe(true);
  });

  it('answers 200 with the catalog', async () => {
    const pod = makePod();
    await authorAndPromote(pod, 'ok-tool', 'https://tools.example/actions/ok');
    await withBridge(pod, async base => {
      const { status, body } = await post(base, { pod_url: POD });
      expect(status).toBe(200);
      expect((body['operations'] as unknown[]).length).toBe(1);
      expect(String(body['digest'])).toMatch(/^sha256:/);
    });
  });

  it('answers 422 for an ambiguous pod, typed as a refusal', async () => {
    const pod = makePod();
    await authorAndPromote(pod, 'a', 'https://tools.example/actions/same');
    await authorAndPromote(pod, 'b', 'https://tools.example/actions/same');
    await withBridge(pod, async base => {
      const { status, body } = await post(base, { pod_url: POD });
      expect(status).toBe(422);
      expect(body['kind']).toBe('refusal');
    });
  });
});
