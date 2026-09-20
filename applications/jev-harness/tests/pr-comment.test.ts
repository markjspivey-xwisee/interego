import { describe, expect, it } from 'vitest';
import { mkdtempSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { descriptorLinks, gateComment, loadSavedResults, selectionComment } from '../src/pr-comment.js';

const links = { podPublicOrigin: 'https://gate.example', relayOrigin: 'https://relay.example', podName: 'u-pk-x' };
const internal = 'http://css.railway.internal:3456/u-pk-x/context-graphs/1789914024271.ttl';

describe('descriptor links', () => {
  it('rewrites the internal storage host to the public origin and derives the relay render view', () => {
    expect(descriptorLinks(internal, links)).toEqual({
      descriptor: 'https://gate.example/u-pk-x/context-graphs/1789914024271.ttl',
      render: 'https://relay.example/render/urn%3Aiep%3Au-pk-x%3A1789914024271',
    });
  });
  it('leaves a public URL alone and reads the pod name out of it when none is given', () => {
    const l = descriptorLinks('https://gate.example/u-pk-y/context-graphs/5.ttl', { relayOrigin: 'https://relay.example' });
    expect(l.descriptor).toBe('https://gate.example/u-pk-y/context-graphs/5.ttl');
    expect(l.render).toBe('https://relay.example/render/urn%3Aiep%3Au-pk-y%3A5');
  });
});

describe('the review-gate comment', () => {
  const body = {
    judgment: {
      kind: 'review-verdict', verdict: 'needs-human-review', confidence: 0.76, model: 'jev-1.13.0',
      reasons: ['deterministic checks fired: sensitive-path:deploy/Dockerfile', 'probability of high risk 0.84 is at or above 0.25'],
      hazards: [{ name: 'authorization-change', probability: 0.1, fired: false }, { name: 'behaviour-beyond-description', probability: 0.71, fired: true }],
      descriptionMatch: 0.42,
    },
    url: 'http://localhost:6090/jev-harness/judgments/x',
    publish: { status: 'published', descriptorUrl: internal },
  };

  it('leads with the verdict, lists the reasons, marks the hazard that fired, and links the descriptor', () => {
    const md = gateComment(body, links);
    expect(md.startsWith('<!-- jev-harness:review-gate -->')).toBe(true);
    expect(md).toContain('Review gate: **needs-human-review**');
    expect(md).toContain('a person should read this diff');
    expect(md).toContain('- deterministic checks fired: sensitive-path:deploy/Dockerfile');
    expect(md).toContain('| behaviour-beyond-description | 0.71 | **fired** |');
    expect(md).toContain('| authorization-change | 0.10 |  |');
    expect(md).toContain('Description match 0.42');
    expect(md).toContain('[signed descriptor](https://gate.example/u-pk-x/context-graphs/1789914024271.ttl)');
    expect(md).toContain('[rendered view](https://relay.example/render/urn%3Aiep%3Au-pk-x%3A1789914024271)');
    expect(md).not.toContain('localhost');
  });

  it('says so when nothing was published, and reads block and auto-ok as their own sentences', () => {
    expect(gateComment({ judgment: { verdict: 'auto-ok', confidence: 0.9 }, publish: { status: 'skipped' } })).toContain('nothing here needs a person');
    expect(gateComment({ judgment: { verdict: 'auto-ok' }, publish: { status: 'skipped' } })).toContain('_Not published to the pod');
    expect(gateComment({ judgment: { verdict: 'block' }, publish: { status: 'failed', error: 'relay down' } })).toContain('do not merge');
    expect(gateComment({ judgment: { verdict: 'block' }, publish: { status: 'failed', error: 'relay down' } })).toContain('failed: relay down');
  });
});

describe('the selection comment', () => {
  it('reports a whole-suite run with its policy reason and a passing run', () => {
    const md = selectionComment([{ verb: 'select-tests', body: { judgment: { mode: 'full', tests: [], reasons: ['sensitive paths changed: .github/workflows/x.yml'] }, publish: { status: 'skipped' } } }]);
    expect(md.startsWith('<!-- jev-harness:selection -->')).toBe(true);
    expect(md).toContain('Test selection: **whole suite**');
    expect(md).toContain('- sensitive paths changed');
    expect(md).toContain('The run passed, so nothing was triaged.');
  });

  it('lists a subset by how it was chosen, tabulates the triage when the run failed, and quotes the outcome', () => {
    const results = [
      { verb: 'select-tests', body: { judgment: { mode: 'subset', tests: [{ path: 'tests/a.test.ts', selectedBy: 'import-graph' }, { path: 'tests/b.test.ts', selectedBy: 'semantic' }, { path: 'tests/c.test.ts', selectedBy: 'import-graph' }], reasons: [] }, publish: { status: 'published', descriptorUrl: internal } } },
      { verb: 'triage', body: { judgment: { failures: [{ id: 'X00', file: 'tests/a.test.ts', name: 'does x', causeClass: 'regression', confidence: 0.8, action: 'fix the code' }] } } },
      { verb: 'record-outcome', body: { judgment: { summary: '1 of 1 failing test was selected' } } },
    ];
    const md = selectionComment(results, links);
    expect(md).toContain('Test selection: **3 test file(s)**');
    expect(md).toContain('2 by import-graph, 1 by semantic.');
    expect(md).toContain('- `tests/b.test.ts`');
    expect(md).toContain('| `tests/a.test.ts` › does x | regression | 0.80 | fix the code |');
    expect(md).toContain('Outcome recorded: 1 of 1 failing test was selected');
    expect(md).toContain('[signed descriptor](https://gate.example/');
  });

  it('says when no selection was saved', () => {
    expect(selectionComment([])).toContain('no result saved');
  });
});

describe('loading the follower\'s saved results', () => {
  it('keeps the newest file per verb, names the verb correctly for ids with a hyphen, and ignores the run log', () => {
    const dir = mkdtempSync(join(tmpdir(), 'jev-follower-'));
    writeFileSync(join(dir, 'select-tests-mu9ba9to-7a156c.json'), JSON.stringify({ judgment: { mode: 'full' } }));
    writeFileSync(join(dir, 'select-tests-mu9zzzzz-000000.json'), JSON.stringify({ judgment: { mode: 'subset' } }));
    writeFileSync(join(dir, 'review-gate-mu9tb4v7.json'), JSON.stringify({ judgment: { verdict: 'auto-ok' } }));
    writeFileSync(join(dir, 'run.log'), 'noise');
    const old = new Date(Date.now() - 60_000);
    utimesSync(join(dir, 'select-tests-mu9ba9to-7a156c.json'), old, old);
    const results = loadSavedResults(dir);
    expect(results.map((r) => r.verb).sort()).toEqual(['review-gate', 'select-tests']);
    expect((results.find((r) => r.verb === 'select-tests')!.body['judgment'] as { mode: string }).mode).toBe('subset');
  });

  it('returns nothing for a directory that does not exist', () => {
    expect(loadSavedResults(join(tmpdir(), 'no-such-dir-' + Date.now()))).toEqual([]);
  });
});
