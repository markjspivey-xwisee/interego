/**
 * AN AGENT'S OWN RECORD OF ITS WORK, VALIDATED AGAINST THE PUBLISHED SHAPE.
 *
 * ── ★★ THE FACT THIS EXISTS TO CARRY ────────────────────────────────────────
 *
 * `agent-turns.jsonl` recorded `ok: true` for every turn where the MODEL ran, and said nothing
 * about whether a word of it survived. Measured live: a delegate ran three turns, each logging
 * success, each costing real money, and wrote nothing at all — while the person who had asked
 * twice sat looking at silence. Working out why meant asking them to read their own UI aloud.
 *
 * `ieh:turnOutcome` is that missing fact, and the shape makes it non-optional. These tests hold
 * the emitter against the SHAPE AS PUBLISHED — not against a copy — so a term renamed in one and
 * not the other fails here rather than at a pod write.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { validateAgainstShape } from '@interego/core';
import { turnTurtle, turnsGraphIri, turnIri, type AgentTurnFacts } from '../packages/workspace-client/src/turnrecord.js';

const ROOT = process.cwd();
/** ★ THE PUBLISHED FILES, read from disk. A fixture copy of a shape validates nothing about it. */
const SHAPES = readFileSync(join(ROOT, 'docs/ns/harness-shapes.ttl'), 'utf8')
  + '\n' + readFileSync(join(ROOT, 'docs/ns/harness.ttl'), 'utf8');

const RELAY = 'https://relay.interego.xwisee.com';
const POD = 'u-eth-8f3b8e939600';
const AGENT = 'did:web:identity.interego.xwisee.com:agents:interego-delegate-u-eth-03f52e15b9df';

const facts = (over: Partial<AgentTurnFacts> = {}): AgentTurnFacts => ({
  turnId: 'df69787c-afed-4709-a2e4-c5045328377e',
  agentId: AGENT,
  atIso: '2026-08-16T02:40:15.431Z',
  outcome: 'Refused',
  ...over,
});

const conforms = (f: AgentTurnFacts): { ok: boolean; why: string } => {
  const r = validateAgainstShape(turnTurtle(RELAY, POD, f), SHAPES, { entailment: 'rdfs' });
  return { ok: r.conforms, why: r.results.map((x) => String(x.message ?? x.constraintComponent)).join('; ') };
};

describe('★★ a turn record conforms to the published harness shape', () => {
  it('a refusal — the case that was previously invisible', () => {
    const v = conforms(facts({
      outcome: 'Refused',
      outcomeReason: 'Your agent did not declare which footing it was speaking on, so nothing was written.',
      answeredFor: 'https://identity.interego.xwisee.com/users/u-eth-8f3b8e939600/profile#me',
      inChannel: RELAY + '/ns/' + POD + '/d-1535759551247417436',
      inputTokens: 7, outputTokens: 774, cacheReadTokens: 95002, cacheCreationTokens: 13995,
      costUsd: 0.10098684999999999, elapsedMs: 22443, providerTurns: 3, toolCallCount: 2,
      models: ['claude-haiku-4-5-20251001', 'claude-sonnet-4-6'],
    }));
    expect(v.ok, v.why).toBe(true);
  });

  it('a posted turn, and an abstention, and a failure', () => {
    for (const outcome of ['Posted', 'Abstained', 'Failed'] as const) {
      const v = conforms(facts({ outcome }));
      expect(v.ok, outcome + ': ' + v.why).toBe(true);
    }
  });

  it('★ the minimum: an agent, a time, and what became of it', () => {
    // Everything else is genuinely optional — a provider that reports no usage is a fact about the
    // provider, and the record must still be publishable.
    expect(conforms(facts()).ok).toBe(true);
  });
});

describe('★★ what the shape refuses', () => {
  /**
   * Each of these would publish a permanent record that cannot answer the question it exists for.
   * The relay validates `conforms_to_shapes` BEFORE the pod write, so they never land.
   */
  it('a turn with no outcome — the exact gap this vocabulary was added to close', () => {
    const ttl = turnTurtle(RELAY, POD, facts()).replace(/\s+ieh:turnOutcome ieh:\w+ ;/, '');
    const r = validateAgainstShape(ttl, SHAPES, { entailment: 'rdfs' });
    expect(r.conforms).toBe(false);
    expect(r.results.map((x) => String(x.message)).join(' ')).toContain('what became of it');
  });

  it('a turn attributed to nobody', () => {
    const ttl = turnTurtle(RELAY, POD, facts()).replace(/\s+prov:wasAssociatedWith <[^>]+> ;/, '');
    expect(validateAgainstShape(ttl, SHAPES, { entailment: 'rdfs' }).conforms).toBe(false);
  });

  it('a turn with no time — a cost series with no time axis answers nothing', () => {
    const ttl = turnTurtle(RELAY, POD, facts()).replace(/\s+prov:startedAtTime "[^"]+"\^\^xsd:dateTime ;/, '');
    expect(validateAgainstShape(ttl, SHAPES, { entailment: 'rdfs' }).conforms).toBe(false);
  });

  it('★ a negative cost', () => {
    const ttl = turnTurtle(RELAY, POD, facts()).replace('a ieh:AgentTurn ;', 'a ieh:AgentTurn ;\n  ieh:costUsd "-1"^^xsd:decimal ;');
    expect(validateAgainstShape(ttl, SHAPES, { entailment: 'rdfs' }).conforms).toBe(false);
  });
});

describe('what the emitter will not do', () => {
  it('★★ omits a number nobody reported rather than writing zero', () => {
    /**
     * `costUsd: 0` and "the provider told us nothing" are different claims, and a total summed
     * over the first is wrong in a direction nobody would notice. Absence is the honest encoding.
     */
    const ttl = turnTurtle(RELAY, POD, facts({ costUsd: null, inputTokens: undefined }));
    expect(ttl).not.toContain('costUsd');
    expect(ttl).not.toContain('inputTokens');
    // ...and includes one that WAS reported, so this is not passing on an empty emitter.
    expect(turnTurtle(RELAY, POD, facts({ costUsd: 0.05 }))).toContain('costUsd');
  });

  it('★★ carries no prompt and no reply — only the host\'s own sentence', () => {
    /**
     * The content already has a home: the ENTRY, published under its own authorship rules with its
     * own footing. Copying it here would republish somebody's words a second time, under different
     * rules, in a document they never reviewed.
     */
    const ttl = turnTurtle(RELAY, POD, facts({ outcomeReason: 'no footing declared' }));
    expect(ttl).toContain('no footing declared');
    for (const leak of ['prompt', 'reply', 'transcript', 'dct:description']) {
      expect(ttl, 'a turn record must not carry ' + leak).not.toContain(leak);
    }
  });

  it('★ refuses an unserializable agent id rather than escaping it', () => {
    // A Turtle IRI reference ends at the first '>' and the production has no escape for one, so
    // refusal is the only correct handling — the same rule every other writer here applies.
    expect(() => turnTurtle(RELAY, POD, facts({ agentId: 'did:web:evil> a <urn:x> . <urn:y> <urn:z> <urn:w' })))
      .toThrow(/not serializable as a Turtle IRI reference/);
  });
});

describe('where the turns live', () => {
  it('★ one graph per agent, one descriptor per turn — an append-only log', () => {
    /**
     * The same shape as an entry stream: `discover_context` over the graph IRI returns the series,
     * and nothing supersedes anything. A turn is a thing that happened; a later one does not
     * correct it, and superseding would collapse the series to a single current value.
     */
    expect(turnsGraphIri(RELAY, POD)).toBe(RELAY + '/ns/' + POD + '/agent-turns');
    expect(turnIri(RELAY, POD, 'abc')).toBe(RELAY + '/ns/' + POD + '/agent-turns/t/abc');
    // A turn id from a provider is not guaranteed URL-safe.
    expect(turnIri(RELAY, POD, 'a b/c')).toBe(RELAY + '/ns/' + POD + '/agent-turns/t/a%20b%2Fc');
  });
});
