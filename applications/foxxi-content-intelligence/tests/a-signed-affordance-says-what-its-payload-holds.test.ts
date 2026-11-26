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
import { describe, expect, it } from 'vitest';
import { foxxiAffordances } from '../affordances.js';
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
      const named = sentence[1]!.split(',').map(s => s.trim().replace(/\?$/, '')).filter(Boolean);
      for (const n of named) expect(Object.keys(input.content!.properties), `${a.toolName} names ${n}`).toContain(n);
    }
  });

  it('is still only prose for the rest, and that number may only fall', () => {
    // 2026-11-26: 4 of the 58 signed affordances say it. Lower NOT_YET as more do; never raise it.
    // A new signed affordance says it from the start, so this number does not grow.
    expect(signed.length - withContent.length).toBe(NOT_YET);
  });

  it('leaves an input without content exactly as it was', () => {
    const plain = foxxiAffordances.find(a => a.inputs.some(i => i.type === 'string' && !i.content))!;
    const props = affordanceToMcpToolSchema(plain).inputSchema.properties as Record<string, object>;
    for (const p of Object.values(props)) { expect(p).not.toHaveProperty('contentSchema'); expect(p).not.toHaveProperty('contentMediaType'); }
  });
});

/** Signed affordances whose payload is still described only in prose. */
const NOT_YET = 54;
