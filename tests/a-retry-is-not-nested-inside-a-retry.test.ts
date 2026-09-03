/**
 * `withTransientRetry` around something that already retries multiplies the ceiling.
 *
 * ── WHAT WAS MEASURED ───────────────────────────────────────────────────────
 *
 * `deploy/mcp-relay/oauth-client-store.ts` wrapped `fetchGraphContent`, `discover` and
 * `publish` in `withTransientRetry`. All three already retry inside `@interego/solid`:
 * `fetchGraphContent` its GET, `discover` its manifest GET at `{maxAttempts: 6, baseMs: 500}`,
 * `publish` its PUTs at the same. The inner layer throws `Failed to GET <url>: 503 …`, which
 * `isTransientNetworkError` accepts — so both layers retried the same failure.
 *
 * Measured against the built dist with a fetch that always answers 503:
 *
 *     HTTP requests issued for ONE durable 503: 16   (elapsed 35.5s)
 *
 * against the "4 attempts, ~15s ceiling" that `packages/core/src/http/retry.ts` documents as
 * its contract. `loadClients` runs at startup under `mapBounded(ours,
 * POD_HYDRATE_CONCURRENCY)`, so a slow CSS turned every registered OAuth client into 16–24
 * requests and half a minute of blocking hydration — the amplification pattern that had
 * previously left the client directory EMPTY after every restart.
 *
 * ── WHY A SOURCE CHECK AND NOT A TIMING TEST ────────────────────────────────
 *
 * A timing test for this would have to actually wait out the backoff — 35s to observe the bug
 * — and would be the flakiest thing in the suite. The defect is syntactic: a retry wrapper
 * around a call to something whose own contract is "I retry". That is decidable by reading, and
 * reading is what this does.
 */
import { describe, it, expect } from 'vitest';
import ts from 'typescript';
import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

/**
 * Functions that retry internally, so wrapping them retries twice.
 *
 * Each is here because its own source calls `withTransientRetry`; the list is checked against
 * that source below rather than trusted, so a function that stops retrying stops being an
 * offence to wrap.
 */
const ALREADY_RETRY = ['fetchGraphContent', 'discover', 'publish', 'publishNode'] as const;

function trackedTs(): string[] {
  return execFileSync('git', ['ls-files', '*.ts'], { cwd: ROOT, encoding: 'utf8', maxBuffer: 1 << 28 })
    .split(String.fromCharCode(10))
    .filter(Boolean)
    .filter(f => !f.endsWith('.d.ts'));
}

/** Every `withTransientRetry(...)` call whose body calls one of the retrying functions. */
function nestedRetries(file: string, text: string): string[] {
  const sf = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true);
  const out: string[] = [];
  const visit = (n: ts.Node): void => {
    if (ts.isCallExpression(n) && ts.isIdentifier(n.expression)
      && n.expression.text === 'withTransientRetry') {
      const inner = n.getText(sf);
      for (const fn of ALREADY_RETRY) {
        // `fn(` inside the wrapped callback — the wrapper's whole text is the callback.
        if (new RegExp(`\\b${fn}\\s*\\(`).test(inner)) {
          const line = sf.getLineAndCharacterOfPosition(n.getStart(sf)).line + 1;
          out.push(`${file}:${line} wraps ${fn}(), which retries on its own`);
        }
      }
    }
    ts.forEachChild(n, visit);
  };
  ts.forEachChild(sf, visit);
  return out;
}

describe('a retry is not nested inside a retry', () => {
  const files = trackedTs();

  it('reads the tree at all', () => {
    // Guards the guard: an empty file list reports no nesting and looks identical to clean.
    expect(files.length, 'no tracked .ts files found — the scan is broken').toBeGreaterThan(500);
  });

  it('the functions this gate calls self-retrying really do retry', () => {
    // ★ THE LIST IS CHECKED, NOT TRUSTED. If `discover` stops retrying internally, wrapping it
    // becomes correct and this gate would otherwise forbid the right code forever — the
    // permanent-false-positive failure mode that gets a gate deleted.
    const solid = readFileSync(join(ROOT, 'packages/solid/src/client.ts'), 'utf8');

    /** A function's source, bounded by the next top-level export — not by a character count. */
    const bodyOf = (fn: string): string | null => {
      const at = solid.search(new RegExp(`(?:export )?(?:async )?function ${fn}\\b`));
      if (at < 0) return null;
      // ★ A FIXED WINDOW IS A GUESS ABOUT HOW LONG A FUNCTION IS. `publish` is ~53,000 chars
      // with its retries near the end; a 6,000-char window stopped short and reported it as
      // no-longer-retrying, which would have made this leg permanently red about correct code.
      const rest = solid.slice(at + 10);
      const next = rest.search(/\nexport (?:async )?function /);
      return next < 0 ? rest : rest.slice(0, next);
    };

    const notRetrying = ALREADY_RETRY.filter((fn) => {
      const body = bodyOf(fn);
      if (body === null) return false;   // not defined here; the wrap check below still applies
      if (body.includes('withTransientRetry')) return false;   // retries in its own body
      // ★ ONE HOP. `discover`'s own body has no retry — its manifest GET is retried in the
      // helper it delegates to, at {maxAttempts: 6, baseMs: 500}. Checking only the top-level
      // body reported it as no-longer-retrying, which is the same too-shallow reading that let
      // the nesting exist: the wrap at the call site could not see the retry either.
      const callees = [...new Set([...body.matchAll(/\b([a-z][A-Za-z0-9]*)\s*\(/g)]
        .map(m => m[1] as string))];
      return !callees.some((c) => bodyOf(c)?.includes('withTransientRetry'));
    });
    expect(
      notRetrying,
      'these no longer retry internally, so ALREADY_RETRY is now forbidding a correct wrap:\n  '
        + notRetrying.join('\n  '),
    ).toEqual([]);
  });

  it('★ no call site wraps a self-retrying function in another retry', () => {
    const offenders = files.flatMap(f => nestedRetries(f, readFileSync(join(ROOT, f), 'utf8')));
    expect(
      offenders,
      'each of these multiplies the documented 4-attempt/~15s ceiling — measured at 16 requests '
        + 'over 35.5s for one durable 503, in a path that runs at startup for every registered '
        + 'client:\n  ' + offenders.join('\n  '),
    ).toEqual([]);
  });
});
