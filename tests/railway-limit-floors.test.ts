/**
 * Railway resource-limit overrides, checked against the floors this fleet has MEASURED.
 *
 * ★ WHAT WAS OPEN. Read live on 2026-08-03: all sixteen services returned
 * `serviceInstanceLimitOverride = null`, i.e. the plan ceiling (32 CPU / 32 GB) applied
 * everywhere. So the relay's 1.0 CPU / 2 GiB floor and foxxi-bridge's 2 CPU / 4 GiB floor
 * held for no reason at all — no override existed. Nothing in the repository recorded the
 * numbers (a grep for `limitOverride|memoryGB|cpuCores` found one hit, about replicas),
 * and `railway-pins.mjs --check` read only `source.image`, so the next override would be
 * both unreviewable and unnoticeable.
 *
 * ★ THIS DETECTS; IT CANNOT REFUSE. The only mutation is `serviceInstanceLimitsUpdate`,
 * called from the Railway dashboard, and no file in this repository sits in that path. The
 * reachable version of "nothing would refuse a below-floor override" is "nothing would
 * NOTICE", and that is what closes here.
 */
import { describe, expect, it } from 'vitest';
import { classifyLimit, LIMIT_FLOORS, resolveImageRepo, serviceNames } from '../tools/railway-services.mjs';
import { collectPins, hasDisagreement } from '../tools/railway-pins.mjs';
import type { Gql } from '../tools/railway-pins.mjs';

const GIB = 1024 * 1024 * 1024;
const limit = (cpu: number, memoryBytes: number) => ({ containers: { cpu, memoryBytes, pidLimit: 1000 } });

/**
 * A Railway double that answers DIFFERENTLY per serviceId, because railway-pins.mjs says
 * so in its own words: a double returning one canned answer cannot tell a correct
 * implementation from one that queries the same service sixteen times.
 *
 * ★ It returns ALL tracked services, each with its CORRECT image repo, a deployment dated
 * after the (injected) commit date, and compliant singleton settings. Every one of those
 * is a load-bearing CONTROL: collectPins synthesises a MISSING row for any tracked service
 * Railway omits, a wrong repo yields MISMATCH, an undatable pin yields UNVERIFIED, and an
 * unset numReplicas on css is a singleton violation. Any of them would make
 * hasDisagreement true on its own, and every assertion below would then pass for a reason
 * that has nothing to do with limits.
 */
function railwayDouble(
  overrides: Record<string, unknown> = {},
  opts: { throwLimitsFor?: string } = {},
): Gql {
  const names = serviceNames();
  const idOf = (n: string) => `svc-${n}`;
  const nameOf = Object.fromEntries(names.map((n) => [idOf(n), n]));
  return async (query, variables = {}) => {
    if (query.includes('projectToken')) {
      return { projectToken: { projectId: 'proj', environmentId: 'env' } };
    }
    if (query.includes('project(id:')) {
      return { project: { name: 'robust-integrity', services: { edges: names.map((n) => ({ node: { id: idOf(n), name: n } })) } } };
    }
    const service = nameOf[String(variables.s)];
    if (service === undefined) throw new Error(`double asked about unknown serviceId ${String(variables.s)}`);
    if (query.includes('serviceInstanceLimitOverride')) {
      if (opts.throwLimitsFor === service) throw new Error('limits unreadable');
      return { serviceInstanceLimitOverride: overrides[service] ?? null };
    }
    const r = resolveImageRepo(service);
    const repo = r.ok ? r.repo : `upstream/${service}`;
    return {
      serviceInstance: {
        source: { image: `${repo}:${'a'.repeat(40)}` },
        numReplicas: 1,
        overlapSeconds: 0,
        drainingSeconds: null,
        latestDeployment: { id: 'dep', status: 'SUCCESS', createdAt: '2026-08-03T00:00:00Z' },
      },
    };
  };
}

/** Every pin in the double is dated a month before its deployment, so the deploy axis is quiet. */
const commitAt = () => '2026-07-01T00:00:00Z';
/** Every pin in the double IS head, so the freshness axis is quiet. */
const git = {
  head: 'a'.repeat(40),
  known: () => true,
  isAncestorOfHead: () => true,
  commitsSince: () => 0,
};

describe('Railway resource-limit floors', () => {
  it('records a floor for every service whose starvation symptom is known, and no others', () => {
    // Guards the numbers themselves. foxxi-bridge's 4 GiB is 3 GiB of
    // --max-old-space-size (read off the live service) plus off-heap headroom; silently
    // lowering it re-opens the bogus "issuer seed unset" bug.
    expect(LIMIT_FLOORS.relay).toEqual({ cpu: 1, memoryBytes: 2 * GIB });
    expect(LIMIT_FLOORS['foxxi-bridge']).toEqual({ cpu: 2, memoryBytes: 4 * GIB });
    for (const name of Object.keys(LIMIT_FLOORS)) expect(serviceNames()).toContain(name);
  });

  it('treats an UNSET override as passing — the plan ceiling is above every floor', () => {
    // All sixteen services were null on 2026-08-03. Failing this case would report sixteen
    // violations on day one and get the check switched off.
    expect(classifyLimit('relay', null).verdict).toBe('none');
    expect(classifyLimit('relay', undefined).verdict).toBe('none');
  });

  it('flags an override below the floor, on either axis independently', () => {
    expect(classifyLimit('relay', limit(0.5, 8 * GIB)).verdict).toBe('BELOW-FLOOR');
    expect(classifyLimit('relay', limit(8, 512 * 1024 * 1024)).verdict).toBe('BELOW-FLOOR');
    expect(classifyLimit('foxxi-bridge', limit(2, 2 * GIB)).verdict).toBe('BELOW-FLOOR');
  });

  it('passes an override AT the floor, so the floor is a floor and not a moat', () => {
    expect(classifyLimit('relay', limit(1, 2 * GIB)).verdict).toBe('ok');
    expect(classifyLimit('foxxi-bridge', limit(2, 4 * GIB)).verdict).toBe('ok');
  });

  it('refuses to pass an override whose shape it does not recognise', () => {
    // The populated shape is INFERRED from serviceInstanceLimits sharing the
    // ServiceInstanceLimit return type; no override has ever been observed SET here. If
    // the inference is wrong, this must go loud rather than green.
    for (const weird of [{}, { containers: {} }, { cpu: 1, memoryBytes: 2 * GIB }, 'unlimited', 0]) {
      expect(classifyLimit('relay', weird).verdict).toBe('UNPARSED');
    }
  });

  it('flags an override on a service with no measured floor rather than assuming it is fine', () => {
    expect(classifyLimit('dashboard', limit(0.1, 128 * 1024 * 1024)).verdict).toBe('UNKNOWN-FLOOR');
  });

  it('does not resolve a floor through Object.prototype', () => {
    // `constructor` reaches classifyLimit from the live API. Via a plain property read it
    // is a truthy function whose `.cpu` is undefined, every `<` is false, and a starved
    // service reports ok — the guard failing open on its whole reason for existing.
    expect(classifyLimit('constructor', limit(0.01, 1)).verdict).toBe('UNKNOWN-FLOOR');
    expect(classifyLimit('toString', limit(0.01, 1)).verdict).toBe('UNKNOWN-FLOOR');
  });
});

describe('Railway limit floors, wired through collectPins', () => {
  it('is green against the live state observed on 2026-08-03 (no overrides anywhere)', async () => {
    const { rows } = await collectPins(railwayDouble(), git, commitAt);
    expect(rows).toHaveLength(serviceNames().length);
    expect(rows.every((r) => r.limitVerdict === 'none')).toBe(true);
    expect(hasDisagreement(rows)).toBe(false); // the control: nothing else is red either
  });

  it('carries a below-floor override all the way into --check', async () => {
    const { rows } = await collectPins(
      railwayDouble({ relay: limit(0.5, 512 * 1024 * 1024) }), git, commitAt);
    const relay = rows.find((r) => r.service === 'relay');
    expect(relay?.limitVerdict).toBe('BELOW-FLOOR');
    expect(relay?.agreement).toBe('ok'); // the image pin is fine; only the limit is not
    expect(hasDisagreement(rows)).toBe(true);
  });

  it('reports an unreadable limit as ERROR, never as no-violation', async () => {
    const { rows } = await collectPins(
      railwayDouble({}, { throwLimitsFor: 'foxxi-bridge' }), git, commitAt);
    const bridge = rows.find((r) => r.service === 'foxxi-bridge');
    expect(bridge?.limitVerdict).toBe('ERROR');
    // ★ The image read SURVIVED independently. This is the assertion that encodes why the
    // override is fetched in its OWN request: Railway fails the whole document on one bad
    // field, and probing this name as a field of ServiceInstance took `source{image}` down
    // with it for all sixteen services. Fold the two queries together and this fails.
    expect(bridge?.image).toContain('interego-foxxi-bridge');
    expect(hasDisagreement(rows)).toBe(true);
  });
});
