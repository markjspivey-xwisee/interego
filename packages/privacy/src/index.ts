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
    /**
     * ★★ THE SAME HEX-COLLISION CLASS AS THE PHONE RULE BELOW, FOUND BY GOING LOOKING FOR IT.
     * `[A-Z]` is satisfied by A-F, so an UPPERCASE hex token simply IS an IBAN-shaped token:
     * measured over 100k random samples per length, uppercase hex of 8-34 characters matched
     * 5.4-5.6% of the time — a higher rate than the phone rule's, at MEDIUM severity, which is the
     * tier that tells the user to "confirm before publishing".
     *
     * ★ AND IT ALREADY HAD A LIVE FALSE POSITIVE THAT IS NOT HEX AT ALL. Over the git-tracked tree
     * — 2,664 text files, this one and tests/privacy.test.ts excluded because both now carry
     * specimens of their own — this detector matches exactly four distinct strings: `PT22M14S`,
     * `PT12M30S` and `PT15M30S`, ISO 8601 DURATIONS of the kind xAPI writes into `result.duration`
     * and this substrate emits by the statement, plus `VA75713W`, a fragment of a sha512 integrity
     * hash in package-lock.json. `PT` + `22` + `M14S` walks straight through
     * `[A-Z]{2}\d{2}[A-Z0-9]{4,30}`. Not one is an account number, so every single flag this rule
     * has ever raised here was wrong. (An earlier version of this sentence said the durations were
     * the ONLY match, "across 3892 files". Both halves were wrong — `VA75713W` is tracked and is
     * not a duration, and the file count described one working tree, ignored directories included,
     * rather than the repo. Quote a corpus a reader can reproduce: `git ls-files`.)
     *
     * ★ THE MISSING CONSTRAINT IS THE ONE A BANK ACCOUNT ACTUALLY HAS, exactly as the ISO/IEC 7812
     * industry identifier was for the card rule: an IBAN carries an ISO 7064 MOD-97-10 check, and
     * ISO 13616 fixes a per-country length starting at 15 (Norway). See `ibanCheckValid`. Both
     * halves are needed and neither subsumes the other: a duration is 8 characters and dies on the
     * length bound, while a hex token long enough to clear that bound dies on mod-97 96 times in
     * 97. `ibanCheckValid` carries the measurement of what each half actually rejects.
     *
     * The pattern stays loose on purpose — it is the cheap prefilter, and the arithmetic below is
     * what decides, the same division of labour the credit-card rule uses.
     */
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
    /**
     * ★★ THE COUNTRY-CODE GROUP HAD NO REQUIRED PUNCTUATION, so it silently absorbed three extra
     * BARE digits and the pattern spanned a full 13-digit run — matching every epoch-millisecond
     * timestamp at 100%, not the ~10% the credit-card rule caught. Both fired on the same value;
     * only overlap-dedup by severity hid this one, which is why a live agent saw its own step id
     * called a credit card one turn and a phone number the next.
     *
     * A leading country code is written `+1` or `1-`, never as three digits jammed against the
     * number. Requiring either the `+` or a separator keeps every real spelling and drops the run.
     *
     * ★★ AND THEN THE BOUNDARY GUARDS TURNED OUT TO KNOW ONLY BASE TEN, WHICH IS THE WRONG RADIX
     * ON A CONTENT-ADDRESSED SUBSTRATE. `(?<!\d)` and `(?!\d)` exist to say "this run of digits is
     * not a slice of a longer number" — but inside a hex identifier the letters a-f ARE digits of
     * that number, and they satisfied a base-10 guard, so any ten-digit window inside a hash was
     * accepted as a phone number. MEASURED here over 200k random samples each: a 40-hex CID flagged
     * 4.35% of the time, a 64-hex sha256 7.18%, a v4-shaped UUID 1.27%. Per artifact that is small,
     * but it compounds — a graph carrying ~20 digests is odds-on to raise at least one spurious
     * phone flag, so the screen ends up crying wolf on the substrate's own identifiers. Over the
     * git-tracked tree (2,664 text files, this one and tests/privacy.test.ts excluded) the old
     * pattern raises 59 raw matches and the guarded one 10; the 49 it drops are ten-digit windows
     * inside pod ids (`u-eth-0123456789ab`) and Ethereum addresses. That they are all hex is not a
     * corpus accident: the guard alphabet is the ONLY difference between the two patterns, so
     * anything dropped is by construction a run bounded by a hex letter.
     *
     * ★ THE GUARD IS WIDENED FROM RADIX 10 TO RADIX 16, NOT SUPPLEMENTED WITH A CARVE-OUT FOR
     * HASHES. `[0-9A-Fa-f]` is a strict superset of `\d`, so everything the old guard rejected is
     * still rejected and the rule is still a property of the thing being detected: a telephone
     * number is a token in its own right, never welded to the inside of a longer identifier. Hex is
     * the only common identifier encoding dense enough in digits for this to bite — 10 of its 16
     * symbols are digits, against 9 of base58's 58 and 6 of base32's 32, where the arithmetic puts
     * the same ten-digit window below 1e-7 per position and nothing shows up in practice.
     *
     * ★ THE THING NOT TO DO HERE IS QUIETEN IT FURTHER. A privacy screen trimmed until it stops
     * being annoying is worse than a noisy one, because a screen nobody believes is not a screen.
     * So every spelling this caught before still has to be caught, and tests/privacy.test.ts pins
     * them: `+1 415 555 2671`, `(415) 555-2671`, `415-555-2671`, `415 555 2671`, `4155552671`,
     * `1-415-555-2671`. Real numbers are bounded by whitespace or punctuation, so the guard costs
     * none of them. (`415.555.2671` is a real spelling this detector has never matched — the
     * separator class is `[ -]`, with no `.` — and it still does not; see the pinned gap in the
     * test file. That is a pre-existing miss, not something this guard took away.)
     *
     * ★ AND 16 IS PINNED, NOT JUST ARGUED. The paragraph above is a reason, and a reason holds
     * nothing on its own: widening one notch further to `[0-9A-Za-z]` used to leave the whole
     * suite green, because on this repo's own content base 36 is QUIETER — the extra strings it
     * suppresses here are all false positives. What it also suppresses is `x4155552671` and
     * `ext4155552671`, the telephone-extension notation, which is why the test named "THE RADIX
     * IS 16 AND NOT 36" exists. Do not delete it to make a further tightening pass.
     */
    pattern: /(?<![0-9A-Fa-f])(?:\+\d{1,3}[ -]?|\d{1,3}[ -])?\(?\d{3}\)?[ -]?\d{3}[ -]?\d{4}(?![0-9A-Fa-f])/g,
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
 * ISO 7064 MOD-97-10 check for an IBAN candidate — the analogue of `luhnValid`
 * above, and for the same reason: the regex is a cheap prefilter and something
 * has to carry a real property of the thing being detected.
 *
 * ★ THE MINIMUM LENGTH IS LOAD-BEARING, AND A MUTANT IS WHAT PROVED IT — the first
 * version of this comment claimed the wrong reason. The shortest national IBAN
 * format is Norway's, at 15 characters. Deleting that line left the whole suite
 * GREEN, because the durations the test then asserted on fail mod-97 anyway
 * (`PT14M22S` → 62, `PT22M14S` → 4, `PT12M30S` → 29, `PT15M30S` → 32), so the test
 * that was meant to pin the bound passed for a reason that had nothing to do with
 * it.
 *
 * The bound matters all the same, because mod-97 accepts 1 candidate in 97 by
 * construction: of the 6,000 two-digit `PT<mm>M<ss>S` durations with `ss` in 00-59,
 * 63 satisfy it — `PT00M31S`, `PT01M25S`, `PT14M44S` — as do 896 of the 86,400
 * `PT<hh>H<mm>M<ss>S` clock durations. Every one of those is rejected by the length
 * bound and by nothing else, so without it roughly one xAPI `result.duration` in a
 * hundred is reported to the user as a bank account. tests/privacy.test.ts pins
 * `PT00M31S` specifically for this.
 *
 * ★ THERE IS NO UPPER BOUND HERE, AND THAT IS THE CORRECTION OF A DEAD ONE. This
 * used to also reject `candidate.length > 34` — ISO 13616's ceiling — and no input
 * could ever reach it: the only caller passes a match of `\b[A-Z]{2}\d{2}[A-Z0-9]
 * {4,30}\b`, which emits at most 2 + 2 + 30 = 34 characters (measured: max match
 * length 34 over 200k random uppercase-alphanumeric tokens up to 75 characters).
 * Mutating it to `> 40` left the suite green because nothing could exercise it,
 * while the comment beside it read as though both ends of the bound were live.
 * ★ SO THE CEILING NOW LIVES ONLY IN THAT `{4,30}` QUANTIFIER: widening it past 30
 * must bring the 34 back here, or over-long candidates start reaching the modulo.
 * (34 is the standard's ceiling, incidentally, not any country's length — the
 * registry specimens pinned in tests/privacy.test.ts run 15 to 27 — so do not read
 * it as naming a country.)
 *
 * The `value` range check inside the loop is NOT dead in the same way and stays: it
 * guards the ARITHMETIC rather than restating a domain fact, since one non-alphanumeric
 * character would fold a garbage digit into the remainder and could make mod-97 accept.
 *
 * The remainder is accumulated digit-by-digit because the rearranged string is
 * up to 34 characters wide, which as an integer overflows a JS number long
 * before the modulo would be reached.
 */
function ibanCheckValid(candidate: string): boolean {
  if (candidate.length < 15) return false;
  // Move the country code + check digits to the end, then map A-Z to 10-35.
  const rearranged = candidate.slice(4) + candidate.slice(0, 4);
  let remainder = 0;
  for (const ch of rearranged) {
    const code = ch.charCodeAt(0);
    // 'A'-'Z' → 10-35 (two decimal places), '0'-'9' → 0-9 (one).
    const value = code >= 65 && code <= 90 ? code - 55 : code - 48;
    if (value < 0 || value > 35) return false;
    remainder = (remainder * (value > 9 ? 100 : 10) + value) % 97;
  }
  return remainder === 1;
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
      /**
       * ── ★★ AN EPOCH-MILLISECOND TIMESTAMP IS NOT A PAYMENT CARD, AND LUHN DOES NOT SAVE US ──
       *
       * MEASURED, live, every turn for days: an agent's own identifiers end in a 13-digit
       * millisecond timestamp — `urn:iep:trajectory-step:<agent>:1787195991824` — and that value
       * is GENUINELY Luhn-valid, as roughly one epoch-ms in ten is. So the check that exists to
       * stop exactly this kind of false positive waved it straight through, and the agent was told
       * its own generated id was somebody's credit card. It reported it four times before anyone
       * looked.
       *
       * ★ THE MISSING CONSTRAINT IS THE ONE THING A CARD NUMBER ACTUALLY HAS AND A TIMESTAMP DOES
       * NOT: an ISO/IEC 7812 major industry identifier. Every issued PAN starts 2-6 (Visa 4,
       * Mastercard 2/5, Amex 3, Discover 6). Epoch milliseconds have started with 1 since 2001 and
       * will until 2033. One digit of context, and it is a real property of the thing being
       * detected rather than a carve-out for the thing that annoyed us.
       */
      if (detector.kind === 'credit-card' && !/^[2-6]/.test(match.replace(/\D/g, ''))) continue;
      /**
       * ── ★★ AN xAPI DURATION IS NOT A BANK ACCOUNT ──
       *
       * The IBAN pattern's `[A-Z]{2}\d{2}` prefix is satisfied by `PT22M…`, and over the
       * git-tracked tree ISO 8601 durations are all but one of what it matches — at medium
       * severity, the tier whose advice is "confirm with the user before publishing". Same class as
       * the hex-run phone false positive: a guard keyed on a character class the substrate's own
       * vocabulary happens to satisfy. `ibanCheckValid` supplies the ISO 7064 check digit and the
       * minimum length, which is what an account number has and a duration does not. The detector
       * comment above carries the full corpus measurement and the one non-duration match.
       */
      if (detector.kind === 'iban' && !ibanCheckValid(match)) continue;

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
