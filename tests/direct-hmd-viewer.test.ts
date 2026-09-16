import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';
import { extractAffordancesFromTurtle, parseHypermediaMarkdown, renderHypermediaMarkdown } from '@interego/core';
import { viewerControls } from '../deploy/mcp-relay/note-view.js';

// Execute the actual handler bodies without starting the relay or replacing its
// parser. Inject only their I/O and session dependencies; a disconnected helper
// or a reverted call site must fail these tests.
const source = readFileSync(new URL('../deploy/mcp-relay/server.ts', import.meta.url), 'utf8');
const ast = ts.createSourceFile('server.ts', source, ts.ScriptTarget.Latest, true);
function handler(name: string, context: Record<string, unknown>) {
  const node = ast.statements.find(n => ts.isFunctionDeclaration(n) && n.name?.text === name);
  if (!node) throw new Error('Handler missing: ' + name);
  const js = ts.transpileModule(node.getText(ast), { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } }).outputText;
  return vm.runInNewContext(js + '\n' + name, context) as (...args: unknown[]) => Promise<string>;
}
const HMD_URL = 'https://content.example/course?format=markdown';
const AUTHORITY = 'https://content.example/affordances';
const ACTION = 'urn:iep:action:example:launch';
const hmd = renderHypermediaMarkdown({ id: 'https://content.example/course', type: 'schema:CreativeWork',
  descriptorUrl: AUTHORITY, title: 'A readable course', body: '# A readable course\n\nLearn the procedure.',
  controls: [{ action: ACTION, method: 'POST', source: AUTHORITY }],
  links: [{ label: 'Launch in player', href: 'https://content.example/player', rel: 'alternate', type: 'text/html' }],
});

function reader(content = hmd, status = 200) {
  let current = content;
  const requests: unknown[] = [], writes: unknown[] = [];
  const get = handler('handleGetDescriptor', { normalizeCssUrl: (url: string) => url,
    resourceCompositions: { claims: () => false }, descriptorBodyCache: new Map(),
    guardedInvokeFetchLanded: async (...args: unknown[]) => {
      requests.push(args);
      return { response: new Response(current, { status, headers: { 'content-type': 'text/markdown; charset=UTF-8; variant=CommonMark' } }), landedUrl: HMD_URL };
    }, cacheDescriptorBody: (...args: unknown[]) => writes.push(args),
  });
  return { get, requests, writes, set: (value: string) => { current = value; } };
}
function viewer(get: (...args: unknown[]) => Promise<string>) {
  return handler('handleRenderHmd', { handleGetDescriptor: get, callerAgentId: () => 'bound-agent',
    canonicalSessionActorId: () => 'did:web:test.example:agent', IDENTITY_URL: 'https://identity.example', PUBLIC_BASE_URL: 'https://relay.example',
    parseHypermediaMarkdown, extractAffordancesFromTurtle, viewerControls,
    isFollowableTarget: (target: string) => target.startsWith('https://content.example/'),
  });
}

describe('direct HyperMarkdown through the actual descriptor and viewer handlers', () => {
  it('preserves the media type, prose, links and controls without inventing signature authority', async () => {
    const r = reader();
    const gd = JSON.parse(await r.get({ url: HMD_URL }));
    expect(gd).toMatchObject({ representationKind: 'hypermarkdown', rendered: hmd, content: hmd, authorship: null });
    expect(gd.turtle).toBeUndefined(); expect(r.writes).toEqual([]);
    const view = JSON.parse(await viewer(r.get)({ descriptor_url: HMD_URL }));
    expect(view.title).toBe('A readable course'); expect(view.body).toContain('Learn the procedure.');
    expect(view.body).not.toContain('# A readable course');
    expect(view.links[0].href).toBe('https://content.example/player');
    expect(view.controls).toHaveLength(1); expect(view.controls[0]).toMatchObject({ action: ACTION, executable: false });
    expect(view.authorship).toBeNull();
  });
  it('does not freeze a mutable document in the immutable-descriptor cache', async () => {
    const r = reader(); await r.get({ url: HMD_URL }); r.set(hmd.replace('Learn the procedure.', 'Revised instruction.'));
    const view = JSON.parse(await viewer(r.get)({ descriptor_url: HMD_URL }));
    expect(view.body).toContain('Revised instruction.'); expect(r.requests.filter(([url]) => url === HMD_URL)).toHaveLength(2); expect(r.writes).toEqual([]);
  });
  it('refuses a projection when a caller explicitly needs a signed descriptor', async () => {
    expect(JSON.parse(await reader().get({ url: HMD_URL }, false)).error).toMatch(/not a signed descriptor/);
  });
  it('keeps upstream access failures generic and never exposes their bodies', async () => {
    const result = JSON.parse(await viewer(reader('private upstream diagnostic', 403).get)({ descriptor_url: HMD_URL }));
    expect(result).toEqual({ error: 'descriptor could not be retrieved' });
  });
  it('returns explicit errors instead of successful empty or malformed viewers', async () => {
    expect(JSON.parse(await viewer(async () => '{}')({ descriptor_url: HMD_URL })).error).toBe('hypermarkdown_unavailable');
    expect(JSON.parse(await viewer(reader('not a HyperMarkdown document').get)({ descriptor_url: HMD_URL })).error).toBe('invalid_hypermarkdown');
  });
  it('does not execute a control just because Markdown declares it', async () => {
    const view = JSON.parse(await viewer(reader().get)({ descriptor_url: HMD_URL }));
    expect(view.controls.every((c: { executable: boolean }) => c.executable === false)).toBe(true);
    const forged = hmd.replace(/^target: "[^"]+"$/m, 'target: "https://untrusted.example/execute"');
    expect(forged).not.toBe(hmd);
    expect(JSON.parse(await viewer(reader(forged).get)({ descriptor_url: HMD_URL })).error).toBe('invalid_hypermarkdown');
  });
  it('preserves existing descriptor-backed controls and authorship', async () => {
    const turtle = '@prefix iep: <https://markjspivey-xwisee.github.io/interego/ns/iep#> .\n'
      + '@prefix hydra: <http://www.w3.org/ns/hydra/core#> .\n'
      + '<https://content.example/affordances> iep:affordance <#launch> .\n'
      + '<#launch> a iep:Affordance ; iep:action <' + ACTION + '> ; hydra:method "POST" ; hydra:target <https://content.example/launch> .';
    const authorship = { authorshipVerified: true, contentBinding: { bound: true } };
    const view = JSON.parse(await viewer(async () => JSON.stringify({ rendered: hmd, turtle, authorship }))({ descriptor_url: AUTHORITY }));
    expect(view.controls[0].executable).toBe(true); expect(view.authorship).toEqual(authorship);
  });
  it('resolves a direct document authority before enabling its control and uses that authority to execute', async () => {
    const turtle = `<urn:aff> a <https://markjspivey-xwisee.github.io/interego/ns/iep#Affordance> ; <https://markjspivey-xwisee.github.io/interego/ns/iep#action> <${ACTION}> ; <http://www.w3.org/ns/hydra/core#method> "POST" ; <http://www.w3.org/ns/hydra/core#target> <https://content.example/execute> .`;
    const resolved: string[] = [];
    const get = async (args: { url: string }) => {
      resolved.push(args.url);
      return JSON.stringify(args.url === AUTHORITY ? { turtle } : { representationKind: 'hypermarkdown', rendered: hmd, authorship: null });
    };
    const view = JSON.parse(await viewer(get)({ descriptor_url: HMD_URL }));
    expect(resolved).toEqual([HMD_URL, AUTHORITY]);
    expect(view.controls[0]).toMatchObject({ executable: true, descriptorUrl: AUTHORITY });
    expect(view.authorship).toBeNull();
  });
});
