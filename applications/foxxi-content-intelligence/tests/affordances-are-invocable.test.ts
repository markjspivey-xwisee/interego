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
import { affordanceToMcpToolSchema, affordancesManifestTurtle } from '../../_shared/affordance-mcp/index.js';
import { Parser } from 'n3';

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

  it('the published Turtle manifest actually PARSES', () => {
    // ★ THE ONE A STATUS-CODE CHECK CANNOT MAKE, and it was green over a broken
    // document for months. /affordances served 198 KB of Turtle in which a single
    // dangling `hydra:supportedProperty` — emitted for the one affordance with
    // `inputs: []` — made the ENTIRE graph unparseable. Every smoke test saw 200.
    // No RDF client could read a single triple.
    //
    // It matters more than its size suggests: that document is the redirect target
    // of every https://relay.interego.xwisee.com/ns/iep/action/foxxi/* action IRI,
    // so follow-your-nose landed on something no parser would accept.
    //
    // Serving RDF is a promise to be parseable. Assert the promise, not the status.
    const ttl = affordancesManifestTurtle(
      'https://foxxi-bridge.interego.xwisee.com/affordances',
      ALL,
      'https://foxxi-bridge.interego.xwisee.com',
    );
    const quads = new Parser().parse(ttl);
    expect(quads.length).toBeGreaterThan(1000);
  });

  it('an affordance with NO inputs still emits valid Turtle', () => {
    // The exact shape that broke it, pinned on its own so a regression names itself
    // rather than surfacing as "the manifest stopped parsing".
    const zeroInput = ALL.filter(a => !(a.inputs ?? []).length);
    for (const a of zeroInput) {
      const ttl = affordancesManifestTurtle(
        'https://x.test/affordances', [a], 'https://x.test');
      expect(() => new Parser().parse(ttl), a.toolName).not.toThrow();
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

  // ── The LRS must be reachable by walking the manifest ────────────────────
  //
  // This bridge is a conformant xAPI 2.0 LRS, and the manifest declared none of it.
  // An agent walking 90 capabilities could not learn that a queryable statement
  // store existed; it had to read /xapi/about or already know the paths.
  //
  // The answer is deliberately ONE affordance rather than twenty. /xapi/statements,
  // /xapi/activities, /xapi/agents and the three document resources are fixed by the
  // xAPI specification and identical on every conformant LRS — restating them here
  // would duplicate a standard this vertical does not own, and the copy would drift
  // the first time the spec moved. What was missing was the POINTER.
  it('declares a way to find the LRS without restating the xAPI specification', () => {
    const door = ALL.find(a => a.targetTemplate.endsWith('/xapi/about'));
    expect(door, 'no affordance points at the LRS discovery document').toBeTruthy();
    expect(door!.method).toBe('GET');
    expect(door!.externallyRouted, 'the route is served by attachXapiLrsRoutes').toBe(true);

    // It has to say where the rest of the surface is, or it is a link to nowhere useful.
    const d = door!.description;
    expect(d).toMatch(/\/xapi\/statements/);
    expect(d, 'a reader must learn how to get credentials, not just where the LRS is')
      .toMatch(/credential/i);

    // …and the manifest must NOT have grown a copy of the spec's own routes.
    const rawLrsRoutes = ALL.filter(a => /\{base\}\/xapi\/(statements|activities|agents|state|profile)/.test(a.targetTemplate));
    expect(rawLrsRoutes.map(a => a.toolName),
      'spec-defined LRS routes should be reached via the about document, not re-declared').toEqual([]);
  });

  // Every foxxi.* tool a description points a reader at must exist. A manifest that
  // cites a capability by a name nothing answers to is the same dangling reference as
  // a URL that 404s — it just fails later, in the reader's code.
  it('cross-references in descriptions name tools that exist', () => {
    const names = new Set(ALL.map(a => a.toolName));
    const dangling: string[] = [];
    for (const a of ALL) {
      for (const m of (a.description ?? '').matchAll(/\bfoxxi\.[a-z0-9_]+/g)) {
        if (!names.has(m[0])) dangling.push(`${a.toolName} -> ${m[0]}`);
      }
    }
    expect(dangling).toEqual([]);
  });
});
