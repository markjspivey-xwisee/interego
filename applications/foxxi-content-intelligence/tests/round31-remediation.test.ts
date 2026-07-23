/**
 * Round-31: privilege-escalation fix. The admin / learning-engineer roles are
 * granted purely on a web_id STRING match. A self-sovereign tenant publishes a
 * PUBLIC membership whose web_id is caller-declared (register_self_sovereign_learner),
 * so a caller could self-declare web_id = adminWebId in their OWN pod's membership and
 * then authenticate against it to be resolved as GLOBAL admin (round-30 blocker).
 *
 * The fix scopes the privileged identities in resolveCaller: for a NON-configured
 * (self-sovereign) tenant it passes adminWebId='' + learningEngineerWebIds=∅, so
 * resolveCallerContext can never grant admin/LE off a self-declared web_id. This
 * asserts the core: resolveCallerContext grants admin ONLY when a non-empty
 * adminWebId is supplied.
 */

import { describe, it, expect } from 'vitest';
import { resolveCallerContext } from '../src/policy.js';

describe('round-31 — resolveCallerContext grants admin only when a configured adminWebId is supplied', () => {
  const users = [{ user_id: 'u1', web_id: 'https://css/attacker/profile/card#me', wallet_address: '0xabc' }] as never;

  it('configured tenant (adminWebId supplied): a member whose web_id === adminWebId IS admin', () => {
    const ctx = resolveCallerContext({
      callerWebId: 'https://css/johnny/profile/card#me',
      callerUserId: 'u1',
      users,
      adminWebId: 'https://css/johnny/profile/card#me',
      learningEngineerWebIds: new Set(),
    });
    expect(ctx.role).toBe('admin');
  });

  it('self-sovereign tenant (adminWebId=\'\'): the SAME self-declared admin web_id is NOT admin', () => {
    const ctx = resolveCallerContext({
      callerWebId: 'https://css/johnny/profile/card#me', // attacker self-declared the admin's WebID
      callerUserId: 'u1',
      users,
      adminWebId: '',                    // scoped: self-sovereign tenant grants no privileged role
      learningEngineerWebIds: new Set(), // scoped: empty
    });
    expect(ctx.role).not.toBe('admin');
    expect(ctx.role).not.toBe('learning-engineer');
  });

  it('self-sovereign tenant: a self-declared learning-engineer web_id is NOT learning-engineer when the LE set is empty', () => {
    const ctx = resolveCallerContext({
      callerWebId: 'https://css/le-person/profile/card#me',
      callerUserId: 'u1',
      users,
      adminWebId: '',
      learningEngineerWebIds: new Set(), // scoped empty — the self-declared LE web_id cannot match
    });
    expect(ctx.role).not.toBe('learning-engineer');
    expect(ctx.role).not.toBe('admin');
  });
});
