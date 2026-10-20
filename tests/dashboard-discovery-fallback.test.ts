import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';

// Execute the shipped discovery/poll functions without starting the HTTP server.
// The regression requires consecutive failed discovery cycles, not a string assertion.
const source = readFileSync(new URL('../examples/dashboard/server.ts', import.meta.url), 'utf8');
const ast = ts.createSourceFile('server.ts', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
const names = new Set(['podNameFromUrl', 'knownPodNames', 'discoverPods', 'pollOne']);
const functions = ast.statements.filter(node => ts.isFunctionDeclaration(node) && node.name && names.has(node.name.text))
  .map(node => node.getText(ast)).join('\n');
const compiled = ts.transpileModule(functions, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } }).outputText;
const CSS_URL = 'https://store.example/base/';

function harness(replies: Array<Response | Error>) {
  const pods = new Map<string, unknown>([[CSS_URL + 'alice/', { descriptors: [], agents: [] }]]);
  const reads: string[] = [];
  const context = {
    URL, AbortController, setTimeout, clearTimeout, CSS_URL, pods,
    knownDescriptorUrls: new Set(),
    fetch: async (url: string) => {
      reads.push(url);
      const reply = replies.shift();
      if (reply instanceof Error) throw reply;
      return reply ?? new Response('', { status: 503 });
    },
    fetchRegistry: async (url: string) => { reads.push(url + 'agents'); return null; },
    fetchManifest: async (url: string) => { reads.push(url + '.well-known/context-graphs'); return []; },
    broadcast: () => {}, log: () => {},
  };
  const api = vm.runInNewContext(compiled + '\n({discoverPods, pollOne})', context) as {
    discoverPods(): Promise<string[]>;
    pollOne(name: string): Promise<void>;
  };
  return { ...api, pods, reads };
}

describe('dashboard pod discovery survives unavailable root listings', () => {
  it('keeps one pod and the same two read targets across repeated HTTP failures', async () => {
    const h = harness(Array.from({ length: 6 }, () => new Response('', { status: 503 })));
    for (let i = 0; i < 6; i++) {
      const found = await h.discoverPods();
      expect([...found]).toEqual(['alice']);
      await Promise.all(found.map(name => h.pollOne(name)));
    }
    expect([...h.pods.keys()]).toEqual([CSS_URL + 'alice/']);
    expect([...new Set(h.reads)]).toEqual([CSS_URL, CSS_URL + 'alice/agents', CSS_URL + 'alice/.well-known/context-graphs']);
  });

  it('uses the same safe fallback for network errors and ignores previously contaminated keys', async () => {
    const h = harness([new Error('offline')]);
    h.pods.set(CSS_URL + CSS_URL + 'alice//', {});
    h.pods.set('https://other.example/alice/', {});
    h.pods.set(CSS_URL + 'alice/nested/', {});
    expect([...(await h.discoverPods())]).toEqual(['alice']);
  });

  it('discovers relative and absolute child containers without following nested or foreign URLs', async () => {
    const h = harness([new Response(`@prefix ldp: <http://www.w3.org/ns/ldp#> .
      <> ldp:contains <alice/>, <https://store.example/base/bob/>, <alice/nested/>,
        <https://foreign.example/mallory/>, <.well-known/>, <bad%2fchild/> .`)]);
    expect([...(await h.discoverPods())]).toEqual(['alice', 'bob']);
  });

  it('refuses malformed cached names before making requests or storing another pod', async () => {
    const h = harness([]);
    for (const name of [CSS_URL + 'alice/', 'alice/nested', '../alice', 'alice?query', 'bad%2fchild', 'bad%5cchild']) {
      await h.pollOne(name);
    }
    expect(h.reads).toEqual([]);
    expect(h.pods.size).toBe(1);
  });
});
