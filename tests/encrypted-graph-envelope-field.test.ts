/**
 * THE SEALED-READ TOOL MUST READ THE FIELD THE DESCRIPTOR ACTUALLY EMITS.
 *
 * ── ★★ WHAT THIS EXISTS FOR ─────────────────────────────────────────────────
 *
 * `get_encrypted_graph` is the read half of end-to-end encryption: it hands a member the sealed
 * envelope so they can open it with a key the relay does not hold. It shipped ADVERTISED AND INERT.
 *
 * `handleGetEncryptedGraph` delegated to `handleGetDescriptor` and then read the envelope location
 * out of `graph.accessURL`. That object is built as `{ url, mediaType, encrypted, content }` and has
 * no `accessURL` at any point — the name came from `dcat:accessURL` in the Turtle, which is what the
 * PARSER's intermediate (`link.accessURL`) is called, not the response field. So the location was
 * always `undefined`, and the tool answered `no_envelope_url` for every encrypted graph it was ever
 * asked for: the only case it exists to serve.
 *
 * Nothing caught it. `tsc` was happy — reading an undeclared property off a locally-widened type is
 * legal, and the type annotation at the read site DECLARED `accessURL?: string`, so the two sides
 * disagreed in writing and still compiled. And the failure is indistinguishable from a descriptor
 * that genuinely names no distribution, so it reads as data, not as a bug. Only a live round trip
 * that published a sealed graph and tried to open it surfaced this.
 *
 * ── ★ WHY IT COMPARES THE TWO SIDES RATHER THAN ASSERTING A NAME ────────────
 *
 * Pinning the literal `graph.url` would pass for the wrong reason the moment `handleGetDescriptor`
 * renames its field — the same class of drift, reintroduced, with a green test. So the invariant
 * under test is the AGREEMENT: whatever key the sealed-read handler reaches for must be one the
 * descriptor response declares.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const RELAY_SRC = readFileSync(join(process.cwd(), 'deploy', 'mcp-relay', 'server.ts'), 'utf8');

/** The keys `handleGetDescriptor` puts on its `graph` object, from its own type annotation. */
function fieldsTheDescriptorEmits(): string[] {
  const m = /let graph:\s*\{([^}]*)\}\s*\|\s*undefined/.exec(RELAY_SRC);
  expect(m, 'handleGetDescriptor no longer declares its `graph` object shape — this guard cannot see the contract any more').toBeTruthy();
  return (m?.[1] ?? '').split(';').map((f) => f.split(':')[0]?.trim() ?? '').filter(Boolean);
}

/** The body of `handleGetEncryptedGraph`, comments stripped so prose about the old bug cannot satisfy a match. */
function sealedReadBody(): string {
  const start = RELAY_SRC.indexOf('async function handleGetEncryptedGraph');
  expect(start, 'handleGetEncryptedGraph is gone or renamed').toBeGreaterThan(-1);
  const end = RELAY_SRC.indexOf('\nasync function ', start + 1);
  return RELAY_SRC.slice(start, end === -1 ? RELAY_SRC.length : end)
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/\/\/[^\n]*/g, '');
}

describe('get_encrypted_graph reads a field the descriptor emits', () => {
  it('★★ the key it takes the envelope location from is one handleGetDescriptor declares', () => {
    const emitted = fieldsTheDescriptorEmits();
    expect(emitted).toContain('url');

    // The property read that feeds `envelopeUrl` — the value that decides whether an envelope is
    // fetched at all, and the exact thing that was wrong.
    const read = /const envelopeUrl\s*=\s*[^;]*?graph\?\.(\w+)/.exec(sealedReadBody());
    expect(read, 'envelopeUrl is no longer derived from a field of the descriptor `graph` object').toBeTruthy();
    expect(emitted).toContain(read?.[1]);
  });

  it('★ and the type it asserts on that object does not claim a field the descriptor never sends', () => {
    /**
     * The annotation is what made the original wrong read typecheck. A cast that promises
     * `accessURL?: string` on an object which never carries one is the lie the compiler was told,
     * so it is checked too — otherwise a future edit could re-add the phantom field and the read
     * above would compile against it again.
     */
    const emitted = fieldsTheDescriptorEmits();
    const cast = /gd\['graph'\]\s*as\s*\{([^}]*)\}/.exec(sealedReadBody());
    expect(cast, 'handleGetEncryptedGraph no longer casts the descriptor `graph` object').toBeTruthy();
    const claimed = (cast?.[1] ?? '').split(';').map((f) => f.split(/[?:]/)[0]?.trim() ?? '').filter(Boolean);
    expect(claimed.length).toBeGreaterThan(0);
    for (const f of claimed) expect(emitted, 'claims `' + f + '`, which the descriptor response does not emit').toContain(f);
  });

  it('★ the tool is still declared, since a handler nothing advertises is a tool that does not exist', () => {
    // This shipped wrong once too: handler and dispatch entry landed without the declaration, so
    // no client could discover it. Both halves are asserted rather than assumed.
    expect(RELAY_SRC).toContain("name: 'get_encrypted_graph'");
    expect(RELAY_SRC).toMatch(/get_encrypted_graph:\s*\{[^}]*handler:\s*handleGetEncryptedGraph/);
  });
});
