/**
 * @interego/agent-interop — engine + profile tests.
 *
 * The load-bearing test here is the DRIFT GUARD: it greps the engine source for any
 * mention of a wire protocol. The architecture's claim is that a protocol is data,
 * and a claim that is only stated in a comment rots. This one fails the build.
 */

import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import {
  EngagementEngine, renderCard, cardVersion, capabilitiesFromAffordances,
  A2A_PROFILE, INTEREGO_AGENTS_PROFILE, PROFILES,
  type AgentIdentity,
} from '../packages/agent-interop/src/index.js';

const SRC = join(process.cwd(), 'packages', 'agent-interop', 'src');

function filesUnder(dir: string, out: string[] = []): string[] {
  for (const e of readdirSync(dir)) {
    const p = join(dir, e);
    if (statSync(p).isDirectory()) filesUnder(p, out);
    else if (p.endsWith('.ts')) out.push(p);
  }
  return out;
}

const IDENTITY: AgentIdentity = {
  id: 'https://relay.example/agents/probe',
  name: 'Probe Agent',
  description: 'A test agent.',
  serviceUrl: 'https://relay.example',
  capabilities: capabilitiesFromAffordances([
    { action: 'https://relay.example/ns/iep/action/foxxi/diagnose', title: 'Diagnose', comment: 'Diagnose a situation.', vertical: 'foxxi' },
    { action: 'https://relay.example/ns/iep/action/foxxi/teach', title: 'Teach', comment: 'Teach an agent.', vertical: 'foxxi' },
    // Dropped: no action URL means it could never be followed.
    { title: 'Unfollowable', comment: 'no action url' },
    // Dropped: a urn is not dereferenceable.
    { action: 'urn:iep:action:legacy:thing', title: 'Legacy', comment: 'urn' },
  ]),
  auth: { oauth2: { metadataUrl: 'https://relay.example/.well-known/oauth-authorization-server', pkceRequired: true } },
};

describe('spec-blindness drift guard', () => {
  it('no file under src/ (outside profiles/) names a wire protocol', () => {
    const offenders: string[] = [];
    for (const f of filesUnder(SRC)) {
      if (f.includes(`${'profiles'}${require('node:path').sep}`)) continue;
      const body = readFileSync(f, 'utf8');
      // The engine may not name the protocol anywhere — code OR comment.
      if (/\ba2a\b/i.test(body) || /agent2agent/i.test(body)) offenders.push(f);
    }
    expect(offenders, `engine files naming the protocol: ${offenders.join(', ')}`).toEqual([]);
  });

  it('the protocol IS named in its profile (the mapping lives in data)', () => {
    const body = readFileSync(join(SRC, 'profiles', 'a2a.profile.ts'), 'utf8');
    expect(/a2a/i.test(body)).toBe(true);
  });
});

describe('two profiles over one engine — a second format is DATA ONLY', () => {
  it('one source model renders through both profiles', () => {
    const a2a = renderCard(A2A_PROFILE, IDENTITY);
    const iep = renderCard(INTEREGO_AGENTS_PROFILE, IDENTITY);
    // Genuinely different documents...
    expect(a2a.document['protocolVersion']).toBe('1.0');
    expect(iep.document['@type']).toBe('iep:Agent');
    // ...from the same capabilities.
    expect((a2a.document['skills'] as unknown[]).length).toBe(2);
    expect((iep.document['iep:offers'] as unknown[]).length).toBe(2);
    expect(PROFILES['a2a']).toBe(A2A_PROFILE);
    expect(PROFILES['interego-agents']).toBe(INTEREGO_AGENTS_PROFILE);
  });
});

describe('card projection', () => {
  it('skill ids are the dereferenceable action URLs; unfollowable ones are dropped', () => {
    const { document } = renderCard(A2A_PROFILE, IDENTITY);
    const ids = (document['skills'] as Array<{ id: string }>).map(s => s.id);
    expect(ids).toEqual([
      'https://relay.example/ns/iep/action/foxxi/diagnose',
      'https://relay.example/ns/iep/action/foxxi/teach',
    ]);
    for (const id of ids) expect(id.startsWith('https://')).toBe(true);
    expect(ids.some(i => i.startsWith('urn:'))).toBe(false);
  });

  it('declares the unimplemented capabilities FALSE rather than omitting them', () => {
    const { document } = renderCard(A2A_PROFILE, IDENTITY);
    expect(document['capabilities']).toEqual({
      streaming: false, pushNotifications: false, stateTransitionHistory: false,
    });
  });

  it('carries NO conformance claim while the profile is unverified', () => {
    const { document } = renderCard(A2A_PROFILE, IDENTITY);
    expect(A2A_PROFILE.conformanceStatus).toBe('unverified');
    expect(JSON.stringify(document).toLowerCase()).not.toContain('conformant');
    expect(JSON.stringify(document).toLowerCase()).not.toContain('certified');
  });

  it('version is content-derived: stable for equal input, changed by a new capability', () => {
    const a = renderCard(A2A_PROFILE, IDENTITY).version;
    const b = renderCard(A2A_PROFILE, IDENTITY).version;
    expect(a).toBe(b);
    const more: AgentIdentity = {
      ...IDENTITY,
      capabilities: [...IDENTITY.capabilities, { id: 'https://relay.example/ns/iep/action/x/y', name: 'Y', description: '' }],
    };
    expect(renderCard(A2A_PROFILE, more).version).not.toBe(a);
  });

  it('cardVersion ignores key order', () => {
    expect(cardVersion({ a: 1, b: { c: 2, d: 3 } })).toBe(cardVersion({ b: { d: 3, c: 2 }, a: 1 }));
  });
});

describe('engagement engine — owner scoping and bounds', () => {
  const ALICE = 'did:ethr:0xA';
  const BOB = 'did:ethr:0xB';
  const mk = () => new EngagementEngine('https://relay.example');

  it('requires a verified caller to open', () => {
    const r = mk().open({ caller: undefined, parts: [{ kind: 'text', text: 'hi' }] });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.kind).toBe('unauthenticated');
  });

  it('mints a dereferenceable URL id, never a urn', () => {
    const r = mk().open({ caller: ALICE, parts: [{ kind: 'text', text: 'hi' }] });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.value.id.startsWith('https://relay.example/engagements/')).toBe(true);
      expect(r.value.id.startsWith('urn:')).toBe(false);
    }
  });

  it('another principal cannot read it, and cannot tell it exists', () => {
    const e = mk();
    const opened = e.open({ caller: ALICE, parts: [{ kind: 'text', text: 'secret' }] });
    expect(opened.ok).toBe(true);
    if (!opened.ok) return;
    const asBob = e.get(opened.value.id, BOB);
    expect(asBob.ok).toBe(false);
    // notFound, NOT forbidden — a distinct 403 is an existence oracle.
    if (!asBob.ok) expect(asBob.error.kind).toBe('notFound');
    const missing = e.get('https://relay.example/engagements/nope', BOB);
    if (!missing.ok) expect(missing.error.kind).toBe('notFound');
  });

  it('list returns only the caller\'s own engagements', () => {
    const e = mk();
    e.open({ caller: ALICE, parts: [{ kind: 'text', text: '1' }] });
    e.open({ caller: BOB, parts: [{ kind: 'text', text: '2' }] });
    const mine = e.list(ALICE);
    expect(mine.ok).toBe(true);
    if (mine.ok) {
      expect(mine.value.length).toBe(1);
      expect(mine.value[0]!.openedBy).toBe(ALICE);
    }
  });

  it('attribution comes from the caller, not the payload', () => {
    const e = mk();
    const r = e.open({ caller: ALICE, parts: [{ kind: 'text', text: 'x' }] });
    if (r.ok) expect(r.value.turns[0]!.attributedTo).toBe(ALICE);
  });

  it('refuses illegal transitions and further turns once terminal', () => {
    const e = mk();
    const r = e.open({ caller: ALICE, parts: [{ kind: 'text', text: 'x' }] });
    if (!r.ok) return;
    expect(e.cancel(r.value.id, ALICE).ok).toBe(true);
    const again = e.transition({ id: r.value.id, caller: ALICE, to: 'working' });
    expect(again.ok).toBe(false);
    const more = e.appendTurn({ id: r.value.id, caller: ALICE, role: 'responder', parts: [{ kind: 'text', text: 'y' }] });
    expect(more.ok).toBe(false);
  });

  it('the store is bounded (no unbounded-growth OOM primitive)', () => {
    const e = new EngagementEngine('https://relay.example', { maxEngagements: 10 });
    for (let i = 0; i < 50; i++) e.open({ caller: ALICE, parts: [{ kind: 'text', text: String(i) }] });
    expect(e.size()).toBeLessThanOrEqual(10);
  });

  it('rejects an oversized turn rather than truncating it', () => {
    const e = new EngagementEngine('https://relay.example', { maxPartsPerTurn: 2 });
    const r = e.open({ caller: ALICE, parts: [{ kind: 'text', text: 'a' }, { kind: 'text', text: 'b' }, { kind: 'text', text: 'c' }] });
    expect(r.ok).toBe(false);
  });
});

describe('lifecycle + engagement projection', () => {
  it('A2A spells cancelled with one l, and round-trips both spellings inbound', () => {
    expect(A2A_PROFILE.lifecycle.name('cancelled')).toBe('canceled');
    expect(A2A_PROFILE.lifecycle.parse('canceled')).toBe('cancelled');
    expect(A2A_PROFILE.lifecycle.parse('cancelled')).toBe('cancelled');
    expect(A2A_PROFILE.lifecycle.parse('nonsense')).toBeUndefined();
  });

  it('parts emit a single discriminating member (no removed `kind` field)', () => {
    const e = new EngagementEngine('https://relay.example');
    const r = e.open({ caller: 'did:ethr:0xA', parts: [{ kind: 'text', text: 'hello' }] });
    if (!r.ok) return;
    const doc = A2A_PROFILE.engagement.render(r.value, { serviceUrl: 'https://relay.example' });
    const part = (doc['history'] as Array<{ parts: Array<Record<string, unknown>> }>)[0]!.parts[0]!;
    expect(part).toEqual({ text: 'hello' });
    expect('kind' in part).toBe(false);
  });

  it('every engine error kind has a profile mapping', () => {
    for (const p of Object.values(PROFILES)) {
      for (const k of ['unauthenticated', 'forbidden', 'notFound', 'badRequest', 'unsupportedOperation', 'internal'] as const) {
        expect(p.errors[k], `${p.slug} missing ${k}`).toBeTruthy();
        expect(p.errors[k].message.toLowerCase()).not.toContain('stack');
      }
    }
  });
});
