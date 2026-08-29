/**
 * THE BOUNDED SHAPE IS THE ONE YOU GET WITHOUT ASKING.
 *
 * `POST /agent/review-record` used to embed every experience and performance record by default — a
 * response measured live at over 1.2 MB, growing without bound with the subject's history. The
 * bounded `links` projection (the judgement, plus `hydra:Collection` references carrying
 * `hydra:totalItems`) shipped OPT-IN for one release so no existing consumer broke on a shape change
 * it had not asked for.
 *
 * ★ LEAVING IT OPT-IN PERMANENTLY WOULD HAVE BEEN THE REAL DEFECT. A safe shape you must already
 * know to request is the same failure as an address its holder cannot dereference: a property the
 * system HAS but does not exhibit. The agent that most needs the bounded response is precisely the
 * one that has never read this docstring.
 *
 * These assertions are on the SOURCE, not on a running server: `bridge/server.ts` starts an HTTP
 * listener at import time, so it cannot be loaded into a test process. That is a real limit and is
 * stated rather than papered over — what is pinned here is the DECISION (which branch is the
 * fallback, and what the affordance advertises), which is exactly what a silent revert would change.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const SERVER = join(
  dirname(fileURLToPath(import.meta.url)),
  '..', 'applications', 'foxxi-content-intelligence', 'bridge', 'server.ts',
);
const src = readFileSync(SERVER, 'utf8');

/**
 * ★ THE ADVERTISEMENT LIVES IN affordances.ts, NOT IN THE BRIDGE. `review-record` used to be
 * declared twice — as a standalone literal in bridge/server.ts and again in affordances.ts, which
 * is what `GET /affordances` publishes — and only the bridge copy documented `projection`. That is
 * exactly the failure this suite exists for: an agent plans against what the affordance says about
 * itself, and the document it can actually fetch said nothing about the parameter that bounds a
 * response measured over 1.2 MB. The two were merged and de-duplicated, so the advertisement is
 * asserted where it publishes from.
 */
const affordancesSrc = readFileSync(join(
  dirname(fileURLToPath(import.meta.url)),
  '..', 'applications', 'foxxi-content-intelligence', 'affordances.ts',
), 'utf8');

/** Source lines that are not comments — a docstring mentioning a shape is not the code choosing it. */
const NEWLINE = String.fromCharCode(10);
const codeLines = (src + NEWLINE + affordancesSrc).split(NEWLINE)  .filter(l => !/^[ ]*(\/\/|[*]|\/[*])/.test(l));

describe('the links projection is the DEFAULT, not an opt-in', () => {
  it('the fallback branch is links — an absent `projection` yields the bounded shape', () => {
    const decision = codeLines.filter(l => /const projectionMode\s*=/.test(l));
    expect(decision).toHaveLength(1);
    // Written as `p.projection === 'inline' ? 'inline' : 'links'`: the STRING TESTED FOR is the
    // opt-out, so whatever is not asked for lands on links. The inverted form
    // (`=== 'links' ? 'links' : 'inline'`) is the pre-flip code and must not come back.
    expect(decision[0]).toMatch(/===\s*'inline'\s*\?\s*'inline'\s*:\s*'links'/);
    expect(decision[0]).not.toMatch(/===\s*'links'\s*\?\s*'links'\s*:\s*'inline'/);
  });

  it('still honours an explicit inline request — nothing was removed, only the default moved', () => {
    // The unbounded shape stays reachable. Flipping a default is only safe while the old behaviour
    // is still available to a caller that genuinely wants it.
    expect(codeLines.some(l => /projectionMode === 'links' \? elrAsLinks\(/.test(l))).toBe(true);
  });

  it('★ and the affordance ADVERTISES links as the default, so a reader is not told the old story', () => {
    // The costliest version of this bug is not the code — it is the code flipping while the
    // published description still says `DEFAULT 'inline'`. An agent plans against what the
    // affordance says about itself, so a stale description is a wrong answer with a signature.
    const advertised = codeLines.filter(l => /projection\?:\s*'inline'\|'links'/.test(l));
    expect(advertised.length).toBeGreaterThan(0);
    for (const line of advertised) {
      expect(line).toMatch(/DEFAULT 'links'/);
      expect(line).not.toMatch(/DEFAULT 'inline'/);
    }
  });

  it('and the response says which projection it used, so "why is this shorter" is answerable', () => {
    // Said on the record itself: a consumer that notices the shape changed must be able to find out
    // why from the response alone, without reading a changelog it does not have.
    expect(codeLines.some(l => /projection:\s*projectionMode/.test(l))).toBe(true);
    expect(src).toMatch(/LINKS projection \(the DEFAULT\)/);
  });
});
