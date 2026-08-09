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
 */

import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
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
  /** Context-relative paths this service's Dockerfile copies. */
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

/**
 * image name → Dockerfile path, read out of the build matrix.
 *
 * Deliberately the same file `validate-input` reads its list of legal image names from,
 * and for the same reason given there: "Read the names out of this file so the check
 * cannot drift from the matrix."
 */
export function matrixDockerfiles(workflowText?: string): Map<string, string> {
  const text = workflowText ?? readFileSync(WORKFLOW, 'utf8');
  const out = new Map<string, string>();
  // Matches a matrix leg: `- { image: interego-relay, dockerfile: deploy/Dockerfile.relay ... }`
  // The `dockerfile:` value runs to the next comma or the closing brace, so legs carrying
  // `build_args:` or `prebuild:` after it parse identically to the bare ones.
  const leg = /^-\s*\{\s*image:\s*([a-z0-9-]+)\s*,\s*dockerfile:\s*([^,}\s]+)/;
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
    if (image && dockerfile) out.set(image, dockerfile);
  }
  return out;
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
 */
function tracked(path: string, root: string): boolean {
  try {
    const out = execFileSync('git', ['ls-tree', '--name-only', 'HEAD', path], {
      cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'],
    });
    return out.trim().length > 0;
  } catch { return false; }
}

/**
 * Everything `service` copies into its image, or a refusal saying why that is unknown.
 *
 * ★ A COPY source that is NOT in the tree is a refusal, not a skip. `interego-css-pgsl`
 * copies `packages/pgsl-store/dist`, which is gitignored and produced by the matrix leg's
 * own `prebuild` step. A parser that quietly dropped it would compare css against
 * `integrations/pgsl-css-accessor` alone and call it clean while every line of
 * `packages/pgsl-store/src` had changed underneath the compiled output it actually ships.
 */
export function bundlePathsFor(service: string, root = ROOT): BundleScope {
  const decl = Object.hasOwn(SERVICES, service) ? SERVICES[service] : undefined;
  const image = decl?.repo;
  if (!image) return { confident: false, paths: [], reason: `no image declared for "${service}"` };

  let dockerfile: string | undefined;
  try {
    // `root`, not the module's own ROOT: reading the matrix from one checkout and the
    // Dockerfile it names from another would silently mix two trees.
    dockerfile = matrixDockerfiles(readFileSync(join(root, WORKFLOW_REL), 'utf8')).get(image);
  } catch (e) {
    return { confident: false, paths: [], reason: `could not read the build matrix: ${(e as Error).message}` };
  }
  if (!dockerfile) return { confident: false, paths: [], reason: `no build-ghcr.yml matrix leg builds "${image}"` };

  const full = join(root, dockerfile);
  if (!existsSync(full)) return { confident: false, paths: [], reason: `${dockerfile} does not exist` };

  const scope = copySources(readFileSync(full, 'utf8'));
  if (!scope.confident) return scope;

  // ★ THE THREE FILES NO COPY LINE CAN NAME — see the header. The Dockerfile decides the
  // base image and every RUN (acme-id's entire nginx config is a `RUN printf` inside it);
  // build-ghcr.yml carries the `build_args` that compile a runtime URL into three Vite
  // SPAs; .dockerignore decides what reaches a `context: .` build at all. Each was proven
  // to wave a real commit through as `equivalent` before they were added here.
  scope.paths.push(dockerfile, WORKFLOW_REL, DOCKERIGNORE_REL, GITATTRIBUTES_REL);

  const missing = scope.paths.filter((p) => !tracked(p, root));
  if (missing.length > 0) {
    return {
      confident: false,
      paths: scope.paths,
      reason: `${dockerfile} copies ${missing.join(', ')}, which git does not track — `
        + 'a build-time artifact whose sources cannot be identified from the Dockerfile alone',
    };
  }
  return scope;
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
