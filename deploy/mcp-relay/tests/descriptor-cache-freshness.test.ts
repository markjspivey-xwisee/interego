#!/usr/bin/env tsx
/** Execute the shipping descriptor reader and cache, without starting the relay.
 * Only I/O, projection and crypto ports are replaced. Mutable registry readback
 * must not depend on which relay or writer last changed the resource. */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { compileFunction } from 'node:vm';
import ts from 'typescript';

const source = readFileSync(new URL('../server.ts', import.meta.url), 'utf8');
const ast = ts.createSourceFile('server.ts', source, ts.ScriptTarget.ES2022, true);
const names = new Set(['DESCRIPTOR_BODY_CACHE_TTL_MS', 'DESCRIPTOR_BODY_CACHE_MAX', 'descriptorBodyCache', 'descriptorBodyWrites']);
const functions = new Set(['canCacheDescriptorBody', 'cacheDescriptorBody', 'handleGetDescriptor',
  'descriptorBodyIdentity', 'invalidateDescriptorBody']);
const code = ast.statements.filter(node => ts.isFunctionDeclaration(node) ? functions.has(node.name?.text ?? '')
  : ts.isVariableStatement(node) && node.declarationList.declarations.some(d => ts.isIdentifier(d.name) && names.has(d.name.text)))
  .map(node => node.getText(ast)).join('\n');
assert(code.includes('async function handleGetDescriptor'), 'execute the actual production handler');
const js = ts.transpileModule(code, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } }).outputText;
const registry = 'http://css.test/u-pk-owner/agents';
const descriptor = 'http://css.test/u-pk-owner/context-graphs/6bd17e4b-8212-4686-8ed5-45cc15b1ce1a.ttl';
const body = (value: string) => `<urn:test:resource> <urn:test:recipient-key> "${value}" .`;
interface Resource { content: string; landedUrl?: string; encrypted?: boolean }
function fixture() {
  const resources = new Map<string, Resource>(), reads: string[] = [], payloadReads: string[] = [];
  let block: null | { entered(): void; waiting: Promise<void> } = null;
  const ports = {
    normalizeCssUrl: (url: string) => url.replace('https://gate.test/', 'http://css.test/'),
    resourceCompositions: { claims: () => false },
    guardedInvokeFetchLanded: async (url: string) => {
      reads.push(url); const held = { ...resources.get(url)! };
      if (block) { const gate = block; block = null; gate.entered(); await gate.waiting; }
      return { response: new Response(held.content, { headers: { 'content-type': 'text/turtle' } }), landedUrl: held.landedUrl ?? url };
    },
    guardedInvokeFetch: async (url: string) => ({ url: resources.get(url)?.landedUrl ?? url }),
    fetchGraphContent: async (url: string, options: { recipientKeyPair?: string; fetch(url: string): Promise<unknown> }) => {
      await options.fetch(url);
      payloadReads.push(url); const resource = resources.get(url)!;
      return { content: resource.encrypted && options.recipientKeyPair !== 'owner' ? null : resource.content,
        encrypted: resource.encrypted === true, mediaType: 'application/trig' };
    },
    recipientKeyFor: async (args: { recipient?: string }) => args.recipient,
    envelopeOpenerFor: async () => undefined,
    parseDistributionFromDescriptorTurtle: () => null,
    parseAuthorshipProofFromDescriptorTurtle: () => null,
    inlineRenderedForDescriptor: () => undefined,
    asPublicPodUrl: (url: string) => url,
    PUBLIC_BASE_URL: 'https://relay.test', PORT: 3000, isFollowableTarget: () => false,
    // The store's two spellings, as server.ts declares them: internal (where the relay writes)
    // and public (what identifiers handed out say).
    CSS_URL: 'http://css.test/', STORE_ORIGINS: new Set(['http://css.test', 'https://store.test']),
  };
  const compiled = compileFunction(js + '\nreturn { get: handleGetDescriptor, cache: descriptorBodyCache, wrote: invalidateDescriptorBody };', Object.keys(ports));
  const api = compiled(...Object.values(ports)) as {
    get(args: Record<string, unknown>, project?: boolean): Promise<string>;
    wrote(url: string): void;
    cache: Map<string, { content: string; landedUrl?: string; encrypted: boolean; mediaType: string; expiresAt: number }>;
  };
  return { ...api, resources, reads, payloadReads,
    read: async (url: string, args = {}) => JSON.parse(await api.get({ url, ...args }, false)),
    holdNext() {
      let entered!: () => void, release!: () => void;
      const started = new Promise<void>(resolve => { entered = resolve; });
      block = { entered, waiting: new Promise<void>(resolve => { release = resolve; }) };
      return { started, release };
    },
  };
}

let passed = 0, failed = 0;
async function check(name: string, run: () => Promise<void> | void) {
  try { await run(); passed++; console.log('PASS ' + name); }
  catch (error) { failed++; console.error('FAIL ' + name + ': ' + (error as Error).message); }
}
await check('default registry reads see a newly registered recipient immediately, across normalized aliases', async () => {
  const f = fixture(); f.resources.set(registry, { content: body('before-registration') });
  assert.equal((await f.read('https://gate.test/u-pk-owner/agents')).turtle, body('before-registration'));
  f.resources.set(registry, { content: body('new-owner-recipient') });
  assert.equal((await f.read(registry)).turtle, body('new-owner-recipient'));
  assert.equal(f.reads.length, 2); assert.equal(f.cache.size, 0);
});
await check('a registry read already in flight cannot repopulate stale bytes after a write', async () => {
  const f = fixture(); f.resources.set(registry, { content: body('old') }); const gate = f.holdNext();
  const oldRead = f.read(registry); await gate.started; f.resources.set(registry, { content: body('new') }); gate.release();
  assert.equal((await oldRead).turtle, body('old'));
  assert.equal((await f.read(registry)).turtle, body('new')); assert.equal(f.cache.size, 0);
});
await check('pre-existing mutable cache entries are ignored', async () => {
  const f = fixture(); f.resources.set(registry, { content: body('current') });
  f.cache.set(registry, { content: body('stale'), encrypted: false, mediaType: 'text/turtle', expiresAt: Date.now() + 60000 });
  assert.equal((await f.read(registry)).turtle, body('current')); assert.equal(f.reads.length, 1);
});
await check('published context descriptors keep cache hits, landed location and explicit bypass', async () => {
  const f = fixture(); f.resources.set(descriptor, { content: body('published') });
  assert.equal((await f.read(descriptor)).turtle, body('published'));
  assert.equal((await f.read(descriptor)).turtle, body('published')); assert.equal(f.reads.length, 1);
  assert.equal(f.cache.get(descriptor)?.landedUrl, descriptor);
  f.resources.set(descriptor, { content: body('fresh-observation') });
  assert.equal((await f.read(descriptor, { bypass_cache: true })).turtle, body('fresh-observation')); assert.equal(f.reads.length, 2);
});
await check('registry, manifest, profile and arbitrary Turtle resources are not immutable descriptor URLs', async () => {
  for (const suffix of ['agents', '.well-known/context-graphs', 'profile/card', 'settings/publicTypeIndex.ttl', 'arbitrary.ttl',
    'context-graphs/x.ttl?view=latest', 'context-graphs/x.ttl#fragment', 'context-graphs/x%2fy.ttl', 'context-graphs/x%5cy.ttl']) {
    const f = fixture(), url = 'http://css.test/u-pk-owner/' + suffix;
    f.resources.set(url, { content: body('first') }); await f.read(url); f.resources.set(url, { content: body('second') });
    assert.equal((await f.read(url)).turtle, body('second'), suffix); assert.equal(f.cache.size, 0, suffix);
  }
});
await check('a descriptor-looking URL landing on a mutable registry is not cached', async () => {
  const f = fixture(); f.resources.set(descriptor, { content: body('old'), landedUrl: registry }); await f.read(descriptor);
  f.resources.set(descriptor, { content: body('current'), landedUrl: registry });
  assert.equal((await f.read(descriptor)).turtle, body('current')); assert.equal(f.cache.size, 0);
});
await check('a published graph alias landing on mutable TriG is not cached', async () => {
  const f = fixture(), url = descriptor.replace(/\.ttl$/, '-graph.trig');
  f.resources.set(url, { content: body('old'), landedUrl: 'http://css.test/u-pk-owner/live.trig' }); await f.read(url);
  f.resources.set(url, { content: body('current'), landedUrl: 'http://css.test/u-pk-owner/live.trig' });
  assert.equal((await f.read(url)).content, body('current')); assert.equal(f.cache.size, 0);
});
await check('plaintext published graph payloads retain caching, arbitrary TriG stays fresh', async () => {
  for (const [url, immutable] of [[descriptor.replace(/\.ttl$/, '-graph.trig'), true], ['http://css.test/u-pk-owner/live.trig', false]] as const) {
    const f = fixture(); f.resources.set(url, { content: body('first') }); await f.read(url); f.resources.set(url, { content: body('second') });
    assert.equal((await f.read(url)).content, body(immutable ? 'first' : 'second'));
    assert.equal(f.payloadReads.length, immutable ? 1 : 2);
  }
});
await check('decrypted envelope bytes never enter the shared cache or leak to another recipient', async () => {
  const f = fixture(), url = descriptor.replace(/\.ttl$/, '-graph.envelope.jose.json');
  f.resources.set(url, { content: 'owner-private-plaintext', encrypted: true });
  assert.equal((await f.read(url, { recipient: 'owner' })).content, 'owner-private-plaintext');
  const other = await f.read(url); assert.equal(other.encrypted, true); assert.equal(other.content, undefined);
  assert.equal(f.payloadReads.length, 2); assert.equal(f.cache.size, 0);
});
await check('a write retires the cached descriptor and graph bodies under every spelling that aliases them', async () => {
  const graph = descriptor.replace(/\.ttl$/, '-graph.trig');
  const writes: Array<[string, string]> = [
    ['the URL itself', descriptor],
    ['the public spelling of the store', descriptor.replace('http://css.test/', 'https://store.test/')],
    ['the legacy host normalizeCssUrl rewrites', descriptor.replace('http://css.test/', 'https://gate.test/')],
    ['upper-case host', descriptor.replace('css.test', 'CSS.TEST')],
    ['percent-encoded path characters', descriptor.replace('context-graphs', 'context%2Dgraphs')],
    ['the graph half of the pair', graph],
    ['an encrypted republish of the graph half', descriptor.replace(/\.ttl$/, '-graph.envelope.jose.json')],
  ];
  for (const [how, written] of writes) {
    const f = fixture();
    f.resources.set(descriptor, { content: body('v1') }); f.resources.set(graph, { content: body('g1') });
    await f.read(descriptor); await f.read(graph); assert.equal(f.cache.size, 2, how);
    f.resources.set(descriptor, { content: body('v2') }); f.resources.set(graph, { content: body('g2') });
    f.wrote(written);
    assert.equal(f.cache.size, 0, how);
    assert.equal((await f.read(descriptor)).turtle, body('v2'), how);
    assert.equal((await f.read(graph)).content, body('g2'), how);
  }
});
await check('a key whose bytes LANDED on the written URL is retired too', async () => {
  const f = fixture(), alias = 'http://css.test/u-pk-owner/context-graphs/alias.ttl';
  f.resources.set(alias, { content: body('v1'), landedUrl: descriptor }); await f.read(alias);
  assert.equal(f.cache.size, 1); f.wrote(descriptor); assert.equal(f.cache.size, 0);
});
await check('writes outside a publication container leave cached descriptors alone', async () => {
  const f = fixture(); f.resources.set(descriptor, { content: body('v1') }); await f.read(descriptor);
  for (const url of [registry, 'http://css.test/u-pk-owner/.well-known/context-graphs', 'not a url']) f.wrote(url);
  assert.equal(f.cache.size, 1);
  f.wrote('http://css.test/u-pk-owner/context-graphs/some-other-descriptor.ttl'); assert.equal(f.cache.size, 1);
});
await check('a descriptor read in flight across a republish cannot put the old bytes back', async () => {
  const f = fixture(); f.resources.set(descriptor, { content: body('old') });
  const gate = f.holdNext(); const oldRead = f.read(descriptor); await gate.started;
  f.resources.set(descriptor, { content: body('new') }); f.wrote(descriptor); gate.release();
  assert.equal((await oldRead).turtle, body('old')); assert.equal(f.cache.size, 0);
  assert.equal((await f.read(descriptor)).turtle, body('new'));
  assert.equal((await f.read(descriptor)).turtle, body('new')); assert.equal(f.reads.length, 2, 'a read after the write caches again');
});
await check('the public get_descriptor input advertises its implemented freshness port', () => {
  const declaration = ast.statements.find(node => ts.isVariableStatement(node) && node.declarationList.declarations.some(d => ts.isIdentifier(d.name) && d.name.text === 'TOOL_SCHEMAS'));
  assert(declaration); const match = /name: 'get_descriptor',([\s\S]*?)outputSchema:/.exec(declaration.getText(ast));
  assert(match); assert.match(match[1]!, /bypass_cache:\s*\{\s*type:\s*'boolean'/);
});
console.log(`descriptor-cache-freshness: ${passed} passed, ${failed} failed`);
if (failed) process.exit(1);
