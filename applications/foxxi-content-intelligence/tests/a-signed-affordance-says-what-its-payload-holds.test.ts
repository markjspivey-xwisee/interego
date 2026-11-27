/**
 * A signed affordance says, in its schema, what its signed payload holds.
 *
 * ★ WHY. A signed affordance takes two strings, `_signed_payload` and `_signature`. What goes
 * inside the payload was written only as prose in the description ("JSON.stringify({ agent_id,
 * timestamp, course_id, ... })"), so a client could follow the descriptor to the right address and
 * still have to be told, or parse a sentence, to know what to send. That is knowledge held outside
 * the descriptor, and the reason a generic client could not drive these affordances.
 *
 * `content` on the input carries it (applications/_shared/affordance-mcp), emitted with JSON
 * Schema's keywords for string-encoded content. This is a ratchet: the signed affordances that
 * say it are checked, and the count of those that do not yet may only fall.
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { foxxiAffordances } from '../affordances.js';
import { SIGNED_PAYLOAD_CONTENT, withSignedPayloadContent } from '../src/signed-payload-content.js';
import { affordanceToMcpToolSchema } from '../../_shared/affordance-mcp/index.js';

const signed = foxxiAffordances.filter(a => a.inputs.some(i => i.name === '_signed_payload'));
const withContent = signed.filter(a => a.inputs.find(i => i.name === '_signed_payload')!.content);

describe('a signed affordance\'s payload', () => {
  it('is described in the schema for the affordances agents learn beside people with', () => {
    const said = withContent.map(a => a.toolName).sort();
    for (const t of ['foxxi.learning_beside_signed', 'foxxi.assign_to_own_agent_signed', 'foxxi.take_down_own_package_signed']) expect(said).toContain(t);
    expect(said.some(t => /cmi5_launch/.test(t))).toBe(true);
  });

  it('is emitted as string-encoded JSON, with the envelope fields the signer fills', () => {
    for (const a of withContent) {
      const prop = (affordanceToMcpToolSchema(a).inputSchema.properties as Record<string, { type: string; contentMediaType?: string; contentSchema?: { type: string; properties: Record<string, { type: string; description: string }>; required: string[] } }>)._signed_payload!;
      expect(prop.type, a.toolName).toBe('string');
      expect(prop.contentMediaType, a.toolName).toBe('application/json');
      expect(Object.keys(prop.contentSchema!.properties), a.toolName).toEqual(expect.arrayContaining(['agent_id', 'timestamp']));
      expect(prop.contentSchema!.required, a.toolName).toEqual(expect.arrayContaining(['agent_id', 'timestamp']));
      for (const r of prop.contentSchema!.required) expect(prop.contentSchema!.properties, `${a.toolName} requires ${r}`).toHaveProperty(r);
      for (const [k, v] of Object.entries(prop.contentSchema!.properties)) expect(v.description.length, `${a.toolName}.${k}`).toBeGreaterThan(10);
    }
  });

  it('names every field the description\'s own sentence names', () => {
    // The prose stays for a reader; the schema must not say less than it.
    for (const a of withContent) {
      const input = a.inputs.find(i => i.name === '_signed_payload')!;
      const sentence = /JSON\.stringify\(\{([^}]*)\}\)/.exec(input.description);
      if (!sentence) continue;
      // A piece is `name`, `name?` or `name?: <what it is>`; the rest of a gloss that had a comma in it is not a name.
      const named = sentence[1]!.split(',').map(s => /^\s*([a-z][A-Za-z0-9_]*)\??\s*(?::|$)/.exec(s)?.[1]).filter((n): n is string => !!n);
      for (const n of named) expect(Object.keys(input.content!.properties), `${a.toolName} names ${n}`).toContain(n);
    }
  });

  it('is described for every signed affordance', () => {
    // 2026-11-26: 4 of the 58 said it. 2026-11-27: all of them (src/signed-payload-content.ts).
    // A new signed affordance says it from the start; this number stays 0.
    expect(signed.filter(a => !a.inputs.find(i => i.name === '_signed_payload')!.content).map(a => a.toolName)).toEqual([]);
    expect(signed.length - withContent.length).toBe(NOT_YET);
  });

  it('describes no affordance that is not there, and replaces no declaration of its own', () => {
    const tools = new Set(signed.map(a => a.toolName));
    for (const t of Object.keys(SIGNED_PAYLOAD_CONTENT)) expect(tools.has(t), `${t} is described and not declared`).toBe(true);
    const own = foxxiAffordances.find(a => a.toolName === 'foxxi.assign_to_own_agent_signed')!;
    expect(withSignedPayloadContent(own)).toBe(own);
  });

  // ★ The schema is held to the code, not to the sentence. Each route's handler is read for the
  // fields it takes from the verified payload; a field it reads and the schema does not name is a
  // field a client following the descriptor would never learn to send.
  it('names every field its route reads from the payload', () => {
    const sources = ['../bridge/server.ts', '../src/cmi5-personal-link.ts', '../src/scorm-dispatch.ts', '../src/xapi-profile-server/authoring-http.ts', '../src/xapi-profile-server/service.ts']
      .map(f => readFileSync(new URL(f, import.meta.url), 'utf8'));
    let checked = 0;
    const unnamed: string[] = [];
    for (const a of signed) {
      const path = a.targetTemplate.replace('{base}', '');
      const found = sources.map(src => handlerOf(src, path)).find(Boolean);
      if (!found) continue;
      // A comment that mentions a field is not a read of it.
      const handler = found.replace(/^\s*(?:\/\/|\*|\/\*).*$/gm, '').replace(/\s\/\/ .*$/gm, '');
      const reads = new Set<string>();
      for (const m of handler.matchAll(/\b(?:auth|bound)\.payload\.([a-z][A-Za-z0-9_]*)/g)) reads.add(m[1]!);
      // `p` is the payload where the handler says so, and not a lambda's parameter elsewhere in it.
      if (/const p = (?:auth|bound|verified)\.payload\b|signed\('[^']*', async \(p, by\)/.test(handler)) {
        for (const m of handler.matchAll(/(?<![\w.])p\.([a-z][A-Za-z0-9_]*)/g)) reads.add(m[1]!);
      }
      for (const lambda of handler.matchAll(/\bp => [^\n]*?\bp\.([a-z][A-Za-z0-9_]*)/g)) reads.delete(lambda[1]!);
      if (reads.size === 0) continue;
      checked++;
      const named = Object.keys(a.inputs.find(i => i.name === '_signed_payload')!.content!.properties);
      for (const r of reads) if (!named.includes(r)) unnamed.push(`${a.toolName} reads ${r}`);
    }
    expect(unnamed).toEqual([]);
    // Enough handlers were found and read for this to mean something.
    expect(checked).toBeGreaterThanOrEqual(30);
  });

  it('leaves an input without content exactly as it was', () => {
    const plain = foxxiAffordances.find(a => a.inputs.some(i => i.type === 'string' && !i.content))!;
    const props = affordanceToMcpToolSchema(plain).inputSchema.properties as Record<string, object>;
    for (const p of Object.values(props)) { expect(p).not.toHaveProperty('contentSchema'); expect(p).not.toHaveProperty('contentMediaType'); }
  });
});

/** Signed affordances whose payload is still described only in prose. */
const NOT_YET = 0;

/** The text of the route registered at `path`, to the parenthesis that closes it. */
function handlerOf(src: string, path: string): string | undefined {
  const at = src.search(new RegExp(`\\b\\w+\\.post\\(\\s*['"\`]${path.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&')}['"\`]`));
  if (at < 0) return undefined;
  let depth = 0; let quote = '';
  for (let i = src.indexOf('(', at); i < src.length; i++) {
    const c = src[i]!;
    if (quote) { if (c === '\\') i++; else if (c === quote) quote = ''; continue; }
    if (c === "'" || c === '"' || c === '`') { quote = c; continue; }
    if (c === '/' && src[i + 1] === '/') { i = src.indexOf('\n', i); continue; }
    if (c === '(') depth++;
    else if (c === ')' && --depth === 0) return src.slice(at, i + 1);
  }
  return undefined;
}
