/**
 * @module privacy
 * @description Pre-publish content screening — flags obvious red flags
 *   (API keys, credit cards, JWTs, private keys, etc.) so the calling
 *   agent can surface a confirmation before persisting to a federated
 *   pod that outlives the session.
 *
 *   This is a HEURISTIC — fast, false-positive-tolerant, safe to run
 *   on every publish. Not a full DLP system. The point is to catch
 *   accidents (a stray secret pasted into a memory descriptor),
 *   not to defeat a determined adversary.
 *
 *   Returns flagged matches with location + a suggested action. The
 *   caller (MCP tool) decides whether to: warn-and-proceed, block,
 *   prompt the user, or strip the match before publishing.
 */

export type SensitivityKind =
  | 'api-key-anthropic'
  | 'api-key-openai'
  | 'api-key-aws'
  | 'aws-secret-access-key'
  | 'api-key-github'
  | 'api-key-stripe'
  | 'api-key-gcp'
  | 'azure-sas-token'
  | 'slack-token'
  | 'oauth-refresh-google'
  | 'postgres-connection-string'
  | 'api-key-generic'
  | 'jwt'
  | 'private-key-pem'
  | 'ssh-private-key'
  | 'credit-card'
  | 'ssn-us'
  | 'iban'
  | 'email'
  | 'phone-number'
  | 'ipv4';

export interface SensitivityFlag {
  readonly kind: SensitivityKind;
  readonly description: string;
  /** Index into the input string where the match starts. */
  readonly position: number;
  /** Length of the matched substring. */
  readonly length: number;
  /** A redacted version of the match (first/last few chars + middle redacted). */
  readonly redacted: string;
  /** Severity: high → block by default; medium → confirm; low → warn. */
  readonly severity: 'high' | 'medium' | 'low';
}

interface Detector {
  kind: SensitivityKind;
  description: string;
  pattern: RegExp;
  severity: 'high' | 'medium' | 'low';
}

const DETECTORS: readonly Detector[] = [
  // ── High-severity API keys + secrets ──
  {
    kind: 'api-key-anthropic',
    description: 'Anthropic API key (sk-ant-…)',
    pattern: /sk-ant-[A-Za-z0-9_-]{20,}/g,
    severity: 'high',
  },
  {
    kind: 'api-key-openai',
    description: 'OpenAI API key (sk-…)',
    pattern: /\bsk-[A-Za-z0-9]{20,}\b/g,
    severity: 'high',
  },
  {
    kind: 'api-key-aws',
    description: 'AWS access key (AKIA… / ASIA…)',
    pattern: /\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/g,
    severity: 'high',
  },
  {
    kind: 'aws-secret-access-key',
    description: 'AWS secret access key (40-char base64-ish near "aws_secret")',
    pattern: /aws[_-]?secret[_-]?access[_-]?key["\s:=]+([A-Za-z0-9/+=]{40})/gi,
    severity: 'high',
  },
  {
    kind: 'api-key-github',
    description: 'GitHub personal access token (ghp_/gho_/ghu_/ghs_/ghr_)',
    pattern: /\bgh[poushr]_[A-Za-z0-9]{30,}\b/g,
    severity: 'high',
  },
  {
    kind: 'api-key-stripe',
    description: 'Stripe API key (sk_live_… / sk_test_…)',
    pattern: /\bsk_(live|test)_[A-Za-z0-9]{20,}\b/g,
    severity: 'high',
  },
  {
    kind: 'api-key-gcp',
    description: 'Google Cloud / Firebase API key (AIza…)',
    // Google API keys: literal "AIza" + 35-40 base64url chars (real-world
    // tokens cluster at 35 but tests + variations seen up to 40).
    pattern: /\bAIza[A-Za-z0-9_-]{30,45}\b/g,
    severity: 'high',
  },
  {
    kind: 'azure-sas-token',
    description: 'Azure SAS token (sv=YYYY-MM-DD…&sig=…)',
    // The signature parameter is the load-bearing secret in an Azure SAS URL.
    // Match the full sig=...  segment with base64-url body.
    pattern: /\bsv=20\d{2}-\d{2}-\d{2}[^"\s&]*&[^"\s]*sig=[A-Za-z0-9%/+=_-]{20,}/g,
    severity: 'high',
  },
  {
    kind: 'slack-token',
    description: 'Slack token (xoxb-/xoxp-/xoxa-/xoxr-/xoxs-…)',
    pattern: /\bxox[bpaors]-[A-Za-z0-9-]{10,}\b/g,
    severity: 'high',
  },
  {
    kind: 'oauth-refresh-google',
    description: 'Google OAuth refresh / access token (ya29…, 1//…)',
    // Two common Google OAuth shapes — short-lived (ya29.) and refresh (1//).
    // Lengths vary by issuance source; the load-bearing signal is the
    // distinctive prefix, so we require only ≥20 chars of payload.
    pattern: /\b(?:ya29\.[A-Za-z0-9_-]{20,}|1\/\/[A-Za-z0-9_-]{20,})\b/g,
    severity: 'high',
  },
  {
    kind: 'jwt',
    description: 'JWT (three base64-url segments)',
    pattern: /\beyJ[A-Za-z0-9_-]+\.eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/g,
    severity: 'high',
  },
  {
    kind: 'private-key-pem',
    description: 'PEM private key block',
    pattern: /-----BEGIN (?:RSA |EC |OPENSSH |PGP |DSA |ENCRYPTED )?PRIVATE KEY-----[\s\S]+?-----END/g,
    severity: 'high',
  },
  {
    kind: 'ssh-private-key',
    description: 'SSH private key (OPENSSH format)',
    pattern: /-----BEGIN OPENSSH PRIVATE KEY-----[\s\S]+?-----END OPENSSH PRIVATE KEY-----/g,
    severity: 'high',
  },
  {
    kind: 'postgres-connection-string',
    description: 'DB connection URI with embedded credentials (postgres / mysql / mongodb / redis)',
    pattern: /\b(?:postgres|postgresql|mysql|mongodb|redis)(?:\+[a-z]+)?:\/\/[^:\s]+:[^@\s]+@[^/\s]+/gi,
    severity: 'high',
  },
  // ── Medium severity: financial identifiers (legitimate use is common
  // but exposure in shared contexts often warrants surfacing) ──
  {
    kind: 'iban',
    description: 'International Bank Account Number (IBAN)',
    pattern: /\b[A-Z]{2}\d{2}[A-Z0-9]{4,30}\b/g,
    severity: 'medium',
  },
  // ── Medium severity: financial PII ──
  {
    kind: 'credit-card',
    description: 'Credit card number (Luhn-valid 13-19 digits)',
    // Loose pattern; severity comes from contextual confirmation.
    pattern: /\b(?:\d[ -]*?){13,19}\b/g,
    severity: 'medium',
  },
  {
    kind: 'ssn-us',
    description: 'US Social Security Number (XXX-XX-XXXX)',
    pattern: /\b\d{3}-\d{2}-\d{4}\b/g,
    severity: 'medium',
  },
  // ── Low severity: general PII (often legitimate, surface for user awareness) ──
  {
    kind: 'email',
    description: 'Email address',
    pattern: /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g,
    severity: 'low',
  },
  {
    kind: 'phone-number',
    description: 'Phone number (international or NANP)',
    pattern: /(?<!\d)(?:\+?\d{1,3}[ -]?)?\(?\d{3}\)?[ -]?\d{3}[ -]?\d{4}(?!\d)/g,
    severity: 'low',
  },
  {
    kind: 'ipv4',
    description: 'IPv4 address',
    pattern: /\b(?:\d{1,3}\.){3}\d{1,3}\b/g,
    severity: 'low',
  },
  // ── Generic API-key heuristic (last; lowest priority) ──
  {
    kind: 'api-key-generic',
    description: 'Generic high-entropy token labeled api/key/secret/token',
    pattern: /\b(?:api[_-]?key|secret|token|password|passwd)["\s:=]+["']?([A-Za-z0-9_\-+/=]{16,})/gi,
    severity: 'medium',
  },
];

/** Produce a redacted form of a sensitive match: keep first 4 + last 4
 *  characters, hide the rest. Short matches collapse to all dots. */
function redact(match: string): string {
  if (match.length <= 12) return '*'.repeat(match.length);
  return `${match.slice(0, 4)}…${'*'.repeat(Math.max(0, match.length - 8))}…${match.slice(-4)}`;
}

/** Luhn check for credit-card-shaped numbers; reduces false positives. */
function luhnValid(digits: string): boolean {
  const onlyDigits = digits.replace(/\D/g, '');
  if (onlyDigits.length < 13 || onlyDigits.length > 19) return false;
  let sum = 0;
  let alt = false;
  for (let i = onlyDigits.length - 1; i >= 0; i--) {
    let d = parseInt(onlyDigits[i]!, 10);
    if (alt) {
      d *= 2;
      if (d > 9) d -= 9;
    }
    sum += d;
    alt = !alt;
  }
  return sum % 10 === 0;
}

/**
 * Screen a string for sensitive content. Returns flagged matches.
 * Empty array means "no obvious red flags" — does NOT mean "safe."
 */
export function screenForSensitiveContent(content: string): readonly SensitivityFlag[] {
  if (!content) return [];
  const flags: SensitivityFlag[] = [];

  for (const detector of DETECTORS) {
    // Reset regex state for global patterns.
    const pattern = new RegExp(detector.pattern.source, detector.pattern.flags);
    let m: RegExpExecArray | null;
    while ((m = pattern.exec(content)) !== null) {
      const match = m[0];

      // Per-detector secondary validation.
      if (detector.kind === 'credit-card' && !luhnValid(match)) continue;

      flags.push({
        kind: detector.kind,
        description: detector.description,
        position: m.index,
        length: match.length,
        redacted: redact(match),
        severity: detector.severity,
      });
    }
  }

  // Deduplicate overlapping matches: keep the highest-severity one
  // per region. We sort by SEVERITY first (high → medium → low) so
  // specific high-severity detectors (e.g. api-key-gcp) take priority
  // over the generic medium-severity api-key-generic when both match
  // the same region. Within a severity tier, sort by position so the
  // emitted flag list stays left-to-right for readability.
  flags.sort((a, b) =>
    severityRank(b.severity) - severityRank(a.severity)
    || a.position - b.position
  );
  const deduped: SensitivityFlag[] = [];
  for (const flag of flags) {
    const overlapsWithPrior = deduped.some(d =>
      flag.position < d.position + d.length &&
      d.position < flag.position + flag.length
    );
    if (!overlapsWithPrior) {
      deduped.push(flag);
    }
  }
  // Final pass: sort the kept flags by position so caller sees them
  // in source order (independent of severity-based dedup ordering).
  deduped.sort((a, b) => a.position - b.position);
  return deduped;
}

function severityRank(s: 'high' | 'medium' | 'low'): number {
  return s === 'high' ? 3 : s === 'medium' ? 2 : 1;
}

/**
 * Format a list of flags as a human-readable warning suitable for
 * appending to an MCP tool response. Returns empty string if no flags.
 */
export function formatSensitivityWarning(flags: readonly SensitivityFlag[]): string {
  if (flags.length === 0) return '';
  const high = flags.filter(f => f.severity === 'high');
  const medium = flags.filter(f => f.severity === 'medium');
  const low = flags.filter(f => f.severity === 'low');
  const lines: string[] = ['', '⚠ Privacy-hygiene preflight:'];
  if (high.length > 0) {
    lines.push(`  ${high.length} HIGH-severity match(es) — secrets/credentials likely:`);
    for (const f of high) lines.push(`    • ${f.description}: ${f.redacted}`);
  }
  if (medium.length > 0) {
    lines.push(`  ${medium.length} MEDIUM-severity match(es):`);
    for (const f of medium) lines.push(`    • ${f.description}: ${f.redacted}`);
  }
  if (low.length > 0) {
    lines.push(`  ${low.length} LOW-severity match(es) (PII, often legitimate):`);
    for (const f of low) lines.push(`    • ${f.description}: ${f.redacted}`);
  }
  if (high.length > 0) {
    lines.push('  Recommendation: STOP and confirm with the user before proceeding.');
  } else if (medium.length > 0) {
    lines.push('  Recommendation: confirm with the user before publishing.');
  } else {
    lines.push('  Recommendation: surface to user; PII may still be intentional.');
  }
  return lines.join('\n');
}

/**
 * Convenience: should an agent BLOCK by default before user confirmation?
 * True if any high-severity flag is present.
 */
export function shouldBlockOnSensitivity(flags: readonly SensitivityFlag[]): boolean {
  return flags.some(f => f.severity === 'high');
}
