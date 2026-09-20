/**
 * Print the pull-request comment for a CI job from the follower's saved results.
 *
 *   npx tsx bin/pr-comment.ts gate      --dir <repo>/.jev-harness/follower [--relay <mcp url>] [--pod <name>] [--pod-public-origin <origin>]
 *   npx tsx bin/pr-comment.ts selection --dir <repo>/.jev-harness/follower [...]
 *
 * The workflow pipes the output into tools/upsert-pr-comment.mjs, which keeps one comment per
 * job on the pull request, keyed on the HTML marker the comment starts with. The link flags
 * turn the relay's internal descriptor URL into links a person can open; the workflow passes
 * them from its own environment.
 */

import { resolve } from 'node:path';
import { gateComment, loadSavedResults, selectionComment, type CommentLinks } from '../src/pr-comment.js';
import { DEFAULT_RELAY_URL } from '../src/publish.js';

function flag(args: readonly string[], name: string): string | undefined {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
}

function main(): void {
  const args = process.argv.slice(2);
  const job = args[0];
  const dir = resolve(flag(args, '--dir') ?? '.jev-harness/follower');
  const relayUrl = flag(args, '--relay') ?? DEFAULT_RELAY_URL;
  const pod = flag(args, '--pod');
  const podPublicOrigin = flag(args, '--pod-public-origin');
  const links: CommentLinks = {
    relayOrigin: new URL(relayUrl).origin,
    ...(podPublicOrigin ? { podPublicOrigin } : {}),
    ...(pod ? { podName: pod } : {}),
  };
  const results = loadSavedResults(dir);
  if (job === 'gate') {
    const gate = results.find((r) => r.verb === 'review-gate');
    process.stdout.write(gate ? gateComment(gate.body, links) : '<!-- jev-harness:review-gate -->\n### Review gate: no verdict was saved\n\nThe bridge did not answer; see the job log.\n');
    return;
  }
  if (job === 'selection') {
    process.stdout.write(selectionComment(results, links));
    return;
  }
  process.stderr.write('usage: pr-comment.ts gate|selection [--dir <follower output dir>] [--relay <url>] [--pod <name>] [--pod-public-origin <origin>]\n');
  process.exit(2);
}

main();
