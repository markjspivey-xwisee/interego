/**
 * A gate nobody calls.
 *
 * ── ★★ THE THIRD WAY A CORRECT GATE PRODUCES NOTHING ─────────────────────────
 *
 * Two are already known here and one has its own test. `tools/ontology-lint.mjs` once did not
 * SCAN the directory a defect shipped from; widening `SCAN_PATHS` fixed nothing, because
 * `.github/workflows/ontology-lint.yml`'s `paths:` filter did not START the job for a commit
 * confined to that directory — the scan reaching a directory and the job starting on a change to
 * it are two separate facts, and `tests/workflow-trigger-covers-the-suite.test.ts` ties them
 * together.
 *
 * ★★ THE THIRD IS QUIETER THAN BOTH: **no workflow invokes the script at all.** Measured
 * 2026-08-25 — `npm run check:turtle-iri-ratchet`, the injection ratchet on raw `<${expr}>` Turtle
 * interpolation, was reachable only through `npm run lint:all`, and no workflow ran either one.
 * `lint.yml` invokes `tools/lint-gate.mjs` and four named linters; `ontology-lint.yml` invokes five
 * others; neither named this one. So it had never run in CI, and it had drifted **11 over budget**
 * — 702 raw sites against 691 — with nobody seeing it. Confirmed pre-existing rather than newly
 * broken by running the tool in a detached worktree at the previous commit: also exactly 702.
 *
 * ★ AND THIS HAD ALREADY HAPPENED ONCE, TO A DIFFERENT GATE, AND WAS FIXED WITHOUT A CHECK.
 * `ontology-lint.yml` carries the note: the security-txt expiry helper "RAN IN NO WORKFLOW AND
 * EXITED 2 ON A CLEAN TREE … `npm run lint:all`, which chains it, was therefore red at HEAD while
 * CI ran the narrower `npm run lint` and saw nothing." That instance was closed by adding a step.
 * Nothing stopped the next one, and the next one was the ratchet. This file is the check that was
 * missing both times.
 *
 * ── WHAT IS CHECKED ──────────────────────────────────────────────────────────
 *
 * For every GATE script in package.json, the tool it ultimately executes must be reachable from
 * some workflow — invoked directly (`node tools/x.mjs`) or through an `npm run <script>` that
 * transitively reaches it. Both lists are DERIVED, never restated: the scripts come from
 * package.json and the invocations from the workflow YAML, so a gate added tomorrow is covered the
 * day it is added rather than the day somebody remembers this file.
 *
 * ★ `lint:all` is deliberately NOT accepted as coverage. It is a convenience target that chains
 * everything; crediting it would re-admit the exact defect above, because being IN `lint:all` is
 * what both unwired gates already had.
 *
 * No YAML or glob dependency, for the reason the sibling test gives: `js-yaml` and `minimatch`
 * resolve here today but are TRANSITIVE, not declared, and a gate that stops resolving is a gate
 * that stops gating.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('../', import.meta.url));

/**
 * A script is a GATE if it exists to make CI go red. `lint:fix` and `lint:raw` are developer
 * conveniences that mutate or re-report rather than gate, and `lint:all` is the chaining target
 * this file exists to distrust.
 */
const GATE_PREFIXES = ['lint', 'check:', 'conformance'];
const NOT_GATES = new Set(['lint:fix', 'lint:raw', 'lint:all']);

/** Every `tools/…` / `spec/…` / `scripts/…` file a shell command executes. */
function toolsIn(command: string): string[] {
  const re = /(?:^|[\s&|;])((?:tools|spec|scripts)\/[\w./-]+\.(?:mjs|js|ts))/g;
  return [...command.matchAll(re)].map((m) => m[1] as string);
}

/** The `npm run <name>` targets a shell command chains to. */
function scriptsIn(command: string): string[] {
  return [...command.matchAll(/npm run ([\w:-]+)/g)].map((m) => m[1] as string);
}

/** Every tool a script reaches, following `npm run` chains. */
function toolsReached(name: string, scripts: Record<string, string>, seen = new Set<string>()): Set<string> {
  const out = new Set<string>();
  if (seen.has(name)) return out;
  seen.add(name);
  const body = scripts[name];
  if (body === undefined) return out;
  for (const t of toolsIn(body)) out.add(t);
  for (const s of scriptsIn(body)) for (const t of toolsReached(s, scripts, seen)) out.add(t);
  return out;
}

/**
 * The COMMANDS a workflow runs — never its prose.
 *
 * ★★ THE FIRST DRAFT OF THIS FILE READ THE RAW YAML, WHICH IS THE DEFECT IT IS ABOUT.
 * `ontology-lint.yml`'s comment about `npm run lint:all` — written the LAST time a gate in that
 * target ran in no workflow — scored as an invocation. A gate credited to a sentence describing
 * the absence of the gate. So this reads `run:` values only.
 */
function runCommands(yaml: string): string[] {
  const out: string[] = [];
  const lines = yaml.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] as string;
    const inline = /^\s*(?:-\s*)?run:\s*(?!\|)(\S.*)$/.exec(line);
    if (inline) { out.push(inline[1] as string); continue; }
    const block = /^(\s*)(?:-\s*)?run:\s*\|/.exec(line);
    if (!block) continue;
    const indent = (block[1] ?? '').length;
    for (let j = i + 1; j < lines.length; j++) {
      const body = lines[j] as string;
      if (body.trim() === '') { i = j; continue; }
      const lead = (/^(\s*)/.exec(body)?.[1] ?? '').length;
      if (lead <= indent) break;
      out.push(body.trim());
      i = j;
    }
  }
  // A trailing `#` comment on a run line is still prose.
  return out.map((c) => c.replace(/\s#.*$/, ''));
}

function workflowFiles(): { name: string; commands: string[] }[] {
  const dir = join(ROOT, '.github', 'workflows');
  return readdirSync(dir)
    .filter((f) => f.endsWith('.yml') || f.endsWith('.yaml'))
    .map((f) => ({ name: f, commands: runCommands(readFileSync(join(dir, f), 'utf8')) }));
}

describe('every gate script is invoked by some workflow', () => {
  const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')) as { scripts: Record<string, string> };
  const scripts = pkg.scripts;
  const gates = Object.keys(scripts)
    .filter((n) => GATE_PREFIXES.some((p) => n.startsWith(p)))
    .filter((n) => !NOT_GATES.has(n));
  const workflows = workflowFiles();
  const allCommands = workflows.flatMap((w) => w.commands);

  it('finds the gates, the workflows AND their run commands, so a green result is not an empty one', () => {
    // ★ THE NON-VACUITY GUARD, AND IT EARNED ITS PLACE: the `run:` parser is the part most likely
    // to silently return nothing, and a parser returning nothing would make every gate below look
    // unwired — or, with the assertion inverted, make every gate look fine. Both lists are derived,
    // so both are checked.
    expect(gates.length, 'no gate scripts were discovered in package.json').toBeGreaterThan(5);
    expect(workflows.length, 'no workflow files were discovered').toBeGreaterThan(5);
    expect(allCommands.length, 'the run: parser found no commands at all').toBeGreaterThan(20);
    expect(allCommands.some((c) => c.includes('tools/lint-gate.mjs')),
      'the run: parser did not find the one invocation this repo is certain to have').toBe(true);
  });

  it('★★ every gate reaches CI — a gate no workflow calls is a number in a file', () => {
    const unwired: string[] = [];
    for (const gate of gates) {
      const tools = toolsReached(gate, scripts);
      if (tools.size === 0) continue; // an eslint-only gate; its own step covers it
      const byScript = new RegExp(`npm run ${gate.replace(/[:]/g, ':')}(?![\\w:-])`);
      const reached = allCommands.some((c) =>
        byScript.test(c) || [...tools].some((tool) => c.includes(tool)));
      if (!reached) unwired.push(`${gate} -> ${[...tools].join(', ')}`);
    }
    expect(unwired, 'these gates run only when somebody types them by hand:\n  ' + unwired.join('\n  '))
      .toEqual([]);
  });

  it('★ and `lint:all` is not accepted as a substitute for wiring', () => {
    // Being inside `lint:all` is precisely what both unwired gates already had. If a workflow ever
    // runs it, revisit this file deliberately: the check above would start crediting every gate it
    // chains to that single line, which is the defect this file was written for.
    const runsLintAll = allCommands.some((c) => /npm run lint:all(?![\w:-])/.test(c));
    expect(runsLintAll, 'a workflow now runs `lint:all` — re-read this file before accepting it')
      .toBe(false);
  });
});
