/**
 * The bridge's admin-only gate decides by its fixed rule, with the substrate's ABAC policy
 * evaluated beside it in SHADOW (src/tenant-admin-policy.ts).
 *
 * Parity: over every branch of the existing rule (each role the directory can resolve a caller
 * to, a caller who is not a member, and a credential that is missing, expired or malformed) the
 * policy answers what the fixed rule answers and nothing is logged. The callers are resolved the
 * way `resolveCaller` resolves a session token: the real `trustedAddressMap`,
 * `verifySessionToken` and `resolveCallerContext` over a directory, never a hand-written role.
 *
 * Then a policy that deliberately disagrees: the log fires with the bounded record, and in shadow
 * the fixed rule's answer still stands.
 *
 * Everything here is fictional: the tenant, its people and the signing seed.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import type { PolicySet, ShadowDisagreement } from '@interego/abac/portable';
import { deriveUserWallet, mintSessionToken, trustedAddressMap, verifySessionToken } from '../src/auth.js';
import { resolveCallerContext, type CallerContext, type CallerRole } from '../src/policy.js';
import { TENANT_ADMIN_ACTION, TENANT_ADMIN_POLICIES, abacMode, callerSubjectFacts, isTenantAdmin,
  mayAdministerTenant } from '../src/tenant-admin-policy.js';

const SEED = 'a fictional seed for a fictional tenant: lanternfish';
const web = (name: string) => `https://id.lantern.example/${name}#me`;
const ADMIN = web('odalys');
const ENGINEER = web('tobiah');

interface Row { user_id: string; web_id: string; manager_user_id?: string | null; wallet_address?: string }
const row = (user_id: string, web_id: string, manager_user_id?: string): Row =>
  ({ user_id, web_id, manager_user_id, wallet_address: deriveUserWallet(user_id, SEED).address });

/** The fictional tenant directory: the authority's own rows. */
const DIRECTORY: Row[] = [
  row('u-odalys', ADMIN),
  row('u-tobiah', ENGINEER),
  row('u-marisol', web('marisol')),                       // manages u-pim
  row('u-pim', web('pim'), 'u-marisol'),
  row('u-wren', web('wren'), 'u-tobiah'),                 // so the engineer also has a report
  row('u-blank', 'not an iri at all', undefined),         // a row whose web_id names nothing
];

interface Config { adminWebId: string; learningEngineerWebIds: ReadonlySet<string>; requireAuth: boolean }
const CONFIGURED: Config = { adminWebId: ADMIN, learningEngineerWebIds: new Set([ENGINEER]), requireAuth: true };
/** A tenant that is not the configured one: `resolveCaller` grants no privileged role there. */
const SELF_SOVEREIGN: Config = { adminWebId: '', learningEngineerWebIds: new Set(), requireAuth: true };

/** The session-token path of `resolveCaller`, from the same functions: a context, or null for a refusal. */
function resolve(token: string | undefined, config: Config): CallerContext | null {
  if (!token) {
    return config.requireAuth ? null
      : { webId: config.adminWebId, userId: 'anonymous', role: 'admin', directReports: new Set() };
  }
  const verified = verifySessionToken(token, trustedAddressMap(DIRECTORY));
  if (!verified.ok) return null;
  return resolveCallerContext({
    callerWebId: verified.callerDid, callerUserId: verified.callerUserId,
    users: DIRECTORY as never, adminWebId: config.adminWebId, learningEngineerWebIds: config.learningEngineerWebIds,
  });
}

const tokenFor = (userId: string, ttlMs?: number) =>
  mintSessionToken({ userId, webId: DIRECTORY.find(u => u.user_id === userId)?.web_id ?? web('nobody'), seed: SEED, ttlMs });

interface Branch {
  name: string;
  caller: () => Promise<CallerContext | null>;
  /** The role the directory resolves the caller to, or null when `resolveCaller` refuses. */
  role: CallerRole | null;
  allowed: boolean;
}

const BRANCHES: Branch[] = [
  { name: 'the configured administrator', role: 'admin', allowed: true,
    caller: async () => resolve(await tokenFor('u-odalys'), CONFIGURED) },
  { name: 'a learning engineer (who also has a direct report)', role: 'learning-engineer', allowed: false,
    caller: async () => resolve(await tokenFor('u-tobiah'), CONFIGURED) },
  { name: 'a manager', role: 'manager', allowed: false,
    caller: async () => resolve(await tokenFor('u-marisol'), CONFIGURED) },
  { name: 'a learner', role: 'learner', allowed: false,
    caller: async () => resolve(await tokenFor('u-pim'), CONFIGURED) },
  { name: 'a delegated administrator (admin-equivalent elsewhere, not here)', role: 'delegated-admin', allowed: false,
    caller: async () => ({ webId: 'did:key:z6MkfictionalDelegate', userId: 'delegated-admin:did:key:z6MkfictionalDelegate',
      role: 'delegated-admin', directReports: new Set<string>() }) },
  { name: 'the administrator\'s web id on a tenant that is not the configured one', role: 'learner', allowed: false,
    caller: async () => resolve(await tokenFor('u-odalys'), SELF_SOVEREIGN) },
  { name: 'a member whose row names no IRI', role: 'learner', allowed: false,
    caller: async () => resolve(await tokenFor('u-blank'), CONFIGURED) },
  { name: 'a signer who is not a member', role: null, allowed: false,
    caller: async () => resolve(await tokenFor('u-stranger'), CONFIGURED) },
  { name: 'no credential', role: null, allowed: false,
    caller: async () => resolve(undefined, CONFIGURED) },
  { name: 'an expired token', role: null, allowed: false,
    caller: async () => resolve(await tokenFor('u-odalys', -60_000), CONFIGURED) },
  { name: 'a malformed token', role: null, allowed: false,
    caller: async () => resolve('this-is-not-a-token', CONFIGURED) },
  { name: 'a token cut short', role: null, allowed: false,
    caller: async () => resolve((await tokenFor('u-odalys')).slice(0, 40), CONFIGURED) },
  { name: 'a token for one member presented under another\'s web id', role: null, allowed: false,
    caller: async () => resolve(await mintSessionToken({ userId: 'u-pim', webId: ADMIN, seed: SEED }), CONFIGURED) },
  { name: 'the development mode without auth, an administrator configured', role: 'admin', allowed: true,
    caller: async () => resolve(undefined, { ...CONFIGURED, requireAuth: false }) },
];

describe('the admin gate: the policy answers what the fixed rule answers', () => {
  it.each(BRANCHES.map(b => [b.name, b] as const))('%s', async (_name, branch) => {
    const ctx = await branch.caller();
    expect(ctx?.role ?? null, 'the branch resolves to the role it names').toBe(branch.role);
    const existing = isTenantAdmin(ctx);
    expect(existing).toBe(branch.allowed);

    const logged: ShadowDisagreement[] = [];
    const shadow = mayAdministerTenant(ctx, { point: 'test.parity', mode: 'shadow', log: r => logged.push(r) });
    expect(shadow, 'shadow returns the fixed rule\'s answer').toBe(existing);
    expect(logged, 'the policy and the fixed rule agree, so nothing is logged').toEqual([]);

    // Enforcing asks the policy alone; agreement there is the parity itself.
    const enforced = mayAdministerTenant(ctx, { point: 'test.parity', mode: 'enforce', log: r => logged.push(r) });
    expect(enforced, 'the policy\'s own answer').toBe(existing);
    expect(logged).toEqual([]);
  });

  it('the table names every role a caller can be resolved to', () => {
    const roles: Record<CallerRole, true> = { admin: true, 'delegated-admin': true, 'learning-engineer': true, manager: true, learner: true };
    expect(new Set(BRANCHES.map(b => b.role).filter(Boolean))).toEqual(new Set(Object.keys(roles)));
  });

  it('the facts are the directory\'s answer and the resolved role, and nothing else', async () => {
    const ctx = await BRANCHES[0]!.caller();
    expect(callerSubjectFacts(ctx!)).toEqual({ subject: ADMIN, provisional: false, roles: ['admin'] });
  });
});

/** A policy set that is wrong on purpose: it permits a learner and no one else. */
const WRONG: PolicySet = {
  policies: [{ id: 'urn:test:policy:learners-administer', policyPredicateShape: 'urn:test:shape:learner',
    governedAction: TENANT_ADMIN_ACTION, deonticMode: 'Permit' }] as never,
  predicates: new Map([['urn:test:shape:learner', { iri: 'urn:test:shape:learner',
    constraints: [{ path: 'passport:role', minCount: 1, hasValue: 'learner' }] }]]) as never,
};

describe('the admin gate: a disagreement is logged and decides nothing in shadow', () => {
  it('a policy that would let a learner in: the learner is still refused, and one record says so', async () => {
    const learner = await resolve(await tokenFor('u-pim'), CONFIGURED);
    const logged: ShadowDisagreement[] = [];
    const answer = mayAdministerTenant(learner, { point: 'foxxi.backup_tenant_pod', mode: 'shadow', policySet: WRONG, log: r => logged.push(r) });
    expect(answer).toBe(false);
    expect(logged).toEqual([{ event: 'abac_shadow_disagreement', point: 'foxxi.backup_tenant_pod', mode: 'shadow',
      action: TENANT_ADMIN_ACTION, subject: web('pim'), existing: false, policy: 'Allowed',
      matchedPolicies: ['urn:test:policy:learners-administer'] }]);
  });

  it('and the administrator it would refuse is still let in', async () => {
    const admin = await resolve(await tokenFor('u-odalys'), CONFIGURED);
    const logged: ShadowDisagreement[] = [];
    expect(mayAdministerTenant(admin, { point: 'p', policySet: WRONG, log: r => logged.push(r) })).toBe(true);
    expect(logged).toHaveLength(1);
    expect(logged[0]).toMatchObject({ existing: true, policy: 'Indeterminate', mode: 'shadow', matchedPolicies: [] });
  });

  it('the record carries no attribute value, credential or request content', async () => {
    const token = await tokenFor('u-pim');
    const learner = resolve(token, CONFIGURED);
    const logged: ShadowDisagreement[] = [];
    mayAdministerTenant(learner, { point: 'p', policySet: WRONG, log: r => logged.push(r) });
    expect(Object.keys(logged[0]!).sort()).toEqual(['action', 'event', 'existing', 'matchedPolicies', 'mode', 'point', 'policy', 'subject']);
    const text = JSON.stringify(logged[0]);
    expect(text).not.toContain(token);
    expect(text).not.toContain('u-pim');
    expect(text).not.toContain(deriveUserWallet('u-pim', SEED).address);
    expect(text).not.toMatch(/"(roles?|provisional|passport:role)"/);
  });

  it('only the exact value `enforce` enforces', async () => {
    const learner = await resolve(await tokenFor('u-pim'), CONFIGURED);
    for (const mode of [undefined, '', 'shadow', 'ENFORCE', 'Enforce', ' enforce', 'enforce ', 'true', '1', 'on']) {
      expect(abacMode(mode), String(mode)).toBe('shadow');
      expect(mayAdministerTenant(learner, { point: 'p', mode, policySet: WRONG }), String(mode)).toBe(false);
    }
    expect(abacMode('enforce')).toBe('enforce');
    expect(mayAdministerTenant(learner, { point: 'p', mode: 'enforce', policySet: WRONG })).toBe(true);
  });

  it('a logger that throws, or a policy set that is not one, changes nothing and throws nothing', async () => {
    const admin = await resolve(await tokenFor('u-odalys'), CONFIGURED);
    const learner = await resolve(await tokenFor('u-pim'), CONFIGURED);
    const boom = () => { throw new Error('the logger failed'); };
    expect(mayAdministerTenant(admin, { point: 'p', policySet: WRONG, log: boom })).toBe(true);
    expect(mayAdministerTenant(learner, { point: 'p', policySet: WRONG, log: boom })).toBe(false);
    for (const broken of [{}, 7,{ policies: 'no', predicates: new Map() }, { policies: [null], predicates: new Map() }]) {
      expect(mayAdministerTenant(admin, { point: 'p', policySet: broken as never, log: boom })).toBe(true);
      expect(mayAdministerTenant(learner, { point: 'p', policySet: broken as never, log: boom })).toBe(false);
      // Enforcing, what cannot be evaluated is a refusal, never a grant.
      expect(mayAdministerTenant(admin, { point: 'p', mode: 'enforce', policySet: broken as never, log: boom })).toBe(false);
    }
    expect(mayAdministerTenant(admin, undefined as never)).toBe(true);
  });

  it('the one place they differ today: development mode without auth and no administrator configured', () => {
    // The fixed rule lets an unnamed caller in as admin. The policy has no subject to decide
    // about, so it refuses, and says so. Shadow keeps the fixed rule's answer.
    const anonymous = resolve(undefined, { adminWebId: '', learningEngineerWebIds: new Set(), requireAuth: false });
    const logged: ShadowDisagreement[] = [];
    expect(mayAdministerTenant(anonymous, { point: 'p', log: r => logged.push(r) })).toBe(true);
    expect(logged).toHaveLength(1);
    expect(logged[0]).toMatchObject({ existing: true, policy: 'Indeterminate', subject: '' });
  });
});

describe('the admin gate: what is deployed', () => {
  const read = (path: string) => readFileSync(new URL(`../../../${path}`, import.meta.url), 'utf8');
  const server = read('applications/foxxi-content-intelligence/bridge/server.ts');

  it('the bridge reads the mode once and passes it to the gate', () => {
    expect(server).toContain('abacMode(process.env.FOXXI_ABAC_MODE)');
    expect(server).toContain('mode: tenantAdminAbacMode');
  });

  it('every admin-only gate goes through it', () => {
    expect(server.match(/if \(!mayAdminister\((?:resolved\.)?ctx, 'foxxi\.[a-z0-9_]+'\)\)/g)?.length).toBe(13);
    expect(server).not.toMatch(/if \((?:resolved\.)?ctx\.role !== 'admin'\) /);
  });

  it('the policy set is the one the module states, and it is frozen', () => {
    expect(Object.isFrozen(TENANT_ADMIN_POLICIES)).toBe(true);
    expect(TENANT_ADMIN_POLICIES.policies).toHaveLength(1);
    expect(TENANT_ADMIN_POLICIES.policies[0]).toMatchObject({ governedAction: TENANT_ADMIN_ACTION, deonticMode: 'Permit' });
  });

  it('nothing deployed sets the mode, so everything deployed is shadow', () => {
    for (const path of ['deploy/Dockerfile.foxxi-bridge', 'deploy/railway/services.json']) {
      expect(read(path), path).not.toContain('FOXXI_ABAC_MODE');
    }
  });
});
