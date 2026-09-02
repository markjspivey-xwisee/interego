/**
 * The scanner three gates rest on, checked against every shape that broke its predecessors.
 *
 * Every case is a real failure from an audit, not an invented edge. The regex versions and the
 * hand-rolled brace counter both reported clean sheets over live defects; if this is wrong, so
 * is every gate above it.
 */
import { describe, it, expect } from 'vitest';
import { returnObjects } from './return-object-scan.js';

const one = (src: string) => returnObjects(src)[0];

describe('returnObjects reads what a module answers a caller with', () => {
  it('★ a REGEX LITERAL does not break it — the defect that excused four planted denials', () => {
    // The hand-rolled counter had no notion of regex literals, so a quote or brace inside one
    // dropped the literal or overran into the next. The overrun swallowed a later
    // `kind: 'refusal'`, which made the census EXCUSE the untyped denial it had just eaten.
    for (const re of ['/"/g', "/'/g", '/^\\//', '/^\\{/', '/\\}$/', '/[{]/', '/\\/\\//', '/\\*\\//']) {
      const src = `return { error: 'forbidden — ' + s.replace(${re}, '') + ' may not' };\n`
        + "return { kind: 'refusal', error: 'next' };";
      const found = returnObjects(src);
      expect(found.length, `regex ${re}: expected both literals, got ${found.length}`).toBe(2);
      expect(found[0]!.text, `regex ${re}: first literal is wrong`).toContain('forbidden');
      expect(
        found[0]!.text,
        `regex ${re}: the first literal OVERRAN into the second, so a census would read the `
          + "next statement's kind:'refusal' as this one's and excuse an untyped denial",
      ).not.toContain("kind: 'refusal'");
    }
  });

  it('★ finds `return ({ … })` and an arrow body `=> ({ … })` — 23 such sites exist', () => {
    expect(one("return ({ error: 'forbidden' });")?.text).toContain('forbidden');
    const arrow = returnObjects("const h = { 'foxxi.x': async (_a) => ({ error: 'forbidden — admin only' }) };");
    expect(arrow.length, 'an expression-bodied handler was invisible').toBe(1);
    expect(arrow[0]!.enclosing).toBe('HANDLER foxxi.x');
  });

  it('★ a refusal built in a VARIABLE and returned by name is still read', () => {
    const r = one("function f() { const out = { kind: 'refusal', error: 'no' }; return out; }");
    expect(r?.text, 'a refusal assembled into a const was invisible to the status legs').toContain("kind: 'refusal'");
    expect(r?.viaVariable).toBe(true);
  });

  it('★ res.status(…) is read through a nested call and a non-literal argument', () => {
    expect(one("res.status(403).json({ error: 'x' });")?.statusCall).toBe(403);
    // `[^)]*` could not cross this paren, so the route read as un-statused.
    expect(one("res.status(Number(400)).json({ error: 'x' });")?.statusCall).toBeNaN();
    expect(one("res.status(evidence.status ?? 400).json({ error: 'x' });")?.statusCall).toBeNaN();
    expect(one("res.status(404).type('application/ld+json').json({ error: 'x' });")?.statusCall).toBe(404);
    expect(one("res.json({ error: 'x' });")?.statusCall, 'no status call at all').toBeNull();
  });

  it('★ a return inside a COMMENT is not an answer, and lines are the real ones', () => {
    const src = "const a = 1; // was: return { error: 'forbidden — admin only' }\n"
      + "/* return { error: 'also prose' } */\n"
      + "return { error: 'the only real one' };";
    const found = returnObjects(src);
    expect(found.length, 'a return described in a comment was censused as a handler return').toBe(1);
    expect(found[0]!.text).toContain('the only real one');
    // Comment-stripping used to shift every reported line; the parser reads the file as written.
    expect(found[0]!.line, 'the line named is not the line in the file').toBe(3);
  });

  it('a brace or quote in a string, template hole, or comment does not close the object', () => {
    expect(one('return { a: "}", b: `x${ { y: 1 } }z`, c: 2 };')?.text).toContain('c: 2');
    expect(one("return {\n  // a stray } in prose\n  error: 'x',\n};")?.text).toContain("error: 'x'");
    expect(one('return { a: `it costs $${n} }`, z: 1 };')?.text).toContain('z: 1');
  });

  it('classifies where an answer sits, so an exclusion cannot hide a handler', () => {
    const src = "const m = {\n  'foxxi.a': async (args) => {\n"
      + "    const cast = (args.x as string[]) ?? [];\n"
      + "    return { ok: false, error: 'denied' };\n  },\n};";
    // A cast whose value starts with `(` used to be classified 'callback', excusing this.
    expect(one(src)?.enclosing).toBe('HANDLER foxxi.a');
    expect(one('function helper() { return { ok: false, error: "x" }; }')?.enclosing).toBe('helper');
  });

  it('★ reads the real bridge, and sees more than the hand-rolled scanner did', async () => {
    const { readFileSync } = await import('node:fs');
    const src = readFileSync(
      new URL('../applications/foxxi-content-intelligence/bridge/server.ts', import.meta.url), 'utf8',
    );
    const found = returnObjects(src);
    expect(found.length, 'the scanner found nothing in the real bridge').toBeGreaterThan(300);
    const refusals = found.filter(r => r.text.includes("kind: 'refusal'"));
    expect(refusals.length, 'no refusals found — the gates above this would be vacuous').toBeGreaterThan(30);
    // No literal may swallow another: an overrun is how a census excuses what it ate.
    const overran = refusals.filter(r => (r.text.match(/kind: 'refusal'/g) ?? []).length > 1);
    expect(overran.map(r => r.line), 'a literal contains a SECOND refusal — it overran').toEqual([]);
  });
});
