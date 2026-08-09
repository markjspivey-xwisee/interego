/**
 * Does the drift between a service's pinned commit and master touch anything that service
 * actually SHIPS?
 *
 * ── THE DEFECT THIS CLOSES, DEMONSTRATED BY ITS OWN FIX ──────────────────────
 *
 * `railway-pins.mjs` reports freshness as "how many commits is this pin behind master".
 * That question cannot be answered green in a repository that merges more often than it
 * deploys, so the check built on it was red on a schedule set by unrelated merges — and a
 * check that is expected to be red is not read. Measured on 2026-08-09: it had been
 * failing every deploy for at least two runs and was twice dismissed in one session as
 * "the documented always-red step", while underneath it the relay was genuinely behind on
 * its own bundled code and fifteen services were pinned to images never built at master.
 *
 * ★ The fix for that (scoping the deploy gate, moving the fleet audit to a schedule)
 * REPRODUCED THE DISEASE within the hour. Commit 2ecd003 changed `.github/workflows/`,
 * `tools/` and `tests/` — paths NO service bundles — and the freshly written fleet audit
 * went red on all sixteen services. Nothing was running stale code. The question was
 * simply the wrong one.
 *
 * The right question is not "is the pin the tip of master" but "is the pin's IMAGE the
 * image master would build". Those differ by exactly the commits that touch nothing the
 * service copies into its build context, which in this repository is most of them.
 *
 * ── DERIVED, NEVER TRANSCRIBED ───────────────────────────────────────────────
 *
 * Everything here is read from the artifacts the BUILD reads:
 *
 *   service → image      tools/railway-services.mjs (SERVICES[svc].repo)
 *   image   → Dockerfile .github/workflows/build-ghcr.yml (the matrix legs)
 *   Dockerfile → paths   the Dockerfile's own COPY lines
 *
 * A hand-kept list of "what each service cares about" is the transcription rot the header
 * of railway-pins.mjs is entirely about; it would be wrong from the next Dockerfile edit
 * onward and nothing would notice. `tools/deploy-scope.mjs` answers a NEIGHBOURING
 * question (which services bundle a changed npm PACKAGE) and says in its own comment that
 * it "cannot tell you a service is running a stale IMAGE". This is that other half.
 *
 * ── WHAT "EQUIVALENT" CLAIMS, EXACTLY ────────────────────────────────────────
 *
 * ★ NOT "the two images are byte-identical" — they never are. `build-ghcr.yml` passes
 * `GIT_SHA=${{ github.sha }}` to every image, every Dockerfile bakes it in (the four
 * nginx SPAs `sed` it into `deploy/nginx-spa.conf`, which then serves it from /health),
 * and the OCI `revision` label carries it too. That field is the repository's ONLY
 * mechanism for proving a container runs a given commit, so it differs by construction at
 * every commit and literal image-equality is unattainable.
 *
 * The claim is narrower and is the one that matters: NO CHANGE TO REPOSITORY CONTENT THAT
 * WOULD ALTER THIS IMAGE HAS BEEN MISSED. Things outside the repository can still move
 * underneath it — every base image floats on a mutable tag (`node:22-slim`,
 * `nginx:1.27-alpine`), and several Dockerfiles run `npm install` rather than `npm ci`,
 * so a rebuild can resolve a different dependency tree from an unchanged lock. Those are
 * real, and they are not what this measures.
 *
 * ── FAIL CLOSED, ALWAYS ──────────────────────────────────────────────────────
 *
 * ★ Every uncertainty answers "affected", never "clean". The verdict this produces can
 * only ever DOWNGRADE a red to a green, so a parse that silently half-worked would be a
 * false all-clear on the one axis that says whether production is running the code that
 * was merged — the precise failure this file exists to end, re-introduced one layer down.
 * So: an unreadable Dockerfile, an unrecognised COPY form, a matrix leg that cannot be
 * found, a COPY source that is not in the tree, a git command that fails — each returns
 * `confident: false`, and a caller that is not confident must leave the row BEHIND.
 *
 * ── THE THREE FILES THAT ARE IN EVERY SCOPE ──────────────────────────────────
 *
 * ★ FOUND BY AN ADVERSARIAL REVIEW OF THE FIRST VERSION, which had none of them, and
 * which was refuted with eight commits out of this repository's own history. A service's
 * scope was built purely from its COPY *sources*, so the three files that most directly
 * decide what an image contains were the three no scope could ever hold:
 *
 *   the Dockerfile itself   `7242353` moved the relay to `node:22-slim` to fix a crash at
 *                           import; `d29ffc8` added `absolute_redirect off` to acme-id,
 *                           whose `Location:` header was leaking the internal port;
 *                           `fb7f42f` added a whole capability to the relay image.
 *                           acme-id and foxxi-scorm-player are the sharp cases — their
 *                           entire nginx server block, CSP and all, is a `RUN printf`
 *                           inside the Dockerfile, so most of their behaviour lived
 *                           outside their own scope.
 *   build-ghcr.yml          carries `build_args`. `0e8ae02` touched only that file and
 *                           decided which bridge URL three Vite SPAs are compiled to talk
 *                           to at runtime.
 *   .dockerignore           `context: .` for every image, so this file decides what
 *                           reaches the build at all. `857c536` touched only it.
 *   .gitattributes          decides the BYTES — the eol policy applied to every text file
 *                           in the checkout that becomes the context.
 *
 * Each was empty-diffed and waved through as `equivalent` by the first version. All four
 * are tracked, so including them costs nothing and closes the class.
 *
 * ★ THE PRICE, STATED DELIBERATELY. Three of the four are in EVERY service's scope, so
 * one edit to any of them turns the whole fleet non-equivalent at once — including a pure
 * comment edit, in a repository whose files are majority comment. That is a partial
 * re-entry of the "red for an unrelated reason" disease this file exists to cure, and it
 * is accepted on measured churn: ten commits all-time on build-ghcr.yml, three on
 * .dockerignore, and .gitattributes rarer still. If that churn rises, the answer is to
 * make the comparison content-aware, NOT to drop the paths — every one of them was added
 * because a real commit slipped through without it.
 *
 * ── A COPY OF A BUILD ARTIFACT IS NOT AN UNANSWERABLE QUESTION ───────────────
 *
 * ★ The remaining collapse, and the reason it was worth closing separately. `css`'s
 * Dockerfile COPYs `packages/pgsl-store/dist`, which git does not track: it is produced by
 * the matrix leg's own `prebuild:` step. An untracked COPY source fails the whole service
 * closed, so css's scope was empty and its verdict could only ever be `current` — never
 * `equivalent` — and it went red on every merge that did not touch it at all. Measured on
 * 2026-08-09: a comment-only merge did exactly that, and css was deployed a second time
 * for no reason but to clear the row.
 *
 * That is safe (it over-reports) but it is not honest, and a row that is red on a schedule
 * is the disease this file was written to cure, arriving one layer down again.
 *
 * The sources ARE derivable, and from the same artifact everything else here is read from.
 * The matrix leg carries `prebuild: pgsl-store`; the workflow steps gated on
 * `matrix.prebuild == 'pgsl-store'` run `npm ci` and three `npm run build --workspace`
 * lines; the root `package.json` workspaces resolve those npm names to directories; and
 * each workspace's own `tsconfig.json` outDir / `package.json` entry points say which
 * directory its build PRODUCES. When a COPY source is one of those produced directories,
 * its shipped-source set is the tracked tree of the workspaces that build it.
 *
 * ★ AN ARTIFACT IS WHAT A MANIFEST SAYS IT IS, NOT WHAT THE INDEX HAPPENS TO HOLD, and the
 * recipe is read for EVERY leg that declares one — not only for a leg whose COPY source
 * fails a tracked check. Both are corrections from an adversarial review of the first
 * version, and both are the `existsSync` bug in a new costume: keyed on tracked-ness, the
 * resolution disappears the moment one file inside the artifact directory gets committed,
 * taking `packages/core`, `packages/abac`, `packages/pgsl` and the lockfile out of css's
 * scope in silence while CI goes on rebuilding the artifact over the committed one.
 *
 * ★ DERIVED GENERALLY, NOT FOR css. Nothing below names a service, an image, a workspace
 * or a path. Any leg that declares `prebuild:` gets the same treatment; css is simply the
 * only leg that declares one today (measured: one `prebuild:` key in the matrix, and css
 * the only service in the fleet whose Dockerfile copies a produced directory at all).
 *
 * ★ AND IT OVER-REPORTS ON PURPOSE, because this is the one place where being wrong fails
 * OPEN — a scope too NARROW reports `equivalent` while a change the service really ships
 * sits undeployed, on the service that holds every pod's data. So the substitute is
 * deliberately wider than the artifact:
 *
 *   · the WHOLE workspace directory, not just its `src/` — README, tests and tsconfig
 *     included, though only some of them reach the emitted `dist`;
 *   · EVERY workspace the recipe builds, not only the one whose output is copied. The
 *     recipe builds @interego/core and @interego/abac before @interego/pgsl-store because
 *     the compile resolves their `.d.ts`, and TypeScript's emit is not independent of them
 *     (a type that becomes a value stops being elided; declaration output can inline);
 *   · closed transitively over each built workspace's DECLARED workspace dependencies
 *     (`optionalDependencies` included), so a package the recipe does not name but the
 *     compile can still resolve is in scope;
 *   · every tsconfig in each of those workspaces' `extends` chains. All four here are a
 *     four-line stub over `../../tsconfig.base.json`, and the base is where `target`,
 *     `declaration`, `sourceMap` and `isolatedModules` actually live — flipping two of them
 *     rewrites all seventeen emitted files with every workspace directory byte-identical.
 *     Measured that way by the reviewer who found it missing;
 *   · plus the root `package.json` and `package-lock.json`, because the recipe runs
 *     `npm ci` and the lockfile decides which compiler emits the bytes — and `.npmrc`,
 *     which npm reads at the root and this tree does not yet have.
 *
 * Measured cost of that width over the last 200 first-parent merges: 54 touch css's scope
 * and 146 do not, so the row can now be green 73% of the time against 0% before. Of the 54:
 * 11 are the narrow scope (the accessor, pgsl-store, the Dockerfile and the three
 * always-in files), 26 are packages/core, 17 the root manifests, 4 packages/pgsl and 1
 * packages/abac. Every one of those is a real input to the compile that emits the artifact;
 * dropping them to buy a greener row is the trade this file exists to refuse.
 *
 * ★ AND IT STILL FAILS CLOSED. A produced directory copied by a leg with no `prebuild:`, a
 * `prebuild:` naming a recipe that builds nothing, a `--workspaces` that enumerates none, a
 * workspace name no manifest in the tree claims, a workspace manifest unreadable at HEAD, a
 * `"build"` script that reaches outside its workspace, a tsconfig chain with an unfollowable
 * link, or a substitute that is itself untracked — each is a refusal. The resolution only
 * ever turns one specific unanswerable question into an answerable one.
 */

import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import type { PinRow } from './railway-pins.mjs';
import { SERVICES } from './railway-services.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
/** Repo-relative, because it is both a file to READ and a path to put in every scope. */
const WORKFLOW_REL = '.github/workflows/build-ghcr.yml';
const DOCKERIGNORE_REL = '.dockerignore';
/**
 * ★ In every scope for the same reason `.dockerignore` is: it decides the BYTES. 80 lines
 * of deliberate policy (`* text=auto eol=lf`, `Dockerfile* text eol=lf`, `*.bat eol=crlf`)
 * that determine the line endings of every text file in the checkout that becomes
 * `context: .`. Flipping the global to `eol=crlf` rewrites every .ts/.json/.ttl/.sh in all
 * sixteen images and gives `integrations/pgsl-css-accessor/docker-entrypoint.sh` a CRLF
 * shebang, which dies as `bad interpreter` — with a completely empty diff in every other
 * scoped path. The file's own header shows these rules get edited.
 */
const GITATTRIBUTES_REL = '.gitattributes';
const WORKFLOW = join(ROOT, WORKFLOW_REL);

export interface BundleScope {
  /** False whenever anything could not be resolved. A caller MUST treat this as "affected". */
  confident: boolean;
  /**
   * Repo-relative TRACKED paths whose content decides this image: what its Dockerfile
   * copies, the files no COPY line can name, and — where a COPY names a build artifact —
   * the sources of the workspaces that produce it, in place of the artifact itself. Every
   * entry must be diffable by git, because that is the only question asked of them.
   */
  paths: string[];
  /** Why the answer is not confident, when it is not. */
  reason?: string;
}

/**
 * A pin row plus this file's findings. Declared here rather than added to
 * `railway-pins.d.mts`, because that file declares the shape `railway-pins.mjs` PRODUCES
 * and these two fields are never on a row it returns — putting them there would assert
 * that collectPins fills them in.
 */
export interface RefinedRow extends PinRow {
  /** Tracked files this service ships that changed since its pin. Empty when equivalent. */
  bundleChanged?: string[];
  /** Why the freshness verdict came out the way it did. */
  bundleReason?: string;
}

export interface BundleDrift {
  confident: boolean;
  /** Tracked files changed between the pin and HEAD that this service actually ships. */
  changed: string[];
  /** True only when the parse was confident AND nothing this service ships has changed. */
  equivalent: boolean;
  reason?: string;
}

/** One `include:` entry of the build matrix, as much of it as this file needs. */
export interface MatrixLeg {
  /** The Dockerfile the leg builds, repo-relative. */
  dockerfile: string;
  /**
   * The leg's `prebuild:` key, when it has one. It names a RECIPE elsewhere in the same
   * workflow — the steps gated on `matrix.prebuild == '<this>'` — which produces artifacts
   * the Dockerfile expects to already be in the build context. It is the only thing that
   * makes an untracked COPY source answerable; see the header.
   */
  prebuild?: string;
}

/**
 * image name → its matrix leg, read out of the build matrix.
 *
 * Deliberately the same file `validate-input` reads its list of legal image names from,
 * and for the same reason given there: "Read the names out of this file so the check
 * cannot drift from the matrix."
 */
export function matrixLegs(workflowText?: string): Map<string, MatrixLeg> {
  const text = workflowText ?? readFileSync(WORKFLOW, 'utf8');
  const out = new Map<string, MatrixLeg>();
  // Matches a matrix leg: `- { image: interego-relay, dockerfile: deploy/Dockerfile.relay ... }`
  // The `dockerfile:` value runs to the next comma or the closing brace, so legs carrying
  // `build_args:` or `prebuild:` after it parse identically to the bare ones.
  const leg = /^-\s*\{\s*image:\s*([a-z0-9-]+)\s*,\s*dockerfile:\s*([^,}\s]+)/;
  // Read wherever it sits in the leg rather than positionally: `build_args:` already
  // appears both with and without a `prebuild:` beside it, and a key order this parser
  // depended on would be a silent drop the first time somebody reordered one.
  //
  // ★ …BUT ONLY INSIDE THE LEG'S OWN BRACES. Skipping lines that START with `#` closed the
  // commented-out-leg attack for `dockerfile:` and left it open for this key: a live leg
  // with a trailing `} # legacy, prebuild: pgsl-store was here` handed the relay another
  // image's build recipe, and with it another image's scope. Found by re-running the same
  // review against the version that had "fixed" the comment class.
  const prebuildKey = /[,{]\s*prebuild:\s*([^,}\s]+)/;
  for (const raw of text.split('\n')) {
    // ★ COMMENTED-OUT LEGS ARE NOT LEGS. Scanning the whole file with a /g regex and
    // `Map.set` makes the LAST match win, so a `# - { image: interego-relay, dockerfile:
    // deploy/Dockerfile.OLD }` left below the live leg would silently redirect the whole
    // comparison to the wrong Dockerfile — a confident answer computed from the wrong
    // file, which is worse than a refusal. build-ghcr.yml is heavily commented in exactly
    // this style, and the `validate-input` shell guard this parser is modelled on already
    // anchors its sed to `^[[:space:]]*- {` for the same reason. Anchoring here makes the
    // two readers of one file agree.
    const line = raw.trim();
    if (line.startsWith('#')) continue;
    const m = leg.exec(line);
    if (!m) continue;
    const image = m[1];
    const dockerfile = m[2];
    if (!image || !dockerfile) continue;
    const close = line.indexOf('}');
    const body = close === -1 ? line : line.slice(0, close + 1);
    const prebuild = prebuildKey.exec(body)?.[1];
    out.set(image, prebuild ? { dockerfile, prebuild } : { dockerfile });
  }
  return out;
}

/** image name → Dockerfile path. The shape most callers want; `matrixLegs` is the parse. */
export function matrixDockerfiles(workflowText?: string): Map<string, string> {
  return new Map([...matrixLegs(workflowText)].map(([image, leg]) => [image, leg.dockerfile]));
}

/**
 * The build-context paths a Dockerfile copies.
 *
 * `COPY --from=<stage>` is skipped: it copies out of an earlier BUILD STAGE, not out of
 * the context, so its source is a path inside a container image and has no meaning in
 * this repository. Twenty-nine of the fleet's two hundred and fifty-eight COPY lines are
 * that form, and counting them would resolve to nothing and fail every service closed.
 *
 * Any other form this does not recognise returns `confident: false` rather than being
 * dropped — a dropped COPY is a path whose changes become invisible.
 */
export function copySources(dockerfileText: string): BundleScope {
  const paths: string[] = [];

  // ★ COMMENTS ARE STRIPPED FIRST, THEN CONTINUATIONS JOINED — DOCKER'S ORDER, AND THE
  // ORDER MATTERS. Doing it the other way round is a silent-drop bug, and it is the one
  // introduced by the FIRST attempt to fix a silent-drop bug:
  //
  //     # see docs/foo \
  //     COPY packages/ ./packages/
  //     COPY x.txt ./
  //
  // Docker strips the comment line before looking for continuations, so a `#` line never
  // continues and both COPYs are seen. A joiner that runs first splices the comment onto
  // the `COPY packages/` line, the result no longer starts with COPY, and `packages/`
  // vanishes — with `confident: true`, and taking any `ADD` refusal on that line with it.
  // Before the joiner existed this was harmless, because a `#` line never matched
  // /^COPY\s/; adding the joiner is what made `#` load-bearing.
  //
  // Not live today, but `deploy/Dockerfile.acme-id` and `deploy/Dockerfile.foxxi-scorm-player`
  // contain ~50 lines that trim to `#` and end in `\` (inside a continued `RUN printf`),
  // i.e. they are written in exactly the style that triggers it.
  const decommented = dockerfileText.split('\n').filter((l) => !l.trim().startsWith('#')).join('\n');

  // Continuations joined only now. The line-based first version parsed `COPY packages/ \`
  // as a complete instruction, took the trailing backslash for the destination, kept
  // `packages/` and DROPPED every source on the continuation lines — while returning
  // `confident: true`. Dockerfile.relay's 33 consecutive one-file COPY lines are the
  // obvious thing for somebody to collapse into exactly that form.
  const joined = decommented.replace(/\\[ \t]*\r?\n/g, ' ');

  for (const raw of joined.split('\n')) {
    const line = raw.trim();
    // ★ ADD copies into the image exactly as COPY does. Matching only /^COPY/ meant an
    // `ADD packages/ ./packages/` vanished with no refusal, taking every change under it
    // out of view. It is rejected rather than parsed: ADD also fetches remote URLs and
    // auto-extracts archives, so its sources are not always context paths, and this file
    // may not guess.
    if (/^ADD\s/i.test(line)) {
      return { confident: false, paths: [], reason: `ADD copies into the image and this parser does not read it: ${line.slice(0, 60)}` };
    }
    // ★ AND `ONBUILD COPY` IS A COPY THAT MATCHES NEITHER PATTERN ABOVE. Found by re-running
    // the review that produced the ADD refusal against the version that added it: the file's
    // stated contract is that an unrecognised form REFUSES, and `ONBUILD COPY packages/ ./`
    // was instead dropped in silence, with `confident: true` — the same silent-drop bug the
    // ADD case exists to prevent, one keyword along. `ONBUILD ADD` slipped the ADD refusal
    // for the same reason.
    if (/^ONBUILD\s/i.test(line)) {
      return { confident: false, paths: [], reason: `ONBUILD defers an instruction into a later build and this parser does not read it: ${line.slice(0, 60)}` };
    }
    if (!/^COPY\s/i.test(line)) continue;
    if (line.includes('\\')) {
      return { confident: false, paths: [], reason: `COPY still contains a backslash after joining continuations: ${line.slice(0, 60)}` };
    }
    if (line.includes('[')) {
      return { confident: false, paths: [], reason: `JSON-array COPY form is not parsed: ${line.slice(0, 60)}` };
    }

    const parts = line.split(/\s+/).slice(1);
    if (parts.some((p) => p.startsWith('--from='))) continue;

    const flags = parts.filter((p) => p.startsWith('--'));
    const args = parts.filter((p) => !p.startsWith('--'));
    // --chown / --chmod change ownership, not what is copied. Anything else is a form
    // this parser has not seen, and guessing at it is how a false green gets in.
    const unknown = flags.find((f) => !/^--(chown|chmod|link)=/.test(f));
    if (unknown) return { confident: false, paths: [], reason: `unrecognised COPY flag ${unknown}` };
    if (args.length < 2) return { confident: false, paths: [], reason: `COPY with no source and destination: ${line}` };

    // The last argument is the destination; everything before it is a source.
    for (const src of args.slice(0, -1)) {
      if (/[*?[\]]/.test(src)) return { confident: false, paths: [], reason: `globbed COPY source ${src}` };
      const clean = src.replace(/^\.\//, '').replace(/\/$/, '');
      if (clean === '' || clean === '.') {
        return { confident: false, paths: [], reason: 'COPY of the whole build context' };
      }
      paths.push(clean);
    }
  }
  if (paths.length === 0) return { confident: false, paths: [], reason: 'no context COPY found' };
  return { confident: true, paths: [...new Set(paths)] };
}

/**
 * Every file git holds at HEAD, read once per checkout.
 *
 * One `git ls-tree` per QUESTION was affordable when the only questions were a handful of
 * COPY sources; resolving a produced directory asks it of every workspace manifest in the
 * tree, and a process spawn per ask is both slow and, on the paths below, asked inside
 * loops. `-z` because git quotes and escapes non-ASCII names in its default output, and a
 * mangled name here reads as "untracked" — a refusal, but a spurious one.
 *
 * The cache is keyed on the checkout only. Every caller resolves against HEAD and this
 * module is used by short-lived CLI runs and one test process, so HEAD does not move
 * underneath it; if it ever did, every git diff in flight would be inconsistent too.
 */
const trackedIndex = new Map<string, Set<string>>();
function trackedFiles(root: string): Set<string> {
  const cached = trackedIndex.get(root);
  if (cached) return cached;
  let files: Set<string>;
  try {
    const out = execFileSync('git', ['ls-tree', '-r', '-z', '--name-only', 'HEAD'], {
      cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], maxBuffer: 64 * 1024 * 1024,
    });
    files = new Set(out.split('\0').filter(Boolean));
  } catch { files = new Set(); }
  trackedIndex.set(root, files);
  return files;
}

/**
 * Tracked files whose working-tree content differs from HEAD, read once per checkout.
 *
 * A git failure yields `undefined`, which every caller must read as "EVERYTHING may differ"
 * — the tmpdir case, and any checkout this cannot interrogate.
 */
const dirtyIndex = new Map<string, Set<string> | undefined>();
function locallyModified(root: string): Set<string> | undefined {
  if (dirtyIndex.has(root)) return dirtyIndex.get(root);
  let dirty: Set<string> | undefined;
  try {
    const out = execFileSync('git', ['diff', '--name-only', '-z', 'HEAD'], {
      cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], maxBuffer: 64 * 1024 * 1024,
    });
    dirty = new Set(out.split('\0').filter(Boolean));
  } catch { dirty = undefined; }
  dirtyIndex.set(root, dirty);
  return dirty;
}

/**
 * The content of a repository file AS HEAD HAS IT, or a throw.
 *
 * ★ EVERY READ IN THIS FILE GOES THROUGH HERE, AND THAT IS THE `existsSync` LESSON APPLIED
 * PROPERLY RATHER THAN LOCALLY. Removing `existsSync` from `tracked()` fixed one symptom of
 * a general defect: this module answers a question about HEAD ("would the image master
 * builds differ") using bytes it reads off the working tree. An adversarial review of the
 * first version of the produced-directory resolution turned three refusals into confident
 * answers, and one BEHIND into `equivalent`, with no commit at all — by editing a tracked
 * `package.json` on disk, by deleting a tracked workspace from the working copy, and by
 * removing a COPY line from a Dockerfile locally. Each is the same bug wearing a different
 * hat: local disk state deciding a claim about a commit.
 *
 * Reading every file out of git would cost a process spawn per read and this asks for
 * dozens. One `git diff --name-only HEAD` answers the question for all of them at once: a
 * tracked file that is NOT locally modified already has its HEAD content on disk. Only the
 * few that are modified — normally none, and in CI never — fall back to `git show`, so a
 * dirty working tree yields the right answer rather than a refusal. Untracked, or a
 * checkout git cannot be asked about at all, throws; every caller turns a throw into a
 * refusal.
 */
function readAtHead(rel: string, root: string): string {
  if (!tracked(rel, root)) throw new Error(`${rel} is not tracked at HEAD`);
  const dirty = locallyModified(root);
  if (dirty && !dirty.has(rel)) return readFileSync(join(root, rel), 'utf8');
  return execFileSync('git', ['show', `HEAD:${rel}`], {
    cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], maxBuffer: 64 * 1024 * 1024,
  });
}

/**
 * Is this path tracked by git at HEAD (as a file or as a directory entry)?
 *
 * ★ GIT IS THE AUTHORITY, AND `existsSync` IS NOT — measured, as a false green in this
 * very file. The first version of this function short-circuited on
 * `existsSync(join(root, path))`. `interego-css-pgsl` copies `packages/pgsl-store/dist`,
 * which is GITIGNORED and produced by the matrix leg's `prebuild` step — but the
 * directory was present on the machine because `npm run build` had run, so the
 * untracked-source guard passed, `git diff -- packages/pgsl-store/dist` matched nothing,
 * and every change under `packages/pgsl-store/src` became invisible to the audit. css
 * stayed red only because three unrelated config files happened to have changed too; had
 * the round's pgsl-store work been the only drift, the service would have been reported
 * `equivalent` while shipping different compiled bytes.
 *
 * The filesystem answers "is this here now", which depends on what has been built in this
 * working tree. The question is "can git tell me how this path changed between two
 * commits", and only git can answer it.
 *
 * ★ AND THE SAME TRAP IS RE-ENTERED BY THE RESOLUTION THAT REPLACED THAT REFUSAL. Reading
 * a workspace's `package.json` / `tsconfig.json` off the disk to decide what it produces
 * makes local disk state an input again: an untracked manifest could name a workspace or
 * claim an output directory that CI has never seen, and the answer would be confident and
 * wrong. So every manifest read below is GATED ON `tracked()` first — the working tree may
 * supply the bytes, but only git decides which files exist.
 */
function tracked(path: string, root: string): boolean {
  const files = trackedFiles(root);
  if (files.has(path)) return true;
  const prefix = `${path}/`;
  for (const f of files) if (f.startsWith(prefix)) return true;
  return false;
}

/** What the workflow steps gated on one `prebuild:` name actually do. */
export interface PrebuildRecipe {
  /** npm package names, in the order the recipe builds them. */
  workspaces: string[];
  /** True when the recipe installs at the repo root, i.e. the root lockfile picks the toolchain. */
  installsFromLockfile: boolean;
}

/**
 * The recipe a `prebuild:` key names, read out of the workflow's own steps.
 *
 * A step belongs to the recipe when its `if:` mentions `matrix.prebuild == '<name>'`, which
 * is precisely the condition GitHub itself evaluates to decide whether to run it — so this
 * reads the build's own answer rather than a second description of it.
 *
 * ★ STEPS ARE FOUND BY INDENTATION, NOT BY "A LINE STARTING WITH `- `". The first version
 * reset the gate on any such line, which a `run: |` block's own content can contain — a
 * heredoc, an echoed YAML list, a bulleted shell comment. An adversarial review used one to
 * cut a recipe in half: the workspaces BEFORE the stray `- ` were kept, the ones after were
 * dropped, and because the copied artifact still resolved, the scope came back confident
 * and short. Reading the step list at its own indent makes block content inert, and reading
 * the whole step regardless of where its `if:` sits removes the key-order dependency too.
 *
 * Returns undefined when the named recipe builds no workspace, which the caller must treat
 * as "this artifact's sources are unknown" rather than "there are none".
 */
export function prebuildRecipe(prebuild: string, workflowText: string): PrebuildRecipe | undefined {
  // The name goes into a RegExp below. Anything outside this class is refused rather than
  // escaped: a `prebuild:` value containing regex metacharacters is not a thing this
  // repository has, and a guess about one is how a confident wrong answer gets in.
  if (!/^[A-Za-z0-9._-]+$/.test(prebuild)) return undefined;
  // Both quote forms, because YAML accepts both and a refusal here is a permanently red row.
  const gate = new RegExp(`matrix\\.prebuild\\s*==\\s*['"]${prebuild}['"]`);
  const indentOf = (line: string): number => line.length - line.trimStart().length;

  // ── the step blocks, cut at the `steps:` list's own indentation ────────────
  const lines = workflowText.split('\n');
  const blocks: string[][] = [];
  let itemIndent: number | undefined;
  let current: string[] | undefined;
  for (const raw of lines) {
    if (raw.trim() === '') { current?.push(raw); continue; }
    const indent = indentOf(raw);
    const isItem = /^\s*-\s/.test(raw);
    if (itemIndent === undefined) {
      if (isItem) { itemIndent = indent; current = [raw]; blocks.push(current); }
      continue;
    }
    if (isItem && indent === itemIndent) { current = [raw]; blocks.push(current); continue; }
    // A line shallower than the list closes it: `steps:` has ended and a sibling key began.
    if (indent < itemIndent) { itemIndent = undefined; current = undefined; continue; }
    current?.push(raw);
  }

  const workspaces: string[] = [];
  let installsFromLockfile = false;
  for (const block of blocks) {
    if (!block.some((l) => /^\s*if:/.test(l) && gate.test(l))) continue;
    for (const raw of block) {
      const line = raw.trim();
      if (line.startsWith('#')) continue;
      // Anywhere in the line, not anchored: `npm ci && npm run build …` on one line is the
      // same install, and reading it as "no install" drops the lockfile — the file that
      // decides which compiler emits the artifact — out of scope entirely.
      if (/(^|[\s;&|(])npm\s+(ci|install)\b/.test(line)) installsFromLockfile = true;
      // ★ `--workspaces` (plural) means EVERY workspace, which this does not enumerate.
      // Refusing beats resolving the few that happen to be named alongside it.
      if (/--workspaces\b/.test(line)) return undefined;
      // matchAll, not exec: npm accepts the flag repeated, and taking only the first left
      // the rest of a `--workspace a --workspace b` line out of the recipe.
      for (const m of line.matchAll(/(?:--workspace[= ]|(?:^|\s)-w[= ]\s*)\s*(\S+)/g)) {
        if (m[1]) workspaces.push(m[1]);
      }
    }
  }
  if (workspaces.length === 0) return undefined;
  return { workspaces: [...new Set(workspaces)], installsFromLockfile };
}

/**
 * npm package name → repo-relative directory, for every workspace the root manifest declares.
 *
 * A glob form this does not understand contributes NO workspace, so a recipe naming a
 * package that needed it stays unresolved and the caller refuses. That is the safe
 * direction: the alternative is inventing a directory for a name.
 */
export function workspaceDirs(root: string): Map<string, string> {
  return workspaceScan(root).byName;
}

/** The workspace map, plus the manifests git tracks but this could not read at HEAD. */
export interface WorkspaceScan {
  byName: Map<string, string>;
  /**
   * Workspace directories git holds a manifest for whose HEAD content could not be read or
   * parsed. Non-empty means the name→directory map is INCOMPLETE, and a caller that walks
   * dependency names through it must refuse rather than treat an unresolved name as
   * external — an unreadable workspace is exactly how a real input goes missing quietly.
   */
  unreadable: string[];
}

export function workspaceScan(root: string): WorkspaceScan {
  const byName = new Map<string, string>();
  const unreadable: string[] = [];
  let declared: unknown;
  try {
    declared = (JSON.parse(readAtHead('package.json', root)) as { workspaces?: unknown }).workspaces;
  } catch { return { byName, unreadable: ['.'] }; }
  const globs: string[] = Array.isArray(declared)
    ? declared.filter((g): g is string => typeof g === 'string')
    : Array.isArray((declared as { packages?: unknown })?.packages)
      ? ((declared as { packages: unknown[] }).packages.filter((g): g is string => typeof g === 'string'))
      : [];

  // ★ CANDIDATES COME FROM GIT, NOT FROM `readdirSync`. The directory listing sees whatever
  // is on the machine: an untracked `packages/<x>/package.json` could claim a workspace
  // name — even shadow the tracked package that owns it — and a workspace deleted from the
  // working copy would simply not appear, which is how a real dependency silently left the
  // scope in an adversarial review of the first version. Every workspace this knows about
  // is one git holds a manifest for.
  const manifests = [...trackedFiles(root)].filter((f) => f.endsWith('/package.json'));
  for (const glob of globs) {
    const exact = !glob.includes('*');
    const parent = glob.endsWith('/*') ? glob.slice(0, -2) : undefined;
    // A glob form this does not understand contributes nothing, so a recipe naming a
    // package that needed it stays unresolved and the caller refuses.
    if (!exact && parent === undefined) continue;
    for (const manifest of manifests) {
      const dir = manifest.slice(0, -'/package.json'.length);
      if (exact ? dir !== glob : !(dir.startsWith(`${parent}/`) && !dir.slice(parent!.length + 1).includes('/'))) {
        continue;
      }
      try {
        const name = (JSON.parse(readAtHead(manifest, root)) as { name?: unknown }).name;
        if (typeof name === 'string' && name) byName.set(name, dir);
        else unreadable.push(dir);
      } catch { unreadable.push(dir); }
    }
  }
  return { byName, unreadable };
}

/**
 * `JSON.parse` for a tsconfig, which is JSONC and not JSON.
 *
 * ★ MEASURED, as the first thing the resolution below got wrong. `tsconfig.base.json` — the
 * file every workspace in the css recipe extends, and the one that carries `target`,
 * `declaration` and `isolatedModules` — opens with a `//` comment and is 30 lines of prose
 * about `exactOptionalPropertyTypes`. Strict `JSON.parse` threw, the extends chain came
 * back unfollowable, and css collapsed to a refusal again for a reason that had nothing to
 * do with what it ships.
 *
 * Strings are tracked so a `//` inside one survives, and trailing commas are removed after
 * the comments so tsc's tolerance of them is matched. Anything this still cannot parse
 * throws, and every caller turns a throw into a refusal.
 */
function parseJsonc(text: string): unknown {
  let out = '';
  let inString = false;
  let inLine = false;
  let inBlock = false;
  let escaped = false;
  for (let i = 0; i < text.length; i += 1) {
    const c = text[i] as string;
    const next = text[i + 1];
    if (inLine) { if (c === '\n') { inLine = false; out += c; } continue; }
    if (inBlock) { if (c === '*' && next === '/') { inBlock = false; i += 1; } continue; }
    if (inString) {
      out += c;
      if (escaped) escaped = false;
      else if (c === '\\') escaped = true;
      else if (c === '"') inString = false;
      continue;
    }
    if (c === '"') { inString = true; out += c; continue; }
    if (c === '/' && next === '/') { inLine = true; i += 1; continue; }
    if (c === '/' && next === '*') { inBlock = true; i += 1; continue; }
    out += c;
  }
  return JSON.parse(out.replace(/,(\s*[}\]])/g, '$1'));
}

/** Every `./`-relative path a package manifest points at as an entry point. */
function entryPoints(pkg: Record<string, unknown>): string[] {
  const found: string[] = [];
  for (const key of ['main', 'module', 'types', 'typings']) {
    const v = pkg[key];
    if (typeof v === 'string') found.push(v);
  }
  const walk = (node: unknown): void => {
    if (typeof node === 'string') { found.push(node); return; }
    if (node && typeof node === 'object') for (const v of Object.values(node)) walk(v);
  };
  walk(pkg['exports']);
  return found;
}

/**
 * The directories a workspace's OWN manifests say its build produces.
 *
 * Two independent statements of the same fact, unioned: `tsconfig.json`'s `outDir` (what
 * the compiler writes) and the directories `package.json`'s entry points resolve into
 * (what consumers are told to load). A manifest that cannot be read or parsed contributes
 * nothing — which NARROWS this set and so produces a refusal upstream, never a resolution.
 *
 * ★ Read from the working tree, like the Dockerfile above it, not from git. That is safe
 * in the way `tracked()` was NOT: nothing here treats the presence of a file as evidence
 * that a path is diffable. This only answers "which directory does this workspace claim to
 * produce"; whether the answer is tracked is still git's question alone.
 */
export function producedDirs(workspaceDir: string, root: string): string[] {
  const out = new Set<string>();
  const add = (rel: string): void => {
    const clean = rel.replace(/^\.\//, '').replace(/\/+$/, '');
    if (clean === '' || clean === '.' || clean.startsWith('..')) return;
    out.add(`${workspaceDir}/${clean}`);
  };
  // Both reads go through `readAtHead`, so neither an untracked manifest nor an uncommitted
  // edit to a tracked one can widen this. Adding `"main": "./generated/index.js"` to a
  // tracked package.json WITHOUT committing it turned a refusal into a confident answer in
  // an adversarial review of the first version.
  try {
    const tsconfig = parseJsonc(readAtHead(`${workspaceDir}/tsconfig.json`, root)) as
      { compilerOptions?: { outDir?: unknown } };
    if (typeof tsconfig.compilerOptions?.outDir === 'string') add(tsconfig.compilerOptions.outDir);
  } catch { /* no parseable tracked tsconfig: contributes nothing, so the caller refuses */ }
  try {
    const pkg = JSON.parse(readAtHead(`${workspaceDir}/package.json`, root)) as Record<string, unknown>;
    for (const entry of entryPoints(pkg)) {
      if (!entry.startsWith('./')) continue;
      // The DIRECTORY the entry point lives in, not its first segment: `./dist/index.js`
      // gives `dist`, `./dist/sub/x.js` gives `dist/sub`. Taking the first segment would
      // widen the set of paths this will resolve — i.e. resolve MORE untracked COPYs,
      // which is the permissive direction on the question of whether to answer at all.
      const dir = entry.slice(2).split('/').slice(0, -1).join('/');
      if (dir) add(dir);
    }
  } catch { /* no parseable manifest: contributes nothing */ }
  return [...out];
}

/**
 * Every tsconfig in a workspace's `extends` chain, repo-relative.
 *
 * ★ FOUND BY MEASURING THE FIRST VERSION OF THIS RESOLUTION RATHER THAN BY BELIEVING IT.
 * All four workspaces the css recipe touches are `{ "extends": "../../tsconfig.base.json" }`
 * over an outDir, and that shared base is where `target`, `module`, `declaration`,
 * `sourceMap` and `isolatedModules` actually live. Flipping `target` to ES2020 or
 * `declaration` to false rewrites every emitted file in `packages/pgsl-store/dist` — the
 * artifact css ships — with `packages/pgsl-store/` itself byte-identical. The chain leaves
 * the workspace directory, so nothing else in the scope covers it.
 *
 * `undefined` means a relative `extends` could not be followed, which the caller must
 * treat as a refusal: an unread link in the chain is an unknown compiler setting. A
 * PACKAGE-name extends (`@tsconfig/node20`) is not a repository path and is deliberately
 * not chased — it arrives through the lockfile, which is already in scope.
 */
function tsconfigChain(workspaceDir: string, root: string): string[] | undefined {
  const found: string[] = [];
  const seen = new Set<string>();
  const visit = (rel: string): boolean => {
    if (seen.has(rel)) return true;              // a cycle tsc would reject; nothing more to add
    seen.add(rel);
    let text: string;
    try { text = readAtHead(rel, root); } catch { return false; }
    found.push(rel);
    let extendsField: unknown;
    try { extendsField = (parseJsonc(text) as { extends?: unknown }).extends; } catch { return false; }
    const parents = typeof extendsField === 'string' ? [extendsField]
      : Array.isArray(extendsField) ? extendsField.filter((p): p is string => typeof p === 'string')
        : [];
    for (const parent of parents) {
      if (!parent.startsWith('.')) continue;     // a package name, not a path in this tree
      // Resolved against the tsconfig's own directory, and `.json` appended when absent —
      // both are tsc's rules, so the chain this walks is the chain the compiler walks.
      const withExt = parent.endsWith('.json') ? parent : `${parent}.json`;
      const resolved = join(dirname(rel), withExt).split('\\').join('/');
      if (!visit(resolved)) return false;
    }
    return true;
  };
  return visit(`${workspaceDir}/tsconfig.json`) ? found : undefined;
}

/**
 * Every directory ANY workspace in the tree says its build writes.
 *
 * ★ THE `existsSync` CLASS, FOUND ONE LAYER FURTHER DOWN BY AN ADVERSARIAL REVIEW. Whether
 * a COPY source is a build artifact was decided by whether git tracks it — and `tracked()`
 * answers yes for a directory as soon as ONE file under it is tracked. Force-add a
 * `.gitkeep` into a gitignored `dist`, or narrow the `dist/` rule in `.gitignore` (fifteen
 * commits on that file), and the artifact becomes "diffable": the untracked guard stops
 * firing, the recipe is never consulted, and the scope collapses to a directory whose real
 * content git has never seen — `confident: true`, and every change to the source that
 * produced it invisible. Exactly the original bug, reached by a different route.
 *
 * So an artifact is identified by what a workspace CLAIMS TO PRODUCE, which is a statement
 * in a tracked manifest, and never by whether it happens to be in the index.
 *
 * `undefined` means the workspace scan was incomplete, i.e. this cannot rule out that a
 * COPY source is an artifact — which must refuse, not resolve.
 */
const producedIndex = new Map<string, string[] | undefined>();
export function buildArtifactDirs(root: string): string[] | undefined {
  if (producedIndex.has(root)) return producedIndex.get(root);
  const { byName, unreadable } = workspaceScan(root);
  const dirs = unreadable.length > 0 || byName.size === 0
    ? undefined
    : [...new Set([...byName.values()].flatMap((dir) => producedDirs(dir, root)))];
  producedIndex.set(root, dirs);
  return dirs;
}

/** What a `prebuild:` recipe reads, and what it claims to write. */
export interface PrebuildInputs {
  /** Tracked repository paths whose change would change the artifacts the recipe produces. */
  paths: string[];
  /**
   * Paths to DIFF but not to require: files the toolchain auto-discovers at the root and
   * which may legitimately not exist. `git diff` accepts a pathspec matching nothing in
   * either tree, so listing one costs nothing and catches the commit that introduces it.
   */
  optional: string[];
  /** Every directory the recipe's workspaces say they write, used to validate an untracked COPY. */
  produced: string[];
}

/**
 * What the leg's `prebuild:` recipe reads and writes, or a refusal saying why that is unknown.
 *
 * ★ ASKED OF EVERY LEG THAT DECLARES A `prebuild:`, NOT ONLY OF ONE WITH AN UNTRACKED COPY.
 * That is the fix for a fail-open an independent reviewer found in the first version, which
 * only consulted the recipe when a COPY source failed the tracked check. Narrow `dist/` in
 * `.gitignore` and commit `packages/pgsl-store/dist` — a plausible one-line change to a file
 * with fifteen commits — and the untracked check stops firing, the recipe is never read, and
 * `packages/core`, `packages/abac`, `packages/pgsl` and the lockfile all silently DROP OUT of
 * css's scope. CI would still run the prebuild and overwrite the committed dist, so a change
 * to `packages/core/src` would ship different bytes against an unchanged tracked artifact:
 * an empty diff, full confidence, false `equivalent`. A resolution that can disappear is
 * worse than one that can fail, because nothing reports it.
 *
 * Exported so the refusals can be tested directly. Every one of them is a way for this to
 * decline to answer, and a resolution that quietly narrowed a scope instead of declining
 * is the false green this whole file exists to prevent.
 */
export function prebuildInputs(
  prebuild: string, workflowText: string, root: string,
): PrebuildInputs | { reason: string } {
  const refuse = (why: string): { reason: string } => ({ reason: `the \`prebuild: ${prebuild}\` recipe ${why}` });
  const recipe = prebuildRecipe(prebuild, workflowText);
  if (!recipe) {
    return refuse(`has no workflow step gated on \`matrix.prebuild == '${prebuild}'\` that builds a workspace`);
  }

  const { byName: known, unreadable } = workspaceScan(root);
  // ★ An INCOMPLETE workspace map cannot be walked safely. A dependency name that does not
  // appear in it is treated as an external npm package and skipped, so one manifest this
  // could not read at HEAD turns a real workspace dependency into "external" and drops it
  // out of scope silently. An adversarial review did exactly that to `packages/pgsl`.
  if (unreadable.length > 0) {
    return refuse(`cannot be resolved while these workspace manifests are unreadable at HEAD: ${unreadable.join(', ')}`);
  }
  const builtDirs: string[] = [];
  for (const name of recipe.workspaces) {
    const dir = known.get(name);
    if (!dir) return refuse(`builds "${name}", which no workspace in this tree claims`);
    builtDirs.push(dir);
  }

  // Closed over DECLARED workspace dependencies: the compile resolves types through them,
  // so a package the recipe does not name by hand is still an input to the bytes it emits.
  const inScope = new Set(builtDirs);
  const pending = [...recipe.workspaces];
  const seen = new Set(pending);
  while (pending.length > 0) {
    const name = pending.pop() as string;
    const dir = known.get(name);
    if (!dir) return refuse(`builds "${name}", which no workspace in this tree claims`);
    inScope.add(dir);
    let manifest: Record<string, unknown>;
    try {
      manifest = JSON.parse(readAtHead(`${dir}/package.json`, root)) as Record<string, unknown>;
    } catch { return refuse(`cannot read ${dir}/package.json at HEAD, so its dependencies are unknown`); }
    // ★ `optionalDependencies` too. It is a workspace link like any other and tsc resolves
    // through it identically; omitting it dropped a real package from the closure.
    for (const field of ['dependencies', 'devDependencies', 'peerDependencies', 'optionalDependencies']) {
      const deps = manifest[field];
      if (!deps || typeof deps !== 'object') continue;
      for (const dep of Object.keys(deps)) {
        if (known.has(dep) && !seen.has(dep)) { seen.add(dep); pending.push(dep); }
      }
    }
    // ★ THE SUBSTITUTION CLAIMS THE COMPILE IS SELF-CONTAINED, so a build script that
    // reaches OUT of the workspace falsifies it. `"build": "node ../../scripts/build.mjs"`
    // makes a file in `scripts/` an input to the artifact, and nothing in this scope would
    // ever see it change. Today every one of these is a bare `tsc`; the day one is not,
    // this must refuse rather than keep asserting the old claim.
    const build = (manifest['scripts'] as Record<string, unknown> | undefined)?.['build'];
    if (typeof build !== 'string' || build.includes('..')) {
      return refuse(`builds ${dir}, whose "build" script (${String(build)}) is missing or reaches outside `
        + 'the workspace, so its inputs are not the workspace tree alone');
    }
  }

  const paths = [...inScope];
  // Every compiler setting that decides the emitted bytes, including the ones that live
  // OUTSIDE the workspace directory. Measured: all four of these workspaces are a two-line
  // tsconfig over `extends: ../../tsconfig.base.json`, and the base is where `target`,
  // `declaration` and `isolatedModules` actually are.
  for (const dir of inScope) {
    const chain = tsconfigChain(dir, root);
    if (!chain) {
      return refuse(`builds ${dir}, whose tsconfig.json is missing or extends a file this cannot `
        + 'follow, so the compiler settings that decide the emitted bytes are unknown');
    }
    paths.push(...chain);
  }
  // `npm ci` at the root resolves the toolchain, so the lockfile decides which compiler
  // emits these bytes. A typescript bump changes the artifact with every source file
  // identical — the emptiest possible in-scope diff, and a false `equivalent` without this.
  const optional: string[] = [];
  if (recipe.installsFromLockfile) {
    paths.push('package.json', 'package-lock.json');
    // ★ npm reads `.npmrc` from the root whether or not anybody put it in a scope. There is
    // none in this tree today, and that is exactly why it is listed rather than resolved:
    // `install-strategy`, `omit` or `legacy-peer-deps` would change the installed compiler
    // with the lockfile byte-identical, and the commit that ADDS the file has to be visible
    // as a change to a path some scope names.
    optional.push('.npmrc');
  }

  const notTracked = paths.filter((p) => !tracked(p, root));
  if (notTracked.length > 0) {
    return refuse(`resolves to sources git does not track: ${notTracked.join(', ')}`);
  }
  // From the workspaces the recipe BUILDS, not from the dependency closure: only a built
  // workspace has a dist in the build context at all, so a COPY of `packages/pgsl/dist` —
  // a package the recipe never compiles — must stay unexplained rather than borrow this
  // recipe's scope. Narrower here means more refusals, which is the safe direction.
  const produced = builtDirs.flatMap((dir) => producedDirs(dir, root));
  return { paths: [...new Set(paths)], optional, produced };
}

/**
 * Everything `service` ships, as TRACKED paths, or a refusal saying why that is unknown.
 *
 * ★ A COPY source that is NOT in the tree is never silently dropped. `interego-css-pgsl`
 * copies `packages/pgsl-store/dist`, which is gitignored and produced by the matrix leg's
 * own `prebuild` step. A parser that dropped it would compare css against
 * `integrations/pgsl-css-accessor` alone and call it clean while every line of
 * `packages/pgsl-store/src` had changed underneath the compiled output it actually ships.
 *
 * It is either RESOLVED to the tracked sources of the workspaces that produce it — see
 * `producedSources` and the header — or refused. Never skipped.
 */
export function bundlePathsFor(service: string, root = ROOT): BundleScope {
  const decl = Object.hasOwn(SERVICES, service) ? SERVICES[service] : undefined;
  const image = decl?.repo;
  if (!image) return { confident: false, paths: [], reason: `no image declared for "${service}"` };

  let workflowText: string;
  let leg: MatrixLeg | undefined;
  try {
    // `root`, not the module's own ROOT: reading the matrix from one checkout and the
    // Dockerfile it names from another would silently mix two trees. And at HEAD, not off
    // the working tree — deleting a `COPY packages/ ./packages/` line locally, with git
    // untouched, turned a BEHIND relay into `equivalent` in an adversarial review.
    workflowText = readAtHead(WORKFLOW_REL, root);
    leg = matrixLegs(workflowText).get(image);
  } catch (e) {
    return { confident: false, paths: [], reason: `could not read the build matrix: ${(e as Error).message}` };
  }
  if (!leg) return { confident: false, paths: [], reason: `no build-ghcr.yml matrix leg builds "${image}"` };
  const dockerfile = leg.dockerfile;

  let dockerfileText: string;
  try { dockerfileText = readAtHead(dockerfile, root); } catch (e) {
    return { confident: false, paths: [], reason: `could not read ${dockerfile} at HEAD: ${(e as Error).message}` };
  }

  const scope = copySources(dockerfileText);
  if (!scope.confident) return scope;

  // ★ THE THREE FILES NO COPY LINE CAN NAME — see the header. The Dockerfile decides the
  // base image and every RUN (acme-id's entire nginx config is a `RUN printf` inside it);
  // build-ghcr.yml carries the `build_args` that compile a runtime URL into three Vite
  // SPAs; .dockerignore decides what reaches a `context: .` build at all. Each was proven
  // to wave a real commit through as `equivalent` before they were added here.
  scope.paths.push(dockerfile, WORKFLOW_REL, DOCKERIGNORE_REL, GITATTRIBUTES_REL);

  // ★ THE RECIPE IS READ WHENEVER THE LEG DECLARES ONE — see `prebuildInputs`. Making this
  // conditional on an untracked COPY (the first version) means the day the artifact becomes
  // tracked, its sources silently leave the scope with no refusal anywhere.
  let produced: string[] = [];
  let optional: string[] = [];
  if (leg.prebuild) {
    const inputs = prebuildInputs(leg.prebuild, workflowText, root);
    if ('reason' in inputs) {
      return { confident: false, paths: scope.paths, reason: `${dockerfile}: ${inputs.reason}` };
    }
    scope.paths.push(...inputs.paths);
    produced = inputs.produced;
    optional = inputs.optional;
  }

  // A COPY source is an artifact either because git has never seen it, or because some
  // workspace declares that its build WRITES it — the second test is what stops a single
  // tracked file inside a build directory from disguising one. See `buildArtifactDirs`.
  const declared = buildArtifactDirs(root);
  if (!declared) {
    return { confident: false, paths: scope.paths, reason: 'the workspaces of this tree could not be read at HEAD, '
      + 'so whether any COPY source is a build artifact is unknown' };
  }
  const under = (path: string, dirs: string[]): boolean =>
    dirs.some((d) => path === d || path.startsWith(`${d}/`));
  const artifacts = [...new Set(scope.paths.filter((p) => !tracked(p, root) || under(p, declared)))];

  // An artifact is answerable only when one of THIS leg's recipe workspaces says it writes
  // it. Anything else — an artifact on a leg with no recipe, or one no built workspace
  // claims — stays a scope collapse, as before.
  const unexplained = artifacts.filter((p) => !under(p, produced));
  if (unexplained.length > 0) {
    return {
      confident: false,
      paths: scope.paths,
      reason: `${dockerfile} copies ${unexplained.join(', ')}, a build artifact that no `
        + '`prebuild:` recipe of this leg produces — its sources cannot be identified from '
        + 'the Dockerfile alone',
    };
  }
  // The artifact itself leaves the diff set: git cannot compare what it has not got, and
  // the point of resolving it is that every path in a scope is one git can compare between
  // two commits. What it is replaced by is deliberately wider — see the header.
  const kept = scope.paths.filter((p) => !artifacts.includes(p));
  return { confident: true, paths: [...new Set([...kept, ...optional])] };
}

/**
 * Has anything `service` ships changed between `pinSha` and HEAD?
 *
 * The comparison is against HEAD rather than a named branch because the caller has
 * already established which commit it means; railway-pins.mjs counts `behind` the same
 * way, from the same checkout.
 */
export function bundleDriftFor(service: string, pinSha: string, root = ROOT): BundleDrift {
  if (!/^[0-9a-f]{40}$/.test(pinSha)) {
    return { confident: false, changed: [], equivalent: false, reason: `not a 40-hex commit: ${pinSha}` };
  }
  const scope = bundlePathsFor(service, root);
  if (!scope.confident) return { confident: false, changed: [], equivalent: false, reason: scope.reason };

  let out: string;
  try {
    out = execFileSync('git', ['diff', '--name-only', `${pinSha}..HEAD`, '--', ...scope.paths], {
      cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
    });
  } catch (e) {
    return { confident: false, changed: [], equivalent: false, reason: `git diff failed: ${(e as Error).message}` };
  }

  const changed = out.split('\n').map((s) => s.trim()).filter(Boolean);
  return { confident: true, changed, equivalent: changed.length === 0 };
}

/**
 * The single place a `BEHIND` row is allowed to become acceptable, used by BOTH the
 * scoped deploy gate and the fleet audit so the two can never disagree.
 *
 * ── WHY IT REWRITES THE ROW INSTEAD OF ADDING A RULE ─────────────────────────
 *
 * `hasDisagreement` in tools/railway-pins.mjs stays untouched. This returns a row whose
 * `freshness` reads `equivalent` instead of `BEHIND`, and that string is in none of
 * hasDisagreement's lists, so the existing predicate accepts it with no second copy of
 * the rule to drift and no new axis to keep in sync. Every other axis — MISMATCH,
 * STALE-DEPLOY, BELOW-FLOOR, the singleton settings — reaches hasDisagreement exactly as
 * before, and `tests/railway-scoped-check-is-not-weaker.test.ts`'s power-set law is
 * undisturbed because this is still a per-ROW transformation.
 *
 * ── WHAT IT WILL AND WILL NOT DOWNGRADE ──────────────────────────────────────
 *
 * ONLY `BEHIND`, and only on a confident empty bundle diff.
 *
 * ★ `DIVERGED` and `UNKNOWN-COMMIT` are never downgraded, however clean the diff looks.
 * Both mean the pinned commit's relationship to master could not be established at all —
 * `DIVERGED` says it is not an ancestor of HEAD, `UNKNOWN-COMMIT` says this clone has
 * never heard of it — and a diff computed from a commit whose place in history is unknown
 * is not evidence of anything. They are the states a rewritten history or a shallow
 * checkout produces, i.e. exactly when a confident-looking answer would be worth least.
 */
export function refineFreshness(row: PinRow, root = ROOT): RefinedRow {
  if (row.freshness !== 'BEHIND') return row;
  if (!row.tag || !/^[0-9a-f]{40}$/.test(row.tag)) return row;

  const drift = bundleDriftFor(row.service, row.tag, root);
  if (!drift.confident || !drift.equivalent) {
    return { ...row, bundleChanged: drift.changed, bundleReason: drift.reason };
  }
  return {
    ...row,
    freshness: 'equivalent',
    bundleChanged: [],
    bundleReason: `${row.behind} commit(s) behind master, none of which touch anything this service copies into its image`,
  };
}
