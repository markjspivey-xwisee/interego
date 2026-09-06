import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import ts from 'typescript';
import { createEncryptedEnvelope, generateKeyPair } from '@interego/core';

const relay = readFileSync('deploy/mcp-relay/server.ts', 'utf8');
const parser = readFileSync('deploy/mcp-relay/sealed-payload.ts', 'utf8');
const source = ts.createSourceFile('server.ts', relay, ts.ScriptTarget.Latest, true);
const propertyName = (name: ts.PropertyName): string | undefined =>
  ts.isIdentifier(name) || ts.isStringLiteral(name) ? name.text : undefined;
const property = (object: ts.ObjectLiteralExpression, name: string): ts.Expression | undefined => {
  for (const p of object.properties) {
    if (ts.isPropertyAssignment(p) && propertyName(p.name) === name) return p.initializer;
  }
  return undefined;
};

describe('the advertised publishing interface reaches the existing sealed parser', () => {
  it('exposes every argument consumed by the sealed-payload parser', () => {
    let declaration: ts.ObjectLiteralExpression | undefined;
    const visit = (node: ts.Node): void => {
      if (ts.isObjectLiteralExpression(node)) {
        const name = property(node, 'name');
        if (name && ts.isStringLiteral(name) && name.text === 'publish_context' && property(node, 'inputSchema')) declaration = node;
      }
      ts.forEachChild(node, visit);
    };
    visit(source);
    if (!declaration) throw new Error('publish_context has no advertised input schema');
    const schema = property(declaration, 'inputSchema');
    if (!schema || !ts.isObjectLiteralExpression(schema)) throw new Error('publishing schema cannot be inspected');
    const properties = property(schema, 'properties');
    if (!properties || !ts.isObjectLiteralExpression(properties)) throw new Error('publishing properties cannot be inspected');
    const advertised = properties.properties.flatMap(p => ts.isPropertyAssignment(p) ? [propertyName(p.name)] : []);
    const consumed = [...parser.matchAll(/args\['([^']+)'\]/g)].map(match => match[1]!);
    expect(consumed.length).toBeGreaterThan(0);
    for (const argument of new Set(consumed)) expect(advertised, `sealed parser consumes hidden argument ${argument}`).toContain(argument);
  });
});

// Execute the actual handler, without importing server.ts and opening a listener.
// Dependencies only provide transport and an authentic descriptor response shape.
const start = relay.indexOf('async function handleGetEncryptedGraph(');
const end = relay.indexOf('\nasync function ', start + 1);
if (start < 0 || end < 0) throw new Error('sealed read handler was not found');
const compiled = ts.transpileModule(relay.slice(start, end), {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None },
}).outputText;

function sealedReader(graph: Record<string, unknown>, envelope: string, fetched: string[]) {
  return new Function('normalizeCssUrl', 'handleGetDescriptor', 'guardedInvokeFetch',
    compiled + '\nreturn handleGetEncryptedGraph;')(
    (url: string) => url,
    async () => JSON.stringify({ graph }),
    async (url: string) => { fetched.push(url); return { ok: true, text: async () => envelope }; },
  ) as (args: { url: string }) => Promise<string>;
}

describe('a request for ciphertext stays a request for ciphertext', () => {
  it('returns the original envelope even when descriptor reading decrypted it for this caller', async () => {
    const key = generateKeyPair();
    const privateText = 'confidential graph payload';
    const envelope = JSON.stringify(createEncryptedEnvelope(privateText, [key.publicKey], key));
    const url = 'https://store.example/owner/1.envelope.jose.json';
    const fetched: string[] = [];
    const read = sealedReader({ url, encrypted: true, content: privateText }, envelope, fetched);
    const result = JSON.parse(await read({ url: 'https://store.example/owner/1.ttl' }));
    expect(result.encrypted).toBe(true);
    expect(result.envelope).toBe(envelope);
    expect(result).not.toHaveProperty('content');
    expect(JSON.stringify(result)).not.toContain(privateText);
    expect(fetched).toEqual([url]);
  });

  it('still returns plaintext for an artifact that was actually published in plaintext', async () => {
    const fetched: string[] = [];
    const read = sealedReader({ encrypted: false, content: 'public graph' }, '', fetched);
    const result = JSON.parse(await read({ url: 'https://store.example/owner/2.ttl' }));
    expect(result).toMatchObject({ encrypted: false, content: 'public graph' });
    expect(fetched).toEqual([]);
  });
});
