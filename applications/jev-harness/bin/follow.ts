#!/usr/bin/env tsx
/**
 * jev-harness follower CLI.
 *
 *   follow <manifest-or-judgment-url> <verb> [--arg k=v]... [--json '{...}'] [--file k=path]
 *          [--then <verb>]... [--run] [--repo <dir>] [--no-validate] [--gate]
 *
 * Verbs are the vertical's action verbs (navigate, select-tests, triage, review-gate,
 * record-outcome, calibration) or a judgment's control names (run-selected-tests, refine, ...).
 * --then chains along the controls each result affords: the follower re-dereferences every
 * result and follows the named control from THAT document. --run performs the declarative
 * run-selected-tests control locally and feeds the log into the next --then triage.
 * --gate exits 1 for needs-human-review and 3 for block, so CI can gate on it.
 */

import { readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { act, affordancesIn, dereference, findAffordance, mergeArguments, runSelectedTests, validateAgainstShape, type ResolvedAffordance, runNeedsTriage } from '../src/follower.js';

interface Cli {
  url: string;
  verb: string;
  args: Record<string, unknown>;
  then: string[];
  run: boolean;
  repo: string;
  validate: boolean;
  gate: boolean;
  outcome: boolean;
  out: string;
}

function parseCli(argv: string[]): Cli {
  const [url, verb, ...rest] = argv;
  if (!url || !verb) {
    console.error('usage: follow <manifest-or-judgment-url> <verb> [--arg k=v] [--json {...}] [--file k=path] [--then verb] [--run] [--outcome] [--repo dir] [--no-validate] [--gate] [--out dir]');
    process.exit(64);
  }
  const cli: Cli = { url, verb, args: {}, then: [], run: false, repo: process.cwd(), validate: true, gate: false, outcome: false, out: '' };
  for (let i = 0; i < rest.length; i += 1) {
    const flag = rest[i]!;
    const next = (): string => { const v = rest[i + 1]; if (v === undefined) throw new Error(`${flag} needs a value`); i += 1; return v; };
    switch (flag) {
      case '--arg': { const kv = next(); const eq = kv.indexOf('='); if (eq < 0) throw new Error('--arg needs key=value'); cli.args[kv.slice(0, eq)] = coerce(kv.slice(eq + 1)); break; }
      case '--json': Object.assign(cli.args, JSON.parse(next()) as Record<string, unknown>); break;
      case '--file': { const kv = next(); const eq = kv.indexOf('='); if (eq < 0) throw new Error('--file needs key=path'); cli.args[kv.slice(0, eq)] = readFileSync(kv.slice(eq + 1), 'utf8'); break; }
      case '--then': cli.then.push(next()); break;
      case '--run': cli.run = true; break;
      case '--repo': cli.repo = resolve(next()); break;
      case '--no-validate': cli.validate = false; break;
      case '--gate': cli.gate = true; break;
      case '--outcome': cli.outcome = true; break;
      case '--out': cli.out = resolve(next()); break;
      default: throw new Error(`unknown flag ${flag}`);
    }
  }
  if (!cli.out) cli.out = join(cli.repo, '.jev-harness', 'follower');
  return cli;
}

function coerce(v: string): unknown {
  if (v === 'true') return true;
  if (v === 'false') return false;
  if (/^-?\d+$/.test(v)) return Number(v);
  if (v.startsWith('[') || v.startsWith('{')) { try { return JSON.parse(v); } catch { return v; } }
  return v;
}

function summarize(body: unknown): string {
  const b = body as { judgment?: Record<string, unknown>; url?: string; controls?: Array<{ name: string; declarative: boolean }>; publish?: { status: string; descriptorUrl?: string } } | undefined;
  if (!b?.judgment) return JSON.stringify(body).slice(0, 400);
  const j = b.judgment;
  const parts = [`${String(j['kind'])} ${String(j['id'])}  confidence=${String(j['confidence'])}  model=${String(j['model'])}`];
  if (j['kind'] === 'navigation') {
    parts.push(`  advice=${String(j['advice'])}`);
    for (const f of (j['files'] as Array<{ path: string; probability: number }>)) parts.push(`  change ${f.probability.toFixed(2)}  ${f.path}`);
    for (const f of (j['tests'] as Array<{ path: string; probability: number }>)) parts.push(`  test   ${f.probability.toFixed(2)}  ${f.path}`);
    for (const f of (j['docs'] as Array<{ path: string; probability: number }>)) parts.push(`  doc    ${f.probability.toFixed(2)}  ${f.path}`);
  } else if (j['kind'] === 'test-selection') {
    parts.push(`  mode=${String(j['mode'])}  tests=${(j['tests'] as unknown[]).length}  ${(j['reasons'] as string[]).join('; ')}`);
    for (const t of (j['tests'] as Array<{ path: string; selectedBy: string; probability?: number }>).slice(0, 40)) parts.push(`  ${t.selectedBy.padEnd(13)} ${t.probability !== undefined ? t.probability.toFixed(2) : '    '}  ${t.path}`);
  } else if (j['kind'] === 'failure-triage') {
    for (const f of (j['failures'] as Array<{ id: string; file?: string; causeClass: string; confidence: number; action: string }>)) parts.push(`  ${f.id} ${f.causeClass.padEnd(30)} ${f.confidence.toFixed(2)}  ${f.action.padEnd(28)} ${f.file ?? ''}`);
  } else if (j['kind'] === 'review-verdict') {
    parts.push(`  verdict=${String(j['verdict'])}`);
    for (const r of (j['reasons'] as string[])) parts.push(`  - ${r}`);
    for (const h of (j['hazards'] as Array<{ name: string; probability: number; fired: boolean }>)) parts.push(`  hazard ${h.name.padEnd(28)} ${h.probability.toFixed(2)}${h.fired ? '  FIRED' : ''}`);
  } else if (j['kind'] === 'outcome') {
    parts.push(`  ${String(j['summary'])}  hit@1=${String(j['hitAt1'])} hit@3=${String(j['hitAt3'])} brier=${String(j['brier'])}`);
  }
  if (b.url) parts.push(`  url: ${b.url}`);
  if (b.publish) parts.push(`  publish: ${b.publish.status}${b.publish.descriptorUrl ? ` ${b.publish.descriptorUrl}` : ''}`);
  if (b.controls) parts.push(`  controls: ${b.controls.map((c) => `${c.name}${c.declarative ? ' (declarative)' : ''}`).join(', ')}`);
  return parts.join('\n');
}

async function followOne(documentUrl: string, verb: string, overrides: Record<string, unknown>, cli: Cli): Promise<{ body: unknown; aff: ResolvedAffordance }> {
  const doc = await dereference(documentUrl);
  const aff = findAffordance(doc.text, verb, documentUrl);
  if (!aff) {
    const available = affordancesIn(doc.text, documentUrl).map((a) => a.action.split(/[:/]/).pop()).join(', ');
    throw new Error(`${documentUrl} affords no "${verb}"; it affords: ${available}`);
  }
  const payload = mergeArguments(aff.arguments, overrides);
  if (aff.declarative) {
    return { body: { declarative: true, control: aff, payload }, aff };
  }
  if (cli.validate) {
    const report = await validateAgainstShape(aff, payload);
    if (report && !report.conforms) {
      throw new Error(`payload does not conform to ${report.shape}:\n${report.violations.map((v) => `  ${v.path}: ${v.message}`).join('\n')}`);
    }
  }
  const result = await act(aff, payload);
  if (result.status >= 400) throw new Error(`${aff.target} responded ${result.status}: ${JSON.stringify(result.body).slice(0, 600)}`);
  return { body: result.body, aff };
}

async function main(): Promise<void> {
  const cli = parseCli(process.argv.slice(2));
  mkdirSync(cli.out, { recursive: true });
  let current = await followOne(cli.url, cli.verb, cli.args, cli);
  let last = current.body as { url?: string; judgment?: { kind?: string; verdict?: string; id?: string } };
  console.log(`▸ ${cli.verb}\n${summarize(current.body)}\n`);
  save(cli.out, cli.verb, current.body);
  const first = last;
  let carried: Record<string, unknown> = {};
  let skipTriage = false;
  for (const verb of cli.then) {
    if (verb === 'triage' && skipTriage) { console.log('▸ triage skipped: the run passed, so there is nothing to explain\n'); continue; }
    const from = last.url;
    if (!from) throw new Error(`cannot follow "${verb}": the previous result has no dereferenceable url`);
    const next = await followOne(`${from}.trig`, verb, carriedFor(verb, carried), cli);
    if ((next.body as { declarative?: boolean }).declarative) {
      const control = next.aff;
      if (actionName(control.action) === 'run-selected-tests' && cli.run) {
        const args = (next.body as { payload: Record<string, unknown> }).payload;
        console.log(`▸ ${verb} (performed locally in ${cli.repo})`);
        const run = runSelectedTests(args, cli.repo);
        writeFileSync(join(cli.out, 'run.log'), run.log);
        console.log(`  ${run.command}\n  exit ${run.exitCode}, ${run.failedTests.length} failing test file(s)\n`);
        carried = { log: run.log, tests_failed: run.failedTests, tests_run: (args['tests'] as string[] | undefined) ?? [] };
        skipTriage = !runNeedsTriage(run);
        continue;
      }
      console.log(`▸ ${verb} is declarative — perform it yourself:\n${JSON.stringify((next.body as { payload: unknown }).payload, null, 2)}\n`);
      break;
    }
    current = next;
    last = current.body as typeof last;
    console.log(`▸ ${verb}\n${summarize(current.body)}\n`);
    save(cli.out, verb, current.body);
  }
  if (cli.outcome && first.url) {
    // Score the FIRST judgment of the chain with what the chain observed (or what --arg supplied).
    const observed = carriedFor('record-outcome', { ...carried, ...pick(cli.args, ['files_changed', 'tests_failed', 'tests_run', 'human_decision', 'confirmed_classes']) });
    const o = await followOne(`${first.url}.trig`, 'record-outcome', observed, cli);
    console.log(`▸ record-outcome\n${summarize(o.body)}\n`);
    save(cli.out, 'record-outcome', o.body);
  }
  if (cli.gate && last.judgment?.kind === 'review-verdict') {
    const v = last.judgment.verdict;
    process.exit(v === 'block' ? 3 : v === 'needs-human-review' ? 1 : 0);
  }
}

function actionName(action: string): string {
  return action.split(/[:/]/).pop() ?? action;
}

/** Only the carried values a verb's input shape can take, so a run log never rides into an outcome. */
function carriedFor(verb: string, carried: Record<string, unknown>): Record<string, unknown> {
  if (verb === 'triage') return pick(carried, ['log', 'changed_files']);
  if (verb === 'record-outcome') return pick(carried, ['tests_failed', 'tests_run', 'files_changed', 'human_decision', 'confirmed_classes']);
  return pick(carried, ['changed_files', 'task']);
}

function pick(obj: Record<string, unknown>, keys: readonly string[]): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const k of keys) if (obj[k] !== undefined) out[k] = obj[k];
  return out;
}

function save(dir: string, verb: string, body: unknown): void {
  const id = (body as { judgment?: { id?: string } }).judgment?.id ?? Date.now().toString(36);
  writeFileSync(join(dir, `${verb}-${id}.json`), JSON.stringify(body, null, 2));
}

main().catch((err: Error & { cause?: Error }) => {
  console.error(`follow: ${err.message}${err.cause ? ` (cause: ${err.cause.message})` : ''}`);
  process.exit(2);
});
