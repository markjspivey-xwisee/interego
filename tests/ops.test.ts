import { describe, it, expect } from 'vitest';
import { Parser } from 'n3';
import {
  buildDeployEvent,
  buildAccessChangeEvent,
  buildWalletRotationEvent,
  buildIncidentEvent,
  buildQuarterlyReviewEvent,
} from '../src/ops/index.js';

const OP = 'did:web:identity.example#operator';

describe('ops event builders — common shape', () => {
  it('every builder returns Asserted modal status (compliance grade)', () => {
    const events = [
      buildDeployEvent({ component: 'relay', commitSha: 'abc123', deployerDid: OP }),
      buildAccessChangeEvent({
        action: 'granted', principal: 'did:web:advisor', system: 'github',
        scope: 'read', grantorDid: OP, justification: 'onboarding',
      }),
      buildWalletRotationEvent({
        retiredAddress: '0xold', newActiveAddress: '0xnew',
        reason: 'scheduled', operatorDid: OP,
      }),
      buildIncidentEvent({
        severity: 'sev-2', title: 'Test', summary: 'test',
        detectedAt: '2026-04-25T12:00:00Z', detectionSource: 'manual',
        responderDid: OP, status: 'open',
      }),
      buildQuarterlyReviewEvent({
        quarter: '2026-Q2', kind: 'access', reviewerDid: OP,
        summary: 'q2', findingCount: 0,
      }),
    ];
    for (const e of events) {
      expect(e.modal_status).toBe('Asserted');
      expect(e.compliance_framework).toBe('soc2');
      expect(e.controls.length).toBeGreaterThan(0);
      expect(e.graph_iri).toMatch(/^urn:graph:ops:/);
      expect(e.graph_content).toContain('@prefix soc2:');
      expect(e.graph_content).toContain('dct:conformsTo');
    }
  });
});

describe('buildDeployEvent', () => {
  it('cites CC8.1 and embeds commit SHA + component', () => {
    const e = buildDeployEvent({
      component: 'relay',
      commitSha: 'deadbeef',
      deployerDid: OP,
      timestamp: '2026-04-25T10:00:00Z',
    });
    expect(e.controls).toEqual(['soc2:CC8.1']);
    expect(e.graph_content).toContain('soc2:DeployEvent');
    expect(e.graph_content).toContain('dct:conformsTo soc2:CC8.1');
    expect(e.graph_content).toContain('soc2:component "relay"');
    expect(e.graph_content).toContain('soc2:commitSha "deadbeef"');
    expect(e.graph_content).toContain('soc2:environment "production"');
    expect(e.graph_content).toContain(`prov:wasAttributedTo <${OP}>`);
  });

  it('respects custom environment + rollback plan', () => {
    const e = buildDeployEvent({
      component: 'identity',
      commitSha: 'x',
      deployerDid: OP,
      environment: 'staging',
      rollbackPlan: 'revert revision r-123',
    });
    expect(e.graph_content).toContain('soc2:environment "staging"');
    expect(e.graph_content).toContain('soc2:rollbackPlan "revert revision r-123"');
  });

  it('escapes embedded quotes in component name (defense in depth)', () => {
    const e = buildDeployEvent({
      component: 'evil"name',
      commitSha: 'x',
      deployerDid: OP,
    });
    expect(e.graph_content).toContain('soc2:component "evil\\"name"');
  });
});

describe('buildAccessChangeEvent', () => {
  it('cites CC6.1 + CC6.3 and records principal/system/scope', () => {
    const e = buildAccessChangeEvent({
      action: 'granted',
      principal: 'did:web:newperson',
      system: 'azure',
      scope: 'Reader',
      grantorDid: OP,
      justification: 'temporary audit access',
    });
    expect(e.controls).toEqual(['soc2:CC6.1', 'soc2:CC6.3']);
    expect(e.graph_content).toContain('soc2:AccessChangeEvent');
    expect(e.graph_content).toContain('soc2:accessAction "granted"');
    expect(e.graph_content).toContain('soc2:principal "did:web:newperson"');
    expect(e.graph_content).toContain('soc2:system "azure"');
    expect(e.graph_content).toContain('soc2:scope "Reader"');
    expect(e.graph_content).toContain('soc2:justification "temporary audit access"');
  });

  it.each(['granted', 'revoked', 'modified'] as const)('records %s as accessAction', (action) => {
    const e = buildAccessChangeEvent({
      action, principal: 'p', system: 's', scope: 'sc',
      grantorDid: OP, justification: 'j',
    });
    expect(e.graph_content).toContain(`soc2:accessAction "${action}"`);
  });
});

describe('buildWalletRotationEvent', () => {
  it('cites CC6.7 and records retired + new addresses', () => {
    const e = buildWalletRotationEvent({
      retiredAddress: '0x111',
      newActiveAddress: '0x222',
      reason: 'compromise-response',
      operatorDid: OP,
      note: 'suspected key leak in incident #7',
    });
    expect(e.controls).toEqual(['soc2:CC6.7']);
    expect(e.graph_content).toContain('soc2:KeyRotationEvent');
    expect(e.graph_content).toContain('soc2:rotationReason "compromise-response"');
    expect(e.graph_content).toContain('soc2:retiredKeyAddress "0x111"');
    expect(e.graph_content).toContain('soc2:newKeyAddress "0x222"');
    expect(e.graph_content).toContain('rdfs:comment "suspected key leak in incident #7"');
  });
});

describe('buildIncidentEvent', () => {
  it('open/contained incidents cite CC7.3 only', () => {
    const e = buildIncidentEvent({
      severity: 'sev-1',
      title: 'Auth outage',
      summary: 'OAuth provider returning 5xx',
      detectedAt: '2026-04-25T08:00:00Z',
      detectionSource: 'oncall pager',
      responderDid: OP,
      status: 'open',
    });
    expect(e.controls).toEqual(['soc2:CC7.3']);
    expect(e.graph_content).toContain('soc2:IncidentEvent');
    expect(e.graph_content).toContain('soc2:incidentSeverity "sev-1"');
    expect(e.graph_content).toContain('soc2:incidentStatus "open"');
  });

  it('resolved incidents cite CC7.3 + CC7.4 + CC7.5', () => {
    const e = buildIncidentEvent({
      severity: 'sev-2',
      title: 'Same outage',
      summary: 'restored',
      detectedAt: '2026-04-25T08:00:00Z',
      detectionSource: 'oncall pager',
      responderDid: OP,
      status: 'resolved',
      affectedComponents: ['identity', 'relay'],
      supersedes: ['https://pod.example/desc/incident-open'],
    });
    expect(e.controls).toEqual(['soc2:CC7.3', 'soc2:CC7.4', 'soc2:CC7.5']);
    expect(e.graph_content).toContain('soc2:affectedComponent "identity"');
    expect(e.graph_content).toContain('soc2:affectedComponent "relay"');
    expect(e.graph_content).toContain('prov:wasDerivedFrom <https://pod.example/desc/incident-open>');
  });
});

describe('buildQuarterlyReviewEvent', () => {
  it('access review maps to access controls', () => {
    const e = buildQuarterlyReviewEvent({
      quarter: '2026-Q2',
      kind: 'access',
      reviewerDid: OP,
      summary: 'reviewed all admins',
      findingCount: 1,
      findings: ['advisor needs MFA hardening'],
    });
    expect(e.controls).toEqual(['soc2:CC6.1', 'soc2:CC6.2', 'soc2:CC6.3']);
    expect(e.graph_content).toContain('soc2:reviewKind "access"');
    expect(e.graph_content).toContain('soc2:reviewQuarter "2026-Q2"');
    expect(e.graph_content).toContain('soc2:findingCount 1');
    expect(e.graph_content).toContain('soc2:finding "advisor needs MFA hardening"');
  });

  it.each([
    ['change', ['soc2:CC8.1']],
    ['risk', ['soc2:CC3.1', 'soc2:CC3.2']],
    ['vendor', ['soc2:CC9.2']],
    ['monitoring', ['soc2:CC4.1', 'soc2:CC4.2', 'soc2:CC7.2']],
  ] as const)('%s review maps to expected controls', (kind, expected) => {
    const e = buildQuarterlyReviewEvent({
      quarter: '2026-Q3', kind, reviewerDid: OP,
      summary: 's', findingCount: 0,
    });
    expect(e.controls).toEqual(expected);
    for (const c of expected) {
      expect(e.graph_content).toContain(`dct:conformsTo ${c}`);
    }
  });
});

describe('IRI safety — caller-supplied data must not break Turtle', () => {
  it('escapes special characters in component before embedding in IRI', () => {
    const e = buildDeployEvent({
      component: 'evil"name with spaces',
      commitSha: 'x',
      deployerDid: OP,
    });
    expect(e.graph_iri).not.toContain('"');
    expect(e.graph_iri).not.toContain(' ');
    expect(e.graph_iri).toContain('evil%22name%20with%20spaces');
  });

  it('escapes special characters in quarter + kind before embedding in IRI', () => {
    const e = buildQuarterlyReviewEvent({
      quarter: '2026-Q2 odd"',
      kind: 'access',
      reviewerDid: OP,
      summary: 's',
      findingCount: 0,
    });
    expect(e.graph_iri).not.toContain('"');
    expect(e.graph_iri).not.toContain(' ');
  });
});

describe('round-trip — Turtle parses cleanly through n3', () => {
  // The unit tests above check substrings inside graph_content, but a
  // pure substring check can miss whole-document syntax bugs (an
  // unescaped quote in an interpolated value, an off-by-one period, a
  // bad blank-node form). This test parses every builder's output
  // through the same RDF parser federation consumers will use. If
  // anything regresses on Turtle correctness, this catches it.
  const OP_DID = 'did:web:identity.example#operator';
  const cases: { name: string; build: () => { graph_content: string }; minQuads: number }[] = [
    {
      name: 'deploy (with hostile component name)',
      build: () => buildDeployEvent({
        component: 'evil"name with spaces',
        commitSha: 'abc',
        deployerDid: OP_DID,
        rollbackPlan: 'revert r-1',
      }),
      minQuads: 8,
    },
    {
      name: 'access change (multiline justification)',
      build: () => buildAccessChangeEvent({
        action: 'granted',
        principal: 'did:web:bob',
        system: 'azure',
        scope: 'Reader',
        grantorDid: OP_DID,
        justification: 'audit access\nmulti-line',
      }),
      minQuads: 9,
    },
    {
      name: 'wallet rotation (special chars in note)',
      build: () => buildWalletRotationEvent({
        retiredAddress: '0x111',
        newActiveAddress: '0x222',
        reason: 'compromise-response',
        operatorDid: OP_DID,
        note: 'special chars: \\ " foo',
      }),
      minQuads: 8,
    },
    {
      name: 'incident (resolved with components + supersedes)',
      build: () => buildIncidentEvent({
        severity: 'sev-1',
        title: 'Auth out',
        summary: 'down',
        detectedAt: '2026-04-25T08:00:00Z',
        detectionSource: 'pager',
        responderDid: OP_DID,
        status: 'resolved',
        affectedComponents: ['identity', 'relay'],
        supersedes: ['https://pod.example/desc/i1'],
      }),
      minQuads: 12,
    },
    {
      name: 'quarterly review (multiple findings)',
      build: () => buildQuarterlyReviewEvent({
        quarter: '2026-Q2',
        kind: 'access',
        reviewerDid: OP_DID,
        summary: 's',
        findingCount: 3,
        findings: ['a', 'b', 'c'],
      }),
      minQuads: 13,
    },
  ];

  it.each(cases)('$name', ({ build, minQuads }) => {
    const ev = build();
    const parser = new Parser();
    const quads = parser.parse(ev.graph_content);
    expect(quads.length).toBeGreaterThanOrEqual(minQuads);
  });
});

describe('graph_iri uniqueness', () => {
  it('different timestamps produce different iris', async () => {
    const a = buildDeployEvent({ component: 'r', commitSha: 'x', deployerDid: OP, timestamp: '2026-04-25T10:00:00Z' });
    const b = buildDeployEvent({ component: 'r', commitSha: 'x', deployerDid: OP, timestamp: '2026-04-25T11:00:00Z' });
    expect(a.graph_iri).not.toBe(b.graph_iri);
  });

  it('different components produce different iris at same timestamp', () => {
    const ts = '2026-04-25T10:00:00Z';
    const a = buildDeployEvent({ component: 'relay', commitSha: 'x', deployerDid: OP, timestamp: ts });
    const b = buildDeployEvent({ component: 'identity', commitSha: 'x', deployerDid: OP, timestamp: ts });
    expect(a.graph_iri).not.toBe(b.graph_iri);
  });
});
