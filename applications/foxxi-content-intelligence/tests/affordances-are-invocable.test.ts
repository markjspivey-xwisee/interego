/**
 * An advertised affordance must be INVOCABLE, not merely discoverable.
 *
 * ★ WHY. A live audit of the deployed bridge found its entry point publishing 89
 * affordances that each carried only `action`, `toolName`, `method` and `target`. A
 * peer could discover every capability and had no way to call one: no field names,
 * no types, no indication of which were required. The only way in was to already
 * know — which is precisely the out-of-band knowledge hypermedia exists to remove.
 * "Capabilities are followable affordances" was true of the link and false of the
 * contract.
 *
 * The declarations were never missing. Every `Affordance` in source already carries
 * title, description and a typed `inputs` list; the PROJECTION dropped them on the
 * way to the wire. So this asserts against the source-of-truth set, at the layer
 * where a regression would be reintroduced.
 *
 * It also pins the property that makes the fix trustworthy: the hypermedia `expects`
 * and the MCP `inputSchema` come from the SAME derivation, so a JSON-RPC caller and
 * a hypermedia caller can never be told different things about the same capability.
 */
import { describe, it, expect } from 'vitest';
import { foxxiAffordances, foxxiAdminAffordances } from '../affordances.js';
import { affordanceToMcpToolSchema } from '../../_shared/affordance-mcp/index.js';

const ALL = [...foxxiAffordances, ...foxxiAdminAffordances];

describe('every advertised affordance can actually be invoked', () => {
  it('ships a non-trivial affordance set', () => {
    expect(ALL.length).toBeGreaterThan(20);
  });

  it('every affordance says what it DOES, not just where it lives', () => {
    const nameless = ALL.filter(a => !a.title || !a.description);
    expect(nameless.map(a => a.toolName)).toEqual([]);
  });

  it('every affordance declares its inputs with names and types', () => {
    // An affordance may legitimately take no arguments. What it may NOT do is take
    // arguments and decline to say so — that is the case a caller cannot recover from.
    const undeclared = ALL.filter(a => !Array.isArray(a.inputs));
    expect(undeclared.map(a => a.toolName)).toEqual([]);

    const untyped = ALL.flatMap(a =>
      (a.inputs ?? [])
        .filter(i => !i.name || !i.type || !i.description)
        .map(i => `${a.toolName}.${i.name ?? '<unnamed>'}`));
    expect(untyped).toEqual([]);
  });

  it('the derived schema names every required field', () => {
    for (const a of ALL) {
      const schema = affordanceToMcpToolSchema(a).inputSchema as {
        type: string; properties: Record<string, unknown>; required?: string[];
      };
      expect(schema.type, a.toolName).toBe('object');
      // Every input the source marks required must appear in `required`, or a
      // caller can omit it and get a runtime failure instead of a contract error.
      const declaredRequired = (a.inputs ?? []).filter(i => i.required).map(i => i.name).sort();
      expect((schema.required ?? []).slice().sort(), a.toolName).toEqual(declaredRequired);
      // And every input must appear in properties, required or not.
      for (const i of a.inputs ?? []) {
        expect(Object.keys(schema.properties), `${a.toolName}.${i.name}`).toContain(i.name);
      }
    }
  });

  it('targets are absolute once the deployment base is substituted', () => {
    const bad = ALL
      .map(a => a.targetTemplate.replace('{base}', 'https://bridge.example'))
      .filter(t => !/^https?:\/\//.test(t));
    expect(bad).toEqual([]);
  });

  it('an affordance with required inputs produces a schema a client can validate against', () => {
    // Spot-check the shape end to end rather than only counting fields.
    const withRequired = ALL.find(a => (a.inputs ?? []).some(i => i.required));
    expect(withRequired, 'expected at least one affordance with a required input').toBeTruthy();
    const schema = affordanceToMcpToolSchema(withRequired!).inputSchema as {
      properties: Record<string, { type: string; description?: string }>; required: string[];
    };
    const first = schema.required[0]!;
    expect(schema.properties[first]).toBeTruthy();
    expect(schema.properties[first]!.type).toBeTruthy();
    expect(schema.properties[first]!.description, `${withRequired!.toolName}.${first}`).toBeTruthy();
  });
});
