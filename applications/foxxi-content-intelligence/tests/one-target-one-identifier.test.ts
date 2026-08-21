/**
 * A capability has ONE name. One target, one action IRI, one toolName.
 *
 * ★★ WHY THE EXISTING GATE COULD NOT SEE THIS. `tools/check-foxxi-affordances.mjs` reconciles
 * ROUTES against TARGETS — every `/agent/*` route must be some affordance's `targetTemplate` or be
 * allowlisted infra. It passes, and it is right to: both targets below were covered. But a gate
 * keyed on the path is structurally blind to two IDENTIFIERS naming one path, which is what was
 * actually there.
 *
 * Measured on the live bridge before this test existed — 13 targets carried more than one
 * identifier:
 *
 *   /agent/void-credential          urn:…:void-credential          (manifest, MCP tools/list)
 *                                   urn:…:void-credential-signed   (the followable document)
 *   /agent/publish-encryption-key   …:publish-encryption-key  vs  …:publish-encryption-key-signed
 *   and 11 more differing on toolName (`foxxi.scorm_author` vs `scorm_author`, …)
 *
 * An action IRI is the NAME of the capability — what an agent resolves, records in a trajectory,
 * and matches against later. Two names for one act means a peer that discovered via /affordances
 * and a peer that followed the affordance document hold different identifiers for the same thing,
 * and neither can match the other's records. That is the same defect class as the operations
 * catalog publishing `urn:iep:action:<name>` while the A2A card published the URL form.
 *
 * ★ WHICH SIDE IS CANONICAL WAS MEASURED, NOT CHOSEN. `tools/list` on the live bridge advertises
 * 91 tools; every `foxxi.*` name is REGISTERED and every bare inline form (`review_foxxi_record`,
 * `void_credential`, `scorm_author`) is ABSENT. So the inline names were never dispatch keys —
 * they rendered into the followable documents only, and no client could depend on them.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const read = (rel: string): string =>
  readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8');

interface Decl { action: string; target: string; toolName?: string; from: string }

/**
 * Every declaration carrying an action, a targetTemplate and (usually) a toolName.
 *
 * ★ ANCHORED ON STRUCTURE, NOT ON A CHARACTER WINDOW — and that is not a style preference, it is
 * the bug this file was written after, committed twice.
 *
 * The first version searched a fixed `[\s\S]{0,4000}` window after each `action:`. It reported 12
 * collisions. `review-record`'s description runs to several thousand characters, so its
 * `targetTemplate` fell outside the window and the scan skipped it silently: there were 13. A
 * window that is too small does not fail — it UNDER-REPORTS, which is the failure mode that reads
 * exactly like a clean result. Widening it to 12000 found the 13th and left the same trap set for
 * the next long description.
 *
 * So the object's own braces bound the search. From each `action:` we walk back to the enclosing
 * `{` and forward to its match, and look only inside that. There is no window to outgrow.
 * `tests/a-proxy-that-is-right-until-something-grows.test.ts` refuses a fixed window for this
 * reason and names the two production deploys the shape cost.
 */
function declarations(src: string, from: string): Decl[] {
  const out: Decl[] = [];
  for (const m of src.matchAll(/action:\s*'([^']+)'/g)) {
    const at = m.index ?? 0;
    // Walk back to the `{` that opens the object this `action:` belongs to.
    let depth = 0;
    let open = -1;
    for (let i = at; i >= 0; i--) {
      const c = src[i];
      if (c === '}') depth++;
      else if (c === '{') {
        if (depth === 0) { open = i; break; }
        depth--;
      }
    }
    if (open < 0) continue;
    // Forward to its match.
    let close = -1;
    depth = 0;
    for (let i = open; i < src.length; i++) {
      const c = src[i];
      if (c === '{') depth++;
      else if (c === '}') {
        depth--;
        if (depth === 0) { close = i; break; }
      }
    }
    if (close < 0) continue;
    const body = src.slice(open, close + 1);
    const target = /targetTemplate:\s*['"`]\{base\}(\/agent\/[^'"`]*)['"`]/.exec(body)?.[1];
    if (!target) continue;
    out.push({
      action: m[1] ?? '',
      target: target.replace(/\/$/, ''),
      toolName: /toolName:\s*'([^']+)'/.exec(body)?.[1],
      from,
    });
  }
  return out;
}

const all = [
  ...declarations(read('../affordances.ts'), 'affordances.ts'),
  ...declarations(read('../bridge/server.ts'), 'bridge/server.ts'),
];

const byTarget = new Map<string, Decl[]>();
for (const d of all) {
  const list = byTarget.get(d.target) ?? [];
  list.push(d);
  byTarget.set(d.target, list);
}

describe('one target, one identifier', () => {
  it('parses declarations from both files — a vacuous pass would hide every case below', () => {
    expect(all.length, 'parsed no declarations at all').toBeGreaterThan(30);
    expect(all.some(d => d.from === 'affordances.ts')).toBe(true);
    expect(all.some(d => d.from === 'bridge/server.ts'), 'parsed no INLINE declarations, so a '
      + 'divergence between the two files could not be seen').toBe(true);
  });

  it('never gives one target two action IRIs', () => {
    const bad: string[] = [];
    for (const [target, ds] of byTarget) {
      const actions = [...new Set(ds.map(d => d.action))];
      if (actions.length > 1) bad.push(`${target}: ${actions.join(' vs ')}`);
    }
    expect(bad, `these targets are named by more than one action IRI, so a peer that discovers via `
      + `the manifest and a peer that follows the affordance document hold different names for the `
      + `same act:\n  ${bad.join('\n  ')}`).toEqual([]);
  });

  it('never gives one target two tool names', () => {
    const bad: string[] = [];
    for (const [target, ds] of byTarget) {
      const tools = [...new Set(ds.map(d => d.toolName).filter(Boolean))];
      if (tools.length > 1) bad.push(`${target}: ${tools.join(' vs ')}`);
    }
    expect(bad, `these targets advertise more than one toolName:\n  ${bad.join('\n  ')}`).toEqual([]);
  });

  it('keeps every inline declaration anchored to a canonical one', () => {
    const canonical = new Set(all.filter(d => d.from === 'affordances.ts').map(d => d.target));
    const orphans = all
      .filter(d => d.from === 'bridge/server.ts' && !canonical.has(d.target))
      .map(d => `${d.target} (${d.action})`);
    expect(orphans, `these are declared ONLY inline, so they are absent from the /affordances `
      + `manifest and from tools/list — invocable but not discoverable:\n  ${orphans.join('\n  ')}`)
      .toEqual([]);
  });
});
