/**
 * Privacy-hygiene tests — screenForSensitiveContent.
 */

import { describe, it, expect } from 'vitest';
import {
  screenForSensitiveContent,
  formatSensitivityWarning,
  shouldBlockOnSensitivity,
} from '../src/privacy/index.js';

// Test fixtures are built via runtime concatenation so the literal strings
// in source don't trip GitHub's secret-scanner push protection. The
// detector regex still matches the assembled strings the same way.
const FAKE = {
  anthropic: 'sk' + '-ant-' + 'api03-FIXTUREDONOTUSE12345678abcdef',
  openai:    'sk' + '-FIXTUREDONOTUSE1234567890abcdef',
  aws:       'AKIA' + 'FIXTUREDONOTUSEX', // AKIA + 16 chars per real format
  github:    'ghp' + '_FIXTUREDONOTUSE12345678901234567890ab',
  stripe:    'sk' + '_live_' + 'FIXTUREDONOTUSE1234567890abcdef',
} as const;

describe('screenForSensitiveContent — high severity', () => {
  it('flags an Anthropic API key', () => {
    const flags = screenForSensitiveContent(`my key is ${FAKE.anthropic}`);
    expect(flags.some(f => f.kind === 'api-key-anthropic')).toBe(true);
    expect(flags.find(f => f.kind === 'api-key-anthropic')?.severity).toBe('high');
  });

  it('flags a generic OpenAI-style key', () => {
    const flags = screenForSensitiveContent(`OPENAI_API_KEY=${FAKE.openai}`);
    expect(flags.some(f => f.kind === 'api-key-openai')).toBe(true);
  });

  it('flags an AWS access key', () => {
    const flags = screenForSensitiveContent(`aws_access_key_id = ${FAKE.aws}`);
    expect(flags.some(f => f.kind === 'api-key-aws')).toBe(true);
  });

  it('flags a GitHub PAT', () => {
    const flags = screenForSensitiveContent(`export GH_TOKEN=${FAKE.github}`);
    expect(flags.some(f => f.kind === 'api-key-github')).toBe(true);
  });

  it('flags a Stripe live key', () => {
    const flags = screenForSensitiveContent(FAKE.stripe);
    expect(flags.some(f => f.kind === 'api-key-stripe')).toBe(true);
  });

  it('flags a JWT', () => {
    const jwt = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NSJ9.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c';
    const flags = screenForSensitiveContent(`Bearer ${jwt}`);
    expect(flags.some(f => f.kind === 'jwt')).toBe(true);
  });

  it('flags a PEM private key', () => {
    const pem = `-----BEGIN RSA PRIVATE KEY-----
MIIBOQIBAAJAYV/BBI...redacted...
-----END RSA PRIVATE KEY-----`;
    const flags = screenForSensitiveContent(`config: ${pem}`);
    expect(flags.some(f => f.kind === 'private-key-pem')).toBe(true);
  });

  // ── Cloud provider tokens (added 2026-05-04 per security audit) ──

  it('flags a Google Cloud / Firebase API key', () => {
    // Synthetic placeholder shaped like AIza + 35 base64url chars; not a
    // real key. (Constructed via concatenation so the literal in source
    // never matches GitHub's secret-scanning fingerprints.)
    const fake = 'AIza' + 'X'.repeat(35);
    const flags = screenForSensitiveContent(`config { apiKey: "${fake}" }`);
    expect(flags.some(f => f.kind === 'api-key-gcp')).toBe(true);
  });

  it('flags an Azure SAS token', () => {
    const sas = 'sv=2021-06-08&sr=b&sp=racwd&se=2030-01-01T00:00:00Z&sig=Abc123XyzDef456%2BGhi789%3D';
    const flags = screenForSensitiveContent(`url=https://account.blob.core.windows.net/path?${sas}`);
    expect(flags.some(f => f.kind === 'azure-sas-token')).toBe(true);
  });

  it('flags a Google OAuth refresh token', () => {
    // Synthetic placeholder; matches `1//[A-Za-z0-9_-]{40,}` but is
    // clearly not real and is constructed via concatenation.
    const fake = '1//' + 'PLACEHOLDER-NOT-A-REAL-REFRESH-TOKEN-XYZ'.padEnd(45, 'X');
    const flags = screenForSensitiveContent(`refresh_token=${fake}`);
    expect(flags.some(f => f.kind === 'oauth-refresh-google')).toBe(true);
  });

  it('flags a Google OAuth access token (ya29.…)', () => {
    // Synthetic placeholder — concatenated so the literal isn't fingerprintable
    const fake = 'ya29.' + 'PLACEHOLDER_NOT_A_REAL_TOKEN_X'.padEnd(30, 'X');
    const flags = screenForSensitiveContent(`Authorization: Bearer ${fake}`);
    expect(flags.some(f => f.kind === 'oauth-refresh-google')).toBe(true);
  });

  it('flags a PostgreSQL connection string with embedded password', () => {
    // Placeholder credentials; clearly not a real production string.
    const fake = 'postgres://' + 'EXAMPLE' + ':' + 'PLACEHOLDER' + '@db.example.com:5432/myapp';
    const flags = screenForSensitiveContent(`DATABASE_URL=${fake}`);
    expect(flags.some(f => f.kind === 'postgres-connection-string')).toBe(true);
  });

  it('flags a MySQL connection string with embedded password', () => {
    const fake = 'mysql://' + 'EXAMPLE' + ':' + 'PLACEHOLDER' + '@127.0.0.1:3306/prod';
    const flags = screenForSensitiveContent(`uri = "${fake}"`);
    expect(flags.some(f => f.kind === 'postgres-connection-string')).toBe(true);
  });

  it('flags a MongoDB connection string with embedded password', () => {
    const fake = 'mongodb+srv://' + 'EXAMPLE' + ':' + 'PLACEHOLDER' + '@cluster0.mongodb.net/myapp';
    const flags = screenForSensitiveContent(`connect("${fake}")`);
    expect(flags.some(f => f.kind === 'postgres-connection-string')).toBe(true);
  });

  it('flags a Slack token', () => {
    // Synthetic placeholder; constructed so the literal in source
    // doesn't match GitHub's secret-scanning fingerprints.
    const fake = 'xoxb-' + 'PLACEHOLDER-NOT-A-REAL-TOKEN-XYZ'.padEnd(35, 'X');
    const flags = screenForSensitiveContent(`SLACK_TOKEN=${fake}`);
    expect(flags.some(f => f.kind === 'slack-token')).toBe(true);
  });
});

describe('screenForSensitiveContent — medium severity (financial)', () => {
  it('flags a Luhn-valid credit card', () => {
    // 4242 4242 4242 4242 is the canonical Stripe test card; Luhn-valid.
    const flags = screenForSensitiveContent('charge card 4242 4242 4242 4242 today');
    expect(flags.some(f => f.kind === 'credit-card')).toBe(true);
  });

  it('does NOT flag a Luhn-invalid 16-digit number', () => {
    const flags = screenForSensitiveContent('order # 1111 1111 1111 1111');
    expect(flags.some(f => f.kind === 'credit-card')).toBe(false);
  });

  it('flags a US SSN', () => {
    const flags = screenForSensitiveContent('SSN: 123-45-6789');
    expect(flags.some(f => f.kind === 'ssn-us')).toBe(true);
  });
});

describe('screenForSensitiveContent — low severity (PII)', () => {
  it('flags an email', () => {
    const flags = screenForSensitiveContent('contact me at alice@example.com');
    const email = flags.find(f => f.kind === 'email');
    expect(email).toBeDefined();
    expect(email!.severity).toBe('low');
  });

  it('flags a US phone number', () => {
    const flags = screenForSensitiveContent('call (555) 123-4567 anytime');
    expect(flags.some(f => f.kind === 'phone-number')).toBe(true);
  });

  it('flags an IPv4 address', () => {
    const flags = screenForSensitiveContent('connect to 192.168.1.1');
    expect(flags.some(f => f.kind === 'ipv4')).toBe(true);
  });
});

describe('screenForSensitiveContent — redaction + dedup', () => {
  it('redacts long matches preserving prefix and suffix', () => {
    const flags = screenForSensitiveContent(FAKE.anthropic);
    const f = flags.find(x => x.kind === 'api-key-anthropic');
    expect(f).toBeDefined();
    expect(f!.redacted).toMatch(/^sk-a/);
    expect(f!.redacted).toContain('…');
  });

  it('does not return overlapping flags for the same region', () => {
    // A JWT also matches generic api-key-generic if labeled "token";
    // dedup should keep the higher-severity one.
    const flags = screenForSensitiveContent(
      'token: eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NSJ9.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c',
    );
    // Should NOT see two flags for the same region.
    const positions = flags.map(f => f.position);
    const uniquePositions = new Set(positions);
    expect(positions.length).toBe(uniquePositions.size);
  });

  it('returns empty array for clean content', () => {
    expect(screenForSensitiveContent('this is a normal sentence about the weather')).toEqual([]);
  });

  it('returns empty array for empty string', () => {
    expect(screenForSensitiveContent('')).toEqual([]);
  });
});

describe('formatSensitivityWarning + shouldBlockOnSensitivity', () => {
  it('returns empty warning for no flags', () => {
    expect(formatSensitivityWarning([])).toBe('');
  });

  it('groups warning by severity tier', () => {
    const flags = screenForSensitiveContent(`alice@x.com ${FAKE.anthropic}`);
    const warning = formatSensitivityWarning(flags);
    expect(warning).toContain('HIGH-severity');
    expect(warning).toContain('LOW-severity');
    expect(warning).toContain('STOP and confirm');
  });

  it('shouldBlockOnSensitivity is true if any high-severity flag', () => {
    const flags = screenForSensitiveContent(FAKE.anthropic);
    expect(shouldBlockOnSensitivity(flags)).toBe(true);
  });

  it('shouldBlockOnSensitivity is false for only PII', () => {
    const flags = screenForSensitiveContent('email me at alice@example.com');
    expect(shouldBlockOnSensitivity(flags)).toBe(false);
  });
});
