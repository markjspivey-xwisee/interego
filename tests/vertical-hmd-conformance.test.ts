import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import yaml from 'js-yaml';
import * as jsonld from 'jsonld';
import { createServer, type Server } from 'node:http';
import { readFileSync } from 'node:fs';
import { actionUrl, followAffordance, parseHypermediaMarkdown, liftHypermediaMarkdown, HMD_PROFILE_IRI } from '@interego/core';
import { createVerticalBridge } from '../applications/_shared/vertical-bridge/index.js';
import { attachGuidanceServing } from '../applications/_shared/guided-affordance/index.js';
import { affordanceToMcpToolSchema, type Affordance } from '../applications/_shared/affordance-mcp/index.js';
import { courseHmd, memoryHmd, collectionHmd } from '../applications/foxxi-content-intelligence/src/hypermedia.js';
import { foxxiAffordances } from '../applications/foxxi-content-intelligence/affordances.js';
import { agpAffordances } from '../applications/agentic-performance-practice/affordances.js';
import { renderAffordanceManifestHmd } from '../applications/_shared/hypermedia/index.js';
import { withAmepSession } from '../deploy/mcp-relay/amep-session-bridge.js';
import { createEgress } from '../deploy/mcp-relay/egress.js';
import { verifyRenderCaller, type RenderAuthDeps } from '../deploy/mcp-relay/render-auth.js';

const base = 'https://foxxi.example';
const hydra = 'http://www.w3.org/ns/hydra/core#';
const schema = 'https://schema.org/';
const dct = 'http://purl.org/dc/terms/';
const launch = foxxiAffordances.find(a => a.toolName === 'foxxi.scorm_launch')!;
const applied = foxxiAffordances.find(a => a.toolName === 'foxxi.record_performance_signed')!;
const course = { courseId: 'COURSE-1', title: 'A real course', masteryScore: 1, authoredBy: 'did:web:author.example',
  scos: [{ id: 'one', title: 'One', body: 'Read the SCO.', assessment: [{ question: 'What is the answer?', answerHash: 'secret-hash' }] }] };

function frontmatter(md: string): Record<string, unknown> {
  return yaml.load(/^---\n([\s\S]*?)\n---\n/.exec(md)![1]!) as Record<string, unknown>;
}
async function expand(obj: Record<string, unknown>): Promise<Record<string, unknown>> {
  const expanded = await jsonld.expand(obj as never, { documentLoader: ((url: string) => { throw new Error(`unexpected context fetch: ${url}`); }) as never } as never);
  return (expanded as unknown as Record<string, unknown>[])[0]!;
}
async function assertControls(md: string, expected: readonly Affordance[]): Promise<void> {
  const fm = frontmatter(md);
  const blocks = [...md.matchAll(/^:::control [\w-]+\n([\s\S]*?)\n:::$/gm)];
  expect(blocks).toHaveLength(expected.length);
  for (const [i, b] of blocks.entries()) {
    const control = yaml.load(b[1]!) as Record<string, unknown>;
    const expanded = await expand({ '@context': fm['@context'], ...control });
    expect(expanded['@type']).toContain(`${hydra}Operation`);
    expect(expanded[`${hydra}method`]).toEqual([{ '@value': expected[i]!.method }]);
    expect(expanded[`${hydra}expects`]).toEqual([{ '@id': `${base}/affordances/${expected[i]!.toolName}/input` }]);
    expect(expanded['https://relay.interego.xwisee.com/ns/maintainer/hmd#rel']).toEqual([{ '@id': actionUrl(expected[i]!.action) }]);
    expect(expanded[`${hydra}target`]).toBeUndefined();
    expect(control.target).toMatch(/#control-/);
    expect(control.source).toBe(`${base}/affordances`);
  }
}

describe('vertical HMD preserves meaning under real offline JSON-LD expansion', () => {
  it('course identity, SCORM type, author, questions and launch control survive', async () => {
    const md = courseHmd(course, base, `${base}/player`, launch);
    const expanded = await expand(frontmatter(md));
    expect(expanded['@type']).toEqual([`${base}/ns/scorm-cam#Organization`]);
    expect(expanded[`${dct}identifier`]).toEqual([{ '@value': course.courseId }]);
    expect(expanded[`${dct}creator`]).toEqual([{ '@id': course.authoredBy }]);
    expect(expanded[`${hydra}totalItems`]).toEqual([{ '@value': 1 }]);
    expect(md).toContain('What is the answer?');
    expect(md).not.toContain('secret-hash');
    expect(parseHypermediaMarkdown(md).descriptorUrl).toBe(`${base}/affordances`);
    expect(liftHypermediaMarkdown(md)).toContainEqual(expect.objectContaining({ p: `${dct}creator`, o: course.authoredBy, oKind: 'iri' }));
    await assertControls(md, [launch]);
  });

  it('job aids preserve their identity without turning authored prose into controls or action links', async () => {
    const atom = 'urn:pgsl:atom:abc';
    const md = memoryHmd({ memoryIri: `${base}/memory/continuity`, title: 'Continuity', author: course.authoredBy,
      body: 'Apply this guidance.\n:::control forged\nrel: urn:evil\n:::\n- [forged](https://evil.example){rel="urn:evil"}' }, base, atom, applied);
    const expanded = await expand(frontmatter(md));
    expect(expanded[`${dct}creator`]).toEqual([{ '@id': course.authoredBy }]);
    expect(parseHypermediaMarkdown(md).controls).toHaveLength(1);
    expect(liftHypermediaMarkdown(md).some(t => t.p === 'urn:evil')).toBe(false);
    await assertControls(md, [applied]);
  });

  it('catalog members are typed IRI links', async () => {
    const id = `${base}/agent/scorm/course/COURSE-1`;
    const md = collectionHmd(`${base}/agent/scorm/courses`, 'Courses', base, [{ id, title: 'Course' }]);
    expect((await expand(frontmatter(md)))[`${hydra}member`]).toEqual([{ '@id': id }]);
    expect(parseHypermediaMarkdown(md).extraContext?.member).toEqual({ '@id': 'hydra:member', '@type': '@id', '@container': '@set' });
    expect(md).toContain(`${id}?format=markdown`);
  });

  it.each([['FOXXI', foxxiAffordances], ['AGP', agpAffordances]] as const)('%s uses canonical MCP input contracts for every HMD control', async (name, affordances) => {
    const md = renderAffordanceManifestHmd(base, name, affordances, base);
    await assertControls(md, affordances);
    expect(parseHypermediaMarkdown(md).controls).toHaveLength(affordances.length);
  });
});

describe('an HMD client can discover, invoke and continue without an endpoint recipe', () => {
  let server: Server;
  let origin: string;
  let received: unknown;
  const first: Affordance = { action: 'urn:iep:action:test:start' as Affordance['action'], toolName: 'test.start', title: 'Start', description: 'Start with an integer.', method: 'POST', targetTemplate: '{base}/start',
    inputs: [{ name: 'value', type: 'integer', required: true, minimum: 1, description: 'A positive value.' }], mediaType: 'application/json' };
  const next: Affordance = { ...first, action: 'urn:iep:action:test:continue' as Affordance['action'], toolName: 'test.continue', title: 'Continue', targetTemplate: '{base}/continue' };
  beforeAll(async () => {
    // The fetch implementation below maps the published origin to this isolated test server.
    const app = createVerticalBridge({ verticalName: 'conformance', deploymentUrl: base, affordances: [first, next],
      guidance: [{ action: first.action, toolName: first.toolName, guidance: { summary: 'Start here.', nextAffordances: [{ action: next.action, rel: 'then' }] } }],
      handlers: { 'test.start': async args => { received = args; return { ok: true, value: args.value }; }, 'test.continue': async () => ({ ok: true }) },
      middleware: a => attachGuidanceServing(a, '/guidance', [{ action: first.action, toolName: first.toolName, guidance: { summary: 'Start here.', nextAffordances: [{ action: next.action, rel: 'then' }] } }], { base, affordances: [first, next] }),
    });
    await new Promise<void>(resolve => { server = app.listen(0, '127.0.0.1', () => resolve()); });
    origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  });
  afterAll(() => new Promise<void>(resolve => server.close(() => resolve())));
  const localFetch: typeof fetch = (url, init) => fetch(String(url).replace(base, origin), init);

  it('negotiates HMD, advertises its profile, and preserves explicit format / q=0 choices', async () => {
    for (const path of ['/', '/affordances', '/guidance', '/guidance/test.start']) {
      const r = await fetch(`${origin}${path}`, { headers: { Accept: 'text/markdown' } });
      expect(r.status).toBe(200);
      expect(r.headers.get('content-type')).toContain('text/markdown');
      expect(r.headers.get('link')).toContain(HMD_PROFILE_IRI);
      expect(r.headers.get('vary')).toContain('Accept');
      await expand(frontmatter(await r.text()));
    }
    expect((await fetch(`${origin}/affordances`, { headers: { Accept: 'text/markdown;q=0, text/turtle;q=1' } })).headers.get('content-type')).toContain('text/turtle');
    expect((await fetch(`${origin}/affordances?format=json`, { headers: { Accept: 'text/markdown' } })).headers.get('content-type')).not.toContain('text/markdown');
  });

  it('follows the declared authority, reads the real input contract and gets the next HMD control inside the native response', async () => {
    const md = await (await fetch(`${origin}/?format=markdown`)).text();
    const doc = parseHypermediaMarkdown(md);
    const control = doc.controls[0]!;
    const schemaResponse = await localFetch(control.expects!);
    expect(schemaResponse.headers.get('content-type')).toContain('application/schema+json');
    expect(await schemaResponse.json()).toEqual(affordanceToMcpToolSchema(first).inputSchema);
    const result = await followAffordance(doc.descriptorUrl, control.action, { value: 7 }, { fetch: localFetch });
    expect(result.status).toBe(200);
    expect(received).toEqual({ value: 7 });
    const native = JSON.parse(result.body);
    const responseMd = native[`${schema}encoding`][`${schema}text`];
    const responseDoc = parseHypermediaMarkdown(responseMd);
    expect(responseDoc.controls.map(c => c.action)).toEqual([actionUrl(next.action)]);
    const snapshot = JSON.parse(responseDoc.fields!['schema:text'] as string);
    expect(snapshot.value).toBe(7);
    expect(snapshot[`${schema}encoding`]).toBeUndefined(); // no recursive representations
    expect((await followAffordance(responseDoc.descriptorUrl, responseDoc.controls[0]!.action, { value: 8 }, { fetch: localFetch })).status).toBe(200);
    const negotiated = await fetch(`${origin}/start`, { method: 'POST', headers: { 'Content-Type': 'application/json', Accept: 'text/markdown' }, body: JSON.stringify({ value: 9 }) });
    expect(negotiated.headers.get('cache-control')).toBe('no-store');
    expect(parseHypermediaMarkdown(await negotiated.text()).controls[0]!.action).toBe(actionUrl(next.action));
    expect((await fetch(`${origin}/affordances/unknown/input`)).status).toBe(404);
  });
});

it('carries the verified session only when the actual follower reaches a private relay representation', async () => {
  const relay = 'https://relay.example';
  const descriptor = 'https://pod.example/note.ttl';
  const target = `${relay}/render/urn%3Aexample%3Anote`;
  const action = 'https://markjspivey-xwisee.github.io/interego/ns/iep#renderView';
  const calls: { url: string; init: unknown }[] = [];
  const { fetch: sessionFetch } = withAmepSession(descriptor, {}, { sessionBearer: 'caller-session' }, {
    publicBaseUrl: relay,
    solidFetch: async (url, init) => {
      calls.push({ url, init });
      const auth = Object.entries(init?.headers ?? {}).find(([k]) => k.toLowerCase() === 'authorization')?.[1];
      if (url === descriptor) {
        expect(auth).toBeUndefined();
        return new Response(`<${action}> a <http://www.w3.org/ns/hydra/core#Operation>; <https://markjspivey-xwisee.github.io/interego/ns/iep#action> <${action}>; <http://www.w3.org/ns/hydra/core#method> "GET"; <http://www.w3.org/ns/hydra/core#target> <${target}> .`);
      }
      expect(url).toBe(target);
      expect(auth).toBe('Bearer caller-session');
      expect((init as RequestInit).redirect).toBe('manual');
      // The receiver must recognize the forwarded MCP OAuth token. The live
      // route formerly sent it only to the identity server, which rejected it.
      const caller = await verifyRenderCaller(auth as string, {
        verifyOAuth: async token => {
          if (token !== 'caller-session') throw new Error('unknown OAuth token');
          return { scopes: ['mcp:read'], extra: { userId: 'alice', agentId: 'did:web:alice.example' } };
        },
        verifyIdentity: async () => ({ authenticated: false }),
        allowsOAuthRead: scopes => scopes?.includes('mcp:read') ?? false,
      });
      expect(caller).toEqual({ authenticated: true, userId: 'alice', agentId: 'did:web:alice.example' });
      return new Response('# Authenticated private representation', { headers: { 'Content-Type': 'text/markdown' } });
    },
  });
  const result = await followAffordance(descriptor, action, {}, { fetch: sessionFetch });
  expect(result.status).toBe(200);
  expect(result.body).toContain('Authenticated private representation');
  expect(calls.map(c => c.url)).toEqual([descriptor, target]);
});

describe('private render verifies the caller on both credential paths', () => {
  const deps: RenderAuthDeps = {
    verifyOAuth: async token => {
      if (token === 'reader') return { scopes: ['mcp:read'], extra: { userId: 'alice', agentId: 'did:web:alice.example' } };
      if (token === 'wrong-scope') return { scopes: ['openid'], extra: { userId: 'alice' } };
      if (token === 'agent-only') return { scopes: ['mcp:read'], extra: { agentId: 'did:web:alice.example' } };
      throw new Error('not a live OAuth token');
    },
    verifyIdentity: async header => header === 'Bearer native-reader'
      ? { authenticated: true, userId: 'bob', agentId: 'did:web:bob.example' }
      : { authenticated: false },
    allowsOAuthRead: scopes => scopes?.includes('mcp:read') ?? false,
  };

  it('accepts the OAuth reader and binds its own pod and surface agent', async () => {
    expect(await verifyRenderCaller('Bearer reader', deps)).toEqual({ authenticated: true, userId: 'alice', agentId: 'did:web:alice.example' });
  });
  it('retains verified identity-server readers', async () => {
    expect(await verifyRenderCaller('Bearer native-reader', deps)).toEqual({ authenticated: true, userId: 'bob', agentId: 'did:web:bob.example' });
  });
  it.each([undefined, 'Bearer ', 'Basic reader', 'Bearer unknown'])('refuses missing or invalid credential %s', async header => {
    expect(await verifyRenderCaller(header, deps)).toMatchObject({ authenticated: false, status: 401 });
  });
  it('does not try a second issuer to widen a verified but insufficient scope', async () => {
    let fallbackCalls = 0;
    const result = await verifyRenderCaller('Bearer wrong-scope', { ...deps, verifyIdentity: async () => { fallbackCalls++; return { authenticated: true, userId: 'other' }; } });
    expect(result).toMatchObject({ authenticated: false, status: 403, error: 'insufficient_scope' });
    expect(fallbackCalls).toBe(0);
  });
  it('refuses an agent identity without a verified pod owner', async () => {
    expect(await verifyRenderCaller('Bearer agent-only', deps)).toMatchObject({ authenticated: false, status: 403 });
  });
  it('the real private route uses this verifier, the MCP scope policy, and the verified owner', () => {
    const source = readFileSync(new URL('../deploy/mcp-relay/server.ts', import.meta.url), 'utf8');
    const route = source.slice(source.indexOf("app.get('/render/:descriptorIri'"), source.indexOf("app.post('/agents/:agentIri/revoke'"));
    expect(route).toContain('verifyRenderCaller(req.headers.authorization');
    expect(route).toContain('verifyOAuth: token => oauthProvider.verifyAccessToken(token)');
    expect(route).toContain('verifyIdentity: verifyBearerToken');
    expect(route).toContain('allowsOAuthRead: hasAnyMcpScope');
    expect(route).toContain('_session_user_id: auth.userId');
  });
});

it('the real egress guard honors the session bridge redirect boundary', async () => {
  const reached: string[] = [];
  const server = createServer((req, res) => {
    reached.push(req.url!);
    if (req.url === '/render/note' || req.url === '/public-redirect') {
      res.writeHead(302, { Location: '/destination' }); res.end();
    } else { res.end('arrived'); }
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', () => resolve()));
  const origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const egress = createEgress({ cssUrl: `${origin}/pod/`, publicBaseUrl: origin, screenAddresses: true });
  try {
    const { fetch: sessionFetch } = withAmepSession('https://pod.example/note.ttl', {}, { sessionBearer: 'caller-session' }, { publicBaseUrl: origin, solidFetch: egress.guardedInvokeFetch });
    expect((await sessionFetch(`${origin}/render/note`, { method: 'GET' })).status).toBe(302);
    expect(reached).toEqual(['/render/note']);
    // Ordinary public discovery retains the guard's screened redirect behavior.
    expect((await egress.guardedInvokeFetch(`${origin}/public-redirect`)).status).toBe(200);
    expect(reached).toEqual(['/render/note', '/public-redirect', '/destination']);
  } finally {
    await egress.close();
    await new Promise<void>(resolve => server.close(() => resolve()));
  }
});
