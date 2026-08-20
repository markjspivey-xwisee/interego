#!/usr/bin/env tsx
/**
 * Every contract the operations catalog advertises must be fetchable, or absent.
 *
 * ★★ MEASURED AGAINST PRODUCTION BEFORE THIS EXISTED:
 *
 *   GET /.well-known/operations   -> 51 operations, all 51 carrying
 *                                     expects: "urn:iep:shape:input:<name>"
 *                                     sh:nodeShape: ".../shacl-shapes#urn:iep:shape:input:<name>"
 *   GET /.well-known/shacl-shapes -> 20 named subjects, ZERO of them urn:-prefixed
 *
 * The urns are non-dereferenceable by construction and the `#urn:…` fragment identified nothing.
 * `packages/core/src/model/agent.ts` refuses precisely this from every capability anyone else
 * publishes — "A SHAPE NOBODY CAN FETCH IS NOT A CONTRACT … present and unfetchable is refused" —
 * so the relay was breaking its own rule on its most public surface.
 *
 * Run from deploy/mcp-relay/:  npx tsx tests/operation-contracts.test.ts
 */
import { contractDocument, operationActionUrl, operationContract } from '../operation-contracts.js';

let pass = 0;
let fail = 0;
const ok = (name: string, cond: boolean, detail = ''): void => {
  if (cond) { pass++; return; }
  fail++;
  console.error(`  FAIL  ${name}${detail ? ` — ${detail}` : ''}`);
};

const BASE = 'https://relay.interego.xwisee.com';
const BOTH = { inputSchema: { type: 'object', properties: { a: { type: 'string' } } }, outputSchema: { type: 'object' } };

// ── 1. A published schema yields a fetchable http(s) URL ─────────────────────
{
  const c = operationContract(BASE, 'mint', BOTH);
  ok('expects is present', typeof c.expects === 'string');
  ok('returns is present', typeof c.returns === 'string');
  // The exact rule agent.ts enforces on everyone else.
  ok('expects is an http(s) URL', /^https?:\/\//.test(String(c.expects)), String(c.expects));
  ok('returns is an http(s) URL', /^https?:\/\//.test(String(c.returns)), String(c.returns));
  ok('expects is not a urn', !String(c.expects).startsWith('urn:'), String(c.expects));
  ok('expects addresses this operation', String(c.expects).endsWith('/.well-known/operations/mint/input'), String(c.expects));
  ok('returns addresses this operation', String(c.returns).endsWith('/.well-known/operations/mint/output'), String(c.returns));
}

// ── 2. ABSENT, never fabricated ──────────────────────────────────────────────
// Paired with case 1: a rule that always emits a URL passes case 1 and fails here.
{
  const inputOnly = operationContract(BASE, 'x', { inputSchema: { type: 'object' } });
  ok('an operation with no output schema advertises no returns', inputOnly.returns === undefined, String(inputOnly.returns));
  ok('and still advertises its input', typeof inputOnly.expects === 'string');

  const none = operationContract(BASE, 'y', undefined);
  ok('an operation with no schemas advertises neither', none.expects === undefined && none.returns === undefined);

  const empty = operationContract(BASE, 'z', {});
  ok('an empty schema record advertises neither', empty.expects === undefined && empty.returns === undefined);
}

// ── 3. The document served at that URL is the contract, and names itself ─────
{
  const doc = contractDocument(BASE, 'mint', 'input', BOTH);
  ok('a document is produced', doc !== undefined);
  ok('$id is the URL it is served at',
    doc?.['$id'] === `${BASE}/.well-known/operations/mint/input`, String(doc?.['$id']));
  ok('it carries the schema itself', doc?.['type'] === 'object', JSON.stringify(doc?.['type']));
  ok('it declares a JSON Schema dialect', typeof doc?.['$schema'] === 'string');
  // The address in the document must equal the address the catalog advertises, or a client that
  // saves the document keeps a different name for it than the one that led it there.
  ok('$id equals the advertised expects',
    doc?.['$id'] === operationContract(BASE, 'mint', BOTH).expects);

  ok('no document when the schema is absent', contractDocument(BASE, 'mint', 'input', {}) === undefined);
  ok('no document for a non-object schema',
    contractDocument(BASE, 'mint', 'input', { inputSchema: 'nope' as unknown }) === undefined);
}

// ── 4. The action id is the relay's own authority, not a urn ─────────────────
// The A2A card publishes this URL form for the same action; the catalog used to say
// `urn:iep:action:<name>`, so a peer resolving a skill id matched nothing here.
{
  const a = operationActionUrl(BASE, 'publish_context');
  ok('action is not a urn', !a.startsWith('urn:'), a);
  ok('action is the relay naming authority',
    a === `${BASE}/ns/iep/action/relay/publish_context`, a);
}

// ── 5. A trailing slash on the base cannot double up ─────────────────────────
{
  const c = operationContract(`${BASE}/`, 'mint', BOTH);
  ok('no doubled slash in expects', !String(c.expects).includes('//.well-known'), String(c.expects));
  ok('no doubled slash in action', !operationActionUrl(`${BASE}/`, 'mint').includes('//ns/'),
    operationActionUrl(`${BASE}/`, 'mint'));
}

console.log(`operation-contracts: ${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
