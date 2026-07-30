/**
 * Every derived tool schema is one MCP SDK v2 actually accepts.
 *
 * ★ WHY. `affordance-mcp` declared an `outputSchema` describing the WIRE ENVELOPE
 * (`{ content, isError }`) with the real payload hidden in a non-standard
 * `x-payload-schema` extension, while the vertical-bridge mount returned only
 * `content`. Since MCP 2025-06-18 that is backwards: `outputSchema` describes the
 * RESULT PAYLOAD, and declaring one OBLIGES the tool to return conforming
 * `structuredContent`.
 *
 * Nothing caught it. The mount advertises `2024-11-05` — a revision with no
 * outputSchema concept — so no client validated, and the low-level server class
 * validates nothing either. The failure only appears when something checks:
 * v2's `McpServer` refuses the result, and v2 CLIENTS validate regardless of which
 * server class served them. And the server-side refusal is an `isError` result at
 * **HTTP 200**, so a smoke test reading status codes stays green while every
 * capability is broken.
 *
 * So this test hands the REAL derived schemas to the REAL v2 `McpServer` and calls the
 * tools with the shape the mount actually returns. It is the only check that closes the
 * loop between what we DECLARE and what we RETURN.
 *
 * It also incidentally guards two other things v2 makes fatal, on all 91 foxxi
 * affordances at once:
 *   - a duplicate toolName (registerTool throws) — see toolnames-are-unique.test.ts
 *   - an inputSchema whose root is not `type: "object"` (registerTool throws)
 */
import { describe, it, expect } from 'vitest';
import { McpServer, fromJsonSchema } from '@modelcontextprotocol/server';
import { InMemoryTransport } from '@modelcontextprotocol/server';
import { Client } from '@modelcontextprotocol/client';
import { affordanceToMcpToolSchema } from '../../_shared/affordance-mcp/index.js';
import { toStructuredContent } from '@interego/core';
import { foxxiAffordances, foxxiAdminAffordances } from '../affordances.js';

const ALL = [...foxxiAffordances, ...foxxiAdminAffordances];

/** A payload shaped like what a real handler returns, including nullish fields. */
const SAMPLE_PAYLOAD = {
  ok: true,
  count: 3,
  label: 'a result',
  optionalAbsent: null,
  nested: { inner: 'value', alsoAbsent: null },
  list: [{ id: 'x1' }, { id: 'x2' }],
};

/** A payload shaped like the soft-error return several handlers produce. */
const SOFT_ERROR_PAYLOAD = { error: 'something was refused', code: 'REFUSED' };

/** Human-readable text, which a few handlers return instead of JSON. */
const TEXT_PAYLOAD = 'Published 3 descriptors.\n  - one\n  - two';

async function connectedPair(register: (s: McpServer) => void) {
  const server = new McpServer({ name: 'schema-conformance', version: '0.0.1' });
  register(server);
  const client = new Client({ name: 'schema-conformance-client', version: '0.0.1' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  return { server, client };
}

describe('the derived tool schemas satisfy MCP SDK v2', () => {
  it('registers all 91 foxxi affordances without throwing', async () => {
    // registerTool throws on a duplicate name and on a non-object inputSchema root, so
    // getting through the whole set is itself the assertion.
    const { client } = await connectedPair((server) => {
      for (const a of ALL) {
        const derived = affordanceToMcpToolSchema(a);
        server.registerTool(
          derived.name,
          {
            description: derived.description,
            inputSchema: fromJsonSchema(derived.inputSchema),
            outputSchema: fromJsonSchema(derived.outputSchema),
          },
          async () => ({
            content: [{ type: 'text' as const, text: JSON.stringify(SAMPLE_PAYLOAD) }],
            structuredContent: toStructuredContent(SAMPLE_PAYLOAD),
          }),
        );
      }
    });
    try {
      const listed = await client.listTools();
      expect(listed.tools.length).toBe(ALL.length);
      // v2 refuses a tool whose outputSchema will not compile, BEFORE any call — so a
      // successful listTools on the client side also proves every schema compiles.
      for (const t of listed.tools) {
        expect(t.outputSchema, `${t.name} lost its outputSchema`).toBeTruthy();
        expect((t.outputSchema as { type?: string }).type, `${t.name} outputSchema.type`).toBe('object');
        expect((t.inputSchema as { type?: string }).type, `${t.name} inputSchema.type`).toBe('object');
      }
    } finally {
      await client.close();
    }
  }, 60_000);

  // ★ The heart of it: the declared schema must accept what the mount RETURNS.
  for (const [label, payload] of [
    ['a success payload with nullish fields', SAMPLE_PAYLOAD],
    ['a soft-error payload', SOFT_ERROR_PAYLOAD],
    ['a human-readable text payload', TEXT_PAYLOAD],
  ] as const) {
    it(`accepts ${label} for every affordance that declares outputs`, async () => {
      // Affordances WITH declared outputs are the strict case — those with none get a
      // permissive schema. Test a representative slice of the strict ones plus a few
      // permissive ones, since 91 round trips per payload is needless.
      const withOutputs = ALL.filter(a => a.outputs).slice(0, 12);
      const withoutOutputs = ALL.filter(a => !a.outputs).slice(0, 4);
      const subject = [...withOutputs, ...withoutOutputs];
      expect(subject.length, 'expected affordances to test').toBeGreaterThan(0);

      const { client } = await connectedPair((server) => {
        for (const a of subject) {
          const derived = affordanceToMcpToolSchema(a);
          server.registerTool(
            derived.name,
            {
              description: derived.description,
              inputSchema: fromJsonSchema(derived.inputSchema),
              outputSchema: fromJsonSchema(derived.outputSchema),
            },
            // Exactly the shape applications/_shared/vertical-bridge returns.
            async () => ({
              content: [{ type: 'text' as const, text: JSON.stringify(payload) }],
              structuredContent: toStructuredContent(payload),
            }),
          );
        }
      });

      try {
        for (const a of subject) {
          const derived = affordanceToMcpToolSchema(a);
          // Supply every required input so the call reaches the handler rather than
          // failing input validation — this test is about the OUTPUT contract.
          const args: Record<string, unknown> = {};
          for (const name of derived.inputSchema.required) {
            const prop = derived.inputSchema.properties[name];
            // Honour `enum` and `minimum`/`minItems`: v2 validates INPUT too (our
            // hand-rolled mount never did), so a placeholder that ignores the declared
            // constraints fails input validation and never reaches the output contract
            // this test is about.
            if (prop?.enum && prop.enum.length > 0) { args[name] = prop.enum[0]; continue; }
            args[name] =
              prop?.type === 'number' || prop?.type === 'integer' ? (prop.minimum ?? 1)
              : prop?.type === 'boolean' ? true
              : prop?.type === 'array' ? (prop.minItems ? Array.from({ length: prop.minItems }, () => 'x') : [])
              : prop?.type === 'object' ? {}
              : 'x';
          }
          const res = await client.callTool({ name: derived.name, arguments: args });
          const text = JSON.stringify(res);
          expect(res.isError ?? false,
            `${derived.name} returned isError for ${label}: ${text.slice(0, 260)}`).toBe(false);
          expect(text,
            `${derived.name} hit output validation for ${label}`).not.toMatch(/[Oo]utput validation error|no structured content was provided/);
        }
      } finally {
        await client.close();
      }
    }, 120_000);
  }

  it('no derived outputSchema describes the wire envelope any more', () => {
    // The regression this whole file exists for. An outputSchema with a top-level
    // `content` property is describing the envelope, not the payload — and the
    // x-payload-schema extension it used to hide the real shape in should be gone.
    for (const a of ALL) {
      const out = affordanceToMcpToolSchema(a).outputSchema as Record<string, unknown>;
      const props = (out.properties ?? {}) as Record<string, unknown>;
      expect('content' in props, `${a.toolName} outputSchema still describes the envelope`).toBe(false);
      expect(JSON.stringify(out),
        `${a.toolName} still carries the x-payload-schema workaround`).not.toContain('x-payload-schema');
    }
  });
});
