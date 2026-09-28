/**
 * WHAT THE "BASE WITHOUT VERTICALS" JOB RUNS IS DERIVED, AND WHAT IT LEAVES OUT IS COUNTED (#366).
 *
 * `.github/workflows/base-without-verticals.yml` deletes `applications/`, `integrations/` and
 * `examples/` and runs the base's build, typecheck and tests. Which tests are base comes from
 * `tools/base-without-verticals.mjs`, which classifies each test module by its closure: an import
 * of, or a string naming, a path in those trees — or a package published from them — makes it an
 * integration test that happens to live in a base directory. This pins the classifier's rules and
 * the count it leaves out, so a new domain-heavy fixture in the base's own suite fails here, in
 * the ordinary suite, and not only in the job that deletes things.
 */

import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { ROOT, baseTestSet, judgeReaching, reachesVertical, relaySteps } from '../tools/base-without-verticals.mjs';

describe('the classifier', () => {
  const dir = mkdtempSync(join(ROOT, 'tests', '.classifier-'));
  const write = (name: string, body: string): string => {
    const file = join(dir, name);
    writeFileSync(file, body);
    return file;
  };

  it('counts an import of, or a string rooted at, a removed tree — and nothing else', () => {
    try {
      expect(reachesVertical(write('a.test.ts', "import x from '../../applications/foo/x.js';\n"))).toMatch(/names/);
      expect(reachesVertical(write('b.test.ts', "const p = join(root, 'integrations', 'x');\n"))).toMatch(/integrations/);
      expect(reachesVertical(write('c.test.ts', "const g = 'examples/**/*.ts';\n"))).toMatch(/examples/);
      // An IRI's path and a docs path are not the trees the job deletes.
      expect(reachesVertical(write('d.test.ts', "const ns = 'https://example.org/interego/applications/x#';\nconst d = '../docs/applications/x.html';\n"))).toBeUndefined();
      // Through a test-side helper, too.
      mkdirSync(join(dir, 'fixtures'), { recursive: true });
      writeFileSync(join(dir, 'fixtures', 'helper.ts'), "export const where = '../../examples/app/store.js';\n");
      expect(reachesVertical(write('e.test.ts', "import { where } from './fixtures/helper.js';\n"))).toMatch(/helper\.ts names/);
      // A package published outside the base.
      expect(reachesVertical(write('f.test.ts', "import '@interego/workspace-client';\n"))).toMatch(/outside the base/);
      expect(reachesVertical(write('g.test.ts', "import { sha256 } from '@interego/core';\n"))).toBeUndefined();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('the plan', () => {
  const set = baseTestSet();

  it('leaves out exactly the pinned number of tests that reach a vertical', () => {
    expect(judgeReaching(set)).toEqual([]);
  });

  it('classifies known cases the way they are', () => {
    // A substrate test with no vertical anywhere in its closure is base…
    expect(set.vitest).toContain('tests/a-rebuild-scans-the-containers-its-caller-names.test.ts');
    // …one that imports a vertical's module is not, and says why…
    expect(set.reachingVitest.find(t => t.file === 'tests/competency-identity.test.ts')?.why).toMatch(/applications/);
    // …and one that reads an example's rule pack through a shared fixture is not either.
    expect(set.reachingVitest.find(t => t.file === 'tests/client-interactions.test.ts')?.why).toMatch(/examples/);
  });

  it('runs the relay\'s typechecks and its own scripts, and leaves out the ones that read a vertical\'s source', () => {
    const steps = relaySteps();
    expect(steps).toContain('tsc --noEmit -p tsconfig.json');
    expect(set.relay).toContain('tsc --noEmit -p tsconfig.json');
    expect(set.relay).toContain('tsx tests/tool-surface.test.ts');
    expect(set.reachingRelay.map(r => r.step)).toContain('tsx tests/listen-loopback.test.ts');
    expect(set.relay.length + set.reachingRelay.length).toBe(steps.length);
    // The relay's test program compiles more than `npm test` runs (a Playwright spec that imports the
    // application runtime); the base typechecks a derived program without those files.
    expect(set.relay).toContain('tsc --noEmit -p .base-without-verticals.tests.tsconfig.json');
    expect(set.relay).not.toContain('tsc --noEmit -p tsconfig.tests.json');
    expect(set.reachingProgram.map(r => r.file)).toContain('tests/passkey-oauth.spec.ts');
    // …and a script that RUNS that spec (Playwright's collection) reaches a vertical through it,
    // though it imports nothing vertical itself. The first run without the trees found this one.
    expect(set.reachingRelay.find(r => r.step === 'tsx tests/e2e-collection.test.ts')?.why).toMatch(/passkey-oauth.spec.ts/);
  });

  it('holds the judgement to both directions', () => {
    const one = { reachingVitest: [{ file: 'x', why: 'y' }], reachingRelay: [], reachingProgram: [] };
    expect(judgeReaching(one, { vitest: 0, relay: 0, program: 0 })[0]).toMatch(/belongs in the vertical/);
    expect(judgeReaching(one, { vitest: 2, relay: 0, program: 0 })[0]).toMatch(/Lower the pin/);
    expect(judgeReaching(one, { vitest: 1, relay: 0, program: 0 })).toEqual([]);
  });
});
