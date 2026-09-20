// Keep ONE comment per job on a pull request: find the comment that starts with the marker
// and edit it, else create it. Runs on the GitHub token the workflow already has; nothing is
// printed but the comment URL.
//
//   node tools/upsert-pr-comment.mjs <pr number> <markdown file> "<!-- marker -->"
//
// Needs GH_TOKEN and GITHUB_REPOSITORY, as every Actions job provides them.

import { readFileSync } from 'node:fs';

const [prArg, file, marker] = process.argv.slice(2);
if (!prArg || !file || !marker) {
  process.stderr.write('usage: upsert-pr-comment.mjs <pr number> <markdown file> <marker>\n');
  process.exit(2);
}
const token = process.env['GH_TOKEN'] ?? process.env['GITHUB_TOKEN'];
const repo = process.env['GITHUB_REPOSITORY'];
if (!token || !repo) {
  process.stderr.write('GH_TOKEN (or GITHUB_TOKEN) and GITHUB_REPOSITORY must be set\n');
  process.exit(2);
}
const body = readFileSync(file, 'utf8');
if (!body.startsWith(marker)) {
  process.stderr.write(`the comment body must start with its marker ${marker}\n`);
  process.exit(2);
}
const api = 'https://api.github.com';
const headers = { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28', 'Content-Type': 'application/json' };

async function call(method, path, payload) {
  const res = await fetch(`${api}${path}`, { method, headers, body: payload ? JSON.stringify(payload) : undefined });
  const text = await res.text();
  if (!res.ok) throw new Error(`${method} ${path} responded ${res.status}: ${text.slice(0, 300)}`);
  return text ? JSON.parse(text) : {};
}

let existing;
for (let page = 1; page <= 10 && !existing; page += 1) {
  const comments = await call('GET', `/repos/${repo}/issues/${prArg}/comments?per_page=100&page=${page}`);
  existing = comments.find((c) => typeof c.body === 'string' && c.body.startsWith(marker));
  if (comments.length < 100) break;
}
const result = existing
  ? await call('PATCH', `/repos/${repo}/issues/comments/${existing.id}`, { body })
  : await call('POST', `/repos/${repo}/issues/${prArg}/comments`, { body });
console.log(`${existing ? 'updated' : 'created'} ${result.html_url ?? ''}`);
