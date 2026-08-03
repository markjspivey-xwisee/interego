#!/usr/bin/env node
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
 *              can silently change it. `css` is pinned to `interego-css-pgsl:redis6`.
 *   DEPLOYED   status + date of the deployment that produced it, so "pinned in July and
 *              never redeployed" is visible rather than inferred.
 *   REPO       agreement with tools/railway-services.mjs. This is the half that keeps the
 *              TABLE honest: a service added or renamed in Railway shows up here as a
 *              disagreement instead of as a failed deploy months later.
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
 * Usage:
 *   node tools/railway-pins.mjs                 # table; token from .interego/railway-token.txt
 *   node tools/railway-pins.mjs --json
 *   node tools/railway-pins.mjs --check         # exit 1 if the tracked table disagrees with Railway
 *   RAILWAY_PROJECT_TOKEN=... node tools/railway-pins.mjs
 */

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { IMAGE_PREFIX, resolveImageRepo, serviceNames, SERVICES } from './railway-services.mjs';

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
export async function collectPins(gql) {
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
        'query($s:String!,$e:String!){ serviceInstance(serviceId:$s,environmentId:$e){ source{ image } latestDeployment{ id status createdAt } } }',
        { s: node.id, e: environmentId });
      const si = d?.serviceInstance;
      row.image = si?.source?.image ?? null;
      row.status = si?.latestDeployment?.status ?? null;
      row.deployedAt = si?.latestDeployment?.createdAt ?? null;
    } catch (e) {
      // Reported in the row, never swallowed: one unreadable service must not turn into a
      // blank cell in a table whose entire purpose is being believed.
      row.error = e.message;
    }
    rows.push(annotate(row));
  }

  // A service this repository knows about that Railway does not have is just as much a
  // disagreement as the reverse, and only this direction catches a rename.
  const live = new Set(nodes.map((n) => n.name));
  for (const name of serviceNames()) {
    if (!live.has(name)) {
      rows.push(annotate({ service: name, serviceId: null, image: null, missingFromRailway: true }));
    }
  }

  return { project: proj?.project?.name ?? '(unnamed)', projectId, environmentId, rows };
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

/** True when anything the table asserts is contradicted by Railway. Drives `--check`. */
export function hasDisagreement(rows) {
  return rows.some((r) => r.agreement === 'MISMATCH' || r.agreement === 'MISSING' ||
    r.agreement === 'UNTRACKED' || r.agreement === 'ERROR');
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
  out.push(`${w('SERVICE', 20)}${w('IMAGE', 30)}${w('TAG', 44)}${w('DEPLOYED', 22)}REPO`);
  for (const r of [...result.rows].sort((a, b) => a.service.localeCompare(b.service))) {
    if (r.error) { out.push(`${w(r.service, 20)}!! ${r.error}`); continue; }
    if (r.missingFromRailway) { out.push(`${w(r.service, 20)}${w('(no such service in Railway)', 74)}${w('', 22)}MISSING`); continue; }
    const deployed = r.status ? `${r.status} ${String(r.deployedAt ?? '').slice(0, 10)}` : '(never deployed)';
    const tag = r.tagKind === 'mutable' ? `${r.tag}  ★mutable` : r.tag || '(no tag)';
    out.push(`${w(r.service, 20)}${w(short(r.repo), 30)}${w(tag, 44)}${w(deployed, 22)}${r.agreement}`);
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

async function main(argv) {
  const { token, source } = loadToken(argv);
  const json = argv.includes('--json');
  if (!json) console.error(`# token from ${source}`);
  const result = await collectPins(railwayGql(token));
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
