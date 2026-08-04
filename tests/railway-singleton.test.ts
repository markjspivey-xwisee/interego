/**
 * css is the only service in this fleet whose CORRECTNESS depends on being a singleton,
 * and that fact was asserted nowhere a tool could read.
 *
 * ★ WHAT WAS MEASURED, 2026-08-03. `serviceInstance(css)` returned `numReplicas: null`,
 * `overlapSeconds: null`, `drainingSeconds: null` — so the single replica was upheld by
 * Railway's platform DEFAULT, not by a decision, and a reader could not tell the two
 * apart. The deploy that day left the predecessor active 2.207 s after the successor went
 * live (new SUCCESS 11:47:57.293Z, old REMOVED 11:47:59.500Z), and that is a FLOOR, not
 * the window. Meanwhile REDIS_ADDR on the service is the EMPTY STRING, so
 * docker-entrypoint.sh selects the PROCESS-LOCAL memory locker over the shared Postgres
 * store: two containers, two independent lockers, one store, on every deploy.
 *
 * ★ WHAT DOES NOT REPRODUCE — and this is why the settings are declared the way they are.
 * Railway's sequence is start-new -> new active -> hold overlapSeconds -> SIGTERM old ->
 * hold drainingSeconds -> SIGKILL old. So overlapSeconds can only SHRINK the window and
 * drainingSeconds can only LENGTHEN it. Neither CLOSES it; only an attached volume does,
 * and that is a substrate decision, not this file's. A green suite here does NOT mean the
 * window is closed — it means the invariant is finally checked.
 */
import { describe, it, expect } from 'vitest';
import { SERVICES, singletonViolations } from '../tools/railway-services.mjs';
import type { LiveRow } from '../tools/railway-services.mjs';

describe('railway singleton invariant', () => {
  it('declares css a singleton with overlap pinned to zero and draining refused', () => {
    expect(SERVICES.css?.singleton).toBe(true);
    expect(SERVICES.css?.maxOverlapSeconds).toBe(0);
    expect(SERVICES.css?.drainingMustBeUnset).toBe(true);
  });

  // ★ THE ANCHOR. This is the shape Railway returned for service `css` on 2026-08-03:
  // every setting null. A check that calls this shape compliant is a check that would not
  // have found it.
  it('reports the live 2026-08-03 css shape (all settings unset) as a violation', () => {
    const rows: LiveRow[] = [{ service: 'css', numReplicas: null, overlapSeconds: null, drainingSeconds: null }];
    const v = singletonViolations(rows);
    expect(v.map((x) => x.setting).sort()).toEqual(['numReplicas', 'overlapSeconds']);
    expect(v.find((x) => x.setting === 'numReplicas')?.live).toBeNull();
  });

  it('is satisfied only by explicit settings', () => {
    expect(singletonViolations([{ service: 'css', numReplicas: 1, overlapSeconds: 0, drainingSeconds: null }])).toEqual([]);
  });

  it('rejects a second replica', () => {
    const v = singletonViolations([{ service: 'css', numReplicas: 2, overlapSeconds: 0, drainingSeconds: null }]);
    expect(v.map((x) => x.setting)).toEqual(['numReplicas']);
  });

  // drainingSeconds is the SIGTERM->SIGKILL grace on the OLD container: it can only make
  // the two-container window LONGER. It reads like hardening, so it is refused.
  it('rejects drainingSeconds even on an otherwise-pinned singleton', () => {
    const v = singletonViolations([{ service: 'css', numReplicas: 1, overlapSeconds: 0, drainingSeconds: 30 }]);
    expect(v.map((x) => x.setting)).toEqual(['drainingSeconds']);
    expect(v[0]?.why).toMatch(/LENGTHEN/);
  });

  it('says nothing about services that are not declared singletons', () => {
    // postgres IS a singleton, but Railway already enforces it via the attached volume, so
    // declaring it here would demand an explicit numReplicas on a service the platform
    // already protects — i.e. noise, which is how a check stops being read.
    expect(singletonViolations([
      { service: 'relay', numReplicas: null, overlapSeconds: null, drainingSeconds: null },
      { service: 'postgres', numReplicas: null, overlapSeconds: null, drainingSeconds: null },
      { service: 'not-a-service', numReplicas: null },
    ])).toEqual([]);
  });

  it('does not judge a row Railway could not be read for', () => {
    // Reporting one MISSING service as four confusing lines is how a check stops being read.
    expect(singletonViolations([{ service: 'css', missingFromRailway: true }])).toEqual([]);
    expect(singletonViolations([{ service: 'css', error: 'Project Token not found' }])).toEqual([]);
  });
});
