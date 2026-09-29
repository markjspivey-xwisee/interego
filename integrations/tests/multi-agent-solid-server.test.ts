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
 * Codex, on #568, found two more things, and this holds both:
 * - On Unix, SIGTERM to npx ended npm's shell and left the server running. The server now runs in
 *   its own process group, and the whole group is stopped.
 * - Omitting groundTruth on an Asserted claim is not "implied true". The serializer then writes no
 *   iep:groundTruth, and iep-shapes.ttl refuses that. The demos' facets must say it.
 *
 * Codex, on #570, then found descriptors whose provenance named no generating agent, so
 * AgentProvenanceConsistencyShape warned and `conforms` was false.
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
  solidServerSpawnOptions,
  stopSolidServer,
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

  // Modal status and ground truth must agree (spec/architecture.md §5.2.2, iep-shapes.ttl). The
  // builder accepts an omitted groundTruth on an Asserted claim, but the serializer then writes no
  // iep:groundTruth, and the shape refuses that, so the facets themselves must say it.
  it.each(['run.ts', 'tla-demo.ts', 'team-demo.ts'])('%s gives every semiotic facet the ground truth its modal status requires', file => {
    const source = readFileSync(join(DIR, file), 'utf8');
    const facets = [...source.matchAll(/\.semiotic\(\{([\s\S]*?)\}\)/g)].map(m => m[1] ?? '');
    expect(facets.length, `${file} has no .semiotic({ … }) facets; the scan is broken`).toBeGreaterThan(0);
    for (const body of facets) {
      const code = body.replace(/\/\/[^\n]*/g, '');
      const modal = /modalStatus:\s*'(\w+)'/.exec(code)?.[1];
      const truth = /groundTruth:\s*(true|false)/.exec(code)?.[1];
      const want = modal === 'Asserted' ? 'true' : modal === 'Counterfactual' ? 'false' : undefined;
      expect(truth, `${file}: a ${modal} facet`).toBe(want);
    }
  });
});

describe('the descriptors the scripts build', () => {
  // iep-shapes.ttl: a ContextDescriptor has exactly one ProvenanceFacet and one AgentFacet. The
  // update in run.ts had neither, and its published v2 failed the shapes (2026-09-29).
  it.each(['run.ts', 'tla-demo.ts', 'team-demo.ts'])('%s gives every descriptor one provenance facet and one agent facet', file => {
    const source = readFileSync(join(DIR, file), 'utf8');
    const chains = [...source.matchAll(/ContextDescriptor\.create\(([\s\S]*?)\.build\(\)/g)].map(m => m[1] ?? '');
    expect(chains.length, `${file} builds no descriptor; the scan is broken`).toBeGreaterThan(0);
    for (const chain of chains) {
      const id = /'([^']+)'/.exec(chain)?.[1];
      expect(chain.match(/^\.provenance\(/gm)?.length, `${file}: ${id} provenance facets`).toBe(1);
      expect(chain.match(/^\.agent\(/gm)?.length, `${file}: ${id} agent facets`).toBe(1);
    }
  });

  // AgentProvenanceConsistencyShape compares the agent facet's identity with the agent of the
  // provenance's generating activity. A provenance facet with no activity compares nothing against
  // it, which is a Warning, and a Warning makes `conforms` false (Codex, on #570). Naming a
  // different agent is a ghost-write, which the shape's own message allows, so the rule here is
  // only that every descriptor names who generated it.
  it.each(['run.ts', 'tla-demo.ts', 'team-demo.ts'])('%s names who generated every descriptor', file => {
    const source = readFileSync(join(DIR, file), 'utf8');
    const chains = [...source.matchAll(/ContextDescriptor\.create\(([\s\S]*?)\.build\(\)/g)].map(m => m[1] ?? '');
    expect(chains.length, `${file} builds no descriptor; the scan is broken`).toBeGreaterThan(0);
    for (const chain of chains) {
      const id = /'([^']+)'/.exec(chain)?.[1];
      const provenance = /^\.provenance\(\{([\s\S]*?)^\s*\}\)/m.exec(chain)?.[1] ?? '';
      expect(provenance, `${file}: ${id} has no provenance facet`).not.toBe('');
      expect(provenance, `${file}: ${id} names no generating agent`).toMatch(/wasGeneratedBy:\s*\{[\s\S]*?\bagent:/);
    }
  });
});

describe('stopping the server', () => {
  const running = { pid: 4242, exitCode: null, signalCode: null, kill: () => true };

  it('spawns it behind a shell on Windows, and as its own process group elsewhere', () => {
    expect(solidServerSpawnOptions('win32')).toEqual({ shell: true, detached: false });
    expect(solidServerSpawnOptions('linux')).toEqual({ shell: false, detached: true });
    expect(solidServerSpawnOptions('darwin')).toEqual({ shell: false, detached: true });
  });

  it('ends the whole process group on Unix, not only npx (Codex, on #568)', () => {
    const signals: Array<[number, string]> = [];
    const runs: string[][] = [];
    stopSolidServer({ ...running }, 'linux', (pid, sig) => { signals.push([pid, sig]); }, (cmd, args) => { runs.push([cmd, ...args]); });
    expect(signals).toEqual([[-4242, 'SIGTERM']]);
    expect(runs).toEqual([]);
  });

  it('ends the whole process tree on Windows', () => {
    const runs: string[][] = [];
    stopSolidServer({ ...running }, 'win32', () => { throw new Error('no signals on Windows'); }, (cmd, args) => { runs.push([cmd, ...args]); });
    expect(runs).toEqual([['taskkill', '/pid', '4242', '/T', '/F']]);
  });

  it('stops a server once, and leaves one that has already exited alone', () => {
    const signals: number[] = [];
    const proc = { ...running };
    const record = (pid: number): void => { signals.push(pid); };
    stopSolidServer(proc, 'linux', record);
    stopSolidServer(proc, 'linux', record);
    stopSolidServer({ ...running, exitCode: 0 }, 'linux', record);
    expect(signals).toEqual([-4242]);
  });

  it('falls back to the process itself when its group cannot be signalled', () => {
    const killed: string[] = [];
    stopSolidServer({ ...running, kill: (sig?: NodeJS.Signals | number) => { killed.push(String(sig)); return true; } }, 'linux', () => { throw new Error('ESRCH'); });
    expect(killed).toEqual(['SIGTERM']);
  });
});
