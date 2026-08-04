/**
 * What every Railway service is ACTUALLY pinned to, right now, read from Railway.
 *
 * ── THE PROBLEM THIS REPLACES ────────────────────────────────────────────────
 *
 * The live image pin is held in exactly one place — Railway — and nothing in this
 * repository records it. Every attempt to keep a file that records it has misled
 * somebody. `deploy/railway/services.json` is a frozen 2026-07-11 migration snapshot;
 * its `bridge: interego-bridge:pedersen1` line was read as evidence that the live bridge
 * runs a mutable tag and carried as an open item across several sessions, while the
 * service had in fact been pinned to an immutable sha since 2026-07-28. The warning
 * banner written to prevent exactly that then went stale itself, twice, in the clause
 * whose whole job was warning about staleness.
 *
 * A file cannot win this. The pin changes without touching the repository — that is what
 * a deploy IS — so any transcription of it is wrong from the next deploy onward, and no
 * CI job can notice because CI has no Railway credential. So this stops transcribing and
 * asks.
 *
 * ── WHAT IT REPORTS ──────────────────────────────────────────────────────────
 *
 *   IMAGE      the live pin: `serviceInstance.source.image`, the authoritative answer.
 *   TAG        `sha` (immutable, a 40-hex commit) or ★ `mutable` — a mutable tag means
 *              the running code cannot be identified from the pin at all, and a restart
 *              can silently change it. WHICH services are in that state is the report's
 *              answer, not this comment's: the sentence here used to name `css` and its
 *              `redis6` tag, and it went stale the moment css was repinned — inside the
 *              file whose entire argument is that a transcribed pin goes stale.
 *   DEPLOYED   status + date of the deployment that produced it, so "pinned in July and
 *              never redeployed" is visible rather than inferred.
 *   REPO       agreement with tools/railway-services.mjs. This is the half that keeps the
 *              TABLE honest: a service added or renamed in Railway shows up here as a
 *              disagreement instead of as a failed deploy months later.
 *   FRESH      whether the pinned commit is the one master is on. ★ On 2026-08-03
 *              build-ghcr.yml built all fourteen images at 7c9124a and every leg passed;
 *              `relay` was repinned and `foxxi-bridge`, `bridge` and `acme-id` were not.
 *              Nothing recorded that: the build was green, the pin was an immutable sha,
 *              the container was up and answering 200, and this table printed
 *              `sha … SUCCESS … ok` for a service 63 commits behind — a row identical in
 *              every column to relay's, which was current. The tool held that sha, ran
 *              inside a checkout of the repo the sha names, and never compared them.
 *   DEPLOY     whether the CONTAINER can be the pin at all. Writing a pin is a CONFIG
 *              write; only serviceInstanceDeployV2 ships it (tools/railway-redeploy.mjs,
 *              "REDEPLOY ≠ DEPLOY"). ★ `identity` spent five days pinned to a commit whose
 *              live deployment had been created FORTY HOURS BEFORE that commit existed —
 *              arithmetically impossible for an honest deploy. Both timestamps were
 *              already being fetched; nothing compared them.
 *   LIMITS     the live resource-limit override against the measured floors in
 *              tools/railway-services.mjs. A service capped below its floor does not
 *              degrade, it dies in disguise (relay: 502s with empty logs; foxxi-bridge:
 *              a bogus "issuer seed unset").
 *   SINGLETON  whether css's one-container invariant is held by a SETTING rather than by
 *              Railway's platform default.
 *
 * ── THE ONE THING IT DOES NOT DO ─────────────────────────────────────────────
 *
 * It mutates nothing. There is no deploy path through this file, deliberately: the reason
 * people read a stale pin table instead of asking Railway was that asking required either
 * the deploy script or a hand-written GraphQL call, and the deploy script is the one that
 * can break production.
 *
 * ── HTTP 200 IS NOT SUCCESS ──────────────────────────────────────────────────
 *
 * Railway's GraphQL API answers 200 with an `errors` array for every failure, auth
 * included. A reporting tool that ignored that would print a clean empty table on a
 * revoked token, which is worse than the stale file it replaces — an empty table reads
 * like "no drift". Every response is checked, and a failure on any single service is
 * printed in that service's row rather than dropped.
 *
 * ── NO SHEBANG, ON PURPOSE ───────────────────────────────────────────────────
 *
 * This file used to open with `#!/usr/bin/env node`. It is gone because vitest cannot
 * import a module that has one: vite-node strips a shebang only from source it TRANSFORMS,
 * and a `tools/*.mjs` reached from a `tests/*.ts` is not on that path, so the `#` reaches
 * the module wrapper and every importing test dies at collection with
 * `SyntaxError: Invalid or unexpected token` pointing at the IMPORT line — a message that
 * blames the test file and says nothing about this one. Measured: removing the line and
 * changing nothing else turned the failing probe green. The shebang bought nothing here;
 * every invocation in this repository, including the Usage block below and every other
 * file that names this tool, spells `node tools/railway-pins.mjs`, and nothing marks it
 * executable. tools/railway-services.mjs never had one, which is why it was importable
 * from a test and this file was not.
 *
 * Usage:
 *   node tools/railway-pins.mjs                 # table; token from .interego/railway-token.txt
 *   node tools/railway-pins.mjs --json
 *   node tools/railway-pins.mjs --check         # exit 1 if the tracked table disagrees with Railway
 *   RAILWAY_PROJECT_TOKEN=... node tools/railway-pins.mjs
 */

import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import {
  classifyLimit, IMAGE_PREFIX, resolveImageRepo, serviceNames, SERVICES, singletonViolations,
} from './railway-services.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const ENDPOINT = 'https://backboard.railway.com/graphql/v2';
const DEFAULT_TOKEN_FILE = join(ROOT, '.interego', 'railway-token.txt');

/**
 * A project token authenticates with the `Project-Access-Token` header. Sent as
 * `Authorization: Bearer` it returns 200 + "Project Token not found", indistinguishable
 * from sending no credential at all — so the header is fixed here and the env var is
 * named for the token type rather than for the service.
 */
export function railwayGql(token, endpoint = ENDPOINT) {
  return async function gql(query, variables = {}) {
    const r = await fetch(endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Project-Access-Token': token },
      body: JSON.stringify({ query, variables }),
    });
    const j = await r.json();
    if (j?.errors?.length) throw new Error(j.errors.map((e) => e.message).join('; '));
    if (!j?.data) throw new Error(`no data in response (HTTP ${r.status})`);
    return j.data;
  };
}

/**
 * Split `ghcr.io/owner/name:tag` into repository and tag.
 *
 * The last-colon rule is not cosmetic: a registry host may carry a port
 * (`registry:5000/x`), so splitting on the first colon would call `registry` the
 * repository and silently report every pin as disagreeing. A digest pin
 * (`repo@sha256:…`) has no tag at all and must not be shredded at the colon inside the
 * digest — it is reported as a digest, which is immutable and therefore fine.
 */
export function splitImage(ref) {
  const s = String(ref ?? '');
  if (!s) return { repo: '', tag: '', kind: 'none' };
  const at = s.indexOf('@');
  if (at >= 0) return { repo: s.slice(0, at), tag: s.slice(at + 1), kind: 'digest' };
  const colon = s.lastIndexOf(':');
  const slash = s.lastIndexOf('/');
  if (colon < 0 || colon < slash) return { repo: s, tag: '', kind: 'none' };
  const tag = s.slice(colon + 1);
  return { repo: s.slice(0, colon), tag, kind: /^[0-9a-f]{40}$/.test(tag) ? 'sha' : 'mutable' };
}

/**
 * Ask Railway for every service and its live pin.
 *
 * `gql` is injected rather than constructed here so the guards below can be exercised
 * against a double whose services answer DIFFERENTLY from one another. A double that
 * returns one canned answer for every serviceId cannot distinguish a correct
 * implementation from one that queries the same service sixteen times, and a mutation
 * sweep against such a double reports survivors that are really untested code.
 */
export async function collectPins(gql, git = null, commitAt = gitCommitAt) {
  const pt = await gql('{ projectToken { projectId environmentId } }');
  const projectId = pt?.projectToken?.projectId;
  const environmentId = pt?.projectToken?.environmentId;
  if (!projectId || !environmentId) {
    throw new Error('projectToken returned no project/environment — is this an ACCOUNT token rather than a PROJECT token?');
  }

  const proj = await gql(
    'query($id:String!){ project(id:$id){ name services{ edges{ node{ id name } } } } }',
    { id: projectId });
  const nodes = (proj?.project?.services?.edges ?? []).map((e) => e.node);

  const rows = [];
  for (const node of nodes) {
    const row = { service: node.name, serviceId: node.id };
    try {
      const d = await gql(
        'query($s:String!,$e:String!){ serviceInstance(serviceId:$s,environmentId:$e){ source{ image } numReplicas overlapSeconds drainingSeconds latestDeployment{ id status createdAt } } }',
        { s: node.id, e: environmentId });
      const si = d?.serviceInstance;
      row.image = si?.source?.image ?? null;
      // `?? null` collapses "field absent" and "explicitly null" to one value, because
      // singletonViolations distinguishes only unset-vs-set and must not see `undefined`
      // from one code path and `null` from another.
      row.numReplicas = si?.numReplicas ?? null;
      row.overlapSeconds = si?.overlapSeconds ?? null;
      row.drainingSeconds = si?.drainingSeconds ?? null;
      row.status = si?.latestDeployment?.status ?? null;
      row.deployedAt = si?.latestDeployment?.createdAt ?? null;
      // Resolved HERE and not in annotate() so annotate() stays pure — this file already
      // relies on that ("Pure, so it is cheap to mutation-check"), and a git subprocess
      // inside it would make the deploy-agreement rule testable only against a real
      // repository at a particular commit.
      row.pinnedCommitAt = commitAt(splitImage(row.image).tag);
    } catch (e) {
      // Reported in the row, never swallowed: one unreadable service must not turn into a
      // blank cell in a table whose entire purpose is being believed.
      row.error = e.message;
    }

    // ── Resource-limit override, in a SEPARATE request ────────────────────────
    // Not folded into the query above, even though both take the same two arguments and
    // one round trip would do. Railway fails the WHOLE document on one bad field:
    // probing this name as a field of `ServiceInstance` (it is a top-level Query field)
    // answered `Cannot query field "serviceInstanceLimitOverride" on type
    // "ServiceInstance"` and took `source{ image }` down with it for all sixteen
    // services. Sharing a document would mean a Railway rename of the limits field
    // silently blanks the IMAGE column every deploy depends on. Sixteen extra requests
    // buy that independence.
    try {
      const d = await gql(
        'query($s:String!,$e:String!){ serviceInstanceLimitOverride(serviceId:$s,environmentId:$e) }',
        { s: node.id, e: environmentId });
      row.limitOverride = d?.serviceInstanceLimitOverride ?? null;
      const c = classifyLimit(node.name, row.limitOverride);
      row.limitVerdict = c.verdict;
      row.limitReason = c.reason;
    } catch (e) {
      // NOT a pass. A limit that could not be read is unknown, and the one thing this
      // must never do is report "no violation" because it could not look — the same
      // failure this file's header names for a revoked token printing a clean table.
      row.limitVerdict = 'ERROR';
      row.limitReason = e.message;
    }
    rows.push(annotateFreshness(annotate(row), git));
  }

  // A service this repository knows about that Railway does not have is just as much a
  // disagreement as the reverse, and only this direction catches a rename.
  const live = new Set(nodes.map((n) => n.name));
  for (const name of serviceNames()) {
    if (!live.has(name)) {
      rows.push(annotateFreshness(
        annotate({ service: name, serviceId: null, image: null, missingFromRailway: true }), git));
    }
  }

  return { project: proj?.project?.name ?? '(unnamed)', projectId, environmentId, rows };
}

/**
 * The COMMITTER date of a 40-hex sha as ISO-8601, from this clone, or null.
 *
 * %cI, never %aI. A rebased commit keeps its original AUTHOR date, which can predate the
 * commit landing on master by days — using it would quietly widen the window in which a
 * stale container still looks fresh, i.e. it would hide the exact defect this reads for.
 * %cI is when the commit reached the branch build-ghcr.yml builds from, so an honest
 * deployment is always LATER than it.
 *
 * execFileSync with an argv array and no shell: `tag` arrives from the Railway API, and a
 * shell here would make an image pin a command-injection point on an operator's laptop.
 * The 40-hex test refuses anything else before git is invoked at all.
 *
 * null means "this clone cannot answer", NOT "fine" — see deployAgreement().
 */
export function gitCommitAt(tag, root = ROOT) {
  if (!/^[0-9a-f]{40}$/.test(String(tag ?? ''))) return null;
  try {
    const out = execFileSync('git', ['-C', root, 'show', '-s', '--format=%cI', tag],
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
    return out.trim() || null;
  } catch {
    // A sha absent from this clone (shallow clone, unfetched branch) or a sha naming a
    // tree/blob rather than a commit. Both are "cannot answer", handled by the caller.
    return null;
  }
}

/**
 * Is the live container capable of being the commit the service is pinned to?
 *
 * The whole rule is one inequality: a deployment cannot be CREATED before the commit its
 * image was built from. ★ Measured across the fleet on 2026-08-03: fourteen of fifteen
 * sha-pinned services sat 4–6 hours on the correct side of it (build + deploy latency);
 * `identity` sat FORTY HOURS on the wrong side — pinned to a commit stamped
 * 2026-07-30T16:36Z with a live deployment created 2026-07-29T00:27Z. A container created
 * before its source commit existed provably is not running that image, so the pin had
 * been WRITTEN and never SHIPPED (serviceInstanceUpdate without serviceInstanceDeployV2).
 * `--check` exited 0 on that state, and every row read `"agreement": "ok"`, because
 * `agreement` compares the image REPOSITORY and nothing dated the tag.
 *
 * There is no tolerance window, deliberately — a tolerance is a bound, and this is not a
 * flakiness problem. A commit stamped in the future by a skewed developer clock will trip
 * this, and that is the right outcome: the footer prints BOTH timestamps, so skew is
 * legible rather than silently absorbed.
 *
 * UNVERIFIED is a DISAGREEMENT, not a pass. The defect this exists to catch was a
 * can't-tell that read as an agreement; repeating that shape here would be the same bug
 * in a new place.
 */
export function deployAgreement(row) {
  // A mutable tag is already shouted about by its own ★ block, and a digest pin carries
  // no commit to date. Neither is answerable here, and neither is a lie.
  if (!row.builtHere || row.tagKind !== 'sha') return 'n/a';
  if (!row.deployedAt || !row.pinnedCommitAt) return 'UNVERIFIED';
  const deployed = Date.parse(row.deployedAt);
  const committed = Date.parse(row.pinnedCommitAt);
  if (!Number.isFinite(deployed) || !Number.isFinite(committed)) return 'UNVERIFIED';
  return deployed < committed ? 'STALE-DEPLOY' : 'ok';
}

/**
 * Is the pinned commit the one master is on? The axis this file did not have.
 *
 * ★ THE CONCRETE FAILURE. On 2026-08-03 build-ghcr.yml built all fourteen images at
 * 7c9124a and succeeded on every leg. `relay` was repinned; `foxxi-bridge` was not, and
 * neither were `bridge` or `acme-id`. Nothing anywhere recorded that: the build was green,
 * the pin was an immutable sha, the container was up and answering 200, and this report
 * printed `sha … SUCCESS … ok` for a service 63 commits behind — a row identical in every
 * column to relay's, which was current. `annotate()` asks whether the running commit is
 * IDENTIFIABLE and whether the table names the right image REPOSITORY. Both said yes.
 * Neither is the question "is production running master", and once every service was
 * repinned to a sha the mutable-tag alarm went quiet and staleness became the only
 * remaining way to be wrong — the one thing nothing measured.
 *
 * ★ WHY `git` IS INJECTED. Same reason `gql` is. A double can then answer DIFFERENTLY for
 * different shas — behind 0, behind 6, behind 63, not-an-ancestor, not-in-this-clone — and
 * a fold that hardcoded any one of those, or collapsed unknown into diverged, is killed by
 * a case rather than surviving under a double that says the same thing every time.
 *
 * ★ `UNKNOWN-COMMIT` IS NOT `DIVERGED`, and collapsing them is the trap. `git merge-base
 * --is-ancestor` exits 1 for a real non-ancestor and 128 for an object this clone does not
 * have. Treating both as "not an ancestor" reports production as running off-master code
 * every time this runs in a shallow clone or against a squash-merged sha — a false alarm
 * in the tool whose entire value is being believed. Existence is asked first, as its own
 * state.
 */
export function annotateFreshness(row, git) {
  row.freshness = 'n/a';
  row.behind = null;
  row.deployAgreement = deployAgreement(row);
  // A mutable tag or an upstream datastore has no commit to compare; `tagKind` already
  // reports those and this axis must not restate them as a second alarm for one fault.
  if (!row.builtHere || row.tagKind !== 'sha') return row;
  if (!git) { row.freshness = 'UNCHECKED'; return row; }
  if (!git.known(row.tag)) { row.freshness = 'UNKNOWN-COMMIT'; return row; }
  if (!git.isAncestorOfHead(row.tag)) { row.freshness = 'DIVERGED'; return row; }
  const n = git.commitsSince(row.tag);
  row.behind = n;
  row.freshness = n === 0 ? 'current' : 'BEHIND';
  return row;
}

/** Compare one live row against the tracked table. Pure, so it is cheap to mutation-check. */
export function annotate(row) {
  const { repo, tag, kind } = splitImage(row.image);
  row.repo = repo;
  row.tag = tag;
  row.tagKind = kind;

  if (row.missingFromRailway) { row.agreement = 'MISSING'; row.builtHere = false; return row; }
  if (row.error) { row.agreement = 'ERROR'; row.builtHere = false; return row; }

  const expected = resolveImageRepo(row.service);
  // Whether THIS repository builds the image decides what a mutable tag means. On a
  // service we build, it means the running commit is unidentifiable and the fix is to
  // repin to a sha. On `postgres:16` it is the deliberate upstream choice, and telling
  // an operator to repin Postgres to a commit sha of this repo is advice that ends in a
  // datastore replaced by an application.
  row.builtHere = expected.ok;
  if (!expected.ok) {
    // Datastores are known-not-built; anything else is a service Railway has and the
    // tracked table does not, which is the rename/addition case worth shouting about.
    row.agreement = Object.hasOwn(SERVICES, row.service) ? 'upstream' : 'UNTRACKED';
    row.expectedRepo = null;
    return row;
  }
  row.expectedRepo = expected.repo;
  row.agreement = repo === expected.repo ? 'ok' : 'MISMATCH';
  return row;
}

/**
 * True when anything this repository asserts is contradicted by Railway. Drives `--check`.
 *
 * FIVE INDEPENDENT AXES, kept in separate fields rather than folded into `agreement`. A
 * service can have a correct image pin AND an unshipped deploy AND a starved cap at once,
 * and a single field can only report one of them — the one an operator most needs both
 * halves of is exactly the one where two things are wrong.
 *
 * ★ `BEHIND` IS IN HERE ON PURPOSE, AND IT WILL GO RED THE MOMENT master MOVES. That is
 * the correct answer, not noise: `--check` asks "is production running master", and one
 * commit after a merge the answer is no. It is not wired into any pull_request gate — CI
 * holds no Railway credential — so it costs nothing until an operator deliberately asks.
 * Do not soften it with a "more than N commits" threshold: a threshold is a number
 * somebody picks, and the whole class of defect above is a report that answered a weaker
 * question than it appeared to.
 *
 * ★ `UNVERIFIED` and `UNKNOWN`-shaped verdicts COUNT. An exit code that cannot tell the
 * difference between "verified fine" and "could not check" is the failure being fixed.
 */
export function hasDisagreement(rows) {
  return rows.some((r) => r.agreement === 'MISMATCH' || r.agreement === 'MISSING' ||
    r.agreement === 'UNTRACKED' || r.agreement === 'ERROR' ||
    r.freshness === 'BEHIND' || r.freshness === 'DIVERGED' || r.freshness === 'UNKNOWN-COMMIT' ||
    r.deployAgreement === 'STALE-DEPLOY' || r.deployAgreement === 'UNVERIFIED' ||
    r.limitVerdict === 'BELOW-FLOOR' || r.limitVerdict === 'UNKNOWN-FLOOR' ||
    r.limitVerdict === 'UNPARSED' || r.limitVerdict === 'ERROR') ||
    singletonViolations(rows).length > 0;
}

/**
 * The repository is printed without the registry/owner prefix, which is identical on
 * every row and pushed the later columns off the side of an 80-column terminal — a table
 * whose columns collide is a table people stop reading, and the point of this tool is
 * that it gets read instead of services.json. The prefix is stated once in the header so
 * nothing is actually hidden.
 */
function formatTable(result) {
  const out = [];
  out.push(`project ${result.project} (${result.projectId})  environment ${result.environmentId}`);
  out.push(`images below are under ${IMAGE_PREFIX}/ unless shown otherwise`);
  out.push('');
  const w = (s, n) => String(s ?? '').padEnd(n);
  const short = (repo) => (repo.startsWith(`${IMAGE_PREFIX}/`) ? repo.slice(IMAGE_PREFIX.length + 1) : repo);
  out.push(`${w('SERVICE', 20)}${w('IMAGE', 30)}${w('TAG', 44)}${w('DEPLOYED', 22)}${w('FRESH', 14)}REPO`);
  for (const r of [...result.rows].sort((a, b) => a.service.localeCompare(b.service))) {
    if (r.error) { out.push(`${w(r.service, 20)}!! ${r.error}`); continue; }
    if (r.missingFromRailway) { out.push(`${w(r.service, 20)}${w('(no such service in Railway)', 74)}${w('', 22)}${w('', 14)}MISSING`); continue; }
    const deployed = r.status ? `${r.status} ${String(r.deployedAt ?? '').slice(0, 10)}` : '(never deployed)';
    const tag = r.tagKind === 'mutable' ? `${r.tag}  ★mutable` : r.tag || '(no tag)';
    const fresh = r.freshness === 'BEHIND' ? `★behind ${r.behind}` : r.freshness;
    // Appended to the last column rather than added as a new one: the comment above this
    // function is explicit that a column collision at 80 chars is how this table stops
    // being read, and the deploy axis is empty on every honest row.
    const deployFlag = r.deployAgreement === 'STALE-DEPLOY' ? ' ★STALE-DEPLOY'
      : r.deployAgreement === 'UNVERIFIED' ? ' ?unverified' : '';
    out.push(`${w(r.service, 20)}${w(short(r.repo), 30)}${w(tag, 44)}${w(deployed, 22)}${w(fresh, 14)}${r.agreement}${deployFlag}`);
  }

  const mutable = result.rows.filter((r) => r.tagKind === 'mutable' && r.builtHere);
  if (mutable.length) {
    out.push('');
    out.push(`★ ${mutable.length} service(s) pinned to a MUTABLE tag: ${mutable.map((r) => `${r.service} (${r.tag})`).join(', ')}`);
    out.push('  The running code cannot be identified from the pin, and a restart can change it');
    out.push('  without any deploy. Repin to a 40-hex commit sha built by build-ghcr.yml.');
  }
  const upstream = result.rows.filter((r) => r.tagKind === 'mutable' && !r.builtHere && r.agreement === 'upstream');
  if (upstream.length) {
    out.push('');
    out.push(`  (${upstream.map((r) => r.image).join(', ')} float by design — upstream images this repo does not build.)`);
  }
  const stale = result.rows.filter((r) => r.freshness === 'BEHIND' || r.freshness === 'DIVERGED' ||
    r.freshness === 'UNKNOWN-COMMIT');
  if (stale.length) {
    out.push('');
    out.push(`★ ${stale.length} service(s) are NOT running master:`);
    for (const r of stale) {
      out.push(`  ${r.service}: ${r.freshness}${r.behind ? ` by ${r.behind} commit(s)` : ''} — ` +
        'the image may already exist (build-ghcr.yml tags every leg with the commit sha), ' +
        `so this is usually a repin, not a build: node tools/railway-redeploy.mjs ${r.service} <sha>`);
    }
  }

  const unshipped = result.rows.filter((r) => r.deployAgreement === 'STALE-DEPLOY');
  if (unshipped.length) {
    out.push('');
    out.push(`★ ${unshipped.length} service(s) are RUNNING CODE OLDER THAN THEIR OWN PIN:`);
    for (const r of unshipped) {
      out.push(`  ${r.service}: pinned to ${String(r.tag).slice(0, 12)} committed ${r.pinnedCommitAt},`);
      out.push(`    but its live deployment was created ${r.deployedAt} — before that commit existed.`);
    }
    out.push('  Writing a pin ships nothing. Deploy it, and VERIFY:');
    out.push('    node tools/railway-redeploy.mjs <service> <sha> --verify-url https://<host>/health');
  }
  const unverified = result.rows.filter((r) => r.deployAgreement === 'UNVERIFIED');
  if (unverified.length) {
    out.push('');
    out.push(`  (${unverified.map((r) => r.service).join(', ')}: pinned sha not in this clone, or never`);
    out.push('   deployed — the deploy axis is UNKNOWN, which --check treats as a disagreement. Run git fetch.)');
  }

  const singles = singletonViolations(result.rows);
  if (singles.length) {
    out.push('');
    out.push('★ singleton invariant not enforced by a SETTING (tools/railway-services.mjs declares it):');
    for (const v of singles) {
      out.push(`  ${v.service}.${v.setting} = ${v.live === null ? '(unset)' : v.live}, want ${v.want === null ? '(unset)' : v.want} — ${v.why}`);
    }
    out.push('  Note: neither overlapSeconds nor drainingSeconds CLOSES the two-container');
    out.push('  deploy window; Railway starts the new container before stopping the old.');
  }

  const bad = result.rows.filter((r) => ['MISMATCH', 'MISSING', 'UNTRACKED', 'ERROR'].includes(r.agreement));
  if (bad.length) {
    out.push('');
    out.push('★ tools/railway-services.mjs disagrees with Railway — the TABLE is what needs fixing:');
    for (const r of bad) {
      out.push(`  ${r.service}: ${r.agreement}` +
        (r.expectedRepo ? ` (table says ${r.expectedRepo}, Railway runs ${r.repo})` : '') +
        (r.error ? ` (${r.error})` : ''));
    }
  }

  // Printed as its own section rather than a column, for the reason above: this table
  // stops being read the moment its columns collide.
  const limitBad = result.rows.filter((r) =>
    ['BELOW-FLOOR', 'UNKNOWN-FLOOR', 'UNPARSED', 'ERROR'].includes(r.limitVerdict));
  out.push('');
  if (limitBad.length) {
    out.push('★ RESOURCE LIMIT OVERRIDES — a service capped below its floor dies in disguise:');
    for (const r of limitBad) out.push(`  ${r.service}: ${r.limitVerdict} — ${r.limitReason}`);
    out.push('  Floors and what each starved service looks like: tools/railway-services.mjs LIMIT_FLOORS.');
  } else {
    const overridden = result.rows.filter((r) => r.limitVerdict === 'ok').length;
    out.push(`limits: no override below floor (${overridden} overridden at/above floor, ` +
      `${result.rows.filter((r) => r.limitVerdict === 'none').length} with no override).`);
  }
  return out.join('\n');
}

/**
 * The token file is read only when the env var is absent, and the SOURCE is printed (never
 * the token). A tool that silently falls back to an on-disk credential is one that reports
 * a different project than the operator believes they asked about.
 */
function loadToken(argv) {
  if (process.env.RAILWAY_PROJECT_TOKEN) {
    return { token: process.env.RAILWAY_PROJECT_TOKEN.trim(), source: 'env RAILWAY_PROJECT_TOKEN' };
  }
  const i = argv.indexOf('--token-file');
  const file = i >= 0 ? argv[i + 1] : DEFAULT_TOKEN_FILE;
  if (i >= 0 && !file) throw new Error('--token-file needs a path');
  let raw;
  try {
    raw = readFileSync(file, 'utf8');
  } catch {
    throw new Error(`no RAILWAY_PROJECT_TOKEN in the environment and ${file} is unreadable`);
  }
  const token = raw.trim();
  // An empty or whitespace-only file would otherwise be sent as a valid-looking empty
  // header and come back as a 200 with an auth error, i.e. as "drift".
  if (!token) throw new Error(`${file} is empty — it must hold a Railway PROJECT token`);
  return { token, source: file };
}

/**
 * The real git facts. Kept thin and at the CLI boundary because it is the only
 * unexercisable part: `annotateFreshness` holds every decision and takes these as data.
 * `stdio: 'pipe'` so a missing object prints nothing to the operator's terminal — the
 * caller turns the non-zero exit into a STATE, and a stray "fatal:" reads like a crash.
 */
export function gitFacts(cwd = ROOT) {
  const run = (args) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  const ok = (args) => { try { run(args); return true; } catch { return false; } };
  let head;
  try { head = run(['rev-parse', 'HEAD']); } catch { return null; }
  return {
    head,
    known: (sha) => ok(['cat-file', '-e', `${sha}^{commit}`]),
    isAncestorOfHead: (sha) => ok(['merge-base', '--is-ancestor', sha, 'HEAD']),
    commitsSince: (sha) => Number(run(['rev-list', '--count', `${sha}..HEAD`])),
  };
}

async function main(argv) {
  const { token, source } = loadToken(argv);
  const json = argv.includes('--json');
  if (!json) console.error(`# token from ${source}`);
  const result = await collectPins(railwayGql(token), gitFacts());
  console.log(json ? JSON.stringify(result, null, 2) : formatTable(result));
  if (argv.includes('--check') && hasDisagreement(result.rows)) return 1;
  return 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    process.exit(await main(process.argv.slice(2)));
  } catch (e) {
    console.error(`error: ${e.message}`);
    process.exit(2);
  }
}
