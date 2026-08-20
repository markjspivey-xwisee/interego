/**
 * AN AGENT WAS UN-ENROLLED FOR HAVING DONE NOTHING, WHICH IS THE STATE EVERY AGENT STARTS IN.
 *
 * MEASURED: an agent enrolled itself, was answered `durable: true`, appeared in the public register
 * beside two others — and was gone fifty minutes later, with nothing anywhere saying so. The prune
 * had retired it for presenting no trajectory-step manifest for ten consecutive cycles. That rule
 * exists for a real cost (a live authority test once left fifteen pods enrolled by keys nobody
 * holds, each fetched every cycle forever) and it cannot tell a discarded key from a new agent.
 *
 * ★ THE BUG IS NOT THE PRUNE, IT IS THE REPRESENTATION. Deleting the row published the retirement as
 * an ABSENCE, and an absence reads identically to "never enrolled" and to "your durable write
 * silently failed". Three situations, one representation, and the only party who needed to tell them
 * apart is the one who cannot see any of it happen. The review then reports "not enrolled" and hands
 * out a remedy — enrol yourself — that produces the identical outcome fifty minutes later.
 *
 * So a retirement is a ROW WITH A REASON, bounded, excluded from the sweep and from the cap.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { retireRow, activeRows, isRetired, type RegisterRow } from '../applications/foxxi-content-intelligence/src/enrolment-register.js';

const podKey = (u: string): string => u.replace(/\/+$/, '').toLowerCase();
const samePod = (a: string, b: string): boolean => podKey(a) === podKey(b);
const row = (pod: string, extra: RegisterRow = {}): RegisterRow =>
  ({ pod_url: pod, enrolled_by: 'did:ethr:0xabc', enrolled_at: '2026-08-19T20:02:47.802Z', ...extra });

const A = 'https://gate.interego.xwisee.com/eth-42c2ffd7e4c0/';
const B = 'https://gate.interego.xwisee.com/u-eth-03f52e15b9df/';
const NOW = '2026-08-19T20:52:47.000Z';
const REASON = 'no trajectory-step manifest found for 10 consecutive projector cycles.';

describe('the row survives its own retirement, carrying when and why', () => {
  it('a retired pod is still in the register, and says what happened to it', () => {
    const out = retireRow({ rows: [row(A), row(B)], pod: A, reason: REASON, now: NOW, keep: 25, samePod });
    expect(out.changed).toBe(true);
    const mine = out.rows.find((r) => r['pod_url'] === A);
    expect(mine, 'the row must not be erased').toBeDefined();
    expect(mine?.['retired_at']).toBe(NOW);
    expect(mine?.['retired_reason']).toBe(REASON);
    // And what it was before is still there — "enrolled then retired" is the fact, not "retired".
    expect(mine?.['enrolled_at']).toBe('2026-08-19T20:02:47.802Z');
  });

  it('and it is out of the swept set, so the prune still achieves what it is for', () => {
    const out = retireRow({ rows: [row(A), row(B)], pod: A, reason: REASON, now: NOW, keep: 25, samePod });
    expect(activeRows(out.rows).map((r) => r['pod_url'])).toEqual([B]);
    expect(out.retired).toBe(true);
  });

  it('one pod, two spellings — the comparison is injected because URL bytes have been wrong before', () => {
    const internal = 'http://css.railway.internal:3456/u-eth-03f52e15b9df/';
    const out = retireRow({
      rows: [row(B)], pod: internal, reason: REASON, now: NOW, keep: 25,
      samePod: (a, b) => (a.replace(/\/+$/, '').split('/').pop() ?? '').replace(/^u-/, '')
        === (b.replace(/\/+$/, '').split('/').pop() ?? '').replace(/^u-/, ''),
    });
    expect(out.changed, 'the internal spelling must find the public row').toBe(true);
  });
});

describe('★ and it does not rewrite a decision that was already recorded', () => {
  it('retiring an already-retired row changes nothing', () => {
    const already = row(A, { retired_at: '2026-08-19T20:52:47.000Z', retired_reason: 'the real reason' });
    const out = retireRow({ rows: [already], pod: A, reason: 'a later, vaguer reason', now: '2026-08-20T09:00:00.000Z', keep: 25, samePod });
    expect(out.changed).toBe(false);
    // Re-stamping would misdate the decision the row exists to explain.
    expect(out.rows[0]?.['retired_at']).toBe('2026-08-19T20:52:47.000Z');
    expect(out.rows[0]?.['retired_reason']).toBe('the real reason');
    // It IS retired, though — the caller must not be told the withdrawal failed.
    expect(out.retired).toBe(true);
  });

  it('a pod with no row at all reports that nothing was retired', () => {
    const out = retireRow({ rows: [row(B)], pod: A, reason: REASON, now: NOW, keep: 25, samePod });
    expect(out.changed).toBe(false);
    expect(out.retired).toBe(false);
  });
});

describe('the audit tail is bounded, and it does not consume the enrolment cap', () => {
  it('only the newest retirements are kept', () => {
    const old = Array.from({ length: 5 }, (_, i) =>
      row(`https://gate.interego.xwisee.com/eth-old${i}/`, { retired_at: `2026-08-1${i}T00:00:00.000Z`, retired_reason: 'x' }));
    const out = retireRow({ rows: [...old, row(A)], pod: A, reason: REASON, now: NOW, keep: 3, samePod });
    const retired = out.rows.filter(isRetired);
    expect(retired).toHaveLength(3);
    // Newest first, and the one just retired is among them — it is the whole point.
    expect(retired.map((r) => r['pod_url'])).toContain(A);
    expect(retired.map((r) => r['pod_url'])).not.toContain('https://gate.interego.xwisee.com/eth-old0/');
  });

  it('★ retired rows are excluded from the count the cap is applied to', () => {
    // The cap bounds recurring outbound work — one pod fetch per cycle per ENROLLED pod. A retired
    // row is fetched by nothing, so counting it would let the audit tail deny enrolment to real
    // agents: the exact failure (a full cap with no retirement path) this all exists to fix.
    const rows = [row(A), ...Array.from({ length: 9 }, (_, i) =>
      row(`https://gate.interego.xwisee.com/eth-dead${i}/`, { retired_at: '2026-08-01T00:00:00.000Z', retired_reason: 'x' }))];
    expect(rows).toHaveLength(10);
    expect(activeRows(rows)).toHaveLength(1);
  });
});

describe('the bridge uses this rule, and reports the retirement where a reader is already looking', () => {
  const src = readFileSync(join(
    dirname(fileURLToPath(import.meta.url)),
    '..', 'applications', 'foxxi-content-intelligence', 'bridge', 'server.ts',
  ), 'utf8');
  const code = src.split('\n').filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l));

  it('the withdrawal path retires rather than filtering the row out', () => {
    expect(code.some((l) => /retireRow\(\{/.test(l)), 'must call the shared transform').toBe(true);
    // The erasure, in the exact shape it had. If it comes back, so does the invisible removal.
    expect(code.some((l) => /read\.rows\.filter\(.*podKey\(r\.pod_url\) !== podKey\(pod\)/.test(l)),
      'the register must not be rewritten by dropping the row').toBe(false);
  });

  it('the cap counts only active rows', () => {
    expect(code.some((l) => /activeRows\(kept\)\.length \+ 1 > MESH_ENROLMENT_CAP/.test(l))).toBe(true);
  });

  it('★ the register publishes retirements, and an empty review names the one that applies to it', () => {
    expect(src, 'the public register must carry them').toMatch(/iep:retired \[/);
    // whyEmpty is where an agent with an empty record is already looking. Telling it "not enrolled"
    // there, when it WAS enrolled and was pruned, is the confidently wrong answer.
    expect(src).toMatch(/subjectRetirement/);
    expect(src, 'and the remedy must differ, because "enrol again" alone repeats the outcome')
      .toMatch(/Re-enrolling alone will produce the same outcome/);
  });
});
