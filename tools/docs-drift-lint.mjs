#!/usr/bin/env node
/**
 * docs-drift-lint — fail when the docs describe infrastructure that no longer exists.
 *
 * ★ WHY THIS IS A GATE AND NOT A SWEEP. The Azure→Railway migration's documentation was
 * "fixed" twice. The first pass corrected the deploy-instructions section; the live-services
 * table twenty lines above it still said three services were "**live on Azure**" and still
 * pinned two "Current live image: contextgraphsacr.azurecr.io/..." references — naming the
 * exact registry the paragraph below it described as deleted. The verification performed was
 * "deploy-azure.yml is absent from the tree", which is a different claim from the one the
 * item made, and it passed while the file contradicted itself.
 *
 * A doc claim that has to be re-checked by hand gets re-checked once. This makes it
 * checkable: a banned string anywhere outside an explicitly-marked historical block fails
 * CI, so the next migration cannot leave the same residue.
 *
 * ★ HOW TO KEEP A HISTORICAL REFERENCE. Prose explaining what USED to be true is valuable —
 * README's "this section previously described a deploy-azure.yml" note is exactly the sort
 * of thing that stops a maintainer re-deriving a dead path. Mark such a line with the
 * HISTORICAL_MARKERS below (a blockquote `>` or an explicit past-tense marker) and it is
 * exempt. The rule is not "never mention Azure"; it is "never mention it in the present
 * tense as though it were live".
 *
 * Run: node tools/docs-drift-lint.mjs
 * Exit: 0 clean, 1 drift found.
 */

import { readFileSync } from 'node:fs';

/** Files whose claims describe the CURRENT deployment. */
const FILES = ['README.md', 'STATUS.md'];

/**
 * Strings that assert a dead platform in the present tense.
 * Keep the reason with the pattern — a banned string with no reason gets deleted by the
 * next person who trips over it.
 */
const BANNED = [
  {
    pattern: /contextgraphsacr/,
    why: 'the Azure Container Registry was deleted; images are on ghcr.io',
  },
  {
    pattern: /live on Azure/i,
    why: 'the whole fleet runs on Railway at *.interego.xwisee.com',
  },
  {
    pattern: /Publicly-hosted Azure deployment/i,
    why: 'the hosted reference is a Railway deployment',
  },
  {
    pattern: /\.azurecontainerapps\.io/,
    why: 'those hostnames resolve to nothing; use the *.interego.xwisee.com FQDNs',
  },
];

/**
 * A line is exempt when it is explicitly framed as history. `>` is the blockquote both
 * corrective notes already use; the phrases cover the surrounding prose.
 */
const HISTORICAL_MARKERS = [
  /^\s*>/,                       // markdown blockquote — how both existing notes are written
  /previously/i,
  /used to (be|target|describe|point|deploy)/i,
  /no longer (exists|reachable|deployed|in the tree)/i,
  /was deleted/i,
  /moved off/i,
  /is not in the tree/i,
  /decommissioned/i,
];

/**
 * ★ A LINE-GRANULAR EXEMPTION IS TOO COARSE FOR A MARKDOWN TABLE, and this gate shipped
 * with exactly the defect it exists to catch — caught by mutating it, not by reading it.
 *
 * A STATUS.md service row is ONE line, hundreds of characters long. The css-gate row
 * legitimately says "streaming hung at the old Azure ingress", which matched a historical
 * marker and exempted the ENTIRE row — so re-introducing "**live on Azure** … Current live
 * image: contextgraphsacr.azurecr.io/..." into that same row passed the gate silently. That
 * is the same shape as the original finding: a corrective note sitting in the same file as
 * the claim it contradicts, with nothing able to tell them apart.
 *
 * So a present-tense liveness claim REVOKES every exemption. History may explain what used
 * to run; it may not appear on a line that also asserts what runs now.
 */
const LIVE_CLAIM = /\*\*live on|Current live image|Publicly-hosted|is live at/i;

let failures = 0;
for (const file of FILES) {
  let text;
  try {
    text = readFileSync(file, 'utf8');
  } catch (err) {
    console.error(`✗ ${file}: ${err.message}`);
    failures++;
    continue;
  }
  const lines = text.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const exempt = HISTORICAL_MARKERS.some(m => m.test(line)) && !LIVE_CLAIM.test(line);
    if (exempt) continue;
    for (const { pattern, why } of BANNED) {
      if (!pattern.test(line)) continue;
      failures++;
      console.error(`✗ ${file}:${i + 1} — ${pattern} states dead infrastructure as live.`);
      console.error(`    ${why}`);
      console.error(`    ${line.trim().slice(0, 140)}`);
      console.error('    If this line is deliberately HISTORICAL, write it as a blockquote (>) or');
      console.error('    say "previously" / "used to" / "was deleted" so the claim is dated.');
    }
  }
}

if (failures > 0) {
  console.error(`\n★ DOCS DRIFT — ${failures} claim(s) describe infrastructure that no longer exists.`);
  process.exit(1);
}
console.log(`✓ docs drift: ${FILES.join(', ')} describe the live fleet (Railway + ghcr.io), no dead-platform claims.`);
