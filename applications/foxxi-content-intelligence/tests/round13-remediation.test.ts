import { describe, it, expect } from 'vitest';
import {
  issueBbsCompletionCredential, deriveCompletionPresentation, verifyCompletionPresentation,
} from '../src/bbs-credentials.js';
import { isPrivateHostname, safePublicUrlOrUndefined, assertSafeFetchTarget } from '../src/ssrf-guard.js';
import { renderSemOntologyJsonLd } from '../src/ler-tla-vocab.js';

// ── B1 (BLOCKER): BBS+ verifier derives disclosed values from the SIGNED message bytes,
//     not the holder-controlled displayValue — a tampered displayValue cannot flip a claim. ──
describe('round-13 — BBS+ verifier ignores a tampered displayValue (selective-disclosure integrity)', () => {
  it('a holder flipping displayValue Beginner→Expert is NOT believed; the disclosed value stays Beginner', async () => {
    const issued = await issueBbsCompletionCredential({
      subject: {
        learnerDid: 'did:ethr:0x1111111111111111111111111111111111111111',
        courseId: 'golf-explained', courseTitle: 'Golf Explained',
        scoreScaled: 0.9, proficiencyLevel: 'Beginner',
        alignedSkills: [{ targetCode: 'golf', targetName: 'Golf' }],
      },
      tenantProfileName: 'Test Tenant', issuerSeed: 'round13-test-seed',
    });
    const presentation = await deriveCompletionPresentation({
      issued, revealPaths: issued.claimIndex.map(c => c.path),
    });
    // Find the disclosed message whose SIGNED value is Beginner, and tamper ONLY its displayValue.
    const tampered = {
      ...presentation,
      disclosedMessages: presentation.disclosedMessages.map(d =>
        d.displayValue.includes('Beginner')
          ? { ...d, displayValue: d.displayValue.replace('Beginner', 'Expert') }
          : d),
    };
    const beginnerPath = presentation.disclosedMessages.find(d => d.displayValue.includes('Beginner'))!.displayValue.split('=')[0];
    const result = await verifyCompletionPresentation({ presentation: tampered });
    // The proof still verifies (message bytes unchanged), but the disclosed value comes
    // from the SIGNED bytes (still says Beginner), NOT the tampered displayValue (Expert).
    expect(result.verified).toBe(true);
    const disclosed = result.disclosed.find(x => x.path === beginnerPath);
    expect(disclosed?.value).toContain('Beginner');
    expect(disclosed?.value).not.toContain('Expert');
    // And NO disclosed value anywhere reflects the tampered 'Expert' string.
    expect(result.disclosed.some(x => x.value.includes('Expert'))).toBe(false);
  });
  it('a failed proof discloses nothing', async () => {
    const issued = await issueBbsCompletionCredential({
      subject: {
        learnerDid: 'did:ethr:0x2222222222222222222222222222222222222222',
        courseId: 'c', courseTitle: 'C', scoreScaled: 0.5, proficiencyLevel: 'Novice',
        alignedSkills: [{ targetCode: 'x', targetName: 'X' }],
      },
      tenantProfileName: 'T', issuerSeed: 'seed2',
    });
    const presentation = await deriveCompletionPresentation({ issued, revealPaths: issued.claimIndex.map(c => c.path) });
    // Corrupt the proof bytes → verification must fail and disclose nothing.
    const badProof = new Uint8Array(presentation.proof); badProof[0] ^= 0xff;
    const result = await verifyCompletionPresentation({ presentation: { ...presentation, proof: badProof } });
    expect(result.verified).toBe(false);
    expect(result.disclosed).toEqual([]);
  });
});

// ── B2 (BLOCKER): SSRF guard blocks loopback/link-local/private targets. ──
describe('round-13 — ssrf-guard blocks private/loopback/link-local, allows public', () => {
  it('isPrivateHostname flags every private/loopback/link-local literal', () => {
    for (const h of ['127.0.0.1', '169.254.169.254', '10.0.0.5', '192.168.1.1', '172.16.0.1', '172.31.255.255', '0.0.0.0', 'localhost', 'foo.localhost', '::1', '::', 'fe80::1', 'fd00::1', '100.64.0.1']) {
      expect(isPrivateHostname(h), h).toBe(true);
    }
  });
  it('isPrivateHostname passes public hosts', () => {
    for (const h of ['gate.interego.xwisee.com', 'foxxi-bridge.interego.xwisee.com', '8.8.8.8', '1.1.1.1', 'example.com']) {
      expect(isPrivateHostname(h), h).toBe(false);
    }
  });
  it('safePublicUrlOrUndefined drops private + non-http(s), keeps public http(s)', () => {
    expect(safePublicUrlOrUndefined('http://127.0.0.1:6080/')).toBeUndefined();
    expect(safePublicUrlOrUndefined('http://169.254.169.254/latest/meta-data/')).toBeUndefined();
    expect(safePublicUrlOrUndefined('ftp://example.com/')).toBeUndefined();
    expect(safePublicUrlOrUndefined('javascript:alert(1)')).toBeUndefined();
    expect(safePublicUrlOrUndefined('https://gate.interego.xwisee.com/foxxi/')).toBe('https://gate.interego.xwisee.com/foxxi/');
  });
  it('assertSafeFetchTarget rejects IP-literal private targets + bad schemes (no DNS needed)', async () => {
    await expect(assertSafeFetchTarget('http://127.0.0.1:6080/')).rejects.toThrow();
    await expect(assertSafeFetchTarget('http://169.254.169.254/')).rejects.toThrow();
    await expect(assertSafeFetchTarget('ftp://example.com/')).rejects.toThrow();
    await expect(assertSafeFetchTarget('not a url')).rejects.toThrow();
  });
});

// ── M4 (major): adl-tla JSON-LD Level/RollupRule skos:inScheme is an IRI reference, not a literal. ──
describe('round-13 — adl-tla proficiency JSON-LD skos:inScheme is {@id} (triple-faithful to Turtle)', () => {
  const j = renderSemOntologyJsonLd('tla') as { '@graph': Array<Record<string, unknown>> };
  it('every tla:Level node carries skos:inScheme as an @id object (not a bare string literal)', () => {
    const levels = j['@graph'].filter(n => Array.isArray(n['@type']) && (n['@type'] as string[]).includes('tla:Level'));
    expect(levels.length).toBeGreaterThan(0);
    for (const l of levels) {
      const inScheme = l['skos:inScheme'] as unknown;
      expect(inScheme, String(l['@id'])).toBeTypeOf('object');
      expect((inScheme as Record<string, unknown>)['@id']).toBeTruthy();
    }
  });
  it('the RollupRule node carries skos:inScheme (was absent from the JSON-LD)', () => {
    const rule = j['@graph'].find(n => n['@type'] === 'tla:RollupRule') as Record<string, unknown>;
    expect(rule).toBeTruthy();
    expect((rule['skos:inScheme'] as Record<string, unknown>)?.['@id']).toBeTruthy();
  });
});
