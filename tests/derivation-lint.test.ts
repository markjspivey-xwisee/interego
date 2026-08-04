/**
 * The derivation gate must agree with the prose that describes it.
 *
 * ★ WHY. `tools/derivation-lint.mjs` printed "97/97 classes grounded" while
 * `spec/LAYERS.md` said "41/41". That 41/41 was true the day derivation discipline landed
 * and was never touched again; `README.md` carried a second, independently drifting copy
 * (91/91, already wrong on the commit that shipped it) until it was rewritten to send the
 * reader to `npm run lint:derivation` rather than restate a figure. Two self-descriptions
 * of one gate, disagreeing with each other and both wrong, because the count was a
 * hand-typed literal with no producer→consumer link to the thing that computes it.
 *
 * The gate now asserts the claim itself. This test is what puts that assertion inside the
 * suite: `.github/workflows/bridge-typecheck.yml` is the only workflow that runs
 * `npx vitest run`, and ontology-lint.yml is `paths:`-filtered, so without this a change
 * outside those filters could take the gate red with nothing observing it.
 *
 * The REAL script is spawned through its REAL entry point. Re-implementing the scan here
 * would be a double standing in for the thing under test — it could not have caught the
 * drift, because the drift was between the script's output and a file the script never read.
 */
import { describe, it, expect } from 'vitest';
import { spawnSync } from 'node:child_process';
import { readFileSync, readdirSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const TOOL = resolve(REPO, 'tools/derivation-lint.mjs');

function runGate(): { status: number; out: string } {
  const r = spawnSync(process.execPath, [TOOL], { cwd: REPO, encoding: 'utf8' });
  return { status: r.status ?? -1, out: `${r.stdout}${r.stderr}` };
}

/**
 * ★ IMPORTED, NOT RE-IMPLEMENTED — and importable only because the gate's body now sits
 * behind a direct-invocation guard. Before that, importing this module ran the whole gate
 * inside the vitest worker and could `process.exit(1)` from within a test, which under this
 * repo's pinned singleFork pool takes every unreached test with it.
 */
const loadGate = async (): Promise<{
  blindSpotFailure: (file: string, ttl: string, parsed: number) => string | null;
  l1Prefixes: (text: string) => { prefixes?: Set<string>; error?: string };
}> => await import(
  new URL('../tools/derivation-lint.mjs', import.meta.url).href
) as {
  blindSpotFailure: (file: string, ttl: string, parsed: number) => string | null;
  l1Prefixes: (text: string) => { prefixes?: Set<string>; error?: string };
};

describe('derivation-lint: the gate and the prose state one number', () => {
  it('passes, and says so only after checking the prose', () => {
    const { status, out } = runGate();
    expect(status, out).toBe(0);
    // The PASS line is worded to name what it verified. If it reverts to the bare
    // "every L2/L3 class is grounded", the doc check has been removed and this fails.
    expect(out).toContain('spec/LAYERS.md states the same count');
  });

  it('spec/LAYERS.md states exactly the count the gate measured', () => {
    // Read independently of the gate, so this case fails even if someone deletes the
    // gate's own doc check — the two assertions are not the same assertion twice.
    const { out } = runGate();
    const measured = /Total: (\d+)\/(\d+) L2\/L3 classes grounded/.exec(out);
    expect(measured, `no total in gate output:\n${out}`).not.toBeNull();
    const layers = readFileSync(resolve(REPO, 'spec/LAYERS.md'), 'utf8');
    // `\s+`, not a literal space: the sentence wraps mid-claim and this repo checks out
    // CRLF on Windows and LF in CI. A literal space matches in neither reliably.
    const claim = /Current status: \*\*(\d+)\/(\d+)\s+classes grounded\*\*/.exec(layers);
    expect(claim, 'spec/LAYERS.md no longer states a grounding count at all').not.toBeNull();
    expect([claim?.[1], claim?.[2]]).toEqual([measured?.[1], measured?.[2]]);
  });

  it('★ enumerates docs/ns/ rather than a hand-written list — every .ttl on disk is reported', () => {
    // ★ THE DEFECT THIS CLOSES. The gate read `const L2_L3_FILES = [...14 names...]` over a
    // directory of 30, and printed "97/97 grounded" about the half it looked at. wks.ttl,
    // vault-ld.ttl, a2a.ttl and hmd.ttl had never been checked by any derivation check;
    // enumerating found three genuinely ungrounded classes. Asserting the COUNT of reported
    // files against the directory is what stops the list coming back in another form.
    const { out } = runGate();
    const onDisk = readdirSync(resolve(REPO, 'docs/ns')).filter(f => f.endsWith('.ttl'));
    expect(onDisk.length).toBeGreaterThan(20);
    for (const f of onDisk) {
      expect(out, `${f} is on disk under docs/ns/ and the gate reported nothing about it`)
        .toContain(f);
    }
    expect(out).toMatch(new RegExp(`Enumerated ${onDisk.length} file\\(s\\) under docs/ns/`));
  });
});

/**
 * The two pieces that make enumeration safe, driven through the real functions.
 *
 * ★★ ENUMERATING ALONE WOULD HAVE BEEN WORSE THAN THE LIST. The old parser took each file's
 * Turtle prefix from its FILENAME, which is wrong for six of the thirty and wrong SILENTLY:
 * `harness.ttl` declares 41 classes under `ieh:`, so a `harness:`-anchored regex matched
 * nothing and the file reported 0/0 — indistinguishable from a clean file. Adding those four
 * names to the old list would have added four files that check nothing and a bigger number
 * in the report.
 */
describe('the scanner blind-spot check', () => {
  it('★ is silent when every declaration in the file was understood — the control', async () => {
    const { blindSpotFailure } = await loadGate();
    const ttl = 'x:A a owl:Class ;\n  rdfs:subClassOf iep:ContextDescriptor .\n';
    expect(blindSpotFailure('x.ttl', ttl, 1)).toBeNull();
  });

  it('★★ fails on the exact defect the old parser had: classes present, none understood', async () => {
    const { blindSpotFailure } = await loadGate();
    const ttl = 'ieh:A a owl:Class ;\n  rdfs:label "a" .\n\nieh:B a owl:Class ;\n  rdfs:label "b" .\n';
    expect(blindSpotFailure('harness.ttl', ttl, 0))
      .toMatch(/harness\.ttl: 2 `a owl:Class` declaration\(s\) in the file, 0 understood/);
  });

  it('★ fails when a body over-ran its terminator and swallowed the next declaration', async () => {
    const { blindSpotFailure } = await loadGate();
    // The swallowed class inherits its neighbour's grounding and would be counted grounded.
    // The count check is the only thing that can see it — the grounded/ungrounded numbers
    // agree with themselves either way.
    const ttl = 'x:A a owl:Class ; rdfs:label "a" .\nx:B a owl:Class ; rdfs:label "b" .\n';
    expect(blindSpotFailure('x.ttl', ttl, 1)).toMatch(/2 `a owl:Class`.*1 understood/);
  });
});

describe('the L1 exemption list', () => {
  it('★ is read out of spec/LAYERS.md §3, and matches the live document', async () => {
    const { l1Prefixes } = await loadGate();
    const r = l1Prefixes(readFileSync(resolve(REPO, 'spec/LAYERS.md'), 'utf8'));
    expect(r.error).toBeUndefined();
    for (const p of ['iep', 'ieh', 'pgsl', 'ie', 'align']) {
      expect(r.prefixes?.has(p), `LAYERS.md §3 no longer names ${p}: as a core namespace`).toBe(true);
    }
    // The pre-rename aliases, which LAYERS.md's present-tense sentence correctly omits.
    expect(r.prefixes?.has('cg')).toBe(true);
    // ★ THE CONTROL. Without it a checker that exempts EVERY prefix passes every case above,
    // and an exemption list that exempts everything is the gate switched off.
    expect(r.prefixes?.has('sat')).toBe(false);
    expect(r.prefixes?.has('wks')).toBe(false);
  });

  it('★ refuses a LAYERS.md that no longer states which namespaces are L1', async () => {
    const { l1Prefixes } = await loadGate();
    // Silently returning an empty set would mark every L1 class ungrounded and red the gate
    // for a reason nobody could act on. It says what happened instead.
    const r = l1Prefixes('# LAYERS\n\nNothing about namespace authority here.\n');
    expect(r.prefixes).toBeUndefined();
    expect(r.error).toMatch(/no longer states which namespaces are L1/);
  });

  it('★ refuses a sentence that survives but names no prefix', async () => {
    const { l1Prefixes } = await loadGate();
    const r = l1Prefixes('- **Core protocol namespaces** (currently none) — governed by the authority.\n');
    expect(r.error).toMatch(/names no `prefix:` at all/);
  });
});
