#!/usr/bin/env tsx
/**
 * Execute the registered HTTP revocation callback without importing the self-starting relay.
 * AST extraction keeps this tied to the production route, rather than a copied handler.
 * Real Solid registry readers/writers round-trip the owner's Turtle; OAuth and audit are
 * boundary ports. Credential signature and alias selection coverage remains in
 * delegation-subject.test.ts.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { compileFunction } from 'node:vm';
import ts from 'typescript';
import {
  createOwnerProfile, ownerProfileToTurtle, removeAuthorizedAgent,
  type IRI, type AuthorizedAgentData,
} from '@interego/core';
import type { FetchFn } from '@interego/core/http';
import { AGENT_REGISTRY_PATH, readAgentRegistry, writeAgentRegistry } from '@interego/solid';
import { equivalentDelegationSubjects } from '../delegation-subject.js';

const server = readFileSync(new URL('../server.ts', import.meta.url), 'utf8');
const ast = ts.createSourceFile('server.ts', server, ts.ScriptTarget.ES2022, true, ts.ScriptKind.TS);
const routePath = '/agents/:agentIri/revoke';
const routes = ast.statements.filter(statement => {
  if (!ts.isExpressionStatement(statement) || !ts.isCallExpression(statement.expression)) return false;
  const { expression, arguments: args } = statement.expression;
  return ts.isPropertyAccessExpression(expression) && ts.isIdentifier(expression.expression) &&
    expression.expression.text === 'app' && expression.name.text === 'post' &&
    args[0] !== undefined && ts.isStringLiteral(args[0]) && args[0].text === routePath;
});
assert.equal(routes.length, 1, 'exactly one production HTTP revoke route is registered');
const variable = (name: string): string => {
  const statements = ast.statements.filter(statement => ts.isVariableStatement(statement) &&
    statement.declarationList.declarations.some(declaration =>
      ts.isIdentifier(declaration.name) && declaration.name.text === name));
  assert.equal(statements.length, 1, 'missing or ambiguous production declaration: ' + name);
  return statements[0]!.getText(ast);
};
const scopeFunctions = ast.statements.filter(statement =>
  ts.isFunctionDeclaration(statement) && statement.name?.text === 'hasWriteOauthScope');
assert.equal(scopeFunctions.length, 1, 'execute the production OAuth write-scope gate');
const fragment = [
  variable('OAUTH_SCOPE_FULL'), variable('OAUTH_SCOPE_WRITE'),
  variable('WRITE_SIDE_OAUTH_SCOPES'), scopeFunctions[0]!.getText(ast),
  routes[0]!.getText(ast),
].join('\n');
const compiled = ts.transpileModule(fragment, {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None },
  reportDiagnostics: true,
  fileName: 'revoke-route-fixture.ts',
});
assert.deepEqual(
  (compiled.diagnostics ?? []).filter(diagnostic => diagnostic.category === ts.DiagnosticCategory.Error),
  [], 'the extracted production route must transpile',
);

const CSS_URL = 'https://gate.example.test/';
const IDENTITY_URL = 'https://identity.interego.xwisee.com';
const pod = CSS_URL + 'owner/';
const owner = 'https://identity.example.test/users/owner/profile#me' as IRI;
const slug = 'chatgpt-u-pk-731e988c2c5b';
const did = 'did:web:identity.interego.xwisee.com:agents:' + slug;
const foreign = 'did:web:attacker.test:agents:' + slug;
const legacy: AuthorizedAgentData = {
  agentId: slug as IRI, delegatedBy: owner, scope: 'ReadWrite', validFrom: '2020-01-01T00:00:00Z',
};
const canonical: AuthorizedAgentData = { ...legacy, agentId: did as IRI, scope: 'ReadOnly' };

interface Token {
  scopes?: readonly string[];
  extra?: { userId?: string; ownerWebId?: string };
}
interface RouteRequest {
  headers: { authorization?: string };
  params: { agentIri: string };
  body: { reason: string };
}
interface RouteResponse {
  status(code: number): RouteResponse;
  json(body: Record<string, unknown>): RouteResponse;
}
type RevokeHandler = (req: RouteRequest, res: RouteResponse) => Promise<unknown>;

function fixture(agents: AuthorizedAgentData[], token: Token = {
  scopes: ['mcp:write'], extra: { userId: 'owner', ownerWebId: owner },
}) {
  let turtle = ownerProfileToTurtle(createOwnerProfile(owner, 'Fixture owner', agents));
  const originalTurtle = turtle;
  const requests: { url: string; method: string }[] = [];
  let writes = 0;
  const solidFetch: FetchFn = async (url, init) => {
    const method = init?.method ?? 'GET';
    requests.push({ url, method });
    assert.equal(url, pod + AGENT_REGISTRY_PATH, 'the route targets the token-bound own pod');
    if (method === 'GET') {
      return new Response(turtle, { status: 200, headers: { 'Content-Type': 'text/turtle' } });
    }
    assert.equal(method, 'PUT', 'revocation uses the real registry writer');
    assert.equal(typeof init?.body, 'string');
    turtle = init!.body as string;
    writes += 1;
    return new Response(null, { status: 204 });
  };
  const profileCache = new Map([[pod, 'cached own profile'], [CSS_URL + 'other/', 'other profile']]);
  const cacheKeys = [slug, did, 'did:key:unrelated'].map(subject => pod + '|' + subject);
  const scopeCache = new Map(cacheKeys.map(key => [key, 'cached scope']));
  const registrationCache = new Map(cacheKeys.map(key => [key, 'cached registration']));
  let route: RevokeHandler | undefined;
  const ports = {
    app: {
      post: (path: string, _limiter: unknown, handler: RevokeHandler) => {
        assert.equal(path, routePath);
        route = handler;
      },
    },
    bearerVerifyLimiter: Symbol('fixture limiter'),
    oauthProvider: {
      verifyAccessToken: async (value: string) => {
        if (value !== 'fixture-valid') throw new Error('Invalid fixture token');
        return token;
      },
    },
    CSS_URL, IDENTITY_URL, solidFetch, readAgentRegistry, writeAgentRegistry,
    equivalentDelegationSubjects, removeAuthorizedAgent,
    relayProfileCache: profileCache, agentScopeCache: scopeCache,
    agentRegistrationCache: registrationCache,
    buildAccessChangeEvent: (event: Record<string, unknown>) => ({ ...event, fixture: true }),
    log: (_message: string) => undefined,
  };
  compileFunction(compiled.outputText, Object.keys(ports), {
    filename: 'production-http-revoke-route.js',
  })(...Object.values(ports));
  assert.ok(route, 'the actual Express registration captures its callback');
  const invoke = async (principal = did, authorization: string | undefined = 'Bearer fixture-valid') => {
    let status = 200;
    let body: Record<string, unknown> | undefined;
    const response: RouteResponse = {
      status: code => { status = code; return response; },
      json: value => { body = value; return response; },
    };
    await route!({
      headers: { authorization }, params: { agentIri: encodeURIComponent(principal) },
      body: { reason: 'bounded route regression' },
    }, response);
    assert.ok(body, 'every route outcome returns a JSON response');
    return { status, body };
  };
  return {
    invoke, requests, profileCache, scopeCache, registrationCache,
    get writes() { return writes; },
    get turtle() { return turtle; },
    originalTurtle,
    persisted: () => readAgentRegistry(pod, { fetch: solidFetch }),
  };
}

for (const agents of [[legacy], [legacy, canonical]]) {
  const f = fixture(agents);
  const result = await f.invoke();
  assert.equal(result.status, 200);
  assert.equal(result.body.revoked, true);
  assert.deepEqual(new Set(result.body.revokedSubjects as string[]), new Set([did, slug]));
  assert.equal(result.body.remaining, 0);
  assert.equal(f.writes, 1, 'all equivalent rows are revoked in a single persisted registry write');
  const persisted = await f.persisted();
  assert.ok(persisted);
  assert.equal(persisted.authorizedAgents.length, 0,
    'actual Turtle serialization cannot leave a legacy grant that revives the canonical caller');
  assert.equal(f.profileCache.has(pod), false);
  assert.equal(f.profileCache.has(CSS_URL + 'other/'), true);
  for (const subject of [slug, did]) {
    assert.equal(f.scopeCache.has(pod + '|' + subject), false, 'every equivalent scope cache is evicted');
    assert.equal(f.registrationCache.has(pod + '|' + subject), false,
      'every equivalent registration cache is evicted');
  }
  assert.equal(f.scopeCache.has(pod + '|did:key:unrelated'), true);
  assert.equal(f.registrationCache.has(pod + '|did:key:unrelated'), true);
}

const refusals: { label: string; token: Token; principal?: string; authorization?: string; status: number }[] = [
  { label: 'read-only OAuth', token: { scopes: ['mcp:read'],
    extra: { userId: 'owner', ownerWebId: owner } }, status: 403 },
  { label: 'different registry owner', token: { scopes: ['mcp:write'],
    extra: { userId: 'owner', ownerWebId: 'https://attacker.test/profile#me' } }, status: 403 },
  { label: 'missing owner binding', token: { scopes: ['mcp:write'], extra: { userId: 'owner' } }, status: 403 },
  { label: 'invalid bearer', token: { scopes: ['mcp:write'],
    extra: { userId: 'owner', ownerWebId: owner } }, authorization: 'Bearer fixture-invalid', status: 401 },
  { label: 'foreign DID authority', token: { scopes: ['mcp:write'],
    extra: { userId: 'owner', ownerWebId: owner } }, principal: foreign, status: 404 },
];
for (const refusal of refusals) {
  const f = fixture([legacy, canonical], refusal.token);
  const result = await f.invoke(refusal.principal ?? did, refusal.authorization ?? 'Bearer fixture-valid');
  assert.equal(result.status, refusal.status, refusal.label);
  assert.equal(f.writes, 0, refusal.label + ' must not mutate a registry');
  assert.equal(f.turtle, f.originalTurtle, refusal.label + ' leaves serialized grants intact');
  assert.equal(f.profileCache.has(pod), true, refusal.label + ' cannot invalidate another owner state');
  assert.equal(f.scopeCache.size, 3);
  assert.equal(f.registrationCache.size, 3);
}
process.stdout.write('Production HTTP alias revocation, cache eviction and authorization refusals passed\n');
