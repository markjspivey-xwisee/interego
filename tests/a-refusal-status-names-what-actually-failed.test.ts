/**
 * A refusal's STATUS must describe what actually failed, not merely that something did.
 *
 * ── WHY THIS EXISTS ──────────────────────────────────────────────────────────
 *
 * Getting off HTTP 200 was the first problem and it is solved. The second is subtler and was
 * found only by signing a real request against the deployed bridge and READING the answer:
 *
 *   · "the request signature is valid but the signer is not a member of this tenant" answered
 *     401. The signature VERIFIED — that caller is authenticated. 401 tells a client to go and
 *     obtain credentials it already holds, and sends an agent back to `sign_request` in a loop
 *     with no exit. It is 403, and the way out is enrolment, so the refusal now names it.
 *   · "tenant pod is not seeded or cannot be decrypted" answered 401 as well. Nothing about the
 *     caller failed; the directory could not be read, so authentication was never ATTEMPTED.
 *     A dependency outage reported as a credentials problem is an outage that gets debugged in
 *     the wrong place, in every client log at once. It is 503.
 *
 * Both were reachable because `kind: 'refusal'` defaults to 401, so a site that declares no
 * status inherits a claim about the CALLER. That default is right for the missing-credential
 * case it was written for and wrong for everything else, which makes silence the bug.
 *
 * So this asserts the rule that catches the class rather than the two instances: every refusal
 * in the bridge either IS the missing-credential case — and then it must offer the way out —
 * or it names its own status.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { returnObjects } from './return-object-scan.js';

/**
 * The bridge, read by the PARSER — not stripped, not pattern-matched.
 *
 * This used to strip full-line comments before matching, which produced two defects at once: a
 * TRAILING `// was: return { error: … }` was censused as a real handler return, and every line
 * number reported was off by the number of comment lines above it (1,454 lines off in one case,
 * so §C named a site nobody could find). The parser does not see comments at all and reports
 * positions in the file as written, so both go away by not doing the stripping.
 */
function bridgeCode(): string {
  return readFileSync(
    new URL('../applications/foxxi-content-intelligence/bridge/server.ts', import.meta.url), 'utf8',
  );
}

/**
 * Every refusal literal in the bridge, read WHOLE by the scanner in tests/return-object-scan.ts.
 *
 * Five regex bounds preceded it and each was blind somewhere — that history, and why every
 * one moved the blindness rather than removing it, is recorded in the scanner's own header.
 */
function refusalLiterals(code: string): string[] {
  // Includes refusals reached through a variable (`const r = {…}; return r;`), which the
  // literal-only scan could not see, so legs 2-4 never examined them.
  return returnObjects(code).map(r => r.text).filter(t => t.includes("kind: 'refusal'"));
}

describe('a refusal names the status that matches what failed', () => {
  it('the census reads real refusals — an empty read would pass everything below', () => {
    const found = refusalLiterals(bridgeCode());
    expect(found.length, 'no refusal literals found; this gate is not reading the bridge').toBeGreaterThan(30);
  });

  it('★ a refusal that declares no status IS the missing-credential case, and offers the exit', () => {
    // 401 is the kind's default. Inheriting it silently is how "not a member" (authenticated)
    // and "directory unreadable" (nothing to do with the caller) both claimed a credentials
    // failure. A site may still rely on the default — but only where 401 is the truth, and
    // then it owes the caller the affordance that mints one.
    // ★ ONLY the credential-minting exit justifies the 401 default. This exempted any literal
    // containing `iep:resolvedBy` — but `wrongPod` names an ENROLMENT affordance as its way
    // out, so deleting its 403 left seven authenticated callers told their credentials failed,
    // with leg 2 green. A resolvedBy that points at sign_request is a 401 refusal; one that
    // points anywhere else is a refusal that has forgotten to say what it is.
    const offenders = refusalLiterals(bridgeCode())
      .filter(r => !r.includes('iep:refusalStatus'))
      .filter(r => !/toolName:\s*'sign_request'/.test(r) && !r.includes('signRequestRefusal'))
      .map(r => r.replace(new RegExp('[ ]+', 'g'), ' ').slice(0, 150));

    expect(
      offenders,
      `${offenders.length} refusal(s) declare no iep:refusalStatus and no way out, so they `
        + 'answer 401 by default — asserting that the CALLER\'s credentials failed, which is '
        + 'false whenever the caller is authenticated (403) or the failure is ours (502/503):'
        + `${String.fromCharCode(10)}  ${offenders.join(String.fromCharCode(10) + '  ')}`,
    ).toEqual([]);
  });

  it('★ an authenticated-but-not-permitted refusal is never 401', () => {
    // The distinguishing phrase is that the signature or session WORKED. If a refusal says so
    // and still claims 401, it is telling a client to re-acquire a credential that is fine.
    // The literal's OWN status is its FIRST refusalStatus — a fixed window can reach into a
    // neighbouring literal, and reading "some 403 appears nearby" would be exactly the kind of
    // check that passes for the wrong reason.
    const ownStatus = (r: string): string | undefined =>
      new RegExp("['\"]iep:refusalStatus['\"]:[ ]*([0-9]{3})").exec(r)?.[1];
    const bad = refusalLiterals(bridgeCode())
      .filter(r => /signature is valid|is authenticated but|is not a member|not the owner of/i.test(r))
      .filter(r => !['403', '404'].includes(ownStatus(r) ?? ''))
      .map(r => r.replace(new RegExp('[ ]+', 'g'), ' ').slice(0, 150));
    expect(
      bad,
      'a refusal states the caller IS authenticated yet does not answer 403/404',
    ).toEqual([]);
  });

  it('★ a failure of OURS is not reported as a failure of the caller', () => {
    // "could not be read", "not seeded", "not configured" are all conditions no argument and no
    // credential can change. 4xx tells the caller to change the request; only 5xx is true.
    const own = (r: string): string | undefined =>
      new RegExp("['\"]iep:refusalStatus['\"]:[ ]*([0-9]{3})").exec(r)?.[1];
    const bad = refusalLiterals(bridgeCode())
      .filter(r => /could not be read|not seeded|cannot be decrypted|not configured|is unset/i.test(r))
      .filter(r => !(own(r) ?? '').startsWith('5'))
      .map(r => r.replace(new RegExp('[ ]+', 'g'), ' ').slice(0, 150));
    expect(
      bad,
      'a deployment-side failure answers a 4xx, which tells the caller to fix a request that '
        + 'was never the problem',
    ).toEqual([]);
  });
  /**
   * ★★ THE SIX HELPERS ARE CHECKED BY NAME, NOT BY THE WORDS IN THEIR MESSAGES.
   *
   * Legs 2–4 select refusals by phrases in their text ("is not a member", "not configured").
   * The central helpers — `notFound`, `notConfigured`, `upstreamFailed`, `wrongPod`,
   * `invalidArguments` — are worded in their OWN terms, so no leg selected them, and an audit
   * showed all three of `notFound`/`notConfigured`/`upstreamFailed` flipped to 401 passing
   * every assertion in this file. Those helpers stand behind 26 call sites: "SCORM Cloud
   * credentials not configured" would have answered 401 and sent an agent back to
   * sign_request in the exact loop this file's docblock says it exists to prevent.
   *
   * A helper's status is a fact about a named function, so it is asserted as one — no
   * vocabulary, nothing to drift. If a helper is renamed or added, this table is the place
   * that must change, and the vacuity check makes forgetting it loud.
   */
  it('★ each status helper declares the status its name promises', () => {
    const code = bridgeCode();
    const EXPECT: Record<string, number | 'default-401'> = {
      invalidArguments: 400,
      notFound: 404,
      wrongPod: 403,
      upstreamFailed: 502,
      notConfigured: 503,
      // No literal status: it relies on the kind's 401 default, and that is CORRECT for the
      // one case it serves — a caller who genuinely holds no credential — because it also
      // names the way out. See leg 2.
      signRequestRefusal: 'default-401',
    };
    // propagateRefusal carries no literal of its own: its whole job is to hand on the status the
    // PRODUCER decided. A hard-coded 401 in its body passed every leg here, so it is checked
    // for the read rather than for a number.
    const prop = code.indexOf('function propagateRefusal(');
    expect(prop, 'propagateRefusal not found').toBeGreaterThan(-1);
    const propBody = returnObjects(code.slice(prop)).find(r => r.text.includes("kind: 'refusal'"));
    expect(
      propBody?.text ?? '',
      'propagateRefusal no longer propagates: it must set iep:refusalStatus from `r.status`, '
        + 'or every producer decision (404 absent, 409 conflict, 403 unauthorised) is discarded',
    ).toMatch(/iep:refusalStatus':\s*r\.status/);
    const wrong: string[] = [];
    for (const [name, want] of Object.entries(EXPECT)) {
      const start = code.indexOf(`function ${name}(`);
      expect(start, `helper ${name} not found — renamed? update this table`).toBeGreaterThan(-1);
      const body = returnObjects(code.slice(start)).find(r => r.text.includes("kind: 'refusal'"));
      expect(body, `helper ${name} no longer returns a refusal literal`).toBeTruthy();
      const m = new RegExp("['\"]iep:refusalStatus['\"]:[ ]*([0-9]{3})").exec(body!.text);
      const got = m ? Number(m[1]) : 'default-401';
      if (got !== want) wrong.push(`${name}: declares ${got}, should be ${want}`);
    }
    expect(
      wrong,
      'a status helper answers the wrong status, and every call site that composes it answers '
        + 'it too:' + String.fromCharCode(10) + '  ' + wrong.join(String.fromCharCode(10) + '  '),
    ).toEqual([]);
    expect(Object.keys(EXPECT).length, 'the helper table is empty — vacuous').toBeGreaterThan(4);
  });
});
