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

/** The bridge with comments stripped, so a status DESCRIBED in prose is never read as one SET. */
function bridgeCode(): string {
  return readFileSync(
    new URL('../applications/foxxi-content-intelligence/bridge/server.ts', import.meta.url), 'utf8',
  ).split('\n').filter(l => !/^\s*(\/\/|\*|\/\*)/.test(l)).join('\n');
}

/**
 * Every refusal literal in the bridge, as a bounded window of text around its `kind`.
 *
 * ★ NOT BRACE-MATCHED, DELIBERATELY. The first version was `[{][^{}]*kind: 'refusal'[^{}]*[}]`,
 * which cannot see any refusal whose message uses a template literal — `${podChecked}` puts
 * braces inside the object and ends the match early. MEASURED: it missed the exact
 * "signer is not a member of ${podUrl}" refusal that motivated this file, so leg 2 passed on a
 * mutant restoring that defect. The most interesting refusals interpolate, because they name
 * the thing they are refusing about.
 *
 * A fixed window from the `kind` marker to the end of the statement reads all of them. Fresh
 * RegExp per call: a `g` regex carries mutable state, and two call sites reaching one instance
 * is how the sibling gate in this directory went blind.
 */
function refusalLiterals(code: string): string[] {
  // Both spellings occur: helper bodies write `kind: 'refusal',` and call sites write
  // `kind: 'refusal' as const,`. Requiring the comma excludes the TYPE DECLARATION
  // (`interface Refusal { readonly kind: 'refusal'; … }`), which is not a refusal and would be
  // a permanent false positive — and a gate with one of those stops being read. Requiring the
  // comma WITHOUT allowing `as const` cut the census from 36 to 6; the vacuity check above is
  // what caught that, which is the reason it is there.
  //
  // ★ A FIXED WINDOW, NOT ONE BOUNDED BY `;`. The previous version ended each literal at the
  // first semicolon, and one refusal's own `note` reads "your own pod; the first enrollee owns
  // it." — so the window closed BEFORE its refusalReason and the phrase test below could not
  // see it. MEASURED: with that bound, declaring an explicit and wrong `401` on the
  // not-a-member refusal passed 4/4. A punctuation mark inside a message is not a statement
  // boundary, and this file exists because that kind of silent truncation keeps happening.
  //
  // The bound is `};` — the end of the object literal — not a bare `;` and not a fixed length.
  // Both of those were tried and both were wrong in a way worth recording:
  //   · bare `;`  truncated at a semicolon INSIDE a message ("your own pod; the first
  //     enrollee owns it."), hiding the refusalReason from the phrase tests. Leg 2 then passed
  //     on an explicit, wrong 401.
  //   · fixed 900 chars overran into neighbouring code and reported FOUR correct 403s as
  //     deployment failures, because the words "not configured" happened to appear after them.
  // A `;` preceded by `}` is a statement end; a `;` inside prose is not.
  //
  // ★ THE CAP IS A SAFETY VALVE, NOT A BOUND, AND IT MUST BE GENEROUS. At 900 the lazy match
  // could not reach the closing `};` of the LONGEST refusal — the not-a-member one, whose error
  // spends 400 characters explaining the default-tenant case — so that literal matched nothing
  // and vanished from the census entirely. A gate that silently stops seeing its most important
  // subject is the failure mode this whole file is about: measured, the explicit-401 mutant on
  // that very refusal passed 4/4. The `};` does the bounding; this number only stops a
  // pathological scan.
  return [...code.matchAll(new RegExp("kind: 'refusal'(?: as const)?,[^]{0,3000}?\\};", 'g'))].map(m => m[0]);
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
    const offenders = refusalLiterals(bridgeCode())
      .filter(r => !r.includes('iep:refusalStatus'))
      .filter(r => !r.includes('iep:resolvedBy') && !r.includes('signRequestRefusal'))
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
      new RegExp("iep:refusalStatus':[ ]*([0-9]{3})").exec(r)?.[1];
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
      new RegExp("iep:refusalStatus':[ ]*([0-9]{3})").exec(r)?.[1];
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
});
