/**
 * Every Turtle file this repo ships parses with a real RDF parser.
 *
 * ── WHY: AN UNPARSEABLE ONTOLOGY WENT OUT PAST TWO GREEN GATES ───────────────
 *
 * `iep:appliesToCollection` was added to `docs/ns/iep.ttl` with an rdfs:comment that
 * named the collections it applies to — and named them the way prose does, in double
 * quotes, inside a literal that was itself delimited by double quotes. Turtle ends the
 * literal at the first inner quote. `docs/ns/iep.ttl` stopped parsing at line 883, and
 * the file was committed, pushed, and served that way.
 *
 * Two gates ran over it and both passed:
 *
 *   1. `npm run lint:ontology` (tools/ontology-lint.mjs) — it has NO parser. It reads
 *      the Turtle as text and pulls terms out with `extractDefinedTerms`, `extractSubjects`
 *      and a `stripComments` regex. Every one of those still finds what it is looking for
 *      in a file that no parser will accept, because a truncated literal does not remove
 *      the lines around it. The lint answers "are the declared terms consistent with the
 *      code that references them", which is a real question, and NOT "is this RDF".
 *
 *   2. `tests/the-projection-matches-the-ontology.test.ts` — 97 cases comparing
 *      `docs/ns/iep.html` against `docs/ns/iep.ttl`. It is blind for a sharper reason than
 *      "no parser": it compares DECLARED TERM NAMES and the HTML's anchors, both pulled out
 *      with regexes, and never reads a comment's text at all — so a broken literal inside one
 *      cannot reach it in either direction. Measured against the mutant: 97/97 green.
 *
 * Nothing caught it directly. It surfaced as a COUNT: the relay's conformance gate began
 * treating `iep.ttl` as a file declaring zero shapes, and the number of zero-shape files
 * went 23 -> 24. Finding the cause meant diffing the two lists by hand. That is the whole
 * reason this file exists — the detection path was a human noticing an off-by-one in an
 * unrelated tally, and that path does not run on anyone else's commit.
 *
 * The class is not "a comment had quotes in it". The class is that a repo whose entire
 * thesis is published, dereferenceable, machine-readable semantics had no gate that ever
 * asked a parser whether the published bytes were parseable. One `new Parser().parse()`
 * over the shipped tree closes it, and it is the cheap kind of gate: it replaces manual
 * vigilance rather than adding another thing to remember.
 *
 * ── WHY `tests/fixtures/` IS EXCLUDED, AND WHY THAT IS NOT A LOOPHOLE ────────
 *
 * Do not "fix" this by widening it to the whole tree. Measured at the time of writing,
 * the repo ships 627 `.ttl` files; 536 of them are W3C conformance fixtures and 88 of
 * those do not parse with the npm `n3` package — CORRECTLY, for two distinct reasons:
 *
 *   - many are negative fixtures (`*-bad-*`, `*-syntax-bad-*`). A parser rejecting them
 *     is the assertion the suite makes. A gate demanding they parse would invert it.
 *   - many are RDF 1.2 (`<<`, `>>`, `~`, `@version`, `@en--ltr`), which the npm `n3`
 *     package does not implement and OUR parser does. Those files are the evidence for
 *     the 106/106 RDF 1.2 result; failing them here would be this gate reporting on the
 *     dependency's coverage while looking like it reported on ours.
 *
 * The fixtures already have an owner — the conformance suites, which run them against the
 * parser that is supposed to accept or reject each one, with a per-file expected verdict.
 * This gate covers the 91 files that have no such owner: the ones we author and serve.
 */
import { describe, it, expect } from 'vitest';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Parser } from 'n3';

// The idiom the rest of tests/ uses. A hand-rolled URL.pathname needs a drive-letter
// fixup on Windows and is the same class as the CRLF gate that was green on one
// platform's checkout and red on the other.
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

function shippedTurtle(): string[] {
  const out = execFileSync('git', ['ls-files', '*.ttl'], { cwd: ROOT, encoding: 'utf8' });
  return out
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean)
    .filter((f) => !f.startsWith('tests/fixtures/'));
}

describe('every Turtle file this repo authors and serves parses', () => {
  it('finds the authored files, and does not silently narrow to nothing', () => {
    const files = shippedTurtle();
    // A glob that stops matching is the failure mode that makes a gate like this pass
    // forever while checking zero files. 91 at the time of writing; the floor only has
    // to be high enough that an empty or near-empty match is a red test.
    expect(files.length).toBeGreaterThanOrEqual(60);
    expect(files.some((f) => f === 'docs/ns/iep.ttl')).toBe(true);
    // The published ontologies are the ones a remote consumer dereferences.
    expect(files.filter((f) => f.startsWith('docs/ns/')).length).toBeGreaterThanOrEqual(25);
  });

  it('parses every one of them', () => {
    const failures: string[] = [];
    for (const rel of shippedTurtle()) {
      const text = readFileSync(join(ROOT, rel), 'utf8');
      try {
        const quads = new Parser().parse(text);
        // A file that parses to nothing is not evidence of anything; an ontology we
        // publish always says something. This is what would have caught the incident
        // even had the truncated literal happened to leave a parseable remainder.
        if (rel.startsWith('docs/ns/') && quads.length === 0) {
          failures.push(`${rel}: parsed to 0 triples`);
        }
      } catch (err) {
        failures.push(`${rel}: ${String((err as Error).message).split('\n')[0]}`);
      }
    }
    expect(failures, `unparseable Turtle:\n  ${failures.join('\n  ')}`).toEqual([]);
  });
});
