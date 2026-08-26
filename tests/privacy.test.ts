/**
 * Privacy-hygiene tests — screenForSensitiveContent.
 */

import { describe, it, expect } from 'vitest';
import {
  formatSensitivityWarning,
  screenForSensitiveContent,
  shouldBlockOnSensitivity,
} from '@interego/privacy';

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

/**
 * ── ★★ AN AGENT'S OWN IDENTIFIER IS NOT THE USER'S PAYMENT CARD ─────────────────────────────
 *
 * MEASURED, live, on four consecutive turns: every trajectory-step id this substrate mints ends in
 * a 13-digit epoch-millisecond timestamp — `urn:iep:trajectory-step:<agent>:1787195991824` — and
 * BOTH numeric detectors matched it. The agent reported being told its own generated id was a
 * credit card, then a phone number; same value, different rule, because overlap-dedup keeps
 * whichever severity is higher.
 *
 * ★ THE LUHN CHECK DID NOT SAVE US, which is the part worth remembering. 1787195991824 is
 * genuinely Luhn-valid, as roughly one epoch-ms in ten is — so the guard that exists to stop this
 * exact false positive waved it straight through, and looked like it was working.
 *
 * Both fixes add a REAL property of the thing being detected rather than a carve-out for the thing
 * that annoyed us: a payment card carries an ISO/IEC 7812 major industry identifier (2-6; epoch
 * milliseconds have begun with 1 since 2001), and a written country code carries a `+` or a
 * separator rather than three digits jammed against the number.
 */
describe('★ a 13-digit timestamp is neither a card nor a phone number', () => {
  const STEP_ID = 'urn:iep:trajectory-step:interego-delegate-u-eth-03f52e15b9df:1787195991824';

  it('the real, Luhn-VALID step id flags nothing', () => {
    expect(screenForSensitiveContent(STEP_ID).map((f) => f.kind)).toEqual([]);
  });

  it('and so does a Luhn-invalid neighbour — the phone rule caught those too', () => {
    expect(screenForSensitiveContent('urn:iep:trajectory-step:x:1787195991825')
      .map((f) => f.kind)).toEqual([]);
  });

  it('★ a bare 13-digit run is still not a phone number, whatever its Luhn value', () => {
    // The country-code group used to be `(?:\+?\d{1,3}[ -]?)?` — no required `+`, no required
    // separator — so it absorbed three extra bare digits and spanned the whole run at 100%.
    for (const ms of ['1787195991824', '1787195991825', '1600000000000']) {
      expect(screenForSensitiveContent(`id:${ms}`).map((f) => f.kind), ms).toEqual([]);
    }
  });
});

describe('★ and the real things are still detected — a quieter detector that misses is worse', () => {
  it('genuine payment cards, across issuers', () => {
    for (const pan of ['4111 1111 1111 1111', '5555555555554444', '378282246310005']) {
      expect(screenForSensitiveContent(`card ${pan} on file`).map((f) => f.kind), pan)
        .toContain('credit-card');
    }
  });

  it('genuine phone numbers, across spellings', () => {
    for (const p of ['(415) 555-2671', '415-555-2671', '4155552671', '+1 415 555 2671', '1-415-555-2671']) {
      expect(screenForSensitiveContent(`call me on ${p}`).map((f) => f.kind), p)
        .toContain('phone-number');
    }
  });
});

/**
 * ── ★★ A HASH IS NOT A PHONE NUMBER, AND THE GUARD THAT SHOULD HAVE SAID SO KNEW ONLY BASE TEN ──
 *
 * The phone pattern's boundary guards were `(?<!\d)` / `(?!\d)`, which exist to say "this run of
 * digits is not a slice of a longer number". Inside a hex identifier the letters a-f ARE digits of
 * that number, so they satisfied a base-10 guard and any ten-digit window inside a digest matched.
 *
 * MEASURED over 200k random samples each, against the pattern as it shipped: a 40-hex CID flagged
 * 4.35% of the time, a 64-hex sha256 7.18%, a v4-shaped UUID 1.27%. Compounded over a graph
 * carrying ~20 digests that is odds-on to raise at least one spurious flag — a screening tool
 * crying wolf on the identifiers of the content-addressed substrate it screens.
 *
 * ★ THE POSITIVE CASES ABOVE AND BELOW ARE THE POINT OF THIS BLOCK, NOT THE NEGATIVES. A privacy
 * screen quietly narrowed until it stops being annoying is worse than a noisy one, so the fix is
 * only admissible if every spelling the detector caught before is still caught. The guard widens
 * from radix 10 to radix 16 — `[0-9A-Fa-f]` is a strict superset of `\d` — which is a property of
 * the thing being detected (a phone number is a whole token, never welded inside a longer
 * identifier) rather than a carve-out for the hashes that were annoying us.
 */
describe('★ a digest is not a phone number — the boundary guard has to know base 16', () => {
  // Real values: an IPFS-style 40-hex CID, a sha256, an Ethereum address and a UUID, each one
  // chosen because the OLD pattern demonstrably matched a ten-digit window inside it.
  const HEX_IDENTIFIERS = [
    '6bcfe8993512884fcaa77013ecee77dce2d4fe18',
    '0eb2bb51c100f3e4024e1b1c9c080160f6b4664e7a17c5213088735c75bca13e',
    '56635317f2fc2670d46cdb41404b3e2199246907',
    '0x2c3ec2978973680f890c0609c6a8c4c1b7a4e0d1',
    '8c863812-4916-5e2b-58a6-772ccf22cf2f',
    'u-eth-0123456789ab',
  ];

  it('no hex identifier raises a phone flag, bare or in a Turtle literal', () => {
    for (const id of HEX_IDENTIFIERS) {
      expect(screenForSensitiveContent(id).map((f) => f.kind), id).not.toContain('phone-number');
      expect(
        screenForSensitiveContent(`<urn:x> iep:digest "${id}" .`).map((f) => f.kind),
        `turtle ${id}`,
      ).not.toContain('phone-number');
    }
  });

  it('★ and the uppercase spelling too — the guard covers A-F, not just a-f', () => {
    // `0x…` addresses arrive EIP-55 mixed-case and digests are sometimes printed uppercase, so a
    // guard written `[0-9a-f]` would have passed the test above and still flagged half the fleet.
    for (const id of HEX_IDENTIFIERS) {
      // `0x` is a literal prefix, not a hex digit pair, so it is put back lowercase after the
      // uppercasing — the guard's alphabet is what is under test, not the prefix's casing.
      const upper = id.toUpperCase().replace(/^0X/, '0x');
      expect(screenForSensitiveContent(upper).map((f) => f.kind), upper).not.toContain('phone-number');
    }
  });

  it('★ a ten-digit run welded to a hex token stays suppressed from either side', () => {
    // The window can sit at the head, the tail or the middle of the token; each position is a
    // different one of the two guards doing the work, so a fix that widened only one would pass
    // two of these three and fail the other.
    expect(screenForSensitiveContent('e4155552671').map((f) => f.kind)).not.toContain('phone-number');
    expect(screenForSensitiveContent('4155552671e').map((f) => f.kind)).not.toContain('phone-number');
    expect(screenForSensitiveContent('ab4155552671cd').map((f) => f.kind)).not.toContain('phone-number');
  });

  it('★ every spelling the detector caught before is still caught — bounded by punctuation', () => {
    // Whitespace, parentheses, colons and quotes are all outside [0-9A-Fa-f], which is exactly why
    // the guard costs no real number: a written phone number is delimited, an embedded run is not.
    const SPELLINGS = [
      '+1 415 555 2671',      // international, spaced
      '+1 (415) 555-2671',    // international + parenthesised area code
      '(415) 555-2671',       // parenthesised, dash
      '(415)555-2671',        // parenthesised, no space
      '415-555-2671',         // dash separators
      '415 555 2671',         // space separators
      '4155552671',           // bare NANP
      '1-415-555-2671',       // national trunk prefix
    ];
    for (const p of SPELLINGS) {
      expect(screenForSensitiveContent(`call me on ${p}.`).map((f) => f.kind), `prose: ${p}`)
        .toContain('phone-number');
      expect(screenForSensitiveContent(`"tel":"${p}"`).map((f) => f.kind), `json: ${p}`)
        .toContain('phone-number');
    }
  });

  it('★ THE RADIX IS 16 AND NOT 36 — a number welded to a NON-hex letter is still caught', () => {
    /**
     * ★★ WITHOUT THIS THE CHOSEN RADIX IS UNPINNED, AND THE PARAGRAPH DEFENDING IT IN
     * packages/privacy/src/index.ts IS ARGUING FOR SOMETHING NO TEST HOLDS. Widening the guard
     * one notch further — `[0-9A-Fa-f]` → `[0-9A-Za-z]`, i.e. base 36 — left every other
     * assertion in this file green, because on this repo's own content the over-tightened guard
     * is QUIETER: over the git-tracked tree it removes 2 further matches — `2130706433` (an IPv4
     * as an integer), `1234567890` and `0000000000` — and every one of them is a false positive.
     * A tightening that looks like an improvement on the corpus you happen to have is exactly the
     * kind that sails through a green suite, so the cases below are the ones that do not appear
     * in the corpus and do appear in the world.
     *
     * `x` and `ext` are the telephone-extension notation; `g`/`z` stand for every other letter
     * outside a-f. Each is caught today and each is suppressed by the base-36 guard. Widening
     * past 16 means deciding that a phone number adjacent to a letter is not a phone number,
     * which is a different claim from "a hex digit is a digit" — make it deliberately, here.
     */
    for (const s of ['x4155552671', 'ext4155552671', 'Tel4155552671', 'call4155552671now', '4155552671x', 'g4155552671', '4155552671z']) {
      expect(screenForSensitiveContent(s).map((f) => f.kind), s).toContain('phone-number');
    }
  });

  it('★ KNOWN GAP, pinned so it is not misattributed: the dot spelling never matched', () => {
    // `415.555.2671` is a real spelling, and this detector has NEVER caught it — the separator
    // class is `[ -]`, with no `.`, and that predates the hex guard. It is pinned here only so a
    // later reader does not blame the radix-16 boundary for a miss it did not cause. THIS IS NOT A
    // REQUIREMENT: if you widen the separator class to `[ .-]`, delete this expectation rather
    // than working around it.
    //
    // ★★ BUT DO NOT READ THIS AS "THE WIDENING IS SAFE" — AN EARLIER VERSION OF THIS COMMENT SAID
    // SO AND IT WAS WRONG, IN THE WAY THAT MATTERS MOST. It argued from a corpus scan ("adding `.`
    // matched 0 new strings across 3892 files") to a property of the pattern, and a corpus scan
    // cannot carry that argument: it reports what one working tree happened to contain, and the
    // tree it was run over included ignored directories no clone has. With `.` in both separator
    // classes the pattern matches DECIMAL NUMBER PAIRS, which is a fact about the regex and needs
    // no corpus at all — `matrix(395.856 1030` and `366.023 1052` both match, so any SVG path or
    // transform attribute becomes a low-severity phone flag. (Real dotted quads stay safe: a valid
    // IPv4 octet is at most 3 digits and the tail here is `\d{4}`.) The widening is still probably
    // worth doing — a written phone number is delimited and these coordinates are not — but it has
    // to come with a separator-position constraint, not with "0 hits on my machine".
    expect(screenForSensitiveContent('call me on 415.555.2671').map((f) => f.kind))
      .not.toContain('phone-number');
  });
});

/**
 * ── ★★ AN xAPI DURATION IS NOT A BANK ACCOUNT — THE SIBLING, FOUND BY GOING LOOKING FOR IT ──
 *
 * The phone bug's shape is "a guard keyed on a character class the substrate's own vocabulary
 * satisfies". Checking the rest of the file for the same shape turned one up immediately: the IBAN
 * pattern `\b[A-Z]{2}\d{2}[A-Z0-9]{4,30}\b` has `[A-Z]` where the phone rule had `\d`, so an
 * UPPERCASE hex token is an IBAN-shaped token — measured at 5.4-5.6% across 100k samples per
 * length, a HIGHER rate than the phone rule's and at MEDIUM severity, whose advice to the user is
 * "confirm before publishing".
 *
 * ★ AND THE LIVE FALSE POSITIVE WAS NOT HEX AT ALL. Over the git-tracked tree — 2,664 text files,
 * this file and packages/privacy/src/index.ts excluded, since both now carry specimens of their
 * own — the prefilter matches exactly four distinct strings: `PT22M14S`, `PT12M30S` and `PT15M30S`,
 * ISO 8601 durations of the kind xAPI writes into `result.duration` and this substrate emits by the
 * statement, plus `VA75713W`, a fragment of a sha512 integrity hash in package-lock.json. Not one
 * is an account number, so every flag the rule had ever raised here was wrong.
 *
 * (An earlier version of this block said the durations were the ONLY thing it ever matched, across
 * "3892 files". Both halves were wrong: `VA75713W` is tracked and is not a duration, and the file
 * count described one working tree including ignored directories rather than the repo. `git
 * ls-files` is the corpus a reader can reproduce, so it is the one quoted here.)
 *
 * The fix follows the Luhn/ISO-7812 precedent already in this file: an ISO 7064 MOD-97-10 check
 * digit plus the ISO 13616 length bound — see `ibanCheckValid` for which half rejects what.
 */
describe('★ the IBAN sibling — same shape, medium severity, and it was firing on our own data', () => {
  it('ISO 8601 durations no longer read as bank accounts', () => {
    for (const d of ['PT14M22S', 'PT22M14S', 'PT12M30S', 'PT15M30S', 'PT1H30M00S']) {
      expect(screenForSensitiveContent(`"duration": "${d}"`).map((f) => f.kind), d)
        .not.toContain('iban');
    }
  });

  it('★ including the 1-in-97 duration that PASSES mod-97 — the length bound is the only thing left', () => {
    /**
     * ★★ THE TEST ABOVE PASSED FOR TWO POSSIBLE REASONS, WHICH MAKES IT EVIDENCE FOR NEITHER.
     * Deleting the ISO 13616 length bound from `ibanCheckValid` left the whole suite green: the
     * four durations this repo actually contains fail mod-97 as well (`PT14M22S` → 62,
     * `PT22M14S` → 4, `PT12M30S` → 29, `PT15M30S` → 32), so the bound was never being exercised.
     * A mutant is what surfaced that; the assertion was rewritten rather than the mutant excused.
     *
     * mod-97 accepts 1 candidate in 97 by construction, so 63 of the 6000 `PT<mm>M<ss>S` durations
     * satisfy it and 896 of the `PT<hh>H<mm>M<ss>S` shape do. Each of these is rejected by the
     * length bound and by nothing else — without it roughly one xAPI `result.duration` in a
     * hundred is reported to the user as a bank account, at medium severity.
     */
    for (const d of ['PT00M31S', 'PT01M25S', 'PT14M44S', 'PT00H00M57S']) {
      expect(screenForSensitiveContent(`"duration": "${d}"`).map((f) => f.kind), d)
        .not.toContain('iban');
    }
  });

  it('★ and a short hex token that passes mod-97 is still not an account number', () => {
    // Same argument as the durations, in the shape the substrate actually emits: uppercase hex
    // ids of 8-14 characters clear the prefilter and 1 in 97 clears mod-97 too.
    for (const h of ['EE85035F', 'DE35E277', 'DC740030D', 'FB90614B2F', 'BA03E7E3133E']) {
      expect(screenForSensitiveContent(`digest ${h} recorded`).map((f) => f.kind), h)
        .not.toContain('iban');
    }
  });

  it('uppercase hex identifiers no longer read as bank accounts', () => {
    for (const h of ['DC80386AFD4D072D', 'AE71445D1ABDB38D9F0ABEB02AC382EE', 'EC7435DA98D1976A10CFD1B3']) {
      expect(screenForSensitiveContent(h).map((f) => f.kind), h).not.toContain('iban');
    }
  });

  it('★ but genuine IBANs are still flagged — the published ISO 13616 registry examples', () => {
    // The specimen IBANs from the ISO 13616 registry / national bank documentation. They are
    // publication examples, not accounts. Mixed lengths (15-27) and one with letters in the BBAN,
    // so a fix that mishandled the A-Z→10-35 mapping would fail on FR and BR but pass on DE.
    const SPECIMENS = [
      'GB82WEST12345698765432',
      'DE89370400440532013000',
      'NO9386011117947',
      'BE68539007547034',
      'CH9300762011623852957',
      'FR1420041010050500013M02606',
      'SA0380000000608010167519',
    ];
    for (const iban of SPECIMENS) {
      expect(screenForSensitiveContent(`account ${iban} on file`).map((f) => f.kind), iban)
        .toContain('iban');
    }
  });

  it('★ a single transposed digit fails the check — proving mod-97 runs, not just the length bound', () => {
    // Same length, same country, one digit changed. If this passed, the length bound would be
    // doing all the work and any 15+ character uppercase token would still be a "bank account".
    expect(screenForSensitiveContent('account DE89370400440532013001 on file').map((f) => f.kind))
      .not.toContain('iban');
    expect(screenForSensitiveContent('account GB82WEST12345698765433 on file').map((f) => f.kind))
      .not.toContain('iban');
  });
});
