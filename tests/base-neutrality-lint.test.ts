/**
 * The base-neutrality gate tells code from comments, and fails every way it claims to.
 *
 * `tools/base-neutrality-lint.mjs` is what keeps vertical vocabulary and dependencies out of the
 * substrate (#366). A gate like that is only as good as its classifier: a vertical's host inside a
 * string on a line that also carries a comment is behaviour, and must not be filed as prose; an
 * `import type` or a dynamic `import()` is a dependency like any other. These cases pin that, and
 * pin that every rule fails in both directions — growth, and an allowance nobody needs any more.
 */

import { describe, expect, it } from 'vitest';
import { join } from 'node:path';
import * as gate from '../tools/base-neutrality-lint.mjs';

const scan = (src: string, file = 'x.ts') => gate.scanSource(src, file);
const RELAY_FILE = join(gate.ROOT, 'deploy/mcp-relay/server.ts');

describe('the classifier', () => {
  it('files a vertical in a string as code even when a comment shares the line', () => {
    const s = scan("const u = 'https://foxxi.example/x'; // a foxxi host\n");
    expect(s.code.map(h => h.text)).toEqual(['foxxi']);
    expect(s.comments.map(h => h.text)).toEqual(['foxxi']);
  });

  it('counts template text, regular expressions and identifiers as code', () => {
    const s = scan('const scormPath = `${base}/xapi/statements`;\nconst re = /cmi5/;\n');
    expect(s.code.map(h => h.text.toLowerCase()).sort()).toEqual(['cmi5', 'scorm', 'xapi']);
    expect(s.comments).toEqual([]);
  });

  it('counts block and line comments as comments, with their lines', () => {
    const s = scan('/**\n * The Foxxi bridge relies on this.\n */\nexport const a = 1; // not AGP\n');
    expect(s.comments.map(h => [h.text, h.line])).toEqual([['Foxxi', 2], ['AGP', 4]]);
    expect(s.code).toEqual([]);
  });

  it('does not mistake TLA+ (the specification language) for ADL TLA, nor a handler for LER', () => {
    const s = scan('// proved in TLA+\nfunction handler() { return "ok"; }\n');
    expect(s.comments).toEqual([]);
    expect(s.code).toEqual([]);
  });

  it('names whole agent-collective terms', () => {
    const s = scan("const t = 'a ac:AgentTool'; const g = 'urn:graph:ac:tool:x';\n");
    expect(s.code.map(h => h.text).sort()).toEqual(['ac:AgentTool', 'urn:graph:ac:']);
  });

  it('lists every kind of module specifier', () => {
    const s = scan([
      "import a from './a.js';",
      "import type { B } from './b.js';",
      "export { c } from './c.js';",
      "const d = await import('./d.js');",
      "const e = require('./e.js');",
      "type F = import('./f.js').F;",
      "import g = require('./g.js');",
    ].join('\n'));
    expect(s.specifiers.map(x => x.specifier)).toEqual(['./a.js', './b.js', './c.js', './d.js', './e.js', './f.js', './g.js']);
  });
});

describe('the dependency rule', () => {
  it('refuses a relative path into a vertical, an integration or an example', () => {
    expect(gate.forbiddenReason('../../applications/foo/src/x.js', RELAY_FILE)).toMatch(/applications/);
    expect(gate.forbiddenReason('../../integrations/foo/x.js', RELAY_FILE)).toMatch(/integrations/);
    expect(gate.forbiddenReason('../../examples/foo/x.js', RELAY_FILE)).toMatch(/examples/);
    expect(gate.forbiddenReason('../../packages/workspace-client/src/index.js', RELAY_FILE)).toMatch(/shared-workspace/);
  });

  it('refuses a package published from outside the base, and allows the base\'s own', () => {
    const published = gate.forbiddenPackages();
    expect(published.has('@interego/foxxi-content-intelligence')).toBe(true);
    expect(published.has('@interego/workspace-client')).toBe(true);
    expect(gate.forbiddenReason('@interego/workspace-client', RELAY_FILE)).toMatch(/outside the base/);
    expect(gate.forbiddenReason('@interego/core', RELAY_FILE)).toBeUndefined();
    expect(gate.forbiddenReason('@interego/core/http', RELAY_FILE)).toBeUndefined();
    expect(gate.forbiddenReason('./pgsl-node-store.js', RELAY_FILE)).toBeUndefined();
  });
});

describe('the verdict', () => {
  const measurement = (over: Partial<gate.Measurement> = {}): gate.Measurement => ({
    roots: { base: 3 },
    dependencies: [],
    code: [],
    comments: { base: { count: 2, examples: [] } },
    ...over,
  });

  it('passes a clean measurement at its pin', () => {
    expect(gate.judge(measurement(), [], { base: 2 })).toEqual([]);
  });

  it('fails vertical code, a dependency, a root that scans nothing, and comment growth', () => {
    const failures = gate.judge(measurement({
      roots: { base: 0 },
      dependencies: [{ file: 'a.ts', line: 1, specifier: '../applications/x', why: 'reaches applications/' }],
      code: [{ file: 'a.ts', line: 2, text: 'foxxi', vertical: 'foxxi-content-intelligence' }],
      comments: { base: { count: 3, examples: [] } },
    }), [], { base: 2 });
    expect(failures.some(f => f.includes('no source files'))).toBe(true);
    expect(failures.some(f => f.includes('DEPENDENCY ON A VERTICAL'))).toBe(true);
    expect(failures.some(f => f.includes('VERTICAL VOCABULARY IN BASE CODE'))).toBe(true);
    expect(failures.some(f => f.includes('GREW'))).toBe(true);
  });

  it('holds an allowlist entry to its exact count, both ways', () => {
    const code = [{ file: 'a.ts', line: 2, text: 'IEEE_LERS', vertical: 'LER and ADL TLA' }];
    const entry = { file: 'a.ts', text: 'IEEE_LERS', why: 'x' };
    expect(gate.judge(measurement({ code }), [{ ...entry, count: 1 }], { base: 2 })).toEqual([]);
    expect(gate.judge(measurement({ code }), [{ ...entry, count: 2 }], { base: 2 })[0]).toMatch(/Lower or remove/);
    expect(gate.judge(measurement({ code: [...code, ...code] }), [{ ...entry, count: 1 }], { base: 2 })[0]).toMatch(/growth/);
  });

  it('fails a comment pin above the measured count as stale', () => {
    expect(gate.judge(measurement(), [], { base: 3 })[0]).toMatch(/STALE PIN/);
  });

  it('the tree as it stands passes', () => {
    expect(gate.judge(gate.measure())).toEqual([]);
  });
});
