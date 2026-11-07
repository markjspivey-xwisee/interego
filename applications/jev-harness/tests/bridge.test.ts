import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { createApp } from '../bridge/server.js';
import { act, dereference, findAffordance, validateAgainstShape } from '../src/follower.js';
import { GitRepositorySource } from '../src/repository-source.js';
import { HarnessStore } from '../src/store.js';
import { fixtureRepo, idOf, preferringJev } from './helpers.js';
import { choiceAnswer, FakeJevClient, type Answer } from '../src/jev-client.js';

let server: Server;
let base: string;
let repo: string;

beforeAll(async () => {
  repo = fixtureRepo();
  const jev = new FakeJevClient((state, questions) => {
    const out: Partial<Record<string, Answer>> = {};
    for (const [id, q] of Object.entries(questions)) {
      if (q.type !== 'choice') continue;
      const opts = Object.keys(q.criteria);
      if (id === 'change') out[id] = choiceAnswer(opts, idOf(state, 'src/rollup.ts'), 0.9);
      if (id === 'test') out[id] = choiceAnswer(opts, idOf(state, 'tests/rollup.test.ts'), 0.8);
      if (id === 'doc') out[id] = choiceAnswer(opts, idOf(state, 'CONFORMANCE.md'), 0.8);
      if (id === 'test_0') out[id] = choiceAnswer(opts, idOf(state, 'tests/conformance-claims-are-grounded.test.ts'), 0.7);
      if (id === 'risk') out[id] = choiceAnswer(opts, 'low', 0.9);
    }
    return out;
  });
  const { app } = createApp({ jev, repoRoot: repo, base: 'http://127.0.0.1:0', store: new HarnessStore(repo) });
  await new Promise<void>((resolve) => { server = app.listen(0, '127.0.0.1', () => resolve()); });
  const port = (server.address() as AddressInfo).port;
  base = `http://127.0.0.1:${port}`;
  server.close();
  // Re-create with the real base so targets are followable.
  const created = createApp({ jev, repoRoot: repo, base, store: new HarnessStore(repo) });
  await new Promise<void>((resolve) => { server = created.app.listen(port, '127.0.0.1', () => resolve()); });
});

afterAll(() => { server.close(); });

describe('the bridge as an Interego vertical', () => {
  it('serves a manifest a generic agent can follow into a judgment whose payload affords the next step', async () => {
    const manifest = await dereference(`${base}/affordances`);
    expect(manifest.contentType).toContain('text/turtle');
    const nav = findAffordance(manifest.text, 'navigate');
    expect(nav?.target).toBe(`${base}/jev-harness/navigate`);

    const payload = { task: 'rollup emits satisfied twice per block' };
    const report = await validateAgainstShape(nav!, payload);
    expect(report?.conforms).toBe(true);

    const r = await act(nav!, payload);
    expect(r.status).toBe(200);
    const body = r.body as { judgment: { kind: string; files: Array<{ path: string }>; graphIri: string; advice: string }; url: string; controls: Array<{ name: string }> ; publish: { status: string } };
    expect(body.judgment.kind).toBe('navigation');
    expect(body.judgment.files[0]?.path).toBe('src/rollup.ts');
    expect(body.judgment.advice).toBe('open-top-file');
    expect(body.publish.status).toBe('skipped');
    expect(body.controls.map((c) => c.name)).toEqual(expect.arrayContaining(['open-files', 'select-tests', 'record-outcome']));

    // Dereference the judgment as TriG and follow the select-tests control it carries.
    const trig = await dereference(`${body.url}.trig`);
    expect(trig.contentType).toContain('application/trig');
    const select = findAffordance(trig.text, 'select-tests');
    expect(select?.target).toBe(`${base}/jev-harness/select-tests`);
    const r2 = await act(select!, select!.arguments);
    expect(r2.status).toBe(200);
    const sel = (r2.body as { judgment: { kind: string; mode: string; tests: Array<{ path: string; selectedBy: string }>; graphIri: string }; url: string }).judgment;
    expect(sel.kind).toBe('test-selection');
    expect(sel.mode).toBe('subset');
    expect(sel.tests.map((t) => t.path)).toEqual(expect.arrayContaining(['tests/rollup.test.ts', 'tests/conformance-claims-are-grounded.test.ts']));

    // Record an outcome through the control the selection affords; it supersedes the selection.
    const trig2 = await dereference(`${(r2.body as { url: string }).url}.trig`);
    const outcome = findAffordance(trig2.text, 'record-outcome');
    const r3 = await act(outcome!, { ...outcome!.arguments, tests_failed: ['tests/rollup.test.ts'] });
    expect(r3.status).toBe(200);
    const o = (r3.body as { judgment: { kind: string; hitAt1: boolean; judgmentIri: string } }).judgment;
    expect(o.kind).toBe('outcome');
    expect(o.hitAt1).toBe(true);
    expect(o.judgmentIri).toBe(sel.graphIri);
    const trig3 = await dereference(`${(r3.body as { url: string }).url}.trig`);
    expect(trig3.text).toContain('iep:supersedes');
    expect(trig3.text).toContain('iep:Asserted');

    const cal = await (await fetch(`${base}/jev-harness/calibration`)).json() as { cells: Array<{ kind: string; samples: number; hitAt1: number | null }> };
    expect(cal.cells.find((c) => c.kind === 'test-selection')?.samples).toBe(1);
  });

  it('refuses a payload that violates the input shape with the relay\'s 422 envelope', async () => {
    const res = await fetch(`${base}/jev-harness/navigate`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ task: 'short' }) });
    expect(res.status).toBe(422);
    const body = await res.json() as { error: string; shape: string; violations: Array<{ constraint: string }> };
    expect(body.error).toBe('shape_violation');
    expect(body.shape).toContain('NavigateInputShape');
    expect(body.violations[0]?.constraint).toBe('sh:minLength');
  });

  it('serves the judgment as markdown with control blocks and the ontology as turtle', async () => {
    const list = await (await fetch(`${base}/jev-harness/judgments`)).json() as Array<{ id: string }>;
    const md = await (await fetch(`${base}/jev-harness/judgments/${list[0]!.id}.md`)).text();
    expect(md).toContain(':::control');
    const onto = await (await fetch(`${base}/ns/jev-harness`, { headers: { Accept: 'text/turtle' } })).text();
    expect(onto).toContain('NavigateInputShape');
    const health = await (await fetch(`${base}/health`)).json() as { status: string; files: number };
    expect(health.status).toBe('ok');
    expect(health.files).toBeGreaterThan(5);
  });

  it('gates a diff through the review-gate affordance', async () => {
    const manifest = await dereference(`${base}/affordances`);
    const gate = findAffordance(manifest.text, 'review-gate')!;
    const r = await act(gate, { diff: 'diff --git a/src/rollup.ts b/src/rollup.ts\n--- a/src/rollup.ts\n+++ b/src/rollup.ts\n@@ -1 +1 @@\n-return 4\n+return 2\n', title: 'fix rollup', description: 'return 2' });
    expect(r.status).toBe(200);
    const j = (r.body as { judgment: { verdict: string; policy: string } }).judgment;
    // The fake answers neutral 0.5 for every hazard noul (below 0.6) and a neutral description score of 1.0, low risk at 0.9.
    expect(j.verdict).toBe('auto-ok');
    expect(j.policy.length).toBeGreaterThan(50);
  });
});

describe('a real repository', () => {
  it('inventories the harness itself (git-tracked) without touching the model', () => {
    const jev = preferringJev(() => undefined);
    const { harness } = createApp({ jev, repoRoot: new URL('..', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'), base: 'http://localhost:1', store: new HarnessStore(repo) });
    const inv = harness.inventory();
    expect(inv.files.some((f) => f.path === 'src/repo.ts')).toBe(true);
    expect(inv.files.some((f) => f.path.startsWith('vendor/'))).toBe(false);
  });

  it('judges a newly fetched revision without restarting or losing earlier judgments', async () => {
    const prefix = 'jev-source-bridge-';
    const scratch = mkdtempSync(join(tmpdir(), prefix));
    const remote = join(scratch, 'repository');
    const stateRoot = join(scratch, 'state');
    const checkoutRoot = join(scratch, 'checkouts');
    const originalPath = 'src/agents-directory.ts';
    const newPath = 'src/agents-filters.ts';
    const originalContent = 'export const directoryCount = 217;\n';
    const git = (...args: string[]): string => execFileSync('git', [
      '-C', remote, '-c', `core.hooksPath=${join(scratch, 'no-hooks')}`, ...args,
    ], { encoding: 'utf8' }).trim();
    const commit = (message: string): string => {
      git('add', '.');
      git('-c', 'user.name=Jev Test', '-c', 'user.email=jev-test@example.invalid', '-c', 'commit.gpgsign=false', 'commit', '-qm', message);
      return git('rev-parse', 'HEAD');
    };
    let listener: Server | undefined;
    try {
      mkdirSync(join(remote, 'src'), { recursive: true });
      mkdirSync(checkoutRoot);
      const source = new GitRepositorySource(remote, 0, checkoutRoot);
      git('init', '-q', '--initial-branch=master');
      writeFileSync(join(remote, originalPath), originalContent);
      const firstCommit = commit('Add the Agents directory');
      const jev = preferringJev((id, state) => {
        if (id !== 'change') return undefined;
        const { task } = state as { task: string };
        return idOf(state, task.includes('refreshed') ? newPath : originalPath);
      });
      const { app } = createApp({ jev, repoRoot: stateRoot, base: 'http://127.0.0.1:0', repositorySource: source });
      const active = app.listen(0, '127.0.0.1');
      listener = active;
      await new Promise<void>((ready, fail) => { active.once('listening', ready).once('error', fail); });
      const origin = `http://127.0.0.1:${(active.address() as AddressInfo).port}`;
      const post = (path: string, body: Record<string, unknown>): Promise<Response> => fetch(`${origin}/jev-harness/${path}`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
        signal: AbortSignal.timeout(10_000),
      });
      const health = async (): Promise<{ commit: string; files: number }> => {
        const response = await fetch(`${origin}/health`, { signal: AbortSignal.timeout(10_000) });
        expect(response.status).toBe(200);
        return await response.json() as { commit: string; files: number };
      };
      const navigate = async (task: string): Promise<{ id: string; files: Array<{ path: string }>; repository: { commit: string } }> => {
        const response = await post('navigate', { task });
        expect(response.status).toBe(200);
        return (await response.json() as { judgment: { id: string; files: Array<{ path: string }>; repository: { commit: string } } }).judgment;
      };

      expect(await health()).toMatchObject({ commit: firstCommit, files: 1 });
      const noChangedFiles = await post('select-tests', { base_ref: firstCommit });
      expect(noChangedFiles.status).toBe(400);
      expect(await noChangedFiles.text()).toContain('changed_files');
      const noDiff = await post('review-gate', { base_ref: firstCommit });
      expect(noDiff.status).toBe(400);
      expect(await noDiff.text()).toContain('diff');
      const prior = await navigate('Find the original Agents directory');
      expect(prior.repository.commit).toBe(firstCommit);
      expect(prior.files[0]?.path).toBe(originalPath);

      await source.read(async (oldRoot) => {
        writeFileSync(join(remote, originalPath), 'export const directoryCount = 218;\n');
        writeFileSync(join(remote, newPath), 'export const linkedExamplesCount = 3;\n');
        const secondCommit = commit('Update the Agents directory filters');

        expect(await health()).toMatchObject({ commit: secondCommit, files: 2 });
        const refreshed = await navigate('Find the refreshed Agents directory filters');
        expect(refreshed.repository.commit).toBe(secondCommit);
        expect(refreshed.files[0]?.path).toBe(newPath);
        const selection = await post('select-tests', { changed_files: [newPath] });
        expect(selection.status).toBe(200);
        expect(await selection.json()).toMatchObject({ judgment: { repository: { commit: secondCommit } } });
        expect(readFileSync(join(oldRoot, originalPath), 'utf8').trim()).toBe(originalContent.trim());
        expect(existsSync(join(oldRoot, newPath))).toBe(false);

        const response = await fetch(`${origin}/jev-harness/judgments`, { signal: AbortSignal.timeout(10_000) });
        expect(response.status).toBe(200);
        const stored = await response.json() as Array<{ id: string }>;
        expect(stored.map(({ id }) => id)).toEqual(expect.arrayContaining([prior.id, refreshed.id]));
      });
    } finally {
      if (listener) await new Promise<void>((closed) => listener?.close(() => closed()));
      const target = realpathSync(scratch);
      expect(dirname(target), 'fixture parent').toBe(realpathSync(tmpdir()));
      expect(basename(target).startsWith(prefix), 'fixture name').toBe(true);
      rmSync(target, { recursive: true, force: true, maxRetries: 3 });
    }
  }, 25_000);
});
