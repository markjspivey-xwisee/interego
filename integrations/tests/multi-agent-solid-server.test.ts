/**
 * THE MULTI-AGENT DEMOS START THEIR SOLID SERVER FROM OUTSIDE THE REPOSITORY.
 *
 * Components.js, the server's configuration loader, loads every node_modules from the server's
 * package directory up to the filesystem root. Installed in examples/multi-agent, the server also
 * found the repository root's @comunica 5 beside its own @comunica 2 and could not build its
 * configuration, so run.ts, tla-demo.ts and team-demo.ts all stopped at a startup timeout
 * (2026-09-28). examples/multi-agent/solid-server.ts runs it with npx from a folder outside the
 * repository instead; this holds the scripts to that path.
 *
 * It lives here, not in `tests/`, because it reads `examples/`, which the base runs without.
 */

import { readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  SOLID_SERVER_PACKAGE,
  SOLID_SERVER_WORKDIR,
  isInside,
  solidServerLaunch,
} from '../../examples/multi-agent/solid-server.js';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const DIR = join(ROOT, 'examples', 'multi-agent');
const launchOptions = { config: join(DIR, 'css-config.json'), port: 3456, baseUrl: 'http://localhost:3456/' };

describe('the Solid server launch', () => {
  it('runs npx from a folder outside the repository, with its pods beneath that folder', () => {
    const launch = solidServerLaunch(launchOptions);
    expect(isInside(launch.cwd, ROOT)).toBe(false);
    expect(launch.cwd).toBe(SOLID_SERVER_WORKDIR);
    expect(isInside(launch.cwd, tmpdir())).toBe(true);
    expect(isInside(launch.podsDir, launch.cwd)).toBe(true);
    expect(launch.command).toBe('npx');
    expect(launch.args).toEqual([
      '--yes', SOLID_SERVER_PACKAGE,
      '-c', launchOptions.config,
      '-p', '3456',
      '-l', 'warn',
      '--baseUrl', 'http://localhost:3456/',
      '-f', launch.podsDir,
    ]);
  });

  it('refuses to run the server from inside the repository', () => {
    expect(() => solidServerLaunch({ ...launchOptions, workDir: DIR })).toThrow(/outside the repository/);
    expect(() => solidServerLaunch({ ...launchOptions, workDir: ROOT })).toThrow(/outside the repository/);
  });

  it('tells inside from outside by path, not by prefix', () => {
    expect(isInside(join(ROOT, 'examples'), ROOT)).toBe(true);
    expect(isInside(`${ROOT}-sibling`, ROOT)).toBe(false);
    expect(isInside(dirname(ROOT), ROOT)).toBe(false);
  });
});

describe('the multi-agent scripts', () => {
  it.each(['run.ts', 'tla-demo.ts', 'team-demo.ts'])('%s starts and stops the server only through solid-server.ts', file => {
    const source = readFileSync(join(DIR, file), 'utf8');
    expect(source).toContain("import { startSolidServer, stopSolidServer } from './solid-server.js';");
    expect(source).toMatch(/return startSolidServer\(\{ config: CSS_CONFIG, port: CSS_PORT, baseUrl: BASE_URL,/);
    expect(source).toContain('stopSolidServer(cssProc);');
    expect(source).not.toContain('node_modules/.bin/community-solid-server');
    expect(source).not.toMatch(/\bspawn\(/);
  });

  it('no longer install a server of their own', () => {
    const pkg = JSON.parse(readFileSync(join(DIR, 'package.json'), 'utf8')) as { dependencies?: Record<string, string> };
    expect(Object.keys(pkg.dependencies ?? {})).not.toContain('@solid/community-server');
  });
});
