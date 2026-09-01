/**
 * discover_all drops pods that found nothing, keeps pods that FAILED, and counts the drop.
 *
 * Live: 578 federation pods, and `discover_all` with `limit: 3` returned 849,399 characters —
 * one row per POD, not per result. Even a graph_iri matching nothing returned 578 rows of
 * `entries: []`. Uncallable by an agent with a context budget: the "a tool too big to call"
 * class. A pod with no entries carries nothing the `pods` count does not already give, so it is
 * dropped — but a pod with an ERROR is kept (a fault is a different answer from a nothing), and
 * the drop is counted (a silently shorter list is "a read that failed is not a thing that is
 * missing" in reverse).
 *
 * Relay-suite idiom: a standalone tsx script that exits non-zero on failure.
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { winnowDiscoverResults } from '../discover-winnow.js';
import { stripComments } from './strip-comments.js';

let failures = 0;
const ok = (cond: boolean, name: string, detail = ''): void => {
  if (cond) { console.log(`  ok    ${name}`); return; }
  failures++; console.error(`  FAIL  ${name}${detail ? `  ${detail}` : ''}`);
};

{
  const { material, omittedEmpty } = winnowDiscoverResults([
    { pod: 'a', entries: [{ x: 1 }] },
    { pod: 'b', entries: [] },
    { pod: 'c', entries: [] },
    { pod: 'd', entries: [{ y: 2 }, { y: 3 }] },
  ]);
  ok(material.map((r) => r.pod).join(',') === 'a,d', 'keeps rows with entries, drops empties',
    `got [${material.map((r) => r.pod).join(',')}]`);
  ok(omittedEmpty === 2, 'counts the two dropped empties', `got ${omittedEmpty}`);
}

{
  const { material, omittedEmpty } = winnowDiscoverResults([
    { pod: 'reachable', entries: [{ x: 1 }] },
    { pod: 'unreachable', entries: [], error: 'fetch failed' },
    { pod: 'genuinely-empty', entries: [] },
  ]);
  ok(material.map((r) => r.pod).join(',') === 'reachable,unreachable',
    '★ keeps an EMPTY row that carries an error — a fault is not a nothing',
    `got [${material.map((r) => r.pod).join(',')}]`);
  ok(omittedEmpty === 1, 'only the true empty is dropped', `got ${omittedEmpty}`);
}

{
  const rows = Array.from({ length: 578 }, (_, i) => ({ pod: `p${i}`, entries: [] as unknown[] }));
  const { material, omittedEmpty } = winnowDiscoverResults(rows);
  ok(material.length === 0, 'an all-empty fan-out returns nothing', `got ${material.length}`);
  ok(omittedEmpty === 578, 'but reports the full breadth — 578 scanned, none matched',
    `got ${omittedEmpty}`);
}


// ── §2 THE WIRING, NOT ONLY THE HELPER ───────────────────────────────────────
//
// Everything above tests `winnowDiscoverResults` in isolation. That is the defect class this
// repository keeps repeating: a gate placed BESIDE the thing it protects. Reverting the one
// line in server.ts that composes the helper — back to `JSON.stringify({ pods, results })` —
// restores the 849,399-character response with every assertion above still green, because the
// helper stays correct and simply stops being called.
//
// server.ts calls app.listen() at module scope and cannot be imported, so this censuses its
// source after stripComments — the relay suite's own idiom, so a call named in prose is not
// mistaken for a call.
{
  const here = dirname(fileURLToPath(import.meta.url));
  const code = stripComments(readFileSync(join(here, '..', 'server.ts'), 'utf8'), 'server.ts');

  ok(code.includes('winnowDiscoverResults(results)'),
    'handleDiscoverAll composes the winnower');
  ok(/results:\s*material/.test(code),
    'the response body carries the WINNOWED rows, not the raw fan-out');
  ok(/omittedEmpty/.test(code),
    'the count of dropped rows is reported, so a shorter list is not a silent one');
  ok(!/JSON\.stringify\(\{\s*pods:\s*results\.length,\s*results\s*\}\)/.test(code),
    'the pre-fix one-row-per-pod response shape is gone');

  // The census must be reading real code, or the four checks above are vacuous.
  ok(code.includes('async function handleDiscoverAll'),
    'the census is reading server.ts');
}

console.log(failures === 0 ? '\nAll discover-winnow checks passed.\n' : `\n${failures} check(s) failed.\n`);
process.exit(failures === 0 ? 0 : 1);
