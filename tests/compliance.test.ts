/**
 * Compliance helper tests — checkComplianceInputs +
 * generateFrameworkReport + walkLineage + wallet load/rotate.
 */

import { describe, it, expect, afterEach } from 'vitest';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { unlinkSync, existsSync } from 'node:fs';
import type { IRI } from '../src/model/types.js';
import {
  checkComplianceInputs,
  generateFrameworkReport,
  walkLineage,
  FRAMEWORK_CONTROLS,
  loadOrCreateComplianceWallet,
  rotateComplianceWallet,
  importComplianceWallet,
  listValidSignerAddresses,
  type AuditableDescriptor,
} from '../src/compliance/index.js';

describe('checkComplianceInputs', () => {
  it('passes when all requirements met', () => {
    const r = checkComplianceInputs({
      modalStatus: 'Asserted',
      trustLevel: 'CryptographicallyVerified',
      hasSignature: true,
    });
    expect(r.compliant).toBe(true);
    expect(r.violations).toHaveLength(0);
  });

  it('flags Hypothetical modal as not compliance-grade', () => {
    const r = checkComplianceInputs({
      modalStatus: 'Hypothetical',
      trustLevel: 'CryptographicallyVerified',
      hasSignature: true,
    });
    expect(r.compliant).toBe(false);
    expect(r.violations.some(v => v.includes('Hypothetical'))).toBe(true);
  });

  it('flags low trust + suggests upgrade', () => {
    const r = checkComplianceInputs({
      modalStatus: 'Asserted',
      trustLevel: 'SelfAsserted',
      hasSignature: true,
    });
    expect(r.compliant).toBe(false);
    expect(r.upgradedFacets.some(u => u.includes('CryptographicallyVerified'))).toBe(true);
  });

  it('flags missing signature', () => {
    const r = checkComplianceInputs({
      modalStatus: 'Asserted',
      trustLevel: 'CryptographicallyVerified',
      hasSignature: false,
    });
    expect(r.compliant).toBe(false);
    expect(r.violations.some(v => v.toLowerCase().includes('signature'))).toBe(true);
  });

  it('accumulates multiple violations', () => {
    const r = checkComplianceInputs({
      modalStatus: 'Hypothetical',
      trustLevel: 'SelfAsserted',
      hasSignature: false,
    });
    expect(r.violations.length).toBeGreaterThanOrEqual(3);
  });
});

describe('FRAMEWORK_CONTROLS', () => {
  it('exposes all three frameworks', () => {
    expect(FRAMEWORK_CONTROLS['eu-ai-act'].length).toBeGreaterThan(0);
    expect(FRAMEWORK_CONTROLS['nist-rmf'].length).toBeGreaterThan(0);
    expect(FRAMEWORK_CONTROLS.soc2.length).toBeGreaterThan(0);
  });

  it('every control has IRI + label', () => {
    for (const fw of Object.values(FRAMEWORK_CONTROLS)) {
      for (const c of fw) {
        expect(c.iri).toBeTruthy();
        expect(c.label).toBeTruthy();
      }
    }
  });
});

describe('generateFrameworkReport', () => {
  const NOW = '2026-04-25T12:00:00Z';

  it('reports all-missing when no evidence supplied', () => {
    const rpt = generateFrameworkReport('soc2', []);
    expect(rpt.framework).toBe('soc2');
    expect(rpt.summary.satisfied).toBe(0);
    expect(rpt.summary.partial).toBe(0);
    expect(rpt.summary.missing).toBe(rpt.summary.totalControls);
    expect(rpt.summary.overallScore).toBe(0);
  });

  it('reports satisfied when ≥ 2 evidence records cite a control', () => {
    const descs: AuditableDescriptor[] = [
      { id: 'urn:1' as IRI, publishedAt: NOW, evidenceForControls: ['soc2:CC6.1' as IRI] },
      { id: 'urn:2' as IRI, publishedAt: NOW, evidenceForControls: ['soc2:CC6.1' as IRI] },
    ];
    const rpt = generateFrameworkReport('soc2', descs);
    const cc61 = rpt.entries.find(e => e.controlIri === 'soc2:CC6.1');
    expect(cc61?.status).toBe('satisfied');
    expect(cc61?.evidenceCount).toBe(2);
  });

  it('reports partial when exactly 1 evidence record', () => {
    const descs: AuditableDescriptor[] = [
      { id: 'urn:1' as IRI, publishedAt: NOW, evidenceForControls: ['soc2:CC6.1' as IRI] },
    ];
    const rpt = generateFrameworkReport('soc2', descs);
    expect(rpt.entries.find(e => e.controlIri === 'soc2:CC6.1')?.status).toBe('partial');
  });

  it('respects audit period filter', () => {
    const descs: AuditableDescriptor[] = [
      { id: 'urn:old' as IRI, publishedAt: '2025-01-01T00:00:00Z', evidenceForControls: ['soc2:CC6.1' as IRI] },
      { id: 'urn:new' as IRI, publishedAt: NOW, evidenceForControls: ['soc2:CC6.1' as IRI] },
    ];
    const rpt = generateFrameworkReport('soc2', descs, {
      auditPeriod: { from: '2026-01-01T00:00:00Z', to: '2026-12-31T00:00:00Z' },
    });
    const cc61 = rpt.entries.find(e => e.controlIri === 'soc2:CC6.1');
    expect(cc61?.evidenceCount).toBe(1); // only urn:new is in period
  });

  it('overallScore is weighted: satisfied=1, partial=0.5, missing=0', () => {
    // Construct exactly: 2 satisfied + 1 partial + rest missing
    const descs: AuditableDescriptor[] = [
      { id: 'urn:a' as IRI, publishedAt: NOW, evidenceForControls: ['soc2:CC1.1' as IRI] },
      { id: 'urn:b' as IRI, publishedAt: NOW, evidenceForControls: ['soc2:CC1.1' as IRI] },
      { id: 'urn:c' as IRI, publishedAt: NOW, evidenceForControls: ['soc2:CC2.1' as IRI] },
      { id: 'urn:d' as IRI, publishedAt: NOW, evidenceForControls: ['soc2:CC2.1' as IRI] },
      { id: 'urn:e' as IRI, publishedAt: NOW, evidenceForControls: ['soc2:CC6.1' as IRI] },
    ];
    const rpt = generateFrameworkReport('soc2', descs);
    expect(rpt.summary.satisfied).toBe(2);
    expect(rpt.summary.partial).toBe(1);
    const expected = (2 + 1 * 0.5) / rpt.summary.totalControls;
    expect(rpt.summary.overallScore).toBeCloseTo(expected, 5);
  });
});

describe('walkLineage', () => {
  const ROOT = 'urn:cg:root' as IRI;

  it('returns just self when no ancestors known', () => {
    const r = walkLineage(ROOT, new Map());
    expect(r).toHaveLength(1);
    expect(r[0]?.id).toBe(ROOT);
    expect(r[0]?.relation).toBe('self');
  });

  it('walks derivedFrom chain', () => {
    const A = 'urn:cg:a' as IRI;
    const B = 'urn:cg:b' as IRI;
    const idx = new Map([
      [ROOT, { publishedAt: '2026-04-25', derivedFrom: [A], supersedes: [] }],
      [A, { publishedAt: '2026-04-20', derivedFrom: [B], supersedes: [] }],
      [B, { publishedAt: '2026-04-15', derivedFrom: [], supersedes: [] }],
    ]);
    const r = walkLineage(ROOT, idx);
    expect(r.length).toBe(3);
    expect(r.map(n => n.id)).toEqual([ROOT, A, B]);
    expect(r.map(n => n.relation)).toEqual(['self', 'derivedFrom', 'derivedFrom']);
  });

  it('walks supersedes chain', () => {
    const PRIOR = 'urn:cg:prior' as IRI;
    const idx = new Map([
      [ROOT, { publishedAt: '2026-04-25', derivedFrom: [], supersedes: [PRIOR] }],
      [PRIOR, { publishedAt: '2026-04-20', derivedFrom: [], supersedes: [] }],
    ]);
    const r = walkLineage(ROOT, idx);
    expect(r.find(n => n.id === PRIOR)?.relation).toBe('supersedes');
  });

  it('handles cycles without infinite loop', () => {
    const A = 'urn:cg:a' as IRI;
    // ROOT → A → ROOT (cyclic)
    const idx = new Map([
      [ROOT, { publishedAt: '2026-04-25', derivedFrom: [A], supersedes: [] }],
      [A, { publishedAt: '2026-04-20', derivedFrom: [ROOT], supersedes: [] }],
    ]);
    const r = walkLineage(ROOT, idx);
    expect(r.length).toBe(2); // visited set prevents re-walk
  });
});

describe('compliance wallet — ESM-safe wallet generation', () => {
  // Regression: a prior version of generatePrivateKey() used CJS
  // require('ethers') inside an ESM module, which silently broke
  // any caller of loadOrCreateComplianceWallet at runtime. The unit
  // tests above don't touch wallet generation, so the breakage
  // shipped. These tests exist so it can't ship again.

  const paths: string[] = [];
  afterEach(() => {
    for (const p of paths.splice(0)) {
      try { if (existsSync(p)) unlinkSync(p); } catch { /* ignore */ }
    }
  });

  function freshPath(): string {
    const p = join(tmpdir(), `interego-wallet-test-${Date.now()}-${Math.random().toString(36).slice(2)}.json`);
    paths.push(p);
    return p;
  }

  it('mints a fresh wallet on first load and persists it', async () => {
    const path = freshPath();
    const w = await loadOrCreateComplianceWallet(path, 'test-signer');
    expect(w.fresh).toBe(true);
    expect(w.wallet.address).toMatch(/^0x[0-9a-fA-F]{40}$/);
    expect(w.privateKey).toMatch(/^0x[0-9a-fA-F]{64}$/);
    expect(w.path).toBe(path);
    expect(w.historyCount).toBe(0);
    expect(existsSync(path)).toBe(true);
  });

  it('reloads the same wallet on subsequent calls', async () => {
    const path = freshPath();
    const a = await loadOrCreateComplianceWallet(path, 'test-signer');
    const b = await loadOrCreateComplianceWallet(path, 'test-signer');
    expect(b.fresh).toBe(false);
    expect(b.wallet.address).toBe(a.wallet.address);
    expect(b.privateKey).toBe(a.privateKey);
  });

  it('rotation produces a new active wallet and retires the prior', async () => {
    const path = freshPath();
    const before = await loadOrCreateComplianceWallet(path, 'test-signer');
    const result = await rotateComplianceWallet(path);
    expect(result.retiredAddress).toBe(before.wallet.address);
    expect(result.newActiveAddress).not.toBe(before.wallet.address);
    const after = await loadOrCreateComplianceWallet(path, 'test-signer');
    expect(after.wallet.address).toBe(result.newActiveAddress);
    expect(after.historyCount).toBe(1);
  });

  it('listValidSignerAddresses returns active + history after rotation', async () => {
    const path = freshPath();
    const before = await loadOrCreateComplianceWallet(path, 'test-signer');
    await rotateComplianceWallet(path);
    const after = await loadOrCreateComplianceWallet(path, 'test-signer');
    const valid = listValidSignerAddresses(path);
    expect(valid).toContain(after.wallet.address);
    expect(valid).toContain(before.wallet.address);
    expect(valid).toHaveLength(2);
  });

  it('importComplianceWallet rotates in a caller-supplied key', async () => {
    const path = freshPath();
    await loadOrCreateComplianceWallet(path, 'test-signer');
    // Use a deterministic well-known test key (NEVER use this for production —
    // this is the first key from the Hardhat default mnemonic)
    const testKey = '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80';
    const result = await importComplianceWallet(path, testKey, 'imported-signer');
    expect(result.newActiveAddress).toBe('0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266');
    const reloaded = await loadOrCreateComplianceWallet(path, 'test-signer');
    expect(reloaded.wallet.address).toBe('0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266');
    expect(reloaded.historyCount).toBe(1);
  });
});
