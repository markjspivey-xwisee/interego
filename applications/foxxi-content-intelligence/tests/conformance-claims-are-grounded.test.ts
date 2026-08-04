/**
 * A CONFORMANCE.md row must be grounded in code that exists.
 *
 * Three rows misdescribed the tree and all three survived because nothing ever
 * compared the prose to the source:
 *
 *   :195 OB3 issuer   deferred against "the substrate's `VcPayload.issuer: string`".
 *                     No `VcPayload` exists anywhere in the repo, and the object form
 *                     `{ id, type, name }` already signs, verifies and stays tamper-bound
 *                     via issuerId(). Naming the one boundary this project gatekeeps
 *                     turned an application-local task into a permanent deferral.
 *   :118 Signed Stmts called the remainder "a small additional wiring step" via
 *                     lti13.ts `jwsSignEs256()`. That helper emits ES256; ALLOWED_JWS_ALGS
 *                     is {RS256,RS384,RS512}, so following the row produces statements
 *                     this very LRS rejects with a 400. Wrong plumbing, not a small step.
 *   :135 LOM Technical cited `schema:duration` and `schema:softwareVersion`, neither of
 *                     which appears in any source file.
 *
 * These assertions bind the prose to the tree so the rows cannot drift back.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const conformance = readFileSync(join(ROOT, 'CONFORMANCE.md'), 'utf8');
const xapiLrs = readFileSync(join(ROOT, 'src', 'xapi-lrs.ts'), 'utf8');
const lomSeq = readFileSync(join(ROOT, 'src', 'lom-sequencing.ts'), 'utf8');
const dataIntegrity = readFileSync(join(ROOT, '..', '_shared', 'vc-jwt', 'data-integrity-jcs.ts'), 'utf8');

/** The single CONFORMANCE.md table row beginning with `marker`. */
function row(marker: string): string {
  const i = conformance.indexOf(marker);
  expect(i, `row not found: ${marker}`).toBeGreaterThan(-1);
  const end = conformance.indexOf('\n', i);
  return conformance.slice(i, end === -1 ? undefined : end);
}

describe('CONFORMANCE.md rows are grounded in code that exists', () => {
  it('no row defers against `VcPayload`, which is declared nowhere', () => {
    expect(dataIntegrity, 'if this type is ever introduced, revisit the OB3 issuer row')
      .not.toMatch(/\bVcPayload\b/);
    expect(conformance).not.toMatch(/\bVcPayload\.issuer\b/);
  });

  it('the OB3 issuer row does not blame the substrate', () => {
    const r = row('| OB3 issuer (Profile)');
    expect(r).not.toMatch(/loosening the substrate/);
    expect(r, 'the row must name the real remedy').toMatch(/issuerId\(\)/);
  });

  it('the object issuer form the row calls supported really is supported', () => {
    expect(dataIntegrity).toMatch(/export function issuerId/);
    expect(dataIntegrity).toMatch(/issuerId\(unsigned\.issuer\) !== issuer\.did/);
    expect(dataIntegrity).toMatch(/issuerId\(signed\.issuer\) !== did/);
  });

  it('the Signed Statements row names exactly the algorithms the LRS accepts', () => {
    const m = /const ALLOWED_JWS_ALGS = new Set\(\[([^\]]*)\]\)/.exec(xapiLrs);
    expect(m, 'ALLOWED_JWS_ALGS not found in xapi-lrs.ts').not.toBeNull();
    const algs = [...m![1]!.matchAll(/'([^']+)'/g)].map(x => x[1]!);
    expect(algs.length, 'the allowlist must not be empty').toBeGreaterThan(0);
    const r = row('| Signed Statements');
    // ★ THE ENUMERATION, NOT MERE MENTION. Asserting `r.toContain(a)` per algorithm is
    // not a binding: the row also names ES256 in the sentence saying the LRS REFUSES it,
    // so adding 'ES256' to ALLOWED_JWS_ALGS left that check green — measured. The row
    // must reproduce the allowlist in order, so widening the set in code and leaving the
    // doc alone is what turns this red.
    expect(r, `the row must enumerate the LRS allowlist verbatim: ${algs.join(' / ')}`)
      .toContain(algs.join(' / '));
    // ES256 is what lti13.ts can emit. The row's claim about that helper must agree with
    // the allowlist in BOTH directions — otherwise the doc can keep calling an accepted
    // algorithm refused.
    if (algs.includes('ES256')) {
      expect(r, 'ES256 is in ALLOWED_JWS_ALGS, so the row must stop calling it rejected')
        .not.toMatch(/ES256, which this LRS rejects/);
    } else {
      expect(r, 'jwsSignEs256() emits an algorithm this LRS refuses')
        .toMatch(/`jwsSignEs256\(\)` is \*not\* the path/);
    }
  });

  it('the LOM Technical row cites only terms that exist in source', () => {
    const r = row('| Technical (duration, format, version)');
    for (const term of ['schema:duration', 'schema:softwareVersion']) {
      // The row is allowed to SAY these terms appear nowhere; what it must not do is
      // cite them as the implementation. The parenthetical retraction is matched out
      // first so the retraction itself cannot trip the guard.
      const claim = r.replace(/\(The `schema:duration` \/ `schema:softwareVersion` terms previously cited here appear in no source file\.\)/, '');
      expect(claim, `${term} appears in no source file`).not.toContain(term);
    }
    expect(lomSeq, 'the row now credits lomToTurtle for format/size/duration')
      .toMatch(/LOM_NS\}format/);
    expect(lomSeq).toMatch(/LOM_NS\}size/);
  });
});
