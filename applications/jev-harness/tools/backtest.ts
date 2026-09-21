#!/usr/bin/env tsx
/**
 * History backtest: replay recent commits as if they were tasks, judge them at the parent
 * commit, and score the judgments against what the commit actually did. Fills the
 * calibration view with real outcomes and shows which policy rule fires most.
 *
 *   tsx tools/backtest.ts --repo <path> [--commits 40] [--kinds navigate,select,gate] [--max-files 25] [--concurrency 3] [--precedents run|none|store]
 *
 * Commits are replayed oldest first, so that with --precedents run (the default) each
 * navigation consults only the outcomes of the commits replayed before it — the memory a live
 * bridge would have had at that point, and never the commit's own outcome from an earlier
 * run. --precedents none turns memory off (the before-measurement); --precedents store hands
 * every outcome the store holds to every navigation, which includes earlier replays of the
 * same commits and is therefore not a fair measurement, only a demonstration.
 *
 * Ground truth per kind:
 *   navigate  the commit's changed files (hit@1, hit@3, Brier over the candidates)
 *   select    the tests the commit itself touched — a proxy for "the tests this change
 *             concerned"; a selection covers the commit when every touched test is in it
 *   gate      the commit landed on the default branch, so the human decision was approved;
 *             auto-ok agrees, needs-human-review is conservative, block disagrees
 *
 * Judgments and outcomes are written to <repo>/.jev-harness like the bridge's, so the
 * bridge's calibration endpoint sees them; a report lands in <repo>/.jev-harness/backtest/.
 */

import { mkdirSync, writeFileSync, existsSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { jevFromEnv } from '../src/jev-client.js';
import { contextFromEnv, descriptorTrig, hmdMarkdown, payloadTurtle, type Published } from '../src/descriptor.js';
import { navigate } from '../src/judgments/navigate.js';
import { selectTests } from '../src/judgments/select-tests.js';
import { reviewGate } from '../src/judgments/review-gate.js';
import { recordOutcome } from '../src/judgments/outcome.js';
import { git, inventory, isTestPath } from '../src/repo.js';
import { HarnessStore, computeCalibration } from '../src/store.js';
import { round } from '../src/judgments/common.js';
import type { Precedent } from '../src/judgments/precedents.js';

type PrecedentMode = 'run' | 'none' | 'store';
interface Args { repo: string; commits: number; kinds: Set<string>; maxFiles: number; concurrency: number; precedents: PrecedentMode }

function parseArgs(argv: string[]): Args {
  const a: Args = { repo: process.cwd(), commits: 40, kinds: new Set(['navigate', 'select', 'gate']), maxFiles: 25, concurrency: 3, precedents: 'run' };
  for (let i = 0; i < argv.length; i += 1) {
    const f = argv[i]!;
    const v = (): string => { const x = argv[i + 1]; if (x === undefined) throw new Error(`${f} needs a value`); i += 1; return x; };
    if (f === '--repo') a.repo = resolve(v());
    else if (f === '--commits') a.commits = Number(v());
    else if (f === '--kinds') a.kinds = new Set(v().split(','));
    else if (f === '--max-files') a.maxFiles = Number(v());
    else if (f === '--concurrency') a.concurrency = Number(v());
    else if (f === '--precedents') {
      const m = v();
      if (m !== 'run' && m !== 'none' && m !== 'store') throw new Error('--precedents takes run, none or store');
      a.precedents = m;
    }
    else throw new Error(`unknown flag ${f}`);
  }
  return a;
}

interface CommitCase {
  sha: string; parent: string; subject: string; body: string; changed: string[]; touchedTests: string[];
}

interface CaseResult {
  sha: string; subject: string; changedCount: number;
  navigate?: { top: string; confidence: number; advice: string; hitAt1: boolean | null; hitAt3: boolean | null; brier: number | null; passes: number; tokens: number; precedents: number; precedentWeight: number };
  select?: { mode: string; tests: number; semantic: number; touchedTests: number; covered: boolean | null; confidence: number; tokens: number; reason: string };
  gate?: { verdict: string; agreement: string; reasons: string[]; riskConfidence: number | null; tokens: number };
  skipped?: string;
}

function loadCases(repo: string, n: number, maxFiles: number): CommitCase[] {
  const shas = (git(repo, ['log', '--no-merges', '--format=%H', '-n', String(n * 2), 'HEAD']) ?? '').split('\n').filter(Boolean);
  const out: CommitCase[] = [];
  for (const sha of shas) {
    if (out.length >= n) break;
    const parent = git(repo, ['rev-parse', `${sha}^`])?.trim();
    if (!parent || parent.startsWith(sha)) continue;
    const changed = (git(repo, ['diff', '--name-only', '--diff-filter=ACMRD', parent, sha]) ?? '').split('\n').map((s) => s.trim()).filter(Boolean);
    if (changed.length === 0 || changed.length > maxFiles) continue;
    const message = git(repo, ['log', '-1', '--format=%s%n%n%b', sha]) ?? '';
    const [subject = '', ...rest] = message.split('\n');
    out.push({ sha, parent, subject: subject.trim(), body: rest.join('\n').trim().slice(0, 1200), changed, touchedTests: changed.filter(isTestPath) });
  }
  return out;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const jev = jevFromEnv();
  const ctx = contextFromEnv(process.env['BRIDGE_DEPLOYMENT_URL'] ?? 'http://localhost:6090');
  const store = new HarnessStore(args.repo);
  // Oldest first: memory only ever holds what came before.
  const cases = loadCases(args.repo, args.commits, args.maxFiles).reverse();
  const runPrecedents: Precedent[] = [];
  const worktree = join(args.repo, '.jev-harness', 'backtest-worktree');
  if (existsSync(worktree)) { git(args.repo, ['worktree', 'remove', '--force', worktree]); rmSync(worktree, { recursive: true, force: true }); }
  const first = cases[0];
  if (!first) throw new Error('no eligible commits');
  if (git(args.repo, ['worktree', 'add', '--detach', worktree, first.parent]) === null) throw new Error('could not create the backtest worktree');
  console.error(`backtest: ${cases.length} commits, kinds ${[...args.kinds].join('+')}, precedents ${args.precedents}, worktree ${worktree}`);

  const results: CaseResult[] = [];
  let tokens = 0;
  const save = (j: Published): void => { store.save(j, { payloadTurtle: payloadTurtle(j, ctx), descriptorTrig: descriptorTrig(j, ctx), markdown: hmdMarkdown(j, ctx) }); };

  for (const [i, c] of cases.entries()) {
    const r: CaseResult = { sha: c.sha.slice(0, 10), subject: c.subject.slice(0, 90), changedCount: c.changed.length };
    results.push(r);
    if (git(args.repo, ['-C', worktree, 'checkout', '-q', '--detach', c.parent]) === null) { r.skipped = 'checkout failed'; continue; }
    const inv = inventory(worktree);
    const task = c.body ? `${c.subject}\n\n${c.body}` : c.subject;
    const jobs: Array<Promise<void>> = [];

    if (args.kinds.has('navigate')) jobs.push((async () => {
      const precedents = args.precedents === 'none' ? undefined : args.precedents === 'store' ? store.precedents() : runPrecedents;
      const j = await navigate(jev, inv, { task, topK: 5, ...(precedents ? { precedents } : {}) });
      const o = recordOutcome(j, { judgmentIri: j.graphIri, filesChanged: [...c.changed], source: 'backtest' });
      save(j); save(o);
      if (args.precedents === 'run') runPrecedents.push({ task, files: [...c.changed], source: 'backtest', at: o.createdAt, outcomeIri: o.graphIri });
      tokens += j.usage.input_tokens;
      r.navigate = { top: j.files[0]?.path ?? '', confidence: j.confidence, advice: j.advice, hitAt1: o.hitAt1, hitAt3: o.hitAt3, brier: o.brier, passes: j.passes.length, tokens: j.usage.input_tokens, precedents: j.precedents?.applied.length ?? 0, precedentWeight: j.precedents?.weight ?? 0 };
    })().catch((e: Error) => { r.skipped = `navigate: ${e.message}`; }));

    if (args.kinds.has('select')) jobs.push((async () => {
      const sources = c.changed.filter((p) => !isTestPath(p));
      if (sources.length === 0) return;
      const j = await selectTests(jev, inv, { changedFiles: sources, task: c.subject });
      const selected = new Set(j.tests.map((t) => t.path));
      const covered = c.touchedTests.length === 0 ? null : c.touchedTests.every((t) => selected.has(t));
      const o = recordOutcome(j, { judgmentIri: j.graphIri, testsRun: j.tests.map((t) => t.path), testsFailed: [...c.touchedTests], source: 'backtest' });
      save(j); save(o);
      tokens += j.usage.input_tokens;
      r.select = { mode: j.mode, tests: j.tests.length, semantic: j.tests.filter((t) => t.selectedBy === 'semantic').length, touchedTests: c.touchedTests.length, covered, confidence: j.confidence, tokens: j.usage.input_tokens, reason: j.reasons[0] ?? '' };
    })().catch((e: Error) => { r.skipped = `select: ${e.message}`; }));

    if (args.kinds.has('gate')) jobs.push((async () => {
      const diff = git(args.repo, ['diff', '--no-color', '--unified=3', c.parent, c.sha]) ?? '';
      if (!diff) return;
      const j = await reviewGate(jev, inv, { diff, title: c.subject, description: c.body || c.subject, changedFiles: [...c.changed] });
      const o = recordOutcome(j, { judgmentIri: j.graphIri, humanDecision: 'approved', source: 'backtest' });
      save(j); save(o);
      tokens += j.usage.input_tokens;
      r.gate = { verdict: j.verdict, agreement: o.agreement ?? 'n/a', reasons: [...j.reasons], riskConfidence: j.risk?.confidence ?? null, tokens: j.usage.input_tokens };
    })().catch((e: Error) => { r.skipped = `gate: ${e.message}`; }));

    await Promise.all(jobs);
    const parts = [
      r.navigate ? `nav hit@1=${r.navigate.hitAt1} conf=${r.navigate.confidence}${r.navigate.precedents > 0 ? ` mem=${r.navigate.precedents}@${r.navigate.precedentWeight}` : ''}` : '',
      r.select ? `select ${r.select.mode}/${r.select.tests} covered=${r.select.covered}` : '',
      r.gate ? `gate ${r.gate.verdict}` : '',
      r.skipped ? `SKIP ${r.skipped}` : '',
    ].filter(Boolean).join('  ');
    console.error(`${String(i + 1).padStart(3)}/${cases.length} ${r.sha} ${parts}  — ${r.subject.slice(0, 60)}`);
  }

  git(args.repo, ['worktree', 'remove', '--force', worktree]);

  // Summary.
  const nav = results.filter((r) => r.navigate).map((r) => r.navigate!);
  const sel = results.filter((r) => r.select).map((r) => r.select!);
  const gate = results.filter((r) => r.gate).map((r) => r.gate!);
  const rate = (xs: Array<boolean | null>): string => { const v = xs.filter((x): x is boolean => x !== null); return v.length ? `${round(v.filter(Boolean).length / v.length, 2)} (n=${v.length})` : 'n/a'; };
  const mean = (xs: number[]): string => (xs.length ? String(round(xs.reduce((a, b) => a + b, 0) / xs.length, 3)) : 'n/a');
  const reasonCounts = new Map<string, number>();
  for (const g of gate) for (const reason of g.reasons) { const key = reason.replace(/[0-9.]+/g, '#'); reasonCounts.set(key, (reasonCounts.get(key) ?? 0) + 1); }
  const cost = round((tokens * 0.042) / 1e6, 4);
  const lines = [
    `# jev-harness backtest — ${new Date().toISOString()}`,
    '',
    `Repository ${args.repo}, ${results.length} commits (≤ ${args.maxFiles} files each, oldest first), precedents ${args.precedents}, ${tokens} input tokens ≈ $${cost}.`,
    '',
    '| Kind | Metric | Value |',
    '| --- | --- | --- |',
    `| navigate | hit@1 | ${rate(nav.map((n) => n.hitAt1))} |`,
    `| navigate | hit@3 | ${rate(nav.map((n) => n.hitAt3))} |`,
    `| navigate | mean Brier | ${mean(nav.map((n) => n.brier).filter((b): b is number => b !== null))} |`,
    `| navigate | mean confidence | ${mean(nav.map((n) => n.confidence))} |`,
    `| navigate | hit@1 when advice=open-top-file | ${rate(nav.filter((n) => n.advice === 'open-top-file').map((n) => n.hitAt1))} |`,
    `| navigate | hit@3 when advice=open-top-three | ${rate(nav.filter((n) => n.advice === 'open-top-three').map((n) => n.hitAt3))} |`,
    `| navigate | precedents (${args.precedents}): commits where any applied | ${nav.length ? round(nav.filter((n) => n.precedents > 0).length / nav.length, 2) : 'n/a'} |`,
    `| navigate | hit@1 when precedents applied | ${rate(nav.filter((n) => n.precedents > 0).map((n) => n.hitAt1))} |`,
    `| navigate | hit@1 when none applied | ${rate(nav.filter((n) => n.precedents === 0).map((n) => n.hitAt1))} |`,
    `| select | covers the tests the commit touched | ${rate(sel.map((s) => s.covered))} |`,
    `| select | full-suite rate | ${sel.length ? round(sel.filter((s) => s.mode === 'full').length / sel.length, 2) : 'n/a'} |`,
    `| select | mean tests selected (subset) | ${mean(sel.filter((s) => s.mode === 'subset').map((s) => s.tests))} |`,
    `| gate | auto-ok (agree) | ${gate.length ? round(gate.filter((g) => g.agreement === 'agree').length / gate.length, 2) : 'n/a'} |`,
    `| gate | needs-human-review (conservative) | ${gate.length ? round(gate.filter((g) => g.agreement === 'conservative').length / gate.length, 2) : 'n/a'} |`,
    `| gate | block (disagree) | ${gate.length ? round(gate.filter((g) => g.agreement === 'disagree').length / gate.length, 2) : 'n/a'} |`,
    `| gate | mean risk confidence | ${mean(gate.map((g) => g.riskConfidence).filter((x): x is number => x !== null))} |`,
    '',
    '## Why the gate asked for a human',
    '',
    '| Reason (numbers elided) | Count |',
    '| --- | --- |',
    ...[...reasonCounts.entries()].sort((a, b) => b[1] - a[1]).map(([k, v]) => `| ${k} | ${v} |`),
    '',
    '## Per commit',
    '',
    '| Commit | Files | navigate top (hit@1/3, conf) | select (mode/tests, covered) | gate | Subject |',
    '| --- | --- | --- | --- | --- | --- |',
    ...results.map((r) => `| ${r.sha} | ${r.changedCount} | ${r.navigate ? `${r.navigate.top.split('/').slice(-2).join('/')} (${r.navigate.hitAt1}/${r.navigate.hitAt3}, ${r.navigate.confidence})` : ''} | ${r.select ? `${r.select.mode}/${r.select.tests}, ${r.select.covered}` : ''} | ${r.gate?.verdict ?? ''} | ${r.subject.replace(/\|/g, '/')}${r.skipped ? ` (${r.skipped})` : ''} |`),
    '',
    '## Calibration view after this run',
    '',
    '```json',
    JSON.stringify(computeCalibration(store.outcomes()), null, 2),
    '```',
  ];
  const outDir = join(args.repo, '.jev-harness', 'backtest');
  mkdirSync(outDir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  writeFileSync(join(outDir, `${stamp}.md`), lines.join('\n'));
  writeFileSync(join(outDir, `${stamp}.json`), JSON.stringify({ args: { ...args, kinds: [...args.kinds] }, tokens, cost, results }, null, 2));
  console.log(lines.slice(0, 22).join('\n'));
  console.log(`\nreport: ${join(outDir, `${stamp}.md`)}`);
}

main().catch((err: Error) => { console.error(`backtest: ${err.message}`); process.exit(1); });
