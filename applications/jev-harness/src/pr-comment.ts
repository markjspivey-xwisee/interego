/**
 * The pull-request comment the CI jobs leave: the verdict where a reviewer reads it, with the
 * hazards that fired and links to the descriptor on the pod, instead of a red check whose
 * reasons live in a job log. Pure: it turns the follower's saved results into Markdown, and the
 * workflow posts it.
 */

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

export interface SavedResult {
  readonly verb: string;
  readonly body: Record<string, unknown>;
}

/** The newest saved result per verb under the follower's output directory. */
export function loadSavedResults(dir: string): SavedResult[] {
  let names: string[];
  try { names = readdirSync(dir).filter((f) => f.endsWith('.json')); } catch { return []; }
  const newest = new Map<string, { verb: string; file: string; mtime: number }>();
  for (const file of names) {
    // Saved as <verb>-<judgment id>.json, the id being <base36 time>-<6 hex>, or a bare time.
    const verb = file.replace(/-[a-z0-9]+(?:-[a-f0-9]{6})?\.json$/, '');
    const mtime = statSync(join(dir, file)).mtimeMs;
    const prev = newest.get(verb);
    if (!prev || mtime > prev.mtime) newest.set(verb, { verb, file, mtime });
  }
  return [...newest.values()].map(({ verb, file }) => ({ verb, body: JSON.parse(readFileSync(join(dir, file), 'utf8')) as Record<string, unknown> }));
}

export interface CommentLinks {
  /** Public origin that serves the pod (the internal storage host is rewritten to it). */
  readonly podPublicOrigin?: string;
  readonly relayOrigin?: string;
  readonly podName?: string;
}

/** The public URL of a descriptor the relay answered with, and the relay's rendered view of it. */
export function descriptorLinks(descriptorUrl: string, links: CommentLinks): { descriptor: string; render?: string } {
  let descriptor = descriptorUrl;
  try {
    const u = new URL(descriptorUrl);
    if (links.podPublicOrigin && /^css\.railway\.internal(:\d+)?$/.test(u.host)) descriptor = `${links.podPublicOrigin.replace(/\/$/, '')}${u.pathname}`;
  } catch { /* not a URL: leave it */ }
  const slug = /\/([^/]+)\.ttl$/.exec(descriptorUrl)?.[1];
  const pod = links.podName ?? /\/([^/]+)\/context-graphs\//.exec(descriptorUrl)?.[1];
  const render = links.relayOrigin && slug && pod ? `${links.relayOrigin.replace(/\/$/, '')}/render/${encodeURIComponent(`urn:iep:${pod}:${slug}`)}` : undefined;
  return render ? { descriptor, render } : { descriptor };
}

const str = (v: unknown): string => (typeof v === 'string' ? v : '');
const num = (v: unknown): number | undefined => (typeof v === 'number' ? v : undefined);

function publishLine(body: Record<string, unknown>, links: CommentLinks): string {
  const publish = body['publish'] as { status?: string; descriptorUrl?: string; error?: string } | undefined;
  if (!publish || publish.status !== 'published' || !publish.descriptorUrl) {
    return publish?.status === 'failed' ? `_Publishing to the pod failed: ${publish.error ?? 'unknown error'}._` : '_Not published to the pod (no agent key in this run)._';
  }
  const l = descriptorLinks(publish.descriptorUrl, links);
  return `On the pod: [signed descriptor](${l.descriptor})${l.render ? ` · [rendered view](${l.render})` : ''}`;
}

/** The review-gate comment. */
export function gateComment(body: Record<string, unknown>, links: CommentLinks = {}): string {
  const j = (body['judgment'] ?? {}) as Record<string, unknown>;
  const verdict = str(j['verdict']) || 'unknown';
  const icon = verdict === 'auto-ok' ? '✅' : verdict === 'block' ? '⛔' : '👀';
  const meaning = verdict === 'auto-ok'
    ? 'nothing here needs a person before merging'
    : verdict === 'block'
      ? 'do not merge until the reason below is gone'
      : 'a person should read this diff before it merges';
  const lines: string[] = [];
  lines.push('<!-- jev-harness:review-gate -->');
  lines.push(`### ${icon} Review gate: **${verdict}**`);
  lines.push('');
  lines.push(`${meaning}. Confidence ${num(j['confidence']) ?? '?'}, model ${str(j['model']) || '?'}.`);
  const reasons = (j['reasons'] as string[] | undefined) ?? [];
  if (reasons.length > 0) {
    lines.push('');
    lines.push('**Why**');
    for (const r of reasons) lines.push(`- ${r}`);
  }
  const hazards = (j['hazards'] as Array<{ name: string; probability: number; fired: boolean; threshold?: number }> | undefined) ?? [];
  if (hazards.length > 0) {
    lines.push('');
    lines.push('| Hazard | Probability | |');
    lines.push('| --- | ---: | --- |');
    for (const h of hazards) lines.push(`| ${h.name} | ${h.probability.toFixed(2)} | ${h.fired ? '**fired**' : ''} |`);
  }
  const dm = num(j['descriptionMatch']);
  if (dm !== undefined) {
    lines.push('');
    lines.push(`Description match ${dm.toFixed(2)} (how well the diff matches the description you wrote).`);
  }
  lines.push('');
  lines.push(publishLine(body, links));
  const url = str(body['url']);
  if (url && !url.includes('localhost')) lines.push(`Judgment: ${url}`);
  lines.push('');
  lines.push('_Judged by the jev-harness vertical (a System One model, policy in code). Outcomes you record supersede this verdict on the pod._');
  return lines.join('\n');
}

/** The selection-and-run comment: which tests ran and why, the run, the triage when it failed. */
export function selectionComment(results: readonly SavedResult[], links: CommentLinks = {}): string {
  const by = (verb: string) => results.find((r) => r.verb === verb)?.body;
  const sel = by('select-tests');
  const lines: string[] = ['<!-- jev-harness:selection -->'];
  if (!sel) {
    lines.push('### 🧪 Test selection: no result saved');
    return lines.join('\n');
  }
  const j = (sel['judgment'] ?? {}) as Record<string, unknown>;
  const mode = str(j['mode']) || 'unknown';
  const tests = (j['tests'] as Array<{ path: string; selectedBy?: string }> | undefined) ?? [];
  const reasons = (j['reasons'] as string[] | undefined) ?? [];
  lines.push(`### 🧪 Test selection: **${mode === 'full' ? 'whole suite' : `${tests.length} test file(s)`}**`);
  lines.push('');
  for (const r of reasons) lines.push(`- ${r}`);
  if (mode !== 'full' && tests.length > 0) {
    lines.push('');
    const byHow = new Map<string, number>();
    for (const t of tests) byHow.set(t.selectedBy ?? 'unknown', (byHow.get(t.selectedBy ?? 'unknown') ?? 0) + 1);
    lines.push([...byHow.entries()].map(([how, n]) => `${n} by ${how}`).join(', ') + '.');
    lines.push('');
    lines.push('<details><summary>Selected tests</summary>');
    lines.push('');
    for (const t of tests.slice(0, 60)) lines.push(`- \`${t.path}\``);
    if (tests.length > 60) lines.push(`- … and ${tests.length - 60} more`);
    lines.push('');
    lines.push('</details>');
  }
  const triage = by('triage');
  if (triage) {
    const tj = (triage['judgment'] ?? {}) as Record<string, unknown>;
    const failures = (tj['failures'] as Array<{ id: string; file?: string; name?: string; causeClass: string; confidence: number; action: string }> | undefined) ?? [];
    lines.push('');
    lines.push(`**The run failed; ${failures.length} failure(s) triaged**`);
    lines.push('');
    lines.push('| Failure | Cause | Confidence | Suggested action |');
    lines.push('| --- | --- | ---: | --- |');
    for (const f of failures.slice(0, 20)) lines.push(`| ${f.file ? `\`${f.file}\`` : f.id}${f.name ? ` › ${f.name}` : ''} | ${f.causeClass} | ${f.confidence.toFixed(2)} | ${f.action} |`);
  } else {
    lines.push('');
    lines.push('The run passed, so nothing was triaged.');
  }
  const outcome = by('record-outcome');
  if (outcome) {
    const oj = (outcome['judgment'] ?? {}) as Record<string, unknown>;
    const summary = str(oj['summary']);
    if (summary) { lines.push(''); lines.push(`Outcome recorded: ${summary}`); }
  }
  lines.push('');
  lines.push(publishLine(sel, links));
  lines.push('');
  lines.push('_Selected by the jev-harness vertical: the import graph and name affinity decide deterministically, the model adds tests that cover a change without importing it, and policy runs the whole suite when a sensitive path changes._');
  return lines.join('\n');
}
