import { describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';
import {
  AffordanceNotFoundError, createEncryptedEnvelope, extractAffordancesFromTurtle,
  generateKeyPair, kernelAct, parseHypermediaMarkdown, sameAction, type FetchFn,
} from '@interego/core';
import { withAmepSession } from '../deploy/mcp-relay/amep-session-bridge.js';
import { managedRecipientKey, openManagedEnvelope, type ManagedKeyContext } from '../deploy/mcp-relay/managed-recipient.js';
import { noteToHyperMarkdown, viewerControls } from '../deploy/mcp-relay/note-view.js';
import { mayUseRelayKey } from '../deploy/mcp-relay/relay-key-gate.js';

// Run the production handlers without booting their self-starting server. Only
// descriptor I/O and the already-authenticated transport context are doubles;
// action following, RDF extraction and private recipient decryption are real.
const source = readFileSync(new URL('../deploy/mcp-relay/server.ts', import.meta.url), 'utf8');
const ast = ts.createSourceFile('server.ts', source, ts.ScriptTarget.Latest, true);
type Args = Record<string, unknown>;
function handler(name: string, context: Args) {
  const node = ast.statements.find(n => ts.isFunctionDeclaration(n) && n.name?.text === name);
  if (!node) throw new Error('Handler missing: ' + name);
  const js = ts.transpileModule(node.getText(ast), {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
  }).outputText;
  return vm.runInNewContext(js + '\n' + name, context) as (...args: unknown[]) => Promise<string>;
}

const ORIGIN = 'https://store.example';
const IDENTITY = 'https://identity.example';
const OWNER = 'did:web:identity.example:agents:owner';
const OTHER = 'did:web:identity.example:agents:other';
const DESCRIPTOR = ORIGIN + '/owner/context-graphs/private.ttl';
const GRAPH_URL = ORIGIN + '/owner/context-graphs/private.envelope.jose.json';
const GRAPH = 'urn:example:private-ui';
const READ = 'urn:example:ui:checkConnection';
const PREVIEW = 'urn:example:ui:previewMessage';
const CHECK_URL = 'https://relay.example/health';
const PREVIEW_URL = 'https://relay.example/hmd/echo';
const DESCRIPTOR_TARGET = 'https://relay.example/descriptor-action';
const IEP = 'https://markjspivey-xwisee.github.io/interego/ns/iep#';
const session = (actor = OWNER): Args => ({
  _session_agent_did: actor,
  _session_bearer: 'synthetic-session',
  _session_principal: 'synthetic-principal',
  _session_user_id: actor === OWNER ? 'owner' : 'other',
});

function fixture(options: { target?: string; descriptorAction?: boolean; descriptorStatus?: number } = {}) {
  const root = generateKeyPair();
  const descriptorTurtle = `@prefix iep: <${IEP}> .
@prefix hydra: <http://www.w3.org/ns/hydra/core#> .
<${DESCRIPTOR}> a iep:ContextDescriptor ; iep:describes <${GRAPH}> .
${options.descriptorAction ? `<urn:descriptor-action> a iep:Affordance ; iep:action <${READ}> ; hydra:method "GET" ; hydra:target <${DESCRIPTOR_TARGET}> .` : ''}`;
  const graph = `@prefix iep: <${IEP}> .
@prefix schema: <https://schema.org/> .
@prefix hydra: <http://www.w3.org/ns/hydra/core#> .
@prefix sh: <http://www.w3.org/ns/shacl#> .
@prefix xsd: <http://www.w3.org/2001/XMLSchema#> .
<${GRAPH}> a schema:CreativeWork ; schema:name "Private UI" ; schema:text "Try the advertised controls." .
<${GRAPH}:read> a iep:Affordance ; iep:action <${READ}> ; hydra:method "GET" ; hydra:target <${options.target ?? CHECK_URL}> .
<${GRAPH}:preview> a iep:Affordance ; iep:action <${PREVIEW}> ; hydra:method "POST" ; hydra:target <${PREVIEW_URL}> ; hydra:expects <${GRAPH}:input> .
<${GRAPH}:input> a sh:NodeShape ; sh:property [ sh:path <urn:example:message> ; sh:name "Message" ; sh:datatype xsd:string ; sh:minCount 1 ; sh:maxLength 280 ] .`;
  const envelope = createEncryptedEnvelope(graph, [managedRecipientKey(root, OWNER, IDENTITY).publicKey], root);
  const keyContext = (args: Args): ManagedKeyContext => ({
    root, identityUrl: IDENTITY, storeOrigins: new Set([ORIGIN]),
    sessionActor: typeof args['_session_agent_did'] === 'string' ? args['_session_agent_did'] : undefined,
    ownPodUrl: typeof args['_session_user_id'] === 'string' ? ORIGIN + '/' + args['_session_user_id'] + '/' : undefined,
  });
  const getDescriptor = vi.fn(async (args: Args, project = true) => {
    expect(args['url']).toBe(DESCRIPTOR);
    const content = openManagedEnvelope(keyContext(args), envelope, GRAPH_URL);
    return JSON.stringify({
      turtle: descriptorTurtle, graph: { content, encrypted: true },
      ...(project && content ? { rendered: noteToHyperMarkdown({
        viewUrl: 'https://relay.example/render/private', authority: DESCRIPTOR,
        descriptorTurtle, plaintextTurtle: content, graphIri: GRAPH,
      }) } : {}),
    });
  });
  const requests: { url: string; method: string; body?: string; authorization: string | null }[] = [];
  const fetch: FetchFn = async (url, init) => {
    requests.push({ url, method: init?.method ?? 'GET',
      ...(typeof init?.body === 'string' ? { body: init.body } : {}),
      authorization: new Headers(init?.headers).get('authorization'),
    });
    if (url === DESCRIPTOR) return new Response(descriptorTurtle, {
      status: options.descriptorStatus ?? 200, headers: { 'content-type': 'text/turtle' },
    });
    if (![CHECK_URL, PREVIEW_URL, DESCRIPTOR_TARGET].includes(url)) throw new Error('Unexpected target fetch');
    return new Response(JSON.stringify({ ok: true, received: init?.body ? JSON.parse(String(init.body)) : null }), {
      headers: { 'content-type': 'application/json' },
    });
  };
  const context: Args = {
    normalizeCssUrl: (url: string) => url,
    signedActPayload: async (_args: Args, payload: unknown) => payload,
    normalizeActPayload: (payload: unknown) => payload,
    handleSignRequest: async () => { throw new Error('No signing expected'); },
    resourceCompositions: { invoke: async () => undefined }, resourceWriteContext: () => ({}),
    resourceInvocation: () => undefined,
    withAmepSession, guardedInvokeFetch: fetch, PUBLIC_BASE_URL: 'https://relay.example',
    stampAmepProof: async (payload: unknown) => payload, amepActSigner: undefined,
    recipientKeyFor: async (args: Args, targetUrl: string) => {
      const ownPodUrl = keyContext(args).ownPodUrl;
      return ownPodUrl && mayUseRelayKey({ targetUrl, ownPodUrl, storeOrigins: new Set([ORIGIN]) }) ? root : undefined;
    },
    envelopeOpenerFor: async (args: Args) => (input: typeof envelope, url: string) => openManagedEnvelope(keyContext(args), input, url),
    handleGetDescriptor: getDescriptor,
    kernelAct, AffordanceNotFoundError, extractAffordancesFromTurtle, sameAction,
    isFollowableTarget: (url: string) => [CHECK_URL, PREVIEW_URL, DESCRIPTOR_TARGET].includes(url),
    CSS_URL: ORIGIN + '/',
    mayUseRelayKey, STORE_ORIGINS: new Set([ORIGIN]),
    ENVELOPE_SHARING_IRI: 'urn:unrelated:sharing',
    decorateKernelResult: (result: unknown) => result, log: () => undefined,
    callerAgentId: (args: Args) => args['_session_agent_did'],
    canonicalSessionActorId: (actor: string) => actor,
    IDENTITY_URL: IDENTITY, parseHypermediaMarkdown, viewerControls,
  };
  context['callerOwnPod'] = handler('callerOwnPod', context);
  context['resolveGraphAffordanceForInvoke'] = handler('resolveGraphAffordanceForInvoke', context);
  return { getDescriptor, requests,
    render: handler('handleRenderHmd', context),
    invoke: handler('handleInvokeAffordance', context),
    act: handler('handleKernelAct', context),
  };
}

describe.each(['invoke', 'act'] as const)('private HMD graph controls through %s', verb => {
  it('executes the recipient-visible GET and POST controls with the same authenticated context as rendering', async () => {
    const f = fixture();
    const ownSession = session();
    const view = JSON.parse(await f.render({ ...ownSession, descriptor_url: DESCRIPTOR }));
    expect(view.controls).toEqual(expect.arrayContaining([
      expect.objectContaining({ action: READ, method: 'GET', executable: true }),
      expect.objectContaining({ action: PREVIEW, method: 'POST', executable: true, fields: [expect.objectContaining({ name: 'Message' })] }),
    ]));
    for (const [action, payload] of [[READ, {}], [PREVIEW, { message: 'synthetic preview' }]] as const) {
      const result = JSON.parse(await f[verb]({ ...ownSession, descriptor_url: DESCRIPTOR, action_iri: action, payload }));
      expect(result.status).toBe(200);
      expect(result.affordance).toMatchObject({ action, target: action === READ ? CHECK_URL : PREVIEW_URL });
    }
    const targets = f.requests.filter(request => request.url !== DESCRIPTOR);
    expect(targets).toEqual([
      { url: CHECK_URL, method: 'GET', authorization: null },
      { url: PREVIEW_URL, method: 'POST', body: JSON.stringify({ message: 'synthetic preview' }), authorization: null },
    ]);
    expect(f.getDescriptor.mock.calls.slice(1)).toHaveLength(2);
    for (const [args, project] of f.getDescriptor.mock.calls.slice(1)) {
      expect(args).toMatchObject({ ...ownSession, url: DESCRIPTOR });
      expect(project).toBe(false);
    }
  });

  it.each([session(OTHER), {}, { agent_id: OWNER, pod_url: ORIGIN + '/owner/' }])(
    'does not resolve private controls for a non-recipient or caller-supplied identity %#', async identity => {
      const f = fixture();
      await expect(f[verb]({ ...identity, descriptor_url: DESCRIPTOR, action_iri: READ, payload: {} }))
        .rejects.toBeInstanceOf(AffordanceNotFoundError);
      expect(f.requests.every(request => request.url === DESCRIPTOR)).toBe(true);
      expect(f.getDescriptor).toHaveBeenCalledTimes(1);
    },
  );

  it('keeps a descriptor-declared action authoritative over a graph control with the same action', async () => {
    const f = fixture({ descriptorAction: true });
    const result = JSON.parse(await f[verb]({ ...session(), descriptor_url: DESCRIPTOR, action_iri: READ, payload: {} }));
    expect(result.affordance.target).toBe(DESCRIPTOR_TARGET);
    expect(f.requests.map(request => request.url)).toEqual([DESCRIPTOR, DESCRIPTOR_TARGET]);
    expect(f.getDescriptor).not.toHaveBeenCalled();
  });

  it('does not enter the graph fallback after a refused descriptor fetch', async () => {
    const f = fixture({ descriptorStatus: 403 });
    await expect(f[verb]({ ...session(), descriptor_url: DESCRIPTOR, action_iri: READ, payload: {} }))
      .rejects.toThrow('Failed to fetch descriptor');
    expect(f.requests.map(request => request.url)).toEqual([DESCRIPTOR]);
    expect(f.getDescriptor).not.toHaveBeenCalled();
  });

  it.each([
    { action: 'urn:example:ui:unknown' },
    { action: READ, target: 'http://127.0.0.1/internal' },
  ])('does not follow an unknown action or an unscreened payload target %j', async input => {
    const f = fixture({ target: input.target });
    await expect(f[verb]({ ...session(), descriptor_url: DESCRIPTOR, action_iri: input.action, payload: {} }))
      .rejects.toBeInstanceOf(AffordanceNotFoundError);
    expect(f.requests.every(request => request.url === DESCRIPTOR)).toBe(true);
  });
});

it('keeps direct-target act on its existing path without consulting private graph authority', async () => {
  const f = fixture();
  const result = JSON.parse(await f.act({ ...session(), target: CHECK_URL, action: READ, method: 'GET', payload: {} }));
  expect(result.status).toBe(200);
  expect(f.requests.map(request => request.url)).toEqual([CHECK_URL]);
  expect(f.getDescriptor).not.toHaveBeenCalled();
});
