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
 *
 * ── AND WHAT THE REFUSAL THAT REPLACED IT COST ───────────────────────────────
 *
 * Failing css closed was safe and it was also permanent: with its scope collapsed, its
 * freshness could only ever read `current`, so it went red on every merge that did not
 * touch it at all — and on 2026-08-09 a comment-only merge did exactly that and css was
 * deployed a second time purely to clear the row. The `prebuild:` resolution ends that,
 * and it is the single most dangerous change this file has taken: a scope derived too
 * NARROW reports `equivalent` while a change the service really ships sits undeployed, on
 * the service holding every pod's data.
 *
 * So the tests below are not "the new scope works". They are, in order: the resolution's
 * REFUSALS (every way it must decline rather than guess); the paths an independent
 * reviewer proved it had missed; and a two-directional sweep of REAL history in which the
 * derived scope is checked against an oracle written by hand, so that a scope which
 * quietly narrowed would show up as commits the tool calls clean and the oracle does not.
 */
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  buildArtifactDirs, bundlePathsFor, copySources, matrixDockerfiles, matrixLegs, prebuildInputs,
  prebuildRecipe, producedDirs, refineFreshness, workspaceDirs,
} from '../tools/deploy-bundle-scope.js';
import type { PinRow } from '../tools/railway-pins.mjs';
import { hasDisagreement } from '../tools/railway-pins.mjs';
import { SERVICES } from '../tools/railway-services.mjs';

const SHA = 'a'.repeat(40);
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const WORKFLOW = readFileSync(join(ROOT, '.github/workflows/build-ghcr.yml'), 'utf8');

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

  // ★ THE ADD BUG, ONE KEYWORD ALONG. Found by re-running the review that produced the ADD
  // refusal against the version that had added it: `ONBUILD COPY` matches neither /^COPY/
  // nor /^ADD/, so it was dropped in silence with `confident: true` — the precise thing the
  // ADD case exists to prevent — and `ONBUILD ADD` slipped the ADD refusal the same way.
  it.each([
    ['ONBUILD COPY', 'FROM node\nONBUILD COPY packages/ ./packages/\nCOPY a.ts ./\n'],
    ['ONBUILD ADD', 'FROM node\nONBUILD ADD packages/ ./packages/\nCOPY a.ts ./\n'],
  ])('★ refuses %s rather than dropping it', (_name, dockerfile) => {
    const r = copySources(dockerfile);
    expect(r.confident).toBe(false);
    expect(r.reason).toMatch(/ONBUILD/);
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

describe('prebuildRecipe — a produced directory resolves to what the build actually runs', () => {
  const step = (name: string, gate: string, body: string[]): string => [
    `      - name: ${name}`,
    `        if: steps.gate.outputs.skip != 'true' && matrix.prebuild == '${gate}'`,
    '        run: |',
    ...body.map((l) => `          ${l}`),
  ].join('\n');

  it('reads the workspaces the gated step builds, and that it installs from the lockfile', () => {
    const r = prebuildRecipe('widget', step('Build it', 'widget', [
      'npm ci', 'npm run build --workspace @acme/a', 'npm run build --workspace=@acme/b',
    ]));
    expect(r).toEqual({ workspaces: ['@acme/a', '@acme/b'], installsFromLockfile: true });
  });

  // ★ Two ways to annex commands that are not part of this recipe. Both WIDEN the scope, so
  // both are safe-direction mistakes — and both would make an unrelated service's verdict a
  // function of workspaces it never compiles, which is a wrong answer that happens to be
  // conservative. A wrong answer is still worth not giving.
  it('★ ignores a step gated on a DIFFERENT prebuild name', () => {
    const text = [
      step('Theirs', 'other', ['npm run build --workspace @acme/theirs']),
      step('Ours', 'widget', ['npm run build --workspace @acme/ours']),
    ].join('\n');
    expect(prebuildRecipe('widget', text)?.workspaces).toEqual(['@acme/ours']);
    expect(prebuildRecipe('other', text)?.workspaces).toEqual(['@acme/theirs']);
  });

  it('★ does not let a gated step annex the UNGATED step that follows it', () => {
    const text = [
      step('Ours', 'widget', ['npm run build --workspace @acme/ours']),
      '      - name: Something else entirely',
      '        run: |',
      '          npm run build --workspace @acme/unrelated',
    ].join('\n');
    expect(prebuildRecipe('widget', text)?.workspaces).toEqual(['@acme/ours']);
  });

  // ★ FOUR WAYS THE RECIPE READ TOO LITTLE, all found by an adversarial review of the first
  // version and all permissive: a recipe read short is a scope built short, and a scope
  // built short reports `equivalent` for a change the service ships.
  it('★ reads `npm ci` when it shares a line with the build, not only at the start of one', () => {
    // `run: npm ci && npm run build --workspace @acme/a` as an inline scalar dropped the
    // root package.json and package-lock.json from the scope entirely — so a TypeScript
    // major bump, which changes every emitted byte, read as `equivalent`.
    const r = prebuildRecipe('widget', [
      '      - name: Build',
      "        if: matrix.prebuild == 'widget'",
      '        run: npm ci && npm run build --workspace @acme/a',
    ].join('\n'));
    expect(r).toEqual({ workspaces: ['@acme/a'], installsFromLockfile: true });
  });

  it('★ reads every --workspace on a line, not just the first', () => {
    const r = prebuildRecipe('widget', step('Build', 'widget', [
      'npm run build --workspace @acme/a --workspace @acme/b', 'npm run build -w @acme/c',
    ]));
    expect(r?.workspaces).toEqual(['@acme/a', '@acme/b', '@acme/c']);
  });

  it('★ refuses `--workspaces`, which names every workspace and enumerates none', () => {
    // Resolving only the packages that happen to be named alongside it is a scope short by
    // however many the plural form covers.
    expect(prebuildRecipe('widget', step('Build', 'widget', [
      'npm run build --workspaces --if-present', 'npm run build --workspace @acme/a',
    ]))).toBeUndefined();
  });

  it('★ a `- ` line inside a run block does not cut the recipe in half', () => {
    // The first version reset the gate on any line starting with `- `, which a shell
    // heredoc or an echoed list contains. The workspaces before the stray line survived and
    // the ones after were dropped — and because the copied artifact still resolved, the
    // answer came back confident and short.
    const r = prebuildRecipe('widget', step('Build', 'widget', [
      'npm run build --workspace @acme/a',
      'cat <<EOF', '- core', '- abac', 'EOF',
      'npm run build --workspace @acme/b',
    ]));
    expect(r?.workspaces).toEqual(['@acme/a', '@acme/b']);
  });

  it('reads a double-quoted gate and one written after the run block', () => {
    // Both are legal YAML. A refusal on either is safe but turns the row permanently red,
    // which is the disease; and reading the whole step removes the key-order dependency
    // that would otherwise miss commands written above the `if:`.
    const r = prebuildRecipe('widget', [
      '      - name: Build',
      '        run: |',
      '          npm ci',
      '          npm run build --workspace @acme/a',
      '        if: matrix.prebuild == "widget"',
    ].join('\n'));
    expect(r).toEqual({ workspaces: ['@acme/a'], installsFromLockfile: true });
  });

  it('★ answers "unknown" rather than "nothing" when the named recipe builds no workspace', () => {
    // The difference decides whether the caller refuses or resolves to an empty input set,
    // and an empty input set is a scope that can never be non-equivalent.
    expect(prebuildRecipe('widget', step('Ours', 'widget', ['echo hello']))).toBeUndefined();
    expect(prebuildRecipe('widget', step('Theirs', 'other', ['npm run build --workspace @acme/x'])))
      .toBeUndefined();
    // A name that would be a regular expression is refused, not escaped.
    expect(prebuildRecipe('.*', step('Ours', 'widget', ['npm run build --workspace @acme/x'])))
      .toBeUndefined();
  });

  it('reads the real workflow: css\'s leg names a recipe that builds three workspaces', () => {
    const leg = matrixLegs().get('interego-css-pgsl');
    expect(leg?.prebuild).toBe('pgsl-store');
    const recipe = prebuildRecipe(leg?.prebuild as string, WORKFLOW);
    expect(recipe?.installsFromLockfile).toBe(true);
    expect(recipe?.workspaces).toEqual(['@interego/core', '@interego/abac', '@interego/pgsl-store']);
    // ★ And no other leg has one, so nothing else in the fleet takes this path today. If
    // that changes, the resolution applies to it identically — there is no service name
    // anywhere in tools/deploy-bundle-scope.ts.
    const withPrebuild = [...matrixLegs()].filter(([, l]) => l.prebuild).map(([image]) => image);
    expect(withPrebuild).toEqual(['interego-css-pgsl']);
  });

  it('★ a commented-out leg cannot inject a prebuild into the live one', () => {
    const m = matrixLegs([
      '          - { image: interego-relay, dockerfile: deploy/Dockerfile.relay }',
      '          # - { image: interego-relay, dockerfile: deploy/Dockerfile.relay, prebuild: nonsense }',
    ].join('\n'));
    expect(m.get('interego-relay')).toEqual({ dockerfile: 'deploy/Dockerfile.relay' });
  });

  // ★ THE COMMENT CLASS, HALF-CLOSED. Skipping lines that START with `#` was enough for
  // `dockerfile:` and not for this key: a live leg with a TRAILING comment handed the relay
  // another image's build recipe, and with it another image's scope. Only the leg's own
  // braces are read now.
  it('★ a trailing comment on a live leg cannot inject a prebuild either', () => {
    const m = matrixLegs(
      '          - { image: interego-relay, dockerfile: deploy/Dockerfile.relay } # legacy, prebuild: pgsl-store was here');
    expect(m.get('interego-relay')).toEqual({ dockerfile: 'deploy/Dockerfile.relay' });
  });

  it('reads a prebuild that sits before the dockerfile key as readily as after it', () => {
    const m = matrixLegs('          - { image: interego-x, dockerfile: deploy/D, prebuild: widget }');
    expect(m.get('interego-x')).toEqual({ dockerfile: 'deploy/D', prebuild: 'widget' });
  });
});

describe('workspaceDirs / producedDirs — what a workspace is, and what it writes', () => {
  it('maps npm package names to directories from the root workspaces globs', () => {
    const dirs = workspaceDirs(ROOT);
    expect(dirs.get('@interego/pgsl-store')).toBe('packages/pgsl-store');
    expect(dirs.get('@interego/core')).toBe('packages/core');
    // A non-glob workspace entry resolves too, so the map is not "packages/* only".
    expect(dirs.get('@interego/mcp-relay')).toBe('deploy/mcp-relay');
  });

  it('reads the produced directory out of the workspace\'s own manifests', () => {
    // Two independent statements of it — tsconfig outDir and the package entry points —
    // and the COPY source css ships is exactly that directory.
    expect(producedDirs('packages/pgsl-store', ROOT)).toContain('packages/pgsl-store/dist');
  });

  // ★ THE `existsSync` CLASS, RELOCATED AND FOUND AGAIN. Whether a COPY source counted as a
  // build artifact used to be decided by whether git tracks it — and `tracked()` says yes
  // for a directory the moment ONE file under it is tracked. Force-add a `.gitkeep` into a
  // gitignored `dist`, or narrow the `dist/` rule in .gitignore, and the artifact becomes
  // "diffable": the recipe is never consulted and the scope collapses onto a directory
  // whose real content git has never seen, confidently. An artifact is now whatever a
  // tracked manifest CLAIMS to produce, which no amount of local disk state can change.
  it('★ a build artifact is identified by what a manifest declares, not by the index', () => {
    const dirs = buildArtifactDirs(ROOT);
    expect(dirs).toBeTruthy();
    for (const d of ['packages/core/dist', 'packages/pgsl-store/dist', 'packages/pgsl/dist']) {
      expect(dirs).toContain(d);
    }
    // …and none of them is a directory any Dockerfile in the fleet copies today, which is
    // why every service still resolves. The check bites the day one does.
    expect(dirs).not.toContain('packages');
  });

  it('refuses to name any artifact in a tree it cannot read', () => {
    expect(buildArtifactDirs(join(tmpdir(), 'definitely-not-a-repo-xyz'))).toBeUndefined();
  });

  it('★ says a workspace produces nothing when it cannot read tracked manifests for it', () => {
    // Narrowing, not widening: an unknown output directory means the untracked COPY that
    // named it goes unexplained and the service refuses.
    expect(producedDirs('packages/no-such-package', ROOT)).toEqual([]);
    expect(producedDirs('packages/pgsl-store', join(tmpdir(), 'definitely-not-a-repo-xyz'))).toEqual([]);
  });
});

describe('prebuildInputs — every way it must refuse instead of guessing', () => {
  it('refuses a prebuild name no step in the workflow is gated on', () => {
    const r = prebuildInputs('no-such-recipe', WORKFLOW, ROOT);
    expect('reason' in r && r.reason).toMatch(/no workflow step gated on/);
  });

  it('refuses a recipe that builds a workspace this tree does not have', () => {
    const text = [
      '      - name: Build',
      "        if: matrix.prebuild == 'widget'",
      '        run: |',
      '          npm ci',
      '          npm run build --workspace @acme/not-in-this-repo',
    ].join('\n');
    const r = prebuildInputs('widget', text, ROOT);
    expect('reason' in r && r.reason).toMatch(/@acme\/not-in-this-repo.*no workspace in this tree claims/);
  });

  it('refuses when pointed at a tree whose workspaces it cannot read', () => {
    const r = prebuildInputs('pgsl-store', WORKFLOW, join(tmpdir(), 'definitely-not-a-repo-xyz'));
    expect('reason' in r).toBe(true);
  });

  // ★ An untracked COPY on a leg with a recipe is NOT automatically forgiven. The recipe
  // must claim to WRITE that directory, or the answer would be about the wrong artifact.
  it('★ a produced-directory claim is checked against the workspace, not assumed', () => {
    const r = prebuildInputs('pgsl-store', WORKFLOW, ROOT);
    expect('reason' in r).toBe(false);
    if ('reason' in r) return;
    expect(r.produced).toContain('packages/pgsl-store/dist');
    // packages/pgsl is a DECLARED dependency and therefore in scope, but the recipe does
    // not build it — so a COPY of its dist must stay unexplained rather than borrow this
    // recipe's answer.
    expect(r.paths).toContain('packages/pgsl');
    expect(r.produced).not.toContain('packages/pgsl/dist');
  });

  it('★ an untracked COPY the recipe does not produce still collapses the whole scope', () => {
    // Through the real service, with the real recipe, against a path the recipe writes
    // nothing to: `producedSources`'s central refusal, exercised where it actually sits.
    const r = prebuildInputs('pgsl-store', WORKFLOW, ROOT);
    if ('reason' in r) throw new Error(r.reason);
    for (const notProduced of ['packages/pgsl-store/src', 'packages/core', 'deploy/mcp-relay/dist']) {
      expect(r.produced.some((d) => notProduced === d || notProduced.startsWith(`${d}/`)),
        `${notProduced} must not count as produced`).toBe(false);
    }
  });

  it('lists .npmrc to diff without requiring it to exist', () => {
    // npm reads it at the root whether or not a scope names it, and there is none in this
    // tree — which is exactly why the commit that ADDS one has to be visible.
    const r = prebuildInputs('pgsl-store', WORKFLOW, ROOT);
    if ('reason' in r) throw new Error(r.reason);
    expect(r.optional).toEqual(['.npmrc']);
    expect(r.paths).not.toContain('.npmrc');
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

  it('★ resolves css, whose Dockerfile copies a gitignored build artifact, to what builds it', () => {
    // `packages/pgsl-store/dist` is produced by the matrix leg's `prebuild: pgsl-store`
    // step, so its sources ARE identifiable — from the recipe that step runs, not from the
    // Dockerfile. The artifact itself must leave the scope (git cannot diff it) and be
    // replaced by the tracked trees that decide its bytes.
    const r = bundlePathsFor('css');
    expect(r.confident, r.reason ?? '').toBe(true);
    expect(r.paths).not.toContain('packages/pgsl-store/dist');
    for (const p of ['packages/pgsl-store', 'packages/core', 'packages/abac',
      'integrations/pgsl-css-accessor', 'package.json', 'package-lock.json']) {
      expect(r.paths, `css must ship ${p}`).toContain(p);
    }
    // ★ Not tools/ or tests/ — the whole point is that a merge touching only those leaves
    // css alone. That is the property the second css deploy of 2026-08-09 paid for.
    expect(r.paths).not.toContain('tools');
    expect(r.paths).not.toContain('tests');
  });

  // ★ REFUTED BY AN INDEPENDENT REVIEWER TOLD TO BREAK THE FIRST VERSION OF THE RESOLUTION,
  // and proved rather than argued: it recompiled packages/pgsl-store with two options from
  // the base config flipped (`--target ES2019 --sourceMap false`) and all seventeen emitted
  // .js files differed, with every .js.map gone. Every workspace the recipe builds is a
  // four-line tsconfig over `extends: ../../tsconfig.base.json`, and the base is where
  // `target`, `module`, `declaration`, `sourceMap` and `isolatedModules` live. It is the
  // one build input with a single commit in this repository's whole history, which is what
  // makes it dangerous: nothing watches it, and it is in no COPY line and no workspace dir.
  it('★ css ships the tsconfig its workspaces extend, which lives outside every one of them', () => {
    const r = bundlePathsFor('css');
    expect(r.confident).toBe(true);
    expect(r.paths).toContain('tsconfig.base.json');
    // The chain is followed from the workspace, not hardcoded: the link that names it.
    expect(readFileSync(join(ROOT, 'packages/pgsl-store/tsconfig.json'), 'utf8'))
      .toMatch(/"extends"\s*:\s*"\.\.\/\.\.\/tsconfig\.base\.json"/);
  });

  // ★ THE SECOND REFUTATION, and the more dangerous one: a fail-open with no refusal
  // anywhere. The first version consulted the recipe ONLY when a COPY source failed the
  // tracked check. Narrow `dist/` in .gitignore and commit `packages/pgsl-store/dist` and
  // that check stops firing — the recipe is never read, packages/core, packages/abac,
  // packages/pgsl and the lockfile all drop silently out of css's scope, while CI still
  // runs the prebuild and overwrites the committed artifact. `prebuildInputs` therefore
  // takes no untracked-path argument at all: there is no input by which the resolution can
  // be switched off, which is the only way a disappearing resolution stays impossible.
  it('★ the recipe decides the scope whether or not the artifact happens to be tracked', () => {
    const inputs = prebuildInputs('pgsl-store', WORKFLOW, ROOT);
    expect('reason' in inputs ? inputs.reason : '').toBe('');
    if ('reason' in inputs) return;
    for (const p of ['packages/core', 'packages/abac', 'packages/pgsl-store', 'package-lock.json']) {
      expect(inputs.paths).toContain(p);
    }
    // …and every one of them reaches the service's scope.
    const scope = bundlePathsFor('css');
    for (const p of inputs.paths) expect(scope.paths).toContain(p);
  });

  it('refuses a service with no matrix leg', () => {
    expect(bundlePathsFor('postgres').confident).toBe(false);
    expect(bundlePathsFor('no-such-service').confident).toBe(false);
  });

  it('resolves EVERY service the fleet declares an image for', () => {
    // A collapsed scope is a permanently BEHIND row, which is the disease. If a future
    // Dockerfile copies something this cannot resolve, that is a real decision to make —
    // and it should be made at the pull request, not discovered in a scheduled audit.
    for (const service of Object.keys(SERVICES)) {
      if (!SERVICES[service]?.repo) continue;
      const r = bundlePathsFor(service);
      expect(r.confident, `${service}: ${r.reason ?? ''}`).toBe(true);
    }
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
    // A service the build matrix cannot place. Until the `prebuild:` resolution landed this
    // case was demonstrated with css, whose scope collapsed on an untracked COPY source —
    // which is precisely the refusal that has now been replaced by an answer, so the law
    // needs a subject that still cannot be resolved rather than a weaker assertion.
    const row = behindRow({ service: 'postgres', tag: SHA });
    const out = refineFreshness(row);
    expect(out.freshness).toBe('BEHIND');
    expect(out.bundleReason).toMatch(/no image declared/);
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

    const diffOf = (sha: string, paths: string[]): string[] => execFileSync(
      'git', ['diff', '--name-only', `${sha}..HEAD`, '--', ...paths], { encoding: 'utf8' })
      .split('\n').map((s) => s.trim()).filter(Boolean);

    // ★ THE CONTROL IS BUILT INTO THE SEARCH, not asserted after it. The candidate must
    // leave acme-id's scope untouched AND differ from HEAD overall — otherwise the empty
    // scope-diff came from comparing a commit with itself rather than from the pathspec,
    // and this would pass against a tool that never ran a diff at all.
    //
    // Not hypothetical: the first version searched only for the empty scope-diff and went
    // green locally, then failed in CI. `pull_request` checks out a MERGE commit whose
    // tree equals the branch tip's, so the very first ancestor examined was
    // content-identical to HEAD — every diff empty, for the one reason that proves
    // nothing. Local runs never saw it because master is not checked out that way.
    const log = execFileSync('git', ['log', '-40', '--format=%H'], { encoding: 'utf8' })
      .split('\n').map((s) => s.trim()).filter(Boolean);
    const clean = log.slice(1).find((sha) =>
      diffOf(sha, scope.paths).length === 0 && diffOf(sha, []).length > 0);
    expect(clean, "no ancestor within 40 commits both differs from HEAD and leaves acme-id's scope untouched")
      .toBeTruthy();

    const out = refineFreshness(behindRow({ service: 'acme-id', tag: clean as string }));
    expect(out.freshness).toBe('equivalent');
    expect(out.bundleChanged).toEqual([]);
    expect(hasDisagreement([out])).toBe(false);
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

  // ── THE PREDICATE ITSELF, MUTATION-CHECKED IN BOTH DIRECTIONS ──────────────
  //
  // ★ "The audit is green" is exactly what a softened check looks like, so a test that
  // asserted today's fleet state would be worthless. These check the derived scope against
  // an ORACLE — the same question answered from a path list written out by hand below —
  // across real commits, and require BOTH classes to be non-empty so the sweep cannot pass
  // by finding nothing to judge.

  /** What css genuinely ships, transcribed by hand. The thing the derivation must equal. */
  const CSS_SHIPS = [
    'packages/pgsl-store/', 'packages/core/', 'packages/abac/', 'packages/pgsl/',
    'integrations/pgsl-css-accessor/', 'package.json', 'package-lock.json', 'tsconfig.base.json',
    '.dockerignore', '.gitattributes', '.github/workflows/build-ghcr.yml', '.npmrc',
  ];
  const shipsByOracle = (files: string[]): boolean =>
    files.some((f) => CSS_SHIPS.some((p) => (p.endsWith('/') ? f.startsWith(p) : f === p)));
  const inScope = (files: string[], paths: string[]): boolean =>
    files.some((f) => paths.some((p) => f === p || f.startsWith(`${p}/`)));

  /** Each of the last `n` first-parent commits with the files it changed, in one git call. */
  function recentCommits(n: number): { sha: string; files: string[] }[] {
    const out = execFileSync('git',
      ['log', '--first-parent', `-${n}`, '--format=%x00%H', '--name-only'],
      { cwd: ROOT, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
    return out.split('\0').map((s) => s.trim()).filter(Boolean).map((block) => {
      const [sha, ...files] = block.split('\n').map((l) => l.trim()).filter(Boolean);
      return { sha: sha as string, files };
    });
  }

  it('★ the derived css scope agrees with a hand-written oracle over 120 real merges', () => {
    const scope = bundlePathsFor('css');
    expect(scope.confident, scope.reason ?? '').toBe(true);

    const commits = recentCommits(120);
    expect(commits.length).toBeGreaterThan(100);
    const disagree: string[] = [];
    let ships = 0;
    let clean = 0;
    for (const { sha, files } of commits) {
      const derived = inScope(files, scope.paths);
      if (derived) ships += 1; else clean += 1;
      if (derived !== shipsByOracle(files)) {
        disagree.push(`${sha.slice(0, 8)} derived=${derived} oracle=${!derived}`);
      }
    }
    expect(disagree).toEqual([]);
    // ★ THE CONTROL. Both classes must be represented, or "agrees with the oracle" is a
    // statement about an empty set — the same defect as a control satisfiable by comparing
    // a commit with itself, which really did pass in CI once.
    expect(ships, 'no merge in the window touches anything css ships').toBeGreaterThan(0);
    expect(clean, 'no merge in the window leaves css alone').toBeGreaterThan(0);
  });

  it('★ css is NOT cleared by any of the real commits that changed packages/pgsl-store/src', () => {
    // The direction that matters. Each of these is a real change to the source of the
    // artifact css ships — a compiled `dist` the Dockerfile copies straight in — and under
    // the previous `existsSync` bug every one of them was invisible.
    const shas = execFileSync('git', ['log', '-6', '--format=%H', '--', 'packages/pgsl-store/src'],
      { cwd: ROOT, encoding: 'utf8' }).split('\n').map((s) => s.trim()).filter(Boolean);
    expect(shas.length).toBeGreaterThan(2);
    for (const sha of shas) {
      const parent = execFileSync('git', ['rev-parse', `${sha}^`], { cwd: ROOT, encoding: 'utf8' }).trim();
      const out = refineFreshness(behindRow({ service: 'css', tag: parent }));
      expect(out.freshness, `${sha} left css cleared`).toBe('BEHIND');
      expect((out.bundleChanged ?? []).some((f) => f.startsWith('packages/pgsl-store/')),
        `${sha}: css's own source is not in its changed set`).toBe(true);
      expect(hasDisagreement([out])).toBe(true);
    }
  });

  it('★ and css IS cleared by an ancestor that changed nothing it ships', () => {
    // The property the second css deploy of 2026-08-09 was spent on, and which css could
    // not have had at all before this: its scope was collapsed, so its freshness could only
    // ever read `current` and any merge at all turned the row red.
    const scope = bundlePathsFor('css');
    expect(scope.confident).toBe(true);

    const diffOf = (sha: string, paths: string[]): string[] => execFileSync(
      'git', ['diff', '--name-only', `${sha}..HEAD`, '--', ...paths], { cwd: ROOT, encoding: 'utf8' })
      .split('\n').map((s) => s.trim()).filter(Boolean);

    // ★ Same built-in control as the acme-id case above: the candidate must leave css's
    // scope untouched AND differ from HEAD overall, or the empty scope-diff came from
    // comparing a commit with itself rather than from the pathspec.
    const log = execFileSync('git', ['log', '-60', '--format=%H'], { cwd: ROOT, encoding: 'utf8' })
      .split('\n').map((s) => s.trim()).filter(Boolean);
    const cleanSha = log.slice(1).find((sha) =>
      diffOf(sha, scope.paths).length === 0 && diffOf(sha, []).length > 0);
    expect(cleanSha, "no ancestor within 60 commits both differs from HEAD and leaves css's scope untouched")
      .toBeTruthy();

    // css is the fleet's declared singleton, so its row carries settings axes the others
    // do not. They are given their compliant values here because this test is about the
    // freshness axis alone — and the fact that a downgraded row still fails on the others
    // is asserted directly, two tests below.
    const out = refineFreshness(behindRow({
      service: 'css', tag: cleanSha as string, numReplicas: 1, overlapSeconds: 0, drainingSeconds: null,
    }));
    expect(out.freshness).toBe('equivalent');
    expect(out.bundleChanged).toEqual([]);
    expect(hasDisagreement([out])).toBe(false);
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
