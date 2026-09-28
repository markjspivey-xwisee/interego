/**
 * EVERY CODE PATH HAS AN OWNER, AND THE TABLE THAT SAYS SO IS THE ONE THE GATE ENFORCES.
 *
 * `spec/LAYERS.md` §6.2 tables which paths are the domain-neutral BASE and which are compositions,
 * deployments, verticals or examples (#366). A table like that goes stale the day a package is
 * added, and a gate that scans a different set of paths than the table names makes both of them
 * wrong. So: every directory under packages/, deploy/, integrations/, applications/ and examples/
 * must have a row, and the rows marked `base` must be exactly the roots
 * `tools/base-neutrality-lint.mjs` scans.
 */

import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { ROOT, VERTICAL_OWNED, baseRoots } from '../tools/base-neutrality-lint.mjs';

interface Row { readonly path: string; readonly role: string }

function ownershipRows(): Row[] {
  const text = readFileSync(join(ROOT, 'spec/LAYERS.md'), 'utf8');
  const start = text.indexOf('### 6.2 Who owns each code path');
  expect(start, '§6.2 heading').toBeGreaterThan(-1);
  const end = text.indexOf('\n---', start);
  expect(end, 'end of §6.2').toBeGreaterThan(start);
  const rows: Row[] = [];
  for (const line of text.slice(start, end).split(/\r?\n/)) {
    const cells = line.split('|').map(c => c.trim());
    const path = /^`([^`]+)`$/.exec(cells[1] ?? '')?.[1];
    if (path && cells.length >= 5) rows.push({ path, role: cells[3]! });
  }
  return rows;
}

const dirsUnder = (top: string): string[] =>
  readdirSync(join(ROOT, top)).filter(name => statSync(join(ROOT, top, name)).isDirectory()).map(name => `${top}/${name}`);

describe('the ownership table in spec/LAYERS.md §6.2', () => {
  const rows = ownershipRows();
  const owns = (dir: string): Row | undefined =>
    rows.find(r => r.path === dir) ?? rows.find(r => r.path.endsWith('/*') && dir.startsWith(r.path.slice(0, -1)));

  it('has a row for every package, deployment, integration, vertical and example', () => {
    const missing = ['packages', 'deploy', 'integrations', 'applications', 'examples']
      .flatMap(dirsUnder)
      .concat('mcp-server')
      .filter(dir => owns(dir) === undefined);
    expect(missing).toEqual([]);
  });

  it('has no row for a path that does not exist', () => {
    const stale = rows.filter(r => !r.path.endsWith('/*')).filter(r => {
      try { return !statSync(join(ROOT, r.path)).isDirectory(); } catch { return true; }
    });
    expect(stale.map(r => r.path)).toEqual([]);
  });

  it('marks as base exactly the roots the neutrality gate scans', () => {
    const base = rows.filter(r => r.role === 'base').map(r => r.path).sort();
    const gateRoots = Object.keys(baseRoots()).filter(k => k !== 'packages');
    const gatePackages = dirsUnder('packages').filter(dir => !VERTICAL_OWNED.some(v => v.dir === dir));
    expect(base).toEqual([...gateRoots, ...gatePackages].sort());
  });

  it('marks every vertical-owned package as a vertical\'s', () => {
    for (const v of VERTICAL_OWNED) expect(owns(v.dir)?.role, v.dir).toBe('vertical');
  });
});
