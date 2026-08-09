/**
 * The one thing in this repository that is allowed to turn a red pin green.
 *
 * `refineFreshness` rewrites a `BEHIND` row to `equivalent` when the commits it is behind
 * touch nothing the service copies into its image. That is the difference between an
 * audit that can pass and one that is red on every merge — but it is also, structurally,
 * a false-green generator if it is wrong in the permissive direction, on the single axis
 * that says whether production is running the code that was merged.
 *
 * So every test below is about the DIRECTION of a mistake. The verdict may only ever be
 * wrong towards "still behind".
 *
 * ★ THE BUG THIS SUITE WAS WRITTEN AFTER, because it is exactly the shape to expect
 * again. `tracked()` began as `existsSync(path) || git ls-tree …`. `interego-css-pgsl`
 * copies `packages/pgsl-store/dist`, which is GITIGNORED and produced by the build matrix
 * leg's own `prebuild` step — but the directory was on the machine because `npm run
 * build` had run, so the untracked-source guard passed, `git diff -- .../dist` matched
 * nothing, and every change under `packages/pgsl-store/src` became invisible. The service
 * stayed red only because three unrelated config files happened to have changed in the
 * same window. Measured, in this file's first live run.
 */
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { copySources, matrixDockerfiles, bundlePathsFor, refineFreshness } from '../tools/deploy-bundle-scope.js';
import type { PinRow } from '../tools/railway-pins.mjs';
import { hasDisagreement } from '../tools/railway-pins.mjs';
import { SERVICES } from '../tools/railway-services.mjs';

const SHA = 'a'.repeat(40);

function behindRow(over: Partial<PinRow> = {}): PinRow {
  return {
    service: 'relay',
    tag: SHA,
    tagKind: 'sha',
    agreement: 'ok',
    freshness: 'BEHIND',
    behind: 7,
    deployAgreement: 'ok',
    limitVerdict: 'none',
    numReplicas: null,
    overlapSeconds: null,
    drainingSeconds: null,
    ...over,
  };
}

describe('copySources — what a Dockerfile puts in its image', () => {
  it('reads plain COPY sources and drops the destination', () => {
    const r = copySources('FROM node\nCOPY packages/ ./packages/\nCOPY a.ts b.ts /app/\n');
    expect(r.confident).toBe(true);
    expect(r.paths).toEqual(['packages', 'a.ts', 'b.ts']);
  });

  it('skips COPY --from=<stage>, which names a path inside an image, not the context', () => {
    // 29 of the fleet's 258 COPY lines are this form. Counting them would resolve to
    // nothing and fail every service closed, which is safe but useless.
    const r = copySources('FROM node AS b\nCOPY src/ ./src/\nFROM node\nCOPY --from=b /app/dist /usr/share/html\n');
    expect(r.confident).toBe(true);
    expect(r.paths).toEqual(['src']);
  });

  it('tolerates --chown/--chmod, which change ownership rather than what is copied', () => {
    const r = copySources('COPY --chown=1000:1000 site/ /var/www/\n');
    expect(r).toMatchObject({ confident: true, paths: ['site'] });
  });

  // ★ Each of these is a way to be UNSURE, and each must answer "unsure" rather than
  // silently narrowing the path set — a dropped COPY is a path whose changes go unseen.
  it.each([
    ['an unrecognised flag', 'COPY --parents a/b /app/'],
    ['a glob', 'COPY packages/*/dist /app/'],
    ['the whole build context', 'COPY . /app/'],
    ['a bare dot source', 'COPY ./ /app/'],
    ['a COPY with no destination', 'COPY onlyone'],
    ['no context COPY at all', 'FROM node\nRUN echo hi\nCOPY --from=b /x /y'],
    ['the JSON-array form', 'COPY ["a b.ts", "/app/"]'],
    ['an ADD, which copies into the image just as COPY does', 'ADD packages/ ./packages/\nCOPY x ./'],
  ])('fails closed on %s', (_name, dockerfile) => {
    const r = copySources(dockerfile);
    expect(r.confident).toBe(false);
    expect(r.reason).toBeTruthy();
  });

  // ★ THE REFUTED CASE. The line-based first version read `COPY packages/ \` as complete,
  // took the backslash for the destination, kept `packages` and DROPPED the rest — while
  // answering `confident: true`. The exact inverse of this file's contract, and latent
  // only because no Dockerfile here uses the form yet.
  it('★ reads every source of a multi-line COPY instead of dropping the continuations', () => {
    const r = copySources('FROM node\nCOPY packages/ \\\n     scripts/ \\\n     docs/ns/ ./dst/\n');
    expect(r.confident).toBe(true);
    expect(r.paths).toEqual(['packages', 'scripts', 'docs/ns']);
  });

  // ★ THE BUG THE PREVIOUS FIX INTRODUCED, found by re-running the same adversarial review
  // against the fixed version. Joining continuations BEFORE stripping comments lets a `#`
  // line ending in a backslash splice itself onto the next instruction, which then no
  // longer starts with COPY — so the source vanishes, with `confident: true`. Docker strips
  // comments first, so a `#` line never continues. One silent drop traded for another.
  it('★ a comment line ending in a backslash does not swallow the COPY beneath it', () => {
    const r = copySources('FROM node\n# see docs/foo \\\nCOPY packages/ ./packages/\nCOPY x.txt ./\n');
    expect(r.confident).toBe(true);
    expect(r.paths).toEqual(['packages', 'x.txt']);
  });

  it('★ and it cannot swallow an ADD refusal either', () => {
    const r = copySources('FROM node\n# note \\\nADD packages/ ./packages/\nCOPY x.txt ./\n');
    expect(r.confident).toBe(false);
    expect(r.reason).toMatch(/ADD/);
  });

  it('parses the real Dockerfiles whose RUN blocks are full of continued # lines', () => {
    // acme-id and foxxi-scorm-player write their entire nginx server block as a continued
    // `RUN printf`, with ~50 interior lines that trim to `#` and end in `\`. They are the
    // files most likely to trip the comment/continuation interaction, so they are parsed
    // for real rather than by fixture.
    for (const service of ['acme-id', 'foxxi-scorm-player']) {
      const r = bundlePathsFor(service);
      expect(r.confident, `${service}: ${r.reason ?? ''}`).toBe(true);
      expect(r.paths).toContain(`deploy/${service}/site`);
    }
  });
});

describe('matrixDockerfiles — image to Dockerfile, read from the build matrix', () => {
  it('parses legs with and without trailing build_args/prebuild', () => {
    const m = matrixDockerfiles([
      '          - { image: interego-relay,     dockerfile: deploy/Dockerfile.relay }',
      '          - { image: interego-microsite, dockerfile: deploy/Dockerfile.m, build_args: "A=b" }',
      '          - { image: interego-css-pgsl,  dockerfile: integrations/pgsl-css-accessor/Dockerfile, prebuild: pgsl-store }',
    ].join('\n'));
    expect(m.get('interego-relay')).toBe('deploy/Dockerfile.relay');
    expect(m.get('interego-microsite')).toBe('deploy/Dockerfile.m');
    expect(m.get('interego-css-pgsl')).toBe('integrations/pgsl-css-accessor/Dockerfile');
  });

  // ★ REFUTED CASE. `matchAll` over the whole file with `Map.set` makes the LAST match
  // win and never skipped `#`. A stale commented-out leg below the live one silently
  // redirected the comparison to the wrong Dockerfile — a confident answer from the wrong
  // file, worse than a refusal. build-ghcr.yml is heavily commented in this exact style.
  it('★ ignores a commented-out leg rather than letting it shadow the live one', () => {
    const m = matrixDockerfiles([
      '          - { image: interego-relay, dockerfile: deploy/Dockerfile.relay }',
      '          # - { image: interego-relay, dockerfile: deploy/Dockerfile.OLD }',
    ].join('\n'));
    expect(m.get('interego-relay')).toBe('deploy/Dockerfile.relay');
  });

  it('reads the real workflow and resolves a leg for EVERY image the fleet declares', () => {
    // Not a fixture: if a leg is renamed and this mapping goes stale, every service it
    // feeds silently loses its bundle comparison and stays BEHIND forever — safe, but a
    // permanent red is the failure mode this whole change exists to remove.
    //
    // ★ This assertion used to be `m.size >= 15`, which tolerated exactly the dropped leg
    // its own comment warned about. Every image SERVICES names must resolve, by name.
    const m = matrixDockerfiles();
    const built = Object.values(SERVICES)
      .map((s) => s.repo)
      .filter((r): r is string => typeof r === 'string' && r.startsWith('interego-'));
    expect(built.length).toBeGreaterThan(0);
    for (const image of built) {
      expect(m.get(image), `build-ghcr.yml has no matrix leg for ${image}`).toBeTruthy();
    }
    expect(m.get('interego-relay')).toBe('deploy/Dockerfile.relay');
  });
});

describe('bundlePathsFor — against the real repository', () => {
  it('resolves the relay to its own per-file COPY list plus packages/', () => {
    const r = bundlePathsFor('relay');
    expect(r.confident).toBe(true);
    expect(r.paths).toContain('packages');
    expect(r.paths).toContain('deploy/mcp-relay/server.ts');
    // ★ Notably NOT tools/ or tests/ — the paths whose change turned all sixteen rows red
    // and prompted this file.
    expect(r.paths).not.toContain('tools');
    expect(r.paths).not.toContain('tests');
  });

  // ★ THE REFUTED CLASS, and the worst of them: the three files that most directly decide
  // an image's content are the three no COPY line can ever name. An adversarial review of
  // the first version broke it with eight real commits — a relay base-image bump that
  // fixed a crash at import (7242353), an acme-id nginx fix for a Location: header
  // leaking the internal port (d29ffc8), a build_args change deciding which bridge URL
  // three Vite SPAs compile against (0e8ae02), and a .dockerignore fix (857c536). Every
  // one had an empty in-scope diff and was waved through as `equivalent`.
  it.each(['relay', 'acme-id', 'foxxi-scorm-player', 'main', 'identity'])(
    '★ %s carries its OWN Dockerfile, the build workflow, .dockerignore and .gitattributes', (service) => {
      const r = bundlePathsFor(service);
      expect(r.confident).toBe(true);
      expect(r.paths).toContain('.github/workflows/build-ghcr.yml');
      expect(r.paths).toContain('.dockerignore');
      expect(r.paths).toContain('.gitattributes');
      // ★ Its OWN, by name from the matrix. `paths.some(p => /Dockerfile/.test(p))` — what
      // this asserted first — is satisfied by an implementation that pushes one hardcoded
      // Dockerfile for every service, which is precisely the bug worth catching here.
      const image = SERVICES[service]?.repo;
      expect(image).toBeTruthy();
      const own = matrixDockerfiles().get(image as string);
      expect(own).toBeTruthy();
      expect(r.paths).toContain(own);
    });

  it('★ a Dockerfile-only commit is NOT cleared for the service it builds', () => {
    // d29ffc8 changed only deploy/Dockerfile.acme-id — adding `absolute_redirect off` to
    // an nginx block that lives entirely inside a RUN, fixing a Location: header that
    // leaked the internal port. acme-id's only COPY source is deploy/acme-id/site, so
    // before the Dockerfile went into scope this was the emptiest possible diff, and the
    // security fix was waved through as `equivalent`.
    const before = execFileSync('git', ['rev-parse', 'd29ffc8^'], { encoding: 'utf8' }).trim();
    expect(execFileSync('git', ['show', '--name-only', '--format=', 'd29ffc8'], { encoding: 'utf8' }))
      .toMatch(/Dockerfile\.acme-id/);

    // ★ Through refineFreshness, the function that actually decides — not a diff
    // re-implemented inline here, which would assert about git rather than about the tool.
    const out = refineFreshness({
      service: 'acme-id', tag: before, tagKind: 'sha', agreement: 'ok',
      freshness: 'BEHIND', behind: 1, deployAgreement: 'ok', limitVerdict: 'none',
      numReplicas: null, overlapSeconds: null, drainingSeconds: null,
    });
    expect(out.freshness).toBe('BEHIND');
    expect(out.bundleChanged).toContain('deploy/Dockerfile.acme-id');
    expect(hasDisagreement([out])).toBe(true);
  });

  it('★ refuses css, whose Dockerfile copies a gitignored build artifact', () => {
    // packages/pgsl-store/dist is produced by the matrix leg's `prebuild` step. Its
    // SOURCES cannot be identified from the Dockerfile, so no honest diff exists — and
    // this must be a refusal even when a local `npm run build` has left the directory on
    // disk, which is precisely the false green this suite was written after.
    const r = bundlePathsFor('css');
    expect(r.confident).toBe(false);
    expect(r.reason).toMatch(/pgsl-store\/dist/);
    expect(r.reason).toMatch(/does not track/);
  });

  it('refuses a service with no matrix leg', () => {
    expect(bundlePathsFor('postgres').confident).toBe(false);
    expect(bundlePathsFor('no-such-service').confident).toBe(false);
  });
});

describe('refineFreshness — may only ever downgrade, and only on certainty', () => {
  it('leaves a non-BEHIND row exactly as it found it', () => {
    for (const freshness of ['current', 'n/a', 'UNCHECKED']) {
      const row = behindRow({ freshness });
      expect(refineFreshness(row).freshness).toBe(freshness);
    }
  });

  // ★ THE LOAD-BEARING REFUSAL. Both states mean the pin's place in history could not be
  // established, so a diff computed from it is not evidence. A shallow checkout produces
  // one and a rewritten history the other — the moments a confident answer is worth least.
  it.each(['DIVERGED', 'UNKNOWN-COMMIT'])('never downgrades %s, however clean the diff looks', (freshness) => {
    const row = behindRow({ service: 'acme-id', freshness });
    const out = refineFreshness(row);
    expect(out.freshness).toBe(freshness);
    expect(hasDisagreement([out])).toBe(true);
  });

  it('does not downgrade a row whose tag is not a 40-hex commit', () => {
    // A mutable tag cannot identify the running code at all, so there is nothing to diff.
    const row = behindRow({ tag: 'latest', tagKind: 'mutable' });
    expect(refineFreshness(row).freshness).toBe('BEHIND');
  });

  it('does not downgrade when the bundle cannot be resolved', () => {
    const row = behindRow({ service: 'css', tag: SHA });
    const out = refineFreshness(row);
    expect(out.freshness).toBe('BEHIND');
    expect(out.bundleReason).toMatch(/does not track/);
    expect(hasDisagreement([out])).toBe(true);
  });

  it('does not downgrade on a commit this clone has never seen', () => {
    // git diff against an unknown sha fails, which must reach the caller as "not
    // confident" rather than as an empty changed-file list that looks like agreement.
    const out = refineFreshness(behindRow({ service: 'acme-id', tag: 'b'.repeat(40) }));
    expect(out.freshness).toBe('BEHIND');
    expect(out.bundleReason).toBeTruthy();
  });

  it('★ DOES downgrade a real service against a real ancestor that changed nothing it ships', () => {
    // The passing leg, end to end against this repository: matrix lookup → Dockerfile
    // parse → tracked-path check → git diff.
    //
    // ★ The ancestor is SEARCHED FOR, not hardcoded as HEAD~1. Pinning it to HEAD~1 made
    // the verdict a property of whatever the tip commit happened to touch, so this test
    // would go red on any commit editing build-ghcr.yml, .dockerignore, .gitattributes or
    // Dockerfile.acme-id — all newly in acme-id's scope. A test whose pass depends on
    // unrelated commit content is not testing the tool.
    const scope = bundlePathsFor('acme-id');
    expect(scope.confident).toBe(true);

    const log = execFileSync('git', ['log', '-40', '--format=%H'], { encoding: 'utf8' })
      .split('\n').map((s) => s.trim()).filter(Boolean);
    const clean = log.slice(1).find((sha) => execFileSync(
      'git', ['diff', '--name-only', `${sha}..HEAD`, '--', ...scope.paths], { encoding: 'utf8' }).trim() === '');
    expect(clean, 'no ancestor within 40 commits leaves acme-id\'s scope untouched').toBeTruthy();

    const out = refineFreshness(behindRow({ service: 'acme-id', tag: clean as string }));
    expect(out.freshness).toBe('equivalent');
    expect(out.bundleChanged).toEqual([]);
    expect(hasDisagreement([out])).toBe(false);

    // ★ THE CONTROL, and it runs unconditionally. The range must be non-empty OVERALL, or
    // the emptiness above came from comparing a commit with itself rather than from the
    // pathspec, and the assertion would pass against a tool that never ran a diff at all.
    const whole = execFileSync('git', ['diff', '--name-only', `${clean as string}..HEAD`], { encoding: 'utf8' })
      .split('\n').filter(Boolean);
    expect(whole.length).toBeGreaterThan(0);
  });

  it('★ the same ancestor does NOT clear a service that ships the changed paths', () => {
    // The other half of the control: a commit range that is clean for acme-id must be
    // dirty for a service whose scope contains the files it touched. Constructed from a
    // commit that really did change packages/, so it cannot silently not run.
    const sha = execFileSync('git', ['log', '-1', '--format=%H', '--', 'packages/'], { encoding: 'utf8' }).trim();
    const parent = execFileSync('git', ['rev-parse', `${sha}^`], { encoding: 'utf8' }).trim();
    const out = refineFreshness(behindRow({ service: 'relay', tag: parent }));
    expect(out.freshness).toBe('BEHIND');
    expect((out.bundleChanged ?? []).some((f) => f.startsWith('packages/'))).toBe(true);
  });

  it('refuses when pointed at a directory that is not this repository', () => {
    // Threads `root` all the way through — matrix read, Dockerfile read and git diff must
    // all use it, or the tool mixes two checkouts and answers confidently about neither.
    const out = refineFreshness(behindRow({ service: 'relay' }), join(tmpdir(), 'definitely-not-a-repo-xyz'));
    expect(out.freshness).toBe('BEHIND');
    expect(out.bundleReason).toBeTruthy();
  });

  it('★ a downgraded row satisfies the untouched fleet predicate', () => {
    // `equivalent` is in none of hasDisagreement's lists, which is the whole mechanism:
    // no rule in railway-pins.mjs changed, and no second copy of it exists here.
    const row = { ...behindRow(), freshness: 'equivalent' };
    expect(hasDisagreement([row])).toBe(false);
    // …and every other axis still bites on a downgraded row, so the downgrade cannot
    // launder an unrelated fault.
    expect(hasDisagreement([{ ...row, agreement: 'MISMATCH' }])).toBe(true);
    expect(hasDisagreement([{ ...row, deployAgreement: 'STALE-DEPLOY' }])).toBe(true);
    expect(hasDisagreement([{ ...row, limitVerdict: 'BELOW-FLOOR' }])).toBe(true);
    expect(hasDisagreement([{ ...row, service: 'css', numReplicas: null }])).toBe(true);
  });
});
