/**
 * The scanner three gates now rest on, checked against the exact shapes that broke their regexes.
 *
 * Every case below is a real failure from the audits, not an invented edge: if this scanner is
 * wrong, the gates above it report clean sheets over live defects, which is what happened four
 * times with regex census matchers.
 */
import { describe, it, expect } from 'vitest';
import { returnObjects } from './return-object-scan.js';

describe('returnObjects reads whole object literals', () => {
  it('★ crosses a NESTED object — what `[^}]*` could not', () => {
    const src = "return { kind: 'refusal', error: 'no', 'iep:resolvedBy': { toolName: 'x' } };";
    const [r] = returnObjects(src);
    expect(r, 'nothing matched at all').toBeTruthy();
    expect(r!.text).toContain('iep:resolvedBy');
    expect(r!.text.endsWith('}')).toBe(true);
    // The whole literal, not a prefix ending at the inner brace.
    expect(r!.text).toContain("toolName: 'x' }");
  });

  it('★ is not truncated by a semicolon INSIDE a message', () => {
    const src = "return { error: 'pass your own pod; the first enrollee owns it.', status: 403 };";
    const [r] = returnObjects(src);
    expect(r!.text).toContain('status: 403');
  });

  it('★ finds a refusal written as res.status(...).json({...})', () => {
    const src = "res.status(403).json({ kind: 'refusal', error: 'nope' });";
    const [r] = returnObjects(src);
    expect(r, 'the .json({...}) form was invisible to the `};`-bounded matcher').toBeTruthy();
    expect(r!.text).toContain("kind: 'refusal'");
  });

  it('a brace inside a string or template hole does not close the object', () => {
    const src = 'return { a: "}", b: `x${ { y: 1 } }z`, c: 2 };';
    const [r] = returnObjects(src);
    expect(r!.text).toContain('c: 2');
  });

  it('a brace inside a comment does not close the object', () => {
    const src = "return {\n  // a stray } in prose\n  error: 'x',\n};";
    const [r] = returnObjects(src);
    expect(r!.text).toContain("error: 'x'");
  });

  it('reports the line, and finds every statement rather than the first', () => {
    const src = "const a = 1;\nreturn { error: 'one' };\nconst b = 2;\nreturn { error: 'two' };";
    const found = returnObjects(src);
    expect(found.length).toBe(2);
    expect(found[0]!.line).toBe(2);
    expect(found[1]!.line).toBe(4);
  });

  it('an unbalanced literal is skipped rather than swallowing the rest of the file', () => {
    // A truncated file must not produce one enormous "match" that makes every later check vacuous.
    expect(returnObjects("return { error: 'x'")).toEqual([]);
  });

  it('★ reads the real bridge, and sees more than the regex it replaces', async () => {
    // The regex could not cross a nested object; the refusals that name a way out all have one.
    const { readFileSync } = await import('node:fs');
    const src = readFileSync(
      new URL('../applications/foxxi-content-intelligence/bridge/server.ts', import.meta.url), 'utf8',
    );
    const scanned = returnObjects(src).filter(r => r.text.includes("kind: 'refusal'"));
    const byRegex = [...src.matchAll(new RegExp("return[^]{0,4}[{][^}]*kind: 'refusal'[^}]*[}]", 'g'))];
    expect(scanned.length, 'the scanner found no refusals in the real bridge').toBeGreaterThan(30);
    expect(
      scanned.length,
      'the scanner should see at least as many refusals as the regex it replaces',
    ).toBeGreaterThanOrEqual(byRegex.length);
  });
});
