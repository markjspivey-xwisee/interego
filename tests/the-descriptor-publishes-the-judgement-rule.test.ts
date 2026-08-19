/**
 * A DESCRIPTOR THAT READS AS COMPLETE AND IS NOT.
 *
 * A live delegate accumulated 750 performance records, dereferenced `review-record`, followed every
 * `iep:reads` block, and still could not find out why its judgement was empty. The blocks published
 * ONE exclusion — a step whose modal status is Hypothetical is not evidence — while
 * `buildCompetencies` applies two more. So nothing was false; the document simply stopped short, and
 * a reader doing everything it said learned the reason from a colleague in a channel.
 *
 * ★ THAT IS THE FAILURE THE WHOLE SELF-DESCRIBING DESIGN EXISTS TO PREVENT, and it is worse than an
 * obviously absent sentence, because a complete-looking document gives a reader no reason to ask.
 *
 * These assertions tie the PUBLISHED text to the CODE that decides. Not by parroting a string — the
 * wording may improve freely — but by requiring the descriptor to name each thing the rule turns on.
 * If the rule changes and the descriptor does not, this goes red on the half that drifted.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', 'applications', 'foxxi-content-intelligence');
const server = readFileSync(join(ROOT, 'bridge', 'server.ts'), 'utf8');
const learnerRecord = readFileSync(join(ROOT, 'src', 'learner-record.ts'), 'utf8');

/** The affordance object the bridge publishes for review-record. */
const affordance = (() => {
  const at = server.indexOf('const REVIEW_RECORD_AFFORDANCE');
  expect(at, 'affordance not found').toBeGreaterThan(-1);
  const rest = server.slice(at);
  return rest.slice(0, rest.indexOf('\n};\n') + 4);
})();

describe('the code still decides what this test says it decides', () => {
  it('a performance record needs a domain type OR an asserted outcome', () => {
    // The line the delegate had to be told about. If this moves, the assertions below are stale and
    // the descriptor they check is describing a rule that no longer exists.
    expect(learnerRecord).toMatch(/if \(!domainTyped && p\.success === undefined\) continue;/);
  });

  it('and protocol-envelope types are what "not domain" means', () => {
    expect(learnerRecord).toMatch(/PROTOCOL_ENVELOPE_TYPE_LOCALNAMES/);
    for (const t of ['AssertedContext', 'ProductionTask', 'SignedAuthorship']) {
      expect(learnerRecord, `${t} must still be an envelope type`).toContain(`'${t}'`);
    }
  });
});

describe('★ and the descriptor publishes it, so a reader need not ask a person', () => {
  it('names both ways a performance record can count', () => {
    expect(affordance, 'must name the domain-type route').toMatch(/DOMAIN activity type/i);
    expect(affordance, 'must name the asserted-outcome route').toMatch(/asserts an outcome|asserted outcome/i);
  });

  it('names the envelope types that decline to count, rather than gesturing at them', () => {
    // A reader holding 750 AssertedContext steps must be able to match its own data against the
    // text. "Some types do not count" would be true and useless.
    for (const t of ['AssertedContext', 'ProductionTask']) {
      expect(affordance, `${t} must be named in the published text`).toContain(t);
    }
  });

  it('says plainly that admission to a store is not the same as counting', () => {
    // The delegate's actual confusion: its steps WERE swept, WERE in the lens, and still scored
    // nothing. Both the JSON affordance and the register's Turtle now say so.
    expect(affordance).toMatch(/ADMITTED IS NOT COUNTED/);
    expect(server, "the register's own comment must say it too").toMatch(/ADMITTED IS NOT COUNTED/);
  });

  it('and does not leave "pass subject_did" as an unqualified promise', () => {
    // True of the bridge called directly, false through the relay, which stamps subject_pod_url
    // from the caller's session. It was invisible while everything 403'd.
    const claim = /pass subject_did/i.test(affordance);
    expect(claim, 'the capability is still advertised').toBe(true);
    expect(affordance, 'and the route where it does not hold is named').toMatch(/relay|sign_request/);
  });
});
