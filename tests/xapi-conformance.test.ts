/**
 * xAPI Conformance Tests for the PGSL Ingestion Profile
 *
 * Validates that the xAPI ingestion profile produces correct chain-based
 * atoms when content is ingested through the PGSL lattice via transformMulti().
 * The profile uses short IFI-derived actor IDs, verb last-segments, and
 * activity last-segments as atoms, with identity/name/result/context as
 * separate word-granularity chains.
 *
 * Covers: profile registration, statement ingestion, content-addressing,
 * batch operations, structural integrity, SPARQL queryability, IFI priority,
 * result structure, context structure, and edge cases.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import {
  createPGSL,
  ingestWithProfile,
  batchIngestWithProfile,
  getProfile,
  latticeStats,
  pgslResolve as resolve,
  sparqlQueryPGSL,
  materializeTriples,
  sparqlMatchPattern as matchPattern,
  validateAllPGSL,
} from '../src/index.js';
import type { IRI, PGSLInstance, XapiStatement } from '../src/index.js';

// ── Test Data ─────────────────────────────────────────────

const basicStatement: XapiStatement = {
  actor: { account: { homePage: 'https://example.com', name: 'sarah' }, name: 'Sarah Chen' },
  verb: { id: 'http://adlnet.gov/expapi/verbs/completed', display: { 'en-US': 'completed' } },
  object: { id: 'http://example.com/activities/intro-to-flight', definition: { name: { 'en-US': 'Introduction to Flight' } } },
  result: { score: { raw: 92, max: 100 }, success: true, duration: 'PT45M' },
  context: { platform: 'T-38C Flight Simulator v4.2' },
  timestamp: '2026-03-15T14:30:00Z',
};

const secondStatement: XapiStatement = {
  actor: { account: { homePage: 'https://example.com', name: 'sarah' }, name: 'Sarah Chen' },
  verb: { id: 'http://adlnet.gov/expapi/verbs/attempted', display: { 'en-US': 'attempted' } },
  object: { id: 'http://example.com/activities/vor-approach', definition: { name: { 'en-US': 'VOR Approach' } } },
  result: { score: { raw: 78, max: 100 }, success: false, duration: 'PT35M' },
  timestamp: '2026-03-15T15:45:00Z',
};

const minimalStatement: XapiStatement = {
  actor: { account: { homePage: 'https://example.com', name: 'john' }, name: 'John Doe' },
  verb: { id: 'http://adlnet.gov/expapi/verbs/experienced', display: { 'en-US': 'experienced' } },
  object: { id: 'http://example.com/activities/simulation', definition: { name: { 'en-US': 'Flight Simulation' } } },
};

// ── Fresh PGSL per test ───────────────────────────────────

let pgsl: PGSLInstance;
beforeEach(() => {
  pgsl = createPGSL({
    wasAttributedTo: 'urn:test:xapi-conformance' as IRI,
    generatedAtTime: new Date().toISOString(),
  });
});

// ═════════════════════════════════════════════════════════════
//  1. Profile Registration
// ═════════════════════════════════════════════════════════════

describe('Profile Registration', () => {
  it('xapi profile exists and is retrievable', () => {
    const profile = getProfile('xapi');
    expect(profile).toBeDefined();
  });

  it('profile has correct name', () => {
    const profile = getProfile('xapi')!;
    expect(profile.name).toBe('xapi');
  });

  it('profile has a description mentioning xAPI', () => {
    const profile = getProfile('xapi')!;
    expect(profile.description).toBeTruthy();
    expect(profile.description.length).toBeGreaterThan(0);
    expect(profile.description.toLowerCase()).toContain('xapi');
  });
});

// ═════════════════════════════════════════════════════════════
//  2. Statement Ingestion
// ═════════════════════════════════════════════════════════════

describe('Statement Ingestion', () => {
  it('single xAPI statement produces valid PGSL structure', () => {
    const uri = ingestWithProfile(pgsl, 'xapi', basicStatement);
    expect(uri).toBeDefined();
    expect(typeof uri).toBe('string');
    expect(uri).toContain('urn:pgsl:');
  });

  it('actor becomes a single IFI atom (account homePage:name)', () => {
    ingestWithProfile(pgsl, 'xapi', basicStatement);
    const ifiAtom = [...pgsl.nodes.values()].find(
      n => n.kind === 'Atom' && n.value === 'https://example.com:sarah',
    );
    expect(ifiAtom).toBeDefined();
  });

  it('actor IFI-derived atom exists AND display name words are separate atoms', () => {
    ingestWithProfile(pgsl, 'xapi', basicStatement);
    const atoms = [...pgsl.nodes.values()].filter(n => n.kind === 'Atom');
    const values = atoms.map(a => a.kind === 'Atom' ? String(a.value) : '');
    // IFI-derived short ID is the actor atom
    expect(values).toContain('sarah');
    // Display name words are separate atoms via `sarah name Sarah` / `sarah name Chen`
    expect(values).toContain('Sarah');
    expect(values).toContain('Chen');
  });

  it('verb becomes a single IRI atom', () => {
    ingestWithProfile(pgsl, 'xapi', basicStatement);
    const verbAtom = [...pgsl.nodes.values()].find(
      n => n.kind === 'Atom' && n.value === 'http://adlnet.gov/expapi/verbs/completed',
    );
    expect(verbAtom).toBeDefined();
  });

  it('verb short ID is an atom and verb identity IRI is a separate atom', () => {
    ingestWithProfile(pgsl, 'xapi', basicStatement);
    const atoms = [...pgsl.nodes.values()].filter(n => n.kind === 'Atom');
    const values = atoms.map(a => a.kind === 'Atom' ? String(a.value) : '');
    // Short verb ID derived from IRI last segment is an atom
    expect(values).toContain('completed');
    // Full verb IRI is a separate identity atom
    expect(values).toContain('http://adlnet.gov/expapi/verbs/completed');
  });

  it('object becomes a single activity ID atom', () => {
    ingestWithProfile(pgsl, 'xapi', basicStatement);
    const objectAtom = [...pgsl.nodes.values()].find(
      n => n.kind === 'Atom' && n.value === 'http://example.com/activities/intro-to-flight',
    );
    expect(objectAtom).toBeDefined();
  });

  it('object definition name IS split into atoms via name chain', () => {
    ingestWithProfile(pgsl, 'xapi', basicStatement);
    const atoms = [...pgsl.nodes.values()].filter(n => n.kind === 'Atom');
    const values = atoms.map(a => a.kind === 'Atom' ? String(a.value) : '');
    // `intro-to-flight name Introduction to Flight` creates word atoms
    expect(values).toContain('Introduction');
    expect(values).toContain('Flight');
    // The `name` keyword is also an atom
    expect(values).toContain('name');
  });

  it('timestamp is NOT stored as an atom', () => {
    ingestWithProfile(pgsl, 'xapi', basicStatement);
    const tsAtom = [...pgsl.nodes.values()].find(
      n => n.kind === 'Atom' && n.value === '2026-03-15T14:30:00Z',
    );
    expect(tsAtom).toBeUndefined();
  });
});

// ═════════════════════════════════════════════════════════════
//  3. Content-Addressing
// ═════════════════════════════════════════════════════════════

describe('Content-Addressing', () => {
  it('two statements with same actor IFI share the actor atom', () => {
    ingestWithProfile(pgsl, 'xapi', basicStatement);
    ingestWithProfile(pgsl, 'xapi', secondStatement);
    const ifiAtoms = [...pgsl.nodes.values()].filter(
      n => n.kind === 'Atom' && n.value === 'https://example.com:sarah',
    );
    // Content-addressed: still just one atom
    expect(ifiAtoms.length).toBe(1);
  });

  it('two statements with same verb IRI share the verb atom', () => {
    const sameVerbStatement: XapiStatement = {
      actor: { account: { homePage: 'https://example.com', name: 'john' } },
      verb: { id: 'http://adlnet.gov/expapi/verbs/completed', display: { 'en-US': 'completed' } },
      object: { id: 'http://example.com/activities/other', definition: { name: { 'en-US': 'Other Activity' } } },
    };
    ingestWithProfile(pgsl, 'xapi', basicStatement);
    ingestWithProfile(pgsl, 'xapi', sameVerbStatement);
    const verbAtoms = [...pgsl.nodes.values()].filter(
      n => n.kind === 'Atom' && n.value === 'http://adlnet.gov/expapi/verbs/completed',
    );
    expect(verbAtoms.length).toBe(1);
  });

  it('two statements with same activity ID share the object atom', () => {
    const sameObjectStatement: XapiStatement = {
      actor: { account: { homePage: 'https://example.com', name: 'john' } },
      verb: { id: 'http://adlnet.gov/expapi/verbs/attempted', display: { 'en-US': 'attempted' } },
      object: { id: 'http://example.com/activities/intro-to-flight', definition: { name: { 'en-US': 'Introduction to Flight' } } },
    };
    ingestWithProfile(pgsl, 'xapi', basicStatement);
    ingestWithProfile(pgsl, 'xapi', sameObjectStatement);
    const objectAtoms = [...pgsl.nodes.values()].filter(
      n => n.kind === 'Atom' && n.value === 'http://example.com/activities/intro-to-flight',
    );
    expect(objectAtoms.length).toBe(1);
  });

  it('two statements with different verbs produce different verb atoms', () => {
    ingestWithProfile(pgsl, 'xapi', basicStatement);
    ingestWithProfile(pgsl, 'xapi', secondStatement);
    const completedAtom = [...pgsl.nodes.values()].find(
      n => n.kind === 'Atom' && n.value === 'http://adlnet.gov/expapi/verbs/completed',
    );
    const attemptedAtom = [...pgsl.nodes.values()].find(
      n => n.kind === 'Atom' && n.value === 'http://adlnet.gov/expapi/verbs/attempted',
    );
    expect(completedAtom).toBeDefined();
    expect(attemptedAtom).toBeDefined();
    expect(completedAtom!.uri).not.toBe(attemptedAtom!.uri);
  });

  it('deduplication: ingesting same statement twice does not create duplicate atoms', () => {
    ingestWithProfile(pgsl, 'xapi', basicStatement);
    const atomCountBefore = [...pgsl.nodes.values()].filter(n => n.kind === 'Atom').length;

    ingestWithProfile(pgsl, 'xapi', basicStatement);
    const atomCountAfter = [...pgsl.nodes.values()].filter(n => n.kind === 'Atom').length;

    expect(atomCountAfter).toBe(atomCountBefore);
  });
});

// ═════════════════════════════════════════════════════════════
//  4. Batch Ingestion
// ═════════════════════════════════════════════════════════════

describe('Batch Ingestion', () => {
  it('batch ingests multiple statements and returns URIs', () => {
    const uris = batchIngestWithProfile(pgsl, 'xapi', [basicStatement, secondStatement, minimalStatement]);
    expect(uris).toHaveLength(3);
    uris.forEach(uri => expect(uri).toContain('urn:pgsl:'));
  });

  it('batch produces correct lattice stats', () => {
    batchIngestWithProfile(pgsl, 'xapi', [basicStatement, secondStatement]);
    const stats = latticeStats(pgsl);
    expect(stats.atoms).toBeGreaterThan(0);
    expect(stats.fragments).toBeGreaterThan(0);
    expect(stats.totalNodes).toBe(stats.atoms + stats.fragments);
  });

  it('shared IFI atoms across batch statements', () => {
    batchIngestWithProfile(pgsl, 'xapi', [basicStatement, secondStatement]);
    // Same actor IFI should appear only once
    const ifiAtoms = [...pgsl.nodes.values()].filter(
      n => n.kind === 'Atom' && n.value === 'https://example.com:sarah',
    );
    expect(ifiAtoms.length).toBe(1);
  });

  it('each statement gets its own top-level fragment', () => {
    const uris = batchIngestWithProfile(pgsl, 'xapi', [basicStatement, secondStatement]);
    expect(uris[0]).not.toBe(uris[1]);
    expect(pgsl.nodes.get(uris[0])?.kind).toBe('Fragment');
    expect(pgsl.nodes.get(uris[1])?.kind).toBe('Fragment');
  });

  it('empty batch returns empty array', () => {
    const uris = batchIngestWithProfile(pgsl, 'xapi', []);
    expect(uris).toEqual([]);
  });
});

// ═════════════════════════════════════════════════════════════
//  5. Structural Integrity
// ═════════════════════════════════════════════════════════════

describe('Structural Integrity', () => {
  it('SHACL validation passes after xAPI ingestion', () => {
    ingestWithProfile(pgsl, 'xapi', basicStatement);
    const result = validateAllPGSL(pgsl);
    expect(result.conforms).toBe(true);
    expect(result.violations.length).toBe(0);
  });

  it('SHACL validation passes after batch ingestion', () => {
    batchIngestWithProfile(pgsl, 'xapi', [basicStatement, secondStatement, minimalStatement]);
    const result = validateAllPGSL(pgsl);
    expect(result.conforms).toBe(true);
    expect(result.violations.length).toBe(0);
  });

  it('fragment levels are consistent', () => {
    ingestWithProfile(pgsl, 'xapi', basicStatement);
    const stats = latticeStats(pgsl);
    // Atoms are at level 0, and fragments build up from there
    expect(stats.levels[0]).toBeGreaterThan(0);
    expect(stats.maxLevel).toBeGreaterThan(0);
  });

  it('no canonicity violations — each value has exactly one atom', () => {
    ingestWithProfile(pgsl, 'xapi', basicStatement);
    ingestWithProfile(pgsl, 'xapi', secondStatement);
    const atoms = [...pgsl.nodes.values()].filter(n => n.kind === 'Atom');
    const values = atoms.map(a => a.kind === 'Atom' ? String(a.value) : '');
    const uniqueValues = new Set(values);
    // Each unique value maps to exactly one atom (canonicity)
    expect(values.length).toBe(uniqueValues.size);
  });

  it('all nodes have provenance', () => {
    ingestWithProfile(pgsl, 'xapi', basicStatement);
    for (const node of pgsl.nodes.values()) {
      expect(node.provenance).toBeDefined();
      expect(node.provenance.wasAttributedTo).toBeTruthy();
    }
  });
});

// ═════════════════════════════════════════════════════════════
//  6. SPARQL Queryability
// ═════════════════════════════════════════════════════════════

describe('SPARQL Queryability', () => {
  it('can find atoms by value — actor IFI', () => {
    ingestWithProfile(pgsl, 'xapi', basicStatement);
    const store = materializeTriples(pgsl);
    const valueTriples = matchPattern(
      store, undefined,
      'https://markjspivey-xwisee.github.io/interego/ns/pgsl#value',
      undefined,
    );
    const values = valueTriples.map(t => t.object.replace(/"/g, ''));
    expect(values).toContain('https://example.com:sarah');
  });

  it('can find atoms by value — verb IRI', () => {
    ingestWithProfile(pgsl, 'xapi', basicStatement);
    const store = materializeTriples(pgsl);
    const valueTriples = matchPattern(
      store, undefined,
      'https://markjspivey-xwisee.github.io/interego/ns/pgsl#value',
      undefined,
    );
    const values = valueTriples.map(t => t.object.replace(/"/g, ''));
    expect(values).toContain('http://adlnet.gov/expapi/verbs/completed');
  });

  it('can find atoms by value — object activity ID', () => {
    ingestWithProfile(pgsl, 'xapi', basicStatement);
    const store = materializeTriples(pgsl);
    const valueTriples = matchPattern(
      store, undefined,
      'https://markjspivey-xwisee.github.io/interego/ns/pgsl#value',
      undefined,
    );
    const values = valueTriples.map(t => t.object.replace(/"/g, ''));
    expect(values).toContain('http://example.com/activities/intro-to-flight');
  });

  it('materialized triples include atom type assertions', () => {
    ingestWithProfile(pgsl, 'xapi', basicStatement);
    const store = materializeTriples(pgsl);
    const atomTypes = matchPattern(
      store, undefined,
      'http://www.w3.org/1999/02/22-rdf-syntax-ns#type',
      'https://markjspivey-xwisee.github.io/interego/ns/pgsl#Atom',
    );
    expect(atomTypes.length).toBeGreaterThan(0);
  });

  it('materialized triples include fragment type assertions', () => {
    ingestWithProfile(pgsl, 'xapi', basicStatement);
    const store = materializeTriples(pgsl);
    const fragTypes = matchPattern(
      store, undefined,
      'http://www.w3.org/1999/02/22-rdf-syntax-ns#type',
      'https://markjspivey-xwisee.github.io/interego/ns/pgsl#Fragment',
    );
    expect(fragTypes.length).toBeGreaterThan(0);
  });

  it('materialized triples include fragment-item relationships', () => {
    ingestWithProfile(pgsl, 'xapi', basicStatement);
    const store = materializeTriples(pgsl);
    const itemTriples = matchPattern(
      store, undefined,
      'https://markjspivey-xwisee.github.io/interego/ns/pgsl#item',
      undefined,
    );
    expect(itemTriples.length).toBeGreaterThan(0);
  });

  it('can count fragments via lattice stats after ingestion', () => {
    batchIngestWithProfile(pgsl, 'xapi', [basicStatement, secondStatement]);
    const stats = latticeStats(pgsl);
    // Two statements produce at least 2 top-level fragments
    expect(stats.fragments).toBeGreaterThanOrEqual(2);
  });
});

// ═════════════════════════════════════════════════════════════
//  7. IFI Priority
// ═════════════════════════════════════════════════════════════

describe('IFI Priority', () => {
  it('account IFI takes priority: homePage:name format', () => {
    const stmt: XapiStatement = {
      actor: {
        account: { homePage: 'https://lms.example.com', name: 'user12345' },
        mbox: 'mailto:user@example.com',
        name: 'Some User',
      },
      verb: { id: 'http://adlnet.gov/expapi/verbs/completed', display: { 'en-US': 'completed' } },
      object: { id: 'http://example.com/activities/test', definition: { name: { 'en-US': 'Test' } } },
    };
    ingestWithProfile(pgsl, 'xapi', stmt);
    const ifiAtom = [...pgsl.nodes.values()].find(
      n => n.kind === 'Atom' && n.value === 'https://lms.example.com:user12345',
    );
    expect(ifiAtom).toBeDefined();
    // mbox should NOT be present as a separate atom
    const mboxAtom = [...pgsl.nodes.values()].find(
      n => n.kind === 'Atom' && n.value === 'mailto:user@example.com',
    );
    expect(mboxAtom).toBeUndefined();
  });

  it('mbox IFI used when no account present', () => {
    const stmt: XapiStatement = {
      actor: { mbox: 'mailto:agent42@example.com', name: 'Agent 42' },
      verb: { id: 'http://adlnet.gov/expapi/verbs/completed', display: { 'en-US': 'completed' } },
      object: { id: 'http://example.com/activities/test', definition: { name: { 'en-US': 'Test' } } },
    };
    ingestWithProfile(pgsl, 'xapi', stmt);
    const mboxAtom = [...pgsl.nodes.values()].find(
      n => n.kind === 'Atom' && n.value === 'mailto:agent42@example.com',
    );
    expect(mboxAtom).toBeDefined();
  });

  it('openid IFI used when no account or mbox', () => {
    const stmt: XapiStatement = {
      actor: { openid: 'https://openid.example.com/user/abc', name: 'OpenID User' },
      verb: { id: 'http://adlnet.gov/expapi/verbs/completed', display: { 'en-US': 'completed' } },
      object: { id: 'http://example.com/activities/test', definition: { name: { 'en-US': 'Test' } } },
    };
    ingestWithProfile(pgsl, 'xapi', stmt);
    const atoms = [...pgsl.nodes.values()].filter(n => n.kind === 'Atom');
    const values = atoms.map(a => a.kind === 'Atom' ? String(a.value) : '');
    // deriveActorId falls back to last word of name: "user"
    expect(values).toContain('user');
    // openid URL is stored as an identity atom via `user identity https://openid.example.com/user/abc`
    expect(values).toContain('https://openid.example.com/user/abc');
  });

  it('name fallback used when no IFI present — last word becomes actor ID', () => {
    const stmt: XapiStatement = {
      actor: { name: 'Fallback Name' },
      verb: { id: 'http://adlnet.gov/expapi/verbs/completed', display: { 'en-US': 'completed' } },
      object: { id: 'http://example.com/activities/test', definition: { name: { 'en-US': 'Test' } } },
    };
    ingestWithProfile(pgsl, 'xapi', stmt);
    const atoms = [...pgsl.nodes.values()].filter(n => n.kind === 'Atom');
    const values = atoms.map(a => a.kind === 'Atom' ? String(a.value) : '');
    // deriveActorId with name-only takes last word lowercased
    expect(values).toContain('name');
    // Display name parts become separate atoms via name chains
    expect(values).toContain('Fallback');
    expect(values).toContain('Name');
  });

  it('unknown actor falls back to "unknown"', () => {
    const stmt: XapiStatement = {
      actor: {},
      verb: { id: 'http://adlnet.gov/expapi/verbs/completed', display: { 'en-US': 'completed' } },
      object: { id: 'http://example.com/activities/test', definition: { name: { 'en-US': 'Test' } } },
    };
    ingestWithProfile(pgsl, 'xapi', stmt);
    const unknownAtom = [...pgsl.nodes.values()].find(
      n => n.kind === 'Atom' && n.value === 'unknown',
    );
    expect(unknownAtom).toBeDefined();
  });
});

// ═════════════════════════════════════════════════════════════
//  8. Result Structure
// ═════════════════════════════════════════════════════════════

describe('Result Structure', () => {
  it('result contains score and value as separate atoms', () => {
    ingestWithProfile(pgsl, 'xapi', basicStatement);
    const atoms = [...pgsl.nodes.values()].filter(n => n.kind === 'Atom');
    const values = atoms.map(a => a.kind === 'Atom' ? String(a.value) : '');
    // `sarah intro-to-flight score 92` creates separate atoms
    expect(values).toContain('score');
    expect(values).toContain('92');
  });

  it('result contains max and value as separate atoms', () => {
    ingestWithProfile(pgsl, 'xapi', basicStatement);
    const atoms = [...pgsl.nodes.values()].filter(n => n.kind === 'Atom');
    const values = atoms.map(a => a.kind === 'Atom' ? String(a.value) : '');
    expect(values).toContain('max');
    expect(values).toContain('100');
  });

  it('result contains success and true as separate atoms', () => {
    ingestWithProfile(pgsl, 'xapi', basicStatement);
    const atoms = [...pgsl.nodes.values()].filter(n => n.kind === 'Atom');
    const values = atoms.map(a => a.kind === 'Atom' ? String(a.value) : '');
    expect(values).toContain('success');
    expect(values).toContain('true');
  });

  it('result contains success and false as separate atoms', () => {
    ingestWithProfile(pgsl, 'xapi', secondStatement);
    const atoms = [...pgsl.nodes.values()].filter(n => n.kind === 'Atom');
    const values = atoms.map(a => a.kind === 'Atom' ? String(a.value) : '');
    expect(values).toContain('success');
    expect(values).toContain('false');
  });

  it('result contains duration and value as separate atoms', () => {
    ingestWithProfile(pgsl, 'xapi', basicStatement);
    const atoms = [...pgsl.nodes.values()].filter(n => n.kind === 'Atom');
    const values = atoms.map(a => a.kind === 'Atom' ? String(a.value) : '');
    expect(values).toContain('duration');
    expect(values).toContain('PT45M');
  });

  it('result with scaled score produces scaled and value as separate atoms', () => {
    const scaledStmt: XapiStatement = {
      actor: { account: { homePage: 'https://example.com', name: 'test' } },
      verb: { id: 'http://adlnet.gov/expapi/verbs/completed', display: { 'en-US': 'completed' } },
      object: { id: 'http://example.com/activities/quiz', definition: { name: { 'en-US': 'Quiz' } } },
      result: { score: { scaled: 0.85 }, success: true },
    };
    ingestWithProfile(pgsl, 'xapi', scaledStmt);
    const atoms = [...pgsl.nodes.values()].filter(n => n.kind === 'Atom');
    const values = atoms.map(a => a.kind === 'Atom' ? String(a.value) : '');
    expect(values).toContain('scaled');
    expect(values).toContain('0.85');
  });

  it('result with only duration, no score or success', () => {
    const durationOnlyStmt: XapiStatement = {
      actor: { account: { homePage: 'https://example.com', name: 'test' } },
      verb: { id: 'http://adlnet.gov/expapi/verbs/experienced', display: { 'en-US': 'experienced' } },
      object: { id: 'http://example.com/activities/video', definition: { name: { 'en-US': 'Training Video' } } },
      result: { duration: 'PT12M30S' },
    };
    ingestWithProfile(pgsl, 'xapi', durationOnlyStmt);
    const atoms = [...pgsl.nodes.values()].filter(n => n.kind === 'Atom');
    const values = atoms.map(a => a.kind === 'Atom' ? String(a.value) : '');
    // Duration keyword and value are separate atoms
    expect(values).toContain('duration');
    expect(values).toContain('PT12M30S');
  });

  it('different durations produce different value atoms', () => {
    batchIngestWithProfile(pgsl, 'xapi', [basicStatement, secondStatement]);
    const pt45 = [...pgsl.nodes.values()].find(
      n => n.kind === 'Atom' && n.value === 'PT45M',
    );
    const pt35 = [...pgsl.nodes.values()].find(
      n => n.kind === 'Atom' && n.value === 'PT35M',
    );
    expect(pt45).toBeDefined();
    expect(pt35).toBeDefined();
    expect(pt45!.uri).not.toBe(pt35!.uri);
  });

  it('result chain creates a fragment containing score atom', () => {
    ingestWithProfile(pgsl, 'xapi', basicStatement);
    // `sarah intro-to-flight score 92` creates a chain fragment containing score
    const scoreAtom = [...pgsl.nodes.values()].find(
      n => n.kind === 'Atom' && n.value === 'score',
    );
    expect(scoreAtom).toBeDefined();
    const fragments = [...pgsl.nodes.values()].filter(n => n.kind === 'Fragment');
    const resultFragment = fragments.find(f =>
      f.kind === 'Fragment' && f.items.includes(scoreAtom!.uri),
    );
    expect(resultFragment).toBeDefined();
  });
});

// ═════════════════════════════════════════════════════════════
//  9. Context Structure
// ═════════════════════════════════════════════════════════════

describe('Context Structure', () => {
  it('context contains platform and value words as separate atoms', () => {
    ingestWithProfile(pgsl, 'xapi', basicStatement);
    const atoms = [...pgsl.nodes.values()].filter(n => n.kind === 'Atom');
    const values = atoms.map(a => a.kind === 'Atom' ? String(a.value) : '');
    // `sarah intro-to-flight platform T-38C Flight Simulator v4.2` creates word atoms
    expect(values).toContain('platform');
    expect(values).toContain('T-38C');
    expect(values).toContain('Simulator');
    expect(values).toContain('v4.2');
  });

  it('context with instructor produces instructor and value as separate atoms', () => {
    const stmtWithInstructor: XapiStatement = {
      actor: { account: { homePage: 'https://example.com', name: 'student1' } },
      verb: { id: 'http://adlnet.gov/expapi/verbs/completed', display: { 'en-US': 'completed' } },
      object: { id: 'http://example.com/activities/test', definition: { name: { 'en-US': 'Test' } } },
      context: { instructor: { mbox: 'mailto:instructor@example.com' } },
    };
    ingestWithProfile(pgsl, 'xapi', stmtWithInstructor);
    const atoms = [...pgsl.nodes.values()].filter(n => n.kind === 'Atom');
    const values = atoms.map(a => a.kind === 'Atom' ? String(a.value) : '');
    expect(values).toContain('instructor');
    expect(values).toContain('mailto:instructor@example.com');
  });

  it('context with registration produces registration and value as separate atoms', () => {
    const stmtWithReg: XapiStatement = {
      actor: { account: { homePage: 'https://example.com', name: 'student1' } },
      verb: { id: 'http://adlnet.gov/expapi/verbs/completed', display: { 'en-US': 'completed' } },
      object: { id: 'http://example.com/activities/test', definition: { name: { 'en-US': 'Test' } } },
      context: { registration: 'reg-uuid-1234' },
    };
    ingestWithProfile(pgsl, 'xapi', stmtWithReg);
    const atoms = [...pgsl.nodes.values()].filter(n => n.kind === 'Atom');
    const values = atoms.map(a => a.kind === 'Atom' ? String(a.value) : '');
    expect(values).toContain('registration');
    expect(values).toContain('reg-uuid-1234');
  });

  it('context chain creates a fragment containing platform atom', () => {
    ingestWithProfile(pgsl, 'xapi', basicStatement);
    const platformAtom = [...pgsl.nodes.values()].find(
      n => n.kind === 'Atom' && n.value === 'platform',
    );
    expect(platformAtom).toBeDefined();
    const fragments = [...pgsl.nodes.values()].filter(n => n.kind === 'Fragment');
    const contextFragment = fragments.find(f =>
      f.kind === 'Fragment' && f.items.includes(platformAtom!.uri),
    );
    expect(contextFragment).toBeDefined();
  });

  it('no context group when context is absent', () => {
    ingestWithProfile(pgsl, 'xapi', minimalStatement);
    const atoms = [...pgsl.nodes.values()].filter(n => n.kind === 'Atom');
    const platformAtoms = atoms.filter(a => a.kind === 'Atom' && String(a.value).startsWith('platform:'));
    expect(platformAtoms.length).toBe(0);
  });
});

// ═════════════════════════════════════════════════════════════
//  10. Edge Cases
// ═════════════════════════════════════════════════════════════

describe('Edge Cases', () => {
  it('statement with missing result and context', () => {
    const uri = ingestWithProfile(pgsl, 'xapi', minimalStatement);
    expect(uri).toBeDefined();
    const stats = latticeStats(pgsl);
    expect(stats.atoms).toBeGreaterThan(0);
    expect(stats.fragments).toBeGreaterThan(0);
  });

  it('minimal statement has no result-derived atoms', () => {
    ingestWithProfile(pgsl, 'xapi', minimalStatement);
    const atoms = [...pgsl.nodes.values()].filter(n => n.kind === 'Atom');
    const values = atoms.map(a => a.kind === 'Atom' ? String(a.value) : '');
    const resultAtoms = values.filter(v =>
      v.startsWith('score:') || v.startsWith('success:') || v.startsWith('duration:'),
    );
    expect(resultAtoms.length).toBe(0);
  });

  it('name-only fallback uses last word as actor ID with display name atoms', () => {
    const nameOnlyStmt: XapiStatement = {
      actor: { name: 'Jane Doe' },
      verb: { id: 'http://adlnet.gov/expapi/verbs/experienced', display: { 'en-US': 'experienced' } },
      object: { id: 'http://example.com/activities/demo', definition: { name: { 'en-US': 'Demo' } } },
    };
    ingestWithProfile(pgsl, 'xapi', nameOnlyStmt);
    const atoms = [...pgsl.nodes.values()].filter(n => n.kind === 'Atom');
    const values = atoms.map(a => a.kind === 'Atom' ? String(a.value) : '');
    // deriveActorId uses last word lowercased: "doe"
    expect(values).toContain('doe');
    // Display name parts become separate atoms via name chains
    expect(values).toContain('Jane');
    expect(values).toContain('Doe');
  });

  it('empty batch returns empty array', () => {
    const uris = batchIngestWithProfile(pgsl, 'xapi', []);
    expect(uris).toEqual([]);
  });

  it('unknown profile name throws error', () => {
    expect(() => {
      ingestWithProfile(pgsl, 'nonexistent', basicStatement);
    }).toThrow('Unknown ingestion profile');
  });

  it('SHACL validation passes for edge-case statements', () => {
    const edgeCaseStmt: XapiStatement = {
      actor: { mbox: 'mailto:edge@test.com' },
      verb: { id: 'http://adlnet.gov/expapi/verbs/completed', display: { 'en-US': 'completed' } },
      object: { id: 'http://example.com/activities/edge', definition: { name: { 'en-US': 'Edge Case' } } },
    };
    ingestWithProfile(pgsl, 'xapi', edgeCaseStmt);
    const result = validateAllPGSL(pgsl);
    expect(result.conforms).toBe(true);
  });

  it('result with completion field produces completion and true as separate atoms', () => {
    const completionStmt: XapiStatement = {
      actor: { account: { homePage: 'https://example.com', name: 'test' } },
      verb: { id: 'http://adlnet.gov/expapi/verbs/completed', display: { 'en-US': 'completed' } },
      object: { id: 'http://example.com/activities/course', definition: { name: { 'en-US': 'Course' } } },
      result: { completion: true },
    };
    ingestWithProfile(pgsl, 'xapi', completionStmt);
    const atoms = [...pgsl.nodes.values()].filter(n => n.kind === 'Atom');
    const values = atoms.map(a => a.kind === 'Atom' ? String(a.value) : '');
    expect(values).toContain('completion');
    expect(values).toContain('true');
  });

  it('result with response field produces response and value as separate atoms', () => {
    const responseStmt: XapiStatement = {
      actor: { account: { homePage: 'https://example.com', name: 'test' } },
      verb: { id: 'http://adlnet.gov/expapi/verbs/answered', display: { 'en-US': 'answered' } },
      object: { id: 'http://example.com/activities/question1', definition: { name: { 'en-US': 'Question 1' } } },
      result: { response: 'option-b' },
    };
    ingestWithProfile(pgsl, 'xapi', responseStmt);
    const atoms = [...pgsl.nodes.values()].filter(n => n.kind === 'Atom');
    const values = atoms.map(a => a.kind === 'Atom' ? String(a.value) : '');
    expect(values).toContain('response');
    expect(values).toContain('option-b');
  });
});
