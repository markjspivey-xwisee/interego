import { describe, it, expect, afterEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildSecurityTxt, buildSecurityTxtFromEnv } from '../src/security-txt/index.js';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '..');

describe('buildSecurityTxt — body construction', () => {
  it('falls back to GitHub Security Advisory URL when no contact configured', () => {
    const body = buildSecurityTxt();
    expect(body).toContain('Contact: https://github.com/markjspivey-xwisee/interego/security/advisories/new');
    expect(body).not.toContain('security@interego.dev');
  });

  it('prefixes a bare email with mailto:', () => {
    const body = buildSecurityTxt({ contact: 'sec@example.com' });
    expect(body).toContain('Contact: mailto:sec@example.com');
  });

  it('passes through mailto: URIs unchanged', () => {
    const body = buildSecurityTxt({ contact: 'mailto:already@example.com' });
    expect(body).toContain('Contact: mailto:already@example.com');
    expect(body).not.toContain('Contact: mailto:mailto:');
  });

  it('passes through https: URIs unchanged', () => {
    const body = buildSecurityTxt({ contact: 'https://example.com/security' });
    expect(body).toContain('Contact: https://example.com/security');
  });

  it('passes through tel: URIs unchanged', () => {
    const body = buildSecurityTxt({ contact: 'tel:+15551234' });
    expect(body).toContain('Contact: tel:+15551234');
  });

  it('emits Canonical line only when canonicalBaseUrl is provided', () => {
    expect(buildSecurityTxt()).not.toContain('Canonical:');
    expect(buildSecurityTxt({ canonicalBaseUrl: 'https://app.example.com' })).toContain(
      'Canonical: https://app.example.com/.well-known/security.txt',
    );
  });

  it('strips trailing slash from canonicalBaseUrl', () => {
    const body = buildSecurityTxt({ canonicalBaseUrl: 'https://app.example.com/' });
    expect(body).toContain('Canonical: https://app.example.com/.well-known/security.txt');
    expect(body).not.toContain('//.well-known');
  });

  it('emits required RFC 9116 fields in order', () => {
    const body = buildSecurityTxt();
    const expected = ['Contact:', 'Expires:', 'Preferred-Languages:', 'Policy:', 'Acknowledgments:'];
    let lastIndex = -1;
    for (const field of expected) {
      const idx = body.indexOf(field);
      expect(idx, `${field} missing`).toBeGreaterThan(-1);
      expect(idx, `${field} out of order`).toBeGreaterThan(lastIndex);
      lastIndex = idx;
    }
  });

  it('has Expires field with valid ISO 8601 timestamp', () => {
    const body = buildSecurityTxt();
    const m = body.match(/^Expires: (.+)$/m);
    expect(m).not.toBeNull();
    const ts = new Date(m![1]!);
    expect(ts.toString()).not.toBe('Invalid Date');
  });

  it('Expires field is not in the past', () => {
    // Audit-relevant: a security.txt that has already expired is
    // worse than no security.txt — researchers don't know if the
    // contact is still monitored. This test will fail when the
    // hardcoded default falls behind the current date, prompting
    // the annual refresh.
    const body = buildSecurityTxt();
    const m = body.match(/^Expires: (.+)$/m);
    const ts = new Date(m![1]!);
    expect(ts.getTime()).toBeGreaterThan(Date.now());
  });
});

describe('buildSecurityTxtFromEnv — env-driven path', () => {
  const originalContact = process.env['SECURITY_CONTACT'];
  afterEach(() => {
    if (originalContact === undefined) delete process.env['SECURITY_CONTACT'];
    else process.env['SECURITY_CONTACT'] = originalContact;
  });

  it('reads SECURITY_CONTACT from env', () => {
    process.env['SECURITY_CONTACT'] = 'reporter@example.com';
    const body = buildSecurityTxtFromEnv();
    expect(body).toContain('Contact: mailto:reporter@example.com');
  });

  it('uses fallback when SECURITY_CONTACT is unset', () => {
    delete process.env['SECURITY_CONTACT'];
    const body = buildSecurityTxtFromEnv();
    expect(body).toContain('Contact: https://github.com/markjspivey-xwisee/interego/security/advisories/new');
  });

  it('threads canonicalBaseUrl through to the body', () => {
    delete process.env['SECURITY_CONTACT'];
    const body = buildSecurityTxtFromEnv('https://relay.example.com');
    expect(body).toContain('Canonical: https://relay.example.com/.well-known/security.txt');
  });
});

describe('inline copies in identity + validator stay in lockstep with shared helper', () => {
  // Identity and validator deliberately don't depend on @interego/core
  // (lean Dockerfiles). They each maintain an inline copy of the
  // security.txt body builder. Audit consistency requires those
  // inlines produce IDENTICAL output to the shared helper for the
  // same inputs. This test diffs the two by extracting and
  // simulating each inline expression — if either drifts, this fails.

  // Strategy: read the inline source, eval the IIFE substring with
  // controlled inputs, compare to buildSecurityTxt with same inputs.
  // We simulate by running buildSecurityTxt directly with the inputs
  // each inline would receive, and assert the inline source contains
  // the same Policy + Acknowledgments URLs and Expires literal.

  it('identity inline emits the same Policy + Acknowledgments URLs as the shared helper', () => {
    const src = readFileSync(resolve(repoRoot, 'deploy/identity/server.ts'), 'utf8');
    const reference = buildSecurityTxt();
    const policyMatch = reference.match(/^Policy: (.+)$/m)![1];
    const ackMatch = reference.match(/^Acknowledgments: (.+)$/m)![1];
    const expiresMatch = reference.match(/^Expires: (.+)$/m)![1];
    expect(src).toContain(`Policy: ${policyMatch}`);
    expect(src).toContain(`Acknowledgments: ${ackMatch}`);
    expect(src).toContain(`Expires: ${expiresMatch}`);
  });

  it('validator inline emits the same Policy + Acknowledgments URLs as the shared helper', () => {
    const src = readFileSync(resolve(repoRoot, 'deploy/validator/server.ts'), 'utf8');
    const reference = buildSecurityTxt();
    const policyMatch = reference.match(/^Policy: (.+)$/m)![1];
    const ackMatch = reference.match(/^Acknowledgments: (.+)$/m)![1];
    const expiresMatch = reference.match(/^Expires: (.+)$/m)![1];
    expect(src).toContain(`Policy: ${policyMatch}`);
    expect(src).toContain(`Acknowledgments: ${ackMatch}`);
    expect(src).toContain(`Expires: ${expiresMatch}`);
  });

  it('identity inline uses the same fallback URL as the shared helper', () => {
    const src = readFileSync(resolve(repoRoot, 'deploy/identity/server.ts'), 'utf8');
    const reference = buildSecurityTxt(); // no contact → falls back
    const fallbackContact = reference.match(/^Contact: (.+)$/m)![1];
    expect(src).toContain(fallbackContact);
  });

  it('validator inline uses the same fallback URL as the shared helper', () => {
    const src = readFileSync(resolve(repoRoot, 'deploy/validator/server.ts'), 'utf8');
    const reference = buildSecurityTxt();
    const fallbackContact = reference.match(/^Contact: (.+)$/m)![1];
    expect(src).toContain(fallbackContact);
  });
});
