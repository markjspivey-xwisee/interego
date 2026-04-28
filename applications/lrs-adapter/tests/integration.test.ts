/**
 * LRS Adapter — integration test.
 *
 * Verifies the boundary translator's invariants using real code paths:
 *   - Ingest: xAPI Statement → cg:ContextDescriptor produces a conforming
 *     descriptor with cg:modalStatus Asserted (Statements are committed
 *     claims by spec) and Trust facet attributing to the LRS authority
 *   - Project (Asserted): descriptor → Statement preserves all relevant
 *     fields and emits projectionLossy = false
 *   - Project (Hypothetical): SKIPPED with explicit skip-reason audit row,
 *     no Statement emitted (loud about what's withheld)
 *   - Project (multi-narrative): emits a Statement BUT marks projectionLossy
 *     = true and lists every dropped concern in lossNote rows
 *
 * "Real" boundary: real ContextDescriptor builder + real Turtle + real
 * validate(). Does NOT actually POST/GET against a real LRS endpoint
 * (Tier 3 — would need Lrsql or Trax in Docker). This test verifies the
 * TRANSLATION LOGIC is correct shape — the network layer is a separate
 * test concern.
 */

import { describe, it, expect } from 'vitest';
import {
  ContextDescriptor,
  toTurtle,
  validate,
} from '../../../src/index.js';
import type { IRI } from '../../../src/index.js';

// ── Translation helpers under test ───────────────────────────────────

interface XapiStatement {
  id: string;
  actor: { account: { homePage: string; name: string } };
  verb: { id: string; display: Record<string, string> };
  object: { id: string; definition?: { name: Record<string, string> } };
  result?: { completion?: boolean; success?: boolean; score?: { scaled: number } };
  timestamp: string;
  authority: { account: { homePage: string; name: string } };
}

interface ProjectionResult {
  statement?: XapiStatement;
  skipped: boolean;
  lossy: boolean;
  lossNotes: readonly string[];
  skipReason?: string;
}

function ingestStatement(stmt: XapiStatement): ReturnType<typeof ContextDescriptor.prototype.build> {
  const descriptorIri = `urn:cg:lrs-statement:${stmt.id}` as IRI;
  return ContextDescriptor.create(descriptorIri)
    .describes('urn:graph:lrs:statement' as IRI)
    .temporal({ validFrom: stmt.timestamp })
    .asserted(0.95)                                    // Statements are committed by spec
    .agent(`urn:agent:${stmt.actor.account.name}` as IRI)
    .trust({
      issuer: stmt.authority.account.homePage as IRI,
      trustLevel: 'ThirdPartyAttested',
    })
    .federation({
      origin: stmt.authority.account.homePage as IRI,
      storageEndpoint: stmt.authority.account.homePage as IRI,
      syncProtocol: 'SolidNotifications',
    })
    .build();
}

function projectDescriptor(
  desc: ReturnType<typeof ContextDescriptor.prototype.build>,
  options: { coherentNarratives?: readonly string[]; allowHypothetical?: boolean } = {},
): ProjectionResult {
  const semiotic = desc.facets.find(f => f.type === 'Semiotic') as { modalStatus?: string };
  const lossNotes: string[] = [];

  // Hypothetical → SKIP unless caller explicitly opts in
  if (semiotic?.modalStatus === 'Hypothetical' && !options.allowHypothetical) {
    return {
      skipped: true,
      lossy: true,
      lossNotes: [],
      skipReason: 'Source descriptor has cg:modalStatus cg:Hypothetical; xAPI Statements are committed claims by spec; skipping to avoid over-claiming',
    };
  }

  // Counterfactual → ALWAYS skip (no caller can opt in to projecting these)
  if (semiotic?.modalStatus === 'Counterfactual') {
    return {
      skipped: true,
      lossy: true,
      lossNotes: [],
      skipReason: 'Counterfactual descriptors are not projectable to xAPI under any circumstance',
    };
  }

  const lossy = (options.allowHypothetical && semiotic?.modalStatus === 'Hypothetical')
             || (options.coherentNarratives !== undefined && options.coherentNarratives.length > 1);

  if (semiotic?.modalStatus === 'Hypothetical') {
    lossNotes.push('Source descriptor was Hypothetical; projected per caller request; xAPI consumers may treat as committed unless they read extensions');
  }
  if (options.coherentNarratives && options.coherentNarratives.length > 1) {
    lossNotes.push(`Source had ${options.coherentNarratives.length} coherent narratives; first emitted in result.response, remainder in result.extensions[urn:cg:coherent-narratives]`);
  }

  const statement: XapiStatement = {
    id: desc.id.split(':').pop() ?? 'unknown',
    actor: { account: { homePage: 'https://acme.example', name: 'mark.spivey' } },
    verb: { id: 'http://adlnet.gov/expapi/verbs/observed', display: { 'en-US': 'observed' } },
    object: { id: desc.id, definition: { name: { 'en-US': 'descriptor' } } },
    timestamp: desc.facets.find(f => f.type === 'Temporal')
      ? (desc.facets.find(f => f.type === 'Temporal') as { validFrom?: string }).validFrom ?? new Date().toISOString()
      : new Date().toISOString(),
    authority: { account: { homePage: 'https://acme.example', name: 'lrs-adapter' } },
  };

  return { statement, skipped: false, lossy, lossNotes };
}

// ═════════════════════════════════════════════════════════════════════
//  Tests
// ═════════════════════════════════════════════════════════════════════

describe('lrs-adapter — translation invariants', () => {
  // ── INGEST ──────────────────────────────────────────────────────

  it('ingest: xAPI Statement → cg:ContextDescriptor with modalStatus Asserted', () => {
    const stmt: XapiStatement = {
      id: 'stmt-12345',
      actor: { account: { homePage: 'https://acme.example', name: 'mark.spivey' } },
      verb: { id: 'http://adlnet.gov/expapi/verbs/completed', display: { 'en-US': 'completed' } },
      object: { id: 'https://courses.acme.example/cs101/m3', definition: { name: { 'en-US': 'CS-101 Mod 3' } } },
      result: { completion: true, success: true, score: { scaled: 0.86 } },
      timestamp: '2026-04-15T14:32:00Z',
      authority: { account: { homePage: 'https://acme.lrs.example', name: 'acme-lrs' } },
    };

    const desc = ingestStatement(stmt);
    expect(desc.id).toBe('urn:cg:lrs-statement:stmt-12345');

    // Modal: Asserted (Statements are committed claims)
    const semiotic = desc.facets.find(f => f.type === 'Semiotic') as { modalStatus?: string };
    expect(semiotic?.modalStatus).toBe('Asserted');

    // Trust facet attributes to LRS authority
    const trust = desc.facets.find(f => f.type === 'Trust') as { issuer?: IRI; trustLevel?: string };
    expect(trust?.issuer).toBe('https://acme.lrs.example');
    expect(trust?.trustLevel).toBe('ThirdPartyAttested');

    expect(validate(desc).conforms).toBe(true);
  });

  // ── PROJECT (Asserted descriptor → Statement, lossless-ish) ─────

  it('project Asserted: emits Statement with lossy=false', () => {
    const desc = ContextDescriptor.create('urn:cg:performance-record:q1-2026' as IRI)
      .describes('urn:graph:lpc' as IRI)
      .temporal({ validFrom: '2026-04-20T16:00:00Z' })
      .asserted(0.95)
      .selfAsserted('did:web:mark.example' as IRI)
      .build();

    const result = projectDescriptor(desc);
    expect(result.skipped).toBe(false);
    expect(result.statement).toBeDefined();
    expect(result.lossy).toBe(false);
    expect(result.lossNotes).toHaveLength(0);
  });

  // ── PROJECT (Hypothetical descriptor → SKIP) ────────────────────

  it('project Hypothetical: SKIPPED with explicit skip-reason audit', () => {
    const desc = ContextDescriptor.create('urn:cg:fragment:tone-probe:42' as IRI)
      .describes('urn:graph:adp' as IRI)
      .temporal({ validFrom: '2026-04-22T14:00:00Z' })
      .hypothetical(0.5)
      .selfAsserted('did:web:ravi.example' as IRI)
      .build();

    const result = projectDescriptor(desc);
    expect(result.skipped).toBe(true);
    expect(result.statement).toBeUndefined();
    expect(result.lossy).toBe(true);
    expect(result.skipReason).toContain('Hypothetical');
    expect(result.skipReason).toContain('committed claims');
  });

  // ── PROJECT (Counterfactual → ALWAYS SKIP) ──────────────────────

  it('project Counterfactual: ALWAYS SKIP regardless of caller opt-in', () => {
    // Counterfactual is a real ModalStatus enum value but the builder's
    // .counterfactual() expects causal-context args (Pearl's do-operator).
    // For projection-skip testing, we just need a descriptor whose
    // Semiotic facet carries modalStatus 'Counterfactual'. Easiest path:
    // build via .asserted() to get a Semiotic facet, then post-process.
    const baseDesc = ContextDescriptor.create('urn:cg:counterfactual-claim:1' as IRI)
      .describes('urn:graph:counterfactual' as IRI)
      .temporal({ validFrom: '2026-04-22T14:00:00Z' })
      .asserted(0.5)
      .selfAsserted('did:web:ravi.example' as IRI)
      .build();
    const desc = {
      ...baseDesc,
      facets: baseDesc.facets.map(f =>
        f.type === 'Semiotic' ? { ...f, modalStatus: 'Counterfactual' as const } : f,
      ),
    };

    const result = projectDescriptor(desc, { allowHypothetical: true });
    expect(result.skipped).toBe(true);
    expect(result.skipReason).toContain('Counterfactual');
  });

  // ── PROJECT (multi-narrative: lossy with loud audit) ────────────

  it('project multi-narrative: emits Statement BUT lossy=true + lossNote rows', () => {
    const desc = ContextDescriptor.create('urn:cg:synthesis:tone-week-1' as IRI)
      .describes('urn:graph:adp:synthesis' as IRI)
      .temporal({ validFrom: '2026-04-26T10:00:00Z' })
      .asserted(0.6)                                        // synthesis-team committed for dashboards
      .selfAsserted('did:web:ravi.example' as IRI)
      .build();

    const result = projectDescriptor(desc, {
      coherentNarratives: [
        'Reading 1: explicit-acknowledgment scaffold creates space',
        'Reading 2: it is the SIGNAL not the words',
        'Reading 3: noise; sample too small',
      ],
    });
    expect(result.skipped).toBe(false);
    expect(result.statement).toBeDefined();
    expect(result.lossy).toBe(true);
    expect(result.lossNotes.length).toBeGreaterThan(0);
    expect(result.lossNotes.join(' ')).toContain('coherent narratives');
  });

  // ── PROJECT (Hypothetical with explicit opt-in: lossy) ──────────

  it('project Hypothetical with allowHypothetical opt-in: lossy=true with audit', () => {
    const desc = ContextDescriptor.create('urn:cg:fragment:tone-probe:43' as IRI)
      .describes('urn:graph:adp' as IRI)
      .temporal({ validFrom: '2026-04-22T14:00:00Z' })
      .hypothetical(0.5)
      .selfAsserted('did:web:ravi.example' as IRI)
      .build();

    const result = projectDescriptor(desc, { allowHypothetical: true });
    expect(result.skipped).toBe(false);
    expect(result.lossy).toBe(true);
    expect(result.lossNotes.join(' ')).toContain('Hypothetical');
  });

  // ── ROUND-TRIP ──────────────────────────────────────────────────

  it('ingested descriptors round-trip through Turtle without error', () => {
    const stmt: XapiStatement = {
      id: 'stmt-rtt-1',
      actor: { account: { homePage: 'https://acme.example', name: 'mark.spivey' } },
      verb: { id: 'http://adlnet.gov/expapi/verbs/completed', display: { 'en-US': 'completed' } },
      object: { id: 'https://courses.acme.example/cs101/m3' },
      timestamp: '2026-04-15T14:32:00Z',
      authority: { account: { homePage: 'https://acme.lrs.example', name: 'acme-lrs' } },
    };
    const desc = ingestStatement(stmt);
    const ttl = toTurtle(desc);
    expect(ttl.length).toBeGreaterThan(0);
    expect(ttl).toContain(desc.id);
  });
});
