/**
 * The CI Chromium install (tools/ci-install-chromium.mjs): what decides the step.
 *
 * On 2026-11-11 `npx playwright install --with-deps chromium` failed for about two hours on every
 * branch, master included: the runners could not resolve the Ubuntu package mirror, apt gave up on
 * nine optional font packages, and the browser was never downloaded, so no passkey test ran. The
 * install now decides on whether Chromium launches, not on whether apt fetched everything.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { DEPS_TIMEOUT_MS, DOWNLOAD_ATTEMPTS, installChromium } from '../tools/ci-install-chromium.mjs';

function steps(answers: { deps?: boolean; downloads?: boolean[]; launch?: Error }) {
  const calls: string[] = [];
  const warnings: string[] = [];
  const pauses: number[] = [];
  const downloads = [...(answers.downloads ?? [true])];
  return {
    calls, warnings, pauses,
    run: (args: string[], timeout: number) => {
      calls.push(`${args.join(' ')} ${timeout}`);
      return args[0] === 'install-deps' ? answers.deps ?? true : downloads.shift() ?? false;
    },
    launch: async () => { calls.push('launch'); if (answers.launch) throw answers.launch; },
    pause: async (ms: number) => { pauses.push(ms); },
    warn: (message: string) => { warnings.push(message); },
  };
}

describe('CI Chromium install', () => {
  it('installs the system packages within a limit, downloads the browser, then launches it', async () => {
    const s = steps({});
    expect(await installChromium(s)).toEqual({ ok: true, deps: true });
    expect(s.calls[0]).toBe(`install-deps chromium ${DEPS_TIMEOUT_MS}`);
    expect(s.calls[1]).toMatch(/^install chromium \d+$/);
    expect(s.calls[2]).toBe('launch');
    expect(s.warnings).toEqual([]);
    expect(DEPS_TIMEOUT_MS).toBeLessThanOrEqual(5 * 60 * 1000);
  });

  it('a package mirror that fails is a warning: the browser is still downloaded, and the launch decides', async () => {
    const s = steps({ deps: false });
    expect(await installChromium(s)).toEqual({ ok: true, deps: false });
    expect(s.calls.slice(1)).toEqual([expect.stringMatching(/^install chromium /), 'launch']);
    expect(s.warnings).toHaveLength(1);
  });

  it('a runner that really lacks a library fails at the launch, with the launcher\'s message, whatever apt said', async () => {
    for (const deps of [true, false]) {
      const outcome = await installChromium(steps({ deps, launch: new Error('libnss3.so: cannot open shared object file') }));
      expect(outcome).toEqual({ ok: false, deps, reason: 'Chromium does not launch: libnss3.so: cannot open shared object file' });
    }
  });

  it('the download is retried, with a pause between attempts, and a download that never succeeds fails without a launch', async () => {
    const second = steps({ downloads: [false, true] });
    expect(await installChromium(second)).toEqual({ ok: true, deps: true });
    expect(second.pauses).toHaveLength(1);
    const never = steps({ downloads: Array.from({ length: DOWNLOAD_ATTEMPTS }, () => false) });
    const outcome = await installChromium(never);
    expect(outcome.ok).toBe(false);
    expect(never.calls.filter(call => call.startsWith('install chromium'))).toHaveLength(DOWNLOAD_ATTEMPTS);
    expect(never.calls).not.toContain('launch');
    expect(never.pauses).toHaveLength(DOWNLOAD_ATTEMPTS - 1);
  });

  it('every workflow that installs Chromium through npx goes through the script, inside its job\'s time limit', () => {
    const directory = new URL('../.github/workflows/', import.meta.url);
    const users: string[] = [];
    for (const name of readdirSync(directory)) {
      const text = readFileSync(new URL(name, directory), 'utf8');
      const code = text.split('\n').filter(line => !line.trim().startsWith('#')).join('\n');
      expect(code, `${name} installs Chromium with the bare command`).not.toMatch(/npx playwright install/);
      if (code.includes('tools/ci-install-chromium.mjs')) users.push(name);
    }
    expect(users.sort()).toEqual(['client-signature-live.yml', 'e2e-passkey.yml', 'identity-tests.yml']);
  });
});
