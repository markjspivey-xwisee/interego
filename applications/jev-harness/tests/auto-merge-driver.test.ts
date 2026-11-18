import { afterEach, describe, expect, it, vi } from 'vitest';

const HEAD = 'a'.repeat(40);
const BASE = 'b'.repeat(40);
const update = ['api', '--method', 'PUT', 'repos/fictional/repo/pulls/42/update-branch', '-f', `expected_head_sha=${HEAD}`];

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.doUnmock('node:child_process');
  vi.doUnmock('../src/pr-comment.js');
});

async function run(options: { staleBase?: boolean; updateError?: string; mergeError?: string; armed?: boolean } = {}) {
  vi.resetModules();
  const calls: string[][] = [];
  const exec = vi.fn((_command: string, args: string[]) => {
    if (args[0] === 'pr' && args[1] === 'view') return 'MERGEABLE';
    if (args[0] === 'api' && args[1] === 'repos/fictional/repo/branches/master') return options.staleBase ? 'c'.repeat(40) : BASE;
    calls.push(args);
    if (args[0] === 'api' && args.includes('PUT')) {
      if (options.updateError) throw new Error(options.updateError);
      return '';
    }
    if (args[0] === 'pr' && args[1] === 'edit') return '';
    if (args[0] === 'pr' && args[1] === 'merge') {
      if (options.mergeError) throw new Error(options.mergeError);
      return '';
    }
    throw new Error('Unexpected GitHub command');
  });
  vi.doMock('node:child_process', () => ({ execFileSync: exec }));
  vi.doMock('../src/pr-comment.js', () => ({
    loadSavedResults: () => [{ verb: 'review-gate', body: { judgment: { verdict: 'auto-ok' } } }],
  }));
  vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, json: async () => ({ cells: [] }) })));
  vi.spyOn(process, 'argv', 'get').mockReturnValue([
    'node', 'auto-merge.ts', '--pr', '42', '--repo', 'fictional/repo', '--dir', 'unused',
    '--calibration-url', 'https://example.test/calibration', '--base-sha', BASE, '--head-sha', HEAD,
    '--armed', options.armed === false ? 'false' : 'true', '--token-present', 'true',
    '--selection-result', 'success', '--suite-result', 'success', '--checks-result', 'success',
  ]);
  const log = vi.spyOn(console, 'log').mockImplementation(() => {});
  const error = vi.spyOn(console, 'error').mockImplementation(() => {});
  const exit = vi.spyOn(process, 'exit').mockImplementation((() => undefined) as never);
  await import('../bin/auto-merge.js');
  await vi.waitFor(() => expect(log).toHaveBeenCalledWith(expect.stringContaining('gated auto-merge for')));
  return { calls, log, error, exit };
}

describe('the automatic driver uses the tested head for every branch effect', () => {
  it('updates a moved base only while the tested head still holds', async () => {
    const r = await run({ staleBase: true });
    expect(r.calls).toEqual([update]);
    expect(r.log).toHaveBeenCalledWith(expect.stringContaining('the branch was updated with master'));
    expect(r.exit).not.toHaveBeenCalled();
  });

  it('stops on a stale-head refusal with no retry, label or merge', async () => {
    const r = await run({ staleBase: true, updateError: 'HTTP 422: expected head changed' });
    expect(r.calls).toEqual([update]);
    expect(r.log).toHaveBeenCalledWith(expect.stringContaining('could not be updated: HTTP 422: expected head changed'));
    expect(r.exit).not.toHaveBeenCalled();
  });

  it('retains unrelated validation diagnostics', async () => {
    const r = await run({ staleBase: true, updateError: 'HTTP 422: unrelated branch validation' });
    expect(r.calls).toEqual([update]);
    expect(r.log).toHaveBeenCalledWith(expect.stringContaining('HTTP 422: unrelated branch validation'));
  });

  it('makes no branch effect when unarmed', async () => {
    const r = await run({ staleBase: true, armed: false });
    expect(r.calls).toEqual([]);
  });

  it('pins a successful merge to the tested head', async () => {
    const r = await run();
    expect(r.calls).toEqual([
      ['pr', 'edit', '42', '--repo', 'fictional/repo', '--add-label', 'jev-harness:auto-merged'],
      ['pr', 'merge', '42', '--repo', 'fictional/repo', '--merge', '--match-head-commit', HEAD],
    ]);
  });

  it('removes the label after a stale-head merge refusal', async () => {
    const r = await run({ mergeError: 'head changed' });
    expect(r.calls).toHaveLength(3);
    expect(r.calls[2]).toEqual(['pr', 'edit', '42', '--repo', 'fictional/repo', '--remove-label', 'jev-harness:auto-merged']);
    expect(r.error).toHaveBeenCalledWith(expect.stringContaining('merge command failed'));
    expect(r.exit).toHaveBeenCalledWith(1);
  });
});
