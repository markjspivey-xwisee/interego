/**
 * Record the outcomes of a closed pull request's judgments through a bridge.
 *
 *   npx tsx bin/outcomes-on-close.ts --pr <number> --repo <owner/name> --bridge http://localhost:6090 \
 *     --merged true|false --base <sha> --head <sha> --workspace <checkout>
 *
 * Reads the pull request's comments (GH_TOKEN), finds the judgments the harness's own comments
 * name, works out the files the pull request changed, and posts an outcome for each judgment
 * to the bridge, which reads the judgment back from the pod and publishes the outcome as the
 * Asserted head of its chain. Prints one line per judgment. Exits 1 only when the bridge
 * could not be reached at all; a judgment the pod no longer holds is reported, not fatal.
 */

import { execFileSync } from 'node:child_process';
import { AUTO_MERGED_LABEL } from '../src/auto-merge.js';
import { outcomeRequests } from '../src/outcomes-on-close.js';

function flag(name: string): string | undefined {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

async function comments(repo: string, pr: string, token: string): Promise<string[]> {
  const bodies: string[] = [];
  for (let page = 1; page <= 10; page += 1) {
    const res = await fetch(`https://api.github.com/repos/${repo}/issues/${pr}/comments?per_page=100&page=${page}`, {
      headers: { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28' },
    });
    if (!res.ok) throw new Error(`GitHub comments responded ${res.status}`);
    const list = await res.json() as Array<{ body?: string }>;
    for (const c of list) if (typeof c.body === 'string') bodies.push(c.body);
    if (list.length < 100) break;
  }
  return bodies;
}

function filesChanged(workspace: string, base: string, head: string): string[] {
  try {
    execFileSync('git', ['fetch', '--no-tags', '--depth=1', 'origin', base, head], { cwd: workspace, stdio: 'ignore' });
  } catch { /* the refs may already be present, or one may be gone: the diff below decides */ }
  try {
    return execFileSync('git', ['diff', '--name-only', `${base}...${head}`], { cwd: workspace, encoding: 'utf8' }).split('\n').filter(Boolean);
  } catch {
    return [];
  }
}

/**
 * The files a pull request changed, from the API. Measured on the first merged pull request
 * this job scored (#424): the workflow passes base.sha and head.sha, but at the closed event
 * the base branch already holds the merge, so `base...head` named no file and the navigation
 * judgments went unscored. The API lists the pull request's own files whatever the merge method.
 */
async function prFiles(repo: string, pr: string, token: string): Promise<string[]> {
  const out: string[] = [];
  for (let page = 1; page <= 30; page += 1) {
    const res = await fetch(`https://api.github.com/repos/${repo}/pulls/${pr}/files?per_page=100&page=${page}`, {
      headers: { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json' },
    });
    if (!res.ok) throw new Error(`${res.status} listing the pull request's files`);
    const rows = await res.json() as Array<{ filename?: string }>;
    for (const r of rows) if (typeof r.filename === 'string') out.push(r.filename);
    if (rows.length < 100) break;
  }
  return out;
}

/** The pull request's labels: the auto-merge job leaves AUTO_MERGED_LABEL on what it merged. */
async function prLabels(repo: string, pr: string, token: string): Promise<string[]> {
  const res = await fetch(`https://api.github.com/repos/${repo}/pulls/${pr}`, {
    headers: { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json' },
  });
  if (!res.ok) throw new Error(`${res.status} reading the pull request`);
  const body = await res.json() as { labels?: Array<{ name?: string }> };
  return (body.labels ?? []).map((l) => l.name).filter((n): n is string => typeof n === 'string');
}

async function main(): Promise<void> {
  const pr = flag('--pr');
  const repo = flag('--repo');
  const bridge = (flag('--bridge') ?? 'http://localhost:6090').replace(/\/$/, '');
  const merged = flag('--merged') === 'true';
  const base = flag('--base');
  const head = flag('--head');
  const workspace = flag('--workspace') ?? process.cwd();
  const token = process.env['GH_TOKEN'] ?? process.env['GITHUB_TOKEN'];
  if (!pr || !repo || !token) { console.error('usage: --pr <n> --repo <owner/name> [--bridge <url>] --merged true|false --base <sha> --head <sha> [--workspace <dir>], with GH_TOKEN set'); process.exit(2); }
  const bodies = await comments(repo, pr, token);
  const changed = await prFiles(repo, pr, token).catch((err: Error) => {
    console.log(`the API did not list the files (${err.message}); diffing ${base ?? '?'}...${head ?? '?'} instead`);
    return base && head ? filesChanged(workspace, base, head) : [];
  });
  const autoMerged = merged && (await prLabels(repo, pr, token).catch((err: Error) => {
    console.log(`the labels could not be read (${err.message}); treating the merge as a person's`);
    return [] as string[];
  })).includes(AUTO_MERGED_LABEL);
  const requests = outcomeRequests(bodies, { merged, filesChanged: changed, autoMerged });
  console.log(`pull request ${pr}: ${merged ? (autoMerged ? 'merged automatically, so the verdict is not scored as a person\'s decision' : 'merged') : 'closed without merging'}, ${changed.length} file(s) changed, ${requests.length} judgment(s) to score`);
  let unreachable = false;
  for (const r of requests) {
    try {
      const res = await fetch(`${bridge}/jev-harness/outcome`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(r.body) });
      const text = await res.text();
      if (!res.ok) { console.log(`  ${r.kind} ${r.graphIri}: ${res.status} ${text.slice(0, 160)}`); continue; }
      const out = JSON.parse(text) as { judgment?: { summary?: string }; publish?: { status?: string; descriptorUrl?: string } };
      console.log(`  ${r.kind} ${r.graphIri}: ${out.judgment?.summary ?? 'recorded'}; publish ${out.publish?.status ?? '?'}${out.publish?.descriptorUrl ? ` ${out.publish.descriptorUrl}` : ''}`);
    } catch (err) {
      unreachable = true;
      console.log(`  ${r.kind} ${r.graphIri}: bridge unreachable: ${(err as Error).message}`);
    }
  }
  if (requests.length > 0 && !unreachable) {
    // The outcomes just recorded changed the view: publish it, and the attestation it grounds.
    try {
      const res = await fetch(`${bridge}/jev-harness/calibration/publish`, { method: 'POST' });
      const out = await res.json() as { status?: string; calibrationUrl?: string; attestationUrl?: string; error?: string };
      console.log(`calibration: ${out.status ?? res.status}${out.calibrationUrl ? ` ${out.calibrationUrl}` : ''}${out.attestationUrl ? `; attestation ${out.attestationUrl}` : ''}${out.error ? `: ${out.error}` : ''}`);
    } catch (err) {
      console.log(`calibration: bridge unreachable: ${(err as Error).message}`);
    }
  }
  if (unreachable) process.exit(1);
}

main().catch((err) => { console.error(err instanceof Error ? err.message : String(err)); process.exit(1); });
