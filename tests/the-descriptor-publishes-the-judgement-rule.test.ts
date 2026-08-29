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
const affordancesSrc = readFileSync(join(ROOT, 'affordances.ts'), 'utf8');

/** The affordance object the bridge publishes for review-record. */
const affordance = (() => {
  // ★ THE CANONICAL DECLARATION MOVED. This affordance used to be declared TWICE — here in
  // bridge/server.ts as `const REVIEW_RECORD_AFFORDANCE`, and again in affordances.ts, which is
  // what `GET /affordances` publishes. The two had DRIFTED on the live wire: only this copy
  // declared a `read_pod_url` input and a three-store `iep:reads` block, and the published
  // manifest carried neither — a grep for read_pod_url over its 205 KB returned 0 — while the
  // relay's action authority 302-redirects agents to that manifest, i.e. to the poorer document.
  // The richer half was merged into affordances.ts and this copy deleted, so the assertions
  // below now read the ONE declaration, which is also the one that publishes.
  const at = affordancesSrc.indexOf("action: 'urn:iep:action:foxxi:review-record'");
  expect(at, 'review-record not found in affordances.ts').toBeGreaterThan(-1);
  const open = affordancesSrc.lastIndexOf('{', at);
  let depth = 0;
  for (let i = open; i < affordancesSrc.length; i += 1) {
    if (affordancesSrc[i] === '{') depth += 1;
    else if (affordancesSrc[i] === '}') {
      depth -= 1;
      if (depth === 0) return affordancesSrc.slice(open, i + 1);
    }
  }
  throw new Error('unbalanced review-record literal');
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

  it('and "pass subject_did" is a promise the common route actually keeps', () => {
    // ★ THIS ASSERTION CHANGED ONE DEPLOY AFTER IT WAS WRITTEN, and the sequence is the point.
    // It first required the claim to be SCOPED — true called directly, false through the relay,
    // where sign_request stamps subject_pod_url over the read target. Writing that limitation down
    // honestly is what made it obvious it was a defect and not a boundary, and it was fixed the
    // same day (src/read-target.ts). So the assertion is now the opposite: the claim must NOT be
    // scoped, because a descriptor that under-promises is as wrong as one that over-promises.
    expect(/pass subject_did/i.test(affordance), 'the capability is still advertised').toBe(true);
    expect(affordance, 'the two questions must be distinguished').toMatch(/WHOSE POD AM I/);
    expect(affordance, 'and the limitation must be gone, not re-scoped').not.toMatch(/does NOT work through the relay/i);
  });
});
