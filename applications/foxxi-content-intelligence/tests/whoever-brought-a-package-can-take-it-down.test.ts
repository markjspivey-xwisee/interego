/**
 * Whoever brought a package can take it down, when it is theirs alone.
 *
 * ★ WHY. Anyone who signs may bring a package to be hosted; only an admin could take one down
 * (src/open-hosting.ts listed "a takedown by whoever brought the package" as not there). On
 * 2026-11-26 an agent that had brought three test packages could not remove them. The rule that
 * makes a self-service takedown safe is narrow, because a package is kept under the sha-256 of its
 * bytes and is one package for everyone who brings those bytes (src/package-bringers.ts).
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { PackageBringers } from '../src/package-bringers.js';

const A = 'did:ethr:0xaaaa', B = 'did:ethr:0xbbbb';
const SHA = 'a'.repeat(64), SHA2 = 'b'.repeat(64);
const T0 = Date.parse('2026-11-26T12:00:00Z');

describe('who may take a hosted package down', () => {
  it('is the signer who brought it, when nobody else did', () => {
    const r = new PackageBringers();
    r.signerBrought(SHA, A, false, T0);
    expect(r.mayTakeDown(SHA, A)).toEqual({ ok: true });
    expect(r.takeDownable(A)).toEqual([SHA]);
    expect(r.dirty).toBe(true);
  });

  it('is not someone who did not bring it, and they are not told it exists', () => {
    const r = new PackageBringers();
    r.signerBrought(SHA, A, false, T0);
    expect(r.mayTakeDown(SHA, B)).toMatchObject({ ok: false, status: 404 });
    expect(r.mayTakeDown(SHA2, A)).toMatchObject({ ok: false, status: 404 });
  });

  it('is nobody but an admin once a second signer brings the same bytes', () => {
    const r = new PackageBringers();
    r.signerBrought(SHA, A, false, T0);
    r.signerBrought(SHA, B, true, T0 + 1);
    expect(r.mayTakeDown(SHA, A)).toMatchObject({ ok: false, status: 403 });
    expect(r.mayTakeDown(SHA, B)).toMatchObject({ ok: false, status: 403 });
  });

  it('is not a signer who brings the bytes of a package that was already hosted', () => {
    // The attack this closes: bring the bytes of an operator's package, then take "your" package down.
    const r = new PackageBringers();
    r.signerBrought(SHA, A, true, T0);
    expect(r.mayTakeDown(SHA, A)).toMatchObject({ ok: false, status: 403 });
    expect(r.originOf(SHA)).toMatchObject({ heldBefore: true, signers: [A] });
  });

  it('is not a signer when an operator keeps the same bytes, before or after', () => {
    const before = new PackageBringers();
    before.operatorKept(SHA, T0);
    before.signerBrought(SHA, A, true, T0 + 1);
    expect(before.mayTakeDown(SHA, A)).toMatchObject({ ok: false, status: 403 });
    const after = new PackageBringers();
    after.signerBrought(SHA, A, false, T0);
    after.operatorKept(SHA, T0 + 1);
    expect(after.mayTakeDown(SHA, A)).toMatchObject({ ok: false, status: 403 });
  });

  it('starts anew once the package is gone', () => {
    const r = new PackageBringers();
    r.signerBrought(SHA, A, false, T0);
    r.signerBrought(SHA, B, true, T0);
    r.forget(SHA);
    expect(r.originOf(SHA)).toBeUndefined();
    r.signerBrought(SHA, B, false, T0 + 5);
    expect(r.mayTakeDown(SHA, B)).toEqual({ ok: true });
  });

  it('ignores an id that is no sha-256', () => {
    const r = new PackageBringers();
    r.signerBrought('nope', A, false, T0);
    expect(r.toJSON()).toEqual({});
  });
});

describe('the record across a restart', () => {
  it('is read back as it was written, and malformed entries are skipped', () => {
    const a = new PackageBringers();
    a.signerBrought(SHA, A, false, T0);
    const b = new PackageBringers();
    expect(b.load({ ...JSON.parse(JSON.stringify(a)), [SHA2]: { signers: 'x' }, notasha: { signers: [A], firstRecordedAt: '2026-11-26T12:00:00Z' } })).toBe(1);
    expect(b.mayTakeDown(SHA, A)).toEqual({ ok: true });
    expect(b.dirty).toBe(false);
  });

  it('only ever narrows who may take a package down when two copies are merged', () => {
    // This process thinks the package is A's alone; the pod's copy knows B brought it too, and that an operator keeps it.
    const r = new PackageBringers();
    r.signerBrought(SHA, A, false, T0);
    r.load({ [SHA]: { signers: [B], operator: true, firstRecordedAt: '2026-11-25T00:00:00.000Z' } });
    expect(r.originOf(SHA)).toMatchObject({ signers: [A, B], operator: true, firstRecordedAt: '2026-11-25T00:00:00.000Z' });
    expect(r.mayTakeDown(SHA, A)).toMatchObject({ ok: false, status: 403 });
    // And the other way about: the copy cannot lift what this process knows.
    const s = new PackageBringers();
    s.signerBrought(SHA, A, true, T0);
    s.load({ [SHA]: { signers: [A], firstRecordedAt: '2026-11-26T12:00:00.000Z' } });
    expect(s.mayTakeDown(SHA, A)).toMatchObject({ ok: false, status: 403 });
  });

  it('keeps a forgotten package forgotten when the older copy is merged, until that is written', () => {
    const r = new PackageBringers();
    r.signerBrought(SHA, A, false, T0);
    const stale = JSON.parse(JSON.stringify(r));
    r.forget(SHA);
    r.load(stale);
    expect(r.originOf(SHA)).toBeUndefined();
    // A write whose body was made before a later forget does not cover that forget.
    const covered = r.pendingForgotten();
    r.signerBrought(SHA2, A, false, T0);
    const stale2 = JSON.parse(JSON.stringify(r));
    r.forget(SHA2);
    r.committed(covered);
    r.load(stale2);
    expect(r.originOf(SHA2)).toBeUndefined();
  });
});

describe('the bridge', () => {
  const src = readFileSync(new URL('../bridge/server.ts', import.meta.url), 'utf8');
  const start = src.indexOf("app.post('/agent/scorm/host/remove'");
  const route = src.slice(start, src.indexOf('\n});', start));

  it('asks the pod whether the package was there before it keeps it, and treats no plain answer as there', () => {
    const bring = src.slice(src.indexOf('const bringing = ('), src.indexOf('const result = await uploadScormPackage({', src.indexOf('const bringing = (')));
    expect(bring.length).toBeGreaterThan(200);
    expect(bring.indexOf('await hostedPackages.isKept(sha)')).toBeLessThan(bring.indexOf('await keep()'));
    expect(bring).toContain("packageBringers.signerBrought(sha, auth.callerDid, before !== 'absent', Date.now())");
    // Nothing is recorded for a package that was not kept.
    expect(bring.indexOf('if (kept.hosted !== true) return kept;')).toBeLessThan(bring.indexOf('packageBringers.signerBrought('));
  });

  it('records an operator\'s upload as the operator\'s', () => {
    expect(src).toContain('host: (bytes, parsed) => operatorKeeps(bytes, () => hostUploadedPackage(bytes, parsed.packageTitle, parsed.launchable)),');
    expect(src).toContain('packageBringers.operatorKept(sha256Of(bytes), Date.now());');
  });

  it('does one thing at a time for a package: a bring and a takedown of the same bytes never interleave', () => {
    // A takedown decided on "mine alone" must not remove bytes someone brought in between.
    expect(src).toContain('=> withPackageLock(sha256Of(bytes), async () => {');
    expect(route).toContain('await withPackageLock(sha, async () => {');
    const locked = route.slice(route.indexOf('withPackageLock(sha'));
    for (const step of ['reloadPackageBringers(true)', 'packageBringers.mayTakeDown(sha, auth.callerDid)', 'hostedPackages.remove(sha)', 'packageBringers.forget(sha)']) expect(locked).toContain(step);
    const op = src.slice(src.indexOf('function operatorKeeps('), src.indexOf('function operatorKeeps(') + 600);
    expect(op.indexOf('withPackageLock(')).toBeLessThan(op.indexOf('await keep()'));
  });

  it('takes a package down only after a fresh read of the record says the signer may', () => {
    expect(src).toContain("app.post('/agent/scorm/host/remove', takeDownOwnRateLimit, async (req, res) => {");
    expect(route).toContain("(await reloadPackageBringers(true)) === 'failed'");
    expect(route.indexOf('packageBringers.mayTakeDown(sha, auth.callerDid)')).toBeLessThan(route.indexOf('hostedPackages.remove(sha)'));
    expect(route.indexOf('if (!may.ok)')).toBeLessThan(route.indexOf('hostedPackages.remove(sha)'));
  });
});
