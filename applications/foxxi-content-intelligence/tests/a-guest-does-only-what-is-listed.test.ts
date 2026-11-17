/**
 * A general guest does only what the allow-list names (src/guest-operations.ts).
 *
 * WHY. A general guest is a caller with no wallet and no directory role. The bridge has over a
 * hundred routes and tools, most of them for an operator, a tenant or an agent, and some of them
 * destructive. A guest reaches none of them: it calls one route with one of a short list of
 * operation names, and everything else is refused by default. These tests hold the list exact,
 * refuse every name the bridge offers anyone else, and refuse any request that says who it is
 * for, on whose authority, or which pod it touches.
 *
 * Everything here is synthetic.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { GUEST_OPERATIONS, GUEST_OPERATION_PURPOSE, decideGuestOperation, isDelegationName } from '../src/guest-operations.js';
import { decideCallerPrincipal, generalGuestPrincipal, type DelegationChecks } from '../src/caller-principal.js';
import type { RecoveredSignedRequest } from '../src/auth.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const server = readFileSync(join(ROOT, 'bridge', 'server.ts'), 'utf8');
const affordances = readFileSync(join(ROOT, 'affordances.ts'), 'utf8');

const KEY = '0x' + 'ab'.repeat(20);
const ask = (operation: unknown, args: unknown = {}, extra: Record<string, unknown> = {}): unknown =>
  ({ agent_id: `did:ethr:${KEY}`, timestamp: '2026-11-17T10:00:00.000Z', purpose: GUEST_OPERATION_PURPOSE, operation, args, ...extra });

describe('the allow-list', () => {
  it('is exactly these six operations', () => {
    expect(Object.keys(GUEST_OPERATIONS).sort()).toEqual(['course.launch', 'course.next', 'course.resolve', 'guest.sign_out', 'guest.standing', 'record.read']);
  });

  it('only answering a step writes, and every operation says why a guest may do it', () => {
    expect(Object.entries(GUEST_OPERATIONS).filter(([, spec]) => spec.writes).map(([name]) => name)).toEqual(['course.next']);
    for (const spec of Object.values(GUEST_OPERATIONS)) expect(spec.why.length).toBeGreaterThan(20);
  });

  it('each listed operation is let through with its own arguments', () => {
    expect(decideGuestOperation(ask('record.read'))).toMatchObject({ ok: true, operation: 'record.read', args: {} });
    expect(decideGuestOperation(ask('course.launch', { composition: 'urn:foxxi:composition:sha256:feed' }))).toMatchObject({ ok: true, operation: 'course.launch' });
    expect(decideGuestOperation(ask('course.next', { session_id: 's-1', answers: ['b'], expected_step: 2 }))).toMatchObject({ ok: true, operation: 'course.next' });
  });
});

describe('default-deny', () => {
  const refused = { ok: false, status: 403, code: 'general_guest_operation_refused' };

  it('refuses a name that is not on the list, whatever it looks like', () => {
    for (const name of ['', 'record.write', 'record.delete', 'course.author', 'guest.link', 'tenant.bootstrap', 'RECORD.READ', 'record.read ', 'constructor', 'toString', '__proto__', 42, null, undefined, ['record.read']]) {
      expect(decideGuestOperation(ask(name)), String(name)).toEqual(refused);
    }
  });

  it('refuses every foxxi.* tool the bridge offers, by its tool name', () => {
    const tools = new Set([...server.matchAll(/'(foxxi\.[a-z0-9_.]+)'/g), ...affordances.matchAll(/'(foxxi\.[a-z0-9_.]+)'/g)].map(m => m[1]!));
    expect(tools.size).toBeGreaterThan(60);
    for (const tool of tools) expect(decideGuestOperation(ask(tool)), tool).toEqual(refused);
  });

  it('refuses every route the bridge serves, by its path', () => {
    const routes = new Set([...server.matchAll(/^app\.(?:get|post|put|delete|all)\((?:\[)?'([^']+)'/gm)].map(m => m[1]!));
    expect(routes.size).toBeGreaterThan(90);
    for (const path of routes) expect(decideGuestOperation(ask(path)), path).toEqual(refused);
  });

  it('refuses an argument the operation does not name', () => {
    expect(decideGuestOperation(ask('record.read', { limit: 5 }))).toEqual({ ok: false, status: 400, code: 'general_guest_input_invalid' });
    expect(decideGuestOperation(ask('course.launch', { composition: 'urn:x', answers: [] }))).toEqual({ ok: false, status: 400, code: 'general_guest_input_invalid' });
  });

  it('refuses a payload that is not exactly the five signed fields', () => {
    const invalid = { ok: false, status: 400, code: 'general_guest_input_invalid' };
    expect(decideGuestOperation(null)).toEqual(invalid);
    expect(decideGuestOperation('record.read')).toEqual(invalid);
    expect(decideGuestOperation(ask('record.read', []))).toEqual(invalid);
    expect(decideGuestOperation(ask('record.read', {}, { note: 'x' }))).toEqual(invalid);
    const { args: _args, ...noArgs } = ask('record.read') as Record<string, unknown>;
    expect(decideGuestOperation(noArgs)).toEqual(invalid);
  });
});

describe('a guest acts as itself: any delegation claim fails closed', () => {
  const claim = { ok: false, status: 403, code: 'general_guest_delegation_refused' };
  const names = ['acting_as', 'actingAs', 'act_as', 'on_behalf_of', 'onBehalfOf', 'delegation', 'delegated_by', 'subject', 'subject_did', 'learner_did',
    'learner_kind', 'agent', 'did', 'webId', 'user_id', 'guest_did', 'role', 'pod_url', 'subject_pod_url', 'learner_pod_url', 'tenant_pod_url', '_session', 'admission'];

  it('among the arguments, whatever the value, even the guest\'s own', () => {
    for (const name of names) {
      expect(isDelegationName(name), name).toBe(true);
      expect(decideGuestOperation(ask('record.read', { [name]: 'did:web:identity.example:users:u-try-guest-' + '0'.repeat(32) })), name).toEqual(claim);
      expect(decideGuestOperation(ask('course.next', { session_id: 's-1', answers: [], [name]: null })), name).toEqual(claim);
    }
  });

  it('at the top of the signed payload', () => {
    for (const name of names) expect(decideGuestOperation(ask('record.read', {}, { [name]: 'x' })), name).toEqual(claim);
  });

  it('on an operation that is not allowed either: the claim is what is answered', () => {
    expect(decideGuestOperation(ask('foxxi.assign_audience', { acting_as: 'did:web:identity.example:users:someone' }))).toEqual(claim);
  });

  it('the arguments a guest operation does take are not claims', () => {
    for (const name of ['composition', 'session_id', 'answers', 'expected_step']) expect(isDelegationName(name), name).toBe(false);
  });
});

describe('a guest is not a signed /agent caller', () => {
  const SIGNER = '0xAbCdEf0123456789aBcDeF0123456789AbCdEf01';
  const GUEST = 'did:web:identity.example:users:u-try-guest-' + '1f'.repeat(16);
  const reads: string[] = [];
  const checks: DelegationChecks = {
    podFor: (a) => { reads.push(a); return 'https://pods.example/foxxi/'; },
    verify: async () => ({ valid: true, trustLevel: 'CryptographicallyVerified' }),
    anchorOf: async () => SIGNER,
  };
  const signedAs = (agentId: string): RecoveredSignedRequest => ({ ok: true, signer: SIGNER, agentId, payload: { agent_id: agentId } });

  it('a request signed in a guest\'s name is refused before any pod is read, even with a verified delegation behind it', async () => {
    for (const bounds of [true, false]) {
      const r = await decideCallerPrincipal(signedAs(GUEST), checks, { agentIdBounds: bounds, anchorRefusalExplains: false });
      expect(r).toMatchObject({ ok: false, reason: 'general-guest-not-accepted', status: 403 });
    }
    expect(await decideCallerPrincipal(signedAs(`  ${GUEST} `), checks, { agentIdBounds: false, anchorRefusalExplains: false })).toMatchObject({ ok: false, reason: 'general-guest-not-accepted' });
    expect(reads).toEqual([]);
  });

  it('a tab key admitted as a guest is refused, signing as itself or for an agent', async () => {
    const guestKey = (signer: string): boolean => signer === SIGNER;
    const opts = { agentIdBounds: true, anchorRefusalExplains: true, guestKey };
    expect(await decideCallerPrincipal(signedAs(`did:ethr:${SIGNER}`), checks, opts)).toMatchObject({ ok: false, reason: 'general-guest-key', status: 403 });
    expect(await decideCallerPrincipal(signedAs('https://relay.example/agents/some-agent-u-eth-1234'), checks, opts)).toMatchObject({ ok: false, reason: 'general-guest-key', status: 403 });
    expect(reads).toEqual([]);
  });

  it('a key that is not a guest\'s is decided as before', async () => {
    const r = await decideCallerPrincipal(signedAs(`did:ethr:${SIGNER}`), checks, { agentIdBounds: true, anchorRefusalExplains: true, guestKey: () => false });
    expect(r).toMatchObject({ ok: true, principal: { authMode: 'direct', subject: `did:ethr:${SIGNER}` } });
  });

  it('a guest\'s principal is about the guest, not the key that signed', () => {
    const guest = { userId: 'u-try-guest-' + '1f'.repeat(16), guestDid: GUEST, podUrl: 'https://pods.example/u-try-guest-' + '1f'.repeat(16) + '/', expiresAt: 1 };
    expect(generalGuestPrincipal(SIGNER.toLowerCase(), { a: 1 }, guest)).toEqual({ subject: GUEST, key: SIGNER.toLowerCase(), authMode: 'general-guest', kind: 'human', payload: { a: 1 }, guest });
  });
});

describe('bridge/server.ts is wired to the rule', () => {
  it('the one signed-caller resolver refuses a guest\'s tab key', () => {
    expect(server).toMatch(/decideCallerPrincipal\(recoverSignedRequest\(body\), signedCallerDelegationChecks, \{ \.\.\.opts, guestKey: signer => dashboardGuestKeys\?\.\(signer\) \?\? false \}\)/);
  });

  it('a guest\'s handlers are exactly the allow-list, and none is given a pod or a subject by the request', () => {
    const start = server.indexOf('const guestPorts: DashboardGuestPorts = {'), end = server.indexOf('const dashboardGeneralGuests = new DashboardGeneralGuest(');
    expect(start).toBeGreaterThan(0); expect(end).toBeGreaterThan(start);
    const block = server.slice(start, end);
    const handled = [...block.matchAll(/^ {4}'([a-z_.]+)': async \(principal/gm)].map(m => m[1]!).sort();
    expect(handled).toEqual(Object.keys(GUEST_OPERATIONS).filter(name => !name.startsWith('guest.')).sort());
    // Whose record and which pod: from the principal. Not the tenant pod, not the shared resolver, not a lens or a lattice.
    const whole = server.slice(server.indexOf('const dashboardGeneralGuest = dashboardGeneralGuestSettings('), end);
    for (const never of ['resolveSubjectPodUrl(', 'lensTenantFor(', 'composeIntoSharedLattice(', 'storeStatementDurably(', 'forwardInOrder(', 'fragmentEfficacy.record(', 'persistEfficacy(', 'learnerAdmissions(', 'learnerCompetencies(']) {
      expect(whole.includes(never), never).toBe(false);
    }
    expect(whole).toContain('guestRecords.append(principal.guest, statements)');
  });

  it('the guest routes are attached only where the switch is on', () => {
    expect(server).toMatch(/const dashboardGeneralGuest = dashboardGeneralGuestSettings\(process\.env, playGrantSettings\);\nif \(dashboardGeneralGuest && playGrants\) \{/);
    expect(server.match(/attachDashboardGeneralGuestRoutes\(/g)).toHaveLength(1);
  });
});
