/** Execute the shipping signed xAPI handler and ownership resolver. Only signature
 * verification, LRS transport and pod persistence are fixture ports; no network
 * requests, pod writes or new operational observations are made by these tests. */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { randomBytes, randomUUID } from 'node:crypto';
import { compileFunction } from 'node:vm';
import ts from 'typescript';
import { resolveSubjectPodUrlPure } from '../src/subject-pod-url.js';
import { safePublicUrlOrUndefined } from '../src/ssrf-guard.js';
import { actorForPod } from '../src/mesh-event-projector.js';
import { readSelfXapi, writeSelfXapi } from '../src/self-xapi.js';

const source = readFileSync(new URL('../bridge/server.ts', import.meta.url), 'utf8');
const ast = ts.createSourceFile('server.ts', source, ts.ScriptTarget.ES2022, true);
const functions = new Set(['resolveSubjectPodUrl', 'selfBoundPod', 'sameStore', 'samePodPrincipal', 'lensTenantFor']);
const variables = new Set(['podPrincipalKey', 'signedXapiHandler']);
const code = ast.statements.filter(node => ts.isFunctionDeclaration(node) ? functions.has(node.name?.text ?? '')
  : ts.isVariableStatement(node) && node.declarationList.declarations.some(d => ts.isIdentifier(d.name) && variables.has(d.name.text)))
  .map(node => node.getText(ast)).join('\n');
if (!code.includes('const signedXapiHandler')) throw new Error('Shipping signed xAPI handler is missing.');
const javascript = ts.transpileModule(code, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } }).outputText;
const did = 'did:ethr:0x1111111111111111111111111111111111111111';
const derived = 'https://gate.example/eth-111111111111/';
const own = 'https://gate.example/u-eth-111111111111/';
const statement = () => ({ id: randomUUID(), timestamp: '2026-10-16T14:00:00Z',
  actor: { objectType: 'Agent', account: { homePage: 'urn:test:services', name: did } },
  verb: { id: 'urn:test:observed-service-snapshot' }, object: { objectType: 'Activity', id: 'urn:test:game-service' } });
type Statement = Record<string, unknown>;
interface Reply { status: number; body: Record<string, unknown> }
type Handler = (req: Record<string, unknown>, res: Record<string, unknown>) => Promise<void>;
function fixture({ authenticated = true, persisted = true } = {}) {
  const credentials = new Map<string, string>(), scopes: string[] = [], requests: string[] = [], writes: Record<string, unknown>[] = [];
  const lrs = new Map<string, Map<string, Statement>>();
  class CaptureError extends Error { status = 500; }
  const ports = {
    tenantPodUrl: 'https://gate.example/foxxi/', SAME_STORE_ORIGINS: new Set(['https://gate.example', 'http://css.internal:3456']),
    resolveSubjectPodUrlPure, safePublicUrlOrUndefined, actorForPod, MESH_ACTOR_LABELS: {}, readSelfXapi, writeSelfXapi,
    bindSignedCaller: async (payload: Record<string, unknown>) => authenticated
      ? { ok: true, callerDid: did, payload } : { ok: false, status: 401, error: 'invalid signature' },
    checkAgenticRateLimit: () => ({ ok: true }), telemetryCaptureStore: () => ({}), randomUUID, randomBytes,
    inboundCredentials: {
      add: (value: { principal: string; tenant: string }) => { credentials.set(value.principal, value.tenant); scopes.push(value.tenant); return { id: value.principal }; },
      remove: (id: string) => { credentials.delete(id); },
    },
    createSelfXapiRequest: ({ principal }: { principal: string }) => async (method: string, query: URLSearchParams, submitted?: Statement[]) => {
      const scope = credentials.get(principal); if (!scope) throw new Error('Request escaped its scoped credential');
      requests.push(scope); let records = lrs.get(scope); if (!records) lrs.set(scope, records = new Map());
      if (method === 'POST') {
        for (const s of submitted ?? []) records.set(String(s.id), { ...s, stored: '2026-10-16T14:00:01Z', authority: { account: { name: scope } } });
        return { status: 200, body: (submitted ?? []).map(s => s.id) };
      }
      const id = query.get('statementId');
      return id ? { status: records.has(id) ? 200 : 404, body: records.get(id) ?? { error: 'not found' } }
        : { status: 200, body: { statements: [...records.values()], more: '' } };
    },
    composeIntoSharedLattice: async (args: Record<string, unknown>) => { writes.push(args); return { persisted, holonUri: 'urn:test:stored', descriptorUrl: String(args.podUrl) + 'foxxi-lattice/observed.ttl' }; },
    signedXapiTimeoutMs: 120000, PORT: 3000, CaptureError,
    sendServerError: (_res: unknown, error: unknown) => { throw error; }, console: { warn: () => undefined }, bridgeWarn: () => undefined,
  };
  const build = compileFunction(javascript + '\nreturn signedXapiHandler;', Object.keys(ports));
  const handler = build(...Object.values(ports)) as (operation: string) => Handler;
  return { scopes, requests, writes, lrs, credentials,
    async invoke(operation: string, payload: Record<string, unknown> = {}): Promise<Reply> {
      let status = 200, body: Record<string, unknown> | undefined;
      const response = { setHeader: () => undefined, status(code: number) { status = code; return this; }, json(value: Record<string, unknown>) { body = value; return this; } };
      await handler(operation)({ body: payload, headers: {}, ip: '127.0.0.1' }, response);
      if (!body) throw new Error('Handler returned no reply');
      expect(credentials.size).toBe(0);
      return { status, body };
    },
  };
}

describe('signed xAPI uses its verified owner pod consistently', () => {
  it('persists to the signed same-wallet u-eth pod and scopes LRS write/read to that same lens', async () => {
    const f = fixture(), s = statement();
    expect((await f.invoke('write', { subject_pod_url: own, statements: [s] })).status).toBe(200);
    expect(f.writes[0]).toMatchObject({ podUrl: own, agentDid: did, label: 'u-eth-111111111111', contentType: 'xapi:Statement' });
    expect(f.scopes).toEqual(['lens:u-eth-111111111111']);
    const read = await f.invoke('read', { subject_pod_url: own, tenant: 'lens:victim', query: { statementId: s.id } });
    expect(read.status).toBe(200); expect(read.body.id).toBe(s.id);
    expect(f.requests).toEqual(Array(3).fill('lens:u-eth-111111111111'));
    expect(f.writes).toHaveLength(1);
  });
  it('honors only the configured internal spelling of the same owner pod', async () => {
    const f = fixture(), pod = 'http://css.internal:3456/u-eth-111111111111/';
    await f.invoke('write', { subject_pod_url: pod, statements: [statement()] });
    expect(f.writes[0]?.podUrl).toBe(pod); expect(f.scopes).toEqual(['lens:u-eth-111111111111']);
  });
  it('keeps the original default lens and does not merge differently selected lenses', async () => {
    const f = fixture(), s = statement(); await f.invoke('write', { statements: [s] });
    expect(f.writes[0]?.podUrl).toBe(derived); expect(f.scopes).toEqual(['lens:eth-111111111111']);
    expect((await f.invoke('read', { subject_pod_url: own, query: { statementId: s.id } })).status).toBe(404);
  });
  it.each([
    'https://gate.example/u-eth-222222222222/', 'https://attacker.example/u-eth-111111111111/',
    'https://gate.example.attacker.example/u-eth-111111111111/', 'https://gate.example:444/u-eth-111111111111/',
    'http://gate.example/u-eth-111111111111/', 'https://gate.example/victim/eth-111111111111/',
    'http://127.0.0.1/u-eth-111111111111/', 'file:///u-eth-111111111111/',
    'https://gate.example/u-eth-111111111111/../u-eth-222222222222/', null, { pod: own },
  ])('never lets a signed unowned or unsafe pod steer private LRS or persistence: %j', async pod => {
    const f = fixture(); await f.invoke('write', { subject_pod_url: pod, statements: [statement()] });
    expect(f.writes[0]?.podUrl).toBe(derived); expect(f.scopes).toEqual(['lens:eth-111111111111']);
  });
  it('does not let caller identity or foreign actor fields replace the verified signer', async () => {
    const f = fixture(), s = statement(); s.actor.account.name = 'did:example:victim';
    expect((await f.invoke('write', { agent_id: 'did:example:victim', subject_pod_url: own, statements: [s] })).status).toBe(403);
    expect(f.requests).toEqual([]); expect(f.writes).toEqual([]);
  });
  it('refuses an invalid signature before any private scope or persistence operation', async () => {
    const f = fixture({ authenticated: false }); expect((await f.invoke('read', { subject_pod_url: own })).status).toBe(401);
    expect(f.scopes).toEqual([]); expect(f.requests).toEqual([]); expect(f.writes).toEqual([]);
  });
  it('retains the failure receipt when the selected owner pod did not confirm persistence', async () => {
    const f = fixture({ persisted: false }), s = statement();
    expect(await f.invoke('write', { subject_pod_url: own, statements: [s] })).toMatchObject({ status: 502, body: { durable: false, lrsAccepted: true, statementIds: [s.id] } });
    expect(f.writes[0]?.podUrl).toBe(own);
  });
});
