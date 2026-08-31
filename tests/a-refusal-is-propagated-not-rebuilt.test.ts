/**
 * A refusal is PROPAGATED, never reconstructed from its message.
 *
 * ── THE MISTAKE THIS EXISTS FOR ──────────────────────────────────────────────
 *
 * `iep:Refusal` gave the kernel a typed way to decline: a handler hands `kind: 'refusal'`,
 * the dispatcher reads `KERNEL_RESULT_STATUS` for the code, and `iep:resolvedBy` names the
 * affordance that obtains what the caller lacks. Foxxi's `resolveCaller` was changed to
 * return one.
 *
 * Every caller then threw it away on the next line:
 *
 *     if ('error' in resolved) return { error: resolved.error };
 *
 * Only the message survived. `kind` — the one field the dispatcher reads — was dropped, along
 * with the reason and the affordance. So the endpoints went on answering HTTP 200 with
 * `kind: undefined`, the whole change was inert in production, and the full suite stayed
 * green: `resolveCaller` is not exported and `bridge/server.ts` calls `app.listen` at import,
 * so nothing in the suite can drive the auth path at all.
 *
 * It was found by ONE unauthenticated request against the deployed bridge, after the change
 * had been committed, CI'd, built and deployed. 41 sites did it.
 *
 * ── WHY THIS IS A SOURCE GATE AND WHAT IT CANNOT DO ──────────────────────────
 *
 * It cannot prove the live endpoint answers 401 — only a live drive does that, which is
 * exactly what caught this. What it CAN do is refuse the shape of the mistake: rebuilding a
 * refusal from its `.error` string is always wrong, because a re-wrap drops the typing by
 * construction. That is checkable without importing anything that listens.
 *
 * ── AND WHY IT IS THE SAME DEFECT AS THE agp SEAM, ONE LAYER UP ──────────────
 *
 * `agp.diagnose` projected its result down and dropped `situationId` and `factors`, the two
 * fields `plan_intervention` needed. This dropped `kind` and `iep:resolvedBy`, the two fields
 * the dispatcher and the caller needed. Both are a lossy projection discarding exactly what
 * the next layer reads — committed the second time on the same day, in the change meant to
 * close the class.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const BRIDGE = 'applications/foxxi-content-intelligence/bridge/server.ts';

describe('a refusal survives the call site that receives it', () => {
  const src = readFileSync(join(ROOT, BRIDGE), 'utf8');

  it('no caller rebuilds a refusal from its error string', () => {
    // The exact shape that made the change inert. `return resolved;` is the fix: it keeps
    // the kind, the reason and the affordance that resolves it.
    const rebuilt = [...src.matchAll(/return\s*\{\s*error:\s*resolved\.error\s*\}/g)];
    expect(
      rebuilt.length,
      `${rebuilt.length} call site(s) rebuild a refusal from its message, dropping the `
        + `'kind' the dispatcher reads and the affordance that resolves it. Return the whole `
        + `refusal instead: 'return resolved;'`,
    ).toBe(0);
  });

  it('★ is measuring a real call site — a gate over an absent pattern proves nothing', () => {
    // If `resolveCaller` is renamed or the guard restyled, the regex above would pass by
    // finding nothing. This pins that the thing being guarded still exists.
    expect(src).toContain('resolveCaller');
    expect(
      [...src.matchAll(/'error'\s+in\s+resolved/g)].length,
      'no caller checks a refusal at all — has the auth path moved?',
    ).toBeGreaterThan(5);
  });

  it('the refusal it builds still carries a way out', () => {
    // RefusalShape puts sh:minCount 1 on iep:resolvedBy, but SHACL cannot run over TypeScript.
    // This is the source-side half: the constructed refusal names an affordance.
    expect(src).toContain("kind: 'refusal'");
    expect(src, 'the refusal no longer names the affordance that resolves it')
      .toContain("'iep:resolvedBy'");
  });
});
